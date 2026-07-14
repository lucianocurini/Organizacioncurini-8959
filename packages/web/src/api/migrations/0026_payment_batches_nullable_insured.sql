-- Migration 0026: payment_batches.insured_id pasa a ser NULLABLE
--
-- Motivo (Etapa "lote multi-asegurado"): un cobro por lote ya no representa
-- necesariamente a UN asegurado — puede mezclar pólizas de distintos
-- integrantes de una familia, o empezar por una imputación completamente
-- manual (source="manual_payment") que no tiene ningún insuredId real
-- detrás. payment_batches.insured_id queda como dato DERIVADO, nunca como
-- restricción:
--   - si todos los ítems reales del batch comparten el mismo insuredId, se
--     guarda ese valor (compatibilidad con todo el código/reportes que ya
--     lo leían);
--   - si hay más de un asegurado real entre los ítems, o el batch es 100%
--     manual (ningún ítem con insuredId real), se guarda NULL.
--
-- SQLite no permite "ALTER COLUMN ... DROP NOT NULL" directamente — se
-- recrea la tabla completa (mismo procedimiento de 12 pasos documentado por
-- SQLite para cambios de esquema no soportados por ALTER TABLE, ya usado en
-- este proyecto para 0008/0009/0010/0014). insured_id sigue siendo
-- REFERENCES insureds(id) (una FK nullable es válida — NULL nunca se valida
-- contra la tabla referenciada). El resto de las columnas, CHECKs, índices y
-- semántica quedan exactamente iguales a la migración 0021.
--
-- payment_batch_splits.batch_id, payments.batch_id y
-- remittance_allocations.payment_batch_id referencian payment_batches(id)
-- por NOMBRE de tabla — SQLite (legacy_alter_table=OFF, el default moderno,
-- confirmado en libsql) actualiza esas referencias automáticamente al hacer
-- RENAME TO, sin tocar esas tablas hijas. La idempotencia y el
-- procedimiento seguro (PRAGMA foreign_keys=OFF fuera de la transacción,
-- PRAGMA foreign_key_check antes de confirmar) los garantiza el aplicador TS
-- (src/lib/migrations/apply-0026-payment-batches-nullable-insured.ts), no
-- este archivo por sí solo — mismo criterio que toda migración de este
-- proyecto desde 0017 en adelante.

CREATE TABLE payment_batches_new (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  insured_id             INTEGER REFERENCES insureds(id),
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

INSERT INTO payment_batches_new (
  id, insured_id, base_amount_cents, surcharge_amount_cents, total_received_cents,
  payment_date, status, notes, created_by, created_at, updated_at
)
SELECT
  id, insured_id, base_amount_cents, surcharge_amount_cents, total_received_cents,
  payment_date, status, notes, created_by, created_at, updated_at
FROM payment_batches;

DROP TABLE payment_batches;
ALTER TABLE payment_batches_new RENAME TO payment_batches;

CREATE INDEX IF NOT EXISTS idx_payment_batches_insured_id ON payment_batches(insured_id);
CREATE INDEX IF NOT EXISTS idx_payment_batches_payment_date ON payment_batches(payment_date);
CREATE INDEX IF NOT EXISTS idx_payment_batches_status ON payment_batches(status);
