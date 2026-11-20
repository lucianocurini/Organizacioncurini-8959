/**
 * Prueba el aplicador idempotente de la migración 0037
 * (payments.cash_period_payment_id + backfill de los contados históricos).
 * Base temporal en el directorio temporal del sistema con el esquema PRE-0037
 * mínimo necesario (policies/policy_installments/payment_batches/payments/
 * cash_period_payments) y datos sintéticos. Se borra al finalizar. No toca
 * dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0037CashPeriodPaymentChildren,
  type Sql0037Client,
} from "../../lib/migrations/apply-0037-cash-period-payment-children";

let tmpDir: string | null = null;
let raw: Database | null = null;

afterEach(async () => {
  raw?.close();
  raw = null;
  if (tmpDir) {
    const dir = tmpDir;
    tmpDir = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch (e) {
        if (attempt === 14) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
}, 15000);

function wrap(db: Database): Sql0037Client {
  return {
    async execute(sql: string, params: any[] = []) {
      const stmt = db.prepare(sql);
      try {
        const upper = sql.trim().toUpperCase();
        if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) return { rows: stmt.all(...params) as any[] };
        stmt.run(...params);
        return { rows: [] };
      } finally {
        stmt.finalize();
      }
    },
  };
}

/** Esquema pre-0037 mínimo + datos sintéticos: un contado histórico, un lote común y un pago suelto. */
function makePreMigrationDb(): { client: Sql0037Client; db: Database } {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0037-"));
  raw = new Database(join(tmpDir, "pre-0037.db"));
  raw.run("PRAGMA foreign_keys=ON");
  raw.run(`CREATE TABLE policies (id INTEGER PRIMARY KEY AUTOINCREMENT, policy_number TEXT)`);
  raw.run(`CREATE TABLE rebillings (id INTEGER PRIMARY KEY AUTOINCREMENT, policy_id INTEGER NOT NULL REFERENCES policies(id))`);
  raw.run(`CREATE TABLE policy_installments (id INTEGER PRIMARY KEY AUTOINCREMENT, policy_id INTEGER NOT NULL REFERENCES policies(id),
    rebilling_id INTEGER REFERENCES rebillings(id), amount REAL NOT NULL)`);
  raw.run(`CREATE TABLE payment_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, total_received_cents INTEGER NOT NULL)`);
  raw.run(`CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, policy_id INTEGER REFERENCES policies(id), amount REAL NOT NULL,
    installment_id INTEGER REFERENCES policy_installments(id), batch_id INTEGER REFERENCES payment_batches(id))`);
  raw.run(`CREATE TABLE cash_period_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_batch_id INTEGER NOT NULL REFERENCES payment_batches(id),
    policy_id INTEGER NOT NULL REFERENCES policies(id), rebilling_id INTEGER REFERENCES rebillings(id), cash_amount_cents INTEGER NOT NULL)`);
  raw.run(`CREATE UNIQUE INDEX ux_cash_period_payments_batch_id ON cash_period_payments(payment_batch_id)`);

  raw.run(`INSERT INTO policies (id, policy_number) VALUES (1, 'SYN-1'), (2, 'SYN-2')`);
  raw.run(`INSERT INTO rebillings (id, policy_id) VALUES (10, 1)`);
  // Período refacturado de la póliza 1 (3 cuotas) y cuotas de emisión de la póliza 2.
  raw.run(`INSERT INTO policy_installments (id, policy_id, rebilling_id, amount) VALUES
    (100, 1, 10, 10000), (101, 1, 10, 10000), (102, 1, 10, 10000), (200, 2, NULL, 5000), (201, 2, NULL, 5000)`);
  // Lote 1: contado histórico de la refacturación 10. Lote 2: lote común de la póliza 2.
  raw.run(`INSERT INTO payment_batches (id, total_received_cents) VALUES (1, 2700000), (2, 500000)`);
  raw.run(`INSERT INTO cash_period_payments (id, payment_batch_id, policy_id, rebilling_id, cash_amount_cents) VALUES (7, 1, 1, 10, 2700000)`);
  raw.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id) VALUES
    (1000, 1, 10000, 100, 1), (1001, 1, 10000, 101, 1), (1002, 1, 10000, 102, 1),
    (2000, 2, 5000, 200, 2),
    (3000, 2, 5000, 201, NULL)`);
  return { client: wrap(raw), db: raw };
}

function links(db: Database): Record<number, number | null> {
  const rows = db.query("SELECT id, cash_period_payment_id AS c FROM payments ORDER BY id").all() as any[];
  return Object.fromEntries(rows.map((r) => [r.id, r.c]));
}

describe("Migración 0037 — payments.cash_period_payment_id", () => {
  test("agrega la columna y el índice y vincula SOLO los hijos del contado histórico", async () => {
    const { client, db } = makePreMigrationDb();
    const summary = await applyMigration0037CashPeriodPaymentChildren(client);
    expect(summary.columnAdded).toBe(true);
    expect(summary.indexCreated).toBe(true);
    expect(summary.backfilledRows).toBe(3);
    expect(summary.paymentsBefore).toBe(5);
    expect(summary.paymentsAfter).toBe(5);
    expect(summary.linkedChildren).toBe(3);
    expect(links(db)).toEqual({ 1000: 7, 1001: 7, 1002: 7, 2000: null, 3000: null });
    const idx = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_payments_cash_period_payment_id'").all();
    expect(idx.length).toBe(1);
  });

  test("idempotente: una segunda corrida no cambia nada", async () => {
    const { client, db } = makePreMigrationDb();
    await applyMigration0037CashPeriodPaymentChildren(client);
    const before = links(db);
    const second = await applyMigration0037CashPeriodPaymentChildren(client);
    expect(second.alreadyApplied).toBe(true);
    expect(second.backfilledRows).toBe(0);
    expect(links(db)).toEqual(before);
  });

  test("re-ejecutarla con un lote MIXTO ya creado no vincula sus cuotas comunes ni aborta", async () => {
    const { client, db } = makePreMigrationDb();
    await applyMigration0037CashPeriodPaymentChildren(client);
    // Lote mixto posterior a 0037: contado 8 (refacturación 11) con su cuota vinculada + una cuota común sin vínculo.
    db.run(`INSERT INTO rebillings (id, policy_id) VALUES (11, 1)`);
    db.run(`INSERT INTO policy_installments (id, policy_id, rebilling_id, amount) VALUES (103, 1, 11, 10000), (202, 2, NULL, 5000)`);
    db.run(`INSERT INTO payment_batches (id, total_received_cents) VALUES (3, 1400000)`);
    db.run(`INSERT INTO cash_period_payments (id, payment_batch_id, policy_id, rebilling_id, cash_amount_cents) VALUES (8, 3, 1, 11, 900000)`);
    db.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id, cash_period_payment_id) VALUES
      (4000, 1, 10000, 103, 3, 8), (4001, 2, 5000, 202, 3, NULL)`);
    const again = await applyMigration0037CashPeriodPaymentChildren(client);
    expect(again.backfilledRows).toBe(0);
    expect(again.alreadyApplied).toBe(true);
    expect(links(db)[4001]).toBe(null);
    // El .sql suelto tampoco la toca.
    const { readFileSync } = await import("fs");
    const sql = readFileSync(join(import.meta.dir, "..", "migrations", "0037_cash_period_payment_children.sql"), "utf8");
    const backfill = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean).pop()!;
    db.run(backfill);
    expect(links(db)[4001]).toBe(null);
  });

  test("un hijo de contado que no es cuota de su período aborta todo y no vincula nada (rollback)", async () => {
    const { client, db } = makePreMigrationDb();
    // Dato histórico inconsistente: un hijo del lote del contado apunta a una cuota de la póliza 2.
    db.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id) VALUES (1003, 2, 5000, 201, 1)`);
    await expect(applyMigration0037CashPeriodPaymentChildren(client)).rejects.toThrow(/no corresponden a una cuota de su período/);
    const cols = db.query("PRAGMA table_info(payments)").all() as any[];
    expect(cols.some((c) => c.name === "cash_period_payment_id")).toBe(false);
  });

  test("un hijo de contado sin cuota también aborta", async () => {
    const { client, db } = makePreMigrationDb();
    db.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id) VALUES (1004, 1, 1, NULL, 1)`);
    await expect(applyMigration0037CashPeriodPaymentChildren(client)).rejects.toThrow(/Migración 0037 abortada/);
  });

  test("el .sql de 0037 ejecutado tal cual (como en los runners) produce el mismo vínculo", async () => {
    const { db } = makePreMigrationDb();
    const { readFileSync } = await import("fs");
    const sql = readFileSync(join(import.meta.dir, "..", "migrations", "0037_cash_period_payment_children.sql"), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) db.run(stmt);
    expect(links(db)).toEqual({ 1000: 7, 1001: 7, 1002: 7, 2000: null, 3000: null });
  });
});
