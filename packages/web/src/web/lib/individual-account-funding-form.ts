// Helpers puros de "Imputar pago" con cuenta corriente del asegurado (pago
// individual con saldo a favor / deuda autorizada / sobrante) — POST
// /api/payments/account-funded. Sin JSX ni estado de React, mismo estilo que
// payment-batch-titular-form.ts, cuyas piezas reutiliza (plan, parseo de
// importes, resumen) en vez de reimplementarlas.
//
// El titular es SIEMPRE el asegurado de la póliza elegida (el backend lo
// resuelve por su cuenta y nunca lo acepta del body) — acá solo se usa su id
// para leer el saldo (GET /api/insureds/:id/account-holder-balance).
//
// Diferencia con el pago tradicional: con la cuenta corriente activa, el
// total a cancelar es cuota + recargo Pronto Pago (si corresponde), igual que
// en "Cobrar en lote" — los medios reales pueden diferir de ese total
// (sobrante → saldo a favor nuevo; faltante → saldo aplicado / redondeo /
// deuda autorizada) y pueden ser cero si el saldo cubre todo.

import { SURCHARGE_AMOUNT_CENTS } from "../../lib/payments/batches";
import { classifySplitGroup } from "../../lib/payments/splits";
import type { AccountHolderFundingPlanResult } from "../../lib/payments/account-holder-funding-plan";
import { amountStringToCentsStrict } from "./payment-splits-form";
import {
  validateBatchSplitsForm, type BatchSplitFormRow, type BatchSplitsValidationResult, type PaymentBatchSplitInput,
} from "./payment-batch-form";
import {
  computeTitularPreview, parseNonNegativeCentsInput, computeAccountOutcome, describeFinalAccountBalance,
  isRebalanceableSingleSplit, rebalanceSingleSplitForCredit,
  MAX_ROUNDING_ADJUSTMENT_CENTS, type TitularPreviewResult,
} from "./payment-batch-titular-form";

export { MAX_ROUNDING_ADJUSTMENT_CENTS, rebalanceSingleSplitForCredit };

// ─── 1. Estado ───────────────────────────────────────────────────────────

export interface IndividualFundingFormState {
  /** "Usar cuenta corriente del asegurado" — sin esto, el modal funciona exactamente como siempre. */
  enabled: boolean;
  creditAppliedInput: string;
  roundingCoverageInput: string;
  debtAuthorized: boolean;
  debtReason: string;
  /** Se genera al primer envío y se reutiliza en reintentos mientras nada económico cambie. */
  idempotencyKey: string | null;
  /** Huella económica con la que se generó idempotencyKey. */
  keyFingerprint: string | null;
}

export function emptyIndividualFundingState(): IndividualFundingFormState {
  return {
    enabled: false, creditAppliedInput: "", roundingCoverageInput: "", debtAuthorized: false, debtReason: "",
    idempotencyKey: null, keyFingerprint: null,
  };
}

/** Cambiar de póliza reinicia toda la financiación (otro titular). */
export function resetFundingForPolicyChange(): IndividualFundingFormState {
  return emptyIndividualFundingState();
}

/** Cambiar cuota o importe reinicia saldo, redondeo, deuda y clave — conserva solo si la cuenta corriente sigue activa. */
export function resetFundingForInstallmentChange(state: IndividualFundingFormState): IndividualFundingFormState {
  return { ...emptyIndividualFundingState(), enabled: state.enabled };
}

/** Cambiar la fecha invalida la clave (la cobrabilidad se revalida aparte) — los importes se conservan. */
export function invalidateFundingKey(state: IndividualFundingFormState): IndividualFundingFormState {
  if (state.idempotencyKey == null && state.keyFingerprint == null) return state;
  return { ...state, idempotencyKey: null, keyFingerprint: null };
}

export function setFundingDebtAuthorized(state: IndividualFundingFormState, debtAuthorized: boolean): IndividualFundingFormState {
  return { ...state, debtAuthorized, debtReason: debtAuthorized ? state.debtReason : "" };
}

// ─── 2. Elegibilidad ──────────────────────────────────────────────────────

/**
 * La cuenta corriente solo se ofrece en un pago NUEVO, vinculado a póliza
 * (con asegurado), con cuota específica, modalidad "cuota" y estado
 * confirmado. Fuera de alcance: edición, imputación manual, pago sin cuota,
 * contado por período, pendiente/anulado.
 */
export function isIndividualFundingEligible(params: {
  editing: boolean;
  manualMode: boolean;
  showCuotaFields: boolean;
  installmentId: string;
  status: string;
  policyInsuredId: number | null | undefined;
}): boolean {
  return !params.editing && !params.manualMode && params.showCuotaFields && params.installmentId !== ""
    && params.status === "confirmado" && params.policyInsuredId != null && params.policyInsuredId > 0;
}

// ─── 3. Total a cancelar ──────────────────────────────────────────────────

/**
 * Recargo Pronto Pago dentro del total: mismo criterio que el backend
 * (calculateApplicableRivadaviaSurcharges) — Rivadavia, aplicado, y medios del
 * grupo "own" (cero medios cuenta como "own": classifySplitGroup([]) = own).
 */
export function individualFundingSurchargeCents(params: {
  isRivadavia: boolean;
  applyProntoPagoSurcharge: boolean;
  splits: ReadonlyArray<Pick<BatchSplitFormRow, "method">>;
}): number {
  if (!params.isRivadavia || !params.applyProntoPagoSurcharge) return 0;
  return classifySplitGroup(params.splits.map((s) => ({ method: s.method }))) === "own" ? SURCHARGE_AMOUNT_CENTS : 0;
}

export function individualFundingTargetCents(installmentAmountCents: number, surchargeCents: number): number {
  return installmentAmountCents + surchargeCents;
}

// ─── 4. Validación de medios (pueden diferir del total y ser cero) ──────────

export function validateIndividualFundingSplits(
  targetCents: number,
  splits: BatchSplitFormRow[],
  creditAppliedCents: number,
): BatchSplitsValidationResult {
  if (splits.length === 0) {
    // Sin medio real el grupo es "own" (mismo criterio que el backend), haya o no saldo cargado todavía.
    return creditAppliedCents > 0
      ? { valid: true, group: "own", errorMessage: null }
      : { valid: false, group: "own", errorMessage: "Sin medios reales, aplicá saldo a favor que cubra el total." };
  }
  return validateBatchSplitsForm(targetCents, splits, { allowAmountDifference: true });
}

/** Con cuenta corriente activa se puede quitar incluso el último medio real (cobro 100% con saldo) — a diferencia de removeBatchSplitRow. */
export function removeFundingSplitRow(splits: BatchSplitFormRow[], uid: string): BatchSplitFormRow[] {
  return splits.filter((s) => s.uid !== uid);
}

export function realSplitsTotalCents(splits: ReadonlyArray<Pick<BatchSplitFormRow, "amount">>): number {
  return splits.reduce((s, x) => s + (amountStringToCentsStrict(x.amount) ?? 0), 0);
}

// ─── 5. Campos económicos y preview ────────────────────────────────────────

export interface IndividualFundingAmounts {
  creditAppliedCents: number;
  roundingCoverageCents: number;
}

/** null si algún importe es inválido (negativo, no numérico, más de dos decimales). */
export function parseIndividualFundingAmounts(state: IndividualFundingFormState): IndividualFundingAmounts | null {
  const creditAppliedCents = parseNonNegativeCentsInput(state.creditAppliedInput);
  const roundingCoverageCents = parseNonNegativeCentsInput(state.roundingCoverageInput);
  if (creditAppliedCents == null || roundingCoverageCents == null) return null;
  return { creditAppliedCents, roundingCoverageCents };
}

export function validateIndividualFundingFields(
  state: IndividualFundingFormState,
  availableCreditCents: number,
): { valid: boolean; errorMessage: string | null } {
  const amounts = parseIndividualFundingAmounts(state);
  if (!amounts) return { valid: false, errorMessage: "Saldo y redondeo deben ser importes válidos, no negativos, con máximo dos decimales." };
  const maxCredit = Math.max(0, availableCreditCents);
  if (amounts.creditAppliedCents > maxCredit) {
    return { valid: false, errorMessage: `El saldo aplicado ($${(amounts.creditAppliedCents / 100).toFixed(2)}) supera el disponible ($${(maxCredit / 100).toFixed(2)}).` };
  }
  if (amounts.roundingCoverageCents > MAX_ROUNDING_ADJUSTMENT_CENTS) {
    return { valid: false, errorMessage: `El redondeo cubierto por la oficina no puede superar $${(MAX_ROUNDING_ADJUSTMENT_CENTS / 100).toFixed(2)}.` };
  }
  if (state.debtAuthorized && state.debtReason.trim() === "") {
    return { valid: false, errorMessage: "El motivo es obligatorio para autorizar el saldo deudor." };
  }
  return { valid: true, errorMessage: null };
}

/** Mismo plan que valida el backend (planAccountHolderBatchFunding), con el saldo recién leído. */
export function computeIndividualFundingPreview(params: {
  targetCents: number;
  splits: ReadonlyArray<BatchSplitFormRow>;
  creditAppliedCents: number;
  roundingCoverageCents: number;
  availableCreditCents: number;
  debtAuthorized: boolean;
}): TitularPreviewResult {
  return computeTitularPreview(params);
}

/**
 * Medios que cuentan con la cuenta corriente activa: el único medio
 * rebalanceado a $0 (el saldo cubre todo) equivale a "sin medios reales" —
 * nunca se valida ni se envía un split de importe cero.
 */
export function effectiveFundingSplits(splits: BatchSplitFormRow[]): BatchSplitFormRow[] {
  if (isRebalanceableSingleSplit(splits) && splits[0]!.amount.trim() !== "" && Number(splits[0]!.amount) === 0) return [];
  return splits;
}

/**
 * Saldo de "Aplicar saldo máximo", siempre entre $0 y el disponible:
 * - sin medios o con un único medio (que se reduce solo): min(disponible, total);
 * - con varios medios (no se tocan): min(disponible, lo no cubierto por ellos).
 */
export function maxApplicableCreditCents(params: {
  availableCreditCents: number;
  targetCents: number;
  splits: BatchSplitFormRow[];
}): number {
  const finite = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
  const available = finite(params.availableCreditCents);
  const target = finite(params.targetCents);
  const splits = effectiveFundingSplits(params.splits);
  if (splits.length === 0 || isRebalanceableSingleSplit(splits)) return Math.min(available, target);
  return Math.min(available, finite(target - realSplitsTotalCents(splits)));
}

/**
 * El único medio se reajusta al saldo aplicado salvo que el usuario esté
 * armando a propósito un redondeo o una deuda (ahí los importes son suyos).
 */
export function shouldRebalanceSingleFundingSplit(state: IndividualFundingFormState, splits: BatchSplitFormRow[]): boolean {
  const amounts = parseIndividualFundingAmounts(state);
  return state.enabled && amounts != null && !state.debtAuthorized && amounts.roundingCoverageCents === 0
    && isRebalanceableSingleSplit(splits);
}

/**
 * Faltante que queda DESPUÉS de agotar el saldo disponible (y el redondeo
 * cargado) — solo si es > 0 tiene sentido ofrecer autorizar deuda. Con saldo
 * sin aplicar, la deuda nunca se ofrece (el backend la rechaza igual).
 */
export function shortfallAfterAllCreditCents(params: {
  targetCents: number;
  realCents: number;
  availableCreditCents: number;
  roundingCoverageCents: number;
}): number {
  return Math.max(0, params.targetCents - params.realCents - Math.max(0, params.availableCreditCents) - params.roundingCoverageCents);
}

// ─── 6. Resumen final ───────────────────────────────────────────────────

export interface IndividualFundingSummaryLine {
  key: "cuota" | "recargo" | "total" | "saldo" | "medios" | "redondeo" | "deuda" | "cancela_deuda" | "nuevo_saldo" | "sobrante" | "saldo_final";
  label: string;
  amountCents: number;
  kind: "neutral" | "total" | "credit" | "debt";
}

/**
 * Siempre en el mismo orden; omite recargo/saldo/redondeo/deuda/nuevo saldo
 * cuando son 0. Los medios reales se muestran siempre (incluso $0).
 *
 * priorBalanceCents (saldo de la cuenta ANTES del cobro, con signo): si el
 * asegurado ya debía y entrega un sobrante, ese sobrante primero cancela la
 * deuda anterior — nunca se presenta como "nuevo saldo a favor" mientras
 * quede deuda; solo el excedente sobre la deuda lo es. Con el saldo previo
 * conocido y un cobro que mueve la cuenta, se muestra además el saldo final;
 * sin él (cargando o error) el sobrante queda neutral. Ver computeAccountOutcome.
 */
export function buildIndividualFundingSummary(params: {
  installmentAmountCents: number;
  surchargeCents: number;
  plan: AccountHolderFundingPlanResult;
  priorBalanceCents?: number;
}): IndividualFundingSummaryLine[] {
  const { plan } = params;
  const lines: IndividualFundingSummaryLine[] = [
    { key: "cuota", label: "Cuota", amountCents: params.installmentAmountCents, kind: "neutral" },
  ];
  if (params.surchargeCents > 0) lines.push({ key: "recargo", label: "Recargo Pronto Pago", amountCents: params.surchargeCents, kind: "neutral" });
  lines.push({ key: "total", label: "Importe a cancelar", amountCents: plan.nominalTotalCents, kind: "total" });
  if (plan.creditAppliedCents > 0) lines.push({ key: "saldo", label: "Saldo a favor utilizado", amountCents: plan.creditAppliedCents, kind: "credit" });
  lines.push({ key: "medios", label: "Dinero real ingresado", amountCents: plan.realSplitsTotalCents, kind: "neutral" });
  if (plan.roundingCoverageCents > 0) lines.push({ key: "redondeo", label: "Redondeo cubierto por la oficina", amountCents: plan.roundingCoverageCents, kind: "neutral" });
  if (plan.newSaldoDeudorCents > 0) lines.push({ key: "deuda", label: "Nueva deuda del asegurado", amountCents: plan.newSaldoDeudorCents, kind: "debt" });
  const outcome = computeAccountOutcome(plan, params.priorBalanceCents);
  if (outcome.cancelsDebtCents > 0) lines.push({ key: "cancela_deuda", label: "Cancela deuda anterior", amountCents: outcome.cancelsDebtCents, kind: "credit" });
  if (outcome.newCreditCents > 0) lines.push({ key: "nuevo_saldo", label: "Nuevo saldo a favor", amountCents: outcome.newCreditCents, kind: "credit" });
  if (outcome.unclassifiedSurplusCents > 0) lines.push({ key: "sobrante", label: "Sobrante a cuenta corriente", amountCents: outcome.unclassifiedSurplusCents, kind: "credit" });
  if (outcome.finalBalanceCents != null) lines.push({ key: "saldo_final", ...describeFinalAccountBalance(outcome.finalBalanceCents) });
  return lines;
}

// ─── 7. Payload, huella e idempotencia ────────────────────────────────────

export interface AccountFundedPaymentPayload {
  policyId: number;
  installmentId: number;
  paymentDate: string;
  splits: PaymentBatchSplitInput[];
  notes: string | null;
  applyProntoPagoSurcharge: boolean;
  creditAppliedCents: number;
  roundingCoverageCents: number;
  debtAuthorized: boolean;
  debtReason: string | null;
  idempotencyKey: string;
  confirmPossibleDuplicates?: boolean;
}

function splitsPayload(splits: ReadonlyArray<BatchSplitFormRow>): PaymentBatchSplitInput[] {
  return splits.map((s) => ({
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
  }));
}

/** Payload exacto de POST /api/payments/account-funded — nunca incluye el titular (lo resuelve el backend desde la póliza). */
export function buildAccountFundedPaymentPayload(params: {
  policyId: number;
  installmentId: number;
  paymentDate: string;
  splits: ReadonlyArray<BatchSplitFormRow>;
  notes: string | null;
  applyProntoPagoSurcharge: boolean;
  creditAppliedCents: number;
  roundingCoverageCents: number;
  debtAuthorized: boolean;
  debtReason: string;
  idempotencyKey: string;
  confirmPossibleDuplicates?: boolean;
}): AccountFundedPaymentPayload {
  return {
    policyId: params.policyId,
    installmentId: params.installmentId,
    paymentDate: params.paymentDate,
    splits: splitsPayload(params.splits),
    notes: params.notes?.trim() ? params.notes.trim() : null,
    applyProntoPagoSurcharge: params.applyProntoPagoSurcharge,
    creditAppliedCents: params.creditAppliedCents,
    roundingCoverageCents: params.roundingCoverageCents,
    debtAuthorized: params.debtAuthorized,
    debtReason: params.debtAuthorized ? params.debtReason.trim() : null,
    idempotencyKey: params.idempotencyKey,
    ...(params.confirmPossibleDuplicates ? { confirmPossibleDuplicates: true } : {}),
  };
}

/**
 * Huella económica: cambia con cualquier dato que cambie el request (póliza,
 * cuota, fecha, medios, saldo, redondeo, deuda, recargo, notas). Ignora la
 * clave y la confirmación de cheque duplicado (no cambian el request
 * semántico — mismo criterio que el fingerprint del backend).
 */
export function computeIndividualFundingFingerprint(payload: AccountFundedPaymentPayload): string {
  const economic: Record<string, unknown> = { ...payload };
  delete economic.idempotencyKey;
  delete economic.confirmPossibleDuplicates;
  return JSON.stringify(economic);
}

/**
 * Clave vigente o una nueva: se reutiliza solo si la huella no cambió desde
 * que se generó (reintento de red / doble clic / confirmación de cheque
 * duplicado = mismo request). Cualquier cambio económico produce una clave
 * nueva.
 */
export function resolveIdempotencyKey(
  state: IndividualFundingFormState,
  fingerprint: string,
  generate: () => string,
): { key: string; state: IndividualFundingFormState } {
  if (state.idempotencyKey != null && state.keyFingerprint === fingerprint) {
    return { key: state.idempotencyKey, state };
  }
  const key = generate();
  return { key, state: { ...state, idempotencyKey: key, keyFingerprint: fingerprint } };
}

// ─── 8. Presentación en el listado ──────────────────────────────────────────

export interface IndividualAccountFundingRowData {
  kind: "individual_account_funded";
  batchId: number;
  batchStatus: string;
  totalCancelledCents: number;
  realReceivedCents: number;
  creditAppliedCents: number;
  newDebtCents: number;
  newCreditCents: number;
  roundingCoveredCents: number;
}

export interface IndividualAccountFundingRowLine {
  label: string;
  amountCents: number;
  kind: "neutral" | "credit" | "debt";
}

/** Líneas del listado: saldo aplicado / saldo deudor / nuevo saldo a favor / redondeo (solo si > 0), dinero real y total cancelado siempre. */
export function describeIndividualAccountFundingRow(f: IndividualAccountFundingRowData): IndividualAccountFundingRowLine[] {
  const lines: IndividualAccountFundingRowLine[] = [];
  if (f.creditAppliedCents > 0) lines.push({ label: "Saldo aplicado", amountCents: f.creditAppliedCents, kind: "credit" });
  if (f.newDebtCents > 0) lines.push({ label: "Saldo deudor", amountCents: f.newDebtCents, kind: "debt" });
  // Neutral a propósito: si el asegurado ya debía, ese sobrante canceló deuda
  // anterior antes de quedar como saldo a favor (la fila no conoce el saldo previo).
  if (f.newCreditCents > 0) lines.push({ label: "Sobrante a cuenta corriente", amountCents: f.newCreditCents, kind: "credit" });
  if (f.roundingCoveredCents > 0) lines.push({ label: "Redondeo oficina", amountCents: f.roundingCoveredCents, kind: "neutral" });
  lines.push({ label: "Medios reales", amountCents: f.realReceivedCents, kind: "neutral" });
  lines.push({ label: "Total cancelado", amountCents: f.totalCancelledCents, kind: "neutral" });
  return lines;
}

export const INDIVIDUAL_FUNDED_CANCEL_CONFIRM =
  "¿Anular este cobro? La cuota vuelve a quedar pendiente, el saldo a favor utilizado se restituye y se anulan la deuda o el saldo a favor que generó. Para corregirlo, volvé a cargarlo.";
