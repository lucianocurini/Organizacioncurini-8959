/**
 * Etapa 1B-3-D — tests de loadAccountHolderFundingCajaImpact
 * (account-holder-funding-caja-loader.ts): partición legacy/titular +
 * resolución del impacto en Caja de las funding allocations, contra DB real.
 *
 * Harness: @libsql/client + drizzle-orm/libsql en modo archivo temporal
 * (mkdtempSync) — mismo criterio que account-holder-funding-batch.test.ts:
 * nunca dev.db, nunca Turso. Esquema mínimo a mano (users/insureds/
 * payment_batches/payment_batch_splits/payments/cash_entries/
 * insured_account_movements/payment_amount_adjustments) + el aplicador REAL
 * de la migración 0036 para payment_batch_funding_allocations y la columna
 * account_holder_insured_id — nunca un DDL de esas dos cosas hecho a mano.
 * `rendered` en payments/cash_entries se agrega a mano (migración anterior a
 * la 0036, fuera del alcance de applyMigration0036AccountHolderFunding).
 */

import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadAccountHolderFundingCajaImpact,
  loadAccountMovementCajaTotals,
  AccountHolderFundingCajaLoaderError,
  type AccountHolderCajaMovementRow,
  type AccountHolderCajaAdjustmentRow,
} from "../account-holder-funding-caja-loader";
import { applyMigration0036AccountHolderFunding } from "../../lib/migrations/apply-0036-account-holder-funding";
import type { Sql0036Client } from "../../lib/migrations/apply-0036-account-holder-funding";

// ─── Harness ────────────────────────────────────────────────────────────

let tmpDir: string | null = null;
let client: Client | null = null;
let db: any;
let userId: number;
let insuredId: number;

/** Cola de limpieza diferida — mismo patrón que account-holder-funding-batch.test.ts. */
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

async function createSchema(c: Client): Promise<void> {
  await c.execute(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  await c.execute(`CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  await c.execute(`
    CREATE TABLE payment_batches (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      insured_id             INTEGER REFERENCES insureds(id),
      base_amount_cents      INTEGER NOT NULL,
      surcharge_amount_cents INTEGER NOT NULL DEFAULT 0,
      total_received_cents   INTEGER NOT NULL,
      payment_date           TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'confirmado',
      created_by             INTEGER REFERENCES users(id),
      created_at             INTEGER,
      received_amount_cents  INTEGER
    )
  `);
  await c.execute(`
    CREATE TABLE payment_batch_splits (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id     INTEGER NOT NULL REFERENCES payment_batches(id),
      method       TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      created_at   INTEGER
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
  await c.execute(`
    CREATE TABLE payments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id       INTEGER REFERENCES payment_batches(id),
      amount         REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_date   TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'confirmado',
      rendered       INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER
    )
  `);
  await c.execute(`
    CREATE TABLE cash_entries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name    TEXT NOT NULL,
      amount         REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_date   TEXT NOT NULL,
      entry_type     TEXT NOT NULL DEFAULT 'normal',
      payment_id     INTEGER REFERENCES payments(id),
      status         TEXT NOT NULL DEFAULT 'activo',
      rendered       INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER
    )
  `);
  // Migración 0034 (subconjunto que lee el loader; sin FKs a policies/rebillings,
  // que este esquema mínimo no tiene).
  await c.execute(`
    CREATE TABLE cash_period_payments (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_batch_id       INTEGER NOT NULL REFERENCES payment_batches(id),
      policy_id              INTEGER NOT NULL,
      nominal_amount_cents   INTEGER NOT NULL,
      cash_amount_cents      INTEGER NOT NULL,
      discount_amount_cents  INTEGER NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'confirmado',
      rendered               INTEGER NOT NULL DEFAULT 0,
      created_by             INTEGER NOT NULL REFERENCES users(id),
      created_at             INTEGER NOT NULL
    )
  `);

  await applyMigration0036AccountHolderFunding(c as unknown as Sql0036Client);
}

async function seedUserAndInsured(c: Client): Promise<{ userId: number; insuredId: number }> {
  const u = await c.execute(`INSERT INTO users (name) VALUES ('QA Loader') RETURNING id`);
  const i = await c.execute(`INSERT INTO insureds (name) VALUES ('QA Titular') RETURNING id`);
  return { userId: Number(u.rows[0]!.id), insuredId: Number(i.rows[0]!.id) };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ahf-caja-loader-"));
  const dbPath = join(tmpDir, "test.db");
  client = createClient({ url: `file:${dbPath}` });
  await createSchema(client);
  const seeded = await seedUserAndInsured(client);
  userId = seeded.userId;
  insuredId = seeded.insuredId;
  db = drizzle(client);
});

beforeEach(async () => {
  await client!.execute(`DELETE FROM payment_batch_funding_allocations`);
  await client!.execute(`DELETE FROM account_holder_funding_idempotency_keys`);
  await client!.execute(`DELETE FROM payment_amount_adjustments`);
  await client!.execute(`DELETE FROM insured_account_movements`);
  await client!.execute(`DELETE FROM cash_entries`);
  await client!.execute(`DELETE FROM payments`);
  await client!.execute(`DELETE FROM payment_batch_splits`);
  await client!.execute(`DELETE FROM cash_period_payments`);
  await client!.execute(`DELETE FROM payment_batches`);
});

afterAll(async () => {
  client?.close();
  client = null;
  if (!tmpDir) return;
  const dir = tmpDir;
  tmpDir = null;

  // Pequeño respiro inicial — en Windows el handle del archivo puede tardar
  // un instante en liberarse después de close().
  await new Promise((resolve) => setTimeout(resolve, 50));

  const ok = await rmDirWithRetries(dir, 30, 200);
  if (ok) return;

  deferredCleanupDirs.push(dir);
  const finalOk = await rmDirWithRetries(dir, 15, 400);
  if (finalOk) {
    deferredCleanupDirs.pop();
    return;
  }

  console.error(
    `[account-holder-funding-caja-loader.test.ts] No se pudo eliminar el directorio temporal tras reintentos: ${dir}. Requiere limpieza manual. Cola de pendientes: ${JSON.stringify(deferredCleanupDirs)}`
  );
});

// ─── Fixture builders ───────────────────────────────────────────────────

async function mkBatch(params: { accountHolderInsuredId?: number | null; status?: "confirmado" | "anulado" }): Promise<number> {
  const r = await client!.execute({
    sql: `INSERT INTO payment_batches (insured_id, base_amount_cents, total_received_cents, payment_date, status, created_by, account_holder_insured_id)
          VALUES (?, 100000, 100000, '2027-01-01', ?, ?, ?) RETURNING id`,
    args: [insuredId, params.status ?? "confirmado", userId, params.accountHolderInsuredId ?? null],
  });
  return Number(r.rows[0]!.id);
}

async function mkPayment(params: { batchId?: number | null; rendered?: 0 | 1; status?: string }): Promise<number> {
  const r = await client!.execute({
    sql: `INSERT INTO payments (batch_id, amount, payment_method, payment_date, status, rendered) VALUES (?, 1000, 'lote', '2027-01-01', ?, ?) RETURNING id`,
    args: [params.batchId ?? null, params.status ?? "confirmado", params.rendered ?? 0],
  });
  return Number(r.rows[0]!.id);
}

async function mkCashEntry(params: { paymentId?: number | null; rendered?: 0 | 1 }): Promise<number> {
  const r = await client!.execute({
    sql: `INSERT INTO cash_entries (client_name, amount, payment_method, payment_date, entry_type, payment_id, rendered) VALUES ('QA', 8, 'lote', '2027-01-01', 'pronto_pago_surcharge', ?, ?) RETURNING id`,
    args: [params.paymentId ?? null, params.rendered ?? 0],
  });
  return Number(r.rows[0]!.id);
}

async function mkMovement(params: {
  type: string; signedAmountCents: number; status?: "activo" | "anulado"; originBatchId?: number | null; relatedPaymentId?: number | null;
}): Promise<AccountHolderCajaMovementRow> {
  const r = await client!.execute({
    sql: `INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, status, origin_batch_id, related_payment_id, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [insuredId, params.type, params.signedAmountCents, params.status ?? "activo", params.originBatchId ?? null, params.relatedPaymentId ?? null, userId, Date.now()],
  });
  const id = Number(r.rows[0]!.id);
  return {
    id, type: params.type, status: params.status ?? "activo", signedAmountCents: params.signedAmountCents,
    originBatchId: params.originBatchId ?? null, relatedPaymentId: params.relatedPaymentId ?? null,
  };
}

async function mkAdjustment(params: { amountCents: number; paymentBatchId?: number | null }): Promise<AccountHolderCajaAdjustmentRow> {
  const r = await client!.execute({
    sql: `INSERT INTO payment_amount_adjustments (payment_batch_id, amount_cents, reason, authorized_by, created_by, created_at)
          VALUES (?, ?, 'QA', ?, ?, ?) RETURNING id`,
    args: [params.paymentBatchId ?? null, params.amountCents, userId, userId, Date.now()],
  });
  const id = Number(r.rows[0]!.id);
  return { id, paymentBatchId: params.paymentBatchId ?? null, amountCents: params.amountCents };
}

async function mkAllocation(params: {
  paymentBatchId: number;
  sourceAccountMovementId?: number | null;
  paymentAmountAdjustmentId?: number | null;
  paymentId?: number | null;
  cashEntryId?: number | null;
  amountCents: number;
}): Promise<number> {
  const r = await client!.execute({
    sql: `INSERT INTO payment_batch_funding_allocations
          (payment_batch_id, source_account_movement_id, payment_amount_adjustment_id, payment_id, cash_entry_id, amount_cents, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [
      params.paymentBatchId, params.sourceAccountMovementId ?? null, params.paymentAmountAdjustmentId ?? null,
      params.paymentId ?? null, params.cashEntryId ?? null, params.amountCents, userId, Date.now(),
    ],
  });
  return Number(r.rows[0]!.id);
}

const ZERO_TITULAR = { creditoActivoEnCajaCents: 0, debtRenderedExpenseCents: 0, roundingRenderedExpenseCents: 0 };

// ─── 1. Caja legacy permanece idéntica ──────────────────────────────────

describe("1. movimientos/ajustes sin batch titular (legacy)", () => {
  test("originBatchId null: siempre legacy, titular en 0", async () => {
    const m = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 5000, originBatchId: null });
    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [m], adjustments: [] });
    expect(result.legacyMovements).toEqual([m]);
    expect(result.titular).toEqual(ZERO_TITULAR);
  });

  test("batch sin accountHolderInsuredId (legacy sobrantes/faltantes): siempre legacy", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: null });
    const m = await mkMovement({ type: "saldo_deudor", signedAmountCents: -4000, originBatchId: batchId });
    const adj = await mkAdjustment({ amountCents: 300, paymentBatchId: batchId });
    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [m], adjustments: [adj] });
    expect(result.legacyMovements).toEqual([m]);
    expect(result.legacyAdjustments).toEqual([adj]);
    expect(result.titular).toEqual(ZERO_TITULAR);
  });
});

// ─── 2. allocation activa pendiente/rendida ─────────────────────────────

describe("2. allocation titular activa — pendiente vs rendida", () => {
  test("crédito consumido, destino NO rendido: no aporta a Caja, movimiento excluido de legacyMovements", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const credit = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -10000, originBatchId: batchId });
    const destPayment = await mkPayment({ batchId, rendered: 0 });
    await mkAllocation({ paymentBatchId: batchId, sourceAccountMovementId: credit.id, paymentId: destPayment, amountCents: 10000 });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [credit], adjustments: [] });
    expect(result.legacyMovements).toEqual([]);
    expect(result.titular.creditoActivoEnCajaCents).toBe(0);
  });

  test("crédito consumido, destino YA rendido: resta de Caja", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const credit = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -10000, originBatchId: batchId });
    const destPayment = await mkPayment({ batchId, rendered: 1 });
    await mkAllocation({ paymentBatchId: batchId, sourceAccountMovementId: credit.id, paymentId: destPayment, amountCents: 10000 });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [credit], adjustments: [] });
    expect(result.titular.creditoActivoEnCajaCents).toBe(-10000);
  });

  test("saldo_a_favor NUEVO titular activo: suma directo a creditoActivoEnCajaCents, sin allocation propia", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const newCredit = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 7000, originBatchId: batchId });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [newCredit], adjustments: [] });
    expect(result.legacyMovements).toEqual([]);
    expect(result.titular.creditoActivoEnCajaCents).toBe(7000);
  });

  test("destino cash_entry (pronto_pago) rendido: crédito consumido resta igual que un payment", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const credit = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -800, originBatchId: batchId });
    const hostPayment = await mkPayment({ batchId, rendered: 1 });
    const destCash = await mkCashEntry({ paymentId: hostPayment, rendered: 1 });
    await mkAllocation({ paymentBatchId: batchId, sourceAccountMovementId: credit.id, cashEntryId: destCash, amountCents: 800 });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [credit], adjustments: [] });
    expect(result.titular.creditoActivoEnCajaCents).toBe(-800);
  });
});

// ─── 3. rendición parcial ────────────────────────────────────────────────

describe("3. rendición parcial — mismo movimiento financia 2 destinos", () => {
  test("un solo aplicacion_saldo_favor con 2 allocations, 1 rendida y 1 no: solo la rendida resta", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const credit = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -15000, originBatchId: batchId });
    const p1 = await mkPayment({ batchId, rendered: 1 });
    const p2 = await mkPayment({ batchId, rendered: 0 });
    await mkAllocation({ paymentBatchId: batchId, sourceAccountMovementId: credit.id, paymentId: p1, amountCents: 6000 });
    await mkAllocation({ paymentBatchId: batchId, sourceAccountMovementId: credit.id, paymentId: p2, amountCents: 9000 });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [credit], adjustments: [] });
    expect(result.titular.creditoActivoEnCajaCents).toBe(-6000);
  });

  test("saldo_deudor con 2 destinos, 1 rendido y 1 no: solo el rendido genera gasto", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const debt = await mkMovement({ type: "saldo_deudor", signedAmountCents: -20000, originBatchId: batchId });
    const p1 = await mkPayment({ batchId, rendered: 1 });
    const p2 = await mkPayment({ batchId, rendered: 0 });
    await mkAllocation({ paymentBatchId: batchId, sourceAccountMovementId: debt.id, paymentId: p1, amountCents: 12000 });
    await mkAllocation({ paymentBatchId: batchId, sourceAccountMovementId: debt.id, paymentId: p2, amountCents: 8000 });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [debt], adjustments: [] });
    expect(result.titular.debtRenderedExpenseCents).toBe(12000);
  });
});

// ─── 4. batch titular anulado aporta 0 ──────────────────────────────────

describe("4. batch titular anulado", () => {
  test("batch anulado: crédito consumido rendido NO resta (parentActive=false lo ignora entero)", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId, status: "anulado" });
    const credit = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -10000, status: "anulado", originBatchId: batchId });
    const destPayment = await mkPayment({ batchId, rendered: 1, status: "anulado" });
    await mkAllocation({ paymentBatchId: batchId, sourceAccountMovementId: credit.id, paymentId: destPayment, amountCents: 10000 });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [credit], adjustments: [] });
    expect(result.titular).toEqual(ZERO_TITULAR);
    expect(result.legacyMovements).toEqual([]); // sigue clasificado como titular (por dueño), solo que ignorado — nunca migra a legacy
  });

  test("batch anulado: saldo_a_favor nuevo, aunque siga status=activo en la fila, no cuenta (batch ya no confirmado)", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId, status: "anulado" });
    const newCredit = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 5000, status: "activo", originBatchId: batchId });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [newCredit], adjustments: [] });
    expect(result.titular.creditoActivoEnCajaCents).toBe(0);
  });

  test("batch anulado: ajuste de redondeo rendido no resta (rounding_adjustment sin status propio, depende solo del batch)", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId, status: "anulado" });
    const adj = await mkAdjustment({ amountCents: -300, paymentBatchId: batchId });
    const destPayment = await mkPayment({ batchId, rendered: 1, status: "anulado" });
    await mkAllocation({ paymentBatchId: batchId, paymentAmountAdjustmentId: adj.id, paymentId: destPayment, amountCents: 300 });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [], adjustments: [adj] });
    expect(result.titular.roundingRenderedExpenseCents).toBe(0);
  });
});

// ─── 5. movimiento fuente anulado aporta 0 ──────────────────────────────

describe("5. movimiento fuente anulado (batch sigue confirmado)", () => {
  test("aplicacion_saldo_favor anulado individualmente: ignorado aunque el batch siga confirmado", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId, status: "confirmado" });
    const credit = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -10000, status: "anulado", originBatchId: batchId });
    const destPayment = await mkPayment({ batchId, rendered: 1 });
    await mkAllocation({ paymentBatchId: batchId, sourceAccountMovementId: credit.id, paymentId: destPayment, amountCents: 10000 });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [credit], adjustments: [] });
    expect(result.titular).toEqual(ZERO_TITULAR);
  });

  test("saldo_deudor anulado individualmente: ignorado aunque el batch siga confirmado", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId, status: "confirmado" });
    const debt = await mkMovement({ type: "saldo_deudor", signedAmountCents: -5000, status: "anulado", originBatchId: batchId });
    const destPayment = await mkPayment({ batchId, rendered: 1 });
    await mkAllocation({ paymentBatchId: batchId, sourceAccountMovementId: debt.id, paymentId: destPayment, amountCents: 5000 });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [debt], adjustments: [] });
    expect(result.titular.debtRenderedExpenseCents).toBe(0);
  });
});

// ─── 6. mezcla legacy + titular sin doble conteo ────────────────────────

describe("6. mezcla legacy + titular en la misma llamada", () => {
  test("un movimiento legacy y uno titular con el mismo type: cada uno en su bucket, sin mezclarse", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null });
    const titularBatchId = await mkBatch({ accountHolderInsuredId: insuredId });

    const legacyCredit = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -3000, originBatchId: legacyBatchId });
    const titularCredit = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -9000, originBatchId: titularBatchId });
    const destPayment = await mkPayment({ batchId: titularBatchId, rendered: 1 });
    await mkAllocation({ paymentBatchId: titularBatchId, sourceAccountMovementId: titularCredit.id, paymentId: destPayment, amountCents: 9000 });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [legacyCredit, titularCredit], adjustments: [] });

    expect(result.legacyMovements).toEqual([legacyCredit]); // el titular NUNCA aparece acá — evita doble conteo si el caller lo pasara a calculateCreditActiveInCaja
    expect(result.titular.creditoActivoEnCajaCents).toBe(-9000);
  });

  test("legacy y titular con saldo_a_favor simultáneo: cada total se calcula por su cuenta, la suma final (responsabilidad del caller) no duplica nada", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null });
    const titularBatchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const legacyNewCredit = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 4000, originBatchId: legacyBatchId });
    const titularNewCredit = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 6000, originBatchId: titularBatchId });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [legacyNewCredit, titularNewCredit], adjustments: [] });
    expect(result.legacyMovements).toEqual([legacyNewCredit]);
    expect(result.titular.creditoActivoEnCajaCents).toBe(6000);
  });
});

// ─── 7. deuda y redondeo impactan solo al rendir ────────────────────────

describe("7. deuda y redondeo — 0 mientras pendiente, gasto real al rendir", () => {
  test("saldo_deudor titular pendiente: debtRenderedExpenseCents en 0", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const debt = await mkMovement({ type: "saldo_deudor", signedAmountCents: -5000, originBatchId: batchId });
    const destPayment = await mkPayment({ batchId, rendered: 0 });
    await mkAllocation({ paymentBatchId: batchId, sourceAccountMovementId: debt.id, paymentId: destPayment, amountCents: 5000 });

    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [debt], adjustments: [] });
    expect(result.titular.debtRenderedExpenseCents).toBe(0);
  });

  test("rounding_adjustment titular pendiente: roundingRenderedExpenseCents en 0; rendido: gasto real", async () => {
    const batchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const adjPending = await mkAdjustment({ amountCents: -200, paymentBatchId: batchId });
    const pendingDest = await mkPayment({ batchId, rendered: 0 });
    await mkAllocation({ paymentBatchId: batchId, paymentAmountAdjustmentId: adjPending.id, paymentId: pendingDest, amountCents: 200 });

    const resultPending = await loadAccountHolderFundingCajaImpact(db, { movements: [], adjustments: [adjPending] });
    expect(resultPending.titular.roundingRenderedExpenseCents).toBe(0);

    const batchId2 = await mkBatch({ accountHolderInsuredId: insuredId });
    const adjRendered = await mkAdjustment({ amountCents: -450, paymentBatchId: batchId2 });
    const renderedDest = await mkPayment({ batchId: batchId2, rendered: 1 });
    await mkAllocation({ paymentBatchId: batchId2, paymentAmountAdjustmentId: adjRendered.id, paymentId: renderedDest, amountCents: 450 });

    const resultRendered = await loadAccountHolderFundingCajaImpact(db, { movements: [], adjustments: [adjRendered] });
    expect(resultRendered.titular.roundingRenderedExpenseCents).toBe(450);
  });
});

// ─── 8. adjustments legacy nunca se confunden con titulares ────────────

describe("8. adjustments legacy vs titulares", () => {
  test("ajuste legacy (positivo, sobrante real) va a legacyAdjustments, nunca se procesa como titular", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null });
    const legacyAdj = await mkAdjustment({ amountCents: 350, paymentBatchId: legacyBatchId }); // positivo: sobrante real legacy
    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [], adjustments: [legacyAdj] });
    expect(result.legacyAdjustments).toEqual([legacyAdj]);
    expect(result.titular).toEqual(ZERO_TITULAR);
  });
});

// ─── 9. validación estricta / errores de cableado ───────────────────────

describe("9. validación de forma y errores de cableado", () => {
  test("movements/adjustments no-array lanza AccountHolderFundingCajaLoaderError", async () => {
    await expect(loadAccountHolderFundingCajaImpact(db, { movements: null as any, adjustments: [] })).rejects.toThrow(AccountHolderFundingCajaLoaderError);
    await expect(loadAccountHolderFundingCajaImpact(db, { movements: [], adjustments: undefined as any })).rejects.toThrow(AccountHolderFundingCajaLoaderError);
  });

  test("sin movimientos ni ajustes: todo vacío, sin ninguna query de allocations", async () => {
    const result = await loadAccountHolderFundingCajaImpact(db, { movements: [], adjustments: [] });
    expect(result).toEqual({ legacyMovements: [], legacyAdjustments: [], titular: ZERO_TITULAR });
  });
});

// ─── 10. loadAccountMovementCajaTotals — combinación final, la única
// función que index.ts llama para las 6 cifras de GET /cash/summary ──────

const ZERO_TOTALS = {
  creditoActivoEnCajaCents: 0, creditoRegularizadoCents: 0, cobrosSaldoDeudorCents: 0,
  roundingAdjustmentCreditCents: 0, titularDebtExpenseCents: 0, titularRoundingExpenseCents: 0,
};

describe("10. loadAccountMovementCajaTotals — legacy sin cambios", () => {
  test("vacío: todo en 0", async () => {
    const result = await loadAccountMovementCajaTotals(db, { movements: [], adjustments: [] });
    expect(result).toEqual(ZERO_TOTALS);
  });

  test("saldo_a_favor legacy activo: suma a creditoActivoEnCajaCents, igual que antes de esta etapa", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null });
    const m = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 12000, originBatchId: legacyBatchId });
    const result = await loadAccountMovementCajaTotals(db, { movements: [m], adjustments: [] });
    expect(result.creditoActivoEnCajaCents).toBe(12000);
  });

  test("aplicacion_saldo_favor legacy con relatedPaymentId rendido: resta creditoActivoEnCajaCents (mismo criterio legacy de siempre)", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null });
    const relatedPayment = await mkPayment({ rendered: 1 });
    const m = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -5000, originBatchId: legacyBatchId, relatedPaymentId: relatedPayment });
    const result = await loadAccountMovementCajaTotals(db, { movements: [m], adjustments: [] });
    expect(result.creditoActivoEnCajaCents).toBe(-5000);
  });

  test("aplicacion_saldo_favor legacy con relatedPaymentId NO rendido: no resta (crédito sigue activo)", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null });
    const relatedPayment = await mkPayment({ rendered: 0 });
    const m = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -5000, originBatchId: legacyBatchId, relatedPaymentId: relatedPayment });
    const result = await loadAccountMovementCajaTotals(db, { movements: [m], adjustments: [] });
    expect(result.creditoActivoEnCajaCents).toBe(0);
  });

  test("ajuste_manual legacy que reduce crédito: resta creditoActivoEnCajaCents y aparece igual en creditoRegularizadoCents", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null });
    const m = await mkMovement({ type: "ajuste_manual", signedAmountCents: -2000, originBatchId: legacyBatchId });
    const result = await loadAccountMovementCajaTotals(db, { movements: [m], adjustments: [] });
    expect(result.creditoActivoEnCajaCents).toBe(-2000);
    expect(result.creditoRegularizadoCents).toBe(2000);
  });

  test("cobro_saldo_deudor legacy: suma cobrosSaldoDeudorCents", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null });
    const m = await mkMovement({ type: "cobro_saldo_deudor", signedAmountCents: 3000, originBatchId: legacyBatchId });
    const result = await loadAccountMovementCajaTotals(db, { movements: [m], adjustments: [] });
    expect(result.cobrosSaldoDeudorCents).toBe(3000);
  });

  test("ajuste de redondeo legacy positivo (sobrante real), batch confirmado: suma roundingAdjustmentCreditCents", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null, status: "confirmado" });
    const adj = await mkAdjustment({ amountCents: 300, paymentBatchId: legacyBatchId });
    const result = await loadAccountMovementCajaTotals(db, { movements: [], adjustments: [adj] });
    expect(result.roundingAdjustmentCreditCents).toBe(300);
  });

  test("ajuste de redondeo legacy positivo, batch anulado: no suma (parentActive=false)", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null, status: "anulado" });
    const adj = await mkAdjustment({ amountCents: 300, paymentBatchId: legacyBatchId });
    const result = await loadAccountMovementCajaTotals(db, { movements: [], adjustments: [adj] });
    expect(result.roundingAdjustmentCreditCents).toBe(0);
  });

  test("ajuste de redondeo de un contado: suma mientras no se rindió; rendido entero, deja de sumar (sus allocations ya llevan el sobrante)", async () => {
    const pendingBatchId = await mkBatch({ accountHolderInsuredId: null, status: "confirmado" });
    const renderedBatchId = await mkBatch({ accountHolderInsuredId: null, status: "confirmado" });
    const now = Date.now();
    for (const [batchId, rendered] of [[pendingBatchId, 0], [renderedBatchId, 1]] as const) {
      await client!.execute({
        sql: `INSERT INTO cash_period_payments (payment_batch_id, policy_id, nominal_amount_cents, cash_amount_cents, discount_amount_cents, status, rendered, created_by, created_at)
              VALUES (?, 1, 40000000, 38000000, 2000000, 'confirmado', ?, ?, ?)`,
        args: [batchId, rendered, userId, now],
      });
    }
    const pendingAdj = await mkAdjustment({ amountCents: 300, paymentBatchId: pendingBatchId });
    const renderedAdj = await mkAdjustment({ amountCents: 500, paymentBatchId: renderedBatchId });

    const result = await loadAccountMovementCajaTotals(db, { movements: [], adjustments: [pendingAdj, renderedAdj] });
    expect(result.roundingAdjustmentCreditCents).toBe(300);
  });
});

describe("11. loadAccountMovementCajaTotals — titular combinado con legacy, sin doble conteo", () => {
  test("crédito titular rendido resta SOLO del lado titular, el legacy no se entera y viceversa", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null });
    const legacyNewCredit = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 20000, originBatchId: legacyBatchId });

    const titularBatchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const titularCredit = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -9000, originBatchId: titularBatchId });
    const destPayment = await mkPayment({ batchId: titularBatchId, rendered: 1 });
    await mkAllocation({ paymentBatchId: titularBatchId, sourceAccountMovementId: titularCredit.id, paymentId: destPayment, amountCents: 9000 });

    const result = await loadAccountMovementCajaTotals(db, { movements: [legacyNewCredit, titularCredit], adjustments: [] });
    // 20000 (legacy, sin condición) − 9000 (titular, ya rendido) — nunca se mezclan las reglas de cada modelo.
    expect(result.creditoActivoEnCajaCents).toBe(11000);
  });

  test("deuda y redondeo titulares SOLO restan cuando están rendidos; el crédito legacy no se ve afectado", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null });
    const legacyCredit = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 50000, originBatchId: legacyBatchId });

    const titularBatchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const debt = await mkMovement({ type: "saldo_deudor", signedAmountCents: -4000, originBatchId: titularBatchId });
    const debtDest = await mkPayment({ batchId: titularBatchId, rendered: 1 });
    await mkAllocation({ paymentBatchId: titularBatchId, sourceAccountMovementId: debt.id, paymentId: debtDest, amountCents: 4000 });

    const adj = await mkAdjustment({ amountCents: -150, paymentBatchId: titularBatchId });
    const adjDest = await mkPayment({ batchId: titularBatchId, rendered: 0 }); // redondeo pendiente: no resta todavía
    await mkAllocation({ paymentBatchId: titularBatchId, paymentAmountAdjustmentId: adj.id, paymentId: adjDest, amountCents: 150 });

    const result = await loadAccountMovementCajaTotals(db, { movements: [legacyCredit, debt], adjustments: [adj] });
    expect(result.creditoActivoEnCajaCents).toBe(50000); // intacto — deuda/redondeo nunca tocan esta cifra
    expect(result.titularDebtExpenseCents).toBe(4000);
    expect(result.titularRoundingExpenseCents).toBe(0); // todavía pendiente
  });

  test("mezcla completa: legacy + titular activos simultáneamente reproduce la fórmula esperada, sin restos", async () => {
    const legacyBatchId = await mkBatch({ accountHolderInsuredId: null });
    const legacyAdj = await mkAdjustment({ amountCents: 250, paymentBatchId: legacyBatchId });
    const legacyDebtPayment = await mkPayment({});
    const legacyCredit = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -1000, originBatchId: legacyBatchId, relatedPaymentId: legacyDebtPayment });

    const titularBatchId = await mkBatch({ accountHolderInsuredId: insuredId });
    const titularNewCredit = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 6000, originBatchId: titularBatchId });

    const result = await loadAccountMovementCajaTotals(db, {
      movements: [legacyCredit, titularNewCredit],
      adjustments: [legacyAdj],
    });

    expect(result.roundingAdjustmentCreditCents).toBe(250); // legacy, batch confirmado
    expect(result.creditoActivoEnCajaCents).toBe(0 + 6000); // legacyCredit no rendido (0) + titular nuevo activo (6000)
    expect(result.titularDebtExpenseCents).toBe(0);
    expect(result.titularRoundingExpenseCents).toBe(0);
  });
});
