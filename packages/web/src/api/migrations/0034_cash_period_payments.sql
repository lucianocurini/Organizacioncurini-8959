-- Migration 0034: "Pago de contado por período de facturación".
--
-- El pago de contado NO es un medio de pago — es una modalidad comercial
-- para cancelar TODAS las cuotas de un período (emisión/renovación o una
-- refacturación puntual) por un importe menor a la suma nominal financiada.
-- La diferencia es un descuento comercial, nunca un faltante/sobrante/ajuste
-- de redondeo.
--
-- ── Dónde vive el "período" ──────────────────────────────────────────────
-- Este proyecto no tiene una entidad "período" propia: ya se modela como
-- policy_installments agrupadas por (policy_id, rebilling_id) — rebilling_id
-- IS NULL es el período de emisión/renovación, cada rebillings.id es el
-- período de esa refacturación puntual (ver
-- src/web/lib/rebilling-groups.ts, groupInstallmentsByRebilling, mismo
-- criterio reutilizado acá). Por eso el importe contado OPCIONAL se agrega
-- como una columna nullable en la tabla dueña de cada período real —
-- policies para emisión/renovación, rebillings para cada refacturación
-- puntual — nunca una tabla "billing_periods" nueva (duplicaría lo que ya
-- son policies/rebillings como fuente de verdad del período, mismo criterio
-- ya usado por rebillings.installment_count/first_due_date, migración 0025).
--
-- En centavos (cash_payment_amount_cents), no en pesos reales como
-- premium/monthly_fee — es un importe de dinero que participa en cálculos
-- exactos de cobro/descuento, mismo criterio que toda la lógica de dinero
-- nueva del proyecto (payment_batches, payment_splits, etc, a diferencia de
-- premium/monthly_fee que son históricos en REAL).
--
-- ── Auditoría persistente: cash_period_payments ──────────────────────────
-- No alcanza con inferir después "esto fue un pago contado" comparando
-- payment_batches.total_received_cents contra la suma nominal de sus
-- cuotas — eso además chocaría con la interpretación existente de esa
-- diferencia (sobrantes/faltantes, Fase 2B/Migración 0030). Se necesita un
-- registro propio, inmutable una vez creado, que:
--   - sea el discriminador expreso de "este payment_batches es un cobro de
--     período de contado" (join 1:1 por payment_batch_id — su sola
--     existencia con status='confirmado' ES la modalidad, sin agregar
--     ninguna columna nueva a payment_batches, tabla ya muy concurrida);
--   - conserve el nominal/contado/descuento de ESE momento, sin depender de
--     policies.cash_payment_amount_cents/rebillings.cash_payment_amount_cents
--     (esos son editables hasta el momento del cobro — después de cobrado
--     quedan bloqueados a nivel aplicación, pero el registro histórico
--     nunca debe depender de que esa protección se mantenga para siempre);
--   - identifique el período exacto (policy_id + rebilling_id nullable) sin
--     volver a resolverlo desde las cuotas;
--   - trackee su propio estado de rendición (rendered/rendered_at) — el
--     período se rinde como UN SOLO instrumento (ver comentario de POST
--     /remittances en index.ts), a diferencia de un payment_batches común
--     donde cada hijo se rinde por separado (Migración 0029) — por eso este
--     estado no puede vivir en payments.rendered de un hijo puntual, hace
--     falta uno propio del período completo;
--   - trackee su propia anulación (status/cancelled_at/cancelled_by),
--     espejando payment_batches — se anula junto con el batch (POST
--     /payment-batches/:id/cancel), nunca por separado.
--
-- "Cuotas canceladas" (dato pedido como parte de la auditoría) NO se
-- duplica acá: ya es exactamente payments.batch_id = este payment_batch_id
-- (cada hijo con su installment_id real) — mismo criterio de trazabilidad
-- que usa cualquier otro payment_batches del sistema, inmutable una vez
-- creado (ver comentario "ningún payment hijo se borra individualmente").
--
-- nominal_amount_cents = SUM(policy_installments.amount) de las cuotas del
-- período al momento del cobro, en centavos. cash_amount_cents = importe
-- contado efectivamente cobrado (= payment_batches.total_received_cents =
-- payment_batches.received_amount_cents de ESE batch — sin recargos Pronto
-- Pago, sin sobrante/faltante: exactos por construcción, ver
-- src/lib/payments/cash-period-payments.ts). discount_amount_cents =
-- nominal_amount_cents - cash_amount_cents, siempre >= 0 (igual al nominal
-- es un contado sin descuento, permitido explícitamente).
--
-- Anti-duplicado: NO hay UNIQUE(policy_id, rebilling_id) a nivel DB —
-- rebilling_id NULL nunca es "igual" a otro NULL en un índice único de
-- SQLite, así que no protegería el caso más común (período de
-- emisión/renovación). La protección real es la misma que ya usa todo el
-- proyecto para evitar doble cobro de una cuota (PaymentBatchRaceConditionError,
-- doble chequeo dentro de la transacción real): un período con un pago
-- contado ya confirmado tiene TODAS sus cuotas en status='pagada', así que
-- un segundo intento de pago contado para el mismo período ya queda
-- bloqueado por la regla "ninguna cuota puede estar pagada" (Regla 5),
-- sin necesitar un constraint aparte.
--
-- Sin backfill: todo lo histórico queda con cash_payment_amount_cents NULL
-- en policies/rebillings, y cero filas nuevas en cash_period_payments — no
-- se reinterpreta ningún pago existente (Regla 7).

ALTER TABLE policies ADD COLUMN cash_payment_amount_cents INTEGER;
ALTER TABLE rebillings ADD COLUMN cash_payment_amount_cents INTEGER;

CREATE TABLE IF NOT EXISTS cash_period_payments (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_batch_id       INTEGER NOT NULL REFERENCES payment_batches(id),
  policy_id              INTEGER NOT NULL REFERENCES policies(id),
  rebilling_id           INTEGER REFERENCES rebillings(id),
  nominal_amount_cents   INTEGER NOT NULL CHECK (nominal_amount_cents > 0),
  cash_amount_cents      INTEGER NOT NULL CHECK (cash_amount_cents > 0),
  discount_amount_cents  INTEGER NOT NULL CHECK (discount_amount_cents >= 0),
  status                 TEXT NOT NULL DEFAULT 'confirmado' CHECK (status IN ('confirmado', 'anulado')),
  rendered               INTEGER NOT NULL DEFAULT 0,
  rendered_at            INTEGER,
  cancelled_at           INTEGER,
  cancelled_by           INTEGER REFERENCES users(id),
  created_by             INTEGER NOT NULL REFERENCES users(id),
  created_at             INTEGER NOT NULL,
  CHECK (cash_amount_cents <= nominal_amount_cents)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_period_payments_batch_id ON cash_period_payments(payment_batch_id);
CREATE INDEX IF NOT EXISTS idx_cash_period_payments_policy_rebilling ON cash_period_payments(policy_id, rebilling_id);
