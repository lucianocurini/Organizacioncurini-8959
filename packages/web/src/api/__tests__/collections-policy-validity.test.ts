/**
 * Regla única de cobrabilidad en Cobranzas — endpoints.
 *  - GET  /api/installments/pending-for-payment (selector de lote y de "Imputar pago")
 *  - POST /api/payments (individual), PUT /api/payments/:id (mover a otra cuota)
 *  - POST /api/payment-batches (lote legacy y titular)
 *  - GET  /api/installments/collectability-diagnostics (solo conteos)
 *
 * Paridad: el mismo escenario se arma dos veces (una para cobro individual y
 * otra para lote); cada cuota debe aparecer en el selector si y solo si
 * ambos endpoints la aceptan. Corre contra la base de DATABASE_URL (file:),
 * nunca Turso.
 */
import { test, expect, beforeAll, afterAll, describe, spyOn } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments,
  payments, paymentSplits, paymentBatches, paymentBatchSplits, cashEntries,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";
import * as collectabilityLoader from "../installment-collectability-loader";
import { InstallmentNotCollectableError, assertInstallmentsCollectable } from "../installment-collectability-loader";
import { buildTitularFundingDependencies } from "../payment-batch-titular-dependencies";

const SESSION_ID = "test-session-collections-validity-001";
const USER_EMAIL = "test-collections-validity@test.local";
const PREFIX = "TEST-COLL-VALIDITY";
const D = "2026-09-25";

let userId: number;
let companyId: number;
let insuredId: number;
const policyIdsToClean: number[] = [];
const batchIdsToClean: number[] = [];

function headers() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}
async function req(method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://localhost${path}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) }));
  const json = await res.json().catch(() => null);
  if (path === "/api/payment-batches" && method === "POST" && json?.id) batchIdsToClean.push(json.id);
  return { status: res.status, body: json as any };
}

interface PolicyOpts { status?: string; renewedFromId?: number | null; parentPolicyId?: number | null; cancellationEffectiveDate?: string | null }
async function mkPolicy(startDate: string, endDate: string, o: PolicyOpts = {}): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: o.status ?? "activa", companyId, insuredId, startDate, endDate, createdBy: userId,
    renewedFromId: o.renewedFromId ?? null, parentPolicyId: o.parentPolicyId ?? null,
    cancellationEffectiveDate: o.cancellationEffectiveDate ?? null,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}
async function mkInst(policyId: number, dueDate: string, o: Record<string, any> = {}): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({ policyId, number: 1, dueDate, amount: 1000, status: "pendiente", rendered: 0, ...o })
    .returning({ id: policyInstallments.id });
  return i!.id;
}
async function mkConfirmedStandalonePayment(policyId: number, installmentId: number) {
  const [p] = await db.insert(payments).values({ policyId, installmentId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2026-09-01", status: "confirmado", createdBy: userId })
    .returning({ id: payments.id });
  await db.insert(paymentSplits).values({ paymentId: p!.id, method: "efectivo", amountCents: 100000 });
}

/** Escenario completo; devuelve cada caso con su cuota y el resultado esperado. */
async function buildScenario(): Promise<Record<string, { policyId: number; installmentId: number; expected: boolean }>> {
  const s: Record<string, { policyId: number; installmentId: number; expected: boolean }> = {};
  const add = async (name: string, policyId: number, due: string, expected: boolean, o: Record<string, any> = {}) => {
    s[name] = { policyId, installmentId: await mkInst(policyId, due, o), expected };
  };
  const vig = await mkPolicy("2026-01-01", "2026-12-31");
  await add("poliza_vigente", vig, "2026-10-01", true);
  await add("corte_2026_07_01_inclusive", vig, "2026-07-01", true);
  await add("anterior_a_2026_07_01", vig, "2026-06-30", false);
  await add("pago_confirmado_estado_desactualizado", vig, "2026-11-01", false);
  await mkConfirmedStandalonePayment(vig, s.pago_confirmado_estado_desactualizado!.installmentId);

  await add("cuota_futura_de_vigente", await mkPolicy("2026-06-01", "2027-06-01"), "2027-05-01", true);
  await add("por_vencer_vigente", await mkPolicy("2025-10-10", "2026-10-10", { status: "por_vencer" }), "2026-10-05", true);

  const a1 = await mkPolicy("2025-08-01", "2026-08-01", { status: "renovada" });
  await mkPolicy("2026-08-01", "2027-08-01", { renewedFromId: a1 });
  await add("antecesora_directa", a1, "2026-07-15", true);

  const b0 = await mkPolicy("2024-06-01", "2025-06-01", { status: "renovada" });
  const b1 = await mkPolicy("2025-06-01", "2026-06-01", { status: "renovada", renewedFromId: b0 });
  await mkPolicy("2026-06-01", "2027-06-01", { renewedFromId: b1 });
  await add("antecesora_mas_antigua", b0, "2026-07-10", false);

  await add("cadena_sin_poliza_vigente", await mkPolicy("2025-08-01", "2026-08-31"), "2026-08-15", false);
  await add("poliza_futura", await mkPolicy("2026-10-01", "2027-10-01"), "2026-10-15", false);
  await add("cancelada_sin_fecha", await mkPolicy("2026-01-01", "2026-12-31", { status: "cancelada" }), "2026-09-01", false);
  await add("cancelada_dia_efectivo", await mkPolicy("2026-01-01", "2026-12-31", { status: "cancelada", cancellationEffectiveDate: D }), "2026-09-20", true);
  await add("cancelada_dia_anterior", await mkPolicy("2026-01-01", "2026-12-31", { status: "cancelada", cancellationEffectiveDate: "2026-09-24" }), "2026-09-20", false);

  const j1 = await mkPolicy("2025-09-25", D, { status: "renovada" });
  const j2 = await mkPolicy(D, "2027-09-25", { renewedFromId: j1 });
  await add("superposicion_antecesora", j1, "2026-09-01", true);
  await add("superposicion_sucesora", j2, "2026-10-25", true);

  await add("enlace_roto", await mkPolicy("2026-01-01", "2026-12-31", { renewedFromId: 987654321 }), "2026-10-01", true);
  await add("renovada_sin_sucesor", await mkPolicy("2026-01-01", "2026-12-31", { status: "renovada" }), "2026-10-01", false);

  const principalVencida = await mkPolicy("2025-01-01", "2025-12-31", { status: "vencida" });
  await add("accesoria_vigente", await mkPolicy("2026-01-01", "2026-12-31", { parentPolicyId: principalVencida }), "2026-10-01", true);
  return s;
}

async function pendingIds(policyId: number, paymentDate = D): Promise<Set<number>> {
  const r = await req("GET", `/api/installments/pending-for-payment?policyId=${policyId}&paymentDate=${paymentDate}`);
  expect(r.status).toBe(200);
  return new Set((r.body as any[]).map((x) => x.installmentId));
}
function individualBody(policyId: number, installmentId: number, paymentDate = D) {
  return { policyId, installmentId, amount: 1000, splits: [{ method: "efectivo", amount: 1000 }], paymentDate, status: "confirmado" };
}
function batchBody(installmentIds: number[], paymentDate = D) {
  return { paymentDate, items: installmentIds.map((installmentId) => ({ installmentId })), splits: [{ method: "efectivo", amount: installmentIds.length * 1000 }] };
}

beforeAll(async () => {
  const prev = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prev) throw new Error(`Residuo de una corrida anterior (usuario ${USER_EMAIL}) — limpiar la base de test antes de correr.`);
  const [u] = await db.insert(users).values({ name: "Test Coll Validity", email: USER_EMAIL, password: "x", role: "admin", active: 1 }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });
  const [co] = await db.insert(companies).values({ name: `${PREFIX} Co ${Date.now()}` }).returning({ id: companies.id });
  companyId = co!.id;
  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(async () => {
  const pays = policyIdsToClean.length ? await db.select({ id: payments.id }).from(payments).where(inArray(payments.policyId, policyIdsToClean)).all() : [];
  const payIds = pays.map((p) => p.id);
  if (payIds.length) {
    await db.delete(cashEntries).where(inArray(cashEntries.paymentId, payIds));
    await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds));
    await db.delete(payments).where(inArray(payments.id, payIds));
  }
  if (batchIdsToClean.length) {
    await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsToClean));
    await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIdsToClean));
  }
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean));
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean));
  }
  await db.delete(insureds).where(eq(insureds.createdBy, userId));
  await db.delete(companies).where(eq(companies.id, companyId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  const left = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, userId)).all();
  if (left.length) throw new Error(`collections-policy-validity.test.ts dejó ${left.length} pólizas sin limpiar.`);
});

describe("paridad selector / cobro individual / cobro por lote", () => {
  test("cada caso: aparece en el selector ⇔ lo acepta POST /payments ⇔ lo acepta POST /payment-batches", async () => {
    const indiv = await buildScenario();
    const batch = await buildScenario();
    const mismatches: string[] = [];
    for (const name of Object.keys(indiv)) {
      const ci = indiv[name]!, cb = batch[name]!;
      const listedI = (await pendingIds(ci.policyId)).has(ci.installmentId);
      const listedB = (await pendingIds(cb.policyId)).has(cb.installmentId);
      const ri = await req("POST", "/api/payments", individualBody(ci.policyId, ci.installmentId));
      const rb = await req("POST", "/api/payment-batches", batchBody([cb.installmentId]));
      const acceptedI = ri.status === 201, acceptedB = rb.status === 201;
      if (listedI !== ci.expected || listedB !== cb.expected || acceptedI !== ci.expected || acceptedB !== cb.expected) {
        mismatches.push(`${name}: esperado=${ci.expected} selector=${listedI}/${listedB} individual=${ri.status} lote=${rb.status} ${JSON.stringify(ri.body?.failures ?? ri.body?.error ?? "")}`);
      }
      if (!ci.expected && name !== "pago_confirmado_estado_desactualizado") {
        // Rechazo explícito de la regla: 400 + código único en ambos flujos.
        if (ri.status !== 400 || ri.body?.code !== "INSTALLMENT_NOT_COLLECTABLE") mismatches.push(`${name}: individual no devolvió 400 INSTALLMENT_NOT_COLLECTABLE (${ri.status})`);
        if (rb.status !== 400 || rb.body?.code !== "INSTALLMENT_NOT_COLLECTABLE") mismatches.push(`${name}: lote no devolvió 400 INSTALLMENT_NOT_COLLECTABLE (${rb.status})`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("pago confirmado con estado desactualizado: individual 400 (regla), lote 409 (chequeo previo existente de pago confirmado)", async () => {
    const pol = await mkPolicy("2026-01-01", "2026-12-31");
    const inst = await mkInst(pol, "2026-10-01");
    await mkConfirmedStandalonePayment(pol, inst);
    const ri = await req("POST", "/api/payments", individualBody(pol, inst));
    expect(ri.status).toBe(400);
    expect(ri.body.failures).toEqual([{ installmentId: inst, reason: "PAGO_CONFIRMADO" }]);
    const rb = await req("POST", "/api/payment-batches", batchBody([inst]));
    expect(rb.status).toBe(409);
  });
});

describe("rechazo backend ante request manual o dato que cambió", () => {
  test("request manual con una cuota de antecesora más antigua → 400 explícito, sin escrituras", async () => {
    const b0 = await mkPolicy("2024-06-01", "2025-06-01", { status: "renovada" });
    const b1 = await mkPolicy("2025-06-01", "2026-06-01", { status: "renovada", renewedFromId: b0 });
    await mkPolicy("2026-06-01", "2027-06-01", { renewedFromId: b1 });
    const inst = await mkInst(b0, "2026-07-10");
    const r = await req("POST", "/api/payments", individualBody(b0, inst));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INSTALLMENT_NOT_COLLECTABLE");
    expect(r.body.error).toContain("ya no está disponible para cobrar");
    expect(r.body.failures).toEqual([{ installmentId: inst, reason: "ANTECESORA_MAS_ANTIGUA" }]);
    const paid = await db.select({ id: payments.id }).from(payments).where(eq(payments.installmentId, inst)).all();
    expect(paid).toEqual([]);
    const row = await db.select({ status: policyInstallments.status }).from(policyInstallments).where(eq(policyInstallments.id, inst)).get();
    expect(row!.status).toBe("pendiente");
  });

  test("la cuota aparece en el selector, luego la póliza se cancela sin fecha efectiva → individual y lote 400", async () => {
    const pol = await mkPolicy("2026-01-01", "2026-12-31");
    const inst1 = await mkInst(pol, "2026-10-01");
    const inst2 = await mkInst(pol, "2026-11-01");
    expect((await pendingIds(pol)).has(inst1)).toBe(true);
    await db.update(policies).set({ status: "cancelada" }).where(eq(policies.id, pol));
    const ri = await req("POST", "/api/payments", individualBody(pol, inst1));
    expect(ri.status).toBe(400);
    expect(ri.body.failures[0].reason).toBe("CANCELADA_SIN_FECHA_EFECTIVA");
    const rb = await req("POST", "/api/payment-batches", batchBody([inst2]));
    expect(rb.status).toBe(400);
    expect(rb.body.code).toBe("INSTALLMENT_NOT_COLLECTABLE");
  });

  test("se carga una renovación después de armar el carrito → la vieja pasa a antecesora directa (sigue cobrable) y la más vieja queda afuera", async () => {
    const p0 = await mkPolicy("2025-01-01", "2026-12-31");
    const instOld = await mkInst(p0, "2026-10-01");
    expect((await pendingIds(p0)).has(instOld)).toBe(true);
    const p1 = await mkPolicy("2026-09-01", "2027-09-01", { renewedFromId: p0 });
    await db.update(policies).set({ status: "renovada" }).where(eq(policies.id, p0));
    await mkPolicy("2026-09-20", "2027-09-20", { renewedFromId: p1 });
    await db.update(policies).set({ status: "renovada" }).where(eq(policies.id, p1));
    const r = await req("POST", "/api/payment-batches", batchBody([instOld]));
    expect(r.status).toBe(400);
    expect(r.body.failures).toEqual([{ installmentId: instOld, reason: "ANTECESORA_MAS_ANTIGUA" }]);
  });

  test("lote con una cuota válida y una inválida → 400 y nada escrito (todo o nada)", async () => {
    const ok = await mkPolicy("2026-01-01", "2026-12-31");
    const future = await mkPolicy("2026-10-01", "2027-10-01");
    const i1 = await mkInst(ok, "2026-10-01");
    const i2 = await mkInst(future, "2026-10-15");
    const r = await req("POST", "/api/payment-batches", batchBody([i1, i2]));
    expect(r.status).toBe(400);
    expect(r.body.blockingInstallmentIds).toEqual([i2]);
    const paid = await db.select({ id: payments.id }).from(payments).where(inArray(payments.installmentId, [i1, i2])).all();
    expect(paid).toEqual([]);
  });

  test("cambiar la fecha de pago después de cargar: válida hoy, inválida con una fecha posterior al fin de vigencia", async () => {
    const pol = await mkPolicy("2026-01-01", "2026-09-30");
    const inst = await mkInst(pol, "2026-09-15");
    expect((await pendingIds(pol, D)).has(inst)).toBe(true);
    expect((await pendingIds(pol, "2026-10-01")).has(inst)).toBe(false);
    const r = await req("POST", "/api/payment-batches", batchBody([inst], "2026-10-01"));
    expect(r.status).toBe(400);
    expect(r.body.failures[0].reason).toBe("SIN_POLIZA_VIGENTE_EN_CADENA");
    const ok = await req("POST", "/api/payment-batches", batchBody([inst], "2026-09-30"));
    expect(ok.status).toBe(201);
  });

  test("PUT /payments/:id que mueve el pago a una cuota no cobrable → 400, el pago queda igual", async () => {
    const pol = await mkPolicy("2026-01-01", "2026-12-31");
    const good = await mkInst(pol, "2026-10-01");
    const bad = await mkInst(pol, "2026-06-15");
    const created = await req("POST", "/api/payments", individualBody(pol, good));
    expect(created.status).toBe(201);
    const r = await req("PUT", `/api/payments/${created.body.id}`, { installmentId: bad });
    expect(r.status).toBe(400);
    expect(r.body.failures).toEqual([{ installmentId: bad, reason: "ANTERIOR_FECHA_MINIMA" }]);
    const row = await db.select({ installmentId: payments.installmentId }).from(payments).where(eq(payments.id, created.body.id)).get();
    expect(row!.installmentId).toBe(good);
  });

  test("pago 'pendiente' sobre una cuota no cobrable no la cobra; confirmarlo después vía PUT → 400", async () => {
    const pol = await mkPolicy("2026-10-01", "2027-10-01");
    const inst = await mkInst(pol, "2026-10-15");
    const created = await req("POST", "/api/payments", { ...individualBody(pol, inst), status: "pendiente" });
    expect(created.status).toBe(201);
    const r = await req("PUT", `/api/payments/${created.body.id}`, { status: "confirmado" });
    expect(r.status).toBe(400);
    expect(r.body.failures).toEqual([{ installmentId: inst, reason: "POLIZA_FUTURA" }]);
    const row = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, created.body.id)).get();
    expect(row!.status).toBe("pendiente");
  });

  test("modo titular: request manual con cuota de póliza futura → 400 antes de escribir", async () => {
    const pol = await mkPolicy("2026-10-01", "2027-10-01");
    const inst = await mkInst(pol, "2026-10-15");
    const r = await req("POST", "/api/payment-batches", {
      ...batchBody([inst]), accountHolderInsuredId: insuredId, idempotencyKey: `coll-validity-${Date.now()}`,
      creditAppliedCents: 0, roundingCoverageCents: 0,
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INSTALLMENT_NOT_COLLECTABLE");
  });
});

describe("revalidación dentro de la transacción", () => {
  test("assertInstallmentsCollectable con tx ve un cambio hecho dentro de la misma transacción y el rollback lo deshace", async () => {
    const pol = await mkPolicy("2026-01-01", "2026-12-31");
    const inst = await mkInst(pol, "2026-10-01");
    await assertInstallmentsCollectable(db, [inst], D);
    let thrown: unknown = null;
    try {
      await db.transaction(async (tx) => {
        await tx.update(policies).set({ status: "cancelada" }).where(eq(policies.id, pol));
        await assertInstallmentsCollectable(tx, [inst], D);
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(InstallmentNotCollectableError);
    const row = await db.select({ status: policies.status }).from(policies).where(eq(policies.id, pol)).get();
    expect(row!.status).toBe("activa");
  });

  test("lote titular: createChildRows revalida con tx (dato cambiado dentro de la transacción → InstallmentNotCollectableError)", async () => {
    const pol = await mkPolicy("2026-01-01", "2026-12-31");
    const inst = await mkInst(pol, "2026-10-01");
    const deps = buildTitularFundingDependencies({
      derivedInsuredId: insuredId, baseAmountCents: 100000, surchargeAmountCents: 0, totalReceivedCents: 100000, receivedCents: 100000,
      paymentDate: D, notes: null, createdBy: userId, accountHolderInsuredId: insuredId, installmentIds: [inst],
      splitsWithChecks: [], childInsertItems: [],
    } as any);
    let thrown: unknown = null;
    try {
      await db.transaction(async (tx) => {
        await tx.update(policyInstallments).set({ dueDate: "2026-06-01" }).where(eq(policyInstallments.id, inst));
        await deps.createChildRows(tx, { id: -1 } as any);
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(InstallmentNotCollectableError);
    expect((thrown as InstallmentNotCollectableError).failures[0]!.reason).toBe("ANTERIOR_FECHA_MINIMA");
  });

  test("POST /payments y POST /payment-batches llaman a la regla dos veces: con db antes y con tx adentro", async () => {
    const spy = spyOn(collectabilityLoader, "assertInstallmentsCollectable");
    try {
      const pol = await mkPolicy("2026-01-01", "2026-12-31");
      const i1 = await mkInst(pol, "2026-10-01");
      const i2 = await mkInst(pol, "2026-11-01");
      spy.mockClear();
      expect((await req("POST", "/api/payments", individualBody(pol, i1))).status).toBe(201);
      expect(spy.mock.calls.length).toBe(2);
      expect(spy.mock.calls[0]![0]).toBe(db);
      expect(spy.mock.calls[1]![0]).not.toBe(db);
      spy.mockClear();
      expect((await req("POST", "/api/payment-batches", batchBody([i2]))).status).toBe(201);
      expect(spy.mock.calls.length).toBe(2);
      expect(spy.mock.calls[0]![0]).toBe(db);
      expect(spy.mock.calls[1]![0]).not.toBe(db);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("cambio de fecha de un cobro ya confirmado", () => {
  async function batchRow(id: number) {
    return db.select({ paymentDate: paymentBatches.paymentDate, notes: paymentBatches.notes }).from(paymentBatches).where(eq(paymentBatches.id, id)).get();
  }

  test("PUT /payments/:id: pago confirmado, misma cuota, cambia la fecha → revalida con la fecha nueva", async () => {
    const pol = await mkPolicy("2026-01-01", "2026-09-30");
    const inst = await mkInst(pol, "2026-09-15");
    const created = await req("POST", "/api/payments", individualBody(pol, inst));
    expect(created.status).toBe(201);

    // Fecha fuera de la vigencia de la póliza → 400, el pago queda igual.
    const bad = await req("PUT", `/api/payments/${created.body.id}`, { paymentDate: "2026-10-01" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INSTALLMENT_NOT_COLLECTABLE");
    expect(bad.body.failures).toEqual([{ installmentId: inst, reason: "SIN_POLIZA_VIGENTE_EN_CADENA" }]);
    const row = await db.select({ paymentDate: payments.paymentDate, installmentId: payments.installmentId }).from(payments).where(eq(payments.id, created.body.id)).get();
    expect(row).toEqual({ paymentDate: D, installmentId: inst });

    // Fecha válida: la cuota está "pagada" por este mismo pago y aun así pasa.
    const ok = await req("PUT", `/api/payments/${created.body.id}`, { paymentDate: "2026-09-20" });
    expect(ok.status).toBe(200);
    expect(ok.body.paymentDate).toBe("2026-09-20");
  });

  test("PUT /payments/:id: solo notas (o la misma fecha) no revalida aunque la cuota ya no sea cobrable", async () => {
    const pol = await mkPolicy("2026-01-01", "2026-12-31");
    const inst = await mkInst(pol, "2026-10-01");
    const created = await req("POST", "/api/payments", individualBody(pol, inst));
    expect(created.status).toBe(201);
    await db.update(policies).set({ status: "cancelada" }).where(eq(policies.id, pol));
    const spy = spyOn(collectabilityLoader, "assertInstallmentsCollectable");
    try {
      spy.mockClear();
      const r = await req("PUT", `/api/payments/${created.body.id}`, { notes: "corrección de notas" });
      expect(r.status).toBe(200);
      expect(r.body.notes).toBe("corrección de notas");
      const same = await req("PUT", `/api/payments/${created.body.id}`, { paymentDate: D, notes: "otra" });
      expect(same.status).toBe(200);
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("PATCH /payment-batches/:id: cambia la fecha → revalida todas las cuotas del lote con la fecha resultante", async () => {
    const polA = await mkPolicy("2026-01-01", "2026-12-31");
    const polB = await mkPolicy("2026-01-01", "2026-12-31");
    const iA = await mkInst(polA, "2026-10-01");
    const iB = await mkInst(polB, "2026-10-01");
    const created = await req("POST", "/api/payment-batches", batchBody([iA, iB]));
    expect(created.status).toBe(201);
    const spy = spyOn(collectabilityLoader, "assertInstallmentsCollectable");
    try {
      spy.mockClear();
      const r = await req("PATCH", `/api/payment-batches/${created.body.id}`, { paymentDate: "2026-09-20" });
      expect(r.status).toBe(200);
      expect(r.body.paymentDate).toBe("2026-09-20");
      // Antes y dentro de la transacción, con las dos cuotas y la fecha nueva.
      expect(spy.mock.calls.length).toBe(2);
      expect(spy.mock.calls[0]![0]).toBe(db);
      expect(spy.mock.calls[1]![0]).not.toBe(db);
      expect([...spy.mock.calls[1]![1]].sort((a, b) => a - b)).toEqual([iA, iB].sort((a, b) => a - b));
      expect(spy.mock.calls[1]![2]).toBe("2026-09-20");
    } finally {
      spy.mockRestore();
    }
  });

  test("PATCH /payment-batches/:id: una cuota deja de ser cobrable con la fecha nueva → 400 y el lote queda intacto (ni fecha ni notas)", async () => {
    const polA = await mkPolicy("2026-01-01", "2026-12-31");
    const polB = await mkPolicy("2026-01-01", "2026-12-31");
    const iA = await mkInst(polA, "2026-09-10");
    const iB = await mkInst(polB, "2026-09-10");
    const created = await req("POST", "/api/payment-batches", { ...batchBody([iA, iB]), notes: "original" });
    expect(created.status).toBe(201);
    await db.update(policies).set({ endDate: "2026-09-30" }).where(eq(policies.id, polB));

    const r = await req("PATCH", `/api/payment-batches/${created.body.id}`, { paymentDate: "2026-10-01", notes: "cambiada" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INSTALLMENT_NOT_COLLECTABLE");
    expect(r.body.blockingInstallmentIds).toEqual([iB]);
    expect(await batchRow(created.body.id)).toEqual({ paymentDate: D, notes: "original" });
  });

  test("PATCH /payment-batches/:id: rollback completo si la revalidación DENTRO de la transacción falla", async () => {
    const polA = await mkPolicy("2026-01-01", "2026-12-31");
    const polB = await mkPolicy("2026-01-01", "2026-09-30");
    const iA = await mkInst(polA, "2026-09-10");
    const iB = await mkInst(polB, "2026-09-10");
    const created = await req("POST", "/api/payment-batches", { ...batchBody([iA, iB]), notes: "original" });
    expect(created.status).toBe(201);
    // Simula que el dato cambió entre la validación previa y la transacción:
    // la primera llamada (con db) pasa; la segunda (con tx, después del
    // UPDATE del lote) corre la regla real y falla.
    const spy = spyOn(collectabilityLoader, "assertInstallmentsCollectable");
    spy.mockImplementationOnce(async () => {});
    try {
      const r = await req("PATCH", `/api/payment-batches/${created.body.id}`, { paymentDate: "2026-10-01", notes: "cambiada" });
      expect(r.status).toBe(400);
      expect(r.body.blockingInstallmentIds).toEqual([iB]);
      expect(spy.mock.calls.length).toBe(2);
      expect(spy.mock.calls[1]![0]).not.toBe(db);
    } finally {
      spy.mockRestore();
    }
    expect(await batchRow(created.body.id)).toEqual({ paymentDate: D, notes: "original" });
  });

  test("PATCH /payment-batches/:id: solo notas (o la misma fecha) no revalida aunque una cuota ya no sea cobrable", async () => {
    const pol = await mkPolicy("2026-01-01", "2026-12-31");
    const inst = await mkInst(pol, "2026-10-01");
    const created = await req("POST", "/api/payment-batches", batchBody([inst]));
    expect(created.status).toBe(201);
    await db.update(policies).set({ status: "cancelada" }).where(eq(policies.id, pol));
    const r = await req("PATCH", `/api/payment-batches/${created.body.id}`, { notes: "solo notas" });
    expect(r.status).toBe(200);
    const same = await req("PATCH", `/api/payment-batches/${created.body.id}`, { paymentDate: D, notes: "misma fecha" });
    expect(same.status).toBe(200);
    expect(await batchRow(created.body.id)).toEqual({ paymentDate: D, notes: "misma fecha" });
  });
});

describe("contado por período con cuotas anteriores y posteriores al corte", () => {
  async function mkCashPeriod(dueDates: string[]): Promise<{ pol: number; ids: number[] }> {
    const pol = await mkPolicy("2026-01-01", "2026-12-31");
    const ids: number[] = [];
    for (const [i, due] of dueDates.entries()) ids.push(await mkInst(pol, due, { number: i + 1 }));
    await db.update(policies).set({ cashPaymentAmountCents: dueDates.length * 100000 - 5000 }).where(eq(policies.id, pol));
    return { pol, ids };
  }

  test("una cuota anterior al 2026-07-01 bloquea el período completo, con mensaje explícito, en búsqueda y cobro", async () => {
    const { pol, ids } = await mkCashPeriod(["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"]);
    const search = await req("GET", `/api/policies/cash-period-search?policyId=${pol}&paymentDate=${D}`);
    expect(search.status).toBe(200);
    expect(search.body).toHaveLength(1);
    expect(search.body[0].eligible).toBe(false);
    expect(search.body[0].ineligibleReasons.join(" ")).toContain("anterior al 2026-07-01");
    expect(search.body[0].ineligibleReasons.join(" ")).toContain("período completo");

    const r = await req("POST", "/api/payment-batches/cash-period-payment", {
      policyId: pol, rebillingId: null, paymentDate: D, splits: [{ method: "efectivo", amount: 3950 }],
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INSTALLMENT_NOT_COLLECTABLE");
    expect(r.body.error).toContain("anterior al 2026-07-01");
    expect(r.body.error).toContain("período completo");
    expect(r.body.blockingInstallmentIds).toEqual([ids[0]]);
    // Nada cobrado: ni la cuota histórica ni las posteriores al corte.
    const paid = await db.select({ id: payments.id }).from(payments).where(inArray(payments.installmentId, ids)).all();
    expect(paid).toEqual([]);
    const rows = await db.select({ status: policyInstallments.status }).from(policyInstallments).where(inArray(policyInstallments.id, ids)).all();
    expect(rows.every((x) => x.status === "pendiente")).toBe(true);
  });

  test("control: el mismo período con todas las cuotas desde el corte es elegible", async () => {
    const { pol } = await mkCashPeriod(["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"]);
    const search = await req("GET", `/api/policies/cash-period-search?policyId=${pol}&paymentDate=${D}`);
    expect(search.body[0].eligible).toBe(true);
    expect(search.body[0].ineligibleReasons).toEqual([]);
  });
});

describe("accesorias y diagnóstico", () => {
  test("GET /policies?includeAccessories=1 incluye accesorias; sin el parámetro, no (listado de Pólizas sin cambios)", async () => {
    const principal = await mkPolicy("2026-01-01", "2026-12-31");
    const acc = await mkPolicy("2026-01-01", "2026-12-31", { parentPolicyId: principal });
    const withAcc = await req("GET", "/api/policies?includeAccessories=1");
    const without = await req("GET", "/api/policies");
    expect((withAcc.body as any[]).some((r) => r.policy.id === acc)).toBe(true);
    expect((without.body as any[]).some((r) => r.policy.id === acc)).toBe(false);
  });

  test("diagnóstico administrativo: solo conteos, sin ids ni números de póliza", async () => {
    await mkInst(await mkPolicy("2026-01-01", "2026-12-31", { status: "cancelada" }), "2026-10-01");
    const r = await req("GET", `/api/installments/collectability-diagnostics?paymentDate=${D}`);
    expect(r.status).toBe(200);
    expect(r.body.paymentDate).toBe(D);
    expect(r.body.notCollectableByReason.CANCELADA_SIN_FECHA_EFECTIVA).toBeGreaterThanOrEqual(1);
    expect(r.body.policyAnomalies.cancelledWithoutEffectiveDate).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.body)).not.toContain(PREFIX);
    expect(Object.keys(r.body).sort()).toEqual(["collectableByVia", "evaluatedInstallments", "notCollectableByReason", "paymentDate", "policyAnomalies"]);
  });

  test("paymentDate inválida en el selector → 400", async () => {
    const r = await req("GET", "/api/installments/pending-for-payment?paymentDate=2026-02-30");
    expect(r.status).toBe(400);
  });
});
