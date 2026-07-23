/**
 * Tests de "carga previa de siniestros" (Opción A): un claim con policyId
 * real puede quedar en status="pendiente" (previa) — status ya no se
 * deriva automáticamente de la presencia de policyId. Corre exclusivamente
 * contra dev.db local (nunca Turso), mismo patrón de fixtures de payment-batches.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import { users, sessions, policies, companies, insureds, claims } from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-claims-001";
const USER_EMAIL = "test-claims@test.local";
const PREFIX = "TEST-CLAIMS";

let userId: number;
let companyId: number;
let insuredId: number;
let policyId: number;

const claimIdsToClean: number[] = [];

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function callPost(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/claims", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) claimIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function callPut(id: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/claims/${id}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

async function getClaim(id: number) {
  return db.select().from(claims).where(eq(claims.id, id)).get();
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const polIds = prevPols.map(p => p.id);
    await db.delete(claims).where(eq(claims.createdBy, prevUser.id)).catch(() => {});
    if (polIds.length) await db.delete(policies).where(inArray(policies.id, polIds)).catch(() => {});
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Claims", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;

  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}`,
    type: "automotor", status: "activa", companyId, insuredId,
    startDate: "2027-01-01", endDate: "2027-12-31", isRebilling: 0, createdBy: userId,
  }).returning({ id: policies.id });
  policyId = p!.id;
});

afterAll(async () => {
  if (claimIdsToClean.length) await db.delete(claims).where(inArray(claims.id, claimIdsToClean)).catch(() => {});
  await db.delete(policies).where(eq(policies.id, policyId)).catch(() => {});
  await db.delete(insureds).where(eq(insureds.createdBy, userId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
  await db.delete(companies).where(eq(companies.id, companyId)).catch(() => {});
});

describe("POST /claims — status ya no se deriva de policyId (Opción A)", () => {
  test("1. sin policyId y sin status: crea pendiente", async () => {
    const { status, body } = await callPost({ manualInsured: "Juan Pérez" });
    expect(status).toBe(201);
    expect(body.status).toBe("pendiente");
    expect(body.policyId).toBeNull();
  });

  test("2. con policyId y sin status: crea pendiente (no 'nuevo')", async () => {
    const { status, body } = await callPost({ policyId });
    expect(status).toBe(201);
    expect(body.status).toBe("pendiente");
    expect(body.policyId).toBe(policyId);
  });

  test("3. con policyId y status='pendiente' explícito: mantiene pendiente", async () => {
    const { status, body } = await callPost({ policyId, status: "pendiente" });
    expect(status).toBe(201);
    expect(body.status).toBe("pendiente");
    expect(body.policyId).toBe(policyId);
  });

  test("4. con policyId y status='nuevo' explícito: guarda nuevo", async () => {
    const { status, body } = await callPost({ policyId, status: "nuevo" });
    expect(status).toBe(201);
    expect(body.status).toBe("nuevo");
    expect(body.policyId).toBe(policyId);
  });

  test("5. status inválido: rechaza con 400", async () => {
    const { status, body } = await callPost({ policyId, status: "no_existe" });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  test("8. manual sin póliza y sin status: sigue creando pendiente", async () => {
    const { status, body } = await callPost({ manualInsured: "Ana Gómez", manualCompany: "La Segunda" });
    expect(status).toBe(201);
    expect(body.status).toBe("pendiente");
    expect(body.policyId).toBeNull();
  });

  test("9. sin póliza y status='nuevo': rechaza con 400 (definitivo requiere póliza real)", async () => {
    const { status, body } = await callPost({ manualInsured: "Ana Gómez", status: "nuevo" });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });
});

describe("PUT /claims/:id", () => {
  test("6. permite pasar de pendiente a nuevo", async () => {
    const created = await callPost({ policyId });
    expect(created.body.status).toBe("pendiente");

    const { status, body } = await callPut(created.body.id, { status: "nuevo" });
    expect(status).toBe(200);
    expect(body.status).toBe("nuevo");

    const row = await getClaim(created.body.id);
    expect(row?.status).toBe("nuevo");
    expect(row?.policyId).toBe(policyId);
  });

  test("7. status inválido en PUT: rechaza con 400 y no modifica el registro", async () => {
    const created = await callPost({ policyId });
    const { status, body } = await callPut(created.body.id, { status: "estado_invalido" });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();

    const row = await getClaim(created.body.id);
    expect(row?.status).toBe("pendiente");
  });

  test("10. status='' en PUT: rechaza con 400 y no modifica", async () => {
    const created = await callPost({ policyId });
    const { status, body } = await callPut(created.body.id, { status: "" });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();

    const row = await getClaim(created.body.id);
    expect(row?.status).toBe("pendiente");
  });

  test("11. status=null en PUT: rechaza con 400 y no modifica", async () => {
    const created = await callPost({ policyId });
    const { status, body } = await callPut(created.body.id, { status: null });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();

    const row = await getClaim(created.body.id);
    expect(row?.status).toBe("pendiente");
  });

  test("12. previa SIN póliza a status='nuevo': rechaza con 400 y no modifica", async () => {
    const created = await callPost({ manualInsured: "Sin Póliza SRL" });
    expect(created.body.policyId).toBeNull();

    const { status, body } = await callPut(created.body.id, { status: "nuevo" });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();

    const row = await getClaim(created.body.id);
    expect(row?.status).toBe("pendiente");
  });

  test("13. previa CON póliza a status='nuevo': sigue funcionando", async () => {
    const created = await callPost({ policyId });
    expect(created.body.status).toBe("pendiente");

    const { status, body } = await callPut(created.body.id, { status: "nuevo" });
    expect(status).toBe(200);
    expect(body.status).toBe("nuevo");
  });

  test("14. actualizar datos manuales sin enviar status: sigue funcionando", async () => {
    const created = await callPost({ manualInsured: "Pedro Notas" });
    const { status, body } = await callPut(created.body.id, { manualNotes: "Falta el número de póliza" });
    expect(status).toBe(200);
    expect(body.status).toBe("pendiente");
    expect(body.manualNotes).toBe("Falta el número de póliza");

    const row = await getClaim(created.body.id);
    expect(row?.status).toBe("pendiente");
    expect(row?.manualNotes).toBe("Falta el número de póliza");
  });
});
