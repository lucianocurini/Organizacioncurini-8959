// Ejecutor de la migración 0037 (contado por período en lote mixto) en UNA
// sola transacción de escritura (client.transaction("write")). Envuelve el
// trabajo puro applyMigration0037CashPeriodPaymentChildrenWork, que no emite
// BEGIN/COMMIT/ROLLBACK propios: si cualquier validación falla antes del
// COMMIT, se revierte TODO (columna, índice y vínculos) gracias al DDL
// transaccional de SQLite.
//
// Dos modos (desde packages/web, siempre con `bun --no-env-file` para que
// ningún .env complete DATABASE_URL/DATABASE_AUTH_TOKEN sin querer):
//
//   --commit   Aplica y confirma. Es el único modo admitido contra la base
//              real (archivo o Turso).
//
//   (sin flag) ENSAYO: ejecuta la migración completa (ESCRIBE: ALTER, CREATE
//              INDEX, UPDATE) y después hace ROLLBACK. NO es una auditoría de
//              solo lectura: toma el lock de escritura y modifica el esquema
//              dentro de la transacción. Por eso SOLO se admite contra un
//              archivo SQLite existente dentro del directorio temporal del
//              sistema (nunca dev.db, nunca una URL remota). Para revisar la
//              base real antes de migrar, usar el auditor de solo lectura
//              (audit-0037-cash-period-payment-children.ts).
//
// Nunca imprime el token ni la URL completa. Salida: una línea
// "RESULT_JSON:{...}". Códigos de salida:
//   0  OK (committed, o ensayo revertido)
//   1  ABORTADO antes del COMMIT: no quedó nada escrito; corregir y reintentar
//   2  uso inválido / destino no permitido: no se conectó a la base
//   3  RESULTADO INCIERTO: falló el COMMIT (p. ej. se perdió la conexión al
//      confirmar). La transacción pudo haberse confirmado o no. Mantener la
//      pausa, NO reintentar automáticamente y NO avanzar de paso solo porque
//      el auditor diga "post": comparar con la auditoría inmediatamente
//      anterior (auditor --previous) y decidir manualmente.

import { createClient, type Client } from "@libsql/client";
import { existsSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { resolve, sep } from "path";
import {
  applyMigration0037CashPeriodPaymentChildrenWork,
  type Migration0037Summary,
  type Sql0037Client,
} from "./apply-0037-cash-period-payment-children";

export interface Run0037Result {
  mode: "dry-run" | "commit";
  outcome: "committed" | "rolled_back";
  summary: Migration0037Summary;
}

/** El COMMIT falló: no se sabe si la transacción quedó confirmada. */
export class Migration0037CommitUncertainError extends Error {
  constructor(public readonly summary: Migration0037Summary, public readonly cause: unknown) {
    super(
      `Resultado incierto: falló la confirmación (COMMIT) de la migración 0037 (${String((cause as any)?.message ?? cause)}). ` +
      `La transacción pudo haberse confirmado o no. Mantené la pausa de escrituras y no reintentes: corré el auditor con ` +
      `--previous <auditoría inmediatamente anterior> y decidí manualmente según la comparación (columna, índice y vínculos esperados).`
    );
  }
}

/**
 * Corre el trabajo de 0037 dentro de una transacción de escritura.
 * - Error antes del COMMIT → rollback y se relanza el error original (nada escrito).
 * - Error DURANTE el COMMIT → Migration0037CommitUncertainError (estado desconocido).
 */
export async function runMigration0037InTransaction(client: Client, options: { commit: boolean }): Promise<Run0037Result> {
  const tx = await client.transaction("write");
  let summary: Migration0037Summary;
  try {
    const adapter: Sql0037Client = {
      async execute(sql: string, params: any[] = []) {
        const rs = await tx.execute({ sql, args: params });
        return { rows: rs.rows as any[] };
      },
    };
    summary = await applyMigration0037CashPeriodPaymentChildrenWork(adapter);
  } catch (e) {
    // Todavía no se envió el COMMIT: si el rollback también falla (conexión
    // caída), el servidor descarta la transacción abierta. Nada quedó escrito.
    try { await tx.rollback(); } catch { /* ya cerrada o conexión perdida */ }
    tx.close();
    throw e;
  }

  if (!options.commit) {
    try { await tx.rollback(); } finally { tx.close(); }
    return { mode: "dry-run", outcome: "rolled_back", summary };
  }

  try {
    await tx.commit();
  } catch (e) {
    tx.close();
    throw new Migration0037CommitUncertainError(summary, e);
  }
  tx.close();
  return { mode: "commit", outcome: "committed", summary };
}

export function describeDatabaseTarget(url: string): string {
  if (url.startsWith("file:")) return `archivo ${url.replace(/^file:/, "").split(/[\\/]/).pop()}`;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(url no reconocida)";
  }
}

/**
 * El ensayo (sin --commit) escribe y revierte: solo se admite contra un
 * archivo SQLite que ya exista dentro del directorio temporal del sistema.
 * Devuelve null si está permitido, o el motivo del rechazo.
 */
export function dryRunTargetRejection(url: string, tempRoot: string = tmpdir()): string | null {
  if (!url.startsWith("file:")) {
    return "El ensayo escribe y luego revierte: solo se admite contra un SQLite temporal (file:), nunca contra una base remota. " +
      "Para revisar la base real usá el auditor de solo lectura.";
  }
  const raw = url.slice("file:".length);
  if (/dev\.db$/i.test(raw)) return "El ensayo nunca se ejecuta contra dev.db.";
  const abs = resolve(raw);
  if (!existsSync(abs)) return "El archivo del ensayo no existe (el ensayo nunca crea una base nueva).";
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const real = norm(realpathSync(abs));
  const root = norm(realpathSync(resolve(tempRoot)));
  if (!real.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return "El ensayo solo se admite contra un archivo dentro del directorio temporal del sistema.";
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--commit");
  if (unknown.length > 0) {
    console.error(`Uso: bun run-0037-cash-period-payment-children.ts [--commit]. Argumento(s) no reconocido(s): ${unknown.join(" ")}`);
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Falta DATABASE_URL.");
    process.exit(2);
  }
  const commit = args.includes("--commit");
  // libsql crea el archivo si no existe: nunca se migra una ruta equivocada.
  if (url.startsWith("file:") && !existsSync(resolve(url.slice("file:".length)))) {
    console.log(`RESULT_JSON:${JSON.stringify({ mode: commit ? "commit" : "dry-run", outcome: "refused", error: "El archivo de DATABASE_URL no existe." })}`);
    process.exit(2);
  }
  if (!commit) {
    const rejection = dryRunTargetRejection(url);
    if (rejection) {
      console.log(`RESULT_JSON:${JSON.stringify({ mode: "dry-run", outcome: "refused", error: rejection })}`);
      process.exit(2);
    }
  }
  console.log(`Migración 0037 — destino: ${describeDatabaseTarget(url)} — modo: ${commit ? "COMMIT" : "ensayo (escribe y revierte)"}`);
  const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  let code = 0;
  try {
    const result = await runMigration0037InTransaction(client, { commit });
    console.log(`RESULT_JSON:${JSON.stringify(result)}`);
  } catch (e: any) {
    if (e instanceof Migration0037CommitUncertainError) {
      console.log(`RESULT_JSON:${JSON.stringify({ mode: "commit", outcome: "uncertain", error: e.message, summaryBeforeCommit: e.summary })}`);
      code = 3;
    } else {
      console.log(`RESULT_JSON:${JSON.stringify({ mode: commit ? "commit" : "dry-run", outcome: "aborted", error: String(e?.message ?? e) })}`);
      code = 1;
    }
  } finally {
    client.close();
  }
  process.exit(code);
}

if (import.meta.main) await main();
