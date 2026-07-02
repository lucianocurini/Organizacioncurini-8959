/**
 * Tests de la relación policy_installments.rebilling_id → rebillings.id (Casos A–N).
 * Ejecutar con: bun test packages/web/src/api/__tests__/rebilling-installments.test.ts
 * Corre exclusivamente contra dev.db local (nunca Turso).
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, rebillings, policyInstallments,
  companies, insureds, payments, remittances, remittanceItems, importLogs,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";
import {
  classifyInstallmentsForBackfill,
  type BackfillInstallment,
  type BackfillRebilling,
} from "../../lib/backfill/rebilling-installments-preview";

// ── Config ────────────────────────────────────────────────────────────────────

const SESSION_ID = "test-session-reb-inst-001";
const USER_EMAIL = "test-reb-inst@test.local";
const PREFIX = "TEST-REB-INST";

let userId: number;
let insuredId: number;
let coElNorteId: number;
let coRivadaviaId: number;
let coMercantilId: number;

const policyIdsToClean: number[] = [];
const rebillingIdsToClean: number[] = [];
const paymentIdsToClean: number[] = [];
const remittanceIdsToClean: number[] = [];
const remittanceItemIdsToClean: number[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateCo(name: string): Promise<number> {
  const ex = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, name)).get();
  if (ex) return ex.id;
  const [c] = await db.insert(companies).values({ name }).returning({ id: companies.id });
  return c!.id;
}

async function mkPolicy(opts: {
  num: string; companyId: number; startDate: string; endDate?: string; notes?: string | null;
}): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: opts.num, type: "automotor", status: "activa",
    companyId: opts.companyId, insuredId,
    startDate: opts.startDate, endDate: opts.endDate ?? `${opts.startDate.slice(0, 4)}-12-31`,
    isRebilling: 0, createdBy: userId, notes: opts.notes ?? null,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}

async function mkRebilling(policyId: number, billingStart: string, billingEnd: string, premium = 1000): Promise<number> {
  const [r] = await db.insert(rebillings).values({
    policyId, billingStart, billingEnd, premium, createdBy: userId,
  }).returning({ id: rebillings.id });
  rebillingIdsToClean.push(r!.id);
  return r!.id;
}

async function mkInstallment(policyId: number, number: number, dueDate: string, amount: number, opts: {
  rebillingId?: number | null; status?: string; rendered?: number;
} = {}): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({
    policyId, number, dueDate, amount,
    status: opts.status ?? "pendiente",
    rendered: opts.rendered ?? 0,
    rebillingId: opts.rebillingId ?? null,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

async function callDelete(id: number | string) {
  return app.fetch(new Request(`http://localhost/api/rebillings/${id}`, {
    method: "DELETE",
    headers: { "x-session-id": SESSION_ID },
  }));
}

async function getInstallmentIds(policyId: number): Promise<number[]> {
  const rows = await db.select({ id: policyInstallments.id }).from(policyInstallments)
    .where(eq(policyInstallments.policyId, policyId)).all();
  return rows.map(r => r.id);
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const prevPolIds = prevPols.map(p => p.id);
    if (prevPolIds.length) {
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, prevPolIds)).catch(() => {});
      await db.delete(rebillings).where(inArray(rebillings.policyId, prevPolIds)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, prevPolIds)).catch(() => {});
    }
    await db.delete(importLogs).where(eq(importLogs.createdBy, prevUser.id)).catch(() => {});
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Reb Inst", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;

  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId })
    .returning({ id: insureds.id });
  insuredId = ins!.id;

  coElNorteId = await getOrCreateCo("El Norte");
  coRivadaviaId = await getOrCreateCo("Rivadavia");
  coMercantilId = await getOrCreateCo("Mercantil Andina");
});

afterAll(async () => {
  if (remittanceItemIdsToClean.length) {
    await db.delete(remittanceItems).where(inArray(remittanceItems.id, remittanceItemIdsToClean)).catch(() => {});
  }
  if (remittanceIdsToClean.length) {
    await db.delete(remittances).where(inArray(remittances.id, remittanceIdsToClean)).catch(() => {});
  }
  if (paymentIdsToClean.length) {
    await db.delete(payments).where(inArray(payments.id, paymentIdsToClean)).catch(() => {});
  }
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(rebillings).where(inArray(rebillings.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  const me = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (me) {
    await db.delete(importLogs).where(eq(importLogs.createdBy, me.id)).catch(() => {});
    await db.delete(insureds).where(eq(insureds.createdBy, me.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, me.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, me.id)).catch(() => {});
  }
});

// ── Caso A — refacturación nueva con cuotas ───────────────────────────────────

describe("Caso A — refacturación nueva con cuotas", () => {
  test("las 3 cuotas creadas junto al rebilling tienen rebilling_id correcto", async () => {
    const polId = await mkPolicy({ num: `${PREFIX}-A001`, companyId: coElNorteId, startDate: "2027-01-01" });
    const rebId = await mkRebilling(polId, "2027-05-01", "2027-08-31", 9000);
    const i1 = await mkInstallment(polId, 1, "2027-05-01", 3000, { rebillingId: rebId });
    const i2 = await mkInstallment(polId, 2, "2027-06-01", 3000, { rebillingId: rebId });
    const i3 = await mkInstallment(polId, 3, "2027-07-01", 3000, { rebillingId: rebId });

    const rows = await db.select().from(policyInstallments).where(inArray(policyInstallments.id, [i1, i2, i3])).all();
    expect(rows.every(r => r.rebillingId === rebId)).toBe(true);
  });
});

// ── Caso B — cuotas base ───────────────────────────────────────────────────────

describe("Caso B — cuotas base sin refacturación", () => {
  test("cuotas creadas para una póliza nueva (sin rebilling) quedan con rebilling_id null", async () => {
    const polId = await mkPolicy({ num: `${PREFIX}-B001`, companyId: coElNorteId, startDate: "2027-01-01" });
    const i1 = await mkInstallment(polId, 1, "2027-01-01", 1000);
    const i2 = await mkInstallment(polId, 2, "2027-02-01", 1000);

    const rows = await db.select().from(policyInstallments).where(inArray(policyInstallments.id, [i1, i2])).all();
    expect(rows.every(r => r.rebillingId === null)).toBe(true);
  });
});

// ── Caso C — rollback ─────────────────────────────────────────────────────────

describe("Caso C — rollback si falla una cuota (importador Rivadavia)", () => {
  test("error en la segunda cuota → no queda rebilling ni ninguna cuota del movimiento", async () => {
    const polNum = `${PREFIX}-C001`;
    const polId = await mkPolicy({ num: polNum, companyId: coRivadaviaId, startDate: "2027-01-01", endDate: "2027-05-01" });

    const payload = {
      policies: [{
        policyNumber: polNum,
        movType: "PRORROGA",
        vehicleType: "automotor",
        startDate: "2027-05-01",
        endDate: "2027-09-01",
        premium: 5000,
        insuredName: `${PREFIX} Asegurado`,
        installments: [
          { number: 1, dueDate: "2027-05-01", amount: 2500 },
          { number: 2, dueDate: "2027-06-01", amount: null }, // fuerza NOT NULL violation
        ],
      }],
    };

    const res = await app.fetch(new Request("http://localhost/api/import/rivadavia", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": SESSION_ID },
      body: JSON.stringify(payload),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBeGreaterThanOrEqual(1);
    expect(body.rebillings).toBe(0);

    const rebs = await db.select().from(rebillings).where(eq(rebillings.policyId, polId)).all();
    const insts = await db.select().from(policyInstallments).where(eq(policyInstallments.policyId, polId)).all();
    expect(rebs.length).toBe(0);
    expect(insts.length).toBe(0);
  });
});

// ── Caso D — borrar refacturación limpia ──────────────────────────────────────

describe("Caso D — borrar refacturación con cuotas pendientes", () => {
  test("DELETE elimina exactamente las 3 cuotas y el rebilling; no toca cuotas base", async () => {
    const polId = await mkPolicy({ num: `${PREFIX}-D001`, companyId: coElNorteId, startDate: "2027-01-01" });
    const baseInst = await mkInstallment(polId, 1, "2027-01-01", 500); // cuota base, rebillingId null
    const rebId = await mkRebilling(polId, "2027-05-01", "2027-08-01", 900);
    await mkInstallment(polId, 2, "2027-05-01", 300, { rebillingId: rebId });
    await mkInstallment(polId, 3, "2027-06-01", 300, { rebillingId: rebId });
    await mkInstallment(polId, 4, "2027-07-01", 300, { rebillingId: rebId });

    const res = await callDelete(rebId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toEqual({ rebilling: 1, installments: 3 });

    const remainingReb = await db.select().from(rebillings).where(eq(rebillings.id, rebId)).get();
    expect(remainingReb).toBeUndefined();

    const remainingInsts = await getInstallmentIds(polId);
    expect(remainingInsts).toEqual([baseInst]); // solo la cuota base sobrevive
  });
});

// ── Caso E — cuota pagada ──────────────────────────────────────────────────────

describe("Caso E — cuota pagada bloquea el borrado", () => {
  test("DELETE → 409, rebilling y cuotas permanecen", async () => {
    const polId = await mkPolicy({ num: `${PREFIX}-E001`, companyId: coElNorteId, startDate: "2027-01-01" });
    const rebId = await mkRebilling(polId, "2027-05-01", "2027-06-01", 500);
    await mkInstallment(polId, 1, "2027-05-01", 500, { rebillingId: rebId, status: "pagada" });

    const res = await callDelete(rebId);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("No se puede eliminar la refacturación porque tiene cuotas pagadas, rendidas o con movimientos asociados.");

    expect(await db.select().from(rebillings).where(eq(rebillings.id, rebId)).get()).toBeDefined();
    expect((await getInstallmentIds(polId)).length).toBe(1);
  });
});

// ── Caso F — cuota rendida ─────────────────────────────────────────────────────

describe("Caso F — cuota rendida bloquea el borrado", () => {
  test("DELETE → 409", async () => {
    const polId = await mkPolicy({ num: `${PREFIX}-F001`, companyId: coElNorteId, startDate: "2027-01-01" });
    const rebId = await mkRebilling(polId, "2027-05-01", "2027-06-01", 500);
    await mkInstallment(polId, 1, "2027-05-01", 500, { rebillingId: rebId, rendered: 1 });

    const res = await callDelete(rebId);
    expect(res.status).toBe(409);
  });
});

// ── Caso G — payment asociado ──────────────────────────────────────────────────

describe("Caso G — cuota con payment asociado bloquea el borrado", () => {
  test("DELETE → 409", async () => {
    const polId = await mkPolicy({ num: `${PREFIX}-G001`, companyId: coElNorteId, startDate: "2027-01-01" });
    const rebId = await mkRebilling(polId, "2027-05-01", "2027-06-01", 500);
    const instId = await mkInstallment(polId, 1, "2027-05-01", 500, { rebillingId: rebId });

    const [pay] = await db.insert(payments).values({
      policyId: polId, amount: 500, paymentMethod: "efectivo", paymentDate: "2027-05-02",
      installmentId: instId, createdBy: userId,
    }).returning({ id: payments.id });
    paymentIdsToClean.push(pay!.id);

    const res = await callDelete(rebId);
    expect(res.status).toBe(409);

    expect(await db.select().from(rebillings).where(eq(rebillings.id, rebId)).get()).toBeDefined();
  });
});

// ── Caso H — remittance_item asociado ─────────────────────────────────────────

describe("Caso H — cuota referenciada en remittance_items bloquea el borrado", () => {
  test("DELETE → 409", async () => {
    const polId = await mkPolicy({ num: `${PREFIX}-H001`, companyId: coElNorteId, startDate: "2027-01-01" });
    const rebId = await mkRebilling(polId, "2027-05-01", "2027-06-01", 500);
    const instId = await mkInstallment(polId, 1, "2027-05-01", 500, { rebillingId: rebId });

    const [rem] = await db.insert(remittances).values({
      date: "2027-05-03", canal: "efectivo", createdBy: userId,
    }).returning({ id: remittances.id });
    remittanceIdsToClean.push(rem!.id);

    const [item] = await db.insert(remittanceItems).values({
      remittanceId: rem!.id, source: "installment", sourceId: instId, amount: 500,
    }).returning({ id: remittanceItems.id });
    remittanceItemIdsToClean.push(item!.id);

    const res = await callDelete(rebId);
    expect(res.status).toBe(409);

    expect(await db.select().from(rebillings).where(eq(rebillings.id, rebId)).get()).toBeDefined();
  });
});

// ── Caso I — rebilling histórico sin cuotas vinculadas ────────────────────────

describe("Caso I — rebilling histórico sin cuotas vinculadas", () => {
  test("DELETE → 200, elimina solo el rebilling; no toca cuotas con rebilling_id null", async () => {
    const polId = await mkPolicy({ num: `${PREFIX}-I001`, companyId: coElNorteId, startDate: "2027-01-01" });
    const baseInst = await mkInstallment(polId, 1, "2027-05-15", 500); // cuota "histórica" sin vínculo, cae en rango de fechas del rebilling
    const rebId = await mkRebilling(polId, "2027-05-01", "2027-06-01", 500);

    const res = await callDelete(rebId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toEqual({ rebilling: 1, installments: 0 });

    // La cuota histórica (rebilling_id null) no debe haberse tocado, aunque su fecha caiga en el rango
    const remaining = await db.select().from(policyInstallments).where(eq(policyInstallments.id, baseInst)).get();
    expect(remaining).toBeDefined();
    expect(remaining!.rebillingId).toBeNull();
  });
});

// ── Caso J — id inválido ───────────────────────────────────────────────────────

describe("Caso J — id inválido", () => {
  test("id no numérico → 400", async () => {
    const res = await callDelete("abc");
    expect(res.status).toBe(400);
  });
  test("id negativo → 400", async () => {
    const res = await callDelete(-1);
    expect(res.status).toBe(400);
  });
  test("id cero → 400", async () => {
    const res = await callDelete(0);
    expect(res.status).toBe(400);
  });
});

// ── Caso K — inexistente ───────────────────────────────────────────────────────

describe("Caso K — rebilling inexistente", () => {
  test("id válido pero inexistente → 404", async () => {
    const res = await callDelete(999999999);
    expect(res.status).toBe(404);
  });
});

// ── Caso L — importadores ─────────────────────────────────────────────────────

describe("Caso L — cuotas de refacturaciones quedan con rebilling_id por importador", () => {
  test("El Norte v2 (/import/el-norte/confirm, PRORROGA sobre póliza existente)", async () => {
    const polNum = `${PREFIX}-L-EN`;
    const polId = await mkPolicy({ num: polNum, companyId: coElNorteId, startDate: "2027-01-01", endDate: "2027-05-01" });

    const payload = {
      policies: [{
        policyNumber: polNum, movType: "PRORROGA", startDate: "2027-05-01", endDate: "2027-09-01",
        premium: 90000, sumInsured: 1000000, endoso: "9", insuredName: `${PREFIX} Asegurado`,
        installments: [
          { number: 1, dueDate: "2027-05-01", amount: 30000 },
          { number: 2, dueDate: "2027-06-01", amount: 30000 },
          { number: 3, dueDate: "2027-07-01", amount: 30000 },
        ],
      }],
    };
    const res = await app.fetch(new Request("http://localhost/api/import/el-norte/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": SESSION_ID },
      body: JSON.stringify(payload),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rebillings).toBe(1);

    const reb = await db.select().from(rebillings).where(eq(rebillings.policyId, polId)).get();
    expect(reb).toBeDefined();
    const insts = await db.select().from(policyInstallments).where(eq(policyInstallments.policyId, polId)).all();
    expect(insts.length).toBe(3);
    expect(insts.every(i => i.rebillingId === reb!.id)).toBe(true);
  });

  test("Rivadavia (/import/rivadavia, PRORROGA sobre póliza existente)", async () => {
    const polNum = `${PREFIX}-L-RIV`;
    const polId = await mkPolicy({ num: polNum, companyId: coRivadaviaId, startDate: "2027-01-01", endDate: "2027-05-01" });

    const payload = {
      policies: [{
        policyNumber: polNum, movType: "PRORROGA", vehicleType: "automotor",
        startDate: "2027-05-01", endDate: "2027-09-01", premium: 8000,
        insuredName: `${PREFIX} Asegurado`,
        installments: [
          { number: 1, dueDate: "2027-05-01", amount: 4000 },
          { number: 2, dueDate: "2027-06-01", amount: 4000 },
        ],
      }],
    };
    const res = await app.fetch(new Request("http://localhost/api/import/rivadavia", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": SESSION_ID },
      body: JSON.stringify(payload),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rebillings).toBe(1);

    const reb = await db.select().from(rebillings).where(eq(rebillings.policyId, polId)).get();
    expect(reb).toBeDefined();
    const insts = await db.select().from(policyInstallments).where(eq(policyInstallments.policyId, polId)).all();
    expect(insts.length).toBe(2);
    expect(insts.every(i => i.rebillingId === reb!.id)).toBe(true);
  });

  test("Mercantil Andina no crea cuotas al importar una renovación (sin regresión)", async () => {
    const polNum = `${PREFIX}-L-MERC`;
    const polId = await mkPolicy({ num: polNum, companyId: coMercantilId, startDate: "2027-01-01", endDate: "2027-05-01" });

    const payload = {
      policies: [{
        policyNumber: polNum, movType: "RENOVACION", vehicleType: "automotor",
        startDate: "2027-05-01", endDate: "2027-09-01", premium: 4000,
        insuredName: `${PREFIX} Asegurado`,
      }],
    };
    const res = await app.fetch(new Request("http://localhost/api/import/mercantil-andina", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": SESSION_ID },
      body: JSON.stringify(payload),
    }));
    expect(res.status).toBe(200);

    const insts = await db.select().from(policyInstallments).where(eq(policyInstallments.policyId, polId)).all();
    expect(insts.length).toBe(0);
  });
});

// ── Caso M — deduplicación ─────────────────────────────────────────────────────

describe("Caso M — reimportar el mismo movimiento no duplica rebilling ni cuotas", () => {
  test("segunda llamada idéntica no crea un segundo rebilling ni un segundo set de cuotas", async () => {
    const polNum = `${PREFIX}-M001`;
    const polId = await mkPolicy({ num: polNum, companyId: coElNorteId, startDate: "2027-01-01", endDate: "2027-05-01" });

    const payload = {
      policies: [{
        policyNumber: polNum, movType: "PRORROGA", startDate: "2027-05-01", endDate: "2027-09-01",
        premium: 50000, endoso: "7", insuredName: `${PREFIX} Asegurado`,
        installments: [{ number: 1, dueDate: "2027-05-01", amount: 50000 }],
      }],
    };
    const call = () => app.fetch(new Request("http://localhost/api/import/el-norte/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": SESSION_ID },
      body: JSON.stringify(payload),
    }));

    const r1 = await call();
    expect((await r1.json()).rebillings).toBe(1);

    const r2 = await call();
    const body2 = await r2.json();
    expect(body2.rebillings).toBe(0);
    expect(body2.duplicados).toBeGreaterThanOrEqual(1);

    const rebs = await db.select().from(rebillings).where(eq(rebillings.policyId, polId)).all();
    const insts = await db.select().from(policyInstallments).where(eq(policyInstallments.policyId, polId)).all();
    expect(rebs.length).toBe(1);
    expect(insts.length).toBe(1);
    expect(insts[0]!.rebillingId).toBe(rebs[0]!.id);
  });
});

// ── Caso N — preview de backfill (función pura, sin tocar la base) ───────────

describe("Caso N — preview de backfill", () => {
  test("caso inequívoco → safe", () => {
    const installments: BackfillInstallment[] = [
      { id: 1, policyId: 100, dueDate: "2027-05-15", amount: 1000, status: "pendiente", rendered: 0 },
    ];
    const rebs: BackfillRebilling[] = [
      { id: 10, policyId: 100, billingStart: "2027-05-01", billingEnd: "2027-06-01", premium: 1000 },
    ];
    const result = classifyInstallmentsForBackfill(installments, rebs);
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("safe");
    expect(result[0]!.candidateRebillingId).toBe(10);
  });

  test("refacturación duplicada (mismo período y premio) → ambiguous", () => {
    const installments: BackfillInstallment[] = [
      { id: 1, policyId: 200, dueDate: "2027-05-15", amount: 1000, status: "pendiente", rendered: 0 },
    ];
    const rebs: BackfillRebilling[] = [
      { id: 20, policyId: 200, billingStart: "2027-05-01", billingEnd: "2027-06-01", premium: 1000 },
      { id: 21, policyId: 200, billingStart: "2027-05-01", billingEnd: "2027-06-01", premium: 1000 },
    ];
    const result = classifyInstallmentsForBackfill(installments, rebs);
    expect(result[0]!.category).toBe("ambiguous");
  });

  test("cuota base (póliza sin rebillings) → no_candidate", () => {
    const installments: BackfillInstallment[] = [
      { id: 1, policyId: 300, dueDate: "2027-01-01", amount: 500, status: "pendiente", rendered: 0 },
    ];
    const result = classifyInstallmentsForBackfill(installments, []);
    expect(result[0]!.category).toBe("no_candidate");
  });

  test("período solapado entre dos rebillings distintos → ambiguous", () => {
    const installments: BackfillInstallment[] = [
      { id: 1, policyId: 400, dueDate: "2027-05-15", amount: 500, status: "pendiente", rendered: 0 },
    ];
    const rebs: BackfillRebilling[] = [
      { id: 40, policyId: 400, billingStart: "2027-05-01", billingEnd: "2027-06-01", premium: 500 },
      { id: 41, policyId: 400, billingStart: "2027-05-10", billingEnd: "2027-06-10", premium: 700 }, // solapa, premio distinto
    ];
    const result = classifyInstallmentsForBackfill(installments, rebs);
    expect(result[0]!.category).toBe("ambiguous");
  });

  test("fecha fuera de cualquier período con rebillings existentes → no_candidate", () => {
    const installments: BackfillInstallment[] = [
      { id: 1, policyId: 500, dueDate: "2027-01-01", amount: 500, status: "pendiente", rendered: 0 },
    ];
    const rebs: BackfillRebilling[] = [
      { id: 50, policyId: 500, billingStart: "2027-05-01", billingEnd: "2027-06-01", premium: 500 },
    ];
    const result = classifyInstallmentsForBackfill(installments, rebs);
    expect(result[0]!.category).toBe("no_candidate");
  });
});
