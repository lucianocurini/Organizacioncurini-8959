-- Migration 0013: Rendición de cuotas no cobradas
-- Agrega rendered y rendered_at a policy_installments para permitir
-- rendir cuotas a compañía aunque el asegurado aún no haya pagado.

ALTER TABLE policy_installments ADD COLUMN rendered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE policy_installments ADD COLUMN rendered_at INTEGER;
