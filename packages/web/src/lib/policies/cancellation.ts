// Validación y clasificación pura para la anulación manual de pólizas
// (POST /api/policies/:id/cancel). Sin DB, sin efectos secundarios — recibe
// datos ya resueltos por el endpoint (que sí consulta la base) y devuelve
// resultados explícitos, mismo estilo que src/lib/installments/rebuild.ts y
// src/lib/payments/batches.ts.
//
// Fechas: siempre strings YYYY-MM-DD comparadas léxicamente (nunca `new
// Date(...)` local) — evita desfases de zona horaria, mismo criterio que
// isValidCalendarDate/addCalendarMonths en installments/plan.ts.

import { isValidCalendarDate } from "../installments/plan";

export class PolicyCancellationValidationError extends Error {}

// Marcador de "la póliza se canceló entre la lectura previa y la transacción"
// (misma ventana TOCTOU que ya documenta rebuild.ts) — el endpoint la mapea
// a 409, distinto de un 400 de validación de datos.
export class PolicyAlreadyCancelledError extends Error {}

// ─── Fecha efectiva ────────────────────────────────────────────────────────────

export interface PolicyCancellationInput {
  effectiveDate: string;
  reason: string;
  notes?: string | null;
}

export interface PolicyCancellationMetadata {
  effectiveDate: string;
  reason: string;
  notes: string | null;
}

/**
 * effectiveDate debe ser una fecha calendario real (YYYY-MM-DD), no anterior
 * a policy.startDate, y si policy.endDate existe, no posterior a esa fecha.
 * Lanza PolicyCancellationValidationError con un mensaje listo para mostrar.
 */
export function validateCancellationEffectiveDate(
  effectiveDate: string,
  policy: { startDate: string; endDate: string | null }
): void {
  if (typeof effectiveDate !== "string" || !isValidCalendarDate(effectiveDate)) {
    throw new PolicyCancellationValidationError(`La fecha efectiva de anulación no es una fecha calendario válida: ${effectiveDate}.`);
  }
  if (effectiveDate < policy.startDate) {
    throw new PolicyCancellationValidationError(
      `La fecha efectiva (${effectiveDate}) no puede ser anterior al inicio de la póliza (${policy.startDate}).`
    );
  }
  if (policy.endDate != null && effectiveDate > policy.endDate) {
    throw new PolicyCancellationValidationError(
      `La fecha efectiva (${effectiveDate}) no puede ser posterior al fin de la póliza (${policy.endDate}).`
    );
  }
}

// ─── Estado de la póliza ────────────────────────────────────────────────────────

export interface PolicyCancellationValidationResult {
  valid: boolean;
  errorMessage: string | null;
}

/**
 * Único chequeo de estado antes de anular: la póliza no puede estar ya
 * cancelada (no-throwing — mismo estilo que validateBatchTotals en
 * payments/batches.ts, para que el endpoint decida el código HTTP). No hay
 * rehabilitación en esta versión, así que cualquier otro status (activa,
 * vencida, por_vencer, incluso "renovada") es válido para anular.
 */
export function validatePolicyCancellationState(status: string): PolicyCancellationValidationResult {
  if (status === "cancelada") {
    return { valid: false, errorMessage: "La póliza ya está cancelada." };
  }
  return { valid: true, errorMessage: null };
}

// ─── Clasificación de cuotas ─────────────────────────────────────────────────────

export interface InstallmentForCancellation {
  id: number;
  dueDate: string;
  status: string;
  rendered: number;
}

export interface InstallmentCancellationClassification {
  paidUnchanged: InstallmentForCancellation[];
  renderedUnchanged: InstallmentForCancellation[];
  priorDebtUnchanged: InstallmentForCancellation[];
  futureNonCollectible: InstallmentForCancellation[];
  duplicateUnchanged: InstallmentForCancellation[];
}

/**
 * Clasifica las cuotas de una póliza según lo que la anulación debe hacerles.
 * Cada cuota cae en EXACTAMENTE un bucket, con esta precedencia:
 *   0. status="duplicada"    -> duplicateUnchanged (nunca se toca — no es parte
 *      del plan real, la anulación de la póliza no le compete; ver Migración
 *      0035. Precedencia MÁS ALTA que "pagada": una fila duplicada nunca
 *      puede estar pagada de verdad — si lo estuviera, sería un error de
 *      datos anterior a esta clasificación, no algo que decidir acá).
 *   1. status="pagada"      -> paidUnchanged (nunca se toca, sea cual sea la fecha)
 *   2. rendered=1            -> renderedUnchanged (nunca se toca, aunque no esté "pagada")
 *   3. dueDate < effectiveDate -> priorDebtUnchanged (deuda anterior, sigue exigible)
 *   4. dueDate >= effectiveDate -> futureNonCollectible (pasa a "no_exigible")
 * Puro: no toca la base, no muta `installments`. El orden de precedencia
 * importa — una cuota pagada con dueDate posterior a effectiveDate sigue
 * siendo "paidUnchanged", nunca "futureNonCollectible" (nunca se perdona ni
 * se retoca lo ya cobrado); una duplicada NUNCA pasa a "no_exigible" — eso
 * pisaría el marcador de auditoría de la Migración 0035 (ver
 * src/lib/installments/duplicate-status.ts).
 */
export function classifyInstallmentsForCancellation(
  installments: InstallmentForCancellation[],
  effectiveDate: string
): InstallmentCancellationClassification {
  const result: InstallmentCancellationClassification = {
    paidUnchanged: [], renderedUnchanged: [], priorDebtUnchanged: [], futureNonCollectible: [], duplicateUnchanged: [],
  };
  for (const inst of installments) {
    if (inst.status === "duplicada") { result.duplicateUnchanged.push(inst); continue; }
    if (inst.status === "pagada") { result.paidUnchanged.push(inst); continue; }
    if (inst.rendered === 1) { result.renderedUnchanged.push(inst); continue; }
    if (inst.dueDate < effectiveDate) { result.priorDebtUnchanged.push(inst); continue; }
    result.futureNonCollectible.push(inst);
  }
  return result;
}

/** Único criterio de "esta cuota ya no se puede cobrar" — usado por los guards de payments. */
export function isInstallmentNonCollectible(status: string): boolean {
  return status === "no_exigible";
}

// ─── Nota de auditoría ───────────────────────────────────────────────────────────

/**
 * Concatena la nota de anulación al notes existente, mismo formato " | " que
 * ya usan los 7 call-sites de anulación por importador en index.ts — una
 * sola convención de concatenación de notas en el proyecto, no dos.
 */
export function appendCancellationNote(existingNotes: string | null | undefined, reason: string, notes?: string | null): string {
  const parts = [`Anulada manualmente. Motivo: ${reason}`];
  if (notes && notes.trim()) parts.push(notes.trim());
  const addition = parts.join(" — ");
  return existingNotes && existingNotes.trim() ? `${existingNotes} | ${addition}` : addition;
}
