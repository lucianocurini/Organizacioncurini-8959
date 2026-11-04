/**
 * Regla única de cobrabilidad — próxima póliza inmediata (regla 8 de
 * src/lib/payments/installment-collectability.ts), de punta a punta:
 *  - GET  /api/installments/pending-for-payment (selector de "Imputar pago" y "Cobrar en lote")
 *  - POST /api/payments (individual)
 *  - POST /api/payment-batches (lote común y lote con titular)
 *  - PATCH /api/payment-batches/:id (edición de fecha de un lote)
 *  - GET  /api/policies/cash-period-search y POST /api/payment-batches/cash-period-payment (contado)
 *
 * Paridad: cada escenario se arma una vez por flujo; cada cuota tiene que
 * aparecer en el selector si y solo si los tres cobros la aceptan. Corre
 * contra la base de DATABASE_URL (file:), nunca Turso.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments, payments, paymentSplits,
  paymentBatches, paymentBatchSplits, cashEntries, cashPeriodPayments, paymentBatchFundingAllocations,
  accountHolderFundingIdempotencyKeys, paymentAmountAdjustments, insuredAccountMovements,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";
import { InstallmentNotCollectableError, assertInstallmentsCollectable } from "../installment-collectability-loader";

const SESSION_ID = "test-session-next-policy-001";
const USER_EMAIL = "test-next-policy@test.local";
const PREFIX = "TEST-NEXT-POLICY";
// Fecha de pago del caso real: hoy la vigente vence el 15/11 y la próxima ya está cargada.
const T = "2026-10-30";

let userId: number;
let companyId: number;
let insuredId: number;
const policyIdsToClean: number[] = [];
const insuredIdsToClean: number[] = [];

function headers() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}
async function req(method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://localhost${path}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) }));
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json as any };
}

interface PolicyOpts { status?: string; renewedFromId?: number | null; cancellationEffectiveDate?: string | null; insuredId?: number; cashPaymentAmountCents?: number | null }
async function mkPolicy(startDate: string, endDate: string, o: PolicyOpts = {}): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: o.status ?? "activa", companyId, insuredId: o.insuredId ?? insuredId, startDate, endDate, createdBy: userId,
    renewedFromId: o.renewedFromId ?? null, cancellationEffectiveDate: o.cancellationEffectiveDate ?? null,
    cashPaymentAmountCents: o.cashPaymentAmountCents ?? null,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}
async function mkInst(policyId: number, dueDate: string, o: Record<string, any> = {}): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({ policyId, number: 1, dueDate, amount: 1000, status: "pendiente", rendered: 0, ...o })
    .returning({ id: policyInstallments.id });
  return i!.id;
}

/** Cadena semestral: A → V (vigente el 30/10) → N (inicia 15/11) → N2 (segunda renovación futura). */
async function mkChain(o: { insuredId?: number; nCash?: number | null } = {}) {
  const ins = o.insuredId;
  const A = await mkPolicy("2025-11-15", "2026-05-15", { status: "renovada", insuredId: ins });
  const V = await mkPolicy("2026-05-15", "2026-11-15", { status: "renovada", renewedFromId: A, insuredId: ins });
  const N = await mkPolicy("2026-11-15", "2027-05-15", { status: "renovada", renewedFromId: V, insuredId: ins, cashPaymentAmountCents: o.nCash ?? null });
  const N2 = await mkPolicy("2027-05-15", "2027-11-15", { renewedFromId: N, insuredId: ins });
  return { A, V, N, N2 };
}

type Case = { policyId: number; installmentId: number; expected: boolean; ruleRejection: boolean };

/** Escenario completo; `ruleRejection` = se rechaza por la cadena (400 INSTALLMENT_NOT_COLLECTABLE en los tres cobros). */
async function buildScenario(): Promise<Record<string, Case>> {
  const s: Record<string, Case> = {};
  const add = async (name: string, policyId: number, due: string, expected: boolean, ruleRejection = !expected, o: Record<string, any> = {}) => {
    s[name] = { policyId, installmentId: await mkInst(policyId, due, o), expected, ruleRejection };
  };

  const c = await mkChain();
  await add("anterior", c.A, "2026-07-10", true);
  await add("vigente", c.V, "2026-10-15", true);
  await add("proxima_15_11", c.N, "2026-11-15", true);
  await add("segunda_renovacion_futura", c.N2, "2027-05-15", false);

  // Mismas exclusiones de cuota que antes, sobre la próxima.
  await add("proxima_cuota_pagada", c.N, "2026-12-15", false, false, { status: "pagada" });
  await add("proxima_cuota_rendida", c.N, "2027-01-15", false, false, { rendered: 1 });
  await add("proxima_cuota_no_exigible", c.N, "2027-02-15", false, false, { status: "no_exigible" });

  await mkPolicy("2026-05-15", "2026-11-15");
  await add("proxima_sin_enlace", await mkPolicy("2026-11-15", "2027-05-15"), "2026-11-15", false);

  const v2 = await mkPolicy("2026-05-15", "2026-11-15", { status: "renovada" });
  await add("proxima_cancelada", await mkPolicy("2026-11-15", "2027-05-15", { status: "cancelada", cancellationEffectiveDate: "2027-01-15", renewedFromId: v2 }), "2026-11-15", false);

  const v3 = await mkPolicy("2026-05-15", "2026-11-15", { status: "renovada" });
  await add("sucesora_ambigua_1", await mkPolicy("2026-11-15", "2027-05-15", { renewedFromId: v3 }), "2026-11-15", false);
  await add("sucesora_ambigua_2", await mkPolicy("2026-11-15", "2027-05-15", { renewedFromId: v3 }), "2026-11-15", false);

  const l1 = await mkPolicy("2025-10-01", "2026-10-15", { status: "renovada" });
  // Regla 9 (2026-11-03): en un hueco, la última terminada con próxima enlazada también es cobrable.
  await add("hueco_anterior_terminada", l1, "2026-10-01", true);
  await add("hueco_proxima_enlazada", await mkPolicy("2026-11-15", "2027-11-15", { renewedFromId: l1 }), "2026-11-15", true);

  await mkPolicy("2025-10-01", "2026-10-15");
  await add("hueco_proxima_sin_enlace", await mkPolicy("2026-11-15", "2027-11-15"), "2026-11-15", false);
  return s;
}

async function pendingIds(query: string): Promise<number[]> {
  const r = await req("GET", `/api/installments/pending-for-payment?${query}`);
  expect(r.status).toBe(200);
  return (r.body as any[]).map((x) => x.installmentId);
}
function individualBody(policyId: number, installmentId: number, paymentDate = T) {
  return { policyId, installmentId, amount: 1000, splits: [{ method: "efectivo", amount: 1000 }], paymentDate, status: "confirmado" };
}
function batchBody(installmentIds: number[], paymentDate = T) {
  return { paymentDate, items: installmentIds.map((installmentId) => ({ installmentId })), splits: [{ method: "efectivo", amount: installmentIds.length * 1000 }] };
}
let idemSeq = 0;
function titularBatchBody(installmentIds: number[], paymentDate = T) {
  return {
    ...batchBody(installmentIds, paymentDate), accountHolderInsuredId: insuredId,
    idempotencyKey: `next-policy-${Date.now()}-${idemSeq++}`, creditAppliedCents: 0, roundingCoverageCents: 0,
  };
}

beforeAll(async () => {
  const prev = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prev) throw new Error(`Residuo de una corrida anterior (usuario ${USER_EMAIL}) — limpiar la base de test antes de correr.`);
  const [u] = await db.insert(users).values({ name: "Test Next Policy", email: USER_EMAIL, password: "x", role: "admin", active: 1 }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });
  const [co] = await db.insert(companies).values({ name: `${PREFIX} Co ${Date.now()}` }).returning({ id: companies.id });
  companyId = co!.id;
  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
  insuredIdsToClean.push(insuredId);
});

afterAll(async () => {
  const batchIds = (await db.select({ id: paymentBatches.id }).from(paymentBatches).where(eq(paymentBatches.createdBy, userId)).all()).map((b) => b.id);
  const payIds = (await db.select({ id: payments.id }).from(payments).where(eq(payments.createdBy, userId)).all()).map((p) => p.id);
  if (batchIds.length) await db.delete(paymentBatchFundingAllocations).where(inArray(paymentBatchFundingAllocations.paymentBatchId, batchIds));
  await db.delete(accountHolderFundingIdempotencyKeys).where(eq(accountHolderFundingIdempotencyKeys.createdBy, userId));
  await db.delete(cashPeriodPayments).where(eq(cashPeriodPayments.createdBy, userId));
  if (payIds.length) await db.delete(cashEntries).where(inArray(cashEntries.paymentId, payIds));
  await db.delete(paymentAmountAdjustments).where(eq(paymentAmountAdjustments.createdBy, userId));
  await db.delete(insuredAccountMovements).where(eq(insuredAccountMovements.createdBy, userId));
  if (payIds.length) {
    await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds));
    await db.delete(payments).where(inArray(payments.id, payIds));
  }
  if (batchIds.length) {
    await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds));
    await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIds));
  }
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean));
    // Primero las que renuevan a otra (renewedFromId es FK).
    for (const id of [...policyIdsToClean].reverse()) await db.delete(policies).where(eq(policies.id, id));
  }
  if (insuredIdsToClean.length) await db.delete(insureds).where(inArray(insureds.id, insuredIdsToClean));
  await db.delete(companies).where(eq(companies.id, companyId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  const left = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, userId)).all();
  if (left.length) throw new Error(`next-policy-collectability.test.ts dejó ${left.length} pólizas sin limpiar.`);
});

describe("paridad selector / individual / lote común / lote con titular", () => {
  test("cada caso: aparece en el selector ⇔ lo acepta POST /payments ⇔ POST /payment-batches (común y titular)", async () => {
    const indiv = await buildScenario();
    const legacy = await buildScenario();
    const titular = await buildScenario();
    const mismatches: string[] = [];
    for (const name of Object.keys(indiv)) {
      const ci = indiv[name]!, cl = legacy[name]!, ct = titular[name]!;
      const listed = [ci, cl, ct].map(async (c) => (await pendingIds(`policyId=${c.policyId}&paymentDate=${T}`)).includes(c.installmentId));
      const [listedI, listedL, listedT] = await Promise.all(listed);
      const ri = await req("POST", "/api/payments", individualBody(ci.policyId, ci.installmentId));
      const rl = await req("POST", "/api/payment-batches", batchBody([cl.installmentId]));
      const rt = await req("POST", "/api/payment-batches", titularBatchBody([ct.installmentId]));
      const accepted = [ri.status === 201, rl.status === 201, rt.status === 201];
      if ([listedI, listedL, listedT, ...accepted].some((v) => v !== ci.expected)) {
        mismatches.push(`${name}: esperado=${ci.expected} selector=${listedI}/${listedL}/${listedT} individual=${ri.status} lote=${rl.status} titular=${rt.status} ${JSON.stringify(ri.body?.failures ?? ri.body?.error ?? "")} ${JSON.stringify(rt.body?.error ?? "")}`);
      }
      if (ci.ruleRejection) {
        for (const [flow, r] of [["individual", ri], ["lote", rl], ["titular", rt]] as const) {
          if (r.status !== 400 || r.body?.code !== "INSTALLMENT_NOT_COLLECTABLE") mismatches.push(`${name}: ${flow} no devolvió 400 INSTALLMENT_NOT_COLLECTABLE (${r.status})`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("motivos explícitos de rechazo de la regla 8", async () => {
    const s = await buildScenario();
    const reasonOf = async (name: string) => {
      const r = await req("POST", "/api/payments", individualBody(s[name]!.policyId, s[name]!.installmentId));
      return r.body?.failures?.[0]?.reason;
    };
    expect(await reasonOf("segunda_renovacion_futura")).toBe("SUCESORA_NO_INMEDIATA");
    expect(await reasonOf("proxima_sin_enlace")).toBe("POLIZA_FUTURA");
    expect(await reasonOf("proxima_cancelada")).toBe("PROXIMA_CANCELADA");
    expect(await reasonOf("sucesora_ambigua_1")).toBe("CADENA_AMBIGUA");
    expect(await reasonOf("hueco_proxima_sin_enlace")).toBe("POLIZA_FUTURA");
  });
});

describe("mismo conjunto y sin cuotas repetidas", () => {
  test("por asegurado: la lista trae exactamente anterior + vigente + próxima, una vez cada cuota, y es el conjunto que valida la regla", async () => {
    const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Cadena`, createdBy: userId }).returning({ id: insureds.id });
    insuredIdsToClean.push(ins!.id);
    const c = await mkChain({ insuredId: ins!.id });
    const iA = await mkInst(c.A, "2026-07-10");
    const iV = await mkInst(c.V, "2026-10-15");
    const iN1 = await mkInst(c.N, "2026-11-15", { number: 1 });
    const iN2 = await mkInst(c.N, "2026-12-15", { number: 2 });
    const iSecond = await mkInst(c.N2, "2027-05-15");

    const listed = await pendingIds(`insuredId=${ins!.id}&paymentDate=${T}`);
    expect(listed.length).toBe(new Set(listed).size);
    expect([...listed].sort((a, b) => a - b)).toEqual([iA, iV, iN1, iN2].sort((a, b) => a - b));

    // La misma función central acepta exactamente ese conjunto y rechaza la segunda futura.
    await assertInstallmentsCollectable(db, listed, T);
    let thrown: unknown = null;
    try { await assertInstallmentsCollectable(db, [...listed, iSecond], T); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(InstallmentNotCollectableError);
    expect((thrown as InstallmentNotCollectableError).failures).toEqual([{ installmentId: iSecond, reason: "SUCESORA_NO_INMEDIATA", message: expect.any(String) }]);

    // Un lote con las cuatro cuotas listadas se acepta de una vez (sin duplicar hijos).
    const r = await req("POST", "/api/payment-batches", batchBody(listed));
    expect(r.status).toBe(201);
    const children = await db.select({ installmentId: payments.installmentId }).from(payments).where(eq(payments.batchId, r.body.id)).all();
    expect(children.map((x) => x.installmentId).sort((a, b) => a! - b!)).toEqual([...listed].sort((a, b) => a - b));
    expect(await pendingIds(`insuredId=${ins!.id}&paymentDate=${T}`)).toEqual([]);
  });

  test("fecha de pago igual al inicio de la próxima: pasa a ser la vigente, la anterior es antecesora directa y la segunda futura es la próxima", async () => {
    const c = await mkChain();
    const iA = await mkInst(c.A, "2026-07-10");
    const iV = await mkInst(c.V, "2026-10-15");
    const iN = await mkInst(c.N, "2026-11-15");
    const iN2 = await mkInst(c.N2, "2027-05-15");
    const r = await req("GET", `/api/installments/pending-for-payment?insuredId=${insuredId}&paymentDate=2026-11-15`);
    const via = new Map((r.body as any[]).map((x) => [x.installmentId, x.collectabilityVia]));
    expect(via.get(iA)).toBeUndefined();
    expect(via.get(iV)).toBe("antecesora_directa");
    expect(via.get(iN)).toBe("poliza_vigente");
    expect(via.get(iN2)).toBe("proxima_inmediata");
  });
});

describe("edición de lote (PATCH /payment-batches/:id)", () => {
  test("lote con una cuota de la próxima: otra fecha válida → 200; fecha en que deja de ser inmediata → 400 y el lote queda igual", async () => {
    const c = await mkChain();
    const iN = await mkInst(c.N, "2026-11-15");
    const created = await req("POST", "/api/payment-batches", batchBody([iN]));
    expect(created.status).toBe(201);

    const ok = await req("PATCH", `/api/payment-batches/${created.body.id}`, { paymentDate: "2026-10-20" });
    expect(ok.status).toBe(200);
    expect(ok.body.paymentDate).toBe("2026-10-20");

    // El 2026-05-01 la vigente es A: N es la segunda renovación futura.
    const bad = await req("PATCH", `/api/payment-batches/${created.body.id}`, { paymentDate: "2026-05-01" });
    expect(bad.status).toBe(400);
    expect(bad.body.failures).toEqual([{ installmentId: iN, reason: "SUCESORA_NO_INMEDIATA" }]);
    const row = await db.select({ paymentDate: paymentBatches.paymentDate }).from(paymentBatches).where(eq(paymentBatches.id, created.body.id)).get();
    expect(row!.paymentDate).toBe("2026-10-20");
  });
});

describe("contado por período", () => {
  test("período de la próxima inmediata: elegible en la búsqueda y cobrable", async () => {
    const c = await mkChain({ nCash: 195000 });
    const ids = [await mkInst(c.N, "2026-11-15", { number: 1 }), await mkInst(c.N, "2026-12-15", { number: 2 })];
    const search = await req("GET", `/api/policies/cash-period-search?policyId=${c.N}&paymentDate=${T}`);
    expect(search.status).toBe(200);
    expect(search.body).toHaveLength(1);
    expect(search.body[0].eligible).toBe(true);
    expect(search.body[0].ineligibleReasons).toEqual([]);

    const r = await req("POST", "/api/payment-batches/cash-period-payment", {
      policyId: c.N, rebillingId: null, paymentDate: T, splits: [{ method: "efectivo", amount: 1950 }],
    });
    expect(r.status).toBe(201);
    const rows = await db.select({ status: policyInstallments.status }).from(policyInstallments).where(inArray(policyInstallments.id, ids)).all();
    expect(rows.every((x) => x.status === "pagada")).toBe(true);
  });

  test("período de la segunda renovación futura: no elegible y rechazado", async () => {
    const c = await mkChain();
    await db.update(policies).set({ cashPaymentAmountCents: 195000 }).where(eq(policies.id, c.N2));
    const ids = [await mkInst(c.N2, "2027-05-15", { number: 1 }), await mkInst(c.N2, "2027-06-15", { number: 2 })];
    const search = await req("GET", `/api/policies/cash-period-search?policyId=${c.N2}&paymentDate=${T}`);
    expect(search.body[0].eligible).toBe(false);

    const r = await req("POST", "/api/payment-batches/cash-period-payment", {
      policyId: c.N2, rebillingId: null, paymentDate: T, splits: [{ method: "efectivo", amount: 1950 }],
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INSTALLMENT_NOT_COLLECTABLE");
    const paid = await db.select({ id: payments.id }).from(payments).where(inArray(payments.installmentId, ids)).all();
    expect(paid).toEqual([]);
  });
});
