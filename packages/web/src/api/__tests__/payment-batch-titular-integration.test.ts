/**
 * Etapa 1B-3-E — tests de integración del modo titular de
 * POST /payment-batches contra DB real (SQLite temporal aislado, nunca
 * dev.db/Turso). Usa EXACTAMENTE el mismo cableado que el endpoint real
 * (buildTitularFundingInput/buildTitularFundingDependencies +
 * runAccountHolderFundingBatch, sin ninguna reimplementación) — esto es lo
 * más cerca de un test end-to-end del handler real que se puede lograr sin
 * abrir la conexión de database/index.ts (que apuntaría a dev.db). No hay
 * ningún test HTTP contra app.fetch en este archivo — nunca se afirma haber
 * probado el endpoint real por HTTP.
 */

import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildTitularFundingInput, buildTitularFundingDependencies } from "../payment-batch-titular-dependencies";
import { runAccountHolderFundingBatch, FundingIdempotencyConflictError } from "../account-holder-funding-batch";
import { formatAccountHolderFundingBatchSuccess, mapAccountHolderFundingBatchError } from "../payment-batch-titular-response";
import { AccountHolderFundingPlanError } from "../../lib/payments/account-holder-funding-plan";
import { parseFundingRequest, AccountHolderFundingRequestError } from "../../lib/payments/account-holder-funding-request";
import { calculateApplicableRivadaviaSurcharges, calculateBaseAmountCents, calculateBatchTotals, resolveBatchSplitGroup } from "../../lib/payments/batches";
import { findPossibleCheckDuplicates, type ExistingCheckForDuplicateCheck } from "../../lib/payments/received-checks";
import { applyMigration0036AccountHolderFunding } from "../../lib/migrations/apply-0036-account-holder-funding";
import type { Sql0036Client } from "../../lib/migrations/apply-0036-account-holder-funding";
import type { BatchItemContext } from "../../lib/payments/batches";
import type { SplitWithChecksForInsert } from "../payment-batch-shared-inserts";

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
      id INTEGER PRIMARY KEY AUTOINCREMENT, policy_number TEXT NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'activa', company_id INTEGER NOT NULL REFERENCES companies(id),
      insured_id INTEGER NOT NULL REFERENCES insureds(id), start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      is_rebilling INTEGER NOT NULL DEFAULT 0, parent_policy_id INTEGER
    )
  `);
  await c.execute(`
    CREATE TABLE policy_installments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, policy_id INTEGER NOT NULL REFERENCES policies(id),
      number INTEGER NOT NULL, due_date TEXT NOT NULL, amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendiente', rendered INTEGER NOT NULL DEFAULT 0
    )
  `);
  await c.execute(`
    CREATE TABLE payment_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, insured_id INTEGER REFERENCES insureds(id),
      base_amount_cents INTEGER NOT NULL, surcharge_amount_cents INTEGER NOT NULL DEFAULT 0,
      total_received_cents INTEGER NOT NULL, payment_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmado', notes TEXT, created_by INTEGER REFERENCES users(id),
      created_at INTEGER, updated_at INTEGER, cancelled_at INTEGER, cancelled_by INTEGER,
      cancellation_reason TEXT, received_amount_cents INTEGER
    )
  `);
  await c.execute(`
    CREATE TABLE payment_batch_splits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL REFERENCES payment_batches(id),
      method TEXT NOT NULL, amount_cents INTEGER NOT NULL, notes TEXT, created_at INTEGER
    )
  `);
  await c.execute(`
    CREATE TABLE received_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_split_id INTEGER REFERENCES payment_batch_splits(id),
      payment_split_id INTEGER, check_number TEXT NOT NULL, bank_name TEXT NOT NULL, bank_code TEXT,
      drawer_name TEXT, drawer_document TEXT, issue_date TEXT, due_date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'ARS', status TEXT NOT NULL DEFAULT 'en_cartera',
      notes TEXT, received_at INTEGER NOT NULL, delivered_at INTEGER, cleared_at INTEGER, rejected_at INTEGER,
      cancelled_at INTEGER, created_by INTEGER REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )
  `);
  await c.execute(`
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, policy_id INTEGER REFERENCES policies(id), manual_payer TEXT,
      manual_policy_number TEXT, manual_company TEXT, amount REAL NOT NULL, payment_method TEXT NOT NULL,
      payment_date TEXT NOT NULL, period_month TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'confirmado',
      rendered INTEGER NOT NULL DEFAULT 0, rendered_at INTEGER, installment_id INTEGER REFERENCES policy_installments(id),
      due_date TEXT, created_by INTEGER REFERENCES users(id), created_at INTEGER, batch_id INTEGER REFERENCES payment_batches(id)
    )
  `);
  await c.execute(`
    CREATE TABLE cash_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_name TEXT NOT NULL, policy_number TEXT, company_name TEXT,
      amount REAL NOT NULL, payment_method TEXT NOT NULL, payment_date TEXT NOT NULL, due_date TEXT,
      entry_type TEXT NOT NULL DEFAULT 'normal', payment_id INTEGER REFERENCES payments(id),
      status TEXT NOT NULL DEFAULT 'activo', rendered INTEGER NOT NULL DEFAULT 0, rendered_at INTEGER,
      voided_at INTEGER, notes TEXT, created_by INTEGER REFERENCES users(id), created_at INTEGER
    )
  `);
  await c.execute(`
    CREATE TABLE insured_account_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, insured_id INTEGER NOT NULL REFERENCES insureds(id), type TEXT NOT NULL,
      signed_amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'activo', origin_payment_id INTEGER,
      origin_batch_id INTEGER, related_payment_id INTEGER, related_installment_id INTEGER, reason TEXT,
      authorized_by INTEGER REFERENCES users(id), created_by INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL, settled_at INTEGER, notes TEXT
    )
  `);
  await c.execute(`
    CREATE TABLE payment_amount_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id INTEGER, payment_batch_id INTEGER REFERENCES payment_batches(id),
      amount_cents INTEGER NOT NULL, reason TEXT NOT NULL, authorized_by INTEGER NOT NULL REFERENCES users(id),
      created_by INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
    )
  `);

  await applyMigration0036AccountHolderFunding(c as unknown as Sql0036Client);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pb-titular-"));
  const dbPath = join(tmpDir, "test.db");
  client = createClient({ url: `file:${dbPath}` });
  await createSchema(client);

  const u = await client.execute(`INSERT INTO users (name) VALUES ('QA Titular Integration') RETURNING id`);
  const i = await client.execute(`INSERT INTO insureds (name) VALUES ('QA Titular') RETURNING id`);
  const co = await client.execute(`INSERT INTO companies (name) VALUES ('QA Company') RETURNING id`);
  const p = await client.execute({
    sql: `INSERT INTO policies (policy_number, type, status, company_id, insured_id, start_date, end_date) VALUES (?, 'automotor', 'activa', ?, ?, '2028-01-01', '2028-12-31') RETURNING id`,
    args: [`QA-POL-${Date.now()}`, Number(co.rows[0]!.id), Number(i.rows[0]!.id)],
  });
  userId = Number(u.rows[0]!.id);
  insuredId = Number(i.rows[0]!.id);
  policyId = Number(p.rows[0]!.id);
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
  console.error(`[payment-batch-titular-integration.test.ts] No se pudo eliminar el directorio temporal: ${dir}. Cola: ${JSON.stringify(deferredCleanupDirs)}`);
}, 20000); // Este archivo hace MUCHAS más escrituras que otros harnesses con el mismo patrón — el presupuesto de reintentos (hasta ~12s en Windows) puede superar el timeout default de bun:test (5s) para el propio hook.

async function mkInstallment(amount: number, dueDate = "2028-02-01"): Promise<number> {
  const r = await client!.execute({
    sql: `INSERT INTO policy_installments (policy_id, number, due_date, amount) VALUES (?, 1, ?, ?) RETURNING id`,
    args: [policyId, dueDate, amount],
  });
  return Number(r.rows[0]!.id);
}

function installmentCtx(installmentId: number, amount: number, isRivadavia = false): BatchItemContext {
  return {
    kind: "installment", installmentId, policyId, insuredId, amount,
    installmentStatus: "pendiente", rendered: 0, policyStatus: "activa", isRivadavia,
    policyType: "automotor", parentPolicyId: null, description: null,
    manualPayer: null, manualPolicyNumber: null, manualCompany: null,
  };
}

const DISPLAY = { insuredName: "QA Titular", policyNumber: "QA-POL", companyName: "QA Company" };

async function insertActiveCredit(amountCents: number): Promise<number> {
  const r = await client!.execute({
    sql: `INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, status, created_by, created_at) VALUES (?, 'saldo_a_favor', ?, 'activo', ?, ?) RETURNING id`,
    args: [insuredId, amountCents, userId, Date.now()],
  });
  return Number(r.rows[0]!.id);
}

/**
 * Construye y ejecuta un batch titular EXACTAMENTE como lo hace el endpoint
 * real — mismo orden de pasos, mismas funciones reusadas (batches.ts +
 * payment-batch-titular-dependencies.ts + runAccountHolderFundingBatch).
 */
async function runTitularBatch(params: {
  items: BatchItemContext[];
  splitsWithChecks: SplitWithChecksForInsert[];
  idempotencyKey: string;
  creditAppliedCents?: number;
  roundingCoverageCents?: number;
  debtAuthorized?: boolean;
  debtReason?: string | null;
  requestFingerprint?: string; // override para simular "misma key, fingerprint distinto"
  dbOverride?: any;
}) {
  const contexts = params.items;
  const displays = contexts.map(() => DISPLAY);
  const splitGroup = resolveBatchSplitGroup(params.splitsWithChecks.map((s) => s.split));
  const applicableSurchargeSet = new Set(calculateApplicableRivadaviaSurcharges(contexts, splitGroup));
  const baseAmountCents = calculateBaseAmountCents(contexts);
  const surchargeAmountCents = applicableSurchargeSet.size * 80000;
  const totals = calculateBatchTotals(baseAmountCents, surchargeAmountCents);
  const receivedCents = params.splitsWithChecks.reduce((s, x) => s + x.split.amountCents, 0);
  const installmentIds = contexts.filter((c) => c.kind === "installment").map((c) => c.installmentId!);

  const { destinations, realSplits, childInsertItems } = buildTitularFundingInput({
    contexts, displays, applicableSurchargeContexts: applicableSurchargeSet, splitsWithChecks: params.splitsWithChecks,
  });
  const dependencies = buildTitularFundingDependencies({
    derivedInsuredId: insuredId,
    baseAmountCents: totals.baseAmountCents,
    surchargeAmountCents: totals.surchargeAmountCents,
    totalReceivedCents: totals.totalReceivedCents,
    receivedCents,
    paymentDate: FIXTURE_DATE,
    notes: null,
    createdBy: userId,
    accountHolderInsuredId: insuredId,
    installmentIds,
    splitsWithChecks: params.splitsWithChecks,
    childInsertItems,
  });

  return runAccountHolderFundingBatch({
    db: params.dbOverride ?? db,
    createdBy: userId,
    idempotencyKey: params.idempotencyKey,
    requestFingerprint: params.requestFingerprint ?? `fp-${params.idempotencyKey}`,
    accountHolderInsuredId: insuredId,
    paymentDate: FIXTURE_DATE,
    destinations,
    realSplits,
    creditAppliedCents: params.creditAppliedCents ?? 0,
    roundingCoverageCents: params.roundingCoverageCents ?? 0,
    debtAuthorized: params.debtAuthorized ?? false,
    debtReason: params.debtReason ?? null,
    dependencies,
  });
}

async function countRows(table: string): Promise<number> {
  const r = await client!.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0]!.c);
}

// ─── 1. Titular exitoso: crédito + medios reales + redondeo ────────────

describe("1. titular exitoso — crédito + medios reales + redondeo", () => {
  test("una cuota financiada con crédito + efectivo + redondeo, cierra exacto", async () => {
    await insertActiveCredit(30000);
    const installmentId = await mkInstallment(1000); // $1000 = 100000 centavos
    const items = [installmentCtx(installmentId, 1000)];
    // nominal 100000 = credit 30000 + rounding 300 (tope $5=500) + cash real (splits)
    const splitsWithChecks: SplitWithChecksForInsert[] = [
      { split: { method: "efectivo", amountCents: 69700, notes: null }, checks: [] },
    ];

    const result = await runTitularBatch({
      items, splitsWithChecks, idempotencyKey: "qa-titular-1",
      creditAppliedCents: 30000, roundingCoverageCents: 300,
    });

    expect(result.responseStatus).toBe(201);
    expect(JSON.parse(result.responseSnapshot)).toEqual({ id: result.paymentBatchId });

    const batchRow = await client!.execute({ sql: `SELECT * FROM payment_batches WHERE id = ?`, args: [result.paymentBatchId] });
    expect(batchRow.rows[0]!.account_holder_insured_id).toBe(insuredId);
    expect(batchRow.rows[0]!.received_amount_cents).toBe(69700);
    expect(batchRow.rows[0]!.total_received_cents).toBe(100000);

    const allocRows = await client!.execute({ sql: `SELECT * FROM payment_batch_funding_allocations WHERE payment_batch_id = ?`, args: [result.paymentBatchId] });
    expect(allocRows.rows.length).toBeGreaterThan(0);

    const movementRows = await client!.execute({ sql: `SELECT * FROM insured_account_movements WHERE origin_batch_id = ?`, args: [result.paymentBatchId] });
    const creditMovement = movementRows.rows.find((r: any) => r.type === "aplicacion_saldo_favor");
    expect(creditMovement).toBeTruthy();
    expect((creditMovement as any).signed_amount_cents).toBe(-30000);

    const roundingRows = await client!.execute({ sql: `SELECT * FROM payment_amount_adjustments WHERE payment_batch_id = ?`, args: [result.paymentBatchId] });
    expect(roundingRows.rows).toHaveLength(1);
    expect((roundingRows.rows[0] as any).amount_cents).toBe(-300);
  });
});

// ─── 2. Múltiples items/splits + Pronto Pago ─────────────────────────────

describe("2. titular con múltiples items/splits y Pronto Pago", () => {
  test("2 cuotas Rivadavia (con recargo) + 2 splits reales, sin crédito ni deuda", async () => {
    const i1 = await mkInstallment(500);
    const i2 = await mkInstallment(700);
    const items = [installmentCtx(i1, 500, true), installmentCtx(i2, 700, true)];
    // nominal = 50000+70000 (base) + 80000+80000 (recargo x2, SURCHARGE_AMOUNT_CENTS=80000=$800) = 280000
    const splitsWithChecks: SplitWithChecksForInsert[] = [
      { split: { method: "efectivo", amountCents: 180000, notes: null }, checks: [] },
      { split: { method: "transferencia", amountCents: 100000, notes: null }, checks: [] },
    ];

    const result = await runTitularBatch({ items, splitsWithChecks, idempotencyKey: "qa-titular-2" });
    expect(result.responseStatus).toBe(201);

    const childRows = await client!.execute({ sql: `SELECT * FROM payments WHERE batch_id = ?`, args: [result.paymentBatchId] });
    expect(childRows.rows).toHaveLength(2);

    const cashEntryRows = await client!.execute({
      sql: `SELECT * FROM cash_entries WHERE entry_type = 'pronto_pago_surcharge' AND payment_id IN (${childRows.rows.map((r: any) => r.id).join(",")})`,
    });
    expect(cashEntryRows.rows).toHaveLength(2); // un recargo por cada cuota Rivadavia

    const splitRows = await client!.execute({ sql: `SELECT * FROM payment_batch_splits WHERE batch_id = ?`, args: [result.paymentBatchId] });
    expect(splitRows.rows).toHaveLength(2);
  });
});

// ─── 3. Deuda autorizada con motivo ──────────────────────────────────────

describe("3. deuda autorizada con motivo", () => {
  test("faltante real, debtAuthorized=true con debtReason: crea saldo_deudor, batch confirmado igual", async () => {
    const installmentId = await mkInstallment(1000);
    const items = [installmentCtx(installmentId, 1000)];
    const splitsWithChecks: SplitWithChecksForInsert[] = [{ split: { method: "efectivo", amountCents: 60000, notes: null }, checks: [] }]; // faltan 40000

    const result = await runTitularBatch({
      items, splitsWithChecks, idempotencyKey: "qa-titular-3",
      debtAuthorized: true, debtReason: "El cliente pagó parcial, resto a cuenta corriente",
    });

    expect(result.responseStatus).toBe(201);
    const debtRows = await client!.execute({ sql: `SELECT * FROM insured_account_movements WHERE origin_batch_id = ? AND type = 'saldo_deudor'`, args: [result.paymentBatchId] });
    expect(debtRows.rows).toHaveLength(1);
    expect((debtRows.rows[0] as any).signed_amount_cents).toBe(-40000);
    expect((debtRows.rows[0] as any).reason).toBe("El cliente pagó parcial, resto a cuenta corriente");
  });

  test("faltante real SIN debtAuthorized: AccountHolderFundingPlanError, cero escrituras", async () => {
    const installmentId = await mkInstallment(1000);
    const items = [installmentCtx(installmentId, 1000)];
    const splitsWithChecks: SplitWithChecksForInsert[] = [{ split: { method: "efectivo", amountCents: 60000, notes: null }, checks: [] }];

    const before = await countRows("payment_batches");
    await expect(runTitularBatch({ items, splitsWithChecks, idempotencyKey: "qa-titular-3b" })).rejects.toThrow(AccountHolderFundingPlanError);
    expect(await countRows("payment_batches")).toBe(before);
  });
});

// ─── 4. Crédito insuficiente: cero escrituras ────────────────────────────

describe("4. crédito insuficiente", () => {
  test("creditAppliedCents > saldo activo disponible: AccountHolderFundingPlanError, cero escrituras en ninguna tabla", async () => {
    await insertActiveCredit(1000); // solo $10 disponibles
    const installmentId = await mkInstallment(1000);
    const items = [installmentCtx(installmentId, 1000)];
    const splitsWithChecks: SplitWithChecksForInsert[] = [{ split: { method: "efectivo", amountCents: 90000, notes: null }, checks: [] }];

    const beforeBatches = await countRows("payment_batches");
    const beforeMovements = await countRows("insured_account_movements");
    const beforeIdempotency = await countRows("account_holder_funding_idempotency_keys");

    await expect(
      runTitularBatch({ items, splitsWithChecks, idempotencyKey: "qa-titular-4", creditAppliedCents: 50000 })
    ).rejects.toThrow(AccountHolderFundingPlanError);

    expect(await countRows("payment_batches")).toBe(beforeBatches);
    expect(await countRows("insured_account_movements")).toBe(beforeMovements); // el saldo_a_favor sembrado sigue siendo el único
    expect(await countRows("account_holder_funding_idempotency_keys")).toBe(beforeIdempotency);
  });
});

// ─── 5. Reintento misma key/fingerprint: mismo resultado, cero duplicados ─

describe("5. idempotencia — reintento exacto", () => {
  test("misma idempotencyKey y mismo requestFingerprint: devuelve el MISMO id/status/body, sin crear un segundo batch", async () => {
    const installmentId = await mkInstallment(1000);
    const items = [installmentCtx(installmentId, 1000)];
    const splitsWithChecks: SplitWithChecksForInsert[] = [{ split: { method: "efectivo", amountCents: 100000, notes: null }, checks: [] }];

    const first = await runTitularBatch({ items, splitsWithChecks, idempotencyKey: "qa-titular-5" });
    const batchesAfterFirst = await countRows("payment_batches");

    // Reintento: MISMOS items/splits (mismo fingerprint real, ya que
    // requestFingerprint se deriva de idempotencyKey en el helper — acá lo
    // fijamos explícito para que sea IDÉNTICO al primero).
    const second = await runTitularBatch({
      items, splitsWithChecks, idempotencyKey: "qa-titular-5", requestFingerprint: `fp-qa-titular-5`,
    });

    expect(second).toEqual(first);
    expect(await countRows("payment_batches")).toBe(batchesAfterFirst); // ningún batch nuevo
  });
});

// ─── 6. Misma key, fingerprint distinto: 409 ─────────────────────────────

describe("6. idempotencia — misma key, request distinta", () => {
  test("mismo idempotencyKey, requestFingerprint distinto: FundingIdempotencyConflictError", async () => {
    const installmentId = await mkInstallment(1000);
    const items = [installmentCtx(installmentId, 1000)];
    const splitsWithChecks: SplitWithChecksForInsert[] = [{ split: { method: "efectivo", amountCents: 100000, notes: null }, checks: [] }];

    await runTitularBatch({ items, splitsWithChecks, idempotencyKey: "qa-titular-6", requestFingerprint: "fp-original" });

    await expect(
      runTitularBatch({ items, splitsWithChecks, idempotencyKey: "qa-titular-6", requestFingerprint: "fp-distinto" })
    ).rejects.toThrow(FundingIdempotencyConflictError);
  });
});

// ─── 7. Cambio de saldo dentro de la transacción: rollback ───────────────

describe("7. cambio de saldo dentro de la transacción", () => {
  // Nota de diseño (ver el mismo caso ya documentado en
  // account-holder-funding-batch.test.ts, 1B-3-C2): con destinations/
  // realSplits/creditAppliedCents/roundingCoverageCents/debtAuthorized
  // fijos (mismo `planParams` reusado para el plan preliminar y el fresco,
  // ver runAccountHolderFundingBatch), el ÚNICO efecto posible de que el
  // saldo cambie entre ambas lecturas es el chequeo de techo "crédito
  // aplicado > disponible" — si el saldo baja lo suficiente como para
  // cruzar ese umbral, planAccountHolderBatchFunding revienta ANTES de
  // devolver ningún plan (AccountHolderFundingPlanError, nunca llega a
  // "cerrar" con un resultado distinto al preliminar); si el saldo cambia
  // pero sigue alcanzando, el plan fresco es byte-idéntico al preliminar
  // (misma entrada fija, función pura) y no hay nada que revalidar como
  // "distinto". assertFundingPlanUnchanged (FundingPlanRaceConditionError)
  // está armado para una discrepancia real en un plan que SÍ cierra — no
  // reproducible acá con una sola llamada y parámetros fijos; se mapea de
  // todos modos a 409 en payment-batch-titular-response.ts por si el
  // diseño de runAccountHolderFundingBatch cambia en el futuro.
  test("el saldo baja lo suficiente ENTRE el plan preliminar y la revalidación fresca (crédito ya no alcanza): AccountHolderFundingPlanError, rollback total", async () => {
    await insertActiveCredit(50000);
    const installmentId = await mkInstallment(1000);
    const items = [installmentCtx(installmentId, 1000)];
    const splitsWithChecks: SplitWithChecksForInsert[] = [{ split: { method: "efectivo", amountCents: 70000, notes: null }, checks: [] }];

    // db "saboteador": la primera vez que se abre una transacción, inserta
    // un movimiento que consume la MAYOR PARTE del crédito DESPUÉS del plan
    // preliminar (fuera de tx, ve $500 disponibles) pero ANTES de la
    // revalidación fresca (dentro de tx, ve solo $100 disponibles) —
    // determinista, sin locks ni timing real.
    let sabotaged = false;
    const sabotagingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (cb: any) => {
            if (!sabotaged) {
              sabotaged = true;
              await client!.execute({
                sql: `INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, status, created_by, created_at) VALUES (?, 'aplicacion_saldo_favor', -40000, 'activo', ?, ?)`,
                args: [insuredId, userId, Date.now()],
              });
            }
            return target.transaction(cb);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const beforeBatches = await countRows("payment_batches");
    const beforeMovements = await countRows("insured_account_movements");
    await expect(
      runTitularBatch({ items, splitsWithChecks, idempotencyKey: "qa-titular-7", creditAppliedCents: 30000, dbOverride: sabotagingDb })
    ).rejects.toThrow(AccountHolderFundingPlanError);
    expect(await countRows("payment_batches")).toBe(beforeBatches); // rollback total, ni el batch quedó
    expect(await countRows("insured_account_movements")).toBe(beforeMovements + 1); // el saboteador quedó (se escribió FUERA de la tx que falló), nada más
  });
});

// ─── 8. Error durante artifacts: rollback completo ───────────────────────

describe("8. error durante artifacts", () => {
  test("un mapeo incompleto en createChildRows revienta persistAccountHolderFundingArtifacts: rollback de batch/splits/hijos", async () => {
    const installmentId = await mkInstallment(1000);
    const items = [installmentCtx(installmentId, 1000)];
    const displays = items.map(() => DISPLAY);
    const splitsWithChecks: SplitWithChecksForInsert[] = [{ split: { method: "efectivo", amountCents: 100000, notes: null }, checks: [] }];
    const splitGroup = resolveBatchSplitGroup(splitsWithChecks.map((s) => s.split));
    const applicableSurchargeSet = new Set(calculateApplicableRivadaviaSurcharges(items, splitGroup));
    const baseAmountCents = calculateBaseAmountCents(items);
    const totals = calculateBatchTotals(baseAmountCents, 0);
    const receivedCents = 100000;

    const { destinations, realSplits, childInsertItems } = buildTitularFundingInput({
      contexts: items, displays, applicableSurchargeContexts: applicableSurchargeSet, splitsWithChecks,
    });
    const realDependencies = buildTitularFundingDependencies({
      derivedInsuredId: insuredId, baseAmountCents: totals.baseAmountCents, surchargeAmountCents: totals.surchargeAmountCents,
      totalReceivedCents: totals.totalReceivedCents, receivedCents, paymentDate: FIXTURE_DATE, notes: null,
      createdBy: userId, accountHolderInsuredId: insuredId, installmentIds: [installmentId], splitsWithChecks, childInsertItems,
    });
    const brokenDependencies = {
      ...realDependencies,
      createChildRows: async (tx: any, batch: any) => {
        const rows = await realDependencies.createChildRows(tx, batch);
        return { ...rows, paymentIdByKey: new Map() }; // rompe el mapeo a propósito
      },
    };

    const beforeBatches = await countRows("payment_batches");
    await expect(runAccountHolderFundingBatch({
      db, createdBy: userId, idempotencyKey: "qa-titular-8", requestFingerprint: "fp-qa-titular-8",
      accountHolderInsuredId: insuredId, paymentDate: FIXTURE_DATE, destinations, realSplits,
      creditAppliedCents: 0, roundingCoverageCents: 0, debtAuthorized: false, debtReason: null,
      dependencies: brokenDependencies as any,
    })).rejects.toThrow();
    expect(await countRows("payment_batches")).toBe(beforeBatches);
    expect(await countRows("payment_batch_splits")).toBe(0);
    expect(await countRows("payments")).toBe(0);
  });
});

// ─── 9. response snapshot corrupto / mapeo de errores end-to-end ─────────

describe("9. formato de respuesta y mapeo de errores — con resultados/errores reales de esta integración", () => {
  test("resultado exitoso real: formatAccountHolderFundingBatchSuccess devuelve {id} y 201", async () => {
    const installmentId = await mkInstallment(1000);
    const items = [installmentCtx(installmentId, 1000)];
    const splitsWithChecks: SplitWithChecksForInsert[] = [{ split: { method: "efectivo", amountCents: 100000, notes: null }, checks: [] }];
    const result = await runTitularBatch({ items, splitsWithChecks, idempotencyKey: "qa-titular-9" });
    const formatted = formatAccountHolderFundingBatchSuccess(result);
    expect(formatted).toEqual({ status: 201, body: { id: result.paymentBatchId } });
  });

  test("AccountHolderFundingPlanError real (crédito insuficiente) mapea a 400 vía mapAccountHolderFundingBatchError", async () => {
    await insertActiveCredit(100);
    const installmentId = await mkInstallment(1000);
    const items = [installmentCtx(installmentId, 1000)];
    const splitsWithChecks: SplitWithChecksForInsert[] = [{ split: { method: "efectivo", amountCents: 90000, notes: null }, checks: [] }];
    let caught: unknown;
    try {
      await runTitularBatch({ items, splitsWithChecks, idempotencyKey: "qa-titular-9b", creditAppliedCents: 10000 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AccountHolderFundingPlanError);
    expect(mapAccountHolderFundingBatchError(caught)?.status).toBe(400);
  });
});

// ─── 10. campos titulares sin titular: 400 (a nivel de parseFundingRequest, la misma función que usa el endpoint) ─

describe("10. campos titulares sin accountHolderInsuredId", () => {
  test("creditAppliedCents>0 sin accountHolderInsuredId: AccountHolderFundingRequestError (400 en el endpoint)", () => {
    const body = {
      paymentDate: FIXTURE_DATE,
      items: [{ source: "installment", installmentId: 1 }],
      splits: [{ method: "efectivo", amount: 1000 }],
      creditAppliedCents: 5000, // no neutro, sin accountHolderInsuredId
    };
    expect(() => parseFundingRequest(body)).toThrow(AccountHolderFundingRequestError);
  });

  test("debtAuthorized=true sin accountHolderInsuredId: AccountHolderFundingRequestError", () => {
    const body = {
      paymentDate: FIXTURE_DATE,
      items: [{ source: "installment", installmentId: 1 }],
      splits: [{ method: "efectivo", amount: 1000 }],
      debtAuthorized: true,
    };
    expect(() => parseFundingRequest(body)).toThrow(AccountHolderFundingRequestError);
  });

  test("idempotencyKey presente sin accountHolderInsuredId: AccountHolderFundingRequestError", () => {
    const body = {
      paymentDate: FIXTURE_DATE,
      items: [{ source: "installment", installmentId: 1 }],
      splits: [{ method: "efectivo", amount: 1000 }],
      idempotencyKey: "algo",
    };
    expect(() => parseFundingRequest(body)).toThrow(AccountHolderFundingRequestError);
  });

  test("body legacy normal (sin ningún campo titular): mode='legacy', sin exigir idempotencyKey", () => {
    const body = {
      paymentDate: FIXTURE_DATE,
      items: [{ source: "installment", installmentId: 1 }],
      splits: [{ method: "efectivo", amount: 1000 }],
    };
    const parsed = parseFundingRequest(body);
    expect(parsed.mode).toBe("legacy");
    expect(parsed.idempotencyKey).toBeNull();
  });
});

// ─── 11. Coexistencia prohibida con accountDifferenceResolution ─────────

describe("11. accountHolderInsuredId + accountDifferenceResolution son mutuamente excluyentes", () => {
  test("ambos presentes a la vez: AccountHolderFundingRequestError", () => {
    const body = {
      paymentDate: FIXTURE_DATE,
      items: [{ source: "installment", installmentId: 1 }],
      splits: [{ method: "efectivo", amount: 1000 }],
      accountHolderInsuredId: insuredId,
      idempotencyKey: "qa-mutex",
      accountDifferenceResolution: { action: "saldo_a_favor" },
    };
    expect(() => parseFundingRequest(body)).toThrow(AccountHolderFundingRequestError);
  });
});

// ─── 12. Advertencia por cheque duplicado — lógica pura, mismo orden que el endpoint ─

describe("12. detección de cheque duplicado (findPossibleCheckDuplicates) — reintento con la misma key", () => {
  test("cheque coincide banco+número con uno existente: se detecta como duplicado (el endpoint devolvería 409 SIN llamar a runAccountHolderFundingBatch)", () => {
    const existing: ExistingCheckForDuplicateCheck[] = [
      { id: 999, checkNumber: "5555", bankName: "Banco QA", amountCents: 100000, dueDate: "2028-03-01", drawerName: "Fulano" },
    ];
    const candidate = { checkNumber: "5555", bankName: "Banco QA", amountCents: 100000, dueDate: "2028-03-01", drawerName: "Fulano" };
    const matches = findPossibleCheckDuplicates(candidate, existing);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.strength).toBe("strong");
    // El endpoint, ante esto y confirmPossibleDuplicates!==true, retorna 409
    // ANTES de llamar a runAccountHolderFundingBatch — nada que limpiar acá,
    // ninguna escritura ocurrió (no se ejercita runTitularBatch en este caso).
  });

  test("reintento con confirmPossibleDuplicates=true y la MISMA idempotencyKey: el batch se crea normalmente (nada quedó escrito en el intento anterior que bloquee esto)", async () => {
    // Simula: el cheque "duplicado" ya existe de una operación ANTERIOR real
    // (no relacionada), y el batch titular de este test usa un cheque con
    // los mismos banco+número — el endpoint ya habría devuelto la
    // advertencia en un primer intento (sin persistir nada); acá se prueba
    // directamente el segundo intento (post-confirmación), que es el único
    // que efectivamente llama a runAccountHolderFundingBatch.
    const installmentId = await mkInstallment(1000);
    const items = [installmentCtx(installmentId, 1000)];
    const splitsWithChecks: SplitWithChecksForInsert[] = [{
      split: { method: "cheque", amountCents: 100000, notes: null },
      checks: [{
        checkNumber: "7777", bankName: "Banco QA Confirm", bankCode: null, drawerName: null, drawerDocument: null,
        issueDate: null, dueDate: "2028-03-01", amountCents: 100000, currency: "ARS", notes: null,
      }],
    }];

    const result = await runTitularBatch({ items, splitsWithChecks, idempotencyKey: "qa-titular-12" });
    expect(result.responseStatus).toBe(201);
    const checkRows = await client!.execute({ sql: `SELECT * FROM received_checks WHERE check_number = '7777'` });
    expect(checkRows.rows).toHaveLength(1); // un solo cheque insertado, sin duplicar
  });
});
