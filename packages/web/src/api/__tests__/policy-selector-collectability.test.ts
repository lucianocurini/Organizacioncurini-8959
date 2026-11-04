/**
 * Selector de pólizas de Cobranzas y cobros de póliza SIN cuota — regla de
 * posición única (evaluatePolicyCollectabilityPosition), de punta a punta:
 *  - GET  /api/policies/collectable-for-payment (selector individual y de lote)
 *  - POST /api/payments y PUT /api/payments/:id con póliza y sin cuota
 *  - POST /api/payment-batches con cobro manual con póliza (común y titular)
 *  - PATCH /api/payment-batches/:id (fecha de un lote con cobro manual con póliza)
 *  - Paridad con GET /installments/pending-for-payment y con contado.
 * Corre contra la base de DATABASE_URL (file:, SQLite sintética), nunca Turso.
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
import { assertPoliciesCollectableForPayment, PolicyNotCollectableError } from "../installment-collectability-loader";

const SESSION_ID = "test-session-policy-selector-001";
const USER_EMAIL = "test-policy-selector@test.local";
const PREFIX = "TEST-POLICY-SELECTOR";
const T = "2026-11-03";

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

interface PolicyOpts {
  status?: string; renewedFromId?: number | null; cancellationEffectiveDate?: string | null;
  insuredId?: number; parentPolicyId?: number | null; type?: string; cashPaymentAmountCents?: number | null;
}
async function mkPolicy(startDate: string, endDate: string, o: PolicyOpts = {}): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: o.type ?? "automotor", status: o.status ?? "activa", companyId, insuredId: o.insuredId ?? insuredId,
    startDate, endDate, createdBy: userId,
    renewedFromId: o.renewedFromId ?? null, cancellationEffectiveDate: o.cancellationEffectiveDate ?? null,
    parentPolicyId: o.parentPolicyId ?? null, cashPaymentAmountCents: o.cashPaymentAmountCents ?? null,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}
async function mkInst(policyId: number, dueDate: string, o: Record<string, any> = {}): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({ policyId, number: 1, dueDate, amount: 1000, status: "pendiente", rendered: 0, ...o })
    .returning({ id: policyInstallments.id });
  return i!.id;
}

async function selector(paymentDate = T, includePolicyId?: number) {
  const qs = new URLSearchParams({ paymentDate });
  if (includePolicyId != null) qs.set("includePolicyId", String(includePolicyId));
  const r = await req("GET", `/api/policies/collectable-for-payment?${qs.toString()}`);
  expect(r.status).toBe(200);
  return new Map((r.body as any[]).map((x) => [x.policy.id as number, x]));
}

function policyOnlyBody(policyId: number, paymentDate = T, status = "confirmado") {
  return { policyId, installmentId: null, amount: 500, splits: [{ method: "efectivo", amount: 500 }], paymentDate, status };
}
function manualBatchBody(policyIds: number[], paymentDate = T) {
  return {
    paymentDate,
    items: policyIds.map((policyId) => ({ source: "policy_manual_payment", policyId, amount: 500, description: "test" })),
    splits: [{ method: "efectivo", amount: policyIds.length * 500 }],
  };
}
let idemSeq = 0;
function titularManualBatchBody(policyIds: number[], paymentDate = T) {
  return {
    ...manualBatchBody(policyIds, paymentDate), accountHolderInsuredId: insuredId,
    idempotencyKey: `policy-selector-${Date.now()}-${idemSeq++}`, creditAppliedCents: 0, roundingCoverageCents: 0,
  };
}

/** Cadena anual al 03/11: P1 (antigua) → P2 (anterior) → P3 (vigente hasta 30/11) → P4 (próxima) → P5 (segunda futura). */
async function mkChain5(ins?: number) {
  const P1 = await mkPolicy("2024-06-01", "2025-05-31", { status: "renovada", insuredId: ins });
  const P2 = await mkPolicy("2025-06-01", "2025-11-30", { status: "renovada", renewedFromId: P1, insuredId: ins });
  const P3 = await mkPolicy("2025-12-01", "2026-11-30", { status: "renovada", renewedFromId: P2, insuredId: ins });
  const P4 = await mkPolicy("2026-12-01", "2027-11-30", { status: "renovada", renewedFromId: P3, insuredId: ins });
  const P5 = await mkPolicy("2027-12-01", "2028-11-30", { renewedFromId: P4, insuredId: ins });
  return { P1, P2, P3, P4, P5 };
}

beforeAll(async () => {
  const prev = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prev) throw new Error(`Residuo de una corrida anterior (usuario ${USER_EMAIL}) — limpiar la base de test antes de correr.`);
  const [u] = await db.insert(users).values({ name: "Test Policy Selector", email: USER_EMAIL, password: "x", role: "admin", active: 1 }).returning({ id: users.id });
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
    for (const id of [...policyIdsToClean].reverse()) await db.delete(policies).where(eq(policies.id, id));
  }
  if (insuredIdsToClean.length) await db.delete(insureds).where(inArray(insureds.id, insuredIdsToClean));
  await db.delete(companies).where(eq(companies.id, companyId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("GET /policies/collectable-for-payment", () => {
  test("vigente + anterior inmediata + próxima inmediata; la más antigua y la segunda futura no aparecen", async () => {
    const c = await mkChain5();
    const s = await selector();
    expect(s.has(c.P1)).toBe(false);
    expect(s.get(c.P2)?.via).toBe("antecesora_directa");
    expect(s.get(c.P3)?.via).toBe("poliza_vigente");
    expect(s.get(c.P4)?.via).toBe("proxima_inmediata");
    expect(s.has(c.P5)).toBe(false);
    for (const id of [c.P2, c.P3, c.P4]) expect(s.get(id)!.collectable).toBe(true);
  });

  test("hueco entre vigencias: la última terminada y su próxima inmediata; nada más antiguo ni segunda futura", async () => {
    const G0 = await mkPolicy("2024-10-01", "2025-09-30", { status: "renovada" });
    const G1 = await mkPolicy("2025-10-01", "2026-09-30", { status: "renovada", renewedFromId: G0 });
    const G2 = await mkPolicy("2026-12-01", "2027-11-30", { status: "renovada", renewedFromId: G1 });
    const G3 = await mkPolicy("2027-12-01", "2028-11-30", { renewedFromId: G2 });
    const s = await selector();
    expect(s.has(G0)).toBe(false);
    expect(s.get(G1)?.via).toBe("ultima_terminada");
    expect(s.get(G2)?.via).toBe("proxima_inmediata");
    expect(s.has(G3)).toBe(false);
  });

  test("futura suelta, canceladas y cadenas ambiguas", async () => {
    const suelta = await mkPolicy("2026-12-01", "2027-11-30");
    const canceladaVigente = await mkPolicy("2026-01-01", "2026-12-31", { status: "cancelada", cancellationEffectiveDate: "2026-11-10" });
    const canceladaTerminada = await mkPolicy("2026-01-01", "2026-12-31", { status: "cancelada", cancellationEffectiveDate: "2026-10-01" });
    const canceladaSinFecha = await mkPolicy("2026-01-01", "2026-12-31", { status: "cancelada" });
    const base = await mkPolicy("2026-01-01", "2026-11-30", { status: "renovada" });
    const amb1 = await mkPolicy("2026-12-01", "2027-11-30", { renewedFromId: base });
    const amb2 = await mkPolicy("2026-12-01", "2027-11-30", { renewedFromId: base });
    const vencidaSuelta = await mkPolicy("2025-01-01", "2025-12-31", { status: "vencida" });
    const s = await selector();
    expect(s.has(suelta)).toBe(false);
    expect(s.get(canceladaVigente)?.via).toBe("poliza_vigente");
    expect(s.has(canceladaTerminada)).toBe(false);
    expect(s.has(canceladaSinFecha)).toBe(false);
    expect(s.get(base)?.via).toBe("poliza_vigente");
    expect(s.has(amb1)).toBe(false);
    expect(s.has(amb2)).toBe(false);
    expect(s.has(vencidaSuelta)).toBe(false);
  });

  test("pólizas válidas sin cuotas cobrables: aparecen con hasCollectableInstallments=false", async () => {
    const sinCuotas = await mkPolicy("2026-01-01", "2026-12-31");
    const conPagada = await mkPolicy("2026-01-01", "2026-12-31");
    await mkInst(conPagada, "2026-10-01", { status: "pagada" });
    const conCuota = await mkPolicy("2026-01-01", "2026-12-31");
    await mkInst(conCuota, "2026-10-01");
    const s = await selector();
    expect(s.get(sinCuotas)).toMatchObject({ collectable: true, hasCollectableInstallments: false });
    expect(s.get(conPagada)).toMatchObject({ collectable: true, hasCollectableInstallments: false });
    expect(s.get(conCuota)).toMatchObject({ collectable: true, hasCollectableInstallments: true });
  });

  test("accesorias: con su propia posición; vínculo válido, principal fuera de posición y vínculo inválido", async () => {
    const principal = await mkPolicy("2026-01-01", "2026-12-31");
    const acc = await mkPolicy("2026-02-01", "2026-12-31", { parentPolicyId: principal, type: "accidentes_pasajeros" });
    await mkInst(acc, "2026-10-01");
    // Principal fuera de posición (terminada sin sucesora) con accesoria propia vigente.
    const principalVieja = await mkPolicy("2025-01-01", "2025-12-31");
    const accHuerfana = await mkPolicy("2026-01-01", "2026-12-31", { parentPolicyId: principalVieja, type: "accidentes_pasajeros" });
    // Vínculo inválido: otro asegurado.
    const [otro] = await db.insert(insureds).values({ name: `${PREFIX} Otro`, createdBy: userId }).returning({ id: insureds.id });
    insuredIdsToClean.push(otro!.id);
    const accOtro = await mkPolicy("2026-01-01", "2026-12-31", { parentPolicyId: principal, type: "accidentes_pasajeros", insuredId: otro!.id });
    // Accesoria cuya propia posición no es cobrable (terminada): no aparece aunque su principal sí.
    const accVieja = await mkPolicy("2025-01-01", "2025-12-31", { parentPolicyId: principal, type: "accidentes_pasajeros" });

    const s = await selector();
    expect(s.get(principal)?.accessory).toBeNull();
    expect(s.get(acc)).toMatchObject({ collectable: true, hasCollectableInstallments: true });
    expect(s.get(acc)!.accessory).toMatchObject({ parentPolicyId: principal, linkValid: true });
    expect(typeof s.get(acc)!.accessory.parentPolicyNumber).toBe("string");
    expect(s.has(principalVieja)).toBe(false);
    expect(s.get(accHuerfana)?.collectable).toBe(true);
    expect(s.get(accOtro)!.accessory.linkValid).toBe(false);
    expect(s.has(accVieja)).toBe(false);
  });

  test("includePolicyId (edición): vuelve aunque no esté en posición, con collectable=false y motivo", async () => {
    const vieja = await mkPolicy("2024-01-01", "2024-12-31");
    expect((await selector()).has(vieja)).toBe(false);
    const s = await selector(T, vieja);
    expect(s.get(vieja)).toMatchObject({ collectable: false, via: null, reason: "SIN_POLIZA_VIGENTE_EN_CADENA" });
  });

  test("fecha inválida → 400; la ruta no la captura /policies/:id", async () => {
    expect((await req("GET", "/api/policies/collectable-for-payment?paymentDate=2026-02-30")).status).toBe(400);
    expect((await req("GET", "/api/policies/collectable-for-payment?paymentDate=2026-11-03&includePolicyId=abc")).status).toBe(400);
    const ok = await req("GET", "/api/policies/collectable-for-payment?paymentDate=2026-11-03");
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
  });

  test("cambio de fecha: el conjunto se recalcula con la fecha pedida", async () => {
    const c = await mkChain5();
    const antes = await selector("2026-11-30");
    const despues = await selector("2026-12-01");
    expect([antes.has(c.P2), antes.has(c.P3), antes.has(c.P4), antes.has(c.P5)]).toEqual([true, true, true, false]);
    expect([despues.has(c.P2), despues.has(c.P3), despues.has(c.P4), despues.has(c.P5)]).toEqual([false, true, true, true]);
    expect(despues.get(c.P3)?.via).toBe("antecesora_directa");
    expect(despues.get(c.P5)?.via).toBe("proxima_inmediata");
  });
});

describe("POST /payments con póliza y sin cuota", () => {
  test("póliza en posición → 201; fuera de posición → 400 POLICY_NOT_COLLECTABLE sin escribir nada", async () => {
    const c = await mkChain5();
    for (const id of [c.P2, c.P3, c.P4]) expect((await req("POST", "/api/payments", policyOnlyBody(id))).status).toBe(201);
    for (const [id, reason] of [[c.P1, "ANTECESORA_MAS_ANTIGUA"], [c.P5, "SUCESORA_NO_INMEDIATA"]] as const) {
      const before = (await db.select({ id: payments.id }).from(payments).where(eq(payments.policyId, id)).all()).length;
      const r = await req("POST", "/api/payments", policyOnlyBody(id));
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("POLICY_NOT_COLLECTABLE");
      expect(r.body.failures).toEqual([{ policyId: id, reason }]);
      const after = (await db.select({ id: payments.id }).from(payments).where(eq(payments.policyId, id)).all()).length;
      expect(after).toBe(before);
    }
  });

  test("póliza inexistente → 404; un pago no confirmado no se valida (se valida al confirmarse)", async () => {
    expect((await req("POST", "/api/payments", policyOnlyBody(987654321))).status).toBe(404);
    const vieja = await mkPolicy("2024-01-01", "2024-12-31");
    expect((await req("POST", "/api/payments", policyOnlyBody(vieja, T, "pendiente"))).status).toBe(201);
  });

  test("hueco: la última terminada y la próxima aceptan cobro sin cuota", async () => {
    const G1 = await mkPolicy("2025-10-01", "2026-09-30", { status: "renovada" });
    const G2 = await mkPolicy("2026-12-01", "2027-11-30", { renewedFromId: G1 });
    expect((await req("POST", "/api/payments", policyOnlyBody(G1))).status).toBe(201);
    expect((await req("POST", "/api/payments", policyOnlyBody(G2))).status).toBe(201);
  });
});

describe("PUT /payments/:id con póliza y sin cuota", () => {
  async function historicalPayment(policyId: number, paymentDate: string, status = "confirmado") {
    // Pago histórico cargado cuando la póliza estaba en posición.
    const r = await req("POST", "/api/payments", policyOnlyBody(policyId, paymentDate, status));
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  test("edición histórica sin cambiar póliza ni fecha (notas): nunca se bloquea aunque hoy esté fuera de posición", async () => {
    const vieja = await mkPolicy("2025-01-01", "2025-12-31");
    const id = await historicalPayment(vieja, "2025-06-01");
    // Después del cobro la póliza queda inválida para cualquier fecha (cancelada sin fecha efectiva).
    await db.update(policies).set({ status: "cancelada" }).where(eq(policies.id, vieja));
    expect((await req("POST", "/api/payments", policyOnlyBody(vieja, "2025-06-01"))).body.code).toBe("POLICY_NOT_COLLECTABLE");
    const r = await req("PUT", `/api/payments/${id}`, { notes: "nota nueva" });
    expect(r.status).toBe(200);
    expect(r.body.notes).toBe("nota nueva");
    // Reenviar la MISMA póliza y fecha tampoco es un cambio.
    const same = await req("PUT", `/api/payments/${id}`, { policyId: vieja, paymentDate: "2025-06-01", notes: "otra" });
    expect(same.status).toBe(200);
  });

  test("cambiar la fecha a una en que la póliza no está en posición → 400 y el pago queda igual; a una válida → 200", async () => {
    const c = await mkChain5();
    const id = await historicalPayment(c.P3, T);
    // El 2025-03-01 la vigente es P1: P3 es la segunda renovación futura.
    const bad = await req("PUT", `/api/payments/${id}`, { paymentDate: "2025-03-01" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("POLICY_NOT_COLLECTABLE");
    expect(bad.body.failures).toEqual([{ policyId: c.P3, reason: "SUCESORA_NO_INMEDIATA" }]);
    const row = await db.select({ paymentDate: payments.paymentDate }).from(payments).where(eq(payments.id, id)).get();
    expect(row!.paymentDate).toBe(T);
    expect((await req("PUT", `/api/payments/${id}`, { paymentDate: "2026-12-15" })).status).toBe(200);
  });

  test("cambiar la póliza: a una fuera de posición → 400; a una inexistente → 404; a una válida → 200", async () => {
    const c = await mkChain5();
    const id = await historicalPayment(c.P3, T);
    expect((await req("PUT", `/api/payments/${id}`, { policyId: c.P1 })).body.code).toBe("POLICY_NOT_COLLECTABLE");
    expect((await req("PUT", `/api/payments/${id}`, { policyId: 987654321 })).status).toBe(404);
    expect((await req("PUT", `/api/payments/${id}`, { policyId: c.P4 })).status).toBe(200);
  });

  test("confirmar un pago pendiente de una póliza fuera de posición → 400", async () => {
    const vieja = await mkPolicy("2024-01-01", "2024-12-31");
    const id = await historicalPayment(vieja, T, "pendiente");
    const r = await req("PUT", `/api/payments/${id}`, { status: "confirmado" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("POLICY_NOT_COLLECTABLE");
  });
});

describe("Cobrar en lote: cobro manual con póliza", () => {
  test("común y titular: póliza en posición → 201; fuera → 400 POLICY_NOT_COLLECTABLE; cancelada vigente se acepta", async () => {
    const c = await mkChain5();
    expect((await req("POST", "/api/payment-batches", manualBatchBody([c.P3]))).status).toBe(201);
    expect((await req("POST", "/api/payment-batches", titularManualBatchBody([c.P4]))).status).toBe(201);
    const bad = await req("POST", "/api/payment-batches", manualBatchBody([c.P1]));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("POLICY_NOT_COLLECTABLE");
    const badT = await req("POST", "/api/payment-batches", titularManualBatchBody([c.P5]));
    expect(badT.status).toBe(400);
    expect(badT.body.code).toBe("POLICY_NOT_COLLECTABLE");
    const canceladaVigente = await mkPolicy("2026-01-01", "2026-12-31", { status: "cancelada", cancellationEffectiveDate: "2026-11-10" });
    expect((await req("POST", "/api/payment-batches", manualBatchBody([canceladaVigente]))).status).toBe(201);
    const canceladaSinFecha = await mkPolicy("2026-01-01", "2026-12-31", { status: "cancelada" });
    expect((await req("POST", "/api/payment-batches", manualBatchBody([canceladaSinFecha]))).body.code).toBe("POLICY_NOT_COLLECTABLE");
  });

  test("PATCH de fecha: fecha en que la póliza del cobro manual sale de posición → 400 y el lote queda igual; solo notas → 200", async () => {
    const c = await mkChain5();
    const created = await req("POST", "/api/payment-batches", manualBatchBody([c.P4]));
    expect(created.status).toBe(201);
    // El 2025-08-01 la vigente es P2: P4 es una segunda renovación futura.
    const bad = await req("PATCH", `/api/payment-batches/${created.body.id}`, { paymentDate: "2025-08-01" });
    expect(bad.status).toBe(400);
    expect(bad.body.failures).toEqual([{ policyId: c.P4, reason: "SUCESORA_NO_INMEDIATA" }]);
    const row = await db.select({ paymentDate: paymentBatches.paymentDate }).from(paymentBatches).where(eq(paymentBatches.id, created.body.id)).get();
    expect(row!.paymentDate).toBe(T);
    expect((await req("PATCH", `/api/payment-batches/${created.body.id}`, { notes: "solo notas" })).status).toBe(200);
  });
});

describe("revalidación dentro de la transacción", () => {
  test("assertPoliciesCollectableForPayment con tx ve el dato cambiado dentro de la transacción y revierte todo", async () => {
    const p = await mkPolicy("2026-01-01", "2026-12-31");
    await assertPoliciesCollectableForPayment(db, [p], T);
    let thrown: unknown = null;
    try {
      await db.transaction(async (tx) => {
        await tx.update(policies).set({ notes: "tocada en la tx" }).where(eq(policies.id, p));
        await tx.update(policies).set({ status: "cancelada" }).where(eq(policies.id, p));
        await assertPoliciesCollectableForPayment(tx, [p], T);
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(PolicyNotCollectableError);
    expect((thrown as PolicyNotCollectableError).failures).toEqual([{ policyId: p, reason: "CANCELADA_SIN_FECHA_EFECTIVA", message: expect.any(String) }]);
    const row = await db.select({ status: policies.status, notes: policies.notes }).from(policies).where(eq(policies.id, p)).get();
    expect(row).toEqual({ status: "activa", notes: null });
  });
});

describe("paridad: selector ⇔ cuotas ⇔ individual ⇔ lote ⇔ contado", () => {
  test("para cada póliza: aparece en el selector ⇔ acepta cobro sin cuota (individual, lote, titular) ⇔ sus cuotas aparecen en pending-for-payment", async () => {
    const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Paridad`, createdBy: userId }).returning({ id: insureds.id });
    insuredIdsToClean.push(ins!.id);
    const c = await mkChain5(ins!.id);
    const G1 = await mkPolicy("2025-10-01", "2026-09-30", { status: "renovada", insuredId: ins!.id });
    const G2 = await mkPolicy("2026-12-01", "2027-11-30", { renewedFromId: G1, insuredId: ins!.id });
    const suelta = await mkPolicy("2026-12-01", "2027-11-30", { insuredId: ins!.id });
    const canc = await mkPolicy("2026-01-01", "2026-12-31", { status: "cancelada", cancellationEffectiveDate: "2026-10-01", insuredId: ins!.id });
    const all = [c.P1, c.P2, c.P3, c.P4, c.P5, G1, G2, suelta, canc];
    const instByPolicy = new Map<number, number>();
    for (const id of all) instByPolicy.set(id, await mkInst(id, "2026-09-15"));

    const s = await selector();
    const pendingRows = (await req("GET", `/api/installments/pending-for-payment?insuredId=${ins!.id}&paymentDate=${T}`)).body as any[];
    const pendingPolicyIds = new Set(pendingRows.map((r) => r.policyId as number));
    const mismatches: string[] = [];
    for (const id of all) {
      const inSelector = s.get(id)?.collectable === true;
      const inPending = pendingPolicyIds.has(id);
      const indiv = (await req("POST", "/api/payments", policyOnlyBody(id))).status === 201;
      const lote = (await req("POST", "/api/payment-batches", manualBatchBody([id]))).status === 201;
      const titular = (await req("POST", "/api/payment-batches", titularManualBatchBody([id]))).status === 201;
      if (inSelector && !s.get(id)!.hasCollectableInstallments) mismatches.push(`${id}: hasCollectableInstallments=false con cuota cobrable`);
      if ([inPending, indiv, lote, titular].some((v) => v !== inSelector)) {
        mismatches.push(`${id}: selector=${inSelector} pending=${inPending} individual=${indiv} lote=${lote} titular=${titular}`);
      }
    }
    expect(mismatches).toEqual([]);
    // Esperado explícito: anterior, vigente, próxima + última terminada y próxima del hueco.
    expect(all.filter((id) => s.get(id)?.collectable === true).sort((a, b) => a - b)).toEqual([c.P2, c.P3, c.P4, G1, G2].sort((a, b) => a - b));
  });

  test("contado: elegible solo para pólizas que muestra el selector (misma regla)", async () => {
    const c = await mkChain5();
    const cases: [number, boolean][] = [[c.P3, true], [c.P4, true], [c.P5, false]];
    const s = await selector();
    for (const [id, expected] of cases) {
      await db.update(policies).set({ cashPaymentAmountCents: 150000 }).where(eq(policies.id, id));
      await mkInst(id, id === c.P3 ? "2026-11-20" : id === c.P4 ? "2026-12-15" : "2027-12-15", { number: 1 });
      await mkInst(id, id === c.P3 ? "2026-11-25" : id === c.P4 ? "2027-01-15" : "2028-01-15", { number: 2 });
      const search = await req("GET", `/api/policies/cash-period-search?policyId=${id}&paymentDate=${T}`);
      expect(search.status).toBe(200);
      expect(search.body[0].eligible).toBe(expected);
      expect(s.get(id)?.collectable === true).toBe(expected);
    }
  });
});
