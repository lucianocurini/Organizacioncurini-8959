/**
 * Estado efectivo (lib/policies/effective-status.ts) y vínculos de accesorias
 * (lib/policies/accessory-link.ts) en GET /reports/renewals-rebillings,
 * GET /policies, GET /policies/:id y GET /stats.
 *  - Vencida por fecha final (aunque guardada activa/por_vencer) no entra en
 *    proyecciones ni colas; cancelada/renovada nunca.
 *  - Accesoria con vínculo válido: sin fila propia en proyecciones/colas; la
 *    renovación agrupada cuenta un movimiento con prima principal +
 *    accesorias una sola vez. Sus movimientos reales y cuotas siguen visibles.
 *  - Vínculo inválido → solo "Vínculos a revisar" (nunca también "A revisar").
 * Fixtures sintéticos con fechas relativas al día de Argentina. Corre contra
 * la SQLite local de test, nunca Turso.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import { users, sessions, policies, rebillings, companies, insureds, policyInstallments } from "../database/schema";
import { eq, inArray } from "drizzle-orm";
import { shiftArgentinaMonth, addCalendarDays, toArgentinaCalendarDay } from "../../lib/dates/argentina-date";

const SESSION_ID = "test-session-reports-eff-acc-001";
const USER_EMAIL = "test-reports-eff-acc@test.local";
const PREFIX = "TEST-EFA";

let userId: number;
let insuredId: number;
let otherInsuredId: number;
let companyId: number;
let otherCompanyId: number;
const policyIdsToClean: number[] = [];

const TODAY = toArgentinaCalendarDay();
const YESTERDAY = addCalendarDays(TODAY, -1);
const d = (k: number, day = "01") => `${shiftArgentinaMonth(k)}-${day}`;
const CURRENT = shiftArgentinaMonth(0);
const PAST = shiftArgentinaMonth(-1);
const REN = shiftArgentinaMonth(3); // mes de la renovación proyectada del grupo
const REN_END = `${REN}-15`;

function headers() { return { "x-session-id": SESSION_ID }; }
async function get(path: string) {
  const res = await app.fetch(new Request(`http://localhost/api${path}`, { headers: headers() }));
  expect(res.status).toBe(200);
  return res.json() as Promise<any>;
}
const callReport = (month: string, params: Record<string, string> = {}) =>
  get(`/reports/renewals-rebillings?${new URLSearchParams({ month, companyId: String(companyId), ...params })}`);

async function mkPolicy(num: string, over: Partial<typeof policies.$inferInsert>): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${num}`, type: "automotor", status: "activa", companyId, insuredId,
    startDate: d(-9), endDate: REN_END, billingCycle: "trimestral", nextRebillingDate: null, premium: 0,
    isRebilling: 0, createdBy: userId, ...over,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}
const acc = (num: string, parentPolicyId: number | null, over: Partial<typeof policies.$inferInsert> = {}) =>
  mkPolicy(num, { type: "accidentes_pasajeros", parentPolicyId, startDate: d(-3), ...over });

const ids: Record<string, number> = {};
const PREMIUM: Record<string, number> = {};

beforeAll(async () => {
  const prev = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prev) {
    const prevPols = (await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prev.id)).all()).map((p) => p.id);
    if (prevPols.length) {
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, prevPols)).catch(() => {});
      await db.delete(rebillings).where(inArray(rebillings.policyId, prevPols)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, prevPols)).catch(() => {});
    }
    await db.delete(insureds).where(eq(insureds.createdBy, prev.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prev.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prev.id)).catch(() => {});
  }
  const [u] = await db.insert(users).values({ name: "Test EFA", email: USER_EMAIL, password: "x", role: "admin", active: 1 })
    .returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });
  const mkIns = async (name: string) => (await db.insert(insureds).values({ name, createdBy: userId }).returning({ id: insureds.id }))[0]!.id;
  insuredId = await mkIns(`${PREFIX} Asegurado Sintético`);
  otherInsuredId = await mkIns(`${PREFIX} Otro Asegurado Sintético`);
  const getCo = async (name: string) =>
    (await db.select({ id: companies.id }).from(companies).where(eq(companies.name, name)).get())?.id
    ?? (await db.insert(companies).values({ name }).returning({ id: companies.id }))[0]!.id;
  companyId = await getCo(`${PREFIX} Compañía`);
  otherCompanyId = await getCo(`${PREFIX} Otra`);

  const P = async (key: string, premium: number, fn: () => Promise<number>) => { PREMIUM[key] = premium; ids[key] = await fn(); };

  // Principal vigente sin fecha segura (trimestral sin refacturaciones) → "A revisar".
  await P("principal", 1000, () => mkPolicy("PRINC", { premium: 1000 }));
  // Accesoria válida (inicio distinto, mismo fin): sigue a la principal.
  await P("accValida", 150.25, () => acc("ACC-OK", ids.principal!, { premium: 150.25 }));
  // Movimiento real y cuota propia de la accesoria válida: siguen visibles.
  await db.insert(rebillings).values({ policyId: ids.accValida!, billingStart: `${CURRENT}-05`, billingEnd: `${shiftArgentinaMonth(3)}-05`, premium: 75, notes: null, createdBy: userId });
  await db.insert(policyInstallments).values({ policyId: ids.accValida!, number: 1, dueDate: `${CURRENT}-10`, amount: 40, status: "pendiente" });

  // Principales auxiliares para los motivos inválidos.
  await P("principalOtraCia", 300, () => mkPolicy("PRINC-OTRA-CIA", { companyId: otherCompanyId, premium: 300 }));
  await P("principalCancelada", 0, () => mkPolicy("PRINC-CANC", { status: "cancelada" }));

  // Una accesoria por cada motivo inválido (todas vigentes y "revisables" por sí solas).
  await P("invInexistente", 11, () => acc("INV-INEX", 999_999_999, { premium: 11 }));
  await P("invOtraCia", 12, () => acc("INV-CIA", ids.principalOtraCia!, { premium: 12 }));
  await P("invOtroAseg", 13, () => acc("INV-ASEG", ids.principal!, { insuredId: otherInsuredId, premium: 13 }));
  await P("invNoVigente", 14, () => acc("INV-NOVIG", ids.principalCancelada!, { premium: 14 }));
  await P("invFecha", 15, () => acc("INV-FECHA", ids.principal!, { endDate: `${REN}-20`, premium: 15 }));
  await P("invCadena", 16, () => acc("INV-CADENA", ids.accValida!, { premium: 16 }));
  await P("invSelf", 17, () => acc("INV-SELF", null, { premium: 17 }));
  await db.update(policies).set({ parentPolicyId: ids.invSelf! }).where(eq(policies.id, ids.invSelf!));

  // Estado efectivo.
  ids.vencidaGuardadaActiva = await mkPolicy("VENC-ACT", { status: "activa", endDate: YESTERDAY });
  ids.vencidaGuardadaPorVencer = await mkPolicy("VENC-PV", { status: "por_vencer", endDate: YESTERDAY });
  ids.vencidaGuardadaFinFuturo = await mkPolicy("VENC-FUT", { status: "vencida", endDate: d(7) });
  ids.finHoy = await mkPolicy("FIN-HOY", { status: "activa", endDate: TODAY });
  ids.canceladaFinFuturo = await mkPolicy("CANC-FUT", { status: "cancelada", endDate: d(7) });
  ids.renovadaFinFuturo = await mkPolicy("RENOV-FUT", { status: "renovada", endDate: d(7) });
  // Accesoria vencida por fecha con vínculo inválido: fuera de ambas colas.
  ids.accVencidaInvalida = await acc("ACC-VENC-INV", 999_999_998, { endDate: YESTERDAY });
});

afterAll(async () => {
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(rebillings).where(inArray(rebillings.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  await db.delete(insureds).where(eq(insureds.createdBy, userId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

const ours = (rows: any[]) => rows.filter((r) => policyIdsToClean.includes(r.policyId));
const idSet = (rows: any[]) => new Set(ours(rows).map((r: any) => r.policyId));
const INVALID_IN_COMPANY = () => ({
  [ids.invInexistente!]: "principal_inexistente",
  [ids.invOtraCia!]: "otra_compania",
  [ids.invOtroAseg!]: "otro_asegurado",
  [ids.invNoVigente!]: "principal_no_vigente",
  [ids.invFecha!]: "distinta_fecha_final",
  [ids.invCadena!]: "principal_es_accesoria",
  [ids.invSelf!]: "vinculo_a_si_misma",
});

describe("mes actual: cola combinada sin doble clasificación", () => {
  test("'A revisar' = principal (con +1 accesoria) y la vencida guardada con fin futuro; nada vencido por fecha", async () => {
    const body = await callReport(CURRENT);
    const review = ours(body.rebillingReview);
    expect(review.map((r: any) => r.policyId).sort((a: number, b: number) => a - b))
      .toEqual([ids.principal!, ids.vencidaGuardadaFinFuturo!, ids.finHoy!].sort((a, b) => a - b));
    expect(review.find((r: any) => r.policyId === ids.principal)).toMatchObject({ accessoryCount: 1, reviewReason: "sin_refacturaciones" });
    for (const id of [ids.vencidaGuardadaActiva, ids.vencidaGuardadaPorVencer, ids.canceladaFinFuturo, ids.renovadaFinFuturo, ids.accValida]) {
      expect(review.some((r: any) => r.policyId === id)).toBe(false);
    }
  });

  test("'Vínculos a revisar' = una por motivo inválido, con su motivo; disjunta de 'A revisar'", async () => {
    const body = await callReport(CURRENT);
    const links = ours(body.linkReview);
    const expected = INVALID_IN_COMPANY();
    expect(Object.fromEntries(links.map((r: any) => [r.policyId, r.linkReason]))).toEqual(expected);
    for (const r of links) expect(r.linkReasonLabel).toBeTruthy();
    expect(links.find((r: any) => r.policyId === ids.invOtroAseg)!.parentPolicyNumber).toBe(`${PREFIX}-PRINC`);
    expect(links.find((r: any) => r.policyId === ids.invInexistente)!.parentPolicyNumber).toBeNull();
    const review = idSet(body.rebillingReview);
    for (const r of links) expect(review.has(r.policyId)).toBe(false);
    // Accesoria vencida por fecha: en ninguna cola.
    expect(idSet(body.linkReview).has(ids.accVencidaInvalida!)).toBe(false);
    expect(body.linkReviewQueueCount).toBe(body.linkReview.length);
    expect(Object.keys(body.totals).filter((k) => /link|review/i.test(k))).toEqual([]);
  });

  test("movimiento real y cuota pendiente de la accesoria válida siguen visibles", async () => {
    const body = await callReport(CURRENT);
    const real = ours(body.rebillings).filter((r: any) => r.policyId === ids.accValida);
    expect(real.map((r: any) => [r.projected, r.billingStart, r.premium])).toEqual([[false, `${CURRENT}-05`, 75]]);
    const pending = ours(body.pendingInstallments).filter((r: any) => r.policyId === ids.accValida);
    // (status pendiente o vencida según el día: la ficha marca vencidas al abrirse.)
    expect(pending.map((r: any) => [r.dueDate, r.amount])).toEqual([[`${CURRENT}-10`, 40]]);
    // Y ninguna escritura: el status guardado de la vencida sigue igual.
    const row = await db.select({ status: policies.status }).from(policies).where(eq(policies.id, ids.vencidaGuardadaActiva!)).get();
    expect(row!.status).toBe("activa");
  });

  test("filtro de ramo: se aplica a la fila resultante (principal para el grupo)", async () => {
    const auto = await callReport(CURRENT, { type: "automotor" });
    expect(ours(auto.rebillingReview).find((r: any) => r.policyId === ids.principal)).toMatchObject({ accessoryCount: 1 });
    expect(ours(auto.linkReview)).toEqual([]);
    const ap = await callReport(CURRENT, { type: "accidentes_pasajeros" });
    expect(ours(ap.rebillingReview)).toEqual([]);
    expect(ours(ap.linkReview).length).toBe(Object.keys(INVALID_IN_COMPANY()).length);
    // El movimiento real de la accesoria sigue con su propio ramo.
    expect(ours(ap.rebillings).some((r: any) => r.policyId === ids.accValida && !r.projected)).toBe(true);
  });

  test("filtros de movimiento/subtipo excluyen 'Vínculos a revisar'; búsqueda aplica", async () => {
    const params: Record<string, string>[] = [{ movementType: "rebilling" }, { movementType: "new_policy" }, { rebillingType: "prorroga" }];
    for (const p of params) {
      const body = await callReport(CURRENT, p);
      expect(body.linkReview).toEqual([]);
      expect(body.linkReviewQueueCount).toBe(0);
    }
    const q = await callReport(CURRENT, { q: `${PREFIX}-INV-FECHA` });
    expect(q.linkReview.map((r: any) => r.policyId)).toEqual([ids.invFecha]);
  });
});

describe("meses futuro y pasado", () => {
  test("mes futuro: las colas no se repiten, solo su tamaño", async () => {
    const body = await callReport(shiftArgentinaMonth(1));
    expect(body.linkReview).toEqual([]);
    expect(body.rebillingReview).toEqual([]);
    const current = await callReport(CURRENT);
    expect(body.linkReviewQueueCount).toBe(current.linkReviewQueueCount);
    expect(body.rebillingReviewQueueCount).toBe(current.rebillingReviewQueueCount);
  });
  test("mes pasado: sin colas ni contadores", async () => {
    const body = await callReport(PAST);
    expect(body.linkReview).toEqual([]);
    expect(body.linkReviewQueueCount).toBe(0);
  });
});

describe("renovación proyectada agrupada", () => {
  test("principal + accesoria válida = un movimiento con prima sumada una sola vez", async () => {
    const body = await callReport(REN);
    const conf = ours(body.renovationsConfirmed);
    const principalRows = conf.filter((r: any) => r.policyId === ids.principal);
    expect(principalRows).toHaveLength(1);
    expect(principalRows[0]).toMatchObject({ projected: true, accessoryCount: 1, premium: PREMIUM.principal! + PREMIUM.accValida! });
    expect(conf.some((r: any) => r.policyId === ids.accValida)).toBe(false);
    // Las inválidas con fin en el mes proyectan su propia fila.
    for (const k of ["invInexistente", "invOtraCia", "invOtroAseg", "invNoVigente", "invFecha", "invCadena", "invSelf"]) {
      const rows = conf.filter((r: any) => r.policyId === ids[k]);
      expect(rows.map((r: any) => [r.premium, r.accessoryCount])).toEqual([[PREMIUM[k], 0]]);
    }
    // Total de renovaciones: cada prima exactamente una vez; cancelada fuera.
    const expectedKeys = ["principal", "accValida", "invInexistente", "invOtraCia", "invOtroAseg", "invNoVigente", "invFecha", "invCadena", "invSelf"];
    const sumOurs = conf.reduce((s: number, r: any) => s + (r.premium ?? 0), 0);
    expect(Math.round(sumOurs * 100) / 100).toBe(Math.round(expectedKeys.reduce((s, k) => s + PREMIUM[k]!, 0) * 100) / 100);
    expect(conf).toHaveLength(expectedKeys.length - 1);
    expect(conf.some((r: any) => r.policyId === ids.principalCancelada)).toBe(false);
    expect(body.totals.renovationsConfirmedCount).toBe(body.renovationsConfirmed.length);
    expect(body.totals.totalPremiumRenovations).toBe(
      Math.round([...body.renovationsConfirmed, ...body.renovationsImported].reduce((s: number, r: any) => s + (r.premium ?? 0), 0) * 100) / 100,
    );
  });

  test("filtro de ramo en la proyección: el grupo viaja con la principal", async () => {
    const auto = ours((await callReport(REN, { type: "automotor" })).renovationsConfirmed);
    expect(auto.find((r: any) => r.policyId === ids.principal)).toMatchObject({ premium: PREMIUM.principal! + PREMIUM.accValida! });
    const ap = ours((await callReport(REN, { type: "accidentes_pasajeros" })).renovationsConfirmed);
    expect(ap.some((r: any) => r.policyId === ids.accValida || r.policyId === ids.principal)).toBe(false);
    expect(ap.some((r: any) => r.policyId === ids.invFecha)).toBe(true);
  });

  test("vencida por fecha, cancelada y renovada nunca proyectan; vencida guardada con fin futuro sí", async () => {
    const body = await callReport(shiftArgentinaMonth(7));
    const conf = idSet(body.renovationsConfirmed);
    expect(conf.has(ids.vencidaGuardadaFinFuturo!)).toBe(true);
    expect(conf.has(ids.canceladaFinFuturo!)).toBe(false);
    expect(conf.has(ids.renovadaFinFuturo!)).toBe(false);
  });
});

describe("GET /policies, /policies/:id y /stats con estado efectivo", () => {
  test("listado: filtro por estado efectivo, policy.status intacto", async () => {
    const vencidas = ours((await get(`/policies?status=vencida&companyId=${companyId}`)).map((r: any) => ({ ...r, policyId: r.policy.id })));
    const vIds = new Set(vencidas.map((r: any) => r.policyId));
    expect(vIds.has(ids.vencidaGuardadaActiva!)).toBe(true);
    expect(vIds.has(ids.vencidaGuardadaPorVencer!)).toBe(true);
    expect(vIds.has(ids.vencidaGuardadaFinFuturo!)).toBe(false);
    expect(vencidas.find((r: any) => r.policyId === ids.vencidaGuardadaActiva)).toMatchObject({ effectiveStatus: "vencida", policy: { status: "activa" } });
    const pv = ours((await get(`/policies?status=por_vencer&companyId=${companyId}`)).map((r: any) => ({ ...r, policyId: r.policy.id })));
    expect(pv.map((r: any) => r.policyId)).toEqual([ids.finHoy]);
    const canc = ours((await get(`/policies?status=cancelada&companyId=${companyId}`)).map((r: any) => ({ ...r, policyId: r.policy.id })));
    expect(new Set(canc.map((r: any) => r.policyId))).toEqual(new Set([ids.principalCancelada!, ids.canceladaFinFuturo!]));
    // Accesorias solo con includeAccessories=1, también con estado efectivo.
    const withAcc = ours((await get(`/policies?includeAccessories=1&companyId=${companyId}`)).map((r: any) => ({ ...r, policyId: r.policy.id })));
    expect(withAcc.find((r: any) => r.policyId === ids.accVencidaInvalida)!.effectiveStatus).toBe("vencida");
    const noAcc = ours((await get(`/policies?companyId=${companyId}`)).map((r: any) => ({ ...r, policyId: r.policy.id })));
    expect(noAcc.some((r: any) => r.policyId === ids.accValida)).toBe(false);
  });

  test("ficha: estado efectivo, principal y vínculo; accesorias con su estado efectivo", async () => {
    const venc = await get(`/policies/${ids.vencidaGuardadaActiva}`);
    expect(venc).toMatchObject({ effectiveStatus: "vencida", policy: { status: "activa" }, parentPolicy: null, accessoryLink: null });
    const ok = await get(`/policies/${ids.accValida}`);
    expect(ok.accessoryLink).toEqual({ valid: true, reason: null, reasonLabel: null });
    expect(ok.parentPolicy).toMatchObject({ id: ids.principal, policyNumber: `${PREFIX}-PRINC`, effectiveStatus: "activa" });
    const bad = await get(`/policies/${ids.invFecha}`);
    expect(bad.accessoryLink).toMatchObject({ valid: false, reason: "distinta_fecha_final" });
    const inex = await get(`/policies/${ids.invInexistente}`);
    expect(inex).toMatchObject({ parentPolicy: null, accessoryLink: { valid: false, reason: "principal_inexistente" } });
    const self = await get(`/policies/${ids.invSelf}`);
    expect(self).toMatchObject({ parentPolicy: null, accessoryLink: { valid: false, reason: "vinculo_a_si_misma" } });
    const princ = await get(`/policies/${ids.principal}`);
    const subs = new Map(princ.subPolicies.map((s: any) => [s.policy.id, s.effectiveStatus]));
    expect(subs.get(ids.accValida)).toBe("activa");
    expect(subs.has(ids.invFecha)).toBe(true);
  });

  test("/stats cuenta por estado efectivo (cancelada intacta)", async () => {
    const before = await get("/stats");
    const extra = await mkPolicy("STATS-VENC", { status: "activa", endDate: YESTERDAY });
    const extraCanc = await mkPolicy("STATS-CANC", { status: "cancelada", endDate: d(7) });
    const after = await get("/stats");
    expect(after.vencidas).toBe(before.vencidas + 1);
    expect(after.activas).toBe(before.activas);
    expect(after.canceladas).toBe(before.canceladas + 1);
    expect(after.total).toBe(before.total);
    expect(extra && extraCanc).toBeTruthy();
  });
});
