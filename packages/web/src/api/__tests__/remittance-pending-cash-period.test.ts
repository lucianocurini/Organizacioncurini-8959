/**
 * Cobro de contado por período en Rendiciones (Migración 0034):
 *   - GET /api/remittances/pending — un único ítem source="payment_batch" por
 *     contado, nunca sus cuotas hijas; contados anulados/rendidos no aparecen;
 *     inconsistencias visibles pero bloqueadas; pagos individuales y lotes
 *     normales sin cambios.
 *   - Recorrido completo: el ítem tal cual lo devuelve el listado se acepta en
 *     POST /api/remittances, rinde el grupo entero y DELETE lo revierte.
 *   - Integridad: contado como adeudado rechazado; PATCH
 *     /api/cash/payments/:id/render rechaza una cuota hija del contado.
 *   - Caja (GET /api/cash/summary): con y sin ajuste de redondeo, la rendición
 *     queda completa, lo pendiente baja exactamente el recibido real, lo
 *     rendido sube lo mismo y totalCobrado no cambia.
 *
 * Corre contra la SQLite de DATABASE_URL (nunca Turso) — fixtures aisladas
 * por prefijo, mismo patrón que cash-period-payments-endpoints.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments, rebillings,
  payments, paymentSplits, paymentBatches, paymentBatchSplits, receivedChecks,
  remittances, remittanceItems, remittanceAllocations, cashPeriodPayments,
  paymentAmountAdjustments, cashEntries,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-cash-period-remit-001";
const USER_EMAIL = "test-cash-period-remit@test.local";
const PREFIX = "TEST-CPREMIT";

let userId: number;
let companyId: number;
let insuredId: number;

const policyIdsToClean: number[] = [];
const batchIdsToClean: number[] = [];
const paymentIdsToClean: number[] = [];
const remittanceIdsToClean: number[] = [];

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function mkPolicy(): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: "activa", companyId, insuredId,
    startDate: "2027-01-01", endDate: "2027-12-31", isRebilling: 0, createdBy: userId,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}

async function mkInstallment(policyId: number, number: number, amount: number, rebillingId: number | null = null): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({
    policyId, number, dueDate: "2027-06-01", amount, status: "pendiente", rendered: 0, rebillingId,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

/** Póliza con 4 cuotas de $100.000 (nominal $400.000) y contado $380.000 cargado. */
async function mkCashReadyPolicy(): Promise<number> {
  const policyId = await mkPolicy();
  for (let i = 1; i <= 4; i++) await mkInstallment(policyId, i, 100000);
  const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify({ cashPaymentAmountCents: 38000000 }),
  }));
  expect(res.status).toBe(200);
  return policyId;
}

async function callCashPeriodPayment(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/payment-batches/cash-period-payment", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) batchIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function mkCashPayment(splits: any[], extra: Record<string, any> = {}): Promise<{ policyId: number; batchId: number }> {
  const policyId = await mkCashReadyPolicy();
  const created = await callCashPeriodPayment({ policyId, paymentDate: "2027-06-15", splits, ...extra });
  expect(created.status).toBe(201);
  return { policyId, batchId: created.body.id };
}

async function callPostNormalBatch(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) batchIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function callPostPayment(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/payments", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) paymentIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function callCancelBatch(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/payment-batches/${id}/cancel`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ confirm: true }),
  }));
  return { status: res.status, body: await res.json() };
}

async function callGetPending(): Promise<any[]> {
  const res = await app.fetch(new Request("http://localhost/api/remittances/pending", { headers: authHeaders() }));
  expect(res.status).toBe(200);
  return res.json();
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
  const res = await app.fetch(new Request(`http://localhost/api/remittances/${id}`, { method: "DELETE", headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

async function callPatchRender(paymentId: number, rendered: boolean) {
  const res = await app.fetch(new Request(`http://localhost/api/cash/payments/${paymentId}/render`, {
    method: "PATCH", headers: authHeaders(), body: JSON.stringify({ rendered }),
  }));
  return { status: res.status, body: await res.json() };
}

async function callGetCashSummary() {
  const res = await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }));
  expect(res.status).toBe(200);
  return res.json();
}

const getChildren = (batchId: number) => db.select().from(payments).where(eq(payments.batchId, batchId)).all();
const getCpp = (batchId: number) => db.select().from(cashPeriodPayments).where(eq(cashPeriodPayments.paymentBatchId, batchId)).get();

/** Ítem del listado para un batch, y las filas sueltas (source=payment) de sus hijos. */
function findCashItem(list: any[], batchId: number) {
  return {
    item: list.find((i) => i.source === "payment_batch" && i.sourceId === batchId),
    grouped: list.filter((i) => i.source === "payment_batch" && i.sourceId === batchId),
    loose: list.filter((i) => i.source === "payment" && i.batchId === batchId),
  };
}

/** Payload de POST /remittances armado EXACTAMENTE con el ítem del listado (lo que hace el modal). */
function remittanceBodyFor(item: any, breakdownKey = "efectivo") {
  return {
    date: "2027-06-20", canal: "directo", paymentBreakdown: { [breakdownKey]: item.amount },
    items: [{
      source: item.source, sourceId: item.sourceId, amount: item.amount, debtorStatus: "pagado",
      clientName: item.clientName, policyNumber: item.policyNumber, companyName: item.companyName,
      paymentMethod: item.paymentMethod,
    }],
  };
}

async function cleanupBatches(batchIds: number[]) {
  if (batchIds.length === 0) return;
  await db.delete(cashPeriodPayments).where(inArray(cashPeriodPayments.paymentBatchId, batchIds)).catch(() => {});
  const childRows = await db.select({ id: payments.id }).from(payments).where(inArray(payments.batchId, batchIds)).all();
  const childIds = childRows.map((r) => r.id);
  if (childIds.length) await db.delete(cashEntries).where(inArray(cashEntries.paymentId, childIds)).catch(() => {});
  if (childIds.length) await db.delete(payments).where(inArray(payments.id, childIds)).catch(() => {});
  const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).all();
  const splitIds = splitRows.map((s) => s.id);
  if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).catch(() => {});
  await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).catch(() => {});
  await db.delete(paymentAmountAdjustments).where(inArray(paymentAmountAdjustments.paymentBatchId, batchIds)).catch(() => {});
  await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIds)).catch(() => {});
}

async function cleanupStandalonePayments(paymentIds: number[]) {
  if (paymentIds.length === 0) return;
  const splitRows = await db.select({ id: paymentSplits.id }).from(paymentSplits).where(inArray(paymentSplits.paymentId, paymentIds)).all();
  const splitIds = splitRows.map((s) => s.id);
  if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.paymentSplitId, splitIds)).catch(() => {});
  await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, paymentIds)).catch(() => {});
  await db.delete(cashEntries).where(inArray(cashEntries.paymentId, paymentIds)).catch(() => {});
  await db.delete(payments).where(inArray(payments.id, paymentIds)).catch(() => {});
}

async function cleanupRemittances(remIds: number[]) {
  if (remIds.length === 0) return;
  await db.delete(remittanceAllocations).where(inArray(remittanceAllocations.remittanceId, remIds)).catch(() => {});
  await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remIds)).catch(() => {});
  await db.delete(remittances).where(inArray(remittances.id, remIds)).catch(() => {});
}

async function cleanupPolicies(polIds: number[]) {
  if (polIds.length === 0) return;
  await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, polIds)).catch(() => {});
  await db.delete(rebillings).where(inArray(rebillings.policyId, polIds)).catch(() => {});
  await db.delete(policies).where(inArray(policies.id, polIds)).catch(() => {});
}

beforeAll(async () => {
  // Restos de una corrida anterior interrumpida (mismo usuario de test).
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = (await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all()).map((p) => p.id);
    const prevPays = prevPols.length ? await db.select({ id: payments.id, batchId: payments.batchId }).from(payments).where(inArray(payments.policyId, prevPols)).all() : [];
    const prevBatchIds = [...new Set(prevPays.map((p) => p.batchId).filter((x): x is number => x != null))];
    const prevRemIds = (await db.select({ id: remittances.id }).from(remittances).where(eq(remittances.createdBy, prevUser.id)).all()).map((r) => r.id);
    await cleanupRemittances(prevRemIds);
    await cleanupBatches(prevBatchIds);
    await cleanupStandalonePayments(prevPays.filter((p) => p.batchId == null).map((p) => p.id));
    await cleanupPolicies(prevPols);
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Cash Period Remit", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(async () => {
  await cleanupRemittances(remittanceIdsToClean);
  await cleanupBatches(batchIdsToClean);
  await cleanupStandalonePayments(paymentIdsToClean);
  await cleanupPolicies(policyIdsToClean);
  await db.delete(insureds).where(eq(insureds.id, insuredId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.id, SESSION_ID)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

// ─── 1. GET /remittances/pending ───────────────────────────────────────────

describe("GET /remittances/pending — cobro de contado agrupado", () => {
  test("un solo ítem por contado, sin sus cuotas sueltas, con importe/período/nominal/descuento/cantidad correctos", async () => {
    const { policyId, batchId } = await mkCashPayment([{ method: "efectivo", amount: 380000 }]);
    const list = await callGetPending();
    const { item, grouped, loose } = findCashItem(list, batchId);

    expect(grouped).toHaveLength(1);
    expect(loose).toHaveLength(0);
    expect(list.some((i) => i.source === "payment" && i.policyNumber === item.policyNumber)).toBe(false);

    expect(item.sourceId).toBe(batchId);
    expect(item.paymentBatchId).toBe(batchId);
    expect(item.amount).toBe(380000); // total del contado, nunca el nominal
    expect(item.concept).toBe("Pago de contado");
    expect(item.isCashPeriodPayment).toBe(true);
    expect(item.paymentMethod).toBe("efectivo");
    expect(item.paymentGroup).toBe("own");
    expect(item.paymentDate).toBe("2027-06-15");
    expect(item.dueDate).toBeNull();
    expect(item.hasSurcharge).toBe(false);
    expect(item.clientName).toBe(`${PREFIX} Asegurado`);
    expect(item.companyName).toBe(`${PREFIX} Co`);
    expect(item.policyNumber).toContain(PREFIX);
    expect(item.blocked).toBe(false);
    expect(item.blockedCode).toBeNull();
    expect(item.blockedReason).toBeNull();
    expect(item.splits).toEqual([{ method: "efectivo", amountCents: 38000000, notes: null }]);
    expect(item.cashPeriodPayment).toMatchObject({
      policyId, rebillingId: null, periodStart: "2027-01-01", periodEnd: "2027-12-31",
      installmentCount: 4, nominalAmountCents: 40000000, discountAmountCents: 2000000,
      cashAmountCents: 38000000, receivedAmountCents: 38000000, hasChecks: false,
    });
  });

  test("período de refacturación: el período sale de la refacturación, no de la póliza", async () => {
    const policyId = await mkPolicy();
    const [reb] = await db.insert(rebillings).values({
      policyId, billingStart: "2027-01-01", billingEnd: "2027-06-30", createdBy: userId, cashPaymentAmountCents: 25000000,
    }).returning({ id: rebillings.id });
    for (let i = 1; i <= 3; i++) await mkInstallment(policyId, i, 90000, reb!.id);
    const created = await callCashPeriodPayment({
      policyId, rebillingId: reb!.id, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 250000 }],
    });
    expect(created.status).toBe(201);

    const { item, loose } = findCashItem(await callGetPending(), created.body.id);
    expect(loose).toHaveLength(0);
    expect(item.amount).toBe(250000);
    expect(item.cashPeriodPayment).toMatchObject({
      rebillingId: reb!.id, periodStart: "2027-01-01", periodEnd: "2027-06-30",
      installmentCount: 3, nominalAmountCents: 27000000, discountAmountCents: 2000000,
    });
  });

  test("transferencia a compañía queda en 'directo a compañía' y se ofrece igual para rendir", async () => {
    const { batchId } = await mkCashPayment([{ method: "transferencia_compania", amount: 380000 }]);
    const { item, loose } = findCashItem(await callGetPending(), batchId);
    expect(loose).toHaveLength(0);
    expect(item.paymentMethod).toBe("transferencia_compania");
    expect(item.paymentGroup).toBe("direct_company");
    expect(item.blocked).toBe(false);
  });

  test("transferencia propia queda en 'propios'", async () => {
    const { batchId } = await mkCashPayment([{ method: "transferencia", amount: 380000 }]);
    const { item } = findCashItem(await callGetPending(), batchId);
    expect(item.paymentMethod).toBe("transferencia");
    expect(item.paymentGroup).toBe("own");
  });

  test("medios combinados: 'combinado', con los dos splits reales", async () => {
    const { batchId } = await mkCashPayment([
      { method: "efectivo", amount: 180000 }, { method: "transferencia", amount: 200000 },
    ]);
    const { item } = findCashItem(await callGetPending(), batchId);
    expect(item.paymentMethod).toBe("combinado");
    expect(item.paymentGroup).toBe("own");
    expect(item.splits.map((s: any) => [s.method, s.amountCents])).toEqual([["efectivo", 18000000], ["transferencia", 20000000]]);
    expect(item.amount).toBe(380000);
  });

  test("cheque: medio cheque, grupo propios, hasChecks", async () => {
    const { batchId } = await mkCashPayment([{
      method: "cheque", amount: 380000,
      checks: [{ checkNumber: `${PREFIX}-CHK-${Date.now()}`, bankName: "Banco QA", dueDate: "2027-07-01", amount: 380000 }],
    }]);
    const { item } = findCashItem(await callGetPending(), batchId);
    expect(item.paymentMethod).toBe("cheque");
    expect(item.paymentGroup).toBe("own");
    expect(item.cashPeriodPayment.hasChecks).toBe(true);
    expect(item.blocked).toBe(false);
  });

  test("un contado ya rendido no aparece (ni agrupado ni por cuota)", async () => {
    const { batchId } = await mkCashPayment([{ method: "efectivo", amount: 380000 }]);
    const { item } = findCashItem(await callGetPending(), batchId);
    const rem = await callPostRemittance(remittanceBodyFor(item));
    expect(rem.status).toBe(200);
    const after = findCashItem(await callGetPending(), batchId);
    expect(after.grouped).toHaveLength(0);
    expect(after.loose).toHaveLength(0);
  });

  test("un contado anulado no aparece (ni agrupado ni por cuota)", async () => {
    const { batchId } = await mkCashPayment([{ method: "efectivo", amount: 380000 }]);
    expect((await callCancelBatch(batchId)).status).toBe(200);
    const { grouped, loose } = findCashItem(await callGetPending(), batchId);
    expect(grouped).toHaveLength(0);
    expect(loose).toHaveLength(0);
  });

  test("inconsistencia (una cuota hija marcada rendida suelta): visible, bloqueado, con código estable, sin cuotas sueltas", async () => {
    const { batchId } = await mkCashPayment([{ method: "efectivo", amount: 380000 }]);
    const children = await getChildren(batchId);
    // Simula un dato histórico desincronizado (ej. un PATCH suelto previo a esta corrección).
    await db.update(payments).set({ rendered: 1, renderedAt: new Date() }).where(eq(payments.id, children[0]!.id));

    const { item, grouped, loose } = findCashItem(await callGetPending(), batchId);
    expect(grouped).toHaveLength(1);
    expect(loose).toHaveLength(0);
    expect(item.blocked).toBe(true);
    expect(item.blockedCode).toBe("CASH_PERIOD_CHILDREN_PARTIALLY_RENDERED");
    expect(typeof item.blockedReason).toBe("string");
    expect(item.blockedReason.length).toBeGreaterThan(0);
  });

  test("inconsistencia (contado marcado rendido con cuotas sin rendir): visible y bloqueado", async () => {
    const { batchId } = await mkCashPayment([{ method: "efectivo", amount: 380000 }]);
    await db.update(cashPeriodPayments).set({ rendered: 1, renderedAt: new Date() }).where(eq(cashPeriodPayments.paymentBatchId, batchId));

    const { item, loose } = findCashItem(await callGetPending(), batchId);
    expect(loose).toHaveLength(0);
    expect(item.blocked).toBe(true);
    expect(item.blockedCode).toBe("CASH_PERIOD_STATE_MISMATCH");
  });

  test("pagos individuales y lotes normales no cambian: siguen por cuota, source='payment'", async () => {
    const policyId = await mkPolicy();
    const instStandalone = await mkInstallment(policyId, 1, 1000);
    const instBatchA = await mkInstallment(policyId, 2, 2000);
    const instBatchB = await mkInstallment(policyId, 3, 3000);

    const standalone = await callPostPayment({
      policyId, installmentId: instStandalone, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-06-15",
    });
    expect(standalone.status).toBe(201);
    const normal = await callPostNormalBatch({
      paymentDate: "2027-06-15",
      items: [{ source: "installment", installmentId: instBatchA }, { source: "installment", installmentId: instBatchB }],
      splits: [{ method: "efectivo", amount: 5000 }],
      applyProntoPagoSurcharge: false,
    });
    expect(normal.status).toBe(201);

    const list = await callGetPending();
    const standaloneRow = list.find((i) => i.source === "payment" && i.sourceId === standalone.body.id);
    expect(standaloneRow).toBeDefined();
    expect(standaloneRow.batchId).toBeNull();
    expect(standaloneRow.amount).toBe(1000);
    expect(standaloneRow.paymentGroup).toBe("own");
    expect(standaloneRow.blocked).toBeUndefined();

    const normalChildren = list.filter((i) => i.source === "payment" && i.batchId === normal.body.id);
    expect(normalChildren).toHaveLength(2);
    expect(normalChildren.map((i) => i.amount).sort()).toEqual([2000, 3000]);
    expect(list.some((i) => i.source === "payment_batch" && i.sourceId === normal.body.id)).toBe(false);
  });
});

// ─── 2. Recorrido completo ─────────────────────────────────────────────────

describe("Recorrido completo: listar → rendir → no se ofrece → revertir", () => {
  test("el ítem del listado se acepta tal cual, rinde el grupo entero y DELETE lo vuelve a ofrecer", async () => {
    const { batchId } = await mkCashPayment([{ method: "transferencia_compania", amount: 380000 }]);
    const { item } = findCashItem(await callGetPending(), batchId);

    const rem = await callPostRemittance(remittanceBodyFor(item, "transferencia"));
    expect(rem.status).toBe(200);

    // Contado y TODOS sus hijos rendidos.
    expect((await getCpp(batchId))!.rendered).toBe(1);
    const children = await getChildren(batchId);
    expect(children).toHaveLength(4);
    expect(children.every((c) => c.rendered === 1)).toBe(true);

    // remittance_items: un solo ítem, por el contado, con el medio REAL.
    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, rem.body.id)).all();
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe("payment_batch");
    expect(items[0]!.sourceId).toBe(batchId);
    expect(items[0]!.amount).toBe(380000);
    expect(items[0]!.debtorStatus).toBe("pagado");
    expect(items[0]!.paymentMethod).toBe("transferencia_compania");
    const allocs = await db.select().from(remittanceAllocations).where(eq(remittanceAllocations.remittanceId, rem.body.id)).all();
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.method).toBe("transferencia_compania");
    expect(allocs[0]!.amountCents).toBe(38000000);

    // Ya no se ofrece.
    const after = findCashItem(await callGetPending(), batchId);
    expect(after.grouped).toHaveLength(0);
    expect(after.loose).toHaveLength(0);

    // Segundo intento: rechazado.
    const again = await callPostRemittance(remittanceBodyFor(item, "transferencia"));
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("ya fue rendido");

    // Revertir: el grupo entero vuelve a pendiente y se ofrece de nuevo, una sola vez.
    expect((await callDeleteRemittance(rem.body.id)).status).toBe(200);
    expect((await getCpp(batchId))!.rendered).toBe(0);
    expect((await getChildren(batchId)).every((c) => c.rendered === 0)).toBe(true);
    const reoffered = findCashItem(await callGetPending(), batchId);
    expect(reoffered.grouped).toHaveLength(1);
    expect(reoffered.loose).toHaveLength(0);
    expect(reoffered.item.blocked).toBe(false);
  });

  test("una cuota hija suelta (source='payment') se rechaza aunque el contado no esté rendido", async () => {
    const { batchId } = await mkCashPayment([{ method: "efectivo", amount: 380000 }]);
    const child = (await getChildren(batchId))[0]!;
    const rem = await callPostRemittance({
      date: "2027-06-20", canal: "directo", paymentBreakdown: { efectivo: child.amount },
      items: [{ source: "payment", sourceId: child.id, amount: child.amount, debtorStatus: "pagado", paymentMethod: "efectivo" }],
    });
    expect(rem.status).toBe(409);
    expect(rem.body.error).toContain("cobro de período de contado");
    expect((await getCpp(batchId))!.rendered).toBe(0);
    expect((await getChildren(batchId)).every((c) => c.rendered === 0)).toBe(true);
  });
});

// ─── 3. Integridad ─────────────────────────────────────────────────────────

describe("Integridad — adeudado y PATCH suelto", () => {
  test("POST /remittances rechaza un contado enviado como adeudado, sin escribir nada", async () => {
    const { batchId } = await mkCashPayment([{ method: "efectivo", amount: 380000 }]);
    const { item } = findCashItem(await callGetPending(), batchId);
    const body = remittanceBodyFor(item);
    body.items[0]!.debtorStatus = "adeudado";
    const rem = await callPostRemittance(body);
    expect(rem.status).toBe(400);
    expect(rem.body.code).toBe("CASH_PERIOD_PAYMENT_CANNOT_BE_DEBT");
    expect((await getCpp(batchId))!.rendered).toBe(0);
    expect((await getChildren(batchId)).every((c) => c.rendered === 0)).toBe(true);
  });

  test("PATCH /cash/payments/:id/render rechaza una cuota hija del contado, en ambos sentidos", async () => {
    const { batchId } = await mkCashPayment([{ method: "efectivo", amount: 380000 }]);
    const child = (await getChildren(batchId))[0]!;

    const res = await callPatchRender(child.id, true);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CASH_PERIOD_CHILD_RENDER_FORBIDDEN");
    expect((await getChildren(batchId)).every((c) => c.rendered === 0)).toBe(true);

    const res2 = await callPatchRender(child.id, false);
    expect(res2.status).toBe(409);
  });

  test("PATCH /cash/payments/:id/render sigue admitiendo un pago normal, y 404 para uno inexistente", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, 1000);
    const pay = await callPostPayment({
      policyId, installmentId: instId, amount: 1000, paymentMethod: "transferencia_compania", paymentDate: "2027-06-15",
    });
    expect(pay.status).toBe(201);

    const on = await callPatchRender(pay.body.id, true);
    expect(on.status).toBe(200);
    expect(on.body.rendered).toBe(1);
    const off = await callPatchRender(pay.body.id, false);
    expect(off.status).toBe(200);
    expect(off.body.rendered).toBe(0);

    expect((await callPatchRender(999999999, true)).status).toBe(404);
  });
});

// ─── 4. Caja ───────────────────────────────────────────────────────────────

describe("Caja — rendir un contado nunca duplica ni pierde dinero", () => {
  function inconsistentIds(summary: any): number[] {
    return (summary.allocationsModel?.inconsistencias ?? []).map((i: any) => i.remittanceId);
  }

  /**
   * Ciclo completo sobre /cash/summary para un contado cobrado en efectivo por
   * `receivedPesos` (contado contractual $380.000): antes, rendido y revertido.
   */
  async function runOwnCashCycle(receivedPesos: number, extra: Record<string, any> = {}) {
    const before = await callGetCashSummary();
    const { batchId } = await mkCashPayment([{ method: "efectivo", amount: receivedPesos }], extra);
    const afterCobro = await callGetCashSummary();
    const { item } = findCashItem(await callGetPending(), batchId);
    expect(item.blocked).toBe(false);
    expect(item.amount).toBe(380000); // aplicado — lo que POST exige
    expect(item.cashPeriodPayment.receivedAmountCents).toBe(Math.round(receivedPesos * 100));

    const rem = await callPostRemittance(remittanceBodyFor(item));
    expect(rem.status).toBe(200);
    const afterRender = await callGetCashSummary();

    expect((await callDeleteRemittance(rem.body.id)).status).toBe(200);
    const afterRevert = await callGetCashSummary();
    return { before, afterCobro, afterRender, afterRevert, remittanceId: rem.body.id as number, batchId };
  }

  function assertCycle(r: Awaited<ReturnType<typeof runOwnCashCycle>>, receivedPesos: number) {
    // Cobro: lo pendiente (cajaNeta) sube exactamente el recibido real.
    expect(r.afterCobro.cajaNeta.total - r.before.cajaNeta.total).toBeCloseTo(receivedPesos, 2);
    const cobradoTrasCobro = r.afterCobro.totalCobrado - r.before.totalCobrado;

    // Rendición: lo pendiente baja exactamente el recibido real, lo rendido sube lo mismo.
    expect(r.afterCobro.cajaNeta.total - r.afterRender.cajaNeta.total).toBeCloseTo(receivedPesos, 2);
    expect(r.afterRender.rendidoPorMetodo.efectivo - r.afterCobro.rendidoPorMetodo.efectivo).toBeCloseTo(receivedPesos, 2);
    expect(r.afterRender.cartera.efectivo - r.before.cartera.efectivo).toBeCloseTo(0, 2);
    // La rendición queda completa (nunca "inconsistent") y totalCobrado no cambia.
    expect(inconsistentIds(r.afterRender)).not.toContain(r.remittanceId);
    expect(r.afterRender.allocationsModel.remittancesCompleteCount - r.afterCobro.allocationsModel.remittancesCompleteCount).toBe(1);
    expect(r.afterRender.totalCobrado - r.before.totalCobrado).toBeCloseTo(cobradoTrasCobro, 2);

    // Revertir: todo vuelve exactamente al estado posterior al cobro.
    expect(r.afterRevert.cajaNeta.total).toBeCloseTo(r.afterCobro.cajaNeta.total, 2);
    expect(r.afterRevert.rendidoPorMetodo.efectivo).toBeCloseTo(r.afterCobro.rendidoPorMetodo.efectivo, 2);
    expect(r.afterRevert.totalCobrado).toBeCloseTo(r.afterCobro.totalCobrado, 2);
  }

  test("contado exacto (sin redondeo)", async () => {
    const r = await runOwnCashCycle(380000);
    assertCycle(r, 380000);
    expect(r.afterCobro.totalCobrado - r.before.totalCobrado).toBeCloseTo(380000, 2);
  });

  test("contado con redondeo a favor (recibido $380.003 > contado $380.000): completa, sin duplicar el sobrante", async () => {
    const r = await runOwnCashCycle(380003, { accountDifferenceResolution: { action: "ajuste_redondeo" } });
    assertCycle(r, 380003);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, r.batchId)).get();
    expect(batch!.totalReceivedCents).toBe(38000000);
    expect(batch!.receivedAmountCents).toBe(38000300);
  });

  test("contado con redondeo en contra (recibido $379.996 < contado $380.000): completa, sin inflar Caja", async () => {
    const r = await runOwnCashCycle(379996, { accountDifferenceResolution: { action: "ajuste_redondeo" } });
    assertCycle(r, 379996);
  });

  test("contado directo a compañía: sale de pendiente directo y entra a rendido directo por el mismo importe", async () => {
    const before = await callGetCashSummary();
    const { batchId } = await mkCashPayment([{ method: "transferencia_compania", amount: 380000 }]);
    const afterCobro = await callGetCashSummary();
    expect(afterCobro.directoCompania.total - before.directoCompania.total).toBeCloseTo(380000, 2);
    expect(afterCobro.cajaNeta.total - before.cajaNeta.total).toBeCloseTo(0, 2); // nunca entra a la oficina

    const { item } = findCashItem(await callGetPending(), batchId);
    const rem = await callPostRemittance(remittanceBodyFor(item, "transferencia"));
    expect(rem.status).toBe(200);
    const afterRender = await callGetCashSummary();
    expect(afterRender.directoCompania.total - before.directoCompania.total).toBeCloseTo(0, 2);
    expect(afterRender.rendidoDirectoCompania.total - afterCobro.rendidoDirectoCompania.total).toBeCloseTo(380000, 2);
    expect(afterRender.rendidoPorMetodo.total - afterCobro.rendidoPorMetodo.total).toBeCloseTo(0, 2);
    expect(afterRender.totalCobrado).toBeCloseTo(afterCobro.totalCobrado, 2);
    expect(inconsistentIds(afterRender)).not.toContain(rem.body.id);
  });
});
