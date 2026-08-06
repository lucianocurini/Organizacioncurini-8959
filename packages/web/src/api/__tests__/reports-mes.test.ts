/**
 * Tests del endpoint GET /api/reports/renewals-rebillings (casos A–M).
 * Ejecutar con: bun test --env-file=packages/web/.env.test packages/web/src/api/__tests__/reports-mes.test.ts
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, rebillings, companies, insureds, policyFleetVehicles, policyInstallments,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";
import { shiftArgentinaMonth, toArgentinaCalendarDay } from "../../lib/dates/argentina-date";

// ── Config ────────────────────────────────────────────────────────────────────

const SESSION_ID = "test-session-reports-mes-001";
const SESSION_ID_B = "test-session-reports-mes-002";
const USER_EMAIL = "test-reports-mes@test.local";

// Far-future months → no real-data collisions
const M = "2027-06";
const M_ADJ = "2027-07";

// Meses para los tests de proyección (renovaciones/refacturaciones futuras).
// Se calculan relativos al mes actual REAL de Argentina (no hardcodeados)
// para que "F es futuro" y "PAST_MONTH es pasado" sigan siendo ciertos sin
// importar cuándo corra la suite — y bien separados de M/M_ADJ para no
// colisionar con esos fixtures.
const NOW_YEAR = Number(toArgentinaCalendarDay().slice(0, 4));
const FUTURE_YEAR = NOW_YEAR + 6;
const F = `${FUTURE_YEAR}-03`;
const F_ADJ = `${FUTURE_YEAR}-04`;
const DEC = `${FUTURE_YEAR}-12`;
const JAN = `${FUTURE_YEAR + 1}-01`;
const PAST_MONTH = "2020-05";

let userId: number;
let insuredId: number;
let coElNorteId: number;
let coRivadaviaId: number;
let coMercantilId: number;
let coCoopId: number;

const policyIdsToClean: number[] = [];
const rebillingIdsToClean: number[] = [];

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getOrCreateCo(name: string): Promise<number> {
  const ex = await db.select({ id: companies.id })
    .from(companies).where(eq(companies.name, name)).get();
  if (ex) return ex.id;
  const [c] = await db.insert(companies).values({ name }).returning({ id: companies.id });
  return c!.id;
}

async function mkPolicy(opts: {
  num: string;
  companyId: number;
  startDate: string;
  endDate?: string;
  type?: string;
  notes?: string | null;
  renewedFromId?: number;
  vehicleBrand?: string | null;
  vehicleModel?: string | null;
  vehicleYear?: number | null;
  vehiclePlate?: string | null;
  isFleet?: number;
  motoBrand?: string | null;
  motoModel?: string | null;
  motoYear?: number | null;
  motoPlate?: string | null;
  propertyAddress?: string | null;
  businessName?: string | null;
  businessActivity?: string | null;
  status?: string;
  sumInsured?: number | null;
  coverageType?: string | null;
  nextRebillingDate?: string | null;
}): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: opts.num,
    type: opts.type ?? "automotor",
    status: opts.status ?? "activa",
    companyId: opts.companyId,
    insuredId,
    startDate: opts.startDate,
    endDate: opts.endDate ?? `${opts.startDate.slice(0, 4)}-12-31`,
    isRebilling: 0,
    createdBy: userId,
    notes: opts.notes ?? null,
    renewedFromId: opts.renewedFromId ?? null,
    vehicleBrand: opts.vehicleBrand ?? null,
    vehicleModel: opts.vehicleModel ?? null,
    vehicleYear: opts.vehicleYear ?? null,
    vehiclePlate: opts.vehiclePlate ?? null,
    isFleet: opts.isFleet ?? 0,
    motoBrand: opts.motoBrand ?? null,
    motoModel: opts.motoModel ?? null,
    motoYear: opts.motoYear ?? null,
    motoPlate: opts.motoPlate ?? null,
    propertyAddress: opts.propertyAddress ?? null,
    businessName: opts.businessName ?? null,
    businessActivity: opts.businessActivity ?? null,
    sumInsured: opts.sumInsured !== undefined ? opts.sumInsured : null,
    coverageType: opts.coverageType !== undefined ? opts.coverageType : null,
    nextRebillingDate: opts.nextRebillingDate !== undefined ? opts.nextRebillingDate : null,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}

async function mkReb(opts: {
  policyId: number;
  billingStart: string;
  billingEnd?: string;
  premium?: number | null;
  monthlyFee?: number | null;
  notes?: string | null;
  sumInsured?: number | null;
}): Promise<number> {
  const [r] = await db.insert(rebillings).values({
    policyId: opts.policyId,
    billingStart: opts.billingStart,
    billingEnd: opts.billingEnd ?? `${opts.billingStart.slice(0, 7)}-28`,
    premium: opts.premium !== undefined ? opts.premium : 10000,
    monthlyFee: opts.monthlyFee ?? null,
    notes: opts.notes ?? null,
    sumInsured: opts.sumInsured !== undefined ? opts.sumInsured : null,
  }).returning({ id: rebillings.id });
  rebillingIdsToClean.push(r!.id);
  return r!.id;
}

async function mkInstallment(opts: {
  policyId: number;
  number: number;
  dueDate: string;
  amount?: number;
  status?: string;
  rendered?: number;
}): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({
    policyId: opts.policyId,
    number: opts.number,
    dueDate: opts.dueDate,
    amount: opts.amount ?? 15000,
    status: opts.status ?? "pendiente",
    rendered: opts.rendered ?? 0,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

async function callReport(month: string, params: Record<string, string> = {}, sid = SESSION_ID) {
  const qs = new URLSearchParams({ month, ...params });
  return app.fetch(new Request(`http://localhost/api/reports/renewals-rebillings?${qs}`, {
    headers: { "x-session-id": sid },
  }));
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Pre-cleanup residual data
  const prevUser = await db.select({ id: users.id })
    .from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id })
      .from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const prevPolIds = prevPols.map((p) => p.id);
    if (prevPolIds.length) {
      await db.delete(rebillings).where(inArray(rebillings.policyId, prevPolIds)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, prevPolIds)).catch(() => {});
    }
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Reports Mes",
    email: USER_EMAIL,
    password: "hashed-dummy",
    role: "user",
    active: 1,
  }).returning({ id: users.id });
  userId = u!.id;

  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });
  await db.insert(sessions).values({ id: SESSION_ID_B, userId, expiresAt: new Date(Date.now() + 86400000) });

  const [ins] = await db.insert(insureds).values({ name: "TEST REPORTS MES", createdBy: userId })
    .returning({ id: insureds.id });
  insuredId = ins!.id;

  coElNorteId  = await getOrCreateCo("El Norte");
  coRivadaviaId = await getOrCreateCo("Rivadavia");
  coMercantilId = await getOrCreateCo("Mercantil Andina");
  coCoopId      = await getOrCreateCo("Cooperación");
});

afterAll(async () => {
  if (rebillingIdsToClean.length) {
    await db.delete(rebillings).where(inArray(rebillings.id, rebillingIdsToClean)).catch(() => {});
  }
  if (policyIdsToClean.length) {
    await db.delete(policyFleetVehicles).where(inArray(policyFleetVehicles.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  const me = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (me) {
    await db.delete(insureds).where(eq(insureds.createdBy, me.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, me.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, me.id)).catch(() => {});
  }
});

// ── Caso A — billingStart para rebillings, startDate para pólizas ─────────────

describe("Caso A — rebillings usan billingStart, pólizas usan startDate", () => {
  test("rebilling en M_ADJ no aparece en M; póliza en M no aparece en M_ADJ", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-A001",
      companyId: coElNorteId,
      startDate: `${M}-01`,
      notes: "Importado de El Norte v2 | Movimiento: ALTA",
    });
    await mkReb({
      policyId: polId,
      billingStart: `${M_ADJ}-01`,
      billingEnd: `${M_ADJ}-28`,
      notes: "Importado de El Norte v2 | Prórroga",
    });

    const rM = await callReport(M);
    expect(rM.status).toBe(200);
    const bM = await rM.json();

    // Policy appears in M as alta
    expect(bM.newPolicies.some((p: any) => p.policyNumber === "TEST-RM-A001")).toBe(true);
    // Rebilling (billingStart=M_ADJ) must NOT appear in M
    expect(bM.rebillings.some((r: any) => r.policyId === polId)).toBe(false);

    const rAdj = await callReport(M_ADJ);
    expect(rAdj.status).toBe(200);
    const bAdj = await rAdj.json();

    // Rebilling appears in M_ADJ
    expect(bAdj.rebillings.some((r: any) => r.policyId === polId)).toBe(true);
    // Policy (startDate=M) must NOT appear in M_ADJ
    expect(bAdj.newPolicies.some((p: any) => p.policyNumber === "TEST-RM-A001")).toBe(false);
  });
});

// ── Caso B — dos rebillings en meses distintos ────────────────────────────────

describe("Caso B — dos rebillings en meses distintos (Rivadavia)", () => {
  test("cada rebilling aparece sólo en su mes", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-B001",
      companyId: coRivadaviaId,
      startDate: `${M}-01`,
      notes: "Importado de Rivadavia | Movimiento: ALTA",
    });
    await mkReb({ policyId: polId, billingStart: `${M}-01`, notes: "Importado de Rivadavia | Prórroga" });
    await mkReb({ policyId: polId, billingStart: `${M_ADJ}-01`, notes: "Importado de Rivadavia | Prórroga" });

    const bM = await (await callReport(M)).json();
    expect(bM.rebillings.filter((r: any) => r.policyId === polId).length).toBe(1);
    expect(bM.rebillings.find((r: any) => r.policyId === polId).billingStart).toStartWith(M);

    const bAdj = await (await callReport(M_ADJ)).json();
    expect(bAdj.rebillings.filter((r: any) => r.policyId === polId).length).toBe(1);
    expect(bAdj.rebillings.find((r: any) => r.policyId === polId).billingStart).toStartWith(M_ADJ);
  });
});

// ── Caso C — renovaciones confirmadas (renewedFromId IS NOT NULL) ─────────────

describe("Caso C — renovación confirmada vía renewedFromId", () => {
  test("póliza con renewedFromId → renovationsConfirmed con datos de la póliza anterior", async () => {
    const fromId = await mkPolicy({
      num: "TEST-RM-C-FROM",
      companyId: coCoopId,
      startDate: "2026-06-01",
      endDate: "2027-05-31",
    });
    const newId = await mkPolicy({
      num: "TEST-RM-C-NEW",
      companyId: coCoopId,
      startDate: `${M}-01`,
      renewedFromId: fromId,
    });

    const body = await (await callReport(M)).json();
    expect(body.renovationsConfirmed.some((r: any) => r.policyId === newId)).toBe(true);

    const row = body.renovationsConfirmed.find((r: any) => r.policyId === newId);
    expect(row.renewedFromPolicyNumber).toBe("TEST-RM-C-FROM");
    expect(row.renewedFromEndDate).toBe("2027-05-31");

    // Must NOT appear in newPolicies
    expect(body.newPolicies.some((p: any) => p.policyId === newId)).toBe(false);
  });
});

// ── Caso D — 3 filas idénticas → duplicateCount=3, extraDuplicateRows=2 ───────

describe("Caso D — dedup: tres filas idénticas colapsan en una", () => {
  test("duplicateCount=3 y extraDuplicateRows=2; sólo 1 fila en respuesta", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-D001",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      notes: "Importado de El Norte v2 | Prórroga",
    });
    await mkReb({ policyId: polId, billingStart: `${M}-01`, premium: 50000, notes: "Importado de El Norte v2 | Prórroga" });
    await mkReb({ policyId: polId, billingStart: `${M}-01`, premium: 50000, notes: "Importado de El Norte v2 | Prórroga" });
    await mkReb({ policyId: polId, billingStart: `${M}-01`, premium: 50000, notes: "Importado de El Norte v2 | Prórroga" });

    const body = await (await callReport(M)).json();
    const matching = body.rebillings.filter((r: any) => r.policyId === polId);
    expect(matching.length).toBe(1);
    expect(matching[0].duplicateCount).toBe(3);
    expect(matching[0].extraDuplicateRows).toBe(2);
  });
});

// ── Caso E — mismo policyId, billingStart distintos → dos filas ───────────────

describe("Caso E — mismo policyId, billingStart distintos en el mismo mes", () => {
  test("dos rebillings con billingStart distintos → dos filas en respuesta", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-E001",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      notes: "Importado de El Norte v2 | Prórroga",
    });
    await mkReb({ policyId: polId, billingStart: `${M}-01`, billingEnd: `${M}-14`, premium: 10000 });
    await mkReb({ policyId: polId, billingStart: `${M}-15`, billingEnd: `${M}-28`, premium: 10000 });

    const body = await (await callReport(M)).json();
    const matching = body.rebillings.filter((r: any) => r.policyId === polId);
    expect(matching.length).toBe(2);
    expect(matching.every((r: any) => r.duplicateCount === 1)).toBe(true);
  });
});

// ── Caso F — mismo período, premium distinto → dos filas ─────────────────────

describe("Caso F — mismo período, premium distinto → dos filas separadas", () => {
  test("dos rebillings con mismo (policyId, billingStart, billingEnd) pero premium diferente → 2 filas", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-F001",
      companyId: coElNorteId,
      startDate: "2026-01-01",
    });
    await mkReb({ policyId: polId, billingStart: `${M}-01`, billingEnd: `${M}-28`, premium: 20000 });
    await mkReb({ policyId: polId, billingStart: `${M}-01`, billingEnd: `${M}-28`, premium: 20001 });

    const body = await (await callReport(M)).json();
    const matching = body.rebillings.filter((r: any) => r.policyId === polId);
    expect(matching.length).toBe(2);
    expect(matching.every((r: any) => r.duplicateCount === 1)).toBe(true);
  });
});

// ── Caso G — premium null → sin NaN ──────────────────────────────────────────

describe("Caso G — premium null es consistente, sin NaN", () => {
  test("premium null en rebilling → premium es null en respuesta, no NaN", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-G001",
      companyId: coElNorteId,
      startDate: "2026-01-01",
    });
    await mkReb({ policyId: polId, billingStart: `${M}-01`, premium: null });

    const body = await (await callReport(M)).json();
    const row = body.rebillings.find((r: any) => r.policyId === polId);
    expect(row).toBeDefined();
    expect(row.premium).toBeNull();
    // The JSON serialized value must be null, not NaN (NaN serializes as null in JSON but let's verify the totals don't blow up)
    expect(Number.isNaN(body.totals.totalPremiumRebillings)).toBe(false);
  });

  test("premium null en policy → premium es null en respuesta", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-G002",
      companyId: coCoopId,
      startDate: `${M}-01`,
    });

    const body = await (await callReport(M)).json();
    const row = body.newPolicies.find((p: any) => p.policyId === polId);
    expect(row).toBeDefined();
    expect(row.premium).toBeNull();
    expect(Number.isNaN(body.totals.totalPremiumRenovations)).toBe(false);
  });
});

// ── Caso H — Movimiento: RENOVACION → renovationsImported ────────────────────

describe("Caso H — notas 'Movimiento: RENOVACION' → renovationsImported", () => {
  test("El Norte policy con 'Movimiento: RENOVACION' aparece en renovationsImported", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-H001",
      companyId: coElNorteId,
      startDate: `${M}-01`,
      notes: "Importado de El Norte v2 | Movimiento: RENOVACION | Endoso: 0",
    });

    const body = await (await callReport(M)).json();
    expect(body.renovationsImported.some((r: any) => r.policyId === polId)).toBe(true);
    expect(body.renovationsConfirmed.some((r: any) => r.policyId === polId)).toBe(false);
    expect(body.newPolicies.some((r: any) => r.policyId === polId)).toBe(false);

    const row = body.renovationsImported.find((r: any) => r.policyId === polId);
    expect(row.sourceImporter).toBe("el_norte_v2");
  });
});

// ── Caso I — SSN-GDE 'Mov: RENOVACION' → renovationsImported ─────────────────

describe("Caso I — SSN-GDE 'Mov: RENOVACION' → renovationsImported", () => {
  test("SSN-GDE policy con 'Mov: RENOVACION' aparece en renovationsImported", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-I001",
      companyId: coRivadaviaId,
      startDate: `${M}-01`,
      notes: "SSN-GDE | Mov: RENOVACION | Nro: 12345",
    });

    const body = await (await callReport(M)).json();
    expect(body.renovationsImported.some((r: any) => r.policyId === polId)).toBe(true);
    expect(body.newPolicies.some((r: any) => r.policyId === polId)).toBe(false);

    const row = body.renovationsImported.find((r: any) => r.policyId === polId);
    expect(row.sourceImporter).toBe("rivadavia_ssn_gde");
  });
});

// ── Caso J — sin señales → newPolicies ───────────────────────────────────────

describe("Caso J — sin señales de renovación → newPolicies", () => {
  test("póliza sin notes de renovación y sin renewedFromId → newPolicies", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-J001",
      companyId: coCoopId,
      startDate: `${M}-01`,
      notes: null,
    });

    const body = await (await callReport(M)).json();
    expect(body.newPolicies.some((p: any) => p.policyId === polId)).toBe(true);
    expect(body.renovationsConfirmed.some((p: any) => p.policyId === polId)).toBe(false);
    expect(body.renovationsImported.some((p: any) => p.policyId === polId)).toBe(false);
  });
});

// ── Caso K — Mercantil Andina → sin_antecedente_de_poliza ────────────────────

describe("Caso K — Mercantil Andina sin renovación → sin_antecedente_de_poliza", () => {
  test("póliza de Mercantil Andina sin notas → classificationReason=sin_antecedente_de_poliza", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-K001",
      companyId: coMercantilId,
      startDate: `${M}-01`,
      notes: "Importado de Mercantil Andina | Movimiento: ALTA",
    });

    const body = await (await callReport(M)).json();
    const row = body.newPolicies.find((p: any) => p.policyId === polId);
    expect(row).toBeDefined();
    expect(row.classificationReason).toBe("sin_antecedente_de_poliza");
    expect(row.sourceImporter).toBe("mercantil_andina");
  });
});

// ── Caso L — filtros combinados ───────────────────────────────────────────────

describe("Caso L — filtros: companyId, type, movementType, rebillingType, q", () => {
  let polElNorteId: number;
  let polRivId: number;

  test("setup: crear dos pólizas de compañías distintas", async () => {
    polElNorteId = await mkPolicy({
      num: "TEST-RM-L-EN",
      companyId: coElNorteId,
      type: "automotor",
      startDate: `${M}-01`,
      notes: "Importado de El Norte v2 | Movimiento: ALTA",
    });
    polRivId = await mkPolicy({
      num: "TEST-RM-L-RV",
      companyId: coRivadaviaId,
      type: "hogar",
      startDate: `${M}-01`,
      notes: "Importado de Rivadavia | Movimiento: ALTA",
    });
    expect(polElNorteId).toBeGreaterThan(0);
    expect(polRivId).toBeGreaterThan(0);
  });

  test("filtro companyId → sólo las pólizas de esa compañía", async () => {
    const body = await (await callReport(M, { companyId: String(coElNorteId) })).json();
    expect(body.newPolicies.some((p: any) => p.policyId === polElNorteId)).toBe(true);
    expect(body.newPolicies.some((p: any) => p.policyId === polRivId)).toBe(false);
  });

  test("filtro type=automotor → sólo automotores", async () => {
    const body = await (await callReport(M, { type: "automotor" })).json();
    expect(body.newPolicies.some((p: any) => p.policyId === polElNorteId)).toBe(true);
    expect(body.newPolicies.some((p: any) => p.policyId === polRivId)).toBe(false);
  });

  test("filtro movementType=new_policy → sólo altas, sin renovaciones", async () => {
    // Add a renovation imported so we can verify it's filtered out
    const polRen = await mkPolicy({
      num: "TEST-RM-L-REN",
      companyId: coElNorteId,
      type: "automotor",
      startDate: `${M}-01`,
      notes: "Importado de El Norte v2 | Movimiento: RENOVACION",
    });

    const body = await (await callReport(M, { movementType: "new_policy" })).json();
    expect(body.renovationsImported).toHaveLength(0);
    expect(body.renovationsConfirmed).toHaveLength(0);
    expect(body.newPolicies.some((p: any) => p.policyId === polElNorteId)).toBe(true);

    // cleanup
    await db.delete(policies).where(eq(policies.id, polRen)).catch(() => {});
    policyIdsToClean.push(polRen);
  });

  test("filtro rebillingType=prorroga → sólo prórrogas en refacturaciones", async () => {
    const polR = await mkPolicy({
      num: "TEST-RM-L-PRR",
      companyId: coElNorteId,
      startDate: "2026-01-01",
    });
    const rPrr = await mkReb({
      policyId: polR,
      billingStart: `${M}-01`,
      notes: "Importado de El Norte v2 | Prórroga de vigencia",
    });
    const rEnd = await mkReb({
      policyId: polR,
      billingStart: `${M}-15`,
      notes: "Importado de El Norte v2 | Endoso de modificación",
    });

    const body = await (await callReport(M, { rebillingType: "prorroga" })).json();
    const rebs = body.rebillings.filter((r: any) => r.policyId === polR);
    expect(rebs.every((r: any) => r.rebillingType === "prorroga")).toBe(true);
    expect(body.rebillings.some((r: any) => r.policyId === polR && r.rebillingType === "endoso")).toBe(false);

    // cleanup helpers
    await db.delete(rebillings).where(inArray(rebillings.id, [rPrr, rEnd])).catch(() => {});
    await db.delete(policies).where(eq(policies.id, polR)).catch(() => {});
  });

  test("filtro q → busca por número de póliza (case-insensitive)", async () => {
    const body = await (await callReport(M, { q: "test-rm-l-en" })).json();
    expect(body.newPolicies.some((p: any) => p.policyId === polElNorteId)).toBe(true);
    expect(body.newPolicies.some((p: any) => p.policyId === polRivId)).toBe(false);
  });
});

// ── Caso N — Bien asegurado (insuredAsset) ────────────────────────────────────

describe("Caso N — Bien asegurado por tipo de póliza", () => {
  test("automotor con datos de vehículo → insuredAsset en rebillings, renovationsConfirmed, renovationsImported y newPolicies", async () => {
    // Alta (newPolicies)
    const polAlta = await mkPolicy({
      num: "TEST-RM-N-ALTA",
      companyId: coElNorteId,
      startDate: `${M}-01`,
      notes: null,
      vehicleBrand: "Toyota",
      vehicleModel: "Corolla",
      vehicleYear: 2020,
      vehiclePlate: "AB123CD",
    });

    // Refacturación (rebillings) sobre una póliza base con datos de vehículo
    const polBase = await mkPolicy({
      num: "TEST-RM-N-BASE",
      companyId: coElNorteId,
      startDate: `${M}-01`,
      notes: "Importado de El Norte v2 | Movimiento: ALTA",
      vehicleBrand: "Ford",
      vehicleModel: "Fiesta",
      vehiclePlate: "XY987ZW",
    });
    await mkReb({
      policyId: polBase,
      billingStart: `${M_ADJ}-01`,
      notes: "Importado de El Norte v2 | Prórroga",
    });

    // Renovación confirmada (renovationsConfirmed) → toma el bien de la póliza NUEVA
    const polOld = await mkPolicy({
      num: "TEST-RM-N-OLD",
      companyId: coCoopId,
      startDate: `2026-01-01`,
      endDate: `${M}-01`,
      notes: null,
      vehicleBrand: "Viejo",
      vehicleModel: "Modelo",
      vehiclePlate: "OLD001",
    });
    const polNew = await mkPolicy({
      num: "TEST-RM-N-NEW",
      companyId: coCoopId,
      startDate: `${M}-01`,
      notes: null,
      renewedFromId: polOld,
      vehicleBrand: "Honda",
      vehicleModel: "Civic",
      vehiclePlate: "NEW002",
    });

    // Renovación importada (renovationsImported)
    const polImportada = await mkPolicy({
      num: "TEST-RM-N-IMP",
      companyId: coRivadaviaId,
      startDate: `${M}-01`,
      notes: "Importado de Rivadavia | Movimiento: RENOVACION",
      vehicleBrand: "Chevrolet",
      vehicleModel: "Onix",
      vehiclePlate: "IMP003",
    });

    const body = await (await callReport(M_ADJ)).json();
    const bodyM = await (await callReport(M)).json();

    const rowAlta = bodyM.newPolicies.find((p: any) => p.policyId === polAlta);
    expect(rowAlta.insuredAsset).toBe("Toyota Corolla 2020 · AB123CD");

    const rowReb = body.rebillings.find((r: any) => r.policyId === polBase);
    expect(rowReb.insuredAsset).toBe("Ford Fiesta · XY987ZW");

    const rowConfirmed = bodyM.renovationsConfirmed.find((p: any) => p.policyId === polNew);
    expect(rowConfirmed.insuredAsset).toBe("Honda Civic · NEW002");

    const rowImported = bodyM.renovationsImported.find((p: any) => p.policyId === polImportada);
    expect(rowImported.insuredAsset).toBe("Chevrolet Onix · IMP003");
  });

  test("póliza sin bien asegurado (tipo sin campos propios) → insuredAsset null y frontend mostraría '—'", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-N-NOASSET",
      companyId: coElNorteId,
      type: "accidentes",
      startDate: `${M}-01`,
      notes: null,
    });

    const body = await (await callReport(M)).json();
    const row = body.newPolicies.find((p: any) => p.policyId === polId);
    expect(row).toBeDefined();
    expect(row.insuredAsset).toBeNull();
  });

  test("automotor de flota sin vehículos cargados → 'Flota'; con vehículos → 'Flota: N vehículos'", async () => {
    const polSinVeh = await mkPolicy({
      num: "TEST-RM-N-FLEET-EMPTY",
      companyId: coElNorteId,
      startDate: `${M}-01`,
      notes: null,
      isFleet: 1,
    });
    const polConVeh = await mkPolicy({
      num: "TEST-RM-N-FLEET-FULL",
      companyId: coElNorteId,
      startDate: `${M}-01`,
      notes: null,
      isFleet: 1,
    });
    await db.insert(policyFleetVehicles).values([
      { policyId: polConVeh, brand: "Toyota", model: "Hilux" },
      { policyId: polConVeh, brand: "Ford", model: "Ranger" },
    ]);

    const body = await (await callReport(M)).json();
    expect(body.newPolicies.find((p: any) => p.policyId === polSinVeh).insuredAsset).toBe("Flota");
    expect(body.newPolicies.find((p: any) => p.policyId === polConVeh).insuredAsset).toBe("Flota: 2 vehículos");
  });

  test("hogar usa propertyAddress; comercial usa businessName + businessActivity", async () => {
    const polHogar = await mkPolicy({
      num: "TEST-RM-N-HOGAR",
      companyId: coElNorteId,
      type: "hogar",
      startDate: `${M}-01`,
      notes: null,
      propertyAddress: "Av. Siempre Viva 742",
    });
    const polComercial = await mkPolicy({
      num: "TEST-RM-N-COMERCIAL",
      companyId: coElNorteId,
      type: "comercial",
      startDate: `${M}-01`,
      notes: null,
      businessName: "Ferretería El Tornillo",
      businessActivity: "Venta de materiales",
    });

    const body = await (await callReport(M)).json();
    expect(body.newPolicies.find((p: any) => p.policyId === polHogar).insuredAsset).toBe("Av. Siempre Viva 742");
    expect(body.newPolicies.find((p: any) => p.policyId === polComercial).insuredAsset)
      .toBe("Ferretería El Tornillo (Venta de materiales)");
  });

  test("no expone DNI, dirección personal, teléfono ni email del asegurado", async () => {
    const body = await (await callReport(M)).json();
    const json = JSON.stringify(body);
    expect(json.toLowerCase()).not.toContain('"dni"');
    expect(json.toLowerCase()).not.toContain('"phone"');
    expect(json.toLowerCase()).not.toContain('"email"');
    // "address" del asegurado no debe exponerse (propertyAddress del bien sí es intencional)
    expect(json).not.toContain('"address"');
  });

  test("filtros y totales previos siguen funcionando con insuredAsset presente", async () => {
    const body = await (await callReport(M)).json();
    expect(body.totals.newPoliciesCount).toBe(body.newPolicies.length);
    expect(body.totals.rebillingsCount).toBe(body.rebillings.length);
    expect(body.totals.renovationsConfirmedCount).toBe(body.renovationsConfirmed.length);
    expect(body.totals.renovationsImportedCount).toBe(body.renovationsImported.length);
  });
});

// ── Caso M — seguridad ────────────────────────────────────────────────────────

describe("Caso M — seguridad y autenticación", () => {
  test("sin sesión → 401", async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/reports/renewals-rebillings?month=${M}`)
    );
    expect(res.status).toBe(401);
  });

  test("sesión inválida → 401", async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/reports/renewals-rebillings?month=${M}`, {
        headers: { "x-session-id": "not-a-real-session-id" },
      })
    );
    expect(res.status).toBe(401);
  });

  test("sesión válida (role=user) → 200 (no es admin-only)", async () => {
    const res = await callReport(M);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.month).toBe(M);
    expect(Array.isArray(body.rebillings)).toBe(true);
    expect(Array.isArray(body.renovationsConfirmed)).toBe(true);
    expect(Array.isArray(body.renovationsImported)).toBe(true);
    expect(Array.isArray(body.newPolicies)).toBe(true);
    expect(body.totals).toBeDefined();
  });

  test("month inválido → 400", async () => {
    const res = await callReport("2027-13");
    expect(res.status).toBe(400);
  });

  test("month ausente → 400", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/reports/renewals-rebillings", {
        headers: { "x-session-id": SESSION_ID },
      })
    );
    expect(res.status).toBe(400);
  });

  test("companyId no numérico → silenciado (ignorado por sanitización)", async () => {
    // Invalid companyId should be ignored, not throw 500
    const res = await callReport(M, { companyId: "abc; DROP TABLE policies" });
    expect(res.status).toBe(200);
  });

  test("type fuera de whitelist → ignorado, no filtra", async () => {
    const res = await callReport(M, { type: "malicious<script>" });
    expect(res.status).toBe(200);
  });
});

// ── Caso O — Cuotas pendientes del mes (proyección de cartera) ───────────────
// Reproduce el reclamo original: "el reporte mensual no muestra cuotas de
// meses futuros". A diferencia de rebillings/policies (eventos ya
// registrados), esta sección proyecta por policyInstallments.dueDate — debe
// mostrar meses futuros aunque no haya ninguna rebilling ni alta cargada.

describe("Caso O — Cuotas pendientes del mes (installments por dueDate)", () => {
  test("cuota pendiente con dueDate en un mes futuro aparece en pendingInstallments de ese mes", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-O-FUTURA",
      companyId: coMercantilId,
      startDate: "2026-01-01",
    });
    await mkInstallment({ policyId: polId, number: 8, dueDate: `${M}-05`, amount: 22500 });

    const body = await (await callReport(M)).json();
    const row = body.pendingInstallments.find((r: any) => r.policyId === polId);
    expect(row).toBeDefined();
    expect(row.amount).toBe(22500);
    expect(row.status).toBe("pendiente");
    expect(body.totals.pendingInstallmentsCount).toBe(body.pendingInstallments.length);
  });

  test("cuota 'vencida' también aparece, y se cuenta en pendingInstallmentsOverdueCount", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-O-VENCIDA",
      companyId: coMercantilId,
      startDate: "2026-01-01",
    });
    await mkInstallment({ policyId: polId, number: 1, dueDate: `${M}-10`, status: "vencida" });

    const body = await (await callReport(M)).json();
    const row = body.pendingInstallments.find((r: any) => r.policyId === polId);
    expect(row).toBeDefined();
    expect(row.status).toBe("vencida");
    expect(body.totals.pendingInstallmentsOverdueCount).toBeGreaterThanOrEqual(1);
  });

  test("no depende de pagos/cash_entries: la cuota aparece sin que exista ningún payment asociado", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-O-SINPAGO",
      companyId: coMercantilId,
      startDate: "2026-01-01",
    });
    await mkInstallment({ policyId: polId, number: 1, dueDate: `${M}-01` });

    // No se crea ningún payment/cash_entry para esta póliza — solo la cuota.
    const body = await (await callReport(M)).json();
    expect(body.pendingInstallments.some((r: any) => r.policyId === polId)).toBe(true);
  });

  test("cuota 'pagada' NO aparece en pendingInstallments", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-O-PAGADA",
      companyId: coMercantilId,
      startDate: "2026-01-01",
    });
    await mkInstallment({ policyId: polId, number: 1, dueDate: `${M}-01`, status: "pagada" });

    const body = await (await callReport(M)).json();
    expect(body.pendingInstallments.some((r: any) => r.policyId === polId)).toBe(false);
  });

  test("cuota 'no_exigible' (póliza anulada) NO aparece en pendingInstallments", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-O-NOEXIGIBLE",
      companyId: coMercantilId,
      startDate: "2026-01-01",
    });
    await mkInstallment({ policyId: polId, number: 1, dueDate: `${M}-01`, status: "no_exigible" });

    const body = await (await callReport(M)).json();
    expect(body.pendingInstallments.some((r: any) => r.policyId === polId)).toBe(false);
  });

  test("cuota ya rendida (rendered=1) NO aparece, aunque siga 'pendiente'", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-O-RENDIDA",
      companyId: coMercantilId,
      startDate: "2026-01-01",
    });
    await mkInstallment({ policyId: polId, number: 1, dueDate: `${M}-01`, rendered: 1 });

    const body = await (await callReport(M)).json();
    expect(body.pendingInstallments.some((r: any) => r.policyId === polId)).toBe(false);
  });

  test("cuota con dueDate fuera del mes pedido no aparece (respeta límites de mes)", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-O-OTROMES",
      companyId: coMercantilId,
      startDate: "2026-01-01",
    });
    await mkInstallment({ policyId: polId, number: 1, dueDate: `${M_ADJ}-01` });

    const body = await (await callReport(M)).json();
    expect(body.pendingInstallments.some((r: any) => r.policyId === polId)).toBe(false);
  });

  test("respeta filtro companyId", async () => {
    const polMercantil = await mkPolicy({
      num: "TEST-RM-O-FILT-MERC",
      companyId: coMercantilId,
      startDate: "2026-01-01",
    });
    const polRiv = await mkPolicy({
      num: "TEST-RM-O-FILT-RIV",
      companyId: coRivadaviaId,
      startDate: "2026-01-01",
    });
    await mkInstallment({ policyId: polMercantil, number: 1, dueDate: `${M}-01` });
    await mkInstallment({ policyId: polRiv, number: 1, dueDate: `${M}-01` });

    const body = await (await callReport(M, { companyId: String(coMercantilId) })).json();
    expect(body.pendingInstallments.some((r: any) => r.policyId === polMercantil)).toBe(true);
    expect(body.pendingInstallments.some((r: any) => r.policyId === polRiv)).toBe(false);
  });

  test("respeta filtro q (por número de póliza)", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-O-QFILTER",
      companyId: coMercantilId,
      startDate: "2026-01-01",
    });
    await mkInstallment({ policyId: polId, number: 1, dueDate: `${M}-01` });

    const body = await (await callReport(M, { q: "test-rm-o-qfilter" })).json();
    expect(body.pendingInstallments.some((r: any) => r.policyId === polId)).toBe(true);
    const bodyOther = await (await callReport(M, { q: "no-existe-esta-poliza" })).json();
    expect(bodyOther.pendingInstallments.some((r: any) => r.policyId === polId)).toBe(false);
  });

  test("movementType=pending_installment → solo esta sección, el resto vacío", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-O-MOVTYPE",
      companyId: coMercantilId,
      startDate: `${M}-01`,
      notes: null,
    });
    await mkInstallment({ policyId: polId, number: 1, dueDate: `${M}-01` });

    const body = await (await callReport(M, { movementType: "pending_installment" })).json();
    expect(body.pendingInstallments.some((r: any) => r.policyId === polId)).toBe(true);
    expect(body.newPolicies).toHaveLength(0);
    expect(body.rebillings).toHaveLength(0);
    expect(body.renovationsConfirmed).toHaveLength(0);
    expect(body.renovationsImported).toHaveLength(0);
  });

  test("no cuenta en totals.totalMovements (concepto distinto de los movimientos de póliza)", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-O-NOTMOVS",
      companyId: coMercantilId,
      startDate: "2026-01-01",
    });
    await mkInstallment({ policyId: polId, number: 1, dueDate: `${M}-01` });

    const body = await (await callReport(M)).json();
    const expectedTotalMovements =
      body.rebillings.length + body.renovationsConfirmed.length +
      body.renovationsImported.length + body.newPolicies.length;
    expect(body.totals.totalMovements).toBe(expectedTotalMovements);
  });

  test("no rompe el resto del reporte para el mismo mes (rebillings/altas siguen funcionando)", async () => {
    const polReb = await mkPolicy({
      num: "TEST-RM-O-COEXIST-REB",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      notes: "Importado de El Norte v2 | Prórroga",
    });
    await mkReb({ policyId: polReb, billingStart: `${M}-01`, notes: "Importado de El Norte v2 | Prórroga" });
    const polInst = await mkPolicy({
      num: "TEST-RM-O-COEXIST-INST",
      companyId: coElNorteId,
      startDate: "2026-01-01",
    });
    await mkInstallment({ policyId: polInst, number: 1, dueDate: `${M}-01` });

    const body = await (await callReport(M)).json();
    expect(body.rebillings.some((r: any) => r.policyId === polReb)).toBe(true);
    expect(body.pendingInstallments.some((r: any) => r.policyId === polInst)).toBe(true);
  });
});

// ── Caso P — Renovaciones proyectadas (mes futuro, pólizas vigentes) ─────────
// Regla de negocio: para meses POSTERIORES al mes actual de Argentina, una
// póliza vigente cuyo endDate cae en el mes seleccionado se muestra como
// renovación proyectada (projected=true), usando esa fecha como "fecha
// prevista de renovación" — nunca se inventa una póliza nueva.

describe("Caso P — Renovaciones proyectadas", () => {
  test("póliza vigente con endDate en el mes futuro → aparece como renovación proyectada", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-P001",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      endDate: `${F}-15`,
      status: "activa",
      sumInsured: 5000000,
      coverageType: "todo_riesgo",
    });

    const body = await (await callReport(F)).json();
    expect(body.isFutureMonth).toBe(true);
    const row = body.renovationsConfirmed.find((r: any) => r.policyId === polId);
    expect(row).toBeDefined();
    expect(row.projected).toBe(true);
    expect(row.endDate).toBe(`${F}-15`);
    expect(row.startDate).toBeNull();
    expect(row.renewedFromPolicyNumber).toBeNull();
    expect(row.renewedFromEndDate).toBeNull();
    expect(row.coverageType).toBe("todo_riesgo");
    expect(row.sumInsured).toBe(5000000);
  });

  test("la misma póliza NO aparece al consultar otro mes futuro", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-P002",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      endDate: `${F}-20`,
      status: "por_vencer",
    });

    const bodyOther = await (await callReport(F_ADJ)).json();
    expect(bodyOther.renovationsConfirmed.some((r: any) => r.policyId === polId)).toBe(false);

    const bodySame = await (await callReport(F)).json();
    expect(bodySame.renovationsConfirmed.some((r: any) => r.policyId === polId)).toBe(true);
  });

  test("póliza 'vencida' con endDate en el mes → NO se proyecta (no está vigente)", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-P003",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      endDate: `${F}-10`,
      status: "vencida",
    });
    const body = await (await callReport(F)).json();
    expect(body.renovationsConfirmed.some((r: any) => r.policyId === polId)).toBe(false);
  });

  test("póliza 'cancelada' con endDate en el mes → NO se proyecta", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-P004",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      endDate: `${F}-10`,
      status: "cancelada",
    });
    const body = await (await callReport(F)).json();
    expect(body.renovationsConfirmed.some((r: any) => r.policyId === polId)).toBe(false);
  });

  test("póliza ya renovada realmente (existe hija con renewedFromId) → no se duplica con una proyección", async () => {
    const oldId = await mkPolicy({
      num: "TEST-RM-P005-OLD",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      endDate: `${F}-12`,
      // A propósito status="activa" (no "renovada"): prueba el dedupe
      // relacional real (policies.renewedFromId), no solo el filtro de status.
      status: "activa",
    });
    const newId = await mkPolicy({
      num: "TEST-RM-P005-NEW",
      companyId: coElNorteId,
      startDate: `${F}-12`,
      renewedFromId: oldId,
    });

    const body = await (await callReport(F)).json();
    expect(body.renovationsConfirmed.filter((r: any) => r.policyId === oldId).length).toBe(0);
    const realRow = body.renovationsConfirmed.find((r: any) => r.policyId === newId);
    expect(realRow).toBeDefined();
    expect(realRow.projected).toBe(false);
  });

  test("mes actual/pasado: preserva comportamiento anterior — endDate en ese mes NO proyecta", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-P006",
      companyId: coElNorteId,
      startDate: "2020-01-01",
      endDate: `${PAST_MONTH}-15`,
      status: "activa",
    });
    const body = await (await callReport(PAST_MONTH)).json();
    expect(body.isFutureMonth).toBe(false);
    expect(body.renovationsConfirmed.some((r: any) => r.policyId === polId)).toBe(false);
  });

  test("mes actual de Argentina tampoco proyecta (solo estrictamente posteriores)", async () => {
    const currentMonth = shiftArgentinaMonth(0);
    const body = await (await callReport(currentMonth)).json();
    expect(body.isFutureMonth).toBe(false);
  });

  test("cambio de año diciembre→enero: respeta el límite exacto del mes", async () => {
    const polDec = await mkPolicy({
      num: "TEST-RM-P007-DEC",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      endDate: `${DEC}-31`,
      status: "activa",
    });
    const polJan = await mkPolicy({
      num: "TEST-RM-P007-JAN",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      endDate: `${JAN}-01`,
      status: "activa",
    });

    const bodyJan = await (await callReport(JAN)).json();
    expect(bodyJan.renovationsConfirmed.some((r: any) => r.policyId === polDec)).toBe(false);
    expect(bodyJan.renovationsConfirmed.some((r: any) => r.policyId === polJan)).toBe(true);

    const bodyDec = await (await callReport(DEC)).json();
    expect(bodyDec.renovationsConfirmed.some((r: any) => r.policyId === polDec)).toBe(true);
    expect(bodyDec.renovationsConfirmed.some((r: any) => r.policyId === polJan)).toBe(false);
  });
});

// ── Caso Q — independencia de huso horario ───────────────────────────────────
// isFutureMonth se calcula con shiftArgentinaMonth (Intl con timeZone fijo
// "America/Argentina/Buenos_Aires"), nunca con Date/getMonth()/toISOString()
// del proceso — el mismo patrón ya validado para el bug UTC de rendición
// #115. Se prueba comparando contra el propio helper en vez de contra una
// fecha hardcodeada, así el test es válido corra cuando corra.

describe("Caso Q — el límite de mes futuro usa el calendario de Argentina, no UTC/local", () => {
  test("mes anterior al actual (Argentina) → isFutureMonth=false", async () => {
    const body = await (await callReport(shiftArgentinaMonth(-1))).json();
    expect(body.isFutureMonth).toBe(false);
  });

  test("mes actual (Argentina) → isFutureMonth=false", async () => {
    const body = await (await callReport(shiftArgentinaMonth(0))).json();
    expect(body.isFutureMonth).toBe(false);
  });

  test("mes siguiente (Argentina) → isFutureMonth=true", async () => {
    const body = await (await callReport(shiftArgentinaMonth(1))).json();
    expect(body.isFutureMonth).toBe(true);
  });
});

// ── Caso R — Refacturaciones proyectadas (mes futuro, nextRebillingDate) ─────

describe("Caso R — Refacturaciones proyectadas", () => {
  test("póliza vigente con nextRebillingDate en el mes → aparece como refacturación proyectada", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-R001",
      companyId: coRivadaviaId,
      startDate: "2026-01-01",
      endDate: `${FUTURE_YEAR + 2}-12-31`,
      status: "activa",
      nextRebillingDate: `${F}-08`,
      sumInsured: 3000000,
      coverageType: "terceros_completo",
    });

    const body = await (await callReport(F)).json();
    const row = body.rebillings.find((r: any) => r.policyId === polId);
    expect(row).toBeDefined();
    expect(row.projected).toBe(true);
    expect(row.billingStart).toBe(`${F}-08`);
    expect(row.billingEnd).toBeNull();
    expect(row.rebillingId).toBeLessThan(0);
    expect(row.rebillingType).toBeNull();
    expect(row.duplicateCount).toBe(1);
    expect(row.coverageType).toBe("terceros_completo");
    expect(row.sumInsured).toBe(3000000);
  });

  test("nextRebillingDate=null → NO se infiere ninguna proyección", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-R002",
      companyId: coRivadaviaId,
      startDate: "2026-01-01",
      endDate: `${FUTURE_YEAR + 2}-12-31`,
      status: "activa",
      nextRebillingDate: null,
    });
    const body = await (await callReport(F)).json();
    expect(body.rebillings.some((r: any) => r.policyId === polId)).toBe(false);
  });

  test("póliza no vigente ('vencida') con nextRebillingDate en el mes → no se proyecta", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-R003",
      companyId: coRivadaviaId,
      startDate: "2026-01-01",
      endDate: `${FUTURE_YEAR + 2}-12-31`,
      status: "vencida",
      nextRebillingDate: `${F}-08`,
    });
    const body = await (await callReport(F)).json();
    expect(body.rebillings.some((r: any) => r.policyId === polId)).toBe(false);
  });

  test("ya existe una refacturación real ese mes → no se duplica con una proyectada", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-R004",
      companyId: coRivadaviaId,
      startDate: "2026-01-01",
      endDate: `${FUTURE_YEAR + 2}-12-31`,
      status: "activa",
      nextRebillingDate: `${F}-08`,
    });
    await mkReb({ policyId: polId, billingStart: `${F}-05`, notes: "Importado de Rivadavia | Prórroga" });

    const body = await (await callReport(F)).json();
    const matching = body.rebillings.filter((r: any) => r.policyId === polId);
    expect(matching.length).toBe(1);
    expect(matching[0].projected).toBe(false);
  });

  test("mes actual/pasado: nextRebillingDate en ese mes no genera fila (preserva comportamiento previo)", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-R005",
      companyId: coRivadaviaId,
      startDate: "2020-01-01",
      endDate: `${FUTURE_YEAR + 2}-12-31`,
      status: "activa",
      nextRebillingDate: `${PAST_MONTH}-08`,
    });
    const body = await (await callReport(PAST_MONTH)).json();
    expect(body.rebillings.some((r: any) => r.policyId === polId)).toBe(false);
  });
});

// ── Caso S — Cobertura y Suma asegurada ───────────────────────────────────────

describe("Caso S — Cobertura y Suma asegurada", () => {
  test("Alta: coverageType/sumInsured de la póliza aparecen tal cual", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-S001",
      companyId: coElNorteId,
      startDate: `${M}-01`,
      notes: null,
      sumInsured: 1234567,
      coverageType: "incendio",
    });
    const body = await (await callReport(M)).json();
    const row = body.newPolicies.find((p: any) => p.policyId === polId);
    expect(row.coverageType).toBe("incendio");
    expect(row.sumInsured).toBe(1234567);
  });

  test("Renovación confirmada real: coverageType/sumInsured de la póliza nueva", async () => {
    const oldId = await mkPolicy({
      num: "TEST-RM-S002-OLD", companyId: coCoopId, startDate: "2025-01-01", endDate: `${M}-01`,
    });
    const newId = await mkPolicy({
      num: "TEST-RM-S002-NEW",
      companyId: coCoopId,
      startDate: `${M}-01`,
      renewedFromId: oldId,
      sumInsured: 999,
      coverageType: "todo_riesgo",
    });
    const body = await (await callReport(M)).json();
    const row = body.renovationsConfirmed.find((r: any) => r.policyId === newId);
    expect(row.coverageType).toBe("todo_riesgo");
    expect(row.sumInsured).toBe(999);
  });

  test("Cuota pendiente: coverageType/sumInsured provienen de la póliza dueña", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-S003",
      companyId: coMercantilId,
      startDate: "2026-01-01",
      sumInsured: 55555,
      coverageType: "basica",
    });
    await mkInstallment({ policyId: polId, number: 1, dueDate: `${M}-01` });
    const body = await (await callReport(M)).json();
    const row = body.pendingInstallments.find((r: any) => r.policyId === polId);
    expect(row.coverageType).toBe("basica");
    expect(row.sumInsured).toBe(55555);
  });

  test("Refacturación real: sumInsured sale de rebillings (histórico), NO de policies, cuando difieren", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-S004",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      sumInsured: 100000,
      coverageType: "todo_riesgo",
    });
    await mkReb({
      policyId: polId,
      billingStart: `${M}-01`,
      sumInsured: 77777,
      notes: "Importado de El Norte v2 | Prórroga",
    });
    const body = await (await callReport(M)).json();
    const row = body.rebillings.find((r: any) => r.policyId === polId);
    expect(row.sumInsured).toBe(77777);
    expect(row.coverageType).toBe("todo_riesgo");
  });

  test("Refacturación real con sumInsured null → null en la fila, SIN fallback al de la póliza", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-S005",
      companyId: coElNorteId,
      startDate: "2026-01-01",
      sumInsured: 500000,
    });
    await mkReb({
      policyId: polId,
      billingStart: `${M}-01`,
      sumInsured: null,
      notes: "Importado de El Norte v2 | Prórroga",
    });
    const body = await (await callReport(M)).json();
    const row = body.rebillings.find((r: any) => r.policyId === polId);
    expect(row.sumInsured).toBeNull();
  });

  test("coverageType null en la póliza → null en la fila (backend no inventa 'Sin informar')", async () => {
    const polId = await mkPolicy({
      num: "TEST-RM-S006",
      companyId: coElNorteId,
      startDate: `${M}-01`,
      notes: null,
      coverageType: null,
      sumInsured: null,
    });
    const body = await (await callReport(M)).json();
    const row = body.newPolicies.find((p: any) => p.policyId === polId);
    expect(row.coverageType).toBeNull();
    expect(row.sumInsured).toBeNull();
  });
});
