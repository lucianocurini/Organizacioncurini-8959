-- Migración 0036: titular de cuenta explícito + asignaciones de financiación
-- (fuente↔destino) para lotes multiasegurado — Etapa 1B-1 de "cuenta
-- corriente con titular de cuenta" (ver diagnóstico de diseño cerrado en la
-- conversación de sobrantes/faltantes con titular de cuenta, 2026-09).
--
-- Puramente aditiva: 3 columnas nullable (payment_batches,
-- insured_account_movements, payment_amount_adjustments) + 2 tablas nuevas
-- sin backfill. Ninguna tabla existente se recrea, ninguna fila histórica
-- cambia, ningún dato se borra. Idempotente (ver
-- src/lib/migrations/apply-0036-account-holder-funding.ts). Esta etapa
-- (1B-1) es exclusivamente de esquema — ningún endpoint usa todavía estas
-- columnas/tablas (eso es 1B-2/1B-3).
--
-- ── A. payment_batches.account_holder_insured_id ────────────────────────
--
-- Titular de cuenta EXPLÍCITO, elegido por quien cobra — independiente del
-- insured_id legacy de la tabla (que sigue siendo un dato DERIVADO de los
-- ítems del batch, ver migración 0026, y sigue existiendo sin cambios). Un
-- lote puede mezclar pólizas de varios insured_id reales y aun así tener un
-- único titular de cuenta explícito, a diferencia de insured_id (que queda
-- NULL en ese caso). NULL para todo batch que no elige explícitamente un
-- titular (todo el histórico, y todo batch nuevo que no use este flujo).
--
-- ── B/C. effective_date en insured_account_movements/payment_amount_adjustments ──
--
-- Fecha efectiva del movimiento/ajuste (a partir de qué día corresponde
-- contablemente), separada de created_at (momento REAL de inserción de la
-- fila, nunca backdateado). NULL en toda fila histórica (interpretación
-- documentada: fecha efectiva = fecha de created_at, sin reescribir nada
-- retroactivamente). Formato esperado YYYY-MM-DD, validado en aplicación —
-- sin CHECK de formato a nivel DB, mismo criterio que el resto de las
-- columnas de fecha en TEXT de este esquema (ninguna otra lo tiene, ver
-- payment_batches.payment_date/cash_entries.payment_date).
--
-- ── D. payment_batch_funding_allocations ─────────────────────────────────
--
-- Reparto fuente↔destino de UN lote: con qué plata (real o virtual) se
-- canceló cada destino nominal. No es una tabla de instrumentos de
-- cobranza (eso sigue siendo payment_batch_splits/received_checks, sin
-- cambios) ni de rendición (eso sigue siendo remittance_allocations, sin
-- cambios) — es el eslabón nuevo entre "cuánto puso el cliente/su cuenta
-- corriente" y "a qué cuota/recargo se lo aplicó", necesario porque un solo
-- movimiento agregado (aplicacion_saldo_favor/saldo_deudor/ajuste de
-- redondeo) puede financiar VARIOS destinos que se rinden en momentos
-- distintos (ver src/lib/payments/insured-account.ts, Etapa 1B-2, para el
-- cálculo de Caja que consume esta tabla).
--
-- Fuente — exactamente una de las tres (CHECK XOR, mismo estilo que
-- remittance_allocations/payment_amount_adjustments):
--   payment_batch_split_id       — un cheque/efectivo/transferencia real,
--                                   sin fusionar (nunca el batch entero).
--   source_account_movement_id   — la fila AGREGADA (una por batch) de
--                                   aplicacion_saldo_favor o saldo_deudor —
--                                   nunca otro tipo (validado en
--                                   aplicación, no expresable en CHECK sin
--                                   consultar insured_account_movements.type).
--   payment_amount_adjustment_id — la fila AGREGADA (una por batch) de
--                                   redondeo absorbido (amount_cents < 0).
--
-- Destino — exactamente uno de los tres:
--   payment_id                     — una prima/cuota (payments hijo).
--   cash_entry_id                  — un recargo Pronto Pago concreto (nunca
--                                     el payment padre — deben distinguirse
--                                     inequívocamente si ambos reciben
--                                     financiación).
--   destination_account_movement_id — la fila NUEVA de saldo_a_favor que
--                                     este mismo batch generó por un
--                                     excedente real — el único caso donde
--                                     el "destino" es, a su vez, un
--                                     movimiento de cuenta corriente.
--
-- source_account_movement_id y destination_account_movement_id nunca
-- pueden ser el mismo id en una misma fila (CHECK defensivo) — en la
-- práctica ya es imposible por incompatibilidad de tipo (aplicacion_saldo_
-- favor/saldo_deudor nunca son saldo_a_favor), reforzado acá sin costo.
--
-- Unicidad: 9 índices ÚNICOS PARCIALES, uno por combinación fuente×destino
-- (3×3) — un UNIQUE compuesto plano sobre las 6 columnas nulables NO
-- serviría acá (SQLite, como el resto de SQL estándar, nunca considera
-- NULL=NULL en un UNIQUE, y cada fila tiene siempre 4 de esas 6 columnas en
-- NULL) — mismo criterio que los UNIQUE parciales de remittance_allocations
-- (migración 0024).
--
-- Sin ON DELETE explícito en ninguna FK (default NO ACTION) — igual que el
-- resto del proyecto: ninguna tabla referenciada acá (payment_batches,
-- payment_batch_splits, insured_account_movements,
-- payment_amount_adjustments, payments, cash_entries, users) tiene hoy
-- ningún endpoint que la borre físicamente — todo es soft-cancel
-- (status/anulado). Sin triggers (este proyecto no usa triggers en ningún
-- lado) — el cierre exacto por fuente/destino y la prohibición de
-- allocations cruzadas entre batches son responsabilidad de la aplicación
-- (Etapa 1B-2/1B-3), igual que validateBatchTotals/validateAllocationTotals.
--
-- ── E. account_holder_funding_idempotency_keys ───────────────────────────
--
-- Sin precedente en el proyecto (no existe ningún mecanismo de idempotency
-- key hasta esta migración). Diseño "sin placeholder": la fila se inserta
-- UNA sola vez, al final de la transacción que crea el batch, cuando ya se
-- conocen todos sus valores — por eso payment_batch_id/response_status/
-- response_snapshot/request_fingerprint son NOT NULL desde el principio (no
-- existe un estado intermedio incompleto que otra transacción pueda leer).
-- UNIQUE(created_by, endpoint, idempotency_key) es la única garantía real
-- de que dos requests concurrentes con la misma clave produzcan como máximo
-- un batch (ver Etapa 1B-3 para el flujo completo de colisión/reintento).

-- ─── A. payment_batches ─────────────────────────────────────────────────
ALTER TABLE payment_batches ADD COLUMN account_holder_insured_id INTEGER REFERENCES insureds(id);
CREATE INDEX IF NOT EXISTS idx_payment_batches_account_holder_insured_id ON payment_batches(account_holder_insured_id);

-- ─── B. insured_account_movements ───────────────────────────────────────
ALTER TABLE insured_account_movements ADD COLUMN effective_date TEXT;

-- ─── C. payment_amount_adjustments ──────────────────────────────────────
ALTER TABLE payment_amount_adjustments ADD COLUMN effective_date TEXT;

-- ─── D. payment_batch_funding_allocations ───────────────────────────────
CREATE TABLE IF NOT EXISTS payment_batch_funding_allocations (
  id                               INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_batch_id                 INTEGER NOT NULL REFERENCES payment_batches(id),

  -- Fuente — exactamente una de las tres.
  payment_batch_split_id           INTEGER REFERENCES payment_batch_splits(id),
  source_account_movement_id       INTEGER REFERENCES insured_account_movements(id),
  payment_amount_adjustment_id     INTEGER REFERENCES payment_amount_adjustments(id),

  -- Destino — exactamente uno de los tres.
  payment_id                       INTEGER REFERENCES payments(id),
  cash_entry_id                    INTEGER REFERENCES cash_entries(id),
  destination_account_movement_id  INTEGER REFERENCES insured_account_movements(id),

  amount_cents                     INTEGER NOT NULL CHECK (amount_cents > 0),
  created_by                       INTEGER NOT NULL REFERENCES users(id),
  created_at                       INTEGER NOT NULL,

  CHECK (
    (payment_batch_split_id IS NOT NULL) +
    (source_account_movement_id IS NOT NULL) +
    (payment_amount_adjustment_id IS NOT NULL) = 1
  ),
  CHECK (
    (payment_id IS NOT NULL) +
    (cash_entry_id IS NOT NULL) +
    (destination_account_movement_id IS NOT NULL) = 1
  ),
  CHECK (
    source_account_movement_id IS NULL
    OR destination_account_movement_id IS NULL
    OR source_account_movement_id != destination_account_movement_id
  )
);

CREATE INDEX IF NOT EXISTS idx_pbfa_payment_batch_id ON payment_batch_funding_allocations(payment_batch_id);
CREATE INDEX IF NOT EXISTS idx_pbfa_payment_batch_split_id ON payment_batch_funding_allocations(payment_batch_split_id);
CREATE INDEX IF NOT EXISTS idx_pbfa_source_account_movement_id ON payment_batch_funding_allocations(source_account_movement_id);
CREATE INDEX IF NOT EXISTS idx_pbfa_payment_amount_adjustment_id ON payment_batch_funding_allocations(payment_amount_adjustment_id);
CREATE INDEX IF NOT EXISTS idx_pbfa_payment_id ON payment_batch_funding_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_pbfa_cash_entry_id ON payment_batch_funding_allocations(cash_entry_id);
CREATE INDEX IF NOT EXISTS idx_pbfa_destination_account_movement_id ON payment_batch_funding_allocations(destination_account_movement_id);

-- Unicidad por (fuente, destino) — 9 índices parciales (3 fuentes × 3 destinos).
CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_split_payment ON payment_batch_funding_allocations(payment_batch_split_id, payment_id) WHERE payment_batch_split_id IS NOT NULL AND payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_split_cash_entry ON payment_batch_funding_allocations(payment_batch_split_id, cash_entry_id) WHERE payment_batch_split_id IS NOT NULL AND cash_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_split_new_credit ON payment_batch_funding_allocations(payment_batch_split_id, destination_account_movement_id) WHERE payment_batch_split_id IS NOT NULL AND destination_account_movement_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_srcmov_payment ON payment_batch_funding_allocations(source_account_movement_id, payment_id) WHERE source_account_movement_id IS NOT NULL AND payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_srcmov_cash_entry ON payment_batch_funding_allocations(source_account_movement_id, cash_entry_id) WHERE source_account_movement_id IS NOT NULL AND cash_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_srcmov_new_credit ON payment_batch_funding_allocations(source_account_movement_id, destination_account_movement_id) WHERE source_account_movement_id IS NOT NULL AND destination_account_movement_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_adj_payment ON payment_batch_funding_allocations(payment_amount_adjustment_id, payment_id) WHERE payment_amount_adjustment_id IS NOT NULL AND payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_adj_cash_entry ON payment_batch_funding_allocations(payment_amount_adjustment_id, cash_entry_id) WHERE payment_amount_adjustment_id IS NOT NULL AND cash_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_adj_new_credit ON payment_batch_funding_allocations(payment_amount_adjustment_id, destination_account_movement_id) WHERE payment_amount_adjustment_id IS NOT NULL AND destination_account_movement_id IS NOT NULL;

-- ─── E. account_holder_funding_idempotency_keys ─────────────────────────
CREATE TABLE IF NOT EXISTS account_holder_funding_idempotency_keys (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by            INTEGER NOT NULL REFERENCES users(id),
  endpoint              TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint   TEXT NOT NULL,
  payment_batch_id      INTEGER NOT NULL REFERENCES payment_batches(id),
  response_status       INTEGER NOT NULL,
  response_snapshot     TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  UNIQUE (created_by, endpoint, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ahf_idempotency_batch_id ON account_holder_funding_idempotency_keys(payment_batch_id);
