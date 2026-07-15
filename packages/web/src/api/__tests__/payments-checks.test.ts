/**
 * Tests de cheques en cobranzas INDIVIDUALES (migración 0028) sobre los
 * endpoints reales: POST/PUT/DELETE /payments, GET /received-checks(/:id),
 * POST /remittances y GET /cash/summary. Corre exclusivamente contra dev.db
 * local (nunca Turso) — misma estrategia de fixtures aisladas por prefijo
 * que payments.test.ts/payment-batches.test.ts/
 * remittance-allocations-endpoints.test.ts/caja-summary-endpoint.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, payments, paymentSplits, receivedChecks, cashEntries,
  remittances, remittanceItems, remittanceAllocations,
} from "../database/schema";
import { eq, inArray, sql } from "drizzle-orm";

const SESSION_ID = "test-session-pay-checks-001";
const USER_EMAIL = "test-pay-checks@test.local";
const PREFIX = "TEST-PAY-CHECKS";

let userId: number;
const paymentIdsToClean: number[] = [];
const remittanceIdsToClean: number[] = [];

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
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

async function callGetPayments(query = "") {
  const res = await app.fetch(new Request(`http://localhost/api/payments${query ? `?${query}` : ""}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

async function callGetReceivedChecks(query = "") {
  const res = await app.fetch(new Request(`http://localhost/api/received-checks${query ? `?${query}` : ""}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

async function callGetReceivedCheck(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/received-checks/${id}`, { headers: authHeaders() }));
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

async function getSummary(): Promise<any> {
  const res = await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }));
  return (await res.json());
}

async function getSplits(paymentId: number) {
  return db.select().from(paymentSplits).where(eq(paymentSplits.paymentId, paymentId)).all();
}

async function getChecksForPayment(paymentId: number) {
  const splits = await getSplits(paymentId);
  const splitIds = splits.map((s) => s.id);
  if (splitIds.length === 0) return [];
  return db.select().from(receivedChecks).where(inArray(receivedChecks.paymentSplitId, splitIds)).all();
}

let checkCounter = 0;
function mkCheckPayload(overrides: Record<string, any> = {}) {
  checkCounter++;
  return {
    checkNumber: `CHK-${PREFIX}-${Date.now()}-${checkCounter}`,
    bankName: `${PREFIX} Banco`,
    dueDate: "2027-06-01",
    amount: 1000,
    ...overrides,
  };
}

async function countPaymentsByManualPolicyNumber(manualPolicyNumber: string): Promise<number> {
  const rows = await db.select({ id: payments.id }).from(payments).where(eq(payments.manualPolicyNumber, manualPolicyNumber)).all();
  return rows.length;
}

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
    const rows = await db.select({ id: payments.id }).from(payments).where(eq(payments.createdBy, prevUser.id)).all();
    const remRows = await db.select({ id: remittances.id }).from(remittances).where(eq(remittances.createdBy, prevUser.id)).all();
    const payIds = rows.map((r) => r.id);
    const remIds = remRows.map((r) => r.id);
    await deleteRemittanceAllocationsFor({ paymentIds: payIds, remittanceIds: remIds });
    if (payIds.length) {
      const splits = await db.select({ id: paymentSplits.id }).from(paymentSplits).where(inArray(paymentSplits.paymentId, payIds)).all();
      const splitIds = splits.map((s) => s.id);
      if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.paymentSplitId, splitIds)).catch(() => {});
      await db.delete(cashEntries).where(inArray(cashEntries.paymentId, payIds)).catch(() => {});
      await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds)).catch(() => {});
      await db.delete(payments).where(inArray(payments.id, payIds)).catch(() => {});
    }
    if (remIds.length) {
      await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remIds)).catch(() => {});
      await db.delete(remittances).where(inArray(remittances.id, remIds)).catch(() => {});
    }
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Pay Checks", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });
});

afterAll(async () => {
  await deleteRemittanceAllocationsFor({ paymentIds: paymentIdsToClean, remittanceIds: remittanceIdsToClean });
  if (remittanceIdsToClean.length) {
    await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remittanceIdsToClean)).catch(() => {});
    await db.delete(remittances).where(inArray(remittances.id, remittanceIdsToClean)).catch(() => {});
  }
  if (paymentIdsToClean.length) {
    const splits = await db.select({ id: paymentSplits.id }).from(paymentSplits).where(inArray(paymentSplits.paymentId, paymentIdsToClean)).all();
    const splitIds = splits.map((s) => s.id);
    if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.paymentSplitId, splitIds)).catch(() => {});
    await db.delete(cashEntries).where(inArray(cashEntries.paymentId, paymentIdsToClean)).catch(() => {});
    await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, paymentIdsToClean)).catch(() => {});
    await db.delete(payments).where(inArray(payments.id, paymentIdsToClean)).catch(() => {});
  }
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

// ─── A. POST /payments con checks[] ────────────────────────────────────────

describe("A. POST /payments — split cheque con checks[]", () => {
  test("A1. un cheque — crea payment_splits + received_checks vinculado por payment_split_id", async () => {
    const { status, body } = await callPost({
      manualPayer: "Cliente A1", manualPolicyNumber: `${PREFIX}-A1`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    expect(status).toBe(201);
    const checks = await getChecksForPayment(body.id);
    expect(checks.length).toBe(1);
    expect(checks[0]!.batchSplitId).toBeNull();
    expect(checks[0]!.paymentSplitId).toBe((await getSplits(body.id))[0]!.id);
    expect(checks[0]!.status).toBe("en_cartera");
    expect(checks[0]!.amountCents).toBe(100000);
  });

  test("A2. dos cheques — crea 2 received_checks, suma coincide", async () => {
    const { status, body } = await callPost({
      manualPayer: "Cliente A2", manualPolicyNumber: `${PREFIX}-A2`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 600 }), mkCheckPayload({ amount: 400 })] }],
    });
    expect(status).toBe(201);
    const checks = await getChecksForPayment(body.id);
    expect(checks.length).toBe(2);
    expect(checks.reduce((s, c) => s + c.amountCents, 0)).toBe(100000);
  });

  test("A3. suma de cheques incorrecta → 400, sin fila parcial (rollback)", async () => {
    const manualPolicyNumber = `${PREFIX}-A3`;
    const { status, body } = await callPost({
      manualPayer: "Cliente A3", manualPolicyNumber, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 900 })] }],
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
    expect(await countPaymentsByManualPolicyNumber(manualPolicyNumber)).toBe(0);
  });

  test("A4. cheque sin número → 400, sin fila parcial", async () => {
    const manualPolicyNumber = `${PREFIX}-A4`;
    const { status } = await callPost({
      manualPayer: "Cliente A4", manualPolicyNumber, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [{ ...mkCheckPayload({ amount: 1000 }), checkNumber: "" }] }],
    });
    expect(status).toBe(400);
    expect(await countPaymentsByManualPolicyNumber(manualPolicyNumber)).toBe(0);
  });

  test("A5. cheque sin banco → 400, sin fila parcial", async () => {
    const manualPolicyNumber = `${PREFIX}-A5`;
    const { status } = await callPost({
      manualPayer: "Cliente A5", manualPolicyNumber, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [{ ...mkCheckPayload({ amount: 1000 }), bankName: "" }] }],
    });
    expect(status).toBe(400);
    expect(await countPaymentsByManualPolicyNumber(manualPolicyNumber)).toBe(0);
  });

  test("A6. cheque sin vencimiento → 400, sin fila parcial", async () => {
    const manualPolicyNumber = `${PREFIX}-A6`;
    const { status } = await callPost({
      manualPayer: "Cliente A6", manualPolicyNumber, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [{ ...mkCheckPayload({ amount: 1000 }), dueDate: "" }] }],
    });
    expect(status).toBe(400);
    expect(await countPaymentsByManualPolicyNumber(manualPolicyNumber)).toBe(0);
  });

  test("A7. split cheque sin checks[] → 400", async () => {
    const { status, body } = await callPost({
      manualPayer: "Cliente A7", manualPolicyNumber: `${PREFIX}-A7`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [] }],
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test("A8. split NO cheque con checks[] → 400", async () => {
    const { status, body } = await callPost({
      manualPayer: "Cliente A8", manualPolicyNumber: `${PREFIX}-A8`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "efectivo", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test("A9. pago sin checks (compatibilidad) sigue funcionando sin received_checks", async () => {
    const { status, body } = await callPost({
      manualPayer: "Cliente A9", manualPolicyNumber: `${PREFIX}-A9`, manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-06-01",
    });
    expect(status).toBe(201);
    expect((await getChecksForPayment(body.id)).length).toBe(0);
  });
});

// ─── B. PUT/DELETE /payments con cheques asociados ─────────────────────────

describe("B. PUT/DELETE /payments — pago con cheques asociados", () => {
  async function mkPaymentWithCheck(manualPolicyNumber: string) {
    const { body } = await callPost({
      manualPayer: "Cliente B", manualPolicyNumber, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    return body.id as number;
  }

  test("B1. PUT con `splits` nuevo → 409, mensaje de cheques asociados", async () => {
    const id = await mkPaymentWithCheck(`${PREFIX}-B1`);
    const { status, body } = await callPut(id, { splits: [{ method: "efectivo", amount: 1000 }] });
    expect(status).toBe(409);
    expect(body.error).toMatch(/cheques asociados/);
  });

  test("B2. PUT cambiando amount (atajo legacy) → 409", async () => {
    const id = await mkPaymentWithCheck(`${PREFIX}-B2`);
    const { status, body } = await callPut(id, { amount: 2000 });
    expect(status).toBe(409);
    expect(body.error).toMatch(/cheques asociados/);
  });

  test("B3. DELETE de un pago con cheques → 409", async () => {
    const id = await mkPaymentWithCheck(`${PREFIX}-B3`);
    const { status, body } = await callDelete(id);
    expect(status).toBe(409);
    expect(body.error).toMatch(/cheques asociados/);
    // Nada se borró — el pago sigue existiendo con su split y su cheque.
    expect((await getSplits(id)).length).toBe(1);
    expect((await getChecksForPayment(id)).length).toBe(1);
  });

  test("B4. PUT status=anulado (no rendido) → 200, transiciona los cheques a anulado", async () => {
    const id = await mkPaymentWithCheck(`${PREFIX}-B4`);
    const { status, body } = await callPut(id, { status: "anulado" });
    expect(status).toBe(200);
    expect(body.status).toBe("anulado");
    const checks = await getChecksForPayment(id);
    expect(checks.length).toBe(1);
    expect(checks[0]!.status).toBe("anulado");
    expect(checks[0]!.cancelledAt).not.toBeNull();
  });

  test("B5. PUT solo notas (sin tocar splits/amount/método) → 200, permitido", async () => {
    const id = await mkPaymentWithCheck(`${PREFIX}-B5`);
    const { status, body } = await callPut(id, { notes: "nota actualizada" });
    expect(status).toBe(200);
    expect(body.notes).toBe("nota actualizada");
    expect((await getChecksForPayment(id)).length).toBe(1);
  });
});

// ─── C. GET /received-checks(/:id) — origen "payment" ──────────────────────

describe("C. GET /received-checks — cheques de pagos individuales", () => {
  test("C1. aparece con source=payment y datos del pago", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente C1", manualPolicyNumber: `${PREFIX}-C1`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const checkId = (await getChecksForPayment(created.id))[0]!.id;

    const { status, body } = await callGetReceivedChecks();
    expect(status).toBe(200);
    const row = body.find((r: any) => r.check.id === checkId);
    expect(row).toBeTruthy();
    expect(row.source).toBe("payment");
    expect(row.batch).toBeNull();
    expect(row.payment.id).toBe(created.id);
    expect(row.installments[0].paymentId).toBe(created.id);
  });

  test("C2. GET /received-checks/:id funciona para un cheque individual", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente C2", manualPolicyNumber: `${PREFIX}-C2`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const checkId = (await getChecksForPayment(created.id))[0]!.id;

    const { status, body } = await callGetReceivedCheck(checkId);
    expect(status).toBe(200);
    expect(body.source).toBe("payment");
    expect(body.check.id).toBe(checkId);
    expect(body.payment.id).toBe(created.id);
    expect(body.batch).toBeNull();
  });

  test("C3. filtro status funciona para cheques individuales", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente C3", manualPolicyNumber: `${PREFIX}-C3`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const checkId = (await getChecksForPayment(created.id))[0]!.id;

    const { body: enCartera } = await callGetReceivedChecks("status=en_cartera");
    expect(enCartera.some((r: any) => r.check.id === checkId)).toBe(true);
    const { body: cobrado } = await callGetReceivedChecks("status=cobrado");
    expect(cobrado.some((r: any) => r.check.id === checkId)).toBe(false);
  });

  test("C4. batchId como filtro excluye cheques de pago individual", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente C4", manualPolicyNumber: `${PREFIX}-C4`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const checkId = (await getChecksForPayment(created.id))[0]!.id;

    const { body } = await callGetReceivedChecks("batchId=999999999");
    expect(body.some((r: any) => r.check.id === checkId)).toBe(false);
  });
});

// ─── D. Rendiciones — una allocation por cheque ────────────────────────────

describe("D. POST /remittances — cheques de un pago individual", () => {
  test("D1. un cheque — 1 allocation con receivedCheckId + paymentSplitId", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente D1", manualPolicyNumber: `${PREFIX}-D1`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const splitId = (await getSplits(created.id))[0]!.id;
    const checkId = (await getChecksForPayment(created.id))[0]!.id;

    const { status, body: rem } = await callPostRemittance({
      date: "2027-06-05", canal: "directo", paymentBreakdown: { cheque: 1000 },
      items: [{ source: "payment", sourceId: created.id, amount: 1000, paymentMethod: "cheque" }],
    });
    expect(status).toBe(200);

    const allocs = await db.select().from(remittanceAllocations).where(eq(remittanceAllocations.remittanceId, rem.id)).all();
    expect(allocs.length).toBe(1);
    expect(allocs[0]!.paymentSplitId).toBe(splitId);
    expect(allocs[0]!.receivedCheckId).toBe(checkId);
    expect(allocs[0]!.method).toBe("cheque");
    expect(allocs[0]!.amountCents).toBe(100000);
  });

  test("D2. dos cheques — 2 allocations, nunca se suma además el split completo", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente D2", manualPolicyNumber: `${PREFIX}-D2`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 600 }), mkCheckPayload({ amount: 400 })] }],
    });

    const { status, body: rem } = await callPostRemittance({
      date: "2027-06-05", canal: "directo", paymentBreakdown: { cheque: 1000 },
      items: [{ source: "payment", sourceId: created.id, amount: 1000, paymentMethod: "cheque" }],
    });
    expect(status).toBe(200);

    const allocs = await db.select().from(remittanceAllocations).where(eq(remittanceAllocations.remittanceId, rem.id)).all();
    expect(allocs.length).toBe(2);
    expect(allocs.every((a) => a.paymentSplitId != null && a.receivedCheckId != null)).toBe(true);
    expect(allocs.reduce((s, a) => s + a.amountCents, 0)).toBe(100000);
  });

  test("D3. el mismo pago no puede rendirse dos veces (cheque no se rinde dos veces)", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente D3", manualPolicyNumber: `${PREFIX}-D3`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const first = await callPostRemittance({
      date: "2027-06-05", canal: "directo", paymentBreakdown: { cheque: 1000 },
      items: [{ source: "payment", sourceId: created.id, amount: 1000, paymentMethod: "cheque" }],
    });
    expect(first.status).toBe(200);

    const second = await callPostRemittance({
      date: "2027-06-06", canal: "directo", paymentBreakdown: { cheque: 1000 },
      items: [{ source: "payment", sourceId: created.id, amount: 1000, paymentMethod: "cheque" }],
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/ya fue rendido/);
  });

  test("D4. un pago con cheque nunca puede rendirse como adeudado", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente D4", manualPolicyNumber: `${PREFIX}-D4`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const { status, body } = await callPostRemittance({
      date: "2027-06-05", canal: "directo",
      items: [{ source: "payment", sourceId: created.id, amount: 1000, debtorStatus: "adeudado", paymentMethod: "cheque" }],
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no puede registrarse como adeudado/);
  });
});

// ─── E. Caja — no duplica importes ─────────────────────────────────────────

describe("E. GET /cash/summary — pago individual con cheque", () => {
  test("E1. cuenta una sola vez en cartera.cheque (no se duplica por received_checks)", async () => {
    const before = await getSummary();
    const { body: created } = await callPost({
      manualPayer: "Cliente E1", manualPolicyNumber: `${PREFIX}-E1`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 600 }), mkCheckPayload({ amount: 400 })] }],
    });
    const after = await getSummary();
    expect(after.cartera.cheque - before.cartera.cheque).toBeCloseTo(1000, 2);
    void created;
  });

  test("E2. un pago anulado deja de contarse en cartera", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente E2", manualPolicyNumber: `${PREFIX}-E2`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const before = await getSummary();
    await callPut(created.id, { status: "anulado" });
    const after = await getSummary();
    expect(before.cartera.cheque - after.cartera.cheque).toBeCloseTo(1000, 2);
  });
});

// ─── F. GET /payments — hasChecks (para que la UI no ofrezca "Eliminar") ────

describe("F. GET /payments — hasChecks", () => {
  test("F1. pago con cheque → hasChecks true", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente F1", manualPolicyNumber: `${PREFIX}-F1`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const { status, body } = await callGetPayments();
    expect(status).toBe(200);
    const row = body.find((r: any) => r.payment.id === created.id);
    expect(row.payment.hasChecks).toBe(true);
  });

  test("F2. pago sin cheques (efectivo) → hasChecks false", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente F2", manualPolicyNumber: `${PREFIX}-F2`, manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-06-01",
    });
    const { body } = await callGetPayments();
    const row = body.find((r: any) => r.payment.id === created.id);
    expect(row.payment.hasChecks).toBe(false);
  });

  test("F3. split cheque sin checks (legacy, compatibilidad) → hasChecks false", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente F3", manualPolicyNumber: `${PREFIX}-F3`, manualCompany: "TestCo",
      amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-06-01",
    });
    // Simula un dato legacy (anterior a 0028): un split method='cheque' sin
    // ningún received_checks real — no debería pasar en datos nuevos vía
    // POST, pero si existiera (histórico), hasChecks debe seguir siendo false.
    await db.update(paymentSplits).set({ method: "cheque" }).where(eq(paymentSplits.paymentId, created.id));
    const { body } = await callGetPayments();
    const row = body.find((r: any) => r.payment.id === created.id);
    expect(row.payment.hasChecks).toBe(false);
  });
});

// ─── G. DELETE — mensaje mostrado por la UI (handleDelete en cobranzas.tsx) ──
// No se puede testear el componente React acá (este proyecto no usa ese tipo
// de test), pero sí que el backend siga devolviendo el mensaje exacto que la
// UI ahora muestra tal cual (antes se perdía en un toast genérico porque solo
// mostraba err.message si contenía "rendido").

describe("G. DELETE /payments/:id — mensaje exacto para pago con cheques", () => {
  test("G1. mensaje exacto, sin la palabra 'rendido' (regresión del bug reportado por QA)", async () => {
    const { body: created } = await callPost({
      manualPayer: "Cliente G1", manualPolicyNumber: `${PREFIX}-G1`, manualCompany: "TestCo",
      amount: 1000, paymentDate: "2027-06-01",
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const { status, body } = await callDelete(created.id);
    expect(status).toBe(409);
    expect(body.error).toBe("Este pago tiene cheques asociados. Para corregirlo, anulá el pago y cargalo nuevamente.");
    expect(body.error).not.toMatch(/rendido/);
  });
});
