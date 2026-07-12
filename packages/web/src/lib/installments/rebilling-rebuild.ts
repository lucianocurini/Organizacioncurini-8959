// Clasificación de seguridad + transacción de reconstrucción para el plan de
// cuotas de UNA refacturación puntual (rebillingId fijo). Variante "scoped"
// de rebuild.ts (que opera sobre TODA la póliza y excluye explícitamente
// cuotas con rebillingId no nulo) — acá es al revés: solo toca
// policy_installments.rebilling_id = :id, nunca la emisión original ni otra
// refacturación.
//
// Separación de responsabilidades (Etapa: editar datos vs. corregir plan):
// PUT /rebillings/:id (metadata-only) NUNCA borra ni inserta cuotas. Esta
// acción — GET rebuild-check + POST rebuild — es la ÚNICA vía para
// reemplazar el grupo de cuotas de una refacturación, y siempre requiere que
// el grupo esté libre de actividad real.

import { sql, eq, inArray, and } from "drizzle-orm";
import { policies, rebillings, policyInstallments, payments, remittanceItems } from "../../api/database/schema";
import type { InstallmentPlanResult } from "./plan";
import type { RebillingPayload } from "./rebilling-plan";

export type RebillingRebuildClassification = "NO_INSTALLMENTS" | "SAFE_TO_REBUILD" | "REQUIRES_MANUAL_REVIEW";

export interface RebillingBlockingInstallment {
  id: number;
  number: number;
  dueDate: string;
  reasons: string[];
}

export interface RebillingRebuildCheck {
  rebillingId: number;
  policyId: number;
  classification: RebillingRebuildClassification;
  currentCount: number;
  currentTotal: number;
  installmentIds: number[];
  statusCounts: Record<string, number>;
  hasPayments: boolean;
  hasRendered: boolean;
  hasRemittanceItems: boolean;
  hasActivity: boolean;
  blockingInstallments: RebillingBlockingInstallment[];
}

interface InstallmentRow {
  id: number;
  number: number;
  dueDate: string;
  amount: number;
  status: string;
  rendered: number;
}

// Mismo criterio fail-closed que rebuild.ts: cualquier status no reconocido
// bloquea, nunca se asume seguro por defecto.
const KNOWN_SAFE_STATUSES = new Set(["pendiente", "vencida"]);

export class RebillingNotFoundError extends Error {
  constructor(public rebillingId: number) {
    super(`La refacturación ${rebillingId} no existe.`);
  }
}

function classifyLoadedRebillingGroup(
  rebillingId: number,
  policyId: number,
  installments: InstallmentRow[],
  paidInstallmentIds: ReadonlySet<number>,
  remittedInstallmentIds: ReadonlySet<number>,
): RebillingRebuildCheck {
  const currentCount = installments.length;

  if (currentCount === 0) {
    return {
      rebillingId, policyId,
      classification: "NO_INSTALLMENTS",
      currentCount: 0, currentTotal: 0, installmentIds: [], statusCounts: {},
      hasPayments: false, hasRendered: false, hasRemittanceItems: false, hasActivity: false,
      blockingInstallments: [],
    };
  }

  const currentTotal = installments.reduce((s, i) => s + i.amount, 0);
  const installmentIds = installments.map((i) => i.id);
  const statusCounts: Record<string, number> = {};
  for (const i of installments) statusCounts[i.status] = (statusCounts[i.status] ?? 0) + 1;

  const blockingInstallments: RebillingBlockingInstallment[] = [];
  let hasPayments = false;
  let hasRendered = false;
  let hasRemittanceItems = false;

  for (const inst of installments) {
    const reasons: string[] = [];
    if (inst.status === "pagada") {
      reasons.push("La cuota está marcada como pagada.");
    } else if (!KNOWN_SAFE_STATUSES.has(inst.status)) {
      reasons.push(`Estado de cuota no reconocido: "${inst.status}".`);
    }
    if (inst.rendered === 1) { reasons.push("La cuota fue rendida a la compañía."); hasRendered = true; }
    if (paidInstallmentIds.has(inst.id)) { reasons.push("La cuota tiene un pago vinculado (payments.installmentId)."); hasPayments = true; }
    if (remittedInstallmentIds.has(inst.id)) { reasons.push("La cuota tiene una rendición directa (remittance_items)."); hasRemittanceItems = true; }
    if (reasons.length > 0) blockingInstallments.push({ id: inst.id, number: inst.number, dueDate: inst.dueDate, reasons });
  }

  const hasActivity = blockingInstallments.length > 0;

  return {
    rebillingId, policyId,
    classification: hasActivity ? "REQUIRES_MANUAL_REVIEW" : "SAFE_TO_REBUILD",
    currentCount, currentTotal, installmentIds, statusCounts,
    hasPayments, hasRendered, hasRemittanceItems, hasActivity,
    blockingInstallments,
  };
}

/**
 * Versión que lee de la base (o de una transacción `tx`). No modifica nada —
 * solo SELECTs. Lanza RebillingNotFoundError si rebillingId no existe.
 */
export async function classifyRebillingGroupForRebuild(dbClient: any, rebillingId: number): Promise<RebillingRebuildCheck> {
  const rebillingRow = await dbClient
    .select({ id: rebillings.id, policyId: rebillings.policyId })
    .from(rebillings)
    .where(eq(rebillings.id, rebillingId))
    .get();
  if (!rebillingRow) throw new RebillingNotFoundError(rebillingId);

  const installments: InstallmentRow[] = await dbClient
    .select({
      id: policyInstallments.id, number: policyInstallments.number, dueDate: policyInstallments.dueDate,
      amount: policyInstallments.amount, status: policyInstallments.status, rendered: policyInstallments.rendered,
    })
    .from(policyInstallments)
    .where(eq(policyInstallments.rebillingId, rebillingId))
    .orderBy(policyInstallments.number)
    .all();

  const installmentIds = installments.map((i) => i.id);
  let paidInstallmentIds = new Set<number>();
  let remittedInstallmentIds = new Set<number>();
  if (installmentIds.length > 0) {
    const payRows = await dbClient.select({ installmentId: payments.installmentId }).from(payments)
      .where(inArray(payments.installmentId, installmentIds)).all();
    paidInstallmentIds = new Set(payRows.map((r: any) => r.installmentId).filter((id: any) => id !== null));

    const remRows = await dbClient.select({ sourceId: remittanceItems.sourceId }).from(remittanceItems)
      .where(and(eq(remittanceItems.source, "installment"), inArray(remittanceItems.sourceId, installmentIds))).all();
    remittedInstallmentIds = new Set(remRows.map((r: any) => r.sourceId).filter((id: any) => id !== null));
  }

  return classifyLoadedRebillingGroup(rebillingId, rebillingRow.policyId, installments, paidInstallmentIds, remittedInstallmentIds);
}

/** Se lanza cuando la reclasificación dentro de la transacción de escritura
 * encuentra actividad que el precheck no vio — condición de carrera entre el
 * chequeo y el borrado. */
export class RebillingRebuildConflictError extends Error {
  constructor(public blockingInstallments: RebillingBlockingInstallment[]) {
    super("La refacturación tiene cuotas con actividad — no se puede corregir el plan.");
  }
}

export interface RebillingRebuildTransactionResult {
  previousCount: number;
  policyId: number;
  rebilling: Record<string, any>;
  insertedRows: Array<{ id: number; policyId: number; number: number; dueDate: string; amount: number; status: string; rebillingId: number }>;
}

/**
 * Cuerpo transaccional completo: reclasifica con `tx` (única autorización real
 * para borrar), borra SOLO las cuotas de este rebillingId, inserta el plan
 * nuevo con ese mismo rebillingId, actualiza los metadatos de la
 * refacturación y ajusta policies.installments/deductible. Nunca toca cuotas
 * de otro grupo ni de la emisión original.
 */
export async function runRebillingRebuildTransaction(
  tx: any,
  rebillingId: number,
  plan: InstallmentPlanResult,
  payload: RebillingPayload,
): Promise<RebillingRebuildTransactionResult> {
  const recheck = await classifyRebillingGroupForRebuild(tx, rebillingId);
  if (recheck.classification === "REQUIRES_MANUAL_REVIEW") {
    throw new RebillingRebuildConflictError(recheck.blockingInstallments);
  }
  const previousCount = recheck.currentCount;
  const policyId = recheck.policyId;

  if (previousCount > 0) {
    await tx.delete(policyInstallments).where(eq(policyInstallments.rebillingId, rebillingId));
  }

  const insertedRows = await tx.insert(policyInstallments).values(
    plan.installments.map((row) => ({
      policyId, number: row.number, dueDate: row.dueDate, amount: row.amount,
      status: "pendiente", rendered: 0, rebillingId,
    }))
  ).returning();

  const [updatedRebilling] = await tx.update(rebillings).set({
    billingStart: payload.billingStart,
    billingEnd: payload.billingEnd,
    premium: payload.premium,
    monthlyFee: payload.monthlyFee,
    sumInsured: payload.sumInsured,
    installmentCount: payload.installmentCount,
    firstDueDate: payload.firstDueDate,
    deductible: payload.deductible,
    notes: payload.notes,
  }).where(eq(rebillings.id, rebillingId)).returning();

  // policies.installments ajustado por la DIFERENCIA — nunca "set" absoluto,
  // para no pisar cuotas de otros grupos ni de la emisión original.
  const diff = plan.installments.length - previousCount;
  if (diff !== 0) {
    await tx.update(policies)
      .set({ installments: sql`COALESCE(${policies.installments}, 0) + ${diff}` })
      .where(eq(policies.id, policyId));
  }
  if (payload.deductible !== null) {
    await tx.update(policies).set({ deductible: payload.deductible }).where(eq(policies.id, policyId));
  }

  if (insertedRows.length !== plan.installments.length) {
    throw new Error("La cantidad insertada no coincide con el plan calculado.");
  }
  if (insertedRows.some((row: any) => row.rebillingId !== rebillingId)) {
    throw new Error("Alguna cuota insertada no quedó vinculada a la refacturación correcta.");
  }

  return { previousCount, policyId, rebilling: updatedRebilling, insertedRows };
}
