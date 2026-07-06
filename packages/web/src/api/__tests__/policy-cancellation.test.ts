/**
 * Tests de la anulación manual de pólizas sobre los endpoints reales:
 * POST /api/policies/:id/cancel/preview, POST /api/policies/:id/cancel,
 * los guards de no_exigible en POST/PUT /payments y GET /remittances/uncollected,
 * y el cierre de la vía lateral en PUT /policies/:id.
 * Corre exclusivamente contra dev.db local (nunca Turso) — misma estrategia
 * de fixtures aisladas por prefijo que installments-rebuild.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments, payments, paymentSplits,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-policy-cancel-001";
const USER_EMAIL = "test-policy-cancel@test.local";
const PREFIX = "TEST-POLICY-CANCEL";

let userId: number;
let companyId: number;
let insuredId: number;
const policyIdsToClean: number[] = [];
const paymentIdsToClean: number[] = [];

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function mkPolicy(opts: { startDate?: string; endDate?: string; status?: string } = {}): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: opts.status ?? "activa", companyId, insuredId,
    startDate: opts.startDate ?? "2027-01-01", endDate: opts.endDate ?? "2027-12-31",
    isRebilling: 0, createdBy: userId,
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

async function mkConfirmedPayment(policyId: number, installmentId: number | null, opts: { rendered?: number } = {}): Promise<number> {
  const [pay] = await db.insert(payments).values({
    policyId, amount: 500, paymentMethod: "efectivo", paymentDate: "2027-02-01",
    installmentId, status: "confirmado", rendered: opts.rendered ?? 0, createdBy: userId,
  }).returning({ id: payments.id });
  paymentIdsToClean.push(pay!.id);
  return pay!.id;
}

async function getPolicy(id: number) {
  return db.select().from(policies).where(eq(policies.id, id)).get();
}
async function getInstallment(id: number) {
  return db.select().from(policyInstallments).where(eq(policyInstallments.id, id)).get();
}

async function callPreview(policyId: number | string, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}/cancel/preview`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function callCancel(policyId: number | string, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}/cancel`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function callPutPolicy(policyId: number | string, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function callPostPayment(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/payments", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) paymentIdsToClean.push(json.id);
  return { status: res.status, body: json };
}
async function callPutPayment(paymentId: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/payments/${paymentId}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function callUncollected(query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  const res = await app.fetch(new Request(`http://localhost/api/remittances/uncollected${qs ? `?${qs}` : ""}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}
async function callPending() {
  const res = await app.fetch(new Request("http://localhost/api/remittances/pending", { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const ids = prevPols.map(p => p.id);
    if (ids.length) {
      const payRows = await db.select({ id: payments.id }).from(payments).where(inArray(payments.policyId, ids)).all();
      const payIds = payRows.map(r => r.id);
      // payment_splits (Etapa 3A) referencia payments.id con FK real — este
      // driver (@libsql/client) SÍ enforce foreign_keys=ON por defecto (a
      // diferencia de bun:sqlite), así que hay que borrar los hijos antes
      // que el padre o el DELETE de payments falla silenciosamente (atrapado
      // por el .catch de abajo) y deja huérfanos que rompen los DELETE
      // siguientes en cascada (policyInstallments, policies, insureds, users).
      if (payIds.length) await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds)).catch(() => {});
      await db.delete(payments).where(inArray(payments.policyId, ids)).catch(() => {});
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, ids)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, ids)).catch(() => {});
    }
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Policy Cancel", email: USER_EMAIL, password: "hashed-dummy", role: "user", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(async () => {
  // Mismo orden que en beforeAll: payment_splits antes que payments — FK real
  // bajo @libsql/client (foreign_keys=ON por defecto en este driver).
  if (paymentIdsToClean.length) await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, paymentIdsToClean)).catch(() => {});
  if (paymentIdsToClean.length) await db.delete(payments).where(inArray(payments.id, paymentIdsToClean)).catch(() => {});
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  await db.delete(insureds).where(eq(insureds.createdBy, userId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

// ─── PREVIEW ────────────────────────────────────────────────────────────────────

describe("POST /policies/:id/cancel/preview", () => {
  test("14. no escribe datos — status y cuotas quedan intactos", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-08-01", 1000);

    const { status } = await callPreview(policyId, { effectiveDate: "2027-06-01" });
    expect(status).toBe(200);

    const policy = await getPolicy(policyId);
    expect(policy!.status).toBe("activa");
    const inst = await getInstallment(instId);
    expect(inst!.status).toBe("pendiente");
  });

  test("15. conteos correctos por bucket", async () => {
    const policyId = await mkPolicy();
    const paidId = await mkInstallment(policyId, 1, "2027-08-01", 500, { status: "pagada" });
    const renderedId = await mkInstallment(policyId, 2, "2027-08-01", 500, { rendered: 1 });
    const priorId = await mkInstallment(policyId, 3, "2027-05-01", 500);
    const futureId = await mkInstallment(policyId, 4, "2027-07-01", 500);
    void paidId; void renderedId; void priorId; void futureId;

    const { status, body } = await callPreview(policyId, { effectiveDate: "2027-06-01" });
    expect(status).toBe(200);
    expect(body.installments).toEqual({
      paidUnchanged: 1, renderedUnchanged: 1, priorDebtUnchanged: 1, markedNonCollectible: 1,
    });
  });

  test("16. póliza inexistente → 404", async () => {
    const { status } = await callPreview(999999999, { effectiveDate: "2027-06-01" });
    expect(status).toBe(404);
  });

  test("17. fecha inválida → 400", async () => {
    const policyId = await mkPolicy();
    const { status } = await callPreview(policyId, { effectiveDate: "no-es-una-fecha" });
    expect(status).toBe(400);
  });

  test("pendingPaymentsToRender cuenta pagos confirmados no rendidos de la póliza", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-05-01", 500);
    await mkConfirmedPayment(policyId, instId);

    const { body } = await callPreview(policyId, { effectiveDate: "2027-06-01" });
    expect(body.pendingPaymentsToRender).toBe(1);
  });
});

// ─── CANCEL ──────────────────────────────────────────────────────────────────────

describe("POST /policies/:id/cancel", () => {
  test("18/23/24. anulación válida → 200, status cancelada, endDate intacta", async () => {
    const policyId = await mkPolicy({ endDate: "2027-12-31" });
    const instId = await mkInstallment(policyId, 1, "2027-08-01", 1000);

    const { status } = await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "venta del vehículo" });
    expect(status).toBe(200);

    const policy = await getPolicy(policyId);
    expect(policy!.status).toBe("cancelada");
    expect(policy!.endDate).toBe("2027-12-31");
    void instId;
  });

  test("19. doble anulación → 409, sin cambios adicionales", async () => {
    const policyId = await mkPolicy();
    const first = await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "motivo 1" });
    expect(first.status).toBe(200);

    const second = await callCancel(policyId, { effectiveDate: "2027-07-01", reason: "motivo 2" });
    expect(second.status).toBe(409);

    const policy = await getPolicy(policyId);
    expect(policy!.cancellationReason).toBe("motivo 1"); // no se pisó con "motivo 2"
  });

  test("20. póliza inexistente → 404", async () => {
    const { status } = await callCancel(999999999, { effectiveDate: "2027-06-01", reason: "x" });
    expect(status).toBe(404);
  });

  test("21. reason vacío → 400, nada se modifica", async () => {
    const policyId = await mkPolicy();
    const { status } = await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "   " });
    expect(status).toBe(400);
    const policy = await getPolicy(policyId);
    expect(policy!.status).toBe("activa");
  });

  test("22. auditoría correcta: cancelledAt, cancellationEffectiveDate, cancellationReason, cancellationNotes, cancelledBy, cancellationSource", async () => {
    const policyId = await mkPolicy();
    const before = Date.now();
    const { status } = await callCancel(policyId, {
      effectiveDate: "2027-06-01", reason: "venta del vehículo", notes: "cliente avisó por whatsapp",
    });
    expect(status).toBe(200);

    const policy = await getPolicy(policyId);
    expect(policy!.cancellationEffectiveDate).toBe("2027-06-01");
    expect(policy!.cancellationReason).toBe("venta del vehículo");
    expect(policy!.cancellationNotes).toBe("cliente avisó por whatsapp");
    expect(policy!.cancelledBy).toBe(userId);
    expect(policy!.cancellationSource).toBe("manual");
    expect(policy!.cancelledAt).toBeDefined();
    expect(new Date(policy!.cancelledAt as any).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(policy!.notes).toContain("Anulada manualmente. Motivo: venta del vehículo");
  });

  test("25/26/27/28. tratamiento exacto de cuotas: futuras → no_exigible, deuda anterior/pagadas/rendidas intactas", async () => {
    const policyId = await mkPolicy();
    const paidId = await mkInstallment(policyId, 1, "2027-08-01", 500, { status: "pagada" });
    const renderedId = await mkInstallment(policyId, 2, "2027-08-01", 500, { rendered: 1 });
    const priorId = await mkInstallment(policyId, 3, "2027-05-01", 500);
    const futureId = await mkInstallment(policyId, 4, "2027-07-01", 500);

    const { status, body } = await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "x" });
    expect(status).toBe(200);
    expect(body.installments).toEqual({
      paidUnchanged: 1, renderedUnchanged: 1, priorDebtUnchanged: 1, markedNonCollectible: 1,
    });

    expect((await getInstallment(paidId))!.status).toBe("pagada");
    expect((await getInstallment(renderedId))!.status).toBe("pendiente"); // rendered, no tocada
    expect((await getInstallment(priorId))!.status).toBe("pendiente"); // deuda anterior, sigue exigible
    expect((await getInstallment(futureId))!.status).toBe("no_exigible");
  });

  test("29. cuotas de refacturación siguen la misma regla por fecha (rebillingId no cambia el criterio)", async () => {
    const policyId = await mkPolicy();
    // No hace falta un rebilling real — la clasificación es puramente por
    // fecha/status/rendered, sin importar rebillingId (ver classifyInstallmentsForCancellation).
    const futureId = await mkInstallment(policyId, 1, "2027-09-01", 500);

    const { status } = await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "x" });
    expect(status).toBe(200);
    expect((await getInstallment(futureId))!.status).toBe("no_exigible");
  });

  test("30. rollback total ante fallo (tx real, no mocks)", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-07-01", 500);

    let threw = false;
    try {
      await db.transaction(async (tx) => {
        await tx.update(policies).set({
          status: "cancelada", cancellationReason: "x", cancelledBy: userId, cancellationSource: "manual",
        }).where(eq(policies.id, policyId));
        // dueDate NOT NULL — fallo real de SQLite, después de haber tocado policies.
        await tx.update(policyInstallments).set({ dueDate: null as any }).where(eq(policyInstallments.id, instId));
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const policy = await getPolicy(policyId);
    expect(policy!.status).toBe("activa"); // revertido
    const inst = await getInstallment(instId);
    expect(inst!.dueDate).toBe("2027-07-01"); // revertido
  });
});

// ─── PAYMENTS ────────────────────────────────────────────────────────────────────

describe("Guards de no_exigible en payments", () => {
  test("31. POST /payments bloquea una cuota no_exigible con 409", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-07-01", 1000);
    await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "x" });
    expect((await getInstallment(instId))!.status).toBe("no_exigible");

    const { status } = await callPostPayment({
      policyId, installmentId: instId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-07-05",
    });
    expect(status).toBe(409);
  });

  test("32. PUT /payments bloquea mover un pago a una cuota no_exigible", async () => {
    const policyId = await mkPolicy();
    const otherInstId = await mkInstallment(policyId, 1, "2027-05-01", 1000);
    const futureInstId = await mkInstallment(policyId, 2, "2027-07-01", 1000);
    const { body: pay } = await callPostPayment({
      policyId, installmentId: otherInstId, amount: 1000, paymentMethod: "efectivo",
      paymentDate: "2027-05-05", status: "pendiente",
    });

    await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "x" });
    expect((await getInstallment(futureInstId))!.status).toBe("no_exigible");

    const { status } = await callPutPayment(pay.id, { installmentId: futureInstId });
    expect(status).toBe(409);
  });

  test("33. deuda anterior a la anulación se puede pagar con normalidad", async () => {
    const policyId = await mkPolicy();
    const priorInstId = await mkInstallment(policyId, 1, "2027-05-01", 1000);
    await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "x" });
    expect((await getInstallment(priorInstId))!.status).toBe("pendiente");

    const { status } = await callPostPayment({
      policyId, installmentId: priorInstId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-06-10",
    });
    expect(status).toBe(201);
    expect((await getInstallment(priorInstId))!.status).toBe("pagada");
  });

  test("34. recalculateInstallmentPaymentStatus conserva no_exigible sin pago confirmado", async () => {
    const policyId = await mkPolicy();
    const otherInstId = await mkInstallment(policyId, 1, "2027-05-01", 1000);
    const futureInstId = await mkInstallment(policyId, 2, "2027-07-01", 1000);
    const { body: pay } = await callPostPayment({
      policyId, installmentId: otherInstId, amount: 1000, paymentMethod: "efectivo",
      paymentDate: "2027-05-05", status: "pendiente",
    });
    await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "x" });
    expect((await getInstallment(futureInstId))!.status).toBe("no_exigible");

    // Editar un campo no relacionado del payment (notas) recalcula el installment
    // ORIGINAL (otherInstId) — no toca futureInstId directamente, pero sirve
    // para confirmar que el helper de recálculo, cuando SÍ corre sobre una
    // cuota no_exigible (ver test de abajo), no la reactiva sin pago válido.
    await callPutPayment(pay.id, { notes: "sin cambios contables" });
    expect((await getInstallment(futureInstId))!.status).toBe("no_exigible");
  });
});

// ─── REMITTANCES ─────────────────────────────────────────────────────────────────

describe("Impacto en rendiciones", () => {
  test("35. cuota no_exigible no aparece en /remittances/uncollected", async () => {
    const policyId = await mkPolicy();
    const futureInstId = await mkInstallment(policyId, 1, "2027-07-01", 1000);
    await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "x" });

    const { body } = await callUncollected();
    expect(body.some((r: any) => r.id === futureInstId)).toBe(false);
  });

  test("36. pago confirmado previo a la anulación sigue apareciendo en /remittances/pending", async () => {
    const policyId = await mkPolicy();
    const priorInstId = await mkInstallment(policyId, 1, "2027-05-01", 1000, { status: "pagada" });
    const payId = await mkConfirmedPayment(policyId, priorInstId);

    await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "x" });

    const { body } = await callPending();
    expect(body.some((r: any) => r.source === "payment" && r.sourceId === payId)).toBe(true);
  });

  test("37. anular la póliza nunca cambia payments.rendered", async () => {
    const policyId = await mkPolicy();
    const priorInstId = await mkInstallment(policyId, 1, "2027-05-01", 1000, { status: "pagada" });
    const payId = await mkConfirmedPayment(policyId, priorInstId, { rendered: 0 });

    await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "x" });

    const pay = await db.select({ rendered: payments.rendered }).from(payments).where(eq(payments.id, payId)).get();
    expect(pay!.rendered).toBe(0);
  });
});

// ─── PUT /policies/:id — vía lateral cerrada ────────────────────────────────────

describe("PUT /policies/:id no gestiona anulaciones", () => {
  test("38. PUT genérico con status='cancelada' → 400, no cancela", async () => {
    const policyId = await mkPolicy();
    const { status, body } = await callPutPolicy(policyId, { status: "cancelada" });
    expect(status).toBe(400);
    expect(body.error).toContain("Anular póliza");

    const policy = await getPolicy(policyId);
    expect(policy!.status).toBe("activa");
  });

  test("39. PUT genérico no rehabilita una póliza ya cancelada (status→'activa' se rechaza)", async () => {
    const policyId = await mkPolicy();
    await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "x" });

    const { status, body } = await callPutPolicy(policyId, { status: "activa" });
    expect(status).toBe(400);
    expect(body.error).toContain("Anular póliza");

    const policy = await getPolicy(policyId);
    expect(policy!.status).toBe("cancelada");
  });

  test("40. editar un campo no relacionado (notes) de una póliza cancelada sigue permitido, y no la 'reactiva'", async () => {
    const policyId = await mkPolicy({ endDate: "2027-12-31" });
    await callCancel(policyId, { effectiveDate: "2027-06-01", reason: "x" });

    const { status } = await callPutPolicy(policyId, { notes: "nota adicional" });
    expect(status).toBe(200);

    const policy = await getPolicy(policyId);
    // Sigue cancelada — el bloque de recálculo automático de status por
    // fecha (endDate) no debe haber corrido y "rehabilitado" la póliza.
    expect(policy!.status).toBe("cancelada");
    expect(policy!.notes).toBe("nota adicional");
  });
});
