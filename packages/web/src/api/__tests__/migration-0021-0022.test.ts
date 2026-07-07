/**
 * Prueba los aplicadores idempotentes de las migraciones 0021
 * (payment_batches + payments.batch_id) y 0022 (payment_batch_splits).
 * Sin backfill en ninguna de las dos — se arma una base temporal mínima a
 * mano (solo insureds/users/payments, tal como existían antes de esta
 * migración) en el scratchpad del sistema — se borra al finalizar. No toca
 * dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyMigration0021PaymentBatches, type Sql0021Client } from "../../lib/migrations/apply-0021-payment-batches";
import { applyMigration0022PaymentBatchSplits, type Sql0022Client } from "../../lib/migrations/apply-0022-payment-batch-splits";

function wrapBunSqlite(db: Database): Sql0021Client & Sql0022Client {
  return {
    async execute(sql: string, params: any[] = []) {
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
        return { rows: db.query(sql).all(...params) as any[] };
      }
      db.query(sql).run(...params);
      return { rows: [] };
    },
  };
}

let tmpDir: string | null = null;
let db: Database | null = null;

afterEach(() => {
  db?.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  db = null;
  tmpDir = null;
});

function makePreMigrationDb(): Sql0021Client & Sql0022Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0021-0022-test-"));
  const dbPath = join(tmpDir, "pre-0021.db");
  db = new Database(dbPath);
  db.run(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)
  `);
  db.run(`
    CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)
  `);
  db.run(`
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmado',
      installment_id INTEGER,
      created_at INTEGER
    )
  `);
  return wrapBunSqlite(db);
}

function insertPayment(amount: number, method: string) {
  db!.run(
    "INSERT INTO payments (amount, payment_method, payment_date, status) VALUES (?, ?, '2027-01-01', 'confirmado')",
    [amount, method]
  );
}

describe("0021 — crea payment_batches y payments.batch_id", () => {
  test("sobre una base sin ninguna de las dos, sin backfill", async () => {
    const client = makePreMigrationDb();
    insertPayment(1000, "efectivo");
    insertPayment(2000, "transferencia");

    const summary = await applyMigration0021PaymentBatches(client);

    expect(summary.tableAlreadyExisted).toBe(false);
    expect(summary.columnAlreadyExisted).toBe(false);
    expect(summary.paymentBatchesCountBefore).toBe(0);
    expect(summary.paymentBatchesCountAfter).toBe(0); // sin backfill
    expect(summary.paymentsCountBefore).toBe(2);
    expect(summary.paymentsCountAfter).toBe(2); // sin cambios en payments

    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_batches'");
    expect(tables.rows.length).toBe(1);
    const cols = await client.execute("PRAGMA table_info(payments)");
    expect((cols.rows as any[]).some((c) => c.name === "batch_id")).toBe(true);
  });

  test("segunda corrida es idempotente — no duplica ni falla", async () => {
    const client = makePreMigrationDb();
    insertPayment(1000, "efectivo");

    const first = await applyMigration0021PaymentBatches(client);
    expect(first.tableAlreadyExisted).toBe(false);
    expect(first.columnAlreadyExisted).toBe(false);

    const second = await applyMigration0021PaymentBatches(client);
    expect(second.tableAlreadyExisted).toBe(true);
    expect(second.columnAlreadyExisted).toBe(true);
    expect(second.paymentsCountAfter).toBe(1);
  });

  test("los índices quedan creados", async () => {
    const client = makePreMigrationDb();
    await applyMigration0021PaymentBatches(client);
    const idx = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
    const names = (idx.rows as any[]).map((r) => r.name);
    expect(names).toContain("idx_payment_batches_insured_id");
    expect(names).toContain("idx_payment_batches_payment_date");
    expect(names).toContain("idx_payment_batches_status");
    expect(names).toContain("idx_payments_batch_id");
  });
});

describe("0022 — crea payment_batch_splits", () => {
  test("requiere payment_batches ya aplicada", async () => {
    const client = makePreMigrationDb();
    await expect(applyMigration0022PaymentBatchSplits(client)).rejects.toThrow(/payment_batches no existe/);
  });

  test("sobre una base con 0021 ya aplicada, sin backfill", async () => {
    const client = makePreMigrationDb();
    await applyMigration0021PaymentBatches(client);

    const summary = await applyMigration0022PaymentBatchSplits(client);
    expect(summary.tableAlreadyExisted).toBe(false);
    expect(summary.splitsCountBefore).toBe(0);
    expect(summary.splitsCountAfter).toBe(0);

    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_batch_splits'");
    expect(tables.rows.length).toBe(1);
  });

  test("segunda corrida es idempotente", async () => {
    const client = makePreMigrationDb();
    await applyMigration0021PaymentBatches(client);

    const first = await applyMigration0022PaymentBatchSplits(client);
    expect(first.tableAlreadyExisted).toBe(false);

    const second = await applyMigration0022PaymentBatchSplits(client);
    expect(second.tableAlreadyExisted).toBe(true);
    expect(second.splitsCountAfter).toBe(0);
  });

  test("CHECK de método rechaza 'lote' y 'combinado' como método individual", async () => {
    const client = makePreMigrationDb();
    await applyMigration0021PaymentBatches(client);
    await applyMigration0022PaymentBatchSplits(client);

    db!.run("INSERT INTO payment_batches (insured_id, base_amount_cents, surcharge_amount_cents, total_received_cents, payment_date, created_at, updated_at) VALUES (1, 100000, 0, 100000, '2027-01-01', 0, 0)");
    const batchId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;

    expect(() => db!.run("INSERT INTO payment_batch_splits (batch_id, method, amount_cents, created_at) VALUES (?, 'lote', 100000, 0)", [batchId]))
      .toThrow();
    expect(() => db!.run("INSERT INTO payment_batch_splits (batch_id, method, amount_cents, created_at) VALUES (?, 'combinado', 100000, 0)", [batchId]))
      .toThrow();
  });
});
