// Helpers puros de remittance_allocations (Etapa 4C) — vínculo real entre
// una rendición y los instrumentos de pago concretos que la componen. Sin
// DB, sin efectos secundarios — mismo estilo que batches.ts/received-checks.ts:
// reciben datos ya resueltos por el endpoint (que sí consulta la base) y
// devuelven resultados explícitos.
//
// IMPORTANTE (decisión aprobada): la validación de suma NUNCA compara contra
// remittances.totalPaid ni remittances.paymentBreakdown — esos campos siguen
// siendo la autoridad del flujo legacy (compatibilidad del formulario
// existente, con su tolerancia de ±$1), pero no dicen nada confiable sobre
// cuánto dinero real hay detrás, porque totalPaid incluye el importe nominal
// de manual_debt/cuotas no cobradas (deuda que la agencia adeuda a la
// compañía, no dinero ya recibido). La única autoridad para
// remittance_allocations son los instrumentos reales ya persistidos:
// payment_splits, payment_batch_splits, received_checks, cash_entries.

// ─── Errores ────────────────────────────────────────────────────────────────

export class RemittanceAllocationValidationError extends Error {}

// ─── Instrumentos resueltos (paso A) ──────────────────────────────────────────
//
// Un "instrumento resuelto" es la unidad mínima de dinero real detrás de una
// futura allocation. resolveStandalonePaymentInstruments/resolveBatchInstruments/
// resolveCashEntryInstrument son las únicas funciones que producen estos
// valores — el endpoint les pasa filas ya leídas de la base (nunca del body
// del request), scopeadas por el id correspondiente (payment_id=X,
// batch_id=Y), así que la pertenencia real ya viene garantizada por esa
// consulta; validateAllocationOwnership es una segunda verificación
// defensiva sobre el resultado, no la única.

export interface ResolvedPaymentSplitInstrument {
  kind: "payment_split";
  remittanceItemId: number;
  paymentId: number;
  paymentSplitId: number;
  method: string;
  amountCents: number;
}

// Migración 0028: un payment_split method='cheque' de un pago STANDALONE
// (no batch) produce un instrumento POR CHEQUE — mismo criterio que
// ResolvedBatchCheckInstrument, pero con paymentId/paymentSplitId en vez de
// paymentBatchId/paymentBatchSplitId.
export interface ResolvedPaymentSplitCheckInstrument {
  kind: "payment_split_check";
  remittanceItemId: number;
  paymentId: number;
  paymentSplitId: number;
  receivedCheckId: number;
  amountCents: number;
}

export interface ResolvedBatchSplitInstrument {
  kind: "batch_split";
  paymentBatchId: number;
  paymentBatchSplitId: number;
  method: string;
  amountCents: number;
}

export interface ResolvedBatchCheckInstrument {
  kind: "batch_split_check";
  paymentBatchId: number;
  paymentBatchSplitId: number;
  receivedCheckId: number;
  amountCents: number;
}

export interface ResolvedCashEntryInstrument {
  kind: "cash_entry";
  remittanceItemId: number;
  cashEntryId: number;
  method: string;
  amountCents: number;
}

// Migración 0029 — rendición por cuota: un payment HIJO de un
// payment_batches (batchId NOT NULL) rendido de forma INDEPENDIENTE de sus
// hermanos. A diferencia de ResolvedBatchSplitInstrument/
// ResolvedBatchCheckInstrument (que representan el instrumento de COBRANZA
// del batch entero — payment_batch_splits/received_checks, pensado para
// cuando el batch se rinde de una sola vez), este instrumento es el de
// SALIDA propio de esta rendición: método/importe con el que Curini le paga
// a la compañía por ESTA cuota puntual, desacoplado de cómo entró el dinero
// originalmente. paymentBatchId es puramente denormalizado (trazabilidad de
// "de qué lote vino") — nunca fuerza consumir su instrumento de cobranza.
export interface ResolvedBatchChildPaymentInstrument {
  kind: "batch_child_payment";
  remittanceItemId: number;
  paymentId: number;
  paymentBatchId: number;
  method: string;
  amountCents: number;
}

export type ResolvedInstrument =
  | ResolvedPaymentSplitInstrument
  | ResolvedPaymentSplitCheckInstrument
  | ResolvedBatchSplitInstrument
  | ResolvedBatchCheckInstrument
  | ResolvedCashEntryInstrument
  | ResolvedBatchChildPaymentInstrument;

/**
 * Pago standalone (payments.batchId IS NULL). Siempre tiene >=1
 * payment_splits real (invariante de Etapa 3A) — una instrumento por cada
 * uno, todos atados al mismo remittance_item_id (la cuota/pago que se está
 * rindiendo). Si el payment no tiene ningún split real, es una
 * inconsistencia de datos que no se puede rendir — se rechaza en vez de
 * inventar un instrumento sin respaldo.
 *
 * Migración 0028: un split method='cheque' produce un instrumento POR
 * CHEQUE (ResolvedPaymentSplitCheckInstrument), igual que
 * resolveBatchInstruments hace para un split cheque de batch — nunca se
 * genera además un instrumento por el split completo (se duplicaría el
 * importe). El resto de los métodos sigue produciendo un instrumento por
 * split completo, sin cambios. La suma de los cheques de un split cheque
 * debe coincidir exactamente con el importe de ese split — si no, es una
 * inconsistencia de datos (no se prorratea ni se ajusta).
 */
export interface StandalonePaymentSplitRow { id: number; method: string; amountCents: number; checks?: ReadonlyArray<{ id: number; amountCents: number }> }

export function resolveStandalonePaymentInstruments(params: {
  remittanceItemId: number;
  paymentId: number;
  splits: ReadonlyArray<StandalonePaymentSplitRow>;
}): Array<ResolvedPaymentSplitInstrument | ResolvedPaymentSplitCheckInstrument> {
  if (params.splits.length === 0) {
    throw new RemittanceAllocationValidationError(
      `El pago ${params.paymentId} no tiene ningún payment_splits real — no se puede rendir.`
    );
  }
  const resolved: Array<ResolvedPaymentSplitInstrument | ResolvedPaymentSplitCheckInstrument> = [];
  for (const s of params.splits) {
    if (s.method === "cheque") {
      const checks = s.checks ?? [];
      if (checks.length === 0) {
        throw new RemittanceAllocationValidationError(
          `El split cheque ${s.id} del pago ${params.paymentId} no tiene ningún received_checks real — no se puede rendir.`
        );
      }
      const checksTotalCents = checks.reduce((sum, ch) => sum + ch.amountCents, 0);
      if (checksTotalCents !== s.amountCents) {
        throw new RemittanceAllocationValidationError(
          `La suma de los cheques del split ${s.id} ($${(checksTotalCents / 100).toFixed(2)}) no coincide con su importe ($${(s.amountCents / 100).toFixed(2)}).`
        );
      }
      for (const chk of checks) {
        resolved.push({
          kind: "payment_split_check" as const,
          remittanceItemId: params.remittanceItemId,
          paymentId: params.paymentId,
          paymentSplitId: s.id,
          receivedCheckId: chk.id,
          amountCents: chk.amountCents,
        });
      }
    } else {
      resolved.push({
        kind: "payment_split" as const,
        remittanceItemId: params.remittanceItemId,
        paymentId: params.paymentId,
        paymentSplitId: s.id,
        method: s.method,
        amountCents: s.amountCents,
      });
    }
  }
  return resolved;
}

/**
 * Cobro múltiple (payment_batches) — se resuelve UNA sola vez por batch
 * (nunca por cada payment hijo), sin remittance_item_id (ver decisión: el
 * batch se rinde completo, no hay un ítem individual al que atarlo). Un
 * split method='cheque' produce un instrumento POR CHEQUE (para poder
 * rastrear cada uno); el resto de los métodos produce un instrumento por
 * split completo. La suma de los cheques de un split cheque debe coincidir
 * exactamente con el importe de ese split — si no, es una inconsistencia de
 * datos (no se prorratea ni se ajusta).
 */
export interface BatchCheckRow { id: number; amountCents: number }
export interface BatchSplitRow { id: number; method: string; amountCents: number; checks: ReadonlyArray<BatchCheckRow> }

export function resolveBatchInstruments(params: {
  paymentBatchId: number;
  splits: ReadonlyArray<BatchSplitRow>;
}): Array<ResolvedBatchSplitInstrument | ResolvedBatchCheckInstrument> {
  const resolved: Array<ResolvedBatchSplitInstrument | ResolvedBatchCheckInstrument> = [];
  for (const split of params.splits) {
    if (split.method === "cheque") {
      if (split.checks.length === 0) {
        throw new RemittanceAllocationValidationError(
          `El split cheque ${split.id} del cobro ${params.paymentBatchId} no tiene ningún received_checks real — no se puede rendir.`
        );
      }
      const checksTotalCents = split.checks.reduce((sum, c) => sum + c.amountCents, 0);
      if (checksTotalCents !== split.amountCents) {
        throw new RemittanceAllocationValidationError(
          `La suma de los cheques del split ${split.id} ($${(checksTotalCents / 100).toFixed(2)}) no coincide con su importe ($${(split.amountCents / 100).toFixed(2)}).`
        );
      }
      for (const chk of split.checks) {
        resolved.push({
          kind: "batch_split_check",
          paymentBatchId: params.paymentBatchId,
          paymentBatchSplitId: split.id,
          receivedCheckId: chk.id,
          amountCents: chk.amountCents,
        });
      }
    } else {
      resolved.push({
        kind: "batch_split",
        paymentBatchId: params.paymentBatchId,
        paymentBatchSplitId: split.id,
        method: split.method,
        amountCents: split.amountCents,
      });
    }
  }
  return resolved;
}

/**
 * cash_entry (cobro manual de Caja, incluye recargos Pronto Pago
 * standalone). Un solo instrumento — el importe real de esa fila.
 *
 * Recargo Pronto Pago de un pago hijo de batch: el endpoint NO debe llamar a
 * esta función para ese caso — el dinero ya está representado en la
 * allocation del payment_batch_split del batch (ver nota en POST
 * /remittances). Esta función no lo sabe ni lo decide; es responsabilidad
 * del endpoint no invocarla para ese caso puntual.
 */
export function resolveCashEntryInstrument(params: {
  remittanceItemId: number;
  cashEntryId: number;
  method: string;
  amountCents: number;
}): ResolvedCashEntryInstrument {
  return {
    kind: "cash_entry",
    remittanceItemId: params.remittanceItemId,
    cashEntryId: params.cashEntryId,
    method: params.method,
    amountCents: params.amountCents,
  };
}

/**
 * Migración 0029 — payment hijo de batch rendido por su cuenta. No arrastra
 * (ni lee) los payment_batch_splits/received_checks del batch: el instrumento
 * acá es el de SALIDA de esta rendición puntual (method/amountCents), no el
 * de cobranza. Validar que method sea un método contable real es
 * responsabilidad del endpoint (evita un import circular con caja-summary.ts,
 * que ya importa de este archivo).
 */
export function resolveBatchChildPaymentInstrument(params: {
  remittanceItemId: number;
  paymentId: number;
  paymentBatchId: number;
  method: string;
  amountCents: number;
}): ResolvedBatchChildPaymentInstrument {
  return {
    kind: "batch_child_payment",
    remittanceItemId: params.remittanceItemId,
    paymentId: params.paymentId,
    paymentBatchId: params.paymentBatchId,
    method: params.method,
    amountCents: params.amountCents,
  };
}

// ─── Construcción de allocations (paso B) ─────────────────────────────────────

export interface AllocationDraft {
  remittanceItemId: number | null;
  paymentId: number | null;
  paymentSplitId: number | null;
  paymentBatchId: number | null;
  paymentBatchSplitId: number | null;
  receivedCheckId: number | null;
  cashEntryId: number | null;
  method: string;
  amountCents: number;
}

/** Traduce instrumentos resueltos a filas listas para insertar en remittance_allocations. No valida nada — eso es C/D. */
export function buildRemittanceAllocations(instruments: ReadonlyArray<ResolvedInstrument>): AllocationDraft[] {
  return instruments.map((instrument): AllocationDraft => {
    switch (instrument.kind) {
      case "payment_split":
        return {
          remittanceItemId: instrument.remittanceItemId,
          paymentId: instrument.paymentId,
          paymentSplitId: instrument.paymentSplitId,
          paymentBatchId: null,
          paymentBatchSplitId: null,
          receivedCheckId: null,
          cashEntryId: null,
          method: instrument.method,
          amountCents: instrument.amountCents,
        };
      case "payment_split_check":
        return {
          remittanceItemId: instrument.remittanceItemId,
          paymentId: instrument.paymentId,
          paymentSplitId: instrument.paymentSplitId,
          paymentBatchId: null,
          paymentBatchSplitId: null,
          receivedCheckId: instrument.receivedCheckId,
          cashEntryId: null,
          method: "cheque",
          amountCents: instrument.amountCents,
        };
      case "batch_split":
        return {
          remittanceItemId: null,
          paymentId: null,
          paymentSplitId: null,
          paymentBatchId: instrument.paymentBatchId,
          paymentBatchSplitId: instrument.paymentBatchSplitId,
          receivedCheckId: null,
          cashEntryId: null,
          method: instrument.method,
          amountCents: instrument.amountCents,
        };
      case "batch_split_check":
        return {
          remittanceItemId: null,
          paymentId: null,
          paymentSplitId: null,
          paymentBatchId: instrument.paymentBatchId,
          paymentBatchSplitId: instrument.paymentBatchSplitId,
          receivedCheckId: instrument.receivedCheckId,
          cashEntryId: null,
          method: "cheque",
          amountCents: instrument.amountCents,
        };
      case "cash_entry":
        return {
          remittanceItemId: instrument.remittanceItemId,
          paymentId: null,
          paymentSplitId: null,
          paymentBatchId: null,
          paymentBatchSplitId: null,
          receivedCheckId: null,
          cashEntryId: instrument.cashEntryId,
          method: instrument.method,
          amountCents: instrument.amountCents,
        };
      case "batch_child_payment":
        return {
          remittanceItemId: instrument.remittanceItemId,
          paymentId: instrument.paymentId,
          paymentSplitId: null,
          paymentBatchId: instrument.paymentBatchId,
          paymentBatchSplitId: null,
          receivedCheckId: null,
          cashEntryId: null,
          method: instrument.method,
          amountCents: instrument.amountCents,
        };
    }
  });
}

// ─── Ownership (paso C) ────────────────────────────────────────────────────────

/**
 * Verificación defensiva adicional (no la única — ver nota arriba): que los
 * instrumentos resueltos para un pago/batch puntual realmente pertenecen al
 * id que el endpoint pretendía consultar. Nunca debería fallar si el
 * endpoint construyó bien su query (WHERE payment_id=X / WHERE batch_id=Y) —
 * si falla, es señal de un bug real de cableado, no un caso de negocio.
 */
export function validateAllocationOwnership(
  instruments: ReadonlyArray<ResolvedInstrument>,
  expected: { paymentId?: number; paymentBatchId?: number }
): void {
  for (const instrument of instruments) {
    if (
      (instrument.kind === "payment_split" || instrument.kind === "payment_split_check") &&
      expected.paymentId != null && instrument.paymentId !== expected.paymentId
    ) {
      throw new RemittanceAllocationValidationError(
        `El payment_split ${instrument.paymentSplitId} pertenece al pago ${instrument.paymentId}, no al pago ${expected.paymentId}.`
      );
    }
    if (
      (instrument.kind === "batch_split" || instrument.kind === "batch_split_check") &&
      expected.paymentBatchId != null &&
      instrument.paymentBatchId !== expected.paymentBatchId
    ) {
      throw new RemittanceAllocationValidationError(
        `El payment_batch_split ${instrument.paymentBatchSplitId} pertenece al cobro ${instrument.paymentBatchId}, no al cobro ${expected.paymentBatchId}.`
      );
    }
  }
}

// ─── Suma (paso D) ─────────────────────────────────────────────────────────────

/**
 * expectedCollectedCents se arma SIEMPRE desde el campo autoritativo del
 * registro padre real — payments.amount (standalone), payment_batches.
 * totalReceivedCents (batch, una sola vez), cash_entries.amount — nunca
 * resumando los mismos splits/cheques que ya van a componer las allocations.
 * Esto es deliberado: si payment_splits no suma exactamente payments.amount
 * (una inconsistencia de datos real, aunque no debería pasar por invariante),
 * esta comparación cruzada la detecta en vez de ocultarla.
 *
 * El endpoint decide qué "sources" incluir — en particular, un cash_entry de
 * recargo Pronto Pago de un pago hijo de batch NO debe agregarse acá (ese
 * dinero ya está una vez en el totalReceivedCents del batch).
 */
export interface CollectedAmountSource {
  kind: "standalone_payment" | "batch" | "cash_entry" | "batch_child_payment";
  amountCents: number;
}

export function calculateExpectedCollectedCents(sources: ReadonlyArray<CollectedAmountSource>): number {
  return sources.reduce((sum, s) => sum + s.amountCents, 0);
}

export interface AllocationTotalValidationResult {
  valid: boolean;
  errorMessage: string | null;
}

/**
 * Compara la suma de los instrumentos YA RESUELTOS (no releídos, no
 * recalculados desde totalPaid) contra expectedCollectedCents. Exacta, sin
 * tolerancia — todos los montos de entrada ya son centavos enteros reales.
 */
export function validateAllocationTotals(
  instruments: ReadonlyArray<{ amountCents: number }>,
  expectedCollectedCents: number
): AllocationTotalValidationResult {
  const sumCents = instruments.reduce((sum, i) => sum + i.amountCents, 0);
  if (sumCents !== expectedCollectedCents) {
    return {
      valid: false,
      errorMessage:
        `La suma de los instrumentos reales ($${(sumCents / 100).toFixed(2)}) no coincide con el total esperado de dinero ` +
        `realmente cobrado ($${(expectedCollectedCents / 100).toFixed(2)}).`,
    };
  }
  return { valid: true, errorMessage: null };
}

// ─── Clasificación histórica (paso E) ─────────────────────────────────────────

export type RemittanceAllocationState = "legacy" | "complete" | "inconsistent";

/**
 * legacy: la rendición no tiene ninguna allocation Y no se creó bajo el
 * modelo nuevo (rendición anterior a 0024 — no se le puede pedir haber
 * generado algo que no existía). No es un error.
 *
 * complete: o bien tiene allocations y su suma coincide exactamente con
 * expectedCollectedCents, o bien no tiene ninguna allocation pero se creó
 * bajo el modelo nuevo Y expectedCollectedCents es 0 (rendición compuesta
 * solo por manual_debt/cuotas no cobradas — cero allocations es el
 * resultado correcto, no legacy).
 *
 * inconsistent: cualquier otro caso — en particular, una rendición nueva sin
 * ninguna allocation pero con expectedCollectedCents > 0 (debería haber
 * generado allocations y no lo hizo), o una rendición con allocations cuya
 * suma no coincide con lo esperado.
 */
export function classifyRemittanceAllocationState(params: {
  allocationCount: number;
  allocationSumCents: number;
  expectedCollectedCents: number;
  createdUnderAllocationsModel: boolean;
}): RemittanceAllocationState {
  if (params.allocationCount === 0) {
    if (!params.createdUnderAllocationsModel) return "legacy";
    return params.expectedCollectedCents === 0 ? "complete" : "inconsistent";
  }
  return params.allocationSumCents === params.expectedCollectedCents ? "complete" : "inconsistent";
}
