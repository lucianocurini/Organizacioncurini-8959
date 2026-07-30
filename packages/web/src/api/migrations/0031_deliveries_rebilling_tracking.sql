-- Migration 0031: seguimiento de Envíos y Entregas vinculado a refacturaciones
-- puntuales (Paso A de la integración formal con Pólizas/Refacturaciones —
-- solo modelo/backend, sin frontend todavía).
--
-- Dos columnas nuevas en deliveries, ambas aditivas y nullable — la tabla NO
-- se recrea, no hay backfill (todo lo histórico queda NULL):
--
--   rebilling_id — FK opcional a rebillings(id). Decisión de negocio: un
--   seguimiento de tipo "refacturación" vinculado a una póliza real
--   (policyId no nulo) DEBE informar también rebillingId, y esa
--   refacturación debe pertenecer a esa misma póliza — validado en la capa
--   de aplicación (src/lib/deliveries/validation.ts), no acá: mismo criterio
--   que el resto de este proyecto, los CHECK de esquema solo restringen
--   vocabulario/forma, nunca reglas de negocio condicionales. Los registros
--   manuales (policyId null) siguen sin vínculo real, por diseño — no
--   compiten por duplicado (ver validation.ts).
--
--   sent_date — fecha en la que el seguimiento pasó a "enviado" (nuevo
--   estado intermedio del flujo pendiente → enviado → entregado). Distinta
--   de scheduled_date (fecha programada, ya existía) y de completed_date
--   (fecha de entregado en el flujo nuevo; en filas históricas con
--   status='realizado' completed_date conserva su significado anterior —
--   NUNCA se reinterpreta ni se reescribe un registro existente).
--
-- Sin CHECK de vocabulario para status/documentType/channel en este
-- archivo — siguen siendo TEXT libres, la whitelist vive en la capa de
-- aplicación (POST/PUT /api/deliveries vía validation.ts), mismo patrón que
-- el resto de las columnas "libres" de este proyecto.
--
-- Índices nuevos: deliveries no tenía ninguno hasta esta migración.
-- idx_deliveries_policy_id e idx_deliveries_rebilling_id — ambos consultados
-- en cada alta/edición para el chequeo de anti-duplicado (mismo criterio que
-- idx_policy_installments_rebilling_id, migración 0017).
--
-- Aplicada localmente (dev.db) por el aplicador idempotente TS
-- (src/lib/migrations/apply-0031-deliveries-rebilling-tracking.ts) — NO se
-- corrió contra Turso/producción.

ALTER TABLE deliveries ADD COLUMN rebilling_id INTEGER REFERENCES rebillings(id);
ALTER TABLE deliveries ADD COLUMN sent_date TEXT;

CREATE INDEX IF NOT EXISTS idx_deliveries_policy_id ON deliveries(policy_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_rebilling_id ON deliveries(rebilling_id);
