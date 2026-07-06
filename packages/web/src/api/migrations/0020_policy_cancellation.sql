-- Migration 0020: anulación manual de pólizas
--
-- Agrega a policies los campos necesarios para auditar una anulación manual
-- (POST /api/policies/:id/cancel), sin cambiar el significado de status
-- (sigue siendo "cancelada", el mismo valor que ya escriben los importadores
-- — ver los 7 call-sites en index.ts) ni de endDate (sigue siendo la fecha
-- contractual original; cancellation_effective_date es el corte real de
-- cobertura, que puede no coincidir con endDate ni con la fecha en que se
-- carga la anulación).
--
-- cancellation_source distingue el origen de la anulación:
--   'manual'     — cargada por un usuario vía el endpoint dedicado.
--   'importador' — reservado para cuando los 7 call-sites de importadores
--                  empiecen a completarlo (deuda futura, no en esta vuelta).
--   NULL         — pólizas históricas canceladas antes de este campo, o
--                  cualquier anulación que no pase por ninguno de los dos
--                  flujos anteriores. NUNCA se infiere ni se backfillea.
--
-- Todos los campos son nullable: compatibilidad total con pólizas existentes
-- (activas, vencidas, o ya canceladas por un importador antes de esta
-- migración) — ninguna fila cambia de valor por este ALTER TABLE.
--
-- Sin CHECK nuevo sobre policies.status (no se agrega en esta vuelta, ver
-- diagnóstico previo — status sigue siendo texto libre a nivel DB).

ALTER TABLE policies ADD COLUMN cancelled_at INTEGER;
ALTER TABLE policies ADD COLUMN cancellation_effective_date TEXT;
ALTER TABLE policies ADD COLUMN cancellation_reason TEXT;
ALTER TABLE policies ADD COLUMN cancellation_notes TEXT;
ALTER TABLE policies ADD COLUMN cancelled_by INTEGER REFERENCES users(id);
ALTER TABLE policies ADD COLUMN cancellation_source TEXT;

-- Uso concreto: GET /api/received... (no aplica acá) — para esta migración,
-- los dos índices sirven a consultas reales:
--   idx_policies_cancellation_effective_date: futuras pantallas/reportes que
--     listen anulaciones por rango de fecha efectiva (ej. "pólizas anuladas
--     este mes").
--   idx_policies_cancelled_by: auditoría — "qué anuló este usuario".
-- No se agrega índice sobre cancellation_source ni cancellation_reason: no
-- hay ningún consumidor previsto que filtre por esas columnas todavía.
CREATE INDEX IF NOT EXISTS idx_policies_cancellation_effective_date ON policies(cancellation_effective_date);
CREATE INDEX IF NOT EXISTS idx_policies_cancelled_by ON policies(cancelled_by);
