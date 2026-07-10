/**
 * Prueba el aplicador idempotente de la migración 0025 (rebillings:
 * installment_count, first_due_date, deductible). Se arma una base temporal
 * mínima a mano (solo rebillings, tal como existía antes de esta migración)
 * en el scratchpad del sistema — se borra al finalizar. No toca dev.db ni
 * Turso. Mismo patrón que migration-0020-policy-cancellation.test.ts.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyMigration0025RebillingInstallmentPlan, type Sql0025Client } from "../../lib/migrations/apply-0025-rebilling-installment-plan";

function wrapBunSqlite(db: Database): Sql0025Client {
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

function makePreMigrationDb(): Sql0025Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0025-rebilling-installment-plan-test-"));
  const dbPath = join(tmpDir, "pre-0025.db");
  db = new Database(dbPath);
  db.run(`
    CREATE TABLE rebillings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL,
      billing_start TEXT NOT NULL,
      billing_end TEXT NOT NULL,
      premium REAL,
      monthly_fee REAL,
      sum_insured REAL,
      notes TEXT,
      created_at INTEGER
    )
  `);
  return wrapBunSqlite(db);
}

function insertRebilling(billingStart: string, billingEnd: string) {
  db!.run(
    "INSERT INTO rebillings (policy_id, billing_start, billing_end) VALUES (1, ?, ?)",
    [billingStart, billingEnd]
  );
}

describe("0025 — agrega columnas de plan de cuotas a rebillings", () => {
  test("primera corrida agrega las 3 columnas, sin backfill", async () => {
    const client = makePreMigrationDb();
    insertRebilling("2027-01-01", "2027-01-31");
    insertRebilling("2027-02-01", "2027-02-28");

    const summary = await applyMigration0025RebillingInstallmentPlan(client);

    expect(summary.alreadyApplied).toBe(false);
    expect(summary.columnsAdded).toEqual(["installment_count", "first_due_date", "deductible"]);
    expect(summary.rebillingsBefore).toBe(2);
    expect(summary.rebillingsAfter).toBe(2); // sin backfill, ninguna fila se pierde ni se duplica

    const cols = await client.execute("PRAGMA table_info(rebillings)");
    const names = (cols.rows as any[]).map((c) => c.name);
    for (const expected of ["installment_count", "first_due_date", "deductible"]) {
      expect(names).toContain(expected);
    }
  });

  test("refacturaciones existentes quedan con las 3 columnas nuevas en NULL", async () => {
    const client = makePreMigrationDb();
    insertRebilling("2027-01-01", "2027-01-31");

    await applyMigration0025RebillingInstallmentPlan(client);

    const rows = db!.query("SELECT installment_count, first_due_date, deductible FROM rebillings").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].installment_count).toBeNull();
    expect(rows[0].first_due_date).toBeNull();
    expect(rows[0].deductible).toBeNull();
  });

  test("segunda corrida es idempotente — no duplica columnas ni falla", async () => {
    const client = makePreMigrationDb();
    insertRebilling("2027-01-01", "2027-01-31");

    const first = await applyMigration0025RebillingInstallmentPlan(client);
    expect(first.alreadyApplied).toBe(false);
    expect(first.columnsAdded.length).toBe(3);

    const second = await applyMigration0025RebillingInstallmentPlan(client);
    expect(second.alreadyApplied).toBe(true);
    expect(second.columnsAdded).toEqual([]);
    expect(second.rebillingsAfter).toBe(1);
  });

  test("segunda corrida no introduce backfill sobre filas ya completadas a mano", async () => {
    const client = makePreMigrationDb();
    insertRebilling("2027-01-01", "2027-01-31");
    await applyMigration0025RebillingInstallmentPlan(client);

    db!.run("UPDATE rebillings SET installment_count = 3, first_due_date = '2027-01-05', deductible = 50000 WHERE id = 1");

    const second = await applyMigration0025RebillingInstallmentPlan(client);
    expect(second.alreadyApplied).toBe(true);
    const row = db!.query("SELECT installment_count, first_due_date, deductible FROM rebillings WHERE id = 1").get() as any;
    expect(row.installment_count).toBe(3);
    expect(row.first_due_date).toBe("2027-01-05");
    expect(row.deductible).toBe(50000);
  });
});
