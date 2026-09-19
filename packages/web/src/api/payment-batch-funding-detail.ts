// Lectura de la financiación persistida de un batch con titular de cuenta,
// para el detalle/comprobante (GET /payment-batches/:id). Sin escrituras.
// Devuelve las filas de payment_batch_funding_allocations tal cual están
// guardadas — el desglose (medios reales / crédito / redondeo / deuda /
// saldo nuevo) lo arma el frontend a partir de estas filas y de
// accountMovements (payment-batch-titular-detail.ts), nunca desde el
// formulario ni desde texto.

import { asc, eq } from "drizzle-orm";
import { insureds, paymentBatchFundingAllocations } from "./database/schema";
import type { AccountHolderFundingDbClient } from "./account-holder-funding-batch";

export interface BatchFundingAllocationRow {
  id: number;
  paymentBatchSplitId: number | null;
  sourceAccountMovementId: number | null;
  paymentAmountAdjustmentId: number | null;
  paymentId: number | null;
  cashEntryId: number | null;
  destinationAccountMovementId: number | null;
  amountCents: number;
}

export interface BatchFundingDetail {
  accountHolder: { id: number; name: string } | null;
  fundingAllocations: BatchFundingAllocationRow[];
}

/** accountHolderInsuredId null (batch legacy) -> sin titular y sin allocations; nunca consulta la tabla de allocations en ese caso. */
export async function loadBatchFundingDetail(
  dbClient: AccountHolderFundingDbClient,
  batchId: number,
  accountHolderInsuredId: number | null,
): Promise<BatchFundingDetail> {
  if (accountHolderInsuredId == null) return { accountHolder: null, fundingAllocations: [] };

  const holderRow = await dbClient.select({ id: insureds.id, name: insureds.name })
    .from(insureds).where(eq(insureds.id, accountHolderInsuredId)).get();

  const fundingAllocations = await dbClient.select({
    id: paymentBatchFundingAllocations.id,
    paymentBatchSplitId: paymentBatchFundingAllocations.paymentBatchSplitId,
    sourceAccountMovementId: paymentBatchFundingAllocations.sourceAccountMovementId,
    paymentAmountAdjustmentId: paymentBatchFundingAllocations.paymentAmountAdjustmentId,
    paymentId: paymentBatchFundingAllocations.paymentId,
    cashEntryId: paymentBatchFundingAllocations.cashEntryId,
    destinationAccountMovementId: paymentBatchFundingAllocations.destinationAccountMovementId,
    amountCents: paymentBatchFundingAllocations.amountCents,
  }).from(paymentBatchFundingAllocations)
    .where(eq(paymentBatchFundingAllocations.paymentBatchId, batchId))
    .orderBy(asc(paymentBatchFundingAllocations.id)).all();

  return { accountHolder: holderRow ? { id: holderRow.id, name: holderRow.name } : null, fundingAllocations };
}
