/**
 * Prueba el aplicador idempotente de la migración 0029 (relaja el CHECK
 * "exactamente un leaf" de remittance_allocations para permitir payment_id
 * SOLO — rendición de un payment hijo de batch independiente de sus
 * hermanos). Se arma una base temporal mínima a mano (reutilizando los
 * aplicadores reales de 0021-0024 y 0028) en el scratchpad del sistema — se
 * borra al finalizar. No toca dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyMigration0021PaymentBatches, type Sql0021Client } from "../../lib/migrations/apply-0021-payment-batches";
import { applyMigration0022PaymentBatchSplits, type Sql0022Client } from "../../lib/migrations/apply-0022-payment-batch-splits";
import { applyMigration0023ReceivedChecks, type Sql0023Client } from "../../lib/migrations/apply-0023-received-checks";
import { applyMigration0024RemittanceAllocations, type Sql0024Client } from "../../lib/migrations/apply-0024-remittance-allocations";
import {
  applyMigration0028ReceivedChecksPaymentSplit, type Sql0028Client,
} from "../../lib/migrations/apply-0028-received-checks-payment-split";
import {
  applyMigration0029RemittanceAllocationsBatchChildPayment,
  isRemittanceAllocationsAlreadyMigrated,
  type Sql0029Client,
} from "../../lib/migrations/apply-0029-remittance-allocations-batch-child-payment";

type Client = Sql0021Client & Sql0022Client & Sql0023Client & Sql0024Client & Sql0028Client & Sql0029Client;

function wrapBunSqlite(db: Database): Client {
  return {
    async execute(sql: string, params: any[] = []) {
      const stmt = db.prepare(sql);
      try {
        const upper = sql.trim().toUpperCase();
        if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
          return { rows: stmt.all(...params) as any[] };
        }
        stmt.run(...params);
        return { rows: [] };
      } finally {
        stmt.finalize();
      }
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

function makePreMigrationDb(): Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0029-test-"));
  const dbPath = join(tmpDir, "pre-0029.db");
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
      batch_id INTEGER,
      rendered INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE payment_splits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL,
      method TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      notes TEXT,
      created_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE cash_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      rendered INTEGER NOT NULL DEFAULT 0,
      entry_type TEXT NOT NULL DEFAULT 'normal',
      payment_id INTEGER,
      created_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE remittances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      canal TEXT NOT NULL,
      payment_breakdown TEXT NOT NULL DEFAULT '{}',
      total_amount REAL NOT NULL DEFAULT 0,
      total_paid REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'confirmada',
      created_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE remittance_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remittance_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_id INTEGER,
      amount REAL NOT NULL,
      debtor_status TEXT NOT NULL DEFAULT 'pagado',
      created_at INTEGER
    )
  `);
  return wrapBunSqlite(db);
}

async function makeDbAt0028(): Promise<Client> {
  const client = makePreMigrationDb();
  await applyMigration0021PaymentBatches(client);
  await applyMigration0022PaymentBatchSplits(client);
  await applyMigration0023ReceivedChecks(client);
  await applyMigration0024RemittanceAllocations(client);
  await applyMigration0028ReceivedChecksPaymentSplit(client);
  return client;
}

function insertInsured(name: string): number {
  db!.run("INSERT INTO insureds (name) VALUES (?)", [name]);
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

function insertBatch(insuredId: number): number {
  db!.run(
    `INSERT INTO payment_batches (insured_id, base_amount_cents, total_received_cents, payment_date, status, created_at, updated_at)
     VALUES (?, 100000, 100000, '2027-06-01', 'confirmado', 1000, 1000)`,
    [insuredId]
  );
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

function insertBatchChildPayment(batchId: number, amount: number): number {
  db!.run(
    "INSERT INTO payments (amount, payment_method, payment_date, batch_id, created_at) VALUES (?, 'lote', '2027-06-01', ?, 1000)",
    [amount, batchId]
  );
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

function insertStandalonePayment(amount: number): number {
  db!.run(
    "INSERT INTO payments (amount, payment_method, payment_date, created_at) VALUES (?, 'efectivo', '2027-06-01', 1000)",
    [amount]
  );
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

function insertPaymentSplit(paymentId: number, method: string, amountCents: number): number {
  db!.run(
    "INSERT INTO payment_splits (payment_id, method, amount_cents, created_at) VALUES (?, ?, ?, 1000)",
    [paymentId, method, amountCents]
  );
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

function insertRemittance(): number {
  db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-09-05', 'directo', 3000)");
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

describe("0029 — remittance_allocations acepta payment_id solo como leaf (rendición por cuota de un hijo de batch)", () => {
  test("requiere remittance_allocations ya aplicada", async () => {
    const client = makePreMigrationDb();
    await applyMigration0021PaymentBatches(client);
    await applyMigration0022PaymentBatchSplits(client);
    await applyMigration0023ReceivedChecks(client);
    // Sin 0024: remittance_allocations no existe todavía.
    await expect(applyMigration0029RemittanceAllocationsBatchChildPayment(client)).rejects.toThrow(/remittance_allocations no existe/);
  });

  test("primera corrida: alreadyApplied=false, y una segunda corrida es no-op (idempotente)", async () => {
    const client = await makeDbAt0028();

    const first = await applyMigration0029RemittanceAllocationsBatchChildPayment(client);
    expect(first.alreadyApplied).toBe(false);
    expect(await isRemittanceAllocationsAlreadyMigrated(client)).toBe(true);

    const second = await applyMigration0029RemittanceAllocationsBatchChildPayment(client);
    expect(second.alreadyApplied).toBe(true);
  });

  test("preserva allocations existentes sin backfill (mismos valores, misma cantidad de filas)", async () => {
    const client = await makeDbAt0028();
    const insuredId = insertInsured("Juan Pérez");
    const batchId = insertBatch(insuredId);
    const paymentId = insertStandalonePayment(500);
    const splitId = insertPaymentSplit(paymentId, "efectivo", 50000);
    const remId = insertRemittance();
    db!.run(
      `INSERT INTO remittance_allocations (remittance_id, payment_id, payment_split_id, method, amount_cents, created_at)
       VALUES (?, ?, ?, 'efectivo', 50000, 3000)`,
      [remId, paymentId, splitId]
    );

    const summary = await applyMigration0029RemittanceAllocationsBatchChildPayment(client);
    expect(summary.remittanceAllocationsCountBefore).toBe(1);
    expect(summary.remittanceAllocationsCountAfter).toBe(1);

    const row = db!.query("SELECT payment_id, payment_split_id, method, amount_cents FROM remittance_allocations WHERE payment_id = ?").get(paymentId) as any;
    expect(row.payment_id).toBe(paymentId);
    expect(row.payment_split_id).toBe(splitId);
    expect(row.method).toBe("efectivo");
    expect(row.amount_cents).toBe(50000);
    void batchId;
  });

  test("leaf nuevo: una allocation con SOLO payment_id (sin split/batch_split/cash_entry) se puede insertar tras la migración", async () => {
    const client = await makeDbAt0028();
    const insuredId = insertInsured("Familia Gómez");
    const batchId = insertBatch(insuredId);
    const childId = insertBatchChildPayment(batchId, 1000);
    const remId = insertRemittance();

    await applyMigration0029RemittanceAllocationsBatchChildPayment(client);

    expect(() => db!.run(
      `INSERT INTO remittance_allocations (remittance_id, payment_id, payment_batch_id, method, amount_cents, created_at)
       VALUES (?, ?, ?, 'transferencia', 100000, 3000)`,
      [remId, childId, batchId]
    )).not.toThrow();

    const row = db!.query(
      "SELECT payment_id, payment_batch_id, payment_split_id, payment_batch_split_id, cash_entry_id, method FROM remittance_allocations WHERE payment_id = ?"
    ).get(childId) as any;
    expect(row.payment_id).toBe(childId);
    expect(row.payment_batch_id).toBe(batchId);
    expect(row.payment_split_id).toBeNull();
    expect(row.payment_batch_split_id).toBeNull();
    expect(row.cash_entry_id).toBeNull();
    expect(row.method).toBe("transferencia");
  });

  test("CHECK: antes de la migración, una allocation con solo payment_id es rechazada", async () => {
    const client = await makeDbAt0028();
    const insuredId = insertInsured("Familia Gómez");
    const batchId = insertBatch(insuredId);
    const childId = insertBatchChildPayment(batchId, 1000);
    const remId = insertRemittance();
    void client;

    expect(() => db!.run(
      `INSERT INTO remittance_allocations (remittance_id, payment_id, payment_batch_id, method, amount_cents, created_at)
       VALUES (?, ?, ?, 'transferencia', 100000, 3000)`,
      [remId, childId, batchId]
    )).toThrow();
  });

  test("leaf payment_split existente sigue funcionando igual tras la migración (payment_id + payment_split_id juntos)", async () => {
    const client = await makeDbAt0028();
    const paymentId = insertStandalonePayment(500);
    const splitId = insertPaymentSplit(paymentId, "efectivo", 50000);
    const remId = insertRemittance();

    await applyMigration0029RemittanceAllocationsBatchChildPayment(client);

    expect(() => db!.run(
      `INSERT INTO remittance_allocations (remittance_id, payment_id, payment_split_id, method, amount_cents, created_at)
       VALUES (?, ?, ?, 'efectivo', 50000, 3000)`,
      [remId, paymentId, splitId]
    )).not.toThrow();
  });

  test("doble rendición del mismo leaf nuevo (mismo payment_id, sin split/batch_split/cash_entry) queda bloqueada por el índice único", async () => {
    const client = await makeDbAt0028();
    const insuredId = insertInsured("Familia Gómez");
    const batchId = insertBatch(insuredId);
    const childId = insertBatchChildPayment(batchId, 1000);
    const remId1 = insertRemittance();
    const remId2 = insertRemittance();

    await applyMigration0029RemittanceAllocationsBatchChildPayment(client);

    db!.run(
      `INSERT INTO remittance_allocations (remittance_id, payment_id, payment_batch_id, method, amount_cents, created_at)
       VALUES (?, ?, ?, 'transferencia', 100000, 3000)`,
      [remId1, childId, batchId]
    );
    expect(() => db!.run(
      `INSERT INTO remittance_allocations (remittance_id, payment_id, payment_batch_id, method, amount_cents, created_at)
       VALUES (?, ?, ?, 'efectivo', 100000, 3000)`,
      [remId2, childId, batchId]
    )).toThrow();
  });

  test("dos hijos DISTINTOS del mismo batch pueden rendirse en rendiciones separadas sin chocar", async () => {
    const client = await makeDbAt0028();
    const insuredId = insertInsured("Familia Gómez");
    const batchId = insertBatch(insuredId);
    const childA = insertBatchChildPayment(batchId, 600);
    const childB = insertBatchChildPayment(batchId, 400);
    const remId1 = insertRemittance();
    const remId2 = insertRemittance();

    await applyMigration0029RemittanceAllocationsBatchChildPayment(client);

    db!.run(
      `INSERT INTO remittance_allocations (remittance_id, payment_id, payment_batch_id, method, amount_cents, created_at)
       VALUES (?, ?, ?, 'transferencia', 60000, 3000)`,
      [remId1, childA, batchId]
    );
    expect(() => db!.run(
      `INSERT INTO remittance_allocations (remittance_id, payment_id, payment_batch_id, method, amount_cents, created_at)
       VALUES (?, ?, ?, 'efectivo', 40000, 3000)`,
      [remId2, childB, batchId]
    )).not.toThrow();

    const rows = db!.query("SELECT payment_id, remittance_id FROM remittance_allocations WHERE payment_batch_id = ?").all(batchId) as any[];
    expect(rows.length).toBe(2);
  });

  test("índices esperados quedan creados (incluye el nuevo ux_remittance_allocations_payment_only)", async () => {
    const client = await makeDbAt0028();
    await applyMigration0029RemittanceAllocationsBatchChildPayment(client);
    const idx = await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='remittance_allocations'");
    const names = (idx.rows as any[]).map((r) => r.name);
    expect(names).toContain("ux_remittance_allocations_payment_only");
    expect(names).toContain("ux_remittance_allocations_payment_split");
    expect(names).toContain("ux_remittance_allocations_batch_split_no_check");
    expect(names).toContain("ux_remittance_allocations_received_check");
    expect(names).toContain("ux_remittance_allocations_cash_entry");
  });
});
