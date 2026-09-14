// Traduce los drafts de financiación de un lote (Etapa 1B-2A,
// account-holder-funding-plan.ts) a filas persistibles de
// payment_batch_funding_allocations (migración 0036), validando cada
// referencia contra metadatos reales ya cargados por el endpoint — nunca
// contra los sourceKey/destinationKey opacos del draft ni contra un simple
// conjunto de IDs válidos. Sin DB, sin HTTP — mismo criterio que el resto de
// src/lib/payments/*.ts: recibe snapshots ya resueltos y devuelve resultados
// explícitos. Ningún endpoint usa todavía este módulo (Etapa 1B-2B-ii,
// diseño cerrado en la conversación de "cuenta corriente con titular de
// cuenta", 2026-09).
//
// ─── Reglas de titularidad (revisadas dos veces en el diseño) ─────────────
//
// - payments y cash_entries de recargo Pronto Pago NO tienen que pertenecer
//   al titular contable (accountHolderInsuredId) — un lote puede mezclar
//   pólizas de asegurados reales distintos (migración 0026). Su único
//   requisito es pertenecer al MISMO batch y tener el status correcto.
// - Solo los 3 movimientos de cuenta corriente (aplicacion_saldo_favor,
//   saldo_deudor, saldo_a_favor nuevo) deben coincidir con
//   accountHolderInsuredId — son los únicos que tocan la cuenta corriente
//   real de un asegurado.
//
// ─── Convención de signo (confirmada contra insured-account.ts antes de
// implementar — ver REQUIRED_SIGN y el único punto de creación real,
// POST /payment-batches en index.ts, ninguno la contradice) ────────────────
//
//   aplicacion_saldo_favor -> signedAmountCents SIEMPRE negativo.
//   saldo_deudor           -> signedAmountCents SIEMPRE negativo.
//   saldo_a_favor (nuevo)  -> signedAmountCents SIEMPRE positivo.
//
// Las filas de payment_batch_funding_allocations usan siempre amount_cents
// positivo (CHECK amount_cents > 0, migración 0036) — cierran contra la
// MAGNITUD (valor absoluto) del movimiento/ajuste, nunca contra su signo.
//
// ─── Ajuste de redondeo (payment_amount_adjustments) ───────────────────────
//
// Esta tabla NO tiene columna status (limitación real de schema, no se
// inventa acá) — el único chequeo de vigencia posible es pertenencia al
// batch (paymentBatchId) + el batch confirmado (validado UNA sola vez al
// principio, nunca por fila, porque toda referencia de este módulo ya está
// forzada a pertenecer a ese batch) + el signo esperado (amountCents < 0,
// única señal documentada de "esto es redondeo").

import type {
  FundingAllocationDraft,
  FundingAllocationSourceKind,
  FundingAllocationDestinationKind,
} from "./account-holder-funding-plan";

export class FundingAllocationRowsError extends Error {}

// ─── Validación de forma de entradas — mismo criterio que el resto de
// src/lib/payments/*.ts, duplicado acá porque este módulo tiene su propia
// clase de error de dominio y su propio contrato de entrada. Nunca debe
// escapar un TypeError crudo por acceder a una propiedad de
// undefined/null/malformado.

function assertPlainObject(label: string, value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FundingAllocationRowsError(
      `${label} debe ser un objeto (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`
    );
  }
}

function assertArray(label: string, value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new FundingAllocationRowsError(`${label} debe ser un array (recibido: ${value === null ? "null" : typeof value}).`);
  }
}

function assertMap(label: string, value: unknown): asserts value is ReadonlyMap<unknown, unknown> {
  if (!(value instanceof Map)) {
    throw new FundingAllocationRowsError(`${label} debe ser un Map (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`);
  }
}

/** IDs reales de DB — siempre enteros seguros positivos. */
function assertSafePositiveInt(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new FundingAllocationRowsError(`${label} debe ser un entero seguro y positivo (recibido: ${value}).`);
  }
}

/** Importes en centavos de una entidad real (split/payment/cash_entry) — siempre enteros seguros estrictamente positivos. */
function assertSafePositiveAmountCents(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new FundingAllocationRowsError(`${label} debe ser un entero seguro y positivo en centavos (recibido: ${value}).`);
  }
}

/** signedAmountCents (movimientos) / amountCents (ajuste de redondeo) — enteros seguros, nunca 0, el signo se valida aparte según el tipo. */
function assertSafeNonZeroSignedAmountCents(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) {
    throw new FundingAllocationRowsError(`${label} debe ser un entero seguro y distinto de cero en centavos (recibido: ${value}).`);
  }
}

function assertSafeAggregateCents(label: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new FundingAllocationRowsError(`${label} dejó de ser un entero seguro en centavos — posible desborde (valor: ${value}).`);
  }
}

function assertCanonicalKey(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FundingAllocationRowsError(`${label} debe ser un string no vacío (recibido: ${value === null ? "null" : typeof value}).`);
  }
}

// ─── Contrato de entrada ─────────────────────────────────────────────────

export interface BatchSnapshot {
  id: number;
  status: "confirmado" | "anulado";
  accountHolderInsuredId: number | null;
}

export interface BatchSplitSnapshot {
  id: number;
  batchId: number;
  amountCents: number;
}

type FundingAllocationMovementType = "aplicacion_saldo_favor" | "saldo_deudor" | "saldo_a_favor";

export interface AccountMovementSnapshot {
  id: number;
  insuredId: number;
  type: string;
  status: "activo" | "anulado";
  originBatchId: number | null;
  signedAmountCents: number;
}

export interface RoundingAdjustmentSnapshot {
  id: number;
  paymentBatchId: number | null;
  amountCents: number;
}

export interface PaymentSnapshot {
  id: number;
  batchId: number | null;
  status: "confirmado" | "pendiente" | "anulado";
  amountCents: number;
}

export interface CashEntrySnapshot {
  id: number;
  entryType: "normal" | "pronto_pago_surcharge";
  status: "activo" | "anulado";
  paymentId: number | null;
  amountCents: number;
}

/**
 * Traducción draft -> id real. Debe corresponder EXACTAMENTE a lo que los
 * drafts usan: toda key/id presente acá y no referenciada por ningún draft
 * es un error ("mapping sobrante"), y todo draft cuya key/kind no resuelve
 * acá es otro error ("mapping faltante") — ver buildFundingAllocationRows.
 */
export interface FundingAllocationKeyMap {
  splitIdByKey: ReadonlyMap<string, number>;
  paymentIdByKey: ReadonlyMap<string, number>;
  cashEntryIdByKey: ReadonlyMap<string, number>;
  /** Fila AGREGADA (una por batch) de aplicacion_saldo_favor — null si ningún draft usa sourceKind="credit_movement". */
  creditMovementId: number | null;
  /** Fila AGREGADA (una por batch) de saldo_deudor — null si ningún draft usa sourceKind="debt_movement". */
  debtMovementId: number | null;
  /** Fila AGREGADA (una por batch) de redondeo absorbido — null si ningún draft usa sourceKind="rounding_adjustment". */
  roundingAdjustmentId: number | null;
  /** Fila NUEVA de saldo_a_favor generada por este batch — null si ningún draft usa destinationKind="new_credit_movement". */
  newCreditMovementId: number | null;
}

/**
 * Snapshots autoritativos — a diferencia de FundingAllocationKeyMap, PUEDEN
 * traer más filas que las referenciadas por los drafts (p.ej. una consulta
 * "todos los movimientos activos del batch"). Nunca es error que sobre acá.
 */
export interface FundingAllocationSnapshots {
  splits: ReadonlyMap<number, BatchSplitSnapshot>;
  movements: ReadonlyMap<number, AccountMovementSnapshot>;
  adjustments: ReadonlyMap<number, RoundingAdjustmentSnapshot>;
  payments: ReadonlyMap<number, PaymentSnapshot>;
  cashEntries: ReadonlyMap<number, CashEntrySnapshot>;
}

export interface FundingAllocationRow {
  paymentBatchId: number;
  paymentBatchSplitId: number | null;
  sourceAccountMovementId: number | null;
  paymentAmountAdjustmentId: number | null;
  paymentId: number | null;
  cashEntryId: number | null;
  destinationAccountMovementId: number | null;
  amountCents: number;
}

type SourceColumn = "paymentBatchSplitId" | "sourceAccountMovementId" | "paymentAmountAdjustmentId";
type DestinationColumn = "paymentId" | "cashEntryId" | "destinationAccountMovementId";

const MOVEMENT_SIGN: Record<FundingAllocationMovementType, "negative" | "positive"> = {
  aplicacion_saldo_favor: "negative",
  saldo_deudor: "negative",
  saldo_a_favor: "positive",
};

// ─── Validadores por entidad ────────────────────────────────────────────────

function validateBatchSnapshot(batch: BatchSnapshot): void {
  assertPlainObject("batch", batch);
  assertSafePositiveInt("batch.id", batch.id);
  if (batch.status !== "confirmado") {
    throw new FundingAllocationRowsError(`El batch ${batch.id} no está confirmado (status="${batch.status}") — no se pueden construir allocations de financiación.`);
  }
  if (batch.accountHolderInsuredId === null || batch.accountHolderInsuredId === undefined) {
    throw new FundingAllocationRowsError(`El batch ${batch.id} no tiene accountHolderInsuredId — no se puede financiar sin titular contable explícito.`);
  }
  assertSafePositiveInt("batch.accountHolderInsuredId", batch.accountHolderInsuredId);
}

function validateSplitSnapshot(id: number, snap: BatchSplitSnapshot | undefined, batch: BatchSnapshot): BatchSplitSnapshot {
  if (!snap) {
    throw new FundingAllocationRowsError(`El split ${id} no tiene snapshot cargado en snapshots.splits.`);
  }
  assertSafePositiveInt("El id del split", snap.id);
  if (snap.id !== id) {
    throw new FundingAllocationRowsError(`El snapshot del split ${id} tiene un id inconsistente (${snap.id}) — bug de cableado del mapa snapshots.splits.`);
  }
  assertSafePositiveAmountCents(`El amountCents del split ${id}`, snap.amountCents);
  if (snap.batchId !== batch.id) {
    throw new FundingAllocationRowsError(`El split ${id} pertenece al batch ${snap.batchId ?? "null"}, no al batch ${batch.id}.`);
  }
  return snap;
}

function validateFundingMovementSnapshot(
  role: "credit_movement" | "debt_movement" | "new_credit_movement",
  expectedType: FundingAllocationMovementType,
  id: number,
  snap: AccountMovementSnapshot | undefined,
  batch: BatchSnapshot
): AccountMovementSnapshot {
  if (!snap) {
    throw new FundingAllocationRowsError(`El movimiento ${id} (usado como ${role}) no tiene snapshot cargado en snapshots.movements.`);
  }
  assertSafePositiveInt(`El id del movimiento usado como ${role}`, snap.id);
  if (snap.id !== id) {
    throw new FundingAllocationRowsError(`El snapshot del movimiento ${id} (${role}) tiene un id inconsistente (${snap.id}) — bug de cableado del mapa snapshots.movements.`);
  }
  assertSafePositiveInt(`El insuredId del movimiento ${id} (${role})`, snap.insuredId);
  assertSafeNonZeroSignedAmountCents(`El signedAmountCents del movimiento ${id} (${role})`, snap.signedAmountCents);
  if (snap.type !== expectedType) {
    throw new FundingAllocationRowsError(`El movimiento ${id} (${role}) tiene type="${snap.type}", se esperaba "${expectedType}".`);
  }
  if (snap.status !== "activo") {
    throw new FundingAllocationRowsError(`El movimiento ${id} (${role}) no está activo (status="${snap.status}").`);
  }
  // Titularidad: solo estos 3 movimientos deben coincidir con el titular
  // contable — a diferencia de payment/cash_entry (ver validatePaymentSnapshot
  // / validateCashEntrySnapshot), que pueden pertenecer a un asegurado real
  // distinto dentro del mismo batch.
  if (snap.insuredId !== batch.accountHolderInsuredId) {
    throw new FundingAllocationRowsError(
      `El movimiento ${id} (${role}) pertenece al asegurado ${snap.insuredId}, distinto del titular contable ${batch.accountHolderInsuredId} del batch ${batch.id}.`
    );
  }
  if (snap.originBatchId !== batch.id) {
    throw new FundingAllocationRowsError(`El movimiento ${id} (${role}) fue originado por el batch ${snap.originBatchId ?? "null"}, no por el batch ${batch.id}.`);
  }
  const requiredSign = MOVEMENT_SIGN[expectedType];
  if (requiredSign === "negative" && !(snap.signedAmountCents < 0)) {
    throw new FundingAllocationRowsError(`El movimiento ${id} (${expectedType}) debe tener signedAmountCents negativo (recibido: ${snap.signedAmountCents}).`);
  }
  if (requiredSign === "positive" && !(snap.signedAmountCents > 0)) {
    throw new FundingAllocationRowsError(`El movimiento ${id} (${expectedType}) debe tener signedAmountCents positivo (recibido: ${snap.signedAmountCents}).`);
  }
  return snap;
}

function validateRoundingAdjustmentSnapshot(id: number, snap: RoundingAdjustmentSnapshot | undefined, batch: BatchSnapshot): RoundingAdjustmentSnapshot {
  if (!snap) {
    throw new FundingAllocationRowsError(`El ajuste de redondeo ${id} no tiene snapshot cargado en snapshots.adjustments.`);
  }
  assertSafePositiveInt("El id del ajuste de redondeo", snap.id);
  if (snap.id !== id) {
    throw new FundingAllocationRowsError(`El snapshot del ajuste de redondeo ${id} tiene un id inconsistente (${snap.id}) — bug de cableado del mapa snapshots.adjustments.`);
  }
  assertSafeNonZeroSignedAmountCents(`El amountCents del ajuste de redondeo ${id}`, snap.amountCents);
  if (snap.paymentBatchId !== batch.id) {
    throw new FundingAllocationRowsError(`El ajuste de redondeo ${id} pertenece al batch ${snap.paymentBatchId ?? "null"}, no al batch ${batch.id}.`);
  }
  // payment_amount_adjustments no tiene columna status (migración 0036) —
  // no se inventa una acá. El signo negativo es la única señal disponible de
  // "esto es redondeo absorbido", documentada en la migración.
  if (!(snap.amountCents < 0)) {
    throw new FundingAllocationRowsError(`El ajuste de redondeo ${id} debe tener amountCents negativo (recibido: ${snap.amountCents}).`);
  }
  return snap;
}

function validatePaymentSnapshot(id: number, snap: PaymentSnapshot | undefined, batch: BatchSnapshot): PaymentSnapshot {
  if (!snap) {
    throw new FundingAllocationRowsError(`El payment ${id} no tiene snapshot cargado en snapshots.payments.`);
  }
  assertSafePositiveInt("El id del payment", snap.id);
  if (snap.id !== id) {
    throw new FundingAllocationRowsError(`El snapshot del payment ${id} tiene un id inconsistente (${snap.id}) — bug de cableado del mapa snapshots.payments.`);
  }
  assertSafePositiveAmountCents(`El amountCents del payment ${id}`, snap.amountCents);
  if (snap.batchId !== batch.id) {
    throw new FundingAllocationRowsError(`El payment ${id} pertenece al batch ${snap.batchId ?? "null"}, no al batch ${batch.id}.`);
  }
  if (snap.status !== "confirmado") {
    throw new FundingAllocationRowsError(`El payment ${id} no está confirmado (status="${snap.status}").`);
  }
  // Deliberadamente SIN chequeo de insuredId acá — un payment hijo de este
  // batch (incluido un pago manual sin póliza) es un destino válido con solo
  // pertenecer al batch y estar confirmado (ver cabecera del archivo).
  return snap;
}

function validateCashEntrySnapshot(
  id: number,
  snap: CashEntrySnapshot | undefined,
  batch: BatchSnapshot,
  payments: ReadonlyMap<number, PaymentSnapshot>
): CashEntrySnapshot {
  if (!snap) {
    throw new FundingAllocationRowsError(`El cash_entry ${id} no tiene snapshot cargado en snapshots.cashEntries.`);
  }
  assertSafePositiveInt("El id del cash_entry", snap.id);
  if (snap.id !== id) {
    throw new FundingAllocationRowsError(`El snapshot del cash_entry ${id} tiene un id inconsistente (${snap.id}) — bug de cableado del mapa snapshots.cashEntries.`);
  }
  assertSafePositiveAmountCents(`El amountCents del cash_entry ${id}`, snap.amountCents);
  if (snap.status !== "activo") {
    throw new FundingAllocationRowsError(`El cash_entry ${id} no está activo (status="${snap.status}").`);
  }
  if (snap.entryType !== "pronto_pago_surcharge") {
    throw new FundingAllocationRowsError(`El cash_entry ${id} tiene entryType="${snap.entryType}", se esperaba "pronto_pago_surcharge".`);
  }
  if (snap.paymentId === null || snap.paymentId === undefined) {
    throw new FundingAllocationRowsError(`El cash_entry ${id} no tiene paymentId — un recargo Pronto Pago siempre debe estar vinculado a su payment padre.`);
  }
  const parentPayment = payments.get(snap.paymentId);
  if (!parentPayment) {
    throw new FundingAllocationRowsError(`El cash_entry ${id} referencia el payment ${snap.paymentId} como padre, que no está en snapshots.payments.`);
  }
  assertSafePositiveInt(`El id del payment padre del cash_entry ${id}`, parentPayment.id);
  if (parentPayment.id !== snap.paymentId) {
    throw new FundingAllocationRowsError(`El snapshot del payment padre ${snap.paymentId} del cash_entry ${id} tiene un id inconsistente (${parentPayment.id}).`);
  }
  if (parentPayment.batchId !== batch.id) {
    throw new FundingAllocationRowsError(`El payment padre ${snap.paymentId} del cash_entry ${id} pertenece al batch ${parentPayment.batchId ?? "null"}, no al batch ${batch.id}.`);
  }
  if (parentPayment.status !== "confirmado") {
    throw new FundingAllocationRowsError(`El payment padre ${snap.paymentId} del cash_entry ${id} no está confirmado (status="${parentPayment.status}").`);
  }
  // Deliberadamente SIN chequeo de insuredId del cash_entry/payment padre —
  // el asegurado real de esa póliza puede ser distinto del titular contable
  // del batch (ver cabecera del archivo).
  return snap;
}

function makeRow(
  batchId: number,
  source: { col: SourceColumn; id: number },
  destination: { col: DestinationColumn; id: number },
  amountCents: number
): FundingAllocationRow {
  return {
    paymentBatchId: batchId,
    paymentBatchSplitId: source.col === "paymentBatchSplitId" ? source.id : null,
    sourceAccountMovementId: source.col === "sourceAccountMovementId" ? source.id : null,
    paymentAmountAdjustmentId: source.col === "paymentAmountAdjustmentId" ? source.id : null,
    paymentId: destination.col === "paymentId" ? destination.id : null,
    cashEntryId: destination.col === "cashEntryId" ? destination.id : null,
    destinationAccountMovementId: destination.col === "destinationAccountMovementId" ? destination.id : null,
    amountCents,
  };
}

function addToSum(map: Map<string, number>, key: string, amountCents: number, label: string): void {
  const next = (map.get(key) ?? 0) + amountCents;
  assertSafeAggregateCents(label, next);
  map.set(key, next);
}

/**
 * Construye, de punta a punta, las filas persistibles de
 * payment_batch_funding_allocations correspondientes a los drafts de un
 * batch — o lanza sin devolver nada parcial. Resuelve cada sourceKey/
 * destinationKey opaco a su id real vía `keys`, valida esa entidad real
 * contra `snapshots` (pertenencia al batch, titularidad cuando corresponde,
 * tipo, status, signo), detecta duplicados equivalentes a los 9 índices
 * únicos parciales de la migración 0036, exige que `keys` no tenga mappings
 * sobrantes ni falte ninguno, y revalida el cierre exacto (conservación)
 * entre lo asignado y el importe real de cada entidad persistida. No muta
 * ninguno de sus argumentos.
 */
export function buildFundingAllocationRows(
  drafts: ReadonlyArray<FundingAllocationDraft>,
  keys: FundingAllocationKeyMap,
  snapshots: FundingAllocationSnapshots,
  batch: BatchSnapshot
): FundingAllocationRow[] {
  validateBatchSnapshot(batch);

  assertArray("drafts", drafts);
  assertPlainObject("keys", keys);
  assertPlainObject("snapshots", snapshots);

  assertMap("keys.splitIdByKey", keys.splitIdByKey);
  assertMap("keys.paymentIdByKey", keys.paymentIdByKey);
  assertMap("keys.cashEntryIdByKey", keys.cashEntryIdByKey);
  for (const [label, value] of [
    ["keys.creditMovementId", keys.creditMovementId],
    ["keys.debtMovementId", keys.debtMovementId],
    ["keys.roundingAdjustmentId", keys.roundingAdjustmentId],
    ["keys.newCreditMovementId", keys.newCreditMovementId],
  ] as const) {
    if (value !== null && value !== undefined) {
      assertSafePositiveInt(label, value);
    }
  }

  assertMap("snapshots.splits", snapshots.splits);
  assertMap("snapshots.movements", snapshots.movements);
  assertMap("snapshots.adjustments", snapshots.adjustments);
  assertMap("snapshots.payments", snapshots.payments);
  assertMap("snapshots.cashEntries", snapshots.cashEntries);

  const rows: FundingAllocationRow[] = [];
  const dedupeSeen = new Set<string>();
  const sourceSums = new Map<string, number>();
  const destinationSums = new Map<string, number>();

  const usedSplitKeys = new Set<string>();
  const usedPaymentKeys = new Set<string>();
  const usedCashEntryKeys = new Set<string>();
  let usedCreditMovement = false;
  let usedDebtMovement = false;
  let usedRoundingAdjustment = false;
  let usedNewCreditMovement = false;

  drafts.forEach((draft, index) => {
    assertPlainObject(`El draft en la posición ${index}`, draft);
    assertCanonicalKey(`El sourceKey del draft en la posición ${index}`, draft.sourceKey);
    assertCanonicalKey(`El destinationKey del draft en la posición ${index}`, draft.destinationKey);
    assertSafePositiveAmountCents(`El amountCents del draft en la posición ${index}`, draft.amountCents);

    let source: { col: SourceColumn; id: number };
    switch (draft.sourceKind as FundingAllocationSourceKind) {
      case "split": {
        const id = keys.splitIdByKey.get(draft.sourceKey);
        if (id === undefined) {
          throw new FundingAllocationRowsError(`Falta el mapeo real para el split "${draft.sourceKey}" (draft en la posición ${index}).`);
        }
        assertSafePositiveInt(`El id real del split "${draft.sourceKey}"`, id);
        usedSplitKeys.add(draft.sourceKey);
        validateSplitSnapshot(id, snapshots.splits.get(id), batch);
        source = { col: "paymentBatchSplitId", id };
        break;
      }
      case "credit_movement": {
        const id = keys.creditMovementId;
        if (id === null) {
          throw new FundingAllocationRowsError(`Falta el mapeo real para credit_movement (draft en la posición ${index}).`);
        }
        usedCreditMovement = true;
        validateFundingMovementSnapshot("credit_movement", "aplicacion_saldo_favor", id, snapshots.movements.get(id), batch);
        source = { col: "sourceAccountMovementId", id };
        break;
      }
      case "debt_movement": {
        const id = keys.debtMovementId;
        if (id === null) {
          throw new FundingAllocationRowsError(`Falta el mapeo real para debt_movement (draft en la posición ${index}).`);
        }
        usedDebtMovement = true;
        validateFundingMovementSnapshot("debt_movement", "saldo_deudor", id, snapshots.movements.get(id), batch);
        source = { col: "sourceAccountMovementId", id };
        break;
      }
      case "rounding_adjustment": {
        const id = keys.roundingAdjustmentId;
        if (id === null) {
          throw new FundingAllocationRowsError(`Falta el mapeo real para rounding_adjustment (draft en la posición ${index}).`);
        }
        usedRoundingAdjustment = true;
        validateRoundingAdjustmentSnapshot(id, snapshots.adjustments.get(id), batch);
        source = { col: "paymentAmountAdjustmentId", id };
        break;
      }
      default:
        throw new FundingAllocationRowsError(`sourceKind desconocido en el draft en la posición ${index}: ${String(draft.sourceKind)}.`);
    }

    let destination: { col: DestinationColumn; id: number };
    switch (draft.destinationKind as FundingAllocationDestinationKind) {
      case "payment": {
        const id = keys.paymentIdByKey.get(draft.destinationKey);
        if (id === undefined) {
          throw new FundingAllocationRowsError(`Falta el mapeo real para el payment "${draft.destinationKey}" (draft en la posición ${index}).`);
        }
        assertSafePositiveInt(`El id real del payment "${draft.destinationKey}"`, id);
        usedPaymentKeys.add(draft.destinationKey);
        validatePaymentSnapshot(id, snapshots.payments.get(id), batch);
        destination = { col: "paymentId", id };
        break;
      }
      case "pronto_pago": {
        const id = keys.cashEntryIdByKey.get(draft.destinationKey);
        if (id === undefined) {
          throw new FundingAllocationRowsError(`Falta el mapeo real para el cash_entry "${draft.destinationKey}" (draft en la posición ${index}).`);
        }
        assertSafePositiveInt(`El id real del cash_entry "${draft.destinationKey}"`, id);
        usedCashEntryKeys.add(draft.destinationKey);
        validateCashEntrySnapshot(id, snapshots.cashEntries.get(id), batch, snapshots.payments);
        destination = { col: "cashEntryId", id };
        break;
      }
      case "new_credit_movement": {
        const id = keys.newCreditMovementId;
        if (id === null) {
          throw new FundingAllocationRowsError(`Falta el mapeo real para new_credit_movement (draft en la posición ${index}).`);
        }
        usedNewCreditMovement = true;
        validateFundingMovementSnapshot("new_credit_movement", "saldo_a_favor", id, snapshots.movements.get(id), batch);
        destination = { col: "destinationAccountMovementId", id };
        break;
      }
      default:
        throw new FundingAllocationRowsError(`destinationKind desconocido en el draft en la posición ${index}: ${String(draft.destinationKind)}.`);
    }

    const dedupeKey = `${source.col}:${source.id}->${destination.col}:${destination.id}`;
    if (dedupeSeen.has(dedupeKey)) {
      throw new FundingAllocationRowsError(
        `Allocation duplicada: ${source.col}=${source.id} -> ${destination.col}=${destination.id} ya fue generada por otro draft (violaría un índice único parcial de la migración 0036).`
      );
    }
    dedupeSeen.add(dedupeKey);

    addToSum(sourceSums, `${source.col}:${source.id}`, draft.amountCents, `La suma de la fuente ${source.col}:${source.id}`);
    addToSum(destinationSums, `${destination.col}:${destination.id}`, draft.amountCents, `La suma del destino ${destination.col}:${destination.id}`);

    rows.push(makeRow(batch.id, source, destination, draft.amountCents));
  });

  // ─── Mappings sobrantes (punto 8) ─────────────────────────────────────────
  for (const key of keys.splitIdByKey.keys()) {
    if (!usedSplitKeys.has(key)) {
      throw new FundingAllocationRowsError(`keys.splitIdByKey tiene la key "${key}" sin usar — ningún draft la referencia.`);
    }
  }
  for (const key of keys.paymentIdByKey.keys()) {
    if (!usedPaymentKeys.has(key)) {
      throw new FundingAllocationRowsError(`keys.paymentIdByKey tiene la key "${key}" sin usar — ningún draft la referencia.`);
    }
  }
  for (const key of keys.cashEntryIdByKey.keys()) {
    if (!usedCashEntryKeys.has(key)) {
      throw new FundingAllocationRowsError(`keys.cashEntryIdByKey tiene la key "${key}" sin usar — ningún draft la referencia.`);
    }
  }
  if (keys.creditMovementId !== null && !usedCreditMovement) {
    throw new FundingAllocationRowsError(`keys.creditMovementId está seteado (${keys.creditMovementId}) pero ningún draft usa sourceKind="credit_movement".`);
  }
  if (keys.debtMovementId !== null && !usedDebtMovement) {
    throw new FundingAllocationRowsError(`keys.debtMovementId está seteado (${keys.debtMovementId}) pero ningún draft usa sourceKind="debt_movement".`);
  }
  if (keys.roundingAdjustmentId !== null && !usedRoundingAdjustment) {
    throw new FundingAllocationRowsError(`keys.roundingAdjustmentId está seteado (${keys.roundingAdjustmentId}) pero ningún draft usa sourceKind="rounding_adjustment".`);
  }
  if (keys.newCreditMovementId !== null && !usedNewCreditMovement) {
    throw new FundingAllocationRowsError(`keys.newCreditMovementId está seteado (${keys.newCreditMovementId}) pero ningún draft usa destinationKind="new_credit_movement".`);
  }

  // ─── Conservación — igualdad exacta contra la entidad real (punto 6/7) ────
  for (const [sKey, sum] of sourceSums) {
    const sep = sKey.indexOf(":");
    const col = sKey.slice(0, sep) as SourceColumn;
    const id = Number(sKey.slice(sep + 1));
    if (col === "paymentBatchSplitId") {
      const snap = snapshots.splits.get(id)!;
      if (sum !== snap.amountCents) {
        throw new FundingAllocationRowsError(`El split ${id} no cierra: las allocations suman ${sum}, el split real es ${snap.amountCents}.`);
      }
    } else if (col === "sourceAccountMovementId") {
      const snap = snapshots.movements.get(id)!;
      const magnitude = Math.abs(snap.signedAmountCents);
      if (sum !== magnitude) {
        throw new FundingAllocationRowsError(`El movimiento ${id} no cierra: las allocations suman ${sum}, su magnitud real es ${magnitude}.`);
      }
    } else {
      const snap = snapshots.adjustments.get(id)!;
      const magnitude = Math.abs(snap.amountCents);
      if (sum !== magnitude) {
        throw new FundingAllocationRowsError(`El ajuste de redondeo ${id} no cierra: las allocations suman ${sum}, su magnitud real es ${magnitude}.`);
      }
    }
  }
  for (const [dKey, sum] of destinationSums) {
    const sep = dKey.indexOf(":");
    const col = dKey.slice(0, sep) as DestinationColumn;
    const id = Number(dKey.slice(sep + 1));
    if (col === "paymentId") {
      const snap = snapshots.payments.get(id)!;
      if (sum !== snap.amountCents) {
        throw new FundingAllocationRowsError(`El payment ${id} no cierra: las allocations suman ${sum}, su importe real es ${snap.amountCents}.`);
      }
    } else if (col === "cashEntryId") {
      const snap = snapshots.cashEntries.get(id)!;
      if (sum !== snap.amountCents) {
        throw new FundingAllocationRowsError(`El cash_entry ${id} no cierra: las allocations suman ${sum}, su importe real es ${snap.amountCents}.`);
      }
    } else {
      const snap = snapshots.movements.get(id)!;
      const magnitude = Math.abs(snap.signedAmountCents);
      if (sum !== magnitude) {
        throw new FundingAllocationRowsError(`El movimiento ${id} no cierra: las allocations suman ${sum}, su magnitud real es ${magnitude}.`);
      }
    }
  }

  return rows;
}
