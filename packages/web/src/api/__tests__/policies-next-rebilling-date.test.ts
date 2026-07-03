/**
 * Tests de API para policies.next_rebilling_date (Etapa 2).
 * Corre contra dev.db local (igual que el resto de los tests de este directorio)
 * — nunca contra Turso. Usa un usuario/prefijo de test propio y limpia al final.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import { users, sessions, policies, companies, insureds } from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-next-rebilling-001";
const USER_EMAIL = "test-next-rebilling@test.local";
const PREFIX = "TEST-NEXT-REB";

let userId: number;
let companyId: number;
let insuredId: number;
const policyIdsToClean: number[] = [];

function authHeaders(extra: Record<string, string> = {}) {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json", ...extra };
}

async function postPolicy(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/policies", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

async function putPolicy(id: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/policies/${id}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

function basePolicyBody(overrides: Record<string, any> = {}) {
  return {
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor",
    companyId,
    insuredId,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    ...overrides,
  };
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    if (prevPols.length) await db.delete(policies).where(inArray(policies.id, prevPols.map(p => p.id))).catch(() => {});
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Next Rebilling", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(async () => {
  if (policyIdsToClean.length) await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  await db.delete(insureds).where(eq(insureds.createdBy, userId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("POST /policies — next_rebilling_date", () => {
  test("acepta una fecha válida y la persiste", async () => {
    const { status, body } = await postPolicy(basePolicyBody({ nextRebillingDate: "2026-07-15" }));
    expect(status).toBe(201);
    expect(body.nextRebillingDate).toBe("2026-07-15");
    policyIdsToClean.push(body.id);
  });

  test("permite omitir el campo — queda null", async () => {
    const { status, body } = await postPolicy(basePolicyBody());
    expect(status).toBe(201);
    expect(body.nextRebillingDate).toBeNull();
    policyIdsToClean.push(body.id);
  });

  test("normaliza string vacío a null", async () => {
    const { status, body } = await postPolicy(basePolicyBody({ nextRebillingDate: "" }));
    expect(status).toBe(201);
    expect(body.nextRebillingDate).toBeNull();
    policyIdsToClean.push(body.id);
  });

  test("rechaza texto arbitrario (no fecha)", async () => {
    const { status, body } = await postPolicy(basePolicyBody({ nextRebillingDate: "pronto" }));
    expect(status).toBe(400);
    expect(body.error).toContain("inválida");
  });

  test("rechaza una fecha que no existe en el calendario", async () => {
    const { status, body } = await postPolicy(basePolicyBody({ nextRebillingDate: "2026-02-30" }));
    expect(status).toBe(400);
    expect(body.error).toContain("inválida");
  });

  test("rechaza formato incorrecto (no YYYY-MM-DD)", async () => {
    const { status } = await postPolicy(basePolicyBody({ nextRebillingDate: "15/07/2026" }));
    expect(status).toBe(400);
  });
});

describe("PUT /policies/:id — next_rebilling_date", () => {
  test("actualiza la fecha cuando se envía", async () => {
    const created = await postPolicy(basePolicyBody());
    policyIdsToClean.push(created.body.id);

    const { status, body } = await putPolicy(created.body.id, { nextRebillingDate: "2026-09-01" });
    expect(status).toBe(200);
    expect(body.nextRebillingDate).toBe("2026-09-01");
  });

  test("edición parcial sin el campo no lo altera", async () => {
    const created = await postPolicy(basePolicyBody({ nextRebillingDate: "2026-07-15" }));
    policyIdsToClean.push(created.body.id);

    // Edita solo las notas — no envía nextRebillingDate en absoluto.
    const { status, body } = await putPolicy(created.body.id, { notes: "actualización parcial" });
    expect(status).toBe(200);
    expect(body.notes).toBe("actualización parcial");
    expect(body.nextRebillingDate).toBe("2026-07-15"); // no se tocó
  });

  test("se puede limpiar explícitamente enviando null", async () => {
    const created = await postPolicy(basePolicyBody({ nextRebillingDate: "2026-07-15" }));
    policyIdsToClean.push(created.body.id);

    const { status, body } = await putPolicy(created.body.id, { nextRebillingDate: null });
    expect(status).toBe(200);
    expect(body.nextRebillingDate).toBeNull();
  });

  test("se puede limpiar explícitamente enviando string vacío", async () => {
    const created = await postPolicy(basePolicyBody({ nextRebillingDate: "2026-07-15" }));
    policyIdsToClean.push(created.body.id);

    const { status, body } = await putPolicy(created.body.id, { nextRebillingDate: "" });
    expect(status).toBe(200);
    expect(body.nextRebillingDate).toBeNull();
  });

  test("rechaza fecha inválida y no modifica el valor existente", async () => {
    const created = await postPolicy(basePolicyBody({ nextRebillingDate: "2026-07-15" }));
    policyIdsToClean.push(created.body.id);

    const { status, body } = await putPolicy(created.body.id, { nextRebillingDate: "no-es-fecha" });
    expect(status).toBe(400);
    expect(body.error).toContain("inválida");

    const row = await db.select({ nextRebillingDate: policies.nextRebillingDate })
      .from(policies).where(eq(policies.id, created.body.id)).get();
    expect(row?.nextRebillingDate).toBe("2026-07-15"); // no se pisó con el intento inválido
  });
});
