/**
 * Prueba la migración 0017 (policy_installments.rebilling_id) contra una copia
 * de un esquema PRE-0017 real (backup local), no contra dev.db ya migrado.
 * Usa la misma función que corre en producción: applyMigration0017.
 * No toca dev.db ni Turso — opera sobre un archivo temporal en el scratchpad
 * del sistema, que se borra al finalizar.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0017,
  type Sql0017Client,
} from "../../lib/migrations/apply-0017-installments-rebilling-id";

const BACKUP_SOURCE = join(import.meta.dir, "..", "..", "..", "dev.db.backup-before-stage3-tests");

function wrapBunSqlite(db: Database): Sql0017Client {
  return {
    async execute(sql: string) {
      return { rows: db.query(sql).all() };
    },
  };
}

describe("Migración 0017 — contra copia de esquema pre-0017", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;
  let policyId: number;
  let installmentId: number;

  beforeAll(() => {
    if (!existsSync(BACKUP_SOURCE)) {
      throw new Error(`No se encontró el backup pre-0017 esperado en ${BACKUP_SOURCE}`);
    }
    tmpDir = mkdtempSync(join(tmpdir(), "migration-0017-test-"));
    dbPath = join(tmpDir, "pre-0017-copy.db");
    copyFileSync(BACKUP_SOURCE, dbPath);
    db = new Database(dbPath);

    // Confirmar de entrada que la copia realmente no tiene rebilling_id todavía.
    const cols = db.query("PRAGMA table_info(policy_installments)").all() as any[];
    if (cols.some((c) => c.name === "rebilling_id")) {
      throw new Error("El backup usado ya tiene rebilling_id — no sirve como fixture pre-0017.");
    }

    // Datos existentes para Caso D (deben sobrevivir intactos a la migración).
    const co = db.query(
      "INSERT INTO companies (name) VALUES ('TEST-MIG-0017 Co') RETURNING id"
    ).get() as any;
    const ins = db.query(
      "INSERT INTO insureds (name) VALUES ('TEST-MIG-0017 Asegurado') RETURNING id"
    ).get() as any;
    const pol = db.query(
      `INSERT INTO policies (policy_number, type, status, company_id, insured_id, start_date, end_date, is_rebilling)
       VALUES ('TEST-MIG-0017-POL', 'automotor', 'activa', ?, ?, '2027-01-01', '2027-12-31', 0) RETURNING id`
    ).get(co.id, ins.id) as any;
    policyId = pol.id;
    const inst = db.query(
      `INSERT INTO policy_installments (policy_id, number, due_date, amount, status, rendered)
       VALUES (?, 1, '2027-02-01', 1234.5, 'pendiente', 0) RETURNING id`
    ).get(policyId) as any;
    installmentId = inst.id;
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Caso A — esquema anterior ────────────────────────────────────────────

  test("Caso A: primera ejecución agrega columna e índice, conserva filas existentes", async () => {
    const before = db.query("SELECT COUNT(*) as c FROM policy_installments").get() as any;

    const summary = await applyMigration0017(wrapBunSqlite(db));

    expect(summary.alreadyApplied).toBe(false);
    expect(summary.columnAdded).toBe(true);
    expect(summary.indexCreated).toBe(true);
    expect(summary.installmentsBefore).toBe(before.c);
    expect(summary.installmentsAfter).toBe(before.c);
    expect(summary.linkedInstallments).toBe(0);
    expect(summary.columnType).toBe("INTEGER");
    expect(summary.columnNullable).toBe(true);

    const cols = db.query("PRAGMA table_info(policy_installments)").all() as any[];
    expect(cols.some((c) => c.name === "rebilling_id")).toBe(true);
    const idx = db.query("PRAGMA index_list(policy_installments)").all() as any[];
    expect(idx.some((i) => i.name === "idx_policy_installments_rebilling_id")).toBe(true);
  });

  // ── Caso D — datos existentes preservados ────────────────────────────────

  test("Caso D: la cuota preexistente conserva todos sus campos y rebilling_id queda null", () => {
    const row = db.query("SELECT * FROM policy_installments WHERE id = ?").get(installmentId) as any;
    expect(row).toBeDefined();
    expect(row.rebilling_id).toBeNull();
    expect(row.due_date).toBe("2027-02-01");
    expect(row.amount).toBe(1234.5);
    expect(row.status).toBe("pendiente");
    expect(row.rendered).toBe(0);
    expect(row.policy_id).toBe(policyId);
  });

  // ── Caso B — segunda ejecución ────────────────────────────────────────────

  test("Caso B: segunda ejecución no falla, no duplica índice, devuelve already_applied", async () => {
    const idxBefore = (db.query("PRAGMA index_list(policy_installments)").all() as any[])
      .filter((i) => i.name === "idx_policy_installments_rebilling_id");
    expect(idxBefore.length).toBe(1);

    const summary = await applyMigration0017(wrapBunSqlite(db));

    expect(summary.alreadyApplied).toBe(true);
    expect(summary.columnAdded).toBe(false);
    expect(summary.indexCreated).toBe(false);

    const idxAfter = (db.query("PRAGMA index_list(policy_installments)").all() as any[])
      .filter((i) => i.name === "idx_policy_installments_rebilling_id");
    expect(idxAfter.length).toBe(1); // sin duplicar

    // La cuota preexistente sigue intacta.
    const row = db.query("SELECT * FROM policy_installments WHERE id = ?").get(installmentId) as any;
    expect(row.due_date).toBe("2027-02-01");
    expect(row.rebilling_id).toBeNull();
  });

  // ── Caso C — columna existe, índice falta ────────────────────────────────

  test("Caso C: si falta solo el índice, la migración crea únicamente el índice", async () => {
    db.run("DROP INDEX idx_policy_installments_rebilling_id");
    const idxGone = (db.query("PRAGMA index_list(policy_installments)").all() as any[])
      .filter((i) => i.name === "idx_policy_installments_rebilling_id");
    expect(idxGone.length).toBe(0);

    const summary = await applyMigration0017(wrapBunSqlite(db));

    expect(summary.alreadyApplied).toBe(false);
    expect(summary.columnAdded).toBe(false); // la columna ya existía, no se toca
    expect(summary.indexCreated).toBe(true);

    const idxAfter = (db.query("PRAGMA index_list(policy_installments)").all() as any[])
      .filter((i) => i.name === "idx_policy_installments_rebilling_id");
    expect(idxAfter.length).toBe(1);
  });
});
