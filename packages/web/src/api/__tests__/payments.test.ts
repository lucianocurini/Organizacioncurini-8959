/**
 * Tests de Etapa 3A — infraestructura de payment_splits sobre los endpoints
 * reales POST/PUT/DELETE /payments, compatibilidad de lectura (GET /payments)
 * y compatibilidad con rendiciones. Corre exclusivamente contra dev.db local
 * (nunca Turso) — misma estrategia de fixtures aisladas por prefijo que
 * installments-rebuild.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments,
  payments, paymentSplits, remittances, remittanceItems, cashEntries,
} from "../database/schema";
import { eq, inArray, and, sql } from "drizzle-orm";

const SESSION_ID = "test-session-pay-splits-001";
const USER_EMAIL = "test-pay-splits@test.local";
const PREFIX = "TEST-PAY-SPLITS";

let userId: number;
let companyId: number;
let rivadaviaCompanyId: number;
let insuredId: number;
const policyIdsToClean: number[] = [];
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

// Etapa 3B: póliza sobre una compañía "Rivadavia" — necesaria para los tests
// de recargo Pronto Pago, que solo aplica cuando la compañía resuelta
// contiene "rivadavia" (case-insensitive) en su nombre.
async function mkRivadaviaPolicy(): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-RIV-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: "activa", companyId: rivadaviaCompanyId, insuredId,
    startDate: "2027-01-01", endDate: "2027-12-31", isRebilling: 0, createdBy: userId,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}

async function mkInstallment(policyId: number, number: number, dueDate: string, amount: number): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({
    policyId, number, dueDate, amount, status: "pendiente", rendered: 0,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

async function getInstallment(id: number) {
  return db.select().from(policyInstallments).where(eq(policyInstallments.id, id)).get();
}

async function callPost(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/payments", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) paymentIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function callPut(id: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/payments/${id}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

async function callDelete(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/payments/${id}`, {
    method: "DELETE", headers: authHeaders(),
  }));
  return { status: res.status, body: await res.json() };
}

async function getSplits(paymentId: number) {
  return db.select().from(paymentSplits).where(eq(paymentSplits.paymentId, paymentId)).all();
}

// remittance_allocations (Etapa 4C) puede referenciar por FK tanto payments
// como remittances — hay que borrarla antes que sus padres, o el DELETE de
// esos padres falla en silencio (catch(() => {})) y deja huérfanos que
// bloquean la corrida siguiente. Este archivo es previo a esa tabla, así que
// chequea sqlite_master primero en vez de asumir que existe: mismo cleanup
// determinista para beforeAll y afterAll, sin catch genérico.
async function deleteRemittanceAllocationsFor(params: { paymentIds: number[]; remittanceIds: number[] }): Promise<void> {
  const tableExists = await db.get<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'remittance_allocations'`
  );
  if (!tableExists) return;
  if (params.paymentIds.length) {
    await db.run(sql`DELETE FROM remittance_allocations WHERE payment_id IN ${params.paymentIds}`);
  }
  if (params.remittanceIds.length) {
    await db.run(sql`DELETE FROM remittance_allocations WHERE remittance_id IN ${params.remittanceIds}`);
  }
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const polIds = prevPols.map(p => p.id);
    const policyPayRows = polIds.length
      ? await db.select({ id: payments.id }).from(payments).where(inArray(payments.policyId, polIds)).all()
      : [];
    // Pagos manuales/standalone (sin policyId, ej. manualPayer) creados
    // directamente por este usuario — un cascade que solo siguiera
    // policies->payments.policyId los dejaba huérfanos, bloqueando el DELETE
    // de users por FK (payments.created_by), silenciado por el
    // .catch(() => {}) de más abajo.
    const standaloneRows = await db.select({ id: payments.id }).from(payments).where(eq(payments.createdBy, prevUser.id)).all();
    const remRows = await db.select({ id: remittances.id }).from(remittances).where(eq(remittances.createdBy, prevUser.id)).all();

    const allPayIds = [...new Set([...policyPayRows.map(r => r.id), ...standaloneRows.map(r => r.id)])];
    const remIds = remRows.map(r => r.id);

    await deleteRemittanceAllocationsFor({ paymentIds: allPayIds, remittanceIds: remIds });

    if (allPayIds.length) await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, allPayIds)).catch(() => {});
    if (polIds.length) await db.delete(payments).where(inArray(payments.policyId, polIds)).catch(() => {});
    if (standaloneRows.length) await db.delete(payments).where(eq(payments.createdBy, prevUser.id)).catch(() => {});
    if (polIds.length) {
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, polIds)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, polIds)).catch(() => {});
    }
    if (remIds.length) {
      await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remIds)).catch(() => {});
      await db.delete(remittances).where(inArray(remittances.id, remIds)).catch(() => {});
    }
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Pay Splits", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
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
  await deleteRemittanceAllocationsFor({ paymentIds: paymentIdsToClean, remittanceIds: remittanceIdsToClean });

  if (remittanceIdsToClean.length) {
    await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remittanceIdsToClean)).catch(() => {});
    await db.delete(remittances).where(inArray(remittances.id, remittanceIdsToClean)).catch(() => {});
  }
  if (paymentIdsToClean.length) {
    await db.delete(cashEntries).where(inArray(cashEntries.paymentId, paymentIdsToClean)).catch(() => {});
    await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, paymentIdsToClean)).catch(() => {});
    await db.delete(payments).where(inArray(payments.id, paymentIdsToClean)).catch(() => {});
  }
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  await db.delete(insureds).where(eq(insureds.createdBy, userId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

// ─── 4: pago nuevo de un medio crea exactamente un split ──────────────────────

describe("4. POST /payments — un medio crea exactamente un split", () => {
  test("payload sin `splits` (compatibilidad con el frontend actual) crea 1 split", async () => {
    const { status, body } = await callPost({
      manualPayer: "Cliente Manual", manualPolicyNumber: "MAN-001", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(status).toBe(201);
    expect(body.splits.length).toBe(1);
    expect(body.splits[0].paymentId).toBe(body.id);
    expect(body.splits[0].method).toBe("efectivo");
    expect(body.splits[0].amountCents).toBe(100000);
    expect(body.splits[0].notes).toBeNull();

    const rows = await getSplits(body.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.amountCents).toBe(100000);
  });
});

// ─── 6, 7, 8, 9, 10: validaciones de POST /payments ──────────────────────────

describe("Validaciones de POST /payments", () => {
  test("6. splits explícitos que no suman el total exacto → 400", async () => {
    const { status, body } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-002", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 999 }],
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test("7. método inválido → 400", async () => {
    const { status } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-003", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "bitcoin", paymentDate: "2027-01-01",
    });
    expect(status).toBe(400);
  });

  test("8a. amount = 0 → 400", async () => {
    const { status } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-004", manualCompany: "TestCo",
      amount: 0, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(status).toBe(400);
  });

  test("8b. amount negativo → 400", async () => {
    const { status } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-005", manualCompany: "TestCo",
      amount: -500, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(status).toBe(400);
  });

  test("8c. amount no numérico (NaN vía string) → 400", async () => {
    const { status } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-006", manualCompany: "TestCo",
      amount: "no-es-un-numero", paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(status).toBe(400);
  });

  test("8d. amount Infinity → 400", async () => {
    const { status } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-007", manualCompany: "TestCo",
      amount: "Infinity", paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(status).toBe(400);
  });

  test("9. más de dos decimales → 400", async () => {
    const { status } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-008", manualCompany: "TestCo",
      amount: 100.567, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(status).toBe(400);
  });

  test("10. Etapa 3B: dos splits propios ya no se rechazan — 201, paymentMethod combinado", async () => {
    const { status, body } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-009", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 500 }, { method: "transferencia", amount: 500 }],
    });
    expect(status).toBe(201);
    expect(body.paymentMethod).toBe("combinado");
    expect(body.splits.length).toBe(2);
  });
});

// ─── Validación de importe contra la cuota (decisión de esta etapa) ──────────

describe("Importe confirmado vinculado a una cuota debe coincidir exactamente", () => {
  test("importe distinto al de la cuota, confirmado → 400, no crea nada", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status } = await callPost({
      policyId, installmentId: instId, amount: 500, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(status).toBe(400);

    const inst = await getInstallment(instId);
    expect(inst?.status).toBe("pendiente"); // no se tocó
  });

  test("importe exacto, confirmado → 201, marca la cuota pagada", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status } = await callPost({
      policyId, installmentId: instId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(status).toBe(201);

    const inst = await getInstallment(instId);
    expect(inst?.status).toBe("pagada");
  });

  test("importe distinto, status pendiente (no confirmado) → 201, no valida ni marca pagada", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status } = await callPost({
      policyId, installmentId: instId, amount: 999, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      status: "pendiente",
    });
    expect(status).toBe(201);

    const inst = await getInstallment(instId);
    expect(inst?.status).toBe("pendiente");
  });

  test("installmentId que no pertenece a policyId → 400, no crea nada", async () => {
    const policyA = await mkPolicy();
    const policyB = await mkPolicy();
    const instOfB = await mkInstallment(policyB, 1, "2027-01-01", 1000);

    const { status } = await callPost({
      policyId: policyA, installmentId: instOfB, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(status).toBe(400);

    const inst = await getInstallment(instOfB);
    expect(inst?.status).toBe("pendiente");
  });

  test("installmentId inexistente con status pendiente (no confirmado) → 404 igual", async () => {
    const { status } = await callPost({
      installmentId: 999999999, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      status: "pendiente",
    });
    expect(status).toBe(404);
  });

  test("cuota ya pagada no recibe otro pago confirmado (409, no duplica el cobro)", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const first = await callPost({
      policyId, installmentId: instId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect(first.status).toBe(201);

    const second = await callPost({
      policyId, installmentId: instId, amount: 1000, paymentMethod: "transferencia", paymentDate: "2027-01-02",
    });
    expect(second.status).toBe(409);

    const rows = await db.select().from(payments).where(eq(payments.installmentId, instId)).all();
    expect(rows.length).toBe(1); // el segundo intento no se creó
  });
});

// ─── 11: PUT actualiza payment y split atómicamente ──────────────────────────

describe("11. PUT /payments/:id actualiza el split existente", () => {
  test("cambiar amount y paymentMethod actualiza el único split (no crea uno nuevo)", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-010", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    const originalSplitId = created.splits[0].id;

    const { status, body } = await callPut(created.id, { amount: 2500, paymentMethod: "transferencia" });
    expect(status).toBe(200);
    expect(body.splits.length).toBe(1);
    expect(body.splits[0].id).toBe(originalSplitId); // mismo split, actualizado — no uno nuevo
    expect(body.splits[0].amountCents).toBe(250000);
    expect(body.splits[0].method).toBe("transferencia");

    const rows = await getSplits(created.id);
    expect(rows.length).toBe(1);
  });

  test("PUT con método inválido → 400, no modifica el payment", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-011", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });

    const { status } = await callPut(created.id, { paymentMethod: "bitcoin" });
    expect(status).toBe(400);

    const rows = await getSplits(created.id);
    expect(rows[0]!.method).toBe("efectivo"); // sin cambios
  });

  test("cambiar installmentId a uno inexistente → 404, no modifica nada", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-016", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });

    const { status } = await callPut(created.id, { installmentId: 999999999 });
    expect(status).toBe(404);

    const row = await db.select().from(payments).where(eq(payments.id, created.id)).get();
    expect(row?.installmentId).toBeNull();
  });

  test("cambiar installmentId a una cuota de otra póliza → 400", async () => {
    const policyA = await mkPolicy();
    const policyB = await mkPolicy();
    const instOfB = await mkInstallment(policyB, 1, "2027-01-01", 1000);

    const { body: created } = await callPost({
      policyId: policyA, manualPayer: null, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });

    const { status } = await callPut(created.id, { installmentId: instOfB });
    expect(status).toBe(400);
  });

  test("anulado→confirmado revalida el importe contra la cuota", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { body: created } = await callPost({
      policyId, installmentId: instId, amount: 500, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      status: "anulado",
    });
    expect((await getInstallment(instId))?.status).toBe("pendiente"); // anulado no marca pagada

    // Pasarlo a confirmado con el mismo importe (500) que no coincide con la cuota (1000) → 400
    const { status } = await callPut(created.id, { status: "confirmado" });
    expect(status).toBe(400);
    expect((await getInstallment(instId))?.status).toBe("pendiente");
  });

  test("no permite pasar a confirmado si la cuota ya tiene otro pago confirmado válido", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    await callPost({ policyId, installmentId: instId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01" });
    const { body: second } = await callPost({
      policyId, installmentId: instId, amount: 1000, paymentMethod: "transferencia", paymentDate: "2027-01-02",
      status: "anulado",
    });

    const { status } = await callPut(second.id, { status: "confirmado" });
    expect(status).toBe(409);
  });

  test("un payment con cero o más de un split existente falla de forma segura al editar (409)", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-017", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    // Rompe deliberadamente la invariante "exactamente 1 split" para simular
    // un dato inconsistente (nunca debería ocurrir vía la API normal).
    await db.insert(paymentSplits).values({ paymentId: created.id, method: "cheque", amountCents: 1 });

    const { status } = await callPut(created.id, { amount: 1000 });
    expect(status).toBe(409);
  });
});

// ─── 12, 13: DELETE elimina payment+split y recalcula la cuota ───────────────

describe("12-13. DELETE /payments/:id", () => {
  test("elimina el payment y su split, y revierte la cuota a pendiente/vencida", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2099-01-01", 1000); // futura → pendiente al revertir

    const { body: created } = await callPost({
      policyId, installmentId: instId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect((await getInstallment(instId))?.status).toBe("pagada");

    const { status } = await callDelete(created.id);
    expect(status).toBe(200);

    const paymentRow = await db.select().from(payments).where(eq(payments.id, created.id)).get();
    expect(paymentRow).toBeUndefined();
    const splitRows = await getSplits(created.id);
    expect(splitRows.length).toBe(0);

    const inst = await getInstallment(instId);
    expect(inst?.status).toBe("pendiente");
  });

  test("no deja una cuota 'pagada' sin ningún payment confirmado vinculado tras borrar", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2020-01-01", 500); // vencida al revertir

    const { body: created } = await callPost({
      policyId, installmentId: instId, amount: 500, paymentMethod: "cheque", paymentDate: "2027-01-01",
    });
    await callDelete(created.id);

    const inst = await getInstallment(instId);
    expect(inst?.status).toBe("vencida");
  });
});

// ─── 14: confirmado → anulado recalcula la cuota ─────────────────────────────

describe("14. Cambiar status confirmado→anulado recalcula la cuota", () => {
  test("anular el único pago confirmado de una cuota la revierte a pendiente", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2099-01-01", 750);

    const { body: created } = await callPost({
      policyId, installmentId: instId, amount: 750, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect((await getInstallment(instId))?.status).toBe("pagada");

    const { status } = await callPut(created.id, { status: "anulado" });
    expect(status).toBe(200);

    const inst = await getInstallment(instId);
    expect(inst?.status).toBe("pendiente");
  });
});

// ─── 15: cambiar installmentId recalcula cuota anterior y nueva ─────────────

describe("15. Cambiar installmentId recalcula ambas cuotas", () => {
  test("mover un pago de la cuota A a la B: A vuelve a pendiente, B pasa a pagada", async () => {
    const policyId = await mkPolicy();
    const instA = await mkInstallment(policyId, 1, "2099-01-01", 600);
    const instB = await mkInstallment(policyId, 2, "2099-02-01", 600); // mismo importe, evita 400 por mismatch

    const { body: created } = await callPost({
      policyId, installmentId: instA, amount: 600, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    expect((await getInstallment(instA))?.status).toBe("pagada");
    expect((await getInstallment(instB))?.status).toBe("pendiente");

    const { status } = await callPut(created.id, { installmentId: instB });
    expect(status).toBe(200);

    expect((await getInstallment(instA))?.status).toBe("pendiente");
    expect((await getInstallment(instB))?.status).toBe("pagada");
  });
});

// ─── 16: rendered bloquea edición y borrado ──────────────────────────────────

describe("16. rendered=1 bloquea PUT y DELETE", () => {
  test("PUT con cambio contable sobre un pago rendido → 409", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-012", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    await db.update(payments).set({ rendered: 1 }).where(eq(payments.id, created.id));

    const { status } = await callPut(created.id, { amount: 2000 });
    expect(status).toBe(409);
  });

  test("DELETE sobre un pago rendido → 409, no borra nada", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-013", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    await db.update(payments).set({ rendered: 1 }).where(eq(payments.id, created.id));

    const { status } = await callDelete(created.id);
    expect(status).toBe(409);

    const rows = await getSplits(created.id);
    expect(rows.length).toBe(1); // sigue intacto
  });
});

// ─── 17: rendición sigue referenciando un único payments.id ──────────────────

describe("17. Rendición de un pago con splits sigue rindiendo un único payments.id", () => {
  test("POST /remittances con source=payment funciona igual, sin conocer payment_splits", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-014", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });

    const res = await app.fetch(new Request("http://localhost/api/remittances", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        date: "2027-01-02", canal: "directo",
        paymentBreakdown: { efectivo: 1000 },
        items: [{ source: "payment", sourceId: created.id, amount: 1000, debtorStatus: "pagado" }],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    remittanceIdsToClean.push(body.id);

    const paymentRow = await db.select({ rendered: payments.rendered }).from(payments).where(eq(payments.id, created.id)).get();
    expect(paymentRow?.rendered).toBe(1);

    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, body.id)).all();
    expect(items.length).toBe(1); // un único ítem por el pago, sin fragmentarse por splits
    expect(items[0]!.sourceId).toBe(created.id);
  });
});

// ─── 18: Caja y listados existentes reciben amount/paymentMethod sin cambio ──

describe("18. GET /payments mantiene amount/paymentMethod y agrega splits de forma aditiva", () => {
  test("la fila del listado conserva la forma esperada por Cobranzas/Caja", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-015", manualCompany: "TestCo",
      amount: 1234, paymentMethod: "transferencia", paymentDate: "2027-01-01",
    });

    const res = await app.fetch(new Request(`http://localhost/api/payments`, { headers: authHeaders() }));
    const list = await res.json();
    const row = list.find((r: any) => r.payment.id === created.id);
    expect(row).toBeDefined();
    expect(row.payment.amount).toBe(1234);
    expect(row.payment.paymentMethod).toBe("transferencia");
    expect(Array.isArray(row.payment.splits)).toBe(true);
    expect(row.payment.splits.length).toBe(1);
  });
});

// ─── 19: pagos históricos (sin splits) siguen legibles ───────────────────────

describe("19. Un payment histórico sin ningún split sigue siendo legible", () => {
  test("GET /payments no rompe con una fila pre-3A (splits: [])", async () => {
    const [historic] = await db.insert(payments).values({
      manualPayer: "Historico", manualPolicyNumber: "MAN-HIST", manualCompany: "TestCo",
      amount: 999, paymentMethod: "efectivo", paymentDate: "2020-01-01",
      status: "confirmado", createdBy: userId,
    }).returning();
    paymentIdsToClean.push(historic!.id);

    const res = await app.fetch(new Request("http://localhost/api/payments", { headers: authHeaders() }));
    const list = await res.json();
    const row = list.find((r: any) => r.payment.id === historic!.id);
    expect(row).toBeDefined();
    expect(row.payment.amount).toBe(999);
    expect(row.payment.splits).toEqual([]);
  });
});

// ─── 21: GET /payments ordena los splits por id ascendente ──────────────────

describe("21. GET /payments ordena los splits por id ascendente", () => {
  test("varios splits creados directamente en el fixture se leen en orden de id, no de inserción por otro criterio", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-018", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    // Etapa 3A solo permite 1 split vía API — se insertan splits adicionales
    // directamente en el fixture (como en 3B) para probar el orden de lectura.
    await db.delete(paymentSplits).where(eq(paymentSplits.paymentId, created.id));
    await db.insert(paymentSplits).values({ paymentId: created.id, method: "cheque", amountCents: 300 });
    await db.insert(paymentSplits).values({ paymentId: created.id, method: "transferencia", amountCents: 500 });
    await db.insert(paymentSplits).values({ paymentId: created.id, method: "efectivo", amountCents: 200 });

    const res = await app.fetch(new Request("http://localhost/api/payments", { headers: authHeaders() }));
    const list = await res.json();
    const row = list.find((r: any) => r.payment.id === created.id);
    expect(row).toBeDefined();
    // El orden de inserción (300, 500, 200) no coincide con ningún orden
    // alfabético/numérico salvo el de id ascendente — si el ORDER BY se
    // rompiera, este orden dejaría de coincidir.
    expect(row.payment.splits.map((s: any) => s.amountCents)).toEqual([300, 500, 200]);
    expect(row.payment.splits.map((s: any) => s.method)).toEqual(["cheque", "transferencia", "efectivo"]);
  });
});

// ─── 5, 20: rollback transaccional ante un fallo real ────────────────────────

describe("5 y 20. Rollback transaccional real (tx real, no mocks)", () => {
  test("un INSERT de payment_splits que viola el CHECK revierte también el payments recién insertado", async () => {
    const before = await db.select({ id: payments.id }).from(payments).all();
    const beforeIds = new Set(before.map(r => r.id));

    let threw = false;
    try {
      await db.transaction(async (tx) => {
        const [p] = await tx.insert(payments).values({
          manualPayer: "Rollback Test", manualPolicyNumber: "MAN-ROLLBACK", manualCompany: "TestCo",
          amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
          status: "confirmado", createdBy: userId,
        }).returning();
        // amountCents=0 viola CHECK(amount_cents > 0) — fallo real de SQLite, no un mock.
        await tx.insert(paymentSplits).values({ paymentId: p!.id, method: "efectivo", amountCents: 0 });
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const after = await db.select({ id: payments.id }).from(payments).all();
    const newRows = after.filter(r => !beforeIds.has(r.id));
    expect(newRows.length).toBe(0); // el payments insertado en la misma tx también se revirtió
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ETAPA 3B — medios de pago combinados (2+ payment_splits por payment)
// ═══════════════════════════════════════════════════════════════════════════

describe("3B.1-10. POST /payments con medios combinados", () => {
  test("1. dos splits propios (efectivo + transferencia) → 201, combinado, 2 splits", async () => {
    const { status, body } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-001", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });
    expect(status).toBe(201);
    expect(body.paymentMethod).toBe("combinado");
    expect(body.splits.length).toBe(2);
    const rows = await getSplits(body.id);
    expect(rows.length).toBe(2);
  });

  test("2. tres splits propios (efectivo + transferencia + cheque) → 201, 3 splits", async () => {
    const { status, body } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-002", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [
        { method: "efectivo", amount: 400 },
        { method: "transferencia", amount: 350 },
        { method: "cheque", amount: 250 },
      ],
    });
    expect(status).toBe(201);
    expect(body.paymentMethod).toBe("combinado");
    expect(body.splits.length).toBe(3);
  });

  test("3. dos splits directos a compañía (transferencia_compania + link_pago) → 201, combinado", async () => {
    const { status, body } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-003", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "transferencia_compania", paymentDate: "2027-01-01",
      splits: [
        { method: "transferencia_compania", amount: 600 },
        { method: "link_pago", amount: 400 },
      ],
    });
    expect(status).toBe(201);
    expect(body.paymentMethod).toBe("combinado");
    expect(body.splits.length).toBe(2);
  });

  test("4. mixed (propio + directo a compañía) → 400, sin persistencia", async () => {
    const before = await db.select({ id: payments.id }).from(payments).all();
    const { status, body } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-004", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 500 }, { method: "transferencia_compania", amount: 500 }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("No se pueden combinar medios propios con pagos directos a la compañía");
    const after = await db.select({ id: payments.id }).from(payments).all();
    expect(after.length).toBe(before.length);
  });

  test("5. métodos repetidos dentro del mismo grupo se permiten (dos transferencias)", async () => {
    const { status, body } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-005", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "transferencia", paymentDate: "2027-01-01",
      splits: [{ method: "transferencia", amount: 400 }, { method: "transferencia", amount: 600 }],
    });
    expect(status).toBe(201);
    expect(body.splits.length).toBe(2);
    expect(body.splits.every((s: any) => s.method === "transferencia")).toBe(true);
  });

  test("8. suma combinada menor al total → 400", async () => {
    const { status } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-008", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 400 }, { method: "transferencia", amount: 400 }],
    });
    expect(status).toBe(400);
  });

  test("9. suma combinada mayor al total → 400", async () => {
    const { status } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-009", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 700 }, { method: "transferencia", amount: 500 }],
    });
    expect(status).toBe(400);
  });

  test("10. centavos exactos en un combinado de 3 splits (33.33 + 33.33 + 33.34)", async () => {
    const { status, body } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-010", manualCompany: "TestCo",
      amount: 100, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [
        { method: "efectivo", amount: 33.33 },
        { method: "transferencia", amount: 33.33 },
        { method: "cheque", amount: 33.34 },
      ],
    });
    expect(status).toBe(201);
    expect(body.splits.map((s: any) => s.amountCents)).toEqual([3333, 3333, 3334]);
  });
});

describe("3B.11-12. Validación contra la cuota con medios combinados", () => {
  test("11. cuota se marca pagada con el total combinado exacto (2 splits)", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { status } = await callPost({
      policyId, installmentId: instId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });
    expect(status).toBe(201);
    const inst = await getInstallment(instId);
    expect(inst?.status).toBe("pagada");
  });

  test("12. importe combinado distinto de la cuota → 400, no crea nada ni toca la cuota", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { status } = await callPost({
      policyId, installmentId: instId, amount: 900, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 300 }],
    });
    expect(status).toBe(400);
    const inst = await getInstallment(instId);
    expect(inst?.status).toBe("pendiente");
  });
});

describe("3B.13-19. PUT /payments/:id con medios combinados", () => {
  test("13. PUT uno→varios: reemplazo completo, no conserva el id del split viejo", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-013", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    const originalSplitId = created.splits[0].id;

    const { status, body } = await callPut(created.id, {
      splits: [{ method: "efectivo", amount: 600 }, { method: "cheque", amount: 400 }],
    });
    expect(status).toBe(200);
    expect(body.paymentMethod).toBe("combinado");
    expect(body.splits.length).toBe(2);
    expect(body.splits.some((s: any) => s.id === originalSplitId)).toBe(false);
  });

  test("14. PUT varios→uno: reemplaza 2 splits por 1, paymentMethod vuelve a un método real", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-014", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });
    expect(created.splits.length).toBe(2);

    const { status, body } = await callPut(created.id, { splits: [{ method: "cheque", amount: 1000 }] });
    expect(status).toBe(200);
    expect(body.paymentMethod).toBe("cheque");
    expect(body.splits.length).toBe(1);
    const rows = await getSplits(created.id);
    expect(rows.length).toBe(1);
  });

  test("15. PUT varios→varios: reemplaza 2 splits por 3 distintos", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-015", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });
    const { status, body } = await callPut(created.id, {
      splits: [
        { method: "efectivo", amount: 300 }, { method: "transferencia", amount: 300 }, { method: "cheque", amount: 400 },
      ],
    });
    expect(status).toBe(200);
    expect(body.splits.length).toBe(3);
    const rows = await getSplits(created.id);
    expect(rows.length).toBe(3);
  });

  test("16. PUT con grupo mixed → 400, conserva los splits anteriores intactos", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-016", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    const { status } = await callPut(created.id, {
      splits: [{ method: "efectivo", amount: 500 }, { method: "link_pago", amount: 500 }],
    });
    expect(status).toBe(400);
    const rows = await getSplits(created.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.method).toBe("efectivo");
  });

  test("17. cliente legacy cambia amount sin enviar splits en un combinado → 409, no modifica nada", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-017", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });
    const { status, body } = await callPut(created.id, { amount: 2000 });
    expect(status).toBe(409);
    expect(body.error).toContain("desglose completo");
    const rows = await getSplits(created.id);
    expect(rows.length).toBe(2);
    const paymentRow = await db.select({ amount: payments.amount }).from(payments).where(eq(payments.id, created.id)).get();
    expect(paymentRow?.amount).toBe(1000);
  });

  test("18. rendered=1 bloquea el envío de splits nuevos", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-018", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    await db.update(payments).set({ rendered: 1 }).where(eq(payments.id, created.id));
    const { status } = await callPut(created.id, {
      splits: [{ method: "efectivo", amount: 500 }, { method: "transferencia", amount: 500 }],
    });
    expect(status).toBe(409);
    const rows = await getSplits(created.id);
    expect(rows.length).toBe(1);
  });

  test("19. anular un pago combinado conserva sus splits y recalcula la cuota", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2099-01-01", 1000);
    const { body: created } = await callPost({
      policyId, installmentId: instId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });
    expect((await getInstallment(instId))?.status).toBe("pagada");

    const { status } = await callPut(created.id, { status: "anulado" });
    expect(status).toBe(200);

    const rows = await getSplits(created.id);
    expect(rows.length).toBe(2);

    const inst = await getInstallment(instId);
    expect(inst?.status).toBe("pendiente");
  });
});

describe("3B.20. DELETE con medios combinados", () => {
  test("20. DELETE borra los 3 splits de un pago combinado y el propio pago", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-020", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [
        { method: "efectivo", amount: 400 }, { method: "transferencia", amount: 350 }, { method: "cheque", amount: 250 },
      ],
    });
    expect(created.splits.length).toBe(3);

    const { status } = await callDelete(created.id);
    expect(status).toBe(200);

    const rows = await getSplits(created.id);
    expect(rows.length).toBe(0);
    const paymentRow = await db.select().from(payments).where(eq(payments.id, created.id)).get();
    expect(paymentRow).toBeUndefined();
  });
});

describe("3B.21. Rollback transaccional con 3 splits", () => {
  test("21. si el tercer split viola el CHECK, se revierte el payment y los otros 2 splits", async () => {
    const before = await db.select({ id: payments.id }).from(payments).all();
    const beforeIds = new Set(before.map(r => r.id));
    let paymentIdAttempted: number | null = null;

    let threw = false;
    try {
      await db.transaction(async (tx) => {
        const [p] = await tx.insert(payments).values({
          manualPayer: "Rollback 3 Splits", manualPolicyNumber: "MAN-ROLLBACK-3B", manualCompany: "TestCo",
          amount: 1000, paymentMethod: "combinado", paymentDate: "2027-01-01",
          status: "confirmado", createdBy: userId,
        }).returning();
        paymentIdAttempted = p!.id;
        await tx.insert(paymentSplits).values({ paymentId: p!.id, method: "efectivo", amountCents: 40000 });
        await tx.insert(paymentSplits).values({ paymentId: p!.id, method: "transferencia", amountCents: 35000 });
        // El tercer split viola CHECK(amount_cents > 0) — fallo real de SQLite.
        await tx.insert(paymentSplits).values({ paymentId: p!.id, method: "cheque", amountCents: 0 });
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const after = await db.select({ id: payments.id }).from(payments).all();
    expect(after.filter(r => !beforeIds.has(r.id)).length).toBe(0);

    if (paymentIdAttempted != null) {
      const orphanSplits = await db.select().from(paymentSplits).where(eq(paymentSplits.paymentId, paymentIdAttempted)).all();
      expect(orphanSplits.length).toBe(0); // ni los 2 splits válidos insertados antes del fallo sobreviven
    }
  });
});

describe("3B.22-24. Pronto Pago con medios combinados", () => {
  test("22. todos los splits propios + Rivadavia → aplica el recargo una sola vez", async () => {
    const policyId = await mkRivadaviaPolicy();
    const { body: created } = await callPost({
      policyId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });
    const surcharges = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, created.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(1);
    expect(surcharges[0]!.amount).toBe(800);
  });

  test("23. todos los splits directos a compañía + Rivadavia → NO aplica el recargo", async () => {
    const policyId = await mkRivadaviaPolicy();
    const { body: created } = await callPost({
      policyId, amount: 1000, paymentMethod: "transferencia_compania", paymentDate: "2027-01-01",
      splits: [{ method: "transferencia_compania", amount: 600 }, { method: "link_pago", amount: 400 }],
    });
    const surcharges = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, created.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(0);
  });

  test("24. mixed con compañía Rivadavia nunca llega a calcular el recargo (se rechaza antes)", async () => {
    const policyId = await mkRivadaviaPolicy();
    const before = await db.select({ id: cashEntries.id }).from(cashEntries)
      .where(eq(cashEntries.entryType, "pronto_pago_surcharge")).all();
    const { status } = await callPost({
      policyId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 500 }, { method: "link_pago", amount: 500 }],
    });
    expect(status).toBe(400);
    const after = await db.select({ id: cashEntries.id }).from(cashEntries)
      .where(eq(cashEntries.entryType, "pronto_pago_surcharge")).all();
    expect(after.length).toBe(before.length);
  });
});

describe("3B.25-26. GET /payments — filtro por método y stats", () => {
  test("25. GET /payments?method= matchea por cualquier split de un combinado", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-025", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "cheque", amount: 400 }],
    });
    const res = await app.fetch(new Request("http://localhost/api/payments?method=cheque", { headers: authHeaders() }));
    const list = await res.json();
    expect(list.some((r: any) => r.payment.id === created.id)).toBe(true);
  });

  test("26. GET /payments/stats suma por split real, total no se duplica", async () => {
    const statsBefore = await (await app.fetch(new Request("http://localhost/api/payments/stats", { headers: authHeaders() }))).json();

    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-026", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });
    paymentIdsToClean.push(created.id);

    const statsAfter = await (await app.fetch(new Request("http://localhost/api/payments/stats", { headers: authHeaders() }))).json();

    expect(statsAfter.total - statsBefore.total).toBe(1000);
    expect(statsAfter.byMethod.efectivo - (statsBefore.byMethod.efectivo || 0)).toBe(600);
    expect(statsAfter.byMethod.transferencia - (statsBefore.byMethod.transferencia || 0)).toBe(400);
    expect(statsAfter.byMethod.combinadoCount - (statsBefore.byMethod.combinadoCount || 0)).toBe(1);
  });
});

describe("3B.27-29. Caja — buckets por método real, sin duplicar el total", () => {
  test("27-28. cash/summary separa efectivo/cheque por split y no duplica cartera.total", async () => {
    const before = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();

    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-027", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "cheque", amount: 400 }],
    });
    paymentIdsToClean.push(created.id);

    const after = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();

    expect(after.cartera.efectivo - before.cartera.efectivo).toBe(600);
    expect(after.cartera.cheque - before.cartera.cheque).toBe(400);
    expect(after.cartera.total - before.cartera.total).toBe(1000);
  });

  test("29. GET /cash/payments/transferencias muestra solo la porción transferencia_compania de un combinado", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-029", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "transferencia_compania", paymentDate: "2027-01-01",
      splits: [{ method: "transferencia_compania", amount: 600 }, { method: "link_pago", amount: 400 }],
    });
    const res = await app.fetch(new Request("http://localhost/api/cash/payments/transferencias", { headers: authHeaders() }));
    const list = await res.json();
    const row = list.find((r: any) => r.id === created.id);
    expect(row).toBeDefined();
    expect(row.amount).toBe(1000);
    expect(row.transferenciaCompaniaAmount).toBe(600);
  });
});

describe("3B.30-31. Rendiciones con medios combinados", () => {
  test("30. rendir un pago combinado sigue creando un único remittanceItem", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-030", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });

    const res = await app.fetch(new Request("http://localhost/api/remittances", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        date: "2027-01-02", canal: "directo",
        paymentBreakdown: { efectivo: 600, transferencia: 400 },
        items: [{ source: "payment", sourceId: created.id, amount: 1000, debtorStatus: "pagado" }],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    remittanceIdsToClean.push(body.id);

    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, body.id)).all();
    expect(items.length).toBe(1);
    expect(items[0]!.sourceId).toBe(created.id);

    const paymentRow = await db.select({ rendered: payments.rendered }).from(payments).where(eq(payments.id, created.id)).get();
    expect(paymentRow?.rendered).toBe(1);
  });

  test("31. GET /remittances/pending expone splits y paymentGroup de un combinado", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-031", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });

    const res = await app.fetch(new Request("http://localhost/api/remittances/pending", { headers: authHeaders() }));
    const list = await res.json();
    const row = list.find((r: any) => r.source === "payment" && r.sourceId === created.id);
    expect(row).toBeDefined();
    expect(row.paymentGroup).toBe("own");
    expect(row.splits.length).toBe(2);
  });
});

describe("3B.32. Compatibilidad histórica con un solo split", () => {
  test("32. un payment de un solo split se sigue creando/editando igual que antes de 3B", async () => {
    const { body: created } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-3B-032", manualCompany: "TestCo",
      amount: 500, paymentMethod: "transferencia", paymentDate: "2027-01-01",
    });
    expect(created.paymentMethod).toBe("transferencia");
    expect(created.splits.length).toBe(1);

    const { status, body } = await callPut(created.id, { amount: 700 });
    expect(status).toBe(200);
    expect(body.splits.length).toBe(1);
    expect(body.splits[0].id).toBe(created.splits[0].id);
  });
});

// ─── Recargo Pronto Pago como categoría separada en Caja ─────────────────────
// El cashEntry pronto_pago_surcharge no tiene splits propios (no es un
// "payment"): su monto fijo ($800) va a cartera.recargosProntoPago, nunca a
// efectivo/transferencia/cheque — identificado por entryType, no por
// paymentMethod (que puede valer "combinado").

describe("3B.33-38. Recargo Pronto Pago — categoría separada en Caja", () => {
  test("33. Rivadavia, un solo medio propio: el payment va a su bucket real, el recargo a recargosProntoPago, total una sola vez cada uno", async () => {
    const before = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();

    const policyId = await mkRivadaviaPolicy();
    const { body: created } = await callPost({
      policyId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    paymentIdsToClean.push(created.id);

    const after = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();

    expect(after.cartera.efectivo - before.cartera.efectivo).toBe(1000);
    expect(after.cartera.recargosProntoPago - before.cartera.recargosProntoPago).toBe(800);
    expect(after.cartera.total - before.cartera.total).toBe(1800);
  });

  test("34. Rivadavia combinado efectivo + transferencia: cada split en su bucket, recargo únicamente en recargosProntoPago, nada bajo 'combinado'", async () => {
    const before = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();

    const policyId = await mkRivadaviaPolicy();
    const { body: created } = await callPost({
      policyId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });
    paymentIdsToClean.push(created.id);

    const after = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();

    expect(after.cartera.efectivo - before.cartera.efectivo).toBe(600);
    expect(after.cartera.transferencia - before.cartera.transferencia).toBe(400);
    expect(after.cartera.recargosProntoPago - before.cartera.recargosProntoPago).toBe(800);
    expect(after.cartera.total - before.cartera.total).toBe(1800); // 600 + 400 + 800, cada uno una vez
    expect(after.cartera).not.toHaveProperty("combinado");
  });

  test("35. Rivadavia con métodos directos a compañía: no crea recargo, recargosProntoPago no cambia", async () => {
    const before = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();

    const policyId = await mkRivadaviaPolicy();
    const { body: created } = await callPost({
      policyId, amount: 1000, paymentMethod: "transferencia_compania", paymentDate: "2027-01-01",
    });
    paymentIdsToClean.push(created.id);

    const surcharges = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, created.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(0);

    const after = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();
    expect(after.cartera.recargosProntoPago).toBe(before.cartera.recargosProntoPago);
  });

  test("36. editar con applyProntoPagoSurcharge=false elimina el recargo y actualiza recargosProntoPago", async () => {
    const policyId = await mkRivadaviaPolicy();
    const { body: created } = await callPost({
      policyId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    const surchargesBefore = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, created.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surchargesBefore.length).toBe(1);

    const before = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();

    const { status } = await callPut(created.id, { applyProntoPagoSurcharge: false });
    expect(status).toBe(200);

    const surchargesAfter = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, created.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surchargesAfter.length).toBe(0);

    const after = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();
    expect(after.cartera.recargosProntoPago - before.cartera.recargosProntoPago).toBe(-800);
  });

  test("37. anular un pago Rivadavia no deja el recargo activo (se borra aunque no se envíe applyProntoPagoSurcharge)", async () => {
    const policyId = await mkRivadaviaPolicy();
    const { body: created } = await callPost({
      policyId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    const surchargesBefore = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, created.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surchargesBefore.length).toBe(1);

    const before = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();

    const { status } = await callPut(created.id, { status: "anulado" });
    expect(status).toBe(200);

    const surchargesAfter = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, created.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surchargesAfter.length).toBe(0);

    const after = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();
    expect(after.cartera.recargosProntoPago - before.cartera.recargosProntoPago).toBe(-800);
  });

  test("38. no duplicación: el total del payment y el recargo se cuentan cada uno exactamente una vez en cartera.total", async () => {
    const before = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();

    const policyId = await mkRivadaviaPolicy();
    const { body: created } = await callPost({
      policyId, amount: 2500, paymentMethod: "cheque", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 1000 }, { method: "cheque", amount: 1500 }],
    });
    paymentIdsToClean.push(created.id);

    const after = await (await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }))).json();

    // 2500 (payment, repartido en sus 2 splits) + 800 (recargo) = 3300, ni más ni menos.
    expect(after.cartera.total - before.cartera.total).toBe(3300);
    expect(after.cartera.efectivo - before.cartera.efectivo).toBe(1000);
    expect(after.cartera.cheque - before.cartera.cheque).toBe(1500);
    expect(after.cartera.recargosProntoPago - before.cartera.recargosProntoPago).toBe(800);
  });
});

// ─── Hotfix Pronto Pago Rivadavia — recargo huérfano tras editar la póliza ────
// Reportado en producción: al armar una rendición de canal "pronto_pago" con
// varias cuotas de El Norte + una de Rivadavia, el modal mostraba 2 × $800 en
// vez de 1 × $800. Causa real: un pago que alguna vez fue Rivadavia y luego
// se corrigió a otra compañía (PUT /payments sin enviar
// applyProntoPagoSurcharge, porque el frontend deja de mostrar el checkbox
// apenas la póliza deja de ser Rivadavia) dejaba su cash_entry
// pronto_pago_surcharge activo y huérfano — GET /remittances/pending y POST
// /remittances lo seguían contando como si el pago siguiera siendo de
// Rivadavia. Los tests de acá simulan tanto la prevención (edición vía PUT)
// como la defensa ante datos ya huérfanos de antes de este fix (reasignación
// directa en DB, sin pasar por PUT).
describe("Hotfix Pronto Pago Rivadavia — recargo huérfano", () => {
  test("39. PUT sin applyProntoPagoSurcharge: si el pago pasa a una póliza no-Rivadavia, borra el recargo huérfano", async () => {
    const rivPolicyId = await mkRivadaviaPolicy();
    const elNortePolicyId = await mkPolicy();
    const { body: created } = await callPost({
      policyId: rivPolicyId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    const surchargesBefore = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, created.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surchargesBefore.length).toBe(1);

    // Mismo flujo real del frontend: se corrige la póliza del pago, el
    // checkbox de recargo ya no se muestra (showSurchargeCheckbox=false) y
    // applyProntoPagoSurcharge nunca viaja en el body.
    const { status } = await callPut(created.id, { policyId: elNortePolicyId });
    expect(status).toBe(200);

    const surchargesAfter = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, created.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surchargesAfter.length).toBe(0);
  });

  test("40. GET /remittances/pending no cuenta un recargo huérfano de un pago ya no-Rivadavia (datos huérfanos previos al fix)", async () => {
    const rivPolicyId = await mkRivadaviaPolicy();
    const elNortePolicyId = await mkPolicy();
    const { body: created } = await callPost({
      policyId: rivPolicyId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    paymentIdsToClean.push(created.id);
    // Reasignación directa en DB (no vía PUT): simula un recargo que ya
    // había quedado huérfano en producción ANTES de este hotfix.
    await db.update(payments).set({ policyId: elNortePolicyId }).where(eq(payments.id, created.id));

    const res = await app.fetch(new Request("http://localhost/api/remittances/pending", { headers: authHeaders() }));
    const list = await res.json();
    const row = list.find((r: any) => r.source === "payment" && r.sourceId === created.id);
    expect(row).toBeDefined();
    expect(row.hasSurcharge).toBe(false);
  });

  test("41. POST /remittances (pronto_pago): un recargo huérfano no se cobra ni se incluye como remittanceItem", async () => {
    const rivPolicyId = await mkRivadaviaPolicy();
    const elNortePolicyId = await mkPolicy();
    const { body: orphanPayment } = await callPost({
      policyId: rivPolicyId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    paymentIdsToClean.push(orphanPayment.id);
    await db.update(payments).set({ policyId: elNortePolicyId }).where(eq(payments.id, orphanPayment.id));

    const res = await app.fetch(new Request("http://localhost/api/remittances", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        date: "2027-01-02", canal: "pronto_pago",
        paymentBreakdown: { efectivo: 1000 },
        items: [{ source: "payment", sourceId: orphanPayment.id, amount: 1000, debtorStatus: "pagado" }],
      }),
    }));
    // Sin el fix, el backend sumaría el recargo huérfano ($1800) y esto
    // fallaría con 400 por no coincidir con paymentBreakdown ($1000).
    expect(res.status).toBe(200);
    const body = await res.json();
    remittanceIdsToClean.push(body.id);
    const remRow = await db.select().from(remittances).where(eq(remittances.id, body.id)).get();
    expect(remRow?.totalAmount).toBe(1000);

    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, body.id)).all();
    expect(items.length).toBe(1);
    expect(items.every((it) => it.source !== "cash_entry")).toBe(true);
  });

  test("42. Escenario reportado: 3 cuotas El Norte (una con recargo huérfano) + 1 Rivadavia real → recargo total $800, no $1600", async () => {
    const rivPolicyId = await mkRivadaviaPolicy();
    const elNortePolicyId = await mkPolicy();

    const { body: rivPayment } = await callPost({
      policyId: rivPolicyId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    paymentIdsToClean.push(rivPayment.id);

    const { body: orphanPayment } = await callPost({
      policyId: rivPolicyId, amount: 500, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    paymentIdsToClean.push(orphanPayment.id);
    await db.update(payments).set({ policyId: elNortePolicyId }).where(eq(payments.id, orphanPayment.id));

    const { body: elNorte2 } = await callPost({
      policyId: elNortePolicyId, amount: 300, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    paymentIdsToClean.push(elNorte2.id);
    const { body: elNorte3 } = await callPost({
      policyId: elNortePolicyId, amount: 200, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    paymentIdsToClean.push(elNorte3.id);

    const totalBase = 1000 + 500 + 300 + 200;
    const res = await app.fetch(new Request("http://localhost/api/remittances", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        date: "2027-01-02", canal: "pronto_pago",
        paymentBreakdown: { efectivo: totalBase + 800 },
        prontoPagoSurcharge: 800,
        items: [
          { source: "payment", sourceId: rivPayment.id, amount: 1000, debtorStatus: "pagado" },
          { source: "payment", sourceId: orphanPayment.id, amount: 500, debtorStatus: "pagado" },
          { source: "payment", sourceId: elNorte2.id, amount: 300, debtorStatus: "pagado" },
          { source: "payment", sourceId: elNorte3.id, amount: 200, debtorStatus: "pagado" },
        ],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    remittanceIdsToClean.push(body.id);
    const remRow = await db.select().from(remittances).where(eq(remittances.id, body.id)).get();
    expect(remRow?.totalAmount).toBe(totalBase + 800);

    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, body.id)).all();
    const surchargeItems = items.filter((it) => it.source === "cash_entry");
    expect(surchargeItems.length).toBe(1);
    expect(surchargeItems[0]!.amount).toBe(800);
  });

  test("43. 0 Rivadavia entre los ítems seleccionados → sin recargo, canal pronto_pago no fuerza nada", async () => {
    const elNortePolicyId = await mkPolicy();
    const { body: created } = await callPost({
      policyId: elNortePolicyId, amount: 400, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    paymentIdsToClean.push(created.id);

    const res = await app.fetch(new Request("http://localhost/api/remittances", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        date: "2027-01-02", canal: "pronto_pago",
        paymentBreakdown: { efectivo: 400 },
        items: [{ source: "payment", sourceId: created.id, amount: 400, debtorStatus: "pagado" }],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    remittanceIdsToClean.push(body.id);
    const remRow = await db.select().from(remittances).where(eq(remittances.id, body.id)).get();
    expect(remRow?.totalAmount).toBe(400);

    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, body.id)).all();
    expect(items.length).toBe(1);
  });

  test("44. 2 pólizas Rivadavia distintas seleccionadas → $1600, cada una con su propio recargo (no se deduplica entre pólizas distintas)", async () => {
    const rivPolicyA = await mkRivadaviaPolicy();
    const rivPolicyB = await mkRivadaviaPolicy();
    const { body: paymentA } = await callPost({
      policyId: rivPolicyA, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    paymentIdsToClean.push(paymentA.id);
    const { body: paymentB } = await callPost({
      policyId: rivPolicyB, amount: 700, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    });
    paymentIdsToClean.push(paymentB.id);

    const res = await app.fetch(new Request("http://localhost/api/remittances", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        date: "2027-01-02", canal: "pronto_pago",
        paymentBreakdown: { efectivo: 1000 + 700 + 1600 },
        items: [
          { source: "payment", sourceId: paymentA.id, amount: 1000, debtorStatus: "pagado" },
          { source: "payment", sourceId: paymentB.id, amount: 700, debtorStatus: "pagado" },
        ],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    remittanceIdsToClean.push(body.id);
    const remRow = await db.select().from(remittances).where(eq(remittances.id, body.id)).get();
    expect(remRow?.totalAmount).toBe(1000 + 700 + 1600);

    const items = await db.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, body.id)).all();
    const surchargeItems = items.filter((it) => it.source === "cash_entry");
    expect(surchargeItems.length).toBe(2);
    expect(surchargeItems.reduce((s, it) => s + it.amount, 0)).toBe(1600);
  });

  test("45. manual_debt con compañía 'Rivadavia' tipeada a mano sigue sumando el recargo (regla explícita existente, sin policyId real)", async () => {
    const res = await app.fetch(new Request("http://localhost/api/remittances", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        date: "2027-01-02", canal: "pronto_pago",
        paymentBreakdown: { efectivo: 300 + 800 },
        items: [{
          source: "manual_debt", sourceId: null, amount: 300, debtorStatus: "adeudado",
          clientName: "Deudor Manual", policyNumber: "MAN-RIV-045", companyName: "Rivadavia",
        }],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    remittanceIdsToClean.push(body.id);
    const remRow = await db.select().from(remittances).where(eq(remittances.id, body.id)).get();
    expect(remRow?.totalAmount).toBe(300 + 800);
  });
});
