// Lectura del saldo activo de cuenta corriente + planificación/revalidación
// de financiación con titular — Etapa 1B-3-B1 (ver diseño cerrado en la
// conversación de "cuenta corriente con titular de cuenta", 2026-09). Vive
// en src/api/ (no en src/lib/payments/) porque, a diferencia de esos
// módulos, ESTE SÍ toca DB — nunca importa la conexión global
// (database/index.ts): el cliente Drizzle (db o tx) siempre lo inyecta el
// caller. index.ts NO importa este módulo todavía — la persistencia real de
// batches/payments/movimientos/ajustes/allocations/idempotencia es una
// etapa posterior (1B-3-B2 en adelante). Este archivo NUNCA inserta,
// actualiza ni borra ninguna fila.
//
// ─── Reutilización ──────────────────────────────────────────────────────
//
// calculateInsuredAccountBalance (insured-account.ts) es la única fuente de
// verdad para sumar signedAmountCents de movimientos activos — no se
// reimplementa acá, solo se le pasan filas ya leídas de la base.
// planAccountHolderBatchFunding (account-holder-funding-plan.ts, Etapa
// 1B-2A) es la única fuente de verdad para decidir cómo cierra un lote con
// titular — este módulo solo le resuelve `availableCreditCents` con un
// saldo real, nunca reimplementa su lógica de cierre/redondeo/saldo nuevo.
//
// ─── Saldo negativo vs. crédito disponible ─────────────────────────────────
//
// El saldo real de un asegurado (SUM(signedAmountCents) activo) puede ser
// negativo (el asegurado ya debe plata) — eso es un hecho legítimo que
// loadActiveAccountHolderBalanceCents devuelve tal cual, con signo. Pero
// planAccountHolderBatchFunding exige availableCreditCents >= 0 (no existe
// "crédito negativo" como concepto — un saldo negativo simplemente significa
// cero crédito disponible, no bloquea un plan que no intente aplicar
// crédito). planFundingWithFreshBalance hace ese clamp (Math.max(0, saldo))
// antes de pasarlo al plan — sin este clamp, CUALQUIER titular con una
// deuda preexistente haría fallar la planificación de un lote nuevo aunque
// ese lote no pidiera aplicar ningún crédito.

import { and, eq, inArray } from "drizzle-orm";
import {
  insuredAccountMovements, paymentAmountAdjustments, paymentBatchSplits, payments, cashEntries, paymentBatchFundingAllocations,
} from "./database/schema";
import {
  calculateInsuredAccountBalance, type InsuredAccountMovementForBalance,
  MAX_ROUNDING_ADJUSTMENT_CENTS, ROUNDING_ADJUSTMENT_REASON,
} from "../lib/payments/insured-account";
import {
  planAccountHolderBatchFunding,
  type PlanAccountHolderBatchFundingInput,
  type AccountHolderFundingPlanResult,
  type FundingPlanSplitInput,
} from "../lib/payments/account-holder-funding-plan";
import type { FundingDestinationInput } from "../lib/payments/account-holder-funding";
import {
  buildFundingAllocationRows,
  type BatchSnapshot,
  type FundingAllocationKeyMap,
  type FundingAllocationSnapshots,
  type BatchSplitSnapshot,
  type AccountMovementSnapshot,
  type RoundingAdjustmentSnapshot,
  type PaymentSnapshot,
  type CashEntrySnapshot,
  type FundingAllocationRow,
} from "../lib/payments/account-holder-funding-allocations";
import { isValidCalendarDate } from "../lib/installments/plan";

export class AccountHolderFundingBatchError extends Error {}
export class FundingPlanRaceConditionError extends Error {}

/**
 * El cliente Drizzle ya resuelto por el caller — `database` (fuera de una
 * transacción) o `tx` (dentro de un db.transaction), exactamente igual que
 * ya usa index.ts. Este módulo NUNCA importa la conexión global — siempre
 * recibe el cliente inyectado. Tipado deliberadamente laxo (mismo criterio
 * que `dbOrTx: any` en loadBatchCancelContext/resolveAccountMovementCancelPlan
 * de index.ts): LibSQLDatabase y su variante de transacción no comparten un
 * supertipo público simple en drizzle-orm.
 */
export type AccountHolderFundingDbClient = any;

// ─── Validación de forma — mismo criterio que el resto de módulos de esta
// etapa: nunca debe escapar un TypeError crudo. Duplicado acá porque este
// módulo es dueño de su propia clase de error de dominio.

function assertPlainObject(label: string, value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AccountHolderFundingBatchError(
      `${label} debe ser un objeto (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`
    );
  }
}

function assertSafePositiveInt(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new AccountHolderFundingBatchError(`${label} debe ser un entero seguro y positivo (recibido: ${value}).`);
  }
}

// ─── 1. Saldo activo real ───────────────────────────────────────────────

/**
 * SUM(signedAmountCents) de los movimientos de cuenta corriente ACTIVOS de
 * un asegurado — con signo (puede ser negativo). Filtra por status='activo'
 * ya en la consulta SQL (nunca trae movimientos anulados a memoria para
 * descartarlos después) y vuelve a filtrar vía calculateInsuredAccountBalance
 * (defensa en profundidad, mismo criterio que el resto de esta etapa: la
 * consulta ya scoped no es la única garantía). Sin escrituras.
 */
export async function loadActiveAccountHolderBalanceCents(dbClient: AccountHolderFundingDbClient, insuredId: number): Promise<number> {
  assertSafePositiveInt("insuredId", insuredId);

  const rows = await dbClient
    .select({
      signedAmountCents: insuredAccountMovements.signedAmountCents,
      status: insuredAccountMovements.status,
    })
    .from(insuredAccountMovements)
    .where(and(eq(insuredAccountMovements.insuredId, insuredId), eq(insuredAccountMovements.status, "activo")))
    .all();

  const balance = calculateInsuredAccountBalance(rows as ReadonlyArray<Pick<InsuredAccountMovementForBalance, "signedAmountCents" | "status">>);

  if (!Number.isSafeInteger(balance)) {
    throw new AccountHolderFundingBatchError(
      `El saldo activo del asegurado ${insuredId} dejó de ser un entero seguro en centavos — posible desborde (valor: ${balance}).`
    );
  }
  return balance;
}

// ─── 2. Planificación con saldo fresco ──────────────────────────────────

export interface PlanFundingWithFreshBalanceParams {
  insuredId: number;
  /** Ya normalizados/resueltos por el caller (nunca el body crudo) — mismo criterio que el resto de 1B-3. */
  destinations: ReadonlyArray<FundingDestinationInput>;
  realSplits: ReadonlyArray<FundingPlanSplitInput>;
  creditAppliedCents: number;
  roundingCoverageCents: number;
  debtAuthorized: boolean;
}

export interface PlanFundingWithFreshBalanceResult {
  /** Saldo real leído en este momento — con signo, puede ser negativo. */
  balanceCents: number;
  /** plan.destinations/allocations ya cierran contra availableCreditCents = Math.max(0, balanceCents). */
  plan: AccountHolderFundingPlanResult;
}

/**
 * Carga el saldo activo real del titular y arma el plan completo con ese
 * saldo — nunca persiste nada. Se usa tanto para la planificación
 * preliminar (fuera de una transacción) como para la revalidación fresca
 * (dentro de una transacción, pasando `tx` como dbClient) — la misma
 * función, sin ninguna rama especial para cada caso.
 */
export async function planFundingWithFreshBalance(
  dbClient: AccountHolderFundingDbClient,
  params: PlanFundingWithFreshBalanceParams
): Promise<PlanFundingWithFreshBalanceResult> {
  assertPlainObject("params", params);

  const balanceCents = await loadActiveAccountHolderBalanceCents(dbClient, params.insuredId);
  const availableCreditCents = Math.max(0, balanceCents);

  const planInput: PlanAccountHolderBatchFundingInput = {
    destinations: params.destinations,
    realSplits: params.realSplits,
    creditAppliedCents: params.creditAppliedCents,
    roundingCoverageCents: params.roundingCoverageCents,
    availableCreditCents,
    debtAuthorized: params.debtAuthorized,
  };
  const plan = planAccountHolderBatchFunding(planInput);

  return { balanceCents, plan };
}

// ─── 3. Revalidación — el plan fresco debe coincidir semánticamente ────────

/**
 * Comparación profunda: para objetos, el orden de las claves es
 * irrelevante (se comparan por conjunto); para arrays, el orden SÍ importa
 * (dos arrays con los mismos elementos en distinto orden NO son iguales) —
 * exactamente el criterio pedido para destinations/allocations, donde el
 * orden de las filas es semánticamente significativo (ver
 * account-holder-funding-plan.ts, buildFundingAllocationDrafts).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
    return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }

  return false;
}

/**
 * Compara un plan preliminar (calculado fuera de la transacción) contra uno
 * fresco (recalculado dentro, con el saldo releído en modo escritura) — o
 * lanza FundingPlanRaceConditionError. Compara el objeto COMPLETO vía
 * deepEqual — deliberadamente sin una lista curada de campos: cualquier
 * propiedad enumerable presente hoy, y cualquiera que se agregue a
 * AccountHolderFundingPlanResult en el futuro, participa automáticamente
 * sin tocar esta función. Nunca acepta en silencio un plan distinto: si el
 * saldo activo del titular cambió entre ambas lecturas de una forma que
 * altera el resultado (montos, destinos, allocations, o cualquier campo
 * nuevo que el plan llegue a tener), esto lo detecta. Un cambio de saldo
 * que NO altera el resultado económico (p.ej. el titular recibió más
 * crédito pero este lote no lo necesitaba) no dispara nada — se compara el
 * PLAN completo, nunca el saldo crudo.
 */
export function assertFundingPlanUnchanged(preliminary: AccountHolderFundingPlanResult, fresh: AccountHolderFundingPlanResult): void {
  assertPlainObject("preliminary", preliminary);
  assertPlainObject("fresh", fresh);

  if (!deepEqual(preliminary, fresh)) {
    throw new FundingPlanRaceConditionError(
      "El plan cambió entre la planificación preliminar y la revalidación dentro de la transacción — el saldo activo del titular cambió, no se puede continuar con datos obsoletos."
    );
  }
}

// ─── 4. Persistencia transaccional de los artefactos de financiación ──────
// Etapa 1B-3-B2. Recibe SIEMPRE la transacción externa activa (nunca abre
// una propia, nunca importa la conexión global) y datos ya creados/
// revalidados por el futuro orquestador: el batch, el plan FRESCO (ya
// revalidado con assertFundingPlanUnchanged fuera de acá), y los ids reales
// de splits/payments/cashEntries ya insertados, asociados a las keys opacas
// del plan. Esta función NUNCA inserta payment_batches/payment_batch_splits/
// payments/received_checks/cash_entries base — eso ya llegó hecho. Tampoco
// implementa idempotencia (Etapa 1B-3-B3 en adelante).
//
// Cualquier error de cualquier validación o insert se propaga tal cual —
// nunca se captura para "seguir con lo que se pudo": este archivo no tiene
// ningún try/catch. Es responsabilidad del caller (la transacción externa
// de index.ts) revertir todo cuando esto lanza.
//
// ─── relatedPaymentId: por qué NO se reusa validateInsuredAccountMovement ──
//
// validateInsuredAccountMovement (insured-account.ts) exige relatedPaymentId
// OBLIGATORIO para aplicacion_saldo_favor — ese requisito viene de un modelo
// anterior (calculateCreditActiveInCaja) donde UN movimiento financia UNA
// sola cuota. En este flujo (Etapa 1B-2B-i/ii) un mismo movimiento agregado
// puede financiar VARIOS destinos a la vez — el tracking real de Caja ya no
// depende de relatedPaymentId, depende de payment_batch_funding_allocations
// (ver account-holder-funding-caja.ts). Forzar esa función acá exigiría
// inventar un relatedPaymentId arbitrario cuando hay más de un payment hijo
// (exactamente lo que "no inventar vínculos ambiguos" prohíbe), o bloquear
// un plan válido con crédito repartido entre varias cuotas. Por eso esta
// función valida signo/insuredId/reason con sus propios chequeos (mismos
// valores que ya usa account-holder-funding-allocations.ts para el signo, no
// una convención nueva) y completa relatedPaymentId con la MISMA regla que
// ya usa el flujo legacy (index.ts, accountMovementToCreate): solo cuando el
// batch tiene EXACTAMENTE un payment hijo — nunca cuando hay más de uno.
// new_credit_movement (saldo_a_favor nuevo) nunca lleva relatedPaymentId,
// tampoco en el flujo legacy (representa dinero nuevo, no aplicado a nada).

function assertSafeNonNegativeInt(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AccountHolderFundingBatchError(`${label} debe ser un entero seguro no negativo (recibido: ${value}).`);
  }
}

function assertMap(label: string, value: unknown): asserts value is ReadonlyMap<string, number> {
  if (!(value instanceof Map)) {
    throw new AccountHolderFundingBatchError(`${label} debe ser un Map (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`);
  }
}

function assertNonEmptyTrimmedString(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AccountHolderFundingBatchError(`${label} debe ser un string no vacío (recibido: ${value === null ? "null" : typeof value}).`);
  }
}

export interface PersistAccountHolderFundingArtifactsParams {
  /** Batch ya insertado, confirmado, con titular explícito. */
  batch: BatchSnapshot;
  /** Plan FRESCO (calculado dentro de esta misma transacción) — el caller ya corrió assertFundingPlanUnchanged antes de llamar acá. */
  plan: AccountHolderFundingPlanResult;
  /** YYYY-MM-DD — se usa tal cual como effectiveDate de todo movimiento/ajuste que se cree acá. */
  paymentDate: string;
  createdBy: number;
  /** Obligatorio (string no vacío) si plan.newSaldoDeudorCents > 0; ignorado en cualquier otro caso. */
  debtReason: string | null;
  /** sourceKey del plan (allocations con sourceKind="split") -> id real de payment_batch_splits, ya insertado por el caller. */
  splitIdByKey: ReadonlyMap<string, number>;
  /** destinationKey del plan (allocations con destinationKind="payment") -> id real de payments, ya insertado por el caller. */
  paymentIdByKey: ReadonlyMap<string, number>;
  /** destinationKey del plan (allocations con destinationKind="pronto_pago") -> id real de cash_entries, ya insertado por el caller. */
  cashEntryIdByKey: ReadonlyMap<string, number>;
}

export interface PersistAccountHolderFundingArtifactsResult {
  creditMovementId: number | null;
  debtMovementId: number | null;
  newCreditMovementId: number | null;
  roundingAdjustmentId: number | null;
  allocationRows: FundingAllocationRow[];
  allocationIds: number[];
}

/** payments hijos del batch — SIEMPRE exactamente uno para que relatedPaymentId no sea ambiguo (ver cabecera). */
function resolveUnambiguousRelatedPaymentId(batchPayments: ReadonlyArray<{ id: number }>): number | null {
  return batchPayments.length === 1 ? batchPayments[0]!.id : null;
}

/**
 * Persiste, dentro de la transacción recibida, los artefactos de
 * financiación con titular que el plan indica: movimientos de cuenta
 * corriente (crédito aplicado / saldo deudor nuevo / saldo a favor nuevo),
 * el ajuste de redondeo, y las filas de payment_batch_funding_allocations —
 * o lanza sin dejar nada a medias (el rollback lo hace la transacción
 * externa). No inserta el batch, sus splits, payments, cheques ni recargos
 * base: esos ya llegan creados. No abre ninguna transacción propia, no
 * implementa idempotencia.
 */
export async function persistAccountHolderFundingArtifacts(
  tx: AccountHolderFundingDbClient,
  params: PersistAccountHolderFundingArtifactsParams
): Promise<PersistAccountHolderFundingArtifactsResult> {
  // ─── Validación previa a la primera escritura — todo lo que no depende de IDs generados ───
  assertPlainObject("params", params);
  assertPlainObject("batch", params.batch);
  assertSafePositiveInt("batch.id", params.batch.id);
  if (params.batch.status !== "confirmado") {
    throw new AccountHolderFundingBatchError(`El batch ${params.batch.id} no está confirmado (status="${params.batch.status}") — no se pueden persistir artefactos de financiación.`);
  }
  if (params.batch.accountHolderInsuredId === null || params.batch.accountHolderInsuredId === undefined) {
    throw new AccountHolderFundingBatchError(`El batch ${params.batch.id} no tiene accountHolderInsuredId — no se puede financiar sin titular contable explícito.`);
  }
  assertSafePositiveInt("batch.accountHolderInsuredId", params.batch.accountHolderInsuredId);
  const batch = params.batch;
  const accountHolderInsuredId = batch.accountHolderInsuredId as number;

  assertPlainObject("plan", params.plan);
  const plan = params.plan;
  assertSafeNonNegativeInt("plan.creditAppliedCents", plan.creditAppliedCents);
  assertSafeNonNegativeInt("plan.roundingCoverageCents", plan.roundingCoverageCents);
  assertSafeNonNegativeInt("plan.newSaldoAFavorCents", plan.newSaldoAFavorCents);
  assertSafeNonNegativeInt("plan.newSaldoDeudorCents", plan.newSaldoDeudorCents);
  if (plan.newSaldoAFavorCents > 0 && plan.newSaldoDeudorCents > 0) {
    // Defensivo: planAccountHolderBatchFunding ya garantiza esto por
    // construcción — si algún día llegara violado (plan tamperado), se
    // rechaza acá también, nunca se persiste un estado contradictorio.
    throw new AccountHolderFundingBatchError("El plan tiene saldo a favor y saldo deudor nuevos simultáneos — invariante violada, no se persiste.");
  }
  if (plan.roundingCoverageCents > MAX_ROUNDING_ADJUSTMENT_CENTS) {
    throw new AccountHolderFundingBatchError(
      `plan.roundingCoverageCents (${plan.roundingCoverageCents}) supera el máximo permitido (${MAX_ROUNDING_ADJUSTMENT_CENTS}).`
    );
  }

  if (!isValidCalendarDate(params.paymentDate)) {
    throw new AccountHolderFundingBatchError(`paymentDate debe ser una fecha calendario válida en formato YYYY-MM-DD (recibido: ${params.paymentDate}).`);
  }
  assertSafePositiveInt("createdBy", params.createdBy);

  if (plan.newSaldoDeudorCents > 0) {
    assertNonEmptyTrimmedString("debtReason", params.debtReason);
  }
  const debtReason = plan.newSaldoDeudorCents > 0 ? (params.debtReason as string).trim() : null;

  assertMap("splitIdByKey", params.splitIdByKey);
  assertMap("paymentIdByKey", params.paymentIdByKey);
  assertMap("cashEntryIdByKey", params.cashEntryIdByKey);

  // ─── Lecturas (no son escrituras) — snapshots reales del batch, para
  // resolver relatedPaymentId sin ambigüedad y para construir
  // FundingAllocationSnapshots más abajo. Se leen una sola vez: nada más en
  // esta función escribe payments/payment_batch_splits/cash_entries, así que
  // no hay riesgo de que queden desactualizados dentro de la misma tx.
  const batchPaymentRows = await tx.select({
    id: payments.id, batchId: payments.batchId, status: payments.status, amount: payments.amount,
  }).from(payments).where(eq(payments.batchId, batch.id)).all();

  const batchSplitRows = await tx.select({
    id: paymentBatchSplits.id, batchId: paymentBatchSplits.batchId, amountCents: paymentBatchSplits.amountCents,
  }).from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, batch.id)).all();

  const batchPaymentIds = batchPaymentRows.map((r: any) => r.id as number);
  const batchCashEntryRows = batchPaymentIds.length > 0
    ? await tx.select({
        id: cashEntries.id, entryType: cashEntries.entryType, status: cashEntries.status,
        paymentId: cashEntries.paymentId, amount: cashEntries.amount,
      }).from(cashEntries).where(inArray(cashEntries.paymentId, batchPaymentIds)).all()
    : [];

  const relatedPaymentId = resolveUnambiguousRelatedPaymentId(batchPaymentRows);

  // ─── Escrituras — movimientos de cuenta corriente y ajuste de redondeo ───
  let creditMovementId: number | null = null;
  let debtMovementId: number | null = null;
  let newCreditMovementId: number | null = null;
  let roundingAdjustmentId: number | null = null;
  const movementSnapshots = new Map<number, AccountMovementSnapshot>();

  if (plan.creditAppliedCents > 0) {
    const signedAmountCents = -plan.creditAppliedCents;
    const [row] = await tx.insert(insuredAccountMovements).values({
      insuredId: accountHolderInsuredId,
      type: "aplicacion_saldo_favor",
      signedAmountCents,
      status: "activo",
      originBatchId: batch.id,
      relatedPaymentId,
      relatedInstallmentId: null,
      reason: null,
      authorizedBy: null,
      createdBy: params.createdBy,
      createdAt: new Date(),
      effectiveDate: params.paymentDate,
    }).returning();
    creditMovementId = row!.id;
    movementSnapshots.set(creditMovementId, {
      id: creditMovementId, insuredId: accountHolderInsuredId, type: "aplicacion_saldo_favor",
      status: "activo", originBatchId: batch.id, signedAmountCents,
    });
  }

  if (plan.newSaldoDeudorCents > 0) {
    const signedAmountCents = -plan.newSaldoDeudorCents;
    const [row] = await tx.insert(insuredAccountMovements).values({
      insuredId: accountHolderInsuredId,
      type: "saldo_deudor",
      signedAmountCents,
      status: "activo",
      originBatchId: batch.id,
      relatedPaymentId,
      relatedInstallmentId: null,
      reason: debtReason,
      authorizedBy: null,
      createdBy: params.createdBy,
      createdAt: new Date(),
      effectiveDate: params.paymentDate,
    }).returning();
    debtMovementId = row!.id;
    movementSnapshots.set(debtMovementId, {
      id: debtMovementId, insuredId: accountHolderInsuredId, type: "saldo_deudor",
      status: "activo", originBatchId: batch.id, signedAmountCents,
    });
  }

  if (plan.newSaldoAFavorCents > 0) {
    const signedAmountCents = plan.newSaldoAFavorCents;
    const [row] = await tx.insert(insuredAccountMovements).values({
      insuredId: accountHolderInsuredId,
      type: "saldo_a_favor",
      signedAmountCents,
      status: "activo",
      originBatchId: batch.id,
      relatedPaymentId: null,
      relatedInstallmentId: null,
      reason: null,
      authorizedBy: null,
      createdBy: params.createdBy,
      createdAt: new Date(),
      effectiveDate: params.paymentDate,
    }).returning();
    newCreditMovementId = row!.id;
    movementSnapshots.set(newCreditMovementId, {
      id: newCreditMovementId, insuredId: accountHolderInsuredId, type: "saldo_a_favor",
      status: "activo", originBatchId: batch.id, signedAmountCents,
    });
  }

  const adjustmentSnapshots = new Map<number, RoundingAdjustmentSnapshot>();
  if (plan.roundingCoverageCents > 0) {
    const amountCents = -plan.roundingCoverageCents;
    const [row] = await tx.insert(paymentAmountAdjustments).values({
      paymentId: null,
      paymentBatchId: batch.id,
      amountCents,
      reason: ROUNDING_ADJUSTMENT_REASON,
      authorizedBy: params.createdBy,
      createdBy: params.createdBy,
      createdAt: new Date(),
      effectiveDate: params.paymentDate,
    }).returning();
    roundingAdjustmentId = row!.id;
    adjustmentSnapshots.set(roundingAdjustmentId, { id: roundingAdjustmentId, paymentBatchId: batch.id, amountCents });
  }

  // ─── Construcción de la matriz completa — SOLO ahora que hay IDs reales ───
  const keys: FundingAllocationKeyMap = {
    splitIdByKey: params.splitIdByKey,
    paymentIdByKey: params.paymentIdByKey,
    cashEntryIdByKey: params.cashEntryIdByKey,
    creditMovementId,
    debtMovementId,
    roundingAdjustmentId,
    newCreditMovementId,
  };

  const splitSnapshots = new Map<number, BatchSplitSnapshot>(
    batchSplitRows.map((r: any) => [r.id as number, { id: r.id as number, batchId: r.batchId as number, amountCents: r.amountCents as number }])
  );
  const paymentSnapshots = new Map<number, PaymentSnapshot>(
    batchPaymentRows.map((r: any) => [
      r.id as number,
      { id: r.id as number, batchId: r.batchId as number | null, status: r.status as PaymentSnapshot["status"], amountCents: Math.round((r.amount as number) * 100) },
    ])
  );
  const cashEntrySnapshotsMap = new Map<number, CashEntrySnapshot>(
    batchCashEntryRows.map((r: any) => [
      r.id as number,
      {
        id: r.id as number, entryType: r.entryType as CashEntrySnapshot["entryType"], status: r.status as CashEntrySnapshot["status"],
        paymentId: r.paymentId as number | null, amountCents: Math.round((r.amount as number) * 100),
      },
    ])
  );

  const snapshots: FundingAllocationSnapshots = {
    splits: splitSnapshots,
    movements: movementSnapshots,
    adjustments: adjustmentSnapshots,
    payments: paymentSnapshots,
    cashEntries: cashEntrySnapshotsMap,
  };

  const allocationRows = buildFundingAllocationRows(plan.allocations, keys, snapshots, batch);

  // ─── Escritura final — solo después de que la matriz completa sea válida ───
  const allocationIds: number[] = [];
  if (allocationRows.length > 0) {
    const insertedRows = await tx.insert(paymentBatchFundingAllocations).values(
      allocationRows.map((row) => ({
        paymentBatchId: row.paymentBatchId,
        paymentBatchSplitId: row.paymentBatchSplitId,
        sourceAccountMovementId: row.sourceAccountMovementId,
        paymentAmountAdjustmentId: row.paymentAmountAdjustmentId,
        paymentId: row.paymentId,
        cashEntryId: row.cashEntryId,
        destinationAccountMovementId: row.destinationAccountMovementId,
        amountCents: row.amountCents,
        createdBy: params.createdBy,
        createdAt: new Date(),
      }))
    ).returning();
    for (const r of insertedRows as any[]) allocationIds.push(r.id as number);
  }

  return { creditMovementId, debtMovementId, newCreditMovementId, roundingAdjustmentId, allocationRows, allocationIds };
}
