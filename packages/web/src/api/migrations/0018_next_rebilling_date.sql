-- Migration 0018: próxima fecha de refacturación
-- Campo manual, nullable, independiente de start_date/end_date. No dispara
-- ninguna refacturación automática ni se sobrescribe solo. Filas existentes
-- quedan con NULL (no hay backfill).

ALTER TABLE policies ADD COLUMN next_rebilling_date TEXT;
