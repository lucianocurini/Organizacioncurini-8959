/**
 * Prueba el aplicador idempotente de la migración 0028 (received_checks.
 * payment_split_id + CHECK XOR, y relajar el CHECK de remittance_allocations
 * para permitir received_check_id junto con payment_split_id). Igual que
 * 0026, esta migración recrea DOS tablas completas (procedimiento de 12
 * pasos de SQLite), así que además de columnas hay que verificar: cheques de
 * lote existentes preservados sin backfill, los índices recreados, el CHECK
 * XOR de received_checks funcionando de verdad (no solo declarado), y que el
 * segundo CHECK de remittance_allocations ahora acepta la combinación que
 * antes rechazaba. Se arma una base temporal mínima a mano (reutilizando los
 * aplicadores reales de 0021-0024) en el scratchpad del sistema — se borra
 * al finalizar. No toca dev.db ni Turso.
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
  applyMigration0028ReceivedChecksPaymentSplit, isReceivedChecksAlreadyMigrated, type Sql0028Client,
} from "../../lib/migrations/apply-0028-received-checks-payment-split";

type Client = Sql0021Client & Sql0022Client & Sql0023Client & Sql0024Client & Sql0028Client;

function wrapBunSqlite(db: Database): Client {
  return {
    async execute(sql: string, params: any[] = []) {
      // Ver comentario del mismo wrapper en migration-0024...test.ts: usar
      // db.prepare()+finalize() en vez de db.query() (que cachea el
      // Statement sin finalizarlo) evita EBUSY al borrar el directorio
      // temporal en Windows.
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
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0028-test-"));
  const dbPath = join(tmpDir, "pre-0028.db");
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

async function makeDbWith0021To0024(): Promise<Client> {
  const client = makePreMigrationDb();
  await applyMigration0021PaymentBatches(client);
  await applyMigration0022PaymentBatchSplits(client);
  await applyMigration0023ReceivedChecks(client);
  await applyMigration0024RemittanceAllocations(client);
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

function insertBatchSplit(batchId: number, method: string, amountCents: number): number {
  db!.run(
    "INSERT INTO payment_batch_splits (batch_id, method, amount_cents, created_at) VALUES (?, ?, ?, 1000)",
    [batchId, method, amountCents]
  );
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

function insertBatchCheck(batchSplitId: number, amountCents: number, checkNumber = "0001"): number {
  db!.run(
    `INSERT INTO received_checks (batch_split_id, check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at)
     VALUES (?, ?, 'Banco Nación', '2027-08-01', ?, 1000, 1000, 1000)`,
    [batchSplitId, checkNumber, amountCents]
  );
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

function insertPayment(amount: number): number {
  db!.run(
    "INSERT INTO payments (amount, payment_method, payment_date, created_at) VALUES (?, 'cheque', '2027-06-01', 1000)",
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

describe("0028 — received_checks.payment_split_id + relaja CHECK de remittance_allocations", () => {
  test("requiere received_checks ya aplicada", async () => {
    const client = makePreMigrationDb();
    await applyMigration0021PaymentBatches(client);
    await applyMigration0022PaymentBatchSplits(client);
    await expect(applyMigration0028ReceivedChecksPaymentSplit(client)).rejects.toThrow(/received_checks no existe/);
  });

  test("requiere remittance_allocations ya aplicada", async () => {
    const client = makePreMigrationDb();
    await applyMigration0021PaymentBatches(client);
    await applyMigration0022PaymentBatchSplits(client);
    await applyMigration0023ReceivedChecks(client);
    await expect(applyMigration0028ReceivedChecksPaymentSplit(client)).rejects.toThrow(/remittance_allocations no existe/);
  });

  test("primera corrida: agrega payment_split_id y vuelve batch_split_id nullable", async () => {
    const client = await makeDbWith0021To0024();

    const summary = await applyMigration0028ReceivedChecksPaymentSplit(client);
    expect(summary.alreadyApplied).toBe(false);

    const cols = await client.execute("PRAGMA table_info(received_checks)");
    const names = (cols.rows as any[]).map((c) => c.name);
    expect(names).toContain("payment_split_id");
    const batchSplitCol = (cols.rows as any[]).find((c) => c.name === "batch_split_id");
    expect(Number(batchSplitCol.notnull)).toBe(0);

    expect(await isReceivedChecksAlreadyMigrated(client)).toBe(true);
  });

  test("preserva cheques de lote existentes sin backfill (mismo batch_split_id, payment_split_id NULL)", async () => {
    const client = await makeDbWith0021To0024();
    const insuredId = insertInsured("Juan Pérez");
    const batchId = insertBatch(insuredId);
    const splitId = insertBatchSplit(batchId, "cheque", 50000);
    const checkId = insertBatchCheck(splitId, 50000, "0001-A");

    const summary = await applyMigration0028ReceivedChecksPaymentSplit(client);
    expect(summary.receivedChecksCountBefore).toBe(1);
    expect(summary.receivedChecksCountAfter).toBe(1);

    const row = db!.query("SELECT batch_split_id, payment_split_id, check_number, amount_cents FROM received_checks WHERE id = ?").get(checkId) as any;
    expect(row.batch_split_id).toBe(splitId);
    expect(row.payment_split_id).toBeNull();
    expect(row.check_number).toBe("0001-A");
    expect(row.amount_cents).toBe(50000);
  });

  test("índices originales y el nuevo de payment_split_id quedan creados", async () => {
    const client = await makeDbWith0021To0024();
    await applyMigration0028ReceivedChecksPaymentSplit(client);
    const idx = await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='received_checks'");
    const names = (idx.rows as any[]).map((r) => r.name);
    expect(names).toContain("idx_received_checks_batch_split_id");
    expect(names).toContain("idx_received_checks_payment_split_id");
    expect(names).toContain("idx_received_checks_status");
    expect(names).toContain("idx_received_checks_due_date");
    expect(names).toContain("idx_received_checks_bank_number");
  });

  test("CHECK XOR: rechaza un cheque sin ningún vínculo", async () => {
    const client = await makeDbWith0021To0024();
    await applyMigration0028ReceivedChecksPaymentSplit(client);

    expect(() => db!.run(
      `INSERT INTO received_checks (check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at)
       VALUES ('X', 'Banco', '2027-08-01', 1000, 1000, 1000, 1000)`
    )).toThrow();
  });

  test("CHECK XOR: rechaza un cheque con AMBOS vínculos a la vez", async () => {
    const client = await makeDbWith0021To0024();
    await applyMigration0028ReceivedChecksPaymentSplit(client);

    const insuredId = insertInsured("Juan Pérez");
    const batchId = insertBatch(insuredId);
    const splitId = insertBatchSplit(batchId, "cheque", 50000);
    const paymentId = insertPayment(500);
    const paySplitId = insertPaymentSplit(paymentId, "cheque", 50000);

    expect(() => db!.run(
      `INSERT INTO received_checks (batch_split_id, payment_split_id, check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at)
       VALUES (?, ?, 'X', 'Banco', '2027-08-01', 1000, 1000, 1000, 1000)`,
      [splitId, paySplitId]
    )).toThrow();
  });

  test("un cheque de pago individual (solo payment_split_id) se puede insertar tras la migración", async () => {
    const client = await makeDbWith0021To0024();
    await applyMigration0028ReceivedChecksPaymentSplit(client);

    const paymentId = insertPayment(500);
    const paySplitId = insertPaymentSplit(paymentId, "cheque", 50000);
    db!.run(
      `INSERT INTO received_checks (payment_split_id, check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at)
       VALUES (?, 'IND-0001', 'Banco Galicia', '2027-09-01', 50000, 2000, 2000, 2000)`,
      [paySplitId]
    );
    const row = db!.query("SELECT batch_split_id, payment_split_id, check_number FROM received_checks WHERE check_number = 'IND-0001'").get() as any;
    expect(row.batch_split_id).toBeNull();
    expect(row.payment_split_id).toBe(paySplitId);
  });

  test("remittance_allocations: el segundo CHECK ahora acepta received_check_id junto con payment_split_id", async () => {
    const client = await makeDbWith0021To0024();
    await applyMigration0028ReceivedChecksPaymentSplit(client);

    const paymentId = insertPayment(500);
    const paySplitId = insertPaymentSplit(paymentId, "cheque", 50000);
    db!.run(
      `INSERT INTO received_checks (payment_split_id, check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at)
       VALUES (?, 'IND-0002', 'Banco Galicia', '2027-09-01', 50000, 2000, 2000, 2000)`,
      [paySplitId]
    );
    const checkId = Number(db!.query("SELECT id FROM received_checks WHERE check_number = 'IND-0002'").get()!.id);
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-09-05', 'directo', 3000)");

    // Antes de 0028 esto violaba el segundo CHECK de remittance_allocations
    // (received_check_id IS NULL OR payment_batch_split_id IS NOT NULL) —
    // ahora debe insertarse sin error.
    expect(() => db!.run(
      `INSERT INTO remittance_allocations
        (remittance_id, payment_id, payment_split_id, received_check_id, method, amount_cents, created_at)
       VALUES (1, ?, ?, ?, 'cheque', 50000, 3000)`,
      [paymentId, paySplitId, checkId]
    )).not.toThrow();

    const alloc = db!.query("SELECT payment_split_id, received_check_id FROM remittance_allocations WHERE received_check_id = ?").get(checkId) as any;
    expect(alloc.payment_split_id).toBe(paySplitId);
    expect(alloc.received_check_id).toBe(checkId);
  });

  test("remittance_allocations: dos cheques del MISMO payment_split_id (2 allocations) no violan el índice único", async () => {
    const client = await makeDbWith0021To0024();
    await applyMigration0028ReceivedChecksPaymentSplit(client);

    const paymentId = insertPayment(1000);
    const paySplitId = insertPaymentSplit(paymentId, "cheque", 100000);
    db!.run(
      `INSERT INTO received_checks (payment_split_id, check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at)
       VALUES (?, 'IND-A', 'Banco Galicia', '2027-09-01', 60000, 2000, 2000, 2000)`,
      [paySplitId]
    );
    db!.run(
      `INSERT INTO received_checks (payment_split_id, check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at)
       VALUES (?, 'IND-B', 'Banco Galicia', '2027-09-01', 40000, 2000, 2000, 2000)`,
      [paySplitId]
    );
    const checkIdA = Number(db!.query("SELECT id FROM received_checks WHERE check_number = 'IND-A'").get()!.id);
    const checkIdB = Number(db!.query("SELECT id FROM received_checks WHERE check_number = 'IND-B'").get()!.id);
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-09-05', 'directo', 3000)");

    // Regresión: ux_remittance_allocations_payment_split sin "AND
    // received_check_id IS NULL" bloquearía la segunda fila (mismo
    // payment_split_id que la primera) aunque sean cheques distintos.
    db!.run(
      `INSERT INTO remittance_allocations
        (remittance_id, payment_id, payment_split_id, received_check_id, method, amount_cents, created_at)
       VALUES (1, ?, ?, ?, 'cheque', 60000, 3000)`,
      [paymentId, paySplitId, checkIdA]
    );
    expect(() => db!.run(
      `INSERT INTO remittance_allocations
        (remittance_id, payment_id, payment_split_id, received_check_id, method, amount_cents, created_at)
       VALUES (1, ?, ?, ?, 'cheque', 40000, 3000)`,
      [paymentId, paySplitId, checkIdB]
    )).not.toThrow();

    const allocs = db!.query("SELECT received_check_id FROM remittance_allocations WHERE payment_split_id = ?").all(paySplitId) as any[];
    expect(allocs.length).toBe(2);
  });

  test("remittance_allocations: sigue bloqueando dos allocations para el MISMO payment_split_id sin cheque (split no-cheque)", async () => {
    const client = await makeDbWith0021To0024();
    await applyMigration0028ReceivedChecksPaymentSplit(client);

    const paymentId = insertPayment(500);
    const paySplitId = insertPaymentSplit(paymentId, "efectivo", 50000);
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-09-05', 'directo', 3000)");
    db!.run(
      `INSERT INTO remittance_allocations (remittance_id, payment_id, payment_split_id, method, amount_cents, created_at)
       VALUES (1, ?, ?, 'efectivo', 50000, 3000)`,
      [paymentId, paySplitId]
    );
    expect(() => db!.run(
      `INSERT INTO remittance_allocations (remittance_id, payment_id, payment_split_id, method, amount_cents, created_at)
       VALUES (1, ?, ?, 'efectivo', 50000, 3000)`,
      [paymentId, paySplitId]
    )).toThrow();
  });

  test("remittance_allocations: sigue exigiendo exactamente un leaf (rechaza payment_split_id + payment_batch_split_id juntos)", async () => {
    const client = await makeDbWith0021To0024();
    await applyMigration0028ReceivedChecksPaymentSplit(client);

    const insuredId = insertInsured("Juan Pérez");
    const batchId = insertBatch(insuredId);
    const splitId = insertBatchSplit(batchId, "efectivo", 50000);
    const paymentId = insertPayment(500);
    const paySplitId = insertPaymentSplit(paymentId, "efectivo", 50000);
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-09-05', 'directo', 3000)");

    expect(() => db!.run(
      `INSERT INTO remittance_allocations
        (remittance_id, payment_split_id, payment_batch_split_id, method, amount_cents, created_at)
       VALUES (1, ?, ?, 'efectivo', 50000, 3000)`,
      [paySplitId, splitId]
    )).toThrow();
  });

  test("las FKs de tablas relacionadas quedan íntegras (PRAGMA foreign_key_check limpio)", async () => {
    const client = await makeDbWith0021To0024();
    const insuredId = insertInsured("Juan Pérez");
    const batchId = insertBatch(insuredId);
    const splitId = insertBatchSplit(batchId, "cheque", 50000);
    insertBatchCheck(splitId, 50000);

    await applyMigration0028ReceivedChecksPaymentSplit(client);

    const fkCheck = await client.execute("PRAGMA foreign_key_check");
    expect(fkCheck.rows.length).toBe(0);
  });

  test("segunda corrida es idempotente — no toca nada, alreadyApplied=true", async () => {
    const client = await makeDbWith0021To0024();
    const insuredId = insertInsured("Juan Pérez");
    const batchId = insertBatch(insuredId);
    const splitId = insertBatchSplit(batchId, "cheque", 50000);
    insertBatchCheck(splitId, 50000);

    const first = await applyMigration0028ReceivedChecksPaymentSplit(client);
    expect(first.alreadyApplied).toBe(false);

    const second = await applyMigration0028ReceivedChecksPaymentSplit(client);
    expect(second.alreadyApplied).toBe(true);
    expect(second.receivedChecksCountBefore).toBe(1);
    expect(second.receivedChecksCountAfter).toBe(1);
  });
});
