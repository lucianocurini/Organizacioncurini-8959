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

import { formatCurrencyCents } from "./utils";
import {
  type PaymentSplitFormRow, type SplitGroup,
  createSplitRow, computeSplitTotals, validateSplitsForm,
  groupSplitsByMethod, amountStringToCentsStrict, MIXED_GROUP_ERROR,
} from "./payment-splits-form";
import { isValidCalendarDate } from "../../lib/installments/plan";
import { classifySplitGroup } from "../../lib/payments/splits";
import { SURCHARGE_AMOUNT_CENTS } from "../../lib/payments/batches";
import { isSurchargeAbsorbedByGroup } from "../../lib/payments/policy-economic-group";
import {
  calculateBatchReceivedAppliedDifference, MAX_ROUNDING_ADJUSTMENT_CENTS,
  type BatchReceivedAppliedDifference, type BatchReceivedAppliedKind,
} from "../../lib/payments/insured-account";

export type { SplitGroup, BatchReceivedAppliedDifference, BatchReceivedAppliedKind };
export {
  computeSplitTotals, groupSplitsByMethod, amountStringToCentsStrict, MIXED_GROUP_ERROR, SURCHARGE_AMOUNT_CENTS,
  calculateBatchReceivedAppliedDifference, MAX_ROUNDING_ADJUSTMENT_CENTS,
};

// ─── 1. Cuota pendiente (fila de resultado de búsqueda, GET /installments/pending-for-payment) ──

export interface PendingInstallmentForPayment {
  installmentId: number;
  policyId: number;
  policyNumber: string;
  // Grupo económico Rivadavia (ver lib/payments/policy-economic-group.ts):
  // policyType/parentPolicyId de la póliza real de esta cuota;
  // parentPolicyNumber solo para mostrar la pista visual "Accesoria de
  // póliza X" — nunca se usa para decidir agrupación (eso lo hace el
  // backend con parentPolicyId, no con el número).
  policyType: string;
  parentPolicyId: number | null;
  parentPolicyNumber: string | null;
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
  policyType: string;
  parentPolicyId: number | null;
  parentPolicyNumber: string | null;
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
  policyType: string;
  parentPolicyId: number | null;
  parentPolicyNumber: string | null;
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
    policyType: item.policyType,
    parentPolicyId: item.parentPolicyId,
    parentPolicyNumber: item.parentPolicyNumber,
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
      // El buscador de "vincular a póliza" de un cobro manual no resuelve
      // hoy el type/parentPolicyId real de la póliza elegida — se deja
      // conservador (nunca "accidentes_pasajeros" agrupable), mismo
      // criterio que el caso D de policy-economic-group.ts: nunca inventar
      // un vínculo que no se puede confirmar. El backend es quien decide de
      // verdad (relee la póliza real en POST /payment-batches).
      policyType: "",
      parentPolicyId: null,
      parentPolicyNumber: null,
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

/**
 * Recalcula split.amount de cada split "cheque" como la suma EXACTA (en
 * centavos) de sus propios cheques — nunca al revés. El usuario ya no
 * escribe el importe de un split cheque a mano: se deriva solo, cada vez que
 * agrega/edita/quita un cheque, sin importar cuántos medios de pago haya en
 * total (a diferencia de syncSingleBatchSplitAmount, que solo actúa con un
 * único split). No-op para cualquier split que no sea "cheque" — no toca su
 * `amount`. Idempotente y puro: aplicarlo dos veces seguidas da el mismo
 * resultado. `.toFixed(2)` (no `String(cents/100)`) para no arrastrar ruido
 * de punto flotante al campo que ahora se muestra como "calculado" en la UI.
 */
export function syncChequeSplitAmounts(splits: BatchSplitFormRow[]): BatchSplitFormRow[] {
  return splits.map((s) => (s.method === "cheque" ? { ...s, amount: (sumCheckRowsCents(s.checks) / 100).toFixed(2) } : s));
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
// calculateApplicableRivadaviaSurcharges del backend: $800 por GRUPO
// ECONÓMICO Rivadavia (cuota o policy_manual_payment cuya companyName REAL
// contenga "rivadavia"), solo si el grupo de medios es "own". Una póliza
// accesoria de Accidentes de Pasajeros cuyo parentPolicyId apunta a otra
// póliza YA presente en este mismo carrito no suma su propio recargo — ver
// lib/payments/policy-economic-group.ts (mismo criterio, mismo archivo,
// para que frontend y backend nunca se desalineen). Un manual_payment
// (imputación libre) NUNCA entra acá — no tiene companyName real, solo
// texto suelto sin garantía (manualCompany no se usa para esta estimación a
// propósito, mismo criterio que el backend: ver batches.ts).

export function estimateProntoPagoSurchargeCents(cart: ReadonlyArray<BatchCartItem>): number {
  const rivadaviaItems = cart.filter((i) =>
    i.kind !== "manual_payment" && (i.companyName ?? "").toLowerCase().includes("rivadavia")
  );
  const policyIdsInScope = new Set(
    cart.filter((i): i is InstallmentCartItem | PolicyManualPaymentCartItem => i.kind !== "manual_payment").map((i) => i.policyId)
  );
  const applicableCount = rivadaviaItems.filter((i) => {
    if (i.kind === "manual_payment") return false; // ya excluido arriba, defensivo para el type narrowing
    return !isSurchargeAbsorbedByGroup(
      { id: i.policyId, type: i.policyType, parentPolicyId: i.parentPolicyId },
      policyIdsInScope
    );
  }).length;
  return applicableCount * SURCHARGE_AMOUNT_CENTS;
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
 * suma sea exacta al importe de ESE split — esto nunca se relaja, ni
 * siquiera con options.allowAmountDifference (Fase 2E): un cheque real
 * jamás se "achica" para cerrar contra ninguna cifra, solo el TOTAL del
 * cobro puede diferir del aplicado (ver BatchPaymentModal, que es el único
 * caller que pasa allowAmountDifference:true — el pago individual standalone
 * en cobranzas.tsx sigue exigiendo coincidencia exacta).
 */
export function validateBatchSplitsForm(
  targetAmountCents: number,
  splits: BatchSplitFormRow[],
  options?: { allowAmountDifference?: boolean },
): BatchSplitsValidationResult {
  const base = validateSplitsForm(String(targetAmountCents / 100), splits, options);
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

// ─── 7B. Resolución de sobrante/faltante (Fase 2E — UI de accountDifferenceResolution) ──
// Cuando SUM(splits) (dinero real, ver validateBatchSplitsForm con
// allowAmountDifference:true) difiere del importe aplicado a las cuotas
// (target = base + recargo), el backend exige un accountDifferenceResolution
// explícito (ver POST /payment-batches, index.ts) — este bloque arma y valida
// esa resolución en el cliente, con el mismo criterio exacto que el backend
// vuelve a chequear con datos reales (nunca se confía solo en esto: el
// backend es la última autoridad, ver normalizeBatchSubmitError para cuando
// igual rechaza).

export interface BatchDifferenceResolutionFormState {
  action: "saldo_a_favor" | "saldo_deudor" | null;
  reason: string;
}

export function emptyBatchDifferenceResolutionForm(): BatchDifferenceResolutionFormState {
  return { action: null, reason: "" };
}

export interface BatchDifferenceValidationResult {
  valid: boolean;
  errorMessage: string | null;
}

/**
 * "exacto" (sin diferencia) siempre es válido sin necesidad de ninguna
 * resolución — comportamiento idéntico a antes de esta fase. Con diferencia:
 *  - exige un único asegurado real en el carrito (cartInsuredKind==="single"
 *    — mismo criterio que resolveBatchInsuredId/derivedInsuredId del
 *    backend: "multiple" o "manual-only" no tienen un dueño único al que
 *    atribuir el sobrante/faltante).
 *  - exige que el caller haya elegido la ÚNICA acción que corresponde al
 *    sentido real de la diferencia (nunca se ofrece elegir la otra).
 *  - exige reason no vacío específicamente para saldo_deudor (mismo
 *    REASON_REQUIRED_TYPES que valida el backend en insured-account.ts).
 */
export function validateBatchDifferenceResolution(
  difference: BatchReceivedAppliedDifference,
  resolution: BatchDifferenceResolutionFormState,
  cartInsuredKind: CartInsuredSummary["kind"],
): BatchDifferenceValidationResult {
  if (difference.kind === "exacto") return { valid: true, errorMessage: null };

  if (cartInsuredKind !== "single") {
    return {
      valid: false,
      errorMessage:
        "No se puede determinar un único asegurado real para asignar esta diferencia (el cobro mezcla más de un " +
        "asegurado, o es una imputación 100% manual sin asegurado real). Separá este cobro para poder continuar.",
    };
  }
  if (resolution.action == null) {
    return {
      valid: false,
      errorMessage: difference.kind === "saldo_a_favor"
        ? "Hay un sobrante: elegí \"Saldo a favor del asegurado\" para poder confirmar el cobro."
        : "Hay un faltante: elegí \"Saldo deudor del asegurado\" para poder confirmar el cobro.",
    };
  }
  if (resolution.action !== difference.kind) {
    return {
      valid: false,
      errorMessage: `La resolución elegida ("${resolution.action}") no coincide con el sentido real de la diferencia ("${difference.kind}").`,
    };
  }
  if (resolution.action === "saldo_deudor" && !resolution.reason.trim()) {
    return { valid: false, errorMessage: "El motivo es obligatorio para registrar un saldo deudor." };
  }
  return { valid: true, errorMessage: null };
}

export interface AccountDifferenceResolutionPayload {
  action: "saldo_a_favor" | "saldo_deudor" | "ajuste_redondeo";
  reason?: string | null;
}

/** null si todavía no se eligió ninguna acción — nunca se manda un payload a medio construir. */
export function buildAccountDifferenceResolutionPayload(
  resolution: BatchDifferenceResolutionFormState,
): AccountDifferenceResolutionPayload | null {
  if (resolution.action == null) return null;
  const reason = resolution.reason.trim();
  return { action: resolution.action, reason: reason || null };
}

// ─── 7C. Tolerancia de redondeo (payment_amount_adjustments, sin cuenta corriente) ──
// Alternativa MÁS SIMPLE a saldo_a_favor/saldo_deudor para una diferencia
// chica (≤$5,00): un checkbox único, sin motivo obligatorio, que NUNCA exige
// un asegurado real único — funciona igual con lote de un asegurado,
// multiasegurado o 100% manual (ver payment_amount_adjustments, que no tiene
// insuredId). El backend vuelve a exigir el mismo tope, nunca confía en que
// el checkbox ya lo filtró (ver POST /payment-batches, index.ts).

/** true si la diferencia es distinta de 0 y su valor absoluto no supera el tope — mismo criterio que validateRoundingAdjustment (backend). */
export function isRoundingAdjustmentEligible(differenceCents: number): boolean {
  return differenceCents !== 0 && Math.abs(differenceCents) <= MAX_ROUNDING_ADJUSTMENT_CENTS;
}

export function buildRoundingAdjustmentPayload(): AccountDifferenceResolutionPayload {
  return { action: "ajuste_redondeo" };
}

/**
 * Validación completa de la resolución de diferencia, incluyendo la
 * tolerancia de redondeo:
 *  - "exacto": siempre válido, sin resolución (comportamiento sin cambios).
 *  - diferencia elegible para redondeo (ver isRoundingAdjustmentEligible) Y
 *    el usuario tildó el checkbox: válido siempre, sin importar
 *    cartInsuredKind — a diferencia de saldo_a_favor/saldo_deudor, esta vía
 *    no exige ningún asegurado real.
 *  - asegurado único, diferencia elegible para redondeo, checkbox SIN tildar
 *    y todavía no eligió ninguna resolución (resolution.action == null):
 *    mensaje que menciona LAS DOS vías disponibles (redondeo o saldo a
 *    favor/deudor) — el genérico de validateBatchDifferenceResolution solo
 *    menciona saldo a favor/deudor, que ya no es la única opción cuando el
 *    checkbox de redondeo está disponible. Una vez que el usuario ya eligió
 *    algo (radio tildado, con o sin motivo cargado), se vuelve al mensaje
 *    específico de esa vía (ver validateBatchDifferenceResolution).
 *  - cualquier otro caso (diferencia >$5,00, o ≤$5,00 sin tildar el
 *    checkbox y ya con una resolución elegida): EXACTAMENTE el criterio
 *    existente de validateBatchDifferenceResolution, sin ningún cambio — el
 *    flujo de saldo a favor/deudor para un asegurado único sigue disponible
 *    tal cual estaba, tildar el checkbox de redondeo es lo único que lo
 *    excluye.
 */
export function validateBatchDifferenceResolutionWithRounding(
  difference: BatchReceivedAppliedDifference,
  resolution: BatchDifferenceResolutionFormState,
  roundingAccepted: boolean,
  cartInsuredKind: CartInsuredSummary["kind"],
): BatchDifferenceValidationResult {
  if (difference.kind === "exacto") return { valid: true, errorMessage: null };
  if (roundingAccepted && isRoundingAdjustmentEligible(difference.differenceCents)) {
    return { valid: true, errorMessage: null };
  }
  if (
    cartInsuredKind === "single" &&
    resolution.action == null &&
    isRoundingAdjustmentEligible(difference.differenceCents)
  ) {
    return {
      valid: false,
      errorMessage: difference.kind === "saldo_a_favor"
        ? "Elegí aceptar el ajuste por redondeo o registrar la diferencia como saldo a favor para confirmar el cobro."
        : "Elegí aceptar el ajuste por redondeo o registrar la diferencia como saldo deudor para confirmar el cobro.",
    };
  }
  return validateBatchDifferenceResolution(difference, resolution, cartInsuredKind);
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
  // Fase 2E: solo presente cuando SUM(splits) difiere de lo aplicado a las
  // cuotas — nunca se manda ni siquiera con valor null cuando no hay
  // diferencia (mismo criterio que el backend: "ni siquiera se mira si vino").
  accountDifferenceResolution?: AccountDifferenceResolutionPayload;
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
  accountDifferenceResolution?: AccountDifferenceResolutionPayload | null;
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
    ...(params.accountDifferenceResolution ? { accountDifferenceResolution: params.accountDifferenceResolution } : {}),
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
  // Fase 2G: dinero REAL recibido (ver receivedCentsOf) — nullable solo por
  // defensividad de tipos, igual que en PaymentBatchDetail.batch (Fase 2F).
  receivedAmountCents: number | null;
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

/**
 * Fase 2F: movimiento de cuenta corriente que este batch (o alguno de sus
 * hijos) originó por un sobrante/faltante (Fase 2B) — GET /payment-batches/:id
 * lo devuelve tal cual quedó en insured_account_movements, para que el
 * comprobante pueda mostrar la resolución real (tipo + motivo) en vez de
 * volver a inferirla solo por el signo de la diferencia.
 */
export interface BatchDetailAccountMovement {
  id: number;
  insuredId: number;
  type: string;
  signedAmountCents: number;
  status: string;
  reason: string | null;
}

/**
 * Fila de payment_amount_adjustments vinculada a este batch (GET
 * /payment-batches/:id, por paymentBatchId) — hoy exclusivamente la
 * tolerancia de redondeo (ver insured-account.ts,
 * MAX_ROUNDING_ADJUSTMENT_CENTS), pero el shape es el de la tabla completa,
 * sin asumir que todo registro futuro sea necesariamente un ajuste de
 * redondeo. A diferencia de BatchDetailAccountMovement, no tiene insuredId
 * ni status propio — "vigente" se resuelve leyendo batch.status (ver
 * summarizeBatchResolution/contributesToCaja más abajo), nunca con una
 * columna propia.
 */
export interface BatchDetailAmountAdjustment {
  id: number;
  paymentBatchId: number | null;
  amountCents: number;
  reason: string;
  authorizedBy: number;
  createdBy: number;
  createdAt: string;
}

export interface PaymentBatchDetail {
  batch: {
    id: number; insuredId: number | null; baseAmountCents: number; surchargeAmountCents: number;
    totalReceivedCents: number;
    // Fase 2B: dinero REAL recibido (SUM(splits) al momento de crear el
    // batch) — puede diferir de totalReceivedCents (aplicado/imputado, ver
    // comentario de cabecera del archivo). Nullable solo por defensividad de
    // tipos (la columna es nullable en el schema, aunque la Migración 0030
    // backfilleó el 100% de los batches históricos) — ver receivedCentsOf.
    receivedAmountCents: number | null;
    paymentDate: string; status: string; notes: string | null; createdAt: string;
    cancelledAt: string | null; cancellationReason: string | null;
  };
  insuredSummary: BatchInsuredSummary;
  items: PaymentBatchDetailItem[];
  splits: PaymentBatchDetailSplit[];
  surcharges: Array<{ id: number; amount: number }>;
  integrity: Record<string, unknown>;
  accountMovements: BatchDetailAccountMovement[];
  amountAdjustments: BatchDetailAmountAdjustment[];
}

// ─── Fase 2F — comprobante consistente con sobrantes/faltantes ─────────────
// batch.totalReceivedCents SIEMPRE fue (y sigue siendo) lo APLICADO/imputado
// a las cuotas — nunca dinero real por sí solo (nombre legacy, sin cambio de
// significado desde antes de Fase 2B). Mostrarlo bajo el label "Total
// recibido" es lo que generaba el riesgo: con un sobrante/faltante resuelto,
// el comprobante mentía sobre cuánto dinero real entró. receivedCentsOf +
// calculateBatchReceivedAppliedDifference (ya usado en el modal de creación,
// Fase 2E) son la única fuente para decidir qué mostrar acá — nunca se
// recalcula la diferencia de otra forma.

/**
 * Dinero real recibido de un batch, con fallback seguro para el caso
 * defensivo de un valor nulo (la columna es nullable en el schema, aunque la
 * Migración 0030 backfilleó el 100% de los batches históricos a
 * receivedAmountCents = totalReceivedCents — antes de esa migración ambos
 * eran siempre iguales por invariante, así que el fallback nunca inventa un
 * número: reproduce exactamente el valor que ya tenía ese batch).
 */
export function receivedCentsOf(batch: Pick<PaymentBatchDetail["batch"], "receivedAmountCents" | "totalReceivedCents">): number {
  return batch.receivedAmountCents ?? batch.totalReceivedCents;
}

export interface BatchDifferenceResolutionDisplay {
  action: "saldo_a_favor" | "saldo_deudor";
  reason: string | null;
  status: string;
}

/**
 * Busca, entre los accountMovements que devuelve GET /payment-batches/:id, el
 * que corresponde a la resolución del sobrante/faltante de ESTE batch (el
 * único tipo que accountDifferenceResolution puede crear hoy, ver POST
 * /payment-batches) — null si el batch nunca tuvo diferencia, o si por algún
 * motivo no se encontró (no debería pasar en un batch con diferencia real:
 * el backend siempre crea el movimiento en la misma transacción que el
 * batch). status="anulado" indica que el batch fue anulado después (Fase 2D)
 * y este movimiento se anuló junto con él — el comprobante debe indicarlo,
 * nunca mostrarlo como si siguiera vigente.
 */
export function findBatchDifferenceResolution(
  accountMovements: ReadonlyArray<BatchDetailAccountMovement>,
): BatchDifferenceResolutionDisplay | null {
  const movement = accountMovements.find((m) => m.type === "saldo_a_favor" || m.type === "saldo_deudor");
  if (!movement) return null;
  return { action: movement.type as "saldo_a_favor" | "saldo_deudor", reason: movement.reason, status: movement.status };
}

/**
 * Ajuste de redondeo (payment_amount_adjustments) ya listo para mostrar en
 * el detalle/comprobante — label trae el texto final ("Faltante por ajuste
 * de redondeo: $2,34" / "Sobrante por ajuste de redondeo: $5,00"), sin que
 * el componente tenga que reconstruir el signo. contributesToCaja refleja
 * batch.status en el momento de leer (=== "confirmado") — la fila histórica
 * de payment_amount_adjustments no tiene columna de estado propia, así que
 * "vigente" siempre se resuelve contra el batch dueño (mismo criterio que
 * calculatePaymentAmountAdjustmentCreditInCaja en insured-account.ts).
 */
export interface BatchRoundingAdjustmentDisplay {
  amountCents: number;
  reason: string;
  label: string;
  contributesToCaja: boolean;
}

export type BatchResolutionKind = "none" | "account_movement" | "rounding_adjustment" | "inconsistent_both";

/**
 * kind="inconsistent_both" es el único caso donde accountMovement Y
 * roundingAdjustment vienen los dos no-null a la vez — nunca debería ocurrir
 * por diseño (POST /payment-batches crea como máximo uno de los dos por
 * batch), pero si datos anómalos lo produjeran, este shape obliga al
 * componente a mostrar (o señalizar) ambos en vez de quedarse en silencio
 * con uno solo.
 */
export interface BatchResolutionSummary {
  kind: BatchResolutionKind;
  accountMovement: BatchDifferenceResolutionDisplay | null;
  roundingAdjustment: BatchRoundingAdjustmentDisplay | null;
}

/**
 * Combina accountMovements (saldo_a_favor/saldo_deudor, insured_account_
 * movements) y amountAdjustments (ajuste_redondeo, payment_amount_
 * adjustments) en una sola descripción de cómo se resolvió la diferencia de
 * ESTE batch. "sin resolución registrada" (kind="none") queda reservado
 * exclusivamente al caso en que NINGUNA de las dos tablas tiene una fila —
 * nunca se devuelve ese kind cuando amountAdjustments trae un ajuste válido.
 * Toma como máximo la primera fila de amountAdjustments (cardinalidad 0 o 1
 * en la práctica, ver POST /payment-batches) — un batch con más de una fila
 * sería en sí mismo un caso anómalo fuera del alcance de este helper.
 */
export function summarizeBatchResolution(
  accountMovements: ReadonlyArray<BatchDetailAccountMovement>,
  amountAdjustments: ReadonlyArray<BatchDetailAmountAdjustment>,
  batchStatus: string,
): BatchResolutionSummary {
  const accountMovement = findBatchDifferenceResolution(accountMovements);
  const adjustmentRow = amountAdjustments[0] ?? null;
  const roundingAdjustment: BatchRoundingAdjustmentDisplay | null = adjustmentRow ? {
    amountCents: adjustmentRow.amountCents,
    reason: adjustmentRow.reason,
    label: `${adjustmentRow.amountCents < 0 ? "Faltante" : "Sobrante"} por ajuste de redondeo: ${formatCurrencyCents(Math.abs(adjustmentRow.amountCents))}`,
    contributesToCaja: batchStatus === "confirmado",
  } : null;

  if (accountMovement && roundingAdjustment) return { kind: "inconsistent_both", accountMovement, roundingAdjustment };
  if (roundingAdjustment) return { kind: "rounding_adjustment", accountMovement: null, roundingAdjustment };
  if (accountMovement) return { kind: "account_movement", accountMovement, roundingAdjustment: null };
  return { kind: "none", accountMovement: null, roundingAdjustment: null };
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

/** Fase 2D: un insured_account_movement que este batch (o alguno de sus hijos) originó. */
export interface BatchCancelAccountMovement {
  id: number;
  type: string;
  signedAmountCents: number;
  status: string;
  insuredId: number;
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
  // Fase 2D: separado a propósito de `canCancel`/`blockingReasons` de arriba
  // (esos son sobre el ESTADO del batch/cheques/rendición) — esto es sobre la
  // seguridad de anular la cuenta corriente del asegurado (ver
  // isSafeToCancelAccountMovementOrigin, backend). Un batch puede tener
  // canCancel=true acá y aun así no ser anulable de verdad — ver
  // isBatchTrulyCancellable, que combina ambos.
  accountMovements: {
    canCancel: boolean;
    blockReasons: string[];
    items: BatchCancelAccountMovement[];
  };
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

/**
 * Fase 2D: un batch solo es REALMENTE anulable si ambos chequeos lo permiten
 * — el de estado (canCancel, cheques/rendición/carrera) Y el de cuenta
 * corriente (accountMovements.canCancel, ver isSafeToCancelAccountMovementOrigin
 * en el backend). Ninguno de los dos implica el otro.
 */
export function isBatchTrulyCancellable(check: PaymentBatchCancelCheckResponse): boolean {
  return check.canCancel && check.accountMovements.canCancel;
}

/** Todas las razones de bloqueo juntas (estado + cuenta corriente), para mostrar en un único listado. */
export function combinedCancelBlockingReasons(check: PaymentBatchCancelCheckResponse): string[] {
  return [...check.blockingReasons, ...check.accountMovements.blockReasons];
}

/** El botón final de "Anular cobro" (destructivo) exige el checkbox tildado Y que cancel-check haya dado luz verde en ambos chequeos. */
export function isCancelConfirmationValid(check: PaymentBatchCancelCheckResponse | null, checkboxConfirmed: boolean): boolean {
  return check != null && isBatchTrulyCancellable(check) && checkboxConfirmed;
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
