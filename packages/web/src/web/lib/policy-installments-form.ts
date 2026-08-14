// Adaptador puro entre PolicyModal.tsx (alta manual de póliza) y
// buildInstallmentPlan (la única función de cálculo de planes de cuotas,
// ver lib/installments/plan.ts). Sin React, sin fetch, sin DOM — testeable
// con bun:test sin infraestructura de componentes, mismo patrón que
// web/lib/installments-rebuild.ts y web/lib/rebilling-modal.ts.
//
// periodStart/periodEnd son siempre startDate/endDate de la póliza acá: al
// momento del alta no existe todavía ningún período facturado distinto de
// la vigencia completa (esa distinción — refacturación puntual — solo
// aparece después, vía RebillingModal, sobre una póliza ya creada).

import { buildInstallmentPlan, InstallmentPlanError, type InstallmentPlanRow } from "../../lib/installments/plan";

export interface InstRow { number: number; dueDate: string; amount: number; notes: string; }

export interface PolicyInstallmentPlanResult {
  installments: InstRow[];
  /** Mensaje listo para mostrar (toast) si el plan no se pudo construir. null = sin error. */
  error: string | null;
}

function toInstRows(rows: InstallmentPlanRow[]): InstRow[] {
  return rows.map((i) => ({ number: i.number, dueDate: i.dueDate, amount: i.amount, notes: "" }));
}

/**
 * Calcula el plan de cuotas para la previsualización y el alta de una
 * póliza nueva. `firstDueDate` vacío o ausente reproduce el comportamiento
 * anterior a este cambio: buildInstallmentPlan usa periodStart (startDate)
 * como fecha de la primera cuota — no hay ninguna rama especial acá, es el
 * mismo default que ya tenía la función de cálculo.
 *
 * Nunca lanza: cualquier combinación inválida (fechas inconsistentes,
 * firstDueDate fuera de [startDate, endDate], cantidad que no entra en el
 * período, etc.) vuelve como `error` con el mensaje de InstallmentPlanError
 * — el caller decide si eso es bloqueante (alta real) o tolerable
 * (previsualización mientras el usuario todavía está completando el
 * formulario).
 */
export function planMonthlyInstallments(
  startDate: string,
  endDate: string,
  count: number,
  monthlyFee: number,
  firstDueDate?: string,
): PolicyInstallmentPlanResult {
  if (!startDate || !endDate || count < 1) return { installments: [], error: null };
  try {
    const { installments } = buildInstallmentPlan({
      periodStart: startDate,
      periodEnd: endDate,
      periodAmount: (monthlyFee || 0) * count,
      installmentCount: count,
      firstDueDate: firstDueDate || undefined,
    });
    return { installments: toInstRows(installments), error: null };
  } catch (e: any) {
    return {
      installments: [],
      error: e instanceof InstallmentPlanError ? e.message : "Datos de período inválidos.",
    };
  }
}

/**
 * "Vencimiento de la primera cuota" sigue a startDate mientras el usuario
 * no la haya tocado manualmente — mismo criterio que ya usa
 * RebillingModal.tsx para firstDueDate/billingStart. Una vez que el
 * usuario edita el campo directamente (`touched = true`), deja de
 * sincronizarse: cambiar startDate después nunca pisa esa elección manual.
 */
export function nextFirstDueDateOnStartDateChange(
  currentFirstDueDate: string,
  touched: boolean,
  newStartDate: string,
): string {
  return touched ? currentFirstDueDate : newStartDate;
}

// ─── Importe contado — solo previsualización, NUNCA la validación real ────
//
// La validación autoritativa (>0, <= nominal) vive en el backend
// (src/lib/payments/cash-period-payments.ts, PUT /policies/:id) — esto es
// puramente informativo para que el usuario vea el ahorro mientras carga el
// dato, mismo criterio que installmentRows más arriba (previsualización
// tolerante, nunca bloqueante por sí sola).
export interface CashPaymentPreview {
  nominalAmountCents: number;
  cashAmountCents: number | null;
  discountAmountCents: number | null;
}

export function computeCashPaymentPreview(
  installments: ReadonlyArray<{ amount: number }>,
  cashPaymentAmountPesos: string,
): CashPaymentPreview {
  const nominalAmountCents = installments.reduce((s, i) => s + Math.round(i.amount * 100), 0);
  const cashPesos = Number(cashPaymentAmountPesos);
  if (!cashPaymentAmountPesos.trim() || !Number.isFinite(cashPesos) || cashPesos <= 0) {
    return { nominalAmountCents, cashAmountCents: null, discountAmountCents: null };
  }
  const cashAmountCents = Math.round(cashPesos * 100);
  return { nominalAmountCents, cashAmountCents, discountAmountCents: nominalAmountCents - cashAmountCents };
}
