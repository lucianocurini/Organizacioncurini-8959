/**
 * GET /reports/renewals-rebillings — próxima refacturación con la regla
 * central (lib/policies/next-rebilling.ts): fecha segura proyectada (períodos
 * leídos por su forma matemática, nunca por las notas) y cola global
 * "A revisar" (solo con el mes actual; los meses futuros informan su tamaño).
 * Fixtures sintéticos con fechas relativas al mes actual de Argentina.
 * Corre contra la SQLite local de test, nunca Turso.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import { users, sessions, policies, rebillings, companies, insureds } from "../database/schema";
import { eq, inArray } from "drizzle-orm";
import { shiftArgentinaMonth, addCalendarDays } from "../../lib/dates/argentina-date";

const SESSION_ID = "test-session-reports-next-reb-001";
const USER_EMAIL = "test-reports-next-reb@test.local";
const PREFIX = "TEST-RNR";

let userId: number;
let insuredId: number;
let companyId: number;
let otherCompanyId: number;
const policyIdsToClean: number[] = [];

const d = (k: number, day = "01") => `${shiftArgentinaMonth(k)}-${day}`;
const F = shiftArgentinaMonth(1);
const CURRENT = shiftArgentinaMonth(0);
const PAST = shiftArgentinaMonth(-1);

async function callReport(month: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams({ month, companyId: String(companyId), ...params });
  const res = await app.fetch(new Request(`http://localhost/api/reports/renewals-rebillings?${qs}`, {
    headers: { "x-session-id": SESSION_ID },
  }));
  expect(res.status).toBe(200);
  return res.json() as Promise<any>;
}

async function mkPolicy(num: string, over: Partial<typeof policies.$inferInsert>): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${num}`, type: "automotor", status: "activa", companyId, insuredId,
    startDate: d(-6), endDate: d(9), billingCycle: "trimestral", nextRebillingDate: null,
    isRebilling: 0, createdBy: userId, ...over,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}
async function mkReb(policyId: number, billingStart: string, billingEnd: string, notes: string | null) {
  await db.insert(rebillings).values({ policyId, billingStart, billingEnd, premium: 1000, notes, createdBy: userId });
}

const ids: Record<string, number> = {};

beforeAll(async () => {
  const prev = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prev) {
    const prevPols = (await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prev.id)).all()).map((p) => p.id);
    if (prevPols.length) {
      await db.delete(rebillings).where(inArray(rebillings.policyId, prevPols)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, prevPols)).catch(() => {});
    }
    await db.delete(insureds).where(eq(insureds.createdBy, prev.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prev.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prev.id)).catch(() => {});
  }
  const [u] = await db.insert(users).values({ name: "Test RNR", email: USER_EMAIL, password: "x", role: "admin", active: 1 })
    .returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });
  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado Sintético`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
  const getCo = async (name: string) =>
    (await db.select({ id: companies.id }).from(companies).where(eq(companies.name, name)).get())?.id
    ?? (await db.insert(companies).values({ name }).returning({ id: companies.id }))[0]!.id;
  companyId = await getCo(`${PREFIX} Compañía`);
  otherCompanyId = await getCo(`${PREFIX} Otra`);

  // El Norte, caso sintético B: guardada = inicio del período (consumida),
  // período cuatrimestral con fin = inicio siguiente → mes F, segura.
  ids.elNorte = await mkPolicy("EN", { billingCycle: "cuatrimestral", nextRebillingDate: d(-3), endDate: d(9) });
  await mkReb(ids.elNorte, d(-3), d(1), "Importado de El Norte v2. Prórroga endoso 1");

  // Rivadavia, caso sintético A: trimestral con fin = inicio siguiente →
  // mes F, segura (las notas no cambian la lectura).
  ids.rivadavia = await mkPolicy("RIV", { billingCycle: "trimestral", nextRebillingDate: d(-2), endDate: d(4) });
  await mkReb(ids.rivadavia, d(-2), d(1), "Prórroga");

  // Sin fecha segura: guardada vencida y sin refacturaciones.
  ids.reviewVencida = await mkPolicy("REV-VENC", { billingCycle: "trimestral", nextRebillingDate: d(-1, "15") });

  // Sin fecha segura: período irregular.
  ids.reviewIrregular = await mkPolicy("REV-IRR", { billingCycle: "trimestral" });
  await mkReb(ids.reviewIrregular, d(-2), d(1, "20"), null);

  // Sin fecha segura: último período cargado por adelantado (empieza en F).
  ids.reviewFuture = await mkPolicy("REV-FUT", { billingCycle: "trimestral", endDate: d(10) });
  await mkReb(ids.reviewFuture, d(-2), d(1), null);
  await mkReb(ids.reviewFuture, d(1), addCalendarDays(d(4), -1), null);

  // Refacturación futura ya cargada cuya fecha guardada es su propio inicio
  // (fecha explícita vigente en F): debe verse UNA sola vez, como fila real.
  ids.futureWithDate = await mkPolicy("FUT-FECHA", { billingCycle: "trimestral", nextRebillingDate: d(1), endDate: d(10) });
  await mkReb(ids.futureWithDate, d(-2), d(1), null);
  await mkReb(ids.futureWithDate, d(1), addCalendarDays(d(4), -1), null);

  // Coincide con la renovación: fin de período importado = fin de vigencia en F.
  ids.renewal = await mkPolicy("REN", { billingCycle: "cuatrimestral", nextRebillingDate: d(-3), endDate: d(1) });
  await mkReb(ids.renewal, d(-3), d(1), "Importado de El Norte v2. Prórroga endoso 2");

  // No vigente: mismo caso que El Norte pero vencida → en ningún lado.
  ids.noVigente = await mkPolicy("NOVIG", { status: "vencida", billingCycle: "cuatrimestral", nextRebillingDate: d(-3) });
  await mkReb(ids.noVigente, d(-3), d(1), "Importado de El Norte v2. Prórroga endoso 3");

  // Otra compañía: no debe aparecer con filtro de compañía.
  ids.otherCompany = await mkPolicy("OTRA", { companyId: otherCompanyId, billingCycle: "trimestral", nextRebillingDate: d(-1, "15") });
});

afterAll(async () => {
  if (policyIdsToClean.length) {
    await db.delete(rebillings).where(inArray(rebillings.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  await db.delete(insureds).where(eq(insureds.createdBy, userId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

const ours = (rows: any[]) => rows.filter((r) => policyIdsToClean.includes(r.policyId));
const QUEUE = () => [ids.reviewVencida!, ids.reviewIrregular!, ids.reviewFuture!].sort((a, b) => a - b);

describe("mes futuro F", () => {
  test("El Norte (caso sintético B) aparece en F como refacturación proyectada con fecha segura", async () => {
    const body = await callReport(F);
    const row = body.rebillings.find((r: any) => r.policyId === ids.elNorte);
    expect(row).toMatchObject({ projected: true, billingStart: d(1), billingEnd: null });
  });

  test("Rivadavia (caso sintético A) aparece en F normalmente, el 01 del mes", async () => {
    const body = await callReport(F);
    const row = body.rebillings.find((r: any) => r.policyId === ids.rivadavia);
    expect(row).toMatchObject({ projected: true, billingStart: d(1), billingEnd: null });
  });

  test("la cola 'A revisar' no se repite en el mes futuro: solo se informa su tamaño, fuera de totals", async () => {
    const body = await callReport(F);
    expect(body.rebillingReview).toEqual([]);
    expect(body.rebillingReviewQueueCount).toBe(3);
    expect(Object.keys(body.totals).filter((k) => /review/i.test(k))).toEqual([]);
    const projected = body.rebillings.filter((r: any) => r.projected).map((r: any) => r.policyId);
    for (const id of QUEUE()) expect(projected).not.toContain(id);
  });

  test("refacturación futura ya cargada: una sola fila real en su mes, sin proyección ni doble conteo", async () => {
    const body = await callReport(F);
    const rows = body.rebillings.filter((r: any) => r.policyId === ids.reviewFuture);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projected: false, billingStart: d(1), billingEnd: addCalendarDays(d(4), -1) });
    // Ningún otro movimiento del mes para la misma póliza ni la misma fecha.
    expect([...body.renovationsConfirmed, ...body.renovationsImported, ...body.newPolicies].some((r: any) => r.policyId === ids.reviewFuture)).toBe(false);
    // Totales = filas visibles (la cola global no se suma).
    expect(body.totals.rebillingsCount).toBe(body.rebillings.length);
    expect(body.totals.totalMovements).toBe(
      body.rebillings.length + body.renovationsConfirmed.length + body.renovationsImported.length + body.newPolicies.length,
    );
    // Con fecha guardada igual a su inicio (que sí se proyectaría): igual una sola fila, la real.
    const withDate = body.rebillings.filter((r: any) => r.policyId === ids.futureWithDate);
    expect(withDate.map((r: any) => [r.projected, r.billingStart])).toEqual([[false, d(1)]]);
    // El período que sigue a esa refacturación (F+3) tampoco se proyecta.
    const after = await callReport(shiftArgentinaMonth(4));
    expect(after.rebillings.some((r: any) => r.policyId === ids.reviewFuture)).toBe(false);
  });

  test("coincide con la renovación → solo como renovación proyectada, sin duplicar", async () => {
    const body = await callReport(F);
    expect(body.renovationsConfirmed.some((r: any) => r.policyId === ids.renewal && r.projected)).toBe(true);
    expect(body.rebillings.some((r: any) => r.policyId === ids.renewal)).toBe(false);
  });

  test("póliza no vigente y otra compañía no aparecen", async () => {
    const body = await callReport(F);
    const all = [...body.rebillings, ...body.renovationsConfirmed].map((r: any) => r.policyId);
    expect(all).not.toContain(ids.noVigente);
    expect(all).not.toContain(ids.otherCompany);
  });

  test("el mes siguiente a F no repite las proyecciones de F", async () => {
    const body = await callReport(shiftArgentinaMonth(2));
    expect(body.rebillings.some((r: any) => r.policyId === ids.elNorte || r.policyId === ids.rivadavia)).toBe(false);
  });
});

describe("mes actual: cola global 'A revisar'", () => {
  test("lista la cola con su motivo, una sola vez, y no proyecta", async () => {
    const body = await callReport(CURRENT);
    expect(body.isFutureMonth).toBe(false);
    expect(body.rebillings.some((r: any) => r.projected)).toBe(false);
    const review = ours(body.rebillingReview);
    expect(review.map((r: any) => r.policyId).sort((a: number, b: number) => a - b)).toEqual(QUEUE());
    expect(body.rebillingReviewQueueCount).toBe(body.rebillingReview.length);
    expect(Object.keys(body.totals).filter((k) => /review/i.test(k))).toEqual([]);
    expect(body.totals.totalMovements).toBe(
      body.rebillings.length + body.renovationsConfirmed.length + body.renovationsImported.length + body.newPolicies.length,
    );
    const byId = (id: number) => review.find((r: any) => r.policyId === id);
    expect(byId(ids.reviewVencida!)).toMatchObject({ reviewReason: "sin_refacturaciones", nextRebillingDate: d(-1, "15") });
    expect(byId(ids.reviewVencida!).reviewReasonLabel).toContain("Próxima refacturación guardada vencida");
    expect(byId(ids.reviewIrregular!).reviewReason).toBe("periodo_irregular");
    expect(byId(ids.reviewFuture!).reviewReason).toBe("periodo_futuro_ya_cargado");
    // El motivo deja claro que la revisión es del evento siguiente, no de la refacturación ya cargada.
    expect(byId(ids.reviewFuture!).reviewReasonLabel).toBe(
      `Ya hay una refacturación cargada que empieza el ${d(1).slice(8, 10)}/${d(1).slice(5, 7)}/${d(1).slice(0, 4)}; lo que falta definir es la siguiente, posterior a ese período`,
    );
    const elsewhere = new Set(ours([...body.rebillings, ...body.renovationsConfirmed]).map((r: any) => r.policyId));
    for (const id of QUEUE()) expect(elsewhere.has(id)).toBe(false);
  });

  test("mes pasado: sin cola ni contador", async () => {
    const body = await callReport(PAST);
    expect(body.rebillingReview).toEqual([]);
    expect(body.rebillingReviewQueueCount).toBe(0);
  });
});

describe("filtros sobre la cola 'A revisar'", () => {
  test("movimiento distinto de refacturación → vacía", async () => {
    const body = await callReport(CURRENT, { movementType: "new_policy" });
    expect(body.rebillingReview).toEqual([]);
    expect(body.rebillingReviewQueueCount).toBe(0);
  });
  test("movimiento = refacturación → se mantiene", async () => {
    expect(ours((await callReport(CURRENT, { movementType: "rebilling" })).rebillingReview).length).toBe(3);
  });
  test("filtro de subtipo → vacía (como las proyectadas)", async () => {
    expect((await callReport(CURRENT, { rebillingType: "prorroga" })).rebillingReview).toEqual([]);
  });
  test("búsqueda por número de póliza", async () => {
    const body = await callReport(CURRENT, { q: `${PREFIX}-REV-VENC` });
    expect(body.rebillingReview.map((r: any) => r.policyId)).toEqual([ids.reviewVencida]);
  });
  test("filtro de otra compañía", async () => {
    const body = await callReport(CURRENT, { companyId: String(otherCompanyId) });
    expect(body.rebillingReview.map((r: any) => r.policyId)).toEqual([ids.otherCompany]);
  });
});
