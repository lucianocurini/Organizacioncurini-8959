/**
 * Tests de GET/POST/PUT/DELETE /api/deliveries + PATCH /send /deliver
 * /complete, y del conflicto de borrado de una refacturación con un
 * seguimiento vinculado (DELETE /api/rebillings/:id). Integración formal de
 * Envíos y Entregas con Pólizas/Refacturaciones — Paso A (migración 0031).
 * Corre exclusivamente contra dev.db local (nunca Turso) — mismo patrón que
 * rebilling-endpoints.test.ts. Cada test crea sus propios fixtures (prefijo
 * único) y los borra en un bloque finally.
 */

import { test, expect, beforeAll, afterAll, describe, setSystemTime } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import { users, sessions, policies, rebillings, deliveries, companies, insureds } from "../database/schema";
import { eq, inArray } from "drizzle-orm";
import { toArgentinaCalendarDay } from "../../lib/dates/argentina-date";
import { DELIVERY_CHANNEL_PENDING } from "../../lib/deliveries/validation";

const SESSION_ID = "test-session-deliveries-endpoints-001";
const USER_EMAIL = "test-deliveries-endpoints@test.local";
const PREFIX = "TEST-DELIVERIES-EP";

let userId: number;
let insuredId: number;
let companyId: number;

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function callGet(qs = "") {
  const res = await app.fetch(new Request(`http://localhost/api/deliveries${qs}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}
async function callPost(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/deliveries", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function callQuickAdd(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/deliveries/quick-add", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function callPut(id: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/deliveries/${id}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function callPatch(path: string) {
  const res = await app.fetch(new Request(`http://localhost/api/deliveries/${path}`, {
    method: "PATCH", headers: authHeaders(),
  }));
  return { status: res.status, body: await res.json() };
}
async function callDeleteDelivery(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/deliveries/${id}`, {
    method: "DELETE", headers: authHeaders(),
  }));
  return { status: res.status, body: await res.json() };
}
async function callDeleteRebilling(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/rebillings/${id}`, {
    method: "DELETE", headers: authHeaders(),
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

async function mkPolicy(suffix: string): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "automotor", status: "activa", companyId, insuredId,
    startDate: "2027-01-01", endDate: "2027-12-31",
    installments: 0, createdBy: userId,
  }).returning({ id: policies.id });
  return p!.id;
}

async function mkRebilling(policyId: number, billingStart = "2027-06-01", billingEnd = "2027-06-30"): Promise<number> {
  const [r] = await db.insert(rebillings).values({
    policyId, billingStart, billingEnd, premium: 1000, createdBy: userId,
  }).returning({ id: rebillings.id });
  return r!.id;
}

const createdPolicyIds: number[] = [];
const createdDeliveryIds: number[] = [];

async function cleanupAll() {
  if (createdDeliveryIds.length) {
    await deleteWithRetry(() => db.delete(deliveries).where(inArray(deliveries.id, createdDeliveryIds)));
    createdDeliveryIds.length = 0;
  }
  for (const policyId of createdPolicyIds) {
    await deleteWithRetry(() => db.delete(deliveries).where(eq(deliveries.policyId, policyId)));
    await deleteWithRetry(() => db.delete(rebillings).where(eq(rebillings.policyId, policyId)));
    await deleteWithRetry(() => db.delete(policies).where(eq(policies.id, policyId)));
  }
  createdPolicyIds.length = 0;
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const stalePolicies = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    for (const p of stalePolicies) {
      await deleteWithRetry(() => db.delete(deliveries).where(eq(deliveries.policyId, p.id)));
      await deleteWithRetry(() => db.delete(rebillings).where(eq(rebillings.policyId, p.id)));
      await deleteWithRetry(() => db.delete(policies).where(eq(policies.id, p.id)));
    }
    await deleteWithRetry(() => db.delete(sessions).where(eq(sessions.userId, prevUser.id)));
    await deleteWithRetry(() => db.delete(users).where(eq(users.id, prevUser.id)));
  }
  const prevInsured = await db.select({ id: insureds.id }).from(insureds).where(eq(insureds.name, `${PREFIX} Asegurado`)).get();
  if (prevInsured) await deleteWithRetry(() => db.delete(insureds).where(eq(insureds.id, prevInsured.id)));

  const [u] = await db.insert(users).values({
    name: "Test Deliveries Endpoints", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 7 * 86400000) });

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Compania`)).get();
  companyId = existingCo ? existingCo.id : (await db.insert(companies).values({ name: `${PREFIX} Compania` }).returning({ id: companies.id }))[0]!.id;
});

afterAll(async () => {
  await cleanupAll();
  await deleteWithRetry(() => db.delete(insureds).where(eq(insureds.id, insuredId)));
  await deleteWithRetry(() => db.delete(sessions).where(eq(sessions.id, SESSION_ID)));
  await deleteWithRetry(() => db.delete(users).where(eq(users.id, userId)));
});

describe("POST /deliveries — vínculo con póliza/refacturación", () => {
  test("seguimiento de póliza real (documentType=poliza) se crea en pendiente", async () => {
    const policyId = await mkPolicy("post-poliza");
    createdPolicyIds.push(policyId);
    const { status, body } = await callPost({ policyId, documentType: "poliza", channel: "email" });
    expect(status).toBe(201);
    expect(body.policyId).toBe(policyId);
    expect(body.rebillingId).toBeNull();
    expect(body.status).toBe("pendiente");
    createdDeliveryIds.push(body.id);
  });

  test("policyId inexistente → 404", async () => {
    const { status, body } = await callPost({ policyId: 999999, documentType: "poliza", channel: "email" });
    expect(status).toBe(404);
    expect(body.error).toContain("póliza");
  });

  test("documentType=refacturacion sin rebillingId → 400", async () => {
    const policyId = await mkPolicy("post-reb-sin-id");
    createdPolicyIds.push(policyId);
    const { status, body } = await callPost({ policyId, documentType: "refacturacion", channel: "email" });
    expect(status).toBe(400);
    expect(body.error).toContain("rebillingId");
  });

  test("rebillingId inexistente → 404", async () => {
    const policyId = await mkPolicy("post-reb-inexistente");
    createdPolicyIds.push(policyId);
    const { status, body } = await callPost({ policyId, rebillingId: 999999, documentType: "refacturacion", channel: "email" });
    expect(status).toBe(404);
    expect(body.error).toContain("refacturación");
  });

  test("rebilling perteneciente a OTRA póliza → 400", async () => {
    const policyId = await mkPolicy("post-reb-otra-a");
    const otherPolicyId = await mkPolicy("post-reb-otra-b");
    createdPolicyIds.push(policyId, otherPolicyId);
    const rebillingId = await mkRebilling(otherPolicyId);
    const { status, body } = await callPost({ policyId, rebillingId, documentType: "refacturacion", channel: "email" });
    expect(status).toBe(400);
    expect(body.error).toContain("no pertenece");
  });

  test("documentType=poliza + rebillingId → 400 (combinación rechazada)", async () => {
    const policyId = await mkPolicy("post-poliza-con-reb");
    createdPolicyIds.push(policyId);
    const rebillingId = await mkRebilling(policyId);
    const { status, body } = await callPost({ policyId, rebillingId, documentType: "poliza", channel: "email" });
    expect(status).toBe(400);
    expect(body.error).toContain("rebillingId");
  });

  test("refacturación real vinculada a la póliza correcta se crea OK", async () => {
    const policyId = await mkPolicy("post-reb-ok");
    createdPolicyIds.push(policyId);
    const rebillingId = await mkRebilling(policyId);
    const { status, body } = await callPost({ policyId, rebillingId, documentType: "refacturacion", channel: "whatsapp" });
    expect(status).toBe(201);
    expect(body.policyId).toBe(policyId);
    expect(body.rebillingId).toBe(rebillingId);
    createdDeliveryIds.push(body.id);
  });

  test("registro manual (sin policyId) sigue siendo compatible", async () => {
    const { status, body } = await callPost({
      manualRecipient: "Juan Pérez", manualPolicyNumber: "MANUAL-001", manualCompany: "Cia Manual",
      documentType: "poliza", channel: "copia_cliente",
    });
    expect(status).toBe(201);
    expect(body.policyId).toBeNull();
    expect(body.rebillingId).toBeNull();
    expect(body.manualRecipient).toBe("Juan Pérez");
    createdDeliveryIds.push(body.id);
  });

  test("channel inválido → 400", async () => {
    const policyId = await mkPolicy("post-channel-invalido");
    createdPolicyIds.push(policyId);
    const { status } = await callPost({ policyId, documentType: "poliza", channel: "carta_documento" });
    expect(status).toBe(400);
  });
});

describe("POST /deliveries/quick-add — alta rápida desde póliza/refacturación", () => {
  test("póliza general: crea pendiente con channel=DELIVERY_CHANNEL_PENDING, sin fechas", async () => {
    const policyId = await mkPolicy("quick-poliza");
    createdPolicyIds.push(policyId);
    const { status, body } = await callQuickAdd({ policyId, documentType: "poliza" });
    expect(status).toBe(201);
    expect(body.policyId).toBe(policyId);
    expect(body.rebillingId).toBeNull();
    expect(body.status).toBe("pendiente");
    expect(body.channel).toBe(DELIVERY_CHANNEL_PENDING);
    expect(body.scheduledDate).toBeNull();
    expect(body.sentDate).toBeNull();
    expect(body.completedDate).toBeNull();
    createdDeliveryIds.push(body.id);
  });

  test("refacturación puntual: crea pendiente vinculado al rebillingId real", async () => {
    const policyId = await mkPolicy("quick-reb");
    createdPolicyIds.push(policyId);
    const rebillingId = await mkRebilling(policyId);
    const { status, body } = await callQuickAdd({ policyId, rebillingId, documentType: "refacturacion" });
    expect(status).toBe(201);
    expect(body.rebillingId).toBe(rebillingId);
    expect(body.channel).toBe(DELIVERY_CHANNEL_PENDING);
    createdDeliveryIds.push(body.id);
  });

  test("segundo clic (mismo documento aún activo) → 409, no duplica", async () => {
    const policyId = await mkPolicy("quick-dup");
    createdPolicyIds.push(policyId);
    const first = await callQuickAdd({ policyId, documentType: "poliza" });
    expect(first.status).toBe(201);
    createdDeliveryIds.push(first.body.id);

    const second = await callQuickAdd({ policyId, documentType: "poliza" });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("Ya existe un seguimiento activo");

    const rows = await db.select().from(deliveries).where(eq(deliveries.policyId, policyId));
    expect(rows.length).toBe(1);
  });

  test("sin policyId → 400, nunca crea modo manual desde este endpoint", async () => {
    const { status, body } = await callQuickAdd({ documentType: "poliza" });
    expect(status).toBe(400);
    expect(body.error).toContain("policyId");
  });

  test("policyId inexistente → 404 (misma resolución que POST /deliveries)", async () => {
    const { status } = await callQuickAdd({ policyId: 999999, documentType: "poliza" });
    expect(status).toBe(404);
  });

  test("rebilling perteneciente a OTRA póliza → 400 (misma validación de pertenencia)", async () => {
    const policyId = await mkPolicy("quick-reb-otra-a");
    const otherPolicyId = await mkPolicy("quick-reb-otra-b");
    createdPolicyIds.push(policyId, otherPolicyId);
    const rebillingId = await mkRebilling(otherPolicyId);
    const { status, body } = await callQuickAdd({ policyId, rebillingId, documentType: "refacturacion" });
    expect(status).toBe(400);
    expect(body.error).toContain("no pertenece");
  });

  test("body.channel es ignorado — siempre arranca con DELIVERY_CHANNEL_PENDING", async () => {
    const policyId = await mkPolicy("quick-channel-ignorado");
    createdPolicyIds.push(policyId);
    const { status, body } = await callQuickAdd({ policyId, documentType: "poliza", channel: "whatsapp" });
    expect(status).toBe(201);
    expect(body.channel).toBe(DELIVERY_CHANNEL_PENDING);
    createdDeliveryIds.push(body.id);
  });
});

describe("POST /deliveries — anti-duplicado", () => {
  test("duplicado activo de póliza (pendiente) → 409", async () => {
    const policyId = await mkPolicy("dup-poliza");
    createdPolicyIds.push(policyId);
    const first = await callPost({ policyId, documentType: "poliza", channel: "email" });
    expect(first.status).toBe(201);
    createdDeliveryIds.push(first.body.id);

    const second = await callPost({ policyId, documentType: "poliza", channel: "whatsapp" });
    expect(second.status).toBe(409);
  });

  test("duplicado activo de refacturación (misma rebillingId) → 409", async () => {
    const policyId = await mkPolicy("dup-reb");
    createdPolicyIds.push(policyId);
    const rebillingId = await mkRebilling(policyId);
    const first = await callPost({ policyId, rebillingId, documentType: "refacturacion", channel: "email" });
    expect(first.status).toBe(201);
    createdDeliveryIds.push(first.body.id);

    const second = await callPost({ policyId, rebillingId, documentType: "refacturacion", channel: "whatsapp" });
    expect(second.status).toBe(409);
  });

  test("dos refacturaciones DISTINTAS de la misma póliza no son duplicado entre sí", async () => {
    const policyId = await mkPolicy("dup-reb-distintas");
    createdPolicyIds.push(policyId);
    const rebillingId1 = await mkRebilling(policyId, "2027-01-01", "2027-01-31");
    const rebillingId2 = await mkRebilling(policyId, "2027-02-01", "2027-02-28");
    const first = await callPost({ policyId, rebillingId: rebillingId1, documentType: "refacturacion", channel: "email" });
    expect(first.status).toBe(201);
    createdDeliveryIds.push(first.body.id);

    const second = await callPost({ policyId, rebillingId: rebillingId2, documentType: "refacturacion", channel: "email" });
    expect(second.status).toBe(201);
    createdDeliveryIds.push(second.body.id);
  });

  test("si el anterior está entregado, permite un reenvío (nuevo registro)", async () => {
    const policyId = await mkPolicy("dup-reenvio-entregado");
    createdPolicyIds.push(policyId);
    const first = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(first.body.id);
    await callPatch(`${first.body.id}/send`);
    await callPatch(`${first.body.id}/deliver`);

    const second = await callPost({ policyId, documentType: "poliza", channel: "whatsapp" });
    expect(second.status).toBe(201);
    createdDeliveryIds.push(second.body.id);
  });

  test("si el anterior está 'realizado' (legacy), permite un reenvío", async () => {
    const policyId = await mkPolicy("dup-reenvio-realizado");
    createdPolicyIds.push(policyId);
    const first = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(first.body.id);
    await callPatch(`${first.body.id}/complete`);

    const second = await callPost({ policyId, documentType: "poliza", channel: "whatsapp" });
    expect(second.status).toBe(201);
    createdDeliveryIds.push(second.body.id);
  });

  test("registros manuales nunca compiten por duplicado entre sí", async () => {
    const first = await callPost({ manualPolicyNumber: "DUP-MANUAL", documentType: "poliza", channel: "email" });
    expect(first.status).toBe(201);
    createdDeliveryIds.push(first.body.id);
    const second = await callPost({ manualPolicyNumber: "DUP-MANUAL", documentType: "poliza", channel: "email" });
    expect(second.status).toBe(201);
    createdDeliveryIds.push(second.body.id);
  });
});

describe("PUT /deliveries/:id", () => {
  test("edición de canal/notas excluye el propio registro del chequeo de duplicado", async () => {
    const policyId = await mkPolicy("put-excluye-propio");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);

    const edited = await callPut(created.body.id, { channel: "whatsapp", notes: "reprogramado" });
    expect(edited.status).toBe(200);
    expect(edited.body.channel).toBe("whatsapp");
    expect(edited.body.notes).toBe("reprogramado");
  });

  test("PUT parcial (solo notes) no borra policyId/rebillingId/fechas existentes", async () => {
    const policyId = await mkPolicy("put-parcial");
    createdPolicyIds.push(policyId);
    const rebillingId = await mkRebilling(policyId);
    const created = await callPost({ policyId, rebillingId, documentType: "refacturacion", channel: "email", scheduledDate: "2027-07-01" });
    createdDeliveryIds.push(created.body.id);
    await callPatch(`${created.body.id}/send`);

    const edited = await callPut(created.body.id, { notes: "solo esto cambia" });
    expect(edited.status).toBe(200);
    expect(edited.body.policyId).toBe(policyId);
    expect(edited.body.rebillingId).toBe(rebillingId);
    expect(edited.body.scheduledDate).toBe("2027-07-01");
    expect(edited.body.status).toBe("enviado"); // PUT nunca toca status
    expect(edited.body.sentDate).not.toBeNull(); // ni sentDate
  });

  test("PUT no acepta status/sentDate/completedDate directos (se ignoran silenciosamente)", async () => {
    const policyId = await mkPolicy("put-ignora-status");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);

    const edited = await callPut(created.body.id, { status: "entregado", completedDate: "2027-01-01", sentDate: "2027-01-01" });
    expect(edited.status).toBe(200);
    expect(edited.body.status).toBe("pendiente"); // sin cambios — el intento se ignora
    expect(edited.body.completedDate).toBeNull();
    expect(edited.body.sentDate).toBeNull();
  });

  test("editar hacia un rebillingId inexistente → 404", async () => {
    const policyId = await mkPolicy("put-reb-inexistente");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);

    const edited = await callPut(created.body.id, { documentType: "refacturacion", rebillingId: 999999 });
    expect(edited.status).toBe(404);
  });

  test("id inexistente → 404", async () => {
    const { status } = await callPut(999999, { notes: "x" });
    expect(status).toBe(404);
  });
});

describe("Transiciones de estado — pendiente → enviado → entregado", () => {
  test("pendiente → enviado registra sentDate y cambia status", async () => {
    const policyId = await mkPolicy("send-ok");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);
    expect(created.body.sentDate).toBeNull();

    const sent = await callPatch(`${created.body.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("enviado");
    expect(sent.body.sentDate).not.toBeNull();
    expect(sent.body.completedDate).toBeNull();
  });

  test("enviado → entregado registra completedDate", async () => {
    const policyId = await mkPolicy("deliver-ok");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);
    await callPatch(`${created.body.id}/send`);

    const delivered = await callPatch(`${created.body.id}/deliver`);
    expect(delivered.status).toBe(200);
    expect(delivered.body.status).toBe("entregado");
    expect(delivered.body.completedDate).not.toBeNull();
  });

  test("pendiente → enviado → entregado usa el día calendario Argentina en la ventana 21:00–23:59, no el día UTC", async () => {
    const policyId = await mkPolicy("send-deliver-tz");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);

    // 01:16 UTC = 22:16 Argentina (UTC-3, sin horario de verano) del día UTC
    // anterior — la misma ventana horaria que produjo el bug de la
    // rendición #115 (día UTC siguiente en vez del día calendario Argentina
    // real). Se calcula relativo a "ahora" (no una fecha fija) para que la
    // sesión de test, creada con expiración real de 7 días, siga siendo
    // válida bajo el reloj simulado.
    const base = new Date();
    const mockedNow = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 1, 1, 16, 0));
    const expectedArgentinaDay = toArgentinaCalendarDay(mockedNow);
    const utcDay = mockedNow.toISOString().slice(0, 10);
    expect(expectedArgentinaDay).not.toBe(utcDay); // confirma que la ventana elegida cruza el día UTC

    setSystemTime(mockedNow);
    try {
      const sent = await callPatch(`${created.body.id}/send`);
      expect(sent.body.sentDate).toBe(expectedArgentinaDay);

      const delivered = await callPatch(`${created.body.id}/deliver`);
      expect(delivered.body.completedDate).toBe(expectedArgentinaDay);
    } finally {
      setSystemTime();
    }
  });

  test("transición inválida: /send sobre un seguimiento ya enviado → 409", async () => {
    const policyId = await mkPolicy("send-invalido");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);
    await callPatch(`${created.body.id}/send`);

    const secondSend = await callPatch(`${created.body.id}/send`);
    expect(secondSend.status).toBe(409);
  });

  test("transición inválida: /deliver directo desde pendiente (sin pasar por enviado) → 409", async () => {
    const policyId = await mkPolicy("deliver-sin-send");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);

    const delivered = await callPatch(`${created.body.id}/deliver`);
    expect(delivered.status).toBe(409);
  });

  test("transición inválida: /deliver sobre uno ya entregado → 409", async () => {
    const policyId = await mkPolicy("deliver-doble");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);
    await callPatch(`${created.body.id}/send`);
    await callPatch(`${created.body.id}/deliver`);

    const secondDeliver = await callPatch(`${created.body.id}/deliver`);
    expect(secondDeliver.status).toBe(409);
  });

  test("/send sobre un alta rápida sin completar (channel=sin_definir) → 409, no cambia de estado", async () => {
    const policyId = await mkPolicy("send-sin-canal");
    createdPolicyIds.push(policyId);
    const created = await callQuickAdd({ policyId, documentType: "poliza" });
    createdDeliveryIds.push(created.body.id);
    expect(created.body.channel).toBe(DELIVERY_CHANNEL_PENDING);

    const sent = await callPatch(`${created.body.id}/send`);
    expect(sent.status).toBe(409);

    const row = await db.select().from(deliveries).where(eq(deliveries.id, created.body.id)).get();
    expect(row!.status).toBe("pendiente");
    expect(row!.sentDate).toBeNull();
  });

  test("Completar datos (PUT con canal real) habilita /send después", async () => {
    const policyId = await mkPolicy("completar-datos-habilita-send");
    createdPolicyIds.push(policyId);
    const created = await callQuickAdd({ policyId, documentType: "poliza" });
    createdDeliveryIds.push(created.body.id);

    const updated = await callPut(created.body.id, { channel: "whatsapp", scheduledDate: "2027-01-15", notes: "Completado en QA" });
    expect(updated.status).toBe(200);
    expect(updated.body.channel).toBe("whatsapp");

    const sent = await callPatch(`${created.body.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("enviado");
    expect(sent.body.sentDate).not.toBeNull();
  });

  test("PATCH /complete legacy sigue funcionando sin cambios: pendiente → realizado directo", async () => {
    const policyId = await mkPolicy("complete-legacy");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);

    const completed = await callPatch(`${created.body.id}/complete`);
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("realizado");
    expect(completed.body.completedDate).not.toBeNull();
  });
});

describe("GET /deliveries — joins y períodos", () => {
  test("devuelve policy (con startDate/endDate), insured, company y rebilling (con billingStart/billingEnd)", async () => {
    const policyId = await mkPolicy("get-joins");
    createdPolicyIds.push(policyId);
    const rebillingId = await mkRebilling(policyId, "2027-08-01", "2027-08-31");
    const created = await callPost({ policyId, rebillingId, documentType: "refacturacion", channel: "email" });
    createdDeliveryIds.push(created.body.id);

    const { status, body } = await callGet(`?policyId=${policyId}`);
    expect(status).toBe(200);
    const row = body.find((r: any) => r.delivery.id === created.body.id);
    expect(row).toBeDefined();
    expect(row.policy.startDate).toBe("2027-01-01");
    expect(row.policy.endDate).toBe("2027-12-31");
    expect(row.insured.id).toBe(insuredId);
    expect(row.company.id).toBe(companyId);
    expect(row.rebilling.id).toBe(rebillingId);
    expect(row.rebilling.billingStart).toBe("2027-08-01");
    expect(row.rebilling.billingEnd).toBe("2027-08-31");
  });

  test("filtro por rebillingId funciona", async () => {
    const policyId = await mkPolicy("get-filtro-reb");
    createdPolicyIds.push(policyId);
    const rebillingId = await mkRebilling(policyId);
    const created = await callPost({ policyId, rebillingId, documentType: "refacturacion", channel: "email" });
    createdDeliveryIds.push(created.body.id);

    const { body } = await callGet(`?rebillingId=${rebillingId}`);
    expect(body.every((r: any) => r.delivery.rebillingId === rebillingId)).toBe(true);
    expect(body.some((r: any) => r.delivery.id === created.body.id)).toBe(true);
  });

  test("fila manual (sin policyId) no se altera: policy/insured/company/rebilling quedan null", async () => {
    const created = await callPost({ manualPolicyNumber: "GET-MANUAL", documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);

    const { body } = await callGet();
    const row = body.find((r: any) => r.delivery.id === created.body.id);
    expect(row.delivery.manualPolicyNumber).toBe("GET-MANUAL");
    expect(row.policy).toBeNull();
    expect(row.insured).toBeNull();
    expect(row.company).toBeNull();
    expect(row.rebilling).toBeNull();
  });

  test("un registro histórico en status='realizado' sigue siendo legible por GET", async () => {
    const policyId = await mkPolicy("get-historico-realizado");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    createdDeliveryIds.push(created.body.id);
    await callPatch(`${created.body.id}/complete`);

    const { body } = await callGet(`?status=realizado`);
    const row = body.find((r: any) => r.delivery.id === created.body.id);
    expect(row).toBeDefined();
    expect(row.delivery.status).toBe("realizado");
    expect(row.delivery.rebillingId).toBeNull();
    expect(row.delivery.sentDate).toBeNull();
  });
});

describe("DELETE /rebillings/:id con seguimiento vinculado", () => {
  test("devuelve 409 claro en vez de fallo opaco de FK", async () => {
    const policyId = await mkPolicy("delete-reb-bloqueada");
    createdPolicyIds.push(policyId);
    const rebillingId = await mkRebilling(policyId);
    const created = await callPost({ policyId, rebillingId, documentType: "refacturacion", channel: "email" });
    createdDeliveryIds.push(created.body.id);

    const { status, body } = await callDeleteRebilling(rebillingId);
    expect(status).toBe(409);
    expect(body.error).toContain("Envíos y Entregas");
  });

  test("sin seguimiento vinculado, el borrado de la refacturación funciona normalmente", async () => {
    const policyId = await mkPolicy("delete-reb-libre");
    createdPolicyIds.push(policyId);
    const rebillingId = await mkRebilling(policyId);

    const { status } = await callDeleteRebilling(rebillingId);
    expect(status).toBe(200);
  });
});

describe("DELETE /deliveries/:id — sin cambios de comportamiento", () => {
  test("elimina el registro sin restricciones (hard delete, igual que antes)", async () => {
    const policyId = await mkPolicy("delete-delivery");
    createdPolicyIds.push(policyId);
    const created = await callPost({ policyId, documentType: "poliza", channel: "email" });
    const { status } = await callDeleteDelivery(created.body.id);
    expect(status).toBe(200);
  });
});
