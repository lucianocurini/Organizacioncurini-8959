/**
 * Prueba la migración 0018 (policies.next_rebilling_date) contra una copia
 * de un esquema PRE-0018 real (backup local), no contra dev.db ya migrado.
 * Usa la misma función que corre en producción: applyMigration0018.
 * No toca dev.db ni Turso — opera sobre un archivo temporal en el scratchpad
 * del sistema, que se borra al finalizar.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0018,
  type Sql0018Client,
} from "../../lib/migrations/apply-0018-next-rebilling-date";

const BACKUP_SOURCE = join(import.meta.dir, "..", "..", "..", "dev.db.backup-before-stage3-tests");

function wrapBunSqlite(db: Database): Sql0018Client {
  return {
    async execute(sql: string) {
      return { rows: db.query(sql).all() };
    },
  };
}

describe("Migración 0018 — contra copia de esquema pre-0018", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;
  let policyId: number;

  beforeAll(() => {
    if (!existsSync(BACKUP_SOURCE)) {
      throw new Error(`No se encontró el backup pre-0018 esperado en ${BACKUP_SOURCE}`);
    }
    tmpDir = mkdtempSync(join(tmpdir(), "migration-0018-test-"));
    dbPath = join(tmpDir, "pre-0018-copy.db");
    copyFileSync(BACKUP_SOURCE, dbPath);
    db = new Database(dbPath);

    // Confirmar de entrada que la copia realmente no tiene next_rebilling_date todavía.
    const cols = db.query("PRAGMA table_info(policies)").all() as any[];
    if (cols.some((c) => c.name === "next_rebilling_date")) {
      throw new Error("El backup usado ya tiene next_rebilling_date — no sirve como fixture pre-0018.");
    }

    // Póliza existente para Caso D (debe sobrevivir intacta a la migración, con NULL).
    const co = db.query(
      "INSERT INTO companies (name) VALUES ('TEST-MIG-0018 Co') RETURNING id"
    ).get() as any;
    const ins = db.query(
      "INSERT INTO insureds (name) VALUES ('TEST-MIG-0018 Asegurado') RETURNING id"
    ).get() as any;
    const pol = db.query(
      `INSERT INTO policies (policy_number, type, status, company_id, insured_id, start_date, end_date, is_rebilling)
       VALUES ('TEST-MIG-0018-POL', 'automotor', 'activa', ?, ?, '2027-01-01', '2027-12-31', 0) RETURNING id`
    ).get(co.id, ins.id) as any;
    policyId = pol.id;
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Caso A — esquema anterior ────────────────────────────────────────────

  test("Caso A: primera ejecución agrega la columna, conserva filas existentes", async () => {
    const before = db.query("SELECT COUNT(*) as c FROM policies").get() as any;

    const summary = await applyMigration0018(wrapBunSqlite(db));

    expect(summary.alreadyApplied).toBe(false);
    expect(summary.columnAdded).toBe(true);
    expect(summary.policiesBefore).toBe(before.c);
    expect(summary.policiesAfter).toBe(before.c);
    expect(summary.populatedAfter).toBe(0);
    expect(summary.columnType).toBe("TEXT");
    expect(summary.columnNullable).toBe(true);

    const cols = db.query("PRAGMA table_info(policies)").all() as any[];
    expect(cols.some((c) => c.name === "next_rebilling_date")).toBe(true);
  });

  // ── Caso D — datos existentes preservados, valor histórico en null ───────

  test("Caso D: la póliza preexistente conserva sus campos y next_rebilling_date queda null", () => {
    const row = db.query("SELECT * FROM policies WHERE id = ?").get(policyId) as any;
    expect(row).toBeDefined();
    expect(row.next_rebilling_date).toBeNull();
    expect(row.start_date).toBe("2027-01-01");
    expect(row.end_date).toBe("2027-12-31");
    expect(row.policy_number).toBe("TEST-MIG-0018-POL");
  });

  // ── Caso B — segunda ejecución ────────────────────────────────────────────

  test("Caso B: segunda ejecución no falla, no duplica la columna, devuelve already_applied", async () => {
    const summary = await applyMigration0018(wrapBunSqlite(db));

    expect(summary.alreadyApplied).toBe(true);
    expect(summary.columnAdded).toBe(false);

    const cols = (db.query("PRAGMA table_info(policies)").all() as any[])
      .filter((c) => c.name === "next_rebilling_date");
    expect(cols.length).toBe(1); // sin duplicar

    const row = db.query("SELECT * FROM policies WHERE id = ?").get(policyId) as any;
    expect(row.next_rebilling_date).toBeNull();
    expect(row.start_date).toBe("2027-01-01");
  });

  // ── Escritura manual tras la migración ────────────────────────────────────

  test("se puede escribir y leer una fecha manual sin afectar el resto de la fila", () => {
    db.run("UPDATE policies SET next_rebilling_date = '2026-07-15' WHERE id = ?", [policyId]);
    const row = db.query("SELECT * FROM policies WHERE id = ?").get(policyId) as any;
    expect(row.next_rebilling_date).toBe("2026-07-15");
    expect(row.start_date).toBe("2027-01-01");
    expect(row.end_date).toBe("2027-12-31");
  });
});
