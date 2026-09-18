// Helpers puros del modo "Titular de cuenta y saldo a favor" de "Cobrar en
// lote" (Etapa 1B-4) — selección de titular, campos económicos (crédito
// aplicado / redondeo cubierto por oficina / deuda autorizada), resumen de
// cierre e idempotencyKey de frontend. Sin JSX, sin estado de React — mismo
// estilo que payment-batch-form.ts, que este módulo complementa (nunca
// reemplaza): el modo legacy sigue viviendo tal cual en ese archivo.
//
// ─── Por qué el resumen reutiliza planAccountHolderBatchFunding ───────────
//
// account-holder-funding-plan.ts (src/lib/payments/) es la MISMA función
// pura que ya usa el backend (runAccountHolderFundingBatch, vía
// planFundingWithFreshBalance) para decidir cómo cierra un lote con titular
// — se reutiliza tal cual acá para el preview/resumen y para bloquear el
// submit ante combinaciones inválidas (crédito > disponible, redondeo >
// tope, faltante sin deuda autorizada, sobre-fondeo con crédito > 0). Nunca
// se reimplementa esa aritmética con una segunda fórmula.
//
// El preview arma un ÚNICO destino sintético que agrega todo el carrito
// (buildPreviewDestinations) — el desglose real por instrumento/destino lo
// arma el backend con datos reales (payment-batch-titular-dependencies.ts);
// acá solo hace falta el TOTAL para que el plan calcule los mismos agregados
// que el backend va a validar. El backend sigue siendo la ÚNICA autoridad
// final: vuelve a leer el saldo fresco dentro de la transacción y revalida
// el plan completo (assertFundingPlanUnchanged) — este módulo solo evita
// mandar un request que ya se sabe inválido con el saldo recién leído.

import {
  planAccountHolderBatchFunding, AccountHolderFundingPlanError,
  type AccountHolderFundingPlanResult, type FundingPlanSplitInput,
} from "../../lib/payments/account-holder-funding-plan";
import { FundingValidationError, type FundingDestinationInput } from "../../lib/payments/account-holder-funding";
import { MAX_ROUNDING_ADJUSTMENT_CENTS } from "../../lib/payments/insured-account";
import { isMultipleOfCent } from "../../lib/payments/splits";
import { amountStringToCentsStrict } from "./payment-splits-form";
import {
  type BatchCartItem, type BatchSplitFormRow, type PaymentBatchTitularPayloadInput,
  buildPaymentBatchPayload,
} from "./payment-batch-form";

export { MAX_ROUNDING_ADJUSTMENT_CENTS };

// ─── 1. Titular seleccionado (resultado de buscar en GET /insureds?q=) ────

export interface AccountHolderOption {
  insuredId: number;
  name: string;
}

// ─── 2. Saldo (GET /insureds/:id/account-holder-balance) ─────────────────

export interface AccountHolderBalance {
  insuredId: number;
  /** Con signo — puede ser negativo si el titular ya debe plata. */
  balanceCents: number;
  /** max(0, balanceCents) — único tope válido para creditAppliedCents. */
  availableCreditCents: number;
}

// ─── 3. Estado del formulario titular ─────────────────────────────────────

export interface TitularFormState {
  accountHolder: AccountHolderOption | null;
  /** Pesos, tal cual lo tipea el usuario — "" significa "sin crédito aplicado" (0). */
  creditAppliedInput: string;
  /** Pesos — "" significa "sin redondeo cubierto" (0). */
  roundingCoverageInput: string;
  debtAuthorized: boolean;
  debtReason: string;
  /** null = no hay ningún intento de envío en curso (se genera una nueva key recién al enviar). */
  idempotencyKey: string | null;
}

export function emptyTitularFormState(): TitularFormState {
  return {
    accountHolder: null,
    creditAppliedInput: "",
    roundingCoverageInput: "",
    debtAuthorized: false,
    debtReason: "",
    idempotencyKey: null,
  };
}

/**
 * Seleccionar (o cambiar de) titular siempre arranca los campos económicos
 * de cero — el crédito/saldo de un titular no tiene ningún sentido aplicado
 * a otro. Nunca conserva una idempotencyKey previa (un titular nuevo es,
 * por definición, un intento económicamente distinto).
 */
export function selectAccountHolder(holder: AccountHolderOption): TitularFormState {
  return { ...emptyTitularFormState(), accountHolder: holder };
}

/** Quitar el titular vuelve al modo legacy — limpia TODOS los campos del modo titular (Regla 1 del pedido), incluida cualquier idempotencyKey pendiente. */
export function clearAccountHolder(): TitularFormState {
  return emptyTitularFormState();
}

/** Desactivar debtAuthorized siempre limpia debtReason — nunca queda un motivo tipeado "flotando" sin autorización marcada (mismo contrato que exige el backend: debtReason debe ser null cuando debtAuthorized=false). */
export function setDebtAuthorized(state: TitularFormState, debtAuthorized: boolean): TitularFormState {
  return { ...state, debtAuthorized, debtReason: debtAuthorized ? state.debtReason : "" };
}

// ─── 4. Parseo de importes (crédito/redondeo) — pesos → centavos ─────────

/**
 * "" (o solo espacios) -> 0 (nada cargado, válido). Un número positivo,
 * múltiplo exacto de un centavo -> centavos. Cualquier otro valor (negativo,
 * no numérico, con más de dos decimales reales) -> null. A diferencia de
 * amountStringToCentsStrict (payment-splits-form.ts), acepta 0/"" como
 * válido — acá "sin crédito"/"sin redondeo" son el estado por defecto, no un
 * error.
 */
export function parseNonNegativeCentsInput(raw: string): number | null {
  if (raw == null || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  if (!isMultipleOfCent(n)) return null;
  return Math.round(n * 100);
}

// ─── 5. Validación de los campos económicos propios (independiente del plan) ──
// Chequeos de FORMA (enteros en centavos, no negativos, tope de redondeo,
// motivo de deuda) — la coherencia financiera completa (crédito vs. saldo
// real, faltante sin deuda autorizada, sobre-fondeo) la resuelve
// computeTitularPreview, reutilizando el plan real.

export interface TitularFieldsValidationResult {
  valid: boolean;
  errorMessage: string | null;
}

export function validateTitularEconomicFields(
  state: TitularFormState,
  availableCreditCents: number,
): TitularFieldsValidationResult {
  const creditCents = parseNonNegativeCentsInput(state.creditAppliedInput);
  if (creditCents == null) {
    return { valid: false, errorMessage: "El crédito aplicado debe ser un importe válido, no negativo, con máximo dos decimales." };
  }
  const maxCredit = Math.max(0, availableCreditCents);
  if (creditCents > maxCredit) {
    return {
      valid: false,
      errorMessage: `El crédito aplicado ($${(creditCents / 100).toFixed(2)}) no puede superar el saldo disponible ($${(maxCredit / 100).toFixed(2)}).`,
    };
  }
  const roundingCents = parseNonNegativeCentsInput(state.roundingCoverageInput);
  if (roundingCents == null) {
    return { valid: false, errorMessage: "El redondeo cubierto por oficina debe ser un importe válido, no negativo, con máximo dos decimales." };
  }
  if (roundingCents > MAX_ROUNDING_ADJUSTMENT_CENTS) {
    return {
      valid: false,
      errorMessage: `El redondeo cubierto por oficina no puede superar $${(MAX_ROUNDING_ADJUSTMENT_CENTS / 100).toFixed(2)}.`,
    };
  }
  if (state.debtAuthorized && state.debtReason.trim() === "") {
    return { valid: false, errorMessage: "El motivo es obligatorio para autorizar deuda nueva." };
  }
  return { valid: true, errorMessage: null };
}

// ─── 6. Resumen/preview — reutiliza planAccountHolderBatchFunding ────────

export interface TitularPreviewOk {
  ok: true;
  plan: AccountHolderFundingPlanResult;
}
export interface TitularPreviewError {
  ok: false;
  errorMessage: string;
}
export type TitularPreviewResult = TitularPreviewOk | TitularPreviewError;

function buildPreviewDestinations(targetCents: number): FundingDestinationInput[] {
  return [{ id: "cart-total", kind: "payment", nominalCents: targetCents }];
}

function buildPreviewRealSplits(splits: ReadonlyArray<BatchSplitFormRow>): FundingPlanSplitInput[] {
  const result: FundingPlanSplitInput[] = [];
  for (const s of splits) {
    const cents = amountStringToCentsStrict(s.amount);
    if (cents != null && cents > 0) result.push({ id: s.uid, amountCents: cents });
  }
  return result;
}

/**
 * targetCents: total nominal a cancelar (base del carrito + recargo Pronto
 * Pago estimado — mismo valor que calculateBatchTargetAmountCents ya usa
 * para el modo legacy, nunca una segunda cuenta). availableCreditCents: el
 * valor ya leído de GET /insureds/:id/account-holder-balance (sin clampear —
 * este helper aplica Math.max(0, ...) él mismo, igual que el backend).
 */
export function computeTitularPreview(params: {
  targetCents: number;
  splits: ReadonlyArray<BatchSplitFormRow>;
  creditAppliedCents: number;
  roundingCoverageCents: number;
  availableCreditCents: number;
  debtAuthorized: boolean;
}): TitularPreviewResult {
  if (params.targetCents <= 0) {
    return { ok: false, errorMessage: "El carrito debe tener un total mayor a cero para calcular el resumen." };
  }
  try {
    const plan = planAccountHolderBatchFunding({
      destinations: buildPreviewDestinations(params.targetCents),
      realSplits: buildPreviewRealSplits(params.splits),
      creditAppliedCents: params.creditAppliedCents,
      roundingCoverageCents: params.roundingCoverageCents,
      availableCreditCents: Math.max(0, params.availableCreditCents),
      debtAuthorized: params.debtAuthorized,
    });
    return { ok: true, plan };
  } catch (e: any) {
    if (e instanceof AccountHolderFundingPlanError || e instanceof FundingValidationError) {
      return { ok: false, errorMessage: e.message };
    }
    throw e;
  }
}

// ─── 7. Payload final — campos exclusivos del modo titular ────────────────

export function buildTitularPayloadInput(params: {
  accountHolderInsuredId: number;
  creditAppliedCents: number;
  roundingCoverageCents: number;
  debtAuthorized: boolean;
  debtReason: string;
  idempotencyKey: string;
}): PaymentBatchTitularPayloadInput {
  return {
    accountHolderInsuredId: params.accountHolderInsuredId,
    creditAppliedCents: params.creditAppliedCents,
    roundingCoverageCents: params.roundingCoverageCents,
    debtAuthorized: params.debtAuthorized,
    // Nunca manda un motivo sin autorización, ni omite el motivo cuando sí
    // está autorizada — mismo contrato exacto que exige el backend (ver
    // account-holder-funding-request.ts).
    debtReason: params.debtAuthorized ? params.debtReason.trim() : null,
    idempotencyKey: params.idempotencyKey,
  };
}

// ─── 8. Idempotencia de frontend (Regla 4 del pedido) ─────────────────────

/**
 * Nueva key aleatoria — se genera UNA vez al iniciar un intento de envío del
 * modo titular, y se reutiliza tal cual para: (a) un reintento por error de
 * red del mismo intento, y (b) la confirmación posterior de un cheque
 * posiblemente duplicado (mismo request semántico — confirmPossibleDuplicates
 * no forma parte del fingerprint que el backend valida, ver
 * account-holder-funding-request.ts). Se descarta (vuelve a null) apenas
 * cambia cualquier dato económico del formulario, o después de un envío
 * exitoso — ver computeTitularEconomicFingerprint.
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * "Huella" económica del intento actual: items + splits en la MISMA forma
 * exacta que ya viaja en el payload (reutilizada vía buildPaymentBatchPayload
 * en vez de reimplementar ese mapeo) más los campos exclusivos del modo
 * titular. Dos llamadas con el mismo carrito/splits/campos titulares
 * producen exactamente el mismo string; cualquier cambio económico real
 * (ítem agregado/quitado, importe/cheque editado, crédito, redondeo, deuda)
 * lo cambia. El caller (el componente) compara esta huella contra la usada
 * para generar la idempotencyKey vigente — si difiere, la invalida (la
 * vuelve a null) para que el próximo envío genere una nueva.
 */
export function computeTitularEconomicFingerprint(params: {
  paymentDate: string;
  cart: ReadonlyArray<BatchCartItem>;
  splits: ReadonlyArray<BatchSplitFormRow>;
  accountHolderInsuredId: number;
  creditAppliedCents: number;
  roundingCoverageCents: number;
  debtAuthorized: boolean;
  debtReason: string;
  /** Notas generales del lote — integran el fingerprint del backend, así que cambiarlas debe invalidar la key. */
  notes?: string | null;
}): string {
  const legacyShape = buildPaymentBatchPayload({ paymentDate: params.paymentDate, cart: params.cart, splits: params.splits, notes: params.notes ?? null });
  return JSON.stringify({
    paymentDate: legacyShape.paymentDate,
    items: legacyShape.items,
    splits: legacyShape.splits,
    notes: legacyShape.notes,
    accountHolderInsuredId: params.accountHolderInsuredId,
    creditAppliedCents: params.creditAppliedCents,
    roundingCoverageCents: params.roundingCoverageCents,
    debtAuthorized: params.debtAuthorized,
    debtReason: params.debtAuthorized ? params.debtReason.trim() : null,
  });
}

// ─── 9. Resumen legible para el panel de confirmación (Regla 3/6 del pedido) ──

export interface TitularSummaryLine {
  label: string;
  amountCents: number;
  kind: "neutral" | "debt" | "credit";
}

/** Siempre en el mismo orden; omite crédito/redondeo/deuda/sobrante cuando son 0 — nunca muestra una línea en $0,00 sin sentido. */
export function buildTitularSummaryLines(plan: AccountHolderFundingPlanResult): TitularSummaryLine[] {
  const lines: TitularSummaryLine[] = [
    { label: "Total a cancelar", amountCents: plan.nominalTotalCents, kind: "neutral" },
    { label: "Medios reales ingresados", amountCents: plan.realSplitsTotalCents, kind: "neutral" },
  ];
  if (plan.creditAppliedCents > 0) lines.push({ label: "Crédito aplicado", amountCents: plan.creditAppliedCents, kind: "credit" });
  if (plan.roundingCoverageCents > 0) lines.push({ label: "Redondeo cubierto por oficina", amountCents: plan.roundingCoverageCents, kind: "neutral" });
  if (plan.newSaldoDeudorCents > 0) lines.push({ label: "Deuda nueva del titular", amountCents: plan.newSaldoDeudorCents, kind: "debt" });
  if (plan.newSaldoAFavorCents > 0) lines.push({ label: "Saldo a favor nuevo", amountCents: plan.newSaldoAFavorCents, kind: "credit" });
  return lines;
}
