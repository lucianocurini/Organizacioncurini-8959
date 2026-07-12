// Lógica pura del modal de refacturaciones (RebillingModal.tsx) — separa
// "editar datos de la refacturación" (nunca toca cuotas) de "alta nueva"
// (siempre exige datos de plan). Sin React, sin fetch — testeable con
// bun:test, mismo patrón que policy-cancellation.ts / installments-rebuild.ts.
//
// El modo se decide EXCLUSIVAMENTE por isEditMode (equivalente a !!initial en
// el componente) — nunca por installmentCount ni por ningún otro campo del
// plan. Esa es justamente la separación que esta etapa introduce.

export interface RebillingModalFormState {
  billingStart: string;
  billingEnd: string;
  premium: string;
  monthlyFee: string;
  installmentCount: string;
  firstDueDate: string;
  sumInsured: string;
  deductible: string;
  notes: string;
}

export function validateRebillingForm(form: RebillingModalFormState, isEditMode: boolean): string | null {
  if (!form.billingStart || !form.billingEnd) return "Completá las fechas de vigencia de la refacturación";
  if (form.billingStart > form.billingEnd) return "El inicio de vigencia no puede ser posterior al fin de vigencia";

  // Cantidad de cuotas y primer vencimiento SOLO se exigen en alta. En
  // edición, ni siquiera se muestran — pertenecen a "Corregir plan de cuotas".
  if (!isEditMode) {
    if (!form.firstDueDate) return "Completá la fecha de la primera cuota";
    const count = Number(form.installmentCount);
    if (!form.installmentCount || !Number.isInteger(count) || count <= 0) {
      return "La cantidad de cuotas debe ser un entero mayor a cero";
    }
    const fee = Number(form.monthlyFee);
    if (!form.monthlyFee || !Number.isFinite(fee) || fee <= 0) {
      return "La cuota mensual debe ser mayor a cero";
    }
  }

  if (form.deductible !== "" && (!Number.isFinite(Number(form.deductible)) || Number(form.deductible) < 0)) {
    return "La franquicia debe ser un número mayor o igual a cero";
  }
  return null;
}

export interface RebillingEditPayload {
  billingStart: string;
  billingEnd: string;
  premium: number | null;
  monthlyFee: number | null;
  sumInsured: number | null;
  deductible: number | null;
  notes: string | null;
}

/**
 * Payload de PUT /rebillings/:id en modo edición. NUNCA incluye
 * installmentCount ni firstDueDate — ni siquiera como undefined. Es
 * justamente la ausencia de esas dos claves la que le indica al backend que
 * esto es una edición de metadata y no una corrección de plan (ver
 * `wantsPlan` en packages/web/src/api/index.ts).
 */
export function buildRebillingEditPayload(form: RebillingModalFormState): RebillingEditPayload {
  return {
    billingStart: form.billingStart,
    billingEnd: form.billingEnd,
    premium: form.premium !== "" ? Number(form.premium) : null,
    monthlyFee: form.monthlyFee !== "" ? Number(form.monthlyFee) : null,
    sumInsured: form.sumInsured !== "" ? Number(form.sumInsured) : null,
    deductible: form.deductible !== "" ? Number(form.deductible) : null,
    notes: form.notes || null,
  };
}

export interface RebillingCreatePayload extends RebillingEditPayload {
  installmentCount: number;
  firstDueDate: string;
}

/** Payload de POST /policies/:id/rebillings (alta) — siempre incluye el plan. */
export function buildRebillingCreatePayload(form: RebillingModalFormState): RebillingCreatePayload {
  return {
    ...buildRebillingEditPayload(form),
    installmentCount: Number(form.installmentCount),
    firstDueDate: form.firstDueDate,
  };
}

/**
 * Advertencia informativa (nunca bloqueante): compara el total del plan
 * vigente (monthlyFee del form × installmentCount YA guardado — en modo
 * edición ese valor nunca cambia acá) contra el importe informado. Si no
 * coinciden, se informa — pero nunca se regeneran ni redistribuyen cuotas
 * desde esta pantalla; eso es tarea exclusiva de "Corregir plan de cuotas".
 */
export function computePlanAmountMismatchWarning(
  monthlyFeeInput: string,
  premiumInput: string,
  existingInstallmentCount: number | null | undefined,
): string | null {
  if (!existingInstallmentCount) return null;
  const fee = Number(monthlyFeeInput);
  const premium = premiumInput !== "" ? Number(premiumInput) : null;
  if (!Number.isFinite(fee) || fee <= 0 || premium === null || !Number.isFinite(premium)) return null;

  const planTotal = fee * existingInstallmentCount;
  if (Math.round(planTotal * 100) === Math.round(premium * 100)) return null;

  return `El total del plan vigente (cuota mensual × ${existingInstallmentCount} cuotas = ${planTotal}) no coincide con el importe informado (${premium}). Esto no modifica las cuotas ya generadas — si hay que ajustarlas, usá "Corregir plan de cuotas".`;
}
