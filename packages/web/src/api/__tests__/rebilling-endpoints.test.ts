/**
 * Tests de POST/PUT/DELETE /policies/:id/rebillings — /rebillings/:id
 * (Etapa: refacturación genera su propio grupo de cuotas, migración 0025).
 * Corre exclusivamente contra dev.db local (nunca Turso). Cada test crea sus
 * propios fixtures (prefijo único) y los borra en un bloque finally —
 * ninguna limpieza ignora errores (ver lección de Etapa Caja: un
 * .catch(() => {}) silencioso puede ocultar un orden de borrado equivocado
 * y dejar filas huérfanas sin que nadie se entere).
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, rebillings, policyInstallments,
  companies, insureds, payments, remittances, remittanceItems,
} from "../database/schema";
import { eq, inArray, and } from "drizzle-orm";

const SESSION_ID = "test-session-reb-endpoints-001";
const USER_EMAIL = "test-reb-endpoints@test.local";
const PREFIX = "TEST-REB-ENDPOINTS";
const FIXTURE_DATE = "2027-06-01";

let userId: number;
let insuredId: number;
let companyId: number;

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function callPost(policyId: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}/rebillings`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function callPut(id: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/rebillings/${id}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function callDelete(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/rebillings/${id}`, {
    method: "DELETE", headers: authHeaders(),
  }));
  return { status: res.status, body: await res.json() };
}

// ─── Borrado determinista (nunca silencioso) — mismo patrón que
// caja-summary-endpoint.test.ts: solo SQLITE_BUSY/SQLITE_LOCKED se
// reintentan con límite corto, cualquier otro error se propaga.
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

async function mkPolicy(): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "automotor", status: "activa", companyId, insuredId,
    startDate: "2027-01-01", endDate: "2027-12-31",
    installments: 0, createdBy: userId,
  }).returning({ id: policies.id });
  return p!.id;
}

async function getPolicy(id: number) {
  return db.select().from(policies).where(eq(policies.id, id)).get();
}

async function getInstallments(policyId: number) {
  return db.select().from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).orderBy(policyInstallments.rebillingId, policyInstallments.number).all();
}

async function mkOriginalInstallment(policyId: number, number: number, dueDate: string, amount: number) {
  const [i] = await db.insert(policyInstallments).values({
    policyId, number, dueDate, amount, status: "pendiente", rendered: 0, rebillingId: null,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

async function cleanupPolicy(policyId: number) {
  // Cuotas de esta póliza pueden tener pagos/rendiciones directas vinculadas
  // (fixtures de los tests de bloqueo CASO C) — se borran antes que las
  // propias cuotas, que a su vez se borran antes que rebillings/policies.
  const instRows = await db.select({ id: policyInstallments.id }).from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();
  const instIds = instRows.map((r) => r.id);
  if (instIds.length) {
    await deleteWithRetry(() => db.delete(remittanceItems).where(and(eq(remittanceItems.source, "installment"), inArray(remittanceItems.sourceId, instIds))));
    await deleteWithRetry(() => db.delete(payments).where(inArray(payments.installmentId, instIds)));
  }
  await deleteWithRetry(() => db.delete(policyInstallments).where(eq(policyInstallments.policyId, policyId)));
  await deleteWithRetry(() => db.delete(rebillings).where(eq(rebillings.policyId, policyId)));
  await deleteWithRetry(() => db.delete(policies).where(eq(policies.id, policyId)));
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const stalePolicies = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    for (const p of stalePolicies) await cleanupPolicy(p.id);
    await deleteWithRetry(() => db.delete(sessions).where(eq(sessions.userId, prevUser.id)));
    await deleteWithRetry(() => db.delete(users).where(eq(users.id, prevUser.id)));
  }
  const prevInsured = await db.select({ id: insureds.id }).from(insureds).where(eq(insureds.name, `${PREFIX} Asegurado`)).get();
  if (prevInsured) await deleteWithRetry(() => db.delete(insureds).where(eq(insureds.id, prevInsured.id)));

  const [u] = await db.insert(users).values({
    name: "Test Reb Endpoints", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Compania`)).get();
  companyId = existingCo ? existingCo.id : (await db.insert(companies).values({ name: `${PREFIX} Compania` }).returning({ id: companies.id }))[0]!.id;
});

afterAll(async () => {
  await deleteWithRetry(() => db.delete(insureds).where(eq(insureds.id, insuredId)));
  await deleteWithRetry(() => db.delete(sessions).where(eq(sessions.id, SESSION_ID)));
  await deleteWithRetry(() => db.delete(users).where(eq(users.id, userId)));

  const leftoverPolicies = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, userId)).all();
  expect(leftoverPolicies.length).toBe(0);
});

describe("POST /policies/:id/rebillings", () => {
  test("genera N cuotas con rebillingId correcto, numeración 1..N, status pendiente, rendered=0", async () => {
    const policyId = await mkPolicy();
    try {
      await mkOriginalInstallment(policyId, 1, "2027-01-01", 1000);
      await mkOriginalInstallment(policyId, 2, "2027-02-01", 1000);

      const { status, body } = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31",
        premium: 999999, monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });

      expect(status).toBe(201);
      expect(body.installments.length).toBe(3);
      for (const inst of body.installments) {
        expect(inst.rebillingId).toBe(body.id);
        expect(inst.status).toBe("pendiente");
        expect(inst.rendered).toBe(0);
      }
      expect(body.installments.map((i: any) => i.number)).toEqual([1, 2, 3]);
      expect(body.installments.map((i: any) => i.dueDate)).toEqual(["2027-06-01", "2027-07-01", "2027-08-01"]);

      // premium NO es la fuente del total del plan — sigue siendo 1000*3.
      const totalCents = body.installments.reduce((s: number, i: any) => s + Math.round(i.amount * 100), 0);
      expect(totalCents).toBe(300000);

      // cuotas originales conservadas, sin tocar.
      const allInst = await getInstallments(policyId);
      expect(allInst.filter((i) => i.rebillingId === null).length).toBe(2);
      expect(allInst.length).toBe(5);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("deductible se guarda en rebillings y actualiza policies.deductible", async () => {
    const policyId = await mkPolicy();
    try {
      const { status, body } = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-06-30",
        monthlyFee: 1000, installmentCount: 1, firstDueDate: "2027-06-01", deductible: 75000,
      });
      expect(status).toBe(201);
      expect(body.deductible).toBe(75000);

      const policy = await getPolicy(policyId);
      expect(policy!.deductible).toBe(75000);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("sin deductible informado, policies.deductible no se modifica", async () => {
    const policyId = await mkPolicy();
    try {
      await db.update(policies).set({ deductible: 12345 }).where(eq(policies.id, policyId));
      const { status } = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-06-30",
        monthlyFee: 1000, installmentCount: 1, firstDueDate: "2027-06-01",
      });
      expect(status).toBe(201);
      const policy = await getPolicy(policyId);
      expect(policy!.deductible).toBe(12345);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("policies.installments se incrementa en N", async () => {
    const policyId = await mkPolicy();
    try {
      await db.update(policies).set({ installments: 12 }).where(eq(policies.id, policyId));
      await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31",
        monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const policy = await getPolicy(policyId);
      expect(policy!.installments).toBe(15);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("segunda refacturación sobre la misma póliza crea un grupo independiente, numeración propia desde 1", async () => {
    const policyId = await mkPolicy();
    try {
      const first = await callPost(policyId, {
        billingStart: "2027-01-01", billingEnd: "2027-03-31",
        monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-01-01",
      });
      const second = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-07-31",
        monthlyFee: 2000, installmentCount: 2, firstDueDate: "2027-06-01",
      });
      expect(second.status).toBe(201);
      expect(second.body.id).not.toBe(first.body.id);
      expect(second.body.installments.map((i: any) => i.number)).toEqual([1, 2]);

      const allInst = await getInstallments(policyId);
      expect(allInst.filter((i) => i.rebillingId === first.body.id).length).toBe(3);
      expect(allInst.filter((i) => i.rebillingId === second.body.id).length).toBe(2);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("POST duplicado (mismo período y prima) devuelve 409 sin crear nada — transacción se descarta completa", async () => {
    const policyId = await mkPolicy();
    try {
      const first = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31",
        premium: 3000, monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      expect(first.status).toBe(201);

      const before = await getInstallments(policyId);
      const policyBefore = await getPolicy(policyId);

      const dup = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31",
        premium: 3000, monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      expect(dup.status).toBe(409);

      const after = await getInstallments(policyId);
      const policyAfter = await getPolicy(policyId);
      expect(after.length).toBe(before.length); // nada nuevo — rollback completo
      expect(policyAfter!.installments).toBe(policyBefore!.installments);

      const rebRows = await db.select().from(rebillings).where(eq(rebillings.policyId, policyId)).all();
      expect(rebRows.length).toBe(1); // no se creó una segunda fila en rebillings
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("póliza inexistente devuelve 404", async () => {
    const { status } = await callPost(9_999_999, {
      billingStart: "2027-06-01", billingEnd: "2027-06-30", monthlyFee: 1000, installmentCount: 1, firstDueDate: "2027-06-01",
    });
    expect(status).toBe(404);
  });

  test("payload inválido (sin installmentCount) devuelve 400, no crea nada", async () => {
    const policyId = await mkPolicy();
    try {
      const { status } = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-06-30", monthlyFee: 1000, firstDueDate: "2027-06-01",
      });
      expect(status).toBe(400);
      const rebRows = await db.select().from(rebillings).where(eq(rebillings.policyId, policyId)).all();
      expect(rebRows.length).toBe(0);
    } finally {
      await cleanupPolicy(policyId);
    }
  });
});

describe("PUT /rebillings/:id", () => {
  test("caso A — refacturación histórica con cero cuotas genera el grupo faltante al editar", async () => {
    const policyId = await mkPolicy();
    try {
      const [reb] = await db.insert(rebillings).values({
        policyId, billingStart: "2027-06-01", billingEnd: "2027-08-31", premium: 3000, createdBy: userId,
      }).returning();

      const { status, body } = await callPut(reb!.id, {
        monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      expect(status).toBe(200);
      expect(body.installments.length).toBe(3);
      expect(body.installments.map((i: any) => i.rebillingId)).toEqual([reb!.id, reb!.id, reb!.id]);

      const policy = await getPolicy(policyId);
      expect(policy!.installments).toBe(3);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("sin actividad, regenera solo su grupo y ajusta policies.installments por la diferencia", async () => {
    const policyId = await mkPolicy();
    try {
      await db.update(policies).set({ installments: 10 }).where(eq(policies.id, policyId));
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31",
        monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;

      const { status, body } = await callPut(rebId, {
        monthlyFee: 1000, installmentCount: 5, firstDueDate: "2027-06-01",
        billingStart: "2027-06-01", billingEnd: "2027-10-31",
      });
      expect(status).toBe(200);
      expect(body.installments.length).toBe(5);
      expect(body.installments.map((i: any) => i.number)).toEqual([1, 2, 3, 4, 5]);

      const policy = await getPolicy(policyId);
      expect(policy!.installments).toBe(10 + 3 + 2); // +3 del POST, +2 de diferencia (5-3) del PUT
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("no toca otros grupos (emisión original ni otra refacturación)", async () => {
    const policyId = await mkPolicy();
    try {
      await mkOriginalInstallment(policyId, 1, "2027-01-01", 500);
      const rebA = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-06-30", monthlyFee: 1000, installmentCount: 1, firstDueDate: "2027-06-01",
      });
      const rebB = await callPost(policyId, {
        billingStart: "2027-09-01", billingEnd: "2027-10-31", monthlyFee: 800, installmentCount: 2, firstDueDate: "2027-09-01",
      });

      await callPut(rebA.body.id, {
        monthlyFee: 1200, installmentCount: 2, firstDueDate: "2027-06-01", billingStart: "2027-06-01", billingEnd: "2027-07-31",
      });

      const allInst = await getInstallments(policyId);
      expect(allInst.filter((i) => i.rebillingId === null).length).toBe(1); // original intacta
      expect(allInst.filter((i) => i.rebillingId === rebB.body.id).length).toBe(2); // otra refacturación intacta
      expect(allInst.filter((i) => i.rebillingId === rebA.body.id).length).toBe(2); // la editada, regenerada
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("cuota pagada bloquea la edición del plan con 409, sin modificar nada", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      const firstInstId = created.body.installments[0].id;
      await db.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, firstInstId));

      const before = await getInstallments(policyId);
      const { status } = await callPut(rebId, { monthlyFee: 2000, installmentCount: 4, firstDueDate: "2027-06-01" });
      expect(status).toBe(409);
      const after = await getInstallments(policyId);
      expect(after).toEqual(before);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("cuota rendida (rendered=1) bloquea la edición del plan con 409", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      const firstInstId = created.body.installments[0].id;
      await db.update(policyInstallments).set({ rendered: 1 }).where(eq(policyInstallments.id, firstInstId));

      const { status } = await callPut(rebId, { monthlyFee: 2000, installmentCount: 4, firstDueDate: "2027-06-01" });
      expect(status).toBe(409);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("cuota con pago vinculado (payments.installmentId) bloquea la edición del plan con 409", async () => {
    const policyId = await mkPolicy();
    let paymentId: number | undefined;
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      const firstInstId = created.body.installments[0].id;
      const [pay] = await db.insert(payments).values({
        amount: 1000, paymentMethod: "efectivo", paymentDate: FIXTURE_DATE, status: "confirmado",
        installmentId: firstInstId, createdBy: userId,
      }).returning({ id: payments.id });
      paymentId = pay!.id;

      const { status } = await callPut(rebId, { monthlyFee: 2000, installmentCount: 4, firstDueDate: "2027-06-01" });
      expect(status).toBe(409);
    } finally {
      if (paymentId !== undefined) await deleteWithRetry(() => db.delete(payments).where(eq(payments.id, paymentId!)));
      await cleanupPolicy(policyId);
    }
  });

  test("cuota con rendición directa (remittance_items) bloquea la edición del plan con 409", async () => {
    const policyId = await mkPolicy();
    let remId: number | undefined;
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      const firstInstId = created.body.installments[0].id;
      const [rem] = await db.insert(remittances).values({
        date: FIXTURE_DATE, canal: "directo", status: "confirmada", createdBy: userId,
      }).returning({ id: remittances.id });
      remId = rem!.id;
      await db.insert(remittanceItems).values({
        remittanceId: remId, source: "installment", sourceId: firstInstId, amount: 1000, debtorStatus: "pagado",
      });

      const { status } = await callPut(rebId, { monthlyFee: 2000, installmentCount: 4, firstDueDate: "2027-06-01" });
      expect(status).toBe(409);
    } finally {
      if (remId !== undefined) {
        await deleteWithRetry(() => db.delete(remittanceItems).where(eq(remittanceItems.remittanceId, remId!)));
        await deleteWithRetry(() => db.delete(remittances).where(eq(remittances.id, remId!)));
      }
      await cleanupPolicy(policyId);
    }
  });

  test("rebilling inexistente devuelve 404", async () => {
    const { status } = await callPut(9_999_999, { monthlyFee: 1000, installmentCount: 1, firstDueDate: "2027-06-01" });
    expect(status).toBe(404);
  });
});

describe("DELETE /rebillings/:id", () => {
  test("elimina solo las cuotas de ese grupo, ajusta policies.installments, conserva el resto", async () => {
    const policyId = await mkPolicy();
    try {
      await mkOriginalInstallment(policyId, 1, "2027-01-01", 500);
      await db.update(policies).set({ installments: 1 }).where(eq(policies.id, policyId));

      const rebA = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebB = await callPost(policyId, {
        billingStart: "2027-09-01", billingEnd: "2027-10-31", monthlyFee: 800, installmentCount: 2, firstDueDate: "2027-09-01",
      });

      const { status, body } = await callDelete(rebA.body.id);
      expect(status).toBe(200);
      expect(body.deleted.installments).toBe(3);

      const allInst = await getInstallments(policyId);
      expect(allInst.filter((i) => i.rebillingId === null).length).toBe(1); // original intacta
      expect(allInst.filter((i) => i.rebillingId === rebA.body.id).length).toBe(0); // eliminada
      expect(allInst.filter((i) => i.rebillingId === rebB.body.id).length).toBe(2); // otra refacturación intacta

      const policy = await getPolicy(policyId);
      expect(policy!.installments).toBe(1 + 3 + 2 - 3); // base + rebA + rebB - rebA eliminada
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("con actividad (cuota pagada) sigue bloqueado con 409, nada se borra", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      await db.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, created.body.installments[0].id));

      const { status } = await callDelete(created.body.id);
      expect(status).toBe(409);

      const allInst = await getInstallments(policyId);
      expect(allInst.filter((i) => i.rebillingId === created.body.id).length).toBe(3); // nada se borró
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("rebilling inexistente devuelve 404", async () => {
    const { status } = await callDelete(9_999_999);
    expect(status).toBe(404);
  });
});
