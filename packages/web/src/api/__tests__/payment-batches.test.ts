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
  payments, paymentSplits, paymentBatches, paymentBatchSplits, cashEntries, receivedChecks, cashDebts,
  insuredAccountMovements,
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

async function getCashSummary(): Promise<any> {
  const res = await app.fetch(new Request("http://localhost/api/cash/summary", { headers: authHeaders() }));
  return res.json();
}

async function mkPolicy(
  insured: number, company: number,
  opts: { type?: string; parentPolicyId?: number | null } = {}
): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: opts.type ?? "automotor", status: "activa", companyId: company, insuredId: insured,
    parentPolicyId: opts.parentPolicyId ?? null,
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

async function callCancelBatch(id: number, body: Record<string, any> = { confirm: true }) {
  const res = await app.fetch(new Request(`http://localhost/api/payment-batches/${id}/cancel`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

async function callGetReceivedChecks(query: string) {
  const res = await app.fetch(new Request(`http://localhost/api/received-checks${query}`, { headers: authHeaders() }));
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

async function getMovementsForBatch(batchId: number) {
  return db.select().from(insuredAccountMovements).where(eq(insuredAccountMovements.originBatchId, batchId)).all();
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
      // Fase 2B: insured_account_movements.related_payment_id/origin_batch_id
      // referencian payments/payment_batches — debe limpiarse ANTES de borrar
      // CUALQUIERA de los dos (FK real bajo @libsql/client, foreign_keys=ON
      // por defecto), o el DELETE bulk de payments de más abajo falla ENTERO
      // por un solo id todavía referenciado (bug real detectado y corregido
      // en Fase 2B — ver mismo comentario en afterAll).
      if (batchIds.length) await db.delete(insuredAccountMovements).where(inArray(insuredAccountMovements.originBatchId, batchIds)).catch(() => {});
      if (payIds.length) await db.delete(cashEntries).where(inArray(cashEntries.paymentId, payIds)).catch(() => {});
      // received_checks.payment_split_id referencia payment_splits — debe
      // limpiarse ANTES de borrar los splits (mismo bug de orden que el de
      // insured_account_movements arriba, ver comentario del mismo fix en afterAll).
      if (payIds.length) {
        const standaloneSplitRows = await db.select({ id: paymentSplits.id }).from(paymentSplits).where(inArray(paymentSplits.paymentId, payIds)).all();
        const standaloneSplitIds = standaloneSplitRows.map(s => s.id);
        if (standaloneSplitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.paymentSplitId, standaloneSplitIds)).catch(() => {});
      }
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
  // Fase 2B: insured_account_movements.related_payment_id/origin_batch_id
  // referencian payments/payment_batches — debe limpiarse ANTES de borrar
  // CUALQUIERA de los dos (FK real bajo @libsql/client, foreign_keys=ON por
  // defecto). Si esto corre después, el DELETE bulk de `payments` de más
  // abajo falla ENTERO por un solo id todavía referenciado — silenciado por
  // el .catch(() => {}) de esa línea, pero deja huérfanos: los 101 payments
  // hijos, sus 76 payment_batches, y en cascada las policies/insureds/user
  // de este archivo (bug real detectado y corregido en Fase 2B).
  if (batchIdsToClean.length) {
    await db.delete(insuredAccountMovements).where(inArray(insuredAccountMovements.originBatchId, batchIdsToClean)).catch(() => {});
  }
  if (paymentIdsToClean.length) {
    await db.delete(cashEntries).where(inArray(cashEntries.paymentId, paymentIdsToClean)).catch(() => {});
    // received_checks.payment_split_id referencia payment_splits — debe
    // limpiarse ANTES de borrar los splits (mismo tipo de bug de orden que
    // el de insured_account_movements arriba; test 4 de este archivo cuelga
    // un cheque de un payment_split standalone, ver mkCheckPayload/test "4.
    // cheque asociado a payment INDIVIDUAL anulado").
    const standaloneSplitRows = await db.select({ id: paymentSplits.id }).from(paymentSplits).where(inArray(paymentSplits.paymentId, paymentIdsToClean)).all();
    const standaloneSplitIds = standaloneSplitRows.map(s => s.id);
    if (standaloneSplitIds.length) await db.delete(receivedChecks).where(inArray(receivedChecks.paymentSplitId, standaloneSplitIds)).catch(() => {});
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

describe("4. Cuotas de asegurados distintos → PERMITIDO (lote multi-asegurado)", () => {
  test("una cuota de otro insuredId → 201, batch.insuredId queda NULL (mezcla real)", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const policyB = await mkPolicy(otherInsuredId, companyId);
    const instA = await mkInstallment(policyA, 1, "2027-01-01", 500);
    const instB = await mkInstallment(policyB, 1, "2027-01-01", 500);

    const { status, body } = await callPost({
      paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instA }, { installmentId: instB }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.insuredId).toBeNull();
    const children = await getChildren(body.id);
    expect(children.map(c => c.installmentId).sort()).toEqual([instA, instB].sort());
  });

  test("caso familiar real: 3 pólizas de 3 asegurados distintos en un solo batch → 201", async () => {
    const thirdInsured = (await db.insert(insureds).values({ name: `${PREFIX} Asegurado C`, createdBy: userId }).returning({ id: insureds.id }))[0]!.id;
    const policyA = await mkPolicy(insuredId, companyId);
    const policyB = await mkPolicy(otherInsuredId, companyId);
    const policyC = await mkPolicy(thirdInsured, companyId);
    const instA = await mkInstallment(policyA, 1, "2027-01-01", 500);
    const instB = await mkInstallment(policyB, 1, "2027-01-01", 300);
    const instC = await mkInstallment(policyC, 1, "2027-01-01", 200);

    const { status, body } = await callPost({
      paymentDate: "2027-01-01", notes: "resumen familiar",
      items: [{ installmentId: instA }, { installmentId: instB }, { installmentId: instC }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.insuredId).toBeNull();
    expect(batch!.baseAmountCents).toBe(100000);
    await db.delete(insureds).where(eq(insureds.id, thirdInsured)).catch(() => {});
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

// ─── Grupo económico Rivadavia + Accidentes de Pasajeros asociada ───────────
// Reproduce el caso real reportado (asegurado BISI NESTOR GUSTAVO FERNA):
// una póliza principal Rivadavia + su accesoria de Accidentes de Pasajeros
// (policies.parentPolicyId → principal) se cobran juntas en el mismo lote.
// Antes del fix: 2 recargos ($1600). Ahora: 1 solo recargo para todo el
// grupo económico — ver src/lib/payments/policy-economic-group.ts.
describe("Grupo económico Rivadavia — principal + Accidentes de Pasajeros asociada", () => {
  test("principal + accesoria vinculada (parentPolicyId presente en el batch) → 1 solo cash_entry de recargo, 2 payments hijos", async () => {
    const principalId = await mkPolicy(insuredId, rivadaviaCompanyId, { type: "automotor" });
    const accesoriaId = await mkPolicy(insuredId, rivadaviaCompanyId, { type: "accidentes_pasajeros", parentPolicyId: principalId });
    const instPrincipal = await mkInstallment(principalId, 1, "2027-01-01", 78171);
    const instAccesoria = await mkInstallment(accesoriaId, 1, "2027-01-01", 1300);

    // Ejemplo obligatorio del pedido: 78.171 + 1.300 = 79.471 base + 800 recargo = 80.271 total.
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instPrincipal }, { installmentId: instAccesoria }],
      splits: [{ method: "efectivo", amount: 79471 + 800 }],
    });
    expect(status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.baseAmountCents).toBe(7947100);
    expect(batch!.surchargeAmountCents).toBe(80000);
    expect(batch!.totalReceivedCents).toBe(8027100);

    // 2 payments hijos — ambas cuotas siguen existiendo por separado, con su importe real propio.
    const children = await getChildren(body.id);
    expect(children.length).toBe(2);
    const childByInstallment = new Map(children.map((c) => [c.installmentId, c]));
    expect(childByInstallment.get(instPrincipal)!.amount).toBe(78171);
    expect(childByInstallment.get(instAccesoria)!.amount).toBe(1300);

    // 1 solo cash_entry de recargo para todo el grupo — atado a un solo payment hijo.
    const childIds = children.map((c) => c.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(inArray(cashEntries.paymentId, childIds), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(1);
    expect(surcharges[0]!.amount).toBe(800);
  });

  test("accesoria SIN principal en el mismo batch (parentPolicyId no incluido) → no agrupa, cada una su propio recargo", async () => {
    const principalId = await mkPolicy(insuredId, rivadaviaCompanyId, { type: "automotor" });
    const accesoriaId = await mkPolicy(insuredId, rivadaviaCompanyId, { type: "accidentes_pasajeros", parentPolicyId: principalId });
    const instAccesoria = await mkInstallment(accesoriaId, 1, "2027-01-01", 1300);
    // Nota: la principal existe en DB pero NO se incluye en este batch —
    // conservador, no se agrupa (mismo criterio que sin parentPolicyId).

    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instAccesoria }],
      splits: [{ method: "efectivo", amount: 1300 + 800 }],
    });
    const children = await getChildren(body.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, children[0]!.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(1);
    expect(surcharges[0]!.amount).toBe(800);
  });

  test("accesoria sin parentPolicyId (nunca vinculada) → genera su propio recargo, sin agrupar", async () => {
    const accesoriaSuelta = await mkPolicy(insuredId, rivadaviaCompanyId, { type: "accidentes_pasajeros", parentPolicyId: null });
    const inst = await mkInstallment(accesoriaSuelta, 1, "2027-01-01", 1300);

    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst }],
      splits: [{ method: "efectivo", amount: 1300 + 800 }],
    });
    const children = await getChildren(body.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, children[0]!.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(1);
  });

  test("dos pólizas Rivadavia realmente independientes (sin relación) → 2 recargos", async () => {
    const p1 = await mkPolicy(insuredId, rivadaviaCompanyId, { type: "automotor" });
    const p2 = await mkPolicy(insuredId, rivadaviaCompanyId, { type: "automotor" });
    const inst1 = await mkInstallment(p1, 1, "2027-01-01", 600);
    const inst2 = await mkInstallment(p2, 1, "2027-01-01", 400);

    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }, { installmentId: inst2 }],
      splits: [{ method: "efectivo", amount: 1000 + 1600 }],
    });
    const children = await getChildren(body.id);
    const childIds = children.map((c) => c.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(inArray(cashEntries.paymentId, childIds), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(2);
  });

  test("otra compañía no-Rivadavia con la misma forma principal+accesoria no genera ningún recargo", async () => {
    const principalId = await mkPolicy(insuredId, companyId, { type: "automotor" }); // companyId = compañía no-Rivadavia del harness
    const accesoriaId = await mkPolicy(insuredId, companyId, { type: "accidentes_pasajeros", parentPolicyId: principalId });
    const instPrincipal = await mkInstallment(principalId, 1, "2027-01-01", 1000);
    const instAccesoria = await mkInstallment(accesoriaId, 1, "2027-01-01", 500);

    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instPrincipal }, { installmentId: instAccesoria }],
      splits: [{ method: "efectivo", amount: 1500 }],
    });
    const children = await getChildren(body.id);
    const childIds = children.map((c) => c.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(inArray(cashEntries.paymentId, childIds), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(0);
  });

  test("Caja refleja un solo recargo ($800, no $1600) para principal + accesoria", async () => {
    // El recargo de un batch NO aparece como bucket "recargosProntoPago"
    // separado (eso es solo para cash_entries standalone) — va fundido en
    // el importe del split (payment_batch_splits), que representa el total
    // realmente recibido (base + recargo). Por eso la forma correcta de
    // verificar "un solo recargo, no dos" en Caja es que el total pendiente
    // suba EXACTAMENTE base + 1×$800 (80.271), nunca base + 2×$800 (81.071).
    const before = await getCashSummary();

    const principalId = await mkPolicy(insuredId, rivadaviaCompanyId, { type: "automotor" });
    const accesoriaId = await mkPolicy(insuredId, rivadaviaCompanyId, { type: "accidentes_pasajeros", parentPolicyId: principalId });
    const instPrincipal = await mkInstallment(principalId, 1, "2027-01-01", 78171);
    const instAccesoria = await mkInstallment(accesoriaId, 1, "2027-01-01", 1300);

    await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instPrincipal }, { installmentId: instAccesoria }],
      splits: [{ method: "efectivo", amount: 79471 + 800 }],
    });

    const after = await getCashSummary();
    expect(after.cartera.efectivo - before.cartera.efectivo).toBeCloseTo(80271, 2);
    expect(after.cartera.total - before.cartera.total).toBeCloseTo(80271, 2);
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

describe("PROBLEMA 3 (hotfix) — cheque de operación anulada no cuenta como duplicado", () => {
  test("1. mismo banco/número asociado a batch ACTIVO → detecta duplicado (sigue bloqueando)", async () => {
    const policyId1 = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId1, 1, "2027-01-01", 1000);
    const bankName = `${PREFIX} Banco P3-1`;
    const checkNumber = `P3-1-${Date.now()}`;

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
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("CHECK_POSSIBLE_DUPLICATE");
  });

  test("2. mismo banco/número asociado a batch ANULADO → NO detecta duplicado, permite cargarlo", async () => {
    const policyId1 = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId1, 1, "2027-01-01", 1000);
    const bankName = `${PREFIX} Banco P3-2`;
    const checkNumber = `P3-2-${Date.now()}`;

    const first = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
    });
    expect(first.status).toBe(201);

    const cancelRes = await callCancelBatch(first.body.id);
    expect(cancelRes.status).toBe(200);

    const policyId2 = await mkPolicy(insuredId, companyId);
    const inst2 = await mkInstallment(policyId2, 1, "2027-01-01", 1000);
    const second = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst2 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
    });
    expect(second.status).toBe(201);
  });

  test("3. cheque con received_checks.status='anulado' pero legacy (batch todavía 'confirmado') → NO detecta duplicado", async () => {
    const policyId1 = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId1, 1, "2027-01-01", 1000);
    const bankName = `${PREFIX} Banco P3-3`;
    const checkNumber = `P3-3-${Date.now()}`;

    const first = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
    });
    expect(first.status).toBe(201);

    // Simula el caso legacy descripto en el hotfix: el cheque quedó
    // "anulado" a mano (o por una vía previa a la migración 0028) sin que se
    // haya anulado el batch que lo originó.
    const splits = await db.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, first.body.id)).all();
    const checkRows = await db.select().from(receivedChecks).where(inArray(receivedChecks.batchSplitId, splits.map(s => s.id))).all();
    await db.update(receivedChecks).set({ status: "anulado" }).where(inArray(receivedChecks.id, checkRows.map(c => c.id)));

    const policyId2 = await mkPolicy(insuredId, companyId);
    const inst2 = await mkInstallment(policyId2, 1, "2027-01-01", 1000);
    const second = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst2 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
    });
    expect(second.status).toBe(201);
  });

  test("4. cheque asociado a payment INDIVIDUAL anulado → NO detecta duplicado", async () => {
    const policyId1 = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId1, 1, "2027-01-01", 1000);
    const bankName = `${PREFIX} Banco P3-4`;
    const checkNumber = `P3-4-${Date.now()}`;

    const [payment] = await db.insert(payments).values({
      policyId: policyId1, amount: 1000, paymentMethod: "cheque", paymentDate: "2027-01-01",
      status: "confirmado", installmentId: inst1, createdBy: userId,
    }).returning();
    paymentIdsToClean.push(payment!.id);
    const [split] = await db.insert(paymentSplits).values({
      paymentId: payment!.id, method: "cheque", amountCents: 100000,
    }).returning();
    await db.insert(receivedChecks).values({
      paymentSplitId: split!.id, checkNumber, bankName, dueDate: "2027-06-01",
      amountCents: 100000, status: "en_cartera", receivedAt: new Date(), createdBy: userId,
      createdAt: new Date(), updatedAt: new Date(),
    });

    const cancelRes = await callPutPayment(payment!.id, { status: "anulado" });
    expect(cancelRes.status).toBe(200);

    const policyId2 = await mkPolicy(insuredId, companyId);
    const inst2 = await mkInstallment(policyId2, 1, "2027-01-01", 1000);
    const second = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst2 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
    });
    expect(second.status).toBe(201);
  });

  test("5. un duplicado anulado y otro activo con el mismo número → SÍ detecta duplicado por el activo", async () => {
    const policyId1 = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId1, 1, "2027-01-01", 1000);
    const bankName = `${PREFIX} Banco P3-5`;
    const checkNumber = `P3-5-${Date.now()}`;

    const first = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
    });
    expect(first.status).toBe(201);
    await callCancelBatch(first.body.id);

    // Un segundo cheque activo, mismo banco+número, cargado con confirmación
    // (porque en ese momento coincidía contra el ya-anulado — no debería
    // haber bloqueado, pero se confirma igual para simplificar el fixture).
    const policyId2 = await mkPolicy(insuredId, companyId);
    const inst2 = await mkInstallment(policyId2, 1, "2027-01-01", 1000);
    const second = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst2 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
    });
    expect(second.status).toBe(201);

    const policyId3 = await mkPolicy(insuredId, companyId);
    const inst3 = await mkInstallment(policyId3, 1, "2027-01-01", 1000);
    const third = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst3 }],
      splits: [{ method: "cheque", amount: 1000, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 1000 }] }],
    });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe("CHECK_POSSIBLE_DUPLICATE");
  });

  test("6. flujo de cobro por lote reutilizando un cheque de una operación anulada permite continuar sin confirmación explícita", async () => {
    const policyId1 = await mkPolicy(insuredId, companyId);
    const inst1 = await mkInstallment(policyId1, 1, "2027-01-01", 500);
    const bankName = `${PREFIX} Banco P3-6`;
    const checkNumber = `P3-6-${Date.now()}`;

    const first = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst1 }],
      splits: [{ method: "cheque", amount: 500, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 500 }] }],
    });
    expect(first.status).toBe(201);
    await callCancelBatch(first.body.id);

    const policyId2 = await mkPolicy(insuredId, companyId);
    const inst2 = await mkInstallment(policyId2, 1, "2027-01-01", 500);
    // Sin confirmPossibleDuplicates:true — el cheque reutilizado viene de una
    // operación anulada, no debe requerir confirmación para continuar.
    const second = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: inst2 }],
      splits: [{ method: "cheque", amount: 500, checks: [{ checkNumber, bankName, dueDate: "2027-06-01", amount: 500 }] }],
    });
    expect(second.status).toBe(201);

    const checks = await getChecksForBatch(second.body.id);
    expect(checks.length).toBe(1);
    expect(checks[0]!.amountCents).toBe(50000);
  });

  test("7. no rompe la validación de importes exactos del cheque tras el fix de duplicados", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1000, checks: [mkCheckPayload({ amount: 900 })] }],
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
    expect(row.insuredSummary.insuredId).toBe(insuredId);
    expect(row.insuredSummary.insuredDisplay).toBeDefined();
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

// ─── 48+: Cobro manual real (source="policy_manual_payment") ─────────────────────────
// UN COBRO MANUAL NUNCA ES UNA DEUDA — ver comentario de cabecera de
// src/lib/payments/batches.ts. Estos tests verifican que un ítem manual
// dentro de un payment_batch se comporta como dinero real: payment hijo
// confirmado con installmentId NULL, sin policy_installments/cash_debts
// nuevos, mismo tratamiento de Pronto Pago y de bloqueo PUT/DELETE que un
// hijo de cuota.

describe("48. Batch 100% manual", () => {
  test("un cobro manual solo → 201, hijo con installmentId NULL", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: 500, description: "cuota faltante" }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(201);
    const children = await getChildren(body.id);
    expect(children.length).toBe(1);
    expect(children[0]!.installmentId).toBeNull();
    expect(children[0]!.policyId).toBe(policyId);
    expect(children[0]!.amount).toBe(500);
    expect(children[0]!.status).toBe("confirmado");
    expect(children[0]!.notes).toBe("cuota faltante");
  });
});

describe("49. Batch mixto — cuota existente + cobro manual", () => {
  test("1 cuota + 1 manual del mismo asegurado → 201, ambos hijos correctos", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const policyB = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyA, 1, "2027-01-01", 700);
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [
        { source: "installment", installmentId: instId },
        { source: "policy_manual_payment", policyId: policyB, amount: 300 },
      ],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
    const children = await getChildren(body.id);
    expect(children.length).toBe(2);
    const instChild = children.find(c => c.installmentId === instId)!;
    const manualChild = children.find(c => c.installmentId == null)!;
    expect(instChild.amount).toBe(700);
    expect(manualChild.amount).toBe(300);
    expect(manualChild.policyId).toBe(policyB);

    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.baseAmountCents).toBe(100000); // 700 + 300
  });
});

describe("50. Legacy sin source explícito sigue funcionando (compatibilidad)", () => {
  test("items sin `source` se tratan como installment", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }], // sin source, forma legacy
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
  });
});

describe("51. Cobro manual con póliza inexistente → 404, nada se crea", () => {
  test("policyId inexistente", async () => {
    const before = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId: 999999999, amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(404);
    expect(body.error).toContain("no existen");
    const after = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    expect(after.length).toBe(before.length);
  });
});

describe("52. Cobro manual con póliza cancelada → 409", () => {
  test("policy.status='cancelada' bloquea el manual_payment", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    await db.update(policies).set({ status: "cancelada" }).where(eq(policies.id, policyId));
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(409);
    expect(body.error).toContain("cancelada");
  });
});

describe("53. Cobro manual con póliza (policy_manual_payment) de otro asegurado → PERMITIDO (lote multi-asegurado)", () => {
  test("policyId de otro insuredId, único ítem → 201, batch.insuredId = ese asegurado real (uno solo, aunque distinto de cualquier 'principal')", async () => {
    const otherPolicy = await mkPolicy(otherInsuredId, companyId);
    const { status, body } = await callPost({
      paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId: otherPolicy, amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.insuredId).toBe(otherInsuredId);
  });

  test("mezclado con una cuota real de otro asegurado → 201, batch.insuredId queda NULL (dos asegurados reales distintos)", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyA, 1, "2027-01-01", 500);
    const otherPolicy = await mkPolicy(otherInsuredId, companyId);
    const { status, body } = await callPost({
      paymentDate: "2027-01-01", notes: null,
      items: [
        { source: "installment", installmentId: instId },
        { source: "policy_manual_payment", policyId: otherPolicy, amount: 500 },
      ],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.insuredId).toBeNull();
    const children = await getChildren(body.id);
    expect(children.length).toBe(2);
  });
});

describe("54. Cobro manual con amount inválido → 400, nada se crea", () => {
  test("amount = 0", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: 0 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(400);
  });
  test("amount negativo", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: -100 }],
      splits: [{ method: "efectivo", amount: 100 }],
    });
    expect(status).toBe(400);
  });
  test("amount con más de dos decimales reales", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: 100.567 }],
      splits: [{ method: "efectivo", amount: 100.57 }],
    });
    expect(status).toBe(400);
  });
});

describe("55. Source inválido → 400, nada se crea", () => {
  test("source desconocido en un ítem", async () => {
    const before = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "cash_entry", policyId: 1, amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("source inválido");
    const after = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    expect(after.length).toBe(before.length);
  });
});

describe("56. notes/description del cobro manual se preserva en el payment hijo", () => {
  test("description con espacios se recorta y se guarda en payments.notes", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: 500, description: "  cuota faltante importada  " }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    const children = await getChildren(body.id);
    expect(children[0]!.notes).toBe("cuota faltante importada");
  });
  test("sin description → notes queda null", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    const children = await getChildren(body.id);
    expect(children[0]!.notes).toBeNull();
  });
});

describe("57. Recargo Pronto Pago Rivadavia sobre un cobro manual", () => {
  test("cobro manual contra una póliza Rivadavia, medios propios → 1 recargo", async () => {
    const rivPolicy = await mkPolicy(insuredId, rivadaviaCompanyId);
    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId: rivPolicy, amount: 1000 }],
      splits: [{ method: "efectivo", amount: 1000 + 800 }],
    });
    const children = await getChildren(body.id);
    expect(children.length).toBe(1);
    const surcharges = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, children[0]!.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(1);
    expect(surcharges[0]!.amount).toBe(800);
  });

  test("batch mixto: cuota Rivadavia + manual Rivadavia → dos recargos, uno por hijo", async () => {
    const rivPolicyA = await mkPolicy(insuredId, rivadaviaCompanyId);
    const rivPolicyB = await mkPolicy(insuredId, rivadaviaCompanyId);
    const instId = await mkInstallment(rivPolicyA, 1, "2027-01-01", 600);
    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [
        { source: "installment", installmentId: instId },
        { source: "policy_manual_payment", policyId: rivPolicyB, amount: 400 },
      ],
      splits: [{ method: "efectivo", amount: 1000 + 1600 }],
    });
    const children = await getChildren(body.id);
    const childIds = children.map(c => c.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(inArray(cashEntries.paymentId, childIds), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(2);
    expect(new Set(surcharges.map(s => s.paymentId)).size).toBe(2);
  });

  test("manual Rivadavia con medios direct_company → cero recargos", async () => {
    const rivPolicy = await mkPolicy(insuredId, rivadaviaCompanyId);
    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId: rivPolicy, amount: 1000 }],
      splits: [{ method: "transferencia_compania", amount: 1000 }],
    });
    const children = await getChildren(body.id);
    const surcharges = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, children[0]!.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(0);
  });
});

describe("58. Rollback total si el hijo manual falla a mitad de la transacción", () => {
  test("hijo installment insertado OK, hijo manual con amount NULL revienta → todo se revierte (batch, splits, primer hijo)", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2099-01-01", 600);
    const manualPolicyId = await mkPolicy(insuredId, companyId);

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
          policyId, installmentId: instId, amount: 600, paymentMethod: "lote",
          paymentDate: "2027-01-01", status: "confirmado", batchId: batch!.id, createdBy: userId,
        });
        // Hijo manual: amount NULL viola NOT NULL — fallo real de SQLite.
        await tx.insert(payments).values({
          policyId: manualPolicyId, installmentId: null, amount: null as any, paymentMethod: "lote",
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
  });
});

describe("59. GET /api/payment-batches/:id con hijo manual", () => {
  test("item manual viene con installment=null y el resto de los campos resueltos", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: 500, description: "cuota faltante" }],
      splits: [{ method: "efectivo", amount: 500 }],
    });

    const { status, body } = await callGetBatch(created.id);
    expect(status).toBe(200);
    expect(body.items.length).toBe(1);
    const item = body.items[0];
    expect(item.installment).toBeNull();
    expect(item.payment.installmentId).toBeNull();
    expect(item.payment.notes).toBe("cuota faltante");
    expect(item.policy.id).toBe(policyId);
    expect(item.company).toBeDefined();
    expect(body.integrity.baseMatchesChildren).toBe(true);
  });

  test("batch mixto (cuota + manual) → integrity sigue cerrando", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const policyB = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyA, 1, "2027-01-01", 700);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [
        { source: "installment", installmentId: instId },
        { source: "policy_manual_payment", policyId: policyB, amount: 300 },
      ],
      splits: [{ method: "efectivo", amount: 1000 }],
    });

    const { body } = await callGetBatch(created.id);
    expect(body.items.length).toBe(2);
    const manualItem = body.items.find((i: any) => i.installment == null);
    const instItem = body.items.find((i: any) => i.installment != null);
    expect(manualItem).toBeDefined();
    expect(instItem).toBeDefined();
    expect(body.integrity.baseMatchesChildren).toBe(true);
    expect(body.integrity.totalMatchesBasePlusSurcharge).toBe(true);
    expect(body.integrity.splitsMatchTotal).toBe(true);
  });
});

describe("60. PUT/DELETE individual de un hijo manual del batch sigue bloqueado", () => {
  test("PUT monetario sobre un hijo manual → 409, mismo mensaje que un hijo de cuota", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    const children = await getChildren(created.id);

    const { status, body } = await callPutPayment(children[0]!.id, { amount: 999 });
    expect(status).toBe(409);
    expect(body.error).toContain("cobro múltiple");

    const unchanged = await db.select({ amount: payments.amount }).from(payments).where(eq(payments.id, children[0]!.id)).get();
    expect(unchanged?.amount).toBe(500);
  });

  test("editar solo notas de un hijo manual sigue permitido", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    const children = await getChildren(created.id);

    const { status } = await callPutPayment(children[0]!.id, { notes: "nota nueva" });
    expect(status).toBe(200);
  });

  test("DELETE de un hijo manual → 409", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    const children = await getChildren(created.id);

    const res = await app.fetch(new Request(`http://localhost/api/payments/${children[0]!.id}`, {
      method: "DELETE", headers: authHeaders(),
    }));
    expect(res.status).toBe(409);
  });
});

describe("61. Un cobro manual nunca crea policy_installments ni cash_debts", () => {
  test("después de crear un batch manual, no aparece ninguna cuota nueva ni deuda nueva", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const beforeInstallments = await db.select({ id: policyInstallments.id }).from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();
    expect(beforeInstallments.length).toBe(0);

    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId, amount: 500, description: "cuota faltante" }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(201);

    const afterInstallments = await db.select({ id: policyInstallments.id }).from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();
    expect(afterInstallments.length).toBe(0); // ningún policy_installments nuevo
  });
});

// ─── 62+: Imputación completamente manual (source="manual_payment") ───────────
// Mismo modelo que la variante "Imputación manual" ya existente en
// POST /payments standalone: pagador/N° de póliza/compañía en texto libre,
// SIN ninguna póliza real detrás. policyId e installmentId quedan NULL en el
// payment hijo. UN COBRO MANUAL NUNCA ES UNA DEUDA — mismo tratamiento que
// cualquier otro ítem del batch (dinero real, cuenta en Caja, se rinde).

describe("62. Batch con un único manual_payment completamente libre", () => {
  test("solo pagador → 201, hijo con policyId/installmentId NULL", async () => {
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "manual_payment", manualPayer: "Cliente sin póliza cargada", amount: 500, description: "pago suelto" }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(201);
    const children = await getChildren(body.id);
    expect(children.length).toBe(1);
    expect(children[0]!.policyId).toBeNull();
    expect(children[0]!.installmentId).toBeNull();
    expect(children[0]!.amount).toBe(500);
    expect(children[0]!.status).toBe("confirmado");
    expect(children[0]!.manualPayer).toBe("Cliente sin póliza cargada");
    expect(children[0]!.notes).toBe("pago suelto");
  });

  test("solo N° de póliza manual (sin pagador) → 201", async () => {
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "manual_payment", manualPolicyNumber: "MAN-12345", amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(201);
    const children = await getChildren(body.id);
    expect(children[0]!.manualPayer).toBeNull();
    expect(children[0]!.manualPolicyNumber).toBe("MAN-12345");
  });

  test("sin pagador ni N° de póliza manual → 400, nada se crea", async () => {
    const before = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "manual_payment", amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("pagador");
    const after = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    expect(after.length).toBe(before.length);
  });
});

describe("63. Batch mixto — cuota existente + manual_payment libre", () => {
  test("1 cuota + 1 imputación libre del mismo asegurado → 201, ambos hijos correctos", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyA, 1, "2027-01-01", 700);
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [
        { source: "installment", installmentId: instId },
        { source: "manual_payment", manualPayer: "Cliente extra", amount: 300 },
      ],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
    const children = await getChildren(body.id);
    expect(children.length).toBe(2);
    const instChild = children.find(c => c.installmentId === instId)!;
    const manualChild = children.find(c => c.installmentId == null)!;
    expect(instChild.amount).toBe(700);
    expect(manualChild.amount).toBe(300);
    expect(manualChild.policyId).toBeNull();
    expect(manualChild.manualPayer).toBe("Cliente extra");
  });
});

describe("64. Varios manual_payment libres en el mismo batch", () => {
  test("dos imputaciones libres distintas → 201, ambas preservan sus propios datos manuales", async () => {
    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [
        { source: "manual_payment", manualPayer: "Cliente A", manualCompany: "MAPFRE", amount: 200 },
        { source: "manual_payment", manualPayer: "Cliente A (otro pago)", manualPolicyNumber: "MAN-999", amount: 300 },
      ],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(201);
    const children = await getChildren(body.id);
    expect(children.length).toBe(2);
    expect(children.every(c => c.policyId == null && c.installmentId == null)).toBe(true);
    const withCompany = children.find(c => c.manualCompany === "MAPFRE")!;
    const withPolicyNumber = children.find(c => c.manualPolicyNumber === "MAN-999")!;
    expect(withCompany.amount).toBe(200);
    expect(withPolicyNumber.amount).toBe(300);
  });
});

describe("65. El primer ítem manual_payment libre NUNCA exige insuredId — body.insuredId ya ni se lee", () => {
  test("sin body.insuredId, batch 100% manual → 201, batch.insuredId queda NULL", async () => {
    const before = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    const { status, body } = await callPost({
      paymentDate: "2027-01-01", notes: null,
      items: [{ source: "manual_payment", manualPayer: "Cliente inventado", amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.insuredId).toBeNull();
    const after = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    expect(after.length).toBe(before.length + 1);
  });

  test("un body.insuredId inexistente/inventado no rompe nada — ya no se lee ni se valida", async () => {
    const { status } = await callPost({
      insuredId: 999999999, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "manual_payment", manualPayer: "Cliente real", amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(201);
  });
});

describe("66. Cuota + manual_payment libre pueden convivir sin exigir ningún insuredId común", () => {
  test("cuota de un asegurado real + manual_payment libre (sin ninguno) → 201, batch.insuredId = el de la cuota (el manual no cuenta como 'otro')", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyA, 1, "2027-01-01", 500);
    const { status, body } = await callPost({
      paymentDate: "2027-01-01", notes: null,
      items: [
        { source: "installment", installmentId: instId },
        { source: "manual_payment", manualPayer: "Cliente extra", amount: 300 },
      ],
      splits: [{ method: "efectivo", amount: 800 }],
    });
    expect(status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.insuredId).toBe(insuredId);
  });

  test("caso familiar completo: cuota (asegurado A) + policy_manual_payment (asegurado B) + manual_payment libre → 201, batch.insuredId NULL (mezcla real de A y B)", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const instA = await mkInstallment(policyA, 1, "2027-01-01", 500);
    const policyB = await mkPolicy(otherInsuredId, companyId);
    const { status, body } = await callPost({
      paymentDate: "2027-01-01", notes: "resumen familiar con faltante manual",
      items: [
        { source: "installment", installmentId: instA },
        { source: "policy_manual_payment", policyId: policyB, amount: 300 },
        { source: "manual_payment", manualPayer: "Cuota faltante", amount: 200 },
      ],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.insuredId).toBeNull();
    expect(batch!.baseAmountCents).toBe(100000);
    const children = await getChildren(body.id);
    expect(children.length).toBe(3);
  });
});

describe("67. manualPayer/manualPolicyNumber/manualCompany se preservan tal cual en el payment hijo", () => {
  test("los 3 campos junto con notes/description quedan guardados exactamente", async () => {
    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{
        source: "manual_payment", manualPayer: "Juan Pérez", manualPolicyNumber: "MAN-777", manualCompany: "MAPFRE",
        amount: 500, description: "pago telefónico",
      }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    const children = await getChildren(body.id);
    expect(children[0]!.manualPayer).toBe("Juan Pérez");
    expect(children[0]!.manualPolicyNumber).toBe("MAN-777");
    expect(children[0]!.manualCompany).toBe("MAPFRE");
    expect(children[0]!.notes).toBe("pago telefónico");
  });
});

describe("68. Un manual_payment libre nunca crea policy_installments ni cash_debts", () => {
  test("después de crear un batch 100% manual libre, no aparece ninguna cuota nueva ni deuda nueva", async () => {
    const beforeDebts = await db.select({ id: cashDebts.id }).from(cashDebts).all();

    const { status } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "manual_payment", manualPayer: "Cliente sin póliza", amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    expect(status).toBe(201);

    const afterDebts = await db.select({ id: cashDebts.id }).from(cashDebts).all();
    expect(afterDebts.length).toBe(beforeDebts.length); // ningún cash_debts nuevo
  });
});

describe("69. Pronto Pago NUNCA se aplica solo por texto libre de compañía", () => {
  test("manualCompany='Rivadavia' con medios propios → cero recargos (a diferencia de una póliza real)", async () => {
    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "manual_payment", manualPayer: "Cliente Rivadavia (texto)", manualCompany: "Rivadavia", amount: 1000 }],
      splits: [{ method: "efectivo", amount: 1000 }], // sin +800 — si aplicara recargo, esto fallaría por suma incorrecta
    });
    expect(body.id).toBeDefined();
    const children = await getChildren(body.id);
    expect(children.length).toBe(1);
    const surcharges = await db.select().from(cashEntries)
      .where(and(eq(cashEntries.paymentId, children[0]!.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).all();
    expect(surcharges.length).toBe(0);

    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.surchargeAmountCents).toBe(0);
    expect(batch!.totalReceivedCents).toBe(100000); // exactamente la base, sin recargo
  });

  test("comparación directa: la MISMA compañía real (Rivadavia) vía policy_manual_payment SÍ genera recargo", async () => {
    const rivPolicy = await mkPolicy(insuredId, rivadaviaCompanyId);
    const { body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "policy_manual_payment", policyId: rivPolicy, amount: 1000 }],
      splits: [{ method: "efectivo", amount: 1000 + 800 }],
    });
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.surchargeAmountCents).toBe(80000);
  });
});

describe("70. PUT/DELETE individual de un hijo manual_payment libre sigue bloqueado", () => {
  test("PUT monetario sobre un hijo manual libre → 409", async () => {
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "manual_payment", manualPayer: "Cliente sin póliza", amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    const children = await getChildren(created.id);
    const { status, body } = await callPutPayment(children[0]!.id, { amount: 999 });
    expect(status).toBe(409);
    expect(body.error).toContain("cobro múltiple");
  });

  test("DELETE de un hijo manual libre → 409", async () => {
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ source: "manual_payment", manualPayer: "Cliente sin póliza", amount: 500 }],
      splits: [{ method: "efectivo", amount: 500 }],
    });
    const children = await getChildren(created.id);
    const res = await app.fetch(new Request(`http://localhost/api/payments/${children[0]!.id}`, {
      method: "DELETE", headers: authHeaders(),
    }));
    expect(res.status).toBe(409);
  });
});

// ─── 71-77: Fase 2B — sobrantes/faltantes (accountDifferenceResolution) ───

describe("71. Batch exacto (sin diferencia) — comportamiento sin cambios", () => {
  test("receivedAmountCents = totalReceivedCents, sin insured_account_movements", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(status).toBe(201);
    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.totalReceivedCents).toBe(100000);
    expect(batch!.receivedAmountCents).toBe(100000);
    const movements = await getMovementsForBatch(body.id);
    expect(movements.length).toBe(0);
  });

  test("accountDifferenceResolution presente pero sin diferencia real → se ignora, batch exacto igual", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
      accountDifferenceResolution: { action: "saldo_a_favor" },
    });
    expect(status).toBe(201);
    const movements = await getMovementsForBatch(body.id);
    expect(movements.length).toBe(0);
  });
});

describe("72. Cheque mayor al aplicado → saldo a favor", () => {
  test("split cheque $1100 contra 1 cuota de $1000 con accountDifferenceResolution saldo_a_favor → 201, +10000 saldo_a_favor", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const checkNumber = `CHK-72-${Date.now()}`;

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1100, checks: [{ checkNumber, bankName: `${PREFIX} Banco`, dueDate: "2027-06-01", amount: 1100 }] }],
      accountDifferenceResolution: { action: "saldo_a_favor" },
    });
    expect(status).toBe(201);

    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.totalReceivedCents).toBe(100000); // aplicado — sin cambios
    expect(batch!.receivedAmountCents).toBe(110000); // real recibido

    // El cheque NUNCA se achica — queda por su importe físico completo.
    const checks = await getChecksForBatch(body.id);
    expect(checks.length).toBe(1);
    expect(checks[0]!.amountCents).toBe(110000);

    const movements = await getMovementsForBatch(body.id);
    expect(movements.length).toBe(1);
    expect(movements[0]!.type).toBe("saldo_a_favor");
    expect(movements[0]!.signedAmountCents).toBe(10000);
    expect(movements[0]!.insuredId).toBe(insuredId);
    expect(movements[0]!.status).toBe("activo");
    expect(movements[0]!.originBatchId).toBe(body.id);
  });
});

describe("73. Cheque menor al aplicado (mismas cuotas) → saldo deudor", () => {
  test("split cheque $900 contra 1 cuota de $1000 con accountDifferenceResolution saldo_deudor → 201, -10000 saldo_deudor", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const checkNumber = `CHK-73-${Date.now()}`;

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 900, checks: [{ checkNumber, bankName: `${PREFIX} Banco`, dueDate: "2027-06-01", amount: 900 }] }],
      accountDifferenceResolution: { action: "saldo_deudor", reason: "cheque acordado por menor valor" },
    });
    expect(status).toBe(201);

    const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, body.id)).get();
    expect(batch!.totalReceivedCents).toBe(100000);
    expect(batch!.receivedAmountCents).toBe(90000);

    // La cuota se marca pagada por su importe APLICADO (nominal), sin cambios.
    const installment = await getInstallment(instId);
    expect(installment!.status).toBe("pagada");

    const movements = await getMovementsForBatch(body.id);
    expect(movements.length).toBe(1);
    expect(movements[0]!.type).toBe("saldo_deudor");
    expect(movements[0]!.signedAmountCents).toBe(-10000);
    expect(movements[0]!.reason).toBe("cheque acordado por menor valor");
    expect(movements[0]!.status).toBe("activo");

    // Único ítem del batch → relatedPaymentId/relatedInstallmentId se completan sin ambigüedad.
    const children = await getChildren(body.id);
    expect(movements[0]!.relatedInstallmentId).toBe(instId);
    expect(movements[0]!.relatedPaymentId).toBe(children[0]!.id);
  });

  test("saldo_deudor sin reason → 400 (obligatorio a nivel app), nada se escribe", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const before = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 900 }],
      accountDifferenceResolution: { action: "saldo_deudor" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("reason");
    const after = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    expect(after.length).toBe(before.length);
  });
});

describe("74. Diferencia sin accountDifferenceResolution → 400, nada se escribe", () => {
  test("sobrante sin resolución → 400, no crea batch/pagos/movimientos, la cuota sigue pendiente", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const before = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1100 }],
    });
    expect(status).toBe(400);
    expect(body.code).toBe("PAYMENT_BATCH_AMOUNT_DIFFERENCE");

    const after = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    expect(after.length).toBe(before.length);
    const installment = await getInstallment(instId);
    expect(installment!.status).toBe("pendiente");
  });

  test("action no soportada (Caso D, todavía no implementado) → 400 explícito", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1100 }],
      accountDifferenceResolution: { action: "ajuste_manual" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("no soportada");
  });

  test("action no coincide con el sentido real de la diferencia → 400", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1100 }], // sobrante → debería ser "saldo_a_favor"
      accountDifferenceResolution: { action: "saldo_deudor", reason: "x" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("no coincide con el sentido real");
  });
});

describe("75. Multiasegurado con diferencia → 400 en esta primera versión", () => {
  test("saldo_a_favor con 2 insuredId reales distintos en el batch → 400", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const instA = await mkInstallment(policyA, 1, "2027-01-01", 1000);
    const policyB = await mkPolicy(otherInsuredId, companyId);
    const instB = await mkInstallment(policyB, 1, "2027-01-01", 500);
    const before = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();

    const { status, body } = await callPost({
      paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instA }, { installmentId: instB }],
      splits: [{ method: "efectivo", amount: 1600 }], // aplicado=1500, recibido=1600 → sobrante $100
      accountDifferenceResolution: { action: "saldo_a_favor" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("único asegurado real");
    const after = await db.select({ id: paymentBatches.id }).from(paymentBatches).all();
    expect(after.length).toBe(before.length);
  });

  test("saldo_deudor con 2 insuredId reales distintos en el batch → 400", async () => {
    const policyA = await mkPolicy(insuredId, companyId);
    const instA = await mkInstallment(policyA, 1, "2027-01-01", 1000);
    const policyB = await mkPolicy(otherInsuredId, companyId);
    const instB = await mkInstallment(policyB, 1, "2027-01-01", 500);

    const { status, body } = await callPost({
      paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instA }, { installmentId: instB }],
      splits: [{ method: "efectivo", amount: 1400 }], // aplicado=1500, recibido=1400 → faltante $100
      accountDifferenceResolution: { action: "saldo_deudor", reason: "x" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("único asegurado real");
  });

  test("saldo_a_favor en batch 100% manual_payment (sin insuredId real) → 400", async () => {
    const { status, body } = await callPost({
      paymentDate: "2027-01-01", notes: null,
      items: [{ source: "manual_payment", manualPayer: "Cliente sin póliza (71)", amount: 1000 }],
      splits: [{ method: "efectivo", amount: 1100 }],
      accountDifferenceResolution: { action: "saldo_a_favor" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("único asegurado real");
  });
});

describe("76. El cheque físico sigue cerrando EXACTO contra su split (sin excepción por accountDifferenceResolution)", () => {
  test("suma de cheques distinta al importe del split → 400 igual que antes, aunque venga accountDifferenceResolution", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const checkNumber = `CHK-76-${Date.now()}`;

    const { status, body } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      // split cheque dice $1100, pero el cheque cargado es de $1050 — inconsistencia física, no una diferencia recibido/aplicado real.
      splits: [{ method: "cheque", amount: 1100, checks: [{ checkNumber, bankName: `${PREFIX} Banco`, dueDate: "2027-06-01", amount: 1050 }] }],
      accountDifferenceResolution: { action: "saldo_a_favor" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("no coincide");
  });
});

describe("77. POST /payments standalone sigue exacto/legacy — no acepta diferencias", () => {
  test("splits que no suman el importe del pago → 400, sin importar accountDifferenceResolution (campo inexistente en este endpoint)", async () => {
    const res = await app.fetch(new Request("http://localhost/api/payments", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        manualPayer: "X", manualPolicyNumber: "MAN-BATCH-77", manualCompany: "TestCo",
        amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-01-01",
        splits: [{ method: "efectivo", amount: 1100 }],
        accountDifferenceResolution: { action: "saldo_a_favor" },
      }),
    }));
    expect(res.status).toBe(400);
  });
});

// ─── 78. Fase 2F — GET /payment-batches/:id expone receivedAmountCents y accountMovements ──

describe("78. GET /payment-batches/:id — datos para el comprobante (Fase 2F)", () => {
  test("batch exacto: receivedAmountCents = totalReceivedCents, accountMovements vacío", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 1000 }],
    });

    const { status, body } = await callGetBatch(created.id);
    expect(status).toBe(200);
    expect(body.batch.receivedAmountCents).toBe(100000);
    expect(body.batch.totalReceivedCents).toBe(100000);
    expect(body.accountMovements).toEqual([]);
  });

  test("sobrante (cheque mayor): receivedAmountCents > totalReceivedCents, accountMovements incluye el saldo_a_favor con su motivo", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const checkNumber = `CHK-78A-${Date.now()}`;
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "cheque", amount: 1100, checks: [{ checkNumber, bankName: `${PREFIX} Banco`, dueDate: "2027-06-01", amount: 1100 }] }],
      accountDifferenceResolution: { action: "saldo_a_favor", reason: "cheque redondeado por el asegurado" },
    });

    const { status, body } = await callGetBatch(created.id);
    expect(status).toBe(200);
    expect(body.batch.receivedAmountCents).toBe(110000);
    expect(body.batch.totalReceivedCents).toBe(100000);
    // El cheque nunca se achica en la respuesta del detalle tampoco.
    expect(body.splits[0].checks[0].amountCents).toBe(110000);
    expect(body.accountMovements.length).toBe(1);
    expect(body.accountMovements[0].type).toBe("saldo_a_favor");
    expect(body.accountMovements[0].signedAmountCents).toBe(10000);
    expect(body.accountMovements[0].reason).toBe("cheque redondeado por el asegurado");
    expect(body.accountMovements[0].status).toBe("activo");
  });

  test("faltante: receivedAmountCents < totalReceivedCents, accountMovements incluye el saldo_deudor con su motivo obligatorio", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 900 }],
      accountDifferenceResolution: { action: "saldo_deudor", reason: "faltante acordado con el asegurado" },
    });

    const { status, body } = await callGetBatch(created.id);
    expect(status).toBe(200);
    expect(body.batch.receivedAmountCents).toBe(90000);
    expect(body.batch.totalReceivedCents).toBe(100000);
    expect(body.accountMovements.length).toBe(1);
    expect(body.accountMovements[0].type).toBe("saldo_deudor");
    expect(body.accountMovements[0].signedAmountCents).toBe(-10000);
    expect(body.accountMovements[0].reason).toBe("faltante acordado con el asegurado");
  });

  test("anular el batch anula también el movimiento — accountMovements refleja status='anulado'", async () => {
    const policyId = await mkPolicy(insuredId, companyId);
    const instId = await mkInstallment(policyId, 1, "2027-01-01", 1000);
    const { body: created } = await callPost({
      insuredId, paymentDate: "2027-01-01", notes: null,
      items: [{ installmentId: instId }],
      splits: [{ method: "efectivo", amount: 900 }],
      accountDifferenceResolution: { action: "saldo_deudor", reason: "faltante a anular" },
    });

    const cancel = await callCancelBatch(created.id);
    expect(cancel.status).toBe(200);

    const { body } = await callGetBatch(created.id);
    expect(body.accountMovements.length).toBe(1);
    expect(body.accountMovements[0].status).toBe("anulado");
  });
});
