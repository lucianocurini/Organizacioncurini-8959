-- Migration 0019: desglose de payments por medio de pago (payment_splits)
-- Etapa 3A — infraestructura solamente. No habilita medios combinados en la
-- interfaz todavía (ver src/lib/installments-rebuild... no, ver
-- POST /payments en index.ts, que en esta etapa sigue aceptando un único
-- medio y crea internamente un solo split).
--
-- payments.amount y payments.paymentMethod NO se tocan — siguen siendo el
-- total y el método resumen de cada pago. payment_splits es aditiva.
--
-- No UNIQUE(payment_id, method): un mismo payment podría en el futuro tener
-- dos splits del mismo método (ej. dos transferencias a cuentas distintas).
--
-- Esta migración SOLO crea estructura — no hace backfill de pagos históricos
-- por sí misma (el SQL de un ALTER/CREATE no puede garantizar por sí solo que
-- el backfill sea idempotente ni abortar ante un pago no backfilleable). El
-- backfill vive en el aplicador TS: src/lib/migrations/apply-0019-payment-splits.ts

CREATE TABLE IF NOT EXISTS payment_splits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  INTEGER NOT NULL REFERENCES payments(id),
  method      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  notes       TEXT,
  created_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_payment_splits_payment_id
ON payment_splits(payment_id);
