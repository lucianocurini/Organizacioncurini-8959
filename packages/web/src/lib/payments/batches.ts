// Helpers puros de payment_batches (Etapa 4A) — cobros que imputan varias
// cuotas del mismo asegurado en un solo evento de cobro real (ej. un cheque
// que cubre varias cuotas juntas). Sin DB, sin efectos secundarios — reciben
// datos ya resueltos por el endpoint (que sí consulta la base) y devuelven
// resultados explícitos, mismo estilo que src/lib/payments/splits.ts y
// src/lib/installments/plan.ts.
//
// Reutiliza isMultipleOfCent/isAllowedPaymentMethod/classifySplitGroup de
// splits.ts — un solo criterio de "importe válido"/"método permitido"/"grupo"
// para pagos individuales y para batches, sin dos fuentes de verdad.
//
// IMPORTANTE: el backend nunca debe confiar en insuredId, importe, compañía
// ni estado que mande el frontend — todo eso se relee de la base en el
// endpoint (POST /api/payment-batches) y se le pasa YA resuelto a estos
// helpers. Estos helpers solo validan consistencia sobre datos que el
// endpoint garantiza que vinieron de la base, no del body crudo.

import { isMultipleOfCent, isAllowedPaymentMethod, classifySplitGroup, type SplitGroup } from "./splits";

export class PaymentBatchValidationError extends Error {}

// Mismo texto que ya usan POST/PUT /payments (Etapa 3B) para rechazar mixed
// — una sola redacción visible al usuario para el mismo tipo de error.
export const BATCH_MIXED_GROUP_ERROR =
  "No se pueden combinar medios propios con pagos directos a la compañía en un mismo cobro.";

// ─── Ítems del batch (cuotas imputadas) ───────────────────────────────────────

export interface PaymentBatchItemInput {
  installmentId: number;
}

export interface NormalizedPaymentBatchItem {
  installmentId: number;
}

/**
 * Valida la forma del array de ítems tal cual llega del body: al menos uno,
 * IDs válidos, sin installmentId repetido dentro del mismo cobro. No conoce
 * (ni puede conocer, es puro) si la cuota existe realmente, su estado, ni a
 * qué asegurado pertenece — eso lo valida el endpoint con datos reales via
 * validateSameInsured/validateInstallmentsEligibility más abajo.
 */
export function normalizeBatchItems(items: PaymentBatchItemInput[]): NormalizedPaymentBatchItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PaymentBatchValidationError("Debe indicarse al menos una cuota.");
  }
  const seen = new Set<number>();
  const normalized: NormalizedPaymentBatchItem[] = [];
  for (const raw of items) {
    const installmentId = Number(raw?.installmentId);
    if (!Number.isFinite(installmentId) || installmentId <= 0) {
      throw new PaymentBatchValidationError(`ID de cuota inválido: ${raw?.installmentId}.`);
    }
    if (seen.has(installmentId)) {
      throw new PaymentBatchValidationError(`La cuota ${installmentId} está repetida en el mismo cobro.`);
    }
    seen.add(installmentId);
    normalized.push({ installmentId });
  }
  return normalized;
}

/** Cuota ya resuelta desde la base — la fuente real de insuredId/amount/estado. */
export interface BatchInstallmentContext {
  installmentId: number;
  policyId: number;
  insuredId: number;
  amount: number; // importe de la cuota (pesos, no centavos) — payments.amount del hijo
  installmentStatus: string; // pendiente | pagada | vencida
  policyStatus: string; // activa | vencida | cancelada | por_vencer
  isRivadavia: boolean;
}

/**
 * Todas las cuotas de un mismo cobro deben pertenecer al mismo asegurado real
 * (mismo insuredId, sin intentar adivinar por nombre/DNI — ver diagnóstico).
 */
export function validateSameInsured(installments: BatchInstallmentContext[]): void {
  if (installments.length === 0) return;
  const first = installments[0]!.insuredId;
  const mismatched = installments.find((i) => i.insuredId !== first);
  if (mismatched) {
    throw new PaymentBatchValidationError(
      `Todas las cuotas del cobro deben pertenecer al mismo asegurado. La cuota ${mismatched.installmentId} pertenece a otro asegurado.`
    );
  }
}

/**
 * Cada cuota debe estar pendiente o vencida (nunca "pagada" — evita duplicar
 * el cobro) y su póliza no puede estar cancelada. Sin pagos parciales: el
 * importe imputado es siempre installment.amount completo — el payload nunca
 * manda un importe por cuota (ver POST /api/payment-batches), así que un
 * pago parcial no puede solicitarse por construcción.
 */
export function validateInstallmentsEligibility(installments: BatchInstallmentContext[]): void {
  for (const i of installments) {
    if (i.installmentStatus === "pagada") {
      throw new PaymentBatchValidationError(`La cuota ${i.installmentId} ya está pagada.`);
    }
    if (i.policyStatus === "cancelada") {
      throw new PaymentBatchValidationError(`La cuota ${i.installmentId} pertenece a una póliza cancelada.`);
    }
  }
}

/** SUM(installment.amount) de todas las cuotas del cobro, en centavos. */
export function calculateBaseAmountCents(installments: BatchInstallmentContext[]): number {
  return installments.reduce((sum, i) => sum + Math.round(i.amount * 100), 0);
}

// ─── Medios de pago del batch ─────────────────────────────────────────────────

export interface PaymentBatchSplitInput {
  method: string;
  amount: number;
  notes?: string | null;
}

export interface NormalizedPaymentBatchSplit {
  method: string;
  amountCents: number;
  notes: string | null;
}

/**
 * Valida cada fila de medios tal cual llega del body: método permitido
 * (nunca "lote" ni "combinado" — esos son valores de resumen, no medios
 * reales; isAllowedPaymentMethod ya los excluye, mismo criterio que 3B),
 * importe > 0, máximo dos decimales reales. NO valida acá que la suma
 * coincida con el total — eso recién se puede hacer después de calcular
 * baseAmountCents+surchargeAmountCents (ver validateBatchTotals), porque acá
 * todavía no se conoce el total del cobro.
 */
export function normalizeBatchSplits(splits: PaymentBatchSplitInput[]): NormalizedPaymentBatchSplit[] {
  if (!Array.isArray(splits) || splits.length === 0) {
    throw new PaymentBatchValidationError("Debe indicarse al menos un medio de pago.");
  }
  return splits.map((s, i) => {
    const label = `medio ${i + 1}`;
    const method = typeof s?.method === "string" ? s.method.trim() : "";
    if (!method) {
      throw new PaymentBatchValidationError(`El método del ${label} no puede estar vacío.`);
    }
    if (!isAllowedPaymentMethod(method)) {
      throw new PaymentBatchValidationError(`Método no permitido en el ${label}: "${method}".`);
    }
    const amount = Number(s.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new PaymentBatchValidationError(`El importe del ${label} (${method}) debe ser un número mayor a cero.`);
    }
    if (!isMultipleOfCent(amount)) {
      throw new PaymentBatchValidationError(`El importe del ${label} (${method}) no puede tener más de dos decimales: ${s.amount}.`);
    }
    return {
      method, amountCents: Math.round(amount * 100),
      notes: typeof s.notes === "string" && s.notes.trim() ? s.notes.trim() : null,
    };
  });
}

/**
 * Clasifica el grupo (own/direct_company) de los medios ya normalizados y
 * rechaza "mixed" de inmediato — mismo criterio que 3B, antes de cualquier
 * escritura.
 */
export function resolveBatchSplitGroup(splits: NormalizedPaymentBatchSplit[]): SplitGroup {
  const group = classifySplitGroup(splits);
  if (group === "mixed") {
    throw new PaymentBatchValidationError(BATCH_MIXED_GROUP_ERROR);
  }
  return group;
}

// ─── Pronto Pago ──────────────────────────────────────────────────────────────

/**
 * $800 por cada cuota Rivadavia elegible — nunca por recibo ni por póliza.
 * Solo aplica si TODOS los medios del batch son del grupo "own" (mixed ya se
 * rechazó antes de llegar acá). Devuelve los installmentId concretos que
 * generan recargo, para que el endpoint sepa a qué payment hijo atarle cada
 * cash_entry — nunca una cantidad suelta sin saber de qué cuota viene.
 */
export function calculateApplicableRivadaviaSurcharges(
  installments: BatchInstallmentContext[],
  splitGroup: SplitGroup
): number[] {
  if (splitGroup !== "own") return [];
  return installments.filter((i) => i.isRivadavia).map((i) => i.installmentId);
}

export const SURCHARGE_AMOUNT_CENTS = 80000; // $800, mismo monto fijo que Etapa 3B

// ─── Totales ──────────────────────────────────────────────────────────────────

export interface PaymentBatchTotals {
  baseAmountCents: number;
  surchargeAmountCents: number;
  totalReceivedCents: number;
}

/** totalReceivedCents = baseAmountCents + surchargeAmountCents, en un solo lugar. */
export function calculateBatchTotals(baseAmountCents: number, surchargeAmountCents: number): PaymentBatchTotals {
  return { baseAmountCents, surchargeAmountCents, totalReceivedCents: baseAmountCents + surchargeAmountCents };
}

export interface PaymentBatchValidationResult {
  valid: boolean;
  errorMessage: string | null;
}

/**
 * La única validación que NO está garantizada por construcción: que lo que
 * la persona cargó como medios (splits) efectivamente sume el total a
 * recibir (base + recargos). No se decompone el instrumento — no se intenta
 * saber "cuánto del cheque es recargo", solo que el total cierre exacto.
 */
export function validateBatchTotals(
  totals: PaymentBatchTotals,
  splits: NormalizedPaymentBatchSplit[]
): PaymentBatchValidationResult {
  const distributedCents = splits.reduce((sum, s) => sum + s.amountCents, 0);
  if (distributedCents !== totals.totalReceivedCents) {
    return {
      valid: false,
      errorMessage:
        `La suma de los medios ($${(distributedCents / 100).toFixed(2)}) no coincide con el total a recibir ` +
        `($${(totals.totalReceivedCents / 100).toFixed(2)} = base $${(totals.baseAmountCents / 100).toFixed(2)} ` +
        `+ recargos $${(totals.surchargeAmountCents / 100).toFixed(2)}).`,
    };
  }
  return { valid: true, errorMessage: null };
}

// ─── Estado del batch ─────────────────────────────────────────────────────────

export type PaymentBatchStatus = "confirmado" | "anulado";

const VALID_BATCH_TRANSITIONS: Record<PaymentBatchStatus, PaymentBatchStatus[]> = {
  confirmado: ["anulado"],
  anulado: [], // terminal — no hay vuelta atrás
};

/**
 * confirmado → anulado es la única transición permitida (anular el batch
 * completo, ver diagnóstico de la vuelta anterior). anulado es terminal. No
 * se usa todavía en 4A (no hay PUT/DELETE de batch), pero queda disponible y
 * testeada para cuando se implemente.
 */
export function validateBatchStatusTransition(current: PaymentBatchStatus, next: PaymentBatchStatus): void {
  const allowed = VALID_BATCH_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new PaymentBatchValidationError(`No se puede pasar un batch de "${current}" a "${next}".`);
  }
}
