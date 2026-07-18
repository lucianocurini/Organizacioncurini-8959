/**
 * Tests de "adeudadas vinculadas a cuotas reales": el circuito completo
 * source="installment" en POST /remittances (rendir una cuota no cobrada
 * como adeudada, adelantando la plata a la compañía) + POST /remittances/
 * items/:id/collect (el asegurado paga después, se cierra la deuda con un
 * cobro real que nunca vuelve a rendirse). Corre exclusivamente contra
 * dev.db local (nunca Turso) — misma estrategia de fixtures aisladas por
 * prefijo que policy-cancellation.test.ts / caja-summary-endpoint.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments,
  payments, paymentSplits, remittances, remittanceItems, remittanceAllocations, cashDebts,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-installment-collect-001";
const USER_EMAIL = "test-installment-collect@test.local";
const PREFIX = "TEST-INST-COLLECT";

let userId: number;
let companyId: number;
let insuredId: number;
const policyIdsToClean: number[] = [];
const paymentIdsToClean: number[] = [];
const remittanceIdsToClean: number[] = [];
const cashDebtIdsToClean: number[] = [];

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

async function mkInstallment(policyId: number, number: number, dueDate: string, amount: number, opts: {
  status?: string; rendered?: number;
} = {}): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({
    policyId, number, dueDate, amount,
    status: opts.status ?? "pendiente",
    rendered: opts.rendered ?? 0,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

async function getInstallment(id: number) {
  return db.select().from(policyInstallments).where(eq(policyInstallments.id, id)).get();
}
async function getRemittanceItem(id: number) {
  return db.select().from(remittanceItems).where(eq(remittanceItems.id, id)).get();
}

async function callPostRemittance(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/remittances", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) remittanceIdsToClean.push(json.id);
  return { status: res.status, body: json };
}
async function callUncollected(query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  const res = await app.fetch(new Request(`http://localhost/api/remittances/uncollected${qs ? `?${qs}` : ""}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}
async function callCollect(itemId: number, body: Record<string, any> = {}) {
  const res = await app.fetch(new Request(`http://localhost/api/remittances/items/${itemId}/collect`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.payment?.id) paymentIdsToClean.push(json.payment.id);
  return { status: res.status, body: json };
}
async function callPatchPaid(itemId: number) {
  const res = await app.fetch(new Request(`http://localhost/api/remittances/items/${itemId}/paid`, {
    method: "PATCH", headers: authHeaders(),
  }));
  return { status: res.status, body: await res.json() };
}

// Rendición mínima "solo deuda" — un único ítem source="installment" que
// referencia una cuota real. paymentBreakdown vacío porque totalBase=amount
// de la cuota y totalPaid debe coincidir (±$1) — sin dinero real detrás, el
// breakdown declarado no importa para el cálculo de Caja (ver diagnóstico:
// solo se usa para rendiciones legacy sin allocations).
async function renderInstallmentAsDebt(installmentId: number, amount: number, opts: { paymentBreakdown?: Record<string, number> } = {}) {
  const breakdown = opts.paymentBreakdown ?? { efectivo: amount };
  return callPostRemittance({
    date: "2027-06-15", canal: "directo", paymentBreakdown: breakdown,
    items: [{ source: "installment", sourceId: installmentId, amount, debtorStatus: "adeudado", clientName: `${PREFIX} Deudor`, policyNumber: `${PREFIX}-POL`, companyName: `${PREFIX} Co` }],
  });
}

async function cleanupRemittance(id: number) {
  await db.delete(remittanceAllocations).where(eq(remittanceAllocations.remittanceId, id)).catch(() => {});
  await db.delete(remittanceItems).where(eq(remittanceItems.remittanceId, id)).catch(() => {});
  await db.delete(remittances).where(eq(remittances.id, id)).catch(() => {});
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevRems = await db.select({ id: remittances.id }).from(remittances).where(eq(remittances.createdBy, prevUser.id)).all();
    for (const r of prevRems) await cleanupRemittance(r.id);
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const ids = prevPols.map(p => p.id);
    if (ids.length) {
      const payRows = await db.select({ id: payments.id }).from(payments).where(inArray(payments.policyId, ids)).all();
      const payIds = payRows.map(r => r.id);
      // payment_splits/policy_installments referencian payments/policies con FK
      // real bajo @libsql/client (foreign_keys=ON) — hijos antes que padres.
      if (payIds.length) await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds)).catch(() => {});
      await db.delete(payments).where(inArray(payments.policyId, ids)).catch(() => {});
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, ids)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, ids)).catch(() => {});
    }
    await db.delete(cashDebts).where(eq(cashDebts.createdBy, prevUser.id)).catch(() => {});
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Installment Collect", email: USER_EMAIL, password: "hashed-dummy", role: "user", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(async () => {
  for (const id of remittanceIdsToClean) await cleanupRemittance(id);
  if (paymentIdsToClean.length) await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, paymentIdsToClean)).catch(() => {});
  if (paymentIdsToClean.length) await db.delete(payments).where(inArray(payments.id, paymentIdsToClean)).catch(() => {});
  for (const id of cashDebtIdsToClean) await db.delete(cashDebts).where(eq(cashDebts.id, id)).catch(() => {});
  if (policyIdsToClean.length) {
    const payRows = await db.select({ id: payments.id }).from(payments).where(inArray(payments.policyId, policyIdsToClean)).all();
    const payIds = payRows.map(r => r.id);
    if (payIds.length) await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds)).catch(() => {});
    await db.delete(payments).where(inArray(payments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  await db.delete(insureds).where(eq(insureds.id, insuredId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.id, SESSION_ID)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("POST /remittances — source=\"installment\" (adeudada vinculada a cuota real)", () => {
  test("1. rendir una cuota real como adeudada crea el remittance_item y la saca de /remittances/uncollected", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1200);

    const before = await callUncollected();
    expect(before.body.some((r: any) => r.id === instId)).toBe(true);

    const res = await renderInstallmentAsDebt(instId, 1200);
    expect(res.status).toBe(200);

    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, res.body.id)).all();
    expect(items.length).toBe(1);
    expect(items[0]!.source).toBe("installment");
    expect(items[0]!.sourceId).toBe(instId);
    expect(items[0]!.debtorStatus).toBe("adeudado");
    expect(items[0]!.paidAt).toBeNull();

    const inst = await getInstallment(instId);
    expect(inst!.rendered).toBe(1);
    expect(inst!.status).not.toBe("pagada"); // sigue sin cobrar del asegurado

    const after = await callUncollected();
    expect(after.body.some((r: any) => r.id === instId)).toBe(false);
  });

  test("2. no permite rendir dos veces la misma cuota real como adeudada", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 900);

    const first = await renderInstallmentAsDebt(instId, 900);
    expect(first.status).toBe(200);

    const second = await renderInstallmentAsDebt(instId, 900);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/ya fue rendida/i);
  });
});

describe("POST /remittances/items/:id/collect", () => {
  test("4/5/8/9. cobro real cierra la deuda de forma atómica: payment rendered=1, cuota pagada, ítem cerrado", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1500);
    const rem = await renderInstallmentAsDebt(instId, 1500);
    const itemId = (await db.select({ id: remittanceItems.id }).from(remittanceItems).where(eq(remittanceItems.remittanceId, rem.body.id)).get())!.id;

    const res = await callCollect(itemId, { paymentDate: "2027-07-01", paymentMethod: "efectivo" });
    expect(res.status).toBe(201);
    expect(res.body.payment.amount).toBeCloseTo(1500, 2);
    expect(res.body.payment.installmentId).toBe(instId);
    expect(res.body.payment.rendered).toBe(1); // 5. nace ya rendido
    expect(res.body.payment.renderedAt).not.toBeNull();
    expect(res.body.payment.status).toBe("confirmado");

    const inst = await getInstallment(instId); // 9.
    expect(inst!.status).toBe("pagada");

    const item = await getRemittanceItem(itemId); // 8.
    expect(item!.debtorStatus).toBe("pagado");
    expect(item!.paidAt).not.toBeNull();
  });

  test("10. segunda ejecución de collect sobre el mismo ítem falla", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 700);
    const rem = await renderInstallmentAsDebt(instId, 700);
    const itemId = (await db.select({ id: remittanceItems.id }).from(remittanceItems).where(eq(remittanceItems.remittanceId, rem.body.id)).get())!.id;

    const first = await callCollect(itemId, { paymentDate: "2027-07-01", paymentMethod: "transferencia" });
    expect(first.status).toBe(201);

    const second = await callCollect(itemId, { paymentDate: "2027-07-02", paymentMethod: "transferencia" });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/no está adeudado/i);
  });

  test("rechaza source distinto de \"installment\" (manual_debt)", async () => {
    const [rem] = await db.insert(remittances).values({
      date: "2027-06-15", canal: "directo", paymentBreakdown: "{}",
      totalAmount: 400, totalPaid: 0, status: "confirmada", createdBy: userId,
    }).returning({ id: remittances.id });
    remittanceIdsToClean.push(rem!.id);
    const [item] = await db.insert(remittanceItems).values({
      remittanceId: rem!.id, source: "manual_debt", sourceId: null, amount: 400, debtorStatus: "adeudado",
    }).returning({ id: remittanceItems.id });

    const res = await callCollect(item!.id, { paymentMethod: "efectivo" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no corresponde a una cuota real/i);
  });

  test("rechaza combinar medios propios con directo a compañía", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000);
    const rem = await renderInstallmentAsDebt(instId, 1000);
    const itemId = (await db.select({ id: remittanceItems.id }).from(remittanceItems).where(eq(remittanceItems.remittanceId, rem.body.id)).get())!.id;

    const res = await callCollect(itemId, {
      splits: [{ method: "efectivo", amount: 500 }, { method: "link_pago", amount: 500 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no se pueden combinar/i);
  });

  test("soporta desglose combinado (efectivo + transferencia)", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000);
    const rem = await renderInstallmentAsDebt(instId, 1000);
    const itemId = (await db.select({ id: remittanceItems.id }).from(remittanceItems).where(eq(remittanceItems.remittanceId, rem.body.id)).get())!.id;

    const res = await callCollect(itemId, {
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.payment.paymentMethod).toBe("combinado");
    expect(res.body.payment.splits.length).toBe(2);
  });

  test("no cambia registros de cash_debts legacy (12.)", async () => {
    const [debt] = await db.insert(cashDebts).values({
      clientName: `${PREFIX} Legacy intacto`, amount: 111, status: "pendiente", createdBy: userId, createdAt: new Date(),
    }).returning({ id: cashDebts.id });
    cashDebtIdsToClean.push(debt!.id);

    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 300);
    const rem = await renderInstallmentAsDebt(instId, 300);
    const itemId = (await db.select({ id: remittanceItems.id }).from(remittanceItems).where(eq(remittanceItems.remittanceId, rem.body.id)).get())!.id;
    await callCollect(itemId, { paymentMethod: "efectivo" });

    const stillThere = await db.select().from(cashDebts).where(eq(cashDebts.id, debt!.id)).get();
    expect(stillThere!.status).toBe("pendiente");
    expect(stillThere!.amount).toBeCloseTo(111, 2);
  });
});

describe("PATCH /remittances/items/:id/paid — regresión", () => {
  test("11. sigue funcionando para manual_debt", async () => {
    const [rem] = await db.insert(remittances).values({
      date: "2027-06-15", canal: "directo", paymentBreakdown: "{}",
      totalAmount: 250, totalPaid: 0, status: "confirmada", createdBy: userId,
    }).returning({ id: remittances.id });
    remittanceIdsToClean.push(rem!.id);
    const [item] = await db.insert(remittanceItems).values({
      remittanceId: rem!.id, source: "manual_debt", sourceId: null, amount: 250, debtorStatus: "adeudado",
    }).returning({ id: remittanceItems.id });

    const res = await callPatchPaid(item!.id);
    expect(res.status).toBe(200);
    const after = await getRemittanceItem(item!.id);
    expect(after!.debtorStatus).toBe("pagado");
    expect(after!.paidAt).not.toBeNull();
  });

  test("rechaza un ítem source=\"installment\" — debe usar /collect", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 500);
    const rem = await renderInstallmentAsDebt(instId, 500);
    const itemId = (await db.select({ id: remittanceItems.id }).from(remittanceItems).where(eq(remittanceItems.remittanceId, rem.body.id)).get())!.id;

    const res = await callPatchPaid(itemId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/collect/i);

    const item = await getRemittanceItem(itemId);
    expect(item!.debtorStatus).toBe("adeudado"); // no se tocó
  });
});
