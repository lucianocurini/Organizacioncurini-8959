// Clasificación de seguridad para la reconstrucción de un plan de cuotas existente
// (Subetapa 2B). Determina si las cuotas actuales de una póliza pueden borrarse y
// reemplazarse por un plan nuevo (buildInstallmentPlan, ver ./plan.ts) sin perder
// actividad real (pagos, rendiciones, cobros).
//
// Pura función de lectura: no borra ni modifica nada. El caller (endpoint) decide
// qué hacer con el resultado, y debe volver a llamarla dentro de la transacción de
// escritura antes de borrar, para evitar condiciones de carrera entre el chequeo y
// el borrado (ver rebuild-check vs. rebuild en index.ts).
//
// Decisión — expectedCount null (policies.installments sin valor cargado):
// no hay nada contra qué comparar, así que `mismatched` es siempre false en ese
// caso. No se trata como bloqueante ni se infiere un valor esperado a partir de
// actualCount — eso ocultaría desincronizaciones reales el día que se cargue
// installments. Cubierto por el test "expectedCount null".
//
// Decisión — rebillingId: cualquier cuota con rebilling_id no nulo bloquea la
// reconstrucción (motivo agregado a blockingInstallments, igual que "pagada" o
// "rendida"). Un plan reconstruido es único (un período, un importe, una cantidad
// de cuotas) y no hay forma de mapear 1 a 1 esas cuotas viejas —que pueden venir de
// varias refacturaciones distintas, con sus propios períodos y montos— a las
// posiciones del plan nuevo sin inventar una regla arbitraria. Preservar el
// rebillingId "como se pueda" arriesgaría perder la trazabilidad silenciosamente.
// La refacturación tiene su propio flujo (POST /policies/:id/rebillings) para
// generar cuotas nuevas; este endpoint no debe pisarlo.

import { eq, inArray, and } from "drizzle-orm";
import { policies, policyInstallments, payments, remittanceItems } from "../../api/database/schema";
import type { InstallmentPlanResult } from "./plan";
import { validateCashPaymentAmountAgainstNominal } from "../payments/cash-period-payments";

export type RebuildClassification = "NO_INSTALLMENTS" | "SAFE_TO_REBUILD" | "REQUIRES_MANUAL_REVIEW";

export interface BlockingInstallment {
  id: number;
  number: number;
  dueDate: string;
  reasons: string[];
}

export interface InstallmentRebuildCheck {
  classification: RebuildClassification;
  expectedCount: number | null;
  actualCount: number;
  mismatched: boolean;
  blockingInstallments: BlockingInstallment[];
}

interface InstallmentRow {
  id: number;
  number: number;
  dueDate: string;
  status: string;
  rendered: number;
  rebillingId: number | null;
}

// Únicos valores de policy_installments.status que no representan actividad real
// por sí mismos. "vencida" es sólo "pendiente" cuya fecha ya pasó (ver el update
// perezoso en GET /policies/:id/installments en index.ts) — no implica pago,
// rendición ni ningún otro movimiento. Cualquier otro valor (incluida corrupción
// de datos, o un estado nuevo agregado a futuro sin actualizar esta lista) se
// trata como bloqueante por defecto: fail-closed, no fail-open.
const KNOWN_SAFE_STATUSES = new Set(["pendiente", "vencida"]);

/**
 * Clasifica cuotas ya cargadas en memoria (sin tocar la base). Usada tanto por
 * classifyInstallmentsForRebuild como directamente en tests unitarios de la regla
 * de clasificación en sí, sin depender de fixtures de base de datos.
 */
export function classifyLoadedInstallments(
  expectedCount: number | null,
  installments: InstallmentRow[],
  paidInstallmentIds: Set<number>,
  remittedInstallmentIds: Set<number>,
): InstallmentRebuildCheck {
  const actualCount = installments.length;

  if (actualCount === 0) {
    return {
      classification: "NO_INSTALLMENTS",
      expectedCount,
      actualCount: 0,
      mismatched: expectedCount !== null && expectedCount !== 0,
      blockingInstallments: [],
    };
  }

  const blockingInstallments: BlockingInstallment[] = [];
  for (const inst of installments) {
    const reasons: string[] = [];
    if (inst.status === "pagada") {
      reasons.push("La cuota está marcada como pagada.");
    } else if (!KNOWN_SAFE_STATUSES.has(inst.status)) {
      reasons.push(`Estado de cuota no reconocido: "${inst.status}".`);
    }
    if (inst.rendered === 1) reasons.push("La cuota fue rendida a la compañía.");
    if (paidInstallmentIds.has(inst.id)) reasons.push("La cuota tiene un pago vinculado (payments.installmentId).");
    if (remittedInstallmentIds.has(inst.id)) reasons.push("La cuota tiene una rendición directa (remittance_items).");
    if (inst.rebillingId !== null) reasons.push(`La cuota pertenece a una refacturación (rebillingId=${inst.rebillingId}).`);
    if (reasons.length > 0) {
      blockingInstallments.push({ id: inst.id, number: inst.number, dueDate: inst.dueDate, reasons });
    }
  }

  return {
    classification: blockingInstallments.length > 0 ? "REQUIRES_MANUAL_REVIEW" : "SAFE_TO_REBUILD",
    expectedCount,
    actualCount,
    mismatched: expectedCount !== null && expectedCount !== actualCount,
    blockingInstallments,
  };
}

/** Se lanza cuando policyId no corresponde a ninguna póliza existente. Evita que
 * classifyInstallmentsForRebuild confunda "póliza real sin cuotas" (NO_INSTALLMENTS,
 * un resultado legítimo) con "policyId inventado o borrado" — ambos casos leerían
 * cero filas de policy_installments si no se distinguieran explícitamente.
 * Los endpoints la mapean a HTTP 404. Cualquier caller futuro (no solo los
 * endpoints actuales) queda protegido igual, porque la verificación vive acá
 * adentro y no en cada sitio que llama a la función. */
export class PolicyNotFoundError extends Error {
  constructor(public policyId: number) {
    super(`La póliza ${policyId} no existe.`);
  }
}

/**
 * Versión que lee de la base de datos (o de una transacción `tx`, que expone la
 * misma API que `db`). No modifica nada — solo SELECTs.
 *
 * Lanza PolicyNotFoundError si policyId no existe — ver esa clase para el motivo.
 */
export async function classifyInstallmentsForRebuild(
  dbClient: any,
  policyId: number,
): Promise<InstallmentRebuildCheck> {
  const policyRow = await dbClient
    .select({ installments: policies.installments })
    .from(policies)
    .where(eq(policies.id, policyId))
    .get();
  if (!policyRow) throw new PolicyNotFoundError(policyId);
  const expectedCount = policyRow.installments ?? null;

  const installments: InstallmentRow[] = await dbClient
    .select({
      id: policyInstallments.id,
      number: policyInstallments.number,
      dueDate: policyInstallments.dueDate,
      status: policyInstallments.status,
      rendered: policyInstallments.rendered,
      rebillingId: policyInstallments.rebillingId,
    })
    .from(policyInstallments)
    .where(eq(policyInstallments.policyId, policyId))
    .orderBy(policyInstallments.number)
    .all();

  const installmentIds = installments.map((i) => i.id);

  let paidInstallmentIds = new Set<number>();
  let remittedInstallmentIds = new Set<number>();

  if (installmentIds.length > 0) {
    const payRows = await dbClient
      .select({ installmentId: payments.installmentId })
      .from(payments)
      .where(inArray(payments.installmentId, installmentIds))
      .all();
    paidInstallmentIds = new Set(payRows.map((r: any) => r.installmentId).filter((id: any) => id !== null));

    const remRows = await dbClient
      .select({ sourceId: remittanceItems.sourceId })
      .from(remittanceItems)
      .where(and(eq(remittanceItems.source, "installment"), inArray(remittanceItems.sourceId, installmentIds)))
      .all();
    remittedInstallmentIds = new Set(remRows.map((r: any) => r.sourceId).filter((id: any) => id !== null));
  }

  return classifyLoadedInstallments(expectedCount, installments, paidInstallmentIds, remittedInstallmentIds);
}

/** Se lanza cuando la reclasificación hecha dentro de la transacción de escritura
 * encuentra actividad que el precheck (hecho antes de abrir la transacción) no
 * vio — condición de carrera entre el chequeo y el borrado. Al lanzarse dentro
 * de `db.transaction`, Drizzle hace ROLLBACK automáticamente antes de propagar
 * el error. */
export class RebuildConflictError extends Error {
  constructor(public blockingInstallments: BlockingInstallment[]) {
    super("La póliza tiene cuotas con actividad — no se puede reconstruir el plan.");
  }
}

export interface RebuildTransactionResult {
  previousCount: number;
  previousExpectedCount: number | null;
  insertedRows: Array<{ id: number; policyId: number; number: number; dueDate: string; amount: number; status: string }>;
}

/**
 * Cuerpo transaccional completo de la reconstrucción: reclasifica con el cliente
 * transaccional (`tx`), borra las cuotas actuales solo si siguen siendo seguras,
 * inserta el plan nuevo, sincroniza policies.installments y verifica el resultado
 * antes de devolverlo. Cualquier error lanzado acá aborta la transacción completa
 * (rollback) — nunca deja cuotas a medio insertar ni policies.installments
 * desincronizado.
 *
 * Extraída de la ruta HTTP para poder probarse directamente: los tests le pasan
 * un `tx` real (dentro de db.transaction) con datos fabricados para forzar tanto
 * el camino de conflicto (test de uso del cliente transaccional) como un
 * fallo real de inserción (test de rollback).
 */
export async function runInstallmentRebuildTransaction(
  tx: any,
  policyId: number,
  plan: InstallmentPlanResult,
  period: { periodStart: string; periodEnd: string; periodAmount: number },
): Promise<RebuildTransactionResult> {
  // Esta es la ÚNICA autorización efectiva para borrar: cualquier clasificación
  // hecha antes de abrir la transacción (el "precheck" en index.ts) es solamente
  // informativa — sirve para devolver 409 rápido sin abrir una transacción de
  // escritura innecesaria, pero no tiene ninguna validez de por sí. El estado
  // real de la póliza puede haber cambiado entre ese precheck y este punto, así
  // que se vuelve a leer acá, con `tx`, inmediatamente antes del borrado.
  const recheck = await classifyInstallmentsForRebuild(tx, policyId);
  if (recheck.classification === "REQUIRES_MANUAL_REVIEW") {
    throw new RebuildConflictError(recheck.blockingInstallments);
  }
  const previousCount = recheck.actualCount;
  const previousExpectedCount = recheck.expectedCount;

  // Migración 0034 — Etapa "seguridad de reconstrucción de plan": el importe
  // contado del período de emisión/renovación (policies.cashPaymentAmountCents)
  // no lo toca esta reconstrucción, pero el NUEVO nominal del plan puede ser
  // menor al que había cuando se cargó ese importe — si queda mayor al nuevo
  // nominal, se rechaza ANTES de borrar ninguna cuota (con `tx`, para ver el
  // valor real vigente, no uno leído fuera de la transacción). Lanzar acá
  // aborta toda la transacción (rollback automático de Drizzle) — el plan
  // anterior queda exactamente como estaba.
  const policyRow = await tx.select({ cashPaymentAmountCents: policies.cashPaymentAmountCents })
    .from(policies).where(eq(policies.id, policyId)).get();
  if (policyRow?.cashPaymentAmountCents != null) {
    const newNominalCents = Math.round(period.periodAmount * 100);
    validateCashPaymentAmountAgainstNominal(policyRow.cashPaymentAmountCents, newNominalCents);
  }

  await tx.delete(policyInstallments).where(eq(policyInstallments.policyId, policyId));

  const insertedRows = await tx
    .insert(policyInstallments)
    .values(plan.installments.map((row) => ({
      policyId,
      number: row.number,
      dueDate: row.dueDate,
      amount: row.amount,
      status: "pendiente",
      notes: null,
    })))
    .returning();

  await tx.update(policies).set({ installments: insertedRows.length }).where(eq(policies.id, policyId));

  if (insertedRows.length !== plan.installments.length) {
    throw new Error("La cantidad insertada no coincide con el plan calculado.");
  }
  const expectedCents = Math.round(period.periodAmount * 100);
  const insertedCents = insertedRows.reduce((sum: number, row: any) => sum + Math.round(row.amount * 100), 0);
  if (insertedCents !== expectedCents) {
    throw new Error("La suma de las cuotas insertadas no coincide con el importe del período.");
  }
  if (insertedRows.some((row: any) => row.dueDate < period.periodStart || row.dueDate > period.periodEnd)) {
    throw new Error("Alguna cuota insertada vence fuera del período facturado.");
  }
  if (insertedRows.some((row: any) => row.policyId !== policyId)) {
    throw new Error("Alguna cuota insertada no pertenece a la póliza correcta.");
  }

  return { previousCount, previousExpectedCount, insertedRows };
}
