-- Migration 0021: medios reales de un cobro múltiple (Etapa 4A)
--
-- Los medios de pago de un payment_batch viven acá, una sola vez por medio
-- (nunca repartidos por cuota) — mismo rol que payment_splits pero para el
-- encabezado del batch en vez de un payment individual.
--
-- SUM(amount_cents) de un batch debe ser exactamente
-- payment_batches.total_received_cents (base + recargos Pronto Pago
-- incluidos, sin descomponer el instrumento — ver 0020 y
-- src/lib/payments/batches.ts).
--
-- ON DELETE RESTRICT (no CASCADE): un split de batch es, desde la Etapa 4B,
-- el punto donde cuelgan los cheques concretos (received_checks). Borrar un
-- payment_batches en cascada borraría silenciosamente esos instrumentos ya
-- entregados/usados — se prefiere que intentar borrar un batch con splits
-- falle explícitamente antes que perder trazabilidad de un cheque real. Nota:
-- este proyecto no habilita PRAGMA foreign_keys, así que esta cláusula es
-- hoy documentación de la intención, no una restricción activa de SQLite —
-- la validación real de "no borrar un batch con splits en uso" queda a cargo
-- del código de aplicación cuando se implemente DELETE/anulación (no en 4A).
--
-- method NUNCA puede ser "lote" ni "combinado" — esos son valores de resumen
-- del payment padre/hijo, no medios reales. Mismo vocabulario de métodos
-- reales que ya usa payment_splits.method.
--
-- Sin backfill: no existe ningún payment_batch histórico para el que crear splits.

CREATE TABLE IF NOT EXISTS payment_batch_splits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     INTEGER NOT NULL REFERENCES payment_batches(id) ON DELETE RESTRICT,
  method       TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'cheque', 'link_pago', 'transferencia_compania')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  notes        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_batch_splits_batch_id ON payment_batch_splits(batch_id);
CREATE INDEX IF NOT EXISTS idx_payment_batch_splits_method ON payment_batch_splits(method);
