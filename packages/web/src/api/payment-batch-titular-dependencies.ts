// Construcción de destinations/realSplits/dependencies del modo titular de
// POST /payment-batches — Etapa 1B-3-E. Extraído para que index.ts y los
// tests de integración ejecuten EXACTAMENTE el mismo cableado (nunca dos
// versiones que puedan divergir).
//
// Las keys opacas ("payment-{idx}", "pronto_pago-{idx}", "split-{i}") se
// construyen UNA sola vez acá y se reusan idénticas tanto en `destinations`/
// `realSplits` (entrada del plan) como dentro de `createChildRows` (mapeo de
// vuelta id real -> key) — nunca se recalculan por separado, evita cualquier
// desalineación entre ambos lados.

import {
  insertPaymentBatchRow, checkInstallmentPaymentRace, insertBatchSplitsAndChecks, insertBatchChildren,
  type SplitWithChecksForInsert, type BatchChildContextForInsert,
} from "./payment-batch-shared-inserts";
import type { AccountHolderFundingBatchDependencies } from "./account-holder-funding-batch";
import type { FundingDestinationInput } from "../lib/payments/account-holder-funding";
import type { FundingPlanSplitInput } from "../lib/payments/account-holder-funding-plan";
import type { BatchItemContext } from "../lib/payments/batches";
import { SURCHARGE_AMOUNT_CENTS } from "../lib/payments/batches";

export interface BuildTitularFundingInputParams {
  contexts: ReadonlyArray<BatchItemContext>;
  displays: ReadonlyArray<{ insuredName: string | null; policyNumber: string | null; companyName: string | null }>;
  /** Mismo criterio que calculateApplicableRivadaviaSurcharges — conjunto de contextos concretos (identidad de objeto) que generan recargo. */
  applicableSurchargeContexts: ReadonlySet<BatchItemContext>;
  splitsWithChecks: ReadonlyArray<SplitWithChecksForInsert>;
}

export interface BuildTitularFundingInputResult {
  destinations: FundingDestinationInput[];
  realSplits: FundingPlanSplitInput[];
  childInsertItems: BatchChildContextForInsert[];
}

/** Construye destinations/realSplits/childInsertItems con keys opacas consistentes — sin tocar DB. */
export function buildTitularFundingInput(params: BuildTitularFundingInputParams): BuildTitularFundingInputResult {
  const destinations: FundingDestinationInput[] = [];
  params.contexts.forEach((ctxItem, idx) => {
    destinations.push({ id: `payment-${idx}`, kind: "payment", nominalCents: Math.round(ctxItem.amount * 100) });
    if (params.applicableSurchargeContexts.has(ctxItem)) {
      destinations.push({ id: `pronto_pago-${idx}`, kind: "pronto_pago", nominalCents: SURCHARGE_AMOUNT_CENTS });
    }
  });
  const realSplits: FundingPlanSplitInput[] = params.splitsWithChecks.map((swc, i) => ({ id: `split-${i}`, amountCents: swc.split.amountCents }));
  const childInsertItems: BatchChildContextForInsert[] = params.contexts.map((ctxItem, idx) => ({
    ctxItem, display: params.displays[idx]!, hasSurcharge: params.applicableSurchargeContexts.has(ctxItem),
  }));
  return { destinations, realSplits, childInsertItems };
}

export interface BuildTitularFundingDependenciesParams {
  derivedInsuredId: number | null;
  baseAmountCents: number;
  surchargeAmountCents: number;
  totalReceivedCents: number;
  receivedCents: number;
  paymentDate: string;
  notes: string | null;
  createdBy: number;
  accountHolderInsuredId: number;
  installmentIds: ReadonlyArray<number>;
  splitsWithChecks: ReadonlyArray<SplitWithChecksForInsert>;
  childInsertItems: ReadonlyArray<BatchChildContextForInsert>;
}

/**
 * Arma las 3 dependencias que runAccountHolderFundingBatch necesita —
 * reusando SIEMPRE payment-batch-shared-inserts.ts (nunca una segunda
 * versión de los inserts). createChildRows re-chequea la carrera de cuotas
 * en el mismo punto relativo que el camino legacy (recién insertado el
 * batch, antes de splits/hijos).
 */
export function buildTitularFundingDependencies(params: BuildTitularFundingDependenciesParams): AccountHolderFundingBatchDependencies {
  return {
    createBatch: (tx) => insertPaymentBatchRow(tx, {
      insuredId: params.derivedInsuredId,
      baseAmountCents: params.baseAmountCents,
      surchargeAmountCents: params.surchargeAmountCents,
      totalReceivedCents: params.totalReceivedCents,
      receivedAmountCents: params.receivedCents,
      paymentDate: params.paymentDate,
      notes: params.notes,
      createdBy: params.createdBy,
      accountHolderInsuredId: params.accountHolderInsuredId,
    }),
    createChildRows: async (tx, batch) => {
      await checkInstallmentPaymentRace(tx, params.installmentIds);

      const splitIds = await insertBatchSplitsAndChecks(tx, batch.id, params.splitsWithChecks, params.createdBy);
      const splitIdByKey = new Map<string, number>(splitIds.map((id, i) => [`split-${i}`, id]));

      const { childIds, cashEntryIdByIndex } = await insertBatchChildren(tx, batch.id, params.childInsertItems, params.paymentDate, params.createdBy);
      const paymentIdByKey = new Map<string, number>(childIds.map((id, idx) => [`payment-${idx}`, id]));
      const cashEntryIdByKey = new Map<string, number>([...cashEntryIdByIndex].map(([idx, id]) => [`pronto_pago-${idx}`, id]));

      return { splitIdByKey, paymentIdByKey, cashEntryIdByKey };
    },
    buildResponseSnapshot: async (_tx, ctx) => ({
      responseStatus: 201,
      responseSnapshot: JSON.stringify({ id: ctx.batch.id }),
    }),
  };
}
