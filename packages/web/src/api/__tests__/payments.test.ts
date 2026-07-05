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
  payments, paymentSplits, remittances, remittanceItems,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-pay-splits-001";
const USER_EMAIL = "test-pay-splits@test.local";
const PREFIX = "TEST-PAY-SPLITS";

let userId: number;
let companyId: number;
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

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const polIds = prevPols.map(p => p.id);
    if (polIds.length) {
      const payRows = await db.select({ id: payments.id }).from(payments).where(inArray(payments.policyId, polIds)).all();
      const payIds = payRows.map(r => r.id);
      if (payIds.length) await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds)).catch(() => {});
      await db.delete(payments).where(inArray(payments.policyId, polIds)).catch(() => {});
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, polIds)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, polIds)).catch(() => {});
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

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(async () => {
  if (remittanceIdsToClean.length) {
    await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remittanceIdsToClean)).catch(() => {});
    await db.delete(remittances).where(inArray(remittances.id, remittanceIdsToClean)).catch(() => {});
  }
  if (paymentIdsToClean.length) {
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

  test("10. dos o más splits → 400, medios combinados aún no habilitados", async () => {
    const { status, body } = await callPost({
      manualPayer: "X", manualPolicyNumber: "MAN-009", manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      splits: [{ method: "efectivo", amount: 500 }, { method: "transferencia", amount: 500 }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("combinados");
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
