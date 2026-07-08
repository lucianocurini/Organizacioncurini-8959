/**
 * Prueba el aplicador idempotente de la migración 0024 (remittance_
 * allocations). A diferencia de 0021-0023, este aplicador valida FKs/CHECKs/
 * índices reales (no solo nombres de columna) — la mayoría de estos tests
 * ejercitan justamente ese endurecimiento. Se arma una base temporal mínima
 * a mano (users/insureds/payments/payment_splits/cash_entries/remittances/
 * remittance_items + 0021/0022/0023 ya aplicadas) en el scratchpad del
 * sistema — se borra al finalizar. No toca dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyMigration0021PaymentBatches, type Sql0021Client } from "../../lib/migrations/apply-0021-payment-batches";
import { applyMigration0022PaymentBatchSplits, type Sql0022Client } from "../../lib/migrations/apply-0022-payment-batch-splits";
import { applyMigration0023ReceivedChecks, type Sql0023Client } from "../../lib/migrations/apply-0023-received-checks";
import {
  applyMigration0024RemittanceAllocations, Migration0024UncertainStateError, type Sql0024Client,
} from "../../lib/migrations/apply-0024-remittance-allocations";

type Client = Sql0021Client & Sql0022Client & Sql0023Client & Sql0024Client;

function wrapBunSqlite(db: Database): Client {
  return {
    async execute(sql: string, params: any[] = []) {
      // db.query() cachea el Statement compilado en el propio Database y
      // nunca lo finaliza (ver bun:sqlite docs) — con las ~10 corridas de
      // migraciones + validaciones PRAGMA de estos tests, eso deja handles
      // sqlite3_stmt vivos que impiden que sqlite3_close_v2 libere el
      // archivo, y Windows no permite borrar un directorio con un archivo
      // todavía bloqueado (EBUSY en el afterEach). db.prepare() no cachea, y
      // finalize() explícito garantiza el cierre real sin depender del GC.
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
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0024-test-"));
  const dbPath = join(tmpDir, "pre-0024.db");
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

async function makeDbWith0021To0023(): Promise<Client> {
  const client = makePreMigrationDb();
  await applyMigration0021PaymentBatches(client);
  await applyMigration0022PaymentBatchSplits(client);
  await applyMigration0023ReceivedChecks(client);
  return client;
}

describe("0024 — crea remittance_allocations", () => {
  test("requiere payment_batches ya aplicada", async () => {
    const client = makePreMigrationDb();
    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/payment_batches no existe/);
  });

  test("requiere payment_batch_splits ya aplicada", async () => {
    const client = makePreMigrationDb();
    await applyMigration0021PaymentBatches(client);
    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/payment_batch_splits no existe/);
  });

  test("requiere received_checks ya aplicada", async () => {
    const client = makePreMigrationDb();
    await applyMigration0021PaymentBatches(client);
    await applyMigration0022PaymentBatchSplits(client);
    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/received_checks no existe/);
  });

  test("sobre una base con 0021-0023 ya aplicadas, sin backfill", async () => {
    const client = await makeDbWith0021To0023();

    const summary = await applyMigration0024RemittanceAllocations(client);
    expect(summary.tableAlreadyExisted).toBe(false);
    expect(summary.allocationsCountBefore).toBe(0);
    expect(summary.allocationsCountAfter).toBe(0);

    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='remittance_allocations'");
    expect(tables.rows.length).toBe(1);
  });

  test("segunda corrida es idempotente — no duplica ni falla", async () => {
    const client = await makeDbWith0021To0023();
    const first = await applyMigration0024RemittanceAllocations(client);
    expect(first.tableAlreadyExisted).toBe(false);

    const second = await applyMigration0024RemittanceAllocations(client);
    expect(second.tableAlreadyExisted).toBe(true);
    expect(second.allocationsCountAfter).toBe(0);
  });

  test("no modifica remittances ni remittance_items existentes", async () => {
    const client = await makeDbWith0021To0023();
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-01-01', 'directo', 0)");
    db!.run("INSERT INTO remittance_items (remittance_id, source, amount, created_at) VALUES (1, 'manual_debt', 1000, 0)");

    await applyMigration0024RemittanceAllocations(client);

    const rems = await client.execute("SELECT * FROM remittances");
    const items = await client.execute("SELECT * FROM remittance_items");
    expect(rems.rows.length).toBe(1);
    expect(items.rows.length).toBe(1);
  });

  test("columnas esperadas presentes", async () => {
    const client = await makeDbWith0021To0023();
    await applyMigration0024RemittanceAllocations(client);
    const cols = await client.execute("PRAGMA table_info(remittance_allocations)");
    const names = (cols.rows as any[]).map((c) => c.name);
    for (const expected of [
      "id", "remittance_id", "remittance_item_id", "payment_id", "payment_split_id",
      "payment_batch_id", "payment_batch_split_id", "received_check_id", "cash_entry_id",
      "method", "amount_cents", "created_at",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("índices simples y unique parciales quedan creados", async () => {
    const client = await makeDbWith0021To0023();
    await applyMigration0024RemittanceAllocations(client);
    const idx = await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='remittance_allocations'");
    const names = (idx.rows as any[]).map((r) => r.name);
    expect(names).toContain("idx_remittance_allocations_remittance_id");
    expect(names).toContain("idx_remittance_allocations_remittance_item_id");
    expect(names).toContain("idx_remittance_allocations_method");
    expect(names).toContain("idx_remittance_allocations_payment_id");
    expect(names).toContain("idx_remittance_allocations_payment_batch_id");
    expect(names).toContain("ux_remittance_allocations_payment_split");
    expect(names).toContain("ux_remittance_allocations_batch_split_no_check");
    expect(names).toContain("ux_remittance_allocations_received_check");
    expect(names).toContain("ux_remittance_allocations_cash_entry");
  });

  // ─── CHECKs reales (comportamiento, no solo presencia) ───────────────────

  test("CHECK de method rechaza un valor fuera del vocabulario", async () => {
    const client = await makeDbWith0021To0023();
    await applyMigration0024RemittanceAllocations(client);
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-01-01', 'directo', 0)");
    db!.run("INSERT INTO payments (amount, payment_method, payment_date, created_at) VALUES (1000, 'efectivo', '2027-01-01', 0)");
    const paymentId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
    db!.run("INSERT INTO payment_splits (payment_id, method, amount_cents, created_at) VALUES (?, 'efectivo', 100000, 0)", [paymentId]);
    const splitId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;

    expect(() => db!.run(
      "INSERT INTO remittance_allocations (remittance_id, payment_id, payment_split_id, method, amount_cents, created_at) VALUES (1, ?, ?, 'bitcoin', 100000, 0)",
      [paymentId, splitId]
    )).toThrow();
  });

  test("CHECK de amount_cents rechaza cero y negativo", async () => {
    const client = await makeDbWith0021To0023();
    await applyMigration0024RemittanceAllocations(client);
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-01-01', 'directo', 0)");
    db!.run("INSERT INTO payments (amount, payment_method, payment_date, created_at) VALUES (1000, 'efectivo', '2027-01-01', 0)");
    const paymentId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
    db!.run("INSERT INTO payment_splits (payment_id, method, amount_cents, created_at) VALUES (?, 'efectivo', 100000, 0)", [paymentId]);
    const splitId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;

    expect(() => db!.run(
      "INSERT INTO remittance_allocations (remittance_id, payment_id, payment_split_id, method, amount_cents, created_at) VALUES (1, ?, ?, 'efectivo', 0, 0)",
      [paymentId, splitId]
    )).toThrow();
    expect(() => db!.run(
      "INSERT INTO remittance_allocations (remittance_id, payment_id, payment_split_id, method, amount_cents, created_at) VALUES (1, ?, ?, 'efectivo', -100, 0)",
      [paymentId, splitId]
    )).toThrow();
  });

  test("CHECK 'exactamente un leaf' rechaza cero leafs y rechaza dos leafs a la vez", async () => {
    const client = await makeDbWith0021To0023();
    await applyMigration0024RemittanceAllocations(client);
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-01-01', 'directo', 0)");
    db!.run("INSERT INTO payments (amount, payment_method, payment_date, created_at) VALUES (1000, 'efectivo', '2027-01-01', 0)");
    const paymentId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
    db!.run("INSERT INTO payment_splits (payment_id, method, amount_cents, created_at) VALUES (?, 'efectivo', 100000, 0)", [paymentId]);
    const splitId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
    db!.run("INSERT INTO cash_entries (client_name, amount, payment_method, payment_date, created_at) VALUES ('X', 500, 'efectivo', '2027-01-01', 0)");
    const cashEntryId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;

    // cero leafs
    expect(() => db!.run(
      "INSERT INTO remittance_allocations (remittance_id, method, amount_cents, created_at) VALUES (1, 'efectivo', 100000, 0)"
    )).toThrow();

    // dos leafs a la vez (payment_split_id + cash_entry_id)
    expect(() => db!.run(
      "INSERT INTO remittance_allocations (remittance_id, payment_split_id, cash_entry_id, method, amount_cents, created_at) VALUES (1, ?, ?, 'efectivo', 100000, 0)",
      [splitId, cashEntryId]
    )).toThrow();
  });

  test("CHECK received_check_id requiere payment_batch_split_id", async () => {
    const client = await makeDbWith0021To0023();
    await applyMigration0024RemittanceAllocations(client);
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-01-01', 'directo', 0)");
    db!.run("INSERT INTO cash_entries (client_name, amount, payment_method, payment_date, created_at) VALUES ('X', 500, 'efectivo', '2027-01-01', 0)");
    const cashEntryId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;

    // received_check_id sin payment_batch_split_id -> viola el segundo CHECK
    // (además de violar "exactamente un leaf" porque cash_entry_id ya es el leaf)
    expect(() => db!.run(
      "INSERT INTO remittance_allocations (remittance_id, cash_entry_id, received_check_id, method, amount_cents, created_at) VALUES (1, ?, 999, 'efectivo', 100000, 0)",
      [cashEntryId]
    )).toThrow();
  });

  test("unique parcial: un mismo payment_split_id no puede allocarse dos veces", async () => {
    const client = await makeDbWith0021To0023();
    await applyMigration0024RemittanceAllocations(client);
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-01-01', 'directo', 0)");
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-01-02', 'directo', 0)");
    db!.run("INSERT INTO payments (amount, payment_method, payment_date, created_at) VALUES (1000, 'efectivo', '2027-01-01', 0)");
    const paymentId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
    db!.run("INSERT INTO payment_splits (payment_id, method, amount_cents, created_at) VALUES (?, 'efectivo', 100000, 0)", [paymentId]);
    const splitId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;

    db!.run(
      "INSERT INTO remittance_allocations (remittance_id, payment_id, payment_split_id, method, amount_cents, created_at) VALUES (1, ?, ?, 'efectivo', 100000, 0)",
      [paymentId, splitId]
    );
    expect(() => db!.run(
      "INSERT INTO remittance_allocations (remittance_id, payment_id, payment_split_id, method, amount_cents, created_at) VALUES (2, ?, ?, 'efectivo', 100000, 0)",
      [paymentId, splitId]
    )).toThrow();
  });

  test("unique parcial de cheque: varias allocations comparten payment_batch_split_id pero cada received_check_id distinto conviven; repetir el mismo received_check_id no", async () => {
    const client = await makeDbWith0021To0023();
    await applyMigration0024RemittanceAllocations(client);
    db!.run("INSERT INTO remittances (date, canal, created_at) VALUES ('2027-01-01', 'directo', 0)");
    db!.run("INSERT INTO insureds (name) VALUES ('Test')");
    const insuredId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
    db!.run(
      "INSERT INTO payment_batches (insured_id, base_amount_cents, surcharge_amount_cents, total_received_cents, payment_date, created_at, updated_at) VALUES (?, 200000, 0, 200000, '2027-01-01', 0, 0)",
      [insuredId]
    );
    const batchId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
    db!.run("INSERT INTO payment_batch_splits (batch_id, method, amount_cents, created_at) VALUES (?, 'cheque', 200000, 0)", [batchId]);
    const splitId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
    db!.run(
      "INSERT INTO received_checks (batch_split_id, check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at) VALUES (?, '001', 'Banco X', '2027-02-01', 100000, 0, 0, 0)",
      [splitId]
    );
    const check1 = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
    db!.run(
      "INSERT INTO received_checks (batch_split_id, check_number, bank_name, due_date, amount_cents, received_at, created_at, updated_at) VALUES (?, '002', 'Banco X', '2027-02-01', 100000, 0, 0, 0)",
      [splitId]
    );
    const check2 = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;

    // dos allocations, mismo payment_batch_split_id, distinto received_check_id — no debe tirar
    db!.run(
      "INSERT INTO remittance_allocations (remittance_id, payment_batch_id, payment_batch_split_id, received_check_id, method, amount_cents, created_at) VALUES (1, ?, ?, ?, 'cheque', 100000, 0)",
      [batchId, splitId, check1]
    );
    expect(() => db!.run(
      "INSERT INTO remittance_allocations (remittance_id, payment_batch_id, payment_batch_split_id, received_check_id, method, amount_cents, created_at) VALUES (1, ?, ?, ?, 'cheque', 100000, 0)",
      [batchId, splitId, check2]
    )).not.toThrow();

    // repetir el mismo received_check_id sí debe tirar
    expect(() => db!.run(
      "INSERT INTO remittance_allocations (remittance_id, payment_batch_id, payment_batch_split_id, received_check_id, method, amount_cents, created_at) VALUES (1, ?, ?, ?, 'cheque', 100000, 0)",
      [batchId, splitId, check1]
    )).toThrow();
  });

  // ─── Endurecimiento: rechazo de tabla/índices preexistentes inválidos ────

  test("rechaza una tabla preexistente sin el CHECK de method", async () => {
    const client = await makeDbWith0021To0023();
    db!.run(`
      CREATE TABLE remittance_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remittance_id INTEGER NOT NULL REFERENCES remittances(id),
        remittance_item_id INTEGER REFERENCES remittance_items(id),
        payment_id INTEGER REFERENCES payments(id),
        payment_split_id INTEGER REFERENCES payment_splits(id),
        payment_batch_id INTEGER REFERENCES payment_batches(id),
        payment_batch_split_id INTEGER REFERENCES payment_batch_splits(id),
        received_check_id INTEGER REFERENCES received_checks(id),
        cash_entry_id INTEGER REFERENCES cash_entries(id),
        method TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        created_at INTEGER NOT NULL,
        CHECK ((payment_split_id IS NOT NULL) + (payment_batch_split_id IS NOT NULL) + (cash_entry_id IS NOT NULL) = 1),
        CHECK (received_check_id IS NULL OR payment_batch_split_id IS NOT NULL)
      )
    `);
    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/CHECK de method/);
  });

  test("rechaza una tabla preexistente cuyo CHECK de method no tiene los 5 métodos", async () => {
    const client = await makeDbWith0021To0023();
    db!.run(`
      CREATE TABLE remittance_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remittance_id INTEGER NOT NULL REFERENCES remittances(id),
        remittance_item_id INTEGER REFERENCES remittance_items(id),
        payment_id INTEGER REFERENCES payments(id),
        payment_split_id INTEGER REFERENCES payment_splits(id),
        payment_batch_id INTEGER REFERENCES payment_batches(id),
        payment_batch_split_id INTEGER REFERENCES payment_batch_splits(id),
        received_check_id INTEGER REFERENCES received_checks(id),
        cash_entry_id INTEGER REFERENCES cash_entries(id),
        method TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        created_at INTEGER NOT NULL,
        CHECK ((payment_split_id IS NOT NULL) + (payment_batch_split_id IS NOT NULL) + (cash_entry_id IS NOT NULL) = 1),
        CHECK (received_check_id IS NULL OR payment_batch_split_id IS NOT NULL)
      )
    `);
    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/no contiene exactamente los 5 métodos/);
  });

  test("rechaza una tabla preexistente sin el CHECK amount_cents > 0", async () => {
    const client = await makeDbWith0021To0023();
    db!.run(`
      CREATE TABLE remittance_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remittance_id INTEGER NOT NULL REFERENCES remittances(id),
        remittance_item_id INTEGER REFERENCES remittance_items(id),
        payment_id INTEGER REFERENCES payments(id),
        payment_split_id INTEGER REFERENCES payment_splits(id),
        payment_batch_id INTEGER REFERENCES payment_batches(id),
        payment_batch_split_id INTEGER REFERENCES payment_batch_splits(id),
        received_check_id INTEGER REFERENCES received_checks(id),
        cash_entry_id INTEGER REFERENCES cash_entries(id),
        method TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'cheque', 'link_pago', 'transferencia_compania')),
        amount_cents INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK ((payment_split_id IS NOT NULL) + (payment_batch_split_id IS NOT NULL) + (cash_entry_id IS NOT NULL) = 1),
        CHECK (received_check_id IS NULL OR payment_batch_split_id IS NOT NULL)
      )
    `);
    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/falta el CHECK amount_cents > 0/);
  });

  test("rechaza una tabla preexistente sin el CHECK de 'exactamente un leaf'", async () => {
    const client = await makeDbWith0021To0023();
    db!.run(`
      CREATE TABLE remittance_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remittance_id INTEGER NOT NULL REFERENCES remittances(id),
        remittance_item_id INTEGER REFERENCES remittance_items(id),
        payment_id INTEGER REFERENCES payments(id),
        payment_split_id INTEGER REFERENCES payment_splits(id),
        payment_batch_id INTEGER REFERENCES payment_batches(id),
        payment_batch_split_id INTEGER REFERENCES payment_batch_splits(id),
        received_check_id INTEGER REFERENCES received_checks(id),
        cash_entry_id INTEGER REFERENCES cash_entries(id),
        method TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'cheque', 'link_pago', 'transferencia_compania')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        created_at INTEGER NOT NULL,
        CHECK (received_check_id IS NULL OR payment_batch_split_id IS NOT NULL)
      )
    `);
    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/exactamente un leaf/);
  });

  test("rechaza una tabla preexistente sin la regla received_check -> batch_split", async () => {
    const client = await makeDbWith0021To0023();
    db!.run(`
      CREATE TABLE remittance_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remittance_id INTEGER NOT NULL REFERENCES remittances(id),
        remittance_item_id INTEGER REFERENCES remittance_items(id),
        payment_id INTEGER REFERENCES payments(id),
        payment_split_id INTEGER REFERENCES payment_splits(id),
        payment_batch_id INTEGER REFERENCES payment_batches(id),
        payment_batch_split_id INTEGER REFERENCES payment_batch_splits(id),
        received_check_id INTEGER REFERENCES received_checks(id),
        cash_entry_id INTEGER REFERENCES cash_entries(id),
        method TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'cheque', 'link_pago', 'transferencia_compania')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        created_at INTEGER NOT NULL,
        CHECK ((payment_split_id IS NOT NULL) + (payment_batch_split_id IS NOT NULL) + (cash_entry_id IS NOT NULL) = 1)
      )
    `);
    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/payment_batch_split_id cuando hay received_check_id/);
  });

  test("rechaza una FK que apunta a una tabla equivocada", async () => {
    const client = await makeDbWith0021To0023();
    db!.run(`
      CREATE TABLE remittance_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remittance_id INTEGER NOT NULL REFERENCES payments(id),
        remittance_item_id INTEGER REFERENCES remittance_items(id),
        payment_id INTEGER REFERENCES payments(id),
        payment_split_id INTEGER REFERENCES payment_splits(id),
        payment_batch_id INTEGER REFERENCES payment_batches(id),
        payment_batch_split_id INTEGER REFERENCES payment_batch_splits(id),
        received_check_id INTEGER REFERENCES received_checks(id),
        cash_entry_id INTEGER REFERENCES cash_entries(id),
        method TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'cheque', 'link_pago', 'transferencia_compania')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        created_at INTEGER NOT NULL,
        CHECK ((payment_split_id IS NOT NULL) + (payment_batch_split_id IS NOT NULL) + (cash_entry_id IS NOT NULL) = 1),
        CHECK (received_check_id IS NULL OR payment_batch_split_id IS NOT NULL)
      )
    `);
    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/foreign keys inválidas/);
  });

  test("rechaza si falta una FK (columna sin REFERENCES)", async () => {
    const client = await makeDbWith0021To0023();
    db!.run(`
      CREATE TABLE remittance_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remittance_id INTEGER NOT NULL,
        remittance_item_id INTEGER REFERENCES remittance_items(id),
        payment_id INTEGER REFERENCES payments(id),
        payment_split_id INTEGER REFERENCES payment_splits(id),
        payment_batch_id INTEGER REFERENCES payment_batches(id),
        payment_batch_split_id INTEGER REFERENCES payment_batch_splits(id),
        received_check_id INTEGER REFERENCES received_checks(id),
        cash_entry_id INTEGER REFERENCES cash_entries(id),
        method TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'cheque', 'link_pago', 'transferencia_compania')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        created_at INTEGER NOT NULL,
        CHECK ((payment_split_id IS NOT NULL) + (payment_batch_split_id IS NOT NULL) + (cash_entry_id IS NOT NULL) = 1),
        CHECK (received_check_id IS NULL OR payment_batch_split_id IS NOT NULL)
      )
    `);
    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/falta la foreign key de remittance_id/);
  });

  test("rechaza un índice parcial preexistente con condición WHERE equivocada", async () => {
    const client = await makeDbWith0021To0023();
    // Crear la tabla correcta primero (sin pasar por el aplicador, para dejar
    // solo el índice mal definido antes de correrlo).
    db!.run(`
      CREATE TABLE remittance_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remittance_id INTEGER NOT NULL REFERENCES remittances(id),
        remittance_item_id INTEGER REFERENCES remittance_items(id),
        payment_id INTEGER REFERENCES payments(id),
        payment_split_id INTEGER REFERENCES payment_splits(id),
        payment_batch_id INTEGER REFERENCES payment_batches(id),
        payment_batch_split_id INTEGER REFERENCES payment_batch_splits(id),
        received_check_id INTEGER REFERENCES received_checks(id),
        cash_entry_id INTEGER REFERENCES cash_entries(id),
        method TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'cheque', 'link_pago', 'transferencia_compania')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        created_at INTEGER NOT NULL,
        CHECK ((payment_split_id IS NOT NULL) + (payment_batch_split_id IS NOT NULL) + (cash_entry_id IS NOT NULL) = 1),
        CHECK (received_check_id IS NULL OR payment_batch_split_id IS NOT NULL)
      )
    `);
    // Índice con el nombre correcto pero SIN el WHERE (no parcial) — el
    // aplicador usa CREATE UNIQUE INDEX IF NOT EXISTS, que no lo tocaría.
    db!.run("CREATE UNIQUE INDEX ux_remittance_allocations_payment_split ON remittance_allocations(payment_split_id)");

    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/índices inválidos o faltantes/);
  });

  // ─── Manejo de errores de COMMIT/ROLLBACK ────────────────────────────────

  test("si falla el cuerpo y el ROLLBACK funciona, se propaga el error original", async () => {
    const client = await makeDbWith0021To0023();
    // Rompemos la migración simulando que falta 0023 después de ya haber
    // pasado el chequeo de dependencias: forzamos un error dentro del cuerpo
    // insertando una columna faltante manualmente antes de correr — más
    // simple: usamos una base sin 0023 pero con 0021+0022 para que el cuerpo
    // falle en el chequeo de dependencia (ya cubierto), así que acá probamos
    // el camino feliz de rollback con un cuerpo que falla por columnas
    // faltantes de una tabla preexistente incompatible.
    db!.run(`CREATE TABLE remittance_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, remittance_id INTEGER NOT NULL)`);
    await expect(applyMigration0024RemittanceAllocations(client)).rejects.toThrow(/le faltan columnas esperadas/);
    // La tabla rota sigue estando (rollback no debería haber podido deshacer
    // una tabla creada FUERA de la transacción de la migración — esto solo
    // confirma que el error propagado es el original, no uno de rollback).
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='remittance_allocations'");
    expect(tables.rows.length).toBe(1);
  });

  test("si falla el ROLLBACK además del cuerpo, se lanza Migration0024UncertainStateError con ambos errores", async () => {
    const client = await makeDbWith0021To0023();
    let rollbackCalls = 0;
    const flaky: Sql0024Client = {
      async execute(sql: string, params: any[] = []) {
        const upper = sql.trim().toUpperCase();
        if (upper === "ROLLBACK") {
          rollbackCalls++;
          throw new Error("rollback simulado roto");
        }
        return client.execute(sql, params);
      },
    };
    db!.run(`CREATE TABLE remittance_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, remittance_id INTEGER NOT NULL)`);

    let caught: unknown;
    try {
      await applyMigration0024RemittanceAllocations(flaky);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Migration0024UncertainStateError);
    expect((caught as Migration0024UncertainStateError).message).toMatch(/Estado incierto/);
    expect((caught as Migration0024UncertainStateError).message).toMatch(/le faltan columnas esperadas/);
    expect((caught as Migration0024UncertainStateError).message).toMatch(/rollback simulado roto/);
    expect(rollbackCalls).toBe(1);
  });

  test("si falla el COMMIT pero el ROLLBACK funciona, informa que no se aplicó nada", async () => {
    const client = await makeDbWith0021To0023();
    const flaky: Sql0024Client = {
      async execute(sql: string, params: any[] = []) {
        const upper = sql.trim().toUpperCase();
        if (upper === "COMMIT") {
          throw new Error("commit simulado roto");
        }
        return client.execute(sql, params);
      },
    };

    await expect(applyMigration0024RemittanceAllocations(flaky)).rejects.toThrow(/Falló el COMMIT.*ROLLBACK exitosamente/s);
  });

  test("si falla el COMMIT y también el ROLLBACK posterior, estado incierto con ambos errores", async () => {
    const client = await makeDbWith0021To0023();
    const flaky: Sql0024Client = {
      async execute(sql: string, params: any[] = []) {
        const upper = sql.trim().toUpperCase();
        if (upper === "COMMIT") throw new Error("commit simulado roto");
        if (upper === "ROLLBACK") throw new Error("rollback simulado roto");
        return client.execute(sql, params);
      },
    };

    let caught: unknown;
    try {
      await applyMigration0024RemittanceAllocations(flaky);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Migration0024UncertainStateError);
    expect((caught as Migration0024UncertainStateError).message).toMatch(/Falló el COMMIT/);
    expect((caught as Migration0024UncertainStateError).message).toMatch(/rollback simulado roto/);
  });
});
