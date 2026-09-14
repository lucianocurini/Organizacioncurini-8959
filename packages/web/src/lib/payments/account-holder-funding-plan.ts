// Etapa 1B-2A ("planificación financiera superior y matriz determinista de
// allocations", ver diagnóstico de diseño de "cuenta corriente con titular de
// cuenta" cerrado en la conversación de sobrantes/faltantes, 2026-09). Sin
// DB, sin HTTP — mismo criterio que account-holder-funding.ts (Etapa 0), que
// este módulo REUTILIZA en vez de duplicar. Ningún endpoint usa todavía este
// módulo (eso es Etapa 1B-2B/1B-3).
//
// ─── Alcance ─────────────────────────────────────────────────────────────
//
// Objetivo 1 (planAccountHolderBatchFunding): dado un lote con destinos,
// splits reales, crédito a aplicar, redondeo a absorber, crédito disponible
// y si hay autorización de deuda, decide de forma determinista si el lote
// cierra exacto, genera saldo a favor nuevo o requiere saldo deudor nuevo —
// reutilizando el waterfall crédito→primas→pronto_pago→redondeo de Etapa 0
// (distributeAccountHolderFunding/validateFundingDistribution), nunca
// reimplementándolo.
//
// Objetivo 2 (buildFundingAllocationDrafts / validateAccountHolderFundingAllocations):
// construye y valida una matriz de allocations fuente→destino, conceptualmente
// compatible con payment_batch_funding_allocations (migración 0036) pero SIN
// ningún id real de DB — son drafts puros para que una etapa futura (1B-2B/
// 1B-3) los traduzca a filas reales. Mapeo conceptual a futuro (documentado,
// no implementado acá):
//   split               -> payment_batch_split_id
//   credit_movement     -> source_account_movement_id (type=aplicacion_saldo_favor)
//   debt_movement       -> source_account_movement_id (type=saldo_deudor)
//   rounding_adjustment -> payment_amount_adjustment_id
//   payment             -> payment_id
//   pronto_pago         -> cash_entry_id
//   new_credit_movement -> destination_account_movement_id (type=saldo_a_favor)

import {
  distributeAccountHolderFunding,
  validateFundingDistribution,
  type FundingDestinationInput,
  type FundingDestinationKind,
  type DestinationFundingBreakdown,
} from "./account-holder-funding";
import { MAX_ROUNDING_ADJUSTMENT_CENTS } from "./insured-account";

export class AccountHolderFundingPlanError extends Error {}

// ─── Validación de importes en centavos (mismo criterio que Etapa 0) ───────

function assertSafeAmountCents(label: string, value: number, options: { min: number }): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AccountHolderFundingPlanError(`${label} debe ser un entero seguro en centavos (recibido: ${value}).`);
  }
  if (value < options.min) {
    throw new AccountHolderFundingPlanError(`${label} no puede ser menor a ${options.min} centavos (recibido: ${value}).`);
  }
}

function assertSafeAggregateCents(label: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new AccountHolderFundingPlanError(`${label} dejó de ser un entero seguro en centavos — posible desborde (valor: ${value}).`);
  }
}

function sumCentsSafe(label: string, values: ReadonlyArray<number>): number {
  let total = 0;
  for (const v of values) {
    total += v;
    assertSafeAggregateCents(label, total);
  }
  return total;
}

// ─── Validación de forma de entradas (objetos/arrays), booleanos estrictos ──
// e ids canónicos — mismo criterio que account-holder-funding.ts (Etapa 0),
// duplicado acá porque este módulo tiene su propia clase de error de dominio
// (AccountHolderFundingPlanError) y es dueño de su propio contrato de
// entrada (PlanAccountHolderBatchFundingInput, FundingAllocationDraft) — ver
// cabecera de archivo. Nunca debe escapar un TypeError crudo por acceder a
// una propiedad de undefined/null/malformado.

function assertPlainObject(label: string, value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AccountHolderFundingPlanError(
      `${label} debe ser un objeto (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`
    );
  }
}

function assertArray(label: string, value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new AccountHolderFundingPlanError(`${label} debe ser un array (recibido: ${value === null ? "null" : typeof value}).`);
  }
}

function assertCanonicalId(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new AccountHolderFundingPlanError(`${label} debe ser un string (recibido: ${value === null ? "null" : typeof value}).`);
  }
  if (value.trim() === "") {
    throw new AccountHolderFundingPlanError(`${label} no puede estar vacío ni compuesto solo de espacios.`);
  }
  if (value !== value.trim()) {
    throw new AccountHolderFundingPlanError(
      `${label} no puede tener espacios al inicio o al final (recibido: "${value}") — se rechaza en vez de recortar.`
    );
  }
}

/**
 * debtAuthorized decide si se autoriza a generar deuda nueva — nunca debe
 * aceptarse por coerción truthy/falsy (un string "false" es truthy en JS y
 * autorizaría deuda por accidente). Se exige exactamente true o false, y se
 * comprueba antes de cualquier decisión financiera.
 */
function assertStrictBoolean(label: string, value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new AccountHolderFundingPlanError(
      `${label} debe ser exactamente true o false (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`
    );
  }
}

// ─── Objetivo 1 — planificación financiera superior ────────────────────────

export interface FundingPlanSplitInput {
  id: string;
  amountCents: number;
}

export interface PlanAccountHolderBatchFundingInput {
  destinations: ReadonlyArray<FundingDestinationInput>;
  /** Orden exacto en que se reciben — determina la matriz de allocations (ver Objetivo 2). */
  realSplits: ReadonlyArray<FundingPlanSplitInput>;
  creditAppliedCents: number;
  roundingCoverageCents: number;
  availableCreditCents: number;
  debtAuthorized: boolean;
}

// ─── Objetivo 2 — matriz de allocations ─────────────────────────────────────

export type FundingAllocationSourceKind = "split" | "credit_movement" | "debt_movement" | "rounding_adjustment";
export type FundingAllocationDestinationKind = "payment" | "pronto_pago" | "new_credit_movement";

export interface FundingAllocationDraft {
  sourceKind: FundingAllocationSourceKind;
  sourceKey: string;
  destinationKind: FundingAllocationDestinationKind;
  destinationKey: string;
  amountCents: number;
}

export interface FundingPlanControlTotals {
  /** realSplitsTotalCents + creditAppliedCents + roundingCoverageCents + newSaldoDeudorCents */
  sourcesTotalCents: number;
  /** nominalTotalCents + newSaldoAFavorCents */
  destinationsTotalCents: number;
}

export interface AccountHolderFundingPlanResult {
  /** Distribución de Etapa 0 por destino (crédito/redondeo/cash agregado) — pasada tal cual. */
  destinations: DestinationFundingBreakdown[];
  nominalTotalCents: number;
  realSplitsTotalCents: number;
  /** Sin modificar respecto de la entrada — nunca se reduce silenciosamente (regla 6). */
  creditAppliedCents: number;
  /** Sin modificar respecto de la entrada — nunca se reduce silenciosamente (regla 6). */
  roundingCoverageCents: number;
  newSaldoAFavorCents: number;
  newSaldoDeudorCents: number;
  allocations: FundingAllocationDraft[];
  totals: FundingPlanControlTotals;
}

const CREDIT_SOURCE_KEY = "credit_movement";
const ROUNDING_SOURCE_KEY = "rounding_adjustment";
const DEBT_SOURCE_KEY = "debt_movement";
const NEW_CREDIT_DESTINATION_KEY = "new_credit_movement";

/**
 * Decide, de forma determinista, cómo cierra un lote con titular de cuenta:
 * reparte crédito/redondeo sobre los destinos (reutilizando Etapa 0), calcula
 * el faltante o excedente real remanente y produce, según corresponda, un
 * saldo a favor nuevo o un saldo deudor nuevo — nunca ambos a la vez (regla
 * 11). No escribe nada: es un helper puro de planificación.
 *
 * Unifica las reglas 7-10 del diseño en una sola cuenta:
 *   shortfallAfterCredit = nominalTotalCents - (realSplitsTotalCents + creditAppliedCents)
 *   remainingAfterRounding = shortfallAfterCredit - roundingCoverageCents
 * remainingAfterRounding > 0 -> falta plata (deuda, si está autorizada).
 * remainingAfterRounding = 0 -> cierra exacto.
 * remainingAfterRounding < 0 -> sobra plata real (saldo a favor, solo si
 *   creditAppliedCents=0 — con crédito>0 esto es sobre-fondeo, error explícito).
 */
export function planAccountHolderBatchFunding(input: PlanAccountHolderBatchFundingInput): AccountHolderFundingPlanResult {
  assertPlainObject("input", input);
  // debtAuthorized se comprueba temprano, antes de tocar destinations/splits
  // o de tomar cualquier decisión financiera — nunca por coerción truthy.
  assertStrictBoolean("input.debtAuthorized", input.debtAuthorized);
  assertArray("input.realSplits", input.realSplits);
  assertSafeAmountCents("availableCreditCents", input.availableCreditCents, { min: 0 });

  // Reutiliza el waterfall de Etapa 0 — valida destinations (no vacío, ids
  // únicos/canónicos, kind válido, nominalCents entero seguro > 0) y
  // creditAppliedCents/roundingCoverageCents (enteros seguros >= 0) de una
  // sola vez, sin reimplementar nada de esa lógica acá. El contrato de
  // destinations es de account-holder-funding.ts, así que un destinations
  // malformado se rechaza ahí con FundingValidationError, no acá.
  const distribution = distributeAccountHolderFunding({
    destinations: input.destinations,
    creditAppliedCents: input.creditAppliedCents,
    roundingCoverageCents: input.roundingCoverageCents,
  });

  if (input.creditAppliedCents > input.availableCreditCents) {
    throw new AccountHolderFundingPlanError(
      `El crédito aplicado ($${(input.creditAppliedCents / 100).toFixed(2)}) supera el crédito disponible ($${(input.availableCreditCents / 100).toFixed(2)}).`
    );
  }

  const seenSplitIds = new Set<string>();
  input.realSplits.forEach((split, index) => {
    assertPlainObject(`El split real en la posición ${index}`, split);
    assertCanonicalId(`El id del split real en la posición ${index}`, split.id);
    if (seenSplitIds.has(split.id)) {
      throw new AccountHolderFundingPlanError(`El id de split "${split.id}" está duplicado — cada split real debe tener un id único.`);
    }
    seenSplitIds.add(split.id);
    assertSafeAmountCents(`El split ${split.id} (amountCents)`, split.amountCents, { min: 1 });
  });

  const nominalTotalCents = sumCentsSafe(
    "nominalTotalCents",
    distribution.destinations.map((d) => d.nominalCents)
  );
  const realSplitsTotalCents = sumCentsSafe(
    "realSplitsTotalCents",
    input.realSplits.map((s) => s.amountCents)
  );

  const fundedBeforeRounding = realSplitsTotalCents + input.creditAppliedCents;
  assertSafeAggregateCents("realSplitsTotalCents + creditAppliedCents", fundedBeforeRounding);
  const shortfallAfterCredit = nominalTotalCents - fundedBeforeRounding;

  if (input.roundingCoverageCents > 0) {
    if (shortfallAfterCredit <= 0) {
      throw new AccountHolderFundingPlanError(
        "El redondeo no puede aplicarse: no hay faltante real después de dinero y crédito."
      );
    }
    if (input.roundingCoverageCents > MAX_ROUNDING_ADJUSTMENT_CENTS) {
      throw new AccountHolderFundingPlanError(
        `El redondeo ($${(input.roundingCoverageCents / 100).toFixed(2)}) supera el máximo permitido ($${(MAX_ROUNDING_ADJUSTMENT_CENTS / 100).toFixed(2)}).`
      );
    }
    if (input.roundingCoverageCents > shortfallAfterCredit) {
      throw new AccountHolderFundingPlanError(
        `El redondeo ($${(input.roundingCoverageCents / 100).toFixed(2)}) supera el faltante real pendiente ($${(shortfallAfterCredit / 100).toFixed(2)}).`
      );
    }
  }

  const remainingAfterRounding = shortfallAfterCredit - input.roundingCoverageCents;
  assertSafeAggregateCents("shortfallAfterCredit - roundingCoverageCents", remainingAfterRounding);

  let newSaldoAFavorCents = 0;
  let newSaldoDeudorCents = 0;

  if (remainingAfterRounding > 0) {
    if (!input.debtAuthorized) {
      throw new AccountHolderFundingPlanError(
        `Queda un faltante de $${(remainingAfterRounding / 100).toFixed(2)} sin autorización de deuda (debtAuthorized=false).`
      );
    }
    newSaldoDeudorCents = remainingAfterRounding;
  } else if (remainingAfterRounding < 0) {
    const excessCents = -remainingAfterRounding;
    if (input.creditAppliedCents > 0) {
      throw new AccountHolderFundingPlanError(
        `Sobre-fondeo con crédito aplicado: dinero real + crédito superan el nominal por $${(excessCents / 100).toFixed(2)} y creditAppliedCents > 0.`
      );
    }
    if (input.roundingCoverageCents > 0) {
      // Estructuralmente inalcanzable: si roundingCoverageCents > 0 ya
      // exigimos shortfallAfterCredit > 0 arriba, lo que impide
      // remainingAfterRounding < 0. Se deja como cierre defensivo explícito
      // de la regla 8 (saldo a favor nunca con redondeo aplicado).
      throw new AccountHolderFundingPlanError("Invariante violada: no puede generarse saldo a favor con redondeo aplicado.");
    }
    newSaldoAFavorCents = excessCents;
  }

  if (newSaldoAFavorCents > 0 && newSaldoDeudorCents > 0) {
    throw new AccountHolderFundingPlanError("Invariante violada: saldo a favor y saldo deudor no pueden coexistir.");
  }

  // Cierre defensivo final, reutilizando el validador de Etapa 0 — nunca
  // debería disparar dado lo anterior, pero es la misma garantía que ya usa
  // el resto del proyecto (ver validateFundingDistribution / aplicadores de
  // migración) de no informar éxito sin re-chequear la postcondición.
  validateFundingDistribution(distribution, {
    creditAppliedCents: input.creditAppliedCents,
    roundingCoverageCents: input.roundingCoverageCents,
  });

  const allocations = buildFundingAllocationDrafts({
    destinations: distribution.destinations,
    realSplits: input.realSplits,
    newSaldoDeudorCents,
    newSaldoAFavorCents,
  });

  const sourcesTotalCents = realSplitsTotalCents + input.creditAppliedCents + input.roundingCoverageCents + newSaldoDeudorCents;
  const destinationsTotalCents = nominalTotalCents + newSaldoAFavorCents;
  assertSafeAggregateCents("sourcesTotalCents", sourcesTotalCents);
  assertSafeAggregateCents("destinationsTotalCents", destinationsTotalCents);
  if (sourcesTotalCents !== destinationsTotalCents) {
    throw new AccountHolderFundingPlanError(
      `La ecuación final no cierra: fuentes=$${(sourcesTotalCents / 100).toFixed(2)}, destinos=$${(destinationsTotalCents / 100).toFixed(2)}.`
    );
  }

  return {
    destinations: distribution.destinations,
    nominalTotalCents,
    realSplitsTotalCents,
    creditAppliedCents: input.creditAppliedCents,
    roundingCoverageCents: input.roundingCoverageCents,
    newSaldoAFavorCents,
    newSaldoDeudorCents,
    allocations,
    totals: { sourcesTotalCents, destinationsTotalCents },
  };
}

// ─── Construcción de la matriz (privado — usado solo desde el plan) ────────

interface CashSource {
  kind: "split" | "debt_movement";
  key: string;
  amountCents: number;
}

interface CashDestination {
  kind: FundingDestinationKind | "new_credit_movement";
  key: string;
  amountCents: number;
}

/**
 * Construye los drafts fuente->destino. Crédito y redondeo salen directo del
 * breakdown por destino de Etapa 0 (no requieren waterfall propio: ya vienen
 * resueltos). El cash agregado de cada destino se reparte entre los splits
 * reales (en el ORDEN EXACTO recibido — cambiar ese orden cambia qué fila de
 * la matriz cubre qué destino, aunque los totales por fuente/destino sigan
 * siendo los mismos) y, si hace falta, el saldo deudor nuevo como última
 * fuente virtual. Los destinos de cash se recorren en el orden comercial de
 * Etapa 0 (payment primero, pronto_pago después) y, si sobra dinero real,
 * new_credit_movement es el último destino. Determinista: misma entrada,
 * misma matriz. No emite filas de monto 0.
 */
function buildFundingAllocationDrafts(args: {
  destinations: ReadonlyArray<DestinationFundingBreakdown>;
  realSplits: ReadonlyArray<FundingPlanSplitInput>;
  newSaldoDeudorCents: number;
  newSaldoAFavorCents: number;
}): FundingAllocationDraft[] {
  const drafts: FundingAllocationDraft[] = [];

  for (const d of args.destinations) {
    if (d.creditCents > 0) {
      drafts.push({
        sourceKind: "credit_movement",
        sourceKey: CREDIT_SOURCE_KEY,
        destinationKind: d.kind,
        destinationKey: String(d.id),
        amountCents: d.creditCents,
      });
    }
  }
  for (const d of args.destinations) {
    if (d.roundingCents > 0) {
      drafts.push({
        sourceKind: "rounding_adjustment",
        sourceKey: ROUNDING_SOURCE_KEY,
        destinationKind: d.kind,
        destinationKey: String(d.id),
        amountCents: d.roundingCents,
      });
    }
  }

  const cashSources: CashSource[] = args.realSplits
    .filter((s) => s.amountCents > 0)
    .map((s) => ({ kind: "split" as const, key: s.id, amountCents: s.amountCents }));
  if (args.newSaldoDeudorCents > 0) {
    cashSources.push({ kind: "debt_movement", key: DEBT_SOURCE_KEY, amountCents: args.newSaldoDeudorCents });
  }

  const cashDestinations: CashDestination[] = [
    ...args.destinations.filter((d) => d.kind === "payment" && d.cashCents > 0).map((d) => ({ kind: d.kind, key: String(d.id), amountCents: d.cashCents })),
    ...args.destinations.filter((d) => d.kind === "pronto_pago" && d.cashCents > 0).map((d) => ({ kind: d.kind, key: String(d.id), amountCents: d.cashCents })),
  ];
  if (args.newSaldoAFavorCents > 0) {
    cashDestinations.push({ kind: "new_credit_movement", key: NEW_CREDIT_DESTINATION_KEY, amountCents: args.newSaldoAFavorCents });
  }

  let si = 0;
  let di = 0;
  let sourceRemaining = cashSources[0]?.amountCents ?? 0;
  let destRemaining = cashDestinations[0]?.amountCents ?? 0;

  while (si < cashSources.length && di < cashDestinations.length) {
    const amount = Math.min(sourceRemaining, destRemaining);
    if (amount > 0) {
      const source = cashSources[si]!;
      const dest = cashDestinations[di]!;
      drafts.push({
        sourceKind: source.kind,
        sourceKey: source.key,
        destinationKind: dest.kind,
        destinationKey: dest.key,
        amountCents: amount,
      });
    }
    sourceRemaining -= amount;
    destRemaining -= amount;
    if (sourceRemaining === 0) {
      si += 1;
      sourceRemaining = cashSources[si]?.amountCents ?? 0;
    }
    if (destRemaining === 0) {
      di += 1;
      destRemaining = cashDestinations[di]?.amountCents ?? 0;
    }
  }

  // Defensivo: por construcción cashSources y cashDestinations suman lo
  // mismo (ver la ecuación final validada en planAccountHolderBatchFunding)
  // — si alguno quedó con capacidad sin consumir, es un bug real de cableado.
  if (si !== cashSources.length || di !== cashDestinations.length) {
    throw new AccountHolderFundingPlanError(
      "Los totales de fuentes y destinos de cash no cierran — no se pudo construir la matriz de allocations."
    );
  }

  return drafts;
}

// ─── Validación pura de la matriz ───────────────────────────────────────────

export interface FundingPlanAllocationExpectations {
  /** Ground truth externa — nunca se toma del plan mismo, para poder detectar manipulación del propio plan. */
  realSplits: ReadonlyArray<FundingPlanSplitInput>;
}

const ALLOWED_SOURCE_KINDS: ReadonlySet<FundingAllocationSourceKind> = new Set([
  "split",
  "credit_movement",
  "debt_movement",
  "rounding_adjustment",
]);
const ALLOWED_DESTINATION_KINDS: ReadonlySet<FundingAllocationDestinationKind> = new Set([
  "payment",
  "pronto_pago",
  "new_credit_movement",
]);

/**
 * Revalida un AccountHolderFundingPlanResult de punta a punta: cierre exacto
 * por cada fuente (cada split por su amountCents, credit_movement por
 * creditAppliedCents, debt_movement por newSaldoDeudorCents,
 * rounding_adjustment por roundingCoverageCents) y por cada destino (cada
 * payment/pronto_pago por su nominal, new_credit_movement por
 * newSaldoAFavorCents); rechaza fuentes/destinos desconocidos (lo que
 * también garantiza que el grafo sea bipartito — sourceKind y
 * destinationKind son conjuntos disjuntos por construcción, así que no hay
 * ciclos posibles), montos no enteros/<=0, sumas agregadas que desborden, y
 * cualquier divergencia entre los totales declarados en el plan (incluidos
 * nominalTotalCents/realSplitsTotalCents/totals) y lo recalculado desde
 * destinations/expected.realSplits — alterar manualmente cualquier monto,
 * en una allocation o en un campo agregado del plan, se detecta acá.
 */
export function validateAccountHolderFundingAllocations(
  plan: AccountHolderFundingPlanResult,
  expected: FundingPlanAllocationExpectations
): void {
  assertPlainObject("plan", plan);
  assertPlainObject("expected", expected);
  assertArray("plan.destinations", plan.destinations);
  assertArray("plan.allocations", plan.allocations);
  assertArray("expected.realSplits", expected.realSplits);
  assertPlainObject("plan.totals", plan.totals);

  for (const [label, value] of [
    ["nominalTotalCents", plan.nominalTotalCents],
    ["realSplitsTotalCents", plan.realSplitsTotalCents],
    ["creditAppliedCents", plan.creditAppliedCents],
    ["roundingCoverageCents", plan.roundingCoverageCents],
    ["newSaldoAFavorCents", plan.newSaldoAFavorCents],
    ["newSaldoDeudorCents", plan.newSaldoDeudorCents],
  ] as const) {
    assertSafeAmountCents(label, value, { min: 0 });
  }
  assertSafeAmountCents("plan.totals.sourcesTotalCents", plan.totals.sourcesTotalCents, { min: 0 });
  assertSafeAmountCents("plan.totals.destinationsTotalCents", plan.totals.destinationsTotalCents, { min: 0 });

  if (plan.newSaldoAFavorCents > 0 && plan.newSaldoDeudorCents > 0) {
    throw new AccountHolderFundingPlanError("El plan tiene saldo a favor y saldo deudor simultáneos — invariante violada.");
  }

  const seenPlanDestinationIds = new Set<string>();
  plan.destinations.forEach((d, index) => {
    assertPlainObject(`El destino del plan en la posición ${index}`, d);
    assertCanonicalId(`El id del destino del plan en la posición ${index}`, d.id);
    if (d.kind !== "payment" && d.kind !== "pronto_pago") {
      throw new AccountHolderFundingPlanError(`El destino ${d.id} del plan tiene un kind inválido: ${String(d.kind)}.`);
    }
    assertSafeAmountCents(`El destino ${d.id} del plan (nominalCents)`, d.nominalCents, { min: 1 });
    if (seenPlanDestinationIds.has(d.id)) {
      throw new AccountHolderFundingPlanError(`El id de destino "${d.id}" está duplicado en el plan.`);
    }
    seenPlanDestinationIds.add(d.id);
  });

  const seenExpectedSplitIds = new Set<string>();
  expected.realSplits.forEach((s, index) => {
    assertPlainObject(`El split esperado en la posición ${index}`, s);
    assertCanonicalId(`El id del split esperado en la posición ${index}`, s.id);
    assertSafeAmountCents(`El split esperado ${s.id} (amountCents)`, s.amountCents, { min: 1 });
    if (seenExpectedSplitIds.has(s.id)) {
      throw new AccountHolderFundingPlanError(`El id de split esperado "${s.id}" está duplicado.`);
    }
    seenExpectedSplitIds.add(s.id);
  });

  const recomputedNominal = sumCentsSafe(
    "nominalTotalCents (recalculado)",
    plan.destinations.map((d) => d.nominalCents)
  );
  if (recomputedNominal !== plan.nominalTotalCents) {
    throw new AccountHolderFundingPlanError(
      `nominalTotalCents fue alterado: declarado ${plan.nominalTotalCents}, recalculado desde destinations ${recomputedNominal}.`
    );
  }
  const recomputedRealSplitsTotal = sumCentsSafe(
    "realSplitsTotalCents (recalculado)",
    expected.realSplits.map((s) => s.amountCents)
  );
  if (recomputedRealSplitsTotal !== plan.realSplitsTotalCents) {
    throw new AccountHolderFundingPlanError(
      `realSplitsTotalCents fue alterado: declarado ${plan.realSplitsTotalCents}, recalculado desde los splits reales ${recomputedRealSplitsTotal}.`
    );
  }

  const sourcesTotalCents = plan.realSplitsTotalCents + plan.creditAppliedCents + plan.roundingCoverageCents + plan.newSaldoDeudorCents;
  const destinationsTotalCents = plan.nominalTotalCents + plan.newSaldoAFavorCents;
  assertSafeAggregateCents("sourcesTotalCents (recalculado)", sourcesTotalCents);
  assertSafeAggregateCents("destinationsTotalCents (recalculado)", destinationsTotalCents);
  if (sourcesTotalCents !== destinationsTotalCents) {
    throw new AccountHolderFundingPlanError(
      `La ecuación final no cierra: fuentes=${sourcesTotalCents}, destinos=${destinationsTotalCents}.`
    );
  }
  if (sourcesTotalCents !== plan.totals.sourcesTotalCents || destinationsTotalCents !== plan.totals.destinationsTotalCents) {
    throw new AccountHolderFundingPlanError("plan.totals fue alterado: no coincide con los totales recalculados.");
  }

  const splitAmountById = new Map(expected.realSplits.map((s) => [s.id, s.amountCents]));
  const destinationById = new Map(plan.destinations.map((d) => [String(d.id), d]));

  const sourceSums = new Map<string, number>();
  const destinationSums = new Map<string, number>();

  plan.allocations.forEach((a, index) => {
    assertPlainObject(`La allocation en la posición ${index}`, a);
    if (!ALLOWED_SOURCE_KINDS.has(a.sourceKind)) {
      throw new AccountHolderFundingPlanError(`sourceKind desconocido: ${String(a.sourceKind)}.`);
    }
    if (!ALLOWED_DESTINATION_KINDS.has(a.destinationKind)) {
      throw new AccountHolderFundingPlanError(`destinationKind desconocido: ${String(a.destinationKind)}.`);
    }
    assertCanonicalId(`El sourceKey de la allocation en la posición ${index}`, a.sourceKey);
    assertCanonicalId(`El destinationKey de la allocation en la posición ${index}`, a.destinationKey);
    if (!Number.isSafeInteger(a.amountCents) || a.amountCents <= 0) {
      throw new AccountHolderFundingPlanError(
        `La allocation ${a.sourceKind}:${a.sourceKey} -> ${a.destinationKind}:${a.destinationKey} tiene amountCents inválido: ${a.amountCents}.`
      );
    }
    if (a.sourceKind === "split" && !splitAmountById.has(a.sourceKey)) {
      throw new AccountHolderFundingPlanError(`La allocation referencia un split desconocido: "${a.sourceKey}".`);
    }
    if ((a.destinationKind === "payment" || a.destinationKind === "pronto_pago") && !destinationById.has(a.destinationKey)) {
      throw new AccountHolderFundingPlanError(`La allocation referencia un destino desconocido: "${a.destinationKey}".`);
    }
    if (a.destinationKind === "new_credit_movement" && a.sourceKind !== "split") {
      throw new AccountHolderFundingPlanError(
        `new_credit_movement solo puede recibir splits reales, nunca ${a.sourceKind} (fila ${a.sourceKind}:${a.sourceKey}).`
      );
    }

    const sKey = `${a.sourceKind}:${a.sourceKind === "split" ? a.sourceKey : ""}`;
    const nextSourceSum = (sourceSums.get(sKey) ?? 0) + a.amountCents;
    assertSafeAggregateCents(`La suma de la fuente ${sKey}`, nextSourceSum);
    sourceSums.set(sKey, nextSourceSum);

    const dKey = `${a.destinationKind}:${a.destinationKey}`;
    const nextDestinationSum = (destinationSums.get(dKey) ?? 0) + a.amountCents;
    assertSafeAggregateCents(`La suma del destino ${dKey}`, nextDestinationSum);
    destinationSums.set(dKey, nextDestinationSum);
  });

  for (const split of expected.realSplits) {
    const sum = sourceSums.get(`split:${split.id}`) ?? 0;
    if (sum !== split.amountCents) {
      throw new AccountHolderFundingPlanError(`El split "${split.id}" no cierra: allocations suman ${sum}, esperado ${split.amountCents}.`);
    }
  }

  const creditSum = sourceSums.get("credit_movement:") ?? 0;
  if (creditSum !== plan.creditAppliedCents) {
    throw new AccountHolderFundingPlanError(`credit_movement no cierra: allocations suman ${creditSum}, esperado ${plan.creditAppliedCents}.`);
  }
  const debtSum = sourceSums.get("debt_movement:") ?? 0;
  if (debtSum !== plan.newSaldoDeudorCents) {
    throw new AccountHolderFundingPlanError(`debt_movement no cierra: allocations suman ${debtSum}, esperado ${plan.newSaldoDeudorCents}.`);
  }
  const roundingSum = sourceSums.get("rounding_adjustment:") ?? 0;
  if (roundingSum !== plan.roundingCoverageCents) {
    throw new AccountHolderFundingPlanError(`rounding_adjustment no cierra: allocations suman ${roundingSum}, esperado ${plan.roundingCoverageCents}.`);
  }

  for (const d of plan.destinations) {
    const key = `${d.kind}:${String(d.id)}`;
    const sum = destinationSums.get(key) ?? 0;
    if (sum !== d.nominalCents) {
      throw new AccountHolderFundingPlanError(`El destino ${d.id} no cierra: allocations suman ${sum}, nominal ${d.nominalCents}.`);
    }
  }
  const newCreditSum = destinationSums.get(`new_credit_movement:${NEW_CREDIT_DESTINATION_KEY}`) ?? 0;
  if (newCreditSum !== plan.newSaldoAFavorCents) {
    throw new AccountHolderFundingPlanError(`new_credit_movement no cierra: allocations suman ${newCreditSum}, esperado ${plan.newSaldoAFavorCents}.`);
  }
}
