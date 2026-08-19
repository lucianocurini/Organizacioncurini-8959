-- Migración 0035: invalidación trazable de cuotas y refacturaciones
-- duplicadas.
--
-- ── Contexto ──────────────────────────────────────────────────────────────
-- El importador de El Norte generaba, en ciertos casos, refacturaciones
-- exactamente duplicadas (mismo policy_id/billing_start/billing_end/premium)
-- y, en consecuencia, cuotas (policy_installments) duplicadas (mismo
-- policy_id/rebilling_id/due_date/amount). La causa raíz del importador ya
-- se corrigió por separado (checkDuplicateRebilling movido dentro de la
-- transacción) — esta migración NO toca importadores, solo prepara el
-- esquema para invalidar de forma trazable lo que ya quedó duplicado en el
-- histórico. El saneamiento de datos en sí se hace con un script aparte,
-- después de esta migración (ver scripts/ — gitignorado).
--
-- ── Por qué "duplicada" y no "anulada"/"no_exigible" ─────────────────────
-- "anulada" no existe como valor de policy_installments.status hoy;
-- "no_exigible" ya tiene un significado propio y distinto (cuota de una
-- póliza cancelada manualmente, con cobertura real que dejó de existir —
-- ver policies.cancelledAt/cancellationEffectiveDate). Una cuota/
-- refacturación "duplicada" nunca tuvo cobertura real propia: es un
-- registro sobrante generado por error de importación sobre un período que
-- ya estaba correctamente facturado por su gemela canónica. Mezclar ambos
-- conceptos bajo el mismo valor rompería cualquier lógica que ya distingue
-- pólizas ancealadas de duplicados de importación. Mismo criterio para
-- rebillings: se agrega `status` (columna nueva, no existía) en vez de
-- reusar cualquier otro campo.
--
-- ── Por qué NO se toca `status` con un CHECK ──────────────────────────────
-- policy_installments.status nunca tuvo CHECK a nivel DB (confirmado
-- contra el esquema real: pendiente/pagada/vencida/no_exigible conviven
-- sin ninguna restricción SQL, igual que el resto de los campos "enum de
-- texto libre" de este proyecto — ver comentario de cabecera de
-- paymentSplits en schema.ts). "duplicada" se admite de la misma forma:
-- ningún ALTER de constraint, se documenta acá y en schema.ts, se valida a
-- nivel aplicación en cada consumidor (Etapa 2 de este trabajo).
--
-- ── Autorreferencia ────────────────────────────────────────────────────────
-- duplicate_of_installment_id / duplicate_of_rebilling_id apuntan a la fila
-- CANÓNICA (la que se conserva activa) dentro de la MISMA tabla. SQLite
-- permite declarar la FK inline en ALTER TABLE ADD COLUMN aunque la
-- referencia sea a la propia tabla que se está alterando — no hace falta
-- reconstruir la tabla para esto (a diferencia de agregar/cambiar un CHECK
-- existente, que sí lo requeriría). La columna es NULLABLE y arranca en
-- NULL para todas las filas existentes: una fila "duplicada" la completa
-- con el id de su canónica; una fila normal (activa/pagada/vencida/
-- no_exigible, o una refacturación 'activa') la deja NULL para siempre.
--
-- ── Sin índice UNIQUE todavía ──────────────────────────────────────────────
-- A propósito: el histórico TODAVÍA tiene duplicados reales sin sanear
-- (114 grupos de refacturaciones, 603 grupos de cuotas — ver diagnóstico).
-- Un UNIQUE(policy_id, rebilling_id, due_date, amount) o
-- UNIQUE(policy_id, billing_start, billing_end, premium) hoy fallaría
-- inmediatamente contra los datos existentes. Ese índice se agrega en una
-- migración POSTERIOR, después de correr el saneamiento (script aparte) y
-- confirmar que el histórico quedó limpio.
--
-- ── Puramente aditiva ────────────────────────────────────────────────────
-- Solo ALTER TABLE ADD COLUMN (todas nullable o con DEFAULT válido para
-- ADD COLUMN). Ninguna tabla se recrea, ninguna fila existente cambia,
-- ningún dato se borra. Idempotente (ver
-- src/lib/migrations/apply-0035-traceable-duplicate-invalidation.ts).

-- ─── policy_installments ────────────────────────────────────────────────
ALTER TABLE policy_installments ADD COLUMN duplicate_of_installment_id INTEGER REFERENCES policy_installments(id);
ALTER TABLE policy_installments ADD COLUMN invalidated_at INTEGER;
ALTER TABLE policy_installments ADD COLUMN invalidated_by INTEGER REFERENCES users(id);
ALTER TABLE policy_installments ADD COLUMN invalidation_reason TEXT;

-- ─── rebillings ─────────────────────────────────────────────────────────
-- status: 'activa' es el valor histórico implícito de TODA fila existente
-- (nunca hubo otro estado hasta ahora) — DEFAULT 'activa' lo deja explícito
-- sin reinterpretar nada.
ALTER TABLE rebillings ADD COLUMN status TEXT NOT NULL DEFAULT 'activa';
ALTER TABLE rebillings ADD COLUMN duplicate_of_rebilling_id INTEGER REFERENCES rebillings(id);
ALTER TABLE rebillings ADD COLUMN invalidated_at INTEGER;
ALTER TABLE rebillings ADD COLUMN invalidated_by INTEGER REFERENCES users(id);
ALTER TABLE rebillings ADD COLUMN invalidation_reason TEXT;

-- Índices de apoyo (no UNIQUE, no bloquean nada) — para que el filtro
-- "excluir duplicada" y la vista de auditoría no hagan table scan.
CREATE INDEX IF NOT EXISTS idx_policy_installments_status ON policy_installments(status);
CREATE INDEX IF NOT EXISTS idx_policy_installments_duplicate_of ON policy_installments(duplicate_of_installment_id);
CREATE INDEX IF NOT EXISTS idx_rebillings_status ON rebillings(status);
CREATE INDEX IF NOT EXISTS idx_rebillings_duplicate_of ON rebillings(duplicate_of_rebilling_id);
