/**
 * Tests de API para policies.vigency_period="mensual" (tolerancia LEGACY) y
 * policies.billing_cycle="mensual" (caso normal) — regresión del bug
 * reportado: "el sistema no permite poner/editar una póliza con
 * refacturación mensual".
 *
 * Causa raíz real: el importador de Mercantil Andina (resolveVigencyPeriod
 * en src/api/index.ts) confundía "el tramo importado dura ~1 mes" con
 * "vigencia contractual de 1 mes", y asignaba vigencyPeriod="mensual" — pero
 * NO hay pólizas de vigencia real de 1 mes (confirmado): ese tramo de 1 mes
 * es casi siempre una refacturación mensual (la compañía emite de a 1 cuota
 * por mes), no la vigencia del contrato completo. 15 pólizas de dev.db ya
 * quedaron mal clasificadas así.
 *
 * Ajuste sobre el fix anterior: vigencyPeriod="mensual" YA NO es una opción
 * normal — el <select> de PolicyModal.tsx no la ofrece, y el caso correcto
 * de "refactura mes a mes" es vigencyPeriod="anual" + billingCycle="mensual"
 * + installments=1 (ver tests de "caso correcto" más abajo). Pero el backend
 * SIGUE aceptando vigencyPeriod="mensual" como tolerancia legacy pura — sin
 * eso, las 15 pólizas ya importadas quedarían de nuevo imposibles de editar
 * (el formulario reenvía el vigencyPeriod completo en cada guardado, lo haya
 * tocado el usuario o no).
 *
 * billing_cycle="mensual" (frecuencia de refacturación real, tabla
 * rebillings) nunca estuvo bloqueado — se agregan tests de regresión igual,
 * para dejar cubiertos ambos campos.
 *
 * Corre contra dev.db local (nunca Turso), mismo estilo que
 * policies-next-rebilling-date.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import { users, sessions, policies, companies, insureds } from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const SESSION_ID = "test-session-vigency-period-001";
const USER_EMAIL = "test-vigency-period@test.local";
const PREFIX = "TEST-VIGENCY";

let userId: number;
let companyId: number;
let insuredId: number;
const policyIdsToClean: number[] = [];

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function postPolicy(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/policies", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) policyIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function putPolicy(id: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/policies/${id}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
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
    name: "Test Vigency Period", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
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

describe("POST /policies — vigencyPeriod='mensual' (tolerancia legacy, no es el camino normal)", () => {
  test("acepta vigencyPeriod='mensual' por compatibilidad con datos ya importados", async () => {
    const { status, body } = await postPolicy(basePolicyBody({
      vigencyPeriod: "mensual", startDate: "2026-05-21", endDate: "2026-06-21",
    }));
    expect(status).toBe(201);
    expect(body.vigencyPeriod).toBe("mensual");
  });

  test("sigue rechazando un valor realmente inválido (nunca ofrecido en el <select>)", async () => {
    const { status, body } = await postPolicy(basePolicyBody({ vigencyPeriod: "bimestral" }));
    expect(status).toBe(400);
    expect(body.error).toContain("inválido");
  });
});

describe("POST/PUT /policies — anual/semestral/cuatrimestral siguen funcionando (regresión)", () => {
  for (const period of ["anual", "semestral", "cuatrimestral"]) {
    test(`POST acepta vigencyPeriod='${period}'`, async () => {
      const { status, body } = await postPolicy(basePolicyBody({ vigencyPeriod: period }));
      expect(status).toBe(201);
      expect(body.vigencyPeriod).toBe(period);
    });
  }
});

describe("PUT /policies/:id — reproduce el bug reportado y confirma el fix", () => {
  test("una póliza YA existente con vigencyPeriod='mensual' (como las importadas de Mercantil Andina) se puede volver a guardar", async () => {
    // Simula exactamente el estado real encontrado en producción/dev.db:
    // pólizas importadas con un período de ~1 mes quedan con vigencyPeriod='mensual'.
    const created = await postPolicy(basePolicyBody({
      vigencyPeriod: "mensual", startDate: "2026-05-21", endDate: "2026-06-21",
      notes: "Importado de Mercantil Andina. Sec: 5",
    }));
    expect(created.status).toBe(201);

    // PolicyModal.tsx reenvía el formulario COMPLETO en cada guardado (nunca
    // un PATCH parcial) — este PUT reproduce eso: vigencyPeriod sigue siendo
    // "mensual" (el usuario no tocó ese campo), solo cambian las notas. Antes
    // del fix, esto fallaba con 400 "Período de vigencia inválido: mensual"
    // sin importar qué campo se quisiera cambiar.
    const { status, body } = await putPolicy(created.body.id, {
      ...basePolicyBody({ vigencyPeriod: "mensual", startDate: "2026-05-21", endDate: "2026-06-21" }),
      notes: "nota actualizada por el usuario",
    });
    expect(status).toBe(200);
    expect(body.vigencyPeriod).toBe("mensual");
    expect(body.notes).toBe("nota actualizada por el usuario");
  });

  test("el backend tolera pasar vigencyPeriod de 'anual' a 'mensual' vía PUT (tolerancia legacy — la UI ya no ofrece esta opción normalmente)", async () => {
    const created = await postPolicy(basePolicyBody({ vigencyPeriod: "anual" }));
    expect(created.status).toBe(201);

    const { status, body } = await putPolicy(created.body.id, { vigencyPeriod: "mensual" });
    expect(status).toBe(200);
    expect(body.vigencyPeriod).toBe("mensual");
  });

  test("PUT sigue rechazando un vigencyPeriod inválido y no pisa el valor existente", async () => {
    const created = await postPolicy(basePolicyBody({ vigencyPeriod: "mensual" }));
    const { status, body } = await putPolicy(created.body.id, { vigencyPeriod: "bimestral" });
    expect(status).toBe(400);
    expect(body.error).toContain("inválido");

    const row = await db.select({ vigencyPeriod: policies.vigencyPeriod }).from(policies).where(eq(policies.id, created.body.id)).get();
    expect(row?.vigencyPeriod).toBe("mensual");
  });
});

describe("billingCycle='mensual' (frecuencia de refacturación real) — regresión, nunca estuvo bloqueado", () => {
  test("POST acepta billingCycle='mensual'", async () => {
    const { status, body } = await postPolicy(basePolicyBody({ billingCycle: "mensual" }));
    expect(status).toBe(201);
    expect(body.billingCycle).toBe("mensual");
  });

  test("PUT acepta billingCycle='mensual' sobre una póliza existente", async () => {
    const created = await postPolicy(basePolicyBody());
    const { status, body } = await putPolicy(created.body.id, { billingCycle: "mensual" });
    expect(status).toBe(200);
    expect(body.billingCycle).toBe("mensual");
  });

  for (const cycle of ["trimestral", "cuatrimestral", "semestral"]) {
    test(`billingCycle='${cycle}' sigue funcionando (regresión)`, async () => {
      const { status, body } = await postPolicy(basePolicyBody({ billingCycle: cycle }));
      expect(status).toBe(201);
      expect(body.billingCycle).toBe(cycle);
    });
  }
});

describe("Caso CORRECTO de refacturación mensual (Sancor/Mercantil Andina — la compañía emite de a 1 cuota por mes)", () => {
  test("vigencyPeriod='anual' + billingCycle='mensual' + installments=1 se guarda correctamente", async () => {
    const { status, body } = await postPolicy(basePolicyBody({
      vigencyPeriod: "anual",
      billingCycle: "mensual",
      installments: 1,
      nextRebillingDate: "2026-07-21",
    }));
    expect(status).toBe(201);
    expect(body.vigencyPeriod).toBe("anual");
    expect(body.billingCycle).toBe("mensual");
    expect(body.installments).toBe(1);
    expect(body.nextRebillingDate).toBe("2026-07-21");
  });

  test("editar una póliza al caso correcto (vigencyPeriod se mantiene anual, solo cambia billingCycle) funciona", async () => {
    const created = await postPolicy(basePolicyBody({ vigencyPeriod: "anual" }));
    expect(created.status).toBe(201);

    const { status, body } = await putPolicy(created.body.id, { billingCycle: "mensual", installments: 1 });
    expect(status).toBe(200);
    expect(body.vigencyPeriod).toBe("anual");
    expect(body.billingCycle).toBe("mensual");
    expect(body.installments).toBe(1);
  });
});
