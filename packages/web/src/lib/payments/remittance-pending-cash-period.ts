// Helper puro para GET /remittances/pending: agrupa cada cobro de contado por
// período (cash_period_payments, Migración 0034) en UN SOLO ítem rendible,
// source="payment_batch", en vez de exponer sus payments hijos por cuota.
//
// Por qué: cada hijo guarda el importe NOMINAL de su cuota y paymentMethod
// "contado" (la modalidad comercial, no un instrumento), y no tiene
// payment_splits propios — sus medios reales viven una sola vez en
// payment_batch_splits del lote. Listarlos tal cual mostraba N filas por el
// nominal, clasificadas como "propios" aunque el cobro hubiera entrado por
// transferencia a la compañía, y POST /remittances las rechaza una por una
// (el período solo se rinde entero, vía source="payment_batch").
//
// Un contado con datos inconsistentes (lote anulado, hijos rendidos a medias,
// importes que no cierran) nunca se oculta en silencio ni se ofrece como
// seleccionable: se devuelve bloqueado, con un código estable.
//
// Sin dependencias de DB — el endpoint arma CashPeriodPendingSource con sus
// propias queries. Ejecutar tests con:
// bun test packages/web/src/api/__tests__/remittance-pending-cash-period-helpers.test.ts

import { classifySplitGroup, type SplitGroup } from "./splits";

export const CASH_PERIOD_PENDING_CONCEPT = "Pago de contado";

export type CashPeriodPendingBlockedCode =
  | "CASH_PERIOD_STATE_MISMATCH"
  | "CASH_PERIOD_BATCH_NOT_CONFIRMED"
  | "CASH_PERIOD_NO_CHILDREN"
  | "CASH_PERIOD_CHILD_NOT_CONFIRMED"
  | "CASH_PERIOD_CHILDREN_PARTIALLY_RENDERED"
  | "CASH_PERIOD_AMOUNT_MISMATCH"
  | "CASH_PERIOD_SPLITS_MISMATCH";

export const CASH_PERIOD_PENDING_BLOCKED_MESSAGES: Record<CashPeriodPendingBlockedCode, string> = {
  CASH_PERIOD_STATE_MISMATCH:
    "El pago de contado figura anulado o ya rendido, pero tiene cuotas cobradas sin rendir. Revisalo antes de rendir.",
  CASH_PERIOD_BATCH_NOT_CONFIRMED:
    "El cobro del pago de contado no está confirmado. Revisalo antes de rendir.",
  CASH_PERIOD_NO_CHILDREN:
    "El pago de contado no tiene cuotas cobradas asociadas. Revisalo antes de rendir.",
  CASH_PERIOD_CHILD_NOT_CONFIRMED:
    "Alguna cuota del pago de contado no está confirmada. Revisalo antes de rendir.",
  CASH_PERIOD_CHILDREN_PARTIALLY_RENDERED:
    "Algunas cuotas del pago de contado ya figuran rendidas y otras no. Revisalo antes de rendir.",
  CASH_PERIOD_AMOUNT_MISMATCH:
    "El importe del cobro no coincide con el importe de contado registrado. Revisalo antes de rendir.",
  CASH_PERIOD_SPLITS_MISMATCH:
    "Los medios de pago del cobro no coinciden con el dinero recibido. Revisalo antes de rendir.",
};

export interface CashPeriodPendingSplit {
  method: string;
  amountCents: number;
  notes: string | null;
  /** received_checks reales del split (solo relevantes si method === "cheque"). */
  checks: ReadonlyArray<{ amountCents: number }>;
}

export interface CashPeriodPendingChild {
  paymentId: number;
  status: string; // confirmado | pendiente | anulado
  rendered: number; // 0 | 1
}

export interface CashPeriodPendingSource {
  paymentBatchId: number;
  cashPeriodPaymentId: number;
  status: string; // cash_period_payments.status: confirmado | anulado
  rendered: number; // cash_period_payments.rendered
  policyId: number;
  rebillingId: number | null;
  nominalAmountCents: number;
  cashAmountCents: number;
  discountAmountCents: number;
  /** null si el payment_batches no existe (integridad rota). */
  batch: {
    status: string;
    paymentDate: string;
    /** Aplicado — siempre el contado contractual; es lo que POST /remittances exige como importe del ítem. */
    totalReceivedCents: number;
    /** Dinero real recibido (SUM(splits)); NULL solo en filas sin backfill de la Migración 0030. */
    receivedAmountCents: number | null;
    notes: string | null;
  } | null;
  splits: ReadonlyArray<CashPeriodPendingSplit>;
  /** Solo las cuotas de ESTE contado (payments.cash_period_payment_id, Migración 0037). */
  children: ReadonlyArray<CashPeriodPendingChild>;
  /**
   * Migración 0037: true si el lote también tiene otros hijos (cuotas comunes
   * de otras pólizas). Sus medios reales pagan todo el lote, así que no se
   * comparan contra el contado ni se rinden con él: el contado se rinde como
   * una partida por su importe de contado, con el medio de rendición elegido
   * (igual que cualquier hijo de lote, Migración 0029).
   */
  mixedBatch: boolean;
  policyNumber: string | null;
  insuredName: string | null;
  companyName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface CashPeriodPendingItem {
  source: "payment_batch";
  sourceId: number;
  paymentBatchId: number;
  amount: number;
  paymentMethod: string;
  paymentDate: string | null;
  dueDate: null;
  clientName: string;
  policyNumber: string;
  companyName: string;
  notes: string | null;
  hasSurcharge: false;
  splits: Array<{ method: string; amountCents: number; notes: string | null }>;
  paymentGroup: SplitGroup;
  isCashPeriodPayment: true;
  concept: string;
  cashPeriodPayment: {
    id: number;
    policyId: number;
    rebillingId: number | null;
    periodStart: string | null;
    periodEnd: string | null;
    installmentCount: number;
    nominalAmountCents: number;
    discountAmountCents: number;
    cashAmountCents: number;
    receivedAmountCents: number | null;
    hasChecks: boolean;
    /** Lote mixto (Migración 0037): se rinde con el medio elegido, no con los medios del lote. */
    mixedBatch: boolean;
  };
  blocked: boolean;
  blockedCode: CashPeriodPendingBlockedCode | null;
  blockedReason: string | null;
}

export type CashPeriodPendingDecision =
  | { kind: "offer" }
  | { kind: "hide" }
  | { kind: "blocked"; code: CashPeriodPendingBlockedCode };

/**
 * Decide si un contado se ofrece para rendir, se omite (anulado o ya rendido,
 * de forma consistente) o se muestra bloqueado por una inconsistencia. Los
 * chequeos replican lo que POST /remittances va a exigir al rendirlo, para
 * que nunca se ofrezca como seleccionable algo que después se rechaza.
 */
export function decideCashPeriodPending(src: CashPeriodPendingSource): CashPeriodPendingDecision {
  const pendingChildren = src.children.filter((c) => c.status === "confirmado" && c.rendered === 0);

  // Anulado o ya rendido: no se ofrece. Pero si alguna cuota quedó cobrada
  // sin rendir, el estado del contado y el de sus hijos no coinciden.
  if (src.status !== "confirmado" || src.rendered !== 0) {
    return pendingChildren.length > 0 ? { kind: "blocked", code: "CASH_PERIOD_STATE_MISMATCH" } : { kind: "hide" };
  }

  if (!src.batch || src.batch.status !== "confirmado") return { kind: "blocked", code: "CASH_PERIOD_BATCH_NOT_CONFIRMED" };
  if (src.children.length === 0) return { kind: "blocked", code: "CASH_PERIOD_NO_CHILDREN" };
  if (src.children.some((c) => c.status !== "confirmado")) return { kind: "blocked", code: "CASH_PERIOD_CHILD_NOT_CONFIRMED" };
  if (src.children.some((c) => c.rendered !== 0)) return { kind: "blocked", code: "CASH_PERIOD_CHILDREN_PARTIALLY_RENDERED" };

  // Lote mixto (Migración 0037): el lote paga además otras cuotas, así que su
  // total y sus medios nunca coinciden con el contado — y no tienen por qué:
  // POST /remittances rinde el contado por su importe de contado con el medio
  // de rendición elegido, sin consumir los medios del lote. El alta del lote
  // ya exigió recibido = imputado.
  if (src.mixedBatch) return { kind: "offer" };

  // POST /remittances exige importe declarado === payment_batches.total_received_cents.
  if (src.batch.totalReceivedCents !== src.cashAmountCents) return { kind: "blocked", code: "CASH_PERIOD_AMOUNT_MISMATCH" };

  // POST /remittances valida las allocations (splits/cheques reales) contra
  // el dinero real recibido — received_amount_cents, o total_received_cents
  // solo si received es NULL (nunca por truthiness: 0 es un valor).
  const expectedRealCents = src.batch.receivedAmountCents ?? src.batch.totalReceivedCents;
  if (src.splits.length === 0) return { kind: "blocked", code: "CASH_PERIOD_SPLITS_MISMATCH" };
  const splitsTotalCents = src.splits.reduce((s, sp) => s + sp.amountCents, 0);
  if (splitsTotalCents !== expectedRealCents) return { kind: "blocked", code: "CASH_PERIOD_SPLITS_MISMATCH" };
  for (const sp of src.splits) {
    if (sp.method !== "cheque") continue;
    const checksCents = sp.checks.reduce((s, c) => s + c.amountCents, 0);
    if (sp.checks.length === 0 || checksCents !== sp.amountCents) return { kind: "blocked", code: "CASH_PERIOD_SPLITS_MISMATCH" };
  }

  return { kind: "offer" };
}

/** Ítem de GET /remittances/pending para un contado, o null si no debe listarse. */
export function buildCashPeriodPendingItem(src: CashPeriodPendingSource): CashPeriodPendingItem | null {
  const decision = decideCashPeriodPending(src);
  if (decision.kind === "hide") return null;

  const batchSplits = src.splits.map((s) => ({ method: s.method, amountCents: s.amountCents, notes: s.notes }));
  // Lote mixto: los medios del lote no son "del contado" — no se exponen como
  // tales (el grupo propio/directo sí: un lote nunca mezcla grupos).
  const splits = src.mixedBatch ? [] : batchSplits;
  const blockedCode = decision.kind === "blocked" ? decision.code : null;
  return {
    source: "payment_batch",
    sourceId: src.paymentBatchId,
    paymentBatchId: src.paymentBatchId,
    // Exactamente lo que POST /remittances acepta como importe del ítem: el
    // total del lote si es un contado puro (histórico), el contado si es mixto.
    amount: (src.mixedBatch ? src.cashAmountCents : (src.batch?.totalReceivedCents ?? src.cashAmountCents)) / 100,
    // Medio REAL del lote, nunca el literal "contado" de los hijos. En un
    // lote mixto, "lote": el medio de rendición se elige al rendir.
    paymentMethod: src.mixedBatch ? "lote" : splits.length === 1 ? splits[0]!.method : splits.length > 1 ? "combinado" : "contado",
    paymentDate: src.batch?.paymentDate ?? null,
    dueDate: null,
    clientName: src.insuredName || "—",
    policyNumber: src.policyNumber || "—",
    companyName: src.companyName || "—",
    notes: src.batch?.notes ?? null,
    hasSurcharge: false,
    splits,
    paymentGroup: classifySplitGroup(batchSplits),
    isCashPeriodPayment: true,
    concept: CASH_PERIOD_PENDING_CONCEPT,
    cashPeriodPayment: {
      id: src.cashPeriodPaymentId,
      policyId: src.policyId,
      rebillingId: src.rebillingId,
      periodStart: src.periodStart,
      periodEnd: src.periodEnd,
      installmentCount: src.children.length,
      nominalAmountCents: src.nominalAmountCents,
      discountAmountCents: src.discountAmountCents,
      cashAmountCents: src.cashAmountCents,
      receivedAmountCents: src.mixedBatch ? src.cashAmountCents : (src.batch?.receivedAmountCents ?? null),
      hasChecks: !src.mixedBatch && src.splits.some((s) => s.method === "cheque" && s.checks.length > 0),
      mixedBatch: src.mixedBatch,
    },
    blocked: blockedCode !== null,
    blockedCode,
    blockedReason: blockedCode !== null ? CASH_PERIOD_PENDING_BLOCKED_MESSAGES[blockedCode] : null,
  };
}

/**
 * Pagos individuales que siguen listándose tal cual: todos menos las cuotas
 * de un contado (payments.cash_period_payment_id, Migración 0037). Los lotes
 * normales, los pagos standalone y las cuotas comunes de un lote mixto no
 * cambian.
 */
export function excludeCashPeriodChildren<T extends { cashPeriodPaymentId: number | null }>(
  pendingPayments: ReadonlyArray<T>,
): T[] {
  return pendingPayments.filter((p) => p.cashPeriodPaymentId == null);
}
