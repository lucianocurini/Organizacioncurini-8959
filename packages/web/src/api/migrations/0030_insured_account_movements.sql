-- Migration 0030: sobrantes/faltantes en cobros — separa dinero REAL recibido
-- de dinero APLICADO a cuotas, y modela la diferencia como cuenta corriente
-- del asegurado. Fase 2A (solo base técnica: columna + 2 tablas nuevas, sin
-- tocar el flujo de cobro todavía — ver diagnóstico de diseño completo,
-- cerrado 2026-07-21).
--
-- A. payment_batches.received_amount_cents (nueva columna)
--
-- payment_batch_splits/received_checks YA representan dinero real (el cheque
-- nunca se "achica" para cerrar contra las cuotas elegidas — confirmado en el
-- diseño: si el cheque es mayor que lo aplicado, el cheque queda registrado
-- por su importe COMPLETO). Hasta esta migración no existía ninguna columna
-- que totalizara ese dinero real de forma independiente de lo aplicado —
-- total_received_cents (pese al nombre) es y sigue siendo el total APLICADO
-- (base_amount_cents + surcharge_amount_cents, imputado a cuotas), y
-- validateBatchTotals exige que coincida exactamente con la suma de splits
-- porque hasta hoy ambos montos eran siempre iguales por invariante.
--
-- received_amount_cents es la columna nueva que sí representa dinero real
-- recibido (debe coincidir con SUM(payment_batch_splits.amount_cents) del
-- batch). total_received_cents NO se renombra ni cambia de significado —
-- queda como "aplicado/imputado" legacy, para no romper ningún código ni
-- test existente que ya lo lee.
--
-- Backfill: received_amount_cents = total_received_cents para todo batch
-- existente, porque hasta esta migración ambos eran siempre iguales por
-- invariante (validateBatchTotals nunca dejó que divergieran).
--
-- B. insured_account_movements (tabla nueva)
--
-- Ledger CON SIGNO de la cuenta corriente de un asegurado real:
--   signed_amount_cents > 0 = saldo A FAVOR del asegurado (crédito).
--   signed_amount_cents < 0 = saldo DEUDOR del asegurado (débito).
--   saldo vigente = SUM(signed_amount_cents) WHERE status = 'activo'.
--
-- 6 tipos:
--   saldo_a_favor          — cheque/efectivo/transferencia recibido de más
--                             respecto de lo aplicado a cuotas (origin_batch_id/
--                             origin_payment_id: de dónde vino el excedente).
--   saldo_deudor            — cobro recibido de menos respecto de lo aplicado
--                             (falta plata real para cubrir lo imputado).
--   aplicacion_saldo_favor  — el crédito se usa para cubrir una cuota FUTURA
--                             (related_payment_id/related_installment_id: qué
--                             cuota consume el crédito). Baja la cuenta
--                             corriente; NO baja Caja hasta que esa cuota se
--                             rinda (ver helpers, Caja y cuenta corriente
--                             divergen a propósito en esa ventana).
--   cobro_saldo_deudor      — entra dinero real que salda una deuda de cuenta
--                             corriente previa.
--   devolucion_saldo_favor  — se le devuelve plata real al asegurado (salida
--                             real de Caja).
--   ajuste_manual           — corrección administrativa que cierra/reduce
--                             cuenta corriente sin mover Caja (ni entrada ni
--                             salida real).
--
-- reason es obligatorio A NIVEL APLICACIÓN (no CHECK de DB) para
-- ajuste_manual/devolucion_saldo_favor/saldo_deudor — motivo de negocio, no
-- de integridad de esquema (mismo criterio que el resto del proyecto: los
-- CHECKs de DB solo restringen vocabulario/forma, nunca reglas de negocio
-- condicionales por tipo). Ídem authorized_by, obligatorio a nivel app
-- únicamente para ajuste_manual.
--
-- Sin relación con cash_debts/remittance_items (Adeudados legacy) — cuenta
-- corriente es un concepto nuevo e independiente, no reemplaza ni se mezcla
-- con esas tablas en esta fase.
--
-- C. payment_amount_adjustments (tabla nueva)
--
-- Ajuste manual PURO para el caso sin asegurado real (batch 100%
-- manual_payment, insured_id null por diseño desde la etapa "lote
-- multi-asegurado" — insured_account_movements exige insured_id NOT NULL, así
-- que ese caso no puede modelarse ahí). amount_cents con signo, exactamente
-- uno de payment_id/payment_batch_id (CHECK XOR), reason/authorized_by
-- siempre NOT NULL a nivel DB (a diferencia de insured_account_movements, acá
-- SIEMPRE son obligatorios sin excepción — todo registro en esta tabla es por
-- definición un ajuste administrativo).
--
-- Ninguna de las dos tablas nuevas se usa todavía en ningún endpoint — solo
-- existen para que los helpers puros de Fase 2A tengan un esquema real contra
-- el cual validar. La idempotencia y el procedimiento seguro (PRAGMA
-- foreign_keys=OFF fuera de la transacción, PRAGMA foreign_key_check antes de
-- confirmar) los garantiza el aplicador TS
-- (src/lib/migrations/apply-0030-insured-account-movements.ts), no este
-- archivo por sí solo — mismo criterio que toda migración de este proyecto
-- desde 0017 en adelante. Solo se aplica localmente (dev.db) — NO se corrió
-- contra Turso/producción.

-- ─── A. payment_batches.received_amount_cents ──────────────────────────────

ALTER TABLE payment_batches ADD COLUMN received_amount_cents INTEGER;

-- Backfill: hasta esta migración, received == applied siempre (invariante
-- garantizado por validateBatchTotals) — se copia 1:1, ninguna fila queda NULL.
UPDATE payment_batches SET received_amount_cents = total_received_cents
WHERE received_amount_cents IS NULL;

-- ─── B. insured_account_movements ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS insured_account_movements (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  insured_id              INTEGER NOT NULL REFERENCES insureds(id),
  type                    TEXT NOT NULL CHECK (
                            type IN (
                              'saldo_a_favor', 'saldo_deudor', 'aplicacion_saldo_favor',
                              'cobro_saldo_deudor', 'devolucion_saldo_favor', 'ajuste_manual'
                            )
                          ),
  signed_amount_cents     INTEGER NOT NULL CHECK (signed_amount_cents != 0),
  status                  TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'anulado')),
  origin_payment_id       INTEGER REFERENCES payments(id),
  origin_batch_id         INTEGER REFERENCES payment_batches(id),
  related_payment_id      INTEGER REFERENCES payments(id),
  related_installment_id  INTEGER REFERENCES policy_installments(id),
  reason                  TEXT,
  authorized_by           INTEGER REFERENCES users(id),
  created_by              INTEGER NOT NULL REFERENCES users(id),
  created_at              INTEGER NOT NULL,
  settled_at              INTEGER,
  notes                   TEXT
);

CREATE INDEX IF NOT EXISTS idx_insured_account_movements_insured_id ON insured_account_movements(insured_id);
CREATE INDEX IF NOT EXISTS idx_insured_account_movements_origin_batch_id ON insured_account_movements(origin_batch_id);
CREATE INDEX IF NOT EXISTS idx_insured_account_movements_origin_payment_id ON insured_account_movements(origin_payment_id);
CREATE INDEX IF NOT EXISTS idx_insured_account_movements_related_payment_id ON insured_account_movements(related_payment_id);
CREATE INDEX IF NOT EXISTS idx_insured_account_movements_status ON insured_account_movements(status);
CREATE INDEX IF NOT EXISTS idx_insured_account_movements_type ON insured_account_movements(type);

-- ─── C. payment_amount_adjustments ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_amount_adjustments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id        INTEGER REFERENCES payments(id),
  payment_batch_id  INTEGER REFERENCES payment_batches(id),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents != 0),
  reason            TEXT NOT NULL,
  authorized_by     INTEGER NOT NULL REFERENCES users(id),
  created_by        INTEGER NOT NULL REFERENCES users(id),
  created_at        INTEGER NOT NULL,
  CHECK (
    (payment_id IS NOT NULL) + (payment_batch_id IS NOT NULL) = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_payment_amount_adjustments_payment_id ON payment_amount_adjustments(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_amount_adjustments_payment_batch_id ON payment_amount_adjustments(payment_batch_id);
