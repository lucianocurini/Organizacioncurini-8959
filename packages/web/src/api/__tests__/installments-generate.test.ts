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

async function mkPolicy(cashPaymentAmountCents: number | null = null): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: "activa", companyId, insuredId,
    startDate: "2026-01-01", endDate: "2026-12-31", isRebilling: 0, createdBy: userId,
    cashPaymentAmountCents,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}

async function callCreatePolicy(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/policies", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) policyIdsToClean.push(json.id);
  return { status: res.status, body: json };
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

// ─── Migración 0034 — alta atómica: contado + plan en una sola transacción ─
//
// Rediseño (ronda 2): POST /policies NUNCA persiste cashPaymentAmountCents
// (no puede validarlo sin cuotas) — el importe viaja recién en el body de
// POST /policies/:id/installments/generate, junto con el plan real, y ahí
// se valida y persiste ATÓMICO con las cuotas: si el contado es inválido, o
// falla cualquier otra parte de la escritura, ni las cuotas ni el contado
// quedan persistidos — la póliza queda exactamente como estaba
// (cashPaymentAmountCents siempre NULL en ese caso, nunca un valor sin
// validar).
describe("Migración 0034 — alta atómica de contado + plan (generate)", () => {
  async function getPolicyCash(policyId: number) {
    const row = await db.select({ cashPaymentAmountCents: policies.cashPaymentAmountCents })
      .from(policies).where(eq(policies.id, policyId)).get();
    return row?.cashPaymentAmountCents ?? null;
  }

  test("POST /policies intenta mandar contado antes del plan: se ignora, queda NULL", async () => {
    const created = await callCreatePolicy({
      policyNumber: `${PREFIX}-GAP-${Date.now()}`,
      type: "automotor", status: "activa", companyId, insuredId,
      startDate: "2026-01-01", endDate: "2026-12-31", isRebilling: 0,
      cashPaymentAmountCents: 999999900, // un importe absurdo, sin ninguna cuota todavía contra la cual validar
    });
    expect(created.status).toBe(201);
    // Nunca se persiste en el alta — ni el valor absurdo ni ningún otro:
    // este endpoint no puede validarlo (no hay nominal todavía).
    expect(created.body.cashPaymentAmountCents).toBeNull();
    expect(await getPolicyCash(created.body.id)).toBeNull();
  });

  test("generate con contado mayor al nominal: rechaza, deja 0 cuotas y el contado en NULL", async () => {
    const policyId = await mkPolicy(); // sin contado (POST /policies siempre lo deja null)

    const { status, body } = await generate(policyId, {
      installments: SAMPLE_INSTALLMENTS, // 2 x $1000 = $2000 nominal
      cashPaymentAmountCents: 250000, // $2500,00 — mayor al nominal
    });
    expect(status).toBe(409);
    expect(body.error).toContain("no puede ser mayor a la suma nominal");

    const rows = await db.select({ id: policyInstallments.id }).from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();
    expect(rows.length).toBe(0); // nada quedó insertado — ni parcial ni completo

    const pol = await db.select({ installments: policies.installments }).from(policies).where(eq(policies.id, policyId)).get();
    expect(pol?.installments).toBeNull(); // policies.installments tampoco se tocó
    expect(await getPolicyCash(policyId)).toBeNull(); // el contado NUNCA quedó persistido

    // La póliza sigue existiendo, sin cuotas — inerte para cualquier cobro
    // real (assertAllInstallmentsEligibleForCashPeriod rechaza "no tiene
    // ninguna cuota"). El intento fallido no dejó nada bloqueado: un
    // reintento posterior con un plan cuyo nominal SÍ cubre el contado
    // ahora sí se acepta, atómico (cuotas + contado juntos).
    const retry = await generate(policyId, {
      installments: [
        { number: 1, dueDate: "2026-01-01", amount: 1000, notes: "" },
        { number: 2, dueDate: "2026-02-01", amount: 1000, notes: "" },
        { number: 3, dueDate: "2026-03-01", amount: 1000, notes: "" }, // nominal $3000 >= $2500 contado
      ],
      cashPaymentAmountCents: 250000,
    });
    expect(retry.status).toBe(201);
    const rowsAfterRetry = await db.select({ id: policyInstallments.id }).from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();
    expect(rowsAfterRetry.length).toBe(3);
    expect(await getPolicyCash(policyId)).toBe(250000); // recién ahora queda persistido, junto con las cuotas
  });

  test("generate con contado igual al nominal: confirma cuotas + contado atómicamente (descuento $0)", async () => {
    const policyId = await mkPolicy();
    const { status } = await generate(policyId, { installments: SAMPLE_INSTALLMENTS, cashPaymentAmountCents: 200000 }); // exactamente $2000,00
    expect(status).toBe(201);
    const rows = await db.select({ id: policyInstallments.id }).from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();
    expect(rows.length).toBe(2);
    expect(await getPolicyCash(policyId)).toBe(200000);
  });

  test("generate con contado menor al nominal: confirma cuotas + contado atómicamente (caso normal, con descuento)", async () => {
    const policyId = await mkPolicy();
    const { status } = await generate(policyId, { installments: SAMPLE_INSTALLMENTS, cashPaymentAmountCents: 150000 }); // $1500,00 < $2000,00 nominal
    expect(status).toBe(201);
    expect(await getPolicyCash(policyId)).toBe(150000);
  });

  test("sin importe contado en el body (omitido): genera las cuotas, contado queda NULL", async () => {
    const policyId = await mkPolicy();
    const { status } = await generate(policyId, { installments: SAMPLE_INSTALLMENTS }); // sin cashPaymentAmountCents
    expect(status).toBe(201);
    expect(await getPolicyCash(policyId)).toBeNull();
  });

  test("precisión de centavos: contado 1 centavo por encima del nominal real se rechaza", async () => {
    const policyId = await mkPolicy();
    const { status, body } = await generate(policyId, {
      installments: [{ number: 1, dueDate: "2026-01-01", amount: 1000, notes: "" }], // nominal exacto $1000,00
      cashPaymentAmountCents: 100001, // $1000,01
    });
    expect(status).toBe(409);
    expect(body.error).toContain("no puede ser mayor a la suma nominal");
    const rows = await db.select({ id: policyInstallments.id }).from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();
    expect(rows.length).toBe(0);
    expect(await getPolicyCash(policyId)).toBeNull();
  });

  test("precisión de centavos: contado 1 centavo por debajo del nominal real se acepta", async () => {
    const policyId = await mkPolicy();
    const { status } = await generate(policyId, {
      installments: [{ number: 1, dueDate: "2026-01-01", amount: 1000, notes: "" }], // nominal exacto $1000,00
      cashPaymentAmountCents: 99999, // $999,99
    });
    expect(status).toBe(201);
    expect(await getPolicyCash(policyId)).toBe(99999);
  });

  test("fallo durante la inserción de cuotas: rollback completo — 0 cuotas Y contado NULL, nunca uno sin el otro", async () => {
    const policyId = await mkPolicy();
    // La segunda cuota viola NOT NULL en due_date (a propósito, para forzar
    // un error real de la base de datos DENTRO de la transacción, después
    // de que la validación JS de contado-vs-nominal ya pasó) — el INSERT
    // multi-fila completo debe abortar, y con él la actualización de
    // policies (installments + cashPaymentAmountCents) que venía después en
    // la misma transacción.
    // Request cruda (no el helper `generate`): el error de DB sin capturar
    // no devuelve JSON (sin app.onError global en este proyecto — comportamiento
    // preexistente, no algo de esta etapa) — alcanza con el status code para
    // probar que la transacción abortó, sin intentar parsear el body.
    const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}/installments/generate`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        installments: [
          { number: 1, dueDate: "2026-01-01", amount: 1000, notes: "" },
          { number: 2, dueDate: null, amount: 1000, notes: "" },
        ],
        cashPaymentAmountCents: 150000, // válido contra el nominal ($2000) — el fallo es de la cuota, no del contado
      }),
    }));
    expect(res.status).toBe(500); // error real de DB, no una validación de negocio (nunca un 4xx limpio)

    const rows = await db.select({ id: policyInstallments.id }).from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();
    expect(rows.length).toBe(0); // ninguna cuota quedó — ni siquiera la primera, válida
    expect(await getPolicyCash(policyId)).toBeNull(); // el contado tampoco quedó persistido
    const pol = await db.select({ installments: policies.installments }).from(policies).where(eq(policies.id, policyId)).get();
    expect(pol?.installments).toBeNull();

    // Reintento posterior con un plan válido funciona sin rastros del fallo previo.
    const retry = await generate(policyId, { installments: SAMPLE_INSTALLMENTS, cashPaymentAmountCents: 150000 });
    expect(retry.status).toBe(201);
    expect(await getPolicyCash(policyId)).toBe(150000);
  });

  test("PUT /policies/:id directo: rechaza cargar un contado no nulo mientras la póliza no tiene cuotas", async () => {
    const policyId = await mkPolicy(); // sin cuotas
    const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}`, {
      method: "PUT", headers: authHeaders(), body: JSON.stringify({ cashPaymentAmountCents: 100000 }),
    }));
    expect(res.status).toBe(409);
    expect(await getPolicyCash(policyId)).toBeNull();
  });

  test("PUT /policies/:id directo: retirar (null) sigue permitido sin cuotas — no hay nada que validar", async () => {
    const policyId = await mkPolicy(); // ya es null
    const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}`, {
      method: "PUT", headers: authHeaders(), body: JSON.stringify({ cashPaymentAmountCents: null }),
    }));
    expect(res.status).toBe(200);
    expect(await getPolicyCash(policyId)).toBeNull();
  });

  test("PUT /policies/:id directo: una vez generadas las cuotas, sí puede cargar un contado válido (camino normal)", async () => {
    const policyId = await mkPolicy();
    await generate(policyId, { installments: SAMPLE_INSTALLMENTS }); // nominal $2000, sin contado
    const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}`, {
      method: "PUT", headers: authHeaders(), body: JSON.stringify({ cashPaymentAmountCents: 180000 }),
    }));
    expect(res.status).toBe(200);
    expect(await getPolicyCash(policyId)).toBe(180000);
  });
});
