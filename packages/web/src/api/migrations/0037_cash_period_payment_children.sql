-- Migración 0037: contado por período en un lote mixto.
--
-- ── Contexto ──────────────────────────────────────────────────────────────
-- Hasta acá un cobro de contado por período (cash_period_payments, 0034)
-- siempre era un payment_batches propio y EXCLUSIVO: todos sus payments hijos
-- eran cuotas de ese período, así que "hijo de un lote con contado" alcanzaba
-- para saber que una cuota estaba cancelada por el contado. Con esta etapa
-- "Cobrar en lote" admite el contado de un período (emisión o refacturación)
-- junto con cuotas comunes de otras pólizas, pagado con uno o varios
-- cheques: dentro de un mismo lote conviven hijos del contado y hijos
-- comunes, y hay que distinguirlos sin deducirlo de importes ni de pólizas.
--
-- ── Cambio ────────────────────────────────────────────────────────────────
-- payments.cash_period_payment_id (nullable, FK a cash_period_payments):
-- con valor = cuota cancelada por ese contado; NULL = cualquier otro pago
-- (standalone, hijo común de lote, hijo común de un lote mixto).
--
-- ── Backfill ──────────────────────────────────────────────────────────────
-- Determinístico: todo hijo de un lote que tiene contado se vincula a ese
-- contado (el índice único ux_cash_period_payments_batch_id garantiza uno
-- solo), pero SOLO en lotes cuyo contado todavía no tiene ningún hijo
-- vinculado: así re-ejecutarlo nunca toca las cuotas comunes de un lote
-- mixto creado después (que quedan en NULL a propósito). Es exacto para el
-- histórico porque, hasta esta migración, POST
-- /payment-batches/cash-period-payment nunca creó otra cosa que cuotas del
-- período. El aplicador (src/lib/migrations/apply-0037-cash-period-payment-
-- children.ts) además verifica ANTES de escribir que cada hijo sea una cuota
-- de la póliza/refacturación de su contado y aborta sin vincular nada si
-- algún dato histórico no cumple — nunca inventa una relación dudosa.
--
-- ── Puramente aditiva ─────────────────────────────────────────────────────
-- Una columna nullable + un índice no único + el backfill. Ninguna tabla se
-- recrea, ninguna fila se borra, ningún importe cambia. El índice único de
-- 0034 (un contado por lote) se mantiene a propósito: esta etapa admite un
-- contado y varias cuotas comunes, no varios contados en un mismo lote.
--
-- Ejecutar en Turso con el aplicador (client.transaction("write")), no
-- sentencia por sentencia: el aplicador es idempotente y valida integridad.

ALTER TABLE payments ADD COLUMN cash_period_payment_id INTEGER REFERENCES cash_period_payments(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_payments_cash_period_payment_id ON payments(cash_period_payment_id);
--> statement-breakpoint
UPDATE payments
  SET cash_period_payment_id = (
    SELECT cpp.id FROM cash_period_payments cpp WHERE cpp.payment_batch_id = payments.batch_id
  )
  WHERE cash_period_payment_id IS NULL
    AND batch_id IS NOT NULL
    AND batch_id IN (
      SELECT cpp.payment_batch_id FROM cash_period_payments cpp
      WHERE NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.cash_period_payment_id = cpp.id)
    );
