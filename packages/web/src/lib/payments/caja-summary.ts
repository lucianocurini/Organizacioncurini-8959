// Helpers puros de Caja (adaptación a remittance_allocations) — GET
// /api/cash/summary. Sin DB, sin efectos secundarios: reciben filas ya
// leídas por el endpoint y devuelven resultados explícitos, mismo estilo que
// batches.ts/received-checks.ts/remittance-allocations.ts.
//
// Reutiliza OWN_METHODS/DIRECT_COMPANY_METHODS de splits.ts y
// classifyRemittanceAllocationState de remittance-allocations.ts — una sola
// fuente de verdad para "qué método es propio/directo compañía" y para "cómo
// se clasifica una rendición" (no se duplica esa lógica acá).
//
// IMPORTANTE — cómo se infiere si una rendición fue creada bajo el modelo de
// allocations sin una columna nueva (no se crea migración para esto): si una
// rendición confirmada tiene CERO allocations pero sus remittance_items
// incluyen algún source 'payment' o 'cash_entry' (dinero real, no solo
// installment/manual_debt), solo puede ser una rendición histórica anterior
// a la migración 0024 — porque POST /remittances (código actual) nunca deja
// confirmar una rendición con dinero real sin generar sus allocations
// coincidentes. Ver classifyRemittanceForRendido.

import { OWN_METHODS, DIRECT_COMPANY_METHODS } from "./splits";
import { classifyRemittanceAllocationState } from "./remittance-allocations";

// ─── Métodos contables ──────────────────────────────────────────────────────

// Medios reales que representan un instrumento de pago concreto.
export const CONTABLE_METHODS = ["efectivo", "transferencia", "cheque", "link_pago", "transferencia_compania"] as const;
export type ContableMethod = (typeof CONTABLE_METHODS)[number];
const CONTABLE_METHODS_SET: ReadonlySet<string> = new Set(CONTABLE_METHODS);
export function isContableMethod(method: string): method is ContableMethod {
  return CONTABLE_METHODS_SET.has(method);
}

// Etiquetas de resumen que aparecen en campos legacy (payments.paymentMethod,
// payment_batch_splits creados para recargos de batch, remittances.
// paymentBreakdown) pero NUNCA son un instrumento real — nunca deben tratarse
// como un método contable.
export const NON_INSTRUMENT_LABELS: ReadonlySet<string> = new Set(["combinado", "lote", "pronto_pago"]);

// ─── Buckets de dinero (centavos) ──────────────────────────────────────────

export interface MoneyBucketCents {
  efectivoCents: number;
  transferenciaCents: number;
  chequeCents: number;
  recargosProntoPagoCents: number;
  totalCents: number;
}

export interface DirectCompanyBucketCents {
  transferenciaCompaniaCents: number;
  linkPagoCents: number;
  totalCents: number;
}

export function emptyMoneyBucket(): MoneyBucketCents {
  return { efectivoCents: 0, transferenciaCents: 0, chequeCents: 0, recargosProntoPagoCents: 0, totalCents: 0 };
}
export function emptyDirectCompanyBucket(): DirectCompanyBucketCents {
  return { transferenciaCompaniaCents: 0, linkPagoCents: 0, totalCents: 0 };
}

function addOwnMethodCents(bucket: MoneyBucketCents, method: string, cents: number): void {
  if (method === "efectivo") bucket.efectivoCents += cents;
  else if (method === "transferencia") bucket.transferenciaCents += cents;
  else if (method === "cheque") bucket.chequeCents += cents;
  else return; // método fuera de OWN_METHODS: no se suma a ningún lado (defensivo, no debería pasar)
  bucket.totalCents += cents;
}

function addDirectCompanyCents(bucket: DirectCompanyBucketCents, method: string, cents: number): void {
  if (method === "transferencia_compania") bucket.transferenciaCompaniaCents += cents;
  else if (method === "link_pago") bucket.linkPagoCents += cents;
  else return;
  bucket.totalCents += cents;
}

// ─── Cartera pendiente (Sección 2) ─────────────────────────────────────────

export interface CarteraInconsistency {
  sourceType: "standalone_payment" | "batch" | "batch_split_check";
  sourceId: number;
  reason: string;
}

// A. Pago standalone confirmado y rendered=0 — usa sus payment_splits reales,
// nunca payments.paymentMethod. Si la suma de splits no coincide con el
// importe del pago, se reporta como inconsistencia y NO se suma (no se
// inventa el desglose).
export interface StandalonePaymentForCartera {
  paymentId: number;
  amountCents: number;
  splits: ReadonlyArray<{ method: string; amountCents: number }>;
}

export function applyStandalonePaymentToCartera(
  payment: StandalonePaymentForCartera,
  cartera: MoneyBucketCents,
  directoCompania: DirectCompanyBucketCents,
  inconsistencias: CarteraInconsistency[]
): void {
  const splitSum = payment.splits.reduce((s, x) => s + x.amountCents, 0);
  if (splitSum !== payment.amountCents) {
    inconsistencias.push({
      sourceType: "standalone_payment",
      sourceId: payment.paymentId,
      reason:
        `La suma de los medios del pago ${payment.paymentId} ($${(splitSum / 100).toFixed(2)}) no coincide con su importe ` +
        `($${(payment.amountCents / 100).toFixed(2)}).`,
    });
    return;
  }
  for (const s of payment.splits) {
    if (OWN_METHODS.has(s.method)) addOwnMethodCents(cartera, s.method, s.amountCents);
    else if (DIRECT_COMPANY_METHODS.has(s.method)) addDirectCompanyCents(directoCompania, s.method, s.amountCents);
  }
}

// B/C. Cobro múltiple (payment_batches) — agrupado por batchId, contado una
// sola vez. Un split cheque usa received_checks para trazabilidad (la suma
// de checks debe coincidir exactamente con el split; se suma UNA vez al
// bucket cheque, nunca además el split padre).
export interface BatchCheckForCartera {
  id: number;
  amountCents: number;
}
export interface BatchSplitForCartera {
  method: string;
  amountCents: number;
  checks: ReadonlyArray<BatchCheckForCartera>;
}
export interface BatchChildForCartera {
  paymentId: number;
  status: string; // confirmado | pendiente | anulado
  rendered: number; // 0 | 1
  // Etapa "rendición por cuota" (Migración 0029): payments.amount de ESTE
  // hijo, en centavos — base del prorrateo cuando el batch queda con
  // hijos rendered mixto (algunos ya rendidos, otros no). Antes de esta
  // etapa un batch mixto era imposible (assertCompletePaymentBatches lo
  // impedía) y este campo no hacía falta.
  amountCents: number;
}
export interface BatchForCartera {
  batchId: number;
  status: string; // payment_batches.status: confirmado | anulado
  splits: ReadonlyArray<BatchSplitForCartera>;
  children: ReadonlyArray<BatchChildForCartera>;
}

/**
 * Reparte totalCents en centavos ENTEROS entre weights, sin drift (método
 * del resto mayor / Hamilton — floor de cada porción proporcional, y el
 * remanente entero se asigna a quienes tienen el resto fraccionario más
 * grande). Garantiza sum(resultado) === totalCents exacto. Usado solo para
 * ESTIMAR/MOSTRAR cuánta plata de un batch parcialmente rendido sigue en la
 * oficina, por método — nunca para decidir qué instrumento físico (cheque/
 * transferencia) se le entrega a qué compañía, eso lo define cada rendición
 * real con su propio instrumento de salida (ver Migración 0029).
 */
function apportionCents(totalCents: number, weights: ReadonlyArray<number>): number[] {
  const sumWeights = weights.reduce((s, w) => s + w, 0);
  if (sumWeights <= 0 || totalCents <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / sumWeights);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = totalCents - floors.reduce((s, f) => s + f, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i]! }))
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++) {
    result[order[k]!.i]! += 1;
    remainder--;
  }
  return result;
}

export function applyBatchToCartera(
  batch: BatchForCartera,
  cartera: MoneyBucketCents,
  directoCompania: DirectCompanyBucketCents,
  inconsistencias: CarteraInconsistency[]
): void {
  if (batch.status !== "confirmado") return; // batches anulados no aportan cartera pendiente

  const confirmedChildren = batch.children.filter((c) => c.status === "confirmado");
  if (confirmedChildren.length === 0) return; // sin hijos confirmados, nada que contar

  // Etapa "rendición por cuota": cobrar por lote no obliga a rendir el lote
  // completo — un batch puede quedar con algunos hijos ya rendidos y otros
  // no, sin que eso sea una inconsistencia. Los hijos ya rendidos salen de
  // cartera pendiente; los que faltan rendir, siguen.
  const pendingChildren = confirmedChildren.filter((c) => c.rendered === 0);
  if (pendingChildren.length === 0) return; // todos los hijos confirmados ya fueron rendidos

  const totalChildrenAmountCents = confirmedChildren.reduce((s, c) => s + c.amountCents, 0);
  const pendingChildrenAmountCents = pendingChildren.reduce((s, c) => s + c.amountCents, 0);
  const allPending = totalChildrenAmountCents > 0 && pendingChildrenAmountCents === totalChildrenAmountCents;

  // splitCentsToApply[i] = cuánto de CADA split del batch corresponde a la
  // porción todavía pendiente de rendir. Caso común (nadie se rindió
  // todavía): el split completo, mismo comportamiento exacto que antes de
  // esta etapa. Caso mixto: se prorratea en proporción a cuánto de la base
  // del batch (suma de payments.amount de sus hijos) sigue sin rendir —
  // una sola operación de redondeo por batch (el total prorrateado), y
  // apportionCents reparte ese total exacto entre los splits sin drift.
  let splitCentsToApply: number[];
  if (allPending) {
    splitCentsToApply = batch.splits.map((s) => s.amountCents);
  } else {
    const totalReceivedCents = batch.splits.reduce((s, sp) => s + sp.amountCents, 0);
    const pendingTargetCents = totalChildrenAmountCents > 0
      ? Math.round((totalReceivedCents * pendingChildrenAmountCents) / totalChildrenAmountCents)
      : 0;
    splitCentsToApply = apportionCents(pendingTargetCents, batch.splits.map((s) => s.amountCents));
  }

  batch.splits.forEach((split, i) => {
    const cents = splitCentsToApply[i]!;
    if (cents <= 0) return;
    if (split.method === "cheque") {
      const checksSum = split.checks.reduce((s, c) => s + c.amountCents, 0);
      if (checksSum !== split.amountCents) {
        inconsistencias.push({
          sourceType: "batch_split_check",
          sourceId: batch.batchId,
          reason:
            `La suma de los cheques del cobro ${batch.batchId} ($${(checksSum / 100).toFixed(2)}) no coincide con el split ` +
            `cheque ($${(split.amountCents / 100).toFixed(2)}).`,
        });
        return; // no sumar este split parcialmente
      }
      addOwnMethodCents(cartera, "cheque", cents); // una sola vez, nunca además el split padre
    } else if (OWN_METHODS.has(split.method)) {
      addOwnMethodCents(cartera, split.method, cents);
    } else if (DIRECT_COMPANY_METHODS.has(split.method)) {
      addDirectCompanyCents(directoCompania, split.method, cents);
    }
  });
}

// D. Pronto Pago standalone — cash_entry pronto_pago_surcharge rendered=0
// cuyo payment asociado NO es hijo de batch. Categoría separada, nunca
// atribuida a un método real.
export function applyStandaloneSurchargeToCartera(amountCents: number, cartera: MoneyBucketCents): void {
  cartera.recargosProntoPagoCents += amountCents;
  cartera.totalCents += amountCents;
}

// G. Ingresos manuales normales de cash_entries — método real del propio
// registro (nunca "combinado"/"lote"/"pronto_pago", ya que entryType='normal'
// no usa esas etiquetas).
export function applyManualCashEntryToCartera(
  method: string,
  amountCents: number,
  cartera: MoneyBucketCents,
  directoCompania: DirectCompanyBucketCents
): void {
  if (DIRECT_COMPANY_METHODS.has(method)) addDirectCompanyCents(directoCompania, method, amountCents);
  else if (OWN_METHODS.has(method)) addOwnMethodCents(cartera, method, amountCents);
}

// ─── Agrupar instrumentos para expectedCollectedCents (Sección 3) ─────────

// Junta, a partir de las allocations YA existentes de una rendición, los ids
// distintos de pago standalone / batch / cash_entry que hacen falta consultar
// para reconstruir expectedCollectedCents con calculateExpectedCollectedCents
// de remittance-allocations.ts (misma fuente autoritativa que usa POST
// /remittances: payments.amount, payment_batches.totalReceivedCents,
// cash_entries.amount — nunca resumando las mismas allocations). Un batch con
// varios splits/cheques solo debe agruparse UNA vez acá.
export interface AllocationRefForExpected {
  paymentId: number | null;
  paymentBatchId: number | null;
  cashEntryId: number | null;
}
export interface DistinctExpectedSources {
  standalonePaymentIds: number[];
  batchIds: number[];
  cashEntryIds: number[];
}
export function collectDistinctExpectedSources(
  allocations: ReadonlyArray<AllocationRefForExpected>
): DistinctExpectedSources {
  const paymentIds = new Set<number>();
  const batchIds = new Set<number>();
  const cashEntryIds = new Set<number>();
  for (const a of allocations) {
    if (a.paymentBatchId != null) batchIds.add(a.paymentBatchId);
    else if (a.paymentId != null) paymentIds.add(a.paymentId);
    if (a.cashEntryId != null) cashEntryIds.add(a.cashEntryId);
  }
  return {
    standalonePaymentIds: [...paymentIds],
    batchIds: [...batchIds],
    cashEntryIds: [...cashEntryIds],
  };
}

// ─── Rendido por método (Sección 3) ────────────────────────────────────────

export interface RemittanceInconsistency {
  remittanceId: number;
  date: string;
  allocationSumCents: number;
  expectedCollectedCents: number;
  reason: string;
}

export interface AllocationForRendido {
  method: string;
  amountCents: number;
  // true si esta allocation viene de un cash_entry con
  // entry_type='pronto_pago_surcharge' (recargo, nunca un método real).
  isProntoPagoSurcharge: boolean;
}

export interface RemittanceForRendido {
  remittanceId: number;
  date: string;
  allocations: ReadonlyArray<AllocationForRendido>;
  // Suma autoritativa esperada (solo hace falta cuando allocations.length>0
  // — ver calculateExpectedCollectedCents de remittance-allocations.ts).
  expectedCollectedCents: number;
  // true si remittance_items de esta rendición incluye algún source
  // 'payment'/'cash_entry' (dinero real) — distingue legacy de "nueva
  // rendición solo con deuda/no cobrada" cuando allocations.length===0.
  hasRealMoneyItems: boolean;
  // remittances.payment_breakdown crudo (JSON string) — solo se usa cuando
  // allocations.length===0 && hasRealMoneyItems (caso legacy).
  legacyPaymentBreakdownRaw: string;
}

export type RemittanceContributionState = "zero" | "legacy" | "complete" | "inconsistent";

export interface RemittanceContributionBreakdown {
  ownByMethodCents: Partial<Record<"efectivo" | "transferencia" | "cheque", number>>;
  recargosProntoPagoCents: number;
  directCompaniaByMethodCents: Partial<Record<"transferencia_compania" | "link_pago", number>>;
  // Claves legacy desconocidas de paymentBreakdown, en PESOS (mismo formato
  // que el JSON original) — nunca convertidas a un método real.
  legacyUnknown: Record<string, number>;
}

export interface RemittanceContribution {
  state: RemittanceContributionState;
  // Suma en cartera propia y directo compañía que esta rendición aporta al
  // total (0 para "zero"/"inconsistent") — útil para totales de período sin
  // tener que reprocesar el breakdown.
  contributionOwnCents: number;
  contributionDirectCompaniaCents: number;
  breakdown: RemittanceContributionBreakdown;
  inconsistency?: RemittanceInconsistency;
}

function emptyBreakdown(): RemittanceContributionBreakdown {
  return { ownByMethodCents: {}, recargosProntoPagoCents: 0, directCompaniaByMethodCents: {}, legacyUnknown: {} };
}

function parseLegacyPaymentBreakdown(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // JSON inválido -> se trata como vacío, no revienta el resumen de Caja.
  }
  return {};
}

/**
 * Clasifica una rendición confirmada para Caja usando exclusivamente
 * remittance_allocations cuando existen (caso "complete"/"inconsistent",
 * vía classifyRemittanceAllocationState — no se duplica ese criterio acá), o
 * paymentBreakdown legacy cuando no hay ninguna allocation pero sí hubo
 * dinero real (caso "legacy"). Una rendición nueva sin ninguna allocation y
 * sin ítems de dinero real (solo deuda/no cobrada) es "zero" — válida, no
 * contamina los totales.
 */
export function classifyRemittanceForRendido(r: RemittanceForRendido): RemittanceContribution {
  const allocationCount = r.allocations.length;
  const allocationSumCents = r.allocations.reduce((s, a) => s + a.amountCents, 0);

  if (allocationCount === 0 && !r.hasRealMoneyItems) {
    return { state: "zero", contributionOwnCents: 0, contributionDirectCompaniaCents: 0, breakdown: emptyBreakdown() };
  }

  if (allocationCount === 0 && r.hasRealMoneyItems) {
    const raw = parseLegacyPaymentBreakdown(r.legacyPaymentBreakdownRaw);
    const breakdown = emptyBreakdown();
    let ownCents = 0;
    let directCents = 0;
    for (const [key, rawValue] of Object.entries(raw)) {
      const value = Number(rawValue) || 0;
      if (value === 0) continue;
      const cents = Math.round(value * 100);
      if (key === "pronto_pago") {
        breakdown.recargosProntoPagoCents += cents;
        ownCents += cents;
      } else if (key === "efectivo" || key === "transferencia" || key === "cheque") {
        breakdown.ownByMethodCents[key] = (breakdown.ownByMethodCents[key] ?? 0) + cents;
        ownCents += cents;
      } else if (key === "transferencia_compania" || key === "link_pago") {
        breakdown.directCompaniaByMethodCents[key] = (breakdown.directCompaniaByMethodCents[key] ?? 0) + cents;
        directCents += cents;
      } else {
        breakdown.legacyUnknown[key] = (breakdown.legacyUnknown[key] ?? 0) + value;
        ownCents += cents; // incluido en el total histórico, sin atribuir a un método real
      }
    }
    return { state: "legacy", contributionOwnCents: ownCents, contributionDirectCompaniaCents: directCents, breakdown };
  }

  // allocationCount > 0
  const state = classifyRemittanceAllocationState({
    allocationCount,
    allocationSumCents,
    expectedCollectedCents: r.expectedCollectedCents,
    createdUnderAllocationsModel: true,
  });

  if (state === "inconsistent") {
    return {
      state: "inconsistent",
      contributionOwnCents: 0,
      contributionDirectCompaniaCents: 0,
      breakdown: emptyBreakdown(),
      inconsistency: {
        remittanceId: r.remittanceId,
        date: r.date,
        allocationSumCents,
        expectedCollectedCents: r.expectedCollectedCents,
        reason:
          `La suma de las allocations de la rendición ${r.remittanceId} ($${(allocationSumCents / 100).toFixed(2)}) no coincide ` +
          `con el total esperado de dinero realmente cobrado ($${(r.expectedCollectedCents / 100).toFixed(2)}).`,
      },
    };
  }

  const breakdown = emptyBreakdown();
  let ownCents = 0;
  let directCents = 0;
  for (const a of r.allocations) {
    if (a.isProntoPagoSurcharge) {
      breakdown.recargosProntoPagoCents += a.amountCents;
      ownCents += a.amountCents;
      continue;
    }
    if (a.method === "efectivo" || a.method === "transferencia" || a.method === "cheque") {
      breakdown.ownByMethodCents[a.method] = (breakdown.ownByMethodCents[a.method] ?? 0) + a.amountCents;
      ownCents += a.amountCents;
    } else if (a.method === "transferencia_compania" || a.method === "link_pago") {
      breakdown.directCompaniaByMethodCents[a.method] = (breakdown.directCompaniaByMethodCents[a.method] ?? 0) + a.amountCents;
      directCents += a.amountCents;
    }
  }
  return { state: "complete", contributionOwnCents: ownCents, contributionDirectCompaniaCents: directCents, breakdown };
}

// ─── Acumulador de rendido por método ──────────────────────────────────────

export interface RendidoAccumulator {
  cartera: MoneyBucketCents; // rendido en cuentas propias, por método
  otrosLegacyCents: number; // total histórico de claves legacy desconocidas
  directoCompania: DirectCompanyBucketCents;
  remittancesLegacyCount: number;
  remittancesCompleteCount: number;
  remittancesZeroCollectedCount: number;
  inconsistencias: RemittanceInconsistency[];
  legacyUnknownMethods: Record<string, number>; // en pesos, para auditoría
}

export function emptyRendidoAccumulator(): RendidoAccumulator {
  return {
    cartera: emptyMoneyBucket(),
    otrosLegacyCents: 0,
    directoCompania: emptyDirectCompanyBucket(),
    remittancesLegacyCount: 0,
    remittancesCompleteCount: 0,
    remittancesZeroCollectedCount: 0,
    inconsistencias: [],
    legacyUnknownMethods: {},
  };
}

export function accumulateRemittanceContribution(contribution: RemittanceContribution, acc: RendidoAccumulator): void {
  if (contribution.state === "zero") {
    acc.remittancesZeroCollectedCount++;
    return;
  }
  if (contribution.state === "inconsistent") {
    acc.inconsistencias.push(contribution.inconsistency!);
    return;
  }
  if (contribution.state === "legacy") acc.remittancesLegacyCount++;
  else acc.remittancesCompleteCount++;

  const bd = contribution.breakdown;
  for (const [method, cents] of Object.entries(bd.ownByMethodCents)) {
    if (cents) addOwnMethodCents(acc.cartera, method, cents);
  }
  if (bd.recargosProntoPagoCents) {
    acc.cartera.recargosProntoPagoCents += bd.recargosProntoPagoCents;
    acc.cartera.totalCents += bd.recargosProntoPagoCents;
  }
  for (const [method, cents] of Object.entries(bd.directCompaniaByMethodCents)) {
    if (cents) addDirectCompanyCents(acc.directoCompania, method, cents);
  }
  for (const [key, valuePesos] of Object.entries(bd.legacyUnknown)) {
    acc.legacyUnknownMethods[key] = (acc.legacyUnknownMethods[key] ?? 0) + valuePesos;
    acc.otrosLegacyCents += Math.round(valuePesos * 100);
  }
}

// ─── Conversión a pesos (frontera pública de la API) ───────────────────────

export function centsToPesos(cents: number): number {
  return cents / 100;
}

// ─── Detalle de adeudados (Caja) ────────────────────────────────────────────
//
// Fuente única: las MISMAS filas que ya calculan totalAdeudadoRendiciones/
// totalAdeudadoLegacy en el handler de /cash/summary (remittance_items con
// debtorStatus='adeudado' AND paidAt IS NULL; cash_debts con status=
// 'pendiente') — acá solo se normalizan a filas de detalle, sin volver a
// consultar la DB ni recalcular el total. Cero deduplicación automática
// entre ambas fuentes: no existe ninguna FK que relacione cash_debts con
// remittance_items/policies, así que no hay manera confiable de detectar un
// duplicado real (ver comentario en index.ts junto a debtsLegacy).

export type AdeudadoOrigin = "installment" | "manual_debt" | "cash_debt_legacy";

export interface AdeudadoDetalleItem {
  id: number;
  origen: AdeudadoOrigin;
  deudor: string;
  polizaODescripcion: string | null;
  compania: string | null;
  importe: number;
  fecha: string;
  estado: "pendiente";
}

export interface RemittanceDebtRowForDetalle {
  id: number;
  // remittance_items.source ya viene filtrado a solo debtorStatus='adeudado'
  // — acá solo distingue 'manual_debt' de cualquier otro valor real
  // (hoy siempre 'installment', el único otro source que puede quedar
  // adeudado — 'payment'/'cash_entry' nunca tienen debtorStatus='adeudado').
  source: string;
  policyNumber: string | null;
  debtorName: string | null;
  companyName: string | null;
  amount: number;
  remittanceDate: string;
}

export interface CashDebtLegacyRowForDetalle {
  id: number;
  clientName: string;
  policyNumber: string | null;
  companyName: string | null;
  amount: number;
  // Único dato de fecha disponible en cash_debts para este propósito — no
  // hay una "fecha de rendición" porque nunca pasó por una rendición.
  createdAt: Date | number | string | null;
}

function formatDebtLegacyDate(createdAt: Date | number | string | null): string {
  if (createdAt instanceof Date) return createdAt.toISOString().slice(0, 10);
  if (typeof createdAt === "number") return new Date(createdAt * 1000).toISOString().slice(0, 10);
  if (typeof createdAt === "string" && createdAt.length > 0) return createdAt.slice(0, 10);
  return "";
}

export function buildAdeudadosDetalle(
  remittanceDebtRows: ReadonlyArray<RemittanceDebtRowForDetalle>,
  cashDebtRows: ReadonlyArray<CashDebtLegacyRowForDetalle>
): AdeudadoDetalleItem[] {
  const fromRemittances: AdeudadoDetalleItem[] = remittanceDebtRows.map((r) => ({
    id: r.id,
    origen: r.source === "manual_debt" ? "manual_debt" : "installment",
    deudor: r.debtorName ?? "—",
    polizaODescripcion: r.policyNumber,
    compania: r.companyName,
    importe: r.amount,
    fecha: r.remittanceDate,
    estado: "pendiente",
  }));
  const fromLegacy: AdeudadoDetalleItem[] = cashDebtRows.map((d) => ({
    id: d.id,
    origen: "cash_debt_legacy",
    deudor: d.clientName,
    polizaODescripcion: d.policyNumber,
    compania: d.companyName,
    importe: d.amount,
    fecha: formatDebtLegacyDate(d.createdAt),
    estado: "pendiente",
  }));
  return [...fromRemittances, ...fromLegacy];
}

// Lanzada cuando SUM(adeudadosDetalle.importe) no coincide con totalAdeudado
// (comparación en centavos, para no arrastrar errores de punto flotante).
// Nunca se "ajusta" el número para que cierre — ver regla explícita del
// pedido que introdujo esto: si no coincide, es una señal real de que
// alguna fila se está contando en el total pero no en el detalle (o
// viceversa), y debe investigarse, no ocultarse.
export class AdeudadosSumMismatchError extends Error {
  constructor(
    public readonly detalleSumCents: number,
    public readonly totalAdeudadoCents: number
  ) {
    super(
      `adeudadosDetalle no coincide con totalAdeudado: detalle=${detalleSumCents} centavos, ` +
      `totalAdeudado=${totalAdeudadoCents} centavos, diferencia=${detalleSumCents - totalAdeudadoCents} centavos.`
    );
  }
}

export function assertAdeudadosDetalleMatchesTotal(
  detalle: ReadonlyArray<AdeudadoDetalleItem>,
  totalAdeudadoPesos: number
): void {
  const detalleSumCents = detalle.reduce((s, item) => s + Math.round(item.importe * 100), 0);
  const totalAdeudadoCents = Math.round(totalAdeudadoPesos * 100);
  if (detalleSumCents !== totalAdeudadoCents) {
    throw new AdeudadosSumMismatchError(detalleSumCents, totalAdeudadoCents);
  }
}
