/**
 * Tests de Etapa 4C — remittance_allocations sobre los endpoints reales
 * POST/DELETE /api/remittances, incluyendo su interacción con payment_batches
 * (Etapa 4A/4B). Corre exclusivamente contra dev.db local (nunca Turso) —
 * misma estrategia de fixtures aisladas por prefijo que payment-batches.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments,
  payments, paymentSplits, paymentBatches, paymentBatchSplits, receivedChecks,
  cashEntries, remittances, remittanceItems, remittanceAllocations, paymentAmountAdjustments,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-remit-alloc-001";
const USER_EMAIL = "test-remit-alloc@test.local";
const PREFIX = "TEST-REMIT-ALLOC";

let userId: number;
let companyId: number;
let rivadaviaCompanyId: number;
let insuredId: number;

const policyIdsToClean: number[] = [];
const paymentIdsToClean: number[] = [];
const cashEntryIdsToClean: number[] = [];
const batchIdsToClean: number[] = [];
const remittanceIdsToClean: number[] = [];

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function mkPolicy(company: number): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: "activa", companyId: company, insuredId,
    startDate: "2027-01-01", endDate: "2027-12-31", isRebilling: 0, createdBy: userId,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}

async function mkInstallment(policyId: number, number: number, amount: number): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({
    policyId, number, dueDate: "2027-06-01", amount, status: "pendiente", rendered: 0,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

async function mkStandalonePayment(params: {
  amount: number; splits: { method: string; amountCents: number }[]; rendered?: number; status?: string;
}): Promise<{ paymentId: number; splitIds: number[] }> {
  const [p] = await db.insert(payments).values({
    amount: params.amount, paymentMethod: params.splits.length > 1 ? "combinado" : params.splits[0]!.method,
    paymentDate: "2027-06-01", status: params.status ?? "confirmado", rendered: params.rendered ?? 0,
    createdBy: userId,
  }).returning({ id: payments.id });
  paymentIdsToClean.push(p!.id);
  const splitIds: number[] = [];
  for (const s of params.splits) {
    const [row] = await db.insert(paymentSplits).values({
      paymentId: p!.id, method: s.method, amountCents: s.amountCents,
    }).returning({ id: paymentSplits.id });
    splitIds.push(row!.id);
  }
  return { paymentId: p!.id, splitIds };
}

async function mkCashEntry(params: { amount: number; method: string; entryType?: string; paymentId?: number; rendered?: number }): Promise<number> {
  const [e] = await db.insert(cashEntries).values({
    clientName: `${PREFIX} Cliente`, amount: params.amount, paymentMethod: params.method,
    paymentDate: "2027-06-01", entryType: params.entryType ?? "normal", paymentId: params.paymentId ?? null,
    rendered: params.rendered ?? 0, createdBy: userId,
  }).returning({ id: cashEntries.id });
  cashEntryIdsToClean.push(e!.id);
  return e!.id;
}

async function callPostBatch(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) batchIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function callGetBatch(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/payment-batches/${id}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

async function callPostRemittance(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/remittances", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) remittanceIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function callDeleteRemittance(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/remittances/${id}`, {
    method: "DELETE", headers: authHeaders(),
  }));
  return { status: res.status, body: await res.json() };
}

async function getAllocations(remittanceId: number) {
  return db.select().from(remittanceAllocations).where(eq(remittanceAllocations.remittanceId, remittanceId)).all();
}

async function getPayment(id: number) {
  return db.select().from(payments).where(eq(payments.id, id)).get();
}

async function getCashEntry(id: number) {
  return db.select().from(cashEntries).where(eq(cashEntries.id, id)).get();
}

async function getInstallment(id: number) {
  return db.select().from(policyInstallments).where(eq(policyInstallments.id, id)).get();
}

async function mkChildIds(batchId: number): Promise<number[]> {
  const rows = await db.select().from(payments).where(eq(payments.batchId, batchId)).all();
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const polIds = prevPols.map((p) => p.id);
    const payRows = await db.select({ id: payments.id }).from(payments).where(eq(payments.createdBy, prevUser.id)).all();
    const payIds = payRows.map((r) => r.id);
    const batchRows = payIds.length
      ? await db.select({ id: paymentBatches.id }).from(paymentBatches)
          .innerJoin(payments, eq(payments.batchId, paymentBatches.id))
          .where(inArray(payments.id, payIds)).all()
      : [];
    const batchIds = [...new Set(batchRows.map((r: any) => r.id))];
    const remRows = await db.select({ id: remittances.id }).from(remittances).where(eq(remittances.createdBy, prevUser.id)).all();
    const remIds = remRows.map((r) => r.id);
    if (remIds.length) await db.delete(remittanceAllocations).where(inArray(remittanceAllocations.remittanceId, remIds)).catch(() => {});
    if (remIds.length) await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remIds)).catch(() => {});
    if (remIds.length) await db.delete(remittances).where(inArray(remittances.id, remIds)).catch(() => {});
    if (payIds.length) await db.delete(cashEntries).where(inArray(cashEntries.paymentId, payIds)).catch(() => {});
    await db.delete(cashEntries).where(eq(cashEntries.createdBy, prevUser.id)).catch(() => {});
    if (payIds.length) await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds)).catch(() => {});
    if (payIds.length) await db.delete(payments).where(inArray(payments.id, payIds)).catch(() => {});
    if (batchIds.length) {
      const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).all();
      const splitIds = splitRows.map((s) => s.id);
      if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).catch(() => {});
    }
    // payment_amount_adjustments.payment_batch_id referencia payment_batches
    // — debe limpiarse ANTES de borrar payment_batches (mismo bug de orden
    // documentado en payment-batches.test.ts, Fase 2B).
    if (batchIds.length) await db.delete(paymentAmountAdjustments).where(inArray(paymentAmountAdjustments.paymentBatchId, batchIds)).catch(() => {});
    if (batchIds.length) await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).catch(() => {});
    if (batchIds.length) await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIds)).catch(() => {});
    if (polIds.length) await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, polIds)).catch(() => {});
    if (polIds.length) await db.delete(policies).where(inArray(policies.id, polIds)).catch(() => {});
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Remit Alloc", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const existingRivCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Rivadavia Co`)).get();
  rivadaviaCompanyId = existingRivCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Rivadavia Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(async () => {
  if (remittanceIdsToClean.length) {
    await db.delete(remittanceAllocations).where(inArray(remittanceAllocations.remittanceId, remittanceIdsToClean)).catch(() => {});
    await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remittanceIdsToClean)).catch(() => {});
    await db.delete(remittances).where(inArray(remittances.id, remittanceIdsToClean)).catch(() => {});
  }
  if (cashEntryIdsToClean.length) await db.delete(cashEntries).where(inArray(cashEntries.id, cashEntryIdsToClean)).catch(() => {});
  if (paymentIdsToClean.length) {
    await db.delete(cashEntries).where(inArray(cashEntries.paymentId, paymentIdsToClean)).catch(() => {});
    await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, paymentIdsToClean)).catch(() => {});
  }
  if (batchIdsToClean.length) {
    const childRows = await db.select({ id: payments.id }).from(payments).where(inArray(payments.batchId, batchIdsToClean)).all();
    const childIds = childRows.map((r) => r.id);
    if (childIds.length) {
      await db.delete(cashEntries).where(inArray(cashEntries.paymentId, childIds)).catch(() => {});
      await db.delete(payments).where(inArray(payments.id, childIds)).catch(() => {});
    }
    const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsToClean)).all();
    const splitIds = splitRows.map((s) => s.id);
    if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).catch(() => {});
    await db.delete(paymentAmountAdjustments).where(inArray(paymentAmountAdjustments.paymentBatchId, batchIdsToClean)).catch(() => {});
    await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsToClean)).catch(() => {});
    await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIdsToClean)).catch(() => {});
  }
  if (paymentIdsToClean.length) await db.delete(payments).where(inArray(payments.id, paymentIdsToClean)).catch(() => {});
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  await db.delete(insureds).where(eq(insureds.id, insuredId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.id, SESSION_ID)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("POST /api/remittances — allocations de pago standalone", () => {
  test("pago simple crea una allocation", async () => {
    const { paymentId, splitIds } = await mkStandalonePayment({ amount: 1000, splits: [{ method: "efectivo", amountCents: 100000 }] });
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment", sourceId: paymentId, amount: 1000, paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(1);
    expect(allocs[0]!.paymentSplitId).toBe(splitIds[0]);
    expect(allocs[0]!.amountCents).toBe(100000);
    expect((await getPayment(paymentId))!.rendered).toBe(1);
  });

  test("pago combinado crea N allocations", async () => {
    const { paymentId } = await mkStandalonePayment({
      amount: 2000, splits: [{ method: "efectivo", amountCents: 120000 }, { method: "transferencia", amountCents: 80000 }],
    });
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1200, transferencia: 800 },
      items: [{ source: "payment", sourceId: paymentId, amount: 2000, paymentMethod: "combinado" }],
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(2);
    expect(allocs.reduce((s, a) => s + a.amountCents, 0)).toBe(200000);
  });

  test("origen ya rendido devuelve 409 y no crea nada", async () => {
    const { paymentId } = await mkStandalonePayment({ amount: 500, splits: [{ method: "efectivo", amountCents: 50000 }], rendered: 1 });
    const before = await db.select().from(remittances).all();
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 500 },
      items: [{ source: "payment", sourceId: paymentId, amount: 500 }],
    });
    expect(res.status).toBe(409);
    const after = await db.select().from(remittances).all();
    expect(after.length).toBe(before.length);
  });

  test("inconsistencia entre payment.amount y la suma real de sus splits se detecta y rechaza", async () => {
    // payment.amount=1000 pero splits solo suman 900 (dato inconsistente, no
    // alcanzable vía POST /payments normal, simulado directo en la base).
    const { paymentId } = await mkStandalonePayment({ amount: 1000, splits: [{ method: "efectivo", amountCents: 90000 }] });
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment", sourceId: paymentId, amount: 1000 }],
    });
    expect(res.status).toBe(409);
    expect((await getPayment(paymentId))!.rendered).toBe(0);
  });
});

describe("POST /api/remittances — cash_entry, manual_debt, installment no cobrada", () => {
  test("cash_entry crea una allocation propia", async () => {
    const ceId = await mkCashEntry({ amount: 300, method: "efectivo" });
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 300 },
      items: [{ source: "cash_entry", sourceId: ceId, amount: 300, paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(1);
    expect(allocs[0]!.cashEntryId).toBe(ceId);
    expect(allocs[0]!.amountCents).toBe(30000);
    expect((await getCashEntry(ceId))!.rendered).toBe(1);
  });

  test("manual_debt no crea allocation y la rendición es válida (expected=0)", async () => {
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 800 },
      items: [{ source: "manual_debt", amount: 800, debtorStatus: "adeudado" }],
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(0);
  });

  test("cuota no cobrada (source=installment) no crea allocation y marca rendered", async () => {
    const policyId = await mkPolicy(companyId);
    const instId = await mkInstallment(policyId, 1, 700);
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 700 },
      items: [{ source: "installment", sourceId: instId, amount: 700 }],
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(0);
    expect((await getInstallment(instId))!.rendered).toBe(1);
  });
});

describe("POST /api/remittances — cobro múltiple (payment_batches), rendición por cuota", () => {
  // Etapa "rendición por cuota" (Migración 0029): cobrar por lote agrupa
  // cuotas solo para cobrarlas más rápido — NO obliga a rendirlas juntas.
  // Cada hijo de batch se rinde con su propio instrumento de SALIDA
  // (paymentMethod elegido en el item), nunca arrastrando payment_batch_
  // splits/received_checks del batch original.

  test("cada hijo de un batch rendido junto crea su propia allocation independiente (no comparten instrumento)", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const p2 = await mkPolicy(companyId);
    const i2 = await mkInstallment(p2, 1, 1000);

    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }, { installmentId: i2 }],
      splits: [{ method: "transferencia", amount: 2000 }],
      applyProntoPagoSurcharge: false,
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);
    expect(children.length).toBe(2);

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { transferencia: 2000 },
      items: children.map((cid) => ({ source: "payment", sourceId: cid, amount: 1000, paymentMethod: "transferencia" })),
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(2); // una allocation POR HIJO, no una compartida
    for (const a of allocs) {
      expect(a.paymentBatchId).toBe(batchId);
      expect(a.paymentBatchSplitId).toBeNull(); // no consume el instrumento de cobranza
      expect(a.receivedCheckId).toBeNull();
      expect(a.paymentId).not.toBeNull();
      expect(a.amountCents).toBe(100000);
    }
    expect(new Set(allocs.map((a) => a.paymentId)).size).toBe(2);
    for (const cid of children) expect((await getPayment(cid))!.rendered).toBe(1);
  });

  test("batch parcial: se puede rendir un solo hijo, el resto queda pendiente (ya no 409)", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const p2 = await mkPolicy(companyId);
    const i2 = await mkInstallment(p2, 1, 1000);

    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }, { installmentId: i2 }],
      splits: [{ method: "efectivo", amount: 2000 }],
      applyProntoPagoSurcharge: false,
    });
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment", sourceId: children[0], amount: 1000, paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(1);
    expect(allocs[0]!.paymentId).toBe(children[0]);

    expect((await getPayment(children[0]!))!.rendered).toBe(1); // rendido
    expect((await getPayment(children[1]!))!.rendered).toBe(0); // sigue pendiente, sin tocar
  });

  test("hijo de batch sin paymentMethod (o inválido) se rechaza con 409 claro, sin tocar nada", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }],
      splits: [{ method: "efectivo", amount: 1000 }],
      applyProntoPagoSurcharge: false,
    });
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);

    const beforeCount = (await db.select().from(remittances).all()).length;
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment", sourceId: children[0], amount: 1000, paymentMethod: "lote" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/método de rendición real/);
    const afterCount = (await db.select().from(remittances).all()).length;
    expect(afterCount).toBe(beforeCount);
    expect((await getPayment(children[0]!))!.rendered).toBe(0);
    void batchId;
  });

  test("un hijo de un batch con cheque se rinde con su propio instrumento de salida, sin apuntar al cheque original", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1500);

    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }],
      splits: [{
        method: "cheque", amount: 1500,
        checks: [
          { checkNumber: `${PREFIX}-CHK-A-${Date.now()}`, bankName: `${PREFIX} Banco`, dueDate: "2027-07-01", amount: 1000 },
          { checkNumber: `${PREFIX}-CHK-B-${Date.now()}`, bankName: `${PREFIX} Banco`, dueDate: "2027-07-01", amount: 500 },
        ],
      }],
      applyProntoPagoSurcharge: false,
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);

    // Se rinde con un medio de SALIDA distinto al de cobro original (cobrado
    // con cheques, rendido por transferencia propia) — exactamente el caso
    // que motivó este rediseño.
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { transferencia: 1500 },
      items: [{ source: "payment", sourceId: children[0], amount: 1500, paymentMethod: "transferencia" }],
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(1);
    expect(allocs[0]!.method).toBe("transferencia");
    expect(allocs[0]!.receivedCheckId).toBeNull();
    expect(allocs[0]!.paymentBatchSplitId).toBeNull();
    expect(allocs[0]!.amountCents).toBe(150000);
    expect(allocs[0]!.paymentId).toBe(children[0]);
    expect(batchId).toBeGreaterThan(0);
  });

  test("pago individual + hijo de batch de la MISMA compañía se rinden juntos en una sola rendición", async () => {
    const { paymentId: standaloneId } = await mkStandalonePayment({ amount: 500, splits: [{ method: "efectivo", amountCents: 50000 }] });

    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }],
      splits: [{ method: "efectivo", amount: 1000 }],
      applyProntoPagoSurcharge: false,
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);
    const batchChildId = children[0]!;

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1500 },
      items: [
        { source: "payment", sourceId: standaloneId, amount: 500, paymentMethod: "efectivo" },
        { source: "payment", sourceId: batchChildId, amount: 1000, paymentMethod: "efectivo" },
      ],
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(2);
    expect(allocs.reduce((s, a) => s + a.amountCents, 0)).toBe(150000);
    expect((await getPayment(standaloneId))!.rendered).toBe(1);
    expect((await getPayment(batchChildId))!.rendered).toBe(1);
  });

  test("doble rendición del mismo hijo de batch queda bloqueada, igual que un pago standalone", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }],
      splits: [{ method: "efectivo", amount: 1000 }],
      applyProntoPagoSurcharge: false,
    });
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);
    const childId = children[0]!;

    const first = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment", sourceId: childId, amount: 1000, paymentMethod: "efectivo" }],
    });
    expect(first.status).toBe(200);

    const beforeCount = (await db.select().from(remittances).all()).length;
    const second = await callPostRemittance({
      date: "2027-06-02", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment", sourceId: childId, amount: 1000, paymentMethod: "efectivo" }],
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/ya fue rendido/);
    const afterCount = (await db.select().from(remittances).all()).length;
    expect(afterCount).toBe(beforeCount);
  });

  test("batch con recargo Pronto Pago: el hijo y su recargo se rinden juntos, cada uno con su propia allocation (sin duplicar ni perder)", async () => {
    const p1 = await mkPolicy(rivadaviaCompanyId);
    const i1 = await mkInstallment(p1, 1, 1000);

    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }],
      splits: [{ method: "efectivo", amount: 1800 }], // 1000 base + 800 recargo
      applyProntoPagoSurcharge: true,
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);
    expect(children.length).toBe(1);

    const surchargeRows = await db.select().from(cashEntries)
      .where(eq(cashEntries.paymentId, children[0]!)).all();
    expect(surchargeRows.length).toBe(1);
    expect(surchargeRows[0]!.entryType).toBe("pronto_pago_surcharge");

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "pronto_pago", paymentBreakdown: { efectivo: 1800 },
      items: [{ source: "payment", sourceId: children[0], amount: 1000, paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(200);

    const allocs = await getAllocations(res.body.id);
    // Una allocation por la cuota (1000) + una allocation propia por el
    // recargo (800) — ninguna arrastra el instrumento del batch, y la suma
    // total sigue siendo exacta (nada se pierde ni se duplica).
    expect(allocs.length).toBe(2);
    expect(allocs.reduce((s, a) => s + a.amountCents, 0)).toBe(180000);
    const paymentLeaf = allocs.find((a) => a.paymentId === children[0] && a.cashEntryId == null);
    const surchargeLeaf = allocs.find((a) => a.cashEntryId != null);
    expect(paymentLeaf?.amountCents).toBe(100000);
    expect(paymentLeaf?.paymentBatchSplitId).toBeNull();
    expect(surchargeLeaf?.amountCents).toBe(80000);
    expect(surchargeLeaf?.cashEntryId).toBe(surchargeRows[0]!.id);
    expect(surchargeLeaf?.method).toBe("efectivo"); // heredado del método elegido para la cuota, no "lote"

    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, res.body.id)).all();
    expect(items.some((it: any) => it.source === "cash_entry" && it.sourceId === surchargeRows[0]!.id)).toBe(true);
    expect((await getCashEntry(surchargeRows[0]!.id))!.rendered).toBe(1);
    expect(batchId).toBeGreaterThan(0);
  });
});

describe("POST /api/remittances — lote con tolerancia de redondeo (payment_amount_adjustments), rendición total y parcial", () => {
  // La tolerancia de redondeo (ver payment-batches.test.ts, describes 79-83)
  // nunca toca payments.amount (nominal) ni payment_batch_splits/
  // received_checks (dinero real) — un batch resuelto con ajuste_redondeo
  // tiene EXACTAMENTE la misma forma que cualquier batch sin diferencia para
  // todo lo que Rendiciones lee. Estos tests confirman que no reintroduce el
  // bug de "batch_child_payment" (ver caja-summary-helpers.test.ts) ni ningún
  // aviso falso de inconsistencia.

  test("rendición TOTAL de un batch con ajuste de redondeo (faltante $2,34, caso real) — sin inconsistencias", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const p2 = await mkPolicy(companyId);
    const i2 = await mkInstallment(p2, 1, 752.66); // 1000 + 752.66 = 1752.66 (mismo patrón a menor escala que el caso real)

    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }, { installmentId: i2 }],
      splits: [{ method: "efectivo", amount: 1750.32 }], // aplicado=1752.66, real=1750.32 → faltante $2,34
      accountDifferenceResolution: { action: "ajuste_redondeo" },
      applyProntoPagoSurcharge: false,
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);
    expect(children.length).toBe(2);

    // Cada hijo se rinde por su propio importe NOMINAL real (payments.amount,
    // el instrumento de SALIDA elegido en la rendición — Migración 0029,
    // independiente del dinero real que entró en el cobro original) — nunca
    // se asume el orden de inserción de items[] al armar el body. El
    // paymentBreakdown debe sumar el NOMINAL rendido (1752.66), nunca el
    // real recibido en el cobro (1750.32, que es del cobro, no de esta rendición).
    const childPayments = await Promise.all(children.map((cid) => getPayment(cid)));
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1752.66 },
      items: children.map((cid, idx) => ({ source: "payment", sourceId: cid, amount: childPayments[idx]!.amount, paymentMethod: "efectivo" })),
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(2);
    // Los hijos se rinden por su importe NOMINAL — el ajuste de redondeo
    // nunca se propaga a la rendición (no es un instrumento ni una cuota).
    expect(allocs.reduce((s, a) => s + a.amountCents, 0)).toBe(175266);
    for (const cid of children) expect((await getPayment(cid))!.rendered).toBe(1);
  });

  test("rendición PARCIAL: se rinde solo un hijo del batch con ajuste de redondeo, el resto queda pendiente sin inconsistencia", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const p2 = await mkPolicy(companyId);
    const i2 = await mkInstallment(p2, 1, 752.66);

    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }, { installmentId: i2 }],
      splits: [{ method: "efectivo", amount: 1750.32 }],
      accountDifferenceResolution: { action: "ajuste_redondeo" },
      applyProntoPagoSurcharge: false,
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);
    const firstChildPayment = (await getPayment(children[0]!))!;

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: firstChildPayment.amount },
      items: [{ source: "payment", sourceId: children[0], amount: firstChildPayment.amount, paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(1);
    expect((await getPayment(children[0]!))!.rendered).toBe(1);
    expect((await getPayment(children[1]!))!.rendered).toBe(0); // sigue pendiente, sin tocar

    // El batch_child_payment del hijo rendido no debe marcarse como
    // "inconsistente" en la reconstrucción de Caja (mismo fix ya en
    // producción — ver caja-summary-helpers.test.ts, collectDistinctExpectedSources).
    const allocRow = allocs[0]!;
    expect(allocRow.paymentId).toBe(children[0]);
    expect(allocRow.paymentBatchId).toBe(batchId); // denormalizado, trazabilidad — nunca "batch completo"

    // Segunda rendición, del hijo restante — también limpia.
    const secondChildPayment = (await getPayment(children[1]!))!;
    const res2 = await callPostRemittance({
      date: "2027-06-02", canal: "directo", paymentBreakdown: { efectivo: secondChildPayment.amount },
      items: [{ source: "payment", sourceId: children[1], amount: secondChildPayment.amount, paymentMethod: "efectivo" }],
    });
    expect(res2.status).toBe(200);
    expect((await getPayment(children[1]!))!.rendered).toBe(1);
  });

  test("el ajuste de redondeo nunca aparece como item/allocation propio — solo los hijos reales", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);

    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }],
      splits: [{ method: "efectivo", amount: 1003 }], // sobrante $3
      accountDifferenceResolution: { action: "ajuste_redondeo" },
      applyProntoPagoSurcharge: false,
    });
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment", sourceId: children[0], amount: 1000, paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    // Exactamente 1 allocation (el hijo) — el ajuste de $3 nunca genera una
    // segunda allocation ni un remittance_item propio.
    expect(allocs.length).toBe(1);
    expect(allocs[0]!.amountCents).toBe(100000);

    const adjustments = await db.select().from(paymentAmountAdjustments).where(eq(paymentAmountAdjustments.paymentBatchId, batchId)).all();
    expect(adjustments.length).toBe(1); // sigue existiendo, pero fuera de remittance_allocations por completo
  });
});

describe("POST /api/remittances — cobro múltiple mixto (cuota existente + cobro manual), rendición por cuota", () => {
  test("los dos hijos (cuota + manual) se rinden juntos, cada uno con su propia allocation", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const p2 = await mkPolicy(companyId);

    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [
        { source: "installment", installmentId: i1 },
        { source: "policy_manual_payment", policyId: p2, amount: 500 },
      ],
      splits: [{ method: "transferencia", amount: 1500 }],
      applyProntoPagoSurcharge: false,
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;
    const childRows = await db.select().from(payments).where(eq(payments.batchId, batchId)).all();
    expect(childRows.length).toBe(2);

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { transferencia: 1500 },
      items: childRows.map((c) => ({ source: "payment", sourceId: c.id, amount: c.amount, paymentMethod: "transferencia" })),
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(2); // una por hijo, ninguna compartida
    expect(allocs.reduce((s, a) => s + a.amountCents, 0)).toBe(150000);
    for (const c of childRows) expect((await getPayment(c.id))!.rendered).toBe(1);

    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, res.body.id)).all();
    expect(items.length).toBe(2);
    expect(items.every((it: any) => it.debtorStatus === "pagado")).toBe(true);
  });

  test("se puede rendir SOLO el hijo con cuota, dejando pendiente el cobro manual del mismo batch (ya no 409)", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const p2 = await mkPolicy(companyId);

    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [
        { source: "installment", installmentId: i1 },
        { source: "policy_manual_payment", policyId: p2, amount: 500 },
      ],
      splits: [{ method: "efectivo", amount: 1500 }],
      applyProntoPagoSurcharge: false,
    });
    const batchId = created.body.id as number;
    const childRows = await db.select().from(payments).where(eq(payments.batchId, batchId)).all();
    const instChild = childRows.find((c) => c.installmentId === i1)!;
    const manualChild = childRows.find((c) => c.installmentId == null)!;

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment", sourceId: instChild.id, amount: 1000, paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(200);
    expect((await getPayment(instChild.id))!.rendered).toBe(1);
    expect((await getPayment(manualChild.id))!.rendered).toBe(0);
    void batchId;
  });

  test("se puede rendir SOLO el cobro manual, dejando pendiente el hijo con cuota del mismo batch (ya no 409)", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const p2 = await mkPolicy(companyId);

    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [
        { source: "installment", installmentId: i1 },
        { source: "policy_manual_payment", policyId: p2, amount: 500 },
      ],
      splits: [{ method: "efectivo", amount: 1500 }],
      applyProntoPagoSurcharge: false,
    });
    const batchId = created.body.id as number;
    const childRows = await db.select().from(payments).where(eq(payments.batchId, batchId)).all();
    const instChild = childRows.find((c) => c.installmentId === i1)!;
    const manualChild = childRows.find((c) => c.installmentId == null)!;

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 500 },
      items: [{ source: "payment", sourceId: manualChild.id, amount: 500, paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(200);
    expect((await getPayment(manualChild.id))!.rendered).toBe(1);
    expect((await getPayment(instChild.id))!.rendered).toBe(0);
    void batchId;
  });
});

describe("POST /api/remittances — imputación completamente manual (source=\"manual_payment\" libre)", () => {
  test("un batch 100% manual libre se rinde como dinero real, siempre pagado", async () => {
    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ source: "manual_payment", manualPayer: `${PREFIX} Cliente libre`, amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
      applyProntoPagoSurcharge: false,
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);
    expect(children.length).toBe(1);

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 500 },
      items: [{ source: "payment", sourceId: children[0], amount: 500, paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(1);
    expect(allocs[0]!.paymentBatchId).toBe(batchId);
    expect(allocs[0]!.amountCents).toBe(50000);
    expect((await getPayment(children[0]!))!.rendered).toBe(1);

    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, res.body.id)).all();
    expect(items[0]!.debtorStatus).toBe("pagado");
  });

  test("batch mixto (cuota + manual libre) se rinde junto, cada hijo con su propia allocation, ambos pagados", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 700);

    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [
        { source: "installment", installmentId: i1 },
        { source: "manual_payment", manualPayer: `${PREFIX} Cliente libre 2`, amount: 300 },
      ],
      splits: [{ method: "transferencia", amount: 1000 }],
      applyProntoPagoSurcharge: false,
    });
    const batchId = created.body.id as number;
    const childRows = await db.select().from(payments).where(eq(payments.batchId, batchId)).all();

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { transferencia: 1000 },
      items: childRows.map((c) => ({ source: "payment", sourceId: c.id, amount: c.amount, paymentMethod: "transferencia" })),
    });
    expect(res.status).toBe(200);
    for (const c of childRows) expect((await getPayment(c.id))!.rendered).toBe(1);
    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, res.body.id)).all();
    expect(items.every((it: any) => it.debtorStatus === "pagado")).toBe(true);
  });

  test("marcar el hijo manual libre como adeudado sigue rechazado (mismo guard que cualquier payment)", async () => {
    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ source: "manual_payment", manualPayer: `${PREFIX} Cliente libre 3`, amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
      applyProntoPagoSurcharge: false,
    });
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 500 },
      items: [{ source: "payment", sourceId: children[0], amount: 500, debtorStatus: "adeudado", paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Un cobro confirmado no puede registrarse como adeudado.");
  });
});

describe("POST /api/remittances — un cobro confirmado nunca puede rendirse como adeudado", () => {
  test("source='payment' standalone con debtorStatus='adeudado' → 400, nada se crea ni se marca rendido", async () => {
    const { paymentId } = await mkStandalonePayment({ amount: 400, splits: [{ method: "efectivo", amountCents: 40000 }] });
    const beforeCount = (await db.select().from(remittances).all()).length;
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 400 },
      items: [{ source: "payment", sourceId: paymentId, amount: 400, debtorStatus: "adeudado", paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Un cobro confirmado no puede registrarse como adeudado.");
    const afterCount = (await db.select().from(remittances).all()).length;
    expect(afterCount).toBe(beforeCount);
    expect((await getPayment(paymentId))!.rendered).toBe(0);
  });

  test("source='payment' hijo de batch (con cuota) con debtorStatus='adeudado' → 400", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }],
      splits: [{ method: "efectivo", amount: 1000 }],
      applyProntoPagoSurcharge: false,
    });
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment", sourceId: children[0], amount: 1000, debtorStatus: "adeudado", paymentMethod: "lote" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Un cobro confirmado no puede registrarse como adeudado.");
  });

  test("source='payment' hijo manual de batch (installmentId NULL) con debtorStatus='adeudado' → 400", async () => {
    const p1 = await mkPolicy(companyId);
    const created = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ source: "policy_manual_payment", policyId: p1, amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
      applyProntoPagoSurcharge: false,
    });
    const batchId = created.body.id as number;
    const children = await mkChildIds(batchId);

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 500 },
      items: [{ source: "payment", sourceId: children[0], amount: 500, debtorStatus: "adeudado", paymentMethod: "lote" }],
    });
    expect(res.status).toBe(400);
  });

  test("source='payment' sin debtorStatus (default 'pagado') sigue funcionando normalmente", async () => {
    const { paymentId } = await mkStandalonePayment({ amount: 250, splits: [{ method: "efectivo", amountCents: 25000 }] });
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 250 },
      items: [{ source: "payment", sourceId: paymentId, amount: 250, paymentMethod: "efectivo" }],
    });
    expect(res.status).toBe(200);
  });

  test("source='installment' con debtorStatus='adeudado' sigue permitido — es la vía real de deuda", async () => {
    const policyId = await mkPolicy(companyId);
    const instId = await mkInstallment(policyId, 1, 700);
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 700 },
      items: [{ source: "installment", sourceId: instId, amount: 700, debtorStatus: "adeudado" }],
    });
    expect(res.status).toBe(200);
    expect((await getInstallment(instId))!.rendered).toBe(1);
  });

  test("source='manual_debt' sigue permitido (deuda manual, sin instrumento real)", async () => {
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 900 },
      items: [{ source: "manual_debt", amount: 900, debtorStatus: "adeudado" }],
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/remittances/:id", () => {
  test("revierte rendered, borra allocations/items/remittance para un pago standalone", async () => {
    const { paymentId } = await mkStandalonePayment({ amount: 400, splits: [{ method: "efectivo", amountCents: 40000 }] });
    const created = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 400 },
      items: [{ source: "payment", sourceId: paymentId, amount: 400 }],
    });
    expect(created.status).toBe(200);
    const remId = created.body.id as number;

    const del = await callDeleteRemittance(remId);
    expect(del.status).toBe(200);

    expect((await getPayment(paymentId))!.rendered).toBe(0);
    expect((await getAllocations(remId)).length).toBe(0);
    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, remId)).all();
    expect(items.length).toBe(0);
    const rem = await db.select().from(remittances).where(eq(remittances.id, remId)).get();
    expect(rem).toBeUndefined();
  });

  test("para un batch rendido completo: revierte rendered de todos los hijos y borra las allocations, sin tocar payment_batch_splits/received_checks", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 1000);
    const p2 = await mkPolicy(companyId);
    const i2 = await mkInstallment(p2, 1, 1000);

    const createdBatch = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }, { installmentId: i2 }],
      splits: [{ method: "transferencia", amount: 2000 }],
      applyProntoPagoSurcharge: false,
    });
    const batchId = createdBatch.body.id as number;
    const children = await mkChildIds(batchId);

    const createdRem = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { transferencia: 2000 },
      items: children.map((cid) => ({ source: "payment", sourceId: cid, amount: 1000, paymentMethod: "transferencia" })),
    });
    expect(createdRem.status).toBe(200);
    const remId = createdRem.body.id as number;

    const splitsBefore = await db.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, batchId)).all();

    const del = await callDeleteRemittance(remId);
    expect(del.status).toBe(200);

    for (const cid of children) expect((await getPayment(cid))!.rendered).toBe(0);
    expect((await getAllocations(remId)).length).toBe(0);
    const splitsAfter = await db.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, batchId)).all();
    expect(splitsAfter.length).toBe(splitsBefore.length);
    const batchAfter = await db.select().from(paymentBatches).where(eq(paymentBatches.id, batchId)).get();
    expect(batchAfter).toBeDefined();
  });

  // Etapa "rendición por cuota" — mandatorio: borrar una rendición de un
  // hijo de batch NO debe afectar a otro hijo del MISMO batch rendido en
  // OTRA rendición separada (compañía distinta, por ejemplo).
  test("borrar la rendición de UN hijo de batch no afecta al hermano rendido en OTRA rendición distinta", async () => {
    const p1 = await mkPolicy(companyId);
    const i1 = await mkInstallment(p1, 1, 600);
    const p2 = await mkPolicy(rivadaviaCompanyId);
    const i2 = await mkInstallment(p2, 1, 400);

    const createdBatch = await callPostBatch({
      paymentDate: "2027-06-01", insuredId,
      items: [{ installmentId: i1 }, { installmentId: i2 }],
      splits: [{ method: "efectivo", amount: 1000 }],
      applyProntoPagoSurcharge: false,
    });
    const batchId = createdBatch.body.id as number;
    const children = await mkChildIds(batchId);
    const childA = children[0]!;
    const childB = children[1]!;

    const remA = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 600 },
      items: [{ source: "payment", sourceId: childA, amount: 600, paymentMethod: "efectivo" }],
    });
    expect(remA.status).toBe(200);
    const remB = await callPostRemittance({
      date: "2027-06-02", canal: "directo", paymentBreakdown: { efectivo: 400 },
      items: [{ source: "payment", sourceId: childB, amount: 400, paymentMethod: "efectivo" }],
    });
    expect(remB.status).toBe(200);
    expect((await getPayment(childA))!.rendered).toBe(1);
    expect((await getPayment(childB))!.rendered).toBe(1);

    const del = await callDeleteRemittance(remA.body.id);
    expect(del.status).toBe(200);

    // Solo el hijo A vuelve a estar pendiente — B sigue rendido, su
    // rendición y su allocation quedan intactas.
    expect((await getPayment(childA))!.rendered).toBe(0);
    expect((await getPayment(childB))!.rendered).toBe(1);
    expect((await getAllocations(remA.body.id)).length).toBe(0);
    const allocsB = await getAllocations(remB.body.id);
    expect(allocsB.length).toBe(1);
    expect(allocsB[0]!.paymentId).toBe(childB);
    const remBAfter = await db.select().from(remittances).where(eq(remittances.id, remB.body.id)).get();
    expect(remBAfter).toBeDefined();
  });

  test("devuelve 404 para una rendición inexistente", async () => {
    const del = await callDeleteRemittance(999999999);
    expect(del.status).toBe(404);
  });
});
