/**
 * Tests de la anulación segura de un payment_batches confirmado (corrección
 * con trazabilidad — GET .../cancel-check, POST .../cancel, PATCH
 * /payment-batches/:id). Corre exclusivamente contra dev.db local (nunca
 * Turso) — misma estrategia de fixtures aisladas por prefijo que
 * payment-batches.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments,
  payments, paymentSplits, paymentBatches, paymentBatchSplits, cashEntries, receivedChecks,
  remittances, remittanceItems, remittanceAllocations, insuredAccountMovements,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-batch-cancel-001";
const USER_EMAIL = "test-batch-cancel@test.local";
const PREFIX = "TEST-BATCH-CANCEL";

let userId: number;
let companyId: number;
let rivadaviaCompanyId: number;
let insuredId: number;

const policyIdsToClean: number[] = [];
const batchIdsToClean: number[] = [];
const remittanceIdsToClean: number[] = [];

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function mkPolicy(company = companyId): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: "activa", companyId: company, insuredId,
    startDate: "2027-01-01", endDate: "2027-12-31", isRebilling: 0, createdBy: userId,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}

async function mkInstallment(policyId: number, dueDate: string, amount: number): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({
    policyId, number: 1, dueDate, amount, status: "pendiente", rendered: 0,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

async function callPost(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) batchIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function callCancelCheck(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/payment-batches/${id}/cancel-check`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

async function callCancel(id: number, body: Record<string, any> = { confirm: true }) {
  const res = await app.fetch(new Request(`http://localhost/api/payment-batches/${id}/cancel`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

async function callPatch(id: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/payment-batches/${id}`, {
    method: "PATCH", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

async function getBatch(id: number) {
  return db.select().from(paymentBatches).where(eq(paymentBatches.id, id)).get();
}
async function getChildren(batchId: number) {
  return db.select().from(payments).where(eq(payments.batchId, batchId)).all();
}
async function getInstallment(id: number) {
  return db.select().from(policyInstallments).where(eq(policyInstallments.id, id)).get();
}
async function getSurcharges(childIds: number[]) {
  if (childIds.length === 0) return [];
  return db.select().from(cashEntries)
    .where(inArray(cashEntries.paymentId, childIds)).all()
    .then((rows) => rows.filter((r) => r.entryType === "pronto_pago_surcharge"));
}
async function getChecksForBatch(batchId: number) {
  const splits = await db.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, batchId)).all();
  const splitIds = splits.map((s) => s.id);
  if (splitIds.length === 0) return [];
  return db.select().from(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).all();
}

/** Batch simple de una cuota, sin recargo — helper para los tests que no necesitan un caso más armado. */
async function createSimpleBatch(dueDate = "2027-06-01", amount = 1000) {
  const policyId = await mkPolicy();
  const instId = await mkInstallment(policyId, dueDate, amount);
  const { status, body } = await callPost({
    insuredId, paymentDate: "2027-06-01", notes: "batch simple",
    items: [{ installmentId: instId }],
    splits: [{ method: "efectivo", amount }],
  });
  expect(status).toBe(201);
  return { batchId: body.id as number, instId, amount };
}

/** Batch de una cuota con diferencia recibido/aplicado ya resuelta (Fase 2B) — genera 1 insured_account_movement. */
async function createBatchWithDifference(
  action: "saldo_a_favor" | "saldo_deudor", cuotaAmount: number, receivedAmount: number, reason = "diferencia de prueba"
) {
  const policyId = await mkPolicy();
  const instId = await mkInstallment(policyId, "2027-06-01", cuotaAmount);
  const { status, body } = await callPost({
    insuredId, paymentDate: "2027-06-01", notes: null,
    items: [{ installmentId: instId }],
    splits: [{ method: "efectivo", amount: receivedAmount }],
    accountDifferenceResolution: { action, reason },
  });
  expect(status).toBe(201);
  return { batchId: body.id as number, instId, policyId };
}

async function getAccountMovementsForBatch(batchId: number) {
  return db.select().from(insuredAccountMovements).where(eq(insuredAccountMovements.originBatchId, batchId)).all();
}

async function cashSummary() {
  const res = await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }));
  return res.json();
}

beforeAll(async () => {
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
      // Fase 2D: insured_account_movements.originBatchId referencia
      // payment_batches.id — debe limpiarse antes que los batches.
      if (batchIds.length) await db.delete(insuredAccountMovements).where(inArray(insuredAccountMovements.originBatchId, batchIds)).catch(() => {});
      await db.delete(insuredAccountMovements).where(eq(insuredAccountMovements.createdBy, prevUser.id)).catch(() => {});
      if (payIds.length) await db.delete(cashEntries).where(inArray(cashEntries.paymentId, payIds)).catch(() => {});
      if (payIds.length) await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds)).catch(() => {});
      if (payIds.length) await db.delete(payments).where(inArray(payments.id, payIds)).catch(() => {});
      if (batchIds.length) {
        const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).all();
        const splitIds = splitRows.map((s) => s.id);
        if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).catch(() => {});
      }
      if (batchIds.length) await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).catch(() => {});
      if (batchIds.length) await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIds)).catch(() => {});
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, polIds)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, polIds)).catch(() => {});
    }
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Batch Cancel", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
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
  if (remittanceIdsToClean.length) {
    await db.delete(remittanceAllocations).where(inArray(remittanceAllocations.remittanceId, remittanceIdsToClean)).catch(() => {});
    await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remittanceIdsToClean)).catch(() => {});
    await db.delete(remittances).where(inArray(remittances.id, remittanceIdsToClean)).catch(() => {});
  }
  // Fase 2D: idem beforeAll — limpiar antes de borrar los batches que referencian.
  if (batchIdsToClean.length) {
    await db.delete(insuredAccountMovements).where(inArray(insuredAccountMovements.originBatchId, batchIdsToClean)).catch(() => {});
  }
  await db.delete(insuredAccountMovements).where(eq(insuredAccountMovements.createdBy, userId)).catch(() => {});

  const allChildIds: number[] = [];
  if (batchIdsToClean.length) {
    const children = await db.select({ id: payments.id }).from(payments).where(inArray(payments.batchId, batchIdsToClean)).all();
    allChildIds.push(...children.map((c) => c.id));
  }
  if (allChildIds.length) {
    await db.delete(cashEntries).where(inArray(cashEntries.paymentId, allChildIds)).catch(() => {});
    await db.delete(payments).where(inArray(payments.id, allChildIds)).catch(() => {});
  }
  if (batchIdsToClean.length) {
    const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsToClean)).all();
    const splitIds = splitRows.map((s) => s.id);
    if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).catch(() => {});
    await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsToClean)).catch(() => {});
    await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIdsToClean)).catch(() => {});
  }
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  await db.delete(insureds).where(eq(insureds.createdBy, userId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

// ─── cancel-check ────────────────────────────────────────────────────────────

describe("GET /payment-batches/:id/cancel-check", () => {
  test("1. sin ninguna actividad posterior → canCancel true, sin motivos", async () => {
    const { batchId, instId, amount } = await createSimpleBatch();
    const { status, body } = await callCancelCheck(batchId);
    expect(status).toBe(200);
    expect(body.canCancel).toBe(true);
    expect(body.blockingReasons).toEqual([]);
    expect(body.status).toBe("confirmado");
    expect(body.affectedPayments.length).toBe(1);
    expect(body.affectedPayments[0].amount).toBe(amount);
    expect(body.affectedInstallments.length).toBe(1);
    expect(body.affectedInstallments[0].id).toBe(instId);
    expect(body.remittanceLinks).toEqual({ allocationCount: 0, itemCount: 0 });
  });

  test("2. bloqueado si un hijo ya está rendido", async () => {
    const { batchId } = await createSimpleBatch();
    const children = await getChildren(batchId);
    await db.update(payments).set({ rendered: 1 }).where(eq(payments.id, children[0]!.id));

    const { body } = await callCancelCheck(batchId);
    expect(body.canCancel).toBe(false);
    expect(body.blockingReasons.some((r: string) => r.includes("rendido"))).toBe(true);
  });

  test("3. bloqueado por remittance_allocation vinculada", async () => {
    const { batchId } = await createSimpleBatch();
    const [split] = await db.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, batchId)).limit(1);
    const [rem] = await db.insert(remittances).values({
      date: "2027-06-02", canal: "directo", paymentBreakdown: "{}", status: "confirmada", createdAt: new Date(),
    }).returning({ id: remittances.id });
    remittanceIdsToClean.push(rem!.id);
    // CHECK de remittance_allocations exige exactamente uno de paymentSplitId/
    // paymentBatchSplitId/cashEntryId — acá va el split real del batch (una
    // allocation de batch siempre lleva su paymentBatchSplitId, ver
    // resolveBatchInstruments en remittance-allocations.ts).
    await db.insert(remittanceAllocations).values({
      remittanceId: rem!.id, paymentBatchId: batchId, paymentBatchSplitId: split!.id,
      method: "efectivo", amountCents: 100000, createdAt: new Date(),
    });

    const { body } = await callCancelCheck(batchId);
    expect(body.canCancel).toBe(false);
    expect(body.blockingReasons.some((r: string) => r.includes("asignación(es) de rendición"))).toBe(true);
    expect(body.remittanceLinks.allocationCount).toBe(1);
  });

  test("4. bloqueado por remittance_item vinculado (aunque no haya allocation)", async () => {
    const { batchId } = await createSimpleBatch();
    const children = await getChildren(batchId);
    const [rem] = await db.insert(remittances).values({
      date: "2027-06-02", canal: "directo", paymentBreakdown: "{}", status: "confirmada", createdAt: new Date(),
    }).returning({ id: remittances.id });
    remittanceIdsToClean.push(rem!.id);
    await db.insert(remittanceItems).values({
      remittanceId: rem!.id, source: "payment", sourceId: children[0]!.id, amount: 1000, debtorStatus: "pagado", createdAt: new Date(),
    });

    const { body } = await callCancelCheck(batchId);
    expect(body.canCancel).toBe(false);
    expect(body.blockingReasons.some((r: string) => r.includes("ítem(s) de rendición"))).toBe(true);
    expect(body.remittanceLinks.itemCount).toBe(1);
  });

  test("5. bloqueado por un cheque con actividad (entregado a compañía)", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2027-06-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber: `${PREFIX}-1`, bankName: "Nación", dueDate: "2027-07-01", amount: 1000 }] }],
    });
    const checks = await getChecksForBatch(created.id);
    expect(checks.length).toBe(1);
    await db.update(receivedChecks).set({ status: "entregado_compania" }).where(eq(receivedChecks.id, checks[0]!.id));

    const { body } = await callCancelCheck(created.id);
    expect(body.canCancel).toBe(false);
    expect(body.blockingReasons.some((r: string) => r.includes("cheque(s)"))).toBe(true);
  });

  test("cheques todos en_cartera → no bloquean", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2027-06-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber: `${PREFIX}-2`, bankName: "Nación", dueDate: "2027-07-01", amount: 1000 }] }],
    });
    const { body } = await callCancelCheck(created.id);
    expect(body.canCancel).toBe(true);
  });

  test("batch inexistente → 404", async () => {
    const { status } = await callCancelCheck(999999999);
    expect(status).toBe(404);
  });
});

// ─── cancel ──────────────────────────────────────────────────────────────────

describe("POST /payment-batches/:id/cancel", () => {
  test("6. requiere confirm:true explícito", async () => {
    const { batchId } = await createSimpleBatch();
    const { status, body } = await callCancel(batchId, {});
    expect(status).toBe(400);
    expect(body.error).toContain("confirm");
    const batch = await getBatch(batchId);
    expect(batch!.status).toBe("confirmado"); // no se tocó nada
  });

  test("7. anula el batch, sus hijos, y recalcula la cuota a pendiente (due date futura)", async () => {
    const { batchId, instId } = await createSimpleBatch("2027-06-01", 1000);
    const { status, body } = await callCancel(batchId, { confirm: true, reason: "error de carga" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.batch.status).toBe("anulado");
    expect(body.batch.cancellationReason).toBe("error de carga");
    expect(body.batch.cancelledAt).not.toBeNull();

    const batch = await getBatch(batchId);
    expect(batch!.status).toBe("anulado");

    const children = await getChildren(batchId);
    expect(children.every((c) => c.status === "anulado")).toBe(true);

    const inst = await getInstallment(instId);
    expect(inst!.status).toBe("pendiente");
  });

  test("8. cuota con vencimiento pasado vuelve a vencida (no a pendiente)", async () => {
    const { batchId, instId } = await createSimpleBatch("2020-01-01", 500);
    const { status } = await callCancel(batchId, { confirm: true });
    expect(status).toBe(200);
    const inst = await getInstallment(instId);
    expect(inst!.status).toBe("vencida");
  });

  test("9. otra cobranza confirmada sobre la misma cuota impide que quede en un estado incorrecto", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2027-06-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    // Segundo pago standalone confirmado, mismo importe exacto, para la
    // misma cuota — simula un estado de datos con doble cobro real (fuera
    // del alcance de esta migración arreglar cómo llegó ahí, solo probar
    // que recalculateInstallmentPaymentStatus lo respeta).
    const [extraPayment] = await db.insert(payments).values({
      policyId, installmentId: instId, amount: 1000, paymentMethod: "efectivo",
      paymentDate: "2027-06-01", status: "confirmado", createdBy: userId,
    }).returning({ id: payments.id });

    const { status } = await callCancel(created.id, { confirm: true });
    expect(status).toBe(200);
    const inst = await getInstallment(instId);
    expect(inst!.status).toBe("pagada"); // el otro pago confirmado la sigue cubriendo

    await db.delete(payments).where(eq(payments.id, extraPayment!.id)).catch(() => {});
  });

  test("10. un ítem manual_payment libre queda anulado, sin crear ninguna deuda", async () => {
    const { status, body: created } = await callPost({
      paymentDate: "2027-06-01", notes: null,
      items: [{ source: "manual_payment", manualPayer: `${PREFIX} Pagador libre`, amount: 500, description: "cobro suelto" }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(201);

    const { status: cancelStatus } = await callCancel(created.id, { confirm: true });
    expect(cancelStatus).toBe(200);

    const children = await getChildren(created.id);
    expect(children.length).toBe(1);
    expect(children[0]!.status).toBe("anulado");
    expect(children[0]!.installmentId).toBeNull();
    expect(children[0]!.policyId).toBeNull();
  });

  test("11. el recargo Pronto Pago del batch queda anulado (status), no borrado", async () => {
    const policyId = await mkPolicy(rivadaviaCompanyId);
    const instId = await mkInstallment(policyId, "2027-06-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1800 }], // 1000 base + 800 recargo Rivadavia
    });
    const batch = await getBatch(created.id);
    expect(batch!.surchargeAmountCents).toBe(80000);

    const childrenBefore = await getChildren(created.id);
    const surchargesBefore = await getSurcharges(childrenBefore.map((c) => c.id));
    expect(surchargesBefore.length).toBe(1);
    expect(surchargesBefore[0]!.status).toBe("activo");

    const { status } = await callCancel(created.id, { confirm: true });
    expect(status).toBe(200);

    const surchargesAfter = await getSurcharges(childrenBefore.map((c) => c.id));
    expect(surchargesAfter.length).toBe(1); // sigue existiendo — nunca se borra
    expect(surchargesAfter[0]!.status).toBe("anulado");
    expect(surchargesAfter[0]!.voidedAt).not.toBeNull();
  });

  test("12. Caja descuenta el batch exactamente una vez tras la anulación", async () => {
    const { batchId, amount } = await createSimpleBatch("2027-06-01", 1234);

    async function carteraTotalCents() {
      const res = await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }));
      const json = await res.json();
      return Math.round(json.cartera.total * 100);
    }

    const before = await carteraTotalCents();
    const { status } = await callCancel(batchId, { confirm: true });
    expect(status).toBe(200);
    const after = await carteraTotalCents();

    expect(before - after).toBe(Math.round(amount * 100));
  });

  test("13. Rendiciones deja de ofrecer los hijos de un batch anulado", async () => {
    const { batchId } = await createSimpleBatch("2027-06-01", 1000);
    const children = await getChildren(batchId);

    async function pendingHasChild(id: number) {
      const res = await app.fetch(new Request("http://localhost/api/remittances/pending", { headers: authHeaders() }));
      const rows = await res.json();
      return rows.some((r: any) => r.source === "payment" && r.sourceId === id);
    }

    expect(await pendingHasChild(children[0]!.id)).toBe(true);
    const { status } = await callCancel(batchId, { confirm: true });
    expect(status).toBe(200);
    expect(await pendingHasChild(children[0]!.id)).toBe(false);
  });

  test("14. segunda anulación es idempotente — no vuelve a modificar nada", async () => {
    const { batchId } = await createSimpleBatch();
    const first = await callCancel(batchId, { confirm: true, reason: "motivo original" });
    expect(first.status).toBe(200);
    const firstCancelledAt = first.body.batch.cancelledAt;

    const second = await callCancel(batchId, { confirm: true, reason: "motivo distinto, no debería aplicarse" });
    expect(second.status).toBe(200);
    expect(second.body.alreadyCancelled).toBe(true);

    const batch = await getBatch(batchId);
    expect(batch!.cancellationReason).toBe("motivo original"); // no se pisó
    expect(batch!.cancelledAt?.getTime?.() ?? batch!.cancelledAt).toEqual(firstCancelledAt ? new Date(firstCancelledAt).getTime?.() ?? firstCancelledAt : batch!.cancelledAt);
  });

  test("15. revalida el estado antes de escribir — si algo cambió, no aplica y no toca datos", async () => {
    const { batchId } = await createSimpleBatch();
    const [split] = await db.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, batchId)).limit(1);
    // Simula que el estado cambió después de que el usuario vio cancel-check
    // (ej. otra pestaña generó una rendición) pero antes de confirmar.
    const [rem] = await db.insert(remittances).values({
      date: "2027-06-02", canal: "directo", paymentBreakdown: "{}", status: "confirmada", createdAt: new Date(),
    }).returning({ id: remittances.id });
    remittanceIdsToClean.push(rem!.id);
    await db.insert(remittanceAllocations).values({
      remittanceId: rem!.id, paymentBatchId: batchId, paymentBatchSplitId: split!.id,
      method: "efectivo", amountCents: 100000, createdAt: new Date(),
    });

    const { status, body } = await callCancel(batchId, { confirm: true });
    expect(status).toBe(409);
    expect(body.blockingReasons.some((r: string) => r.includes("asignación"))).toBe(true);

    const batch = await getBatch(batchId);
    expect(batch!.status).toBe("confirmado"); // rollback completo, nada se tocó
    const children = await getChildren(batchId);
    expect(children.every((c) => c.status === "confirmado")).toBe(true);
  });

  test("batch inexistente → 404", async () => {
    const { status } = await callCancel(999999999, { confirm: true });
    expect(status).toBe(404);
  });
});

// ─── Fase 2D — cuenta corriente de asegurados al cancelar un batch ─────────
//
// Ver isSafeToCancelAccountMovementOrigin (insured-account.ts) y
// resolveAccountMovementCancelPlan (index.ts): anular el
// insured_account_movement que un batch originó (saldo_a_favor/saldo_deudor,
// Fase 2B) es seguro solo si el resto del pool GLOBAL activo del mismo
// asegurado sigue alcanzando para explicar todo lo ya consumido/cobrado — si
// no, se bloquea con 409 ACCOUNT_MOVEMENT_REQUIRES_MANUAL_REVIEW en vez de
// adivinar una reversa.
describe("POST /payment-batches/:id/cancel — Fase 2D: cuenta corriente de asegurados", () => {
  test("1. batch exacto sin cuenta corriente — comportamiento igual que antes", async () => {
    const { batchId } = await createSimpleBatch("2027-06-01", 1000);
    const { status, body } = await callCancel(batchId, { confirm: true });
    expect(status).toBe(200);
    expect(body.voidedAccountMovementIds).toEqual([]);
    const movements = await getAccountMovementsForBatch(batchId);
    expect(movements.length).toBe(0);
  });

  test("2. batch con saldo a favor — el movimiento se anula, la cuenta corriente cierra y creditoActivoEnCaja vuelve a 0 sin inflar cajaNeta", async () => {
    const before = await cashSummary();
    const { batchId } = await createBatchWithDifference("saldo_a_favor", 1000, 1100);

    const afterCreate = await cashSummary();
    expect(afterCreate.cuentaCorriente.saldosAFavorPendientes - before.cuentaCorriente.saldosAFavorPendientes).toBeCloseTo(100, 2);
    expect(afterCreate.cuentaCorriente.creditoActivoEnCaja - before.cuentaCorriente.creditoActivoEnCaja).toBeCloseTo(100, 2);
    expect(afterCreate.cajaNeta.total - before.cajaNeta.total).toBeCloseTo(1100, 2);

    const { status, body } = await callCancel(batchId, { confirm: true });
    expect(status).toBe(200);
    expect(body.voidedAccountMovementIds.length).toBe(1);

    const movements = await getAccountMovementsForBatch(batchId);
    expect(movements.length).toBe(1);
    expect(movements[0]!.status).toBe("anulado");

    const afterCancel = await cashSummary();
    // Cuenta corriente vuelve exactamente al estado previo a crear el batch.
    expect(afterCancel.cuentaCorriente.saldosAFavorPendientes - before.cuentaCorriente.saldosAFavorPendientes).toBeCloseTo(0, 2);
    expect(afterCancel.cuentaCorriente.creditoActivoEnCaja - before.cuentaCorriente.creditoActivoEnCaja).toBeCloseTo(0, 2);
    // cajaNeta tampoco queda inflada — el payment hijo también se anuló, así
    // que cartera.total vuelve a 0 igual que el crédito.
    expect(afterCancel.cajaNeta.total - before.cajaNeta.total).toBeCloseTo(0, 2);
  });

  test("3. batch con saldo deudor — el movimiento se anula y la cuenta corriente cierra", async () => {
    const before = await cashSummary();
    const { batchId } = await createBatchWithDifference("saldo_deudor", 1000, 900);

    const afterCreate = await cashSummary();
    expect(afterCreate.cuentaCorriente.saldosDeudoresPendientes - before.cuentaCorriente.saldosDeudoresPendientes).toBeCloseTo(100, 2);

    const { status, body } = await callCancel(batchId, { confirm: true });
    expect(status).toBe(200);
    expect(body.voidedAccountMovementIds.length).toBe(1);

    const movements = await getAccountMovementsForBatch(batchId);
    expect(movements[0]!.status).toBe("anulado");

    const afterCancel = await cashSummary();
    expect(afterCancel.cuentaCorriente.saldosDeudoresPendientes - before.cuentaCorriente.saldosDeudoresPendientes).toBeCloseTo(0, 2);
  });

  test("4. batch con cheque mayor a la cuota (received_checks real) — el cheque se anula igual que siempre y el saldo a favor no queda activo", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2027-06-01", 1000);
    const { status: postStatus, body: created } = await callPost({
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{
        method: "cheque", amount: 1100,
        checks: [{ checkNumber: `${PREFIX}-CHK-${Date.now()}`, bankName: "Banco Test", dueDate: "2027-07-01", amount: 1100 }],
      }],
      accountDifferenceResolution: { action: "saldo_a_favor", reason: "cheque recibido de más" },
    });
    expect(postStatus).toBe(201);
    const batchId = created.id as number;

    const checksBefore = await getChecksForBatch(batchId);
    expect(checksBefore.length).toBe(1);
    expect(checksBefore[0]!.status).toBe("en_cartera");

    const { status } = await callCancel(batchId, { confirm: true });
    expect(status).toBe(200);

    const checksAfter = await getChecksForBatch(batchId);
    expect(checksAfter[0]!.status).toBe("anulado"); // comportamiento existente, sin cambios

    const movements = await getAccountMovementsForBatch(batchId);
    expect(movements[0]!.status).toBe("anulado"); // el saldo a favor no queda activo
  });

  test("5. batch con 2 cuotas del mismo asegurado real — anula solo el movimiento de ESTE batch, nunca el de otro", async () => {
    // Otro batch independiente, con su propio saldo a favor, que debe quedar intacto.
    const other = await createBatchWithDifference("saldo_a_favor", 500, 550);
    const otherMovementBefore = (await getAccountMovementsForBatch(other.batchId))[0]!;
    expect(otherMovementBefore.status).toBe("activo");

    const policyId = await mkPolicy();
    const inst1 = await mkInstallment(policyId, "2027-06-01", 600);
    const inst2 = await mkInstallment(policyId, "2027-06-02", 400);
    const { status: postStatus, body: created } = await callPost({
      insuredId, paymentDate: "2027-06-01", notes: null,
      items: [{ installmentId: inst1 }, { installmentId: inst2 }],
      splits: [{ method: "efectivo", amount: 1100 }], // 1000 aplicado + 100 sobrante
      accountDifferenceResolution: { action: "saldo_a_favor", reason: "2 cuotas, 1 asegurado" },
    });
    expect(postStatus).toBe(201);
    const batchId = created.id as number;

    const { status } = await callCancel(batchId, { confirm: true });
    expect(status).toBe(200);

    const thisMovement = (await getAccountMovementsForBatch(batchId))[0]!;
    expect(thisMovement.status).toBe("anulado");

    // El otro batch nunca se tocó.
    const otherMovementAfter = (await getAccountMovementsForBatch(other.batchId))[0]!;
    expect(otherMovementAfter.status).toBe("activo");

    await callCancel(other.batchId, { confirm: true }); // limpieza: deja todo cancelado
  });

  test("6. batch 100% manual (sin asegurado real) — cancelar no crea ni intenta anular cuenta corriente inexistente", async () => {
    const { status: postStatus, body: created } = await callPost({
      paymentDate: "2027-06-01", notes: null,
      items: [{ source: "manual_payment", manualPayer: `${PREFIX} Manual Cancel`, amount: 700, description: "cobro suelto" }],
      splits: [{ method: "efectivo", amount: 700 }],
    });
    expect(postStatus).toBe(201);
    const batchId = created.id as number;

    const { status, body } = await callCancel(batchId, { confirm: true });
    expect(status).toBe(200);
    expect(body.voidedAccountMovementIds).toEqual([]);
    expect(await getAccountMovementsForBatch(batchId)).toEqual([]);
  });

  test("7. saldo a favor ya consumido entero por otra operación — bloquea con 409 ACCOUNT_MOVEMENT_REQUIRES_MANUAL_REVIEW, sin tocar nada", async () => {
    const { batchId } = await createBatchWithDifference("saldo_a_favor", 1000, 1100);
    const movementBefore = (await getAccountMovementsForBatch(batchId))[0]!;

    // Se consume el crédito entero vía aplicacion_saldo_favor (simulado
    // directo — sin endpoint propio todavía, ver Fase 2C). "Anchor" payment
    // sin splits/importe real: solo hace falta que exista para
    // relatedPaymentId (ver insured-account.ts).
    const [anchor] = await db.insert(payments).values({
      amount: 0, paymentMethod: "efectivo", paymentDate: "2027-06-01", status: "confirmado", rendered: 0, createdBy: userId,
    }).returning({ id: payments.id });
    const anchorId = anchor!.id;
    const [applyMovement] = await db.insert(insuredAccountMovements).values({
      insuredId, type: "aplicacion_saldo_favor", signedAmountCents: -10000, status: "activo",
      relatedPaymentId: anchorId, reason: "aplicado a cuota futura", createdBy: userId, createdAt: new Date(),
    }).returning({ id: insuredAccountMovements.id });

    try {
      const { status, body } = await callCancel(batchId, { confirm: true });
      expect(status).toBe(409);
      expect(body.code).toBe("ACCOUNT_MOVEMENT_REQUIRES_MANUAL_REVIEW");
      expect(Array.isArray(body.blockingReasons)).toBe(true);
      expect(body.blockingReasons.length).toBeGreaterThan(0);

      // Rollback completo: nada se tocó.
      const batch = await getBatch(batchId);
      expect(batch!.status).toBe("confirmado");
      const children = await getChildren(batchId);
      expect(children.every((c) => c.status === "confirmado")).toBe(true);
      const movementAfter = await db.select().from(insuredAccountMovements).where(eq(insuredAccountMovements.id, movementBefore.id)).get();
      expect(movementAfter!.status).toBe("activo");
    } finally {
      await db.delete(insuredAccountMovements).where(eq(insuredAccountMovements.id, applyMovement!.id)).catch(() => {});
      await db.delete(payments).where(eq(payments.id, anchorId)).catch(() => {});
    }
  });
});

// ─── PATCH (edición administrativa) ─────────────────────────────────────────

describe("PATCH /payment-batches/:id", () => {
  test("16. permite editar paymentDate y notes", async () => {
    const { batchId } = await createSimpleBatch();
    const { status, body } = await callPatch(batchId, { paymentDate: "2027-07-15", notes: "nota corregida" });
    expect(status).toBe(200);
    expect(body.paymentDate).toBe("2027-07-15");
    expect(body.notes).toBe("nota corregida");
  });

  test("17. rechaza importes/items/splits con 400, sin tocar nada", async () => {
    const { batchId } = await createSimpleBatch();
    const before = await getBatch(batchId);

    const r1 = await callPatch(batchId, { amount: 999 });
    expect(r1.status).toBe(400);
    const r2 = await callPatch(batchId, { items: [] });
    expect(r2.status).toBe(400);
    const r3 = await callPatch(batchId, { splits: [] });
    expect(r3.status).toBe(400);
    const r4 = await callPatch(batchId, { insuredId: 999 });
    expect(r4.status).toBe(400);
    const r5 = await callPatch(batchId, { totalReceivedCents: 1 });
    expect(r5.status).toBe(400);

    const after = await getBatch(batchId);
    expect(after).toEqual(before);
  });

  test("18. rechaza formato de fecha inválido", async () => {
    const { batchId } = await createSimpleBatch();
    const { status } = await callPatch(batchId, { paymentDate: "15/07/2027" });
    expect(status).toBe(400);
  });

  test("19. no permite editar un batch ya anulado", async () => {
    const { batchId } = await createSimpleBatch();
    await callCancel(batchId, { confirm: true });
    const { status, body } = await callPatch(batchId, { notes: "no debería aplicarse" });
    expect(status).toBe(409);
    expect(body.blockingReasons[0]).toContain("anulado");
  });

  test("20. no permite editar un batch con un hijo ya rendido", async () => {
    const { batchId } = await createSimpleBatch();
    const children = await getChildren(batchId);
    await db.update(payments).set({ rendered: 1 }).where(eq(payments.id, children[0]!.id));

    const { status } = await callPatch(batchId, { notes: "no debería aplicarse" });
    expect(status).toBe(409);
  });

  test("batch inexistente → 404", async () => {
    const { status } = await callPatch(999999999, { notes: "x" });
    expect(status).toBe(404);
  });
});
