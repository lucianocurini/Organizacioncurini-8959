-- Migration 0025: refacturación genera su propio grupo de cuotas
--
-- Hasta esta migración, POST /policies/:id/rebillings solo insertaba la fila
-- en rebillings — nunca generaba policy_installments (bug: una refacturación
-- se guardaba pero no producía cuotas nuevas). policy_installments.rebilling_id
-- ya existe desde la migración 0017, pero rebillings no tenía los datos que
-- hacen falta para construir el plan de esas cuotas (buildInstallmentPlan
-- exige installmentCount y firstDueDate como entradas explícitas — nunca se
-- infieren del billingCycle ni del período).
--
-- installment_count: cantidad de cuotas de ESTA refacturación puntual. NULL
--   en refacturaciones históricas que nunca generaron cuotas (el bug que
--   motiva esta migración) — se completa recién cuando alguien edita esa
--   refacturación y aporta el dato (ver PUT /rebillings/:id, caso A).
-- first_due_date: vencimiento de la primera cuota del grupo. Puede
--   precargarse con billing_start en el formulario, pero es un valor propio
--   guardado, no un cálculo derivado — puede diferir de billing_start.
-- deductible: franquicia vigente al momento de esta refacturación (histórico
--   por período, mismo patrón que premium/monthly_fee/sum_insured). Separada
--   de policies.deductible, que sigue siendo la franquicia VIGENTE actual.
--
-- Todas nullable, sin backfill: ninguna fila de rebillings existente cambia
-- de valor por este ALTER TABLE — las refacturaciones históricas quedan con
-- las tres columnas en NULL hasta que alguien las complete a mano (PUT).

ALTER TABLE rebillings ADD COLUMN installment_count INTEGER;
ALTER TABLE rebillings ADD COLUMN first_due_date TEXT;
ALTER TABLE rebillings ADD COLUMN deductible REAL;
