/**
 * Tests de Etapa 4A — infraestructura de payment_batches sobre el endpoint
 * real POST /api/payment-batches y la lectura GET /api/payment-batches/:id.
 * Corre exclusivamente contra dev.db local (nunca Turso) — misma estrategia
 * de fixtures aisladas por prefijo que payments.test.ts.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, companies, insureds, policyInstallments,
  payments, paymentSplits, paymentBatches, paymentBatchSplits, cashEntries, receivedChecks,
} from "../database/schema";
import { eq, inArray, and } from "drizzle-orm";

const SESSION_ID = "test-session-batches-001";
const USER_EMAIL = "test-batches@test.local";
const PREFIX = "TEST-BATCHES";

let userId: number;
let companyId: number;
let rivadaviaCompanyId: number;
let insuredId: number;
let otherInsuredId: number;

const policyIdsToClean: number[] = [];
const paymentIdsToClean: number[] = [];
const batchIdsToClean: number[] = [];

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function mkPolicy(insured: number, company: number): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "automotor", status: "activa", companyId: company, insuredId: insured,
    startDate: "2027-01-01", endDate: "2027-12-31", isRebilling: 0, createdBy: userId,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}

async function mkInstallment(policyId: number, number: number, dueDate: string, amount: number): Promise<number> {
  const [i] = await db.insert(policyInstallments).values({
    policyId, number, dueDate, amount, status: "pendiente", rendered: 0,
  }).returning({ id: policyInstallments.id });
  return i!.id;
}

async function getInstallment(id: number) {
  return db.select().from(policyInstallments).where(eq(policyInstallments.id, id)).get();
}

async function callPost(body: Record<string, any>) {
  const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  const json = await res.json();
  if (json?.id) batchIdsToClean.push(json.id);
  return { status: res.status, body: json };
}

async function callGetBatch(id: number) {
  const res = await app.fetch(new Request(`http://localhost/api/payment-batches/${id}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

async function callPutPayment(id: number, body: Record<string, any>) {
  const res = await app.fetch(new Request(`http://localhost/api/payments/${id}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

async function getChildren(batchId: number) {
  return db.select().from(payments).where(eq(payments.batchId, batchId)).all();
}

let checkCounter = 0;
function mkCheckPayload(overrides: Record<string, any> = {}) {
  checkCounter++;
  return {
    checkNumber: `CHK-${PREFIX}-${Date.now()}-${checkCounter}`,
    bankName: `${PREFIX} Banco`,
    dueDate: "2027-06-01",
    amount: 1000,
    ...overrides,
  };
}

async function getChecksForBatch(batchId: number) {
  const splits = await db.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, batchId)).all();
  const splitIds = splits.map(s => s.id);
  if (splitIds.length === 0) return [];
  return db.select().from(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).all();
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevPols = await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prevUser.id)).all();
    const polIds = prevPols.map(p => p.id);
    if (polIds.length) {
      const payRows = await db.select({ id: payments.id }).from(payments).where(inArray(payments.policyId, polIds)).all();
      const payIds = payRows.map(r => r.id);
      const batchRows = payIds.length
        ? await db.select({ id: paymentBatches.id }).from(paymentBatches)
            .innerJoin(payments, eq(payments.batchId, paymentBatches.id))
            .where(inArray(payments.id, payIds)).all()
        : [];
      const batchIds = [...new Set(batchRows.map((r: any) => r.id))];
      if (payIds.length) await db.delete(cashEntries).where(inArray(cashEntries.paymentId, payIds)).catch(() => {});
      if (payIds.length) await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, payIds)).catch(() => {});
      if (payIds.length) await db.delete(payments).where(inArray(payments.id, payIds)).catch(() => {});
      if (batchIds.length) {
        const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).all();
        const splitIds = splitRows.map(s => s.id);
        if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).catch(() => {});
      }
      if (batchIds.length) await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).catch(() => {});
      if (batchIds.length) await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIds)).catch(() => {});
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, polIds)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, polIds)).catch(() => {});
    }
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Batches", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const existingCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = existingCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;

  const existingRivCo = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Rivadavia Co`)).get();
  rivadaviaCompanyId = existingRivCo?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Rivadavia Co` }).returning({ id: companies.id }))[0]!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado A`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
  const [ins2] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado B`, createdBy: userId }).returning({ id: insureds.id });
  otherInsuredId = ins2!.id;
});

afterAll(async () => {
  if (paymentIdsToClean.length) {
    await db.delete(cashEntries).where(inArray(cashEntries.paymentId, paymentIdsToClean)).catch(() => {});
    await db.delete(paymentSplits).where(inArray(paymentSplits.paymentId, paymentIdsToClean)).catch(() => {});
  }
  const allChildIds: number[] = [];
  if (batchIdsToClean.length) {
    const children = await db.select({ id: payments.id }).from(payments).where(inArray(payments.batchId, batchIdsToClean)).all();
    allChildIds.push(...children.map(c => c.id));
  }
  if (allChildIds.length) {
    await db.delete(cashEntries).where(inArray(cashEntries.paymentId, allChildIds)).catch(() => {});
    await db.delete(payments).where(inArray(payments.id, allChildIds)).catch(() => {});
  }
  if (paymentIdsToClean.length) await db.delete(payments).where(inArray(payments.id, paymentIdsToClean)).catch(() => {});
  if (batchIdsToClean.length) {
    const splitRows = await db.select({ id: paymentBatchSplits.id }).from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsToClean)).all();
    const splitIds = splitRows.map(s => s.id);
    if (splitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).catch(() => {});
    await db.delete(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsToClean)).catch(() => {});
    await db.delete(paymentBatches).where(inArray(paymentBatches.id, batchIdsToClean)).catch(() => {});
  }
  if (policyIdsToClean.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, policyIdsToClean)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, policyIdsToClean)).catch(() => {});
  }
  await db.delete(insureds).where(eq(insureds.createdBy, userId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

// ─── 1-3: casos válidos básicos ───────────────────────────────────────────────

describe("1. Una cuota dentro de un batch", () => {
  test("1 cuota + 1 medio → 201, batch creado", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
  });
});

describe("2. Varias cuotas de una póliza", () => {
  test("2 cuotas de la misma póliza → 201", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId, 1, "2027-01-01", 600);
    const inst2 = await mkInstallment(policyId, 2, "2027-02-01", 400);

    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }, { installmentId: inst2 }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
  });
});

describe("3. Cuotas de pólizas distintas del mismo asegurado", () => {
  test("2 pólizas del mismo insuredId → 201", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const policyB = await mkPolicy(insuredId, companyId);
    const instA = await mkInstallment(policyA, 1, "2027-01-01", 700);
    const instB = await mkInstallment(policyB, 1, "2027-01-01", 300);

    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instA }, { installmentId: instB }],
      splits: [{ method: "transferencia", amount: 1000 }],
    });
    expect(status).toBe(201);
  });
});

describe("4. Cuotas de asegurados distintos → rechazo", () => {
  test("una cuota de otro insuredId → 400, nada se crea", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const policyB = await mkPolicy(otherInsuredId, companyId);
    const instA = await mkInstallment(policyA, 1, "2027-01-01", 500);
    const instB = await mkInstallment(policyB, 1, "2027-01-01", 500);

    const before = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instA }, { installmentId: instB }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("mismo asegurado");
    const after = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    expect(after.length).toBe(before.length);
  });
});

describe("5. Cuota repetida → rechazo", () => {
  test("mismo installmentId dos veces → 400", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }, { installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("repetida");
  });
});

describe("6. Cuota ya pagada → rechazo", () => {
  test("installment.status='pagada' → 409", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    await db.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, instId));

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(409);
    expect(body.error).toContain("ya está pagada");
  });
});

describe("7. Póliza cancelada → rechazo", () => {
  test("policy.status='cancelada' → 409", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    await db.update(policies).set({ status: "cancelada" }).where(eq(policies.id, policyId));
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(409);
    expect(body.error).toContain("cancelada");
  });
});

describe("8/9. Suma de splits menor/mayor", () => {
  test("8. suma de splits menor al total → 400", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 900 }],
    });
    expect(status).toBe(400);
  });

  test("9. suma de splits mayor al total → 400", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1100 }],
    });
    expect(status).toBe(400);
  });
});

describe("10/11/12. Grupos de medios", () => {
  test("10. mixed (efectivo + transferencia_compania) → 400", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 500 }, { method: "transferencia_compania", amount: 500 }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("No se pueden combinar");
  });

  test("11. métodos propios combinados (efectivo + transferencia) → 201", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }],
    });
    expect(status).toBe(201);
  });

  test("12. métodos directos combinados (transferencia_compania + link_pago) → 201", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "transferencia_compania", amount: 700 }, { method: "link_pago", amount: 300 }],
    });
    expect(status).toBe(201);
  });
});

// ─── 13-18: guardado correcto, sin duplicar ──────────────────────────────────

describe("13-18. Persistencia correcta del batch", () => {
  test("batch guardado con totales correctos; N hijos con paymentMethod='lote' sin splits propios; el split se guarda una sola vez", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId, 1, "2027-01-01", 400);
    const inst2 = await mkInstallment(policyId, 2, "2027-02-01", 350);
    const inst3 = await mkInstallment(policyId, 3, "2027-03-01", 250);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: "cheque único para 3 cuotas",
      items: [{ installmentId: inst1 }, { installmentId: inst2 }, { installmentId: inst3 }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    expect(status).toBe(201);

    // 13. payment_batch guardado
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch).toBeDefined();
    expect(batch!.baseAmountCents).toBe(100000);
    expect(batch!.surchargeAmountCents).toBe(0);
    expect(batch!.totalReceivedCents).toBe(100000);

    // 14. N payment hijos creados
    const children = await getChildren(body.id);
    expect(children.length).toBe(3);

    // 15. hijos con paymentMethod="lote"
    expect(children.every(c => c.paymentMethod === "lote")).toBe(true);

    // 16. hijos sin payment_splits propios
    const childIds = children.map(c => c.id);
    const splitsForChildren = await db.select().from(paymentSplits).where(inArray(paymentSplits.paymentId, childIds)).all();
    expect(splitsForChildren.length).toBe(0);

    // 17/18. splits guardados una sola vez en el batch — no uno por cuota
    const batchSplits = await db.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, body.id)).all();
    expect(batchSplits.length).toBe(1); // no 3 — el cheque no se repite por cuota
    expect(batchSplits[0]!.amountCents).toBe(100000);
  });
});

// ─── 19-22: Pronto Pago ──────────────────────────────────────────────────────

describe("19-22. Pronto Pago por cuota Rivadavia", () => {
  test("19. una cuota Rivadavia, medios propios → un recargo", async () => {
    const policyId = await mkPolicy(insuredId, rivadaviaCompanyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 + 800 }], // base + 1×800
    });
    expect(status).toBe(201);
    const children = await getChildren(body.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, children[0]!.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(1);
    expect(surcharges[0]!.amount).toBe(800);
  });

  test("20. dos cuotas Rivadavia → dos recargos", async () => {
    const policyId = await mkPolicy(insuredId, rivadaviaCompanyId);
    const inst1 = await mkInstallment(policyId, 1, "2027-01-01", 600);
    const inst2 = await mkInstallment(policyId, 2, "2027-02-01", 400);

    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }, { installmentId: inst2 }],
      splits: [{ method: "efectivo", amount: 1000 + 1600 }], // base + 2×800
    });
    const children = await getChildren(body.id);
    const childIds = children.map(c => c.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(inArray(cashEntries.paymentId, childIds), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(2);
    // cada recargo apunta a un hijo distinto (trazabilidad por cuota)
    expect(new Set(surcharges.map(s => s.paymentId)).size).toBe(2);
  });

  test("21. Rivadavia + otra compañía → solo recargos Rivadavia", async () => {
    const rivPolicy = await mkPolicy(insuredId, rivadaviaCompanyId);
    const otherPolicy = await mkPolicy(insuredId, companyId);
    const rivInst = await mkInstallment(rivPolicy, 1, "2027-01-01", 600);
    const otherInst = await mkInstallment(otherPolicy, 1, "2027-01-01", 400);

    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: rivInst }, { installmentId: otherInst }],
      splits: [{ method: "efectivo", amount: 1000 + 800 }], // base + 1×800 (solo la Rivadavia)
    });
    const children = await getChildren(body.id);
    const childIds = children.map(c => c.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(inArray(cashEntries.paymentId, childIds), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(1);

    const rivChild = children.find(c => c.installmentId === rivInst)!;
    expect(surcharges[0]!.paymentId).toBe(rivChild.id);
  });

  test("22. Rivadavia con medios direct_company → cero recargos", async () => {
    const policyId = await mkPolicy(insuredId, rivadaviaCompanyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "transferencia_compania", amount: 1000 }],
    });
    const children = await getChildren(body.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, children[0]!.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(0);
  });
});

// ─── 23-25: Rollback transaccional real ──────────────────────────────────────

describe("23-25. Rollback transaccional real (tx real, no mocks)", () => {
  test("23. fallo insertando el segundo hijo revierte batch + splits + primer hijo", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId, 1, "2099-01-01", 600);
    const inst2 = await mkInstallment(policyId, 2, "2099-02-01", 400);

    const beforeBatches = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    const beforePayments = await db.select({ id: payments.id }).from(payments).all();
    const beforeBatchIds = new Set(beforeBatches.map(b => b.id));
    const beforePaymentIds = new Set(beforePayments.map(p => p.id));

    let threw = false;
    try {
      await db.transaction(async (tx) => {
        const [batch] = await tx.insert(paymentBatches).values({
          insuredId, baseAmountCents: 100000, surchargeAmountCents: 0, totalReceivedCents: 100000,
          paymentDate: "2027-01-01", status: "confirmado", createdBy: userId,
        }).returning();
        await tx.insert(paymentBatchSplits).values({ batchId: batch!.id, method: "efectivo", amountCents: 100000 });
        await tx.insert(payments).values({
          policyId, installmentId: inst1, amount: 600, paymentMethod: "lote",
          paymentDate: "2027-01-01", status: "confirmado", batchId: batch!.id, createdBy: userId,
        });
        // Segundo hijo: amount NULL viola NOT NULL — fallo real de SQLite.
        await tx.insert(payments).values({
          policyId, installmentId: inst2, amount: null as any, paymentMethod: "lote",
          paymentDate: "2027-01-01", status: "confirmado", batchId: batch!.id, createdBy: userId,
        });
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const afterBatches = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    const afterPayments = await db.select({ id: payments.id }).from(payments).all();
    expect(afterBatches.filter(b => !beforeBatchIds.has(b.id)).length).toBe(0);
    expect(afterPayments.filter(p => !beforePaymentIds.has(p.id)).length).toBe(0);

    // 25. ninguna cuota queda pagada tras el rollback
    expect((await getInstallment(inst1))?.status).toBe("pendiente");
    expect((await getInstallment(inst2))?.status).toBe("pendiente");
  });

  test("24. fallo insertando un recargo revierte batch + splits + ambos hijos", async () => {
    const policyId = await mkPolicy(insuredId, rivadaviaCompanyId);
    const inst1 = await mkInstallment(policyId, 1, "2099-01-01", 600);
    const inst2 = await mkInstallment(policyId, 2, "2099-02-01", 400);

    const beforePayments = await db.select({ id: payments.id }).from(payments).all();
    const beforePaymentIds = new Set(beforePayments.map(p => p.id));

    let threw = false;
    try {
      await db.transaction(async (tx) => {
        const [batch] = await tx.insert(paymentBatches).values({
          insuredId, baseAmountCents: 100000, surchargeAmountCents: 160000, totalReceivedCents: 260000,
          paymentDate: "2027-01-01", status: "confirmado", createdBy: userId,
        }).returning();
        await tx.insert(paymentBatchSplits).values({ batchId: batch!.id, method: "efectivo", amountCents: 260000 });
        const [child1] = await tx.insert(payments).values({
          policyId, installmentId: inst1, amount: 600, paymentMethod: "lote",
          paymentDate: "2027-01-01", status: "confirmado", batchId: batch!.id, createdBy: userId,
        }).returning();
        const [child2] = await tx.insert(payments).values({
          policyId, installmentId: inst2, amount: 400, paymentMethod: "lote",
          paymentDate: "2027-01-01", status: "confirmado", batchId: batch!.id, createdBy: userId,
        }).returning();
        await tx.insert(cashEntries).values({
          clientName: "X", amount: 800, paymentMethod: "lote", paymentDate: "2027-01-01",
          entryType: "pronto_pago_surcharge", paymentId: child1!.id, rendered: 0, createdBy: userId,
        });
        // Segundo recargo: amount NULL viola NOT NULL — fallo real de SQLite.
        await tx.insert(cashEntries).values({
          clientName: "X", amount: null as any, paymentMethod: "lote", paymentDate: "2027-01-01",
          entryType: "pronto_pago_surcharge", paymentId: child2!.id, rendered: 0, createdBy: userId,
        });
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const afterPayments = await db.select({ id: payments.id }).from(payments).all();
    expect(afterPayments.filter(p => !beforePaymentIds.has(p.id)).length).toBe(0);
    expect((await getInstallment(inst1))?.status).toBe("pendiente");
    expect((await getInstallment(inst2))?.status).toBe("pendiente");
  });
});

// ─── 26: GET del batch e integridad ──────────────────────────────────────────

describe("26. GET /api/payment-batches/:id e integridad", () => {
  test("devuelve batch, items, splits, recargos e integridad correcta", async () => {
    const policyId = await mkPolicy(insuredId, rivadaviaCompanyId);
    const inst1 = await mkInstallment(policyId, 1, "2027-01-01", 600);
    const inst2 = await mkInstallment(policyId, 2, "2027-02-01", 400);

    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }, { installmentId: inst2 }],
      splits: [{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 + 1600 }],
    });

    const { status, body } = await callGetBatch(created.id);
    expect(status).toBe(200);
    expect(body.batch.id).toBe(created.id);
    expect(body.items.length).toBe(2);
    expect(body.splits.length).toBe(2);
    expect(body.surcharges.length).toBe(2);
    expect(body.integrity).toEqual({
      baseMatchesChildren: true,
      surchargeMatchesEntries: true,
      totalMatchesBasePlusSurcharge: true,
      splitsMatchTotal: true,
      // sin splits cheque en este batch — vacuously true/vacío.
      checkSplitsHaveChecks: true,
      checkAmountsMatchSplits: true,
      checksBelongOnlyToCheckSplits: true,
      invalidCheckStatuses: [],
      possibleDuplicateChecks: [],
    });
  });
});

// ─── 27: compatibilidad histórica standalone ────────────────────────────────

describe("27. Payment standalone histórico sigue exigiendo/teniendo splits", () => {
  test("un payment sin batchId (vía POST /payments) sigue teniendo exactamente 1 split", async () => {
    const res = await app.fetch(new Request("http://localhost/api/payments", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        manualPayer: "X", manualPolicyNumber: "MAN-BATCH-27", manualCompany: "TestCo",
        amount: 500, paymentMethod: "efectivo", paymentDate: "2027-01-01",
      }),
    }));
    const created = await res.json();
    paymentIdsToClean.push(created.id);
    expect(created.batchId ?? null).toBeNull();
    const rows = await db.select().from(paymentSplits).where(eq(paymentSplits.paymentId, created.id)).all();
    expect(rows.length).toBe(1);
  });
});

// ─── 28: PUT monetario sobre hijo de batch ───────────────────────────────────

describe("28. PUT monetario sobre un hijo de batch → 409", () => {
  test("cambiar amount de un hijo de batch se rechaza con el mensaje esperado", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    const children = await getChildren(created.id);

    const { status, body } = await callPutPayment(children[0]!.id, { amount: 2000 });
    expect(status).toBe(409);
    expect(body.error).toContain("cobro múltiple");

    // no se modificó nada
    const unchanged = await db.select({ amount: payments.amount }).from(payments).where(eq(payments.id, children[0]!.id)).get();
    expect(unchanged?.amount).toBe(1000);
  });

  test("editar solo notas de un hijo de batch sigue permitido", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    const children = await getChildren(created.id);

    const { status } = await callPutPayment(children[0]!.id, { notes: "nota nueva" });
    expect(status).toBe(200);
  });

  test("DELETE de un hijo de batch → 409", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    const children = await getChildren(created.id);

    const res = await app.fetch(new Request(`http://localhost/api/payments/${children[0]!.id}`, {
      method: "DELETE", headers: authHeaders(),
    }));
    expect(res.status).toBe(409);
  });
});

// ─── 29: sin pagos parciales ──────────────────────────────────────────────────

describe("29. Sin pagos parciales — el importe por cuota siempre es el de la cuota real", () => {
  test("un 'amount' inyectado en el ítem del body se ignora — se usa installment.amount", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId, amount: 1 }], // amount espurio — debe ignorarse
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
    const children = await getChildren(body.id);
    expect(children[0]!.amount).toBe(1000); // el importe real de la cuota, no el "1" inyectado
  });
});

// ─── 30: precisión en centavos ────────────────────────────────────────────────

describe("30. Precisión exacta en centavos", () => {
  test("3 cuotas con decimales que suman exacto en centavos", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId, 1, "2027-01-01", 333.33);
    const inst2 = await mkInstallment(policyId, 2, "2027-02-01", 333.33);
    const inst3 = await mkInstallment(policyId, 3, "2027-03-01", 333.34);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }, { installmentId: inst2 }, { installmentId: inst3 }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.baseAmountCents).toBe(100000);
    expect(batch!.totalReceivedCents).toBe(100000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 4B — received_checks dentro de POST /api/payment-batches
// ═══════════════════════════════════════════════════════════════════════════

describe("23. Un cheque para varias cuotas", () => {
  test("2 cuotas + 1 split cheque + 1 cheque → 201, 1 cheque guardado", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId, 1, "2027-01-01", 600);
    const inst2 = await mkInstallment(policyId, 2, "2027-02-01", 400);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }, { installmentId: inst2 }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    expect(status).toBe(201);
    const checks = await getChecksForBatch(body.id);
    expect(checks.length).toBe(1);
    expect(checks[0]!.amountCents).toBe(100000);
  });
});

describe("24. Varios cheques para varias cuotas", () => {
  test("2 cuotas + 1 split cheque + 2 cheques que suman el total → 201", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId, 1, "2027-01-01", 600);
    const inst2 = await mkInstallment(policyId, 2, "2027-02-01", 400);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }, { installmentId: inst2 }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 600 }), mkCheckPayload({ amount: 400 })] }],
    });
    expect(status).toBe(201);
    const checks = await getChecksForBatch(body.id);
    expect(checks.length).toBe(2);
    expect(checks.reduce((s, c) => s + c.amountCents, 0)).toBe(100000);
  });
});

describe("25. Cheque + transferencia combinados", () => {
  test("split cheque con su cheque + split transferencia sin cheques → 201", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [
        { method: "cheque", amount: 600, checks: [mkCheckPayload({ amount: 600 })] },
        { method: "transferencia", amount: 400 },
      ],
    });
    expect(status).toBe(201);
    const checks = await getChecksForBatch(body.id);
    expect(checks.length).toBe(1);
    expect(checks[0]!.amountCents).toBe(60000);
  });
});

describe("26/27. Forma de checks por split", () => {
  test("26. split cheque sin checks → 400, nada se crea", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const before = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000 }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("al menos un cheque");
    const after = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    expect(after.length).toBe(before.length);
  });

  test("26. split cheque con array de checks vacío → 400", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [] }],
    });
    expect(status).toBe(400);
  });

  test("27. split no-cheque con checks → 400, nada se crea", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const before = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("no puede incluir cheques");
    const after = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    expect(after.length).toBe(before.length);
  });
});

describe("28/29. Suma de cheques contra el importe del split", () => {
  test("28. suma de cheques menor al importe del split → 400", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 900 })] }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("no coincide");
  });

  test("29. suma de cheques mayor al importe del split → 400", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1100 })] }],
    });
    expect(status).toBe(400);
  });
});

describe("30/31. Posible cheque duplicado", () => {
  test("30. mismo banco+número que un cheque ya cargado → 409 CHECK_POSSIBLE_DUPLICATE, nada nuevo se crea", async () => {
    const policyId1 = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId1, 1, "2027-01-01", 1000);
    const bankName = `${PREFIX} Banco Dup`;
    const checkNumber = `DUP-${Date.now()}`;

    const first = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
    });
    expect(first.status).toBe(201);

    const policyId2 = await mkPolicy(insuredId, companyId);
    const inst2 = await mkInstallment(policyId2, 1, "2027-01-01", 1000);
    const before = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();

    const second = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst2 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("CHECK_POSSIBLE_DUPLICATE");
    expect(Array.isArray(second.body.duplicates)).toBe(true);
    const after = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    expect(after.length).toBe(before.length);
  });

  test("31. confirmPossibleDuplicates=true permite continuar con el mismo banco+número", async () => {
    const policyId1 = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId1, 1, "2027-01-01", 1000);
    const bankName = `${PREFIX} Banco Dup2`;
    const checkNumber = `DUP2-${Date.now()}`;

    const first = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
    });
    expect(first.status).toBe(201);

    const policyId2 = await mkPolicy(insuredId, companyId);
    const inst2 = await mkInstallment(policyId2, 1, "2027-01-01", 1000);

    const second = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst2 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
      confirmPossibleDuplicates: true,
    });
    expect(second.status).toBe(201);
  });

  test("confirmPossibleDuplicates=true NO saltea otras validaciones (suma incorrecta sigue en 400)", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 900 })] }],
      confirmPossibleDuplicates: true,
    });
    expect(status).toBe(400);
  });
});

describe("32/33. Vinculación correcta de los cheques", () => {
  test("32. cada cheque apunta al batch_split correcto (no al otro split)", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [
        { method: "cheque", amount: 600, checks: [mkCheckPayload({ amount: 600 })] },
        { method: "transferencia", amount: 400 },
      ],
    });
    expect(status).toBe(201);

    const splitRows = await db.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, body.id)).all();
    const chequeSplit = splitRows.find(s => s.method === "cheque")!;
    const transferSplit = splitRows.find(s => s.method === "transferencia")!;
    const checks = await db.select().from(receivedChecks).where(eq(receivedChecks.batchSplitId, chequeSplit.id)).all();
    expect(checks.length).toBe(1);
    const checksOnTransfer = await db.select().from(receivedChecks).where(eq(receivedChecks.batchSplitId, transferSplit.id)).all();
    expect(checksOnTransfer.length).toBe(0);
  });

  test("33. ningún cheque apunta a un payment hijo — un solo cheque cubre 2 cuotas, no se duplica por cuota", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId, 1, "2027-01-01", 600);
    const inst2 = await mkInstallment(policyId, 2, "2027-02-01", 400);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }, { installmentId: inst2 }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    expect(status).toBe(201);
    const checks = await getChecksForBatch(body.id);
    expect(checks.length).toBe(1); // no 2 — el cheque no se repite por cuota
    // received_checks no tiene ninguna columna de installment/payment.
    expect((checks[0] as any).installmentId).toBeUndefined();
    expect((checks[0] as any).paymentId).toBeUndefined();
  });
});

describe("34-36. Rollback transaccional real con cheques (tx real, no mocks)", () => {
  test("34. fallo insertando el segundo cheque revierte batch + split + primer cheque", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId, 1, "2099-03-01", 1000);

    const beforeBatches = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    const beforeChecks = await db.select({ id: receivedChecks.id }).from(receivedChecks).all();
    const beforeBatchIds = new Set(beforeBatches.map(b => b.id));
    const beforeCheckIds = new Set(beforeChecks.map(c => c.id));

    let threw = false;
    try {
      await db.transaction(async (tx) => {
        const [batch] = await tx.insert(paymentBatches).values({
          insuredId, baseAmountCents: 100000, surchargeAmountCents: 0, totalReceivedCents: 100000,
          paymentDate: "2027-01-01", status: "confirmado", createdBy: userId,
        }).returning();
        const [split] = await tx.insert(paymentBatchSplits).values({
          batchId: batch!.id, method: "cheque", amountCents: 100000,
        }).returning();
        await tx.insert(receivedChecks).values({
          batchSplitId: split!.id, checkNumber: "R1", bankName: `${PREFIX} RB`, dueDate: "2027-06-01",
          amountCents: 50000, receivedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
        });
        // Segundo cheque: amountCents NULL viola NOT NULL — fallo real de SQLite.
        await tx.insert(receivedChecks).values({
          batchSplitId: split!.id, checkNumber: "R2", bankName: `${PREFIX} RB`, dueDate: "2027-06-01",
          amountCents: null as any, receivedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
        });
        await tx.insert(payments).values({
          policyId, installmentId: inst1, amount: 1000, paymentMethod: "lote",
          paymentDate: "2027-01-01", status: "confirmado", batchId: batch!.id, createdBy: userId,
        });
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const afterBatches = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    const afterChecks = await db.select({ id: receivedChecks.id }).from(receivedChecks).all();
    expect(afterBatches.filter(b => !beforeBatchIds.has(b.id)).length).toBe(0);
    expect(afterChecks.filter(c => !beforeCheckIds.has(c.id)).length).toBe(0);

    // 36. ninguna cuota queda pagada tras el rollback
    expect((await getInstallment(inst1))?.status).toBe("pendiente");
  });

  test("35. fallo insertando el payment hijo DESPUÉS de insertar los cheques revierte batch + split + cheques", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId, 1, "2099-04-01", 1000);

    const beforeChecks = await db.select({ id: receivedChecks.id }).from(receivedChecks).all();
    const beforeCheckIds = new Set(beforeChecks.map(c => c.id));

    let threw = false;
    try {
      await db.transaction(async (tx) => {
        const [batch] = await tx.insert(paymentBatches).values({
          insuredId, baseAmountCents: 100000, surchargeAmountCents: 0, totalReceivedCents: 100000,
          paymentDate: "2027-01-01", status: "confirmado", createdBy: userId,
        }).returning();
        const [split] = await tx.insert(paymentBatchSplits).values({
          batchId: batch!.id, method: "cheque", amountCents: 100000,
        }).returning();
        await tx.insert(receivedChecks).values({
          batchSplitId: split!.id, checkNumber: "R3", bankName: `${PREFIX} RB2`, dueDate: "2027-06-01",
          amountCents: 100000, receivedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
        });
        // payment hijo con amount NULL — fallo real de SQLite, DESPUÉS de insertar el cheque.
        await tx.insert(payments).values({
          policyId, installmentId: inst1, amount: null as any, paymentMethod: "lote",
          paymentDate: "2027-01-01", status: "confirmado", batchId: batch!.id, createdBy: userId,
        });
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const afterChecks = await db.select({ id: receivedChecks.id }).from(receivedChecks).all();
    expect(afterChecks.filter(c => !beforeCheckIds.has(c.id)).length).toBe(0);
    expect((await getInstallment(inst1))?.status).toBe("pendiente");
  });
});

describe("37. Pronto Pago sigue correcto combinado con cheque", () => {
  test("cuota Rivadavia pagada con cheque → 1 recargo, cheque = base + recargo", async () => {
    const policyId = await mkPolicy(insuredId, rivadaviaCompanyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000 + 800, checks: [mkCheckPayload({ amount: 1800 })] }],
    });
    expect(status).toBe(201);
    const children = await getChildren(body.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, children[0]!.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(1);
    expect(surcharges[0]!.amount).toBe(800);
    const checks = await getChecksForBatch(body.id);
    expect(checks[0]!.amountCents).toBe(180000);
  });
});

describe("38. Los cheques quedan dentro del total recibido, sin sumar adicional", () => {
  test("split cheque = base + recargo; ningún importe extra se agrega por tener cheques", async () => {
    const policyId = await mkPolicy(insuredId, rivadaviaCompanyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1800, checks: [mkCheckPayload({ amount: 1000 }), mkCheckPayload({ amount: 800 })] }],
    });
    expect(status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.totalReceivedCents).toBe(180000);
    const splitRows = await db.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, body.id)).all();
    expect(splitRows.reduce((s, sp) => s + sp.amountCents, 0)).toBe(batch!.totalReceivedCents);
    const checks = await getChecksForBatch(body.id);
    expect(checks.reduce((s, c) => s + c.amountCents, 0)).toBe(splitRows[0]!.amountCents);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 4B — lecturas: GET /payment-batches/:id con checks e integrity
// ═══════════════════════════════════════════════════════════════════════════

describe("39/40. GET /api/payment-batches/:id incluye checks e integrity limpio", () => {
  test("batch con split cheque → splits[].checks presente, integrity todo en true, sin duplicados", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });

    const { status, body } = await callGetBatch(created.id);
    expect(status).toBe(200);
    const chequeSplit = body.splits.find((s: any) => s.method === "cheque");
    expect(chequeSplit.checks.length).toBe(1);
    expect(body.integrity.checkSplitsHaveChecks).toBe(true);
    expect(body.integrity.checkAmountsMatchSplits).toBe(true);
    expect(body.integrity.checksBelongOnlyToCheckSplits).toBe(true);
    expect(body.integrity.invalidCheckStatuses).toEqual([]);
    expect(body.integrity.possibleDuplicateChecks).toEqual([]);
  });
});

describe("41. GET detecta inconsistencia creada por fixture controlado", () => {
  test("un cheque re-vinculado (a mano) a un split no-cheque rompe checksBelongOnlyToCheckSplits", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId, 1, "2027-01-01", 600);
    const inst2 = await mkInstallment(policyId, 2, "2027-02-01", 400);

    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }, { installmentId: inst2 }],
      splits: [
        { method: "cheque", amount: 600, checks: [mkCheckPayload({ amount: 600 })] },
        { method: "transferencia", amount: 400 },
      ],
    });

    const splitRows = await db.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, created.id)).all();
    const chequeSplit = splitRows.find(s => s.method === "cheque")!;
    const transferSplit = splitRows.find(s => s.method === "transferencia")!;
    const checks = await db.select().from(receivedChecks).where(eq(receivedChecks.batchSplitId, chequeSplit.id)).all();

    // Fixture controlado: re-apunta el cheque a un split NO cheque directo en
    // la base (nunca alcanzable por POST /payment-batches, que siempre
    // vincula un cheque al split cheque que lo trae) — ejercita que la
    // lectura detecta la inconsistencia en vez de asumirla imposible.
    await db.update(receivedChecks).set({ batchSplitId: transferSplit.id }).where(eq(receivedChecks.id, checks[0]!.id));

    const { body } = await callGetBatch(created.id);
    expect(body.integrity.checksBelongOnlyToCheckSplits).toBe(false);
    expect(body.integrity.checkSplitsHaveChecks).toBe(false); // el split cheque quedó sin cheques
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 4B — GET /api/received-checks (cartera)
// ═══════════════════════════════════════════════════════════════════════════

async function callGetReceivedChecks(query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  const res = await app.fetch(new Request(`http://localhost/api/received-checks${qs ? `?${qs}` : ""}`, { headers: authHeaders() }));
  return { status: res.status, body: await res.json() };
}

describe("42-47. Lectura de cartera GET /api/received-checks", () => {
  test("42. filtra por status", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const checks = await getChecksForBatch(created.id);

    const { status, body } = await callGetReceivedChecks({ status: "en_cartera" });
    expect(status).toBe(200);
    expect(body.some((r: any) => r.check.id === checks[0]!.id)).toBe(true);

    const { body: noneCobrado } = await callGetReceivedChecks({ status: "cobrado" });
    expect(noneCobrado.some((r: any) => r.check.id === checks[0]!.id)).toBe(false);
  });

  test("43. filtra por rango de vencimiento (dueFrom/dueTo)", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000, dueDate: "2027-08-15" })] }],
    });
    const checks = await getChecksForBatch(created.id);

    const inRange = await callGetReceivedChecks({ dueFrom: "2027-08-01", dueTo: "2027-08-31" });
    expect(inRange.body.some((r: any) => r.check.id === checks[0]!.id)).toBe(true);

    const outOfRange = await callGetReceivedChecks({ dueFrom: "2028-01-01", dueTo: "2028-12-31" });
    expect(outOfRange.body.some((r: any) => r.check.id === checks[0]!.id)).toBe(false);
  });

  test("44. filtra por banco", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const uniqueBank = `${PREFIX} BancoFiltro${Date.now()}`;
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000, bankName: uniqueBank })] }],
    });
    const checks = await getChecksForBatch(created.id);

    const { body } = await callGetReceivedChecks({ bank: uniqueBank });
    expect(body.length).toBe(1);
    expect(body[0].check.id).toBe(checks[0]!.id);
  });

  test("45. filtra por asegurado (insuredId)", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const checks = await getChecksForBatch(created.id);

    const { body: matching } = await callGetReceivedChecks({ insuredId: String(insuredId) });
    expect(matching.some((r: any) => r.check.id === checks[0]!.id)).toBe(true);

    const { body: other } = await callGetReceivedChecks({ insuredId: String(otherInsuredId) });
    expect(other.some((r: any) => r.check.id === checks[0]!.id)).toBe(false);
  });

  test("46. la respuesta trae compañías/cuotas ya resueltas (sin necesidad de otra consulta por fila)", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 1000 })] }],
    });
    const checks = await getChecksForBatch(created.id);

    const { body } = await callGetReceivedChecks({ status: "en_cartera" });
    const row = body.find((r: any) => r.check.id === checks[0]!.id);
    expect(row).toBeDefined();
    expect(row.installments.length).toBe(1);
    expect(row.installments[0].installmentId).toBe(instId);
    expect(Array.isArray(row.companies)).toBe(true);
    expect(row.insured.id).toBe(insuredId);
  });

  test("47. un batch histórico sin cheques (splits solo efectivo) sigue legible — no rompe la lectura de cartera", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);

    // No debe tirar ni incluir nada de este batch (no tiene cheques) — la
    // sola presencia de un batch sin cheques no puede romper la consulta.
    const { status: listStatus } = await callGetReceivedChecks({});
    expect(listStatus).toBe(200);
  });
});
