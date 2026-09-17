/**
 * Etapa 1B-3-E — tests de payment-batch-shared-inserts.ts contra DB real
 * (SQLite temporal aislado, nunca dev.db/Turso). Estos son los MISMOS
 * inserts que ahora ejecuta POST /payment-batches — tanto en su camino
 * legacy (accountHolderInsuredId omitido) como en su rama titular — así que
 * cubrirlos acá es, a la vez, la regresión legacy focalizada pedida (el
 * endpoint real ya no tiene una implementación propia de estos pasos que
 * pueda divergir) y la base de los tests de integración titular en
 * payment-batch-titular-integration.test.ts.
 */

import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  insertPaymentBatchRow, checkInstallmentPaymentRace, insertBatchSplitsAndChecks, insertBatchChildren,
  PaymentBatchRaceConditionError, type SplitWithChecksForInsert, type BatchChildContextForInsert,
} from "../payment-batch-shared-inserts";
import { applyMigration0036AccountHolderFunding } from "../../lib/migrations/apply-0036-account-holder-funding";
import type { Sql0036Client } from "../../lib/migrations/apply-0036-account-holder-funding";
import type { BatchItemContext } from "../../lib/payments/batches";

let tmpDir: string | null = null;
let client: Client | null = null;
let db: any;
let userId: number;
let insuredId: number;
let policyId: number;

const deferredCleanupDirs: string[] = [];
async function rmDirWithRetries(dir: string, attempts: number, delayMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt === attempts - 1) return false;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

const FIXTURE_DATE = "2028-01-15";

async function createSchema(c: Client): Promise<void> {
  await c.execute(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  await c.execute(`CREATE TABLE companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  await c.execute(`CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  await c.execute(`
    CREATE TABLE policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_number TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'activa',
      company_id INTEGER NOT NULL REFERENCES companies(id),
      insured_id INTEGER NOT NULL REFERENCES insureds(id),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      is_rebilling INTEGER NOT NULL DEFAULT 0,
      parent_policy_id INTEGER
    )
  `);
  await c.execute(`
    CREATE TABLE policy_installments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL REFERENCES policies(id),
      number INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendiente',
      rendered INTEGER NOT NULL DEFAULT 0
    )
  `);
  await c.execute(`
    CREATE TABLE payment_batches (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      insured_id             INTEGER REFERENCES insureds(id),
      base_amount_cents      INTEGER NOT NULL,
      surcharge_amount_cents INTEGER NOT NULL DEFAULT 0,
      total_received_cents   INTEGER NOT NULL,
      payment_date           TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'confirmado',
      notes                  TEXT,
      created_by             INTEGER REFERENCES users(id),
      created_at             INTEGER,
      updated_at             INTEGER,
      cancelled_at           INTEGER,
      cancelled_by           INTEGER,
      cancellation_reason    TEXT,
      received_amount_cents  INTEGER
    )
  `);
  await c.execute(`
    CREATE TABLE payment_batch_splits (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id     INTEGER NOT NULL REFERENCES payment_batches(id),
      method       TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      notes        TEXT,
      created_at   INTEGER
    )
  `);
  await c.execute(`
    CREATE TABLE received_checks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_split_id   INTEGER REFERENCES payment_batch_splits(id),
      payment_split_id INTEGER,
      check_number     TEXT NOT NULL,
      bank_name        TEXT NOT NULL,
      bank_code        TEXT,
      drawer_name      TEXT,
      drawer_document  TEXT,
      issue_date       TEXT,
      due_date         TEXT NOT NULL,
      amount_cents     INTEGER NOT NULL,
      currency         TEXT NOT NULL DEFAULT 'ARS',
      status           TEXT NOT NULL DEFAULT 'en_cartera',
      notes            TEXT,
      received_at      INTEGER NOT NULL,
      delivered_at     INTEGER,
      cleared_at       INTEGER,
      rejected_at      INTEGER,
      cancelled_at     INTEGER,
      created_by       INTEGER REFERENCES users(id),
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    )
  `);
  await c.execute(`
    CREATE TABLE payments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id      INTEGER REFERENCES policies(id),
      manual_payer   TEXT,
      manual_policy_number TEXT,
      manual_company TEXT,
      amount         REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_date   TEXT NOT NULL,
      period_month   TEXT,
      notes          TEXT,
      status         TEXT NOT NULL DEFAULT 'confirmado',
      rendered       INTEGER NOT NULL DEFAULT 0,
      rendered_at    INTEGER,
      installment_id INTEGER REFERENCES policy_installments(id),
      due_date       TEXT,
      created_by     INTEGER REFERENCES users(id),
      created_at     INTEGER,
      batch_id       INTEGER REFERENCES payment_batches(id)
    )
  `);
  await c.execute(`
    CREATE TABLE cash_entries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name    TEXT NOT NULL,
      policy_number  TEXT,
      company_name   TEXT,
      amount         REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_date   TEXT NOT NULL,
      due_date       TEXT,
      entry_type     TEXT NOT NULL DEFAULT 'normal',
      payment_id     INTEGER REFERENCES payments(id),
      status         TEXT NOT NULL DEFAULT 'activo',
      rendered       INTEGER NOT NULL DEFAULT 0,
      rendered_at    INTEGER,
      voided_at      INTEGER,
      notes          TEXT,
      created_by     INTEGER REFERENCES users(id),
      created_at     INTEGER
    )
  `);
  await c.execute(`
    CREATE TABLE insured_account_movements (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      insured_id              INTEGER NOT NULL REFERENCES insureds(id),
      type                    TEXT NOT NULL,
      signed_amount_cents     INTEGER NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'activo',
      origin_payment_id       INTEGER,
      origin_batch_id         INTEGER,
      related_payment_id      INTEGER,
      related_installment_id  INTEGER,
      reason                  TEXT,
      authorized_by           INTEGER REFERENCES users(id),
      created_by              INTEGER NOT NULL REFERENCES users(id),
      created_at              INTEGER NOT NULL,
      settled_at              INTEGER,
      notes                   TEXT
    )
  `);
  await c.execute(`
    CREATE TABLE payment_amount_adjustments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id       INTEGER,
      payment_batch_id INTEGER REFERENCES payment_batches(id),
      amount_cents     INTEGER NOT NULL,
      reason           TEXT NOT NULL,
      authorized_by    INTEGER NOT NULL REFERENCES users(id),
      created_by       INTEGER NOT NULL REFERENCES users(id),
      created_at       INTEGER NOT NULL
    )
  `);

  await applyMigration0036AccountHolderFunding(c as unknown as Sql0036Client);
}

async function seedFixtures(c: Client): Promise<{ userId: number; insuredId: number; companyId: number; policyId: number }> {
  const u = await c.execute(`INSERT INTO users (name) VALUES ('QA Shared Inserts') RETURNING id`);
  const i = await c.execute(`INSERT INTO insureds (name) VALUES ('QA Insured') RETURNING id`);
  const co = await c.execute(`INSERT INTO companies (name) VALUES ('QA Company') RETURNING id`);
  const p = await c.execute({
    sql: `INSERT INTO policies (policy_number, type, status, company_id, insured_id, start_date, end_date) VALUES (?, 'automotor', 'activa', ?, ?, ?, ?) RETURNING id`,
    args: [`QA-POL-${Date.now()}`, Number(co.rows[0]!.id), Number(i.rows[0]!.id), "2028-01-01", "2028-12-31"],
  });
  return { userId: Number(u.rows[0]!.id), insuredId: Number(i.rows[0]!.id), companyId: Number(co.rows[0]!.id), policyId: Number(p.rows[0]!.id) };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pb-shared-inserts-"));
  const dbPath = join(tmpDir, "test.db");
  client = createClient({ url: `file:${dbPath}` });
  await createSchema(client);
  const seeded = await seedFixtures(client);
  userId = seeded.userId;
  insuredId = seeded.insuredId;
  policyId = seeded.policyId;
  db = drizzle(client);
});

beforeEach(async () => {
  await client!.execute(`DELETE FROM payment_batch_funding_allocations`);
  await client!.execute(`DELETE FROM account_holder_funding_idempotency_keys`);
  await client!.execute(`DELETE FROM payment_amount_adjustments`);
  await client!.execute(`DELETE FROM insured_account_movements`);
  await client!.execute(`DELETE FROM cash_entries`);
  await client!.execute(`DELETE FROM received_checks`);
  await client!.execute(`DELETE FROM payments`);
  await client!.execute(`DELETE FROM payment_batch_splits`);
  await client!.execute(`DELETE FROM payment_batches`);
  await client!.execute(`DELETE FROM policy_installments`);
});

afterAll(async () => {
  client?.close();
  client = null;
  if (!tmpDir) return;
  const dir = tmpDir;
  tmpDir = null;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const ok = await rmDirWithRetries(dir, 30, 200);
  if (ok) return;
  deferredCleanupDirs.push(dir);
  const finalOk = await rmDirWithRetries(dir, 15, 400);
  if (finalOk) {
    deferredCleanupDirs.pop();
    return;
  }
  console.error(`[payment-batch-shared-inserts.test.ts] No se pudo eliminar el directorio temporal: ${dir}. Cola: ${JSON.stringify(deferredCleanupDirs)}`);
}, 20000); // El presupuesto de reintentos (hasta ~12s en Windows) puede superar el timeout default de bun:test (5s) para el propio hook.

async function mkInstallment(amount: number, dueDate = "2028-02-01"): Promise<number> {
  const r = await client!.execute({
    sql: `INSERT INTO policy_installments (policy_id, number, due_date, amount) VALUES (?, 1, ?, ?) RETURNING id`,
    args: [policyId, dueDate, amount],
  });
  return Number(r.rows[0]!.id);
}

function installmentCtx(installmentId: number, amount: number): BatchItemContext {
  return {
    kind: "installment", installmentId, policyId, insuredId, amount,
    installmentStatus: "pendiente", rendered: 0, policyStatus: "activa", isRivadavia: true,
    policyType: "automotor", parentPolicyId: null, description: null,
    manualPayer: null, manualPolicyNumber: null, manualCompany: null,
  };
}

function manualCtx(amount: number): BatchItemContext {
  return {
    kind: "manual_payment", installmentId: null, policyId: null, insuredId: null, amount,
    installmentStatus: null, rendered: null, policyStatus: null, isRivadavia: false,
    policyType: null, parentPolicyId: null, description: "cobro manual QA",
    manualPayer: "QA Manual Payer", manualPolicyNumber: null, manualCompany: null,
  };
}

const DISPLAY = { insuredName: "QA Insured", policyNumber: "QA-POL", companyName: "QA Company" };

// ─── 1. insertPaymentBatchRow ────────────────────────────────────────────

describe("1. insertPaymentBatchRow", () => {
  test("legacy (accountHolderInsuredId omitido): batch sin titular", async () => {
    const batch = await db.transaction(async (tx: any) => insertPaymentBatchRow(tx, {
      insuredId, baseAmountCents: 100000, surchargeAmountCents: 0, totalReceivedCents: 100000,
      receivedAmountCents: 100000, paymentDate: FIXTURE_DATE, notes: null, createdBy: userId,
    }));
    expect(batch.accountHolderInsuredId).toBeNull();
    expect(batch.status).toBe("confirmado");
    expect(batch.id).toBeGreaterThan(0);
  });

  test("titular: accountHolderInsuredId persiste tal cual", async () => {
    const batch = await db.transaction(async (tx: any) => insertPaymentBatchRow(tx, {
      insuredId, baseAmountCents: 100000, surchargeAmountCents: 0, totalReceivedCents: 100000,
      receivedAmountCents: 100000, paymentDate: FIXTURE_DATE, notes: "titular notes", createdBy: userId,
      accountHolderInsuredId: insuredId,
    }));
    expect(batch.accountHolderInsuredId).toBe(insuredId);
  });

  test("notes se persiste exactamente como se pasó (sin recortar acá — la normalización es responsabilidad del caller)", async () => {
    const batch = await db.transaction(async (tx: any) => insertPaymentBatchRow(tx, {
      insuredId: null, baseAmountCents: 5000, surchargeAmountCents: 0, totalReceivedCents: 5000,
      receivedAmountCents: 5000, paymentDate: FIXTURE_DATE, notes: "  ya recortado  ", createdBy: userId,
    }));
    const row = await client!.execute({ sql: `SELECT notes FROM payment_batches WHERE id = ?`, args: [batch.id] });
    expect(row.rows[0]!.notes).toBe("  ya recortado  ");
  });
});

// ─── 2. checkInstallmentPaymentRace ──────────────────────────────────────

describe("2. checkInstallmentPaymentRace", () => {
  test("sin pagos confirmados previos: no lanza", async () => {
    const installmentId = await mkInstallment(1000);
    await expect(db.transaction(async (tx: any) => checkInstallmentPaymentRace(tx, [installmentId]))).resolves.toBeUndefined();
  });

  test("array vacío: no lanza, sin ninguna query", async () => {
    await expect(db.transaction(async (tx: any) => checkInstallmentPaymentRace(tx, []))).resolves.toBeUndefined();
  });

  test("cuota ya con un payment confirmado (carrera real): PaymentBatchRaceConditionError con el id bloqueante", async () => {
    const installmentId = await mkInstallment(1000);
    await client!.execute({
      sql: `INSERT INTO payments (installment_id, amount, payment_method, payment_date, status) VALUES (?, 1000, 'efectivo', ?, 'confirmado')`,
      args: [installmentId, FIXTURE_DATE],
    });
    await expect(
      db.transaction(async (tx: any) => checkInstallmentPaymentRace(tx, [installmentId]))
    ).rejects.toThrow(PaymentBatchRaceConditionError);
  });

  test("cuota con un payment ANULADO (no confirmado): no bloquea", async () => {
    const installmentId = await mkInstallment(1000);
    await client!.execute({
      sql: `INSERT INTO payments (installment_id, amount, payment_method, payment_date, status) VALUES (?, 1000, 'efectivo', ?, 'anulado')`,
      args: [installmentId, FIXTURE_DATE],
    });
    await expect(db.transaction(async (tx: any) => checkInstallmentPaymentRace(tx, [installmentId]))).resolves.toBeUndefined();
  });
});

// ─── 3. insertBatchSplitsAndChecks ───────────────────────────────────────

describe("3. insertBatchSplitsAndChecks", () => {
  test("splits sin cheques: ids en el mismo orden que la entrada", async () => {
    const batch = await db.transaction(async (tx: any) => insertPaymentBatchRow(tx, {
      insuredId, baseAmountCents: 100000, surchargeAmountCents: 0, totalReceivedCents: 100000,
      receivedAmountCents: 100000, paymentDate: FIXTURE_DATE, notes: null, createdBy: userId,
    }));
    const swc: SplitWithChecksForInsert[] = [
      { split: { method: "efectivo", amountCents: 60000, notes: null }, checks: [] },
      { split: { method: "transferencia", amountCents: 40000, notes: null }, checks: [] },
    ];
    const ids = await db.transaction(async (tx: any) => insertBatchSplitsAndChecks(tx, batch.id, swc, userId));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2); // ids reales distintos
  });

  test("split cheque con 2 cheques: se insertan ambos, vinculados al split real", async () => {
    const batch = await db.transaction(async (tx: any) => insertPaymentBatchRow(tx, {
      insuredId, baseAmountCents: 50000, surchargeAmountCents: 0, totalReceivedCents: 50000,
      receivedAmountCents: 50000, paymentDate: FIXTURE_DATE, notes: null, createdBy: userId,
    }));
    const swc: SplitWithChecksForInsert[] = [{
      split: { method: "cheque", amountCents: 50000, notes: null },
      checks: [
        { checkNumber: "1001", bankName: "Banco QA", bankCode: null, drawerName: null, drawerDocument: null, issueDate: null, dueDate: "2028-03-01", amountCents: 30000, currency: "ARS", notes: null },
        { checkNumber: "1002", bankName: "Banco QA", bankCode: null, drawerName: null, drawerDocument: null, issueDate: null, dueDate: "2028-03-01", amountCents: 20000, currency: "ARS", notes: null },
      ],
    }];
    const [splitId] = await db.transaction(async (tx: any) => insertBatchSplitsAndChecks(tx, batch.id, swc, userId));
    const checksRes = await client!.execute({ sql: `SELECT * FROM received_checks WHERE batch_split_id = ?`, args: [splitId!] });
    expect(checksRes.rows).toHaveLength(2);
    expect(checksRes.rows.every((r: any) => r.status === "en_cartera")).toBe(true);
  });
});

// ─── 4. insertBatchChildren ───────────────────────────────────────────────

describe("4. insertBatchChildren", () => {
  test("un solo ítem installment sin recargo: singleChildId seteado, cuota pasa a pagada", async () => {
    const installmentId = await mkInstallment(1000);
    const batch = await db.transaction(async (tx: any) => insertPaymentBatchRow(tx, {
      insuredId, baseAmountCents: 100000, surchargeAmountCents: 0, totalReceivedCents: 100000,
      receivedAmountCents: 100000, paymentDate: FIXTURE_DATE, notes: null, createdBy: userId,
    }));
    const items: BatchChildContextForInsert[] = [{ ctxItem: installmentCtx(installmentId, 1000), display: DISPLAY, hasSurcharge: false }];
    const result = await db.transaction(async (tx: any) => insertBatchChildren(tx, batch.id, items, FIXTURE_DATE, userId));
    expect(result.childIds).toHaveLength(1);
    expect(result.singleChildId).toBe(result.childIds[0]);
    expect(result.cashEntryIdByIndex.size).toBe(0);

    const installmentRow = await client!.execute({ sql: `SELECT status FROM policy_installments WHERE id = ?`, args: [installmentId] });
    expect(installmentRow.rows[0]!.status).toBe("pagada"); // recalculateInstallmentPaymentStatus se ejecutó de verdad
  });

  test("2+ ítems: singleChildId null (ambigüedad real, mismo criterio legacy)", async () => {
    const i1 = await mkInstallment(1000);
    const i2 = await mkInstallment(2000);
    const batch = await db.transaction(async (tx: any) => insertPaymentBatchRow(tx, {
      insuredId, baseAmountCents: 300000, surchargeAmountCents: 0, totalReceivedCents: 300000,
      receivedAmountCents: 300000, paymentDate: FIXTURE_DATE, notes: null, createdBy: userId,
    }));
    const items: BatchChildContextForInsert[] = [
      { ctxItem: installmentCtx(i1, 1000), display: DISPLAY, hasSurcharge: false },
      { ctxItem: installmentCtx(i2, 2000), display: DISPLAY, hasSurcharge: false },
    ];
    const result = await db.transaction(async (tx: any) => insertBatchChildren(tx, batch.id, items, FIXTURE_DATE, userId));
    expect(result.childIds).toHaveLength(2);
    expect(result.singleChildId).toBeNull();
  });

  test("ítem con hasSurcharge=true: cash_entry de recargo Pronto Pago creado y vinculado", async () => {
    const installmentId = await mkInstallment(1000);
    const batch = await db.transaction(async (tx: any) => insertPaymentBatchRow(tx, {
      insuredId, baseAmountCents: 100000, surchargeAmountCents: 80000, totalReceivedCents: 180000,
      receivedAmountCents: 180000, paymentDate: FIXTURE_DATE, notes: null, createdBy: userId,
    }));
    const items: BatchChildContextForInsert[] = [{ ctxItem: installmentCtx(installmentId, 1000), display: DISPLAY, hasSurcharge: true }];
    const result = await db.transaction(async (tx: any) => insertBatchChildren(tx, batch.id, items, FIXTURE_DATE, userId));
    expect(result.cashEntryIdByIndex.size).toBe(1);
    const cashEntryId = result.cashEntryIdByIndex.get(0);
    const entryRes = await client!.execute({ sql: `SELECT * FROM cash_entries WHERE id = ?`, args: [cashEntryId!] });
    expect(entryRes.rows[0]!.entry_type).toBe("pronto_pago_surcharge");
    expect(entryRes.rows[0]!.amount).toBe(800); // SURCHARGE_AMOUNT_CENTS/100
    expect(entryRes.rows[0]!.payment_id).toBe(result.childIds[0]);
  });

  test("cobro manual (sin installmentId): payment hijo con manualPayer, sin recalculateInstallmentPaymentStatus", async () => {
    const batch = await db.transaction(async (tx: any) => insertPaymentBatchRow(tx, {
      insuredId: null, baseAmountCents: 5000, surchargeAmountCents: 0, totalReceivedCents: 5000,
      receivedAmountCents: 5000, paymentDate: FIXTURE_DATE, notes: null, createdBy: userId,
    }));
    const items: BatchChildContextForInsert[] = [{ ctxItem: manualCtx(50), display: DISPLAY, hasSurcharge: false }];
    const result = await db.transaction(async (tx: any) => insertBatchChildren(tx, batch.id, items, FIXTURE_DATE, userId));
    const childRes = await client!.execute({ sql: `SELECT * FROM payments WHERE id = ?`, args: [result.childIds[0]!] });
    expect(childRes.rows[0]!.manual_payer).toBe("QA Manual Payer");
    expect(childRes.rows[0]!.installment_id).toBeNull();
  });
});
