-- Migration 0027: anulación segura de payment_batches con trazabilidad
--
-- Dos cambios aditivos (ALTER TABLE ADD COLUMN, sin rebuild — a diferencia de
-- la 0026, ninguna de estas columnas necesita perder un NOT NULL existente):
--
-- 1. payment_batches gana 3 columnas de auditoría, mismo patrón que
--    policies.cancelled_at/cancelled_by/cancellation_reason (migración 0020):
--    quién anuló el lote, cuándo, y por qué. payment_batches.status ya
--    admitía 'anulado' desde la migración 0021 (CHECK status IN
--    ('confirmado','anulado')) — nunca se usó hasta ahora porque no existía
--    ningún endpoint que hiciera esa transición (ver validateBatchStatusTransition
--    en src/lib/payments/batches.ts, ya escrita y testeada pero sin uso).
--
-- 2. cash_entries gana `status` (activo|anulado, texto libre a nivel DB,
--    mismo criterio sin CHECK que ya usa cash_expenses.status) y `voided_at`.
--    Diagnóstico: cash_entries NO tenía ningún estado — un recargo Pronto
--    Pago Rivadavia generado por un payment_batches (cash_entries.payment_id
--    = un payment hijo del batch, entry_type='pronto_pago_surcharge') no
--    podía marcarse como anulado sin borrarlo físicamente. Nunca se
--    contaba dos veces en Caja (GET /cash/summary ya excluye explícitamente
--    todo cash_entries de tipo pronto_pago_surcharge cuyo payment pertenezca
--    a un batch — su importe ya está una sola vez dentro de
--    payment_batch_splits), así que este campo es una mejora de trazabilidad
--    y de defensa (impedir que se ofrezca en /remittances/pending), no una
--    corrección de un total mal calculado.
--
-- Sin backfill: todas las filas existentes quedan con
-- cancelled_at/cancelled_by/cancellation_reason NULL y cash_entries.status
-- ='activo' (el DEFAULT), voided_at NULL — ninguna fila cambia de
-- significado.

ALTER TABLE payment_batches ADD COLUMN cancelled_at INTEGER;
ALTER TABLE payment_batches ADD COLUMN cancelled_by INTEGER REFERENCES users(id);
ALTER TABLE payment_batches ADD COLUMN cancellation_reason TEXT;

ALTER TABLE cash_entries ADD COLUMN status TEXT NOT NULL DEFAULT 'activo';
ALTER TABLE cash_entries ADD COLUMN voided_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_payment_batches_cancelled_by ON payment_batches(cancelled_by);
CREATE INDEX IF NOT EXISTS idx_cash_entries_status ON cash_entries(status);
