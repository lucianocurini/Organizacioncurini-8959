// Helpers puros de payment_batches (Etapa 4A) — cobros que imputan varios
// ítems (cuotas, cobros con póliza, imputaciones libres) en un solo evento
// de cobro real (ej. un cheque que cubre varias cuotas juntas). Sin DB, sin
// efectos secundarios — reciben datos ya resueltos por el endpoint (que sí
// consulta la base) y devuelven resultados explícitos, mismo estilo que
// src/lib/payments/splits.ts y src/lib/installments/plan.ts.
//
// Etapa "lote multi-asegurado": un batch representa una OPERACIÓN de cobro,
// no un asegurado — puede mezclar pólizas de distintos integrantes de una
// familia (ej. un resumen familiar: póliza propia + de cónyuge + de hijo +
// una cuota faltante cargada a mano), y el primer ítem puede ser una
// imputación completamente manual. Ya no existe ninguna validación de
// "mismo asegurado" en la creación — cada ítem identifica su propio origen
// de forma independiente (ver BatchItemContext.insuredId, nullable).
//
// Reutiliza isMultipleOfCent/isAllowedPaymentMethod/classifySplitGroup de
// splits.ts — un solo criterio de "importe válido"/"método permitido"/"grupo"
// para pagos individuales y para batches, sin dos fuentes de verdad.
//
// IMPORTANTE: el backend nunca debe confiar en insuredId, importe, compañía
// ni estado que mande el frontend — todo eso se relee de la base en el
// endpoint (POST /api/payment-batches) y se le pasa YA resuelto a estos
// helpers. Estos helpers solo validan consistencia sobre datos que el
// endpoint garantiza que vinieron de la base, no del body crudo.
//
// Etapa "cobro manual real": un ítem del batch puede ser, además de una
// cuota existente (source="installment"), uno de dos tipos de cobro manual
// (nunca una deuda — mismo dinero real que una cuota, cuenta en Caja, se
// rinde de verdad):
//   - source="policy_manual_payment": cobro contra una póliza REAL sin cuota
//     puntual (mismo concepto que POST /payments standalone con policyId +
//     installmentId vacío). isRivadavia se deriva de la compañía REAL de esa
//     póliza — misma fuente confiable que un installment.
//   - source="manual_payment": imputación COMPLETAMENTE libre (mismo modelo
//     que la variante "Imputación manual" ya existente en POST /payments
//     standalone cuando no se manda policyId — texto libre
//     manualPayer/manualPolicyNumber/manualCompany, sin ninguna fila real
//     detrás). A diferencia del standalone histórico (que sí aplica Pronto
//     Pago con solo `manualCompany` conteniendo "rivadavia" — comportamiento
//     legacy, no se toca acá), un manual_payment de batch NUNCA califica
//     para el recargo — isRivadavia siempre false por construcción — porque
//     acá no hay ninguna fuente confiable (una compañía tipeada a mano no
//     alcanza para un recargo automático de $800). Ver comentario en
//     POST /payment-batches (index.ts) para la decisión completa.
// Ningún cobro manual crea policy_installments, cash_debts, ni un
// remittance_item source='manual_debt'. Su payment hijo nunca dispara
// recalculateInstallmentPaymentStatus (no hay cuota que recalcular).

import { isMultipleOfCent, isAllowedPaymentMethod, classifySplitGroup, type SplitGroup } from "./splits";
import { isSurchargeAbsorbedByGroup } from "./policy-economic-group";

export class PaymentBatchValidationError extends Error {}

// Mismo texto que ya usan POST/PUT /payments (Etapa 3B) para rechazar mixed
// — una sola redacción visible al usuario para el mismo tipo de error.
export const BATCH_MIXED_GROUP_ERROR =
  "No se pueden combinar medios propios con pagos directos a la compañía en un mismo cobro.";

// ─── Ítems del batch (cuotas + cobros manuales, con o sin póliza real) ────────

// Forma tal cual puede llegar del body: con source explícito, o legacy sin
// source (siempre installment — compatibilidad con clientes/tests previos a
// esta etapa, ver normalizeBatchItems).
export type PaymentBatchItemInput =
  | { source: "installment"; installmentId: number }
  | { source: "policy_manual_payment"; policyId: number; amount: number; description?: string | null }
  | {
      source: "manual_payment";
      manualPayer?: string | null;
      manualPolicyNumber?: string | null;
      manualCompany?: string | null;
      amount: number;
      description?: string | null;
    }
  | { installmentId: number }; // legacy sin source

export type NormalizedPaymentBatchItem =
  | { source: "installment"; installmentId: number }
  | { source: "policy_manual_payment"; policyId: number; amountCents: number; description: string | null }
  | {
      source: "manual_payment";
      manualPayer: string | null;
      manualPolicyNumber: string | null;
      manualCompany: string | null;
      amountCents: number;
      description: string | null;
    };

/**
 * Valida la forma del array de ítems tal cual llega del body: al menos uno,
 * IDs/importes válidos, sin installmentId repetido dentro del mismo cobro
 * (los cobros manuales no tienen un id natural pre-inserción, así que no se
 * deduplican acá — dos cobros manuales iguales son una decisión de negocio
 * válida, ej. dos cheques distintos del mismo importe). No conoce (ni puede
 * conocer, es puro) si la cuota/póliza existe realmente ni su estado — eso
 * lo valida el endpoint con datos reales vía validateInstallmentsEligibility
 * más abajo. No valida "mismo asegurado" — un batch puede mezclar ítems de
 * distintos asegurados (ver comentario de cabecera del archivo).
 *
 * Compatibilidad: un ítem sin `source` (forma anterior a esta etapa, solo
 * `{installmentId}`) se normaliza como si fuera `source: "installment"` —
 * los clientes/tests existentes que todavía mandan esa forma siguen
 * funcionando sin cambios. La UI nueva manda siempre `source` explícito.
 *
 * manual_payment: mismo criterio que la variante "Imputación manual" ya
 * existente en POST /payments standalone — exige al menos UNO de
 * manualPayer/manualPolicyNumber (no ambos, no específicamente el pagador),
 * nunca los dos vacíos a la vez. manualCompany es siempre opcional.
 */
export function normalizeBatchItems(items: PaymentBatchItemInput[]): NormalizedPaymentBatchItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PaymentBatchValidationError("Debe indicarse al menos una cuota.");
  }
  const seenInstallmentIds = new Set<number>();
  const normalized: NormalizedPaymentBatchItem[] = [];
  items.forEach((raw: any, i) => {
    const label = `ítem ${i + 1}`;
    const source = raw?.source == null ? "installment" : raw.source;

    if (source === "installment") {
      const installmentId = Number(raw?.installmentId);
      if (!Number.isFinite(installmentId) || installmentId <= 0) {
        throw new PaymentBatchValidationError(`ID de cuota inválido: ${raw?.installmentId}.`);
      }
      if (seenInstallmentIds.has(installmentId)) {
        throw new PaymentBatchValidationError(`La cuota ${installmentId} está repetida en el mismo cobro.`);
      }
      seenInstallmentIds.add(installmentId);
      normalized.push({ source: "installment", installmentId });
      return;
    }

    if (source === "policy_manual_payment") {
      const policyId = Number(raw?.policyId);
      if (!Number.isFinite(policyId) || policyId <= 0) {
        throw new PaymentBatchValidationError(`El ${label} (cobro manual) tiene un policyId inválido: ${raw?.policyId}.`);
      }
      const amount = Number(raw?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new PaymentBatchValidationError(`El importe del ${label} (cobro manual) debe ser un número mayor a cero.`);
      }
      if (!isMultipleOfCent(amount)) {
        throw new PaymentBatchValidationError(`El importe del ${label} (cobro manual) no puede tener más de dos decimales: ${raw?.amount}.`);
      }
      const description = typeof raw?.description === "string" && raw.description.trim() ? raw.description.trim() : null;
      normalized.push({ source: "policy_manual_payment", policyId, amountCents: Math.round(amount * 100), description });
      return;
    }

    if (source === "manual_payment") {
      const manualPayer = typeof raw?.manualPayer === "string" ? raw.manualPayer.trim() : "";
      const manualPolicyNumber = typeof raw?.manualPolicyNumber === "string" ? raw.manualPolicyNumber.trim() : "";
      const manualCompany = typeof raw?.manualCompany === "string" ? raw.manualCompany.trim() : "";
      if (!manualPayer && !manualPolicyNumber) {
        throw new PaymentBatchValidationError(
          `El ${label} (imputación manual) debe incluir al menos el pagador o el N° de póliza manual.`
        );
      }
      const amount = Number(raw?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new PaymentBatchValidationError(`El importe del ${label} (imputación manual) debe ser un número mayor a cero.`);
      }
      if (!isMultipleOfCent(amount)) {
        throw new PaymentBatchValidationError(`El importe del ${label} (imputación manual) no puede tener más de dos decimales: ${raw?.amount}.`);
      }
      const description = typeof raw?.description === "string" && raw.description.trim() ? raw.description.trim() : null;
      normalized.push({
        source: "manual_payment",
        manualPayer: manualPayer || null,
        manualPolicyNumber: manualPolicyNumber || null,
        manualCompany: manualCompany || null,
        amountCents: Math.round(amount * 100),
        description,
      });
      return;
    }

    throw new PaymentBatchValidationError(`El ${label} tiene un source inválido: "${source}".`);
  });
  return normalized;
}

/**
 * Ítem ya resuelto — la fuente real de insuredId/amount/estado. `kind`
 * discrimina el resto de los campos:
 *   - installment: installmentId/installmentStatus/rendered reales,
 *     policyId/policyStatus/insuredId reales, manualPayer/manualPolicyNumber/
 *     manualCompany siempre null.
 *   - policy_manual_payment: policyId/policyStatus/insuredId reales,
 *     installmentId/installmentStatus/rendered siempre null,
 *     manualPayer/manualPolicyNumber/manualCompany siempre null (se
 *     muestran vía la póliza real, no como texto libre).
 *   - manual_payment: policyId/policyStatus/insuredId SIEMPRE null (no hay
 *     ninguna fila real detrás — ni póliza ni asegurado), installmentId/
 *     installmentStatus/rendered siempre null, manualPayer/
 *     manualPolicyNumber/manualCompany son el texto libre cargado.
 *
 * Etapa "lote multi-asegurado": un batch ya NO exige que todos sus ítems
 * compartan insuredId — cada ítem lleva el suyo (o null) de forma
 * independiente. Ver resolveBatchInsuredId más abajo para cómo se deriva el
 * insuredId legacy del batch (dato descriptivo, nunca una restricción).
 */
export interface BatchItemContext {
  kind: "installment" | "policy_manual_payment" | "manual_payment";
  installmentId: number | null;
  policyId: number | null;
  insuredId: number | null;
  amount: number; // pesos
  installmentStatus: string | null; // pendiente | pagada | vencida | no_exigible
  rendered: number | null; // 0 | 1
  policyStatus: string | null; // activa | vencida | cancelada | por_vencer — null si no hay póliza real
  isRivadavia: boolean;
  // Grupo económico Rivadavia (ver policy-economic-group.ts) — policyType/
  // parentPolicyId de la póliza REAL del ítem, null para manual_payment (sin
  // póliza real detrás). Solo se usan para decidir si una accesoria de
  // Accidentes de Pasajeros absorbe su recargo en el de la principal —
  // nunca cambian amount/installmentId/payment hijo.
  policyType: string | null;
  parentPolicyId: number | null;
  description: string | null; // policy_manual_payment / manual_payment
  manualPayer: string | null; // solo manual_payment
  manualPolicyNumber: string | null; // solo manual_payment
  manualCompany: string | null; // solo manual_payment
}

// Alias de compatibilidad — el nombre anterior a esta etapa (antes de que un
// ítem pudiera ser manual) sigue siendo válido para código/tests existentes.
export type BatchInstallmentContext = BatchItemContext;

/**
 * insuredId legacy del batch (payment_batches.insured_id, nullable desde la
 * migración 0026) — dato DERIVADO, nunca una restricción de creación:
 *   - si todos los ítems con insuredId real (installment/policy_manual_payment)
 *     coinciden en el mismo valor, y no hay ítems manual_payment sin
 *     asegurado que "rompan" esa identidad única... en realidad SÍ se
 *     considera unívoco aunque haya manual_payment mezclados, porque esos no
 *     tienen insuredId propio que pueda contradecir al resto — se ignoran
 *     para esta derivación, no se tratan como "otro asegurado".
 *   - si hay dos o más insuredId reales distintos → null (mezcla real).
 *   - si NINGÚN ítem tiene insuredId real (0% installment/policy_manual_payment,
 *     100% manual_payment) → null (no hay ningún asegurado real que guardar).
 */
export function resolveBatchInsuredId(items: BatchItemContext[]): number | null {
  const realInsuredIds = new Set(items.map((i) => i.insuredId).filter((id): id is number => id != null));
  if (realInsuredIds.size === 1) return [...realInsuredIds][0]!;
  return null;
}

/**
 * Elegibilidad por ítem:
 *  - installment: pendiente/vencida únicamente (nunca "pagada" — evita
 *    duplicar el cobro), sin rendir todavía (rendered=1 significa que la
 *    agencia ya la rindió a la compañía sin cobrarle al asegurado), exigible
 *    (no_exigible es una cuota de una póliza anulada manualmente) y con su
 *    póliza no cancelada. Sin pagos parciales: el importe imputado es
 *    siempre installment.amount completo.
 *  - policy_manual_payment: no hay cuota ni estado de cobro previo que
 *    validar (es dinero nuevo, no preexistente) — el único requisito es que
 *    la póliza indicada no esté cancelada.
 *  - manual_payment: no hay ninguna fila real que validar — nada que
 *    chequear acá (siempre elegible por construcción; la única validación
 *    de forma ya corrió en normalizeBatchItems).
 */
export function validateInstallmentsEligibility(items: BatchItemContext[]): void {
  for (const i of items) {
    if (i.kind === "installment") {
      if (i.installmentStatus === "pagada") {
        throw new PaymentBatchValidationError(`La cuota ${i.installmentId} ya está pagada.`);
      }
      if (i.installmentStatus === "no_exigible") {
        throw new PaymentBatchValidationError(`La cuota ${i.installmentId} no es exigible.`);
      }
      // Migración 0035: mismo criterio que "pagada"/"no_exigible" — una cuota
      // duplicada nunca es cobrable, ni siquiera dentro de un lote.
      if (i.installmentStatus === "duplicada") {
        throw new PaymentBatchValidationError(`La cuota ${i.installmentId} es un duplicado invalidado — no corresponde cobrarla.`);
      }
      if (i.rendered === 1) {
        throw new PaymentBatchValidationError(`La cuota ${i.installmentId} ya fue rendida.`);
      }
      if (i.policyStatus === "cancelada") {
        throw new PaymentBatchValidationError(`La póliza de la cuota ${i.installmentId} está cancelada.`);
      }
    } else if (i.kind === "policy_manual_payment") {
      if (i.policyStatus === "cancelada") {
        throw new PaymentBatchValidationError(`La póliza del cobro manual (póliza ${i.policyId}) está cancelada.`);
      }
    }
    // manual_payment: nada que validar contra la base — no hay fila real.
  }
}

/** SUM(amount) de todos los ítems del cobro (cuotas + manuales), en centavos. */
export function calculateBaseAmountCents(items: BatchItemContext[]): number {
  return items.reduce((sum, i) => sum + Math.round(i.amount * 100), 0);
}

// ─── Medios de pago del batch ─────────────────────────────────────────────────

export interface PaymentBatchSplitInput {
  method: string;
  amount: number;
  notes?: string | null;
}

export interface NormalizedPaymentBatchSplit {
  method: string;
  amountCents: number;
  notes: string | null;
}

/**
 * Valida cada fila de medios tal cual llega del body: método permitido
 * (nunca "lote" ni "combinado" — esos son valores de resumen, no medios
 * reales; isAllowedPaymentMethod ya los excluye, mismo criterio que 3B),
 * importe > 0, máximo dos decimales reales. NO valida acá que la suma
 * coincida con el total — eso recién se puede hacer después de calcular
 * baseAmountCents+surchargeAmountCents (ver validateBatchTotals), porque acá
 * todavía no se conoce el total del cobro.
 */
export function normalizeBatchSplits(splits: PaymentBatchSplitInput[]): NormalizedPaymentBatchSplit[] {
  if (!Array.isArray(splits) || splits.length === 0) {
    throw new PaymentBatchValidationError("Debe indicarse al menos un medio de pago.");
  }
  return splits.map((s, i) => {
    const label = `medio ${i + 1}`;
    const method = typeof s?.method === "string" ? s.method.trim() : "";
    if (!method) {
      throw new PaymentBatchValidationError(`El método del ${label} no puede estar vacío.`);
    }
    if (!isAllowedPaymentMethod(method)) {
      throw new PaymentBatchValidationError(`Método no permitido en el ${label}: "${method}".`);
    }
    const amount = Number(s.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new PaymentBatchValidationError(`El importe del ${label} (${method}) debe ser un número mayor a cero.`);
    }
    if (!isMultipleOfCent(amount)) {
      throw new PaymentBatchValidationError(`El importe del ${label} (${method}) no puede tener más de dos decimales: ${s.amount}.`);
    }
    return {
      method, amountCents: Math.round(amount * 100),
      notes: typeof s.notes === "string" && s.notes.trim() ? s.notes.trim() : null,
    };
  });
}

/**
 * Clasifica el grupo (own/direct_company) de los medios ya normalizados y
 * rechaza "mixed" de inmediato — mismo criterio que 3B, antes de cualquier
 * escritura.
 */
export function resolveBatchSplitGroup(splits: NormalizedPaymentBatchSplit[]): SplitGroup {
  const group = classifySplitGroup(splits);
  if (group === "mixed") {
    throw new PaymentBatchValidationError(BATCH_MIXED_GROUP_ERROR);
  }
  return group;
}

// ─── Pronto Pago ──────────────────────────────────────────────────────────────

/**
 * $800 por cada GRUPO ECONÓMICO Rivadavia elegible — nunca por recibo ni por
 * póliza suelta. Solo aplica si TODOS los medios del batch son del grupo
 * "own" (mixed ya se rechazó antes de llegar acá). `isRivadavia` es siempre
 * false para manual_payment (imputación libre, ver comentario de cabecera)
 * — así que esta función nunca les genera recargo, sin necesidad de un caso
 * especial acá: ya viene resuelto en el contexto.
 *
 * Grupo económico (ver policy-economic-group.ts): una póliza accesoria de
 * Accidentes de Pasajeros cuyo parentPolicyId apunta a otra póliza presente
 * en ESTE MISMO batch no genera su propio recargo — el de su principal ya
 * cubre el grupo entero. Esto es estrictamente sobre el RECARGO: el
 * importe base de la accesoria se sigue sumando igual, y sigue generando su
 * propio payment hijo (ver POST /payment-batches) — acá solo se decide qué
 * contextos entran en la lista que dispara un cash_entry de recargo.
 *
 * Dos o más cuotas de la MISMA póliza (sin relación de accesoria) siguen
 * generando un recargo cada una — esa regla preexistente no cambia; el
 * agrupamiento nuevo es exclusivamente para el vínculo principal/accesoria.
 *
 * Devuelve los CONTEXTOS concretos que generan recargo (no solo un id — un
 * cobro manual no tiene installmentId al que atarlo), para que el endpoint
 * sepa a qué payment hijo asociar cada cash_entry por identidad de objeto.
 */
export function calculateApplicableRivadaviaSurcharges(
  items: BatchItemContext[],
  splitGroup: SplitGroup
): BatchItemContext[] {
  if (splitGroup !== "own") return [];
  const policyIdsInScope = new Set(
    items.filter((i): i is BatchItemContext & { policyId: number } => i.policyId != null).map((i) => i.policyId)
  );
  return items.filter((i) => {
    if (!i.isRivadavia) return false;
    if (i.policyId == null) return true; // manual_payment: sin póliza real, sin cambios de comportamiento
    return !isSurchargeAbsorbedByGroup(
      { id: i.policyId, type: i.policyType ?? "", parentPolicyId: i.parentPolicyId },
      policyIdsInScope
    );
  });
}

export const SURCHARGE_AMOUNT_CENTS = 80000; // $800, mismo monto fijo que Etapa 3B

// ─── Totales ──────────────────────────────────────────────────────────────────

export interface PaymentBatchTotals {
  baseAmountCents: number;
  surchargeAmountCents: number;
  totalReceivedCents: number;
}

/** totalReceivedCents = baseAmountCents + surchargeAmountCents, en un solo lugar. */
export function calculateBatchTotals(baseAmountCents: number, surchargeAmountCents: number): PaymentBatchTotals {
  return { baseAmountCents, surchargeAmountCents, totalReceivedCents: baseAmountCents + surchargeAmountCents };
}

export interface PaymentBatchValidationResult {
  valid: boolean;
  errorMessage: string | null;
}

/**
 * La única validación que NO está garantizada por construcción: que lo que
 * la persona cargó como medios (splits) efectivamente sume el total a
 * recibir (base + recargos). No se decompone el instrumento — no se intenta
 * saber "cuánto del cheque es recargo", solo que el total cierre exacto.
 */
export function validateBatchTotals(
  totals: PaymentBatchTotals,
  splits: NormalizedPaymentBatchSplit[]
): PaymentBatchValidationResult {
  const distributedCents = splits.reduce((sum, s) => sum + s.amountCents, 0);
  if (distributedCents !== totals.totalReceivedCents) {
    return {
      valid: false,
      errorMessage:
        `La suma de los medios ($${(distributedCents / 100).toFixed(2)}) no coincide con el total a recibir ` +
        `($${(totals.totalReceivedCents / 100).toFixed(2)} = base $${(totals.baseAmountCents / 100).toFixed(2)} ` +
        `+ recargos $${(totals.surchargeAmountCents / 100).toFixed(2)}).`,
    };
  }
  return { valid: true, errorMessage: null };
}

// ─── Estado del batch ─────────────────────────────────────────────────────────

export type PaymentBatchStatus = "confirmado" | "anulado";

const VALID_BATCH_TRANSITIONS: Record<PaymentBatchStatus, PaymentBatchStatus[]> = {
  confirmado: ["anulado"],
  anulado: [], // terminal — no hay vuelta atrás
};

/**
 * confirmado → anulado es la única transición permitida (anular el batch
 * completo, ver diagnóstico de la vuelta anterior). anulado es terminal. No
 * se usa todavía en 4A (no hay PUT/DELETE de batch), pero queda disponible y
 * testeada para cuando se implemente.
 */
export function validateBatchStatusTransition(current: PaymentBatchStatus, next: PaymentBatchStatus): void {
  const allowed = VALID_BATCH_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new PaymentBatchValidationError(`No se puede pasar un batch de "${current}" a "${next}".`);
  }
}

// ─── Anulación de un batch confirmado (corrección segura) ──────────────────
//
// "Corregir" un lote confirmado nunca es una edición monetaria — es anular
// (con trazabilidad: quién/cuándo/por qué, ver payment_batches.cancelledAt/
// cancelledBy/cancellationReason, migración 0027) y cargar un lote nuevo. La
// anulación en sí solo se permite si el lote todavía no generó NINGUNA
// actividad posterior que dependa de él — apenas exista una sola, se
// bloquea entera (nunca una anulación parcial de "lo que todavía se puede").
//
// Todo esto llega YA RESUELTO desde la base (mismo criterio que el resto del
// archivo) — este helper no hace ninguna consulta, solo decide.

export interface BatchCancelChildPayment {
  id: number;
  status: string; // confirmado | pendiente | anulado
  rendered: number; // 0 | 1
}

export interface BatchCancelCheck {
  id: number;
  status: string; // en_cartera | entregado_compania | cobrado | rechazado | anulado
}

export interface BatchCancelInput {
  batchStatus: PaymentBatchStatus;
  childPayments: ReadonlyArray<BatchCancelChildPayment>;
  // COUNT de remittance_allocations.payment_batch_id = este batch.
  remittanceAllocationCount: number;
  // COUNT de remittance_items que referencian este batch: source='payment'
  // con sourceId de alguno de sus hijos, O source='cash_entry' con sourceId
  // del recargo Pronto Pago de alguno de sus hijos (un batch puede terminar
  // rendido por remittance_items aun sin allocation propia — ver
  // src/api/index.ts, POST /remittances, rama canal='pronto_pago').
  remittanceItemCount: number;
  checks: ReadonlyArray<BatchCancelCheck>;
}

export interface BatchCancelCheckResult {
  canCancel: boolean;
  blockingReasons: string[];
}

/**
 * Reglas aprobadas (ver pedido): un batch confirmado se puede anular
 * solamente si ninguno de sus hijos está rendido, no existe ninguna
 * remittance_allocation ni remittance_item que lo referencie, y todos sus
 * cheques siguen "en_cartera" (cualquier otro estado — entregado, cobrado,
 * rechazado, o ya anulado individualmente — significa que hubo actividad
 * real sobre ese cheque y bloquea). Todas las razones de bloqueo se
 * acumulan (nunca se corta en la primera) para que cancel-check pueda
 * mostrarlas todas juntas de una vez.
 */
export function checkBatchCancellable(input: BatchCancelInput): BatchCancelCheckResult {
  const reasons: string[] = [];

  if (input.batchStatus !== "confirmado") {
    reasons.push(`El cobro no está confirmado (status="${input.batchStatus}") — no se puede anular.`);
  }

  const renderedChildren = input.childPayments.filter((p) => p.rendered === 1);
  if (renderedChildren.length > 0) {
    reasons.push(
      `Tiene ${renderedChildren.length} pago(s) ya rendido(s): ${renderedChildren.map((p) => p.id).join(", ")}. Anulá la rendición primero.`
    );
  }

  if (input.remittanceAllocationCount > 0) {
    reasons.push(`Tiene ${input.remittanceAllocationCount} asignación(es) de rendición (remittance_allocations) vinculada(s).`);
  }

  if (input.remittanceItemCount > 0) {
    reasons.push(`Tiene ${input.remittanceItemCount} ítem(s) de rendición (remittance_items) vinculado(s).`);
  }

  const activeChecks = input.checks.filter((c) => c.status !== "en_cartera");
  if (activeChecks.length > 0) {
    reasons.push(
      `Tiene ${activeChecks.length} cheque(s) que ya no está(n) en cartera (status distinto de "en_cartera"): ${activeChecks.map((c) => c.id).join(", ")}.`
    );
  }

  return { canCancel: reasons.length === 0, blockingReasons: reasons };
}

// ─── PATCH administrativo (solo datos no monetarios) ────────────────────────

const BATCH_PATCH_ALLOWED_FIELDS: ReadonlySet<string> = new Set(["paymentDate", "notes"]);

/**
 * Un batch confirmado y sin ningún hijo rendido admite editar solamente
 * paymentDate/notes — nunca items, importes, splits, cheques, insuredId,
 * recargos ni totales (esos exigen anular + crear un lote nuevo, ver
 * checkBatchCancellable). Devuelve los nombres de campo del body que están
 * fuera de la lista blanca, para que el endpoint arme un 400 explícito con
 * todos los rechazados de una vez.
 */
export function findDisallowedBatchPatchFields(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => !BATCH_PATCH_ALLOWED_FIELDS.has(k));
}

export interface BatchPatchCheckResult {
  canPatch: boolean;
  blockingReasons: string[];
}

export function canPatchBatch(batchStatus: PaymentBatchStatus, childPayments: ReadonlyArray<BatchCancelChildPayment>): BatchPatchCheckResult {
  const reasons: string[] = [];
  if (batchStatus !== "confirmado") {
    reasons.push(`El cobro no está confirmado (status="${batchStatus}") — no se pueden editar sus datos.`);
  }
  const renderedChildren = childPayments.filter((p) => p.rendered === 1);
  if (renderedChildren.length > 0) {
    reasons.push(`Tiene ${renderedChildren.length} pago(s) ya rendido(s) — no se pueden editar sus datos. Anulá la rendición primero.`);
  }
  return { canPatch: reasons.length === 0, blockingReasons: reasons };
}
