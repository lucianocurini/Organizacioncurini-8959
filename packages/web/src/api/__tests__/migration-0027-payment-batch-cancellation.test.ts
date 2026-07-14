/**
 * Prueba el aplicador idempotente de la migración 0027 (columnas de
 * trazabilidad de anulación en payment_batches + status/voided_at en
 * cash_entries). Puramente aditivo (ALTER TABLE ADD COLUMN, sin rebuild) —
 * mismo patrón que migration-0020-policy-cancellation.test.ts. Se arma una
 * base temporal mínima a mano en el scratchpad del sistema — se borra al
 * finalizar. No toca dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0027PaymentBatchCancellation,
  type Sql0027Client,
} from "../../lib/migrations/apply-0027-payment-batch-cancellation";

function wrapBunSqlite(db: Database): Sql0027Client {
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

function makePreMigrationDb(): Sql0027Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0027-payment-batch-cancellation-test-"));
  const dbPath = join(tmpDir, "pre-0027.db");
  db = new Database(dbPath);
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  db.run(`
    CREATE TABLE payment_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      insured_id INTEGER,
      base_amount_cents INTEGER NOT NULL,
      surcharge_amount_cents INTEGER NOT NULL DEFAULT 0,
      total_received_cents INTEGER NOT NULL,
      payment_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmado',
      notes TEXT,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE cash_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT NOT NULL,
      policy_number TEXT,
      company_name TEXT,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      due_date TEXT,
      notes TEXT,
      rendered INTEGER NOT NULL DEFAULT 0,
      rendered_at INTEGER,
      created_by INTEGER,
      created_at INTEGER,
      entry_type TEXT NOT NULL DEFAULT 'normal',
      payment_id INTEGER
    )
  `);
  return wrapBunSqlite(db);
}

function insertBatch(): number {
  db!.run(
    `INSERT INTO payment_batches (base_amount_cents, total_received_cents, payment_date, created_at, updated_at)
     VALUES (100000, 100000, '2027-06-01', 1000, 1000)`
  );
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

function insertCashEntry(): number {
  db!.run(
    `INSERT INTO cash_entries (client_name, amount, payment_method, payment_date, created_at)
     VALUES ('Juan Pérez', 800, 'lote', '2027-06-01', 1000)`
  );
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

describe("0027 — columnas de anulación en payment_batches + status en cash_entries", () => {
  test("primera corrida agrega las 3 columnas de payment_batches y las 2 de cash_entries, sin backfill", async () => {
    const client = makePreMigrationDb();
    const batchId = insertBatch();
    const entryId = insertCashEntry();

    const summary = await applyMigration0027PaymentBatchCancellation(client);

    expect(summary.alreadyApplied).toBe(false);
    expect(summary.paymentBatchesColumnsAdded).toEqual(["cancelled_at", "cancelled_by", "cancellation_reason"]);
    expect(summary.cashEntriesColumnsAdded).toEqual(["status", "voided_at"]);
    expect(summary.paymentBatchesBefore).toBe(1);
    expect(summary.paymentBatchesAfter).toBe(1);
    expect(summary.cashEntriesBefore).toBe(1);
    expect(summary.cashEntriesAfter).toBe(1);
    expect(summary.nonActiveCashEntriesAfter).toBe(0);

    const batchCols = (await client.execute("PRAGMA table_info(payment_batches)")).rows.map((r: any) => r.name);
    for (const c of ["cancelled_at", "cancelled_by", "cancellation_reason"]) expect(batchCols).toContain(c);
    const cashCols = (await client.execute("PRAGMA table_info(cash_entries)")).rows.map((r: any) => r.name);
    for (const c of ["status", "voided_at"]) expect(cashCols).toContain(c);

    const batchRow = db!.query("SELECT cancelled_at, cancelled_by, cancellation_reason FROM payment_batches WHERE id = ?").get(batchId) as any;
    expect(batchRow.cancelled_at).toBeNull();
    expect(batchRow.cancelled_by).toBeNull();
    expect(batchRow.cancellation_reason).toBeNull();

    const entryRow = db!.query("SELECT status, voided_at FROM cash_entries WHERE id = ?").get(entryId) as any;
    expect(entryRow.status).toBe("activo");
    expect(entryRow.voided_at).toBeNull();
  });

  test("los índices quedan creados", async () => {
    const client = makePreMigrationDb();
    await applyMigration0027PaymentBatchCancellation(client);
    const idx = (await client.execute("SELECT name FROM sqlite_master WHERE type='index'")).rows.map((r: any) => r.name);
    expect(idx).toContain("idx_payment_batches_cancelled_by");
    expect(idx).toContain("idx_cash_entries_status");
  });

  test("segunda corrida es idempotente — no duplica columnas ni falla, no toca filas ya anuladas", async () => {
    const client = makePreMigrationDb();
    const batchId = insertBatch();

    const first = await applyMigration0027PaymentBatchCancellation(client);
    expect(first.alreadyApplied).toBe(false);

    // Simula una anulación real ya cargada entre las dos corridas.
    db!.run("UPDATE payment_batches SET status = 'anulado', cancelled_at = 5000, cancellation_reason = 'error de carga' WHERE id = ?", [batchId]);

    const second = await applyMigration0027PaymentBatchCancellation(client);
    expect(second.alreadyApplied).toBe(true);
    expect(second.paymentBatchesColumnsAdded).toEqual([]);
    expect(second.cashEntriesColumnsAdded).toEqual([]);

    const row = db!.query("SELECT status, cancelled_at, cancellation_reason FROM payment_batches WHERE id = ?").get(batchId) as any;
    expect(row.status).toBe("anulado");
    expect(row.cancelled_at).toBe(5000);
    expect(row.cancellation_reason).toBe("error de carga");
  });
});
