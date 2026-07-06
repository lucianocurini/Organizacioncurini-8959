-- Migration 0020: cobros que imputan varias cuotas del mismo asegurado (Etapa 4A)
--
-- payment_batches es el encabezado de un cobro múltiple: agrupa varios
-- payments hijos (cada uno sigue representando una cuota individual — ver
-- payments.batch_id más abajo) bajo un mismo evento de cobro real (un
-- cheque/transferencia que cubre varias cuotas a la vez, en vez de repartir
-- artificialmente ese instrumento entre cada cuota).
--
-- base_amount_cents      = suma de payments.amount de sus hijos.
-- surcharge_amount_cents = recargos Pronto Pago aplicables ($800 por cada
--                          cuota Rivadavia elegible — nunca por recibo ni por
--                          póliza — solo si TODOS los medios del batch son
--                          del grupo "own"; ver src/lib/payments/batches.ts).
-- total_received_cents   = base + surcharge = lo efectivamente recibido,
--                          que debe coincidir exactamente con la suma de
--                          payment_batch_splits (migración 0021).
--
-- Un payment con batch_id NOT NULL es un hijo del batch: conserva
-- installment_id/policy_id, su amount es el importe exacto de esa cuota,
-- payment_method='lote', y NO tiene payment_splits propios — los medios
-- reales del cobro viven una sola vez en payment_batch_splits del batch,
-- nunca repartidos por cuota. Un payment standalone (batch_id IS NULL) sigue
-- exigiendo al menos un payment_split, sin cambios (Etapa 3A/3B).
--
-- Sin backfill: ningún payment histórico recibe batch_id. Ningún payment_batch
-- se crea para datos existentes.

CREATE TABLE IF NOT EXISTS payment_batches (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  insured_id             INTEGER NOT NULL REFERENCES insureds(id),
  base_amount_cents      INTEGER NOT NULL CHECK (base_amount_cents > 0),
  surcharge_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (surcharge_amount_cents >= 0),
  total_received_cents   INTEGER NOT NULL CHECK (total_received_cents > 0),
  payment_date           TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'confirmado' CHECK (status IN ('confirmado', 'anulado')),
  notes                  TEXT,
  created_by             INTEGER REFERENCES users(id),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_batches_insured_id ON payment_batches(insured_id);
CREATE INDEX IF NOT EXISTS idx_payment_batches_payment_date ON payment_batches(payment_date);
CREATE INDEX IF NOT EXISTS idx_payment_batches_status ON payment_batches(status);

-- payments.batch_id: nullable — NULL para todo pago standalone (histórico o
-- nuevo, sin cambios de significado). Con valor: identifica de qué cobro
-- múltiple es hijo esta cuota. Igual que en 0016 (due_date), este ALTER no es
-- idempotente por sí solo — la idempotencia la garantiza el aplicador TS
-- (src/lib/migrations/apply-0020-payment-batches.ts), que verifica con
-- PRAGMA table_info antes de ejecutarlo.
ALTER TABLE payments ADD COLUMN batch_id INTEGER REFERENCES payment_batches(id);

CREATE INDEX IF NOT EXISTS idx_payments_batch_id ON payments(batch_id);
