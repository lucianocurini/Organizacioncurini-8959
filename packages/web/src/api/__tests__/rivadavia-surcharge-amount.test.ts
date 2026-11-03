/**
 * Recargo Pronto Pago Rivadavia — monto $900 para operaciones nuevas, importes
 * históricos ($800) intactos. Endpoints reales (POST /payments, PUT
 * /payments/:id, POST /payment-batches, GET /remittances/pending, GET
 * /payments, POST /remittances, GET /cash/summary) contra la base de tests.
 *
 * "Histórico" se simula con una fila cuyo importe guardado es $800, igual a
 * las que existen en producción de antes del cambio: ningún recorrido debe
 * recalcularla con SURCHARGE_AMOUNT.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments,
  payments, paymentSplits, paymentBatches, paymentBatchSplits, cashEntries, remittances, remittanceItems,
} from "../database/schema";
import { eq, inArray, and, sql } from "drizzle-orm";
import {
  SURCHARGE_AMOUNT, SURCHARGE_AMOUNT_CENTS, calculateApplicableRivadaviaSurcharges, type BatchItemContext,
} from "../../lib/payments/batches";
import { estimateProntoPagoSurchargeCents, type BatchCartItem } from "../../web/lib/payment-batch-form";
import { individualFundingSurchargeCents } from "../../web/lib/individual-account-funding-form";
import { buildTitularFundingInput } from "../payment-batch-titular-dependencies";

const SESSION_ID = "test-session-riv-surcharge-001";
const USER_EMAIL = "test-riv-surcharge@test.local";
const PREFIX = "TEST-RIV-SURCHARGE";
const HISTORICAL_AMOUNT = 800;

let userId: number;
let companyId: number;
let rivadaviaCompanyId: number;
let insuredId: number;

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://localhost/api${path}`, {
    method, headers: authHeaders(), body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as any };
}

async function mkPolicy(company: number): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: "activa", companyId: company, insuredId,
    startDate: "2027-01-01", endDate: "2027-12-31", isRebilling: 0, createdBy: userId,
  }).returning({ id: policies.id });
  return p!.id;
}

async function mkInstallment(policyId: number, amount: number): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({
    policyId, number: 1, dueDate: "2027-01-01", amount, status: "pendiente", rendered: 0,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

async function surchargesOf(paymentIds: number[]) {
  if (paymentIds.length === 0) return [];
  return db.select().from(cashEntries)
    .where(and(inArray(cashEntries.paymentId, paymentIds), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
}

async function childrenOf(batchId: number) {
  return db.select().from(payments).where(eq(payments.batchId, batchId)).all();
}

async function cashSummary() {
  return (await call("GET", "/cash/summary")).body;
}

/** Simula un recargo registrado antes del cambio: su importe guardado es $800. */
async function makeHistorical(paymentId: number) {
  await db.update(cashEntries).set({ amount: HISTORICAL_AMOUNT })
    .where(and(eq(cashEntries.paymentId, paymentId), eq(cashEntries.entryType, "pronto_pago_surcharge")));
}

async function cleanup() {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (!prevUser) return;
  const uid = prevUser.id;
  const polIds = (await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, uid)).all()).map((p) => p.id);
  const payIds = polIds.length
    ? (await db.select({ id: payments.id }).from(payments).where(inArray(payments.policyId, polIds)).all()).map((p) => p.id)
    : [];
  const batchIds = (await db.select({ id: paymentBatches.id }).from(paymentBatches).where(eq(paymentBatches.createdBy, uid)).all()).map((b) => b.id);
  const remIds = (await db.select({ id: remittances.id }).from(remittances).where(eq(remittances.createdBy, uid)).all()).map((r) => r.id);
  const hasAllocations = await db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'remittance_allocations'`);
  if (hasAllocations && remIds.length) await db.run(sql`DELETE FROM remittance_allocations WHERE remittance_id IN ${remIds}`);
  if (remIds.length) {
    await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remIds));
    await db.delete(remittances).where(inArray(remittances.id, remIds));
  }
  if (payIds.length) {
    await db.delete(cashEntries).where(inArray(cashEntries.paymentId, payIds));
    await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds));
    await db.delete(payments).where(inArray(payments.id, payIds));
  }
  if (batchIds.length) {
    await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds));
    await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIds));
  }
  if (polIds.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, polIds));
    await db.delete(policies).where(inArray(policies.id, polIds));
  }
  await db.delete(insureds).where(eq(insureds.createdBy, uid));
  await db.delete(sessions).where(eq(sessions.userId, uid));
  await db.delete(users).where(eq(users.id, uid));
}

beforeAll(async () => {
  await cleanup();
  const [u] = await db.insert(users).values({
    name: "Test Riv Surcharge", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });
  const co = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = co?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;
  const riv = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Rivadavia Co`)).get();
  rivadaviaCompanyId = riv?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Rivadavia Co` }).returning({ id: companies.id }))[0]!.id;
  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(cleanup);

describe("monto vigente", () => {
  test("constante central = $900 (90000 centavos)", () => {
    expect(SURCHARGE_AMOUNT_CENTS).toBe(90000);
    expect(SURCHARGE_AMOUNT).toBe(900);
  });
});

describe("imputación individual (POST /payments)", () => {
  test("una póliza Rivadavia, medio propio → recargo $900", async () => {
    const r = await call("POST", "/payments", {
      policyId: await mkPolicy(rivadaviaCompanyId), amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(r.status).toBe(201);
    const s = await surchargesOf([r.body.id]);
    expect(s.map((e) => e.amount)).toEqual([900]);
  });

  test("otra compañía → $0 (sin cash_entry de recargo)", async () => {
    const r = await call("POST", "/payments", {
      policyId: await mkPolicy(companyId), amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(r.status).toBe(201);
    expect(await surchargesOf([r.body.id])).toEqual([]);
  });

  test("Rivadavia con medio directo a compañía → $0", async () => {
    const r = await call("POST", "/payments", {
      policyId: await mkPolicy(rivadaviaCompanyId), amount: 1000, paymentMethod: "transferencia_compania", paymentDate: "2027-01-01",
    });
    expect(r.status).toBe(201);
    expect(await surchargesOf([r.body.id])).toEqual([]);
  });

  test("edición que agrega el recargo a un pago sin recargo → $900 (operación nueva)", async () => {
    const r = await call("POST", "/payments", {
      policyId: await mkPolicy(rivadaviaCompanyId), amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      applyProntoPagoSurcharge: false,
    });
    expect(await surchargesOf([r.body.id])).toEqual([]);
    const put = await call("PUT", `/payments/${r.body.id}`, { applyProntoPagoSurcharge: true });
    expect(put.status).toBe(200);
    expect((await surchargesOf([r.body.id])).map((e) => e.amount)).toEqual([900]);
  });
});

describe("lote común (POST /payment-batches)", () => {
  test("varias pólizas Rivadavia → cantidad × $900; otra compañía en el mismo lote no suma", async () => {
    const i1 = await mkInstallment(await mkPolicy(rivadaviaCompanyId), 1000);
    const i2 = await mkInstallment(await mkPolicy(rivadaviaCompanyId), 500);
    const i3 = await mkInstallment(await mkPolicy(rivadaviaCompanyId), 300);
    const other = await mkInstallment(await mkPolicy(companyId), 200);
    const r = await call("POST", "/payment-batches", {
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: i1 }, { installmentId: i2 }, { installmentId: i3 }, { installmentId: other }],
      splits: [{ method: "efectivo", amount: 2000 + 3 * 900 }],
    });
    expect(r.status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, r.body.id)).get();
    expect(batch!.surchargeAmountCents).toBe(3 * 90000);
    expect(batch!.totalReceivedCents).toBe(200000 + 3 * 90000);
    const s = await surchargesOf((await childrenOf(r.body.id)).map((c) => c.id));
    expect(s.map((e) => e.amount)).toEqual([900, 900, 900]);
  });

  test("lote Rivadavia con medios directos a compañía → $0", async () => {
    const i1 = await mkInstallment(await mkPolicy(rivadaviaCompanyId), 1000);
    const r = await call("POST", "/payment-batches", {
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: i1 }],
      splits: [{ method: "transferencia_compania", amount: 1000 }],
    });
    expect(r.status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, r.body.id)).get();
    expect(batch!.surchargeAmountCents).toBe(0);
  });

  test("paridad: individual y lote de una póliza Rivadavia generan el mismo recargo", async () => {
    const individual = await call("POST", "/payments", {
      policyId: await mkPolicy(rivadaviaCompanyId), amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    const inst = await mkInstallment(await mkPolicy(rivadaviaCompanyId), 1000);
    const lote = await call("POST", "/payment-batches", {
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst }],
      splits: [{ method: "efectivo", amount: 1000 + 900 }],
    });
    expect(lote.status).toBe(201);
    const a = (await surchargesOf([individual.body.id])).map((e) => e.amount);
    const b = (await surchargesOf((await childrenOf(lote.body.id)).map((c) => c.id))).map((e) => e.amount);
    expect(a).toEqual([900]);
    expect(b).toEqual(a);
  });
});

describe("paridad de cálculo: lote común, lote con titular, pago individual con saldo y preview", () => {
  const ctx = (o: Partial<BatchItemContext>): BatchItemContext => ({
    kind: "installment", installmentId: 1, policyId: 1, insuredId: 1, amount: 1000, installmentStatus: "pendiente",
    rendered: 0, policyStatus: "activa", isRivadavia: true, policyType: "automotor", parentPolicyId: null,
    description: null, manualPayer: null, manualPolicyNumber: null, manualCompany: null, ...o,
  } as BatchItemContext);

  test("N pólizas Rivadavia → N × $900 en todos los recorridos; otras compañías $0", () => {
    const contexts = [
      ctx({ installmentId: 1, policyId: 10 }), ctx({ installmentId: 2, policyId: 20 }),
      ctx({ installmentId: 3, policyId: 30, isRivadavia: false }),
    ];
    // Lote común (backend)
    const applicable = calculateApplicableRivadaviaSurcharges(contexts, "own");
    expect(applicable.length * SURCHARGE_AMOUNT_CENTS).toBe(2 * 90000);
    // Lote con titular: destinos pronto_pago del plan de fondeo
    const titular = buildTitularFundingInput({
      contexts, displays: contexts.map(() => ({ insuredName: null, policyNumber: null, companyName: null })),
      applicableSurchargeContexts: new Set(applicable), splitsWithChecks: [],
    });
    const pp = titular.destinations.filter((d) => d.kind === "pronto_pago");
    expect(pp.map((d) => d.nominalCents)).toEqual([90000, 90000]);
    // Preview del carrito (frontend)
    const cart = [
      { kind: "installment", installmentId: 1, policyId: 10, companyName: "Rivadavia", policyType: "automotor", parentPolicyId: null },
      { kind: "installment", installmentId: 2, policyId: 20, companyName: "Rivadavia", policyType: "automotor", parentPolicyId: null },
      { kind: "installment", installmentId: 3, policyId: 30, companyName: "Otra", policyType: "automotor", parentPolicyId: null },
    ] as unknown as BatchCartItem[];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(2 * 90000);
  });

  test("pago individual con saldo: Rivadavia propio $900, directo $0, otra compañía $0", () => {
    expect(individualFundingSurchargeCents({ isRivadavia: true, applyProntoPagoSurcharge: true, splits: [{ method: "efectivo" }] })).toBe(90000);
    expect(individualFundingSurchargeCents({ isRivadavia: true, applyProntoPagoSurcharge: true, splits: [{ method: "transferencia_compania" }] })).toBe(0);
    expect(individualFundingSurchargeCents({ isRivadavia: false, applyProntoPagoSurcharge: true, splits: [{ method: "efectivo" }] })).toBe(0);
  });
});

describe("importes históricos ($800) no se recalculan", () => {
  test("PUT /payments sobre un pago con recargo histórico conserva $800", async () => {
    const r = await call("POST", "/payments", {
      policyId: await mkPolicy(rivadaviaCompanyId), amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    await makeHistorical(r.body.id);
    const put = await call("PUT", `/payments/${r.body.id}`, { applyProntoPagoSurcharge: true, notes: "editado", paymentDate: "2027-01-02" });
    expect(put.status).toBe(200);
    expect((await surchargesOf([r.body.id])).map((e) => e.amount)).toEqual([HISTORICAL_AMOUNT]);
    const list = await call("GET", "/payments");
    const row = (list.body as any[]).find((x) => x.payment.id === r.body.id);
    expect(row.payment.hasSurcharge).toBe(true);
    expect(row.payment.surchargeAmount).toBe(HISTORICAL_AMOUNT);
  });

  test("lote con recargo histórico: el importe guardado del lote y del cash_entry no cambia al leerlo", async () => {
    const inst = await mkInstallment(await mkPolicy(rivadaviaCompanyId), 1000);
    const r = await call("POST", "/payment-batches", {
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst }],
      splits: [{ method: "efectivo", amount: 1000 + 900 }],
    });
    expect(r.status).toBe(201);
    const child = (await childrenOf(r.body.id))[0]!;
    // Lote de antes del cambio: recargo $800 guardado en batch, split y cash_entry.
    await makeHistorical(child.id);
    await db.update(paymentBatches).set({ surchargeAmountCents: 80000, totalReceivedCents: 180000, receivedAmountCents: 180000 })
      .where(eq(paymentBatches.id, r.body.id));
    await db.update(paymentBatchSplits).set({ amountCents: 180000 }).where(eq(paymentBatchSplits.batchId, r.body.id));
    const get = await call("GET", `/payment-batches/${r.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body.batch.surchargeAmountCents).toBe(80000);
    expect(get.body.integrity.surchargeMatchesEntries).toBe(true);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, r.body.id)).get();
    expect(batch!.surchargeAmountCents).toBe(80000);
  });

  test("Caja suma el importe guardado ($800), no la constante vigente", async () => {
    const before = await cashSummary();
    const r = await call("POST", "/payments", {
      policyId: await mkPolicy(rivadaviaCompanyId), amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    await makeHistorical(r.body.id);
    const after = await cashSummary();
    expect(after.cartera.recargosProntoPago - before.cartera.recargosProntoPago).toBe(HISTORICAL_AMOUNT);
  });

  test("rendición Pronto Pago: pendiente expone $800 guardado, y la rendición mezcla histórico $800 + nuevo $900", async () => {
    const hist = await call("POST", "/payments", {
      policyId: await mkPolicy(rivadaviaCompanyId), amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    await makeHistorical(hist.body.id);
    const nuevo = await call("POST", "/payments", {
      policyId: await mkPolicy(rivadaviaCompanyId), amount: 500, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });

    const pending = await call("GET", "/remittances/pending");
    const byId = new Map((pending.body as any[]).filter((i) => i.source === "payment").map((i) => [i.sourceId, i]));
    expect(byId.get(hist.body.id).surchargeAmount).toBe(HISTORICAL_AMOUNT);
    expect(byId.get(nuevo.body.id).surchargeAmount).toBe(900);

    const rem = await call("POST", "/remittances", {
      date: "2027-01-02", canal: "pronto_pago",
      paymentBreakdown: { efectivo: 1000 + 500 + HISTORICAL_AMOUNT + 900 },
      prontoPagoSurcharge: SURCHARGE_AMOUNT,
      items: [
        { source: "payment", sourceId: hist.body.id, amount: 1000, debtorStatus: "pagado" },
        { source: "payment", sourceId: nuevo.body.id, amount: 500, debtorStatus: "pagado" },
      ],
    });
    expect(rem.status).toBe(200);
    const remRow = await db.select().from(remittances).where(eq(remittances.id, rem.body.id)).get();
    expect(remRow!.totalAmount).toBe(1000 + 500 + HISTORICAL_AMOUNT + 900);
    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, rem.body.id)).all();
    expect(items.filter((i) => i.source === "cash_entry").map((i) => i.amount).sort()).toEqual([HISTORICAL_AMOUNT, 900]);
  });

  test("rendición con canal distinto de Pronto Pago → no suma recargo", async () => {
    const r = await call("POST", "/payments", {
      policyId: await mkPolicy(rivadaviaCompanyId), amount: 700, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    const rem = await call("POST", "/remittances", {
      date: "2027-01-02", canal: "directo",
      paymentBreakdown: { efectivo: 700 },
      prontoPagoSurcharge: 0,
      items: [{ source: "payment", sourceId: r.body.id, amount: 700, debtorStatus: "pagado" }],
    });
    expect(rem.status).toBe(200);
    const remRow = await db.select().from(remittances).where(eq(remittances.id, rem.body.id)).get();
    expect(remRow!.totalAmount).toBe(700);
    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, rem.body.id)).all();
    expect(items.filter((i) => i.source === "cash_entry")).toEqual([]);
  });

  test("deuda manual Rivadavia en rendición nueva → $900 vigente", async () => {
    const rem = await call("POST", "/remittances", {
      date: "2027-01-02", canal: "pronto_pago",
      paymentBreakdown: { efectivo: 300 + 900 },
      items: [{
        source: "manual_debt", sourceId: null, amount: 300, debtorStatus: "adeudado",
        clientName: "Deudor", policyNumber: `${PREFIX}-MAN`, companyName: "Rivadavia",
      }],
    });
    expect(rem.status).toBe(200);
    const remRow = await db.select().from(remittances).where(eq(remittances.id, rem.body.id)).get();
    expect(remRow!.totalAmount).toBe(300 + 900);
  });
});
