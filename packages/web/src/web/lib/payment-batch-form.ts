// Helpers puros para "Cobrar en lote" (Cobranzas) — buscador + carrito
// heterogéneo (cuotas existentes + cobros manuales reales) + reparto de un
// cobro entre varios medios + cheques por medio. Sin JSX, sin estado de
// React — mismo estilo que payment-splits-form.ts, rendicion-pending.ts,
// rebilling-modal.ts.
//
// Reutiliza directamente de payment-splits-form.ts todo lo que ya es
// genérico sobre (totalAmountRaw, splits[]) — esa lógica nunca supuso un solo
// payment, así que no hace falta reimplementarla acá. También reutiliza
// classifySplitGroup y SURCHARGE_AMOUNT_CENTS de src/lib/payments — mismo
// criterio que usa el backend para decidir si el recargo Pronto Pago aplica,
// sin duplicar el monto ($800) en una segunda constante.
//
// UN COBRO MANUAL NUNCA ES UNA DEUDA — ver comentario de cabecera de
// src/lib/payments/batches.ts. Este archivo solo arma el carrito/payload; la
// regla de negocio vive en el backend (nunca confiar en el frontend para
// decidir qué es dinero real).
//
// Etapa "lote multi-asegurado": el carrito ya NO fija ningún asegurado ni
// bloquea ítems de "otro asegurado" — un batch es una operación de cobro,
// no un asegurado (puede mezclar pólizas de distintos integrantes de una
// familia, y el primer ítem puede ser una imputación completamente
// manual). Cada ítem lleva su propio insuredId (o null) de forma
// independiente; ya no existe "Cliente del lote" ni ningún gating por
// asegurado en las funciones de este archivo.
//
// Tres sources posibles, mismo criterio que el backend:
//   - installment: cuota existente — insuredId siempre real (viene de la
//     póliza de esa cuota).
//   - policy_manual_payment: vinculado a una póliza REAL sin cuota puntual
//     — insuredId siempre real (viene de esa póliza).
//   - manual_payment: imputación completamente libre (pagador/póliza/
//     compañía en texto, sin ninguna fila real detrás) — insuredId SIEMPRE
//     null, nunca inferido de ningún otro ítem del carrito.

import {
  type PaymentSplitFormRow, type SplitGroup,
  createSplitRow, computeSplitTotals, validateSplitsForm,
  groupSplitsByMethod, amountStringToCentsStrict, MIXED_GROUP_ERROR,
} from "./payment-splits-form";
import { isValidCalendarDate } from "../../lib/installments/plan";
import { classifySplitGroup } from "../../lib/payments/splits";
import { SURCHARGE_AMOUNT_CENTS } from "../../lib/payments/batches";

export type { SplitGroup };
export { computeSplitTotals, groupSplitsByMethod, amountStringToCentsStrict, MIXED_GROUP_ERROR, SURCHARGE_AMOUNT_CENTS };

// ─── 1. Cuota pendiente (fila de resultado de búsqueda, GET /installments/pending-for-payment) ──

export interface PendingInstallmentForPayment {
  installmentId: number;
  policyId: number;
  policyNumber: string;
  insuredId: number;
  insuredName: string;
  companyId: number;
  companyName: string;
  installmentNumber: number;
  dueDate: string;
  amount: number;
  status: string;
  rebillingId: number | null;
}

// ─── 2. Carrito heterogéneo (cuota existente / cobro manual con póliza / imputación libre) ──
// Sin ninguna restricción de asegurado — cada ítem identifica el suyo (o
// ninguno) de forma independiente.

export interface InstallmentCartItem {
  kind: "installment";
  installmentId: number;
  policyId: number;
  policyNumber: string;
  insuredId: number;
  insuredName: string;
  companyId: number;
  companyName: string;
  installmentNumber: number;
  dueDate: string;
  amount: number;
  status: string;
}

/** Cobro manual vinculado a una póliza real, sin cuota puntual — source="policy_manual_payment". */
export interface PolicyManualPaymentCartItem {
  kind: "policy_manual_payment";
  /** Clave local estable (no existe ningún id real hasta el submit). */
  localId: string;
  policyId: number;
  policyNumber: string;
  insuredId: number;
  insuredName: string;
  companyId: number;
  companyName: string;
  amount: number;
  description: string;
}

/** Imputación completamente manual (sin póliza ni asegurado real) — source="manual_payment". */
export interface ManualPaymentCartItem {
  kind: "manual_payment";
  localId: string;
  insuredId: null;
  insuredName: null;
  manualPayer: string | null;
  manualPolicyNumber: string | null;
  manualCompany: string | null;
  amount: number;
  description: string;
}

export type BatchCartItem = InstallmentCartItem | PolicyManualPaymentCartItem | ManualPaymentCartItem;

let manualUidCounter = 0;
export function nextManualPaymentLocalId(): string {
  manualUidCounter += 1;
  return `manual-${manualUidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function cartItemKey(item: BatchCartItem): string {
  return item.kind === "installment" ? `installment-${item.installmentId}` : item.localId;
}

/** Suma de amount del carrito, en pesos (no centavos) — cuotas + manuales. */
export function calculateCartTotal(cart: ReadonlyArray<BatchCartItem>): number {
  return cart.reduce((sum, i) => sum + i.amount, 0);
}

/**
 * Resumen de identificación del carrito — solo para MOSTRAR (nunca para
 * bloquear nada): "Varios asegurados" si hay más de una identidad real
 * distinta, el nombre real si hay exactamente una, o una etiqueta neutral
 * si el carrito es 100% manual_payment / está vacío. Mismo criterio que
 * computeBatchInsuredDisplay en el backend (index.ts), reimplementado acá
 * en el cliente para no depender de una ida y vuelta al servidor solo para
 * mostrar un badge.
 */
export interface CartInsuredSummary {
  kind: "empty" | "single" | "multiple" | "manual-only";
  label: string;
}
export function summarizeCartInsureds(cart: ReadonlyArray<BatchCartItem>): CartInsuredSummary {
  if (cart.length === 0) return { kind: "empty", label: "" };
  const realInsuredIds = new Set(cart.map((i) => i.insuredId).filter((id): id is number => id != null));
  if (realInsuredIds.size > 1) return { kind: "multiple", label: "Varios asegurados" };
  if (realInsuredIds.size === 1) {
    const label = cart.find((i) => i.insuredId != null)!.insuredName!;
    return { kind: "single", label };
  }
  return { kind: "manual-only", label: "Sin asegurado real (100% manual)" };
}

export interface CartMutationResult {
  cart: BatchCartItem[];
  error: string | null;
}

/** Estado de una fila de resultado de búsqueda de cuotas respecto al carrito actual — solo dedup, sin restricción de asegurado. */
export interface SearchResultRowState {
  addable: boolean;
  alreadyInCart: boolean;
  reason: string | null;
}

export function getInstallmentRowState(
  item: PendingInstallmentForPayment,
  cart: ReadonlyArray<BatchCartItem>
): SearchResultRowState {
  const alreadyInCart = cart.some((c) => c.kind === "installment" && c.installmentId === item.installmentId);
  if (alreadyInCart) {
    return { addable: false, alreadyInCart: true, reason: "Ya está en el carrito." };
  }
  return { addable: true, alreadyInCart: false, reason: null };
}

/** Agrega una cuota al carrito — solo rechaza duplicados (cualquier asegurado es válido). */
export function addInstallmentToCart(cart: BatchCartItem[], item: PendingInstallmentForPayment): CartMutationResult {
  const state = getInstallmentRowState(item, cart);
  if (!state.addable) {
    return { cart, error: state.reason };
  }
  const next: InstallmentCartItem = {
    kind: "installment",
    installmentId: item.installmentId,
    policyId: item.policyId,
    policyNumber: item.policyNumber,
    insuredId: item.insuredId,
    insuredName: item.insuredName,
    companyId: item.companyId,
    companyName: item.companyName,
    installmentNumber: item.installmentNumber,
    dueDate: item.dueDate,
    amount: item.amount,
    status: item.status,
  };
  return { cart: [...cart, next], error: null };
}

export function removeFromCart(cart: BatchCartItem[], key: string): BatchCartItem[] {
  return cart.filter((i) => cartItemKey(i) !== key);
}

// ─── 3. Formulario "Agregar cobro manual" ───────────────────────────────────
// Mismo modelo que la variante "Imputación manual" ya existente en
// PaymentModal (Cobranzas, pagos standalone): pagador/N° de póliza/compañía
// en texto libre, SIN exigir ninguna póliza real NI ningún cliente elegido
// de antemano. `linkPolicy` es la opción secundaria (desactivada por
// defecto) para vincular una póliza real existente — cuando está activa, el
// ítem resultante es "policy_manual_payment"; cuando no, es
// "manual_payment" (texto libre, sin asegurado).

export interface ManualPaymentFormState {
  linkPolicy: boolean;
  // Campos libres — siempre editables, se usan cuando linkPolicy=false.
  manualPayer: string;
  manualPolicyNumber: string;
  manualCompany: string;
  // Comunes a ambos modos.
  amount: string;
  description: string;
  // Solo cuando linkPolicy=true — poblados al elegir la póliza en el buscador.
  policyId: string;
  policyNumber: string;
  policyStatus: string;
  policyInsuredId: string;
  policyInsuredName: string;
  policyCompanyId: string;
  policyCompanyName: string;
}

export function emptyManualPaymentForm(): ManualPaymentFormState {
  return {
    linkPolicy: false,
    manualPayer: "", manualPolicyNumber: "", manualCompany: "",
    amount: "", description: "",
    policyId: "", policyNumber: "", policyStatus: "",
    policyInsuredId: "", policyInsuredName: "", policyCompanyId: "", policyCompanyName: "",
  };
}

export interface ManualPaymentValidationResult {
  valid: boolean;
  errorMessage: string | null;
}

/**
 * Validación de UI antes de agregar al carrito — replica (sin duplicar la
 * redacción) las mismas reglas que el backend vuelve a chequear con datos
 * reales en POST /payment-batches. Ninguna de las dos ramas pide ni valida
 * ningún asegurado "fijado" — ese concepto ya no existe.
 *  - linkPolicy=true: póliza seleccionada, no cancelada.
 *  - linkPolicy=false: al menos pagador o N° de póliza manual (mismo
 *    criterio que la imputación manual standalone) — nada más.
 */
export function validateManualPaymentForm(form: ManualPaymentFormState): ManualPaymentValidationResult {
  if (amountStringToCentsStrict(form.amount) == null) {
    return { valid: false, errorMessage: "El importe debe ser mayor a cero, con máximo dos decimales." };
  }
  if (form.linkPolicy) {
    if (!form.policyId) {
      return { valid: false, errorMessage: "Seleccioná una póliza o desactivá \"Vincular a una póliza existente\"." };
    }
    if (form.policyStatus === "cancelada") {
      return { valid: false, errorMessage: "La póliza está cancelada — no se puede cargar un cobro manual." };
    }
    return { valid: true, errorMessage: null };
  }
  if (!form.manualPayer.trim() && !form.manualPolicyNumber.trim()) {
    return { valid: false, errorMessage: "Completá al menos el pagador o el N° de póliza manual." };
  }
  return { valid: true, errorMessage: null };
}

/** Construye el ítem de carrito según el modo — nunca necesita ningún asegurado "de respaldo". */
export function buildManualCartItemFromForm(form: ManualPaymentFormState): PolicyManualPaymentCartItem | ManualPaymentCartItem {
  const localId = nextManualPaymentLocalId();
  if (form.linkPolicy) {
    return {
      kind: "policy_manual_payment",
      localId,
      policyId: Number(form.policyId),
      policyNumber: form.policyNumber,
      insuredId: Number(form.policyInsuredId),
      insuredName: form.policyInsuredName,
      companyId: Number(form.policyCompanyId),
      companyName: form.policyCompanyName,
      amount: Number(form.amount),
      description: form.description.trim(),
    };
  }
  return {
    kind: "manual_payment",
    localId,
    insuredId: null,
    insuredName: null,
    manualPayer: form.manualPayer.trim() || null,
    manualPolicyNumber: form.manualPolicyNumber.trim() || null,
    manualCompany: form.manualCompany.trim() || null,
    amount: Number(form.amount),
    description: form.description.trim(),
  };
}

/** Valida y, si es válido, agrega el cobro manual al carrito — combina las dos funciones de arriba para el caso común. */
export function addManualPaymentToCart(cart: BatchCartItem[], form: ManualPaymentFormState): CartMutationResult {
  const validation = validateManualPaymentForm(form);
  if (!validation.valid) {
    return { cart, error: validation.errorMessage };
  }
  return { cart: [...cart, buildManualCartItemFromForm(form)], error: null };
}

// ─── 4. Splits del lote (reparto entre medios de pago) ─────────────────────

export interface BatchSplitFormRow extends PaymentSplitFormRow {
  checks: CheckFormRow[];
}

export function createBatchSplitRow(method: string = "efectivo", amount: string = ""): BatchSplitFormRow {
  return { ...createSplitRow(method, amount), checks: [] };
}

export function addBatchSplitRow(splits: BatchSplitFormRow[], method: string = "efectivo"): BatchSplitFormRow[] {
  return [...splits, createBatchSplitRow(method)];
}

/** No permite eliminar la última fila — mismo criterio que removeSplitRow. */
export function removeBatchSplitRow(splits: BatchSplitFormRow[], uid: string): BatchSplitFormRow[] {
  if (splits.length <= 1) return splits;
  return splits.filter((s) => s.uid !== uid);
}

export function updateBatchSplitRow(
  splits: BatchSplitFormRow[],
  uid: string,
  patch: Partial<Pick<BatchSplitFormRow, "method" | "amount">>,
): BatchSplitFormRow[] {
  return splits.map((s) => (s.uid === uid ? { ...s, ...patch } : s));
}

/**
 * Con exactamente un medio, su importe siempre iguala el total a recibir
 * (que puede incluir el recargo Pronto Pago estimado — ver
 * calculateBatchTargetAmountCents). Reimplementado acá (2 líneas) en vez de
 * forzar el tipo genérico de syncSingleSplitAmount (que no conoce `checks` y
 * perdería el campo al tipar el retorno).
 */
export function syncSingleBatchSplitAmount(splits: BatchSplitFormRow[], amount: string): BatchSplitFormRow[] {
  if (splits.length !== 1) return splits;
  return [{ ...splits[0]!, amount }];
}

// ─── 5. Cheques por split ────────────────────────────────────────────────────

export interface CheckFormRow {
  uid: string;
  checkNumber: string;
  bankName: string;
  bankCode: string;
  drawerName: string;
  drawerDocument: string;
  issueDate: string;
  dueDate: string;
  amount: string;
  currency: string;
  notes: string;
}

let checkUidCounter = 0;
export function nextCheckUid(): string {
  checkUidCounter += 1;
  return `check-${checkUidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createCheckRow(): CheckFormRow {
  return {
    uid: nextCheckUid(), checkNumber: "", bankName: "", bankCode: "",
    drawerName: "", drawerDocument: "", issueDate: "", dueDate: "", amount: "",
    currency: "ARS", notes: "",
  };
}

export function addCheckToSplit(splits: BatchSplitFormRow[], splitUid: string): BatchSplitFormRow[] {
  return splits.map((s) => (s.uid === splitUid ? { ...s, checks: [...s.checks, createCheckRow()] } : s));
}

/** No permite eliminar el último cheque de un split cheque (siempre queda >=1 fila para completar). */
export function removeCheckFromSplit(splits: BatchSplitFormRow[], splitUid: string, checkUid: string): BatchSplitFormRow[] {
  return splits.map((s) => {
    if (s.uid !== splitUid) return s;
    if (s.checks.length <= 1) return s;
    return { ...s, checks: s.checks.filter((c) => c.uid !== checkUid) };
  });
}

export function updateCheckInSplit(
  splits: BatchSplitFormRow[], splitUid: string, checkUid: string, patch: Partial<Omit<CheckFormRow, "uid">>,
): BatchSplitFormRow[] {
  return splits.map((s) => (s.uid === splitUid
    ? { ...s, checks: s.checks.map((c) => (c.uid === checkUid ? { ...c, ...patch } : c)) }
    : s));
}

export interface CheckValidationResult {
  valid: boolean;
  errorMessage: string | null;
}

/**
 * Valida un cheque tal cual está en el formulario: número/banco/vencimiento
 * obligatorios, importe > 0 con máximo dos decimales. Mismo criterio que
 * lib/payments/received-checks.ts (validateReceivedCheckFields/
 * validateCheckDate), adaptado a strings de formulario en vez de un body ya
 * parseado — no duplica la regla de negocio, solo adapta la entrada.
 */
export function validateCheckRow(check: CheckFormRow, label = "cheque"): CheckValidationResult {
  if (!check.checkNumber.trim()) return { valid: false, errorMessage: `El número del ${label} es obligatorio.` };
  if (!check.bankName.trim()) return { valid: false, errorMessage: `El banco del ${label} es obligatorio.` };
  if (!check.dueDate) return { valid: false, errorMessage: `La fecha de vencimiento del ${label} es obligatoria.` };
  if (!isValidCalendarDate(check.dueDate)) {
    return { valid: false, errorMessage: `La fecha de vencimiento del ${label} no es una fecha válida.` };
  }
  if (check.issueDate) {
    if (!isValidCalendarDate(check.issueDate)) {
      return { valid: false, errorMessage: `La fecha de emisión del ${label} no es una fecha válida.` };
    }
    if (check.dueDate < check.issueDate) {
      return { valid: false, errorMessage: `El vencimiento del ${label} no puede ser anterior a la emisión.` };
    }
  }
  if (amountStringToCentsStrict(check.amount) == null) {
    return { valid: false, errorMessage: `El importe del ${label} debe ser mayor a cero, con máximo dos decimales.` };
  }
  return { valid: true, errorMessage: null };
}

/** Suma de cheques con importe válido de un split, en centavos (inválidos cuentan 0 — igual bloquean por otro lado). */
export function sumCheckRowsCents(checks: ReadonlyArray<CheckFormRow>): number {
  return checks.reduce((sum, c) => sum + (amountStringToCentsStrict(c.amount) ?? 0), 0);
}

// Migración 0028 — cheques en cobranzas INDIVIDUALES: cambiar el método de
// un split debe conservar sus cheques solo si sigue siendo "cheque". Al
// entrar a "cheque" arranca con una fila vacía (nunca 0, para no mostrar el
// subformulario sin nada que completar); al salir de "cheque" se descartan
// (un split no-cheque no puede tener checks — ver
// validateChecksMatchSplit/normalizeReceivedCheck del backend). Reutilizado
// por el modal de "Imputar pago individual" (cobranzas.tsx); "Cobrar en
// lote" no lo necesita porque ahí cada split nuevo ya nace con el método
// elegido en el selector de "+ Agregar medio", nunca cambia de método
// después de creado con cheques cargados.
export function updateSplitMethodPreservingChecks(splits: BatchSplitFormRow[], uid: string, method: string): BatchSplitFormRow[] {
  const updated = updateBatchSplitRow(splits, uid, { method });
  return updated.map((s) => {
    if (s.uid !== uid) return s;
    if (method === "cheque") return { ...s, checks: s.checks.length > 0 ? s.checks : [createCheckRow()] };
    return { ...s, checks: [] };
  });
}

// Payload de splits para POST/PUT /api/payments (pago individual) — mismo
// mapeo de checks que ya usa buildPaymentBatchPayload para POST
// /api/payment-batches, pero sin el resto del sobre (items/paymentDate/etc.,
// que no aplican a un pago individual).
export interface PaymentSplitPayloadItem {
  method: string;
  amount: number;
  checks?: ReceivedCheckInput[];
}

export function splitsToPaymentSplitsPayload(splits: ReadonlyArray<BatchSplitFormRow>): PaymentSplitPayloadItem[] {
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

// ─── 6. Recargo Pronto Pago estimado + importe objetivo del reparto ────────
// El backend es la única autoridad real (recalcula todo con datos de DB) —
// esto es una ESTIMACIÓN de UI para que el importe que el usuario tipea en
// los medios ya incluya el recargo esperado, en vez de descubrir recién al
// confirmar que "la suma no coincide". Mismo criterio exacto que
// calculateApplicableRivadaviaSurcharges del backend: $800 por cuota o
// policy_manual_payment cuya companyName (REAL) contenga "rivadavia", solo
// si el grupo de medios es "own". Un manual_payment (imputación libre) NUNCA
// entra acá — no tiene companyName real, solo texto suelto sin garantía
// (manualCompany no se usa para esta estimación a propósito, mismo criterio
// que el backend: ver batches.ts).

export function estimateProntoPagoSurchargeCents(cart: ReadonlyArray<BatchCartItem>): number {
  const rivadaviaCount = cart.filter((i) =>
    i.kind !== "manual_payment" && (i.companyName ?? "").toLowerCase().includes("rivadavia")
  ).length;
  return rivadaviaCount * SURCHARGE_AMOUNT_CENTS;
}

/**
 * Importe total que los medios (splits) deben sumar exacto: base del
 * carrito + recargo Pronto Pago estimado, solo si TODOS los métodos ya
 * cargados son del grupo "own" (mismo criterio que el backend — con 0 splits
 * o grupo direct_company/mixed, el recargo no aplica y el objetivo es solo
 * la base).
 */
export function calculateBatchTargetAmountCents(
  cart: ReadonlyArray<BatchCartItem>,
  splits: ReadonlyArray<BatchSplitFormRow>
): number {
  const baseCents = Math.round(calculateCartTotal(cart) * 100);
  if (splits.length === 0) return baseCents;
  const group = classifySplitGroup(splits.map((s) => ({ method: s.method })));
  if (group !== "own") return baseCents;
  return baseCents + estimateProntoPagoSurchargeCents(cart);
}

// ─── 7. Validación completa del editor de medios del lote ───────────────────

export interface BatchSplitsValidationResult {
  valid: boolean;
  group: SplitGroup | null;
  errorMessage: string | null;
}

/**
 * Reutiliza validateSplitsForm (método/suma total/grupo propio-vs-directo)
 * contra el importe OBJETIVO (base + recargo estimado si corresponde, ver
 * calculateBatchTargetAmountCents — nunca solo la base) y agrega la regla
 * propia de cheques: cada split "cheque" necesita >=1 cheque válido cuya
 * suma sea exacta al importe de ese split.
 */
export function validateBatchSplitsForm(targetAmountCents: number, splits: BatchSplitFormRow[]): BatchSplitsValidationResult {
  const base = validateSplitsForm(String(targetAmountCents / 100), splits);
  if (!base.valid) return base;

  for (const split of splits) {
    if (split.method !== "cheque") continue;
    if (split.checks.length === 0) {
      return { valid: false, group: base.group, errorMessage: "El medio cheque debe incluir al menos un cheque." };
    }
    for (const chk of split.checks) {
      const chkValid = validateCheckRow(chk);
      if (!chkValid.valid) return { valid: false, group: base.group, errorMessage: chkValid.errorMessage };
    }
    const splitCents = amountStringToCentsStrict(split.amount);
    const checksCents = sumCheckRowsCents(split.checks);
    if (splitCents != null && checksCents !== splitCents) {
      const diffCents = splitCents - checksCents;
      const msg = diffCents > 0
        ? `Faltan distribuir $${(diffCents / 100).toFixed(2)} en cheques.`
        : `Los cheques exceden por $${(Math.abs(diffCents) / 100).toFixed(2)}.`;
      return { valid: false, group: base.group, errorMessage: msg };
    }
  }
  return { valid: true, group: base.group, errorMessage: null };
}

/** Misma condición que el resto de la app: deshabilita el botón de confirmar mientras guarda o mientras el formulario no es válido. */
export function isBatchSubmitDisabled(saving: boolean, splitsValid: boolean, hasSelection: boolean): boolean {
  return saving || !splitsValid || !hasSelection;
}

// ─── 8. Payload final — POST /api/payment-batches ───────────────────────────

export interface ReceivedCheckInput {
  checkNumber: string;
  bankName: string;
  bankCode?: string | null;
  drawerName?: string | null;
  drawerDocument?: string | null;
  issueDate?: string | null;
  dueDate: string;
  amount: number;
  notes?: string | null;
}

export interface PaymentBatchSplitInput {
  method: string;
  amount: number;
  notes?: string | null;
  checks?: ReceivedCheckInput[];
}

// Discriminado — la UI nueva manda siempre `source` explícito (a diferencia
// del body legacy `{installmentId}` que el backend sigue aceptando para
// compatibilidad, ver normalizeBatchItems en lib/payments/batches.ts).
export type PaymentBatchItemInput =
  | { source: "installment"; installmentId: number }
  | { source: "policy_manual_payment"; policyId: number; amount: number; description?: string | null }
  | {
      source: "manual_payment";
      manualPayer?: string | null;
      manualPolicyNumber?: string | null;
      manualCompany?: string | null;
      amount: number;
      description?: string | null;
    };

// Sin insuredId — el backend ya no lo exige ni lo lee: cada ítem resuelve el
// suyo, y payment_batches.insured_id se deriva server-side.
export interface PaymentBatchCreatePayload {
  paymentDate: string;
  items: PaymentBatchItemInput[];
  splits: PaymentBatchSplitInput[];
  notes?: string | null;
  applyProntoPagoSurcharge?: boolean;
  confirmPossibleDuplicates?: boolean;
}

/**
 * Payload exacto de POST /api/payment-batches. NUNCA incluye `uid`/`localId`
 * (locales, solo para keys de React) ni insuredId (dato derivado
 * server-side, ya no se manda). Un installment nunca manda importe (el
 * backend siempre relee installment.amount de la base); los dos tipos de
 * cobro manual sí, porque no hay ninguna otra fuente de verdad para su
 * importe.
 */
export function buildPaymentBatchPayload(params: {
  paymentDate: string;
  cart: ReadonlyArray<BatchCartItem>;
  splits: ReadonlyArray<BatchSplitFormRow>;
  notes?: string | null;
  applyProntoPagoSurcharge?: boolean;
  confirmPossibleDuplicates?: boolean;
}): PaymentBatchCreatePayload {
  return {
    paymentDate: params.paymentDate,
    items: params.cart.map((i): PaymentBatchItemInput => {
      if (i.kind === "installment") return { source: "installment", installmentId: i.installmentId };
      if (i.kind === "policy_manual_payment") {
        return { source: "policy_manual_payment", policyId: i.policyId, amount: i.amount, description: i.description || null };
      }
      return {
        source: "manual_payment",
        manualPayer: i.manualPayer,
        manualPolicyNumber: i.manualPolicyNumber,
        manualCompany: i.manualCompany,
        amount: i.amount,
        description: i.description || null,
      };
    }),
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
    applyProntoPagoSurcharge: params.applyProntoPagoSurcharge,
    confirmPossibleDuplicates: params.confirmPossibleDuplicates,
  };
}

// ─── 9. Listado y detalle (GET /payment-batches, GET /payment-batches/:id) ──

// insuredId/insuredName son datos DERIVADOS y con frecuencia null (lote
// multi-asegurado, o 100% manual) — insuredDisplay SIEMPRE viene poblado
// (nombre real / "Varios asegurados" / pagador manual / "Cobro múltiple"),
// pensado para mostrar directo sin lógica adicional en el componente.
export interface PaymentBatchSummary {
  id: number;
  paymentDate: string;
  insuredId: number | null;
  insuredName: string | null;
  insuredDisplay: string;
  status: string;
  totalAmountCents: number;
  totalReceivedCents: number;
  itemCount: number;
  splitCount: number;
  checkCount: number;
  notes: string | null;
  createdAt: string;
}

export interface PaymentBatchDetailItem {
  payment: {
    id: number; amount: number; policyId: number | null; installmentId: number | null;
    paymentDate: string; status: string; notes: string | null;
    manualPayer: string | null; manualPolicyNumber: string | null; manualCompany: string | null;
  };
  installment: { id: number; number: number; dueDate: string; amount: number } | null;
  policy: { id: number; policyNumber: string } | null;
  company: { id: number; name: string } | null;
  insured: { id: number; name: string } | null;
}

export interface PaymentBatchDetailCheck {
  id: number;
  checkNumber: string;
  bankName: string;
  amountCents: number;
  dueDate: string;
  status: string;
}

export interface PaymentBatchDetailSplit {
  id: number;
  batchId: number;
  method: string;
  amountCents: number;
  notes: string | null;
  checks: PaymentBatchDetailCheck[];
}

export interface BatchInsuredSummary {
  insuredId: number | null;
  insuredName: string | null;
  insuredDisplay: string;
}

export interface PaymentBatchDetail {
  batch: {
    id: number; insuredId: number | null; baseAmountCents: number; surchargeAmountCents: number;
    totalReceivedCents: number; paymentDate: string; status: string; notes: string | null; createdAt: string;
    cancelledAt: string | null; cancellationReason: string | null;
  };
  insuredSummary: BatchInsuredSummary;
  items: PaymentBatchDetailItem[];
  splits: PaymentBatchDetailSplit[];
  surcharges: Array<{ id: number; amount: number }>;
  integrity: Record<string, unknown>;
}

/** true si el ítem del detalle es un cobro manual de cualquier tipo (sin cuota — installment viene null del backend). */
export function isManualBatchDetailItem(item: PaymentBatchDetailItem): boolean {
  return item.installment == null;
}

/** true específicamente para la imputación completamente libre (sin póliza real — policyId también null). */
export function isFreeformManualBatchDetailItem(item: PaymentBatchDetailItem): boolean {
  return item.installment == null && item.policy == null;
}

/** Asegurado/pagador de UN ítem puntual — real si lo tiene, texto manual si no, "—" si no hay ningún dato. */
export function batchDetailItemInsuredLabel(item: PaymentBatchDetailItem): string {
  if (item.insured) return item.insured.name;
  return item.payment.manualPayer ?? "—";
}

/**
 * Etiqueta de una fila del comprobante/resumen:
 *  - "Cuota N — vence FECHA — póliza X" para una cuota existente;
 *  - "Cobro manual — póliza X — descripción" para un cobro manual con
 *    póliza real;
 *  - "Cobro manual — pagador/póliza/compañía manuales — descripción" para
 *    una imputación completamente libre (datos desde payment.manualPayer/
 *    manualPolicyNumber/manualCompany, únicas columnas donde el backend los
 *    persiste).
 */
export function describeBatchDetailItem(item: PaymentBatchDetailItem): string {
  if (!isManualBatchDetailItem(item)) {
    const policyLabel = item.policy?.policyNumber ?? "—";
    return `Cuota ${item.installment!.number} — vence ${item.installment!.dueDate} — póliza ${policyLabel}`;
  }
  const description = item.payment.notes?.trim();
  if (!isFreeformManualBatchDetailItem(item)) {
    const policyLabel = item.policy?.policyNumber ?? "—";
    return `Cobro manual — póliza ${policyLabel}${description ? ` — ${description}` : ""}`;
  }
  const parts = [
    item.payment.manualPayer ? `pagador ${item.payment.manualPayer}` : null,
    item.payment.manualPolicyNumber ? `póliza manual ${item.payment.manualPolicyNumber}` : null,
    item.payment.manualCompany ? `compañía ${item.payment.manualCompany}` : null,
  ].filter((p): p is string => p != null);
  const manualLabel = parts.length > 0 ? parts.join(" — ") : "sin datos";
  return `Cobro manual — ${manualLabel}${description ? ` — ${description}` : ""}`;
}

// ─── 10. Errores de red ──────────────────────────────────────────────────────
// Mismo contrato que ya usa toda la app: api.ts adjunta status/body al Error.

export interface NormalizedBatchError {
  message: string;
  blockingInstallmentIds: number[];
  code: string | null;
}

export function normalizeBatchSubmitError(err: { message?: string; body?: any }): NormalizedBatchError {
  return {
    message: err?.body?.error || err?.message || "No se pudo crear el cobro por lote.",
    blockingInstallmentIds: err?.body?.blockingInstallmentIds ?? [],
    code: err?.body?.code ?? null,
  };
}

// ─── 11. Anulación de un lote confirmado (corrección segura) ────────────────
// "Corregir" un lote confirmado nunca es una edición monetaria: es anular
// (con trazabilidad) y crear uno nuevo. GET .../cancel-check muestra el
// impacto ANTES de tocar nada; POST .../cancel exige confirmación explícita.
// Ninguna función de esta sección llama a la red — solo dan forma a lo que
// ya devolvió/necesita el backend, mismo estilo que el resto del archivo.

export interface BatchCancelAffectedPayment {
  id: number;
  amount: number;
  installmentId: number | null;
  policyId: number | null;
  manualPayer: string | null;
}
export interface BatchCancelAffectedInstallment {
  id: number;
  number: number;
  dueDate: string;
  amount: number;
  currentStatus: string;
}
export interface BatchCancelCheckRow {
  id: number;
  checkNumber: string;
  bankName: string;
  amountCents: number;
  status: string;
}
export interface BatchCancelSurchargeEntry {
  id: number;
  amountCents: number;
  rendered: number;
}

export interface PaymentBatchCancelCheckResponse {
  canCancel: boolean;
  status: string;
  blockingReasons: string[];
  affectedPayments: BatchCancelAffectedPayment[];
  affectedInstallments: BatchCancelAffectedInstallment[];
  checks: BatchCancelCheckRow[];
  remittanceLinks: { allocationCount: number; itemCount: number };
  surchargeEntries: BatchCancelSurchargeEntry[];
}

export interface PaymentBatchCancelResult {
  ok: boolean;
  alreadyCancelled: boolean;
  batch: { id: number; status: string; cancelledAt: string | null; cancellationReason: string | null };
}

/**
 * Resumen legible para el modal "Anular cobro" — una línea por cada efecto
 * real, en el mismo orden que la sección 3 del diagnóstico (items, cuotas,
 * manuales, cheques, recargo). Nunca incluye los blockingReasons (esos se
 * muestran aparte, y cuando existen no se llega a ofrecer la confirmación).
 */
export function describeBatchCancelImpact(check: PaymentBatchCancelCheckResponse): string[] {
  const lines: string[] = [];
  const total = check.affectedPayments.reduce((s, p) => s + p.amount, 0);
  lines.push(`${check.affectedPayments.length} pago(s) por un total de $${total.toFixed(2)} quedarán anulados.`);
  if (check.affectedInstallments.length > 0) {
    lines.push(`${check.affectedInstallments.length} cuota(s) volverán a estar disponibles para cobrar: ${check.affectedInstallments.map((i) => `#${i.number}`).join(", ")}.`);
  }
  const manualCount = check.affectedPayments.filter((p) => p.installmentId == null && p.policyId == null).length;
  if (manualCount > 0) {
    lines.push(`${manualCount} cobro(s) manual(es) libre(s) quedarán anulados (sin generar ninguna deuda).`);
  }
  if (check.checks.length > 0) {
    lines.push(`${check.checks.length} cheque(s) quedarán anulados: ${check.checks.map((c) => `${c.bankName} #${c.checkNumber}`).join(", ")}.`);
  }
  if (check.surchargeEntries.length > 0) {
    const surchargeTotal = check.surchargeEntries.reduce((s, e) => s + e.amountCents, 0) / 100;
    lines.push(`El recargo Pronto Pago ($${surchargeTotal.toFixed(2)}) dejará de contarse.`);
  }
  return lines;
}

/** Botón "Anular cobro" — solo tiene sentido ofrecerlo sobre un batch todavía confirmado. */
export function canShowCancelButton(batchStatus: string): boolean {
  return batchStatus === "confirmado";
}

/** Botón "Editar datos" — misma condición que "Anular cobro": solo un batch confirmado admite tocar algo. */
export function canShowEditButton(batchStatus: string): boolean {
  return batchStatus === "confirmado";
}

/** El botón final de "Anular cobro" (destructivo) exige el checkbox tildado Y que cancel-check haya dado canCancel=true. */
export function isCancelConfirmationValid(check: PaymentBatchCancelCheckResponse | null, checkboxConfirmed: boolean): boolean {
  return check != null && check.canCancel && checkboxConfirmed;
}

export interface PaymentBatchCancelPayload {
  confirm: true;
  reason?: string | null;
}

export function buildBatchCancelPayload(reason: string): PaymentBatchCancelPayload {
  const trimmed = reason.trim();
  return { confirm: true, reason: trimmed || null };
}

// ─── 12. Edición administrativa (PATCH — solo fecha/notas) ──────────────────
// Nunca se ofrece ningún campo monetario en este formulario — ver texto
// operativo fijo más abajo, que la UI debe mostrar siempre junto al botón
// "Editar datos" (no solo cuando algo falla).

export const BATCH_CORRECTION_HINT =
  'Para cambiar importes, cuotas o medios de pago, anulá este cobro y creá uno nuevo.';

export interface BatchEditFormState {
  paymentDate: string;
  notes: string;
}

export function emptyBatchEditForm(paymentDate: string, notes: string | null): BatchEditFormState {
  return { paymentDate, notes: notes ?? "" };
}

export interface PaymentBatchPatchPayload {
  paymentDate?: string;
  notes?: string | null;
}

export interface BatchEditValidationResult {
  valid: boolean;
  errorMessage: string | null;
}

/** paymentDate obligatoria y con formato de fecha real — mismo criterio de forma que el resto de la app (YYYY-MM-DD). */
export function validateBatchEditForm(form: BatchEditFormState): BatchEditValidationResult {
  if (!form.paymentDate || !/^\d{4}-\d{2}-\d{2}$/.test(form.paymentDate)) {
    return { valid: false, errorMessage: "La fecha de pago es obligatoria y debe tener formato YYYY-MM-DD." };
  }
  return { valid: true, errorMessage: null };
}

/** Payload de PATCH — nunca incluye ningún campo fuera de paymentDate/notes (esa es la garantía que valida el backend). */
export function buildBatchPatchPayload(form: BatchEditFormState): PaymentBatchPatchPayload {
  return { paymentDate: form.paymentDate, notes: form.notes.trim() || null };
}
