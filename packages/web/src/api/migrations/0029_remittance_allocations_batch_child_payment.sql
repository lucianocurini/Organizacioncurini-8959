-- Migración 0029: relaja el CHECK "exactamente un leaf" de
-- remittance_allocations para permitir un cuarto tipo de leaf — payment_id
-- SOLO — que representa la rendición de un payment HIJO de un
-- payment_batches (cobro por lote) de forma INDEPENDIENTE de sus hermanos.
--
-- MOTIVO (regla de negocio confirmada): cobrar por lote agrupa cuotas/
-- pólizas solo para cobrarlas más rápido o imputar juntas un cheque/
-- transferencia/resumen del cliente — NO define cómo se rinden después a
-- cada compañía. Hasta esta migración, el único camino para rendir un
-- payment hijo de batch era resolveBatchInstruments (ver migración 0024):
-- arrastraba TODOS los payment_batch_splits/received_checks del batch
-- completo como si ese fuera el instrumento de la rendición, y
-- assertCompletePaymentBatches (src/lib/payments/remittance-allocations.ts,
-- eliminada en esta etapa) exigía incluir a TODOS los hermanos pendientes
-- del batch en la misma rendición ("se rinde completo o no se rinde").
-- Eso conflaba dos cosas distintas:
--   - instrumento de COBRANZA (payment_batch_splits/received_checks): cómo
--     entró la plata del cliente a la oficina — física, indivisible, un
--     cheque no se puede "partir" entre compañías.
--   - instrumento de RENDICIÓN/salida: cómo Curini le paga/rinde a cada
--     compañía — propio de cada rendición, puede no coincidir con el medio
--     de cobro original.
--
-- Esta migración NO toca cómo se leen/interpretan las allocations de batch
-- YA EXISTENTES (payment_batch_split_id/received_check_id siguen siendo un
-- leaf válido, resolveBatchInstruments no se borra, solo deja de ser el
-- único camino) — solo agrega un camino alternativo: una allocation con
-- payment_id (el payment puntual que se rinde) + payment_batch_id
-- (denormalizado, solo trazabilidad de "de qué lote vino", NUNCA fuerza
-- consumir su instrumento) + method/amount_cents PROPIOS de esta rendición.
--
-- SQLite no permite modificar un CHECK existente vía ALTER TABLE — se
-- recrea la tabla completa (procedimiento de 12 pasos, mismo criterio que
-- 0021/0022/0023/0024/0026/0028). No se agrega ninguna columna nueva
-- (payment_id ya existe desde 0024) — el único cambio de esquema real es el
-- CHECK y un índice único nuevo.
--
-- CHECK anterior:
--   (payment_split_id IS NOT NULL) +
--   (payment_batch_split_id IS NOT NULL) +
--   (cash_entry_id IS NOT NULL) = 1
-- CHECK nuevo:
--   (payment_split_id IS NOT NULL) +
--   (payment_batch_split_id IS NOT NULL) +
--   (cash_entry_id IS NOT NULL) +
--   (payment_id IS NOT NULL AND payment_split_id IS NULL) = 1
--
-- El término nuevo nunca interfiere con filas existentes: un leaf
-- payment_split/payment_split_check ya tiene payment_id Y payment_split_id
-- seteados juntos (denormalización histórica de la migración 0024) — el
-- "AND payment_split_id IS NULL" excluye exactamente ese caso. Los leaves de
-- batch (payment_batch_split_id) y cash_entry nunca tienen payment_id
-- seteado (ver buildRemittanceAllocations) — el término nuevo da 0 para
-- ellos. El segundo CHECK (received_check_id) queda igual — el leaf nuevo
-- nunca tiene received_check_id.
--
-- Protección contra doble rendición del leaf nuevo: índice único parcial
-- ux_remittance_allocations_payment_only sobre payment_id, acotado a las
-- filas donde payment_id es la ÚNICA columna identificadora — un mismo
-- payment hijo de batch no puede aparecer dos veces bajo este leaf en
-- ninguna rendición, en todo el historial (a nivel DB, además de la
-- validación de aplicación vía payments.rendered que ya existe en POST
-- /remittances).
--
-- Sin backfill: ninguna fila existente cambia de valor. La idempotencia y el
-- procedimiento seguro (PRAGMA foreign_keys=OFF fuera de la transacción,
-- PRAGMA foreign_key_check antes de confirmar) los garantiza el aplicador TS
-- (src/lib/migrations/apply-0029-remittance-allocations-batch-child-payment.ts),
-- no este archivo por sí solo — mismo criterio que toda migración de este
-- proyecto desde 0017 en adelante. Solo se aplicó localmente (dev.db) — NO
-- se corrió contra Turso/producción.

CREATE TABLE remittance_allocations_new (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  remittance_id           INTEGER NOT NULL REFERENCES remittances(id),
  remittance_item_id      INTEGER REFERENCES remittance_items(id),
  payment_id              INTEGER REFERENCES payments(id),
  payment_split_id        INTEGER REFERENCES payment_splits(id),
  payment_batch_id        INTEGER REFERENCES payment_batches(id),
  payment_batch_split_id  INTEGER REFERENCES payment_batch_splits(id),
  received_check_id       INTEGER REFERENCES received_checks(id),
  cash_entry_id           INTEGER REFERENCES cash_entries(id),
  method                  TEXT NOT NULL CHECK (
                            method IN ('efectivo', 'transferencia', 'cheque', 'link_pago', 'transferencia_compania')
                          ),
  amount_cents            INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at              INTEGER NOT NULL,
  CHECK (
    (payment_split_id IS NOT NULL) +
    (payment_batch_split_id IS NOT NULL) +
    (cash_entry_id IS NOT NULL) +
    (payment_id IS NOT NULL AND payment_split_id IS NULL) = 1
  ),
  CHECK (
    received_check_id IS NULL
    OR payment_batch_split_id IS NOT NULL
    OR payment_split_id IS NOT NULL
  )
);

INSERT INTO remittance_allocations_new (
  id, remittance_id, remittance_item_id, payment_id, payment_split_id,
  payment_batch_id, payment_batch_split_id, received_check_id, cash_entry_id,
  method, amount_cents, created_at
)
SELECT
  id, remittance_id, remittance_item_id, payment_id, payment_split_id,
  payment_batch_id, payment_batch_split_id, received_check_id, cash_entry_id,
  method, amount_cents, created_at
FROM remittance_allocations;

DROP TABLE remittance_allocations;
ALTER TABLE remittance_allocations_new RENAME TO remittance_allocations;

CREATE INDEX IF NOT EXISTS idx_remittance_allocations_remittance_id ON remittance_allocations(remittance_id);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_remittance_item_id ON remittance_allocations(remittance_item_id);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_method ON remittance_allocations(method);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_payment_id ON remittance_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_payment_batch_id ON remittance_allocations(payment_batch_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_payment_split
  ON remittance_allocations(payment_split_id)
  WHERE payment_split_id IS NOT NULL AND received_check_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_batch_split_no_check
  ON remittance_allocations(payment_batch_split_id)
  WHERE payment_batch_split_id IS NOT NULL AND received_check_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_received_check
  ON remittance_allocations(received_check_id) WHERE received_check_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_cash_entry
  ON remittance_allocations(cash_entry_id) WHERE cash_entry_id IS NOT NULL;

-- Leaf nuevo (0029): payment_id es la única columna identificadora (las
-- otras 3 NULL) — nunca choca con ux_remittance_allocations_payment_split
-- de arriba, que exige payment_split_id IS NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_payment_only
  ON remittance_allocations(payment_id)
  WHERE payment_id IS NOT NULL AND payment_split_id IS NULL AND payment_batch_split_id IS NULL AND cash_entry_id IS NULL;
