// Inserts compartidos entre el camino legacy y el modo titular de
// POST /payment-batches — Etapa 1B-3-E. Extraídos TAL CUAL del flujo legacy
// preexistente (mismos inserts, mismo orden, mismos valores) — ninguna regla
// económica nueva, ningún comportamiento distinto según el modo. Vive en
// src/api/ porque toca DB (recibe siempre `tx` ya resuelto por el caller,
// nunca abre su propia transacción ni importa la conexión global — mismo
// criterio que account-holder-funding-batch.ts).
//
// Por qué existe este archivo: para que el modo titular (que orquesta su
// transacción vía runAccountHolderFundingBatch, con callbacks createBatch/
// createChildRows) y el camino legacy (transacción inline en index.ts)
// ejecuten EXACTAMENTE el mismo código de inserción — nunca dos versiones
// que puedan divergir con el tiempo. También permite testear estos inserts
// contra una base SQLite temporal aislada sin pasar por index.ts/
// database/index.ts (que abriría la conexión real).

import { eq, and, inArray } from "drizzle-orm";
import { paymentBatches, paymentBatchSplits, receivedChecks, payments, cashEntries } from "./database/schema";
import { recalculateInstallmentPaymentStatus } from "../lib/payments/installment-status";
import { SURCHARGE_AMOUNT_CENTS, type NormalizedPaymentBatchSplit, type BatchItemContext } from "../lib/payments/batches";
import type { NormalizedReceivedCheck } from "../lib/payments/received-checks";
import type { AccountHolderFundingDbClient } from "./account-holder-funding-batch";
import type { BatchSnapshot } from "../lib/payments/account-holder-funding-allocations";

/**
 * Mismo mensaje/forma que la clase histórica homónima que vivía en index.ts
 * (movida acá para que el modo titular pueda reaccionar al mismo tipo de
 * error sin duplicar la clase) — ver comentario extenso de "LÍMITE CONOCIDO"
 * en index.ts, POST /payment-batches, sobre por qué este re-chequeo dentro
 * de la transacción sigue siendo necesario y no es una garantía formal.
 */
export class PaymentBatchRaceConditionError extends Error {
  constructor(public installmentIds: number[]) {
    super(`Otra solicitud ya cobró la(s) cuota(s) ${installmentIds.join(", ")} mientras se procesaba este pedido.`);
  }
}

// ─── 1. payment_batches ──────────────────────────────────────────────────

export interface InsertPaymentBatchRowParams {
  insuredId: number | null;
  baseAmountCents: number;
  surchargeAmountCents: number;
  totalReceivedCents: number;
  /** Fase 2B: dinero real recibido — SIEMPRE SUM(splits), sin excepción, legacy o titular. */
  receivedAmountCents: number;
  paymentDate: string;
  notes: string | null;
  createdBy: number;
  /** undefined/null -> batch legacy (sin titular). Positivo -> batch del modo titular. */
  accountHolderInsuredId?: number | null;
}

/** Primera escritura real de la transacción — idéntico en legacy y en modo titular, solo cambia si accountHolderInsuredId viene seteado. */
export async function insertPaymentBatchRow(
  tx: AccountHolderFundingDbClient,
  params: InsertPaymentBatchRowParams
): Promise<BatchSnapshot> {
  const [batch] = await tx.insert(paymentBatches).values({
    insuredId: params.insuredId,
    baseAmountCents: params.baseAmountCents,
    surchargeAmountCents: params.surchargeAmountCents,
    totalReceivedCents: params.totalReceivedCents,
    receivedAmountCents: params.receivedAmountCents,
    paymentDate: params.paymentDate,
    status: "confirmado",
    notes: params.notes,
    createdBy: params.createdBy,
    accountHolderInsuredId: params.accountHolderInsuredId ?? null,
  }).returning();
  return {
    id: batch!.id as number,
    status: batch!.status as "confirmado" | "anulado",
    accountHolderInsuredId: (batch!.accountHolderInsuredId as number | null | undefined) ?? null,
  };
}

// ─── 2. Re-chequeo de carrera, ya en modo escritura ─────────────────────────

/**
 * Mismo re-chequeo que ya hacía el flujo legacy justo después de insertar el
 * batch (antes de escribir splits/hijos) — si otra request confirmó un pago
 * para alguna de estas cuotas entre la validación inicial (fuera de la
 * transacción) y este punto, aborta acá. El caller (transacción externa,
 * legacy inline o el db.transaction de runAccountHolderFundingBatch) hace el
 * rollback completo, incluido el insert del batch recién hecho.
 */
export async function checkInstallmentPaymentRace(
  tx: AccountHolderFundingDbClient,
  installmentIds: ReadonlyArray<number>
): Promise<void> {
  if (installmentIds.length === 0) return;
  const raceCheck = await tx.select({ installmentId: payments.installmentId })
    .from(payments)
    .where(and(inArray(payments.installmentId, installmentIds), eq(payments.status, "confirmado")))
    .all();
  if (raceCheck.length > 0) {
    throw new PaymentBatchRaceConditionError((raceCheck as any[]).map((p) => p.installmentId as number));
  }
}

// ─── 3. payment_batch_splits + received_checks ──────────────────────────────

export interface SplitWithChecksForInsert {
  split: NormalizedPaymentBatchSplit;
  checks: ReadonlyArray<NormalizedReceivedCheck>;
}

/**
 * Splits uno por uno (no bulk) porque cada split cheque necesita su propio
 * id ya generado antes de insertar los cheques que cuelgan de él. Devuelve
 * los ids reales en el MISMO orden que splitsWithChecks — el modo titular los
 * usa para mapear cada split a su key opaca del plan de financiación
 * ("split-{i}"); el camino legacy no necesita ese mapeo y puede ignorar el
 * resultado.
 */
export async function insertBatchSplitsAndChecks(
  tx: AccountHolderFundingDbClient,
  batchId: number,
  splitsWithChecks: ReadonlyArray<SplitWithChecksForInsert>,
  createdBy: number
): Promise<number[]> {
  const insertedIds: number[] = [];
  for (const { split, checks } of splitsWithChecks) {
    const [insertedSplit] = await tx.insert(paymentBatchSplits).values({
      batchId, method: split.method, amountCents: split.amountCents, notes: split.notes,
    }).returning();
    const splitId = insertedSplit!.id as number;
    insertedIds.push(splitId);

    if (checks.length > 0) {
      await tx.insert(receivedChecks).values(checks.map((chk) => ({
        batchSplitId: splitId,
        checkNumber: chk.checkNumber,
        bankName: chk.bankName,
        bankCode: chk.bankCode,
        drawerName: chk.drawerName,
        drawerDocument: chk.drawerDocument,
        issueDate: chk.issueDate,
        dueDate: chk.dueDate,
        amountCents: chk.amountCents,
        currency: chk.currency,
        status: "en_cartera",
        notes: chk.notes,
        receivedAt: new Date(),
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
      })));
    }
  }
  return insertedIds;
}

// ─── 4. payments hijos + cash_entries de recargo + recálculo de cuotas ────

export interface BatchChildContextForInsert {
  ctxItem: BatchItemContext;
  display: { insuredName: string | null; policyNumber: string | null; companyName: string | null };
  /** Ya resuelto por el caller (applicableSurchargeSet.has(ctxItem)) — este módulo no decide elegibilidad de Pronto Pago. */
  hasSurcharge: boolean;
}

export interface InsertBatchChildrenResult {
  /** Mismo orden que `items` — el modo titular las mapea a "payment-{idx}". */
  childIds: number[];
  /** índice de `items` -> id real del cash_entry de recargo (solo para los que tuvieron hasSurcharge=true) — el modo titular las mapea a "pronto_pago-{idx}". */
  cashEntryIdByIndex: Map<number, number>;
  /** Único hijo sin ambigüedad — null si items.length !== 1 (mismo criterio legacy, usado solo para relatedPaymentId/relatedInstallmentId de un eventual saldo_deudor). */
  singleChildId: number | null;
}

/**
 * Inserta, para cada ítem del batch: el payment hijo, su cash_entry de
 * recargo Pronto Pago si corresponde, y recalcula el status de la cuota real
 * si el ítem es de tipo "installment" — mismo orden y mismos valores que el
 * flujo legacy preexistente, sin ninguna rama condicional por modo.
 */
export async function insertBatchChildren(
  tx: AccountHolderFundingDbClient,
  batchId: number,
  items: ReadonlyArray<BatchChildContextForInsert>,
  paymentDate: string,
  createdBy: number
): Promise<InsertBatchChildrenResult> {
  const childIds: number[] = [];
  const cashEntryIdByIndex = new Map<number, number>();
  let singleChildId: number | null = null;

  for (let idx = 0; idx < items.length; idx++) {
    const { ctxItem, display, hasSurcharge } = items[idx]!;

    const [child] = await tx.insert(payments).values({
      policyId: ctxItem.policyId,
      installmentId: ctxItem.installmentId,
      amount: ctxItem.amount,
      paymentMethod: "lote",
      paymentDate,
      notes: ctxItem.kind !== "installment" ? ctxItem.description : null,
      manualPayer: ctxItem.kind === "manual_payment" ? ctxItem.manualPayer : null,
      manualPolicyNumber: ctxItem.kind === "manual_payment" ? ctxItem.manualPolicyNumber : null,
      manualCompany: ctxItem.kind === "manual_payment" ? ctxItem.manualCompany : null,
      status: "confirmado",
      batchId,
      createdBy,
    }).returning();
    const childId = child!.id as number;
    childIds.push(childId);
    if (items.length === 1) singleChildId = childId;

    if (hasSurcharge) {
      const [entry] = await tx.insert(cashEntries).values({
        clientName: display.insuredName ?? "—",
        policyNumber: display.policyNumber ?? null,
        companyName: display.companyName ?? null,
        amount: SURCHARGE_AMOUNT_CENTS / 100,
        paymentMethod: "lote",
        paymentDate,
        entryType: "pronto_pago_surcharge",
        paymentId: childId,
        rendered: 0,
        notes: "Recargo Pronto Pago Rivadavia",
        createdBy,
      }).returning();
      cashEntryIdByIndex.set(idx, entry!.id as number);
    }

    if (ctxItem.kind === "installment") {
      await recalculateInstallmentPaymentStatus(tx, ctxItem.installmentId!);
    }
  }

  return { childIds, cashEntryIdByIndex, singleChildId };
}
