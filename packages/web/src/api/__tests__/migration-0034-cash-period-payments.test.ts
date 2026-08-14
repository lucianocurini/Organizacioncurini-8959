/**
 * Prueba el aplicador idempotente de la migración 0034 (cash_payment_amount_cents
 * en policies/rebillings + tabla cash_period_payments — "Pago de contado por
 * período de facturación"). Puramente aditiva — se arma una base temporal en
 * el scratchpad del sistema con el esquema PRE-0034 mínimo necesario
 * (users/policies/rebillings/payment_batches). Se borra al finalizar. No
 * toca dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0034CashPeriodPayments,
  applyMigration0034CashPeriodPaymentsWork,
  type Sql0034Client,
} from "../../lib/migrations/apply-0034-cash-period-payments";

function wrapBunSqlite(db: Database): Sql0034Client {
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
}, 15000);

function makePreMigrationDb(): Sql0034Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0034-test-"));
  const dbPath = join(tmpDir, "pre-0034.db");
  db = new Database(dbPath);
  db.run("PRAGMA foreign_keys=ON");
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  db.run(`
    CREATE TABLE policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_number TEXT NOT NULL,
      premium REAL
    )
  `);
  db.run(`
    CREATE TABLE rebillings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL REFERENCES policies(id),
      billing_start TEXT NOT NULL,
      billing_end TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE payment_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_amount_cents INTEGER NOT NULL,
      total_received_cents INTEGER NOT NULL,
      payment_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmado'
    )
  `);
  return wrapBunSqlite(db);
}

function insertPolicy(): number {
  const row = db!.query(`INSERT INTO policies (policy_number) VALUES ('TEST-0034') RETURNING id`).get() as any;
  return row.id;
}

function insertBatch(): number {
  const row = db!.query(
    `INSERT INTO payment_batches (base_amount_cents, total_received_cents, payment_date) VALUES (38000000, 38000000, '2026-08-11') RETURNING id`
  ).get() as any;
  return row.id;
}

describe("0034 — agrega las columnas y la tabla", () => {
  test("cash_payment_amount_cents no existe en policies/rebillings antes, existe después", async () => {
    const client = makePreMigrationDb();
    const beforePolicies = await client.execute("PRAGMA table_info(policies)");
    const beforeRebillings = await client.execute("PRAGMA table_info(rebillings)");
    expect((beforePolicies.rows as any[]).some((c) => c.name === "cash_payment_amount_cents")).toBe(false);
    expect((beforeRebillings.rows as any[]).some((c) => c.name === "cash_payment_amount_cents")).toBe(false);

    const summary = await applyMigration0034CashPeriodPayments(client);
    expect(summary.policiesColumnAdded).toBe(true);
    expect(summary.rebillingsColumnAdded).toBe(true);
    expect(summary.tableCreated).toBe(true);

    const afterPolicies = await client.execute("PRAGMA table_info(policies)");
    const col = (afterPolicies.rows as any[]).find((c) => c.name === "cash_payment_amount_cents");
    expect(col).toBeDefined();
    expect(col.notnull).toBe(0); // nullable

    const afterRebillings = await client.execute("PRAGMA table_info(rebillings)");
    expect((afterRebillings.rows as any[]).some((c) => c.name === "cash_payment_amount_cents")).toBe(true);
  });

  test("crea cash_period_payments con sus CHECK e índices", async () => {
    const client = makePreMigrationDb();
    await applyMigration0034CashPeriodPayments(client);

    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='cash_period_payments'");
    expect(tables.rows.length).toBe(1);

    const indexes = await client.execute("PRAGMA index_list(cash_period_payments)");
    const indexNames = (indexes.rows as any[]).map((r) => r.name);
    expect(indexNames).toContain("ux_cash_period_payments_batch_id");
    expect(indexNames).toContain("idx_cash_period_payments_policy_rebilling");
  });
});

describe("0034 — conserva filas históricas", () => {
  test("no cambia la cantidad de filas de policies/rebillings", async () => {
    const client = makePreMigrationDb();
    insertPolicy();
    insertPolicy();

    const summary = await applyMigration0034CashPeriodPayments(client);
    expect(summary.policiesBefore).toBe(2);
    expect(summary.policiesAfter).toBe(2);
  });

  test("filas existentes quedan cash_payment_amount_cents=NULL (nada histórico se reinterpreta)", async () => {
    const client = makePreMigrationDb();
    const policyId = insertPolicy();

    await applyMigration0034CashPeriodPayments(client);

    const row = db!.query("SELECT cash_payment_amount_cents FROM policies WHERE id = ?").get(policyId) as any;
    expect(row.cash_payment_amount_cents).toBeNull();
  });

  test("cash_period_payments queda vacía (sin backfill)", async () => {
    const client = makePreMigrationDb();
    insertPolicy();

    const summary = await applyMigration0034CashPeriodPayments(client);
    expect(summary.cashPeriodPaymentsCountAfter).toBe(0);
  });
});

describe("0034 — CHECK constraints reales de cash_period_payments", () => {
  test("rechaza cash_amount_cents > nominal_amount_cents", async () => {
    const client = makePreMigrationDb();
    await applyMigration0034CashPeriodPayments(client);
    const userId = db!.query(`INSERT INTO users (name) VALUES ('QA') RETURNING id`).get() as any;
    const policyId = insertPolicy();
    const batchId = insertBatch();

    expect(() => {
      db!.run(
        `INSERT INTO cash_period_payments
         (payment_batch_id, policy_id, nominal_amount_cents, cash_amount_cents, discount_amount_cents, created_by, created_at)
         VALUES (?, ?, 100, 200, -100, ?, 0)`,
        [batchId, policyId, userId.id]
      );
    }).toThrow();
  });

  test("permite cash_amount_cents == nominal_amount_cents (descuento $0)", async () => {
    const client = makePreMigrationDb();
    await applyMigration0034CashPeriodPayments(client);
    const userId = (db!.query(`INSERT INTO users (name) VALUES ('QA') RETURNING id`).get() as any).id;
    const policyId = insertPolicy();
    const batchId = insertBatch();

    db!.run(
      `INSERT INTO cash_period_payments
       (payment_batch_id, policy_id, nominal_amount_cents, cash_amount_cents, discount_amount_cents, created_by, created_at)
       VALUES (?, ?, 40000000, 40000000, 0, ?, 0)`,
      [batchId, policyId, userId]
    );
    const row = db!.query("SELECT * FROM cash_period_payments WHERE payment_batch_id = ?").get(batchId) as any;
    expect(row.cash_amount_cents).toBe(40000000);
    expect(row.discount_amount_cents).toBe(0);
  });

  test("rechaza un segundo cash_period_payments para el mismo payment_batch_id (UNIQUE)", async () => {
    const client = makePreMigrationDb();
    await applyMigration0034CashPeriodPayments(client);
    const userId = (db!.query(`INSERT INTO users (name) VALUES ('QA') RETURNING id`).get() as any).id;
    const policyId = insertPolicy();
    const batchId = insertBatch();
    const insertOne = () =>
      db!.run(
        `INSERT INTO cash_period_payments
         (payment_batch_id, policy_id, nominal_amount_cents, cash_amount_cents, discount_amount_cents, created_by, created_at)
         VALUES (?, ?, 40000000, 38000000, 2000000, ?, 0)`,
        [batchId, policyId, userId]
      );
    insertOne();
    expect(() => insertOne()).toThrow();
  });
});

describe("0034 — idempotencia", () => {
  test("segunda corrida no duplica columnas ni tabla, alreadyApplied=true", async () => {
    const client = makePreMigrationDb();
    insertPolicy();

    const first = await applyMigration0034CashPeriodPayments(client);
    expect(first.alreadyApplied).toBe(false);

    const second = await applyMigration0034CashPeriodPayments(client);
    expect(second.alreadyApplied).toBe(true);
    expect(second.policiesColumnAdded).toBe(false);
    expect(second.rebillingsColumnAdded).toBe(false);
    expect(second.tableCreated).toBe(false);

    const cols = await client.execute("PRAGMA table_info(policies)");
    expect((cols.rows as any[]).filter((c) => c.name === "cash_payment_amount_cents").length).toBe(1);
  });
});

// ─── Work vs. wrapper local — no controla transacciones por sí misma ────────
describe("0034 — applyMigration0034CashPeriodPaymentsWork no controla transacciones", () => {
  function wrapRecording(base: Sql0034Client): { client: Sql0034Client; sqlLog: string[] } {
    const sqlLog: string[] = [];
    return {
      sqlLog,
      client: {
        async execute(sql: string, params: any[] = []) {
          sqlLog.push(sql.trim());
          return base.execute(sql, params);
        },
      },
    };
  }

  test("no emite BEGIN/COMMIT/ROLLBACK", async () => {
    const base = makePreMigrationDb();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0034CashPeriodPaymentsWork(client);

    const controlStatements = sqlLog.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql));
    expect(controlStatements).toEqual([]);
  });

  test("el wrapper local sí emite BEGIN y COMMIT", async () => {
    const base = makePreMigrationDb();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0034CashPeriodPayments(client);

    expect(sqlLog.some((sql) => /^BEGIN\b/i.test(sql))).toBe(true);
    expect(sqlLog.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
  });
});
