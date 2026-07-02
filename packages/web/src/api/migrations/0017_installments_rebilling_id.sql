-- Migration 0017: vínculo explícito entre cuotas y refacturaciones
-- Permite saber si una cuota es base de la póliza (rebilling_id = NULL)
-- o fue generada por una refacturación puntual (rebilling_id = rebillings.id).
-- No usa ON DELETE CASCADE ni ON DELETE SET NULL: el borrado de una
-- refacturación y sus cuotas lo controla explícitamente el endpoint.
-- Filas existentes quedan con NULL (cuotas históricas sin vínculo).

ALTER TABLE policy_installments ADD COLUMN rebilling_id INTEGER REFERENCES rebillings(id);

CREATE INDEX IF NOT EXISTS idx_policy_installments_rebilling_id
ON policy_installments(rebilling_id);
