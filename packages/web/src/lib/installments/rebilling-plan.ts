// Lógica pura reutilizable para generar/regenerar el grupo de cuotas que una
// refacturación puntual aporta a policy_installments (rebillingId =
// rebillings.id). Sin DB: recibe datos ya leídos/parseados y devuelve
// resultados explícitos — el endpoint (index.ts) hace las queries y decide
// qué hacer con el resultado, mismo patrón que src/lib/installments/rebuild.ts.
//
// Decisión — premium vs. monthlyFee como fuente del total del plan: premium
// sigue siendo información de prima de la refacturación (se guarda tal cual,
// nunca se descarta), pero el importe que se distribuye entre las cuotas es
// SIEMPRE monthlyFee * installmentCount. No son necesariamente iguales (ej.
// premium puede incluir impuestos/recargos que no se cobran en cuotas) — usar
// premium como total del plan mezclaría ambos conceptos silenciosamente.
//
// Decisión — validación de firstDueDate: no se agrega acá ninguna regla de
// tolerancia de "unos días antes/después" del período. buildInstallmentPlan
// ya es la única función de cálculo del proyecto (ver plan.ts) y ya exige
// firstDueDate dentro de [periodStart, periodEnd] con un mensaje de error
// claro — inventar una segunda regla más laxa acá duplicaría (y podría
// contradecir) esa validación central. Si una fecha "razonable" cae fuera de
// rango, buildInstallmentPlan la rechaza con InstallmentPlanError y ese
// mensaje se muestra tal cual — no se la fuerza a pasar con una excepción
// comercial ad hoc no documentada en ningún otro lado del sistema.

import { buildInstallmentPlan, type InstallmentPlanResult } from "./plan";

export class RebillingPayloadError extends Error {}

export interface RebillingPayloadRaw {
  billingStart?: unknown;
  billingEnd?: unknown;
  premium?: unknown;
  monthlyFee?: unknown;
  installmentCount?: unknown;
  firstDueDate?: unknown;
  sumInsured?: unknown;
  deductible?: unknown;
  notes?: unknown;
}

export interface RebillingPayload {
  billingStart: string;
  billingEnd: string;
  premium: number | null;
  monthlyFee: number;
  installmentCount: number;
  firstDueDate: string;
  sumInsured: number | null;
  deductible: number | null;
  notes: string | null;
}

function parseOptionalPositiveNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new RebillingPayloadError(`${label} debe ser un número mayor o igual a cero.`);
  }
  return n;
}

/**
 * Valida y normaliza el payload de POST/PUT /rebillings cuando se van a
 * generar cuotas (installmentCount + firstDueDate presentes y obligatorios).
 * No valida orden de fechas ni rango de firstDueDate — eso lo hace
 * buildInstallmentPlan (ver nota de diseño arriba).
 */
export function parseRebillingPayload(body: RebillingPayloadRaw): RebillingPayload {
  if (typeof body.billingStart !== "string" || !body.billingStart) {
    throw new RebillingPayloadError("Falta la fecha de inicio de vigencia (billingStart).");
  }
  if (typeof body.billingEnd !== "string" || !body.billingEnd) {
    throw new RebillingPayloadError("Falta la fecha de fin de vigencia (billingEnd).");
  }
  if (typeof body.firstDueDate !== "string" || !body.firstDueDate) {
    throw new RebillingPayloadError("Falta la fecha de la primera cuota (firstDueDate).");
  }

  const installmentCount = Number(body.installmentCount);
  if (!Number.isInteger(installmentCount) || installmentCount <= 0) {
    throw new RebillingPayloadError("La cantidad de cuotas debe ser un entero mayor a cero.");
  }

  const monthlyFee = Number(body.monthlyFee);
  if (!Number.isFinite(monthlyFee) || monthlyFee <= 0) {
    throw new RebillingPayloadError("La cuota mensual debe ser un número mayor a cero.");
  }

  const premium = parseOptionalPositiveNumber(body.premium, "La prima");
  const sumInsured = parseOptionalPositiveNumber(body.sumInsured, "La suma asegurada");
  const deductible = parseOptionalPositiveNumber(body.deductible, "La franquicia");

  return {
    billingStart: body.billingStart,
    billingEnd: body.billingEnd,
    premium,
    monthlyFee,
    installmentCount,
    firstDueDate: body.firstDueDate,
    sumInsured,
    deductible,
    notes: typeof body.notes === "string" && body.notes ? body.notes : null,
  };
}

/**
 * Construye el plan de cuotas de una refacturación. El importe total
 * SIEMPRE es monthlyFee * installmentCount — nunca premium (ver nota de
 * diseño arriba). Puede lanzar InstallmentPlanError (período/fechas
 * inválidas, plan que no entra en el rango facturado, etc.).
 */
export function buildRebillingInstallmentPlan(payload: RebillingPayload): InstallmentPlanResult {
  return buildInstallmentPlan({
    periodStart: payload.billingStart,
    periodEnd: payload.billingEnd,
    periodAmount: payload.monthlyFee * payload.installmentCount,
    installmentCount: payload.installmentCount,
    firstDueDate: payload.firstDueDate,
  });
}

// ─── Actividad sobre un grupo de cuotas de una refacturación ──────────────

export interface RebillingGroupInstallment {
  id: number;
  status: string;
  rendered: number;
}

/**
 * true si alguna cuota del grupo tiene actividad real: pagada, rendida a la
 * compañía, con un pago vinculado (payments.installmentId) o con una
 * rendición directa (remittance_items). Mismo criterio que ya usa
 * DELETE /rebillings/:id — centralizado acá para que PUT use exactamente la
 * misma regla, en vez de reimplementarla.
 */
export function hasRebillingGroupActivity(
  installments: ReadonlyArray<RebillingGroupInstallment>,
  paidInstallmentIds: ReadonlySet<number>,
  remittedInstallmentIds: ReadonlySet<number>,
): boolean {
  return installments.some(
    (i) =>
      i.status === "pagada" ||
      i.rendered === 1 ||
      paidInstallmentIds.has(i.id) ||
      remittedInstallmentIds.has(i.id)
  );
}
