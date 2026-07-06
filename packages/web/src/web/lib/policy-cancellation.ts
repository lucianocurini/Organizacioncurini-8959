// Helpers puros para la interfaz de anulación manual de pólizas. Sin React,
// sin fetch, sin DOM — así se pueden testear con bun:test sin infraestructura
// de componentes, mismo estilo que installments-rebuild.ts.
//
// Estos helpers NO deciden si el backend permite anular — esa autoridad es
// siempre la respuesta de POST /policies/:id/cancel(/preview). Acá solo se
// arma el pedido, se interpreta la respuesta y se decide qué mostrar/habilitar.

// ─── 1. ¿Mostrar el botón "Anular póliza"? ─────────────────────────────────────

// Oculto para una póliza ya cancelada — no hay rehabilitación manual en esta
// versión (ver diagnóstico), así que no tiene sentido ofrecer "anular" de nuevo.
export function shouldShowCancelButton(policyStatus: string): boolean {
  return policyStatus !== "cancelada";
}

// Fuente única del label visual de policy_installments.status="no_exigible"
// (usado en poliza-detail.tsx) — evita que el texto quede solo como literal
// embebido en el JSX, sin ningún lugar testeable.
export const NON_COLLECTIBLE_STATUS_LABEL = "No exigible";

// ─── 2. Formulario ──────────────────────────────────────────────────────────────

export interface CancellationFormInput {
  effectiveDate: string;
  reason: string;
  notes: string;
}

// Validación mínima de forma para habilitar el pedido de preview — la
// validación real (rango de fechas contra la póliza) es siempre del backend.
export function isCancellationFormComplete(form: CancellationFormInput): boolean {
  return !!form.effectiveDate && !!form.reason.trim();
}

// ─── 3. Resumen del preview ─────────────────────────────────────────────────────

export interface CancellationPreviewSummary {
  policy: any;
  effectiveDate: string;
  installments: {
    paidUnchanged: number;
    renderedUnchanged: number;
    priorDebtUnchanged: number;
    markedNonCollectible: number;
  };
  pendingPaymentsToRender: number;
}

// ─── 4. Gating del botón de confirmación final ────────────────────────────────

// Igual que canConfirmRebuild: solo se habilita con preview cargado sin
// error, formulario completo, y checkbox de confirmación explícita marcado.
export function canConfirmCancellation(
  form: CancellationFormInput,
  hasValidPreview: boolean,
  confirmed: boolean
): boolean {
  return isCancellationFormComplete(form) && hasValidPreview && confirmed;
}

// ─── 5. Normalización de errores ────────────────────────────────────────────────

export type CancellationErrorKind = "validation" | "not_found" | "already_cancelled" | "unknown";

export interface NormalizedCancellationError {
  kind: CancellationErrorKind;
  message: string;
}

// `err` es el Error que lanza packages/web/src/web/lib/api.ts: .status viene
// del código HTTP, .body es el JSON completo de la respuesta.
export function normalizeCancellationError(err: { status?: number; message?: string; body?: any }): NormalizedCancellationError {
  const status = err?.status;
  if (status === 404) {
    return { kind: "not_found", message: "La póliza ya no existe o fue eliminada." };
  }
  if (status === 409) {
    return { kind: "already_cancelled", message: err?.body?.error || "La póliza ya está cancelada." };
  }
  if (status === 400) {
    return { kind: "validation", message: err?.body?.error || err?.message || "Los datos de la anulación no son válidos." };
  }
  return { kind: "unknown", message: "No se pudo anular la póliza." };
}

// ─── 6. ¿La respuesta exitosa debe refrescar el estado local? ─────────────────

export function shouldRefreshAfterCancelResponse(status: number): boolean {
  return status === 200;
}
