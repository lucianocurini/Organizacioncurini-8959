// Auditoría de SOLO LECTURA para la migración 0037 (contado por período en
// lote mixto). Ejecuta únicamente las consultas SELECT fijas de abajo — sin
// transacción, sin DDL, sin UPDATE — así que puede correrse contra la base
// real antes de migrar, después de migrar, después del deploy y, sobre todo,
// si el ejecutor informó "resultado incierto" (exit 3) para saber si el
// COMMIT llegó a aplicarse.
//
// Uso (desde packages/web, siempre con --no-env-file):
//   bun --no-env-file src/lib/migrations/audit-0037-cash-period-payment-children.ts [--out <archivo.json>] [--previous <archivo.json>]
//   (DATABASE_URL y DATABASE_AUTH_TOKEN en el entorno del proceso)
//
// Detecta si payments.cash_period_payment_id existe y corre el juego "pre"
// (antes de migrar) o "post" (ya migrada; exige además el índice). --out
// guarda el resultado para compararlo después. --previous <auditoría
// inmediatamente anterior> evalúa el estado tras un exit 3 del ejecutor
// (resultado incierto): no_aplicada / coincide_con_aplicada /
// compatible_sin_confirmar / discrepancia. "post" por sí solo nunca alcanza
// para avanzar de paso, y ningún veredicto autoriza reintentar ni levantar la
// pausa: eso es una decisión manual.
//
// Nunca imprime el token ni la URL completa. Salida: una línea
// "RESULT_JSON:{...}". Exit 0 = sin alertas (o veredicto distinto de
// discrepancia), 1 = alertas o discrepancia, 2 = uso inválido, 4 = error de
// conexión/consulta.

import { createClient, type Client } from "@libsql/client";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { describeDatabaseTarget } from "./run-0037-cash-period-payment-children";

export interface AuditQuery {
  key: string;
  description: string;
  sql: string;
  /** Si se indica, el valor esperado; cualquier otro valor es una alerta. */
  expect?: number;
}

// Consultas comunes (no dependen de la columna nueva).
export const AUDIT_0037_COMMON: readonly AuditQuery[] = [
  { key: "columna_existe", description: "payments.cash_period_payment_id existe (1) o no (0)",
    sql: "SELECT COUNT(*) AS c FROM pragma_table_info('payments') WHERE name = 'cash_period_payment_id'" },
  { key: "indice_existe", description: "índice idx_payments_cash_period_payment_id existe (1) o no (0)",
    sql: "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND name = 'idx_payments_cash_period_payment_id'" },
  { key: "contados_total", description: "filas en cash_period_payments",
    sql: "SELECT COUNT(*) AS c FROM cash_period_payments" },
  { key: "contados_confirmados_sin_rendir", description: "contados confirmados pendientes de rendir",
    sql: "SELECT COUNT(*) AS c FROM cash_period_payments WHERE status = 'confirmado' AND rendered = 0" },
  { key: "hijos_de_lotes_con_contado", description: "pagos hijos de lotes que tienen contado",
    sql: "SELECT COUNT(*) AS c FROM payments WHERE batch_id IN (SELECT payment_batch_id FROM cash_period_payments)" },
  { key: "payments_total", description: "filas en payments (debe ser igual antes y después de migrar)",
    sql: "SELECT COUNT(*) AS c FROM payments" },
];

// Antes de migrar: no referencia la columna nueva.
export const AUDIT_0037_PRE: readonly AuditQuery[] = [
  { key: "hijos_inconsistentes", expect: 0,
    description: "hijos de un contado que no son cuota de su póliza/refacturación (o sin cuota) — la migración abortaría",
    sql: `SELECT COUNT(*) AS c FROM payments p
      INNER JOIN cash_period_payments cpp ON cpp.payment_batch_id = p.batch_id
      LEFT JOIN policy_installments pi ON pi.id = p.installment_id
      WHERE p.installment_id IS NULL OR pi.id IS NULL
        OR p.policy_id IS NOT cpp.policy_id OR pi.policy_id IS NOT cpp.policy_id OR pi.rebilling_id IS NOT cpp.rebilling_id` },
  { key: "vinculos_a_crear", description: "vínculos que creará la primera ejecución (= hijos_de_lotes_con_contado si no hay inconsistencias)",
    sql: "SELECT COUNT(*) AS c FROM payments WHERE batch_id IN (SELECT payment_batch_id FROM cash_period_payments)" },
];

// Ya migrada: valida índice y vínculos.
export const AUDIT_0037_POST: readonly AuditQuery[] = [
  { key: "indice_presente", expect: 1,
    description: "con la columna creada, el índice idx_payments_cash_period_payment_id debe existir",
    sql: "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND name = 'idx_payments_cash_period_payment_id'" },
  { key: "hijos_vinculados", description: "pagos vinculados a un contado",
    sql: "SELECT COUNT(*) AS c FROM payments WHERE cash_period_payment_id IS NOT NULL" },
  { key: "vinculos_pendientes",
    description: "cuotas de contados todavía sin vincular que la próxima ejecución vincularía (0 si no hay nada pendiente)",
    sql: `SELECT COUNT(*) AS c FROM payments p
      INNER JOIN cash_period_payments cpp ON cpp.payment_batch_id = p.batch_id
      WHERE p.cash_period_payment_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.cash_period_payment_id = cpp.id)` },
  { key: "contados_sin_vinculo", expect: 0,
    description: "contados con hijos pero sin ningún hijo vinculado (registrados con la versión anterior después de migrar: re-ejecutar 0037)",
    sql: `SELECT COUNT(*) AS c FROM cash_period_payments cpp
      WHERE EXISTS (SELECT 1 FROM payments p WHERE p.batch_id = cpp.payment_batch_id)
        AND NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.cash_period_payment_id = cpp.id)` },
  { key: "vinculos_periodo_incorrecto", expect: 0,
    description: "pagos vinculados cuya cuota no es de la póliza/refacturación del contado",
    sql: `SELECT COUNT(*) AS c FROM payments p
      INNER JOIN cash_period_payments cpp ON cpp.id = p.cash_period_payment_id
      LEFT JOIN policy_installments pi ON pi.id = p.installment_id
      WHERE p.installment_id IS NULL OR pi.id IS NULL
        OR p.policy_id IS NOT cpp.policy_id OR pi.policy_id IS NOT cpp.policy_id OR pi.rebilling_id IS NOT cpp.rebilling_id` },
  { key: "vinculos_otro_lote", expect: 0, description: "pagos vinculados a un contado de otro lote",
    sql: `SELECT COUNT(*) AS c FROM payments p INNER JOIN cash_period_payments cpp ON cpp.id = p.cash_period_payment_id
      WHERE p.batch_id IS NOT cpp.payment_batch_id` },
  { key: "lotes_mixtos", description: "lotes con contado y además cuotas comunes (esperado 0 hasta el primer lote mixto real)",
    sql: `SELECT COUNT(DISTINCT cpp.payment_batch_id) AS c FROM cash_period_payments cpp
      WHERE EXISTS (SELECT 1 FROM payments lp WHERE lp.cash_period_payment_id = cpp.id)
        AND EXISTS (SELECT 1 FROM payments p WHERE p.batch_id = cpp.payment_batch_id AND p.cash_period_payment_id IS NULL)` },
  { key: "hijos_inconsistentes_pendientes", expect: 0,
    description: "en contados todavía sin vincular, hijos que no son cuota de su período — una re-ejecución abortaría",
    sql: `SELECT COUNT(*) AS c FROM payments p
      INNER JOIN cash_period_payments cpp ON cpp.payment_batch_id = p.batch_id
      LEFT JOIN policy_installments pi ON pi.id = p.installment_id
      WHERE p.cash_period_payment_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.cash_period_payment_id = cpp.id)
        AND (p.installment_id IS NULL OR pi.id IS NULL
          OR p.policy_id IS NOT cpp.policy_id OR pi.policy_id IS NOT cpp.policy_id OR pi.rebilling_id IS NOT cpp.rebilling_id)` },
];

export interface Audit0037Result {
  phase: "pre" | "post";
  values: Record<string, number>;
  alerts: Array<{ key: string; value: number; expected: number; description: string }>;
}

function assertReadOnly(q: AuditQuery): void {
  if (!/^\s*SELECT\b/i.test(q.sql) || /;\s*\S/.test(q.sql)) throw new Error(`Consulta de auditoría no permitida: ${q.key}`);
}

export async function runAudit0037(client: Client): Promise<Audit0037Result> {
  const values: Record<string, number> = {};
  const alerts: Audit0037Result["alerts"] = [];
  const run = async (queries: readonly AuditQuery[]) => {
    for (const q of queries) {
      assertReadOnly(q);
      const rs = await client.execute(q.sql);
      const value = Number((rs.rows[0] as any)?.c ?? 0);
      values[q.key] = value;
      if (q.expect !== undefined && value !== q.expect) alerts.push({ key: q.key, value, expected: q.expect, description: q.description });
    }
  };
  await run(AUDIT_0037_COMMON);
  const phase = values.columna_existe === 1 ? "post" : "pre";
  await run(phase === "post" ? AUDIT_0037_POST : AUDIT_0037_PRE);
  return { phase, values, alerts };
}

// ─── Después de un exit 3 del ejecutor (resultado incierto) ───────────────
//
// El auditor solo describe el estado actual; "post" NO alcanza para seguir.
// Se compara contra la auditoría INMEDIATAMENTE ANTERIOR a la ejecución
// incierta: columna, índice, vínculos esperados y cantidad de pagos. En
// todos los casos la recomendación es la misma: mantener la pausa de
// escrituras y no reintentar automáticamente — la decisión de seguir es
// manual.

export type UncertainCommitVerdict =
  | "no_aplicada"               // el estado es idéntico al anterior y había algo por aplicar
  | "coincide_con_aplicada"     // pasó al estado que la ejecución debía producir
  | "compatible_sin_confirmar"  // ya estaba migrada sin pendientes y quedó igual
  | "discrepancia";             // cualquier otra cosa: frenar y revisar

export interface UncertainCommitAssessment {
  verdict: UncertainCommitVerdict;
  message: string;
  expected: { columna: 1; indice: 1; vinculos: number; payments_total: number };
  actual: { columna: number; indice: number; vinculos: number; payments_total: number; alertas: number };
}

const KEEP_PAUSED = "Mantené la pausa de escrituras. No reintentes automáticamente: la decisión de continuar es manual.";

export function assessUncertainCommit(previous: Audit0037Result, current: Audit0037Result): UncertainCommitAssessment {
  const pv = previous.values, cv = current.values;
  const prevLinked = previous.phase === "post" ? (pv.hijos_vinculados ?? 0) : 0;
  const prevPending = previous.phase === "post" ? (pv.vinculos_pendientes ?? 0) : (pv.vinculos_a_crear ?? 0);
  const expectedLinked = prevLinked + prevPending;
  const actual = {
    columna: cv.columna_existe ?? 0,
    indice: cv.indice_existe ?? 0,
    vinculos: current.phase === "post" ? (cv.hijos_vinculados ?? 0) : 0,
    payments_total: cv.payments_total ?? 0,
    alertas: current.alerts.length,
  };
  const expected = { columna: 1 as const, indice: 1 as const, vinculos: expectedLinked, payments_total: pv.payments_total ?? 0 };
  const result = (verdict: UncertainCommitVerdict, message: string): UncertainCommitAssessment =>
    ({ verdict, message: `${message} ${KEEP_PAUSED}`, expected, actual });

  if (actual.payments_total !== expected.payments_total) {
    return result("discrepancia", `La cantidad de pagos cambió (${expected.payments_total} → ${actual.payments_total}): hubo escrituras durante la pausa o un problema mayor. Frená y revisá.`);
  }
  const sameAsBefore = current.phase === previous.phase
    && actual.columna === (pv.columna_existe ?? 0)
    && actual.indice === (pv.indice_existe ?? 0)
    && actual.vinculos === prevLinked
    && (current.phase === "post" ? (cv.vinculos_pendientes ?? 0) : (cv.vinculos_a_crear ?? 0)) === prevPending;
  // Alertas nuevas = las que no estaban, con el mismo valor, en la auditoría anterior.
  const newAlerts = current.alerts.filter((a) => !previous.alerts.some((p) => p.key === a.key && p.value === a.value));

  if (sameAsBefore && prevPending > 0 && newAlerts.length === 0) {
    return result("no_aplicada", `La base está igual que en la auditoría anterior y quedan ${prevPending} vínculo(s) por crear: la ejecución no se aplicó.`);
  }
  if (actual.alertas > 0) {
    return result("discrepancia", `La auditoría actual tiene ${actual.alertas} alerta(s). Frená y revisá antes de cualquier otro paso.`);
  }
  if (sameAsBefore && previous.phase === "post" && prevPending === 0) {
    return result("compatible_sin_confirmar",
      `La base ya estaba migrada (columna, índice y ${prevLinked} vínculo(s)) y quedó igual: el estado es compatible con lo esperado, pero no se pudo confirmar el resultado de esa ejecución.`);
  }
  if (current.phase === "post" && actual.columna === 1 && actual.indice === 1 && actual.vinculos === expectedLinked && (cv.vinculos_pendientes ?? 0) === 0) {
    return result("coincide_con_aplicada",
      `El estado coincide con el que la ejecución debía dejar (columna, índice y ${expectedLinked} vínculo(s)), pero no se pudo confirmar el resultado de esa ejecución.`);
  }
  return result("discrepancia",
    `El estado no coincide ni con el anterior ni con el esperado (columna ${actual.columna}/1, índice ${actual.indice}/1, vínculos ${actual.vinculos}/${expectedLinked}). Frená y revisá.`);
}

function parseArgs(argv: string[]): { out: string | null; previous: string | null } | null {
  let out: string | null = null, previous: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === "--out" || a === "--previous") && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      if (a === "--out") out = argv[++i]!; else previous = argv[++i]!;
    } else {
      return null;
    }
  }
  return { out, previous };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Uso: bun audit-0037-cash-period-payment-children.ts [--out <archivo.json>] [--previous <auditoría-anterior.json>]");
    process.exit(2);
  }
  let previous: Audit0037Result | null = null;
  if (args.previous) {
    try {
      previous = JSON.parse(readFileSync(args.previous, "utf8")) as Audit0037Result;
      if (!previous || (previous.phase !== "pre" && previous.phase !== "post") || typeof previous.values !== "object") throw new Error("formato");
    } catch {
      console.error("No se pudo leer la auditoría anterior (--previous).");
      process.exit(2);
    }
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Falta DATABASE_URL.");
    process.exit(2);
  }
  // libsql crea el archivo si no existe: con una ruta equivocada la
  // "auditoría" crearía una base vacía. Nunca se audita un archivo inexistente.
  if (url.startsWith("file:") && !existsSync(resolve(url.slice("file:".length)))) {
    console.error("El archivo de DATABASE_URL no existe.");
    process.exit(2);
  }
  console.log(`Auditoría 0037 (solo lectura) — destino: ${describeDatabaseTarget(url)}`);
  const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  let code = 0;
  try {
    const result = await runAudit0037(client);
    if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
    if (previous) {
      const assessment = assessUncertainCommit(previous, result);
      console.log(`RESULT_JSON:${JSON.stringify({ ...result, assessment })}`);
      console.log(`Evaluación tras resultado incierto: ${assessment.verdict} — ${assessment.message}`);
      code = assessment.verdict === "discrepancia" ? 1 : 0;
    } else {
      console.log(`RESULT_JSON:${JSON.stringify(result)}`);
      code = result.alerts.length > 0 ? 1 : 0;
    }
  } catch (e: any) {
    console.log(`RESULT_JSON:${JSON.stringify({ error: String(e?.message ?? e) })}`);
    code = 4;
  } finally {
    client.close();
  }
  process.exit(code);
}

if (import.meta.main) await main();
