// Sincronización transaccional de policies.next_rebilling_date después de
// crear, editar, reconstruir o borrar una refacturación desde la ficha (los
// únicos caminos en uso; los importadores fueron de carga inicial y no la
// llaman). Ambos pasos se llaman SIEMPRE con el cliente transaccional `tx` del
// mismo camino de escritura:
//   1. captureNextRebillingBaseline — ANTES de la mutación: fecha derivada del
//      estado anterior;
//   2. syncPolicyNextRebillingDate — DESPUÉS de la mutación.
// Si cualquiera de los dos lanza, la mutación tampoco queda escrita.
//
// Regla conservadora (regla central en next-rebilling.ts):
// - Después hay fecha derivada SEGURA y la guardada es NULL, está consumida o
//   era la derivada del estado anterior → se escribe la nueva.
// - Después NO hay fecha segura y la guardada era exactamente la derivada del
//   estado anterior → quedó sin respaldo: se limpia a NULL ("cleared").
// - Una explícita posterior distinta de esa derivada nunca se pisa ni se
//   limpia; ante revisión se conserva el dato y se devuelve el motivo.
// Toda escritura lleva guarda sobre el valor leído
// (WHERE next_rebilling_date IS <leído>): si otra escritura lo cambió en el
// medio, lanza NextRebillingSyncConflictError y la transacción vuelve atrás.

import { and, eq, isNull } from "drizzle-orm";
import { policies, rebillings } from "../../api/database/schema";
import {
  resolveNextRebilling,
  nextRebillingReviewLabel,
  type NextRebillingKind,
  type NextRebillingReason,
  type NextRebillingResolution,
  type NextRebillingState,
} from "./next-rebilling";

export class NextRebillingSyncConflictError extends Error {
  constructor(policyId: number) {
    super(`La próxima refacturación de la póliza ${policyId} cambió durante la operación — no se aplicó ningún cambio.`);
  }
}

export type NextRebillingSyncStatus =
  | "updated" | "unchanged" | "kept_explicit" | "cleared" | "review" | "renewal" | "not_applicable";

export interface NextRebillingSyncResult {
  policyId: number;
  status: NextRebillingSyncStatus;
  before: string | null;
  after: string | null;
  kind: NextRebillingKind;
  state: NextRebillingState;
  reason: NextRebillingReason | null;
  reasonLabel: string | null;
  /** Fecha derivada del historial, si la hay. */
  derived: string | null;
}

/** Fecha derivada del estado ANTERIOR a la mutación (null si no había). */
export interface NextRebillingBaseline { derived: string | null }

async function loadAndResolve(tx: any, policyId: number, today: string) {
  const policy = await tx.select({
    status: policies.status,
    endDate: policies.endDate,
    billingCycle: policies.billingCycle,
    nextRebillingDate: policies.nextRebillingDate,
  }).from(policies).where(eq(policies.id, policyId)).get();
  if (!policy) throw new Error(`syncPolicyNextRebillingDate: la póliza ${policyId} no existe.`);
  const rebillingRows = await tx.select({
    id: rebillings.id,
    billingStart: rebillings.billingStart,
    billingEnd: rebillings.billingEnd,
    status: rebillings.status,
  }).from(rebillings).where(eq(rebillings.policyId, policyId)).all();
  return { policy, rebillingRows, resolution: resolveNextRebilling(policy, rebillingRows, today) };
}

export async function captureNextRebillingBaseline(tx: any, policyId: number, today: string): Promise<NextRebillingBaseline> {
  const { resolution } = await loadAndResolve(tx, policyId, today);
  return { derived: resolution.derived };
}

export async function syncPolicyNextRebillingDate(
  tx: any,
  policyId: number,
  { today, baseline }: { today: string; baseline: NextRebillingBaseline },
): Promise<NextRebillingSyncResult> {
  const loaded = await loadAndResolve(tx, policyId, today);
  const before: string | null = loaded.policy.nextRebillingDate ?? null;
  // La guardada era la derivada del estado anterior y ya no coincide con la
  // actual: no es un dato del usuario sino un derivado que perdió respaldo.
  const unbacked = before != null && before === baseline.derived && before !== loaded.resolution.derived;
  const resolution: NextRebillingResolution = unbacked
    ? resolveNextRebilling({ ...loaded.policy, nextRebillingDate: null }, loaded.rebillingRows, today)
    : loaded.resolution;

  const result = (status: NextRebillingSyncStatus, after: string | null): NextRebillingSyncResult => ({
    policyId,
    status,
    before,
    after,
    kind: resolution.kind,
    state: resolution.state,
    reason: resolution.reason,
    reasonLabel: nextRebillingReviewLabel(resolution),
    derived: resolution.derived,
  });
  const compareAndSet = async (value: string | null) => {
    const updated = await tx.update(policies)
      .set({ nextRebillingDate: value })
      .where(and(
        eq(policies.id, policyId),
        before === null ? isNull(policies.nextRebillingDate) : eq(policies.nextRebillingDate, before),
      ))
      .returning({ id: policies.id });
    if (updated.length !== 1) throw new NextRebillingSyncConflictError(policyId);
  };

  if (resolution.kind === "safe" && resolution.source === "derivada") {
    const date = resolution.date!;
    if (date === before) return result("unchanged", before);
    await compareAndSet(date);
    return result("updated", date);
  }
  // Guardada = derivada: ya sincronizada. Posterior o sin contraste: se respeta.
  if (resolution.kind === "safe") return result(resolution.state === "coincide" ? "unchanged" : "kept_explicit", before);
  if (unbacked) {
    await compareAndSet(null);
    return result("cleared", null);
  }
  if (resolution.kind === "review") return result("review", before);
  return result(resolution.kind, before);
}
