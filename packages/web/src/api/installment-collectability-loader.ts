// Loader de la regla de cobrabilidad de cuotas (src/lib/payments/
// installment-collectability.ts) — ÚNICO punto que lee de la base para
// decidirla. Lo usan los selectores (GET /installments/pending-for-payment,
// GET /policies/cash-period-search) y todos los endpoints que crean un cobro
// nuevo de cuotas (POST /payments, PUT /payments/:id al cambiar de cuota,
// POST /payment-batches legacy y titular, POST /payment-batches/
// cash-period-payment) o que cambian la fecha de un cobro confirmado
// (PUT /payments/:id y PATCH /payment-batches/:id, modo existingCollection),
// tanto antes de la transacción como DENTRO de ella
// (assertInstallmentsCollectable con `tx`), para que un dato que cambió entre
// la carga de la pantalla y la confirmación nunca se cobre.
//
// Recibe siempre el cliente ya resuelto (`db` o `tx`), nunca importa la
// conexión global — mismo criterio que payment-batch-shared-inserts.ts.

import { and, eq, inArray } from "drizzle-orm";
import { policies, policyInstallments, payments } from "./database/schema";
import {
  COLLECTIONS_MIN_DUE_DATE,
  buildRenewalChainIndex,
  evaluateInstallmentCollectability,
  summarizeCollectability,
  type CollectabilityInstallment,
  type CollectabilityPolicy,
  type CollectabilityReason,
  type CollectabilityResult,
  type CollectabilitySummary,
  type RenewalChainIndex,
} from "../lib/payments/installment-collectability";

type DbClient = any;

const CHUNK = 400;
function chunks<T>(arr: ReadonlyArray<T>): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
}

const POLICY_COLUMNS = {
  id: policies.id,
  status: policies.status,
  startDate: policies.startDate,
  endDate: policies.endDate,
  renewedFromId: policies.renewedFromId,
  cancellationEffectiveDate: policies.cancellationEffectiveDate,
};

/**
 * Carga las cadenas de renovación COMPLETAS de las pólizas indicadas (cierre
 * transitivo en ambos sentidos de renewedFromId) y arma el índice. Un
 * renewedFromId a una póliza inexistente queda como enlace roto (anomalía),
 * nunca rompe la consulta.
 */
export async function loadRenewalChainIndex(dbClient: DbClient, seedPolicyIds: ReadonlyArray<number>): Promise<RenewalChainIndex> {
  const byId = new Map<number, CollectabilityPolicy>();
  const add = (rows: any[]): number[] => {
    const fresh: number[] = [];
    for (const r of rows) {
      if (byId.has(r.id)) continue;
      byId.set(r.id, {
        id: r.id, status: r.status, startDate: r.startDate ?? null, endDate: r.endDate ?? null,
        renewedFromId: r.renewedFromId ?? null, cancellationEffectiveDate: r.cancellationEffectiveDate ?? null,
      });
      fresh.push(r.id);
    }
    return fresh;
  };

  // Cierre transitivo: cada póliza se "expande" una sola vez (se piden su
  // predecesora y sus sucesoras). Un id pedido que no existe queda en
  // `missing` (enlace roto) y nunca se vuelve a pedir.
  const missing = new Set<number>();
  const expanded = new Set<number>();
  let toFetchById = [...new Set(seedPolicyIds)];
  for (;;) {
    const ids = toFetchById.filter((id) => !byId.has(id) && !missing.has(id));
    for (const part of chunks(ids)) {
      add(await dbClient.select(POLICY_COLUMNS).from(policies).where(inArray(policies.id, part)).all());
    }
    for (const id of ids) if (!byId.has(id)) missing.add(id);

    const toExpand = [...byId.keys()].filter((id) => !expanded.has(id));
    if (toExpand.length === 0) break;
    const nextById = new Set<number>();
    for (const id of toExpand) {
      expanded.add(id);
      const pred = byId.get(id)!.renewedFromId;
      if (pred != null && !byId.has(pred) && !missing.has(pred)) nextById.add(pred);
    }
    for (const part of chunks(toExpand)) {
      add(await dbClient.select(POLICY_COLUMNS).from(policies).where(inArray(policies.renewedFromId, part)).all());
    }
    toFetchById = [...nextById];
  }
  return buildRenewalChainIndex([...byId.values()]);
}

export interface CollectabilityLoadOptions {
  /** Pagos que NO cuentan como "pago confirmado" (ej. el propio payment recién insertado o el que se está editando). */
  excludePaymentIds?: ReadonlyArray<number>;
  /**
   * Revalidación de un cobro ya existente (cambio de fecha de un pago o lote
   * confirmado): admite la cuota "pagada" por ese mismo cobro. Usar SIEMPRE
   * junto con excludePaymentIds = los pagos de ese cobro.
   */
  existingCollection?: boolean;
}

async function loadInstallmentInputs(
  dbClient: DbClient,
  installmentIds: ReadonlyArray<number>,
  opts: CollectabilityLoadOptions
): Promise<Map<number, CollectabilityInstallment>> {
  const ids = [...new Set(installmentIds)];
  const rows: any[] = [];
  for (const part of chunks(ids)) {
    rows.push(...await dbClient.select({
      id: policyInstallments.id, policyId: policyInstallments.policyId, status: policyInstallments.status,
      dueDate: policyInstallments.dueDate, rendered: policyInstallments.rendered,
    }).from(policyInstallments).where(inArray(policyInstallments.id, part)).all());
  }
  const exclude = new Set(opts.excludePaymentIds ?? []);
  const confirmed = new Set<number>();
  for (const part of chunks(ids)) {
    const paid = await dbClient.select({ id: payments.id, installmentId: payments.installmentId }).from(payments)
      .where(and(inArray(payments.installmentId, part), eq(payments.status, "confirmado"))).all();
    for (const p of paid as any[]) if (!exclude.has(p.id)) confirmed.add(p.installmentId);
  }
  const out = new Map<number, CollectabilityInstallment>();
  for (const r of rows) {
    out.set(r.id, { id: r.id, policyId: r.policyId, status: r.status, dueDate: r.dueDate ?? null, rendered: r.rendered, hasConfirmedPayment: confirmed.has(r.id) });
  }
  return out;
}

/** Evalúa cada cuota con la regla única. Las cuotas inexistentes se devuelven aparte (missingInstallmentIds). */
export async function evaluateInstallmentsCollectability(
  dbClient: DbClient,
  installmentIds: ReadonlyArray<number>,
  paymentDate: string,
  opts: CollectabilityLoadOptions = {}
): Promise<{ results: Map<number, CollectabilityResult>; missingInstallmentIds: number[] }> {
  const inputs = await loadInstallmentInputs(dbClient, installmentIds, opts);
  const index = await loadRenewalChainIndex(dbClient, [...new Set([...inputs.values()].map((i) => i.policyId))]);
  const results = new Map<number, CollectabilityResult>();
  const evalOpts = { existingCollection: opts.existingCollection === true };
  for (const [id, inst] of inputs) results.set(id, evaluateInstallmentCollectability(index, inst, paymentDate, evalOpts));
  const missingInstallmentIds = [...new Set(installmentIds)].filter((id) => !inputs.has(id));
  return { results, missingInstallmentIds };
}

export interface NotCollectableFailure {
  installmentId: number;
  reason: CollectabilityReason | "CUOTA_INEXISTENTE";
  message: string;
}

export class InstallmentNotCollectableError extends Error {
  readonly failures: NotCollectableFailure[];
  constructor(failures: NotCollectableFailure[]) {
    const detail = failures.map((f) => `cuota ${f.installmentId}: ${f.message}`).join(" ");
    super(`${failures.length === 1 ? "La cuota ya no está disponible para cobrar" : "Algunas cuotas ya no están disponibles para cobrar"} — ${detail}`);
    this.failures = failures;
  }
}

/**
 * Lanza InstallmentNotCollectableError si alguna cuota no es cobrable en
 * `paymentDate`. Pensado para usarse con `db` antes de la transacción y otra
 * vez con `tx` dentro de ella (después del primer INSERT, mismo punto que el
 * re-chequeo de carrera existente), para que el rollback sea completo.
 */
export async function assertInstallmentsCollectable(
  dbClient: DbClient,
  installmentIds: ReadonlyArray<number>,
  paymentDate: string,
  opts: CollectabilityLoadOptions = {}
): Promise<void> {
  if (installmentIds.length === 0) return;
  const { results, missingInstallmentIds } = await evaluateInstallmentsCollectability(dbClient, installmentIds, paymentDate, opts);
  const failures: NotCollectableFailure[] = missingInstallmentIds.map((id) => ({ installmentId: id, reason: "CUOTA_INEXISTENTE", message: "La cuota no existe." }));
  for (const [id, r] of results) if (!r.collectable) failures.push({ installmentId: id, reason: r.reason, message: r.message });
  if (failures.length > 0) {
    failures.sort((a, b) => a.installmentId - b.installmentId);
    throw new InstallmentNotCollectableError(failures);
  }
}

/** Respuesta HTTP única para toda cuota que dejó de ser cobrable (400 explícito). */
export function installmentNotCollectableResponse(e: InstallmentNotCollectableError): { status: 400; body: Record<string, unknown> } {
  return {
    status: 400,
    body: {
      error: e.message,
      code: "INSTALLMENT_NOT_COLLECTABLE",
      blockingInstallmentIds: e.failures.map((f) => f.installmentId),
      failures: e.failures.map((f) => ({ installmentId: f.installmentId, reason: f.reason })),
    },
  };
}

/**
 * Contado por período (todo o nada): si ALGUNA cuota del período vence antes
 * de la fecha operativa mínima, el período entero queda bloqueado con este
 * mensaje explícito — nunca se cobra en silencio esa cuota histórica ni se
 * cobra el resto del período sin ella.
 */
export const CASH_PERIOD_HISTORICAL_INSTALLMENT_MESSAGE =
  `El período incluye cuotas con vencimiento anterior al ${COLLECTIONS_MIN_DUE_DATE}: no se puede cobrar de contado. ` +
  `Se bloquea el período completo; ninguna de sus cuotas se cobra.`;

export function hasHistoricalInstallment(reasons: Iterable<CollectabilityReason | "CUOTA_INEXISTENTE">): boolean {
  for (const r of reasons) if (r === "ANTERIOR_FECHA_MINIMA") return true;
  return false;
}

/** Igual que installmentNotCollectableResponse, con el mensaje explícito de período si hay cuotas históricas. */
export function cashPeriodNotCollectableResponse(e: InstallmentNotCollectableError): { status: 400; body: Record<string, unknown> } {
  const r = installmentNotCollectableResponse(e);
  if (hasHistoricalInstallment(e.failures.map((f) => f.reason))) {
    r.body.error = `${CASH_PERIOD_HISTORICAL_INSTALLMENT_MESSAGE} (${e.message})`;
  }
  return r;
}

/** Diagnóstico agregado (solo conteos) sobre todas las cuotas pendientes/vencidas no rendidas. */
export async function loadCollectabilityDiagnostics(dbClient: DbClient, paymentDate: string): Promise<CollectabilitySummary> {
  const rows = await dbClient.select({ id: policyInstallments.id }).from(policyInstallments)
    .where(and(inArray(policyInstallments.status, ["pendiente", "vencida"]), eq(policyInstallments.rendered, 0))).all();
  const inputs = await loadInstallmentInputs(dbClient, (rows as any[]).map((r) => r.id), {});
  const allPolicies = await dbClient.select(POLICY_COLUMNS).from(policies).all();
  const index = buildRenewalChainIndex((allPolicies as any[]).map((r) => ({
    id: r.id, status: r.status, startDate: r.startDate ?? null, endDate: r.endDate ?? null,
    renewedFromId: r.renewedFromId ?? null, cancellationEffectiveDate: r.cancellationEffectiveDate ?? null,
  })));
  return summarizeCollectability(index, [...inputs.values()], paymentDate);
}
