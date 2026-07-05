/**
 * Tests directos de recalculateInstallmentPaymentStatus (Etapa 3A, revisión):
 * la cuota solo queda "pagada" si existe un payment confirmado, vinculado a
 * esa cuota, con importe EXACTO en centavos — no alcanza con "cualquier
 * confirmado". Corre contra dev.db local (nunca Turso), fixtures aisladas
 * por prefijo.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { database as db } from "../database/index";
import { users, sessions, policies, companies, insureds, policyInstallments, payments } from "../database/schema";
import { eq, inArray } from "drizzle-orm";
import { recalculateInstallmentPaymentStatus } from "../../lib/payments/installment-status";

const USER_EMAIL = "test-inst-payment-status@test.local";
const PREFIX = "TEST-INST-PAY-STATUS";

let userId: number;
let companyId: number;
let insuredId: number;
const policyIdsToClean: number[] = [];
const paymentIdsToClean: number[] = [];

async function mkPolicy(): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: "activa", companyId, insuredId,
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

async function mkPayment(installmentId: number, amount: number, status: string): Promise<number> {
  const [p] = await db.insert(payments).values({
    installmentId, amount, paymentMethod: "efectivo", paymentDate: "2027-01-01",
    status, createdBy: userId,
  }).returning({ id: payments.id });
  paymentIdsToClean.push(p!.id);
  return p!.id;
}

async function getInstallment(id: number) {
  return db.select().from(policyInstallments).where(eq(policyInstallments.id, id)).get();
}

async function recalc(installmentId: number) {
  return db.transaction(async (tx) => recalculateInstallmentPaymentStatus(tx, installmentId));
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const polIds = prevPols.map(p => p.id);
    if (polIds.length) {
      const payRows = await db.select({ id: payments.id }).from(payments).where(inArray(payments.policyId, polIds)).all();
      if (payRows.length) await db.delete(payments).where(inArray(payments.id, payRows.map(r => r.id))).catch(() => {});
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, polIds)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, polIds)).catch(() => {});
    }
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Inst Pay Status", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(async () => {
  if (paymentIdsToClean.length) await db.delete(payments).where(inArray(payments.id, paymentIdsToClean)).catch(() => {});
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  await db.delete(insureds).where(eq(insureds.createdBy, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("1. Confirmado con importe exacto → pagada", () => {
  test("un único payment confirmado con el mismo importe marca la cuota pagada", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2099-01-01", 1000);
    await mkPayment(instId, 1000, "confirmado");

    await recalc(instId);
    expect((await getInstallment(instId))?.status).toBe("pagada");
  });
});

describe("2. Confirmado con importe diferente → NO justifica pagada", () => {
  test("un payment confirmado con importe distinto no cuenta como válido", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2099-01-01", 1000);
    await mkPayment(instId, 500, "confirmado"); // monto corrupto/histórico distinto

    await recalc(instId);
    expect((await getInstallment(instId))?.status).toBe("pendiente"); // no "pagada"
  });
});

describe("3. Un anulado + un exacto confirmado → pagada", () => {
  test("el anulado no cuenta, pero el confirmado exacto sí alcanza", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2099-01-01", 1000);
    await mkPayment(instId, 1000, "anulado");
    await mkPayment(instId, 1000, "confirmado");

    await recalc(instId);
    expect((await getInstallment(instId))?.status).toBe("pagada");
  });
});

describe("4. Eliminación del único confirmado exacto revierte la cuota", () => {
  test("borrar (simulado: pasar a anulado) el único payment válido la revierte", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2099-01-01", 1000);
    const payId = await mkPayment(instId, 1000, "confirmado");
    await recalc(instId);
    expect((await getInstallment(instId))?.status).toBe("pagada");

    // Simula la eliminación del payment (mismo efecto que DELETE /payments/:id
    // sobre la validez: ya no hay ningún confirmado vinculado).
    await db.delete(payments).where(eq(payments.id, payId));
    await recalc(instId);
    expect((await getInstallment(instId))?.status).toBe("pendiente");
  });
});

describe("5. Cuota vencida sin payment válido", () => {
  test("dueDate en el pasado y sin payment válido → vencida", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2020-01-01", 1000);

    await recalc(instId);
    expect((await getInstallment(instId))?.status).toBe("vencida");
  });
});

describe("6. Cuota futura sin payment válido", () => {
  test("dueDate futura y sin payment válido → pendiente", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2099-01-01", 1000);

    await recalc(instId);
    expect((await getInstallment(instId))?.status).toBe("pendiente");
  });
});
