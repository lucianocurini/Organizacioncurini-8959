/**
 * Etapa 1B-3-B1 — tests de loadActiveAccountHolderBalanceCents /
 * planFundingWithFreshBalance / assertFundingPlanUnchanged.
 *
 * Harness DB: @libsql/client + drizzle-orm/libsql en modo archivo temporal
 * (mkdtempSync) — mismo driver que produce database/index.ts (nunca
 * bun:sqlite, para no depender de una particularidad ajena al driver real),
 * pero apuntado a un archivo descartable, nunca a dev.db ni a Turso.
 * Reutiliza el objeto real `insuredAccountMovements` de database/schema.ts
 * para que las consultas ejercitadas sean exactamente las mismas que
 * correrán en producción, no una reimplementación. Esquema mínimo creado a
 * mano (users/insureds/insured_account_movements, columnas de la migración
 * 0030 + 0036) — sin drizzle-kit, sin dev.db, sin Turso.
 *
 * ─── Una sola base compartida para todo el archivo ──────────────────────
 *
 * A diferencia de un client/directorio por test (que generaba 30 ciclos de
 * creación/borrado de archivos sqlite por corrida y disparaba EBUSY
 * intermitente en Windows), acá se crea UN único cliente+esquema en
 * beforeAll, se limpia insured_account_movements en beforeEach (aísla cada
 * test sin recrear nada), y se cierra+borra una sola vez en afterAll. Todos
 * los tests comparten el mismo insuredId/userId — están aislados porque la
 * tabla de movimientos queda vacía al empezar cada test. El único caso que
 * necesita un SEGUNDO asegurado ("no mezcla el saldo de otro asegurado") lo
 * crea con su propio INSERT...RETURNING id, sin asumir ningún valor de
 * autoincremento — insureds no se limpia entre tests (no hace falta: nada
 * depende de su cantidad exacta de filas), así que ese insert no colisiona
 * con nada.
 */

import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { sqliteTable, integer, text, real } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { insuredAccountMovements, accountHolderFundingIdempotencyKeys } from "../database/schema";
import {
  loadActiveAccountHolderBalanceCents,
  planFundingWithFreshBalance,
  assertFundingPlanUnchanged,
  persistAccountHolderFundingArtifacts,
  findAccountHolderFundingIdempotencyRow,
  resolveExistingIdempotentFundingRow,
  insertAccountHolderFundingIdempotencyRow,
  isAccountHolderFundingIdempotencyUniqueViolation,
  reconcileAccountHolderFundingIdempotencyConflict,
  runAccountHolderFundingTransaction,
  runAccountHolderFundingBatch,
  AccountHolderFundingBatchError,
  FundingPlanRaceConditionError,
  FundingIdempotencyConflictError,
  type PlanFundingWithFreshBalanceParams,
  type PersistAccountHolderFundingArtifactsParams,
  type AccountHolderFundingIdempotencyRow,
  type InsertAccountHolderFundingIdempotencyRowParams,
  type AccountHolderFundingBatchDependencies,
  type AccountHolderFundingChildRows,
  type RunAccountHolderFundingBatchParams,
  type RunAccountHolderFundingBatchResult,
} from "../account-holder-funding-batch";
import {
  planAccountHolderBatchFunding,
  AccountHolderFundingPlanError,
  type AccountHolderFundingPlanResult,
  type FundingPlanSplitInput,
} from "../../lib/payments/account-holder-funding-plan";
import type { FundingDestinationInput } from "../../lib/payments/account-holder-funding";
import type { BatchSnapshot } from "../../lib/payments/account-holder-funding-allocations";
import { applyMigration0036AccountHolderFunding } from "../../lib/migrations/apply-0036-account-holder-funding";
import type { Sql0036Client } from "../../lib/migrations/apply-0036-account-holder-funding";

// ─── Harness ────────────────────────────────────────────────────────────

let tmpDir: string | null = null;
let client: Client | null = null;
let db: any;
let userId: number;
let insuredId: number;

/** Cola de limpieza diferida (punto 3 del pedido): directorios que no se pudieron borrar en su primer intento se reintentan UNA vez más antes de terminar la suite — nunca se abandonan en silencio. Hoy, con una única DB compartida, en el caso normal queda vacía; existe para no perder la garantía si algún día hiciera falta un cliente propio por test. */
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

/**
 * Etapa 1B-3-B2: esquema PRE-migración 0036 (idéntico al que arma
 * migration-0036-account-holder-funding.test.ts) + aplicador REAL de la
 * migración 0036 (applyMigration0036AccountHolderFunding) — nunca un
 * esquema final hand-rolled. Así, las columnas nuevas
 * (payment_batches.account_holder_insured_id,
 * insured_account_movements.effective_date,
 * payment_amount_adjustments.effective_date) y las tablas nuevas
 * (payment_batch_funding_allocations, account_holder_funding_idempotency_keys)
 * quedan EXACTAMENTE como las crea el aplicador real, sin duplicar su DDL a
 * mano ni arriesgar un "ADD COLUMN" duplicado.
 */
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
  // migration-0036-account-holder-funding.test.ts usa una versión mínima de
  // esta tabla (sin created_at, columna que esa migración no toca) — acá se
  // agrega porque insertSplit (fixture de 1B-3-B2) sí la completa, igual que
  // el esquema real de database/schema.ts (paymentBatchSplits.createdAt).
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
      created_at     INTEGER
    )
  `);

  await applyMigration0036AccountHolderFunding(c as unknown as Sql0036Client);
}

async function seedUserAndInsured(c: Client): Promise<{ userId: number; insuredId: number }> {
  const u = await c.execute(`INSERT INTO users (name) VALUES ('QA') RETURNING id`);
  const i = await c.execute(`INSERT INTO insureds (name) VALUES ('QA') RETURNING id`);
  return { userId: Number(u.rows[0]!.id), insuredId: Number(i.rows[0]!.id) };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "account-holder-funding-batch-"));
  const c = createClient({ url: `file:${join(tmpDir, "shared.db")}` });
  client = c;
  await createSchema(c);
  const seeded = await seedUserAndInsured(c);
  userId = seeded.userId;
  insuredId = seeded.insuredId;
  db = drizzle(c);
});

// Aísla cada test sin recrear nada — insureds/users quedan fijos toda la
// corrida. Etapa 1B-3-B2 agrega tablas mutables nuevas (payment_batches y
// todo lo que cuelga de un batch) — se limpian en orden hijo->padre para
// respetar foreign_keys=ON (default real de @libsql/client). Etapa 1B-3-C1
// agrega account_holder_funding_idempotency_keys, que referencia
// payment_batches — se limpia antes que su padre por la misma razón.
beforeEach(async () => {
  await client!.execute(`DELETE FROM account_holder_funding_idempotency_keys`);
  await client!.execute(`DELETE FROM payment_batch_funding_allocations`);
  await client!.execute(`DELETE FROM insured_account_movements`);
  await client!.execute(`DELETE FROM payment_amount_adjustments`);
  await client!.execute(`DELETE FROM cash_entries`);
  await client!.execute(`DELETE FROM payments`);
  await client!.execute(`DELETE FROM payment_batch_splits`);
  await client!.execute(`DELETE FROM payment_batches`);
});

afterAll(async () => {
  client?.close();
  client = null;
  if (!tmpDir) return;
  const dir = tmpDir;
  tmpDir = null;

  // Pequeño respiro inicial — en Windows el handle del archivo puede tardar
  // un instante en liberarse después de close(), incluso antes del primer
  // intento de borrado.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const ok = await rmDirWithRetries(dir, 30, 200); // ~6s de margen acotado
  if (ok) return;

  // No se pudo en la primera tanda — cola de limpieza diferida: un
  // reintento más, con más margen, antes de terminar la suite.
  deferredCleanupDirs.push(dir);
  const finalOk = await rmDirWithRetries(dir, 15, 400); // ~6s adicionales
  if (finalOk) {
    deferredCleanupDirs.pop();
    return;
  }

  // Tras todos los reintentos, sigue sin poder borrarse — se informa de
  // forma explícita y visible (nunca en silencio), sin hacer fallar la
  // suite completa por un problema de limpieza ajeno a la lógica bajo
  // prueba (ver deferredCleanupDirs, que queda con este directorio).
  console.error(
    `[account-holder-funding-batch.test.ts] No se pudo eliminar el directorio temporal tras reintentos: ${dir}. Requiere limpieza manual. Cola de pendientes: ${JSON.stringify(deferredCleanupDirs)}`
  );
}, 20000);

async function insertMovement(
  dbClient: any,
  params: { insuredId: number; type: string; signedAmountCents: number; status?: "activo" | "anulado"; createdBy: number }
): Promise<void> {
  await dbClient.insert(insuredAccountMovements).values({
    insuredId: params.insuredId,
    type: params.type,
    signedAmountCents: params.signedAmountCents,
    status: params.status ?? "activo",
    createdBy: params.createdBy,
    createdAt: new Date(),
  });
}

// ─── Fixtures de persistAccountHolderFundingArtifacts (Etapa 1B-3-B2) ──────
//
// Insertadas por SQL crudo (mismo criterio que
// migration-0036-account-holder-funding.test.ts): estos fixtures representan
// datos YA creados por un futuro orquestador (el batch, sus splits reales,
// los payments/cash_entries destino) — persistAccountHolderFundingArtifacts
// nunca los inserta, así que el test tampoco debe pasar por la función bajo
// prueba para crearlos.

async function insertBatch(
  c: Client,
  params: {
    accountHolderInsuredId: number | null;
    baseAmountCents: number;
    surchargeAmountCents?: number;
    totalReceivedCents: number;
    paymentDate: string;
    status?: "confirmado" | "anulado";
    createdBy: number;
  }
): Promise<number> {
  const r = await c.execute(
    `INSERT INTO payment_batches (base_amount_cents, surcharge_amount_cents, total_received_cents, payment_date, status, created_by, created_at, account_holder_insured_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [params.baseAmountCents, params.surchargeAmountCents ?? 0, params.totalReceivedCents, params.paymentDate, params.status ?? "confirmado", params.createdBy, Date.now(), params.accountHolderInsuredId]
  );
  return Number(r.rows[0]!.id);
}

async function insertSplit(c: Client, params: { batchId: number; method: string; amountCents: number }): Promise<number> {
  const r = await c.execute(`INSERT INTO payment_batch_splits (batch_id, method, amount_cents, created_at) VALUES (?, ?, ?, ?) RETURNING id`, [
    params.batchId,
    params.method,
    params.amountCents,
    Date.now(),
  ]);
  return Number(r.rows[0]!.id);
}

async function insertBatchPayment(c: Client, params: { batchId: number; amountCents: number; paymentDate: string; status?: "confirmado" | "pendiente" | "anulado" }): Promise<number> {
  const r = await c.execute(
    `INSERT INTO payments (batch_id, amount, payment_method, payment_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [params.batchId, params.amountCents / 100, "efectivo", params.paymentDate, params.status ?? "confirmado", Date.now()]
  );
  return Number(r.rows[0]!.id);
}

async function insertProntoPagoCashEntry(c: Client, params: { paymentId: number; amountCents: number; paymentDate: string; status?: "activo" | "anulado" }): Promise<number> {
  const r = await c.execute(
    `INSERT INTO cash_entries (client_name, amount, payment_method, payment_date, entry_type, payment_id, status, created_at) VALUES (?, ?, ?, ?, 'pronto_pago_surcharge', ?, ?, ?) RETURNING id`,
    ["QA", params.amountCents / 100, "efectivo", params.paymentDate, params.paymentId, params.status ?? "activo", Date.now()]
  );
  return Number(r.rows[0]!.id);
}

interface BatchFixtureDestination {
  id: string;
  kind: "payment" | "pronto_pago";
  nominalCents: number;
}

interface BatchFixtureResult {
  batchId: number;
  paymentIdByKey: Map<string, number>;
  cashEntryIdByKey: Map<string, number>;
  splitIdByKey: Map<string, number>;
  /** Todos los payments hijos reales del batch (incluye el host de Pronto Pago si no hubo ningún destino "payment"). */
  allPaymentIds: number[];
}

/**
 * Arma un batch real completo (payment_batches + splits + payments +
 * cash_entries de Pronto Pago) a partir de destinos/splits ya decididos por
 * el test — sin pasar por planAccountHolderBatchFunding: el plan se
 * construye aparte (es puro, no necesita DB) y se le pasa a
 * persistAccountHolderFundingArtifacts junto con los mapas que esta función
 * devuelve. Los destinos "pronto_pago" cuelgan del primer destino "payment"
 * como padre real (o de un payment dedicado si el batch no tiene ningún
 * destino "payment") — igual que en el flujo real, un recargo Pronto Pago
 * siempre está atado a un payment concreto del mismo batch.
 */
async function buildBatchFixture(
  c: Client,
  params: {
    accountHolderInsuredId: number | null;
    paymentDate: string;
    createdBy: number;
    destinations: ReadonlyArray<BatchFixtureDestination>;
    realSplits: ReadonlyArray<{ id: string; amountCents: number; method?: string }>;
    status?: "confirmado" | "anulado";
  }
): Promise<BatchFixtureResult> {
  const paymentDestinations = params.destinations.filter((d) => d.kind === "payment");
  const prontoPagoDestinations = params.destinations.filter((d) => d.kind === "pronto_pago");
  const baseAmountCents = paymentDestinations.reduce((acc, d) => acc + d.nominalCents, 0);
  const surchargeAmountCents = prontoPagoDestinations.reduce((acc, d) => acc + d.nominalCents, 0);
  const totalReceivedCents = params.realSplits.reduce((acc, s) => acc + s.amountCents, 0);

  const batchId = await insertBatch(c, {
    accountHolderInsuredId: params.accountHolderInsuredId,
    baseAmountCents: baseAmountCents || 1,
    surchargeAmountCents,
    totalReceivedCents: totalReceivedCents || 1,
    paymentDate: params.paymentDate,
    status: params.status,
    createdBy: params.createdBy,
  });

  const splitIdByKey = new Map<string, number>();
  for (const [index, split] of params.realSplits.entries()) {
    const method = split.method ?? (["efectivo", "transferencia", "cheque"][index % 3] as string);
    const id = await insertSplit(c, { batchId, method, amountCents: split.amountCents });
    splitIdByKey.set(split.id, id);
  }

  const paymentIdByKey = new Map<string, number>();
  const allPaymentIds: number[] = [];
  for (const d of paymentDestinations) {
    const id = await insertBatchPayment(c, { batchId, amountCents: d.nominalCents, paymentDate: params.paymentDate });
    paymentIdByKey.set(d.id, id);
    allPaymentIds.push(id);
  }

  let hostPaymentId: number | null = paymentDestinations.length > 0 ? paymentIdByKey.get(paymentDestinations[0]!.id)! : null;
  if (prontoPagoDestinations.length > 0 && hostPaymentId === null) {
    hostPaymentId = await insertBatchPayment(c, { batchId, amountCents: 100, paymentDate: params.paymentDate });
    allPaymentIds.push(hostPaymentId);
  }

  const cashEntryIdByKey = new Map<string, number>();
  for (const d of prontoPagoDestinations) {
    const id = await insertProntoPagoCashEntry(c, { paymentId: hostPaymentId!, amountCents: d.nominalCents, paymentDate: params.paymentDate });
    cashEntryIdByKey.set(d.id, id);
  }

  return { batchId, paymentIdByKey, cashEntryIdByKey, splitIdByKey, allPaymentIds };
}

function buildPersistablePlan(args: {
  destinations: ReadonlyArray<FundingDestinationInput>;
  realSplits: ReadonlyArray<FundingPlanSplitInput>;
  creditAppliedCents?: number;
  roundingCoverageCents?: number;
  availableCreditCents?: number;
  debtAuthorized?: boolean;
}): AccountHolderFundingPlanResult {
  return planAccountHolderBatchFunding({
    destinations: args.destinations,
    realSplits: args.realSplits,
    creditAppliedCents: args.creditAppliedCents ?? 0,
    roundingCoverageCents: args.roundingCoverageCents ?? 0,
    availableCreditCents: args.availableCreditCents ?? (args.creditAppliedCents ?? 0),
    debtAuthorized: args.debtAuthorized ?? false,
  });
}

async function countRows(c: Client, table: string): Promise<number> {
  const r = await c.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number((r.rows[0] as any).c);
}

// ─── 1. loadActiveAccountHolderBalanceCents ─────────────────────────────

describe("loadActiveAccountHolderBalanceCents", () => {
  test("sin movimientos: saldo 0", async () => {
    expect(await loadActiveAccountHolderBalanceCents(db, insuredId)).toBe(0);
  });

  test("suma de varios movimientos activos", async () => {
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 10000, createdBy: userId });
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 5000, createdBy: userId });
    expect(await loadActiveAccountHolderBalanceCents(db, insuredId)).toBe(15000);
  });

  test("excluye movimientos anulados", async () => {
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 10000, createdBy: userId });
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 99999, status: "anulado", createdBy: userId });
    expect(await loadActiveAccountHolderBalanceCents(db, insuredId)).toBe(10000);
  });

  test("varios tipos y signos: aplicacion_saldo_favor y saldo_deudor negativos, saldo_a_favor y cobro_saldo_deudor positivos", async () => {
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 20000, createdBy: userId });
    await insertMovement(db, { insuredId, type: "aplicacion_saldo_favor", signedAmountCents: -8000, createdBy: userId });
    await insertMovement(db, { insuredId, type: "saldo_deudor", signedAmountCents: -3000, createdBy: userId });
    await insertMovement(db, { insuredId, type: "cobro_saldo_deudor", signedAmountCents: 1000, createdBy: userId });
    expect(await loadActiveAccountHolderBalanceCents(db, insuredId)).toBe(20000 - 8000 - 3000 + 1000);
  });

  test("saldo positivo neto", async () => {
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 50000, createdBy: userId });
    await insertMovement(db, { insuredId, type: "aplicacion_saldo_favor", signedAmountCents: -10000, createdBy: userId });
    expect(await loadActiveAccountHolderBalanceCents(db, insuredId)).toBe(40000);
  });

  test("saldo negativo neto", async () => {
    await insertMovement(db, { insuredId, type: "saldo_deudor", signedAmountCents: -15000, createdBy: userId });
    expect(await loadActiveAccountHolderBalanceCents(db, insuredId)).toBe(-15000);
  });

  test("no mezcla el saldo de otro asegurado", async () => {
    const otherInsuredId = Number((await client!.execute(`INSERT INTO insureds (name) VALUES ('Otro') RETURNING id`)).rows[0]!.id);
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 10000, createdBy: userId });
    await insertMovement(db, { insuredId: otherInsuredId, type: "saldo_a_favor", signedAmountCents: 99999, createdBy: userId });
    expect(await loadActiveAccountHolderBalanceCents(db, insuredId)).toBe(10000);
  });

  test.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])("insuredId inválido (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    await expect(loadActiveAccountHolderBalanceCents(db, bad as number)).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("overflow: suma de movimientos activos por encima de Number.MAX_SAFE_INTEGER lanza AccountHolderFundingBatchError", async () => {
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: Number.MAX_SAFE_INTEGER, createdBy: userId });
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: Number.MAX_SAFE_INTEGER, createdBy: userId });
    await expect(loadActiveAccountHolderBalanceCents(db, insuredId)).rejects.toThrow(AccountHolderFundingBatchError);
  });
});

// ─── 2. planFundingWithFreshBalance ──────────────────────────────────────

function fundingParams(overrides: Partial<PlanFundingWithFreshBalanceParams> = {}, forInsuredId: number): PlanFundingWithFreshBalanceParams {
  return {
    insuredId: forInsuredId,
    destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }],
    realSplits: [{ id: "s1", amountCents: 100000 }],
    creditAppliedCents: 0,
    roundingCoverageCents: 0,
    debtAuthorized: false,
    ...overrides,
  };
}

describe("planFundingWithFreshBalance", () => {
  test("crédito suficiente: balance cubre creditAppliedCents", async () => {
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 30000, createdBy: userId });

    const result = await planFundingWithFreshBalance(
      db,
      fundingParams({ destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 70000 }], creditAppliedCents: 30000 }, insuredId)
    );

    expect(result.balanceCents).toBe(30000);
    expect(result.plan.creditAppliedCents).toBe(30000);
    expect(result.plan.newSaldoAFavorCents).toBe(0);
    expect(result.plan.newSaldoDeudorCents).toBe(0);
  });

  test("crédito insuficiente: balance no cubre creditAppliedCents, propaga AccountHolderFundingPlanError", async () => {
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 10000, createdBy: userId });

    await expect(
      planFundingWithFreshBalance(
        db,
        fundingParams({ destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 70000 }], creditAppliedCents: 30000 }, insuredId)
      )
    ).rejects.toThrow(AccountHolderFundingPlanError);
  });

  test("saldo negativo (deuda preexistente) con creditAppliedCents=0 no lanza — el clamp a 0 no bloquea un plan que no pide crédito", async () => {
    await insertMovement(db, { insuredId, type: "saldo_deudor", signedAmountCents: -5000, createdBy: userId });

    const result = await planFundingWithFreshBalance(db, fundingParams({}, insuredId));

    expect(result.balanceCents).toBe(-5000);
    expect(result.plan.creditAppliedCents).toBe(0);
    expect(result.plan.newSaldoAFavorCents).toBe(0);
    expect(result.plan.newSaldoDeudorCents).toBe(0);
  });

  test("saldo negativo + creditAppliedCents > 0 se rechaza explícitamente por crédito insuficiente", async () => {
    await insertMovement(db, { insuredId, type: "saldo_deudor", signedAmountCents: -5000, createdBy: userId });

    await expect(
      planFundingWithFreshBalance(
        db,
        fundingParams({ destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 90000 }], creditAppliedCents: 10000 }, insuredId)
      )
    ).rejects.toThrow(AccountHolderFundingPlanError);
  });

  test("determinismo: misma DB, mismos parámetros -> mismo plan", async () => {
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 20000, createdBy: userId });

    const a = await planFundingWithFreshBalance(db, fundingParams({ creditAppliedCents: 20000, realSplits: [{ id: "s1", amountCents: 80000 }] }, insuredId));
    const b = await planFundingWithFreshBalance(db, fundingParams({ creditAppliedCents: 20000, realSplits: [{ id: "s1", amountCents: 80000 }] }, insuredId));

    expect(a).toEqual(b);
  });

  test("no muta destinations/realSplits de entrada", async () => {
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 10000, createdBy: userId });

    const destinations = [{ id: "d1", kind: "payment" as const, nominalCents: 100000 }];
    const realSplits = [{ id: "s1", amountCents: 100000 }];
    const destinationsSnapshot = JSON.parse(JSON.stringify(destinations));
    const realSplitsSnapshot = JSON.parse(JSON.stringify(realSplits));

    await planFundingWithFreshBalance(db, fundingParams({ destinations, realSplits }, insuredId));

    expect(JSON.parse(JSON.stringify(destinations))).toEqual(destinationsSnapshot);
    expect(JSON.parse(JSON.stringify(realSplits))).toEqual(realSplitsSnapshot);
  });

  test("insuredId inválido lanza AccountHolderFundingBatchError (propagado desde loadActiveAccountHolderBalanceCents)", async () => {
    await expect(planFundingWithFreshBalance(db, fundingParams({}, -1))).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("params no-objeto lanza AccountHolderFundingBatchError", async () => {
    await expect(planFundingWithFreshBalance(db, null as any)).rejects.toThrow(AccountHolderFundingBatchError);
  });
});

// ─── 3. assertFundingPlanUnchanged — pura, sin DB ──────────────────────────

function buildPlan(overrides: { availableCreditCents?: number; creditAppliedCents?: number; destinations?: any[]; realSplits?: any[] } = {}): AccountHolderFundingPlanResult {
  return planAccountHolderBatchFunding({
    destinations: overrides.destinations ?? [{ id: "d1", kind: "payment", nominalCents: 100000 }],
    realSplits: overrides.realSplits ?? [{ id: "s1", amountCents: 100000 - (overrides.creditAppliedCents ?? 0) }],
    creditAppliedCents: overrides.creditAppliedCents ?? 0,
    roundingCoverageCents: 0,
    availableCreditCents: overrides.availableCreditCents ?? (overrides.creditAppliedCents ?? 0),
    debtAuthorized: false,
  });
}

describe("assertFundingPlanUnchanged — comparación pura", () => {
  test("dos planes idénticos: no lanza", () => {
    const a = buildPlan();
    const b = buildPlan();
    expect(() => assertFundingPlanUnchanged(a, b)).not.toThrow();
  });

  test("no depende del orden de claves de los objetos", () => {
    const a = buildPlan({ creditAppliedCents: 20000 });
    // Mismo contenido semántico, reconstruido con las claves en otro orden
    // real (no solo TS) — JS respeta el orden de inserción del literal.
    const b: AccountHolderFundingPlanResult = {
      totals: { destinationsTotalCents: a.totals.destinationsTotalCents, sourcesTotalCents: a.totals.sourcesTotalCents },
      allocations: a.allocations.map((alloc) => ({
        amountCents: alloc.amountCents, destinationKey: alloc.destinationKey,
        destinationKind: alloc.destinationKind, sourceKey: alloc.sourceKey, sourceKind: alloc.sourceKind,
      })),
      newSaldoDeudorCents: a.newSaldoDeudorCents, newSaldoAFavorCents: a.newSaldoAFavorCents,
      roundingCoverageCents: a.roundingCoverageCents, creditAppliedCents: a.creditAppliedCents,
      realSplitsTotalCents: a.realSplitsTotalCents, nominalTotalCents: a.nominalTotalCents,
      destinations: a.destinations.map((d) => ({ cashCents: d.cashCents, roundingCents: d.roundingCents, creditCents: d.creditCents, nominalCents: d.nominalCents, kind: d.kind, id: d.id })),
    };
    expect(() => assertFundingPlanUnchanged(a, b)).not.toThrow();
  });

  test("orden de arrays significativo: mismas allocations en distinto orden lanza", () => {
    const a = buildPlan({
      destinations: [{ id: "d1", kind: "payment", nominalCents: 40000 }, { id: "d2", kind: "payment", nominalCents: 60000 }],
      realSplits: [{ id: "s1", amountCents: 40000 }, { id: "s2", amountCents: 60000 }],
    });
    const b: AccountHolderFundingPlanResult = { ...a, allocations: [...a.allocations].reverse() };
    expect(() => assertFundingPlanUnchanged(a, b)).toThrow(FundingPlanRaceConditionError);
  });

  test("cambio de destinos/splits detectado (mismo saldo, distinto contenido)", () => {
    const a = buildPlan({ destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }] });
    const b = buildPlan({ destinations: [{ id: "d2", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }] });
    expect(() => assertFundingPlanUnchanged(a, b)).toThrow(FundingPlanRaceConditionError);
  });

  test("preliminary/fresh no-objeto lanza AccountHolderFundingBatchError", () => {
    const a = buildPlan();
    expect(() => assertFundingPlanUnchanged(null as any, a)).toThrow(AccountHolderFundingBatchError);
    expect(() => assertFundingPlanUnchanged(a, undefined as any)).toThrow(AccountHolderFundingBatchError);
  });

  // Simulan un campo que AccountHolderFundingPlanResult todavía no tiene —
  // prueban que la comparación es genérica (deepEqual sobre el objeto
  // completo) y no una lista curada de campos conocidos: un campo futuro
  // participa automáticamente sin que nadie tenga que acordarse de sumarlo acá.
  test("un campo futuro/sintético adicional DISTINTO entre preliminary y fresh se detecta", () => {
    const a = buildPlan();
    const withExtraA = { ...a, futureField: { nested: 1 } } as any;
    const withExtraB = { ...a, futureField: { nested: 2 } } as any;
    expect(() => assertFundingPlanUnchanged(withExtraA, withExtraB)).toThrow(FundingPlanRaceConditionError);
  });

  test("un campo futuro/sintético adicional IDÉNTICO en ambos se considera igual", () => {
    const a = buildPlan();
    const withExtraA = { ...a, futureField: { nested: 1 } } as any;
    const withExtraB = { ...a, futureField: { nested: 1 } } as any;
    expect(() => assertFundingPlanUnchanged(withExtraA, withExtraB)).not.toThrow();
  });
});

// ─── 4. Integración: cambio de saldo real entre lecturas ──────────────────

describe("integración — cambio de saldo real entre planificación preliminar y fresca", () => {
  test("un cambio de saldo que ALTERA el resultado económico se detecta", async () => {
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 30000, createdBy: userId });

    const params = fundingParams({ destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 70000 }], creditAppliedCents: 30000 }, insuredId);
    await planFundingWithFreshBalance(db, params);

    // Entre la planificación preliminar y la escritura, alguien consumió
    // parte del crédito disponible (otra operación real) — el saldo bajó.
    await insertMovement(db, { insuredId, type: "aplicacion_saldo_favor", signedAmountCents: -20000, createdBy: userId });

    // El caller pide releer y volver a planificar con el saldo fresco.
    const freshBalance = await loadActiveAccountHolderBalanceCents(db, insuredId);
    expect(freshBalance).toBe(10000); // ya no alcanza para creditAppliedCents=30000

    await expect(planFundingWithFreshBalance(db, params)).rejects.toThrow(AccountHolderFundingPlanError);
  });

  test("un cambio de saldo que NO altera el resultado económico no se rechaza (se compara el plan, no el saldo crudo)", async () => {
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 50000, createdBy: userId });

    const params = fundingParams({}, insuredId); // creditAppliedCents:0 — nunca toca el saldo
    const preliminary = await planFundingWithFreshBalance(db, params);

    // El saldo sube entre ambas lecturas, pero este lote nunca pidió crédito.
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 30000, createdBy: userId });

    const fresh = await planFundingWithFreshBalance(db, params);
    expect(fresh.balanceCents).toBe(80000);
    expect(preliminary.balanceCents).toBe(50000);

    // Los saldos crudos difieren, pero el PLAN (lo único relevante para
    // decidir si es seguro escribir) es idéntico.
    expect(() => assertFundingPlanUnchanged(preliminary.plan, fresh.plan)).not.toThrow();
  });
});

// ─── 5. persistAccountHolderFundingArtifacts — Etapa 1B-3-B2 ───────────────

const PDATE = "2026-01-15";

describe("persistAccountHolderFundingArtifacts", () => {
  test("solo dinero real: sin movimientos ni ajuste, una sola allocation split->payment", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = buildPersistablePlan({ destinations, realSplits });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const result = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan,
      paymentDate: PDATE,
      createdBy: userId,
      debtReason: null,
      splitIdByKey: fx.splitIdByKey,
      paymentIdByKey: fx.paymentIdByKey,
      cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    expect(result.creditMovementId).toBeNull();
    expect(result.debtMovementId).toBeNull();
    expect(result.newCreditMovementId).toBeNull();
    expect(result.roundingAdjustmentId).toBeNull();
    expect(result.allocationRows).toHaveLength(1);
    expect(result.allocationRows[0]).toEqual({
      paymentBatchId: fx.batchId,
      paymentBatchSplitId: fx.splitIdByKey.get("s1")!,
      sourceAccountMovementId: null,
      paymentAmountAdjustmentId: null,
      paymentId: fx.paymentIdByKey.get("d1")!,
      cashEntryId: null,
      destinationAccountMovementId: null,
      amountCents: 100000,
    });
    expect(await countRows(client!, "insured_account_movements")).toBe(0);
    expect(await countRows(client!, "payment_amount_adjustments")).toBe(0);
  });

  test("aplicación de crédito: movimiento aplicacion_saldo_favor negativo + relatedPaymentId único", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }];
    const plan = buildPersistablePlan({ destinations, realSplits, creditAppliedCents: 30000, availableCreditCents: 30000 });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const result = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan,
      paymentDate: PDATE,
      createdBy: userId,
      debtReason: null,
      splitIdByKey: fx.splitIdByKey,
      paymentIdByKey: fx.paymentIdByKey,
      cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    expect(result.creditMovementId).not.toBeNull();
    const row = (await client!.execute(`SELECT * FROM insured_account_movements WHERE id = ?`, [result.creditMovementId])).rows[0] as any;
    expect(row.type).toBe("aplicacion_saldo_favor");
    expect(Number(row.signed_amount_cents)).toBe(-30000);
    expect(row.status).toBe("activo");
    expect(Number(row.insured_id)).toBe(insuredId);
    expect(Number(row.origin_batch_id)).toBe(fx.batchId);
    expect(Number(row.related_payment_id)).toBe(fx.paymentIdByKey.get("d1")!);
    expect(Number(row.created_by)).toBe(userId);
    expect(row.effective_date).toBe(PDATE);

    expect(result.allocationRows).toHaveLength(2);
    const total = result.allocationRows.reduce((acc, r) => acc + r.amountCents, 0);
    expect(total).toBe(100000);
  });

  test("crédito repartido entre varios payments: un único movimiento agregado, relatedPaymentId null (ambiguo)", async () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 50000 },
      { id: "d2", kind: "payment", nominalCents: 50000 },
    ];
    const realSplits: FundingPlanSplitInput[] = [];
    const plan = buildPersistablePlan({ destinations, realSplits, creditAppliedCents: 100000, availableCreditCents: 100000 });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const result = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan,
      paymentDate: PDATE,
      createdBy: userId,
      debtReason: null,
      splitIdByKey: fx.splitIdByKey,
      paymentIdByKey: fx.paymentIdByKey,
      cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    expect(result.creditMovementId).not.toBeNull();
    const row = (await client!.execute(`SELECT related_payment_id FROM insured_account_movements WHERE id = ?`, [result.creditMovementId])).rows[0] as any;
    expect(row.related_payment_id).toBeNull();

    // Un único movimiento agregado financia ambos destinos — 2 allocations, mismo sourceAccountMovementId.
    expect(result.allocationRows).toHaveLength(2);
    expect(new Set(result.allocationRows.map((r) => r.sourceAccountMovementId)).size).toBe(1);
    expect(result.allocationRows.map((r) => r.paymentId).sort()).toEqual([fx.paymentIdByKey.get("d1")!, fx.paymentIdByKey.get("d2")!].sort());
    expect(result.allocationRows.reduce((acc, r) => acc + r.amountCents, 0)).toBe(100000);
  });

  test("crédito que también alcanza Pronto Pago: allocations con destinationKind payment y pronto_pago desde el mismo movimiento", async () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 80000 },
      { id: "d2", kind: "pronto_pago", nominalCents: 20000 },
    ];
    const realSplits: FundingPlanSplitInput[] = [];
    const plan = buildPersistablePlan({ destinations, realSplits, creditAppliedCents: 100000, availableCreditCents: 100000 });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const result = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan,
      paymentDate: PDATE,
      createdBy: userId,
      debtReason: null,
      splitIdByKey: fx.splitIdByKey,
      paymentIdByKey: fx.paymentIdByKey,
      cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    expect(result.creditMovementId).not.toBeNull();
    const cashEntryRow = result.allocationRows.find((r) => r.cashEntryId !== null);
    expect(cashEntryRow).toBeDefined();
    expect(cashEntryRow!.cashEntryId).toBe(fx.cashEntryIdByKey.get("d2")!);
    expect(cashEntryRow!.sourceAccountMovementId).toBe(result.creditMovementId);
    expect(cashEntryRow!.amountCents).toBe(20000);
    expect(result.allocationRows.reduce((acc, r) => acc + r.amountCents, 0)).toBe(100000);
  });

  test("saldo deudor autorizado con razón: movimiento saldo_deudor negativo con reason", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 60000 }];
    const plan = buildPersistablePlan({ destinations, realSplits, debtAuthorized: true });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    expect(plan.newSaldoDeudorCents).toBe(40000);

    const result = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan,
      paymentDate: PDATE,
      createdBy: userId,
      debtReason: "Autorizado por gerencia — QA",
      splitIdByKey: fx.splitIdByKey,
      paymentIdByKey: fx.paymentIdByKey,
      cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    expect(result.debtMovementId).not.toBeNull();
    const row = (await client!.execute(`SELECT * FROM insured_account_movements WHERE id = ?`, [result.debtMovementId])).rows[0] as any;
    expect(row.type).toBe("saldo_deudor");
    expect(Number(row.signed_amount_cents)).toBe(-40000);
    expect(row.reason).toBe("Autorizado por gerencia — QA");
    expect(Number(row.related_payment_id)).toBe(fx.paymentIdByKey.get("d1")!);
  });

  test("debtReason faltante con newSaldoDeudorCents > 0 lanza AccountHolderFundingBatchError", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 60000 }];
    const plan = buildPersistablePlan({ destinations, realSplits, debtAuthorized: true });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    await expect(
      persistAccountHolderFundingArtifacts(db, {
        batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
        plan,
        paymentDate: PDATE,
        createdBy: userId,
        debtReason: "   ",
        splitIdByKey: fx.splitIdByKey,
        paymentIdByKey: fx.paymentIdByKey,
        cashEntryIdByKey: fx.cashEntryIdByKey,
      })
    ).rejects.toThrow(AccountHolderFundingBatchError);
    expect(await countRows(client!, "insured_account_movements")).toBe(0);
  });

  test("crédito más saldo deudor: ambos movimientos en el mismo batch", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 30000 }];
    const plan = buildPersistablePlan({ destinations, realSplits, creditAppliedCents: 20000, availableCreditCents: 20000, debtAuthorized: true });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    expect(plan.newSaldoDeudorCents).toBe(50000);

    const result = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan,
      paymentDate: PDATE,
      createdBy: userId,
      debtReason: "Deuda residual — QA",
      splitIdByKey: fx.splitIdByKey,
      paymentIdByKey: fx.paymentIdByKey,
      cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    expect(result.creditMovementId).not.toBeNull();
    expect(result.debtMovementId).not.toBeNull();
    expect(result.newCreditMovementId).toBeNull();
    expect(result.allocationRows).toHaveLength(3);
    expect(result.allocationRows.reduce((acc, r) => acc + r.amountCents, 0)).toBe(100000);
  });

  test("redondeo: ajuste negativo hasta el máximo permitido cubre el faltante real", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 99700 }];
    const plan = buildPersistablePlan({ destinations, realSplits, roundingCoverageCents: 300 });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const result = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan,
      paymentDate: PDATE,
      createdBy: userId,
      debtReason: null,
      splitIdByKey: fx.splitIdByKey,
      paymentIdByKey: fx.paymentIdByKey,
      cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    expect(result.roundingAdjustmentId).not.toBeNull();
    const row = (await client!.execute(`SELECT * FROM payment_amount_adjustments WHERE id = ?`, [result.roundingAdjustmentId])).rows[0] as any;
    expect(Number(row.amount_cents)).toBe(-300);
    expect(Number(row.payment_batch_id)).toBe(fx.batchId);
    expect(row.payment_id).toBeNull();
    expect(Number(row.authorized_by)).toBe(userId);
    expect(Number(row.created_by)).toBe(userId);
    expect(row.effective_date).toBe(PDATE);
    expect(row.reason).toBeTruthy();
  });

  test("nuevo saldo a favor por dinero real: movimiento saldo_a_favor positivo, relatedPaymentId siempre null", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 80000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = buildPersistablePlan({ destinations, realSplits });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    expect(plan.newSaldoAFavorCents).toBe(20000);

    const result = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan,
      paymentDate: PDATE,
      createdBy: userId,
      debtReason: null,
      splitIdByKey: fx.splitIdByKey,
      paymentIdByKey: fx.paymentIdByKey,
      cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    expect(result.newCreditMovementId).not.toBeNull();
    const row = (await client!.execute(`SELECT * FROM insured_account_movements WHERE id = ?`, [result.newCreditMovementId])).rows[0] as any;
    expect(row.type).toBe("saldo_a_favor");
    expect(Number(row.signed_amount_cents)).toBe(20000);
    expect(row.related_payment_id).toBeNull();

    const allocRow = result.allocationRows.find((r) => r.destinationAccountMovementId !== null);
    expect(allocRow!.destinationAccountMovementId).toBe(result.newCreditMovementId);
    expect(allocRow!.amountCents).toBe(20000);
  });

  test("splits separados de cheque/efectivo/transferencia: 3 allocations distintas, nunca fusionadas", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 150000 }];
    // method es solo un dato del fixture (payment_batch_splits.method real) —
    // FundingPlanSplitInput (el contrato del plan puro) no lo conoce, así que
    // se pasa aparte a buildBatchFixture y se despoja para buildPersistablePlan.
    const realSplitsFixture = [
      { id: "s1", amountCents: 50000, method: "efectivo" },
      { id: "s2", amountCents: 50000, method: "transferencia" },
      { id: "s3", amountCents: 50000, method: "cheque" },
    ];
    const realSplits: FundingPlanSplitInput[] = realSplitsFixture.map(({ id, amountCents }) => ({ id, amountCents }));
    const plan = buildPersistablePlan({ destinations, realSplits });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits: realSplitsFixture });

    const result = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan,
      paymentDate: PDATE,
      createdBy: userId,
      debtReason: null,
      splitIdByKey: fx.splitIdByKey,
      paymentIdByKey: fx.paymentIdByKey,
      cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    expect(result.allocationRows).toHaveLength(3);
    const splitIds = result.allocationRows.map((r) => r.paymentBatchSplitId).sort();
    expect(splitIds).toEqual([fx.splitIdByKey.get("s1")!, fx.splitIdByKey.get("s2")!, fx.splitIdByKey.get("s3")!].sort());
    expect(new Set(splitIds).size).toBe(3);
    for (const row of result.allocationRows) expect(row.amountCents).toBe(50000);
  });

  test("batch con distintos asegurados reales y un único titular contable: payments/pronto_pago no necesitan coincidir con accountHolderInsuredId", async () => {
    // payments/cash_entries no llevan insuredId directo en este esquema — la
    // regla real de titularidad (ver account-holder-funding-allocations.ts)
    // es que SOLO los 3 movimientos de cuenta corriente deben coincidir con
    // accountHolderInsuredId; los destinos (payment/pronto_pago) solo deben
    // pertenecer al mismo batch. Este test confirma que un batch con más de
    // un destino "real" persiste sin exigir ninguna coincidencia de asegurado
    // en esos destinos.
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 60000 },
      { id: "d2", kind: "payment", nominalCents: 40000 },
    ];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = buildPersistablePlan({ destinations, realSplits });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const result = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan,
      paymentDate: PDATE,
      createdBy: userId,
      debtReason: null,
      splitIdByKey: fx.splitIdByKey,
      paymentIdByKey: fx.paymentIdByKey,
      cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    expect(result.allocationRows).toHaveLength(2);
    expect(result.allocationRows.reduce((acc, r) => acc + r.amountCents, 0)).toBe(100000);
  });

  describe("relatedPaymentId — caso único vs. caso ambiguo", () => {
    test("único payment hijo: relatedPaymentId se completa", async () => {
      const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
      const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }];
      const plan = buildPersistablePlan({ destinations, realSplits, creditAppliedCents: 30000, availableCreditCents: 30000 });
      const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

      const result = await persistAccountHolderFundingArtifacts(db, {
        batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
        plan, paymentDate: PDATE, createdBy: userId, debtReason: null,
        splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
      });

      const row = (await client!.execute(`SELECT related_payment_id FROM insured_account_movements WHERE id = ?`, [result.creditMovementId])).rows[0] as any;
      expect(Number(row.related_payment_id)).toBe(fx.paymentIdByKey.get("d1")!);
    });

    test("dos payments hijos: relatedPaymentId queda null — nunca se inventa un vínculo ambiguo", async () => {
      const destinations: FundingDestinationInput[] = [
        { id: "d1", kind: "payment", nominalCents: 60000 },
        { id: "d2", kind: "payment", nominalCents: 40000 },
      ];
      const realSplits: FundingPlanSplitInput[] = [];
      const plan = buildPersistablePlan({ destinations, realSplits, creditAppliedCents: 100000, availableCreditCents: 100000 });
      const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

      const result = await persistAccountHolderFundingArtifacts(db, {
        batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
        plan, paymentDate: PDATE, createdBy: userId, debtReason: null,
        splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
      });

      const row = (await client!.execute(`SELECT related_payment_id FROM insured_account_movements WHERE id = ?`, [result.creditMovementId])).rows[0] as any;
      expect(row.related_payment_id).toBeNull();
    });
  });

  test("filas de allocations exactas: cada columna FK nula/no-nula según el tipo de fuente/destino", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 30000 }];
    const plan = buildPersistablePlan({ destinations, realSplits, creditAppliedCents: 20000, availableCreditCents: 20000, debtAuthorized: true });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    expect(plan.newSaldoDeudorCents).toBe(50000);

    const result = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan, paymentDate: PDATE, createdBy: userId, debtReason: "Residual — QA",
      splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    const bySplit = result.allocationRows.find((r) => r.paymentBatchSplitId !== null)!;
    expect(bySplit).toMatchObject({ paymentBatchSplitId: fx.splitIdByKey.get("s1")!, sourceAccountMovementId: null, paymentAmountAdjustmentId: null, paymentId: fx.paymentIdByKey.get("d1")!, cashEntryId: null, destinationAccountMovementId: null, amountCents: 30000 });

    const byCredit = result.allocationRows.find((r) => r.sourceAccountMovementId === result.creditMovementId)!;
    expect(byCredit).toMatchObject({ paymentBatchSplitId: null, paymentAmountAdjustmentId: null, paymentId: fx.paymentIdByKey.get("d1")!, cashEntryId: null, destinationAccountMovementId: null, amountCents: 20000 });

    const byDebt = result.allocationRows.find((r) => r.sourceAccountMovementId === result.debtMovementId)!;
    expect(byDebt).toMatchObject({ paymentBatchSplitId: null, paymentAmountAdjustmentId: null, paymentId: fx.paymentIdByKey.get("d1")!, cashEntryId: null, destinationAccountMovementId: null, amountCents: 50000 });

    // Cada fila real insertada en la tabla coincide exactamente con lo devuelto por la función.
    const persistedCount = await countRows(client!, "payment_batch_funding_allocations");
    expect(persistedCount).toBe(result.allocationRows.length);
    expect(result.allocationIds).toHaveLength(result.allocationRows.length);
  });

  test("error de mapping (falta un destino real) produce rollback total — ninguna fila parcial", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }];
    const plan = buildPersistablePlan({ destinations, realSplits, creditAppliedCents: 30000, availableCreditCents: 30000 });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const emptyPaymentIdByKey = new Map<string, number>(); // falta "d1" -> mapping incompleto

    await expect(
      db.transaction(async (tx: any) => {
        await persistAccountHolderFundingArtifacts(tx, {
          batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
          plan, paymentDate: PDATE, createdBy: userId, debtReason: null,
          splitIdByKey: fx.splitIdByKey, paymentIdByKey: emptyPaymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
        });
      })
    ).rejects.toThrow();

    // El credit_movement (y su fila) ya se habían insertado dentro de la
    // transacción antes de que fallara la construcción de la matriz de
    // allocations — el rollback de la transacción externa debe deshacerlos
    // por completo, sin dejar nada a medias.
    expect(await countRows(client!, "insured_account_movements")).toBe(0);
    expect(await countRows(client!, "payment_batch_funding_allocations")).toBe(0);
  });

  test("referencia a un payment de OTRO batch produce rollback total (movimiento/allocation inválida)", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 60000 }];
    const plan = buildPersistablePlan({ destinations, realSplits, debtAuthorized: true });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    // Un batch completamente ajeno, con su propio payment real.
    const otherFx = await buildBatchFixture(client!, {
      accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId,
      destinations: [{ id: "od1", kind: "payment", nominalCents: 50000 }],
      realSplits: [{ id: "os1", amountCents: 50000 }],
    });

    const tamperedPaymentIdByKey = new Map<string, number>([["d1", otherFx.paymentIdByKey.get("od1")!]]);

    await expect(
      db.transaction(async (tx: any) => {
        await persistAccountHolderFundingArtifacts(tx, {
          batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
          plan, paymentDate: PDATE, createdBy: userId, debtReason: "Residual — QA",
          splitIdByKey: fx.splitIdByKey, paymentIdByKey: tamperedPaymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
        });
      })
    ).rejects.toThrow();

    expect(await countRows(client!, "insured_account_movements")).toBe(0);
    expect(await countRows(client!, "payment_batch_funding_allocations")).toBe(0);
  });

  test("batch no confirmado (anulado) lanza AccountHolderFundingBatchError sin escribir nada", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = buildPersistablePlan({ destinations, realSplits });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    await expect(
      persistAccountHolderFundingArtifacts(db, {
        batch: { id: fx.batchId, status: "anulado", accountHolderInsuredId: insuredId },
        plan, paymentDate: PDATE, createdBy: userId, debtReason: null,
        splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
      })
    ).rejects.toThrow(AccountHolderFundingBatchError);
    expect(await countRows(client!, "insured_account_movements")).toBe(0);
  });

  test("batch sin accountHolderInsuredId (titular nulo) lanza AccountHolderFundingBatchError", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = buildPersistablePlan({ destinations, realSplits });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    await expect(
      persistAccountHolderFundingArtifacts(db, {
        batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: null },
        plan, paymentDate: PDATE, createdBy: userId, debtReason: null,
        splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
      })
    ).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[0], [-1], [1.5]])("batch.id inválido (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = buildPersistablePlan({ destinations, realSplits });

    await expect(
      persistAccountHolderFundingArtifacts(db, {
        batch: { id: bad as number, status: "confirmado", accountHolderInsuredId: insuredId },
        plan, paymentDate: PDATE, createdBy: userId, debtReason: null,
        splitIdByKey: new Map(), paymentIdByKey: new Map(), cashEntryIdByKey: new Map(),
      })
    ).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("overflow: plan.creditAppliedCents no entero lanza AccountHolderFundingBatchError", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }];
    const plan = buildPersistablePlan({ destinations, realSplits, creditAppliedCents: 30000, availableCreditCents: 30000 });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const tamperedPlan = { ...plan, creditAppliedCents: 1.5 };

    await expect(
      persistAccountHolderFundingArtifacts(db, {
        batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
        plan: tamperedPlan, paymentDate: PDATE, createdBy: userId, debtReason: null,
        splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
      })
    ).rejects.toThrow(AccountHolderFundingBatchError);
    expect(await countRows(client!, "insured_account_movements")).toBe(0);
  });

  test("plan.roundingCoverageCents por encima del máximo permitido lanza (plan tamperado)", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 99700 }];
    const plan = buildPersistablePlan({ destinations, realSplits, roundingCoverageCents: 300 });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const tamperedPlan = { ...plan, roundingCoverageCents: 600 };

    await expect(
      persistAccountHolderFundingArtifacts(db, {
        batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
        plan: tamperedPlan, paymentDate: PDATE, createdBy: userId, debtReason: null,
        splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
      })
    ).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("plan tamperado con saldo a favor y saldo deudor simultáneos lanza sin escribir nada", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = buildPersistablePlan({ destinations, realSplits });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const tamperedPlan = { ...plan, newSaldoAFavorCents: 1000, newSaldoDeudorCents: 1000 };

    await expect(
      persistAccountHolderFundingArtifacts(db, {
        batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
        plan: tamperedPlan, paymentDate: PDATE, createdBy: userId, debtReason: null,
        splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
      })
    ).rejects.toThrow(AccountHolderFundingBatchError);
    expect(await countRows(client!, "insured_account_movements")).toBe(0);
  });

  test("paymentDate inválido lanza AccountHolderFundingBatchError", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = buildPersistablePlan({ destinations, realSplits });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    await expect(
      persistAccountHolderFundingArtifacts(db, {
        batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
        plan, paymentDate: "15/01/2026", createdBy: userId, debtReason: null,
        splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
      })
    ).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[0], [-1], [1.5], [NaN]])("createdBy inválido (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = buildPersistablePlan({ destinations, realSplits });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    await expect(
      persistAccountHolderFundingArtifacts(db, {
        batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
        plan, paymentDate: PDATE, createdBy: bad as number, debtReason: null,
        splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
      })
    ).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[null], [undefined], [[]], [{}], ["x"]])("params no-objeto/malformado (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    await expect(persistAccountHolderFundingArtifacts(db, bad as any)).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([["splitIdByKey"], ["paymentIdByKey"], ["cashEntryIdByKey"]])("%s no-Map lanza AccountHolderFundingBatchError", async (field) => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = buildPersistablePlan({ destinations, realSplits });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const params: any = {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan, paymentDate: PDATE, createdBy: userId, debtReason: null,
      splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
    };
    params[field] = { notAMap: true };

    await expect(persistAccountHolderFundingArtifacts(db, params)).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("determinismo: dos batches estructuralmente idénticos producen el mismo resultado (salvo ids reales)", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }];
    const plan = buildPersistablePlan({ destinations, realSplits, creditAppliedCents: 30000, availableCreditCents: 30000 });

    const fxA = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });
    const fxB = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const resultA = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fxA.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan, paymentDate: PDATE, createdBy: userId, debtReason: null,
      splitIdByKey: fxA.splitIdByKey, paymentIdByKey: fxA.paymentIdByKey, cashEntryIdByKey: fxA.cashEntryIdByKey,
    });
    const resultB = await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fxB.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan, paymentDate: PDATE, createdBy: userId, debtReason: null,
      splitIdByKey: fxB.splitIdByKey, paymentIdByKey: fxB.paymentIdByKey, cashEntryIdByKey: fxB.cashEntryIdByKey,
    });

    expect(resultA.allocationRows.length).toBe(resultB.allocationRows.length);
    expect(resultA.allocationRows.map((r) => r.amountCents)).toEqual(resultB.allocationRows.map((r) => r.amountCents));
    // Mismo "shape" de columnas usadas fila a fila (cuál columna es no-nula), sin comparar los ids reales (necesariamente distintos entre A y B).
    const shape = (rows: typeof resultA.allocationRows) =>
      rows.map((r) => ({
        source: r.paymentBatchSplitId !== null ? "split" : r.sourceAccountMovementId !== null ? "movement" : "adjustment",
        destination: r.paymentId !== null ? "payment" : r.cashEntryId !== null ? "cash_entry" : "movement",
        amountCents: r.amountCents,
      }));
    expect(shape(resultA.allocationRows)).toEqual(shape(resultB.allocationRows));
    expect(resultA.creditMovementId).not.toBe(resultB.creditMovementId); // ids reales distintos, batches distintos
  });

  test("no muta los Maps de entrada (splitIdByKey/paymentIdByKey/cashEntryIdByKey)", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = buildPersistablePlan({ destinations, realSplits });
    const fx = await buildBatchFixture(client!, { accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId, destinations, realSplits });

    const splitSnapshot = new Map(fx.splitIdByKey);
    const paymentSnapshot = new Map(fx.paymentIdByKey);
    const cashEntrySnapshot = new Map(fx.cashEntryIdByKey);

    await persistAccountHolderFundingArtifacts(db, {
      batch: { id: fx.batchId, status: "confirmado", accountHolderInsuredId: insuredId },
      plan, paymentDate: PDATE, createdBy: userId, debtReason: null,
      splitIdByKey: fx.splitIdByKey, paymentIdByKey: fx.paymentIdByKey, cashEntryIdByKey: fx.cashEntryIdByKey,
    });

    expect(fx.splitIdByKey).toEqual(splitSnapshot);
    expect(fx.paymentIdByKey).toEqual(paymentSnapshot);
    expect(fx.cashEntryIdByKey).toEqual(cashEntrySnapshot);
  });
});

// ─── 6. Idempotencia del flujo con titular — Etapa 1B-3-C1 ─────────────────

const IDEMP_ENDPOINT = "POST /payment-batches";

/** Batch mínimo válido, solo como blanco real de la FK payment_batch_id — sin splits/payments/cash_entries (no los necesita ningún test de esta sección). */
async function insertPlainBatch(overrides: { accountHolderInsuredId?: number | null; status?: "confirmado" | "anulado" } = {}): Promise<number> {
  return insertBatch(client!, {
    accountHolderInsuredId: overrides.accountHolderInsuredId ?? insuredId,
    baseAmountCents: 100000,
    totalReceivedCents: 100000,
    paymentDate: PDATE,
    status: overrides.status,
    createdBy: userId,
  });
}

function buildIdempotencyRowParams(batchId: number, overrides: Partial<InsertAccountHolderFundingIdempotencyRowParams> = {}): InsertAccountHolderFundingIdempotencyRowParams {
  return {
    createdBy: userId,
    endpoint: IDEMP_ENDPOINT,
    idempotencyKey: "qa-key-1",
    requestFingerprint: "fp-qa-1",
    paymentBatchId: batchId,
    responseStatus: 201,
    responseSnapshot: JSON.stringify({ id: batchId }),
    ...overrides,
  };
}

describe("findAccountHolderFundingIdempotencyRow", () => {
  test("lookup inexistente: devuelve null", async () => {
    const row = await findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "no-existe" });
    expect(row).toBeNull();
  });

  test("inserción completa y lectura exacta: todos los campos coinciden bit a bit", async () => {
    const batchId = await insertPlainBatch();
    const snapshot = JSON.stringify({ id: batchId, status: 201, splits: [1, 2, 3] });
    const insertedId = await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, {
      idempotencyKey: "qa-key-exact", requestFingerprint: "fp-exact", responseStatus: 201, responseSnapshot: snapshot,
    }));

    const row = await findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "qa-key-exact" });
    expect(row).not.toBeNull();
    expect(row!.id).toBe(insertedId);
    expect(row!.createdBy).toBe(userId);
    expect(row!.endpoint).toBe(IDEMP_ENDPOINT);
    expect(row!.idempotencyKey).toBe("qa-key-exact");
    expect(row!.requestFingerprint).toBe("fp-exact");
    expect(row!.paymentBatchId).toBe(batchId);
    expect(row!.responseStatus).toBe(201);
    expect(row!.responseSnapshot).toBe(snapshot);
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  test("lookup recorta idempotencyKey antes de buscar: coincide con la clave guardada ya recortada", async () => {
    const batchId = await insertPlainBatch();
    await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, { idempotencyKey: "  clave-con-espacios  " }));

    const row = await findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "clave-con-espacios" });
    expect(row).not.toBeNull();
    expect(row!.idempotencyKey).toBe("clave-con-espacios");
  });

  test("determinismo: dos lecturas consecutivas devuelven el mismo contenido", async () => {
    const batchId = await insertPlainBatch();
    await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, { idempotencyKey: "qa-key-determinismo" }));

    const first = await findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "qa-key-determinismo" });
    const second = await findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "qa-key-determinismo" });
    expect(first).toEqual(second);
  });

  test("no muta el objeto params recibido", async () => {
    const params = { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "  qa-key-no-mutar  " };
    const snapshot = { ...params };
    await findAccountHolderFundingIdempotencyRow(db, params);
    expect(params).toEqual(snapshot);
  });

  test.each([[0], [-1], [1.5], [NaN]])("createdBy inválido (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    await expect(findAccountHolderFundingIdempotencyRow(db, { createdBy: bad as number, endpoint: IDEMP_ENDPOINT, idempotencyKey: "x" })).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([["GET /payment-batches"], ["POST /payment-batches/"], [""], [" POST /payment-batches"], [null], [undefined], [123]])(
    "endpoint inválido (%p) lanza AccountHolderFundingBatchError",
    async (bad) => {
      await expect(findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: bad as string, idempotencyKey: "x" })).rejects.toThrow(AccountHolderFundingBatchError);
    }
  );

  test.each([[""], ["   "], [123], [null], [undefined], [true], [[]], [{}]])("idempotencyKey inválida (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    await expect(findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: bad as string })).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("idempotencyKey de 201 caracteres lanza AccountHolderFundingBatchError", async () => {
    await expect(
      findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "x".repeat(201) })
    ).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("idempotencyKey cuenta code points Unicode, no unidades UTF-16: 200 emoji fuera del BMP no lanza", async () => {
    const key = "😀".repeat(200);
    expect(key.length).toBe(400); // unidades UTF-16 — confirma que no es lo que se usa para validar
    await expect(findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: key })).resolves.toBeNull();
  });

  test.each([[null], [undefined], [[]], ["x"]])("params no-objeto (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    await expect(findAccountHolderFundingIdempotencyRow(db, bad as any)).rejects.toThrow(AccountHolderFundingBatchError);
  });
});

describe("resolveExistingIdempotentFundingRow", () => {
  function makeRow(overrides: Partial<AccountHolderFundingIdempotencyRow> = {}): AccountHolderFundingIdempotencyRow {
    return {
      id: 1, createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "qa-key-1",
      requestFingerprint: "fp-real", paymentBatchId: 42, responseStatus: 201,
      responseSnapshot: JSON.stringify({ id: 42 }), createdAt: new Date(),
      ...overrides,
    };
  }

  test("mismo fingerprint: devuelve exactamente responseStatus/responseSnapshot/paymentBatchId almacenados, sin reinterpretar el snapshot", () => {
    const row = makeRow({ responseSnapshot: '{"raw":"tal cual"}' });
    const result = resolveExistingIdempotentFundingRow(row, "fp-real");
    expect(result).toEqual({ paymentBatchId: 42, responseStatus: 201, responseSnapshot: '{"raw":"tal cual"}' });
  });

  test("fingerprint diferente: lanza FundingIdempotencyConflictError", () => {
    const row = makeRow({ requestFingerprint: "fp-guardado" });
    expect(() => resolveExistingIdempotentFundingRow(row, "fp-distinto")).toThrow(FundingIdempotencyConflictError);
  });

  test("no muta la fila recibida", () => {
    const row = makeRow();
    const snapshot = { ...row };
    resolveExistingIdempotentFundingRow(row, row.requestFingerprint);
    expect(row).toEqual(snapshot);
  });

  test("determinismo: dos llamadas con los mismos argumentos devuelven el mismo resultado", () => {
    const row = makeRow();
    const a = resolveExistingIdempotentFundingRow(row, row.requestFingerprint);
    const b = resolveExistingIdempotentFundingRow(row, row.requestFingerprint);
    expect(a).toEqual(b);
  });

  test.each([[""], [123], [null], [undefined]])("requestFingerprint inválido (%p) lanza AccountHolderFundingBatchError", (bad) => {
    const row = makeRow();
    expect(() => resolveExistingIdempotentFundingRow(row, bad as string)).toThrow(AccountHolderFundingBatchError);
  });

  test.each([[0], [-1], [1.5]])("existingRow.paymentBatchId inválido (%p) lanza AccountHolderFundingBatchError", (bad) => {
    const row = makeRow({ paymentBatchId: bad as number });
    expect(() => resolveExistingIdempotentFundingRow(row, row.requestFingerprint)).toThrow(AccountHolderFundingBatchError);
  });

  test.each([[99], [0], [-1], [600], [1.5]])("existingRow.responseStatus inválido (%p) lanza AccountHolderFundingBatchError", (bad) => {
    const row = makeRow({ responseStatus: bad as number });
    expect(() => resolveExistingIdempotentFundingRow(row, row.requestFingerprint)).toThrow(AccountHolderFundingBatchError);
  });

  test.each([[""], [null], [undefined]])("existingRow.responseSnapshot inválido (%p) lanza AccountHolderFundingBatchError", (bad) => {
    const row = makeRow({ responseSnapshot: bad as string });
    expect(() => resolveExistingIdempotentFundingRow(row, row.requestFingerprint)).toThrow(AccountHolderFundingBatchError);
  });

  test.each([[null], [undefined], [[]], ["x"]])("existingRow no-objeto (%p) lanza AccountHolderFundingBatchError", (bad) => {
    expect(() => resolveExistingIdempotentFundingRow(bad as any, "fp")).toThrow(AccountHolderFundingBatchError);
  });
});

describe("insertAccountHolderFundingIdempotencyRow", () => {
  test("mismo fingerprint end-to-end: find + resolve devuelven status/snapshot/batch guardados", async () => {
    const batchId = await insertPlainBatch();
    const snapshot = JSON.stringify({ id: batchId, ok: true });
    await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, {
      idempotencyKey: "qa-key-e2e", requestFingerprint: "fp-e2e", responseStatus: 201, responseSnapshot: snapshot,
    }));

    const row = await findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "qa-key-e2e" });
    const resolved = resolveExistingIdempotentFundingRow(row!, "fp-e2e");
    expect(resolved).toEqual({ paymentBatchId: batchId, responseStatus: 201, responseSnapshot: snapshot });
  });

  test("dos claves idénticas para usuarios distintos coexisten", async () => {
    const batchId1 = await insertPlainBatch();
    const batchId2 = await insertPlainBatch();
    const [{ id: otherUserId }] = (await client!.execute(`INSERT INTO users (name) VALUES ('QA otro usuario') RETURNING id`)).rows as any[];

    const id1 = await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId1, { createdBy: userId, idempotencyKey: "clave-compartida" }));
    const id2 = await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId2, { createdBy: Number(otherUserId), idempotencyKey: "clave-compartida" }));

    expect(id1).not.toBe(id2);
    const row1 = await findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "clave-compartida" });
    const row2 = await findAccountHolderFundingIdempotencyRow(db, { createdBy: Number(otherUserId), endpoint: IDEMP_ENDPOINT, idempotencyKey: "clave-compartida" });
    expect(row1!.paymentBatchId).toBe(batchId1);
    expect(row2!.paymentBatchId).toBe(batchId2);
  });

  test("mismo (createdBy, idempotencyKey) con endpoint distinto: el ESQUEMA los deja coexistir (UNIQUE compuesto), aunque el helper dedicado solo acepta el endpoint real", async () => {
    const batchId1 = await insertPlainBatch();
    const batchId2 = await insertPlainBatch();

    // Bypass deliberado del helper — SQL crudo — para probar el comportamiento
    // real del UNIQUE(created_by, endpoint, idempotency_key) de la migración
    // 0036, independiente de que este módulo solo maneje POST /payment-batches.
    await client!.execute(
      `INSERT INTO account_holder_funding_idempotency_keys (created_by, endpoint, idempotency_key, request_fingerprint, payment_batch_id, response_status, response_snapshot, created_at) VALUES (?, 'POST /payment-batches', 'clave-endpoint', 'fp-a', ?, 201, '{}', ?)`,
      [userId, batchId1, Date.now()]
    );
    await client!.execute(
      `INSERT INTO account_holder_funding_idempotency_keys (created_by, endpoint, idempotency_key, request_fingerprint, payment_batch_id, response_status, response_snapshot, created_at) VALUES (?, 'POST /payment-batches-otro', 'clave-endpoint', 'fp-b', ?, 201, '{}', ?)`,
      [userId, batchId2, Date.now()]
    );
    expect(await countRows(client!, "account_holder_funding_idempotency_keys")).toBe(2);

    // El helper dedicado, en cambio, rechaza el endpoint no permitido — nunca
    // asume que "cualquier string" es válido solo porque el esquema lo acepte.
    await expect(
      insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId1, { endpoint: "POST /payment-batches-otro", idempotencyKey: "clave-endpoint-2" }))
    ).rejects.toThrow(AccountHolderFundingBatchError);
    await expect(
      findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: "POST /payment-batches-otro", idempotencyKey: "clave-endpoint" })
    ).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("UNIQUE duplicado (mismo created_by+endpoint+idempotencyKey) se propaga tal cual — nunca se traduce a AccountHolderFundingBatchError", async () => {
    const batchId1 = await insertPlainBatch();
    const batchId2 = await insertPlainBatch();

    await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId1, { idempotencyKey: "clave-unique-dup", requestFingerprint: "fp-a" }));

    let caught: unknown = null;
    try {
      await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId2, { idempotencyKey: "clave-unique-dup", requestFingerprint: "fp-b" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught).not.toBeInstanceOf(AccountHolderFundingBatchError);
    // drizzle-orm/libsql envuelve el error real del driver en DrizzleQueryError
    // (.cause = el LibsqlError original) — el mensaje de UNIQUE vive ahí, no
    // en el mensaje de nivel superior ("Failed query: ..."). Cualquiera de
    // los dos niveles alcanza para confirmar que es el error crudo del
    // driver, nunca uno traducido por este helper.
    const rawMessage = String((caught as any)?.cause?.message ?? (caught as Error).message);
    expect(rawMessage).toContain("UNIQUE constraint failed");

    // Solo la primera fila quedó insertada — la segunda nunca se persistió.
    expect(await countRows(client!, "account_holder_funding_idempotency_keys")).toBe(1);
  });

  test("ningún placeholder: los valores guardados son EXACTAMENTE los pasados, sin defaults ni relleno", async () => {
    const batchId = await insertPlainBatch();
    const params = buildIdempotencyRowParams(batchId, {
      idempotencyKey: "qa-key-sin-placeholder", requestFingerprint: "fp-real-y-completo",
      responseStatus: 422, responseSnapshot: JSON.stringify({ error: "algo falló", details: [1, 2, 3] }),
    });
    await insertAccountHolderFundingIdempotencyRow(db, params);

    const row = await findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "qa-key-sin-placeholder" });
    expect(row!.requestFingerprint).toBe(params.requestFingerprint);
    expect(row!.responseStatus).toBe(422);
    expect(row!.responseSnapshot).toBe(params.responseSnapshot);
    expect(row!.paymentBatchId).toBe(batchId);
  });

  test("prueba con transacción externa: el error UNIQUE hace rollback de una escritura previa en la misma transacción", async () => {
    const batchId1 = await insertPlainBatch();
    const batchId2 = await insertPlainBatch();

    await expect(
      db.transaction(async (tx: any) => {
        // Escritura previa real dentro de la misma transacción externa.
        await insertAccountHolderFundingIdempotencyRow(tx, buildIdempotencyRowParams(batchId1, { idempotencyKey: "clave-rollback-tx", requestFingerprint: "fp-primera" }));
        // Segunda escritura con la MISMA clave natural — colisiona con la anterior, todavía sin commitear.
        await insertAccountHolderFundingIdempotencyRow(tx, buildIdempotencyRowParams(batchId2, { idempotencyKey: "clave-rollback-tx", requestFingerprint: "fp-segunda" }));
      })
    ).rejects.toThrow();

    // El rollback de la transacción externa deshace también la primera
    // escritura, ya exitosa dentro de esa misma transacción.
    expect(await countRows(client!, "account_holder_funding_idempotency_keys")).toBe(0);
  });

  test.each([[0], [-1], [1.5], [NaN]])("createdBy inválido (%p) lanza AccountHolderFundingBatchError sin escribir nada", async (bad) => {
    const batchId = await insertPlainBatch();
    await expect(insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, { createdBy: bad as number }))).rejects.toThrow(AccountHolderFundingBatchError);
    expect(await countRows(client!, "account_holder_funding_idempotency_keys")).toBe(0);
  });

  test.each([["GET /payment-batches"], [""], [null], [undefined], [123]])("endpoint inválido (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    const batchId = await insertPlainBatch();
    await expect(insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, { endpoint: bad as string }))).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[""], ["   "], [123], [null], [undefined]])("idempotencyKey inválida (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    const batchId = await insertPlainBatch();
    await expect(insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, { idempotencyKey: bad as string }))).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("idempotencyKey de 201 caracteres lanza AccountHolderFundingBatchError", async () => {
    const batchId = await insertPlainBatch();
    await expect(insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, { idempotencyKey: "x".repeat(201) }))).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[""], [123], [null], [undefined]])("requestFingerprint inválido (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    const batchId = await insertPlainBatch();
    await expect(insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, { requestFingerprint: bad as string }))).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[0], [-1], [1.5]])("paymentBatchId con forma inválida (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    await expect(insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(bad as number))).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("paymentBatchId con forma válida pero de un batch inexistente: la FK real se propaga tal cual (no es un error de forma)", async () => {
    const nonExistentBatchId = 999999;
    await expect(
      insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(nonExistentBatchId, { idempotencyKey: "qa-key-fk-inexistente" }))
    ).rejects.not.toBeInstanceOf(AccountHolderFundingBatchError);
    expect(await countRows(client!, "account_holder_funding_idempotency_keys")).toBe(0);
  });

  test.each([[99], [0], [-1], [600], [1.5], [NaN]])("responseStatus inválido (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    const batchId = await insertPlainBatch();
    await expect(insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, { responseStatus: bad as number }))).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[""], [123], [null], [undefined]])("responseSnapshot inválido (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    const batchId = await insertPlainBatch();
    await expect(insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, { responseSnapshot: bad as string }))).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[null], [undefined], [[]], ["x"]])("params no-objeto (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    await expect(insertAccountHolderFundingIdempotencyRow(db, bad as any)).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("no muta el objeto params recibido", async () => {
    const batchId = await insertPlainBatch();
    const params = buildIdempotencyRowParams(batchId, { idempotencyKey: "  clave-no-mutar  " });
    const snapshot = { ...params };
    await insertAccountHolderFundingIdempotencyRow(db, params);
    expect(params).toEqual(snapshot);
  });
});

// ─── 7. runAccountHolderFundingBatch — orquestación completa, Etapa 1B-3-C2 ─
//
// Las dependencias FAKE de acá insertan filas REALES (payment_batches/
// payment_batch_splits/payments/cash_entries) vía `tx` — nunca simulan datos
// en memoria — para que persistAccountHolderFundingArtifacts (llamado por el
// orquestador real, sin mocks) reciba exactamente lo que recibiría en
// producción.
//
// Tablas Drizzle LOCALES (testPaymentBatches/testPaymentBatchSplits/
// testPayments/testCashEntries), no los objetos importados de
// database/schema.ts: Drizzle arma el INSERT con TODAS las columnas
// declaradas en el objeto de tabla (default o NULL para las que no se pasan
// en `.values()`, no solo las presentes) — confirmado empíricamente acá (un
// primer intento con los objetos completos de schema.ts falló con "table
// payment_batches has no column named notes", porque esa tabla física
// (createSchema, arriba) es la versión MÍNIMA histórica de este harness, sin
// notes/updatedAt/cancelledAt/etc.). Estas tablas locales declaran
// ÚNICAMENTE las columnas reales del DDL de createSchema — nunca se usan
// para nada fuera de esta sección.
const testPaymentBatches = sqliteTable("payment_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  insuredId: integer("insured_id"),
  baseAmountCents: integer("base_amount_cents").notNull(),
  surchargeAmountCents: integer("surcharge_amount_cents").notNull().default(0),
  totalReceivedCents: integer("total_received_cents").notNull(),
  paymentDate: text("payment_date").notNull(),
  status: text("status").notNull().default("confirmado"),
  createdBy: integer("created_by"),
  createdAt: integer("created_at"),
  receivedAmountCents: integer("received_amount_cents"),
  accountHolderInsuredId: integer("account_holder_insured_id"),
});
const testPaymentBatchSplits = sqliteTable("payment_batch_splits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: integer("batch_id").notNull(),
  method: text("method").notNull(),
  amountCents: integer("amount_cents").notNull(),
  createdAt: integer("created_at"),
});
const testPayments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: integer("batch_id"),
  amount: real("amount").notNull(),
  paymentMethod: text("payment_method").notNull(),
  paymentDate: text("payment_date").notNull(),
  status: text("status").notNull().default("confirmado"),
  createdAt: integer("created_at"),
});
const testCashEntries = sqliteTable("cash_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientName: text("client_name").notNull(),
  amount: real("amount").notNull(),
  paymentMethod: text("payment_method").notNull(),
  paymentDate: text("payment_date").notNull(),
  entryType: text("entry_type").notNull().default("normal"),
  paymentId: integer("payment_id"),
  status: text("status").notNull().default("activo"),
  createdAt: integer("created_at"),
});

interface OrchestrationFixtureConfig {
  accountHolderInsuredId: number;
  paymentDate: string;
  createdBy: number;
  destinations: FundingDestinationInput[];
  realSplits: FundingPlanSplitInput[];
  batchStatus?: "confirmado" | "anulado";
  /** Solo para el test defensivo de titular inconsistente — el resto nunca lo usa. */
  batchAccountHolderInsuredIdOverride?: number;
}

function buildOrchestrationDependencies(cfg: OrchestrationFixtureConfig): AccountHolderFundingBatchDependencies {
  const baseAmountCents = cfg.destinations.filter((d) => d.kind === "payment").reduce((acc, d) => acc + d.nominalCents, 0);
  const surchargeAmountCents = cfg.destinations.filter((d) => d.kind === "pronto_pago").reduce((acc, d) => acc + d.nominalCents, 0);
  const totalReceivedCents = cfg.realSplits.reduce((acc, s) => acc + s.amountCents, 0);

  return {
    createBatch: async (tx: any): Promise<BatchSnapshot> => {
      const accountHolderInsuredId = cfg.batchAccountHolderInsuredIdOverride ?? cfg.accountHolderInsuredId;
      const status = cfg.batchStatus ?? "confirmado";
      const [row] = await tx.insert(testPaymentBatches).values({
        accountHolderInsuredId,
        baseAmountCents: baseAmountCents || 1,
        surchargeAmountCents,
        totalReceivedCents: totalReceivedCents || 1,
        paymentDate: cfg.paymentDate,
        status,
        createdBy: cfg.createdBy,
      }).returning({ id: testPaymentBatches.id });
      return { id: row!.id as number, status, accountHolderInsuredId };
    },
    createChildRows: async (tx: any, batch: BatchSnapshot): Promise<AccountHolderFundingChildRows> => {
      const splitIdByKey = new Map<string, number>();
      for (const s of cfg.realSplits) {
        const [row] = await tx.insert(testPaymentBatchSplits).values({
          batchId: batch.id, method: "efectivo", amountCents: s.amountCents,
        }).returning({ id: testPaymentBatchSplits.id });
        splitIdByKey.set(s.id, row!.id as number);
      }

      const paymentIdByKey = new Map<string, number>();
      const cashEntryIdByKey = new Map<string, number>();
      const paymentDestinations = cfg.destinations.filter((d) => d.kind === "payment");
      const prontoPagoDestinations = cfg.destinations.filter((d) => d.kind === "pronto_pago");

      for (const d of paymentDestinations) {
        const [row] = await tx.insert(testPayments).values({
          amount: d.nominalCents / 100, paymentMethod: "lote", paymentDate: cfg.paymentDate,
          status: "confirmado", batchId: batch.id,
        }).returning({ id: testPayments.id });
        paymentIdByKey.set(d.id, row!.id as number);
      }

      let hostPaymentId: number | null = paymentDestinations.length > 0 ? paymentIdByKey.get(paymentDestinations[0]!.id)! : null;
      if (prontoPagoDestinations.length > 0 && hostPaymentId === null) {
        const [row] = await tx.insert(testPayments).values({
          amount: 1, paymentMethod: "lote", paymentDate: cfg.paymentDate, status: "confirmado", batchId: batch.id,
        }).returning({ id: testPayments.id });
        hostPaymentId = row!.id as number;
      }
      for (const d of prontoPagoDestinations) {
        const [row] = await tx.insert(testCashEntries).values({
          clientName: "QA", amount: d.nominalCents / 100, paymentMethod: "lote", paymentDate: cfg.paymentDate,
          entryType: "pronto_pago_surcharge", paymentId: hostPaymentId!, status: "activo",
        }).returning({ id: testCashEntries.id });
        cashEntryIdByKey.set(d.id, row!.id as number);
      }

      return { splitIdByKey, paymentIdByKey, cashEntryIdByKey };
    },
    buildResponseSnapshot: async (_tx: any, ctx) => ({
      responseStatus: 201,
      responseSnapshot: JSON.stringify({ batchId: ctx.batch.id, allocations: ctx.artifacts.allocationRows.length }),
    }),
  };
}

function buildOrchestrationParams(args: {
  idempotencyKey: string;
  requestFingerprint: string;
  destinations: FundingDestinationInput[];
  realSplits: FundingPlanSplitInput[];
  accountHolderInsuredId?: number;
  paymentDate?: string;
  creditAppliedCents?: number;
  roundingCoverageCents?: number;
  debtAuthorized?: boolean;
  debtReason?: string | null;
  dependencies?: AccountHolderFundingBatchDependencies;
  db?: any;
}): RunAccountHolderFundingBatchParams {
  const accountHolderInsuredId = args.accountHolderInsuredId ?? insuredId;
  const paymentDate = args.paymentDate ?? PDATE;
  return {
    db: args.db ?? db,
    createdBy: userId,
    idempotencyKey: args.idempotencyKey,
    requestFingerprint: args.requestFingerprint,
    accountHolderInsuredId,
    paymentDate,
    destinations: args.destinations,
    realSplits: args.realSplits,
    creditAppliedCents: args.creditAppliedCents ?? 0,
    roundingCoverageCents: args.roundingCoverageCents ?? 0,
    debtAuthorized: args.debtAuthorized ?? false,
    debtReason: args.debtReason ?? null,
    dependencies: args.dependencies ?? buildOrchestrationDependencies({
      accountHolderInsuredId, paymentDate, createdBy: userId, destinations: args.destinations, realSplits: args.realSplits,
    }),
  };
}

/** Cuenta llamadas a `.transaction()` sin alterar su comportamiento real — Proxy transparente para todo lo demás. */
function withTransactionSpy(realDb: any): { db: any; transactionCallCount: () => number } {
  let count = 0;
  const proxied = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return (...args: any[]) => {
          count++;
          return (target as any).transaction(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: proxied, transactionCallCount: () => count };
}

/** Cuenta llamadas a cada dependencia sin alterar su comportamiento real. */
function withDependencyCallCounters(deps: AccountHolderFundingBatchDependencies): {
  deps: AccountHolderFundingBatchDependencies;
  counts: { createBatch: number; createChildRows: number; buildResponseSnapshot: number };
} {
  const counts = { createBatch: 0, createChildRows: 0, buildResponseSnapshot: 0 };
  return {
    counts,
    deps: {
      createBatch: async (tx) => { counts.createBatch++; return deps.createBatch(tx); },
      createChildRows: async (tx, batch) => { counts.createChildRows++; return deps.createChildRows(tx, batch); },
      buildResponseSnapshot: async (tx, ctx) => { counts.buildResponseSnapshot++; return deps.buildResponseSnapshot(tx, ctx); },
    },
  };
}

/** Mismo shape real que produce @libsql/client + drizzle-orm/libsql (DrizzleQueryError con .cause = LibsqlError) — ver el test "UNIQUE duplicado" de la sección 6, que confirmó este shape contra un error REAL. */
function makeSyntheticIdempotencyUniqueError(): Error {
  const err = new Error(
    `Failed query: insert into "account_holder_funding_idempotency_keys" (...) values (...)`
  ) as Error & { cause?: unknown };
  err.cause = new Error(
    "UNIQUE constraint failed: account_holder_funding_idempotency_keys.created_by, account_holder_funding_idempotency_keys.endpoint, account_holder_funding_idempotency_keys.idempotency_key"
  );
  return err;
}

/**
 * Inyecta el punto de fallo (ver cabecera de la sección 6 en el archivo de
 * implementación, "por qué NO se puede reproducir con concurrencia real"):
 * intercepta ÚNICAMENTE la llamada `tx.insert(accountHolderFundingIdempotencyKeys)`
 * dentro de la transacción real (todo lo demás — batch/splits/payments/
 * movimientos/allocations — se escribe de verdad, con la MISMA `tx` real, y
 * se revierte de verdad cuando la sentencia inyectada lanza) y, recién
 * DESPUÉS de que esa transacción real ya terminó de revertirse (en el
 * `.catch` de la promesa de `.transaction()`, nunca dentro de ella), ejecuta
 * `onFailure` — secuencial y determinista, sin locks ni timing.
 */
function withInjectedIdempotencyUniqueFailure(realDb: any, onFailure: () => Promise<void>): any {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return (cb: any) =>
          (target as any)
            .transaction((tx: any) => {
              const wrappedTx = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === "insert") {
                    return (table: any) => {
                      if (table === accountHolderFundingIdempotencyKeys) {
                        throw makeSyntheticIdempotencyUniqueError();
                      }
                      return (txTarget as any).insert(table);
                    };
                  }
                  return Reflect.get(txTarget, txProp, txReceiver);
                },
              });
              return cb(wrappedTx);
            })
            .catch(async (err: any) => {
              await onFailure();
              throw err;
            });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe("isAccountHolderFundingIdempotencyUniqueViolation", () => {
  test("detecta un error REAL de UNIQUE de esta tabla (mismo mecanismo que la Etapa 1B-3-C1)", async () => {
    const batchId1 = await insertPlainBatch();
    const batchId2 = await insertPlainBatch();
    await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId1, { idempotencyKey: "qa-detector-real", requestFingerprint: "fp-a" }));

    let caught: unknown = null;
    try {
      await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId2, { idempotencyKey: "qa-detector-real", requestFingerprint: "fp-b" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(isAccountHolderFundingIdempotencyUniqueViolation(caught)).toBe(true);
  });

  test("no detecta un error genérico no relacionado", () => {
    expect(isAccountHolderFundingIdempotencyUniqueViolation(new Error("fallo de red cualquiera"))).toBe(false);
  });

  test("no detecta un UNIQUE de OTRA tabla (mismo texto, distinto nombre de tabla)", () => {
    const err = new Error("Failed query") as Error & { cause?: unknown };
    err.cause = new Error("UNIQUE constraint failed: payment_batch_funding_allocations.payment_batch_split_id, payment_batch_funding_allocations.payment_id");
    expect(isAccountHolderFundingIdempotencyUniqueViolation(err)).toBe(false);
  });

  test.each([[null], [undefined], ["string plano"], [{ message: "UNIQUE constraint failed: account_holder_funding_idempotency_keys" }]])(
    "valores que no son Error (%p) devuelven false",
    (bad) => {
      expect(isAccountHolderFundingIdempotencyUniqueViolation(bad)).toBe(false);
    }
  );
});

describe("reconcileAccountHolderFundingIdempotencyConflict", () => {
  test("mismo fingerprint: devuelve status/snapshot/batch del ganador ya guardado", async () => {
    const batchId = await insertPlainBatch();
    const snapshot = JSON.stringify({ id: batchId });
    await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, {
      idempotencyKey: "qa-reconcile-1", requestFingerprint: "fp-ganador", responseStatus: 201, responseSnapshot: snapshot,
    }));

    const result = await reconcileAccountHolderFundingIdempotencyConflict(db, { createdBy: userId, idempotencyKey: "qa-reconcile-1", requestFingerprint: "fp-ganador" });
    expect(result).toEqual({ paymentBatchId: batchId, responseStatus: 201, responseSnapshot: snapshot });
  });

  test("fingerprint distinto: FundingIdempotencyConflictError", async () => {
    const batchId = await insertPlainBatch();
    await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, { idempotencyKey: "qa-reconcile-2", requestFingerprint: "fp-guardado" }));

    await expect(
      reconcileAccountHolderFundingIdempotencyConflict(db, { createdBy: userId, idempotencyKey: "qa-reconcile-2", requestFingerprint: "fp-otro" })
    ).rejects.toThrow(FundingIdempotencyConflictError);
  });

  test("no encuentra ninguna fila: AccountHolderFundingBatchError explícito, nunca en silencio", async () => {
    await expect(
      reconcileAccountHolderFundingIdempotencyConflict(db, { createdBy: userId, idempotencyKey: "qa-reconcile-inexistente", requestFingerprint: "fp-x" })
    ).rejects.toThrow(AccountHolderFundingBatchError);
  });
});

describe("runAccountHolderFundingTransaction — envoltorio try/catch/reconciliación", () => {
  test("runTransaction exitoso: devuelve su resultado sin llamar a reconciliación", async () => {
    const expected: RunAccountHolderFundingBatchResult = { paymentBatchId: 1, responseStatus: 201, responseSnapshot: "{}" };
    const result = await runAccountHolderFundingTransaction(db, async () => expected, { createdBy: userId, idempotencyKey: "x", requestFingerprint: "y" });
    expect(result).toBe(expected);
  });

  test("runTransaction lanza un error UNIQUE inyectado: reconcilia con el ganador pre-existente", async () => {
    const batchId = await insertPlainBatch();
    const snapshot = JSON.stringify({ winner: true });
    await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, {
      idempotencyKey: "qa-wrapper-unique", requestFingerprint: "fp-ganador", responseStatus: 201, responseSnapshot: snapshot,
    }));

    const result = await runAccountHolderFundingTransaction(
      db,
      async () => { throw makeSyntheticIdempotencyUniqueError(); },
      { createdBy: userId, idempotencyKey: "qa-wrapper-unique", requestFingerprint: "fp-ganador" }
    );
    expect(result).toEqual({ paymentBatchId: batchId, responseStatus: 201, responseSnapshot: snapshot });
  });

  test("runTransaction lanza un error no-UNIQUE: se propaga sin reconciliar", async () => {
    await expect(
      runAccountHolderFundingTransaction(
        db,
        async () => { throw new AccountHolderFundingBatchError("fallo no relacionado con UNIQUE"); },
        { createdBy: userId, idempotencyKey: "qa-wrapper-otro", requestFingerprint: "fp-z" }
      )
    ).rejects.toThrow("fallo no relacionado con UNIQUE");
  });
});

describe("runAccountHolderFundingBatch — Etapa 1B-3-C2", () => {
  test("cache hit previo (mismo fingerprint): no abre transacción ni ejecuta creación", async () => {
    const batchId = await insertPlainBatch();
    const snapshot = JSON.stringify({ cached: true });
    await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, {
      idempotencyKey: "qa-cache-hit", requestFingerprint: "fp-cache", responseStatus: 201, responseSnapshot: snapshot,
    }));

    const spy = withTransactionSpy(db);
    const { deps, counts } = withDependencyCallCounters(buildOrchestrationDependencies({
      accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId,
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
    }));

    const result = await runAccountHolderFundingBatch(buildOrchestrationParams({
      idempotencyKey: "qa-cache-hit", requestFingerprint: "fp-cache",
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
      dependencies: deps, db: spy.db,
    }));

    expect(result).toEqual({ paymentBatchId: batchId, responseStatus: 201, responseSnapshot: snapshot });
    expect(spy.transactionCallCount()).toBe(0);
    expect(counts.createBatch).toBe(0);
    expect(counts.createChildRows).toBe(0);
    expect(counts.buildResponseSnapshot).toBe(0);
  });

  test("conflicto previo (fingerprint distinto): 409 de dominio, tampoco abre transacción", async () => {
    const batchId = await insertPlainBatch();
    await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(batchId, { idempotencyKey: "qa-conflicto-previo", requestFingerprint: "fp-guardado" }));

    const spy = withTransactionSpy(db);
    await expect(
      runAccountHolderFundingBatch(buildOrchestrationParams({
        idempotencyKey: "qa-conflicto-previo", requestFingerprint: "fp-distinto",
        destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
        db: spy.db,
      }))
    ).rejects.toThrow(FundingIdempotencyConflictError);
    expect(spy.transactionCallCount()).toBe(0);
  });

  test("fila encontrada en la revalidación interna (aparece entre el lookup rápido y la apertura de la tx): no crea un segundo batch", async () => {
    // Simula, de forma determinista y secuencial (nunca con timing/locks
    // reales), que "otra request" terminó y committeó su fila ganadora justo
    // después del lookup rápido pero antes de abrir la transacción propia —
    // el `db.transaction` fake inserta esa fila primero, luego abre la
    // transacción real.
    const winnerBatchId = await insertPlainBatch();
    const winnerSnapshot = JSON.stringify({ winner: true });
    const winnerParams = buildIdempotencyRowParams(winnerBatchId, {
      idempotencyKey: "qa-revalidacion-interna", requestFingerprint: "fp-ganador-interno", responseStatus: 201, responseSnapshot: winnerSnapshot,
    });

    const dbWithLateWinner = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (cb: any) => {
            await insertAccountHolderFundingIdempotencyRow(db, winnerParams);
            return target.transaction(cb);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const { deps, counts } = withDependencyCallCounters(buildOrchestrationDependencies({
      accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId,
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
    }));

    const result = await runAccountHolderFundingBatch(buildOrchestrationParams({
      idempotencyKey: "qa-revalidacion-interna", requestFingerprint: "fp-ganador-interno",
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
      dependencies: deps, db: dbWithLateWinner,
    }));

    expect(result).toEqual({ paymentBatchId: winnerBatchId, responseStatus: 201, responseSnapshot: winnerSnapshot });
    expect(counts.createBatch).toBe(0); // nunca se creó un segundo batch
    expect(await countRows(client!, "payment_batches")).toBe(1); // solo el batch "ganador" pre-existente
  });

  test("éxito completo: orden observable batch->children->artifacts->responseSnapshot->idempotencia (última escritura)", async () => {
    const steps: string[] = [];
    const realDeps = buildOrchestrationDependencies({
      accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId,
      destinations: [{ id: "d1", kind: "payment", nominalCents: 80000 }, { id: "d2", kind: "pronto_pago", nominalCents: 20000 }],
      realSplits: [{ id: "s1", amountCents: 100000 }],
    });
    const instrumentedDeps: AccountHolderFundingBatchDependencies = {
      createBatch: async (tx) => {
        steps.push("createBatch:start");
        const batch = await realDeps.createBatch(tx);
        steps.push("createBatch:end");
        return batch;
      },
      createChildRows: async (tx, batch) => {
        steps.push("createChildRows:start");
        const batchRows = await tx.select({ id: testPaymentBatches.id }).from(testPaymentBatches).where(eq(testPaymentBatches.id, batch.id)).all();
        expect(batchRows.length).toBe(1); // el batch YA existe de verdad en esta misma tx
        const result = await realDeps.createChildRows(tx, batch);
        steps.push("createChildRows:end");
        return result;
      },
      buildResponseSnapshot: async (tx, ctx) => {
        steps.push("buildResponseSnapshot:start");
        expect(ctx.artifacts.allocationRows.length).toBeGreaterThan(0); // artifacts YA persistidos de verdad
        const idempSoFar = await findAccountHolderFundingIdempotencyRow(tx, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "qa-orden-observable" });
        expect(idempSoFar).toBeNull(); // la fila de idempotencia TODAVÍA no existe
        const result = await realDeps.buildResponseSnapshot(tx, ctx);
        steps.push("buildResponseSnapshot:end");
        return result;
      },
    };

    const result = await runAccountHolderFundingBatch(buildOrchestrationParams({
      idempotencyKey: "qa-orden-observable", requestFingerprint: "fp-orden",
      destinations: [{ id: "d1", kind: "payment", nominalCents: 80000 }, { id: "d2", kind: "pronto_pago", nominalCents: 20000 }],
      realSplits: [{ id: "s1", amountCents: 100000 }], creditAppliedCents: 0,
      dependencies: instrumentedDeps,
    }));

    expect(steps).toEqual(["createBatch:start", "createBatch:end", "createChildRows:start", "createChildRows:end", "buildResponseSnapshot:start", "buildResponseSnapshot:end"]);
    expect(result.paymentBatchId).toBeGreaterThan(0);

    const finalRow = await findAccountHolderFundingIdempotencyRow(db, { createdBy: userId, endpoint: IDEMP_ENDPOINT, idempotencyKey: "qa-orden-observable" });
    expect(finalRow).not.toBeNull();
    expect(finalRow!.paymentBatchId).toBe(result.paymentBatchId);
    expect(finalRow!.responseSnapshot).toBe(result.responseSnapshot);
  });

  test("cambio de saldo dentro de la transacción: rollback total — el ceiling de crédito disponible ya no alcanza (AccountHolderFundingPlanError, ver nota)", async () => {
    // El plan preliminar (fuera de la tx) ve $300 de crédito disponible,
    // suficiente para creditAppliedCents=$300. `createBatch` (parte real de
    // la transacción) simula que otra operación consumió ese crédito justo
    // antes — la revalidación fresca (con `tx`, ya dentro de la
    // transacción) ve el saldo bajo y su PROPIO ceiling interno rechaza el
    // plan. No es FundingPlanRaceConditionError: ese error es para un plan
    // que CIERRA pero difiere del preliminar — un saldo insuficiente nunca
    // llega a cerrar un plan nuevo, revienta antes (mismo comportamiento ya
    // documentado y testeado para planFundingWithFreshBalance más arriba,
    // "integración — cambio de saldo real..." — no se duplica esa prueba,
    // se confirma que la orquestación la propaga y revierte todo).
    await insertMovement(db, { insuredId, type: "saldo_a_favor", signedAmountCents: 30000, createdBy: userId });

    const deps = buildOrchestrationDependencies({
      accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId,
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 70000 }],
    });
    const sabotagingDeps: AccountHolderFundingBatchDependencies = {
      ...deps,
      createBatch: async (tx) => {
        const batch = await deps.createBatch(tx);
        await insertMovement(tx, { insuredId, type: "aplicacion_saldo_favor", signedAmountCents: -20000, createdBy: userId });
        return batch;
      },
    };

    await expect(
      runAccountHolderFundingBatch(buildOrchestrationParams({
        idempotencyKey: "qa-saldo-cambia", requestFingerprint: "fp-saldo",
        destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 70000 }],
        creditAppliedCents: 30000, dependencies: sabotagingDeps,
      }))
    ).rejects.toThrow(AccountHolderFundingPlanError);

    // Rollback total: ni el batch ni el movimiento "saboteador" quedaron.
    expect(await countRows(client!, "payment_batches")).toBe(0);
    expect((await db.select().from(insuredAccountMovements).all()).length).toBe(1); // solo el saldo_a_favor inicial, sembrado FUERA de la tx fallida
  });

  test("error durante artifacts (mapping incompleto): rollback del batch y sus hijos", async () => {
    const deps = buildOrchestrationDependencies({
      accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId,
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
    });
    const brokenMappingDeps: AccountHolderFundingBatchDependencies = {
      ...deps,
      createChildRows: async (tx, batch) => {
        const rows = await deps.createChildRows(tx, batch);
        return { ...rows, paymentIdByKey: new Map() }; // "d1" nunca se mapea -> persistAccountHolderFundingArtifacts debe rechazar
      },
    };

    await expect(
      runAccountHolderFundingBatch(buildOrchestrationParams({
        idempotencyKey: "qa-artifacts-falla", requestFingerprint: "fp-artifacts",
        destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
        dependencies: brokenMappingDeps,
      }))
    ).rejects.toThrow();

    expect(await countRows(client!, "payment_batches")).toBe(0);
    expect(await countRows(client!, "payment_batch_splits")).toBe(0);
    expect(await countRows(client!, "payments")).toBe(0);
    expect(await countRows(client!, "account_holder_funding_idempotency_keys")).toBe(0);
  });

  test("UNIQUE perdido: rollback completo de la transacción propia, relectura externa y respuesta exacta del ganador", async () => {
    let winnerBatchId: number | null = null;
    const dbInjected = withInjectedIdempotencyUniqueFailure(db, async () => {
      winnerBatchId = await insertPlainBatch();
      await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(winnerBatchId, {
        idempotencyKey: "qa-unique-perdido", requestFingerprint: "fp-nuestro", responseStatus: 201, responseSnapshot: JSON.stringify({ winner: true }),
      }));
    });

    const result = await runAccountHolderFundingBatch(buildOrchestrationParams({
      idempotencyKey: "qa-unique-perdido", requestFingerprint: "fp-nuestro",
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
      db: dbInjected,
    }));

    if (winnerBatchId === null) throw new Error("winnerBatchId no fue asignado — bug en el fixture del test"); // narrowing real, no solo un expect
    expect(result).toEqual({ paymentBatchId: winnerBatchId, responseStatus: 201, responseSnapshot: JSON.stringify({ winner: true }) });
    // Nuestra propia transacción (batch/splits/payments) se revirtió por
    // completo — solo sobrevive el batch del "ganador" insertado después.
    expect(await countRows(client!, "payment_batches")).toBe(1);
    expect(await countRows(client!, "account_holder_funding_idempotency_keys")).toBe(1);
  });

  test("UNIQUE perdido con fingerprint distinto: conflicto de dominio, nunca el UNIQUE crudo", async () => {
    let winnerBatchId: number | null = null;
    const dbInjected = withInjectedIdempotencyUniqueFailure(db, async () => {
      winnerBatchId = await insertPlainBatch();
      await insertAccountHolderFundingIdempotencyRow(db, buildIdempotencyRowParams(winnerBatchId, {
        idempotencyKey: "qa-unique-perdido-conflicto", requestFingerprint: "fp-del-ganador",
      }));
    });

    await expect(
      runAccountHolderFundingBatch(buildOrchestrationParams({
        idempotencyKey: "qa-unique-perdido-conflicto", requestFingerprint: "fp-nuestro-distinto",
        destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
        db: dbInjected,
      }))
    ).rejects.toThrow(FundingIdempotencyConflictError);
  });

  test("error DB no relacionado con UNIQUE: se propaga sin disfrazar, no se confunde con una carrera de idempotencia", async () => {
    const deps = buildOrchestrationDependencies({
      accountHolderInsuredId: insuredId, paymentDate: PDATE, createdBy: userId,
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
    });
    const brokenDeps: AccountHolderFundingBatchDependencies = {
      ...deps,
      createChildRows: async () => { throw new Error("fallo de DB no relacionado — QA"); },
    };

    await expect(
      runAccountHolderFundingBatch(buildOrchestrationParams({
        idempotencyKey: "qa-error-no-unique", requestFingerprint: "fp-no-unique",
        destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
        dependencies: brokenDeps,
      }))
    ).rejects.toThrow("fallo de DB no relacionado — QA");

    expect(await countRows(client!, "payment_batches")).toBe(0);
    expect(await countRows(client!, "account_holder_funding_idempotency_keys")).toBe(0);
  });

  test("determinismo: dos ejecuciones estructuralmente iguales con claves distintas producen resultados consistentes", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];

    const resultA = await runAccountHolderFundingBatch(buildOrchestrationParams({
      idempotencyKey: "qa-determinismo-a", requestFingerprint: "fp-determinismo-a", destinations, realSplits,
    }));
    const resultB = await runAccountHolderFundingBatch(buildOrchestrationParams({
      idempotencyKey: "qa-determinismo-b", requestFingerprint: "fp-determinismo-b", destinations, realSplits,
    }));

    expect(resultA.responseStatus).toBe(resultB.responseStatus);
    expect(resultA.paymentBatchId).not.toBe(resultB.paymentBatchId); // batches reales distintos
    const snapA = JSON.parse(resultA.responseSnapshot);
    const snapB = JSON.parse(resultB.responseSnapshot);
    expect(snapA.allocations).toBe(snapB.allocations); // misma forma económica
  });

  test("no muta params.destinations/realSplits ni el objeto dependencies recibido", async () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const params = buildOrchestrationParams({ idempotencyKey: "qa-no-mutar", requestFingerprint: "fp-no-mutar", destinations, realSplits });
    const destinationsSnapshot = JSON.parse(JSON.stringify(params.destinations));
    const realSplitsSnapshot = JSON.parse(JSON.stringify(params.realSplits));
    const dependenciesRef = params.dependencies;

    await runAccountHolderFundingBatch(params);

    expect(params.destinations).toEqual(destinationsSnapshot);
    expect(params.realSplits).toEqual(realSplitsSnapshot);
    expect(params.dependencies).toBe(dependenciesRef);
  });

  test.each([[0], [-1], [1.5], [NaN]])("createdBy inválido (%p vía db directo) lanza AccountHolderFundingBatchError", async (bad) => {
    const params = buildOrchestrationParams({
      idempotencyKey: "qa-val-createdby", requestFingerprint: "fp-val",
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
    });
    (params as any).createdBy = bad;
    await expect(runAccountHolderFundingBatch(params)).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[""], ["   "], [123], [null]])("idempotencyKey inválida (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    const params = buildOrchestrationParams({
      idempotencyKey: "qa-val-key", requestFingerprint: "fp-val",
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
    });
    (params as any).idempotencyKey = bad;
    await expect(runAccountHolderFundingBatch(params)).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[""], [123], [null]])("requestFingerprint inválido (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    const params = buildOrchestrationParams({
      idempotencyKey: "qa-val-fp", requestFingerprint: "fp-val",
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
    });
    (params as any).requestFingerprint = bad;
    await expect(runAccountHolderFundingBatch(params)).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[0], [-1], [1.5]])("accountHolderInsuredId inválido (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    const params = buildOrchestrationParams({
      idempotencyKey: "qa-val-insured", requestFingerprint: "fp-val",
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
    });
    (params as any).accountHolderInsuredId = bad;
    await expect(runAccountHolderFundingBatch(params)).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test("paymentDate inválido lanza AccountHolderFundingBatchError", async () => {
    const params = buildOrchestrationParams({
      idempotencyKey: "qa-val-date", requestFingerprint: "fp-val",
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
    });
    (params as any).paymentDate = "15/01/2026";
    await expect(runAccountHolderFundingBatch(params)).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([["createBatch"], ["createChildRows"], ["buildResponseSnapshot"]])("dependencies.%s no-función lanza AccountHolderFundingBatchError", async (fnName) => {
    const params = buildOrchestrationParams({
      idempotencyKey: "qa-val-deps", requestFingerprint: "fp-val",
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
    });
    (params.dependencies as any)[fnName] = "no soy una función";
    await expect(runAccountHolderFundingBatch(params)).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[null], [undefined], [{}], ["x"]])("db inválido (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    const params = buildOrchestrationParams({
      idempotencyKey: "qa-val-db", requestFingerprint: "fp-val",
      destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }], realSplits: [{ id: "s1", amountCents: 100000 }],
    });
    (params as any).db = bad;
    await expect(runAccountHolderFundingBatch(params)).rejects.toThrow(AccountHolderFundingBatchError);
  });

  test.each([[null], [undefined], [[]], ["x"]])("params no-objeto (%p) lanza AccountHolderFundingBatchError", async (bad) => {
    await expect(runAccountHolderFundingBatch(bad as any)).rejects.toThrow(AccountHolderFundingBatchError);
  });
});
