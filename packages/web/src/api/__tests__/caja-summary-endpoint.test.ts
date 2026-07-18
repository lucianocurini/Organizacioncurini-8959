/**
 * Tests de GET /api/cash/summary (Caja) adaptado a remittance_allocations.
 * Corre exclusivamente contra dev.db local (nunca Turso). Como el endpoint
 * agrega TODAS las filas de las tablas involucradas (no está scopeado por
 * usuario), cada test toma un snapshot antes/después y compara la DIFERENCIA
 * — nunca un valor absoluto — para no depender de qué otros datos ya existen
 * en dev.db. Mismo estilo de fixtures aisladas por prefijo que
 * remittance-allocations-endpoints.test.ts / payment-batches.test.ts.
 *
 * Limpieza determinista: cada test borra sus propias filas (identificadas
 * por SESSION_ID/USER_EMAIL/PREFIX únicos de este archivo) en un bloque
 * finally, hijos antes que padres, y ningún delete ignora errores — un
 * SQLITE_BUSY/SQLITE_LOCKED se reintenta un número acotado de veces; una FK
 * u otro error hace fallar el test en lugar de dejar una fila huérfana sin
 * que nadie se entere.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, insureds, companies, policies, policyInstallments,
  payments, paymentSplits, paymentBatches, paymentBatchSplits, receivedChecks,
  cashEntries, cashExpenses, commissionEntries, ownMoneyMovements, cashDebts,
  remittances, remittanceItems, remittanceAllocations,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-caja-summary-001";
const USER_EMAIL = "test-caja-summary@test.local";
const PREFIX = "TEST-CAJA-SUMMARY";
const FIXTURE_DATE = "2027-06-01"; // lejos del mes/año actual — no afecta comisionesMes/gastosMes/comisionesAnio

let userId: number;
let insuredId: number;
let companyId: number;

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function getSummary(query = ""): Promise<{ status: number; body: any }> {
  const res = await app.fetch(new Request(`http://localhost/api/cash/summary${query}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

async function callPostRemittance(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/remittances", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

async function callPostBatch(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

async function callCollectItem(itemId: number, body: Record<string, any> = {}) {
  const res = await app.fetch(new Request(`http://localhost/api/remittances/items/${itemId}/collect`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

// ─── Borrado determinista (nunca silencioso) ───────────────────────────────
//
// Solo SQLITE_BUSY/SQLITE_LOCKED son transitorios y ameritan reintento (con
// límite corto). Cualquier otro error (FK constraint, sintaxis, lo que sea)
// se propaga: un test cuyo cleanup no puede completarse debe fallar, nunca
// dejar la fila huérfana en silencio.
const RETRYABLE_SQLITE_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);
const MAX_DELETE_ATTEMPTS = 5;

async function deleteWithRetry(op: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await op();
      return;
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code;
      if (RETRYABLE_SQLITE_CODES.has(code) && attempt < MAX_DELETE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ─── Fixture builders (inserts directos) ───────────────────────────────────

async function mkStandalonePayment(params: { amount: number; splits: { method: string; amountCents: number }[]; rendered?: number }) {
  const [p] = await db.insert(payments).values({
    amount: params.amount, paymentMethod: params.splits.length > 1 ? "combinado" : params.splits[0]!.method,
    paymentDate: FIXTURE_DATE, status: "confirmado", rendered: params.rendered ?? 0, createdBy: userId,
  }).returning({ id: payments.id });
  const splitIds: number[] = [];
  for (const s of params.splits) {
    const [row] = await db.insert(paymentSplits).values({ paymentId: p!.id, method: s.method, amountCents: s.amountCents }).returning({ id: paymentSplits.id });
    splitIds.push(row!.id);
  }
  return { paymentId: p!.id, splitIds };
}

async function mkCashEntry(params: { amount: number; method: string; entryType?: string; paymentId?: number; rendered?: number; paymentDate?: string }) {
  const [e] = await db.insert(cashEntries).values({
    clientName: `${PREFIX} Cliente`, amount: params.amount, paymentMethod: params.method,
    paymentDate: params.paymentDate ?? FIXTURE_DATE, entryType: params.entryType ?? "normal",
    paymentId: params.paymentId ?? null, rendered: params.rendered ?? 0, createdBy: userId,
  }).returning({ id: cashEntries.id });
  return e!.id as number;
}

interface MkBatchSplit { method: string; amountCents: number; checks?: { amountCents: number }[] }
async function mkBatch(params: {
  baseAmountCents: number; surchargeAmountCents?: number; splits: MkBatchSplit[];
  childrenCount: number; childRendered?: number; status?: string;
}) {
  const surcharge = params.surchargeAmountCents ?? 0;
  const total = params.baseAmountCents + surcharge;
  const [b] = await db.insert(paymentBatches).values({
    insuredId, baseAmountCents: params.baseAmountCents, surchargeAmountCents: surcharge, totalReceivedCents: total,
    paymentDate: FIXTURE_DATE, status: params.status ?? "confirmado", createdBy: userId,
  }).returning({ id: paymentBatches.id });
  const batchId = b!.id;

  const childIds: number[] = [];
  const perChildAmount = params.baseAmountCents / params.childrenCount / 100;
  for (let i = 0; i < params.childrenCount; i++) {
    const [child] = await db.insert(payments).values({
      amount: perChildAmount, paymentMethod: "lote", paymentDate: FIXTURE_DATE, status: "confirmado",
      rendered: params.childRendered ?? 0, createdBy: userId, batchId,
    }).returning({ id: payments.id });
    childIds.push(child!.id);
  }

  const splitIds: number[] = [];
  for (const s of params.splits) {
    const [split] = await db.insert(paymentBatchSplits).values({ batchId, method: s.method, amountCents: s.amountCents }).returning({ id: paymentBatchSplits.id });
    splitIds.push(split!.id);
    if (s.checks) {
      for (const chk of s.checks) {
        await db.insert(receivedChecks).values({
          batchSplitId: split!.id,
          checkNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          bankName: "Banco Test", dueDate: "2027-07-01", amountCents: chk.amountCents, status: "en_cartera",
          receivedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), createdBy: userId,
        });
      }
    }
  }
  return { batchId, childIds, splitIds };
}

async function cleanupPayment(paymentId: number) {
  await deleteWithRetry(() => db.delete(cashEntries).where(eq(cashEntries.paymentId, paymentId)));
  await deleteWithRetry(() => db.delete(paymentSplits).where(eq(paymentSplits.paymentId, paymentId)));
  await deleteWithRetry(() => db.delete(payments).where(eq(payments.id, paymentId)));
}

async function cleanupCashEntry(id: number) {
  await deleteWithRetry(() => db.delete(cashEntries).where(eq(cashEntries.id, id)));
}

async function cleanupCashDebt(id: number) {
  await deleteWithRetry(() => db.delete(cashDebts).where(eq(cashDebts.id, id)));
}

async function cleanupBatch(batchId: number) {
  const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, batchId)).all();
  const splitIds = splitRows.map((s) => s.id);
  if (splitIds.length) await deleteWithRetry(() => db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)));
  const childRows = await db.select({ id: payments.id }).from(payments).where(eq(payments.batchId, batchId)).all();
  const childIds = childRows.map((c) => c.id);
  if (childIds.length) await deleteWithRetry(() => db.delete(cashEntries).where(inArray(cashEntries.paymentId, childIds)));
  await deleteWithRetry(() => db.delete(payments).where(eq(payments.batchId, batchId)));
  await deleteWithRetry(() => db.delete(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, batchId)));
  await deleteWithRetry(() => db.delete(paymentBatches).where(eq(paymentBatches.id, batchId)));
}

async function cleanupRemittance(id: number) {
  await deleteWithRetry(() => db.delete(remittanceAllocations).where(eq(remittanceAllocations.remittanceId, id)));
  await deleteWithRetry(() => db.delete(remittanceItems).where(eq(remittanceItems.remittanceId, id)));
  await deleteWithRetry(() => db.delete(remittances).where(eq(remittances.id, id)));
}

// Purga cualquier residuo de una corrida anterior de ESTE archivo (mismo
// email/prefijo únicos) antes de crear el fixture del usuario, en orden
// hijos->padres (remittance_allocations referencia payments/paymentBatches/
// cashEntries directamente, así que las rendiciones se limpian primero).
async function purgeStaleFixturesFor(prevUserId: number) {
  const staleRemittances = await db.select({ id: remittances.id }).from(remittances).where(eq(remittances.createdBy, prevUserId)).all();
  for (const r of staleRemittances) await cleanupRemittance(r.id);

  const staleBatches = await db.select({ id: paymentBatches.id }).from(paymentBatches).where(eq(paymentBatches.createdBy, prevUserId)).all();
  for (const b of staleBatches) await cleanupBatch(b.id);

  const stalePayments = await db.select({ id: payments.id }).from(payments).where(eq(payments.createdBy, prevUserId)).all();
  for (const p of stalePayments) await cleanupPayment(p.id);

  const staleCashEntries = await db.select({ id: cashEntries.id }).from(cashEntries).where(eq(cashEntries.createdBy, prevUserId)).all();
  for (const e of staleCashEntries) await cleanupCashEntry(e.id);

  const staleCashDebts = await db.select({ id: cashDebts.id }).from(cashDebts).where(eq(cashDebts.createdBy, prevUserId)).all();
  for (const d of staleCashDebts) await cleanupCashDebt(d.id);

  // insureds.created_by referencia users.id — debe borrarse antes que el
  // usuario, si no, el delete de users revienta con FOREIGN KEY constraint.
  const staleInsureds = await db.select({ id: insureds.id }).from(insureds).where(eq(insureds.createdBy, prevUserId)).all();
  for (const i of staleInsureds) await deleteWithRetry(() => db.delete(insureds).where(eq(insureds.id, i.id)));

  await deleteWithRetry(() => db.delete(sessions).where(eq(sessions.userId, prevUserId)));
  await deleteWithRetry(() => db.delete(users).where(eq(users.id, prevUserId)));
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) await purgeStaleFixturesFor(prevUser.id);

  // Segunda red de contención: por si el asegurado quedó huérfano de un
  // usuario ya eliminado en una corrida previa (createdBy no matchea).
  const prevInsured = await db.select({ id: insureds.id }).from(insureds).where(eq(insureds.name, `${PREFIX} Asegurado`)).get();
  if (prevInsured) await deleteWithRetry(() => db.delete(insureds).where(eq(insureds.id, prevInsured.id)));

  const [u] = await db.insert(users).values({
    name: "Test Caja Summary", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;
});

afterAll(async () => {
  // Orden obligatorio: insureds.created_by referencia users.id — borrar el
  // usuario antes que el asegurado revienta con FOREIGN KEY constraint
  // failed (bug real detectado al quitar el .catch(() => {}) silencioso que
  // lo venía ocultando en cada corrida).
  await deleteWithRetry(() => db.delete(sessions).where(eq(sessions.id, SESSION_ID)));
  await deleteWithRetry(() => db.delete(insureds).where(eq(insureds.id, insuredId)));
  await deleteWithRetry(() => db.delete(users).where(eq(users.id, userId)));

  // Limpieza completa: no debe quedar ninguna fila con nuestro prefijo/usuario.
  const leftoverPayments = await db.select({ id: payments.id }).from(payments).where(eq(payments.createdBy, userId)).all();
  const leftoverEntries = await db.select({ id: cashEntries.id }).from(cashEntries).where(eq(cashEntries.createdBy, userId)).all();
  const leftoverBatches = await db.select({ id: paymentBatches.id }).from(paymentBatches).where(eq(paymentBatches.createdBy, userId)).all();
  const leftoverRemittances = await db.select({ id: remittances.id }).from(remittances).where(eq(remittances.createdBy, userId)).all();
  const leftoverDebts = await db.select({ id: cashDebts.id }).from(cashDebts).where(eq(cashDebts.createdBy, userId)).all();
  expect(leftoverPayments.length).toBe(0);
  expect(leftoverEntries.length).toBe(0);
  expect(leftoverBatches.length).toBe(0);
  expect(leftoverRemittances.length).toBe(0);
  expect(leftoverDebts.length).toBe(0);
});

describe("GET /api/cash/summary — forma de la respuesta", () => {
  test("respuesta compatible con claves anteriores + nuevas claves del modelo de allocations", async () => {
    const { status, body } = await getSummary();
    expect(status).toBe(200);
    expect(body.cartera).toEqual(expect.objectContaining({
      efectivo: expect.any(Number), transferencia: expect.any(Number), cheque: expect.any(Number),
      recargosProntoPago: expect.any(Number), total: expect.any(Number),
    }));
    expect(body.directoCompania).toEqual(expect.objectContaining({
      transferencia_compania: expect.any(Number), link_pago: expect.any(Number), total: expect.any(Number),
    }));
    expect(body.cajaNeta).toBeDefined();
    expect(body.rendidoPorMetodo).toEqual(expect.objectContaining({
      efectivo: expect.any(Number), transferencia: expect.any(Number), cheque: expect.any(Number),
      pronto_pago: expect.any(Number), otros: expect.any(Number), total: expect.any(Number),
    }));
    expect(body.rendidoDirectoCompania).toEqual(expect.objectContaining({
      transferencia_compania: expect.any(Number), link_pago: expect.any(Number), total: expect.any(Number),
    }));
    expect(body.allocationsModel).toEqual(expect.objectContaining({
      remittancesLegacyCount: expect.any(Number),
      remittancesCompleteCount: expect.any(Number),
      remittancesZeroCollectedCount: expect.any(Number),
      inconsistencias: expect.any(Array),
      legacyUnknownMethods: expect.any(Object),
    }));
    expect(Array.isArray(body.carteraInconsistencias)).toBe(true);
    expect(body.totalCobrado).toEqual(expect.any(Number));
    expect(body.totalRendido).toEqual(expect.any(Number));
    expect(body.cajaPropia?.historico).toBeDefined();
  });
});

describe("GET /api/cash/summary — cartera pendiente", () => {
  test("pago simple pendiente", async () => {
    const before = (await getSummary()).body;
    const { paymentId } = await mkStandalonePayment({ amount: 1000, splits: [{ method: "efectivo", amountCents: 100000 }] });
    try {
      const after = (await getSummary()).body;
      expect(after.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(1000, 2);
      expect(after.cartera.total - before.cartera.total).toBeCloseTo(1000, 2);
    } finally {
      await cleanupPayment(paymentId);
    }
  });

  test("pago combinado pendiente — se reparte por método real", async () => {
    const before = (await getSummary()).body;
    const { paymentId } = await mkStandalonePayment({
      amount: 1500, splits: [{ method: "efectivo", amountCents: 100000 }, { method: "transferencia", amountCents: 50000 }],
    });
    try {
      const after = (await getSummary()).body;
      expect(after.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(1000, 2);
      expect(after.cartera.transferencia - before.cartera.transferencia).toBeCloseTo(500, 2);
    } finally {
      await cleanupPayment(paymentId);
    }
  });

  test("batch pendiente una sola vez — 2 hijos no duplican el total", async () => {
    const before = (await getSummary()).body;
    const { batchId } = await mkBatch({
      baseAmountCents: 200000, splits: [{ method: "efectivo", amountCents: 200000 }], childrenCount: 2,
    });
    try {
      const after = (await getSummary()).body;
      expect(after.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(2000, 2); // no 4000
    } finally {
      await cleanupBatch(batchId);
    }
  });

  // Etapa "rendición por cuota" (Migración 0029) — mandatorio: un batch con
  // un hijo ya rendido (a su compañía) y otro todavía no, YA NO es una
  // inconsistencia: la porción pendiente sigue en cartera, la rendida sale.
  test("batch parcialmente rendido — el hijo rendido sale de cartera, el pendiente queda, sin inconsistencia (cierra exacto)", async () => {
    const before = (await getSummary()).body;
    const { batchId, childIds } = await mkBatch({
      baseAmountCents: 200000, splits: [{ method: "efectivo", amountCents: 200000 }], childrenCount: 2,
    });
    try {
      // Un hijo ya fue rendido a su compañía (simulado directo, aislado del
      // flujo de POST /remittances que ya se cubre en
      // remittance-allocations-endpoints.test.ts) — el otro sigue pendiente.
      await db.update(payments).set({ rendered: 1, renderedAt: new Date() }).where(eq(payments.id, childIds[0]!));

      const after = (await getSummary()).body;
      // Antes de esta etapa esto se excluía por completo (delta 0, reportado
      // como inconsistencia). Ahora: la mitad todavía pendiente (1000 de los
      // 2000 originales) sigue en cartera, sin inconsistencia.
      expect(after.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(1000, 2);
      const newInconsistencies = (after.carteraInconsistencias as any[]).filter((i) => i.sourceId === batchId);
      expect(newInconsistencies.length).toBe(0);
    } finally {
      await cleanupBatch(batchId);
    }
  });

  test("batch con cheque — usa received_checks, se suma una sola vez", async () => {
    const before = (await getSummary()).body;
    const { batchId } = await mkBatch({
      baseAmountCents: 100000,
      splits: [{ method: "cheque", amountCents: 100000, checks: [{ amountCents: 60000 }, { amountCents: 40000 }] }],
      childrenCount: 1,
    });
    try {
      const after = (await getSummary()).body;
      expect(after.cartera.cheque - before.cartera.cheque).toBeCloseTo(1000, 2);
    } finally {
      await cleanupBatch(batchId);
    }
  });

  test("batch mixto real (cuota existente + cobro manual) — cuenta una sola vez, nunca por hijo", async () => {
    const before = (await getSummary()).body;

    const [policyReal] = await db.insert(policies).values({
      policyNumber: `${PREFIX}-REAL-${Date.now()}`, type: "automotor", status: "activa",
      companyId, insuredId, startDate: "2027-01-01", endDate: "2027-12-31", createdBy: userId,
    }).returning({ id: policies.id });
    const realPolicyId = policyReal!.id;
    const [instRow] = await db.insert(policyInstallments).values({
      policyId: realPolicyId, number: 1, dueDate: FIXTURE_DATE, amount: 700, status: "pendiente", rendered: 0,
    }).returning({ id: policyInstallments.id });
    const instId = instRow!.id;

    const [policyManual] = await db.insert(policies).values({
      policyNumber: `${PREFIX}-MANUAL-${Date.now()}`, type: "automotor", status: "activa",
      companyId, insuredId, startDate: "2027-01-01", endDate: "2027-12-31", createdBy: userId,
    }).returning({ id: policies.id });
    const manualPolicyId = policyManual!.id;

    const created = await callPostBatch({
      paymentDate: FIXTURE_DATE, insuredId,
      items: [
        { source: "installment", installmentId: instId },
        { source: "policy_manual_payment", policyId: manualPolicyId, amount: 300 },
      ],
      splits: [{ method: "efectivo", amount: 1000 }],
      applyProntoPagoSurcharge: false,
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;
    const childRows = await db.select().from(payments).where(eq(payments.batchId, batchId)).all();
    expect(childRows.length).toBe(2);

    try {
      // Cartera pendiente sube exactamente $1000 (700 cuota + 300 manual) una
      // sola vez — nunca se duplica por tener 2 payments hijos.
      const afterCreate = (await getSummary()).body;
      expect(afterCreate.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(1000, 2);
    } finally {
      await cleanupBatch(batchId);
      await deleteWithRetry(() => db.delete(policyInstallments).where(eq(policyInstallments.id, instId)));
      await deleteWithRetry(() => db.delete(policies).where(inArray(policies.id, [realPolicyId, manualPolicyId])));
    }
  });

  test("batch 100% imputación manual libre (sin ninguna póliza real) — cuenta como dinero real, una sola vez", async () => {
    const before = (await getSummary()).body;
    const created = await callPostBatch({
      paymentDate: FIXTURE_DATE, insuredId,
      items: [{ source: "manual_payment", manualPayer: `${PREFIX} Cliente libre`, amount: 650 }],
      splits: [{ method: "efectivo", amount: 650 }],
      applyProntoPagoSurcharge: false,
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;
    try {
      const after = (await getSummary()).body;
      expect(after.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(650, 2);
    } finally {
      await cleanupBatch(batchId);
    }
  });

  test("recargo Pronto Pago standalone — categoría separada", async () => {
    const before = (await getSummary()).body;
    const { paymentId } = await mkStandalonePayment({ amount: 1000, splits: [{ method: "efectivo", amountCents: 100000 }] });
    let surchargeId: number | undefined;
    try {
      surchargeId = await mkCashEntry({ amount: 800, method: "efectivo", entryType: "pronto_pago_surcharge", paymentId });
      const after = (await getSummary()).body;
      expect(after.cartera.recargosProntoPago - before.cartera.recargosProntoPago).toBeCloseTo(800, 2);
      expect(after.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(1000, 2); // no incluye el recargo
    } finally {
      if (surchargeId !== undefined) await cleanupCashEntry(surchargeId);
      await cleanupPayment(paymentId);
    }
  });

  test("recargo Pronto Pago dentro de batch — no se duplica (ya está en el split)", async () => {
    const before = (await getSummary()).body;
    // Split ya incluye base + recargo mezclados ($1000 + $8 = $1008), como en un cobro real.
    const { batchId, childIds } = await mkBatch({
      baseAmountCents: 100000, surchargeAmountCents: 800,
      splits: [{ method: "efectivo", amountCents: 100800 }], childrenCount: 1,
    });
    let surchargeId: number | undefined;
    try {
      surchargeId = await mkCashEntry({ amount: 8, method: "lote", entryType: "pronto_pago_surcharge", paymentId: childIds[0]! });
      const after = (await getSummary()).body;
      expect(after.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(1008, 2);
      expect(after.cartera.recargosProntoPago - before.cartera.recargosProntoPago).toBeCloseTo(0, 2);
    } finally {
      if (surchargeId !== undefined) await cleanupCashEntry(surchargeId);
      await cleanupBatch(batchId);
    }
  });

  test("transferencia_compania y link_pago — van a directoCompania, no a cartera", async () => {
    const before = (await getSummary()).body;
    const { paymentId: p1 } = await mkStandalonePayment({ amount: 300, splits: [{ method: "transferencia_compania", amountCents: 30000 }] });
    let p2: number | undefined;
    try {
      const r2 = await mkStandalonePayment({ amount: 400, splits: [{ method: "link_pago", amountCents: 40000 }] });
      p2 = r2.paymentId;
      const after = (await getSummary()).body;
      expect(after.directoCompania.transferencia_compania - before.directoCompania.transferencia_compania).toBeCloseTo(300, 2);
      expect(after.directoCompania.link_pago - before.directoCompania.link_pago).toBeCloseTo(400, 2);
      expect(after.cartera.total - before.cartera.total).toBeCloseTo(0, 2);
    } finally {
      if (p2 !== undefined) await cleanupPayment(p2);
      await cleanupPayment(p1);
    }
  });
});

describe("GET /api/cash/summary — rendido por método", () => {
  test("rendición legacy (sin allocations, con dinero real) — usa paymentBreakdown", async () => {
    const before = (await getSummary()).body;
    const { paymentId } = await mkStandalonePayment({ amount: 1200, splits: [{ method: "efectivo", amountCents: 120000 }], rendered: 1 });
    let remId: number | undefined;
    try {
      const [rem] = await db.insert(remittances).values({
        date: FIXTURE_DATE, canal: "directo", paymentBreakdown: JSON.stringify({ efectivo: 1200 }),
        totalAmount: 1200, totalPaid: 1200, status: "confirmada", createdBy: userId,
      }).returning({ id: remittances.id });
      remId = rem!.id;
      await db.insert(remittanceItems).values({
        remittanceId: remId, source: "payment", sourceId: paymentId, amount: 1200, debtorStatus: "pagado",
      });
      const after = (await getSummary()).body;

      expect(after.allocationsModel.remittancesLegacyCount - before.allocationsModel.remittancesLegacyCount).toBe(1);
      expect(after.rendidoPorMetodo.efectivo - before.rendidoPorMetodo.efectivo).toBeCloseTo(1200, 2);
    } finally {
      if (remId !== undefined) await cleanupRemittance(remId);
      await cleanupPayment(paymentId);
    }
  });

  test("rendición nueva con allocations (vía POST real) — usa remittance_allocations", async () => {
    const before = (await getSummary()).body;
    const { paymentId } = await mkStandalonePayment({ amount: 900, splits: [{ method: "transferencia", amountCents: 90000 }] });
    let remId: number | undefined;
    try {
      const res = await callPostRemittance({
        date: FIXTURE_DATE, canal: "directo", paymentBreakdown: { transferencia: 900 },
        items: [{ source: "payment", sourceId: paymentId, amount: 900, paymentMethod: "transferencia" }],
      });
      expect(res.status).toBe(200);
      remId = res.body.id;
      const after = (await getSummary()).body;

      expect(after.allocationsModel.remittancesCompleteCount - before.allocationsModel.remittancesCompleteCount).toBe(1);
      expect(after.rendidoPorMetodo.transferencia - before.rendidoPorMetodo.transferencia).toBeCloseTo(900, 2);
    } finally {
      if (remId !== undefined) await cleanupRemittance(remId);
      await cleanupPayment(paymentId);
    }
  });

  test("batch mixto real (cuota + cobro manual) rendido — sale de cartera pendiente, entra a rendido una sola vez", async () => {
    const before = (await getSummary()).body;

    const [policyReal] = await db.insert(policies).values({
      policyNumber: `${PREFIX}-REND-REAL-${Date.now()}`, type: "automotor", status: "activa",
      companyId, insuredId, startDate: "2027-01-01", endDate: "2027-12-31", createdBy: userId,
    }).returning({ id: policies.id });
    const realPolicyId = policyReal!.id;
    const [instRow] = await db.insert(policyInstallments).values({
      policyId: realPolicyId, number: 1, dueDate: FIXTURE_DATE, amount: 700, status: "pendiente", rendered: 0,
    }).returning({ id: policyInstallments.id });
    const instId = instRow!.id;

    const [policyManual] = await db.insert(policies).values({
      policyNumber: `${PREFIX}-REND-MANUAL-${Date.now()}`, type: "automotor", status: "activa",
      companyId, insuredId, startDate: "2027-01-01", endDate: "2027-12-31", createdBy: userId,
    }).returning({ id: policies.id });
    const manualPolicyId = policyManual!.id;

    const created = await callPostBatch({
      paymentDate: FIXTURE_DATE, insuredId,
      items: [
        { source: "installment", installmentId: instId },
        { source: "policy_manual_payment", policyId: manualPolicyId, amount: 300 },
      ],
      splits: [{ method: "efectivo", amount: 1000 }],
      applyProntoPagoSurcharge: false,
    });
    expect(created.status).toBe(201);
    const batchId = created.body.id as number;
    const childRows = await db.select().from(payments).where(eq(payments.batchId, batchId)).all();

    let remId: number | undefined;
    try {
      const res = await callPostRemittance({
        date: FIXTURE_DATE, canal: "directo", paymentBreakdown: { efectivo: 1000 },
        items: childRows.map((c) => ({ source: "payment", sourceId: c.id, amount: c.amount, paymentMethod: "efectivo" })),
      });
      expect(res.status).toBe(200);
      remId = res.body.id;

      const after = (await getSummary()).body;
      // Salió de cartera pendiente (diferencia neta 0 contra el snapshot inicial)...
      expect(after.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(0, 2);
      // ...y entró en rendido por método, una sola vez (no 700 + 300 duplicado por hijo).
      expect(after.rendidoPorMetodo.efectivo - before.rendidoPorMetodo.efectivo).toBeCloseTo(1000, 2);
      expect(after.allocationsModel.remittancesCompleteCount - before.allocationsModel.remittancesCompleteCount).toBe(1);
    } finally {
      if (remId !== undefined) await cleanupRemittance(remId);
      await cleanupBatch(batchId);
      await deleteWithRetry(() => db.delete(policyInstallments).where(eq(policyInstallments.id, instId)));
      await deleteWithRetry(() => db.delete(policies).where(inArray(policies.id, [realPolicyId, manualPolicyId])));
    }
  });

  test("rendición con allocations inconsistentes — excluida de los totales, reportada", async () => {
    const before = (await getSummary()).body;
    const { paymentId, splitIds } = await mkStandalonePayment({ amount: 1000, splits: [{ method: "efectivo", amountCents: 100000 }], rendered: 1 });
    let remId: number | undefined;
    try {
      const [rem] = await db.insert(remittances).values({
        date: FIXTURE_DATE, canal: "directo", paymentBreakdown: JSON.stringify({ efectivo: 900 }),
        totalAmount: 900, totalPaid: 900, status: "confirmada", createdBy: userId,
      }).returning({ id: remittances.id });
      remId = rem!.id;
      const [item] = await db.insert(remittanceItems).values({
        remittanceId: remId, source: "payment", sourceId: paymentId, amount: 1000, debtorStatus: "pagado",
      }).returning({ id: remittanceItems.id });
      // Allocation deliberadamente corrupta: suma $900 contra un pago real de $1000.
      await db.insert(remittanceAllocations).values({
        remittanceId: remId, remittanceItemId: item!.id, paymentId, paymentSplitId: splitIds[0]!,
        method: "efectivo", amountCents: 90000, createdAt: new Date(),
      });
      const after = (await getSummary()).body;

      const newInconsistencies = after.allocationsModel.inconsistencias.filter((i: any) => i.remittanceId === remId);
      expect(newInconsistencies.length).toBe(1);
      expect(newInconsistencies[0].allocationSumCents).toBe(90000);
      expect(newInconsistencies[0].expectedCollectedCents).toBe(100000);
      // No debe haberse sumado a los totales de rendido.
      expect(after.rendidoPorMetodo.efectivo - before.rendidoPorMetodo.efectivo).toBeCloseTo(0, 2);
    } finally {
      if (remId !== undefined) await cleanupRemittance(remId);
      await cleanupPayment(paymentId);
    }
  });

  test("rendición nueva solo con deuda/no cobrada — expected=0/allocations=0 no contamina totales", async () => {
    const before = (await getSummary()).body;
    let remId: number | undefined;
    try {
      const [rem] = await db.insert(remittances).values({
        date: FIXTURE_DATE, canal: "directo", paymentBreakdown: "{}",
        totalAmount: 500, totalPaid: 0, status: "confirmada", createdBy: userId,
      }).returning({ id: remittances.id });
      remId = rem!.id;
      await db.insert(remittanceItems).values({
        remittanceId: remId, source: "manual_debt", sourceId: null, amount: 500, debtorStatus: "adeudado",
      });
      const after = (await getSummary()).body;

      expect(after.allocationsModel.remittancesZeroCollectedCount - before.allocationsModel.remittancesZeroCollectedCount).toBe(1);
      expect(after.rendidoPorMetodo.total - before.rendidoPorMetodo.total).toBeCloseTo(0, 2);
      expect(after.rendidoDirectoCompania.total - before.rendidoDirectoCompania.total).toBeCloseTo(0, 2);
    } finally {
      if (remId !== undefined) await cleanupRemittance(remId);
    }
  });
});

describe("GET /api/cash/summary — filtros por fecha", () => {
  test("periodo.cobrado solo incluye movimientos dentro del rango", async () => {
    const inRangeId = await mkCashEntry({ amount: 111, method: "efectivo", paymentDate: "2027-08-15" });
    let outOfRangeId: number | undefined;
    try {
      outOfRangeId = await mkCashEntry({ amount: 222, method: "efectivo", paymentDate: "2027-09-15" });
      const { body } = await getSummary("?from=2027-08-01&to=2027-08-31");

      expect(body.periodo).not.toBeNull();
      expect(body.periodo.from).toBe("2027-08-01");
      expect(body.periodo.to).toBe("2027-08-31");
      // No aserta el valor absoluto (dev.db puede tener otros datos en el rango)
      // — solo que el filtro efectivamente acota (no explota, formato correcto).
      expect(typeof body.periodo.cobrado).toBe("number");
    } finally {
      if (outOfRangeId !== undefined) await cleanupCashEntry(outOfRangeId);
      await cleanupCashEntry(inRangeId);
    }
  });

  test("?month=YYYY-MM inválido devuelve 400", async () => {
    const res = await app.fetch(new Request("http://localhost/api/cash/summary?month=2027-13", { headers: authHeaders() }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/cash/summary — sin regresión en gastos/comisiones/dinero propio", () => {
  test("gastos, comisiones y movimientos propios siguen sumando igual que antes", async () => {
    const before = (await getSummary()).body;
    let expId: number | undefined;
    let commId: number | undefined;
    let ownId: number | undefined;
    try {
      const [exp] = await db.insert(cashExpenses).values({
        date: FIXTURE_DATE, description: `${PREFIX} gasto`, amount: 555, type: "gasto_operativo",
        paymentMethod: "efectivo", status: "registrado", createdBy: userId,
      }).returning({ id: cashExpenses.id });
      expId = exp!.id;
      const [comm] = await db.insert(commissionEntries).values({
        date: FIXTURE_DATE, amount: 333, paymentMethod: "transferencia", status: "registrado", createdBy: userId,
      }).returning({ id: commissionEntries.id });
      commId = comm!.id;
      const [own] = await db.insert(ownMoneyMovements).values({
        type: "aporte", date: FIXTURE_DATE, amount: 777, paymentMethod: "efectivo", status: "registrado", createdBy: userId,
      }).returning({ id: ownMoneyMovements.id });
      ownId = own!.id;

      const after = (await getSummary()).body;

      expect(after.totalGastos - before.totalGastos).toBeCloseTo(555, 2);
      expect(after.cajaPropia.historico.comisiones - before.cajaPropia.historico.comisiones).toBeCloseTo(333, 2);
      expect(after.cajaPropia.historico.aportes - before.cajaPropia.historico.aportes).toBeCloseTo(777, 2);
      expect(after.cajaPropia.historico.gastosOperativos - before.cajaPropia.historico.gastosOperativos).toBeCloseTo(555, 2);
    } finally {
      if (ownId !== undefined) await deleteWithRetry(() => db.delete(ownMoneyMovements).where(eq(ownMoneyMovements.id, ownId!)));
      if (commId !== undefined) await deleteWithRetry(() => db.delete(commissionEntries).where(eq(commissionEntries.id, commId!)));
      if (expId !== undefined) await deleteWithRetry(() => db.delete(cashExpenses).where(eq(cashExpenses.id, expId!)));
    }
  });
});

describe("GET /api/cash/summary — adeudadosDetalle", () => {
  test("manual_debt pendiente (adeudado, sin paidAt) aparece con origen 'manual_debt'", async () => {
    const before = (await getSummary()).body;
    const [rem] = await db.insert(remittances).values({
      date: FIXTURE_DATE, canal: "directo", paymentBreakdown: "{}",
      totalAmount: 700, totalPaid: 0, status: "confirmada", createdBy: userId,
    }).returning({ id: remittances.id });
    const remId = rem!.id;
    try {
      await db.insert(remittanceItems).values({
        remittanceId: remId, source: "manual_debt", sourceId: null, amount: 700, debtorStatus: "adeudado",
        clientName: `${PREFIX} Deudor Manual`, policyNumber: `${PREFIX}-POL-1`, companyName: `${PREFIX} Cía`,
      });
      const after = (await getSummary()).body;

      const newItems = after.adeudadosDetalle.filter((i: any) => !before.adeudadosDetalle.some((b: any) => b.id === i.id && b.origen === i.origen));
      expect(newItems.length).toBe(1);
      expect(newItems[0].origen).toBe("manual_debt");
      expect(newItems[0].deudor).toBe(`${PREFIX} Deudor Manual`);
      expect(newItems[0].polizaODescripcion).toBe(`${PREFIX}-POL-1`);
      expect(newItems[0].compania).toBe(`${PREFIX} Cía`);
      expect(newItems[0].importe).toBeCloseTo(700, 2);
      expect(newItems[0].estado).toBe("pendiente");
      expect(after.totalAdeudadoRendiciones - before.totalAdeudadoRendiciones).toBeCloseTo(700, 2);
    } finally {
      await cleanupRemittance(remId);
    }
  });

  test("installment pendiente (adeudado, sin paidAt) aparece con origen 'installment'", async () => {
    const before = (await getSummary()).body;
    const { paymentId } = await mkStandalonePayment({ amount: 400, splits: [{ method: "efectivo", amountCents: 40000 }], rendered: 1 });
    const [rem] = await db.insert(remittances).values({
      date: FIXTURE_DATE, canal: "directo", paymentBreakdown: "{}",
      totalAmount: 400, totalPaid: 400, status: "confirmada", createdBy: userId,
    }).returning({ id: remittances.id });
    const remId = rem!.id;
    try {
      // source='installment' representa una cuota rendida marcada como no
      // pagada por el asegurado — no requiere sourceId real para este test
      // (la clasificación de origen depende solo de la columna source).
      await db.insert(remittanceItems).values({
        remittanceId: remId, source: "installment", sourceId: null, amount: 400, debtorStatus: "adeudado",
        clientName: `${PREFIX} Deudor Cuota`, policyNumber: `${PREFIX}-POL-2`, companyName: `${PREFIX} Cía`,
      });
      const after = (await getSummary()).body;

      const newItems = after.adeudadosDetalle.filter((i: any) => !before.adeudadosDetalle.some((b: any) => b.id === i.id && b.origen === i.origen));
      expect(newItems.length).toBe(1);
      expect(newItems[0].origen).toBe("installment");
      expect(newItems[0].deudor).toBe(`${PREFIX} Deudor Cuota`);
    } finally {
      await cleanupRemittance(remId);
      await cleanupPayment(paymentId);
    }
  });

  test("adeudado con paidAt seteado NO aparece en el detalle", async () => {
    const before = (await getSummary()).body;
    const [rem] = await db.insert(remittances).values({
      date: FIXTURE_DATE, canal: "directo", paymentBreakdown: "{}",
      totalAmount: 300, totalPaid: 0, status: "confirmada", createdBy: userId,
    }).returning({ id: remittances.id });
    const remId = rem!.id;
    try {
      await db.insert(remittanceItems).values({
        remittanceId: remId, source: "manual_debt", sourceId: null, amount: 300, debtorStatus: "adeudado",
        clientName: `${PREFIX} Ya Pagado`, paidAt: new Date(),
      });
      const after = (await getSummary()).body;

      expect(after.adeudadosDetalle.some((i: any) => i.deudor === `${PREFIX} Ya Pagado`)).toBe(false);
      expect(after.totalAdeudadoRendiciones - before.totalAdeudadoRendiciones).toBeCloseTo(0, 2);
    } finally {
      await cleanupRemittance(remId);
    }
  });

  test("item con debtorStatus distinto de 'adeudado' (pagado) NO aparece en el detalle", async () => {
    const before = (await getSummary()).body;
    const { paymentId } = await mkStandalonePayment({ amount: 250, splits: [{ method: "efectivo", amountCents: 25000 }], rendered: 1 });
    const [rem] = await db.insert(remittances).values({
      date: FIXTURE_DATE, canal: "directo", paymentBreakdown: JSON.stringify({ efectivo: 250 }),
      totalAmount: 250, totalPaid: 250, status: "confirmada", createdBy: userId,
    }).returning({ id: remittances.id });
    const remId = rem!.id;
    try {
      await db.insert(remittanceItems).values({
        remittanceId: remId, source: "payment", sourceId: paymentId, amount: 250, debtorStatus: "pagado",
        clientName: `${PREFIX} Pagado OK`,
      });
      const after = (await getSummary()).body;

      expect(after.adeudadosDetalle.some((i: any) => i.deudor === `${PREFIX} Pagado OK`)).toBe(false);
    } finally {
      await cleanupRemittance(remId);
      await cleanupPayment(paymentId);
    }
  });

  test("cash_debt legacy pendiente aparece con origen 'cash_debt_legacy'", async () => {
    const before = (await getSummary()).body;
    const [debt] = await db.insert(cashDebts).values({
      clientName: `${PREFIX} Deuda Legacy`, policyNumber: `${PREFIX}-POL-3`, companyName: `${PREFIX} Cía`,
      amount: 850, status: "pendiente", createdBy: userId, createdAt: new Date(),
    }).returning({ id: cashDebts.id });
    const debtId = debt!.id;
    try {
      const after = (await getSummary()).body;

      const newItems = after.adeudadosDetalle.filter((i: any) => !before.adeudadosDetalle.some((b: any) => b.id === i.id && b.origen === i.origen));
      expect(newItems.length).toBe(1);
      expect(newItems[0].origen).toBe("cash_debt_legacy");
      expect(newItems[0].deudor).toBe(`${PREFIX} Deuda Legacy`);
      expect(newItems[0].importe).toBeCloseTo(850, 2);
      expect(after.totalAdeudadoLegacy - before.totalAdeudadoLegacy).toBeCloseTo(850, 2);
    } finally {
      await cleanupCashDebt(debtId);
    }
  });

  test("cash_debt legacy con status='cobrado' NO aparece en el detalle", async () => {
    const before = (await getSummary()).body;
    const [debt] = await db.insert(cashDebts).values({
      clientName: `${PREFIX} Deuda Ya Cobrada`, status: "cobrado", amount: 400, createdBy: userId, createdAt: new Date(),
    }).returning({ id: cashDebts.id });
    const debtId = debt!.id;
    try {
      const after = (await getSummary()).body;

      expect(after.adeudadosDetalle.some((i: any) => i.deudor === `${PREFIX} Deuda Ya Cobrada`)).toBe(false);
      expect(after.totalAdeudadoLegacy - before.totalAdeudadoLegacy).toBeCloseTo(0, 2);
    } finally {
      await cleanupCashDebt(debtId);
    }
  });

  test("sin ningún adeudado activo, adeudadosDetalle sigue siendo un array (puede ser vacío)", async () => {
    const { status, body } = await getSummary();
    expect(status).toBe(200);
    expect(Array.isArray(body.adeudadosDetalle)).toBe(true);
  });

  test("SUM(adeudadosDetalle.importe) === totalAdeudado (en centavos, con las 3 fuentes mezcladas)", async () => {
    const { paymentId } = await mkStandalonePayment({ amount: 111.11, splits: [{ method: "efectivo", amountCents: 11111 }], rendered: 1 });
    const [rem] = await db.insert(remittances).values({
      date: FIXTURE_DATE, canal: "directo", paymentBreakdown: "{}",
      totalAmount: 111.11, totalPaid: 0, status: "confirmada", createdBy: userId,
    }).returning({ id: remittances.id });
    const remId = rem!.id;
    const [rem2] = await db.insert(remittances).values({
      date: FIXTURE_DATE, canal: "directo", paymentBreakdown: "{}",
      totalAmount: 222.22, totalPaid: 0, status: "confirmada", createdBy: userId,
    }).returning({ id: remittances.id });
    const remId2 = rem2!.id;
    let debtId: number | undefined;
    try {
      await db.insert(remittanceItems).values({
        remittanceId: remId, source: "installment", sourceId: null, amount: 111.11, debtorStatus: "adeudado",
        clientName: `${PREFIX} Mix 1`,
      });
      await db.insert(remittanceItems).values({
        remittanceId: remId2, source: "manual_debt", sourceId: null, amount: 222.22, debtorStatus: "adeudado",
        clientName: `${PREFIX} Mix 2`,
      });
      const [debt] = await db.insert(cashDebts).values({
        clientName: `${PREFIX} Mix 3`, amount: 333.33, status: "pendiente", createdBy: userId, createdAt: new Date(),
      }).returning({ id: cashDebts.id });
      debtId = debt!.id;

      const { body } = await getSummary();
      const detalleSumCents = body.adeudadosDetalle.reduce((s: number, i: any) => s + Math.round(i.importe * 100), 0);
      const totalAdeudadoCents = Math.round(body.totalAdeudado * 100);
      expect(detalleSumCents).toBe(totalAdeudadoCents);
    } finally {
      if (debtId !== undefined) await cleanupCashDebt(debtId);
      await cleanupRemittance(remId2);
      await cleanupRemittance(remId);
      await cleanupPayment(paymentId);
    }
  });

  test("no hay duplicados dentro de una misma fuente (2 adeudados manual_debt distintos generan 2 filas, no 1)", async () => {
    const before = (await getSummary()).body;
    const [rem] = await db.insert(remittances).values({
      date: FIXTURE_DATE, canal: "directo", paymentBreakdown: "{}",
      totalAmount: 600, totalPaid: 0, status: "confirmada", createdBy: userId,
    }).returning({ id: remittances.id });
    const remId = rem!.id;
    try {
      await db.insert(remittanceItems).values([
        { remittanceId: remId, source: "manual_debt", sourceId: null, amount: 300, debtorStatus: "adeudado", clientName: `${PREFIX} Dup A` },
        { remittanceId: remId, source: "manual_debt", sourceId: null, amount: 300, debtorStatus: "adeudado", clientName: `${PREFIX} Dup B` },
      ]);
      const after = (await getSummary()).body;

      const newItems = after.adeudadosDetalle.filter((i: any) => !before.adeudadosDetalle.some((b: any) => b.id === i.id && b.origen === i.origen));
      expect(newItems.length).toBe(2);
      expect(new Set(newItems.map((i: any) => i.id)).size).toBe(2);
    } finally {
      await cleanupRemittance(remId);
    }
  });
});

describe("GET /api/cash/summary — adelantos/recuperos de adeudadas (cuotas reales)", () => {
  test("3. adelantosAdeudados sube por el importe rendido, fechado por remittances.date", async () => {
    const before = (await getSummary()).body;

    const [policyReal] = await db.insert(policies).values({
      policyNumber: `${PREFIX}-ADEL-${Date.now()}`, type: "automotor", status: "activa",
      companyId, insuredId, startDate: "2027-01-01", endDate: "2027-12-31", createdBy: userId,
    }).returning({ id: policies.id });
    const realPolicyId = policyReal!.id;
    const [instRow] = await db.insert(policyInstallments).values({
      policyId: realPolicyId, number: 1, dueDate: FIXTURE_DATE, amount: 900, status: "pendiente", rendered: 0,
    }).returning({ id: policyInstallments.id });
    const instId = instRow!.id;

    let remId: number | undefined;
    try {
      const res = await callPostRemittance({
        date: FIXTURE_DATE, canal: "directo", paymentBreakdown: { efectivo: 900 },
        items: [{ source: "installment", sourceId: instId, amount: 900, debtorStatus: "adeudado" }],
      });
      expect(res.status).toBe(200);
      remId = res.body.id;

      const after = (await getSummary()).body;
      expect(after.adelantosAdeudados - before.adelantosAdeudados).toBeCloseTo(900, 2);
      // No es dinero real cobrado — no debe mover cartera ni rendido.
      expect(after.cartera.total - before.cartera.total).toBeCloseTo(0, 2);
      expect(after.rendidoPorMetodo.total - before.rendidoPorMetodo.total).toBeCloseTo(0, 2);

      const period = await getSummary(`?from=${FIXTURE_DATE}&to=${FIXTURE_DATE}`);
      expect(period.body.periodo.adelantosAdeudados).toBeGreaterThanOrEqual(900);
    } finally {
      if (remId !== undefined) await cleanupRemittance(remId);
      await deleteWithRetry(() => db.delete(policyInstallments).where(eq(policyInstallments.id, instId)));
      await deleteWithRetry(() => db.delete(policies).where(eq(policies.id, realPolicyId)));
    }
  });

  test("6/7. el cobro posterior de una adeudada suma como ingreso una sola vez — cajaNeta no duplica", async () => {
    const [policyReal] = await db.insert(policies).values({
      policyNumber: `${PREFIX}-RECUP-${Date.now()}`, type: "automotor", status: "activa",
      companyId, insuredId, startDate: "2027-01-01", endDate: "2027-12-31", createdBy: userId,
    }).returning({ id: policies.id });
    const realPolicyId = policyReal!.id;
    const [instRow] = await db.insert(policyInstallments).values({
      policyId: realPolicyId, number: 1, dueDate: FIXTURE_DATE, amount: 650, status: "pendiente", rendered: 0,
    }).returning({ id: policyInstallments.id });
    const instId = instRow!.id;

    const rem = await callPostRemittance({
      date: FIXTURE_DATE, canal: "directo", paymentBreakdown: { efectivo: 650 },
      items: [{ source: "installment", sourceId: instId, amount: 650, debtorStatus: "adeudado" }],
    });
    expect(rem.status).toBe(200);
    const remId = rem.body.id as number;
    const item = await db.select({ id: remittanceItems.id }).from(remittanceItems).where(eq(remittanceItems.remittanceId, remId)).get();

    const beforeCollect = (await getSummary()).body;
    let paymentId: number | undefined;
    try {
      const collect = await callCollectItem(item!.id, { paymentDate: FIXTURE_DATE, paymentMethod: "efectivo" });
      expect(collect.status).toBe(201);
      paymentId = collect.body.payment.id;

      const afterCollect = (await getSummary()).body;
      // 6. suma una sola vez a lo históricamente cobrado.
      expect(afterCollect.totalCobrado - beforeCollect.totalCobrado).toBeCloseTo(650, 2);
      expect(afterCollect.recuperosAdeudados - beforeCollect.recuperosAdeudados).toBeCloseTo(650, 2);
      // 7. cajaNeta (pendiente de rendir) NO se mueve — el payment nace rendered=1.
      expect(afterCollect.cajaNeta.total - beforeCollect.cajaNeta.total).toBeCloseTo(0, 2);
      expect(afterCollect.cartera.total - beforeCollect.cartera.total).toBeCloseTo(0, 2);
      // El adelanto histórico ya estaba contado desde que se rindió (antes de
      // este snapshot "before") y NO se borra al cobrarse — el collect no lo
      // mueve para nada, sigue existiendo intacto.
      expect(afterCollect.adelantosAdeudados - beforeCollect.adelantosAdeudados).toBeCloseTo(0, 2);
    } finally {
      if (paymentId !== undefined) await cleanupPayment(paymentId);
      await cleanupRemittance(remId);
      await deleteWithRetry(() => db.delete(policyInstallments).where(eq(policyInstallments.id, instId)));
      await deleteWithRetry(() => db.delete(policies).where(eq(policies.id, realPolicyId)));
    }
  });
});
