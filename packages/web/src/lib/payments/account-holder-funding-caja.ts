// Impacto en Caja de las allocations de financiación de un lote con titular
// de cuenta, en el momento en que cada destino se rinde a la compañía —
// Etapa 1B-2B-i ("helpers puros de Caja", ver diagnóstico de diseño de
// "cuenta corriente con titular de cuenta" cerrado en la conversación de
// sobrantes/faltantes, 2026-09). Sin DB, sin HTTP — mismo criterio que
// insured-account.ts/account-holder-funding-plan.ts: recibe datos ya
// resueltos por el endpoint (allocations reales, ya con el flag
// destinationRendered leído en vivo desde payments.rendered/
// cashEntries.rendered) y devuelve totales explícitos. Ningún endpoint usa
// todavía este módulo (eso es una etapa futura).
//
// ─── Regla de negocio confirmada (diagnóstico 1B-2B, 2026-09) ──────────────
//
// - Crédito aplicado (aplicacion_saldo_favor): un mismo movimiento agregado
//   puede financiar VARIOS destinos que se rinden en momentos distintos (ver
//   migración 0036) — el boolean todo-o-nada relatedPaymentRendered de
//   calculateCreditActiveInCaja (insured-account.ts) no alcanza para este
//   flujo. Acá el crédito consumido se reconoce PARCIALMENTE: solo la
//   porción cuyo destino ya está rendido deja de contar como crédito activo;
//   el resto sigue activo hasta que su destino también se rinda.
// - Saldo deudor cubierto por la oficina: NO afecta Caja mientras su destino
//   no se rinde (es un monto a recuperar, no plata que ya salió de la
//   oficina). Cuando el destino se rinde, la oficina le paga a la compañía
//   el nominal completo aunque el cliente no haya completado el pago — eso
//   es una salida real de Caja en ese momento, no antes.
// - Redondeo absorbido por la oficina: mismo criterio que saldo deudor —
//   pendiente/no rendido no afecta Caja; al rendirse el destino, la
//   diferencia que la oficina absorbió es una salida real de Caja.
// - Reversión: si la rendición de un destino se anula, destinationRendered
//   vuelve a false para ese destino. Caja se recalcula SIEMPRE en vivo desde
//   ese flag (nunca cachea un resultado anterior), así que el impacto
//   desaparece automáticamente en el próximo cálculo — no se crea ningún
//   movimiento inverso ni ajuste artificial. Este módulo no tiene una
//   función de "reversión": es la misma función de cálculo, invocada de
//   nuevo con el flag actualizado (ver tests de reversión).

export class AccountHolderFundingCajaError extends Error {}

// ─── Validación de forma de entradas — mismo criterio que
// account-holder-funding.ts/account-holder-funding-plan.ts, duplicado acá
// porque este módulo tiene su propia clase de error de dominio
// (AccountHolderFundingCajaError) y es dueño de su propio contrato de
// entrada (FundingAllocationRenderStatus). Nunca debe escapar un TypeError
// crudo por acceder a una propiedad de undefined/null/malformado.

function assertPlainObject(label: string, value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AccountHolderFundingCajaError(
      `${label} debe ser un objeto (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`
    );
  }
}

function assertArray(label: string, value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new AccountHolderFundingCajaError(`${label} debe ser un array (recibido: ${value === null ? "null" : typeof value}).`);
  }
}

/** IDs persistidos reales (insured_account_movements.id / payment_amount_adjustments.id) — siempre enteros seguros positivos. */
function assertSafePositiveId(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new AccountHolderFundingCajaError(`${label} debe ser un id entero seguro y positivo (recibido: ${value}).`);
  }
}

/** Importes en centavos — enteros seguros y estrictamente positivos (una allocation de monto 0 no debería existir, ver account-holder-funding-plan.ts regla 25). */
function assertSafePositiveAmountCents(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AccountHolderFundingCajaError(`${label} debe ser un entero seguro en centavos (recibido: ${value}).`);
  }
  if (value <= 0) {
    throw new AccountHolderFundingCajaError(`${label} debe ser positivo (recibido: ${value}).`);
  }
}

function assertSafeAggregateCents(label: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new AccountHolderFundingCajaError(`${label} dejó de ser un entero seguro en centavos — posible desborde (valor: ${value}).`);
  }
}

/** destinationRendered decide si la allocation ya golpeó Caja — nunca por coerción truthy/falsy (mismo criterio que debtAuthorized en account-holder-funding-plan.ts). */
function assertStrictBoolean(label: string, value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new AccountHolderFundingCajaError(
      `${label} debe ser exactamente true o false (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`
    );
  }
}

// ─── Contrato de entrada ─────────────────────────────────────────────────

export type FundingCajaSourceKind = "credit_movement" | "debt_movement" | "rounding_adjustment";

const ALLOWED_SOURCE_KINDS: ReadonlySet<string> = new Set<FundingCajaSourceKind>([
  "credit_movement",
  "debt_movement",
  "rounding_adjustment",
]);

export interface FundingAllocationRenderStatus {
  sourceKind: FundingCajaSourceKind;
  /** id real de insured_account_movements (credit_movement/debt_movement) o payment_amount_adjustments (rounding_adjustment). Solo se valida acá — la agregación es por sourceKind, no por sourceId (el pool es global, mismo criterio que calculateCreditActiveInCaja). */
  sourceId: number;
  amountCents: number;
  /** Leído EN VIVO desde payments.rendered/cashEntries.rendered del destino de esta allocation en el momento del cálculo — nunca un valor cacheado. */
  destinationRendered: boolean;
}

export interface AllocationRenderedCajaImpact {
  /** Crédito consumido cuyo destino todavía NO se rindió — sigue contando como crédito activo, Caja no baja todavía. */
  creditConsumedPendingCents: number;
  /** Crédito consumido cuyo destino YA se rindió — deja de contar como crédito activo (resta de Caja). */
  creditConsumedRenderedCents: number;
  /** Saldo deudor cuyo destino todavía no se rindió — no afecta Caja. */
  debtPendingCents: number;
  /** Saldo deudor cuyo destino ya se rindió — salida real de Caja (gasto reconocido al rendir). */
  debtRenderedExpenseCents: number;
  /** Redondeo cuyo destino todavía no se rindió — no afecta Caja. */
  roundingPendingCents: number;
  /** Redondeo cuyo destino ya se rindió — salida real de Caja (gasto reconocido al rendir). */
  roundingRenderedExpenseCents: number;
}

/**
 * Calcula, a partir de un conjunto de allocations con su estado de render ya
 * resuelto, el impacto agregado en Caja: cuánto crédito sigue pendiente vs.
 * ya consumido en Caja, y cuánto de saldo deudor/redondeo se convirtió en
 * gasto real de Caja porque su destino ya se rindió. Admite allocations
 * parciales del mismo movimiento agregado (varias filas con el mismo
 * sourceId, algunas rendidas y otras no) sin ningún tratamiento especial:
 * cada allocation se clasifica de forma independiente por su propio
 * destinationRendered, y los totales por sourceKind son la suma simple —
 * exactamente lo que hace que "conservación de totales" (pendiente +
 * rendido = total) sea una propiedad estructural, no algo que haya que
 * forzar. No escribe nada, no cachea nada: revertir una rendición (volver
 * destinationRendered a false) y volver a llamar a esta función con el
 * mismo conjunto de allocations reproduce exactamente el estado anterior.
 */
export function calculateAllocationRenderedCajaImpact(
  allocations: ReadonlyArray<FundingAllocationRenderStatus>
): AllocationRenderedCajaImpact {
  assertArray("allocations", allocations);

  let creditConsumedPendingCents = 0;
  let creditConsumedRenderedCents = 0;
  let debtPendingCents = 0;
  let debtRenderedExpenseCents = 0;
  let roundingPendingCents = 0;
  let roundingRenderedExpenseCents = 0;

  allocations.forEach((a, index) => {
    assertPlainObject(`La allocation en la posición ${index}`, a);
    if (!ALLOWED_SOURCE_KINDS.has(a.sourceKind as unknown as string)) {
      throw new AccountHolderFundingCajaError(
        `La allocation en la posición ${index} tiene sourceKind desconocido: ${String(a.sourceKind)}.`
      );
    }
    assertSafePositiveId(`El sourceId de la allocation en la posición ${index}`, a.sourceId);
    assertSafePositiveAmountCents(`El amountCents de la allocation en la posición ${index}`, a.amountCents);
    assertStrictBoolean(`El destinationRendered de la allocation en la posición ${index}`, a.destinationRendered);

    const amountCents = a.amountCents as number;
    const rendered = a.destinationRendered as boolean;

    switch (a.sourceKind as FundingCajaSourceKind) {
      case "credit_movement":
        if (rendered) {
          creditConsumedRenderedCents += amountCents;
          assertSafeAggregateCents("creditConsumedRenderedCents", creditConsumedRenderedCents);
        } else {
          creditConsumedPendingCents += amountCents;
          assertSafeAggregateCents("creditConsumedPendingCents", creditConsumedPendingCents);
        }
        break;
      case "debt_movement":
        if (rendered) {
          debtRenderedExpenseCents += amountCents;
          assertSafeAggregateCents("debtRenderedExpenseCents", debtRenderedExpenseCents);
        } else {
          debtPendingCents += amountCents;
          assertSafeAggregateCents("debtPendingCents", debtPendingCents);
        }
        break;
      case "rounding_adjustment":
        if (rendered) {
          roundingRenderedExpenseCents += amountCents;
          assertSafeAggregateCents("roundingRenderedExpenseCents", roundingRenderedExpenseCents);
        } else {
          roundingPendingCents += amountCents;
          assertSafeAggregateCents("roundingPendingCents", roundingPendingCents);
        }
        break;
    }
  });

  return {
    creditConsumedPendingCents,
    creditConsumedRenderedCents,
    debtPendingCents,
    debtRenderedExpenseCents,
    roundingPendingCents,
    roundingRenderedExpenseCents,
  };
}
