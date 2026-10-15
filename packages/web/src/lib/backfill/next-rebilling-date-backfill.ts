// Backfill de policies.next_rebilling_date — SOLO los casos con fecha
// derivada segura (guardada NULL o consumida) según la regla central
// (lib/policies/next-rebilling.ts), que lee los períodos históricos —incluidos
// los de importadores— por su forma matemática, nunca por las notas. La
// cantidad NO está fijada: la auditoría 2026-10-14 contó 13 con la regla
// anterior; con la regla por forma matemática hace falta un dry-run nuevo y
// autorizado, y la aplicación exige exactamente la cantidad y la huella de
// ese dry-run. Todo lo demás queda excluido por construcción:
// - períodos irregulares y cualquier otro motivo de revisión manual
//   (superposición, discontinuidad, ciclo, último período vencido, sin
//   refacturaciones, período futuro ya cargado, etc.),
// - períodos duplicados sin invalidar (periodo_duplicado_activo),
// - derivada que coincide con la renovación (coincide_con_renovacion),
// - fechas fuera de rango (año 0206 y similares → fecha_invalida /
//   explicita_invalida),
// - explícitas posteriores o sin contraste (nunca se pisan).
//
// Usable contra cualquier cliente compatible con @libsql/client (Turso o un
// archivo SQLite local). planNextRebillingDateBackfill solo lee (2 SELECT).
// applyNextRebillingDateBackfill escribe en UN batch "write" atómico: cada
// UPDATE lleva guarda sobre el valor leído y una sentencia de control que
// aborta el batch completo si la guarda no afectó exactamente 1 fila.
// Idempotente: después de aplicar, el plan queda vacío y una segunda pasada
// no cambia nada.

import {
  resolveNextRebilling,
  NEXT_REBILLING_VIGENTE_STATUSES,
  type NextRebillingRebillingInput,
  type NextRebillingResolution,
} from "../policies/next-rebilling";

export interface BackfillStatement { sql: string; args?: (string | number | null)[] }

export interface NextRebillingBackfillClient {
  execute(stmt: BackfillStatement): Promise<{ rows: any[] }>;
  batch(stmts: BackfillStatement[], mode: "write"): Promise<unknown>;
}

export interface NextRebillingBackfillItem {
  policyId: number;
  before: string | null;
  after: string;
  state: "nulo_derivable" | "atrasado_derivable";
  lastRebillingId: number;
}

export interface NextRebillingBackfillPlan {
  today: string;
  vigentePolicies: number;
  eligible: NextRebillingBackfillItem[];
  /** Conteo de las pólizas vigentes NO incluidas, por categoría (kind:state[:reason]). */
  excluded: Record<string, number>;
  /** sha256 de los casos elegibles (id, antes, después) — no depende de `today`. */
  fingerprint: string;
}

export const NEXT_REBILLING_BACKFILL_STATES = ["nulo_derivable", "atrasado_derivable"] as const;

const VIGENTES_SQL = NEXT_REBILLING_VIGENTE_STATUSES.map((s) => `'${s}'`).join(", ");

export function isNextRebillingBackfillEligible(r: NextRebillingResolution): boolean {
  return r.kind === "safe"
    && r.source === "derivada"
    && (NEXT_REBILLING_BACKFILL_STATES as readonly string[]).includes(r.state)
    && r.lastRebillingId != null;
}

export async function nextRebillingBackfillFingerprint(items: NextRebillingBackfillItem[]): Promise<string> {
  const canonical = [...items]
    .sort((a, b) => a.policyId - b.policyId)
    .map((i) => [i.policyId, i.before, i.after]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Dry-run: solo lectura. */
export async function planNextRebillingDateBackfill(client: NextRebillingBackfillClient, today: string): Promise<NextRebillingBackfillPlan> {
  const pol = await client.execute({
    sql: `SELECT id, status, end_date, billing_cycle, next_rebilling_date FROM policies WHERE status IN (${VIGENTES_SQL}) ORDER BY id`,
  });
  const reb = await client.execute({
    sql: `SELECT r.id, r.policy_id, r.billing_start, r.billing_end, r.status FROM rebillings r
          JOIN policies p ON p.id = r.policy_id WHERE p.status IN (${VIGENTES_SQL}) ORDER BY r.id`,
  });
  const byPolicy = new Map<number, NextRebillingRebillingInput[]>();
  for (const r of reb.rows) {
    const list = byPolicy.get(Number(r.policy_id)) ?? [];
    list.push({ id: Number(r.id), billingStart: r.billing_start ?? null, billingEnd: r.billing_end ?? null, status: r.status ?? null });
    byPolicy.set(Number(r.policy_id), list);
  }

  const eligible: NextRebillingBackfillItem[] = [];
  const excluded: Record<string, number> = {};
  for (const p of pol.rows) {
    const policyId = Number(p.id);
    const resolution = resolveNextRebilling(
      { status: p.status ?? null, endDate: p.end_date ?? null, billingCycle: p.billing_cycle ?? null, nextRebillingDate: p.next_rebilling_date ?? null },
      byPolicy.get(policyId) ?? [],
      today,
    );
    if (isNextRebillingBackfillEligible(resolution)) {
      eligible.push({
        policyId,
        before: p.next_rebilling_date ?? null,
        after: resolution.date!,
        state: resolution.state as NextRebillingBackfillItem["state"],
        lastRebillingId: resolution.lastRebillingId!,
      });
      continue;
    }
    // Ya sincronizada: la derivada coincide con la guardada (estado "coincide").
    const key = [resolution.kind, resolution.state, resolution.reason].filter(Boolean).join(":");
    excluded[key] = (excluded[key] ?? 0) + 1;
  }
  return { today, vigentePolicies: pol.rows.length, eligible, excluded, fingerprint: await nextRebillingBackfillFingerprint(eligible) };
}

export class NextRebillingBackfillAbortError extends Error {}

export interface NextRebillingBackfillApplyOptions {
  today: string;
  /** Cantidad exacta del dry-run aprobado. */
  expectedCount: number;
  /** Huella del dry-run aprobado. */
  expectedFingerprint: string;
}

export interface NextRebillingBackfillApplyResult {
  applied: number;
  items: NextRebillingBackfillItem[];
  /** Plan recalculado después de aplicar — debe quedar vacío. */
  remainingAfter: number;
}

// Sentencia de control: aborta el batch (y con él toda la transacción) si
// el UPDATE anterior no tocó exactamente 1 fila. json('…') con texto
// inválido es un error de SQLite ("malformed JSON"), así que el CASE solo
// lo evalúa cuando la guarda falló.
const GUARD_SQL = "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('next_rebilling_backfill_guard_failed') END";

export async function applyNextRebillingDateBackfill(
  client: NextRebillingBackfillClient,
  { today, expectedCount, expectedFingerprint }: NextRebillingBackfillApplyOptions,
): Promise<NextRebillingBackfillApplyResult> {
  const plan = await planNextRebillingDateBackfill(client, today);
  if (plan.eligible.length === 0) return { applied: 0, items: [], remainingAfter: 0 };
  if (plan.eligible.length !== expectedCount) {
    throw new NextRebillingBackfillAbortError(`Se esperaban ${expectedCount} casos y el plan actual tiene ${plan.eligible.length} — no se aplicó nada.`);
  }
  if (plan.fingerprint !== expectedFingerprint) {
    throw new NextRebillingBackfillAbortError("La huella del plan actual no coincide con el dry-run aprobado — no se aplicó nada.");
  }

  const stmts: BackfillStatement[] = [];
  for (const item of plan.eligible) {
    stmts.push({
      sql: `UPDATE policies SET next_rebilling_date = ? WHERE id = ? AND next_rebilling_date IS ? AND status IN (${VIGENTES_SQL})`,
      args: [item.after, item.policyId, item.before],
    });
    stmts.push({ sql: GUARD_SQL });
  }
  await client.batch(stmts, "write");

  const after = await planNextRebillingDateBackfill(client, today);
  return { applied: plan.eligible.length, items: plan.eligible, remainingAfter: after.eligible.length };
}

export interface NextRebillingBackfillPreconditions {
  confirm: string | undefined;
  systemPaused: string | undefined;
  expectedCount: string | undefined;
  expectedFingerprint: string | undefined;
  backup: { path: string | undefined; sizeBytes: number | null; modifiedAtMs: number | null };
  nowMs: number;
}

/** Guardas previas a cualquier aplicación real. Devuelve la lista de faltantes (vacía = OK). */
export function checkNextRebillingBackfillPreconditions(p: NextRebillingBackfillPreconditions): string[] {
  const problems: string[] = [];
  if (p.confirm !== "1") problems.push("Falta CONFIRM_NEXT_REBILLING_BACKFILL=1.");
  if (p.systemPaused !== "1") problems.push("Falta SYSTEM_PAUSED_CONFIRMED=1 (el sistema debe estar pausado durante la aplicación).");
  if (!p.expectedCount || !/^[1-9]\d*$/.test(p.expectedCount)) problems.push("Falta EXPECTED_COUNT (entero positivo: la cantidad del dry-run nuevo y autorizado).");
  if (!p.expectedFingerprint || !/^[0-9a-f]{64}$/.test(p.expectedFingerprint)) problems.push("Falta EXPECTED_FINGERPRINT (sha256 del dry-run aprobado).");
  if (!p.backup.path) problems.push("Falta BACKUP_FILE (backup completo previo).");
  else if (p.backup.sizeBytes == null || p.backup.modifiedAtMs == null) problems.push(`No existe el backup ${p.backup.path}.`);
  else {
    if (p.backup.sizeBytes <= 0) problems.push("El backup está vacío.");
    const ageMs = p.nowMs - p.backup.modifiedAtMs;
    if (ageMs < 0 || ageMs > 6 * 3600 * 1000) problems.push("El backup debe tener menos de 6 horas.");
  }
  return problems;
}
