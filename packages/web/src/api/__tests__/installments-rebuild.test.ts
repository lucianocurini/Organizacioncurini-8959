/**
 * Tests de Subetapa 2B: clasificación y reconstrucción segura de planes de
 * cuotas existentes (classifyInstallmentsForRebuild, endpoints
 * GET/POST /policies/:id/installments/rebuild-check|rebuild).
 * Corre exclusivamente contra dev.db local (nunca Turso) — misma estrategia
 * de fixtures aisladas por prefijo que installments-generate.test.ts y
 * rebilling-installments.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments,
  payments, rebillings, remittances, remittanceItems,
} from "../database/schema";
import { eq, inArray } from "drizzle-orm";
import {
  classifyInstallmentsForRebuild,
  runInstallmentRebuildTransaction,
  RebuildConflictError,
  PolicyNotFoundError,
} from "../../lib/installments/rebuild";

const SESSION_ID = "test-session-inst-rebuild-001";
const USER_EMAIL = "test-inst-rebuild@test.local";
const PREFIX = "TEST-INST-REBUILD";

let userId: number;
let companyId: number;
let insuredId: number;
const policyIdsToClean: number[] = [];
const rebillingIdsToClean: number[] = [];
const paymentIdsToClean: number[] = [];
const remittanceIdsToClean: number[] = [];

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function mkPolicy(installmentsExpected: number | null = null): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: "activa", companyId, insuredId,
    startDate: "2027-01-01", endDate: "2027-12-31", isRebilling: 0, createdBy: userId,
    installments: installmentsExpected,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}

async function mkInstallment(policyId: number, number: number, dueDate: string, amount: number, opts: {
  status?: string; rendered?: number; rebillingId?: number | null;
} = {}): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({
    policyId, number, dueDate, amount,
    status: opts.status ?? "pendiente",
    rendered: opts.rendered ?? 0,
    rebillingId: opts.rebillingId ?? null,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

async function mkPayment(policyId: number, installmentId: number, opts: { status?: string } = {}): Promise<number> {
  const [pay] = await db.insert(payments).values({
    policyId, amount: 500, paymentMethod: "efectivo", paymentDate: "2027-02-01",
    installmentId, status: opts.status ?? "pendiente", createdBy: userId,
  }).returning({ id: payments.id });
  paymentIdsToClean.push(pay!.id);
  return pay!.id;
}

async function mkRemittanceItem(installmentId: number, amount = 500): Promise<number> {
  const [rem] = await db.insert(remittances).values({
    date: "2027-02-01", canal: "efectivo", createdBy: userId,
  }).returning({ id: remittances.id });
  remittanceIdsToClean.push(rem!.id);
  const [item] = await db.insert(remittanceItems).values({
    remittanceId: rem!.id, source: "installment", sourceId: installmentId, amount,
  }).returning({ id: remittanceItems.id });
  return item!.id;
}

async function mkRebilling(policyId: number): Promise<number> {
  const [r] = await db.insert(rebillings).values({
    policyId, billingStart: "2027-02-01", billingEnd: "2027-05-31", premium: 3000, createdBy: userId,
  }).returning({ id: rebillings.id });
  rebillingIdsToClean.push(r!.id);
  return r!.id;
}

async function getInstallments(policyId: number) {
  return db.select().from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).orderBy(policyInstallments.number).all();
}

async function callCheck(policyId: number | string) {
  const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}/installments/rebuild-check`, {
    method: "GET", headers: authHeaders(),
  }));
  return { status: res.status, body: await res.json() };
}

async function callRebuild(policyId: number | string, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/policies/${policyId}/installments/rebuild`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

const VALID_REBUILD_BODY = {
  periodStart: "2027-01-01", periodEnd: "2027-06-01",
  periodAmount: 3000, installmentCount: 3,
};

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const ids = prevPols.map(p => p.id);
    if (ids.length) {
      const instRows = await db.select({ id: policyInstallments.id }).from(policyInstallments).where(inArray(policyInstallments.policyId, ids)).all();
      const instIds = instRows.map(r => r.id);
      if (instIds.length) await db.delete(payments).where(inArray(payments.installmentId, instIds)).catch(() => {});
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, ids)).catch(() => {});
      await db.delete(rebillings).where(inArray(rebillings.policyId, ids)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, ids)).catch(() => {});
    }
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Inst Rebuild", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
});

afterAll(async () => {
  if (remittanceIdsToClean.length) {
    await db.delete(remittanceItems).where(inArray(remittanceItems.remittanceId, remittanceIdsToClean)).catch(() => {});
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
  await db.delete(insureds).where(eq(insureds.createdBy, userId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

// ─── 1-10: Clasificación ───────────────────────────────────────────────────────

describe("classifyInstallmentsForRebuild — clasificación", () => {
  test("1. póliza sin cuotas → NO_INSTALLMENTS", async () => {
    const policyId = await mkPolicy();
    const result = await classifyInstallmentsForRebuild(db, policyId);
    expect(result.classification).toBe("NO_INSTALLMENTS");
    expect(result.actualCount).toBe(0);
    expect(result.blockingInstallments).toEqual([]);
  });

  test("2. cuotas pendientes sin actividad → SAFE_TO_REBUILD", async () => {
    const policyId = await mkPolicy();
    await mkInstallment(policyId, 1, "2027-01-01", 1000);
    await mkInstallment(policyId, 2, "2027-02-01", 1000);
    const result = await classifyInstallmentsForRebuild(db, policyId);
    expect(result.classification).toBe("SAFE_TO_REBUILD");
    expect(result.blockingInstallments).toEqual([]);
  });

  test("3. status pagada → REQUIRES_MANUAL_REVIEW", async () => {
    const policyId = await mkPolicy();
    await mkInstallment(policyId, 1, "2027-01-01", 1000, { status: "pagada" });
    const result = await classifyInstallmentsForRebuild(db, policyId);
    expect(result.classification).toBe("REQUIRES_MANUAL_REVIEW");
    expect(result.blockingInstallments[0]!.reasons).toContain("La cuota está marcada como pagada.");
  });

  test("4. rendered=1 → REQUIRES_MANUAL_REVIEW", async () => {
    const policyId = await mkPolicy();
    await mkInstallment(policyId, 1, "2027-01-01", 1000, { rendered: 1 });
    const result = await classifyInstallmentsForRebuild(db, policyId);
    expect(result.classification).toBe("REQUIRES_MANUAL_REVIEW");
    expect(result.blockingInstallments[0]!.reasons).toContain("La cuota fue rendida a la compañía.");
  });

  test("5. payment vinculado → REQUIRES_MANUAL_REVIEW aunque esté pendiente o anulado", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    await mkPayment(policyId, instId, { status: "anulado" });
    const result = await classifyInstallmentsForRebuild(db, policyId);
    expect(result.classification).toBe("REQUIRES_MANUAL_REVIEW");
    expect(result.blockingInstallments[0]!.reasons).toContain("La cuota tiene un pago vinculado (payments.installmentId).");
  });

  test("6. remittance_item directo → REQUIRES_MANUAL_REVIEW", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    await mkRemittanceItem(instId);
    const result = await classifyInstallmentsForRebuild(db, policyId);
    expect(result.classification).toBe("REQUIRES_MANUAL_REVIEW");
    expect(result.blockingInstallments[0]!.reasons).toContain("La cuota tiene una rendición directa (remittance_items).");
  });

  test("7. una cuota con varios motivos → devuelve todos sin duplicados", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000, { status: "pagada", rendered: 1 });
    await mkPayment(policyId, instId);
    await mkRemittanceItem(instId);
    const result = await classifyInstallmentsForRebuild(db, policyId);
    const reasons = result.blockingInstallments[0]!.reasons;
    expect(reasons.length).toBe(new Set(reasons).size); // sin duplicados
    expect(reasons).toContain("La cuota está marcada como pagada.");
    expect(reasons).toContain("La cuota fue rendida a la compañía.");
    expect(reasons).toContain("La cuota tiene un pago vinculado (payments.installmentId).");
    expect(reasons).toContain("La cuota tiene una rendición directa (remittance_items).");
  });

  test("vencida sin actividad → SAFE_TO_REBUILD (vencida no es un motivo bloqueante por sí sola)", async () => {
    const policyId = await mkPolicy();
    await mkInstallment(policyId, 1, "2020-01-01", 1000, { status: "vencida" });
    const result = await classifyInstallmentsForRebuild(db, policyId);
    expect(result.classification).toBe("SAFE_TO_REBUILD");
    expect(result.blockingInstallments).toEqual([]);
  });

  test("status desconocido → REQUIRES_MANUAL_REVIEW (fail-closed: solo pendiente/vencida se consideran seguros)", async () => {
    const policyId = await mkPolicy();
    await mkInstallment(policyId, 1, "2027-01-01", 1000, { status: "estado_inventado" });
    const result = await classifyInstallmentsForRebuild(db, policyId);
    expect(result.classification).toBe("REQUIRES_MANUAL_REVIEW");
    expect(result.blockingInstallments[0]!.reasons).toContain('Estado de cuota no reconocido: "estado_inventado".');
  });

  test("status desconocido combinado con otro motivo → devuelve ambos una sola vez", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000, { status: "estado_inventado" });
    await mkPayment(policyId, instId);
    const result = await classifyInstallmentsForRebuild(db, policyId);
    const reasons = result.blockingInstallments[0]!.reasons;
    expect(reasons.length).toBe(2);
    expect(reasons.length).toBe(new Set(reasons).size); // sin duplicados
    expect(reasons).toContain('Estado de cuota no reconocido: "estado_inventado".');
    expect(reasons).toContain("La cuota tiene un pago vinculado (payments.installmentId).");
  });

  test("policyId inexistente → PolicyNotFoundError (no se confunde con NO_INSTALLMENTS)", async () => {
    const bogusId = 999999999;
    let error: unknown = null;
    try {
      await classifyInstallmentsForRebuild(db, bogusId);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PolicyNotFoundError);
    expect((error as PolicyNotFoundError).policyId).toBe(bogusId);
  });

  test("8. expectedCount distinto del real → mismatched true", async () => {
    const policyId = await mkPolicy(5);
    await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const result = await classifyInstallmentsForRebuild(db, policyId);
    expect(result.expectedCount).toBe(5);
    expect(result.actualCount).toBe(1);
    expect(result.mismatched).toBe(true);
  });

  test("9. expectedCount null → no bloquea y mismatched es siempre false", async () => {
    const policyId = await mkPolicy(null);
    await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const result = await classifyInstallmentsForRebuild(db, policyId);
    expect(result.expectedCount).toBeNull();
    expect(result.mismatched).toBe(false);
    expect(result.classification).toBe("SAFE_TO_REBUILD");
  });

  test("10. aislamiento: actividad de otra póliza no afecta la consultada", async () => {
    const policyA = await mkPolicy();
    const policyB = await mkPolicy();
    await mkInstallment(policyA, 1, "2027-01-01", 1000);
    const instB = await mkInstallment(policyB, 1, "2027-01-01", 1000, { status: "pagada" });
    await mkPayment(policyB, instB);

    const resultA = await classifyInstallmentsForRebuild(db, policyA);
    expect(resultA.classification).toBe("SAFE_TO_REBUILD");

    const resultB = await classifyInstallmentsForRebuild(db, policyB);
    expect(resultB.classification).toBe("REQUIRES_MANUAL_REVIEW");
  });

  test("23. cuota con rebillingId bloquea la reconstrucción (Opción A)", async () => {
    const policyId = await mkPolicy();
    const rebId = await mkRebilling(policyId);
    await mkInstallment(policyId, 1, "2027-02-01", 1000, { rebillingId: rebId });
    const result = await classifyInstallmentsForRebuild(db, policyId);
    expect(result.classification).toBe("REQUIRES_MANUAL_REVIEW");
    expect(result.blockingInstallments[0]!.reasons.some(r => r.includes("refacturación"))).toBe(true);
  });
});

// ─── 11-22, 24: Endpoints de consulta y reconstrucción ────────────────────────

describe("GET /policies/:id/installments/rebuild-check", () => {
  test("404 si la póliza no existe", async () => {
    const { status } = await callCheck(999999999);
    expect(status).toBe(404);
  });

  test("400 si el id es inválido", async () => {
    const { status } = await callCheck("abc");
    expect(status).toBe(400);
  });

  test("devuelve el resultado completo de la clasificación", async () => {
    const policyId = await mkPolicy();
    await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { status, body } = await callCheck(policyId);
    expect(status).toBe(200);
    expect(body).toEqual({
      classification: "SAFE_TO_REBUILD",
      expectedCount: null,
      actualCount: 1,
      mismatched: false,
      blockingInstallments: [],
    });
  });
});

describe("POST /policies/:id/installments/rebuild", () => {
  test("11. NO_INSTALLMENTS genera el plan correctamente", async () => {
    const policyId = await mkPolicy();
    const { status, body } = await callRebuild(policyId, VALID_REBUILD_BODY);
    expect(status).toBe(200);
    expect(body.rebuilt).toBe(true);
    expect(body.previousCount).toBe(0);
    expect(body.insertedCount).toBe(3);
    expect(body.installments.length).toBe(3);
  });

  test("12. SAFE_TO_REBUILD reemplaza todas las cuotas seguras", async () => {
    const policyId = await mkPolicy();
    await mkInstallment(policyId, 1, "2020-01-01", 999);
    await mkInstallment(policyId, 2, "2020-02-01", 999);

    const { status, body } = await callRebuild(policyId, VALID_REBUILD_BODY);
    expect(status).toBe(200);
    expect(body.previousCount).toBe(2);

    const rows = await getInstallments(policyId);
    expect(rows.length).toBe(3);
    expect(rows.every(r => r.dueDate !== "2020-01-01" && r.dueDate !== "2020-02-01")).toBe(true);
  });

  test("13. sincroniza policies.installments con la cantidad real insertada", async () => {
    const policyId = await mkPolicy();
    await callRebuild(policyId, VALID_REBUILD_BODY);
    const pol = await db.select({ installments: policies.installments }).from(policies).where(eq(policies.id, policyId)).get();
    expect(pol?.installments).toBe(3);
  });

  test("respuesta de éxito distingue previousExpectedCount (valor previo) de newExpectedCount (valor sincronizado)", async () => {
    const policyId = await mkPolicy(2); // policies.installments = 2 antes del rebuild
    await mkInstallment(policyId, 1, "2027-01-01", 1500);
    await mkInstallment(policyId, 2, "2027-02-01", 1500);

    const { status, body } = await callRebuild(policyId, VALID_REBUILD_BODY); // plan nuevo de 3 cuotas
    expect(status).toBe(200);
    expect(body.previousCount).toBe(2);
    expect(body.insertedCount).toBe(3);
    expect(body.previousExpectedCount).toBe(2); // lo que decía policies.installments ANTES
    expect(body.newExpectedCount).toBe(3);       // lo que quedó sincronizado DESPUÉS
    expect(body.expectedCount).toBeUndefined();  // el nombre ambiguo anterior ya no se expone
  });

  test("14. conserva el total exacto en centavos", async () => {
    const policyId = await mkPolicy();
    const { body } = await callRebuild(policyId, { ...VALID_REBUILD_BODY, periodAmount: 1000, installmentCount: 3 });
    const totalCents = body.installments.reduce((s: number, i: any) => s + Math.round(i.amount * 100), 0);
    expect(totalCents).toBe(100000);
  });

  test("15. no crea fechas fuera de periodEnd", async () => {
    const policyId = await mkPolicy();
    const { body } = await callRebuild(policyId, VALID_REBUILD_BODY);
    expect(body.installments.every((i: any) => i.dueDate <= VALID_REBUILD_BODY.periodEnd)).toBe(true);
  });

  test("16. body inválido devuelve 400 y no modifica nada", async () => {
    const policyId = await mkPolicy();
    await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const before = await getInstallments(policyId);

    const { status, body } = await callRebuild(policyId, { ...VALID_REBUILD_BODY, installmentCount: -1 });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();

    const after = await getInstallments(policyId);
    expect(after).toEqual(before);
  });

  test("17. plan que no entra en el período devuelve 400 y no modifica nada", async () => {
    const policyId = await mkPolicy();
    await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const before = await getInstallments(policyId);

    const { status } = await callRebuild(policyId, {
      periodStart: "2027-01-01", periodEnd: "2027-02-01", periodAmount: 3000, installmentCount: 6,
    });
    expect(status).toBe(400);

    const after = await getInstallments(policyId);
    expect(after).toEqual(before);
  });

  test("18. cuota pagada devuelve 409 y no modifica nada", async () => {
    const policyId = await mkPolicy();
    await mkInstallment(policyId, 1, "2027-01-01", 1000, { status: "pagada" });
    const before = await getInstallments(policyId);

    const { status, body } = await callRebuild(policyId, VALID_REBUILD_BODY);
    expect(status).toBe(409);
    expect(body.blockingInstallments.length).toBe(1);

    const after = await getInstallments(policyId);
    expect(after).toEqual(before);
  });

  test("19. payment vinculado devuelve 409", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    await mkPayment(policyId, instId);

    const { status, body } = await callRebuild(policyId, VALID_REBUILD_BODY);
    expect(status).toBe(409);
    expect(body.blockingInstallments[0].reasons).toContain("La cuota tiene un pago vinculado (payments.installmentId).");
  });

  test("20. rendición directa devuelve 409", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    await mkRemittanceItem(instId);

    const { status, body } = await callRebuild(policyId, VALID_REBUILD_BODY);
    expect(status).toBe(409);
    expect(body.blockingInstallments[0].reasons).toContain("La cuota tiene una rendición directa (remittance_items).");
  });

  test("22. no toca cuotas de otras pólizas", async () => {
    const policyA = await mkPolicy();
    const policyB = await mkPolicy();
    await mkInstallment(policyA, 1, "2027-01-01", 111);
    await mkInstallment(policyB, 1, "2027-01-01", 222);

    await callRebuild(policyA, VALID_REBUILD_BODY);

    const rowsB = await getInstallments(policyB);
    expect(rowsB.length).toBe(1);
    expect(rowsB[0]!.amount).toBe(222);
  });

  test("23. cuota con rebillingId devuelve 409 (no pierde la refacturación silenciosamente)", async () => {
    const policyId = await mkPolicy();
    const rebId = await mkRebilling(policyId);
    await mkInstallment(policyId, 1, "2027-02-01", 1000, { rebillingId: rebId });

    const { status, body } = await callRebuild(policyId, VALID_REBUILD_BODY);
    expect(status).toBe(409);
    expect(body.blockingInstallments[0].reasons.some((r: string) => r.includes("refacturación"))).toBe(true);
  });

  // ─── Migración 0034 — seguridad de reconstrucción del plan de emisión ─────
  describe("importe contado vs. nuevo nominal", () => {
    test("contado ya cargado mayor al NUEVO nominal: rechaza, plan anterior y contado quedan intactos", async () => {
      const policyId = await mkPolicy();
      const initial = await callRebuild(policyId, VALID_REBUILD_BODY); // nominal $3000
      expect(initial.status).toBe(200);
      await db.update(policies).set({ cashPaymentAmountCents: 300000 }).where(eq(policies.id, policyId)); // $3000, == nominal actual

      // Reconstruir a un plan más chico ($2000) — el contado ya cargado
      // ($3000) quedaría mayor al nuevo nominal.
      const rebuilt = await callRebuild(policyId, { periodStart: "2027-01-01", periodEnd: "2027-06-01", periodAmount: 2000, installmentCount: 2 });
      expect(rebuilt.status).toBe(409);
      expect(rebuilt.body.error).toContain("no puede ser mayor a la suma nominal");

      // El plan anterior (3 cuotas, $3000) sigue exactamente igual — nunca se
      // llegó a borrar nada.
      const rows = await getInstallments(policyId);
      expect(rows.length).toBe(3);
      const pol = await db.select({ cashPaymentAmountCents: policies.cashPaymentAmountCents, installments: policies.installments })
        .from(policies).where(eq(policies.id, policyId)).get();
      expect(pol?.cashPaymentAmountCents).toBe(300000); // intacto, nunca se tocó
      expect(pol?.installments).toBe(3); // tampoco se tocó
    });

    test("contado ya cargado igual o menor al nuevo nominal: el rebuild funciona igual que antes", async () => {
      const policyId = await mkPolicy();
      await callRebuild(policyId, VALID_REBUILD_BODY); // nominal $3000
      await db.update(policies).set({ cashPaymentAmountCents: 150000 }).where(eq(policies.id, policyId)); // $1500 < $3000

      // Reconstruir a un plan más grande ($4000) — el contado ($1500) sigue
      // siendo válido contra el nuevo nominal, mayor.
      const rebuilt = await callRebuild(policyId, { periodStart: "2027-01-01", periodEnd: "2027-06-01", periodAmount: 4000, installmentCount: 4 });
      expect(rebuilt.status).toBe(200);
      const pol = await db.select({ cashPaymentAmountCents: policies.cashPaymentAmountCents })
        .from(policies).where(eq(policies.id, policyId)).get();
      expect(pol?.cashPaymentAmountCents).toBe(150000); // el rebuild no lo toca, sigue siendo válido
    });

    test("sin contado cargado (null): el rebuild funciona sin cambios de comportamiento", async () => {
      const policyId = await mkPolicy();
      await callRebuild(policyId, VALID_REBUILD_BODY);
      const rebuilt = await callRebuild(policyId, { periodStart: "2027-01-01", periodEnd: "2027-06-01", periodAmount: 2000, installmentCount: 2 });
      expect(rebuilt.status).toBe(200);
    });
  });
});

// ─── 21, 24: pruebas directas de la transacción (tx real, sin pasar por HTTP) ──

describe("runInstallmentRebuildTransaction — transacción", () => {
  test("21. fallo real durante la inserción provoca rollback completo (cuotas, policies.installments y ausencia de filas parciales)", async () => {
    const policyId = await mkPolicy(2); // expectedCount previo conocido, para poder comprobar que no cambia
    await mkInstallment(policyId, 1, "2027-01-01", 1000);
    await mkInstallment(policyId, 2, "2027-02-01", 1000);
    const installmentsBefore = await getInstallments(policyId);
    const policyBefore = await db.select({ installments: policies.installments }).from(policies).where(eq(policies.id, policyId)).get();
    expect(policyBefore?.installments).toBe(2);

    // Plan fabricado con un amount inválido (viola NOT NULL de policy_installments.amount)
    // para forzar un error real de la base de datos durante el INSERT, sin pasar por
    // buildInstallmentPlan (que nunca produciría una fila así). Se usa la transacción
    // real de libSQL (db.transaction), no un mock de tx — el rollback lo hace el motor,
    // no una simulación.
    const brokenPlan = {
      installments: [{ number: 1, dueDate: "2027-03-01", amount: null as any }],
      totalAmount: 0,
      warnings: [],
    };

    let threw = false;
    try {
      await db.transaction(async (tx) =>
        runInstallmentRebuildTransaction(tx, policyId, brokenPlan, {
          periodStart: "2027-01-01", periodEnd: "2027-06-01", periodAmount: 0,
        })
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // 1. Las cuotas anteriores siguen existiendo, con el mismo contenido exacto
    //    (mismos ids, fechas, importes — no solo la misma cantidad).
    const installmentsAfter = await getInstallments(policyId);
    expect(installmentsAfter).toEqual(installmentsBefore);
    expect(installmentsAfter.length).toBe(2);

    // 2. No quedó ninguna fila nueva ni inserción parcial: el total de cuotas de
    //    la póliza sigue siendo exactamente 2 (ni una fila rota, ni una fila de más).
    const allForPolicy = await db.select({ id: policyInstallments.id }).from(policyInstallments)
      .where(eq(policyInstallments.policyId, policyId)).all();
    expect(allForPolicy.length).toBe(2);

    // 3. policies.installments conserva exactamente el valor anterior — el
    //    tx.update(policies, ...) nunca llegó a confirmarse porque el INSERT
    //    que lo precede en la misma transacción falló antes.
    const policyAfter = await db.select({ installments: policies.installments }).from(policies).where(eq(policies.id, policyId)).get();
    expect(policyAfter?.installments).toBe(2);
  });

  test("24. la reclasificación con `tx` es la única autorización efectiva para borrar (no es un test de concurrencia real)", async () => {
    // Este test NO ejercita transacciones concurrentes de verdad — Bun corre los
    // tests secuencialmente, y el `payment` de abajo se inserta y confirma antes
    // de que se abra la transacción de rebuild. Lo que demuestra es una propiedad
    // más simple pero igual de importante: el precheck hecho fuera de la
    // transacción (en index.ts, antes de abrir `db.transaction`) es puramente
    // informativo — sirve para responder 409 rápido, pero no autoriza nada. La
    // única autorización real para borrar es la llamada a
    // classifyInstallmentsForRebuild(tx, ...) que runInstallmentRebuildTransaction
    // hace con el cliente transaccional, inmediatamente antes del DELETE. Si el
    // estado cambió desde el precheck, esta relectura lo detecta y aborta antes
    // de borrar nada — sin importar lo que haya visto el precheck.
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    // Precheck (fuera de la tx) vería SAFE_TO_REBUILD en este momento.
    const precheck = await classifyInstallmentsForRebuild(db, policyId);
    expect(precheck.classification).toBe("SAFE_TO_REBUILD");

    // Actividad que aparece recién ahora — simula (secuencialmente, no en
    // paralelo) que el estado cambió entre el precheck y la apertura de la
    // transacción de escritura.
    await mkPayment(policyId, instId);

    const plan = { installments: [{ number: 1, dueDate: "2027-03-01", amount: 1000 }], totalAmount: 1000, warnings: [] };

    let conflict: RebuildConflictError | null = null;
    try {
      await db.transaction(async (tx) =>
        runInstallmentRebuildTransaction(tx, policyId, plan, {
          periodStart: "2027-01-01", periodEnd: "2027-06-01", periodAmount: 1000,
        })
      );
    } catch (e) {
      conflict = e as RebuildConflictError;
    }

    expect(conflict).toBeInstanceOf(RebuildConflictError);
    expect(conflict!.blockingInstallments.length).toBe(1);

    // La cuota original sigue intacta — el borrado nunca llegó a ejecutarse,
    // pese a que el precheck (ya desactualizado) había dado SAFE_TO_REBUILD.
    const rows = await getInstallments(policyId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(instId);
  });
});
