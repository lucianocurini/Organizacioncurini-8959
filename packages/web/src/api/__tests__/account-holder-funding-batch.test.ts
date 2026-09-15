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
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { insuredAccountMovements } from "../database/schema";
import {
  loadActiveAccountHolderBalanceCents,
  planFundingWithFreshBalance,
  assertFundingPlanUnchanged,
  persistAccountHolderFundingArtifacts,
  AccountHolderFundingBatchError,
  FundingPlanRaceConditionError,
  type PlanFundingWithFreshBalanceParams,
  type PersistAccountHolderFundingArtifactsParams,
} from "../account-holder-funding-batch";
import {
  planAccountHolderBatchFunding,
  AccountHolderFundingPlanError,
  type AccountHolderFundingPlanResult,
  type FundingPlanSplitInput,
} from "../../lib/payments/account-holder-funding-plan";
import type { FundingDestinationInput } from "../../lib/payments/account-holder-funding";
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
// respetar foreign_keys=ON (default real de @libsql/client).
beforeEach(async () => {
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
