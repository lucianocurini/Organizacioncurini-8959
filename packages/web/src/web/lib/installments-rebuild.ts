// Helpers puros para la interfaz de reconstrucción segura de planes de cuotas
// (Subetapa 2B). Sin React, sin fetch, sin DOM — así se pueden testear con
// bun:test sin infraestructura de componentes (ver __tests__/installments-rebuild.test.ts).
//
// Estos helpers NO deciden si el backend permite reconstruir — esa autoridad
// es siempre `classification`, devuelta por GET/POST /installments/rebuild-check|rebuild.
// Acá solo se arma el pedido, se interpreta la respuesta y se decide qué mostrar.

// ─── 1. Cantidad esperada vs. cantidad real ────────────────────────────────────

export type ExpectedVsActualStatus = "coincide" | "no_coincide" | "sin_definir";

export interface ExpectedVsActual {
  status: ExpectedVsActualStatus;
  expectedCount: number | null;
  actualCount: number;
}

export const EXPECTED_VS_ACTUAL_LABELS: Record<ExpectedVsActualStatus, string> = {
  coincide: "Coinciden",
  no_coincide: "No coinciden",
  sin_definir: "Sin cantidad esperada definida",
};

// expectedCount null nunca es "no coincide" — no hay nada contra qué comparar.
// Misma regla que classifyInstallmentsForRebuild en el backend
// (packages/web/src/lib/installments/rebuild.ts) — no duplicar ese criterio
// con uno distinto acá sería inconsistente entre back y front.
export function compareExpectedVsActual(expectedCount: number | null, actualCount: number): ExpectedVsActual {
  if (expectedCount === null) return { status: "sin_definir", expectedCount, actualCount };
  return { status: expectedCount === actualCount ? "coincide" : "no_coincide", expectedCount, actualCount };
}

// ─── 2. Validación del campo "Cantidad de cuotas esperada" (PolicyModal) ──────

export interface ExpectedInstallmentsParseResult {
  value: number | null;
  error: string | null;
}

const POSITIVE_INTEGER_RE = /^\d+$/;

// Acepta entero positivo, o vacío/null (= "sin definir"). Rechaza cero,
// negativos, decimales y cualquier valor no numérico — con un mensaje que se
// puede mostrar directamente debajo del campo.
export function parseExpectedInstallmentsInput(raw: string): ExpectedInstallmentsParseResult {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { value: null, error: null };
  if (!POSITIVE_INTEGER_RE.test(trimmed)) {
    return { value: null, error: "Debe ser un número entero positivo (o dejarlo vacío)." };
  }
  const n = Number(trimmed);
  if (n <= 0) return { value: null, error: "Debe ser mayor a cero." };
  return { value: n, error: null };
}

// ─── 3. Body exacto para POST /policies/:id/installments/rebuild ──────────────

export interface RebuildFormInput {
  periodStart: string;
  periodEnd: string;
  periodAmount: string;
  installmentCount: string;
  firstDueDate?: string;
  installmentIntervalMonths?: string;
}

export interface RebuildRequestBody {
  periodStart: string;
  periodEnd: string;
  periodAmount: number;
  installmentCount: number;
  firstDueDate?: string;
  installmentIntervalMonths?: number;
}

// Arma exactamente los campos que acepta el backend — nunca cuotas prearmadas.
// buildInstallmentPlan corre server-side; acá solo se envían los parámetros
// de entrada, igual que en la previsualización local.
export function buildRebuildRequestBody(form: RebuildFormInput): RebuildRequestBody {
  const body: RebuildRequestBody = {
    periodStart: form.periodStart,
    periodEnd: form.periodEnd,
    periodAmount: Number(form.periodAmount),
    installmentCount: Number(form.installmentCount),
  };
  if (form.firstDueDate) body.firstDueDate = form.firstDueDate;
  if (form.installmentIntervalMonths) body.installmentIntervalMonths = Number(form.installmentIntervalMonths);
  return body;
}

// ─── 4. Resumen del plan para la confirmación ─────────────────────────────────

export interface RebuildPlanSummary {
  previousCount: number;
  newCount: number;
  totalAmount: number;
  periodStart: string;
  periodEnd: string;
  firstDueDate: string;
  lastDueDate: string;
}

export function summarizeRebuildPlan(
  previousCount: number,
  plan: { installments: { dueDate: string }[]; totalAmount: number },
  periodStart: string,
  periodEnd: string,
): RebuildPlanSummary {
  const first = plan.installments[0];
  const last = plan.installments[plan.installments.length - 1];
  return {
    previousCount,
    newCount: plan.installments.length,
    totalAmount: plan.totalAmount,
    periodStart,
    periodEnd,
    firstDueDate: first?.dueDate ?? "",
    lastDueDate: last?.dueDate ?? "",
  };
}

// ─── 5. Normalización de errores del POST /rebuild ────────────────────────────

export interface RebuildBlockingInstallment {
  id: number;
  number: number;
  dueDate: string;
  reasons: string[];
}

export type RebuildErrorKind = "validation" | "not_found" | "blocked" | "unknown";

export interface NormalizedRebuildError {
  kind: RebuildErrorKind;
  message: string;
  blockingInstallments: RebuildBlockingInstallment[];
}

// `err` es el Error que lanza packages/web/src/web/lib/api.ts: .status viene
// del código HTTP, .body es el JSON completo de la respuesta (agregado ahí
// puntualmente para poder leer blockingInstallments en un 409).
export function normalizeRebuildError(err: { status?: number; message?: string; body?: any }): NormalizedRebuildError {
  const status = err?.status;
  if (status === 404) {
    return { kind: "not_found", message: "La póliza ya no existe o fue eliminada.", blockingInstallments: [] };
  }
  if (status === 409) {
    return {
      kind: "blocked",
      message: err?.body?.error || "El estado de las cuotas cambió — no se puede reconstruir el plan ahora mismo.",
      blockingInstallments: err?.body?.blockingInstallments ?? [],
    };
  }
  if (status === 400) {
    return { kind: "validation", message: err?.message || "El plan de cuotas no es válido.", blockingInstallments: [] };
  }
  return { kind: "unknown", message: "No se pudo reconstruir el plan de cuotas.", blockingInstallments: [] };
}

// ─── 6. Gating del botón de confirmación final ────────────────────────────────

export function canConfirmRebuild(hasValidPlan: boolean, confirmed: boolean): boolean {
  return hasValidPlan && confirmed;
}

// ─── 7. Qué mostrar según la clasificación del backend ────────────────────────

export type RebuildClassification = "NO_INSTALLMENTS" | "SAFE_TO_REBUILD" | "REQUIRES_MANUAL_REVIEW";
export type RebuildUiAction = "open_form" | "show_blocked";

// La autoridad es SIEMPRE `classification`, nunca `mismatched`: una póliza
// puede tener expectedCount null (mismatched siempre false, ver punto 1) y
// aun así requerir revisión manual por una cuota pagada, rendida o con
// rebillingId — mismatched no participa en esta decisión.
export function decideRebuildUiAction(classification: RebuildClassification): RebuildUiAction {
  return classification === "REQUIRES_MANUAL_REVIEW" ? "show_blocked" : "open_form";
}

// ─── 8. ¿Mostrar el botón "Corregir plan de cuotas"? ──────────────────────────

// Visible si hay cuotas reales, o si hay una diferencia esperado/real (aun con
// actualCount = 0 — p.ej. expectedCount=5 y ya no queda ninguna cuota real).
export function shouldShowRebuildButton(actualCount: number, comparison: ExpectedVsActual): boolean {
  return actualCount > 0 || comparison.status === "no_coincide";
}

// ─── 9. ¿La respuesta exitosa debe refrescar el estado local? ─────────────────

// Solo un 200 de éxito dispara refresco de datos y cierre del modal. Cualquier
// otro código (400/404/409) deja la lista de cuotas local intacta — nunca se
// actualiza como si la reconstrucción hubiera ocurrido.
export function shouldRefreshAfterRebuildResponse(status: number): boolean {
  return status === 200;
}
