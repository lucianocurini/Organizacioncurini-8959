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
  accountHolderFundingIdempotencyKeys,
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
import {
  FUNDING_REQUEST_ENDPOINTS, PAYMENT_BATCHES_ENDPOINT, type FundingRequestEndpoint,
} from "../lib/payments/account-holder-funding-fingerprint";

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
    // Narrowing explícito: `row` es `any` (AccountHolderFundingDbClient lo es
    // a propósito, ver su tipo) — asignar row!.id directamente a una `let`
    // tipada `number | null` NO la angosta a `number` (TS no angosta a partir
    // de un valor `any`, conserva el tipo declarado). insertedId, con su
    // propia anotación de tipo explícita, sí lo hace — sin `as number` ni
    // `any` nuevos. Garantía en runtime: `tx.insert(...).values(UNA fila)
    // .returning()` siempre devuelve exactamente una fila con id real
    // (autoincrement) — el `!` sobre `row` ya era el criterio existente de
    // todo este archivo (ver el resto de este método y
    // insertAccountHolderFundingIdempotencyRow), no algo nuevo introducido acá.
    const insertedId: number = row!.id;
    creditMovementId = insertedId;
    movementSnapshots.set(insertedId, {
      id: insertedId, insuredId: accountHolderInsuredId, type: "aplicacion_saldo_favor",
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
    // Ver comentario de narrowing explícito en el bloque de creditMovementId, arriba — mismo criterio.
    const insertedId: number = row!.id;
    debtMovementId = insertedId;
    movementSnapshots.set(insertedId, {
      id: insertedId, insuredId: accountHolderInsuredId, type: "saldo_deudor",
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
    // Ver comentario de narrowing explícito en el bloque de creditMovementId, arriba — mismo criterio.
    const insertedId: number = row!.id;
    newCreditMovementId = insertedId;
    movementSnapshots.set(insertedId, {
      id: insertedId, insuredId: accountHolderInsuredId, type: "saldo_a_favor",
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
    // Ver comentario de narrowing explícito en el bloque de creditMovementId, arriba — mismo criterio.
    const insertedId: number = row!.id;
    roundingAdjustmentId = insertedId;
    adjustmentSnapshots.set(insertedId, { id: insertedId, paymentBatchId: batch.id, amountCents });
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

// ─── 5. Idempotencia del flujo con titular ──────────────────────────────
// Etapa 1B-3-C1. Migración 0036, tabla
// account_holder_funding_idempotency_keys (ver cabecera de esa migración:
// diseño "sin placeholder" — la fila se inserta UNA sola vez, al final de la
// misma transacción externa que ya insertó el batch completo y corrió
// persistAccountHolderFundingArtifacts, cuando ya se conocen todos sus
// valores reales — nunca hay un INSERT parcial seguido de un UPDATE). Esta
// etapa agrega solo 3 helpers atómicos (buscar / resolver / insertar). La
// orquestación completa — el guard en POST /payment-batches, el cómputo real
// del hash SHA-256 sobre canonicalizeFundingRequest (account-holder-funding-
// fingerprint.ts) y la relectura de la fila ganadora fuera de esta
// transacción cuando este INSERT pierde una carrera — es una subetapa
// posterior (1B-3-C2 en adelante). index.ts NO importa este módulo todavía.
//
// ─── Por qué responseSnapshot es un string opaco, nunca un objeto ─────────
// account_holder_funding_idempotency_keys.response_snapshot es TEXT NOT NULL
// (migración 0036) — en database/schema.ts es `text("response_snapshot").
// notNull()`, sin `mode: "json"` (Drizzle no define ese modo para SQLite en
// este proyecto; ninguna otra columna TEXT de todo schema.ts lo usa
// tampoco). Los fixtures reales de la propia migración
// (migration-0036-account-holder-funding.test.ts) insertan literales como
// '{"id":1}' o '{}': confirma que el CONTENIDO esperado es JSON, pero la
// COLUMNA no lo tipa, no lo parsea ni lo valida como tal — es un string
// crudo. Por eso estos helpers NUNCA hacen JSON.parse/JSON.stringify sobre
// este campo: lo reciben como el string ya serializado por un caller futuro
// (quien arme el response real de POST /payment-batches) y lo devuelven bit
// a bit tal cual se guardó (punto 2 del pedido: "no reinterpretar ni
// reconstruir el snapshot"). La única validación acá es "string no vacío"
// (coherente con NOT NULL y con "sin placeholders") — nunca se exige que sea
// JSON válido, esa responsabilidad es de quien lo arma.
//
// ─── endpoint: misma fuente que el fingerprint ─────────────────────────────
// Los valores válidos de `endpoint` son exactamente los de
// FUNDING_REQUEST_ENDPOINTS (account-holder-funding-fingerprint.ts): POST
// /payment-batches (lote con titular) y POST /payments/account-funded (pago
// individual con saldo, persistido como lote de un ítem). El fingerprint
// canónico embebe el mismo endpoint, así que una idempotencyKey registrada en
// uno nunca resuelve una fila del otro. Cualquier otro valor se rechaza acá.

export class FundingIdempotencyConflictError extends Error {}

const ACCOUNT_HOLDER_FUNDING_IDEMPOTENCY_ENDPOINT = PAYMENT_BATCHES_ENDPOINT;
const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;

function assertNonEmptyString(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AccountHolderFundingBatchError(`${label} debe ser un string no vacío (recibido: ${value === null ? "null" : typeof value}).`);
  }
}

/** responseStatus: código HTTP real de la respuesta ya calculada — entero seguro dentro del rango válido 100..599. */
function assertHttpStatus(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < HTTP_STATUS_MIN || value > HTTP_STATUS_MAX) {
    throw new AccountHolderFundingBatchError(
      `${label} debe ser un código HTTP entero entre ${HTTP_STATUS_MIN} y ${HTTP_STATUS_MAX} (recibido: ${value}).`
    );
  }
}

/** Solo los endpoints de FUNDING_REQUEST_ENDPOINTS — cualquier otro valor se rechaza acá, aunque el esquema (UNIQUE compuesto) permitiría conviver con otro endpoint. */
function assertIdempotencyEndpoint(label: string, value: unknown): asserts value is FundingRequestEndpoint {
  if (typeof value !== "string" || !FUNDING_REQUEST_ENDPOINTS.has(value)) {
    throw new AccountHolderFundingBatchError(
      `${label} debe ser uno de ${[...FUNDING_REQUEST_ENDPOINTS].map((e) => `"${e}"`).join(", ")} (recibido: ${
        value === null ? "null" : typeof value === "string" ? `"${value}"` : typeof value
      }).`
    );
  }
}

/**
 * Recorta y valida 1..200 code points Unicode DESPUÉS del recorte — mismo
 * CHECK exacto que la migración 0036 (length(idempotency_key) BETWEEN 1 AND
 * 200; SQLite length() sobre TEXT cuenta caracteres, no bytes). Duplicado a
 * propósito de requireIdempotencyKey (account-holder-funding-request.ts,
 * Etapa 1B-3-A): mismo criterio, módulo y clase de error distintos. El
 * spread de string itera por code point (a diferencia de .length, que cuenta
 * unidades UTF-16 y duplicaría el conteo de caracteres fuera del BMP).
 */
function assertAndTrimIdempotencyKey(label: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new AccountHolderFundingBatchError(`${label} debe ser un string (recibido: ${value === null ? "null" : typeof value}).`);
  }
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > 200) {
    throw new AccountHolderFundingBatchError(
      `${label} debe tener entre 1 y 200 caracteres Unicode después de recortar espacios (recibido: ${length}).`
    );
  }
  return trimmed;
}

export interface AccountHolderFundingIdempotencyRow {
  id: number;
  createdBy: number;
  endpoint: string;
  idempotencyKey: string;
  requestFingerprint: string;
  paymentBatchId: number;
  responseStatus: number;
  responseSnapshot: string;
  createdAt: Date;
}

export interface FindAccountHolderFundingIdempotencyRowParams {
  createdBy: number;
  endpoint: string;
  idempotencyKey: string;
}

/**
 * Busca por la clave única real — UNIQUE(created_by, endpoint,
 * idempotency_key), migración 0036. Sin escrituras. Devuelve null si no hay
 * fila (caso normal: primera vez que se ve esta clave) — nunca lanza por
 * "no encontrado". `dbClient` puede ser `database` o `tx`, igual que el
 * resto del módulo (ver AccountHolderFundingDbClient).
 */
export async function findAccountHolderFundingIdempotencyRow(
  dbClient: AccountHolderFundingDbClient,
  params: FindAccountHolderFundingIdempotencyRowParams
): Promise<AccountHolderFundingIdempotencyRow | null> {
  assertPlainObject("params", params);
  assertSafePositiveInt("createdBy", params.createdBy);
  assertIdempotencyEndpoint("endpoint", params.endpoint);
  const idempotencyKey = assertAndTrimIdempotencyKey("idempotencyKey", params.idempotencyKey);

  const row = await dbClient
    .select()
    .from(accountHolderFundingIdempotencyKeys)
    .where(
      and(
        eq(accountHolderFundingIdempotencyKeys.createdBy, params.createdBy),
        eq(accountHolderFundingIdempotencyKeys.endpoint, params.endpoint),
        eq(accountHolderFundingIdempotencyKeys.idempotencyKey, idempotencyKey)
      )
    )
    .get();

  if (!row) return null;
  return {
    id: row.id as number,
    createdBy: row.createdBy as number,
    endpoint: row.endpoint as string,
    idempotencyKey: row.idempotencyKey as string,
    requestFingerprint: row.requestFingerprint as string,
    paymentBatchId: row.paymentBatchId as number,
    responseStatus: row.responseStatus as number,
    responseSnapshot: row.responseSnapshot as string,
    createdAt: row.createdAt as Date,
  };
}

export interface ResolvedIdempotentFundingResponse {
  paymentBatchId: number;
  responseStatus: number;
  responseSnapshot: string;
}

/**
 * Dada una fila ya encontrada (findAccountHolderFundingIdempotencyRow) y el
 * fingerprint REAL del request actual: si coincide con el guardado, es un
 * reintento legítimo de la misma idempotencyKey — devuelve exactamente
 * responseStatus/responseSnapshot/paymentBatchId ya guardados, sin
 * reinterpretar ni reconstruir el snapshot. Si NO coincide, la misma
 * idempotencyKey se está reusando con un request semánticamente distinto —
 * lanza FundingIdempotencyConflictError (el caller la traduce a HTTP 409).
 * Pura — sin DB, sin efectos, testeable sin el harness SQLite.
 */
export function resolveExistingIdempotentFundingRow(
  existingRow: AccountHolderFundingIdempotencyRow,
  requestFingerprint: string
): ResolvedIdempotentFundingResponse {
  assertPlainObject("existingRow", existingRow);
  assertSafePositiveInt("existingRow.paymentBatchId", existingRow.paymentBatchId);
  assertNonEmptyString("existingRow.requestFingerprint", existingRow.requestFingerprint);
  assertHttpStatus("existingRow.responseStatus", existingRow.responseStatus);
  assertNonEmptyString("existingRow.responseSnapshot", existingRow.responseSnapshot);
  assertNonEmptyString("requestFingerprint", requestFingerprint);

  if (existingRow.requestFingerprint !== requestFingerprint) {
    throw new FundingIdempotencyConflictError(
      `La idempotencyKey ya fue usada con un request distinto (el fingerprint no coincide) — batch existente ${existingRow.paymentBatchId}.`
    );
  }

  return {
    paymentBatchId: existingRow.paymentBatchId,
    responseStatus: existingRow.responseStatus,
    responseSnapshot: existingRow.responseSnapshot,
  };
}

export interface InsertAccountHolderFundingIdempotencyRowParams {
  createdBy: number;
  endpoint: string;
  idempotencyKey: string;
  requestFingerprint: string;
  paymentBatchId: number;
  responseStatus: number;
  /** String ya serializado por el caller (típicamente JSON) — ver cabecera de esta sección. Nunca se parsea acá. */
  responseSnapshot: string;
}

/**
 * Inserta la fila COMPLETA de idempotencia — todos los valores reales ya
 * conocidos, ningún placeholder ni actualización posterior. Debe llamarse
 * SIEMPRE al final de la misma transacción externa que ya creó el batch (el
 * mismo `tx` que recibió persistAccountHolderFundingArtifacts) — nunca abre
 * su propia transacción, nunca importa la conexión global. Si la fila
 * colisiona con el UNIQUE(created_by, endpoint, idempotency_key) — otra
 * request concurrente con la misma clave ganó la carrera — el error crudo
 * del driver se propaga TAL CUAL: esta función no tiene try/catch, nunca lo
 * atrapa ni lo traduce. Es responsabilidad de la transacción externa hacer
 * rollback completo de todo lo que esta request ya escribió (batch,
 * payments, movimientos, allocations). La relectura de la fila ganadora
 * fuera de esta transacción es una subetapa posterior (1B-3-C2+).
 */
export async function insertAccountHolderFundingIdempotencyRow(
  tx: AccountHolderFundingDbClient,
  params: InsertAccountHolderFundingIdempotencyRowParams
): Promise<number> {
  assertPlainObject("params", params);
  assertSafePositiveInt("createdBy", params.createdBy);
  assertIdempotencyEndpoint("endpoint", params.endpoint);
  const idempotencyKey = assertAndTrimIdempotencyKey("idempotencyKey", params.idempotencyKey);
  assertNonEmptyString("requestFingerprint", params.requestFingerprint);
  assertSafePositiveInt("paymentBatchId", params.paymentBatchId);
  assertHttpStatus("responseStatus", params.responseStatus);
  assertNonEmptyString("responseSnapshot", params.responseSnapshot);

  const [row] = await tx
    .insert(accountHolderFundingIdempotencyKeys)
    .values({
      createdBy: params.createdBy,
      endpoint: params.endpoint,
      idempotencyKey,
      requestFingerprint: params.requestFingerprint,
      paymentBatchId: params.paymentBatchId,
      responseStatus: params.responseStatus,
      responseSnapshot: params.responseSnapshot,
      createdAt: new Date(),
    })
    .returning();

  return row!.id as number;
}

// ─── 6. Orquestación transaccional completa — Etapa 1B-3-C2 ───────────────
// Coordina, sin duplicar ninguna regla económica ni de negocio, TODO el
// flujo del modo titular en una sola transacción real — pero todavía SIN
// conectar a POST /payment-batches (index.ts no importa este módulo). La
// creación de las filas base (payment_batches, payment_batch_splits,
// received_checks, payments, cash_entries de recargo) es responsabilidad de
// `dependencies`, inyectada por el futuro caller (index.ts) — este módulo no
// conoce policyId/installmentId/cheques/recargos ni ninguna de las ~700
// líneas de resolución de ítems reales de POST /payment-batches hoy; solo
// sabe que esas filas existen y necesita sus ids reales + el BatchSnapshot.
//
// ─── Orden real dentro de la transacción (pedido, con una sola desviación
// documentada) ───────────────────────────────────────────────────────────
//   revalidación de idempotencia (SELECT, antes de cualquier escritura)
//   -> batch -> revalidación de saldo/plan -> splits+cheques y
//   payments+recargos (un solo callback, createChildRows) -> movimientos/
//   ajuste + funding allocations (persistAccountHolderFundingArtifacts,
//   que YA internamente hace movimientos antes que allocations) -> fila
//   completa de idempotencia (última escritura).
//
// Única desviación del orden literal pedido: "splits y cheques" y "payments
// y recargos" se piden como DOS pasos separados, acá son UNO
// (createChildRows). Imposibilidad demostrada: en el flujo real (index.ts)
// ya están interleaved — cada split se inserta junto con SUS cheques en la
// misma iteración, y cada payment se inserta junto con SU recargo Pronto
// Pago en la suya — partirlos en dos callbacks distintos no reflejaría el
// código real ni traería ningún beneficio de integridad (no hay ninguna FK
// entre un split y un payment, a diferencia de batch -> children, que sí
// necesita el id real del batch). El orden RELATIVO entre splits y payments
// nunca importó ni en el código legacy ni acá.
//
// La revalidación de idempotencia ocurre ANTES del batch (no después, como
// insinúa la posición de "batch" en la lista) porque es la única forma de
// cumplir el requisito "encontrar la fila en la revalidación interna no crea
// un segundo batch" — si se revalidara después de crear el batch, ya
// existiría un batch huérfano que revertir (correcto igual, por rollback,
// pero entonces el orden pedido no tendría sentido con ese requisito). Nota
// de performance, no de corrección: el código legacy evita a propósito que
// la primera sentencia de su transacción sea un SELECT (contención de locks
// medida empíricamente, ver comentario en POST /payment-batches, index.ts)
// — acá la primera sentencia SÍ es un SELECT (la revalidación de
// idempotencia), sobre una tabla nueva y todavía sin tráfico real (el modo
// titular no está conectado). Si al activarlo se observara contención
// similar, ver ese mismo comentario en index.ts para el patrón de mitigación
// — no se replica preventivamente acá sin evidencia real de este flujo.
//
// ─── Carrera UNIQUE de idempotencia — por qué NO se puede reproducir con
// concurrencia real en los tests ─────────────────────────────────────────
// Reproducir la carrera real requeriría dos transacciones SQLite abiertas al
// mismo tiempo sobre el mismo archivo — con libsql en modo archivo local
// eso son locks a nivel de archivo (no de fila): la segunda conexión
// bloquearía o fallaría de forma dependiente del timing exacto, exactamente
// lo que el pedido prohíbe testear. Por eso la detección
// (isAccountHolderFundingIdempotencyUniqueViolation) y la reconciliación
// (reconcileAccountHolderFundingIdempotencyConflict) son funciones propias,
// testeables de forma aislada y determinista; y el "punto de fallo" para
// probar el cableado completo se inyecta pasando un `runTransaction` que
// falla directamente (runAccountHolderFundingTransaction, exportada para
// eso) — nunca con sleeps, locks reales ni condiciones de carrera genuinas.
// El test real de UNIQUE ya existente de 1B-3-C1 (dos inserts con la misma
// clave dentro de la misma transacción) se reutiliza para validar el
// detector contra un error REAL del driver, no solo contra uno sintético.

const ACCOUNT_HOLDER_FUNDING_IDEMPOTENCY_TABLE_NAME = "account_holder_funding_idempotency_keys";

/**
 * true si `error` (lo que rechazó `db.transaction(...)`) es el UNIQUE(created_by,
 * endpoint, idempotency_key) de esta tabla específica — nunca un falso
 * positivo con otro UNIQUE del mismo batch (p.ej. los 9 índices parciales de
 * payment_batch_funding_allocations): exige tanto la frase de SQLite como el
 * nombre de ESTA tabla. drizzle-orm/libsql envuelve el error real del driver
 * en DrizzleQueryError (`.cause` = el LibsqlError original, ver
 * insertAccountHolderFundingIdempotencyRow más arriba y su test) — se
 * inspecciona el mensaje en ambos niveles porque cuál de los dos lo trae
 * depende de la versión del driver, nunca se asume uno solo.
 */
export function isAccountHolderFundingIdempotencyUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const combined = `${error.message}\n${causeMessage}`;
  return combined.includes("UNIQUE constraint failed") && combined.includes(ACCOUNT_HOLDER_FUNDING_IDEMPOTENCY_TABLE_NAME);
}

export interface AccountHolderFundingIdempotencyReconciliationParams {
  createdBy: number;
  idempotencyKey: string;
  requestFingerprint: string;
  /** Default POST /payment-batches. */
  endpoint?: FundingRequestEndpoint;
}

/**
 * Se llama SOLO después de perder la carrera UNIQUE (la transacción propia
 * ya se revirtió por completo). Relee la fila ganadora con `dbClient`
 * (nunca `tx` — la transacción que falló ya no existe) y aplica la MISMA
 * regla de siempre: mismo fingerprint -> responseStatus/responseSnapshot/
 * paymentBatchId exactos del ganador; fingerprint distinto ->
 * FundingIdempotencyConflictError. Si no encuentra ninguna fila (estado
 * inesperado — se detectó el UNIQUE pero no hay fila que lo explique) lanza
 * un error de dominio explícito en vez de fallar en silencio o reintentar.
 */
export async function reconcileAccountHolderFundingIdempotencyConflict(
  dbClient: AccountHolderFundingDbClient,
  params: AccountHolderFundingIdempotencyReconciliationParams
): Promise<RunAccountHolderFundingBatchResult> {
  const existingRow = await findAccountHolderFundingIdempotencyRow(dbClient, {
    createdBy: params.createdBy,
    endpoint: params.endpoint ?? ACCOUNT_HOLDER_FUNDING_IDEMPOTENCY_ENDPOINT,
    idempotencyKey: params.idempotencyKey,
  });
  if (!existingRow) {
    throw new AccountHolderFundingBatchError(
      `Se detectó una colisión UNIQUE de idempotencia (createdBy=${params.createdBy}, idempotencyKey="${params.idempotencyKey}") pero no se encontró ninguna fila al releer — estado inesperado, no se puede reconciliar.`
    );
  }
  return resolveExistingIdempotentFundingRow(existingRow, params.requestFingerprint);
}

/**
 * Lookup + resolución en un solo paso — usado tanto para el chequeo rápido
 * previo a la transacción como para la revalidación interna (misma lógica,
 * distinto `dbClient`: `database` afuera, `tx` adentro). null si no hay
 * fila (caso normal). Puede lanzar FundingIdempotencyConflictError (fila
 * encontrada con fingerprint distinto).
 */
async function lookupAndResolveIdempotency(
  dbClient: AccountHolderFundingDbClient,
  lookupParams: FindAccountHolderFundingIdempotencyRowParams,
  requestFingerprint: string
): Promise<RunAccountHolderFundingBatchResult | null> {
  const existingRow = await findAccountHolderFundingIdempotencyRow(dbClient, lookupParams);
  if (!existingRow) return null;
  return resolveExistingIdempotentFundingRow(existingRow, requestFingerprint);
}

export interface AccountHolderFundingChildRows {
  /** sourceKey del plan (allocations con sourceKind="split") -> id real de payment_batch_splits. */
  splitIdByKey: ReadonlyMap<string, number>;
  /** destinationKey del plan (destinationKind="payment") -> id real de payments. */
  paymentIdByKey: ReadonlyMap<string, number>;
  /** destinationKey del plan (destinationKind="pronto_pago") -> id real de cash_entries. */
  cashEntryIdByKey: ReadonlyMap<string, number>;
}

export interface AccountHolderFundingResponseSnapshotContext {
  batch: BatchSnapshot;
  childRows: AccountHolderFundingChildRows;
  artifacts: PersistAccountHolderFundingArtifactsResult;
}

export interface AccountHolderFundingResponseSnapshot {
  responseStatus: number;
  /** String ya serializado (ver "responseSnapshot es un string opaco", 1B-3-C1) — este módulo nunca lo construye ni lo interpreta. */
  responseSnapshot: string;
}

/**
 * Contrato explícito de lo que el futuro caller (index.ts) debe inyectar —
 * TODO lo que este módulo no sabe hacer ni debe duplicar. Ninguna de las 3
 * funciones tiene acceso a payment_batch_funding_allocations ni a
 * account_holder_funding_idempotency_keys: no se les pasa ninguna referencia
 * a persistAccountHolderFundingArtifacts/insertAccountHolderFundingIdempotencyRow,
 * así que no pueden insertar ahí por su cuenta salvo que el propio caller
 * decida importarlas — no es una garantía en tiempo de compilación, es el
 * contrato de diseño: estas 3 funciones solo devuelven datos, nunca deciden
 * qué se persiste en esas dos tablas.
 */
export interface AccountHolderFundingBatchDependencies {
  /** Inserta ÚNICAMENTE la fila de payment_batches — primera escritura real de la transacción. Nunca splits/payments/cashEntries/allocations/idempotencia. */
  createBatch(tx: AccountHolderFundingDbClient): Promise<BatchSnapshot>;
  /** Inserta splits+cheques+payments+recargos Pronto Pago del batch YA creado. Nunca el batch mismo, nunca allocations/idempotencia. */
  createChildRows(tx: AccountHolderFundingDbClient, batch: BatchSnapshot): Promise<AccountHolderFundingChildRows>;
  /** Puro en cuanto a decisiones (no escribe nada propio) — arma el string de respuesta final a partir de lo ya persistido. Recibe `tx` solo por si necesita leer datos de exhibición (nombres, etc.) ya committeados en esta misma transacción. */
  buildResponseSnapshot(tx: AccountHolderFundingDbClient, ctx: AccountHolderFundingResponseSnapshotContext): Promise<AccountHolderFundingResponseSnapshot>;
}

export interface RunAccountHolderFundingBatchParams {
  /** Cliente Drizzle CON `.transaction()` — siempre `database`, nunca `tx` (este es el punto de entrada que ABRE la transacción). */
  db: AccountHolderFundingDbClient;
  createdBy: number;
  idempotencyKey: string;
  requestFingerprint: string;
  accountHolderInsuredId: number;
  paymentDate: string;
  destinations: ReadonlyArray<FundingDestinationInput>;
  realSplits: ReadonlyArray<FundingPlanSplitInput>;
  creditAppliedCents: number;
  roundingCoverageCents: number;
  debtAuthorized: boolean;
  debtReason: string | null;
  dependencies: AccountHolderFundingBatchDependencies;
  /** Endpoint que registra el cobro (idempotencia). Default POST /payment-batches. */
  endpoint?: FundingRequestEndpoint;
}

export interface RunAccountHolderFundingBatchResult {
  paymentBatchId: number;
  responseStatus: number;
  responseSnapshot: string;
}

/**
 * Envoltorio try/catch/reconciliación alrededor de UNA ejecución de la
 * transacción completa — aislado del resto de runAccountHolderFundingBatch
 * exclusivamente para que un test pueda inyectar un `runTransaction` que
 * falle de forma controlada (ver cabecera de esta sección, "por qué NO se
 * puede reproducir con concurrencia real"), sin mockear nada de DB. Si
 * `runTransaction()` lanza un error UNIQUE de esta tabla específica,
 * reconcilia releyendo con `db` (nunca con el `tx` ya muerto). Cualquier
 * otro error (incluido FundingPlanRaceConditionError,
 * FundingIdempotencyConflictError de la revalidación interna, o cualquier
 * error de DB no relacionado) se propaga tal cual — nunca se disfraza.
 */
export async function runAccountHolderFundingTransaction(
  db: AccountHolderFundingDbClient,
  runTransaction: () => Promise<RunAccountHolderFundingBatchResult>,
  reconciliation: AccountHolderFundingIdempotencyReconciliationParams
): Promise<RunAccountHolderFundingBatchResult> {
  try {
    return await runTransaction();
  } catch (error) {
    if (isAccountHolderFundingIdempotencyUniqueViolation(error)) {
      return await reconcileAccountHolderFundingIdempotencyConflict(db, reconciliation);
    }
    throw error;
  }
}

// ─── Serialización en proceso de las transacciones de financiación ─────────
// Dos requests simultáneos (doble clic, dos pestañas) que abren su
// transacción de escritura a la vez colisionan con SQLITE_BUSY. Con
// @libsql/client en modo archivo local eso además deja la conexión compartida
// del cliente con un BEGIN fallido "en progreso" (reproducido aislado contra
// el driver): las escrituras siguientes de TODO el proceso fallan con BUSY.
// Encolando acá las transacciones de financiación (lote con titular y pago
// individual con saldo) dentro del mismo proceso, nunca colisionan entre sí:
// la segunda espera a la primera y, si es el mismo request, su revalidación
// interna de idempotencia devuelve la respuesta ya guardada. No reemplaza a
// la base como autoridad entre procesos distintos (UNIQUE de idempotencia +
// relectura del saldo dentro de la transacción siguen siendo la garantía).
let fundingTransactionQueue: Promise<unknown> = Promise.resolve();

export function runSerializedFundingTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const run = fundingTransactionQueue.then(fn, fn);
  fundingTransactionQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Orquesta el flujo COMPLETO del modo titular de POST /payment-batches —
 * todavía sin conectar (index.ts no llama a esta función). Ver cabecera de
 * la sección para el orden exacto y las decisiones de diseño. No abre
 * ninguna transacción propia fuera de la única `params.db.transaction(...)`
 * que le corresponde como punto de entrada; nunca importa la conexión
 * global (recibe `params.db` inyectado, igual que el resto del archivo).
 */
export async function runAccountHolderFundingBatch(
  params: RunAccountHolderFundingBatchParams
): Promise<RunAccountHolderFundingBatchResult> {
  assertPlainObject("params", params);
  assertSafePositiveInt("createdBy", params.createdBy);
  const idempotencyKey = assertAndTrimIdempotencyKey("idempotencyKey", params.idempotencyKey);
  assertNonEmptyString("requestFingerprint", params.requestFingerprint);
  assertSafePositiveInt("accountHolderInsuredId", params.accountHolderInsuredId);
  if (!isValidCalendarDate(params.paymentDate)) {
    throw new AccountHolderFundingBatchError(`paymentDate debe ser una fecha calendario válida en formato YYYY-MM-DD (recibido: ${params.paymentDate}).`);
  }
  assertPlainObject("dependencies", params.dependencies);
  for (const fnName of ["createBatch", "createChildRows", "buildResponseSnapshot"] as const) {
    if (typeof (params.dependencies as Record<string, unknown>)[fnName] !== "function") {
      throw new AccountHolderFundingBatchError(`dependencies.${fnName} debe ser una función (recibido: ${typeof (params.dependencies as Record<string, unknown>)[fnName]}).`);
    }
  }
  if (!params.db || typeof (params.db as Record<string, unknown>).transaction !== "function") {
    throw new AccountHolderFundingBatchError("db debe ser un cliente Drizzle con .transaction() (recibido inválido).");
  }
  const endpoint = params.endpoint ?? ACCOUNT_HOLDER_FUNDING_IDEMPOTENCY_ENDPOINT;
  assertIdempotencyEndpoint("endpoint", endpoint);

  const planParams: PlanFundingWithFreshBalanceParams = {
    insuredId: params.accountHolderInsuredId,
    destinations: params.destinations,
    realSplits: params.realSplits,
    creditAppliedCents: params.creditAppliedCents,
    roundingCoverageCents: params.roundingCoverageCents,
    debtAuthorized: params.debtAuthorized,
  };
  const idempotencyLookupParams: FindAccountHolderFundingIdempotencyRowParams = {
    createdBy: params.createdBy,
    endpoint,
    idempotencyKey,
  };

  // ─── 1. Lookup rápido de idempotencia, fuera de la transacción ─────────
  const earlyHit = await lookupAndResolveIdempotency(params.db, idempotencyLookupParams, params.requestFingerprint);
  if (earlyHit) return earlyHit;

  // ─── 2. Plan preliminar, fuera de la transacción ───────────────────────
  const preliminary = await planFundingWithFreshBalance(params.db, planParams);

  // ─── 3. Transacción única ───────────────────────────────────────────────
  const runTransaction = (): Promise<RunAccountHolderFundingBatchResult> => runSerializedFundingTransaction(() =>
    params.db.transaction(async (tx: AccountHolderFundingDbClient) => {
      // Revalidación de idempotencia — primera operación de la transacción,
      // antes de cualquier escritura (ver cabecera de la sección).
      const internalHit = await lookupAndResolveIdempotency(tx, idempotencyLookupParams, params.requestFingerprint);
      if (internalHit) return internalHit;

      const batch = await params.dependencies.createBatch(tx);
      assertPlainObject("dependencies.createBatch() resultado", batch);
      assertSafePositiveInt("batch.id", batch.id);
      if (batch.accountHolderInsuredId !== params.accountHolderInsuredId) {
        throw new AccountHolderFundingBatchError(
          `dependencies.createBatch() devolvió un batch con accountHolderInsuredId=${batch.accountHolderInsuredId}, distinto del titular solicitado (${params.accountHolderInsuredId}).`
        );
      }

      // Revalidación de saldo/plan con el saldo releído DENTRO de la
      // transacción — si difiere del preliminar, lanza
      // FundingPlanRaceConditionError y la transacción entera (incluido el
      // batch recién insertado) se revierte.
      const fresh = await planFundingWithFreshBalance(tx, planParams);
      assertFundingPlanUnchanged(preliminary.plan, fresh.plan);

      const childRows = await params.dependencies.createChildRows(tx, batch);
      assertPlainObject("dependencies.createChildRows() resultado", childRows);
      assertMap("childRows.splitIdByKey", childRows.splitIdByKey);
      assertMap("childRows.paymentIdByKey", childRows.paymentIdByKey);
      assertMap("childRows.cashEntryIdByKey", childRows.cashEntryIdByKey);

      const artifacts = await persistAccountHolderFundingArtifacts(tx, {
        batch,
        plan: fresh.plan,
        paymentDate: params.paymentDate,
        createdBy: params.createdBy,
        debtReason: params.debtReason,
        splitIdByKey: childRows.splitIdByKey,
        paymentIdByKey: childRows.paymentIdByKey,
        cashEntryIdByKey: childRows.cashEntryIdByKey,
      });

      const { responseStatus, responseSnapshot } = await params.dependencies.buildResponseSnapshot(tx, { batch, childRows, artifacts });
      assertHttpStatus("responseStatus (buildResponseSnapshot)", responseStatus);
      assertNonEmptyString("responseSnapshot (buildResponseSnapshot)", responseSnapshot);

      // Última escritura de la transacción — ver cabecera de la sección.
      await insertAccountHolderFundingIdempotencyRow(tx, {
        createdBy: params.createdBy,
        endpoint,
        idempotencyKey,
        requestFingerprint: params.requestFingerprint,
        paymentBatchId: batch.id,
        responseStatus,
        responseSnapshot,
      });

      return { paymentBatchId: batch.id, responseStatus, responseSnapshot };
    }));

  // ─── 4. Carrera UNIQUE — reconciliación fuera de la transacción ────────
  return runAccountHolderFundingTransaction(params.db, runTransaction, {
    createdBy: params.createdBy,
    idempotencyKey,
    requestFingerprint: params.requestFingerprint,
    endpoint,
  });
}
