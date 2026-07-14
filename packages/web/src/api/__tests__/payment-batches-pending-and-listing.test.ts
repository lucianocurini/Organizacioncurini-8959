/**
 * Tests de "Cobrar en lote" — piezas nuevas de esta vuelta:
 *  - GET /api/installments/pending-for-payment
 *  - GET /api/payment-batches (listado)
 *  - gaps de elegibilidad cerrados en POST /payment-batches (rendered, no_exigible)
 *  - mitigación de doble submit (re-chequeo dentro de la transacción real)
 *
 * Corre exclusivamente contra dev.db local (nunca Turso). Mismo patrón de
 * fixtures aisladas por prefijo que payment-batches.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments,
  payments, paymentSplits, paymentBatches, paymentBatchSplits, cashEntries, receivedChecks,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-batch-pending-001";
const USER_EMAIL = "test-batch-pending@test.local";
const PREFIX = "TEST-BATCH-PENDING";

let userId: number;
let companyId: number;
let insuredId: number;
let otherInsuredId: number;

const policyIdsToClean: number[] = [];
const batchIdsToClean: number[] = [];
// Payments STANDALONE creados directo con db.insert (nunca vía callPost, que
// ya trackea su propio batch en batchIdsToClean). Antes de este fix, el único
// caso ("excluye cuota con payment confirmado (standalone)", más abajo) no
// registraba su id acá — afterAll solo miraba hijos de batchIdsToClean, así
// que este payment quedaba huérfano y su FK bloqueaba en cascada el borrado
// de policies/insureds/users. Confirmado: este es exactamente el payment
// id=320 ($1000, confirmado, batchId=null) que apareció en la auditoría de
// producción — ver informe de auditoría 2026-07-13.
const paymentIdsToClean: number[] = [];
// Companies creadas con nombre timestampeado (nunca reusadas vía
// existingCo ?? insert, a diferencia de la company principal) — el mismo
// patrón de bug que paymentIdsToClean: si no se trackean, quedan huérfanas.
// Confirmado: exactamente estas ("TEST-BATCH-PENDING Otra Co <timestamp>")
// aparecieron en la auditoría de producción del 2026-07-13 (ids 59-63).
const companyIdsToClean: number[] = [];

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function mkPolicy(insured: number, company: number, status: string = "activa"): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status, companyId: company, insuredId: insured,
    startDate: "2027-01-01", endDate: "2027-12-31", createdBy: userId,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}

async function mkInstallment(policyId: number, number: number, dueDate: string, amount: number, overrides: Record<string, any> = {}): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({
    policyId, number, dueDate, amount, status: "pendiente", rendered: 0, ...overrides,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

async function callPending(query: string = "") {
  const res = await app.fetch(new Request(`http://localhost/api/installments/pending-for-payment${query}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

async function callPost(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) batchIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function callListBatches(query: string = "") {
  const res = await app.fetch(new Request(`http://localhost/api/payment-batches${query}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

// Recuperación best-effort de residuos de una corrida ANTERIOR rota (por eso
// tolera fallos parciales con .catch — a diferencia de afterAll más abajo,
// que es responsabilidad exclusiva de ESTA corrida y no debe ocultar nada).
// Igual ya no debería hacer falta con el afterAll corregido, pero se deja
// como red de seguridad adicional.
beforeAll(async () => {
  const warn = (step: string) => (e: unknown) => console.warn(`[payment-batches-pending-and-listing] beforeAll: recuperación de corrida previa falló en "${step}" (no bloqueante):`, e);

  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const polIds = prevPols.map((p) => p.id);
    if (polIds.length) {
      const payRows = await db.select({ id: payments.id }).from(payments).where(inArray(payments.policyId, polIds)).all();
      const payIds = payRows.map((r) => r.id);
      const batchRows = payIds.length
        ? await db.select({ id: paymentBatches.id }).from(paymentBatches)
            .innerJoin(payments, eq(payments.batchId, paymentBatches.id))
            .where(inArray(payments.id, payIds)).all()
        : [];
      const batchIds = [...new Set(batchRows.map((r: any) => r.id))];
      if (payIds.length) await db.delete(cashEntries).where(inArray(cashEntries.paymentId, payIds)).catch(warn("cashEntries"));
      if (payIds.length) await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds)).catch(warn("paymentSplits"));
      if (payIds.length) await db.delete(payments).where(inArray(payments.id, payIds)).catch(warn("payments"));
      if (batchIds.length) {
        const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).all();
        const splitIds = splitRows.map((s) => s.id);
        if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).catch(warn("receivedChecks"));
      }
      if (batchIds.length) await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).catch(warn("paymentBatchSplits"));
      if (batchIds.length) await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIds)).catch(warn("paymentBatches"));
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, polIds)).catch(warn("policyInstallments"));
      await db.delete(policies).where(inArray(policies.id, polIds)).catch(warn("policies"));
    }
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(warn("insureds"));
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(warn("sessions"));
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(warn("users"));
  }

  const [u] = await db.insert(users).values({
    name: "Test Batch Pending", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado A`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
  const [ins2] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado B`, createdBy: userId }).returning({ id: insureds.id });
  otherInsuredId = ins2!.id;
});

// Responsabilidad exclusiva de ESTA corrida: si algo acá falla, el afterAll
// debe reventar (nunca .catch(() => {})) para que bun test lo reporte como
// fallo visible, en vez de dejar residuos silenciosos como pasó en
// producción (ver comentario de paymentIdsToClean más arriba).
afterAll(async () => {
  // Todo payment que cuelgue de un policyId de esta corrida (batch children +
  // standalone tracked + cualquier otro que se nos haya escapado de trackear
  // — red de seguridad adicional, ya que su policyId sigue siendo de este
  // mismo test) debe borrarse ANTES de policies/policyInstallments, o la FK
  // bloquea el borrado en cascada.
  const batchChildren = batchIdsToClean.length
    ? await db.select({ id: payments.id }).from(payments).where(inArray(payments.batchId, batchIdsToClean)).all()
    : [];
  const byPolicyId = policyIdsToClean.length
    ? await db.select({ id: payments.id }).from(payments).where(inArray(payments.policyId, policyIdsToClean)).all()
    : [];
  const allPaymentIds = [...new Set([
    ...batchChildren.map((c) => c.id),
    ...byPolicyId.map((c) => c.id),
    ...paymentIdsToClean,
  ])];

  if (allPaymentIds.length) {
    await db.delete(cashEntries).where(inArray(cashEntries.paymentId, allPaymentIds));
    await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, allPaymentIds));
    await db.delete(payments).where(inArray(payments.id, allPaymentIds));
  }
  if (batchIdsToClean.length) {
    const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsToClean)).all();
    const splitIds = splitRows.map((s) => s.id);
    if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds));
    await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsToClean));
    await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIdsToClean));
  }
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean));
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean));
  }
  if (companyIdsToClean.length) {
    await db.delete(companies).where(inArray(companies.id, companyIdsToClean));
  }
  await db.delete(insureds).where(eq(insureds.createdBy, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));

  // Verificación final: si queda CUALQUIER residuo de este prefijo/usuario,
  // fallar visiblemente en vez de dejarlo pasar silenciosamente.
  const [leftoverUsers, leftoverInsureds, leftoverPolicies, leftoverPayments, leftoverCompanies] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).all(),
    db.select({ id: insureds.id }).from(insureds).where(eq(insureds.createdBy, userId)).all(),
    db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, userId)).all(),
    db.select({ id: payments.id }).from(payments).where(eq(payments.createdBy, userId)).all(),
    companyIdsToClean.length
      ? db.select({ id: companies.id }).from(companies).where(inArray(companies.id, companyIdsToClean)).all()
      : Promise.resolve([]),
  ]);
  const leftoverPolicyIds = leftoverPolicies.map((p) => p.id);
  const leftoverInstallments = leftoverPolicyIds.length
    ? await db.select({ id: policyInstallments.id }).from(policyInstallments).where(inArray(policyInstallments.policyId, leftoverPolicyIds)).all()
    : [];

  const residue = {
    users: leftoverUsers.length,
    insureds: leftoverInsureds.length,
    policies: leftoverPolicies.length,
    policyInstallments: leftoverInstallments.length,
    payments: leftoverPayments.length,
    companies: leftoverCompanies.length,
  };
  const total = Object.values(residue).reduce((a, b) => a + b, 0);
  if (total > 0) {
    throw new Error(
      `afterAll de payment-batches-pending-and-listing.test.ts dejó residuos sin limpiar: ${JSON.stringify(residue)}. ` +
      `Esto es exactamente el tipo de fixture huérfano que llegó a producción — revisar qué helper de test crea datos sin trackear su id para cleanup.`
    );
  }
});

describe("GET /api/installments/pending-for-payment", () => {
  test("lista cuota pendiente cobrable con los campos mínimos requeridos", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1500);

    const { status, body } = await callPending(`?insuredId=${insuredId}`);
    expect(status).toBe(200);
    const row = body.find((r: any) => r.installmentId === instId);
    expect(row).toBeDefined();
    expect(row.policyId).toBe(policyId);
    expect(row.insuredId).toBe(insuredId);
    expect(row.amount).toBe(1500);
    expect(row.status).toBe("pendiente");
    expect(row.rebillingId).toBeNull();
    expect(typeof row.policyNumber).toBe("string");
    expect(typeof row.companyName).toBe("string");
  });

  test("excluye cuota ya pagada", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000, { status: "pagada" });
    const { body } = await callPending(`?insuredId=${insuredId}`);
    expect(body.some((r: any) => r.installmentId === instId)).toBe(false);
  });

  test("excluye cuota rendered=1", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000, { rendered: 1 });
    const { body } = await callPending(`?insuredId=${insuredId}`);
    expect(body.some((r: any) => r.installmentId === instId)).toBe(false);
  });

  test("excluye cuota no_exigible", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000, { status: "no_exigible" });
    const { body } = await callPending(`?insuredId=${insuredId}`);
    expect(body.some((r: any) => r.installmentId === instId)).toBe(false);
  });

  test("excluye cuota de póliza cancelada", async () => {
    const policyId = await mkPolicy(insuredId, companyId, "cancelada");
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000);
    const { body } = await callPending(`?insuredId=${insuredId}`);
    expect(body.some((r: any) => r.installmentId === instId)).toBe(false);
  });

  test("excluye cuota con payment confirmado (standalone)", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000);
    const [standalonePayment] = await db.insert(payments).values({
      policyId, installmentId: instId, amount: 1000, paymentMethod: "efectivo",
      paymentDate: "2027-06-01", status: "confirmado", createdBy: userId,
    }).returning({ id: payments.id });
    paymentIdsToClean.push(standalonePayment!.id);
    const { body } = await callPending(`?insuredId=${insuredId}`);
    expect(body.some((r: any) => r.installmentId === instId)).toBe(false);
  });

  test("excluye cuota ya asociada a otro batch", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000);
    const created = await callPost({
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(created.status).toBe(201);

    const { body } = await callPending(`?insuredId=${insuredId}`);
    expect(body.some((r: any) => r.installmentId === instId)).toBe(false);
  });

  test("filtro companyId funciona", async () => {
    const otherCo = (await db.insert(companies).values({ name: `${PREFIX} Otra Co ${Date.now()}` }).returning({ id: companies.id }))[0]!.id;
    companyIdsToClean.push(otherCo);
    const policyId = await mkPolicy(insuredId, otherCo);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000);

    const matching = await callPending(`?companyId=${otherCo}`);
    expect(matching.body.some((r: any) => r.installmentId === instId)).toBe(true);

    const nonMatching = await callPending(`?companyId=${companyId}`);
    expect(nonMatching.body.some((r: any) => r.installmentId === instId)).toBe(false);
  });

  test("orden: asegurado, vencimiento, póliza, número de cuota", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    await mkInstallment(policyId, 2, "2027-08-01", 500);
    await mkInstallment(policyId, 1, "2027-07-01", 500);
    const { body } = await callPending(`?insuredId=${insuredId}`);
    const dates = body.filter((r: any) => r.policyId === policyId).map((r: any) => r.dueDate);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });
});

describe("POST /payment-batches — gaps de elegibilidad cerrados", () => {
  test("cuota rendered=1 → 409 'ya fue rendida'", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000, { rendered: 1 });
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(409);
    expect(body.error).toContain("ya fue rendida");
  });

  test("cuota no_exigible → 409 'no es exigible'", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000, { status: "no_exigible" });
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(409);
    expect(body.error).toContain("no es exigible");
  });

  test("cuota ya pertenece a otro batch → 409 con mensaje diferenciado (no 'ya está pagada')", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 1000);
    const first = await callPost({
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(first.status).toBe(201);

    const second = await callPost({
      insuredId, paymentDate: "2027-06-02", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("ya pertenece a otro cobro por lote");
    expect(second.body.error).not.toContain("ya está pagada");
  });

  test("doble request secuencial para la misma cuota: la segunda 409, no queda ningún batch parcial ni duplicado", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 2000);
    const payloadBody = {
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "transferencia", amount: 2000 }],
    };
    const first = await callPost(payloadBody);
    const second = await callPost(payloadBody);
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);

    const allBatchesForThisInstallment = await db.select({ id: payments.id })
      .from(payments).where(eq(payments.installmentId, instId)).all();
    expect(allBatchesForThisInstallment.length).toBe(1); // nunca 2
  });
});

describe("GET /api/payment-batches — listado", () => {
  test("devuelve los campos resumidos esperados, sin duplicar filas por joins", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId, 1, "2027-06-01", 1000);
    const inst2 = await mkInstallment(policyId, 2, "2027-07-01", 500);
    const created = await callPost({
      insuredId, paymentDate: "2027-06-05", notes: "lote de prueba",
      items: [{ installmentId: inst1 }, { installmentId: inst2 }],
      splits: [{ method: "efectivo", amount: 1500 }],
    });
    expect(created.status).toBe(201);

    const { status, body } = await callListBatches(`?insuredId=${insuredId}`);
    expect(status).toBe(200);
    const row = body.find((b: any) => b.id === created.body.id);
    expect(row).toBeDefined();
    expect(row.itemCount).toBe(2);
    expect(row.splitCount).toBe(1);
    expect(row.checkCount).toBe(0);
    expect(row.totalReceivedCents).toBe(150000);
    expect(row.insuredName).toBeDefined();
    // una sola fila por batch, no una por cada payment/split
    expect(body.filter((b: any) => b.id === created.body.id).length).toBe(1);
  });

  test("filtro insuredId funciona", async () => {
    const policyIdA = await mkPolicy(insuredId, companyId);
    const instA = await mkInstallment(policyIdA, 1, "2027-06-01", 400);
    const createdA = await callPost({
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instA }], splits: [{ method: "efectivo", amount: 400 }],
    });

    const policyIdB = await mkPolicy(otherInsuredId, companyId);
    const instB = await mkInstallment(policyIdB, 1, "2027-06-01", 400);
    const createdB = await callPost({
      insuredId: otherInsuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instB }], splits: [{ method: "efectivo", amount: 400 }],
    });

    const { body } = await callListBatches(`?insuredId=${insuredId}`);
    expect(body.some((b: any) => b.id === createdA.body.id)).toBe(true);
    expect(body.some((b: any) => b.id === createdB.body.id)).toBe(false);
  }, 15000); // 2 POSTs reales secuenciales (cada uno con su propia transacción) — puede rozar el timeout default de 5s en una corrida aislada.

  test("filtro dateFrom/dateTo funciona", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-06-01", 300);
    const created = await callPost({
      insuredId, paymentDate: "2020-01-15", notes: null,
      items: [{ installmentId: instId }], splits: [{ method: "efectivo", amount: 300 }],
    });
    expect(created.status).toBe(201);

    const inRange = await callListBatches(`?insuredId=${insuredId}&dateFrom=2020-01-01&dateTo=2020-01-31`);
    expect(inRange.body.some((b: any) => b.id === created.body.id)).toBe(true);

    const outOfRange = await callListBatches(`?insuredId=${insuredId}&dateFrom=2021-01-01`);
    expect(outOfRange.body.some((b: any) => b.id === created.body.id)).toBe(false);
  });

  test("limit funciona", async () => {
    const { body } = await callListBatches(`?insuredId=${insuredId}&limit=1`);
    expect(body.length).toBeLessThanOrEqual(1);
  });

  test("itemCount cuenta ítems manuales igual que cuotas — batch mixto con 1 cuota + 1 manual → itemCount=2", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const policyB = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyA, 1, "2027-06-01", 700);
    const created = await callPost({
      insuredId, paymentDate: "2027-06-05", notes: null,
      items: [
        { source: "installment", installmentId: instId },
        { source: "policy_manual_payment", policyId: policyB, amount: 300 },
      ],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(created.status).toBe(201);

    const { body } = await callListBatches(`?insuredId=${insuredId}`);
    const row = body.find((b: any) => b.id === created.body.id);
    expect(row).toBeDefined();
    expect(row.itemCount).toBe(2);
    expect(row.totalReceivedCents).toBe(100000);
  });

  test("itemCount cuenta una imputación completamente libre (source=manual_payment) igual que cualquier otro ítem", async () => {
    // Sin ninguna póliza real detrás — no aparece bajo el filtro insuredId
    // (correcto: no pertenece a ningún asegurado real), así que se busca por
    // fecha única en vez de por insuredId.
    const uniqueDate = "2029-03-17";
    const created = await callPost({
      insuredId, paymentDate: uniqueDate, notes: null,
      items: [{ source: "manual_payment", manualPayer: "Cliente sin póliza cargada", amount: 450 }],
      splits: [{ method: "efectivo", amount: 450 }],
    });
    expect(created.status).toBe(201);

    const { body } = await callListBatches(`?dateFrom=${uniqueDate}&dateTo=${uniqueDate}`);
    const row = body.find((b: any) => b.id === created.body.id);
    expect(row).toBeDefined();
    expect(row.itemCount).toBe(1);
    expect(row.totalReceivedCents).toBe(45000);
    expect(row.insuredId).toBeNull();
    expect(row.insuredDisplay).toBe("Cliente sin póliza cargada");
  });

  test("itemCount de un batch mixto multi-asegurado se cuenta igual, y no aparece filtrando por un solo insuredId salvo que uno de sus hijos sea de ese asegurado", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const instA = await mkInstallment(policyA, 1, "2027-06-01", 400);
    const policyB = await mkPolicy(otherInsuredId, companyId);
    const instB = await mkInstallment(policyB, 1, "2027-06-01", 600);
    const created = await callPost({
      paymentDate: "2027-06-05", notes: null,
      items: [{ source: "installment", installmentId: instA }, { source: "installment", installmentId: instB }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(created.status).toBe(201);

    const { body: byA } = await callListBatches(`?insuredId=${insuredId}`);
    expect(byA.some((b: any) => b.id === created.body.id)).toBe(true);
    const rowA = byA.find((b: any) => b.id === created.body.id);
    expect(rowA.itemCount).toBe(2);
    expect(rowA.insuredId).toBeNull(); // mezcla real — nunca se le atribuye un solo asegurado
    expect(rowA.insuredDisplay).toBe("Varios asegurados");

    const { body: byB } = await callListBatches(`?insuredId=${otherInsuredId}`);
    expect(byB.some((b: any) => b.id === created.body.id)).toBe(true);
  });
});
