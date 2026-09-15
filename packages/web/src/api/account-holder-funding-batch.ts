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

import { and, eq } from "drizzle-orm";
import { insuredAccountMovements } from "./database/schema";
import { calculateInsuredAccountBalance, type InsuredAccountMovementForBalance } from "../lib/payments/insured-account";
import {
  planAccountHolderBatchFunding,
  type PlanAccountHolderBatchFundingInput,
  type AccountHolderFundingPlanResult,
  type FundingPlanSplitInput,
} from "../lib/payments/account-holder-funding-plan";
import type { FundingDestinationInput } from "../lib/payments/account-holder-funding";

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
