// Helpers puros de "Pagar período de contado" (Cobranzas — integrado en el
// modal "Imputar pago" de cobranzas.tsx, ÚNICO lugar de todo Cobranzas donde
// se puede elegir la modalidad de pago; "Cobrar en lote" nunca ofrece esta
// alternativa, para no duplicar la misma decisión de negocio en dos
// pantallas distintas. Rediseño: YA NO se cobra desde Pólizas, que solo
// muestra el importe/vencimiento como dato de lectura. Sin
// React, sin fetch — mismo estilo que payment-batch-form.ts, del que
// reutiliza directamente el editor de medios (BatchSplitFormRow y toda su
// familia de funciones) y el mapeo de cheques a payload: un cobro de
// contado usa el MISMO editor de medios/cheques que "Cobrar en lote", solo
// que el importe objetivo es siempre el contado (nunca la suma nominal).
//
// Ronda 2 (tolerancia de redondeo): el importe objetivo SÍ puede diferir del
// real hasta $5 inclusive, con aceptación explícita — mismo checkbox único
// de "ajuste por redondeo" que "Cobrar en lote" (isRoundingAdjustmentEligible/
// buildRoundingAdjustmentPayload, reutilizados tal cual), pero acá NUNCA se
// ofrece saldo a favor/deudor: la diferencia contra el contado nunca es una
// decisión de cuenta corriente del asegurado (ver
// validateCashPeriodDifferenceResolution más abajo, versión simplificada de
// validateBatchDifferenceResolution sin la rama saldo_a_favor/saldo_deudor).

import {
  type BatchSplitFormRow, validateBatchSplitsForm, type BatchSplitsValidationResult,
  calculateBatchReceivedAppliedDifference, isRoundingAdjustmentEligible, buildRoundingAdjustmentPayload,
  type BatchReceivedAppliedDifference, type AccountDifferenceResolutionPayload,
} from "./payment-batch-form";
import {
  calculateCashPeriodDeadline, getCashPeriodDeadlineStatus, type CashPeriodDeadlineStatus,
} from "../../lib/payments/cash-period-payments";

export { calculateBatchReceivedAppliedDifference, isRoundingAdjustmentEligible, buildRoundingAdjustmentPayload };
export type { BatchReceivedAppliedDifference, AccountDifferenceResolutionPayload };
// Vencimiento informativo del contado (Regla del usuario, ronda 2): mismo
// helper puro que usa el backend (calculateCashPeriodDeadline/
// getCashPeriodDeadlineStatus en src/lib/payments/cash-period-payments.ts) —
// nunca una copia propia. Vigente/Vencido es SOLO display acá, igual que en
// el backend: jamás condiciona si se puede cobrar o no.
export { calculateCashPeriodDeadline, getCashPeriodDeadlineStatus };
export type { CashPeriodDeadlineStatus };

export interface CashPeriodGroup {
  policyId: number;
  rebillingId: number | null;
  label: string;
  installmentCount: number;
  nominalAmountCents: number;
  cashAmountCents: number;
  // Vencimiento informativo (rediseño Cobranzas) — siempre viene de
  // GET /policies/cash-period-search, nunca recalculado en el componente que
  // arma el grupo: mismo dato que ya mostró la búsqueda, para que la
  // confirmación no pueda desincronizarse de lo que el usuario vio.
  deadline: string;
  deadlineStatus: CashPeriodDeadlineStatus;
}

/**
 * Un grupo de cuotas (emisión/renovación o refacturación puntual — mismo
 * criterio que src/web/lib/rebilling-groups.ts) es elegible para "Pagar
 * período de contado" solo si: tiene un importe contado cargado (>0), tiene
 * al menos una cuota, y NINGUNA cuota del grupo tiene actividad (pagada,
 * vencida-pero-ya-con-pago, rendida) — mismo criterio "todo o nada" que
 * revalida siempre el backend (assertAllInstallmentsEligibleForCashPeriod).
 * Esto es solo para DECIDIR SI MOSTRAR el botón — nunca la única
 * validación: el backend vuelve a revisar todo con datos reales.
 */
export function isCashPeriodEligible(
  cashPaymentAmountCents: number | null | undefined,
  installments: ReadonlyArray<{ status: string; rendered?: number }>,
): boolean {
  if (cashPaymentAmountCents == null || cashPaymentAmountCents <= 0) return false;
  if (installments.length === 0) return false;
  return installments.every((i) => i.status !== "pagada" && i.status !== "no_exigible" && i.rendered !== 1);
}

// ─── Modal "Imputar pago" — modalidad de pago (contado vs. cuota) ──────────
//
// GET /policies/cash-period-search devuelve una fila por período (emisión +
// cada refacturación puntual) de la póliza seleccionada. Estas funciones
// puras deciden, a partir de esa respuesta, qué debe ver/poder elegir el
// usuario en "Imputar pago" — la ÚNICA pantalla de Cobranzas donde se elige
// modalidad (ver comentario de archivo). Nunca se usan como autoridad de
// negocio: el backend vuelve a validar todo con datos reales al confirmar.

export interface CashPeriodSearchRow {
  policyId: number;
  policyNumber: string;
  insuredId: number;
  insuredName: string;
  companyId: number;
  companyName: string;
  rebillingId: number | null;
  cashPaymentAmountCents: number | null;
  nominalAmountCents: number;
  discountAmountCents: number | null;
  installmentCount: number;
  periodStartDate: string;
  deadline: string;
  deadlineStatus: CashPeriodDeadlineStatus;
  eligible: boolean;
  ineligibleReasons: string[];
}

/** Clave estable para <select>/keys de React — nunca colisiona entre emisión y refacturaciones de la misma póliza. */
export function cashPeriodCandidateKey(c: Pick<CashPeriodSearchRow, "policyId" | "rebillingId">): string {
  return `${c.policyId}-${c.rebillingId ?? "emision"}`;
}

/** Etiqueta legible — nunca confunde una refacturación con la emisión original (Regla del usuario). */
export function cashPeriodCandidateLabel(c: Pick<CashPeriodSearchRow, "rebillingId">): string {
  return c.rebillingId == null ? "Emisión/renovación" : `Refacturación #${c.rebillingId}`;
}

/**
 * Con un único candidato elegible se resuelve solo (no hace falta selector
 * de período en la UI); con 2+ (ej. emisión Y una refacturación con contado
 * cargado a la vez) se resuelve por la clave elegida explícitamente — nunca
 * se asume "el primero" para no cobrar el período equivocado por error.
 */
export function resolveSelectedCashPeriodCandidate(
  eligibleCandidates: ReadonlyArray<CashPeriodSearchRow>,
  selectedKey: string,
): CashPeriodSearchRow | undefined {
  if (eligibleCandidates.length === 1) return eligibleCandidates[0];
  return eligibleCandidates.find((c) => cashPeriodCandidateKey(c) === selectedKey);
}

/** Payload para CashPeriodPaymentModal — deadline/deadlineStatus SIEMPRE los que ya mostró la búsqueda, nunca recalculados acá. */
export function buildCashPeriodGroupFromCandidate(c: CashPeriodSearchRow): CashPeriodGroup {
  return {
    policyId: c.policyId,
    rebillingId: c.rebillingId,
    label: cashPeriodCandidateLabel(c),
    installmentCount: c.installmentCount,
    nominalAmountCents: c.nominalAmountCents,
    cashAmountCents: c.cashPaymentAmountCents ?? 0,
    deadline: c.deadline,
    deadlineStatus: c.deadlineStatus,
  };
}

export type CashPeriodModalityAvailability =
  // Sin ningún importe de contado configurado en ningún período de la
  // póliza — nunca mostrar una alternativa falsa, solo el flujo de cuotas.
  | { kind: "none" }
  // Contado configurado pero el período ya tiene actividad (o no existe
  // ninguna cuota) — se informa el motivo, pero tampoco se ofrece elegir.
  | { kind: "unavailable"; cashPaymentAmountCents: number; firstReason: string }
  // Al menos un período elegible — acá sí se ofrece "Modalidad de pago".
  | { kind: "available"; eligibleCandidates: CashPeriodSearchRow[] };

/**
 * Única función de decisión de "qué mostrar" en Imputar pago a partir de la
 * respuesta cruda de GET /policies/cash-period-search para la póliza
 * seleccionada. Prioriza "available" sobre "unavailable": si CUALQUIER
 * período de la póliza es elegible, se ofrece esa alternativa aunque otro
 * período (ej. una refacturación vieja) ya no lo sea.
 */
export function resolveCashPeriodModalityAvailability(
  candidates: ReadonlyArray<CashPeriodSearchRow>,
): CashPeriodModalityAvailability {
  const eligible = candidates.filter((c) => c.eligible);
  if (eligible.length > 0) return { kind: "available", eligibleCandidates: eligible };
  const ineligibleWithAmount = candidates.find((c) => !c.eligible && c.cashPaymentAmountCents != null);
  if (ineligibleWithAmount) {
    return {
      kind: "unavailable",
      cashPaymentAmountCents: ineligibleWithAmount.cashPaymentAmountCents!,
      firstReason: ineligibleWithAmount.ineligibleReasons[0] ?? "el período ya tiene actividad.",
    };
  }
  return { kind: "none" };
}

/**
 * Importe objetivo de los medios: SIEMPRE el contado, nunca la suma nominal
 * (Regla 5). Admite diferencia real (tolerancia de redondeo, ronda 2) — esta
 * función solo valida la FORMA de los splits (importes/cheques); si la suma
 * total difiere del contado, ver validateCashPeriodDifferenceResolution para
 * decidir si esa diferencia puede aceptarse.
 */
export function validateCashPeriodSplitsForm(
  cashAmountCents: number,
  splits: BatchSplitFormRow[],
): BatchSplitsValidationResult {
  return validateBatchSplitsForm(cashAmountCents, splits, { allowAmountDifference: true });
}

// ─── Tolerancia de redondeo (ronda 2) ──────────────────────────────────────
//
// A diferencia de "Cobrar en lote" (validateBatchDifferenceResolution), acá
// NUNCA se ofrece saldo a favor/deudor — la única resolución posible es
// "ajuste_redondeo" (isRoundingAdjustmentEligible/buildRoundingAdjustmentPayload,
// reutilizados de payment-batch-form.ts), y por eso tampoco depende de si el
// carrito tiene un único asegurado real: el importe contado ya es un número
// fijo por período, sin ambigüedad de a quién pertenece.
export interface CashPeriodDifferenceValidationResult {
  valid: boolean;
  errorMessage: string | null;
}

export function validateCashPeriodDifferenceResolution(
  difference: BatchReceivedAppliedDifference,
  roundingAccepted: boolean,
): CashPeriodDifferenceValidationResult {
  if (difference.kind === "exacto") return { valid: true, errorMessage: null };
  if (!isRoundingAdjustmentEligible(difference.differenceCents)) {
    return {
      valid: false,
      errorMessage:
        `La diferencia entre los medios y el importe contado ($${(Math.abs(difference.differenceCents) / 100).toFixed(2)}) ` +
        `supera el máximo tolerado de $5,00 — revisá los importes cargados.`,
    };
  }
  if (!roundingAccepted) {
    return {
      valid: false,
      errorMessage:
        difference.kind === "saldo_a_favor"
          ? `Los medios suman $${(Math.abs(difference.differenceCents) / 100).toFixed(2)} más que el importe contado — aceptá el ajuste por redondeo para continuar.`
          : `Los medios suman $${(Math.abs(difference.differenceCents) / 100).toFixed(2)} menos que el importe contado — aceptá el ajuste por redondeo para continuar.`,
    };
  }
  return { valid: true, errorMessage: null };
}

export interface CashPeriodPaymentPayload {
  policyId: number;
  rebillingId: number | null;
  paymentDate: string;
  splits: Array<{
    method: string;
    amount: number;
    notes?: string | null;
    checks?: Array<{
      checkNumber: string; bankName: string; bankCode?: string | null;
      drawerName?: string | null; drawerDocument?: string | null;
      issueDate?: string | null; dueDate: string; amount: number; notes?: string | null;
    }>;
  }>;
  notes?: string | null;
  confirmPossibleDuplicates?: boolean;
  accountDifferenceResolution?: AccountDifferenceResolutionPayload | null;
}

export function buildCashPeriodPaymentPayload(params: {
  policyId: number;
  rebillingId: number | null;
  paymentDate: string;
  splits: ReadonlyArray<BatchSplitFormRow>;
  notes?: string | null;
  confirmPossibleDuplicates?: boolean;
  accountDifferenceResolution?: AccountDifferenceResolutionPayload | null;
}): CashPeriodPaymentPayload {
  return {
    policyId: params.policyId,
    rebillingId: params.rebillingId,
    paymentDate: params.paymentDate,
    accountDifferenceResolution: params.accountDifferenceResolution ?? null,
    splits: params.splits.map((s) => ({
      method: s.method,
      amount: Number(s.amount),
      ...(s.method === "cheque" ? {
        checks: s.checks.map((c) => ({
          checkNumber: c.checkNumber.trim(),
          bankName: c.bankName.trim(),
          bankCode: c.bankCode.trim() || null,
          drawerName: c.drawerName.trim() || null,
          drawerDocument: c.drawerDocument.trim() || null,
          issueDate: c.issueDate || null,
          dueDate: c.dueDate,
          amount: Number(c.amount),
          notes: c.notes.trim() || null,
        })),
      } : {}),
    })),
    notes: params.notes || null,
    confirmPossibleDuplicates: params.confirmPossibleDuplicates,
  };
}
