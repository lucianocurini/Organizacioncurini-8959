/**
 * Tests de API para POST /policies/:id/installments/generate (Etapa 2):
 * protección de cuotas existentes contra regeneración accidental (guard 409).
 * Corre contra dev.db local — nunca contra Turso.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import { users, sessions, policies, companies, insureds, policyInstallments } from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-inst-gen-001";
const USER_EMAIL = "test-inst-gen@test.local";
const PREFIX = "TEST-INST-GEN";

let userId: number;
let companyId: number;
let insuredId: number;
const policyIdsToClean: number[] = [];

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function mkPolicy(): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: "activa", companyId, insuredId,
    startDate: "2026-01-01", endDate: "2026-12-31", isRebilling: 0, createdBy: userId,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}

async function generate(policyId: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}/installments/generate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

const SAMPLE_INSTALLMENTS = [
  { number: 1, dueDate: "2026-01-01", amount: 1000, notes: "" },
  { number: 2, dueDate: "2026-02-01", amount: 1000, notes: "" },
];

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const ids = prevPols.map(p => p.id);
    if (ids.length) {
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, ids)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, ids)).catch(() => {});
    }
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Inst Gen", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(async () => {
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  await db.delete(insureds).where(eq(insureds.createdBy, userId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("Protección de cuotas existentes (sin cambios de comportamiento)", () => {
  test("primera generación: crea las cuotas e informa la cantidad en policies.installments", async () => {
    const policyId = await mkPolicy();
    const { status, body } = await generate(policyId, { installments: SAMPLE_INSTALLMENTS });
    expect(status).toBe(201);
    expect(body.length).toBe(2);

    const pol = await db.select({ installments: policies.installments }).from(policies).where(eq(policies.id, policyId)).get();
    expect(pol?.installments).toBe(2);
  });

  test("segunda generación sobre la misma póliza: 409, no agrega ni borra filas", async () => {
    const policyId = await mkPolicy();
    await generate(policyId, { installments: SAMPLE_INSTALLMENTS });

    const before = await db.select({ id: policyInstallments.id }).from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();

    const { status, body } = await generate(policyId, { installments: [{ number: 1, dueDate: "2026-06-01", amount: 999, notes: "" }] });
    expect(status).toBe(409);
    expect(body.error).toContain("ya tiene cuotas");

    const after = await db.select({ id: policyInstallments.id }).from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();
    expect(after.length).toBe(before.length); // ni se agregó ni se borró nada
  });
});
