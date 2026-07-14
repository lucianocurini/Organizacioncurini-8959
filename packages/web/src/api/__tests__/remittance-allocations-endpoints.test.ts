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
  cashEntries, remittances, remittanceItems, remittanceAllocations,
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

describe("POST /api/remittances — cobro múltiple (payment_batches)", () => {
  test("batch completo crea las allocations una sola vez, compartidas entre sus hijos", async () => {
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
      items: children.map((cid) => ({ source: "payment", sourceId: cid, amount: 1000, paymentMethod: "lote" })),
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(1); // un solo split no-cheque
    expect(allocs[0]!.paymentBatchId).toBe(batchId);
    expect(allocs[0]!.remittanceItemId).toBeNull();
    expect(allocs[0]!.amountCents).toBe(200000);
    for (const cid of children) expect((await getPayment(cid))!.rendered).toBe(1);
  });

  test("batch parcial devuelve 409 y no modifica nada", async () => {
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

    const beforeCount = (await db.select().from(remittances).all()).length;
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment", sourceId: children[0], amount: 1000, paymentMethod: "lote" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/rendirse completo/);
    const afterCount = (await db.select().from(remittances).all()).length;
    expect(afterCount).toBe(beforeCount);
    for (const cid of children) expect((await getPayment(cid))!.rendered).toBe(0);
  });

  test("split cheque de batch crea una allocation por cada received_check", async () => {
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

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { cheque: 1500 },
      items: children.map((cid) => ({ source: "payment", sourceId: cid, amount: 1500, paymentMethod: "lote" })),
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(2);
    expect(allocs.every((a) => a.receivedCheckId != null)).toBe(true);
    expect(new Set(allocs.map((a) => a.receivedCheckId)).size).toBe(2);
    expect(allocs.reduce((s, a) => s + a.amountCents, 0)).toBe(150000);
  });

  test("batch con recargo Pronto Pago no duplica la allocation del cash_entry", async () => {
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
      items: [{ source: "payment", sourceId: children[0], amount: 1000, paymentMethod: "lote" }],
    });
    expect(res.status).toBe(200);

    const allocs = await getAllocations(res.body.id);
    // Solo la allocation del batch split (1800 en un solo split efectivo) —
    // NINGUNA allocation aparte para el cash_entry del recargo.
    expect(allocs.length).toBe(1);
    expect(allocs[0]!.paymentBatchId).toBe(batchId);
    expect(allocs[0]!.amountCents).toBe(180000);
    expect(allocs.some((a) => a.cashEntryId != null)).toBe(false);

    const allocsByCashEntry = await db.select().from(remittanceAllocations)
      .where(eq(remittanceAllocations.cashEntryId, surchargeRows[0]!.id)).all();
    expect(allocsByCashEntry.length).toBe(0);

    // El remittance_item del recargo se creó igual (comportamiento sin cambios)
    // y el cash_entry quedó marcado rendered, aunque sin allocation propia.
    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, res.body.id)).all();
    expect(items.some((it: any) => it.source === "cash_entry" && it.sourceId === surchargeRows[0]!.id)).toBe(true);
    expect((await getCashEntry(surchargeRows[0]!.id))!.rendered).toBe(1);
  });
});

describe("POST /api/remittances — cobro múltiple mixto (cuota existente + cobro manual)", () => {
  test("batch mixto completo crea las allocations una sola vez; ambos hijos quedan rendered; ningún remittance_item queda adeudado", async () => {
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
      items: childRows.map((c) => ({ source: "payment", sourceId: c.id, amount: c.amount, paymentMethod: "lote" })),
    });
    expect(res.status).toBe(200);
    const allocs = await getAllocations(res.body.id);
    expect(allocs.length).toBe(1); // un solo split, compartido por ambos hijos (cuota + manual)
    expect(allocs[0]!.paymentBatchId).toBe(batchId);
    expect(allocs[0]!.amountCents).toBe(150000);
    for (const c of childRows) expect((await getPayment(c.id))!.rendered).toBe(1);

    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, res.body.id)).all();
    expect(items.length).toBe(2);
    expect(items.every((it: any) => it.debtorStatus === "pagado")).toBe(true);
  });

  test("batch mixto parcial — falta el hijo manual → 409, nada se modifica", async () => {
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

    const beforeCount = (await db.select().from(remittances).all()).length;
    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment", sourceId: instChild.id, amount: 1000, paymentMethod: "lote" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/rendirse completo/);
    const afterCount = (await db.select().from(remittances).all()).length;
    expect(afterCount).toBe(beforeCount);
    for (const c of childRows) expect((await getPayment(c.id))!.rendered).toBe(0);
  });

  test("batch mixto parcial — falta el hijo con cuota → 409, nada se modifica", async () => {
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
    const manualChild = childRows.find((c) => c.installmentId == null)!;

    const res = await callPostRemittance({
      date: "2027-06-01", canal: "directo", paymentBreakdown: { efectivo: 500 },
      items: [{ source: "payment", sourceId: manualChild.id, amount: 500, paymentMethod: "lote" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/rendirse completo/);
    for (const c of childRows) expect((await getPayment(c.id))!.rendered).toBe(0);
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
      items: [{ source: "payment", sourceId: children[0], amount: 500, paymentMethod: "lote" }],
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

  test("batch mixto (cuota + manual libre) se rinde completo, ambos pagados", async () => {
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
      items: childRows.map((c) => ({ source: "payment", sourceId: c.id, amount: c.amount, paymentMethod: "lote" })),
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
      items: [{ source: "payment", sourceId: children[0], amount: 500, debtorStatus: "adeudado", paymentMethod: "lote" }],
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

  test("para un batch: revierte rendered de todos los hijos y borra las allocations, sin tocar payment_batch_splits/received_checks", async () => {
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
      items: children.map((cid) => ({ source: "payment", sourceId: cid, amount: 1000, paymentMethod: "lote" })),
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

  test("devuelve 404 para una rendición inexistente", async () => {
    const del = await callDeleteRemittance(999999999);
    expect(del.status).toBe(404);
  });
});
