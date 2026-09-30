// Regla ÚNICA de cobrabilidad de cuotas en Cobranzas (individual, lote legacy,
// lote con titular y contado por período). Pura: no toca DB. El loader
// (src/api/installment-collectability-loader.ts) arma las entradas y la usa
// tanto para filtrar selectores como para revalidar DENTRO de la transacción.
//
// Regla de negocio confirmada (2026-09-25):
//   1. Fecha operativa mínima inclusiva: installment.dueDate >= 2026-07-01.
//   2. Cuota cobrable: pendiente o vencida, no rendida, sin pago confirmado
//      (pagada / no_exigible / duplicada nunca se cobran).
//   3. Debe existir UNA póliza vigente en la cadena de renovación
//      (renewedFromId) para la fecha de pago. Solo se admiten cuotas de esa
//      póliza vigente y de su antecesora DIRECTA; nunca de antecesoras más
//      antiguas, de sucesoras futuras ni de cadenas sin póliza vigente.
//   4. Vigencia inclusiva: startDate <= fecha <= endDate. Una cancelada con
//      fecha efectiva E sigue vigente durante E y queda fuera desde E+1; sus
//      cuotas que vencen después de E no se cobran.
//   5. Superposición: si dos pólizas de la misma cadena son vigentes el mismo
//      día, la sucesora prevalece desde su inicio y la anterior pasa a ser su
//      antecesora directa. Nunca se modifican fechas históricas.
//   6. Datos indispensables faltantes o inválidos bloquean (nunca se infieren):
//      fechas de póliza inválidas, cancelada sin fecha efectiva válida,
//      "renovada" sin ninguna póliza que la renueve.
//   7. renewedFromId roto (apunta a una póliza inexistente): la póliza se trata
//      como inicio de cadena y se reporta la anomalía.
//
// Todas las fechas son días calendario "YYYY-MM-DD" (Argentina) y se comparan
// como strings, que es orden cronológico para ese formato validado.

import { isValidCalendarDate } from "../installments/plan";

export const COLLECTIONS_MIN_DUE_DATE = "2026-07-01";

export interface CollectabilityPolicy {
  id: number;
  status: string;
  startDate: string | null;
  endDate: string | null;
  renewedFromId: number | null;
  cancellationEffectiveDate: string | null;
}

export interface CollectabilityInstallment {
  id: number;
  policyId: number;
  status: string;
  dueDate: string | null;
  rendered: number | boolean | null;
  hasConfirmedPayment: boolean;
}

export type CollectabilityReason =
  | "FECHA_PAGO_INVALIDA"
  | "ESTADO_NO_COBRABLE"
  | "RENDIDA"
  | "PAGO_CONFIRMADO"
  | "VENCIMIENTO_INVALIDO"
  | "ANTERIOR_FECHA_MINIMA"
  | "POLIZA_INEXISTENTE"
  | "POLIZA_FECHAS_INVALIDAS"
  | "CANCELADA_SIN_FECHA_EFECTIVA"
  | "RENOVADA_SIN_SUCESOR"
  | "VENCE_DESPUES_DE_CANCELACION"
  | "POLIZA_FUTURA"
  | "SIN_POLIZA_VIGENTE_EN_CADENA"
  | "CADENA_AMBIGUA"
  | "ANTECESORA_MAS_ANTIGUA"
  | "FUERA_DE_CADENA_VIGENTE";

export type CollectabilityVia = "poliza_vigente" | "antecesora_directa";

export type CollectabilityResult =
  | { collectable: true; via: CollectabilityVia; currentPolicyId: number }
  | { collectable: false; reason: CollectabilityReason; message: string };

// ─── Índice de cadenas de renovación ────────────────────────────────────────

export interface RenewalChainAnomalies {
  /** renewedFromId que apunta a una póliza inexistente (se trata como inicio de cadena). */
  brokenLinkPolicyIds: number[];
  /** renewedFromId === id (se ignora el enlace). */
  selfLinkPolicyIds: number[];
  /** Pólizas renovadas por más de una póliza (cadena bifurcada). */
  multipleSuccessorPolicyIds: number[];
  /** Pólizas que forman parte de un ciclo de renewedFromId. */
  cyclePolicyIds: number[];
}

export interface RenewalChainIndex {
  policies: ReadonlyMap<number, CollectabilityPolicy>;
  /** Predecesora VÁLIDA (existente, no auto-referencia) o null. */
  predecessorOf: ReadonlyMap<number, number | null>;
  successorsOf: ReadonlyMap<number, readonly number[]>;
  /** Representante de la cadena (componente conexa por renewedFromId válido). */
  chainOf: ReadonlyMap<number, number>;
  chainMembers: ReadonlyMap<number, readonly number[]>;
  anomalies: RenewalChainAnomalies;
}

/**
 * Arma el índice a partir de un conjunto de pólizas. El caller es responsable
 * de pasar cadenas COMPLETAS (el loader hace el cierre transitivo): un
 * renewedFromId que apunte a un id fuera del conjunto se interpreta como
 * enlace roto.
 */
export function buildRenewalChainIndex(input: ReadonlyArray<CollectabilityPolicy>): RenewalChainIndex {
  const policies = new Map<number, CollectabilityPolicy>();
  for (const p of input) policies.set(p.id, p);

  const anomalies: RenewalChainAnomalies = { brokenLinkPolicyIds: [], selfLinkPolicyIds: [], multipleSuccessorPolicyIds: [], cyclePolicyIds: [] };
  const predecessorOf = new Map<number, number | null>();
  const successorsOf = new Map<number, number[]>();
  for (const p of policies.values()) {
    let pred: number | null = null;
    if (p.renewedFromId != null) {
      if (p.renewedFromId === p.id) anomalies.selfLinkPolicyIds.push(p.id);
      else if (!policies.has(p.renewedFromId)) anomalies.brokenLinkPolicyIds.push(p.id);
      else pred = p.renewedFromId;
    }
    predecessorOf.set(p.id, pred);
    if (pred != null) {
      const arr = successorsOf.get(pred) ?? [];
      arr.push(p.id);
      successorsOf.set(pred, arr);
    }
  }
  for (const [id, succ] of successorsOf) if (succ.length > 1) anomalies.multipleSuccessorPolicyIds.push(id);

  // Ciclos: subir por predecessorOf; si se vuelve a un id ya visitado en el mismo recorrido, hay ciclo.
  const inCycle = new Set<number>();
  for (const id of policies.keys()) {
    const path: number[] = [];
    const onPath = new Set<number>();
    let cur: number | null = id;
    while (cur != null && !onPath.has(cur)) {
      onPath.add(cur);
      path.push(cur);
      cur = predecessorOf.get(cur) ?? null;
    }
    if (cur != null) for (const x of path.slice(path.indexOf(cur))) inCycle.add(x);
  }
  anomalies.cyclePolicyIds = [...inCycle].sort((a, b) => a - b);

  // Componentes conexas (union-find) por enlaces válidos.
  const parent = new Map<number, number>();
  for (const id of policies.keys()) parent.set(id, id);
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  for (const [id, pred] of predecessorOf) if (pred != null) parent.set(find(id), find(pred));
  const chainOf = new Map<number, number>();
  const chainMembers = new Map<number, number[]>();
  for (const id of policies.keys()) {
    const root = find(id);
    chainOf.set(id, root);
    const arr = chainMembers.get(root) ?? [];
    arr.push(id);
    chainMembers.set(root, arr);
  }

  for (const k of ["brokenLinkPolicyIds", "selfLinkPolicyIds", "multipleSuccessorPolicyIds"] as const) anomalies[k].sort((a, b) => a - b);
  return { policies, predecessorOf, successorsOf, chainOf, chainMembers, anomalies };
}

// ─── Integridad y vigencia de una póliza ────────────────────────────────────

type PolicyIntegrity =
  | { ok: true; start: string; end: string; cancellationDate: string | null }
  | { ok: false; reason: "POLIZA_FECHAS_INVALIDAS" | "CANCELADA_SIN_FECHA_EFECTIVA" | "RENOVADA_SIN_SUCESOR" };

function policyIntegrity(index: RenewalChainIndex, p: CollectabilityPolicy): PolicyIntegrity {
  if (!p.startDate || !p.endDate || !isValidCalendarDate(p.startDate) || !isValidCalendarDate(p.endDate) || p.startDate > p.endDate) {
    return { ok: false, reason: "POLIZA_FECHAS_INVALIDAS" };
  }
  if (p.status === "cancelada") {
    if (!p.cancellationEffectiveDate || !isValidCalendarDate(p.cancellationEffectiveDate)) return { ok: false, reason: "CANCELADA_SIN_FECHA_EFECTIVA" };
    const end = p.cancellationEffectiveDate < p.endDate ? p.cancellationEffectiveDate : p.endDate;
    return { ok: true, start: p.startDate, end, cancellationDate: p.cancellationEffectiveDate };
  }
  if (p.status === "renovada" && (index.successorsOf.get(p.id)?.length ?? 0) === 0) {
    return { ok: false, reason: "RENOVADA_SIN_SUCESOR" };
  }
  return { ok: true, start: p.startDate, end: p.endDate, cancellationDate: null };
}

function isVigenteOn(index: RenewalChainIndex, policyId: number, date: string): boolean {
  const p = index.policies.get(policyId);
  if (!p) return false;
  const integ = policyIntegrity(index, p);
  return integ.ok && integ.start <= date && date <= integ.end;
}

function isDescendant(index: RenewalChainIndex, ancestorId: number, candidateId: number): boolean {
  const seen = new Set<number>();
  let frontier = [...(index.successorsOf.get(ancestorId) ?? [])];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const id of frontier) {
      if (id === candidateId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(...(index.successorsOf.get(id) ?? []));
    }
    frontier = next;
  }
  return false;
}

export type CurrentPolicyResolution =
  | { kind: "current"; policyId: number }
  | { kind: "none" }
  | { kind: "ambiguous"; policyIds: number[] };

/**
 * Póliza "vigente actual" de la cadena de `policyId` para `date`. Entre las
 * vigentes por fecha, se descarta toda la que tenga una DESCENDIENTE también
 * vigente (la sucesora prevalece desde su inicio). Una cadena con ciclo o que
 * sigue teniendo más de una candidata queda ambigua (se bloquea y se reporta).
 */
export function resolveChainCurrentPolicy(index: RenewalChainIndex, policyId: number, date: string): CurrentPolicyResolution {
  const root = index.chainOf.get(policyId);
  if (root == null) return { kind: "none" };
  const members = index.chainMembers.get(root) ?? [];
  if (members.some((m) => index.anomalies.cyclePolicyIds.includes(m))) return { kind: "ambiguous", policyIds: [...members] };
  const vigentes = members.filter((m) => isVigenteOn(index, m, date));
  const current = vigentes.filter((v) => !vigentes.some((o) => o !== v && isDescendant(index, v, o)));
  if (current.length === 1) return { kind: "current", policyId: current[0]! };
  if (current.length === 0) return { kind: "none" };
  return { kind: "ambiguous", policyIds: current.sort((a, b) => a - b) };
}

// ─── Evaluación de una cuota ────────────────────────────────────────────────

const COLLECTABLE_INSTALLMENT_STATUSES = new Set(["pendiente", "vencida"]);

function fail(reason: CollectabilityReason, message: string): CollectabilityResult {
  return { collectable: false, reason, message };
}

export interface CollectabilityEvaluationOptions {
  /**
   * Revalidación de un cobro YA existente (cambio de fecha de un pago o lote
   * confirmado sobre las mismas cuotas): la cuota puede estar "pagada" por
   * ese mismo cobro. El caller debe excluir esos pagos de hasConfirmedPayment;
   * el resto de la regla (vencimiento mínimo, vigencia, cadena) aplica igual.
   */
  existingCollection?: boolean;
}

export function evaluateInstallmentCollectability(
  index: RenewalChainIndex,
  installment: CollectabilityInstallment,
  paymentDate: string,
  opts: CollectabilityEvaluationOptions = {}
): CollectabilityResult {
  if (typeof paymentDate !== "string" || !isValidCalendarDate(paymentDate)) {
    return fail("FECHA_PAGO_INVALIDA", "La fecha de pago no es una fecha calendario válida (YYYY-MM-DD).");
  }
  const statusAllowed = COLLECTABLE_INSTALLMENT_STATUSES.has(installment.status)
    || (opts.existingCollection === true && installment.status === "pagada");
  if (!statusAllowed) {
    return fail("ESTADO_NO_COBRABLE", `La cuota está en estado "${installment.status}" (solo se cobran cuotas pendientes o vencidas).`);
  }
  if (installment.rendered === 1 || installment.rendered === true) return fail("RENDIDA", "La cuota ya fue rendida.");
  if (installment.hasConfirmedPayment) return fail("PAGO_CONFIRMADO", "La cuota ya tiene un pago confirmado.");
  if (!installment.dueDate || !isValidCalendarDate(installment.dueDate)) {
    return fail("VENCIMIENTO_INVALIDO", "El vencimiento de la cuota falta o no es una fecha válida.");
  }
  if (installment.dueDate < COLLECTIONS_MIN_DUE_DATE) {
    return fail("ANTERIOR_FECHA_MINIMA", `La cuota vence antes de la fecha operativa mínima (${COLLECTIONS_MIN_DUE_DATE}).`);
  }

  const policy = index.policies.get(installment.policyId);
  if (!policy) return fail("POLIZA_INEXISTENTE", "La póliza de la cuota no existe.");
  const integ = policyIntegrity(index, policy);
  if (!integ.ok) {
    if (integ.reason === "POLIZA_FECHAS_INVALIDAS") return fail(integ.reason, "La póliza tiene fechas de vigencia faltantes o inválidas.");
    if (integ.reason === "CANCELADA_SIN_FECHA_EFECTIVA") return fail(integ.reason, "La póliza está cancelada sin fecha efectiva de cancelación válida.");
    return fail(integ.reason, "La póliza figura como renovada pero ninguna póliza la renueva.");
  }
  if (integ.cancellationDate != null && installment.dueDate > integ.cancellationDate) {
    return fail("VENCE_DESPUES_DE_CANCELACION", "La cuota vence después de la fecha efectiva de cancelación de la póliza.");
  }
  if (integ.start > paymentDate) return fail("POLIZA_FUTURA", "La póliza todavía no inició su vigencia en la fecha de pago.");

  const current = resolveChainCurrentPolicy(index, policy.id, paymentDate);
  if (current.kind === "none") {
    return fail("SIN_POLIZA_VIGENTE_EN_CADENA", "No hay ninguna póliza vigente en la cadena de renovación para la fecha de pago.");
  }
  if (current.kind === "ambiguous") {
    return fail("CADENA_AMBIGUA", "La cadena de renovación tiene más de una póliza vigente o un ciclo; no se puede determinar la vigente.");
  }
  if (current.policyId === policy.id) return { collectable: true, via: "poliza_vigente", currentPolicyId: current.policyId };
  if (index.predecessorOf.get(current.policyId) === policy.id) {
    return { collectable: true, via: "antecesora_directa", currentPolicyId: current.policyId };
  }
  if (isDescendant(index, policy.id, current.policyId)) {
    return fail("ANTECESORA_MAS_ANTIGUA", "La póliza es una antecesora anterior a la antecesora directa de la póliza vigente.");
  }
  return fail("FUERA_DE_CADENA_VIGENTE", "La póliza no es la vigente ni su antecesora directa en la fecha de pago.");
}

// ─── Diagnóstico agregado (solo conteos, sin datos personales) ──────────────

export interface CollectabilitySummary {
  paymentDate: string;
  evaluatedInstallments: number;
  collectableByVia: Record<CollectabilityVia, number>;
  notCollectableByReason: Partial<Record<CollectabilityReason, number>>;
  policyAnomalies: {
    cancelledWithoutEffectiveDate: number;
    renewedWithoutSuccessor: number;
    invalidDates: number;
    brokenRenewalLinks: number;
    selfRenewalLinks: number;
    multipleSuccessors: number;
    policiesInCycles: number;
    /** Cadenas con más de una póliza vigente por fecha antes de aplicar la prioridad de la sucesora. */
    chainsWithOverlappingVigentes: number;
    /** Cadenas que siguen ambiguas después de aplicar la prioridad (se bloquean). */
    ambiguousChains: number;
  };
}

export function summarizeCollectability(
  index: RenewalChainIndex,
  installments: ReadonlyArray<CollectabilityInstallment>,
  paymentDate: string
): CollectabilitySummary {
  const collectableByVia: Record<CollectabilityVia, number> = { poliza_vigente: 0, antecesora_directa: 0 };
  const notCollectableByReason: Partial<Record<CollectabilityReason, number>> = {};
  for (const inst of installments) {
    const r = evaluateInstallmentCollectability(index, inst, paymentDate);
    if (r.collectable) collectableByVia[r.via]++;
    else notCollectableByReason[r.reason] = (notCollectableByReason[r.reason] ?? 0) + 1;
  }
  let cancelledWithoutEffectiveDate = 0, renewedWithoutSuccessor = 0, invalidDates = 0;
  for (const p of index.policies.values()) {
    const integ = policyIntegrity(index, p);
    if (!integ.ok) {
      if (integ.reason === "CANCELADA_SIN_FECHA_EFECTIVA") cancelledWithoutEffectiveDate++;
      else if (integ.reason === "RENOVADA_SIN_SUCESOR") renewedWithoutSuccessor++;
      else invalidDates++;
    }
  }
  let chainsWithOverlappingVigentes = 0, ambiguousChains = 0;
  if (isValidCalendarDate(paymentDate)) {
    for (const [root, members] of index.chainMembers) {
      if (members.filter((m) => isVigenteOn(index, m, paymentDate)).length > 1) chainsWithOverlappingVigentes++;
      if (resolveChainCurrentPolicy(index, root, paymentDate).kind === "ambiguous") ambiguousChains++;
    }
  }
  return {
    paymentDate,
    evaluatedInstallments: installments.length,
    collectableByVia,
    notCollectableByReason,
    policyAnomalies: {
      cancelledWithoutEffectiveDate, renewedWithoutSuccessor, invalidDates,
      brokenRenewalLinks: index.anomalies.brokenLinkPolicyIds.length,
      selfRenewalLinks: index.anomalies.selfLinkPolicyIds.length,
      multipleSuccessors: index.anomalies.multipleSuccessorPolicyIds.length,
      policiesInCycles: index.anomalies.cyclePolicyIds.length,
      chainsWithOverlappingVigentes, ambiguousChains,
    },
  };
}
