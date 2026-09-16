// Partición legacy/titular + resolución del impacto en Caja de las funding
// allocations de un lote con titular de cuenta — Etapa 1B-3-D. Vive en
// src/api/ (no en src/lib/payments/) porque, a diferencia de
// account-holder-funding-caja.ts (puro), ESTE SÍ toca DB — recibe siempre el
// cliente ya resuelto por el caller (GET /cash/summary en index.ts), nunca
// importa la conexión global. Mismo criterio que account-holder-funding-batch.ts.
//
// ─── Por qué hace falta partición ───────────────────────────────────────────
//
// insured_account_movements y payment_amount_adjustments son las MISMAS
// tablas que ya usa el modelo "sobrantes/faltantes" legacy (Fase 2A-2H,
// insured-account.ts) — comparten exactamente los mismos `type` (
// aplicacion_saldo_favor/saldo_deudor/saldo_a_favor) y la misma tabla de
// ajustes de redondeo. Un batch con accountHolderInsuredId != null (Etapa
// 1B) usa el MISMO esquema pero con semántica DISTINTA: un movimiento puede
// financiar VARIOS destinos que se rinden en momentos distintos (nunca 1:1
// como relatedPaymentId legacy), y el redondeo titular es SIEMPRE un gasto
// absorbido por la oficina (signo negativo, se resta al rendir), nunca un
// sobrante real (signo positivo, se suma sin condición) como el redondeo
// legacy. Sumar ambos modelos con la MISMA fórmula sería doble conteo (o,
// para el redondeo, invertiría el signo del negocio). La partición es por
// BATCH DUEÑO (originBatchId / paymentBatchId -> payment_batches.
// account_holder_insured_id), nunca por `type` — ambos modelos usan los
// mismos types. Dato histórico sin originBatchId (o cuyo batch no tiene
// accountHolderInsuredId) siempre cae en "legacy" — comportamiento actual,
// sin cambios.
//
// ─── parentActive ───────────────────────────────────────────────────────────
//
// Ver FundingAllocationRenderStatus.parentActive (account-holder-funding-
// caja.ts): credit_movement/debt_movement exigen batch confirmado Y
// movimiento activo; rounding_adjustment (sin status propio) exige solo
// batch confirmado. Se resuelven acá, nunca en el módulo puro (que no toca
// DB) — payment_batch_funding_allocations/payment_amount_adjustments NUNCA
// se escriben ni se marcan al anular un batch (quedan como historial, ver
// POST /payment-batches/:id/cancel en index.ts): la exclusión es 100% de
// lectura, en el momento de calcular Caja.
//
// ─── destinationRendered ────────────────────────────────────────────────────
//
// Fuente autoritativa única — payments.rendered / cash_entries.rendered,
// leídos en vivo acá (nunca cacheados, nunca inferidos de remittance_items:
// esas dos columnas son la misma fuente que ya usa el resto de GET
// /cash/summary para paymentsInCartera/paymentsRendered/manualInCartera/
// manualRendered). Una allocation credit_movement/debt_movement/
// rounding_adjustment SIEMPRE tiene como destino un payment o un cash_entry
// — nunca otro movimiento (new_credit_movement solo puede recibir splits
// reales, ver account-holder-funding-allocations.ts) — así que no hace falta
// contemplar destinationAccountMovementId acá.
//
// ─── saldo_a_favor NUEVO (new_credit_movement) ──────────────────────────────
//
// La fila de saldo_a_favor que un batch titular genera cuando sobra crédito
// nunca es fuente de ninguna allocation (es terminal) — no participa de
// calculateAllocationRenderedCajaImpact. Su aporte a Caja es el MISMO que ya
// usa el modelo legacy para su propio saldo_a_favor (calculateCreditActiveInCaja):
// se suma sin condición mientras siga "activo", sin depender de que se rinda
// nada. Acá se resuelve con el mismo criterio parentActive (batch confirmado
// Y movimiento activo) por consistencia y para no depender de la invariante
// de que la cancelación de un batch siempre anula sus propios saldo_a_favor/
// saldo_deudor de forma atómica (ver resolveAccountMovementCancelPlan,
// index.ts) — aunque hoy esa invariante se sostiene, no hace falta apoyarse
// en ella acá.

import { inArray, or } from "drizzle-orm";
import { paymentBatches, paymentBatchFundingAllocations, payments, cashEntries } from "./database/schema";
import {
  calculateAllocationRenderedCajaImpact,
  type FundingAllocationRenderStatus,
  type FundingCajaSourceKind,
} from "../lib/payments/account-holder-funding-caja";
import {
  calculateCreditActiveInCaja, calculateCreditRegularizedInCaja, calculateCobroSaldoDeudorInCaja,
  calculatePaymentAmountAdjustmentCreditInCaja,
  type InsuredAccountMovementForCaja, type PaymentAmountAdjustmentForCaja,
} from "../lib/payments/insured-account";
import type { AccountHolderFundingDbClient } from "./account-holder-funding-batch";

export class AccountHolderFundingCajaLoaderError extends Error {}

function assertArray(label: string, value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new AccountHolderFundingCajaLoaderError(`${label} debe ser un array (recibido: ${value === null ? "null" : typeof value}).`);
  }
}

// ─── Contrato de entrada — mismas filas que el endpoint ya consulta ───────

export interface AccountHolderCajaMovementRow {
  id: number;
  /** aplicacion_saldo_favor | saldo_deudor | saldo_a_favor | cobro_saldo_deudor | devolucion_saldo_favor | ajuste_manual — solo los 3 primeros pueden ser titular (ver persistAccountHolderFundingArtifacts). */
  type: string;
  status: "activo" | "anulado";
  signedAmountCents: number;
  originBatchId: number | null;
  /** Solo relevante para type="aplicacion_saldo_favor" legacy — ver loadAccountMovementCajaTotals. Opcional: loadAccountHolderFundingCajaImpact no lo necesita. */
  relatedPaymentId?: number | null;
}

export interface AccountHolderCajaAdjustmentRow {
  id: number;
  paymentBatchId: number | null;
  amountCents: number;
}

export interface LoadAccountHolderFundingCajaImpactParams {
  movements: ReadonlyArray<AccountHolderCajaMovementRow>;
  adjustments: ReadonlyArray<AccountHolderCajaAdjustmentRow>;
}

export interface TitularFundingCajaImpact {
  /** saldo_a_favor NUEVO activo (batch confirmado) menos crédito consumido cuyo destino ya se rindió — mismo signo/criterio que creditoActivoEnCajaCents legacy, listo para sumarse directo. */
  creditoActivoEnCajaCents: number;
  /** Saldo deudor cubierto por la oficina cuyo destino ya se rindió — gasto real, restar de Caja. */
  debtRenderedExpenseCents: number;
  /** Redondeo absorbido por la oficina cuyo destino ya se rindió — gasto real, restar de Caja. */
  roundingRenderedExpenseCents: number;
}

export interface LoadAccountHolderFundingCajaImpactResult {
  /** Movimientos SIN batch titular (originBatchId null, o su batch no tiene accountHolderInsuredId) — pasan tal cual al cálculo legacy existente, sin cambios. */
  legacyMovements: AccountHolderCajaMovementRow[];
  /** Ajustes de redondeo SIN batch titular — pasan tal cual a calculatePaymentAmountAdjustmentCreditInCaja. */
  legacyAdjustments: AccountHolderCajaAdjustmentRow[];
  titular: TitularFundingCajaImpact;
}

const TITULAR_MOVEMENT_SOURCE_KIND: Partial<Record<string, FundingCajaSourceKind>> = {
  aplicacion_saldo_favor: "credit_movement",
  saldo_deudor: "debt_movement",
};

/**
 * Partición legacy/titular + resolución completa del impacto en Caja de los
 * movimientos/ajustes de financiación con titular — ver cabecera del
 * archivo. Sin escrituras. `dbClient` puede ser `database` o `tx`, igual que
 * el resto de esta etapa.
 */
export async function loadAccountHolderFundingCajaImpact(
  dbClient: AccountHolderFundingDbClient,
  params: LoadAccountHolderFundingCajaImpactParams
): Promise<LoadAccountHolderFundingCajaImpactResult> {
  assertArray("params.movements", params.movements);
  assertArray("params.adjustments", params.adjustments);

  const movements = params.movements;
  const adjustments = params.adjustments;

  // ─── 1. Batches dueños — status + accountHolderInsuredId, UNA sola query ──
  const ownerBatchIds = new Set<number>();
  for (const m of movements) if (m.originBatchId != null) ownerBatchIds.add(m.originBatchId);
  for (const a of adjustments) if (a.paymentBatchId != null) ownerBatchIds.add(a.paymentBatchId);

  const batchInfoById = new Map<number, { status: string; accountHolderInsuredId: number | null }>();
  if (ownerBatchIds.size > 0) {
    const rows = await dbClient
      .select({ id: paymentBatches.id, status: paymentBatches.status, accountHolderInsuredId: paymentBatches.accountHolderInsuredId })
      .from(paymentBatches)
      .where(inArray(paymentBatches.id, [...ownerBatchIds]))
      .all();
    for (const r of rows as any[]) {
      batchInfoById.set(r.id as number, { status: r.status as string, accountHolderInsuredId: r.accountHolderInsuredId as number | null });
    }
  }

  const isTitularBatch = (batchId: number | null): boolean => {
    if (batchId == null) return false;
    const info = batchInfoById.get(batchId);
    return info != null && info.accountHolderInsuredId != null;
  };

  // ─── 2. Partición ──────────────────────────────────────────────────────
  const legacyMovements: AccountHolderCajaMovementRow[] = [];
  const titularMovements: AccountHolderCajaMovementRow[] = [];
  for (const m of movements) {
    (isTitularBatch(m.originBatchId) ? titularMovements : legacyMovements).push(m);
  }

  const legacyAdjustments: AccountHolderCajaAdjustmentRow[] = [];
  const titularAdjustments: AccountHolderCajaAdjustmentRow[] = [];
  for (const a of adjustments) {
    (isTitularBatch(a.paymentBatchId) ? titularAdjustments : legacyAdjustments).push(a);
  }

  // ─── 3. saldo_a_favor NUEVO titular — nunca es fuente de ninguna allocation ──
  let titularNewCreditCents = 0;
  for (const m of titularMovements) {
    if (m.type !== "saldo_a_favor") continue;
    const batchConfirmed = batchInfoById.get(m.originBatchId!)?.status === "confirmado";
    if (m.status === "activo" && batchConfirmed) titularNewCreditCents += m.signedAmountCents;
  }

  // ─── 4. Movimientos/ajustes titulares que SÍ son fuente de allocations ────
  const sourceMovementsById = new Map<number, AccountHolderCajaMovementRow>();
  for (const m of titularMovements) {
    if (TITULAR_MOVEMENT_SOURCE_KIND[m.type] != null) sourceMovementsById.set(m.id, m);
  }
  const sourceAdjustmentsById = new Map<number, AccountHolderCajaAdjustmentRow>(titularAdjustments.map((a) => [a.id, a]));

  const sourceMovementIds = [...sourceMovementsById.keys()];
  const sourceAdjustmentIds = [...sourceAdjustmentsById.keys()];

  let titularAllocationRows: any[] = [];
  if (sourceMovementIds.length > 0 || sourceAdjustmentIds.length > 0) {
    const conditions = [] as any[];
    if (sourceMovementIds.length > 0) conditions.push(inArray(paymentBatchFundingAllocations.sourceAccountMovementId, sourceMovementIds));
    if (sourceAdjustmentIds.length > 0) conditions.push(inArray(paymentBatchFundingAllocations.paymentAmountAdjustmentId, sourceAdjustmentIds));
    titularAllocationRows = await dbClient
      .select()
      .from(paymentBatchFundingAllocations)
      .where(conditions.length === 1 ? conditions[0] : or(...conditions))
      .all();
  }

  // ─── 5. destinationRendered — leído en vivo, payments.rendered/cashEntries.rendered ──
  const destPaymentIds = new Set<number>();
  const destCashEntryIds = new Set<number>();
  for (const row of titularAllocationRows as any[]) {
    if (row.paymentId != null) destPaymentIds.add(row.paymentId as number);
    else if (row.cashEntryId != null) destCashEntryIds.add(row.cashEntryId as number);
  }

  const paymentRenderedById = new Map<number, boolean>();
  if (destPaymentIds.size > 0) {
    const rows = await dbClient.select({ id: payments.id, rendered: payments.rendered }).from(payments).where(inArray(payments.id, [...destPaymentIds])).all();
    for (const r of rows as any[]) paymentRenderedById.set(r.id as number, r.rendered === 1);
  }
  const cashEntryRenderedById = new Map<number, boolean>();
  if (destCashEntryIds.size > 0) {
    const rows = await dbClient.select({ id: cashEntries.id, rendered: cashEntries.rendered }).from(cashEntries).where(inArray(cashEntries.id, [...destCashEntryIds])).all();
    for (const r of rows as any[]) cashEntryRenderedById.set(r.id as number, r.rendered === 1);
  }

  // ─── 6. Armado del input de calculateAllocationRenderedCajaImpact ─────────
  const allocationInputs: FundingAllocationRenderStatus[] = [];
  for (const row of titularAllocationRows as any[]) {
    let sourceKind: FundingCajaSourceKind;
    let sourceId: number;
    let parentActive: boolean;

    if (row.sourceAccountMovementId != null) {
      const movement = sourceMovementsById.get(row.sourceAccountMovementId as number);
      if (!movement) {
        throw new AccountHolderFundingCajaLoaderError(
          `La allocation ${row.id} referencia el movimiento ${row.sourceAccountMovementId} como fuente, que no está en sourceMovementsById — bug de cableado.`
        );
      }
      const kind = TITULAR_MOVEMENT_SOURCE_KIND[movement.type];
      if (!kind) {
        throw new AccountHolderFundingCajaLoaderError(`El movimiento ${movement.id} (type="${movement.type}") no es una fuente titular válida.`);
      }
      sourceKind = kind;
      sourceId = movement.id;
      const batchConfirmed = batchInfoById.get(movement.originBatchId!)?.status === "confirmado";
      parentActive = movement.status === "activo" && batchConfirmed === true;
    } else if (row.paymentAmountAdjustmentId != null) {
      const adjustment = sourceAdjustmentsById.get(row.paymentAmountAdjustmentId as number);
      if (!adjustment) {
        throw new AccountHolderFundingCajaLoaderError(
          `La allocation ${row.id} referencia el ajuste ${row.paymentAmountAdjustmentId} como fuente, que no está en sourceAdjustmentsById — bug de cableado.`
        );
      }
      sourceKind = "rounding_adjustment";
      sourceId = adjustment.id;
      const batchConfirmed = batchInfoById.get(adjustment.paymentBatchId!)?.status === "confirmado";
      parentActive = batchConfirmed === true; // sin columna status propia — solo depende del batch.
    } else {
      // paymentBatchSplitId (fuente "split", dinero real) — ajeno a este
      // módulo (splits nunca pasan por credit_movement/debt_movement/
      // rounding_adjustment, ver account-holder-funding-caja.ts); una
      // allocation así nunca debería aparecer en esta query (filtrada por
      // sourceAccountMovementId/paymentAmountAdjustmentId), pero se ignora
      // explícitamente en vez de fallar en silencio si algún día apareciera.
      continue;
    }

    let destinationRendered: boolean;
    if (row.paymentId != null) {
      destinationRendered = paymentRenderedById.get(row.paymentId as number) ?? false;
    } else if (row.cashEntryId != null) {
      destinationRendered = cashEntryRenderedById.get(row.cashEntryId as number) ?? false;
    } else {
      throw new AccountHolderFundingCajaLoaderError(
        `La allocation ${row.id} (fuente ${sourceKind}=${sourceId}) no tiene paymentId ni cashEntryId como destino — inesperado (new_credit_movement nunca es destino de estas 3 fuentes).`
      );
    }

    allocationInputs.push({ sourceKind, sourceId, amountCents: row.amountCents as number, destinationRendered, parentActive });
  }

  const impact = calculateAllocationRenderedCajaImpact(allocationInputs);

  return {
    legacyMovements,
    legacyAdjustments,
    titular: {
      creditoActivoEnCajaCents: titularNewCreditCents - impact.creditConsumedRenderedCents,
      debtRenderedExpenseCents: impact.debtRenderedExpenseCents,
      roundingRenderedExpenseCents: impact.roundingRenderedExpenseCents,
    },
  };
}

// ─── Totales combinados, listos para GET /cash/summary ────────────────────
//
// Envuelve loadAccountHolderFundingCajaImpact (partición + impacto titular)
// y agrega el paso que antes vivía inline en index.ts: resolver
// relatedPaymentRendered de los movimientos LEGACY (aplicacion_saldo_favor
// con relatedPaymentId) y el status del batch dueño de cada ajuste de
// redondeo LEGACY, para correr los 4 cálculos puros existentes de
// insured-account.ts (calculateCreditActiveInCaja/
// calculateCreditRegularizedInCaja/calculateCobroSaldoDeudorInCaja/
// calculatePaymentAmountAdjustmentCreditInCaja) exactamente como ya lo hacía
// el endpoint, y sumarles el aporte titular ya resuelto. Es la ÚNICA función
// que index.ts necesita llamar para estas 6 cifras — index.ts ya no calcula
// nada de esto por su cuenta, solo arma la query de entrada y consume la
// salida.

export interface LoadAccountMovementCajaTotalsResult {
  /** legacy (calculateCreditActiveInCaja) + titular (saldo_a_favor nuevo activo − crédito consumido ya rendido). */
  creditoActivoEnCajaCents: number;
  /** Solo legacy — ajuste_manual nunca lo origina un batch titular. */
  creditoRegularizadoCents: number;
  /** Solo legacy — cobro_saldo_deudor nunca lo origina un batch titular. */
  cobrosSaldoDeudorCents: number;
  /** Solo legacy (payment_amount_adjustments con signo positivo, sobrante real) — nunca incluye redondeo titular (signo/criterio opuesto). */
  roundingAdjustmentCreditCents: number;
  /** Saldo deudor titular cuyo destino ya se rindió — restar de cajaNeta (nunca sumarlo a creditoActivoEnCajaCents, polaridad distinta). */
  titularDebtExpenseCents: number;
  /** Redondeo titular cuyo destino ya se rindió — restar de cajaNeta. */
  titularRoundingExpenseCents: number;
}

export async function loadAccountMovementCajaTotals(
  dbClient: AccountHolderFundingDbClient,
  params: LoadAccountHolderFundingCajaImpactParams
): Promise<LoadAccountMovementCajaTotalsResult> {
  const partitioned = await loadAccountHolderFundingCajaImpact(dbClient, params);

  // ─── Legacy: relatedPaymentRendered de aplicacion_saldo_favor ───────────
  const relatedPaymentIds = [...new Set(
    partitioned.legacyMovements
      .filter((m) => m.type === "aplicacion_saldo_favor" && m.relatedPaymentId != null)
      .map((m) => m.relatedPaymentId as number)
  )];
  const relatedPaymentRenderedById = new Map<number, boolean>();
  if (relatedPaymentIds.length > 0) {
    const rows = await dbClient.select({ id: payments.id, rendered: payments.rendered }).from(payments).where(inArray(payments.id, relatedPaymentIds)).all();
    for (const r of rows as any[]) relatedPaymentRenderedById.set(r.id as number, r.rendered === 1);
  }
  const legacyMovementsForCaja: InsuredAccountMovementForCaja[] = partitioned.legacyMovements.map((m) => ({
    type: m.type as InsuredAccountMovementForCaja["type"],
    signedAmountCents: m.signedAmountCents,
    status: m.status,
    relatedPaymentRendered: m.relatedPaymentId != null ? (relatedPaymentRenderedById.get(m.relatedPaymentId) ?? false) : null,
  }));

  // ─── Legacy: status del batch dueño de cada ajuste de redondeo ─────────
  const legacyAdjustmentBatchIds = [...new Set(partitioned.legacyAdjustments.filter((a) => a.paymentBatchId != null).map((a) => a.paymentBatchId as number))];
  const legacyAdjustmentBatchStatusById = new Map<number, string>();
  if (legacyAdjustmentBatchIds.length > 0) {
    const rows = await dbClient.select({ id: paymentBatches.id, status: paymentBatches.status }).from(paymentBatches).where(inArray(paymentBatches.id, legacyAdjustmentBatchIds)).all();
    for (const r of rows as any[]) legacyAdjustmentBatchStatusById.set(r.id as number, r.status as string);
  }
  const legacyAdjustmentsForCaja: PaymentAmountAdjustmentForCaja[] = partitioned.legacyAdjustments.map((a) => ({
    amountCents: a.amountCents,
    parentActive: a.paymentBatchId != null && legacyAdjustmentBatchStatusById.get(a.paymentBatchId) === "confirmado",
  }));

  return {
    creditoActivoEnCajaCents: calculateCreditActiveInCaja(legacyMovementsForCaja) + partitioned.titular.creditoActivoEnCajaCents,
    creditoRegularizadoCents: calculateCreditRegularizedInCaja(legacyMovementsForCaja),
    cobrosSaldoDeudorCents: calculateCobroSaldoDeudorInCaja(legacyMovementsForCaja),
    roundingAdjustmentCreditCents: calculatePaymentAmountAdjustmentCreditInCaja(legacyAdjustmentsForCaja),
    titularDebtExpenseCents: partitioned.titular.debtRenderedExpenseCents,
    titularRoundingExpenseCents: partitioned.titular.roundingRenderedExpenseCents,
  };
}
