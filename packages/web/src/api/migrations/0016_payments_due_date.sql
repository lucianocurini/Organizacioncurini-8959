-- Migration 0016: fecha de vencimiento de cuota en payments
-- Para pagos vinculados a installment, la fuente efectiva es policy_installments.due_date (via JOIN).
-- Para pagos manuales sin installmentId, se guarda en esta columna.
-- Filas existentes quedan con NULL (sin impacto).

ALTER TABLE payments ADD COLUMN due_date TEXT;
