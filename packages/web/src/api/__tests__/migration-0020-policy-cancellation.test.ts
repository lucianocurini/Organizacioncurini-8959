/**
 * Prueba el aplicador idempotente de la migración 0020 (anulación manual de
 * pólizas — cancelled_at, cancellation_effective_date, cancellation_reason,
 * cancellation_notes, cancelled_by, cancellation_source en policies). Se
 * arma una base temporal mínima a mano (solo policies, tal como existía
 * antes de esta migración) en el scratchpad del sistema — se borra al
 * finalizar. No toca dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyMigration0020PolicyCancellation, type Sql0020Client } from "../../lib/migrations/apply-0020-policy-cancellation";

function wrapBunSqlite(db: Database): Sql0020Client {
  return {
    async execute(sql: string) {
      return { rows: db.query(sql).all() };
    },
  };
}

let tmpDir: string | null = null;
let db: Database | null = null;

afterEach(async () => {
  db?.close();
  db = null;
  // Mismo problema de timing de Windows documentado en
  // migration-0022-received-checks.test.ts — reintenta en vez de fallar el
  // test por un problema de limpieza ajeno a la lógica de la migración.
  if (tmpDir) {
    const dir = tmpDir;
    tmpDir = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (attempt === 14) throw e;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

function makePreMigrationDb(): Sql0020Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0020-policy-cancellation-test-"));
  const dbPath = join(tmpDir, "pre-0020.db");
  db = new Database(dbPath);
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  db.run(`
    CREATE TABLE policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'activa',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at INTEGER
    )
  `);
  return wrapBunSqlite(db);
}

function insertPolicy(policyNumber: string, status: string) {
  db!.run(
    "INSERT INTO policies (policy_number, status, start_date, end_date) VALUES (?, ?, '2027-01-01', '2027-12-31')",
    [policyNumber, status]
  );
}

describe("0020 — agrega columnas de anulación manual a policies", () => {
  // 1. columnas nuevas
  test("1. sobre una base sin ninguna de las columnas, sin backfill", async () => {
    const client = makePreMigrationDb();
    insertPolicy("POL-1", "activa");
    insertPolicy("POL-2", "cancelada"); // ya cancelada por un importador antes de esta migración

    const summary = await applyMigration0020PolicyCancellation(client);

    expect(summary.alreadyApplied).toBe(false);
    expect(summary.columnsAdded).toEqual([
      "cancelled_at", "cancellation_effective_date", "cancellation_reason",
      "cancellation_notes", "cancelled_by", "cancellation_source",
    ]);
    expect(summary.policiesBefore).toBe(2);
    expect(summary.policiesAfter).toBe(2); // sin backfill, ninguna fila se pierde ni se duplica

    const cols = await client.execute("PRAGMA table_info(policies)");
    const names = (cols.rows as any[]).map((c) => c.name);
    for (const expected of [
      "cancelled_at", "cancellation_effective_date", "cancellation_reason",
      "cancellation_notes", "cancelled_by", "cancellation_source",
    ]) {
      expect(names).toContain(expected);
    }
  });

  // 4. pólizas existentes quedan con campos null
  test("4. pólizas existentes (activas o ya canceladas por importador) quedan con los campos nuevos en NULL", async () => {
    const client = makePreMigrationDb();
    insertPolicy("POL-1", "activa");
    insertPolicy("POL-2", "cancelada");

    await applyMigration0020PolicyCancellation(client);

    const rows = db!.query("SELECT cancelled_at, cancellation_effective_date, cancellation_reason, cancellation_notes, cancelled_by, cancellation_source FROM policies").all() as any[];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.cancelled_at).toBeNull();
      expect(row.cancellation_effective_date).toBeNull();
      expect(row.cancellation_reason).toBeNull();
      expect(row.cancellation_notes).toBeNull();
      expect(row.cancelled_by).toBeNull();
      expect(row.cancellation_source).toBeNull();
    }
  });

  // 2/3. idempotencia + cero backfill en la segunda corrida
  test("2. segunda corrida es idempotente — no duplica columnas ni falla", async () => {
    const client = makePreMigrationDb();
    insertPolicy("POL-1", "activa");

    const first = await applyMigration0020PolicyCancellation(client);
    expect(first.alreadyApplied).toBe(false);
    expect(first.columnsAdded.length).toBe(6);

    const second = await applyMigration0020PolicyCancellation(client);
    expect(second.alreadyApplied).toBe(true);
    expect(second.columnsAdded).toEqual([]);
    expect(second.policiesAfter).toBe(1);
  });

  test("3. segunda corrida no introduce backfill sobre filas ya pobladas manualmente", async () => {
    const client = makePreMigrationDb();
    insertPolicy("POL-1", "activa");
    await applyMigration0020PolicyCancellation(client);

    // Simula una anulación manual real ya cargada.
    db!.run("UPDATE policies SET cancelled_at = 12345, cancellation_source = 'manual' WHERE policy_number = 'POL-1'");

    const second = await applyMigration0020PolicyCancellation(client);
    expect(second.alreadyApplied).toBe(true);
    const row = db!.query("SELECT cancelled_at, cancellation_source FROM policies WHERE policy_number = 'POL-1'").get() as any;
    expect(row.cancelled_at).toBe(12345);
    expect(row.cancellation_source).toBe("manual");
  });

  test("índices quedan creados", async () => {
    const client = makePreMigrationDb();
    await applyMigration0020PolicyCancellation(client);
    const idx = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
    const names = (idx.rows as any[]).map((r) => r.name);
    expect(names).toContain("idx_policies_cancellation_effective_date");
    expect(names).toContain("idx_policies_cancelled_by");
  });
});
