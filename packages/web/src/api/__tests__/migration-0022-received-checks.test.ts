/**
 * Prueba el aplicador idempotente de la migración 0022 (received_checks).
 * Se arma una base temporal mínima a mano (users/insureds/payments +
 * payment_batches/payment_batch_splits ya aplicadas vía sus propios
 * aplicadores) en el scratchpad del sistema — se borra al finalizar. No toca
 * dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyMigration0020PaymentBatches, type Sql0020Client } from "../../lib/migrations/apply-0020-payment-batches";
import { applyMigration0021PaymentBatchSplits, type Sql0021Client } from "../../lib/migrations/apply-0021-payment-batch-splits";
import { applyMigration0022ReceivedChecks, type Sql0022Client } from "../../lib/migrations/apply-0022-received-checks";

type Client = Sql0020Client & Sql0021Client & Sql0022Client;

function wrapBunSqlite(db: Database): Client {
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

afterEach(async () => {
  db?.close();
  db = null;
  // En Windows, tras varias migraciones encadenadas (0020+0021+0022) el
  // handle del archivo WAL/journal puede tardar unos ms en liberarse después
  // de close() — reintenta unas pocas veces en vez de fallar el test por un
  // problema de limpieza ajeno a la lógica de la migración.
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

function makePreMigrationDb(): Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0022-test-"));
  const dbPath = join(tmpDir, "pre-0022.db");
  db = new Database(dbPath);
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  db.run(`CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
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

async function makeDbWith0020And0021(): Promise<Client> {
  const client = makePreMigrationDb();
  await applyMigration0020PaymentBatches(client);
  await applyMigration0021PaymentBatchSplits(client);
  return client;
}

function insertBatch(): number {
  db!.run(
    "INSERT INTO payment_batches (insured_id, base_amount_cents, surcharge_amount_cents, total_received_cents, payment_date, created_at, updated_at) VALUES (1, 100000, 0, 100000, '2027-01-01', 0, 0)"
  );
  return (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
}

function insertSplit(batchId: number, method: string, amountCents: number): number {
  db!.run(
    "INSERT INTO payment_batch_splits (batch_id, method, amount_cents, created_at) VALUES (?, ?, ?, 0)",
    [batchId, method, amountCents]
  );
  return (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
}

describe("0022 — crea received_checks", () => {
  test("requiere payment_batch_splits ya aplicada", async () => {
    const client = makePreMigrationDb();
    await expect(applyMigration0022ReceivedChecks(client)).rejects.toThrow(/payment_batch_splits no existe/);
  });

  test("sobre una base con 0020+0021 ya aplicadas, sin backfill", async () => {
    const client = await makeDbWith0020And0021();

    const summary = await applyMigration0022ReceivedChecks(client);
    expect(summary.tableAlreadyExisted).toBe(false);
    expect(summary.checksCountBefore).toBe(0);
    expect(summary.checksCountAfter).toBe(0);

    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='received_checks'");
    expect(tables.rows.length).toBe(1);
  });

  test("segunda corrida es idempotente — no duplica ni falla", async () => {
    const client = await makeDbWith0020And0021();

    const first = await applyMigration0022ReceivedChecks(client);
    expect(first.tableAlreadyExisted).toBe(false);

    const batchId = insertBatch();
    const splitId = insertSplit(batchId, "cheque", 100000);
    db!.run(
      "INSERT INTO received_checks (batch_split_id, check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at) VALUES (?, '001', 'Banco X', '2027-02-01', 100000, 0, 0, 0)",
      [splitId]
    );

    const second = await applyMigration0022ReceivedChecks(client);
    expect(second.tableAlreadyExisted).toBe(true);
    expect(second.checksCountBefore).toBe(1);
    expect(second.checksCountAfter).toBe(1); // no duplica, no borra
  });

  test("los índices quedan creados", async () => {
    const client = await makeDbWith0020And0021();
    await applyMigration0022ReceivedChecks(client);
    const idx = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
    const names = (idx.rows as any[]).map((r) => r.name);
    expect(names).toContain("idx_received_checks_batch_split_id");
    expect(names).toContain("idx_received_checks_status");
    expect(names).toContain("idx_received_checks_due_date");
    expect(names).toContain("idx_received_checks_bank_number");
  });

  test("columnas esperadas presentes", async () => {
    const client = await makeDbWith0020And0021();
    await applyMigration0022ReceivedChecks(client);
    const cols = await client.execute("PRAGMA table_info(received_checks)");
    const names = (cols.rows as any[]).map((c) => c.name);
    for (const expected of [
      "id", "batch_split_id", "check_number", "bank_name", "bank_code", "drawer_name",
      "drawer_document", "issue_date", "due_date", "amount_cents", "currency", "status",
      "notes", "received_at", "delivered_at", "cleared_at", "rejected_at", "cancelled_at",
      "created_by", "created_at", "updated_at",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("CHECK de status rechaza un valor fuera del vocabulario (incluye 'depositado')", async () => {
    const client = await makeDbWith0020And0021();
    await applyMigration0022ReceivedChecks(client);
    const batchId = insertBatch();
    const splitId = insertSplit(batchId, "cheque", 100000);

    expect(() => db!.run(
      "INSERT INTO received_checks (batch_split_id, check_number, bank_name, due_date, amount_cents, status, received_at, created_at, updated_at) VALUES (?, '001', 'Banco X', '2027-02-01', 100000, 'depositado', 0, 0, 0)",
      [splitId]
    )).toThrow();
  });

  test("CHECK de amount_cents rechaza cero y negativo", async () => {
    const client = await makeDbWith0020And0021();
    await applyMigration0022ReceivedChecks(client);
    const batchId = insertBatch();
    const splitId = insertSplit(batchId, "cheque", 100000);

    expect(() => db!.run(
      "INSERT INTO received_checks (batch_split_id, check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at) VALUES (?, '001', 'Banco X', '2027-02-01', 0, 0, 0, 0)",
      [splitId]
    )).toThrow();
    expect(() => db!.run(
      "INSERT INTO received_checks (batch_split_id, check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at) VALUES (?, '002', 'Banco X', '2027-02-01', -100, 0, 0, 0)",
      [splitId]
    )).toThrow();
  });
});
