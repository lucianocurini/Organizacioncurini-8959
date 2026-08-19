// Helpers puros de "Pago de contado por período de facturación". Sin DB, sin
// efectos secundarios — mismo estilo que batches.ts/insured-account.ts:
// reciben datos ya resueltos por el endpoint (que sí consulta la base) y
// devuelven resultados explícitos o lanzan CashPeriodPaymentValidationError.
//
// REGLA DE NEGOCIO (confirmada, ver migración 0034): el "pago de contado" NO
// es un medio de pago — es una modalidad comercial para cancelar TODAS las
// cuotas de un período (policyId + rebillingId, mismo criterio de "período"
// que src/web/lib/rebilling-groups.ts — rebillingId null = emisión/
// renovación) por un importe menor a su suma nominal. La diferencia es un
// descuento comercial, nunca un faltante/sobrante/ajuste de redondeo — por
// eso este flujo NUNCA pasa por accountDifferenceResolution/
// insured_account_movements/payment_amount_adjustments (ver
// src/lib/payments/insured-account.ts, que sigue existiendo sin cambios
// para el resto de los cobros).
//
// Todo o nada: se exige el período completo, ninguna cuota pagada/rendida/
// imputada, y los medios deben sumar EXACTO el importe contado — sin la
// tolerancia de redondeo que sí existe para diferencias reales de
// instrumentos en un cobro común (MAX_ROUNDING_ADJUSTMENT_CENTS en
// insured-account.ts no aplica acá: el importe contado es un número fijo
// conocido de antemano, no hay ninguna razón legítima para que los medios no
// cierren exacto).

import { addCalendarDays } from "../dates/argentina-date";

export class CashPeriodPaymentValidationError extends Error {}

// ─── Vencimiento informativo del contado (fecha límite, nunca un gate) ─────
//
// Regla confirmada por el usuario: la fecha límite es SOLO informativa —
// "Vigente"/"Vencido" es un estado de visualización, jamás una condición de
// habilitación. Un contado vencido sigue siendo cobrable sin restricción
// alguna, tanto acá como en el endpoint — la ÚNICA condición que vuelve
// definitivamente indisponible el contado es actividad real en alguna cuota
// del período (ver assertAllInstallmentsEligibleForCashPeriod, eje
// completamente independiente de este). periodStartDate es policy.startDate
// para emisión/renovación o rebilling.billingStart para refacturación — ya
// una fecha calendario "YYYY-MM-DD" (nunca un instante), así que se suma con
// addCalendarDays (Argentina, sin husos horarios de por medio).

export const CASH_PERIOD_DEADLINE_DAYS = 30;

export type CashPeriodDeadlineStatus = "vigente" | "vencido";

/** Fecha límite informativa = inicio del período + 30 días corridos. */
export function calculateCashPeriodDeadline(periodStartDate: string): string {
  return addCalendarDays(periodStartDate, CASH_PERIOD_DEADLINE_DAYS);
}

/**
 * "vigente" hasta el día límite inclusive, "vencido" desde el día siguiente.
 * Comparación lexicográfica de strings "YYYY-MM-DD" — válida porque ambos
 * extremos ya son días calendario puros (mismo criterio que el resto de este
 * archivo: nunca Date para comparar fechas de negocio).
 */
export function getCashPeriodDeadlineStatus(
  deadline: string,
  todayArgentina: string
): CashPeriodDeadlineStatus {
  return todayArgentina <= deadline ? "vigente" : "vencido";
}

// ─── Importe contado cargado en policies/rebillings (Regla 2/3) ───────────

/**
 * Valida el importe contado tal como se carga en PolicyModal/RebillingModal
 * (policies.cashPaymentAmountCents / rebillings.cashPaymentAmountCents) —
 * null/undefined es válido (opcional, "todo sigue funcionando como hoy").
 * Entero positivo en centavos — el límite superior contra el nominal del
 * período (Regla 3: "igual está permitido, mayor se rechaza") solo se puede
 * validar cuando el período ya tiene cuotas reales; ver
 * validateCashPaymentAmountAgainstNominal, invocada aparte por el endpoint
 * cuando corresponde (no siempre hay cuotas todavía al cargar el dato).
 */
export function validateCashPaymentAmountInput(cents: unknown): number | null {
  if (cents === null || cents === undefined) return null;
  const n = Number(cents);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new CashPeriodPaymentValidationError(
      "El importe contado debe ser un número entero de centavos mayor a cero, o vacío."
    );
  }
  return n;
}

/**
 * Regla 3: mayor que cero (ya cubierto por validateCashPaymentAmountInput),
 * menor o igual a la suma nominal de las cuotas del período. Igual al
 * nominal está permitido (descuento $0) — solo rechaza estrictamente mayor.
 */
export function validateCashPaymentAmountAgainstNominal(cashAmountCents: number, nominalAmountCents: number): void {
  if (cashAmountCents > nominalAmountCents) {
    throw new CashPeriodPaymentValidationError(
      `El importe contado ($${(cashAmountCents / 100).toFixed(2)}) no puede ser mayor a la suma nominal de las cuotas ` +
      `del período ($${(nominalAmountCents / 100).toFixed(2)}).`
    );
  }
}

// ─── Edición bloqueada tras actividad (Regla 4) ────────────────────────────
//
// La gating real ("¿tiene actividad este período?") reutiliza TAL CUAL
// hasRebillingGroupActivity/rebillingGroupActivitySets de
// src/lib/installments/rebilling-plan.ts — ya es exactamente "cuotas con
// algún payment (cualquier estado) o remittance_items(source=installment)",
// el mismo criterio que ya bloquea la edición del plan de una refacturación
// (PUT /rebillings/:id) y que aplica sin cambios al período de
// emisión/renovación de una póliza (mismas policyInstallments, agrupadas
// por policyId+rebillingId IS NULL en vez de por rebillingId). No se
// duplica esa lógica acá — el endpoint la importa directo.

// ─── Elegibilidad para el cobro (Regla 5 — todo o nada) ────────────────────

export interface CashPeriodInstallmentForEligibility {
  id: number;
  status: string; // pendiente | pagada | vencida | no_exigible
  rendered: number; // 0 | 1
  hasConfirmedPayment: boolean; // payments.status='confirmado' ya vinculado (standalone o hijo de batch)
}

export interface CashPeriodEligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * Variante sin throw de assertAllInstallmentsEligibleForCashPeriod (misma
 * regla exacta, todo o nada) — para uso en listados/búsquedas (ej. GET
 * /policies/cash-period-search) donde un período no elegible debe ocultar o
 * deshabilitar la alternativa de contado, nunca lanzar un error de request.
 * assertAllInstallmentsEligibleForCashPeriod es un wrapper fino sobre ésta.
 */
export function checkCashPeriodEligibility(
  installments: ReadonlyArray<CashPeriodInstallmentForEligibility>
): CashPeriodEligibilityResult {
  if (installments.length === 0) {
    return { eligible: false, reasons: ["El período no tiene ninguna cuota — no se puede pagar de contado."] };
  }
  const reasons: string[] = [];
  for (const i of installments) {
    if (i.status === "pagada") reasons.push(`La cuota ${i.id} ya está pagada.`);
    else if (i.status === "no_exigible") reasons.push(`La cuota ${i.id} no es exigible.`);
    // Migración 0035 — defensa en profundidad: el caller (index.ts) ya debe
    // excluir cuotas 'duplicada' de `installments` ANTES de llamar acá (no
    // son parte del período real, ver duplicate-status.ts) — pero si una se
    // colara igual, esto la bloquea explícitamente en vez de dejarla pasar
    // como "sin razones de bloqueo" por no matchear ningún caso conocido.
    else if (i.status === "duplicada") reasons.push(`La cuota ${i.id} es un duplicado invalidado — no es parte del período real.`);
    if (i.rendered === 1) reasons.push(`La cuota ${i.id} ya fue rendida.`);
    if (i.hasConfirmedPayment) reasons.push(`La cuota ${i.id} ya tiene un pago confirmado.`);
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Todo o nada: el período completo debe existir (>=1 cuota) y NINGUNA cuota
 * puede estar pagada, rendida, no exigible, ni tener ya un pago confirmado
 * vinculado. Se acumulan TODOS los bloqueos (nunca se corta en el primero)
 * para que el endpoint pueda mostrarlos todos juntos, mismo criterio que
 * checkBatchCancellable en batches.ts.
 */
export function assertAllInstallmentsEligibleForCashPeriod(
  installments: ReadonlyArray<CashPeriodInstallmentForEligibility>
): void {
  const { eligible, reasons } = checkCashPeriodEligibility(installments);
  if (eligible) return;
  if (installments.length === 0) {
    throw new CashPeriodPaymentValidationError(reasons[0]!);
  }
  throw new CashPeriodPaymentValidationError(
    `No se puede pagar el período de contado: ${reasons.join(" ")} Requiere revisión manual — un pago de contado exige que ` +
    `NINGUNA cuota del período tenga actividad previa.`
  );
}

// ─── Snapshot de auditoría (Regla 6) ───────────────────────────────────────

export interface CashPeriodPaymentSnapshot {
  nominalAmountCents: number;
  cashAmountCents: number;
  discountAmountCents: number;
}

/**
 * nominal/cash/descuento a persistir en cash_period_payments — SNAPSHOT
 * inmutable al momento del cobro (nunca se vuelve a leer de
 * policies/rebillings después de esto). discountAmountCents siempre >= 0
 * por construcción (ya validado arriba).
 */
export function buildCashPeriodPaymentSnapshot(
  nominalAmountCents: number,
  cashAmountCents: number
): CashPeriodPaymentSnapshot {
  if (!Number.isInteger(nominalAmountCents) || nominalAmountCents <= 0) {
    throw new CashPeriodPaymentValidationError("El total nominal del período debe ser un entero de centavos mayor a cero.");
  }
  if (!Number.isInteger(cashAmountCents) || cashAmountCents <= 0) {
    throw new CashPeriodPaymentValidationError("El importe contado debe ser un entero de centavos mayor a cero.");
  }
  validateCashPaymentAmountAgainstNominal(cashAmountCents, nominalAmountCents);
  return {
    nominalAmountCents,
    cashAmountCents,
    discountAmountCents: nominalAmountCents - cashAmountCents,
  };
}

// ─── Medios de pago del cobro contado (Regla 5) ────────────────────────────
//
// Los medios deben sumar el importe contado (Regla 5), con tolerancia de
// redondeo (ronda 2 del pedido): una diferencia REAL de instrumentos de
// hasta $5 inclusive se acepta solo con confirmación explícita del usuario,
// vía el mismo mecanismo auditado que un payment_batches común
// (calculateBatchReceivedAppliedDifference/validateRoundingAdjustment de
// insured-account.ts, payment_amount_adjustments) — pero acá SOLO admite
// action="ajuste_redondeo", nunca saldo_a_favor/saldo_deudor: el importe
// contado ya es un número fijo conocido de antemano (cargado previamente en
// el período), así que una diferencia contra él nunca es una decisión de
// cuenta corriente del asegurado, siempre es un error de captura del
// instrumento. El descuento comercial (nominal - contado) es un concepto
// completamente distinto — vive únicamente en discountAmountCents, nunca se
// registra acá ni se confunde con esta diferencia. Ver POST
// /payment-batches/cash-period-payment para la implementación completa (no
// hay un helper propio acá: reutiliza directo las funciones genéricas de
// insured-account.ts, ya probadas).

// ─── Comisiones (Regla 9 — confirmada) ─────────────────────────────────────
//
// "Las comisiones se calculan sobre el importe contado real" — este
// proyecto no tiene hoy ningún cálculo automático de comisión a partir de
// pagos (commission_entries, en schema.ts, es 100% carga manual de lo que
// la compañía efectivamente liquidó — ver GET/POST /cash/commissions en
// index.ts). Esta función es la ÚNICA fuente de verdad de "cuál es la base
// de comisión de un cobro de período de contado", para que cualquier
// reporte o integración futura la use en vez de re-derivar (nunca leer
// nominalAmountCents con ese fin — ver tests explícitos que comparan ambos
// casos: contado menor al nominal y contado igual al nominal).
export function getCommissionBaseAmountCents(cashPeriodPayment: { cashAmountCents: number }): number {
  return cashPeriodPayment.cashAmountCents;
}
