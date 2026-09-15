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
  AccountHolderFundingBatchError,
  FundingPlanRaceConditionError,
  type PlanFundingWithFreshBalanceParams,
} from "../account-holder-funding-batch";
import {
  planAccountHolderBatchFunding,
  AccountHolderFundingPlanError,
  type AccountHolderFundingPlanResult,
} from "../../lib/payments/account-holder-funding-plan";

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

async function createSchema(c: Client): Promise<void> {
  await c.execute(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  await c.execute(`CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
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
      notes                   TEXT,
      effective_date          TEXT
    )
  `);
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

// Aísla cada test sin recrear nada: la única tabla que varía entre tests es
// insured_account_movements — insureds/users quedan fijos toda la corrida.
beforeEach(async () => {
  await db.delete(insuredAccountMovements);
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
