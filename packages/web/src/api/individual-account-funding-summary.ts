// Resumen de presentación de los pagos individuales con saldo (POST
// /payments/account-funded) para GET /payments. Sin escrituras. Recibe el
// cliente Drizzle inyectado (nunca importa la conexión global), mismo
// criterio que account-holder-funding-batch.ts.
//
// Identificación ESTRUCTURADA, nunca por texto libre: un lote es "pago
// individual" si y solo si tiene una fila en account_holder_funding_idempotency_keys
// con endpoint = ACCOUNT_FUNDED_PAYMENT_ENDPOINT (la escribe la misma
// transacción que crea el lote, ver runAccountHolderFundingBatch). Los
// importes salen de las filas reales: payment_batches (total cancelado /
// dinero real), insured_account_movements originados por el lote (saldo
// aplicado / deuda nueva / saldo a favor nuevo, cualquier estado — un cobro
// anulado sigue mostrando qué movió) y payment_amount_adjustments (redondeo).

import { and, eq, inArray } from "drizzle-orm";
import {
  accountHolderFundingIdempotencyKeys, paymentBatches, paymentBatchSplits, insuredAccountMovements,
  paymentAmountAdjustments, receivedChecks,
} from "./database/schema";
import { ACCOUNT_FUNDED_PAYMENT_ENDPOINT } from "../lib/payments/account-holder-funding-fingerprint";
import type { AccountHolderFundingDbClient } from "./account-holder-funding-batch";

export interface IndividualAccountFundingSummary {
  kind: "individual_account_funded";
  batchId: number;
  batchStatus: string;
  notes: string | null;
  /** Cuota + recargos cancelados (payment_batches.total_received_cents, lo aplicado). */
  totalCancelledCents: number;
  /** Dinero real ingresado (SUM de medios reales). */
  realReceivedCents: number;
  creditAppliedCents: number;
  newDebtCents: number;
  newCreditCents: number;
  roundingCoveredCents: number;
  splits: { method: string; amountCents: number; notes: string | null }[];
  hasChecks: boolean;
}

export async function loadIndividualAccountFundingSummaries(
  dbClient: AccountHolderFundingDbClient,
  batchIds: ReadonlyArray<number>
): Promise<Map<number, IndividualAccountFundingSummary>> {
  const result = new Map<number, IndividualAccountFundingSummary>();
  const ids = [...new Set(batchIds)];
  if (ids.length === 0) return result;

  const markerRows = await dbClient.select({ paymentBatchId: accountHolderFundingIdempotencyKeys.paymentBatchId })
    .from(accountHolderFundingIdempotencyKeys)
    .where(and(
      eq(accountHolderFundingIdempotencyKeys.endpoint, ACCOUNT_FUNDED_PAYMENT_ENDPOINT),
      inArray(accountHolderFundingIdempotencyKeys.paymentBatchId, ids),
    )).all();
  const individualIds = [...new Set((markerRows as any[]).map((r) => r.paymentBatchId as number))];
  if (individualIds.length === 0) return result;

  const batchRows = await dbClient.select().from(paymentBatches).where(inArray(paymentBatches.id, individualIds)).all();
  const splitRows = await dbClient.select().from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, individualIds)).all();
  const movementRows = await dbClient.select({
    originBatchId: insuredAccountMovements.originBatchId,
    type: insuredAccountMovements.type,
    signedAmountCents: insuredAccountMovements.signedAmountCents,
  }).from(insuredAccountMovements).where(inArray(insuredAccountMovements.originBatchId, individualIds)).all();
  const adjustmentRows = await dbClient.select({
    paymentBatchId: paymentAmountAdjustments.paymentBatchId,
    amountCents: paymentAmountAdjustments.amountCents,
  }).from(paymentAmountAdjustments).where(inArray(paymentAmountAdjustments.paymentBatchId, individualIds)).all();

  const splitIds = (splitRows as any[]).map((s) => s.id as number);
  const batchIdsWithChecks = new Set<number>();
  if (splitIds.length > 0) {
    const splitToBatch = new Map((splitRows as any[]).map((s) => [s.id as number, s.batchId as number]));
    const checkRows = await dbClient.select({ batchSplitId: receivedChecks.batchSplitId })
      .from(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).all();
    for (const chk of checkRows as any[]) {
      const bId = chk.batchSplitId != null ? splitToBatch.get(chk.batchSplitId as number) : undefined;
      if (bId != null) batchIdsWithChecks.add(bId);
    }
  }

  for (const b of batchRows as any[]) {
    const batchId = b.id as number;
    const movements = (movementRows as any[]).filter((m) => m.originBatchId === batchId);
    const sumAbs = (type: string) => movements.filter((m) => m.type === type).reduce((s, m) => s + Math.abs(m.signedAmountCents as number), 0);
    const roundingCoveredCents = (adjustmentRows as any[])
      .filter((a) => a.paymentBatchId === batchId && (a.amountCents as number) < 0)
      .reduce((s, a) => s + Math.abs(a.amountCents as number), 0);
    const splits = (splitRows as any[])
      .filter((s) => s.batchId === batchId)
      .sort((x, y) => (x.id as number) - (y.id as number))
      .map((s) => ({ method: s.method as string, amountCents: s.amountCents as number, notes: (s.notes as string | null) ?? null }));

    result.set(batchId, {
      kind: "individual_account_funded",
      batchId,
      batchStatus: b.status as string,
      notes: (b.notes as string | null) ?? null,
      totalCancelledCents: b.totalReceivedCents as number,
      realReceivedCents: (b.receivedAmountCents as number | null) ?? splits.reduce((s, x) => s + x.amountCents, 0),
      creditAppliedCents: sumAbs("aplicacion_saldo_favor"),
      newDebtCents: sumAbs("saldo_deudor"),
      newCreditCents: sumAbs("saldo_a_favor"),
      roundingCoveredCents,
      splits,
      hasChecks: batchIdsWithChecks.has(batchId),
    });
  }
  return result;
}
