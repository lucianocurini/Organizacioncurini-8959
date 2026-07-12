/**
 * Tests de la separación entre "editar datos de una refacturación" (PUT
 * /rebillings/:id sin installmentCount/firstDueDate) y "corregir plan de
 * cuotas" (GET/POST /rebillings/:id/installments/rebuild-check|rebuild).
 * Corre exclusivamente contra dev.db local (nunca Turso). Cada test crea sus
 * propios fixtures (prefijo único) y los borra en un bloque finally.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, rebillings, policyInstallments,
  companies, insureds, payments, remittances, remittanceItems,
} from "../database/schema";
import { eq, inArray, and } from "drizzle-orm";

const SESSION_ID = "test-session-reb-meta-rebuild-001";
const USER_EMAIL = "test-reb-meta-rebuild@test.local";
const PREFIX = "TEST-REB-META-REBUILD";
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
async function callRebuildCheck(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/rebillings/${id}/installments/rebuild-check`, {
    method: "GET", headers: authHeaders(),
  }));
  return { status: res.status, body: await res.json() };
}
async function callRebuild(id: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/rebillings/${id}/installments/rebuild`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

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
    name: "Test Reb Meta Rebuild", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
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

describe("PUT /rebillings/:id — edición de metadata (sin installmentCount/firstDueDate)", () => {
  test("editar solo billingStart/billingEnd conserva todos los IDs de cuotas", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      const idsBefore = created.body.installments.map((i: any) => i.id).sort();

      const { status } = await callPut(rebId, { billingStart: "2027-06-15", billingEnd: "2027-09-15" });
      expect(status).toBe(200);

      const installments = await getInstallments(policyId);
      const idsAfter = installments.filter((i) => i.rebillingId === rebId).map((i) => i.id).sort();
      expect(idsAfter).toEqual(idsBefore);

      const reb = await db.select().from(rebillings).where(eq(rebillings.id, rebId)).get();
      expect(reb!.billingStart).toBe("2027-06-15");
      expect(reb!.billingEnd).toBe("2027-09-15");
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("editar solo franquicia (deductible) conserva todos los IDs de cuotas y actualiza policies.deductible", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      const idsBefore = created.body.installments.map((i: any) => i.id).sort();

      const { status, body } = await callPut(rebId, { deductible: 55555 });
      expect(status).toBe(200);
      expect(body.deductible).toBe(55555);

      const installments = await getInstallments(policyId);
      const idsAfter = installments.filter((i) => i.rebillingId === rebId).map((i) => i.id).sort();
      expect(idsAfter).toEqual(idsBefore);

      const policy = await getPolicy(policyId);
      expect(policy!.deductible).toBe(55555);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("editar solo observaciones (notes) conserva todos los IDs de cuotas", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      const idsBefore = created.body.installments.map((i: any) => i.id).sort();

      const { status, body } = await callPut(rebId, { notes: "Ajuste administrativo sin tocar cuotas" });
      expect(status).toBe(200);
      expect(body.notes).toBe("Ajuste administrativo sin tocar cuotas");

      const installments = await getInstallments(policyId);
      const idsAfter = installments.filter((i) => i.rebillingId === rebId).map((i) => i.id).sort();
      expect(idsAfter).toEqual(idsBefore);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("editar monthlyFee/premium (amount) no regenera cuotas — ids y montos de las cuotas existentes intactos", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", premium: 3000, monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      const idsBefore = created.body.installments.map((i: any) => i.id).sort();
      const amountsBefore = created.body.installments.map((i: any) => i.amount);

      const { status, body } = await callPut(rebId, { monthlyFee: 5000, premium: 15000 });
      expect(status).toBe(200);
      expect(body.monthlyFee).toBe(5000);
      expect(body.premium).toBe(15000);

      const installments = await getInstallments(policyId);
      const group = installments.filter((i) => i.rebillingId === rebId);
      expect(group.map((i) => i.id).sort()).toEqual(idsBefore);
      expect(group.map((i) => i.amount)).toEqual(amountsBefore); // las cuotas NO se redistribuyen
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("edición de metadata funciona sin enviar installmentCount (rebilling histórico con installmentCount NULL)", async () => {
    const policyId = await mkPolicy();
    try {
      const [reb] = await db.insert(rebillings).values({
        policyId, billingStart: "2027-06-01", billingEnd: "2027-08-31", premium: 3000, createdBy: userId,
      }).returning();

      const { status, body } = await callPut(reb!.id, { notes: "Solo actualizo notas, sin plan" });
      expect(status).toBe(200);
      expect(body.notes).toBe("Solo actualizo notas, sin plan");

      const installments = await getInstallments(policyId);
      expect(installments.filter((i) => i.rebillingId === reb!.id).length).toBe(0); // no se creó ninguna cuota
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("edición de metadata funciona sin enviar firstDueDate", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;

      const { status } = await callPut(rebId, { premium: 9999 });
      expect(status).toBe(200);

      const reb = await db.select().from(rebillings).where(eq(rebillings.id, rebId)).get();
      expect(reb!.firstDueDate).toBe("2027-06-01"); // no se tocó
      expect(reb!.installmentCount).toBe(3); // no se tocó
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("refacturación sin grupo de cuotas puede editar metadata sin crear ninguna cuota", async () => {
    const policyId = await mkPolicy();
    try {
      const [reb] = await db.insert(rebillings).values({
        policyId, billingStart: "2027-06-01", billingEnd: "2027-08-31", premium: 3000, createdBy: userId,
      }).returning();

      const { status } = await callPut(reb!.id, { billingStart: "2027-06-10", deductible: 1000, notes: "sin plan todavía" });
      expect(status).toBe(200);

      const installments = await getInstallments(policyId);
      expect(installments.filter((i) => i.rebillingId === reb!.id).length).toBe(0);
    } finally {
      await cleanupPolicy(policyId);
    }
  });
});

describe("POST /policies/:id/rebillings — alta nueva sigue exigiendo datos de plan", () => {
  test("sin installmentCount devuelve 400", async () => {
    const policyId = await mkPolicy();
    try {
      const { status } = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, firstDueDate: "2027-06-01",
      });
      expect(status).toBe(400);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("sin firstDueDate devuelve 400", async () => {
    const policyId = await mkPolicy();
    try {
      const { status } = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3,
      });
      expect(status).toBe(400);
    } finally {
      await cleanupPolicy(policyId);
    }
  });
});

describe("GET /rebillings/:id/installments/rebuild-check", () => {
  test("detecta cuota pagada", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      const firstInstId = created.body.installments[0].id;
      await db.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, firstInstId));

      const { status, body } = await callRebuildCheck(rebId);
      expect(status).toBe(200);
      expect(body.classification).toBe("REQUIRES_MANUAL_REVIEW");
      expect(body.hasActivity).toBe(true);
      expect(body.blockingInstallments.some((b: any) => b.id === firstInstId)).toBe(true);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("detecta payment vinculado", async () => {
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

      const { body } = await callRebuildCheck(rebId);
      expect(body.classification).toBe("REQUIRES_MANUAL_REVIEW");
      expect(body.hasPayments).toBe(true);
    } finally {
      if (paymentId !== undefined) await deleteWithRetry(() => db.delete(payments).where(eq(payments.id, paymentId!)));
      await cleanupPolicy(policyId);
    }
  });

  test("detecta rendered=1", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      await db.update(policyInstallments).set({ rendered: 1 }).where(eq(policyInstallments.id, created.body.installments[0].id));

      const { body } = await callRebuildCheck(rebId);
      expect(body.classification).toBe("REQUIRES_MANUAL_REVIEW");
      expect(body.hasRendered).toBe(true);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("detecta remittance_items", async () => {
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

      const { body } = await callRebuildCheck(rebId);
      expect(body.classification).toBe("REQUIRES_MANUAL_REVIEW");
      expect(body.hasRemittanceItems).toBe(true);
    } finally {
      if (remId !== undefined) {
        await deleteWithRetry(() => db.delete(remittanceItems).where(eq(remittanceItems.remittanceId, remId!)));
        await deleteWithRetry(() => db.delete(remittances).where(eq(remittances.id, remId!)));
      }
      await cleanupPolicy(policyId);
    }
  });

  test("sin actividad devuelve SAFE_TO_REBUILD con cantidad e importe actuales", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const { status, body } = await callRebuildCheck(created.body.id);
      expect(status).toBe(200);
      expect(body.classification).toBe("SAFE_TO_REBUILD");
      expect(body.currentCount).toBe(3);
      expect(body.currentTotal).toBe(3000);
      expect(body.installmentIds.length).toBe(3);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("refacturación sin cuotas devuelve NO_INSTALLMENTS", async () => {
    const policyId = await mkPolicy();
    try {
      const [reb] = await db.insert(rebillings).values({
        policyId, billingStart: "2027-06-01", billingEnd: "2027-08-31", createdBy: userId,
      }).returning();
      const { body } = await callRebuildCheck(reb!.id);
      expect(body.classification).toBe("NO_INSTALLMENTS");
      expect(body.currentCount).toBe(0);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("rebilling inexistente devuelve 404", async () => {
    const { status } = await callRebuildCheck(9_999_999);
    expect(status).toBe(404);
  });
});

describe("POST /rebillings/:id/installments/rebuild", () => {
  test("bloqueado (cuota pagada) devuelve 409 y no modifica nada", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      await db.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, created.body.installments[0].id));

      const before = await getInstallments(policyId);
      const { status, body } = await callRebuild(rebId, {
        billingStart: "2027-06-01", billingEnd: "2027-10-31", monthlyFee: 2000, installmentCount: 5, firstDueDate: "2027-06-01",
      });
      expect(status).toBe(409);
      expect(body.blockingInstallments.length).toBeGreaterThan(0);

      const after = await getInstallments(policyId);
      expect(after).toEqual(before);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("seguro: reemplaza solo el grupo de esta refacturación, no toca emisión original ni otra refacturación", async () => {
    const policyId = await mkPolicy();
    try {
      await mkOriginalInstallment(policyId, 1, "2027-01-01", 500);
      const rebA = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-06-30", monthlyFee: 1000, installmentCount: 1, firstDueDate: "2027-06-01",
      });
      const rebB = await callPost(policyId, {
        billingStart: "2027-09-01", billingEnd: "2027-10-31", monthlyFee: 800, installmentCount: 2, firstDueDate: "2027-09-01",
      });

      const { status, body } = await callRebuild(rebA.body.id, {
        billingStart: "2027-06-01", billingEnd: "2027-07-31", monthlyFee: 1200, installmentCount: 2, firstDueDate: "2027-06-01",
      });
      expect(status).toBe(200);
      expect(body.previousCount).toBe(1);
      expect(body.insertedCount).toBe(2);
      expect(body.installments.every((i: any) => i.rebillingId === rebA.body.id)).toBe(true);

      const allInst = await getInstallments(policyId);
      expect(allInst.filter((i) => i.rebillingId === null).length).toBe(1); // original intacta
      expect(allInst.filter((i) => i.rebillingId === rebB.body.id).length).toBe(2); // otra refacturación intacta
      expect(allInst.filter((i) => i.rebillingId === rebA.body.id).length).toBe(2); // la corregida
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("segunda petición idéntica (doble submit) no duplica cuotas — reemplaza de nuevo, mismo resultado", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;

      const rebuildBody = { billingStart: "2027-06-01", billingEnd: "2027-09-30", monthlyFee: 1500, installmentCount: 4, firstDueDate: "2027-06-01" };
      const first = await callRebuild(rebId, rebuildBody);
      expect(first.status).toBe(200);
      expect(first.body.insertedCount).toBe(4);

      const second = await callRebuild(rebId, rebuildBody);
      expect(second.status).toBe(200);
      expect(second.body.previousCount).toBe(4); // reemplaza las 4 recién creadas
      expect(second.body.insertedCount).toBe(4);

      const allInst = await getInstallments(policyId);
      expect(allInst.filter((i) => i.rebillingId === rebId).length).toBe(4); // nunca 8
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("ajusta policies.installments por la diferencia", async () => {
    const policyId = await mkPolicy();
    try {
      await db.update(policies).set({ installments: 10 }).where(eq(policies.id, policyId));
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      await callRebuild(created.body.id, {
        billingStart: "2027-06-01", billingEnd: "2027-10-31", monthlyFee: 1000, installmentCount: 5, firstDueDate: "2027-06-01",
      });
      const policy = await getPolicy(policyId);
      expect(policy!.installments).toBe(10 + 3 + 2); // +3 del POST, +2 de diferencia (5-3) del rebuild
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("rebilling inexistente devuelve 404", async () => {
    const { status } = await callRebuild(9_999_999, {
      billingStart: "2027-06-01", billingEnd: "2027-06-30", monthlyFee: 1000, installmentCount: 1, firstDueDate: "2027-06-01",
    });
    expect(status).toBe(404);
  });
});

describe("Caso F — grupo con actividad: corrección de plan bloqueada, edición de metadata permitida", () => {
  test("cuota pagada bloquea POST /rebuild (409) pero PUT de solo notas sigue funcionando (200)", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      await db.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, created.body.installments[0].id));

      const rebuildAttempt = await callRebuild(rebId, {
        billingStart: "2027-06-01", billingEnd: "2027-10-31", monthlyFee: 2000, installmentCount: 5, firstDueDate: "2027-06-01",
      });
      expect(rebuildAttempt.status).toBe(409);

      const editAttempt = await callPut(rebId, { notes: "Nota administrativa pese a tener actividad" });
      expect(editAttempt.status).toBe(200);
      expect(editAttempt.body.notes).toBe("Nota administrativa pese a tener actividad");

      // ninguna de las dos operaciones tocó las cuotas
      const installments = await getInstallments(policyId);
      expect(installments.filter((i) => i.rebillingId === rebId).length).toBe(3);
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("cuota pagada bloquea PUT de campos de plan (409), sin modificar nada", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;
      await db.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, created.body.installments[0].id));

      const { status } = await callPut(rebId, { billingStart: "2027-07-01" });
      expect(status).toBe(409);
    } finally {
      await cleanupPolicy(policyId);
    }
  });
});

describe("Regresión QA visual — rebillingId === objetivo NUNCA es motivo de bloqueo", () => {
  // Reporte: al pulsar "Corregir plan de cuotas" de una refacturación con 3
  // cuotas propias, pendientes, sin actividad, el check las bloqueaba con
  // "La cuota pertenece a una refacturación (rebillingId=N)". Causa real: el
  // botón viejo de reconstrucción a nivel póliza (Subetapa 2B,
  // /policies/:id/installments/rebuild-check) coexistía visualmente con el
  // nuevo y bloquea CUALQUIER cuota con rebillingId no nulo por diseño — es
  // correcto para SU propósito (solo reconstruye la emisión original), pero
  // se confundía con la acción nueva. rebilling-rebuild.ts nunca tuvo esa
  // regla; estos tests lo dejan explícito y a prueba de regresión.
  test("3 cuotas pendientes con rebillingId === objetivo → check permite reconstruir, sin bloqueo por pertenencia", async () => {
    const policyId = await mkPolicy();
    try {
      const created = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-08-31", monthlyFee: 1000, installmentCount: 3, firstDueDate: "2027-06-01",
      });
      const rebId = created.body.id;

      const { status, body } = await callRebuildCheck(rebId);
      expect(status).toBe(200);
      expect(body.classification).toBe("SAFE_TO_REBUILD");
      expect(body.blockingInstallments).toEqual([]);
      expect(body.installmentIds.sort()).toEqual(created.body.installments.map((i: any) => i.id).sort());
      // Ninguna razón de bloqueo debe mencionar jamás la pertenencia a la propia refacturación.
      for (const b of body.blockingInstallments) {
        expect(b.reasons.join(" ")).not.toContain("pertenece a una refacturación");
      }
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("cuota con rebillingId distinto del objetivo: no entra al grupo del check y el rebuild no la toca", async () => {
    const policyId = await mkPolicy();
    try {
      const rebTarget = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-06-30", monthlyFee: 1000, installmentCount: 1, firstDueDate: "2027-06-01",
      });
      const rebOther = await callPost(policyId, {
        billingStart: "2027-09-01", billingEnd: "2027-09-30", monthlyFee: 500, installmentCount: 1, firstDueDate: "2027-09-01",
      });
      const otherInstId = rebOther.body.installments[0].id;
      const otherInstBefore = (await getInstallments(policyId)).find((i) => i.id === otherInstId);

      const { body } = await callRebuildCheck(rebTarget.body.id);
      expect(body.installmentIds).not.toContain(otherInstId);
      expect(body.currentCount).toBe(1);

      const rebuildResult = await callRebuild(rebTarget.body.id, {
        billingStart: "2027-06-01", billingEnd: "2027-07-31", monthlyFee: 1200, installmentCount: 2, firstDueDate: "2027-06-01",
      });
      expect(rebuildResult.status).toBe(200);
      expect(rebuildResult.body.installments.every((i: any) => i.id !== otherInstId)).toBe(true);

      const otherInstAfter = (await getInstallments(policyId)).find((i) => i.id === otherInstId);
      expect(otherInstAfter).toEqual(otherInstBefore); // nunca modificada
    } finally {
      await cleanupPolicy(policyId);
    }
  });

  test("cuota con rebillingId NULL (emisión original) no se incorpora al grupo ni al check", async () => {
    const policyId = await mkPolicy();
    try {
      const originalInstId = await mkOriginalInstallment(policyId, 1, "2027-01-01", 500);
      const rebTarget = await callPost(policyId, {
        billingStart: "2027-06-01", billingEnd: "2027-06-30", monthlyFee: 1000, installmentCount: 1, firstDueDate: "2027-06-01",
      });

      const { body } = await callRebuildCheck(rebTarget.body.id);
      expect(body.installmentIds).not.toContain(originalInstId);
      expect(body.currentCount).toBe(1);

      const originalBefore = (await getInstallments(policyId)).find((i) => i.id === originalInstId);
      await callRebuild(rebTarget.body.id, {
        billingStart: "2027-06-01", billingEnd: "2027-07-31", monthlyFee: 1200, installmentCount: 2, firstDueDate: "2027-06-01",
      });
      const originalAfter = (await getInstallments(policyId)).find((i) => i.id === originalInstId);
      expect(originalAfter).toEqual(originalBefore); // la emisión original nunca se toca ni se vincula
      expect(originalAfter!.rebillingId).toBeNull();
    } finally {
      await cleanupPolicy(policyId);
    }
  });
});
