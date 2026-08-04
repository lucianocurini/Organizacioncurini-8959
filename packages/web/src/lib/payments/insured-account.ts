// Helpers puros de cuenta corriente del asegurado (sobrantes/faltantes en
// cobros — Migración 0030, Fase 2A). Sin DB, sin efectos secundarios:
// reciben datos ya resueltos por el endpoint y devuelven resultados
// explícitos, mismo estilo que batches.ts/caja-summary.ts. Ningún endpoint
// usa todavía estos helpers — existen solo como base técnica de esta fase.
//
// Diseño de fondo (ver diagnóstico completo, cerrado 2026-07-21):
//
// - payment_batch_splits/received_checks SIEMPRE representan dinero real: un
//   cheque nunca se achica para cerrar contra las cuotas elegidas. Si el
//   cheque es mayor que lo aplicado, el cheque queda por su importe completo.
// - payment_batches.receivedAmountCents = dinero real recibido.
//   payment_batches.totalReceivedCents (columna preexistente, sin cambio de
//   nombre) = dinero APLICADO/imputado a cuotas.
// - La diferencia entre ambos genera (o no) un movimiento de
//   insured_account_movements — nunca toca payment_splits.
// - Caja = dinero real cobrado, y NUNCA resta saldos a favor. La cuenta
//   corriente es informativa (obligación), Caja es dinero físico — ambos
//   cálculos divergen a propósito durante la ventana "crédito consumido pero
//   la cuota relacionada todavía no se rindió" (ver calculateCreditActiveInCaja).
//
// Reglas de cómo cada tipo de movimiento afecta Caja (aprobadas, ver
// diagnóstico 2026-07-21b/c):
//   saldo_a_favor          → SUMA Caja (dinero real recibido de más).
//   aplicacion_saldo_favor → baja cuenta corriente ya (SUM simple, sin
//                            condicionar por rendered), pero NO baja Caja
//                            hasta que su relatedPaymentId se rinde.
//   devolucion_saldo_favor → BAJA Caja (salida real de plata).
//   cobro_saldo_deudor     → SUMA Caja (dinero real que entra a saldar deuda).
//   saldo_deudor           → NO afecta Caja (es un monto a recuperar, no
//                            plata que ya está en la oficina).
//   ajuste_manual          → NO mueve Caja nunca (ni suma ni resta) — si
//                            reduce crédito, se refleja en
//                            creditoActivoEnCajaCents (D) pero se cancela con
//                            creditoRegularizadoCents (=−D) en la fórmula
//                            consolidada de Caja, así el total no se mueve.

// ─── Tipos de movimiento ────────────────────────────────────────────────────

export const INSURED_ACCOUNT_MOVEMENT_TYPES = [
  "saldo_a_favor",
  "saldo_deudor",
  "aplicacion_saldo_favor",
  "cobro_saldo_deudor",
  "devolucion_saldo_favor",
  "ajuste_manual",
] as const;
export type InsuredAccountMovementType = (typeof INSURED_ACCOUNT_MOVEMENT_TYPES)[number];
const INSURED_ACCOUNT_MOVEMENT_TYPES_SET: ReadonlySet<string> = new Set(INSURED_ACCOUNT_MOVEMENT_TYPES);

export const INSURED_ACCOUNT_MOVEMENT_STATUSES = ["activo", "anulado"] as const;
export type InsuredAccountMovementStatus = (typeof INSURED_ACCOUNT_MOVEMENT_STATUSES)[number];

export class InsuredAccountValidationError extends Error {}

// ─── Diferencia recibido vs aplicado (origen del movimiento) ───────────────

export type BatchReceivedAppliedKind = "exacto" | "saldo_a_favor" | "saldo_deudor";

export interface BatchReceivedAppliedDifference {
  kind: BatchReceivedAppliedKind;
  differenceCents: number; // receivedCents - appliedCents; 0 en "exacto"
}

/**
 * Compara dinero real recibido (payment_batches.receivedAmountCents) contra
 * lo aplicado a cuotas (payment_batches.totalReceivedCents) para un mismo
 * cobro. receivedCents > appliedCents → sobrante (saldo a favor del
 * asegurado). receivedCents < appliedCents → faltante (saldo deudor). No
 * decide acá si corresponde generar el movimiento (ver
 * resolveSingleRealInsuredIdForBalance) — solo clasifica la diferencia.
 */
export function calculateBatchReceivedAppliedDifference(
  receivedCents: number,
  appliedCents: number
): BatchReceivedAppliedDifference {
  const differenceCents = receivedCents - appliedCents;
  if (differenceCents === 0) return { kind: "exacto", differenceCents: 0 };
  return { kind: differenceCents > 0 ? "saldo_a_favor" : "saldo_deudor", differenceCents };
}

/**
 * insuredId real y único de un cobro, para decidir si una diferencia
 * recibido/aplicado puede generar un movimiento de cuenta corriente. Mismo
 * criterio que resolveBatchInsuredId (batches.ts): si hay 0 o ≥2 insuredId
 * reales distintos entre los ítems del cobro, no hay un único dueño al que
 * acreditar/debitar → null (bloquea el saldo automático; ese sobrante/
 * faltante debe ir a payment_amount_adjustments en su lugar). Si exactamente
 * uno de los ítems tiene insuredId real, ese es el dueño de la diferencia.
 */
export function resolveSingleRealInsuredIdForBalance(insuredIds: ReadonlyArray<number | null>): number | null {
  const real = new Set(insuredIds.filter((id): id is number => id != null));
  return real.size === 1 ? [...real][0]! : null;
}

// ─── Saldo de cuenta corriente ──────────────────────────────────────────────

export interface InsuredAccountMovementForBalance {
  insuredId: number;
  signedAmountCents: number;
  status: InsuredAccountMovementStatus;
}

/** SUM(signedAmountCents) de los movimientos activo de UN asegurado. Positivo = a favor, negativo = deudor. */
export function calculateInsuredAccountBalance(
  movements: ReadonlyArray<Pick<InsuredAccountMovementForBalance, "signedAmountCents" | "status">>
): number {
  return movements.filter((m) => m.status === "activo").reduce((sum, m) => sum + m.signedAmountCents, 0);
}

export interface InsuredBalance {
  insuredId: number;
  balanceCents: number; // positivo = a favor, negativo = deudor
}

export interface InsuredAccountBalancesSummary {
  byInsured: InsuredBalance[];
  // Suma de todos los balances positivos (a favor) — informativo, Caja nunca resta esto.
  saldosAFavorPendientesCents: number;
  // Suma (en valor absoluto) de todos los balances negativos (deudores) — monto a recuperar.
  saldosDeudoresPendientesCents: number;
}

/** Agrupa por insuredId y separa el total en saldos a favor / deudores pendientes, para el panel informativo de cuenta corriente. */
export function summarizeInsuredAccountBalances(
  movements: ReadonlyArray<InsuredAccountMovementForBalance>
): InsuredAccountBalancesSummary {
  const byInsuredId = new Map<number, number>();
  for (const m of movements) {
    if (m.status !== "activo") continue;
    byInsuredId.set(m.insuredId, (byInsuredId.get(m.insuredId) ?? 0) + m.signedAmountCents);
  }
  const byInsured: InsuredBalance[] = [...byInsuredId.entries()].map(([insuredId, balanceCents]) => ({ insuredId, balanceCents }));
  let saldosAFavorPendientesCents = 0;
  let saldosDeudoresPendientesCents = 0;
  for (const b of byInsured) {
    if (b.balanceCents > 0) saldosAFavorPendientesCents += b.balanceCents;
    else if (b.balanceCents < 0) saldosDeudoresPendientesCents += -b.balanceCents;
  }
  return { byInsured, saldosAFavorPendientesCents, saldosDeudoresPendientesCents };
}

// ─── Validación de un movimiento nuevo ──────────────────────────────────────

export interface InsuredAccountMovementInput {
  insuredId: number;
  type: InsuredAccountMovementType;
  signedAmountCents: number;
  reason?: string | null;
  authorizedBy?: number | null;
  relatedPaymentId?: number | null;
  relatedInstallmentId?: number | null;
}

// El signo no es libre para los 5 tipos con semántica fija (ver comentario de
// cabecera) — solo ajuste_manual puede ir en cualquier sentido (puede cerrar
// tanto un crédito como una deuda). Validarlo acá evita que un bug de
// aplicación inserte, por ejemplo, un "saldo_deudor" con importe positivo que
// rompería silenciosamente el signo de calculateInsuredAccountBalance.
const REQUIRED_SIGN: Partial<Record<InsuredAccountMovementType, "positive" | "negative">> = {
  saldo_a_favor: "positive",
  cobro_saldo_deudor: "positive",
  saldo_deudor: "negative",
  aplicacion_saldo_favor: "negative",
  devolucion_saldo_favor: "negative",
};

// reason obligatorio a nivel app (no hay CHECK de DB) para estos 3 tipos —
// mismo texto exacto del pedido: "ajuste/devolución/deuda".
const REASON_REQUIRED_TYPES: ReadonlySet<InsuredAccountMovementType> = new Set([
  "ajuste_manual",
  "devolucion_saldo_favor",
  "saldo_deudor",
]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Valida un movimiento antes de insertarlo — reglas que el CHECK de la
 * migración 0030 no puede expresar (dependen del `type`, no solo de la forma
 * de la fila): signo esperado por tipo, reason obligatorio para
 * ajuste_manual/devolucion_saldo_favor/saldo_deudor, authorizedBy obligatorio
 * para ajuste_manual, y relatedPaymentId obligatorio para
 * aplicacion_saldo_favor (sin él, calculateCreditActiveInCaja no puede saber
 * si el crédito consumido ya se rindió — ver comentario de cabecera).
 */
export function validateInsuredAccountMovement(input: InsuredAccountMovementInput): void {
  if (!Number.isFinite(input.insuredId) || input.insuredId <= 0) {
    throw new InsuredAccountValidationError(`insuredId inválido: ${input.insuredId}.`);
  }
  if (!INSURED_ACCOUNT_MOVEMENT_TYPES_SET.has(input.type)) {
    throw new InsuredAccountValidationError(`Tipo de movimiento inválido: "${input.type}".`);
  }
  if (!Number.isFinite(input.signedAmountCents) || input.signedAmountCents === 0) {
    throw new InsuredAccountValidationError("signedAmountCents no puede ser 0.");
  }
  const requiredSign = REQUIRED_SIGN[input.type];
  if (requiredSign === "positive" && input.signedAmountCents < 0) {
    throw new InsuredAccountValidationError(`El movimiento "${input.type}" debe tener signedAmountCents positivo.`);
  }
  if (requiredSign === "negative" && input.signedAmountCents > 0) {
    throw new InsuredAccountValidationError(`El movimiento "${input.type}" debe tener signedAmountCents negativo.`);
  }
  if (REASON_REQUIRED_TYPES.has(input.type) && !isNonEmptyString(input.reason)) {
    throw new InsuredAccountValidationError(`El movimiento "${input.type}" requiere reason.`);
  }
  if (input.type === "ajuste_manual" && (input.authorizedBy == null || input.authorizedBy <= 0)) {
    throw new InsuredAccountValidationError('El movimiento "ajuste_manual" requiere authorizedBy.');
  }
  if (input.type === "aplicacion_saldo_favor" && (input.relatedPaymentId == null || input.relatedPaymentId <= 0)) {
    throw new InsuredAccountValidationError('El movimiento "aplicacion_saldo_favor" requiere relatedPaymentId.');
  }
}

// ─── Ajuste manual puro (sin asegurado real) ────────────────────────────────

export interface PaymentAmountAdjustmentInput {
  paymentId?: number | null;
  paymentBatchId?: number | null;
  amountCents: number;
  reason?: string | null;
  authorizedBy?: number | null;
}

/** Refleja el CHECK XOR de la migración 0030 + reason/authorizedBy siempre obligatorios (NOT NULL a nivel DB en esta tabla). */
export function validatePaymentAmountAdjustment(input: PaymentAmountAdjustmentInput): void {
  const hasPayment = input.paymentId != null;
  const hasBatch = input.paymentBatchId != null;
  if (hasPayment === hasBatch) {
    throw new InsuredAccountValidationError("Debe indicarse exactamente uno de paymentId o paymentBatchId.");
  }
  if (!Number.isFinite(input.amountCents) || input.amountCents === 0) {
    throw new InsuredAccountValidationError("amountCents no puede ser 0.");
  }
  if (!isNonEmptyString(input.reason)) {
    throw new InsuredAccountValidationError("reason es obligatorio.");
  }
  if (input.authorizedBy == null || input.authorizedBy <= 0) {
    throw new InsuredAccountValidationError("authorizedBy es obligatorio.");
  }
}

// ─── Ajuste por redondeo (payment_amount_adjustments, sin asegurado) ───────
//
// Caso de uso distinto del resto de esta tabla (ajuste administrativo
// discrecional): una diferencia CHICA y acotada entre dinero real recibido
// (SUM(splits)) y lo aplicado a las cuotas de un cobro por lote, aceptada
// explícitamente por el usuario en el momento de cobrar — nunca una decisión
// de negocio de cuenta corriente (por eso usa payment_amount_adjustments,
// nunca insured_account_movements: no tiene insuredId, funciona igual con
// lote de un asegurado, multiasegurado o 100% manual_payment).
//
// Convención de signo (sin CHECK de DB, igual criterio que
// calculateBatchReceivedAppliedDifference): amountCents = receivedCents -
// appliedCents. Positivo = sobrante real (dinero real de más). Negativo =
// faltante (dinero real de menos, nunca llegó).
export const MAX_ROUNDING_ADJUSTMENT_CENTS = 500;

export const ROUNDING_ADJUSTMENT_REASON = "Ajuste por redondeo autorizado en cobro en lote";

/**
 * Único chequeo propio de este caso de uso (además de
 * validatePaymentAmountAdjustment, que sigue aplicando para XOR/reason/
 * authorizedBy): la diferencia debe ser distinta de 0 (sin ajuste no hay nada
 * que registrar) y su valor absoluto no puede superar el tope — el backend
 * nunca confía en que el frontend ya filtró esto, aunque lo envíe forzado.
 */
export function validateRoundingAdjustment(input: { differenceCents: number }): void {
  if (!Number.isFinite(input.differenceCents) || input.differenceCents === 0) {
    throw new InsuredAccountValidationError("La diferencia debe ser distinta de 0 para registrar un ajuste por redondeo.");
  }
  if (Math.abs(input.differenceCents) > MAX_ROUNDING_ADJUSTMENT_CENTS) {
    throw new InsuredAccountValidationError(
      `El ajuste por redondeo solo admite diferencias de hasta $${(MAX_ROUNDING_ADJUSTMENT_CENTS / 100).toFixed(2)} ` +
      `(recibida: $${(Math.abs(input.differenceCents) / 100).toFixed(2)}).`
    );
  }
}

export interface PaymentAmountAdjustmentForCaja {
  amountCents: number;
  /** true si el payment/payment_batch al que pertenece este ajuste sigue "confirmado" (no anulado). */
  parentActive: boolean;
}

/**
 * roundingAdjustmentCreditCents — SUMA Caja (dinero real recibido de más),
 * mismo criterio que saldo_a_favor en calculateCreditActiveInCaja. Un
 * faltante (amountCents<0) nunca resta acá: esa porción de dinero que no
 * llegó ya quedó excluida de cartera.totalCents por el Math.min de
 * applyBatchToCartera (caja-summary.ts) — sumarla de nuevo en negativo la
 * duplicaría. Un ajuste cuyo batch/pago padre ya fue anulado (parentActive
 * false) no contribuye nada — se excluye entero, sin escribir ni anular la
 * fila histórica de payment_amount_adjustments (ver POST
 * /payment-batches/:id/cancel: no la toca, la exclusión es 100% de lectura).
 */
export function calculatePaymentAmountAdjustmentCreditInCaja(
  adjustments: ReadonlyArray<PaymentAmountAdjustmentForCaja>
): number {
  return adjustments
    .filter((a) => a.parentActive && a.amountCents > 0)
    .reduce((sum, a) => sum + a.amountCents, 0);
}

// ─── Contribución a Caja ─────────────────────────────────────────────────────

export interface InsuredAccountMovementForCaja {
  type: InsuredAccountMovementType;
  signedAmountCents: number;
  status: InsuredAccountMovementStatus;
  // Solo relevante para type="aplicacion_saldo_favor" — payments.rendered===1
  // del relatedPaymentId. null/undefined para el resto de los tipos.
  relatedPaymentRendered?: boolean | null;
}

/**
 * creditoActivoEnCajaCents — bucket GLOBAL (no por-batch/por-cheque a
 * propósito, evita un problema de FIFO entre varios créditos distintos):
 *   + saldo_a_favor (todo, activo)
 *   + aplicacion_saldo_favor CUYO relatedPayment ya está rendido (activo) —
 *     ya viene negativo en el ledger, sumarlo resta. Mientras NO esté
 *     rendido, el crédito sigue contando acá (Caja no baja antes de tiempo).
 *   + devolucion_saldo_favor (todo, activo) — ya viene negativo, resta.
 *   + ajuste_manual que reduce crédito (signedAmountCents < 0, activo) — ya
 *     viene negativo, resta. Un ajuste_manual que en cambio SUMA crédito
 *     (signedAmountCents > 0) no tiene plata real detrás y se excluye
 *     entero (ni suma ni resta acá).
 */
export function calculateCreditActiveInCaja(movements: ReadonlyArray<InsuredAccountMovementForCaja>): number {
  let total = 0;
  for (const m of movements) {
    if (m.status !== "activo") continue;
    if (m.type === "saldo_a_favor") {
      total += m.signedAmountCents;
    } else if (m.type === "aplicacion_saldo_favor" && m.relatedPaymentRendered === true) {
      total += m.signedAmountCents;
    } else if (m.type === "devolucion_saldo_favor") {
      total += m.signedAmountCents;
    } else if (m.type === "ajuste_manual" && m.signedAmountCents < 0) {
      total += m.signedAmountCents;
    }
  }
  return total;
}

/**
 * creditoRegularizadoCents — el espejo positivo de la porción "D" (ajuste_manual
 * que reduce crédito) que calculateCreditActiveInCaja restó. Se muestra por
 * separado ("activo/aplicable" vs. "regularizado por ajuste") pero al sumarse
 * con creditoActivoEnCajaCents se cancelan exactamente — un ajuste_manual
 * nunca mueve el total de Caja, solo lo reclasifica.
 */
export function calculateCreditRegularizedInCaja(movements: ReadonlyArray<InsuredAccountMovementForCaja>): number {
  let total = 0;
  for (const m of movements) {
    if (m.status !== "activo") continue;
    if (m.type === "ajuste_manual" && m.signedAmountCents < 0) total += -m.signedAmountCents;
  }
  return total;
}

/** cobrosSaldoDeudorCents — dinero real que entra a saldar una deuda de cuenta corriente previa. SUMA Caja. */
export function calculateCobroSaldoDeudorInCaja(movements: ReadonlyArray<InsuredAccountMovementForCaja>): number {
  let total = 0;
  for (const m of movements) {
    if (m.status !== "activo") continue;
    if (m.type === "cobro_saldo_deudor") total += m.signedAmountCents;
  }
  return total;
}

// ─── Fase 2D: seguridad al cancelar un batch con movimiento de cuenta corriente ───
//
// El pool de crédito/deuda de un asegurado es GLOBAL a propósito (ver
// calculateCreditActiveInCaja) — no hay FIFO ni tracking por origen, así que
// ningún movimiento de consumo (aplicacion_saldo_favor/devolucion_saldo_favor/
// ajuste_manual que reduce crédito, o cobro_saldo_deudor) puede atribuirse de
// forma confiable a UN origen específico (un batch/pago puntual) cuando el
// asegurado tiene más de uno.
//
// Anular el insured_account_movement que un batch originó (al cancelarlo) es
// matemáticamente seguro SOLO SI, sacando ese movimiento puntual del pool, lo
// que queda del resto del pool activo de ese mismo asegurado TODAVÍA alcanza
// para explicar todo lo que ya se consumió/cobró — si no alcanza, una parte
// de ese consumo necesariamente vino de este origen específico, y no hay
// forma segura de revertirlo automáticamente (ver POST
// /payment-batches/:id/cancel, 409 ACCOUNT_MOVEMENT_REQUIRES_MANUAL_REVIEW).
// No es una heurística: es una prueba — si el resto alcanza, este origen por
// definición no hizo falta para cubrir el consumo y sigue intacto.
export function isSafeToCancelAccountMovementOrigin(params: {
  /** Valor absoluto del propio movimiento (saldo_a_favor o saldo_deudor) que el batch/pago originó. */
  thisOriginAmountCents: number;
  /** Valor absoluto del pool activo total de ese asegurado en la misma dirección (crédito o deuda), INCLUYE thisOriginAmountCents. */
  totalActivePoolCents: number;
  /** Valor absoluto de lo ya consumido/cobrado activo de ese asegurado en la misma dirección. */
  totalActiveConsumptionCents: number;
}): boolean {
  return params.totalActiveConsumptionCents <= params.totalActivePoolCents - params.thisOriginAmountCents;
}
