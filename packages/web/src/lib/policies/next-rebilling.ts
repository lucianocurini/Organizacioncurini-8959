// Regla central (pura, sin DB ni I/O) para resolver la PRÓXIMA refacturación
// de una póliza. Única fuente para el reporte de renovaciones/refacturaciones,
// para la sincronización transaccional de policies.next_rebilling_date
// (next-rebilling-sync.ts) y para el backfill (lib/backfill/
// next-rebilling-date-backfill.ts). Fechas = texto calendario YYYY-MM-DD.
//
// policies.next_rebilling_date sigue siendo el dato canónico: la fecha
// derivada del historial solo lo reemplaza cuando es NULL o está
// demostrablemente consumida (<= inicio del último período registrado).
// Una explícita posterior a la derivada se respeta siempre.
//
// El fin de cada período se interpreta SOLO por su forma matemática (nunca
// por las notas ni por el importador que lo cargó, que son diagnóstico):
//   a) fin = inicio + N meses − 1 día → próximo inicio = fin + 1 día;
//   b) fin = inicio + N meses         → próximo inicio = fin;
//   c) cualquier otra forma           → revisión.
// (a) y (b) no pueden darse a la vez: exigen días distintos en el fin.

import { addCalendarDays } from "../dates/argentina-date";

export const NEXT_REBILLING_VIGENTE_STATUSES = ["activa", "por_vencer"] as const;

export const BILLING_CYCLE_MONTHS: Record<string, number> = {
  mensual: 1, bimestral: 2, trimestral: 3, cuatrimestral: 4, semestral: 6, anual: 12,
};

export interface NextRebillingPolicyInput {
  status: string | null;
  endDate: string | null;
  billingCycle: string | null;
  nextRebillingDate: string | null;
}

export interface NextRebillingRebillingInput {
  id: number;
  billingStart: string | null;
  billingEnd: string | null;
  status: string | null;
}

export type NextRebillingReason =
  | "sin_refacturaciones"
  | "no_aplica_sin_ciclo"
  | "fecha_invalida"
  | "periodo_duplicado_activo"
  | "superposicion"
  | "periodo_irregular"
  | "periodo_futuro_ya_cargado"
  | "ultimo_periodo_vencido"
  | "periodos_discontinuos"
  | "ciclo_desconocido"
  | "ciclo_no_coincide"
  | "sin_corroboracion"
  | "explicita_invalida"
  | "explicita_dentro_del_periodo_vigente";

export type NextRebillingState =
  | "no_vigente"
  | "nulo_no_aplica"
  | "nulo_derivable"
  | "atrasado_derivable"
  | "coincide"
  | "posterior"
  | "explicita_sin_contraste"
  | "coincide_con_renovacion"
  | "nulo_sin_derivacion_segura"
  | "explicita_vencida_sin_derivacion"
  | "explicita_invalida"
  | "contradictorio_en_periodo";

export type NextRebillingKind = "safe" | "review" | "renewal" | "not_applicable";

export interface NextRebillingResolution {
  kind: NextRebillingKind;
  state: NextRebillingState;
  reason: NextRebillingReason | null;
  /** Fecha a usar (solo kind="safe"). */
  date: string | null;
  /** Fecha derivada del historial, si la hay. */
  derived: string | null;
  explicit: string | null;
  source: "explicita" | "derivada" | null;
  lastRebillingId: number | null;
  /**
   * Solo con reason "periodo_futuro_ya_cargado": inicio de la refacturación
   * ya cargada que todavía no empezó. La revisión es del evento SIGUIENTE a
   * ese período, no de esa refacturación (que es real y figura en su mes).
   */
  loadedFutureStart: string | null;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** Fecha calendario real YYYY-MM-DD con año plausible (descarta, p. ej., 0206-07-08). */
export function isPlausibleCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (y < MIN_YEAR || y > MAX_YEAR) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function sameDayMonths(a: string, b: string): number | null {
  if (a.slice(8) !== b.slice(8)) return null;
  const n = (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
  return n > 0 ? n : null;
}

/**
 * Forma matemática de un período: meses completos y próximo inicio, o null
 * si no es ni (a) fin inclusivo ni (b) fin = inicio siguiente.
 */
export function periodShape(billingStart: string, billingEnd: string): { months: number; nextStart: string } | null {
  const afterEnd = addCalendarDays(billingEnd, 1);
  const inclusive = sameDayMonths(billingStart, afterEnd);
  if (inclusive != null) return { months: inclusive, nextStart: afterEnd };
  const exclusive = sameDayMonths(billingStart, billingEnd);
  if (exclusive != null) return { months: exclusive, nextStart: billingEnd };
  return null;
}

interface ValidRebilling { id: number; billingStart: string; billingEnd: string }

type Derivation =
  | { ok: true; candidate: string; lastRebillingId: number; lastStart: string }
  | { ok: false; reason: NextRebillingReason; loadedFutureStart?: string };

function derive(policy: NextRebillingPolicyInput, rebillings: NextRebillingRebillingInput[], today: string): Derivation {
  const active = rebillings.filter((r) => (r.status ?? "activa") !== "duplicada");
  if (active.length === 0) {
    return policy.billingCycle && policy.billingCycle !== "anual"
      ? { ok: false, reason: "sin_refacturaciones" }
      : { ok: false, reason: "no_aplica_sin_ciclo" };
  }
  if (active.some((r) => !isPlausibleCalendarDate(r.billingStart) || !isPlausibleCalendarDate(r.billingEnd) || r.billingStart > r.billingEnd)) {
    return { ok: false, reason: "fecha_invalida" };
  }
  const valid: ValidRebilling[] = active.map((r) => ({ id: r.id, billingStart: r.billingStart as string, billingEnd: r.billingEnd as string }));
  valid.sort((a, b) => (a.billingEnd === b.billingEnd ? a.billingStart.localeCompare(b.billingStart) : a.billingEnd.localeCompare(b.billingEnd)));
  const last = valid[valid.length - 1]!;
  const others = valid.slice(0, -1);

  if (others.some((r) => r.billingStart === last.billingStart && r.billingEnd === last.billingEnd)) {
    return { ok: false, reason: "periodo_duplicado_activo" };
  }
  if (others.some((r) => r.billingEnd > last.billingStart)) return { ok: false, reason: "superposicion" };
  if (last.billingStart > today) return { ok: false, reason: "periodo_futuro_ya_cargado", loadedFutureStart: last.billingStart };

  const shape = periodShape(last.billingStart, last.billingEnd);
  if (!shape) return { ok: false, reason: "periodo_irregular" };
  if (shape.nextStart < today) return { ok: false, reason: "ultimo_periodo_vencido" };

  const prev = others.length > 0 ? others[others.length - 1]! : null;
  let prevCorroborates = false;
  if (prev) {
    const prevShape = periodShape(prev.billingStart, prev.billingEnd);
    if (!prevShape || prevShape.nextStart !== last.billingStart) return { ok: false, reason: "periodos_discontinuos" };
    prevCorroborates = prevShape.months === shape.months;
  }
  const cycleMonths = policy.billingCycle ? BILLING_CYCLE_MONTHS[policy.billingCycle] : undefined;
  if (policy.billingCycle && cycleMonths === undefined) return { ok: false, reason: "ciclo_desconocido" };
  if (cycleMonths !== undefined && cycleMonths !== shape.months) return { ok: false, reason: "ciclo_no_coincide" };
  if (cycleMonths === undefined && !prevCorroborates) return { ok: false, reason: "sin_corroboracion" };

  return { ok: true, candidate: shape.nextStart, lastRebillingId: last.id, lastStart: last.billingStart };
}

/**
 * Resuelve la próxima refacturación de una póliza. `today` = día calendario
 * de Argentina (toArgentinaCalendarDay()).
 */
export function resolveNextRebilling(
  policy: NextRebillingPolicyInput,
  rebillings: NextRebillingRebillingInput[],
  today: string,
): NextRebillingResolution {
  const explicit = policy.nextRebillingDate ? policy.nextRebillingDate : null;
  const d = derive(policy, rebillings, today);
  const derived = d.ok ? d.candidate : null;
  const lastRebillingId = d.ok ? d.lastRebillingId : null;
  const loadedFutureStart = !d.ok && d.loadedFutureStart ? d.loadedFutureStart : null;
  const out = (kind: NextRebillingKind, state: NextRebillingState, reason: NextRebillingReason | null, date: string | null, source: NextRebillingResolution["source"]): NextRebillingResolution =>
    ({ kind, state, reason, date, derived, explicit, source, lastRebillingId, loadedFutureStart });

  if (!policy.status || !(NEXT_REBILLING_VIGENTE_STATUSES as readonly string[]).includes(policy.status)) {
    return out("not_applicable", "no_vigente", null, null, null);
  }
  // La próxima refacturación no puede caer en el mes de la renovación (ni
  // después): ahí el evento es la renovación, que el reporte ya proyecta por
  // endDate — nunca se muestra la misma póliza en las dos secciones.
  const endDate = isPlausibleCalendarDate(policy.endDate) ? policy.endDate : null;
  const isRenewal = (date: string) => !!endDate && (date >= endDate || date.slice(0, 7) === endDate.slice(0, 7));
  const safe = (state: NextRebillingState, date: string, source: "explicita" | "derivada") =>
    isRenewal(date) ? out("renewal", "coincide_con_renovacion", null, null, null) : out("safe", state, null, date, source);

  if (explicit == null) {
    if (d.ok) return safe("nulo_derivable", d.candidate, "derivada");
    return d.reason === "no_aplica_sin_ciclo"
      ? out("not_applicable", "nulo_no_aplica", null, null, null)
      : out("review", "nulo_sin_derivacion_segura", d.reason, null, null);
  }
  if (!isPlausibleCalendarDate(explicit)) return out("review", "explicita_invalida", "explicita_invalida", null, null);
  if (!d.ok) {
    return explicit < today
      ? out("review", "explicita_vencida_sin_derivacion", d.reason, null, null)
      : safe("explicita_sin_contraste", explicit, "explicita");
  }
  if (explicit === d.candidate) return safe("coincide", explicit, "explicita");
  if (explicit > d.candidate) return safe("posterior", explicit, "explicita");
  if (explicit <= d.lastStart) return safe("atrasado_derivable", d.candidate, "derivada");
  return out("review", "contradictorio_en_periodo", "explicita_dentro_del_periodo_vigente", null, null);
}

const REASON_LABELS: Record<NextRebillingReason, string> = {
  sin_refacturaciones: "Tiene frecuencia de refacturación pero ninguna refacturación cargada",
  no_aplica_sin_ciclo: "Sin frecuencia de refacturación",
  fecha_invalida: "Alguna refacturación tiene fechas inválidas o fuera de rango",
  periodo_duplicado_activo: "El último período está cargado dos veces sin invalidar",
  superposicion: "Períodos de refacturación superpuestos",
  periodo_irregular: "El último período no termina ni el día anterior ni el mismo día del inicio siguiente",
  periodo_futuro_ya_cargado: "Ya hay una refacturación cargada que todavía no empezó; lo que falta definir es la siguiente, posterior a ese período",
  ultimo_periodo_vencido: "El último período ya terminó y no hay una refacturación nueva cargada",
  periodos_discontinuos: "Hay un salto o un solapamiento entre los dos últimos períodos",
  ciclo_desconocido: "Frecuencia de refacturación desconocida",
  ciclo_no_coincide: "La duración del último período no coincide con la frecuencia de la póliza",
  sin_corroboracion: "Sin frecuencia informada ni período anterior que confirme la duración",
  explicita_invalida: "La próxima refacturación guardada tiene una fecha inválida",
  explicita_dentro_del_periodo_vigente: "La próxima refacturación guardada cae dentro del período vigente",
};

function formatDayAr(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/** Motivo legible de revisión (pantalla, Excel y CSV usan este mismo texto). */
export function nextRebillingReviewLabel(
  r: Pick<NextRebillingResolution, "kind" | "state" | "reason" | "explicit"> & { loadedFutureStart?: string | null },
): string | null {
  if (r.kind !== "review" || !r.reason) return null;
  const label = r.reason === "periodo_futuro_ya_cargado" && r.loadedFutureStart
    ? `Ya hay una refacturación cargada que empieza el ${formatDayAr(r.loadedFutureStart)}; lo que falta definir es la siguiente, posterior a ese período`
    : REASON_LABELS[r.reason];
  if (r.state === "explicita_vencida_sin_derivacion" && r.explicit) {
    return `Próxima refacturación guardada vencida (${formatDayAr(r.explicit)}); ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  }
  return label;
}
