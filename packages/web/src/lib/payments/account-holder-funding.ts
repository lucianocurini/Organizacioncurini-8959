// Helpers puros de distribución de fondos para un lote con titular de cuenta
// (accountHolderInsuredId) — sobrantes/faltantes con saldo a favor aplicado y
// ajuste de redondeo absorbido por la oficina. Sin DB, sin HTTP, mismo estilo
// que caja-summary.ts/insured-account.ts: reciben datos ya resueltos por el
// endpoint y devuelven resultados explícitos.
//
// Etapa 0 del diseño (ver diagnóstico cerrado en la conversación de "sobrantes
// /faltantes con titular de cuenta", 2026-09) — SOLO estos helpers de reparto
// agregado por destino. Ningún endpoint usa todavía este módulo.
//
// ─── Alcance deliberadamente LIMITADO de esta etapa ────────────────────────
//
// cashCents en este módulo es el AGREGADO de dinero nuevo por destino (nominal
// − crédito − redondeo), nunca discriminado por instrumento real (cheque /
// efectivo / transferencia). Repartir ese agregado entre los payment_batch_
// splits concretos del lote (p.ej. "de los $109.913,17 de este destino,
// cuánto es del cheque de $100.000 y cuánto del efectivo de $71.200") es el
// trabajo de OTRA función, en otra etapa — no se hace ni se simula acá. Por
// la misma razón, este módulo no calcula ni asume una cantidad final de filas
// de payment_batch_funding_allocations: cuántas filas hacen falta depende de
// cómo se resuelva ese reparto por instrumento, que todavía no existe.
//
// Prioridad de asignación (fija, no configurable):
//   1. Crédito (saldo a favor aplicado) → destinos "payment" (primas/cuotas).
//   2. Excedente de crédito, si el destino "payment" ya está cubierto en su
//      totalidad → destinos "pronto_pago" (recargos).
//   3. Redondeo absorbido por la oficina → mismo orden, sobre lo que haya
//      quedado sin cubrir después del paso 1-2.
//   4. Lo que quede sin cubrir en cada destino es cash agregado (dinero
//      nuevo), por complemento — nunca se apportiona de forma independiente,
//      así cashCents + creditCents + roundingCents = nominalCents exacto en
//      cada destino, sin excepción.

import { apportionCents } from "./apportion";

export class FundingValidationError extends Error {}

// ─── Validación de importes en centavos ────────────────────────────────────
//
// Todo importe en centavos que entra o sale de este módulo debe ser un
// entero seguro (Number.isSafeInteger) — esto rechaza de una sola vez NaN,
// Infinity, -Infinity, decimales y cualquier valor fuera del rango donde la
// aritmética de punto flotante deja de representar enteros exactos
// (> Number.MAX_SAFE_INTEGER). Se usa tanto para validar entradas como para
// detectar sumas agregadas que hayan desbordado ese rango.

function assertSafeAmountCents(label: string, value: number, options: { min: number }): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new FundingValidationError(`${label} debe ser un entero seguro en centavos (recibido: ${value}).`);
  }
  if (value < options.min) {
    throw new FundingValidationError(`${label} no puede ser menor a ${options.min} centavos (recibido: ${value}).`);
  }
}

function assertSafeAggregateCents(label: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new FundingValidationError(`${label} dejó de ser un entero seguro en centavos — posible desborde (valor: ${value}).`);
  }
}

// ─── Validación de forma de entradas (objetos/arrays) y de ids canónicos ───
//
// Todo export público de este módulo puede recibir datos ajenos a TypeScript
// (JSON deserializado, un caller sin tipos) — nunca debe dejar escapar un
// TypeError crudo por acceder a una propiedad de undefined/null. Los ids
// deben ser strings no vacíos, sin espacios al inicio o al final: se
// rechazan en vez de recortarse, para que la unicidad se compruebe siempre
// sobre el valor canónico (" split-1 " y "split-1" no pueden coexistir).

function assertPlainObject(label: string, value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FundingValidationError(
      `${label} debe ser un objeto (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`
    );
  }
}

function assertArray(label: string, value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new FundingValidationError(`${label} debe ser un array (recibido: ${value === null ? "null" : typeof value}).`);
  }
}

function assertCanonicalId(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new FundingValidationError(`${label} debe ser un string (recibido: ${value === null ? "null" : typeof value}).`);
  }
  if (value.trim() === "") {
    throw new FundingValidationError(`${label} no puede estar vacío ni compuesto solo de espacios.`);
  }
  if (value !== value.trim()) {
    throw new FundingValidationError(
      `${label} no puede tener espacios al inicio o al final (recibido: "${value}") — se rechaza en vez de recortar.`
    );
  }
}

// ─── Destinos ───────────────────────────────────────────────────────────────

export type FundingDestinationKind = "payment" | "pronto_pago";

export interface FundingDestinationInput {
  /** Identificador opaco del destino (payment.id o cash_entry.id) — este módulo no sabe ni le importa cuál. Debe ser un string canónico (ver assertCanonicalId). */
  id: string;
  kind: FundingDestinationKind;
  /** Importe nominal del destino, en centavos. Debe ser > 0. */
  nominalCents: number;
}

export interface DestinationFundingBreakdown {
  id: string;
  kind: FundingDestinationKind;
  nominalCents: number;
  creditCents: number;
  roundingCents: number;
  /** Agregado de dinero nuevo — SIN discriminar por instrumento real (ver cabecera). */
  cashCents: number;
}

// ─── Reparto en cascada (waterfall) de UNA fuente sobre destinos restantes ──

interface TierWaterfallResult {
  portionsById: Map<string, number>;
  consumedCents: number;
}

/**
 * Reparte sourceCents sobre destinations (ya filtrados a un solo tier),
 * proporcional a remainingCentsById, capeado a la necesidad total del tier —
 * nunca asigna a un destino más de lo que le queda pendiente. Usa
 * apportionCents (Hamilton/resto mayor) para que la suma cierre exacto sin
 * drift. Devuelve cuánto se consumió realmente (puede ser menor a
 * sourceCents si el tier no tiene necesidad suficiente).
 */
function waterfallOverTier(
  sourceCents: number,
  tierIds: ReadonlyArray<string>,
  remainingCentsById: Map<string, number>
): TierWaterfallResult {
  const weights = tierIds.map((id) => remainingCentsById.get(id) ?? 0);
  const tierTotal = weights.reduce((s, w) => s + w, 0);
  assertSafeAggregateCents("La suma de los montos pendientes de los destinos de este tier", tierTotal);
  const toApply = Math.min(Math.max(sourceCents, 0), tierTotal);
  const portions = apportionCents(toApply, weights);
  const portionsById = new Map<string, number>();
  tierIds.forEach((id, i) => {
    const portion = portions[i]!;
    portionsById.set(id, portion);
    remainingCentsById.set(id, (remainingCentsById.get(id) ?? 0) - portion);
  });
  return { portionsById, consumedCents: toApply };
}

/**
 * Reparte sourceCents en cascada: primero sobre los destinos "payment"
 * (tier 1), y el excedente (si el tier 1 ya no tiene necesidad pendiente que
 * cubrir) sobre los destinos "pronto_pago" (tier 2). Devuelve las porciones
 * por destino (0 para los que no reciben nada de esta fuente) y cuánto de
 * sourceCents quedó SIN consumir por ningún destino (fondos ofrecidos de más
 * — ver validateFundingDistribution, que rechaza esto como error de uso).
 */
function waterfallCreditOrRounding(
  sourceCents: number,
  paymentIds: ReadonlyArray<string>,
  prontoPagoIds: ReadonlyArray<string>,
  remainingCentsById: Map<string, number>
): { portionsById: Map<string, number>; unconsumedCents: number } {
  const tier1 = waterfallOverTier(sourceCents, paymentIds, remainingCentsById);
  const overflow = sourceCents - tier1.consumedCents;
  const tier2 = waterfallOverTier(overflow, prontoPagoIds, remainingCentsById);
  const unconsumedCents = overflow - tier2.consumedCents;

  const portionsById = new Map<string, number>();
  for (const [id, cents] of tier1.portionsById) portionsById.set(id, cents);
  for (const [id, cents] of tier2.portionsById) portionsById.set(id, cents);
  return { portionsById, unconsumedCents };
}

// ─── Distribución completa (crédito → redondeo → cash por complemento) ─────

export interface FundingDistributionInput {
  destinations: ReadonlyArray<FundingDestinationInput>;
  /** Positivo — cuánto de saldo a favor se aplica en total. 0 si no aplica. */
  creditAppliedCents: number;
  /** Positivo — cuánto de la diferencia cubre el redondeo absorbido por la oficina. 0 si no aplica. */
  roundingCoverageCents: number;
}

export interface FundingDistributionResult {
  destinations: DestinationFundingBreakdown[];
  /** Crédito realmente consumido por algún destino — puede ser < creditAppliedCents pedido (ver unconsumedCreditCents). */
  creditConsumedCents: number;
  /** Redondeo realmente consumido por algún destino. */
  roundingConsumedCents: number;
  /** Agregado de cash (dinero nuevo) por complemento, sumado en todos los destinos. */
  cashAggregateCents: number;
  /** Crédito pedido que no pudo aplicarse a ningún destino (excedente sin destino que lo absorba) — 0 en el uso normal. */
  unconsumedCreditCents: number;
  /** Redondeo pedido que no pudo aplicarse a ningún destino (excedente sin destino que lo absorba) — 0 en el uso normal. */
  unconsumedRoundingCents: number;
}

/**
 * Distribuye crédito y redondeo sobre destinations según la prioridad fija
 * de cabecera, y calcula el cash agregado de cada destino por complemento
 * (nominalCents − creditCents − roundingCents). No valida cierre — para eso
 * ver validateFundingDistribution, un paso separado y explícito.
 */
export function distributeAccountHolderFunding(input: FundingDistributionInput): FundingDistributionResult {
  assertPlainObject("input", input);
  assertArray("input.destinations", input.destinations);
  assertSafeAmountCents("creditAppliedCents", input.creditAppliedCents, { min: 0 });
  assertSafeAmountCents("roundingCoverageCents", input.roundingCoverageCents, { min: 0 });

  if (input.destinations.length === 0) {
    throw new FundingValidationError("destinations no puede estar vacío: no hay ningún destino sobre el cual distribuir fondos.");
  }

  const seenDestinationIds = new Set<string>();
  input.destinations.forEach((d, index) => {
    assertPlainObject(`El destino en la posición ${index}`, d);
    assertCanonicalId(`El id del destino en la posición ${index}`, d.id);

    if (seenDestinationIds.has(d.id)) {
      throw new FundingValidationError(`El id de destino "${d.id}" está duplicado — cada destino debe tener un id único.`);
    }
    seenDestinationIds.add(d.id);

    if (d.kind !== "payment" && d.kind !== "pronto_pago") {
      throw new FundingValidationError(`El destino ${d.id} tiene un kind inválido: ${String(d.kind)}. Debe ser "payment" o "pronto_pago".`);
    }

    assertSafeAmountCents(`El destino ${d.id} (nominalCents)`, d.nominalCents, { min: 1 });
  });

  const paymentIds = input.destinations.filter((d) => d.kind === "payment").map((d) => d.id);
  const prontoPagoIds = input.destinations.filter((d) => d.kind === "pronto_pago").map((d) => d.id);
  const remainingCentsById = new Map<string, number>(input.destinations.map((d) => [d.id, d.nominalCents]));

  const credit = waterfallCreditOrRounding(input.creditAppliedCents, paymentIds, prontoPagoIds, remainingCentsById);
  const rounding = waterfallCreditOrRounding(input.roundingCoverageCents, paymentIds, prontoPagoIds, remainingCentsById);

  let cashAggregateCents = 0;
  const destinations: DestinationFundingBreakdown[] = input.destinations.map((d) => {
    const creditCents = credit.portionsById.get(d.id) ?? 0;
    const roundingCents = rounding.portionsById.get(d.id) ?? 0;
    const cashCents = d.nominalCents - creditCents - roundingCents;
    cashAggregateCents += cashCents;
    return { id: d.id, kind: d.kind, nominalCents: d.nominalCents, creditCents, roundingCents, cashCents };
  });

  assertSafeAggregateCents("cashAggregateCents", cashAggregateCents);

  return {
    destinations,
    creditConsumedCents: input.creditAppliedCents - credit.unconsumedCents,
    roundingConsumedCents: input.roundingCoverageCents - rounding.unconsumedCents,
    cashAggregateCents,
    unconsumedCreditCents: credit.unconsumedCents,
    unconsumedRoundingCents: rounding.unconsumedCents,
  };
}

// ─── Validación de cierre exacto ────────────────────────────────────────────

export interface FundingDistributionExpectations {
  creditAppliedCents: number;
  roundingCoverageCents: number;
}

/**
 * Rechaza si algún destino no cierra exacto (cash+crédito+redondeo !==
 * nominal), si las sumas por fuente no coinciden con lo pedido, si quedó
 * crédito/redondeo sin consumir (excedente ofrecido por el caller por
 * encima de lo que este lote necesita), o si el resultado en sí está mal
 * formado (ids duplicados, importes no enteros, negativos o nominal <= 0).
 * Nunca "ajusta" para que cierre — una discrepancia acá es un bug real de
 * cableado, no algo para ocultar (mismo criterio que
 * assertAdeudadosDetalleMatchesTotal en caja-summary.ts).
 */
export function validateFundingDistribution(
  result: FundingDistributionResult,
  expected: FundingDistributionExpectations
): void {
  assertPlainObject("result", result);
  assertPlainObject("expected", expected);
  assertArray("result.destinations", result.destinations);

  for (const [label, value] of [
    ["result.creditConsumedCents", result.creditConsumedCents],
    ["result.roundingConsumedCents", result.roundingConsumedCents],
    ["result.cashAggregateCents", result.cashAggregateCents],
    ["result.unconsumedCreditCents", result.unconsumedCreditCents],
    ["result.unconsumedRoundingCents", result.unconsumedRoundingCents],
  ] as const) {
    assertSafeAmountCents(label, value, { min: 0 });
  }
  assertSafeAmountCents("expected.creditAppliedCents", expected.creditAppliedCents, { min: 0 });
  assertSafeAmountCents("expected.roundingCoverageCents", expected.roundingCoverageCents, { min: 0 });

  const seenDestinationIds = new Set<string>();
  result.destinations.forEach((d, index) => {
    assertPlainObject(`El destino del resultado en la posición ${index}`, d);
    assertCanonicalId(`El id del destino del resultado en la posición ${index}`, d.id);

    if (seenDestinationIds.has(d.id)) {
      throw new FundingValidationError(
        `El id de destino "${d.id}" está duplicado en el resultado — no se puede validar un resultado con ids repetidos.`
      );
    }
    seenDestinationIds.add(d.id);

    const numericFields: Array<[string, number]> = [
      ["nominalCents", d.nominalCents],
      ["cashCents", d.cashCents],
      ["creditCents", d.creditCents],
      ["roundingCents", d.roundingCents],
    ];
    for (const [field, value] of numericFields) {
      if (!Number.isSafeInteger(value)) {
        throw new FundingValidationError(`El destino ${d.id} tiene ${field} inválido (no es un entero seguro en centavos): ${value}.`);
      }
    }
    if (d.nominalCents <= 0) {
      throw new FundingValidationError(`El destino ${d.id} tiene nominalCents inválido: debe ser > 0 (recibido ${d.nominalCents}).`);
    }
    if (d.cashCents < 0 || d.creditCents < 0 || d.roundingCents < 0) {
      throw new FundingValidationError(
        `El destino ${d.id} tiene un componente negativo (cash=${d.cashCents}, credit=${d.creditCents}, rounding=${d.roundingCents}).`
      );
    }

    const sum = d.cashCents + d.creditCents + d.roundingCents;
    if (sum !== d.nominalCents) {
      throw new FundingValidationError(
        `El destino ${d.id} no cierra: cash+crédito+redondeo=$${(sum / 100).toFixed(2)}, nominal=$${(d.nominalCents / 100).toFixed(2)}.`
      );
    }
  });

  if (result.unconsumedCreditCents > 0) {
    throw new FundingValidationError(
      `Crédito ofrecido en exceso: quedaron $${(result.unconsumedCreditCents / 100).toFixed(2)} de crédito sin destino que los absorba.`
    );
  }
  if (result.unconsumedRoundingCents > 0) {
    throw new FundingValidationError(
      `Redondeo ofrecido en exceso: quedaron $${(result.unconsumedRoundingCents / 100).toFixed(2)} de redondeo sin destino que los absorba.`
    );
  }
  if (result.creditConsumedCents !== expected.creditAppliedCents) {
    throw new FundingValidationError(
      `El crédito consumido ($${(result.creditConsumedCents / 100).toFixed(2)}) no coincide con el solicitado ($${(expected.creditAppliedCents / 100).toFixed(2)}).`
    );
  }
  if (result.roundingConsumedCents !== expected.roundingCoverageCents) {
    throw new FundingValidationError(
      `El redondeo consumido ($${(result.roundingConsumedCents / 100).toFixed(2)}) no coincide con el solicitado ($${(expected.roundingCoverageCents / 100).toFixed(2)}).`
    );
  }
  const sumCredit = result.destinations.reduce((s, d) => s + d.creditCents, 0);
  const sumRounding = result.destinations.reduce((s, d) => s + d.roundingCents, 0);
  const sumCash = result.destinations.reduce((s, d) => s + d.cashCents, 0);
  if (sumCredit !== expected.creditAppliedCents) {
    throw new FundingValidationError(`La suma de crédito por destino ($${(sumCredit / 100).toFixed(2)}) no coincide con lo aplicado.`);
  }
  if (sumRounding !== expected.roundingCoverageCents) {
    throw new FundingValidationError(`La suma de redondeo por destino ($${(sumRounding / 100).toFixed(2)}) no coincide con lo cubierto.`);
  }
  if (sumCash !== result.cashAggregateCents) {
    throw new FundingValidationError(`La suma de cash por destino no coincide con cashAggregateCents.`);
  }
}

// ─── Conversión de signo — payment_amount_adjustments (cobertura de faltante) ──
//
// Convención existente del campo (ver insured-account.ts,
// calculateBatchReceivedAppliedDifference): amountCents = receivedCents −
// appliedCents. Cuando lo que se absorbe es un FALTANTE (recibido+aplicado
// de otras fuentes < aplicado total), ese valor es NEGATIVO. roundingCoverageCents
// en este módulo es siempre POSITIVO ("cuánto de la diferencia cubre el
// redondeo") — nunca sumar directo el valor guardado en la fila como si fuera
// un aporte positivo; usar siempre estas dos funciones, nunca el signo crudo.

/** Dominio (positivo) → BD (negativo). roundingCoverageCents debe ser > 0. */
export function roundingAdjustmentAmountCentsForShortfall(roundingCoverageCents: number): number {
  if (!Number.isInteger(roundingCoverageCents) || roundingCoverageCents <= 0) {
    throw new FundingValidationError(`roundingCoverageCents debe ser un entero positivo: ${roundingCoverageCents}.`);
  }
  return -roundingCoverageCents;
}

/** BD (negativo) → dominio (positivo). El valor guardado debe ser negativo (cobertura de faltante, nunca sobrante). */
export function roundingCoverageCentsFromStoredAdjustment(storedAmountCents: number): number {
  if (!Number.isInteger(storedAmountCents) || storedAmountCents >= 0) {
    throw new FundingValidationError(
      `El ajuste guardado debe ser negativo para representar cobertura de un faltante: ${storedAmountCents}.`
    );
  }
  return -storedAmountCents;
}
