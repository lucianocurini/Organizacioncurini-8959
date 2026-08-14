/**
 * Tests de "Pago de contado por período de facturación" (Migración 0034)
 * sobre los endpoints reales:
 *   - PUT /api/policies/:id, POST/PUT /api/rebillings — carga y bloqueo de
 *     edición del importe contado.
 *   - POST /api/payment-batches/cash-period-payment — el cobro en sí.
 *   - GET /api/cash-period-payments/:batchId — detalle/comprobante.
 *   - POST /api/payment-batches/:id/cancel — anulación y reversión completa.
 *   - POST/DELETE /api/remittances — rendición como instrumento único.
 *   - GET /api/cash/summary — Caja solo suma el contado real.
 *
 * Corre exclusivamente contra dev.db local (nunca Turso) — misma estrategia
 * de fixtures aisladas por prefijo que payment-batches.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments, rebillings,
  payments, paymentBatches, paymentBatchSplits, receivedChecks,
  remittances, remittanceItems, remittanceAllocations, cashPeriodPayments,
  paymentAmountAdjustments, insuredAccountMovements,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-cash-period-001";
const USER_EMAIL = "test-cash-period@test.local";
const PREFIX = "TEST-CASHPERIOD";

let userId: number;
let companyId: number;
let insuredId: number;

const policyIdsToClean: number[] = [];
const batchIdsToClean: number[] = [];
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

/** Período de emisión (rebillingId null) con 4 cuotas de `amount` c/u. */
async function mkFourInstallmentPeriod(policyId: number, amount = 100000): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 1; i <= 4; i++) ids.push(await mkInstallment(policyId, i, amount));
  return ids;
}

async function setPolicyCashAmount(policyId: number, cents: number | null) {
  const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify({ cashPaymentAmountCents: cents }),
  }));
  return { status: res.status, body: await res.json() };
}

async function callCashPeriodPayment(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/payment-batches/cash-period-payment", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) batchIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function callGetCashPeriodPayment(batchId: number) {
  const res = await app.fetch(new Request(`http://localhost/api/cash-period-payments/${batchId}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

async function callGetPayments(query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  const res = await app.fetch(new Request(`http://localhost/api/payments${qs ? `?${qs}` : ""}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() as any[] };
}

async function callGetPaymentsStats() {
  const res = await app.fetch(new Request("http://localhost/api/payments/stats", { headers: authHeaders() }));
  return res.json();
}

async function callCancelBatch(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/payment-batches/${id}/cancel`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ confirm: true }),
  }));
  return { status: res.status, body: await res.json() };
}

async function callCancelCheck(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/payment-batches/${id}/cancel-check`, { headers: authHeaders() }));
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
  const res = await app.fetch(new Request(`http://localhost/api/remittances/${id}`, { method: "DELETE", headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

async function callGetRemittanceItems(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/remittances/${id}/items`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

async function callGetCashSummary() {
  const res = await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }));
  return res.json();
}

async function callGetCashSummaryPeriod(from: string, to: string) {
  const res = await app.fetch(new Request(`http://localhost/api/cash/summary?from=${from}&to=${to}`, { headers: authHeaders() }));
  return res.json();
}

async function getInstallments(policyId: number) {
  return db.select().from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();
}

async function getChildren(batchId: number) {
  return db.select().from(payments).where(eq(payments.batchId, batchId)).all();
}

async function getCashPeriodPaymentRow(batchId: number) {
  return db.select().from(cashPeriodPayments).where(eq(cashPeriodPayments.paymentBatchId, batchId)).get();
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const polIds = prevPols.map((p) => p.id);
    const instRows = polIds.length ? await db.select({ id: policyInstallments.id }).from(policyInstallments).where(inArray(policyInstallments.policyId, polIds)).all() : [];
    const instIds = instRows.map((r) => r.id);
    const payRows = instIds.length ? await db.select({ id: payments.id, batchId: payments.batchId }).from(payments).where(inArray(payments.installmentId, instIds)).all() : [];
    const payIds = payRows.map((r) => r.id);
    const batchIds = [...new Set(payRows.map((r: any) => r.batchId).filter((x: any) => x != null))] as number[];
    const remRows = await db.select({ id: remittances.id }).from(remittances).where(eq(remittances.createdBy, prevUser.id)).all();
    const remIds = remRows.map((r) => r.id);
    if (remIds.length) await db.delete(remittanceAllocations).where(inArray(remittanceAllocations.remittanceId, remIds)).catch(() => {});
    if (remIds.length) await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remIds)).catch(() => {});
    if (remIds.length) await db.delete(remittances).where(inArray(remittances.id, remIds)).catch(() => {});
    if (batchIds.length) await db.delete(cashPeriodPayments).where(inArray(cashPeriodPayments.paymentBatchId, batchIds)).catch(() => {});
    if (payIds.length) await db.delete(payments).where(inArray(payments.id, payIds)).catch(() => {});
    if (batchIds.length) {
      const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).all();
      const splitIds = splitRows.map((s) => s.id);
      if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).catch(() => {});
      await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).catch(() => {});
      // Tolerancia de redondeo (ronda 2): un ajuste deja una fila en
      // payment_amount_adjustments con paymentBatchId=batchId — con
      // foreign_keys=ON, el DELETE de payment_batches revienta si esto no se
      // borra primero (no-op para batches sin ajuste, la mayoría). Sin este
      // paso, un fallo SILENCIOSO acá dejaba huérfano el batch, y en cascada
      // insureds/users, rompiendo la corrida siguiente con UNIQUE constraint
      // en users.email — bug real encontrado durante esta sesión.
      await db.delete(paymentAmountAdjustments).where(inArray(paymentAmountAdjustments.paymentBatchId, batchIds)).catch(() => {});
      await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIds)).catch(() => {});
    }
    if (instIds.length) await db.delete(policyInstallments).where(inArray(policyInstallments.id, instIds)).catch(() => {});
    if (polIds.length) await db.delete(rebillings).where(inArray(rebillings.policyId, polIds)).catch(() => {});
    if (polIds.length) await db.delete(policies).where(inArray(policies.id, polIds)).catch(() => {});
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Cash Period", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(async () => {
  if (remittanceIdsToClean.length) {
    await db.delete(remittanceAllocations).where(inArray(remittanceAllocations.remittanceId, remittanceIdsToClean)).catch(() => {});
    await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remittanceIdsToClean)).catch(() => {});
    await db.delete(remittances).where(inArray(remittances.id, remittanceIdsToClean)).catch(() => {});
  }
  if (batchIdsToClean.length) {
    await db.delete(cashPeriodPayments).where(inArray(cashPeriodPayments.paymentBatchId, batchIdsToClean)).catch(() => {});
    const childRows = await db.select({ id: payments.id }).from(payments).where(inArray(payments.batchId, batchIdsToClean)).all();
    const childIds = childRows.map((r) => r.id);
    if (childIds.length) await db.delete(payments).where(inArray(payments.id, childIds)).catch(() => {});
    const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsToClean)).all();
    const splitIds = splitRows.map((s) => s.id);
    if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).catch(() => {});
    await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsToClean)).catch(() => {});
    // Tolerancia de redondeo (ronda 2): ver comentario equivalente en
    // beforeAll — sin este paso, un ajuste huérfano bloquea el DELETE de
    // paymentBatches (foreign_keys=ON) y en cascada insureds/users.
    await db.delete(paymentAmountAdjustments).where(inArray(paymentAmountAdjustments.paymentBatchId, batchIdsToClean)).catch(() => {});
    await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIdsToClean)).catch(() => {});
  }
  if (policyIdsToClean.length) {
    // policyInstallments antes que rebillings (installments.rebillingId ->
    // rebillings.id), y rebillings antes que policies (rebillings.policyId
    // -> policies.id) — @libsql/client enforce foreign_keys=ON, así que el
    // orden importa de verdad acá (a diferencia de un catch silencioso que
    // esconda el problema, ver bug real encontrado durante esta sesión: sin
    // este orden, rebillings/users quedaban huérfanos entre corridas).
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(rebillings).where(inArray(rebillings.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  await db.delete(insureds).where(eq(insureds.id, insuredId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.id, SESSION_ID)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

// ─── Carga y bloqueo de edición (Reglas 2/3/4) ─────────────────────────────

describe("PUT /policies/:id — importe contado", () => {
  test("acepta y persiste un importe contado válido (con cuotas ya generadas)", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // nominal 400000 — sin cuotas, PUT directo rechaza (ver "seguridad alta de póliza")
    const res = await setPolicyCashAmount(policyId, 38000000);
    expect(res.status).toBe(200);
    expect(res.body.cashPaymentAmountCents).toBe(38000000);
  });

  test("acepta null (opcional) — antes y después de tener cuotas", async () => {
    const policyId = await mkPolicy();
    // Sin cuotas: retirar (null) sigue permitido, no hay nada que validar.
    const resNullSinCuotas = await setPolicyCashAmount(policyId, null);
    expect(resNullSinCuotas.status).toBe(200);
    expect(resNullSinCuotas.body.cashPaymentAmountCents).toBeNull();

    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    const res = await setPolicyCashAmount(policyId, null);
    expect(res.status).toBe(200);
    expect(res.body.cashPaymentAmountCents).toBeNull();
  });

  test("rechaza cero o negativo (la validación de forma corre antes que el chequeo de cuotas)", async () => {
    const policyId = await mkPolicy();
    expect((await setPolicyCashAmount(policyId, 0)).status).toBe(400);
    expect((await setPolicyCashAmount(policyId, -100)).status).toBe(400);
  });

  test("PUT directo sin cuotas: rechaza un valor no nulo (debe cargarse vía installments/generate)", async () => {
    const policyId = await mkPolicy(); // sin cuotas
    const res = await setPolicyCashAmount(policyId, 38000000);
    expect(res.status).toBe(409);
  });

  test("rechaza un importe mayor a la suma nominal ya generada", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // nominal = 400000
    const res = await setPolicyCashAmount(policyId, 40000001);
    expect(res.status).toBe(400);
  });

  test("permite un importe igual al nominal (descuento $0)", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    const res = await setPolicyCashAmount(policyId, 40000000);
    expect(res.status).toBe(200);
  });

  test("bloquea modificar el importe contado si alguna cuota del período ya tiene un pago confirmado", async () => {
    const policyId = await mkPolicy();
    const [instId] = await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    await db.insert(payments).values({ policyId, installmentId: instId, amount: 100000, paymentMethod: "efectivo", paymentDate: "2027-06-01", status: "confirmado", createdBy: userId });

    const res = await setPolicyCashAmount(policyId, 39000000);
    expect(res.status).toBe(409);
    // tampoco se puede "retirar" (volver a null)
    const res2 = await setPolicyCashAmount(policyId, null);
    expect(res2.status).toBe(409);
  });
});

// ─── Regresión: reenviar/omitir la clave nunca bloquea otros campos ───────
//
// Regla 4: el gating por actividad debe aplicar EXCLUSIVAMENTE a un cambio
// real de cashPaymentAmountCents — reenviar el mismo valor, u omitir la
// clave del todo, tiene que seguir permitiendo editar cualquier otro dato de
// la póliza (aunque el período ya tenga actividad real).
describe("PUT /policies/:id — importe contado con actividad: no bloquear lo que no cambia", () => {
  async function callPutPolicy(policyId: number, body: Record<string, any>) {
    const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}`, {
      method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  }

  test("actividad por PAGO confirmado: reenviar el MISMO valor no bloquea editar otro campo (notes)", async () => {
    const policyId = await mkPolicy();
    const [instId] = await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    await db.insert(payments).values({ policyId, installmentId: instId, amount: 100000, paymentMethod: "efectivo", paymentDate: "2027-06-01", status: "confirmado", createdBy: userId });

    const res = await callPutPolicy(policyId, { cashPaymentAmountCents: 38000000, notes: `${PREFIX} nota actualizada` });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe(`${PREFIX} nota actualizada`);
    expect(res.body.cashPaymentAmountCents).toBe(38000000);
  });

  test("actividad por PAGO confirmado: omitir la clave no la modifica ni bloquea el resto de la edición", async () => {
    const policyId = await mkPolicy();
    const [instId] = await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    await db.insert(payments).values({ policyId, installmentId: instId, amount: 100000, paymentMethod: "efectivo", paymentDate: "2027-06-01", status: "confirmado", createdBy: userId });

    const res = await callPutPolicy(policyId, { notes: `${PREFIX} otra nota` }); // sin cashPaymentAmountCents
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe(`${PREFIX} otra nota`);
    expect(res.body.cashPaymentAmountCents).toBe(38000000); // intacto

    const check = await db.select({ cashPaymentAmountCents: policies.cashPaymentAmountCents }).from(policies).where(eq(policies.id, policyId)).get();
    expect(check!.cashPaymentAmountCents).toBe(38000000);
  });

  test("actividad por IMPUTACIÓN directa (remittance_items source=installment, sin payment) bloquea cambiar el valor", async () => {
    const policyId = await mkPolicy();
    const [instId] = await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);

    const [rem] = await db.insert(remittances).values({
      date: "2027-06-01", canal: "directo", paymentBreakdown: "{}", totalAmount: 100000, totalPaid: 0, status: "confirmada", createdBy: userId,
    }).returning({ id: remittances.id });
    remittanceIdsToClean.push(rem!.id);
    await db.insert(remittanceItems).values({
      remittanceId: rem!.id, source: "installment", sourceId: instId, amount: 100000, debtorStatus: "adeudado",
    });

    const res = await setPolicyCashAmount(policyId, 39000000);
    expect(res.status).toBe(409);
  });

  test("actividad por RENDICIÓN (installment.rendered=1) bloquea cambiar el valor", async () => {
    const policyId = await mkPolicy();
    const [instId] = await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    await db.update(policyInstallments).set({ rendered: 1 }).where(eq(policyInstallments.id, instId));

    const res = await setPolicyCashAmount(policyId, 39000000);
    expect(res.status).toBe(409);
  });

  test("actividad bloquea pasar de null a un valor (agregar contado a un período que ya tiene actividad)", async () => {
    const policyId = await mkPolicy();
    const [instId] = await mkFourInstallmentPeriod(policyId, 100000);
    await db.insert(payments).values({ policyId, installmentId: instId, amount: 100000, paymentMethod: "efectivo", paymentDate: "2027-06-01", status: "confirmado", createdBy: userId });

    const res = await setPolicyCashAmount(policyId, 38000000); // nunca tuvo contado cargado (null -> valor)
    expect(res.status).toBe(409);
  });

  test("sin actividad: todas las transiciones son libres (null→valor, valor→valor distinto, valor→null)", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // sin actividad

    const toValue = await setPolicyCashAmount(policyId, 38000000);
    expect(toValue.status).toBe(200);

    const toOther = await setPolicyCashAmount(policyId, 35000000);
    expect(toOther.status).toBe(200);

    const toNull = await setPolicyCashAmount(policyId, null);
    expect(toNull.status).toBe(200);
    expect(toNull.body.cashPaymentAmountCents).toBeNull();
  });
});

// ─── El cobro en sí (Reglas 5/6/7/9) ────────────────────────────────────────

describe("POST /payment-batches/cash-period-payment", () => {
  test("contado menor al nominal: cancela las 4 cuotas, registra el descuento, Caja suma solo el contado", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // nominal 400000
    await setPolicyCashAmount(policyId, 380000 * 100);

    const PAYMENT_DATE = "2027-06-15";
    const beforePeriod = await callGetCashSummaryPeriod(PAYMENT_DATE, PAYMENT_DATE);

    const res = await callCashPeriodPayment({
      policyId, rebillingId: null, paymentDate: PAYMENT_DATE,
      splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.nominalAmountCents).toBe(40000000);
    expect(res.body.cashAmountCents).toBe(38000000);
    expect(res.body.discountAmountCents).toBe(2000000);
    expect(res.body.commissionBaseAmountCents).toBe(38000000);

    const installments = await getInstallments(policyId);
    expect(installments.every((i) => i.status === "pagada")).toBe(true);

    const children = await getChildren(res.body.id);
    expect(children.length).toBe(4);
    expect(children.every((c) => c.amount === 100000)).toBe(true); // nominal por cuota, sin prorratear el descuento
    expect(children.every((c) => c.status === "confirmado")).toBe(true);

    const cpp = await getCashPeriodPaymentRow(res.body.id);
    expect(cpp!.nominalAmountCents).toBe(40000000);
    expect(cpp!.cashAmountCents).toBe(38000000);
    expect(cpp!.discountAmountCents).toBe(2000000);
    expect(cpp!.status).toBe("confirmado");

    const summary = await callGetCashSummary();
    expect(summary.cartera.efectivo).toBeGreaterThanOrEqual(380000);
    // nunca la suma nominal (400000) filtrándose a cartera por este cobro

    // Regresión: el subtotal informativo del período (periodo.cobrado) tenía
    // el mismo problema — sumaba el importe NOMINAL de los 4 hijos ($400.000)
    // en vez del importe contado real recibido ($380.000). Nunca debe
    // acercarse a $400.000.
    const afterPeriod = await callGetCashSummaryPeriod(PAYMENT_DATE, PAYMENT_DATE);
    expect(afterPeriod.periodo.cobrado - beforePeriod.periodo.cobrado).toBeCloseTo(380000, 2);
    expect(afterPeriod.periodo.cobrado - beforePeriod.periodo.cobrado).not.toBeCloseTo(400000, 2);
  });

  test("contado igual al nominal: descuento $0, sigue funcionando", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 40000000);

    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "transferencia", amount: 400000 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.discountAmountCents).toBe(0);
  });

  test("rechaza si el período no tiene importe contado cargado", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(res.status).toBe(400);
  });

  test("rechaza si el importe contado cargado quedó por encima del nominal actual (drift post-carga)", async () => {
    const policyId = await mkPolicy();
    const ids = await mkFourInstallmentPeriod(policyId, 100000); // nominal 400000
    await setPolicyCashAmount(policyId, 380000 * 100);
    // Simula que el plan se achicó después de cargado el contado (ej. una
    // corrección de cuotas) sin volver a validar — el endpoint de cobro debe
    // revalidar igual, nunca confiar en que sigue siendo válido.
    await db.update(policyInstallments).set({ amount: 50000 }).where(eq(policyInstallments.id, ids[0]!));

    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(res.status).toBe(400);
  });

  test("todo o nada: bloquea el período completo si UNA cuota ya está pagada", async () => {
    const policyId = await mkPolicy();
    const ids = await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    await db.insert(payments).values({ policyId, installmentId: ids[2]!, amount: 100000, paymentMethod: "efectivo", paymentDate: "2027-06-01", status: "confirmado", createdBy: userId });
    await db.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, ids[2]!));

    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.blockingInstallmentIds).toEqual(expect.arrayContaining(ids));

    // Ninguna cuota quedó pagada por este intento fallido — todo o nada real.
    const installments = await getInstallments(policyId);
    expect(installments.filter((i) => i.status === "pagada").length).toBe(1); // solo la que ya estaba
  });

  test("bloquea si una cuota ya fue rendida", async () => {
    const policyId = await mkPolicy();
    const ids = await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    await db.update(policyInstallments).set({ rendered: 1 }).where(eq(policyInstallments.id, ids[0]!));

    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(res.status).toBe(409);
  });

  test("rechaza si los medios no suman exactamente el importe contado (de menos)", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 379999 }],
    });
    expect(res.status).toBe(400);
  });

  test("rechaza si los medios suman de más — la diferencia nunca absorbe el descuento", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380001 }],
    });
    expect(res.status).toBe(400);
  });

  test("medios combinados (efectivo + transferencia) que suman exacto", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 180000 }, { method: "transferencia", amount: 200000 }],
    });
    expect(res.status).toBe(201);
  });

  test("medio cheque con importe exacto", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{
        method: "cheque", amount: 380000,
        checks: [{ checkNumber: `${PREFIX}-CHK-${Date.now()}`, bankName: "Banco QA", dueDate: "2027-07-01", amount: 380000 }],
      }],
    });
    expect(res.status).toBe(201);
  });

  test("centavos: cierra exacto sin redondeo", async () => {
    const policyId = await mkPolicy();
    await mkInstallment(policyId, 1, 333.33);
    await mkInstallment(policyId, 2, 333.33);
    await mkInstallment(policyId, 3, 333.34);
    // nominal = 999.99 + 1 centavo redondeado... calculamos en centavos reales
    const nominalCents = Math.round(333.33 * 100) + Math.round(333.33 * 100) + Math.round(333.34 * 100);
    await setPolicyCashAmount(policyId, nominalCents - 111);
    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: (nominalCents - 111) / 100 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.discountAmountCents).toBe(111);
  });

  test("anti-duplicado: un segundo pago contado del mismo período ya pagado se bloquea", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const first = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(first.status).toBe(201);

    const second = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-16", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(second.status).toBe(409);
  });

  test("rechaza si la póliza está cancelada", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    await db.update(policies).set({ status: "cancelada" }).where(eq(policies.id, policyId));
    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(res.status).toBe(409);
    await db.update(policies).set({ status: "activa" }).where(eq(policies.id, policyId)); // no afecta otros tests
  });
});

// ─── Ronda 2 — tolerancia de redondeo en el cobro de contado ──────────────
//
// El importe contado ($380.000) es el número contractual fijo — nunca se
// toca. La diferencia real de instrumentos (cheques/efectivo) contra ESE
// número puede tolerarse hasta $5 inclusive, solo con aceptación explícita
// (accountDifferenceResolution.action="ajuste_redondeo"), reutilizando el
// mismo payment_amount_adjustments auditado que un payment_batches común —
// nunca insured_account_movements (el descuento comercial no es una cuenta
// corriente). Ver POST /payment-batches/cash-period-payment.
describe("POST /payment-batches/cash-period-payment — tolerancia de redondeo", () => {
  async function getAdjustmentsForBatch(batchId: number) {
    return db.select().from(paymentAmountAdjustments).where(eq(paymentAmountAdjustments.paymentBatchId, batchId)).all();
  }
  async function getBatchRow(batchId: number) {
    return db.select().from(paymentBatches).where(eq(paymentBatches.id, batchId)).get();
  }

  test("faltante dentro del límite ($4,99), con aceptación: acepta, registra el ajuste, nunca lo confunde con el descuento", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // nominal 400000
    await setPolicyCashAmount(policyId, 380000 * 100); // contado contractual 380000

    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 379995.01 }], // $4,99 menos que el contado
      accountDifferenceResolution: { action: "ajuste_redondeo" },
    });
    expect(res.status).toBe(201);
    expect(res.body.nominalAmountCents).toBe(40000000);
    expect(res.body.cashAmountCents).toBe(38000000); // contractual, SIN TOCAR
    expect(res.body.discountAmountCents).toBe(2000000); // descuento comercial, sin cambios
    expect(res.body.actualReceivedCents).toBe(37999501); // real
    expect(res.body.roundingAdjustmentCents).toBe(-499); // -$4,99

    const batch = await getBatchRow(res.body.id);
    expect(batch!.totalReceivedCents).toBe(38000000); // aplicado = contado, siempre
    expect(batch!.receivedAmountCents).toBe(37999501); // real

    const adjustments = await getAdjustmentsForBatch(res.body.id);
    expect(adjustments.length).toBe(1); // exactamente un ajuste
    expect(adjustments[0]!.amountCents).toBe(-499);

    // Cero insured_account_movements por el descuento — nunca se llama a ese camino.
    const movements = await db.select().from(insuredAccountMovements).where(eq(insuredAccountMovements.originBatchId, res.body.id)).all();
    expect(movements.length).toBe(0);
  });

  test("sobrante dentro del límite ($3,00), con aceptación: acepta, registra el ajuste positivo", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);

    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 380003 }], // $3,00 más que el contado
      accountDifferenceResolution: { action: "ajuste_redondeo" },
    });
    expect(res.status).toBe(201);
    expect(res.body.cashAmountCents).toBe(38000000);
    expect(res.body.actualReceivedCents).toBe(38000300);
    expect(res.body.roundingAdjustmentCents).toBe(300);

    const adjustments = await getAdjustmentsForBatch(res.body.id);
    expect(adjustments.length).toBe(1);
    expect(adjustments[0]!.amountCents).toBe(300);
  });

  test("límite exacto $5,00 (500 centavos): acepta, inclusive", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);

    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 380005 }], // exactamente $5,00 más
      accountDifferenceResolution: { action: "ajuste_redondeo" },
    });
    expect(res.status).toBe(201);
    expect(res.body.roundingAdjustmentCents).toBe(500);
  });

  test("$5,01 (501 centavos): rechaza aunque haya aceptación explícita", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);

    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 380005.01 }],
      accountDifferenceResolution: { action: "ajuste_redondeo" },
    });
    expect(res.status).toBe(400);

    // Nada quedó insertado — ni cuotas pagadas, ni batch, ni ajuste.
    const installments = await getInstallments(policyId);
    expect(installments.every((i) => i.status === "pendiente")).toBe(true);
  });

  test("diferencia dentro del límite SIN accountDifferenceResolution (sin \"checkbox\"): rechaza", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);

    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 380003 }], // $3,00 de más, tolerable — pero sin aceptación
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CASH_PERIOD_PAYMENT_AMOUNT_DIFFERENCE");
  });

  test("nunca acepta saldo_a_favor/saldo_deudor para esta diferencia — solo ajuste_redondeo", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);

    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 380003 }],
      accountDifferenceResolution: { action: "saldo_a_favor", reason: "no debería aceptarse" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("ajuste_redondeo");

    // No quedó ningún insured_account_movements ni cuota pagada.
    const installments = await getInstallments(policyId);
    expect(installments.every((i) => i.status === "pendiente")).toBe(true);
  });

  test("ejemplo completo del pedido: nominal $400.000, contado $380.000, cheques $379.999,66 — descuento y ajuste quedan separados", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // nominal 400000
    await setPolicyCashAmount(policyId, 380000 * 100); // contado contractual 380000

    const beforeCobro = await callGetCashSummary();
    const res = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 379999.66 }],
      accountDifferenceResolution: { action: "ajuste_redondeo" },
    });
    expect(res.status).toBe(201);
    expect(res.body.nominalAmountCents).toBe(40000000);       // $400.000
    expect(res.body.cashAmountCents).toBe(38000000);          // $380.000 — contado contractual
    expect(res.body.discountAmountCents).toBe(2000000);       // $20.000 — descuento comercial
    expect(res.body.actualReceivedCents).toBe(37999966);      // $379.999,66 — dinero real
    expect(res.body.roundingAdjustmentCents).toBe(-34);       // -$0,34 — ajuste de redondeo real

    // El descuento ($20.000) y el ajuste ($0,34) nunca se mezclan.
    const adjustments = await getAdjustmentsForBatch(res.body.id);
    expect(adjustments.length).toBe(1);
    expect(adjustments[0]!.amountCents).toBe(-34); // nunca -2000034 (descuento + ajuste sumados)

    // El REGISTRO de la rendición (remittance_items.amount, lo que se
    // comunica como "importe a rendir") es el CONTADO contractual
    // ($380.000), nunca el real ni el nominal — validado server-side (ver
    // describe "restricciones de source=payment_batch"). El instrumento REAL
    // (remittance_allocations, para Caja/auditoría de instrumentos físicos)
    // sigue reflejando el dinero real ($379.999,66) — igual que CUALQUIER
    // otra allocation del sistema — nunca el contractual: el contado
    // contractual permanece, sin cambios, en cash_period_payments.cashAmountCents.
    const rem = await callPostRemittance({
      date: "2027-06-16", canal: "directo", paymentBreakdown: { efectivo: 380000 },
      items: [{ source: "payment_batch", sourceId: res.body.id, amount: 380000, debtorStatus: "pagado" }],
    });
    expect(rem.status).toBe(200);
    const allocs = await db.select().from(remittanceAllocations).where(eq(remittanceAllocations.remittanceId, rem.body.id)).all();
    expect(allocs.length).toBe(1);
    expect(allocs[0]!.amountCents).toBe(37999966); // instrumento real — nunca el contractual ni el nominal
    const remItem = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, rem.body.id)).get();
    expect(remItem!.amount).toBe(380000); // el REGISTRO de la rendición sigue siendo el contado contractual

    // totalCobrado: nunca reconstruye el nominal ($400.000) en ningún punto,
    // y rendir no lo mueve — capea al real ($379.999,66) antes y después,
    // igual que un lote normal con faltante (regresión punto 1, generalizada
    // acá al caso con tolerancia de redondeo).
    const afterRender = await callGetCashSummary();
    expect(afterRender.totalCobrado - beforeCobro.totalCobrado).toBeCloseTo(379999.66, 2);
    expect(afterRender.totalCobrado - beforeCobro.totalCobrado).not.toBeCloseTo(400000, 2);
    expect(afterRender.totalCobrado - beforeCobro.totalCobrado).not.toBeCloseTo(380000, 2);

    // Comprobante: expone el desglose completo, auditable.
    const receipt = await app.fetch(new Request(`http://localhost/api/cash-period-payments/${res.body.id}`, { headers: authHeaders() }));
    const receiptBody = await receipt.json();
    expect(receiptBody.nominalAmountCents).toBe(40000000);
    expect(receiptBody.cashAmountCents).toBe(38000000);
    expect(receiptBody.discountAmountCents).toBe(2000000);
    expect(receiptBody.actualReceivedCents).toBe(37999966);
    expect(receiptBody.roundingAdjustmentCents).toBe(-34);

    // Anular la rendición y luego el cobro — el ajuste sigue existiendo,
    // histórico (nunca se borra), pero deja de ser "activo" para Caja
    // (parentActive=false vía payment_batches.status, ver caja-summary.ts).
    await callDeleteRemittance(rem.body.id);
    const cancel = await callCancelBatch(res.body.id);
    expect(cancel.status).toBe(200);
    const adjustmentsAfterCancel = await getAdjustmentsForBatch(res.body.id);
    expect(adjustmentsAfterCancel.length).toBe(1); // la fila histórica no se borra
  });
});

// ─── GET /payments — fila sintética de contado (regresión) ────────────────
//
// Cubre el bug real de wiring detectado en runtime (ver comentario de
// index.ts: cashPeriodSyntheticRows) — un cobro de contado confirmado tenía
// que colapsar sus 4 hijos reales en UNA fila sintética con la forma
// pública COMPLETA de cualquier otro payment (mismas keys que un payment
// standalone, nunca ausentes), pero el chequeo de tipos que lo hubiera
// detectado nunca corría (tsconfig raíz vacío). Este test verifica el
// comportamiento real del endpoint, no solo que tsc compile.

describe("GET /payments — fila sintética de contado", () => {
  test("colapsa el período en UNA sola fila, nunca expone los 4 hijos por separado", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // nominal 400000
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;

    const children = await getChildren(batchId);
    expect(children.length).toBe(4);
    const childIds = new Set(children.map((c) => c.id));

    const { status, body: list } = await callGetPayments({ policyId: String(policyId) });
    expect(status).toBe(200);

    // Ni un solo hijo real aparece como fila propia del listado.
    const rowsMatchingChildIds = list.filter((r: any) => r.payment.id != null && childIds.has(r.payment.id));
    expect(rowsMatchingChildIds.length).toBe(0);

    // Exactamente una fila sintética representa todo el período.
    const syntheticRows = list.filter((r: any) => r.payment.isCashPeriodPayment === true && r.payment.batchId === batchId);
    expect(syntheticRows.length).toBe(1);
  });

  test("la fila sintética tiene la forma pública completa: campos que no aplican llegan como null (presentes, no ausentes)", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "transferencia", amount: 380000 }],
    });
    const batchId = created.body.id as number;

    const { body: list } = await callGetPayments({ policyId: String(policyId) });
    const row = list.find((r: any) => r.payment.isCashPeriodPayment === true && r.payment.batchId === batchId);
    expect(row).toBeDefined();
    const p = row.payment;

    // Mismas keys que cualquier payment real (payments.* completo) más las
    // propias de la fila sintética — ninguna ausente.
    const expectedKeys = [
      "id", "batchId", "policyId", "manualPayer", "manualPolicyNumber", "manualCompany",
      "amount", "paymentMethod", "paymentDate", "periodMonth", "status", "rendered",
      "renderedAt", "installmentId", "dueDate", "createdBy", "createdAt", "notes",
      "hasSurcharge", "hasChecks", "splits", "isCashPeriodPayment", "concept", "cashPeriodPayment",
    ];
    for (const key of expectedKeys) {
      expect(Object.prototype.hasOwnProperty.call(p, key)).toBe(true);
    }

    // payments.id real: no aplica (no es un payments.id real) — null, no ausente.
    expect(p.id).toBeNull();
    // Imputación manual: no aplica (siempre vinculado a una póliza real).
    expect(p.manualPayer).toBeNull();
    expect(p.manualPolicyNumber).toBeNull();
    expect(p.manualCompany).toBeNull();
    // No hay un único mes contable — cubre el período completo.
    expect(p.periodMonth).toBeNull();
    // El período colapsa 4 cuotas — ninguna cuota individual representa la fila.
    expect(p.installmentId).toBeNull();
    expect(p.dueDate).toBeNull();

    // Campos que SÍ aplican y tienen valor real (nunca null acá).
    expect(p.batchId).toBe(batchId);
    expect(p.policyId).toBe(policyId);
    expect(typeof p.amount).toBe("number");
    expect(p.paymentMethod).toBe("transferencia");
    expect(p.status).toBe("confirmado");
    expect(p.rendered).toBe(0);
    expect(p.createdBy).not.toBeNull();
    expect(p.createdAt).not.toBeNull();
    expect(p.isCashPeriodPayment).toBe(true);
    expect(p.concept).toBe("Pago de contado");
    expect(Array.isArray(p.splits)).toBe(true);
    expect(p.cashPeriodPayment).toBeDefined();
  });

  test("búsqueda por póliza y filtro por método siguen encontrando el cobro de contado como UN único resultado", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "transferencia", amount: 200000 }, { method: "efectivo", amount: 180000 }],
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;

    // Búsqueda por póliza (GET /payments?policyId=): un único resultado, no 4.
    const byPolicy = await callGetPayments({ policyId: String(policyId) });
    const foundByPolicy = byPolicy.body.filter((r: any) => r.payment.batchId === batchId);
    expect(foundByPolicy.length).toBe(1);

    // Filtro por método: matchea por CUALQUIER medio real del combinado
    // (mismo criterio que un payment standalone combinado), un único
    // resultado por método, nunca 4 (uno por hijo).
    const byTransferencia = await callGetPayments({ method: "transferencia" });
    expect(byTransferencia.body.filter((r: any) => r.payment.batchId === batchId).length).toBe(1);

    const byEfectivo = await callGetPayments({ method: "efectivo" });
    expect(byEfectivo.body.filter((r: any) => r.payment.batchId === batchId).length).toBe(1);

    const byLinkPago = await callGetPayments({ method: "link_pago" });
    expect(byLinkPago.body.filter((r: any) => r.payment.batchId === batchId).length).toBe(0);
  });

  test("estadísticas (GET /payments/stats) cuentan el período como UN único cobro, nunca 4", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);

    const statsBefore = await callGetPaymentsStats();
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(created.status).toBe(201);
    const statsAfter = await callGetPaymentsStats();

    // Un único cobro cuenta como 1, nunca como 4 (uno por hijo colapsado).
    expect(statsAfter.count - statsBefore.count).toBe(1);
    // El total suma el importe de CONTADO real ($380.000), nunca la suma
    // nominal de las 4 cuotas ($400.000).
    expect(statsAfter.total - statsBefore.total).toBeCloseTo(380000, 2);
    expect(statsAfter.byMethod.efectivo - (statsBefore.byMethod.efectivo || 0)).toBeCloseTo(380000, 2);
  });
});

// ─── GET /cash-period-payments/:batchId — comprobante/auditoría ───────────

describe("GET /cash-period-payments/:batchId", () => {
  test("devuelve el detalle completo con la base de comisión real", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    const res = await callGetCashPeriodPayment(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.nominalAmountCents).toBe(40000000);
    expect(res.body.cashAmountCents).toBe(38000000);
    expect(res.body.commissionBaseAmountCents).toBe(38000000);
    expect(res.body.cancelledInstallments.length).toBe(4);
    expect(res.body.policy.id).toBe(policyId);
  });

  test("404 para un batch que no es de contado", async () => {
    const res = await callGetCashPeriodPayment(999999999);
    expect(res.status).toBe(404);
  });
});

// ─── Anulación y reversión (Regla 6) ───────────────────────────────────────

describe("POST /payment-batches/:id/cancel — cobro de contado", () => {
  test("revierte las 4 cuotas a pendiente, marca cash_period_payments anulado, y permite volver a cobrar contado después", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(created.status).toBe(201);

    const check = await callCancelCheck(created.body.id);
    expect(check.status).toBe(200);
    expect(check.body.cashPeriodPayment.id).toBe(created.body.cashPeriodPaymentId);
    expect(check.body.canCancel).toBe(true);

    const cancel = await callCancelBatch(created.body.id);
    expect(cancel.status).toBe(200);
    expect(cancel.body.voidedCashPeriodPaymentId).toBe(created.body.cashPeriodPaymentId);

    const installments = await getInstallments(policyId);
    expect(installments.every((i) => i.status === "pendiente")).toBe(true);

    const cpp = await getCashPeriodPaymentRow(created.body.id);
    expect(cpp!.status).toBe("anulado");

    // Reversión completa: se puede volver a pagar contado el mismo período.
    const again = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-20", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(again.status).toBe(201);
  });
});

// ─── Rendición como instrumento único (Regla 8) ────────────────────────────

describe("POST/DELETE /api/remittances — cobro de contado como instrumento único", () => {
  test("rinde el período entero por el importe contado real, no por cuota nominal", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // nominal 400000
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(created.status).toBe(201);

    const rem = await callPostRemittance({
      date: "2027-06-16", canal: "directo", paymentBreakdown: { efectivo: 380000 },
      items: [{ source: "payment_batch", sourceId: created.body.id, amount: 380000, debtorStatus: "pagado" }],
    });
    expect(rem.status).toBe(200);

    const allocs = await db.select().from(remittanceAllocations).where(eq(remittanceAllocations.remittanceId, rem.body.id)).all();
    expect(allocs.length).toBe(1); // UN solo instrumento — el split efectivo del batch
    expect(allocs[0]!.amountCents).toBe(38000000);
    expect(allocs[0]!.paymentBatchId).toBe(created.body.id);
    expect(allocs[0]!.remittanceItemId).toBeNull(); // el batch se rinde completo, no por ítem

    const cpp = await getCashPeriodPaymentRow(created.body.id);
    expect(cpp!.rendered).toBe(1);
    const children = await getChildren(created.body.id);
    expect(children.every((c) => c.rendered === 1)).toBe(true);

    // Comprobante enriquecido.
    const items = await callGetRemittanceItems(rem.body.id);
    const item = items.body.find((i: any) => i.source === "payment_batch");
    expect(item.cashPeriodPayment.nominalAmountCents).toBe(40000000);
    expect(item.cashPeriodPayment.cashAmountCents).toBe(38000000);
    expect(item.cashPeriodPayment.discountAmountCents).toBe(2000000);
    expect(item.cashPeriodPayment.cancelledInstallments.length).toBe(4);

    // Anular la rendición revierte todo.
    const del = await callDeleteRemittance(rem.body.id);
    expect(del.status).toBe(200);
    const cppAfter = await getCashPeriodPaymentRow(created.body.id);
    expect(cppAfter!.rendered).toBe(0);
    const childrenAfter = await getChildren(created.body.id);
    expect(childrenAfter.every((c) => c.rendered === 0)).toBe(true);
  });

  test("totalCobrado nunca reconstruye el nominal ($400.000) en ningún punto del ciclo: sin rendir, rendido, rendición anulada, cobro anulado", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // nominal 400000
    await setPolicyCashAmount(policyId, 380000 * 100);
    const PAYMENT_DATE = "2027-06-15";

    const before = await callGetCashSummary();
    const created = await callCashPeriodPayment({
      policyId, paymentDate: PAYMENT_DATE, splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(created.status).toBe(201);

    // 1. Contado NO rendido: totalCobrado sube exactamente $380.000.
    const afterCobro = await callGetCashSummary();
    expect(afterCobro.totalCobrado - before.totalCobrado).toBeCloseTo(380000, 2);
    expect(afterCobro.totalCobrado - before.totalCobrado).not.toBeCloseTo(400000, 2);

    // 2. Contado rendido: totalCobrado NO se mueve (sigue en +$380.000) —
    // la plata pasa de cartera a rendido, nunca reaparece como nominal.
    const rem = await callPostRemittance({
      date: "2027-06-16", canal: "directo", paymentBreakdown: { efectivo: 380000 },
      items: [{ source: "payment_batch", sourceId: created.body.id, amount: 380000, debtorStatus: "pagado" }],
    });
    expect(rem.status).toBe(200);
    const afterRender = await callGetCashSummary();
    expect(afterRender.totalCobrado - before.totalCobrado).toBeCloseTo(380000, 2);
    expect(afterRender.totalCobrado - before.totalCobrado).not.toBeCloseTo(400000, 2);
    expect(afterRender.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(0, 2); // salió de cartera
    expect(afterRender.rendidoPorMetodo.efectivo - before.rendidoPorMetodo.efectivo).toBeCloseTo(380000, 2); // entró a rendido

    // 3. Rendición anulada: vuelve a cartera, totalCobrado sigue en +$380.000.
    const del = await callDeleteRemittance(rem.body.id);
    expect(del.status).toBe(200);
    const afterUnrender = await callGetCashSummary();
    expect(afterUnrender.totalCobrado - before.totalCobrado).toBeCloseTo(380000, 2);
    expect(afterUnrender.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(380000, 2); // volvió a cartera
    expect(afterUnrender.rendidoPorMetodo.efectivo - before.rendidoPorMetodo.efectivo).toBeCloseTo(0, 2);

    // 4. Cobro anulado (nunca rendido en este punto): totalCobrado vuelve a 0.
    const cancel = await callCancelBatch(created.body.id);
    expect(cancel.status).toBe(200);
    const afterCancel = await callGetCashSummary();
    expect(afterCancel.totalCobrado - before.totalCobrado).toBeCloseTo(0, 2);
    expect(afterCancel.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(0, 2);
  });

  test("un cobro de contado ya rendido no se puede anular (mismo criterio que cualquier batch rendido)", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    await callPostRemittance({
      date: "2027-06-16", canal: "directo", paymentBreakdown: { efectivo: 380000 },
      items: [{ source: "payment_batch", sourceId: created.body.id, amount: 380000, debtorStatus: "pagado" }],
    });

    const cancel = await callCancelBatch(created.body.id);
    expect(cancel.status).toBe(409);
  });
});

// ─── Regresión: restringir source="payment_batch" a instrumentos válidos ──
//
// Reactivar source="payment_batch" para el pago de contado por período no
// debía habilitar de paso rendir CUALQUIER lote normal como si fuera un
// instrumento completo, ni permitir doble-contar/duplicar el mismo dinero
// combinándolo con sus hijos individuales.
describe("POST /api/remittances — restricciones de source=\"payment_batch\"", () => {
  async function callPostNormalBatch(body: Record<string, any>) {
    const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
      method: "POST", headers: authHeaders(), body: JSON.stringify(body),
    }));
    const json = await res.json();
    if (json?.id) batchIdsToClean.push(json.id);
    return { status: res.status, body: json };
  }

  test("rechaza un lote NORMAL (sin cash_period_payments) como source=\"payment_batch\"", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, 1000);

    const normal = await callPostNormalBatch({
      paymentDate: "2027-06-15",
      items: [{ source: "installment", installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
      applyProntoPagoSurcharge: false,
    });
    expect(normal.status).toBe(201);

    const rem = await callPostRemittance({
      date: "2027-06-16", canal: "directo", paymentBreakdown: { efectivo: 1000 },
      items: [{ source: "payment_batch", sourceId: normal.body.id, amount: 1000, debtorStatus: "pagado" }],
    });
    expect(rem.status).toBe(409);
    expect(rem.body.error).toContain("no es un pago de contado por período");
  });

  test("rechaza un cobro de contado ANULADO como source=\"payment_batch\"", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(created.status).toBe(201);
    const cancel = await callCancelBatch(created.body.id);
    expect(cancel.status).toBe(200);

    const rem = await callPostRemittance({
      date: "2027-06-16", canal: "directo", paymentBreakdown: { efectivo: 380000 },
      items: [{ source: "payment_batch", sourceId: created.body.id, amount: 380000, debtorStatus: "pagado" }],
    });
    expect(rem.status).toBe(409);
  });

  test("rechaza rendir el mismo cobro de contado dos veces (doble rendición)", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(created.status).toBe(201);
    const rem1 = await callPostRemittance({
      date: "2027-06-16", canal: "directo", paymentBreakdown: { efectivo: 380000 },
      items: [{ source: "payment_batch", sourceId: created.body.id, amount: 380000, debtorStatus: "pagado" }],
    });
    expect(rem1.status).toBe(200);

    const rem2 = await callPostRemittance({
      date: "2027-06-17", canal: "directo", paymentBreakdown: { efectivo: 380000 },
      items: [{ source: "payment_batch", sourceId: created.body.id, amount: 380000, debtorStatus: "pagado" }],
    });
    expect(rem2.status).toBe(409);
    expect(rem2.body.error).toContain("ya fue rendido");
  });

  test("rechaza el mismo cobro de contado repetido DOS VECES en el mismo request", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(created.status).toBe(201);

    const rem = await callPostRemittance({
      date: "2027-06-16", canal: "directo", paymentBreakdown: { efectivo: 760000 },
      items: [
        { source: "payment_batch", sourceId: created.body.id, amount: 380000, debtorStatus: "pagado" },
        { source: "payment_batch", sourceId: created.body.id, amount: 380000, debtorStatus: "pagado" },
      ],
    });
    expect(rem.status).toBe(409);
    expect(rem.body.error).toContain("repetido");
  });

  test("rechaza declarar el importe NOMINAL (400.000) en vez del contado real (380.000)", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(created.status).toBe(201);

    const rem = await callPostRemittance({
      date: "2027-06-16", canal: "directo", paymentBreakdown: { efectivo: 400000 },
      items: [{ source: "payment_batch", sourceId: created.body.id, amount: 400000, debtorStatus: "pagado" }],
    });
    expect(rem.status).toBe(409);
    expect(rem.body.error).toContain("nominal");

    // El período sigue sin rendir — el rechazo fue antes de escribir nada.
    const cpp = await getCashPeriodPaymentRow(created.body.id);
    expect(cpp!.rendered).toBe(0);
  });

  test("rechaza rendir además un payment hijo del período individualmente (duplicaría el mismo dinero)", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // nominal 400000
    await setPolicyCashAmount(policyId, 380000 * 100);
    const created = await callCashPeriodPayment({
      policyId, paymentDate: "2027-06-15", splits: [{ method: "efectivo", amount: 380000 }],
    });
    expect(created.status).toBe(201);
    const children = await getChildren(created.body.id);
    const childPaymentId = children[0]!.id;

    // Intento 1: SOLO el hijo individual (sin el batch) — igual debe
    // rechazarse, el período nunca se rinde por cuota.
    const remChildOnly = await callPostRemittance({
      date: "2027-06-16", canal: "directo", paymentBreakdown: { efectivo: 100000 },
      items: [{ source: "payment", sourceId: childPaymentId, amount: 100000, debtorStatus: "pagado", paymentMethod: "efectivo" }],
    });
    expect(remChildOnly.status).toBe(409);
    expect(remChildOnly.body.error).toContain("período de contado");

    // Intento 2: el batch entero MÁS uno de sus hijos en el mismo request —
    // duplicaría $100.000 de los $380.000 ya representados por el instrumento
    // único del batch.
    const remBoth = await callPostRemittance({
      date: "2027-06-16", canal: "directo", paymentBreakdown: { efectivo: 480000 },
      items: [
        { source: "payment_batch", sourceId: created.body.id, amount: 380000, debtorStatus: "pagado" },
        { source: "payment", sourceId: childPaymentId, amount: 100000, debtorStatus: "pagado", paymentMethod: "efectivo" },
      ],
    });
    expect(remBoth.status).toBe(409);
    expect(remBoth.body.error).toContain("período de contado");

    // Nada quedó rendido por ninguno de los dos intentos fallidos.
    const cpp = await getCashPeriodPaymentRow(created.body.id);
    expect(cpp!.rendered).toBe(0);
    const childrenAfter = await getChildren(created.body.id);
    expect(childrenAfter.every((c) => c.rendered === 0)).toBe(true);
  });
});

// ─── Refacturación (Regla 1: rebillingId no nulo) ──────────────────────────

describe("Pago de contado de una refacturación puntual", () => {
  test("funciona igual con rebillingId, sin tocar el período de emisión", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 50000); // emisión, nominal 200000 — no se toca

    const [reb] = await db.insert(rebillings).values({
      policyId, billingStart: "2027-07-01", billingEnd: "2027-10-31", createdBy: userId,
    }).returning();
    const rebillingId = reb!.id;
    const rebInstallmentIds: number[] = [];
    for (let i = 1; i <= 4; i++) rebInstallmentIds.push(await mkInstallment(policyId, i, 90000, rebillingId));

    const put = await app.fetch(new Request(`http://localhost/api/rebillings/${rebillingId}`, {
      method: "PUT", headers: authHeaders(), body: JSON.stringify({ cashPaymentAmountCents: 340000 * 100 }),
    }));
    expect(put.status).toBe(200);

    const res = await callCashPeriodPayment({
      policyId, rebillingId, paymentDate: "2027-07-15", splits: [{ method: "transferencia", amount: 340000 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.nominalAmountCents).toBe(36000000);
    expect(res.body.cashAmountCents).toBe(34000000);

    // El período de emisión sigue intacto (todo o nada es POR período).
    const emissionInstallments = (await getInstallments(policyId)).filter((i) => i.rebillingId === null);
    expect(emissionInstallments.every((i) => i.status === "pendiente")).toBe(true);
    void rebInstallmentIds; // limpieza real la hace afterAll (batchIdsToClean + policyIdsToClean, orden correcto de FKs)
  });
});

// ─── Regresión: el mismo gating (Regla 4) en PUT /rebillings/:id ──────────
describe("PUT /rebillings/:id — importe contado con actividad: no bloquear lo que no cambia", () => {
  async function mkRebillingWithInstallments(policyId: number, amount = 90000): Promise<{ rebillingId: number; instIds: number[] }> {
    const [reb] = await db.insert(rebillings).values({
      policyId, billingStart: "2027-07-01", billingEnd: "2027-10-31", createdBy: userId,
    }).returning({ id: rebillings.id });
    const rebillingId = reb!.id;
    const instIds: number[] = [];
    for (let i = 1; i <= 4; i++) instIds.push(await mkInstallment(policyId, i, amount, rebillingId));
    return { rebillingId, instIds };
  }

  async function callPutRebilling(rebillingId: number, body: Record<string, any>) {
    const res = await app.fetch(new Request(`http://localhost/api/rebillings/${rebillingId}`, {
      method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  }

  test("actividad por PAGO confirmado: reenviar el MISMO valor no bloquea editar notes", async () => {
    const policyId = await mkPolicy();
    const { rebillingId, instIds } = await mkRebillingWithInstallments(policyId);
    await callPutRebilling(rebillingId, { cashPaymentAmountCents: 34000000 });
    await db.insert(payments).values({ policyId, installmentId: instIds[0], amount: 90000, paymentMethod: "efectivo", paymentDate: "2027-07-01", status: "confirmado", createdBy: userId });

    const res = await callPutRebilling(rebillingId, { cashPaymentAmountCents: 34000000, notes: `${PREFIX} nota reb` });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe(`${PREFIX} nota reb`);
    expect(res.body.cashPaymentAmountCents).toBe(34000000);
  });

  test("actividad por PAGO confirmado: omitir la clave no la modifica ni bloquea editar notes", async () => {
    const policyId = await mkPolicy();
    const { rebillingId, instIds } = await mkRebillingWithInstallments(policyId);
    await callPutRebilling(rebillingId, { cashPaymentAmountCents: 34000000 });
    await db.insert(payments).values({ policyId, installmentId: instIds[0], amount: 90000, paymentMethod: "efectivo", paymentDate: "2027-07-01", status: "confirmado", createdBy: userId });

    const res = await callPutRebilling(rebillingId, { notes: `${PREFIX} otra nota reb` }); // sin cashPaymentAmountCents
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe(`${PREFIX} otra nota reb`);
    expect(res.body.cashPaymentAmountCents).toBe(34000000); // intacto
  });

  test("actividad por IMPUTACIÓN directa (remittance_items source=installment) bloquea cambiar el valor", async () => {
    const policyId = await mkPolicy();
    const { rebillingId, instIds } = await mkRebillingWithInstallments(policyId);
    await callPutRebilling(rebillingId, { cashPaymentAmountCents: 34000000 });

    const [rem] = await db.insert(remittances).values({
      date: "2027-07-01", canal: "directo", paymentBreakdown: "{}", totalAmount: 90000, totalPaid: 0, status: "confirmada", createdBy: userId,
    }).returning({ id: remittances.id });
    remittanceIdsToClean.push(rem!.id);
    await db.insert(remittanceItems).values({
      remittanceId: rem!.id, source: "installment", sourceId: instIds[0], amount: 90000, debtorStatus: "adeudado",
    });

    const res = await callPutRebilling(rebillingId, { cashPaymentAmountCents: 30000000 });
    expect(res.status).toBe(409);
  });

  test("actividad por RENDICIÓN (installment.rendered=1) bloquea cambiar el valor", async () => {
    const policyId = await mkPolicy();
    const { rebillingId, instIds } = await mkRebillingWithInstallments(policyId);
    await callPutRebilling(rebillingId, { cashPaymentAmountCents: 34000000 });
    await db.update(policyInstallments).set({ rendered: 1 }).where(eq(policyInstallments.id, instIds[0]!));

    const res = await callPutRebilling(rebillingId, { cashPaymentAmountCents: 30000000 });
    expect(res.status).toBe(409);
  });

  test("actividad bloquea pasar de null a un valor", async () => {
    const policyId = await mkPolicy();
    const { rebillingId, instIds } = await mkRebillingWithInstallments(policyId); // nunca se cargó cashPaymentAmountCents (null)
    await db.insert(payments).values({ policyId, installmentId: instIds[0], amount: 90000, paymentMethod: "efectivo", paymentDate: "2027-07-01", status: "confirmado", createdBy: userId });

    const res = await callPutRebilling(rebillingId, { cashPaymentAmountCents: 34000000 });
    expect(res.status).toBe(409);
  });

  test("sin actividad: todas las transiciones son libres (null→valor, valor→otro valor, valor→null)", async () => {
    const policyId = await mkPolicy();
    const { rebillingId } = await mkRebillingWithInstallments(policyId); // sin actividad

    const toValue = await callPutRebilling(rebillingId, { cashPaymentAmountCents: 34000000 });
    expect(toValue.status).toBe(200);

    const toOther = await callPutRebilling(rebillingId, { cashPaymentAmountCents: 30000000 });
    expect(toOther.status).toBe(200);

    const toNull = await callPutRebilling(rebillingId, { cashPaymentAmountCents: null });
    expect(toNull.status).toBe(200);
    expect(toNull.body.cashPaymentAmountCents).toBeNull();
  });
});

// ─── Rediseño Pago de contado — búsqueda desde Cobranzas ───────────────────
// GET /policies/cash-period-search es el único punto de entrada nuevo: ya no
// hay ningún cobro de contado generable desde Pólizas (ese botón/modal se
// removió de poliza-detail.tsx). startDate/billingStart se eligen bien lejos
// en el futuro o el pasado (2099 / 2020) para que vigente/vencido no dependa
// de en qué fecha real corra la suite.
describe("GET /policies/cash-period-search", () => {
  async function mkPolicyWithStart(startDate: string): Promise<number> {
    const [p] = await db.insert(policies).values({
      policyNumber: `${PREFIX}-SEARCH-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: "automotor", status: "activa", companyId, insuredId,
      startDate, endDate: "2099-12-31", isRebilling: 0, createdBy: userId,
    }).returning({ id: policies.id });
    policyIdsToClean.push(p!.id);
    return p!.id;
  }

  async function callSearch(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await app.fetch(new Request(`http://localhost/api/policies/cash-period-search${qs ? `?${qs}` : ""}`, { headers: authHeaders() }));
    return { status: res.status, body: (await res.json()) as any[] };
  }

  test("período de emisión elegible y vigente (startDate futuro): aparece con importe/nominal/descuento/vencimiento correctos", async () => {
    const policyId = await mkPolicyWithStart("2099-01-01");
    await mkFourInstallmentPeriod(policyId, 100000); // nominal 4 * 100000 * 100 = 40.000.000 centavos
    await setPolicyCashAmount(policyId, 38000000);

    const { status, body } = await callSearch({ policyId: String(policyId) });
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    const row = body[0];
    expect(row.rebillingId).toBeNull();
    expect(row.cashPaymentAmountCents).toBe(38000000);
    expect(row.nominalAmountCents).toBe(40000000);
    expect(row.discountAmountCents).toBe(2000000);
    expect(row.installmentCount).toBe(4);
    expect(row.periodStartDate).toBe("2099-01-01");
    expect(row.deadline).toBe("2099-01-31");
    expect(row.deadlineStatus).toBe("vigente");
    expect(row.eligible).toBe(true);
    expect(row.ineligibleReasons).toEqual([]);
  });

  test("período vencido pero sin actividad: deadlineStatus=vencido, eligible sigue en true (el vencimiento nunca bloquea)", async () => {
    const policyId = await mkPolicyWithStart("2020-01-01");
    await mkFourInstallmentPeriod(policyId, 50000);
    await setPolicyCashAmount(policyId, 18000000);

    const { body } = await callSearch({ policyId: String(policyId) });
    expect(body).toHaveLength(1);
    expect(body[0].deadline).toBe("2020-01-31");
    expect(body[0].deadlineStatus).toBe("vencido");
    expect(body[0].eligible).toBe(true);
  });

  test("con actividad (una cuota pagada): eligible=false con motivos, pero SIGUE apareciendo con el importe preservado como histórico", async () => {
    const policyId = await mkPolicyWithStart("2099-01-01");
    const instIds = await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    await db.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, instIds[0]!));

    const { body } = await callSearch({ policyId: String(policyId) });
    expect(body).toHaveLength(1);
    expect(body[0].eligible).toBe(false);
    expect(body[0].ineligibleReasons.length).toBeGreaterThan(0);
    expect(body[0].cashPaymentAmountCents).toBe(38000000);
  });

  test("período de refacturación: usa rebillings.billingStart para el vencimiento, no policy.startDate", async () => {
    const policyId = await mkPolicyWithStart("2020-01-01"); // emisión de esta póliza sin contado cargado — no debe aparecer
    const [reb] = await db.insert(rebillings).values({
      policyId, billingStart: "2099-03-01", billingEnd: "2099-06-30", createdBy: userId,
      cashPaymentAmountCents: 25000000,
    }).returning({ id: rebillings.id });
    const rebillingId = reb!.id;
    for (let i = 1; i <= 3; i++) await mkInstallment(policyId, i, 90000, rebillingId);

    const { body } = await callSearch({ policyId: String(policyId) });
    expect(body).toHaveLength(1);
    const row = body[0];
    expect(row.rebillingId).toBe(rebillingId);
    expect(row.nominalAmountCents).toBe(27000000);
    expect(row.discountAmountCents).toBe(2000000);
    expect(row.periodStartDate).toBe("2099-03-01");
    expect(row.deadline).toBe("2099-03-31");
    expect(row.deadlineStatus).toBe("vigente");
    expect(row.eligible).toBe(true);
  });

  test("período sin importe contado cargado: no aparece en absoluto", async () => {
    const policyId = await mkPolicyWithStart("2099-01-01");
    await mkFourInstallmentPeriod(policyId, 100000); // sin setPolicyCashAmount

    const { body } = await callSearch({ policyId: String(policyId) });
    expect(body).toHaveLength(0);
  });

  test("search filtra por número de póliza", async () => {
    const policyId = await mkPolicyWithStart("2099-01-01");
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    const policyRow = await db.select({ policyNumber: policies.policyNumber }).from(policies).where(eq(policies.id, policyId)).get();

    const { body } = await callSearch({ search: policyRow!.policyNumber });
    expect(body.some((r: any) => r.policyId === policyId)).toBe(true);
  });

  test("anulación de un cobro de contado revierte las cuotas Y vuelve a habilitar la alternativa (round-trip completo)", async () => {
    const policyId = await mkPolicyWithStart("2099-01-01");
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);

    // 1. Antes de cobrar: elegible.
    const before = await callSearch({ policyId: String(policyId) });
    expect(before.body[0].eligible).toBe(true);

    // 2. Se cobra de contado → el período deja de estar elegible (todas las
    // cuotas ahora tienen un payment confirmado vinculado).
    const { body: created } = await callCashPeriodPayment({
      policyId, rebillingId: null, paymentDate: "2027-06-15",
      splits: [{ method: "transferencia", amount: 380000 }],
    });
    const afterCharge = await callSearch({ policyId: String(policyId) });
    expect(afterCharge.body[0].eligible).toBe(false);
    expect(afterCharge.body[0].ineligibleReasons.length).toBeGreaterThan(0);

    // 3. Se anula el cobro → las cuotas vuelven a "pendiente" y el período
    // vuelve a estar disponible para pagar de contado de nuevo.
    const cancelRes = await app.fetch(new Request(`http://localhost/api/payment-batches/${created.id}/cancel`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify({ confirm: true }),
    }));
    expect(cancelRes.status).toBe(200);

    const installmentsAfterCancel = await getInstallments(policyId);
    expect(installmentsAfterCancel.every((i) => i.status === "pendiente")).toBe(true);

    const afterCancel = await callSearch({ policyId: String(policyId) });
    expect(afterCancel.body[0].eligible).toBe(true);
    expect(afterCancel.body[0].ineligibleReasons).toEqual([]);
    // El importe configurado se preserva sin cambios durante todo el ciclo.
    expect(afterCancel.body[0].cashPaymentAmountCents).toBe(38000000);
  });
});

// ─── Rediseño Pago de contado — GET /payments y GET /payments/stats ────────
// Los 4 hijos de un batch de contado (uno por cuota, cada uno con el NOMINAL
// completo — ver POST /payment-batches/cash-period-payment) nunca deben
// listarse ni contarse como 4 pagos separados: acá se verifica que ambos
// endpoints los colapsan en un único registro, por el importe CONTRACTUAL
// real (cashAmountCents), con el medio REAL del instrumento (nunca el
// literal "contado", que es la modalidad comercial de los hijos, no un
// medio de pago).
describe("GET /payments — colapsa los hijos de un cobro de período de contado", () => {
  async function callGetPayments(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await app.fetch(new Request(`http://localhost/api/payments${qs ? `?${qs}` : ""}`, { headers: authHeaders() }));
    return { status: res.status, body: (await res.json()) as any[] };
  }

  test("una sola fila (no cuatro): importe = importe contado real, método = instrumento real, nunca 'contado'", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // nominal 40.000.000 centavos = $400.000
    await setPolicyCashAmount(policyId, 38000000); // $380.000
    const { body: created } = await callCashPeriodPayment({
      policyId, rebillingId: null, paymentDate: "2027-06-15",
      splits: [{ method: "transferencia", amount: 380000 }],
    });
    expect(created.id).toBeDefined();

    const { body: list } = await callGetPayments({ policyId: String(policyId) });
    const cashPeriodRows = list.filter((r: any) => r.payment.batchId === created.id);
    expect(cashPeriodRows).toHaveLength(1);
    const row = cashPeriodRows[0];
    expect(row.payment.amount).toBe(380000); // nunca 400000 (nominal)
    expect(row.payment.paymentMethod).toBe("transferencia"); // nunca "contado"
    expect(row.payment.status).toBe("confirmado");
    expect(row.payment.rendered).toBe(0);
    expect(row.payment.isCashPeriodPayment).toBe(true);
    expect(row.payment.concept).toBe("Pago de contado");
    expect(row.payment.cashPeriodPayment.nominalAmountCents).toBe(40000000);
    expect(row.payment.cashPeriodPayment.discountAmountCents).toBe(2000000);
  });

  test("rendered refleja cash_period_payments.rendered (el período se rinde como UN SOLO instrumento) — sin esto, el filtro 'pendientes de rendir' de Cobranzas nunca mostraría la fila", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    const { body: created } = await callCashPeriodPayment({
      policyId, rebillingId: null, paymentDate: "2027-06-15",
      splits: [{ method: "transferencia", amount: 380000 }],
    });

    const before = await callGetPayments({ policyId: String(policyId) });
    const rowBefore = before.body.find((r: any) => r.payment.batchId === created.id);
    expect(rowBefore.payment.rendered).toBe(0);

    await db.update(cashPeriodPayments).set({ rendered: 1 }).where(eq(cashPeriodPayments.paymentBatchId, created.id));

    const after = await callGetPayments({ policyId: String(policyId) });
    const rowAfter = after.body.find((r: any) => r.payment.batchId === created.id);
    expect(rowAfter.payment.rendered).toBe(1);
  });

  test("2+ medios reales → método 'combinado', con los splits reales adjuntos", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    const { body: created } = await callCashPeriodPayment({
      policyId, rebillingId: null, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 200000 }, { method: "transferencia", amount: 180000 }],
    });

    const { body: list } = await callGetPayments({ policyId: String(policyId) });
    const row = list.find((r: any) => r.payment.batchId === created.id);
    expect(row.payment.paymentMethod).toBe("combinado");
    expect(row.payment.splits).toHaveLength(2);
  });

  test("filtro method=<real> encuentra el cobro por su instrumento real; method=contado nunca matchea nada", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    const { body: created } = await callCashPeriodPayment({
      policyId, rebillingId: null, paymentDate: "2027-06-15",
      splits: [{
        method: "cheque", amount: 380000,
        checks: [{ checkNumber: `${PREFIX}-GETPAY-${Date.now()}`, bankName: "Banco QA", dueDate: "2027-07-01", amount: 380000 }],
      }],
    });

    const { body: byRealMethod } = await callGetPayments({ policyId: String(policyId), method: "cheque" });
    expect(byRealMethod.some((r: any) => r.payment.batchId === created.id)).toBe(true);
    const byRealMethodRow = byRealMethod.find((r: any) => r.payment.batchId === created.id);
    expect(byRealMethodRow.payment.hasChecks).toBe(true);

    const { body: byContado } = await callGetPayments({ policyId: String(policyId), method: "contado" });
    expect(byContado.some((r: any) => r.payment.batchId === created.id)).toBe(false);
  });

  test("anulado: sigue apareciendo colapsado con status=anulado, y desaparece del filtro status=confirmado", async () => {
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    const { body: created } = await callCashPeriodPayment({
      policyId, rebillingId: null, paymentDate: "2027-06-15",
      splits: [{ method: "transferencia", amount: 380000 }],
    });
    await callCancelBatch(created.id);

    const { body: list } = await callGetPayments({ policyId: String(policyId) });
    const row = list.find((r: any) => r.payment.batchId === created.id);
    expect(row.payment.status).toBe("anulado");

    const { body: onlyConfirmado } = await callGetPayments({ policyId: String(policyId), status: "confirmado" });
    expect(onlyConfirmado.some((r: any) => r.payment.batchId === created.id)).toBe(false);
  });
});

describe("GET /payments/stats — el contado cuenta UNA sola vez, por el importe real (nunca 4x nominal)", () => {
  async function callGetPaymentsStats() {
    const res = await app.fetch(new Request("http://localhost/api/payments/stats", { headers: authHeaders() }));
    return res.json();
  }

  test("total/count suman el importe contado real, no la suma nominal de las 4 cuotas", async () => {
    const before = await callGetPaymentsStats();
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000); // nominal $400.000
    await setPolicyCashAmount(policyId, 38000000); // $380.000
    await callCashPeriodPayment({
      policyId, rebillingId: null, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 380000 }],
    });
    const after = await callGetPaymentsStats();

    expect(after.total - before.total).toBe(380000); // nunca 400000
    expect(after.count - before.count).toBe(1); // nunca 4
    expect((after.byMethod.efectivo ?? 0) - (before.byMethod.efectivo ?? 0)).toBe(380000);
    expect(after.byMethod.contado).toBeUndefined(); // "contado" nunca es un método real en byMethod
  });

  test("2+ medios reales en el batch de contado incrementa combinadoCount", async () => {
    const before = await callGetPaymentsStats();
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    await callCashPeriodPayment({
      policyId, rebillingId: null, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 200000 }, { method: "transferencia", amount: 180000 }],
    });
    const after = await callGetPaymentsStats();
    expect((after.byMethod.combinadoCount ?? 0) - (before.byMethod.combinadoCount ?? 0)).toBe(1);
  });

  test("un batch anulado no suma al total confirmado", async () => {
    const before = await callGetPaymentsStats();
    const policyId = await mkPolicy();
    await mkFourInstallmentPeriod(policyId, 100000);
    await setPolicyCashAmount(policyId, 38000000);
    const { body: created } = await callCashPeriodPayment({
      policyId, rebillingId: null, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 380000 }],
    });
    await callCancelBatch(created.id);
    const after = await callGetPaymentsStats();

    expect(after.total).toBe(before.total);
    expect(after.count).toBe(before.count);
  });
});
