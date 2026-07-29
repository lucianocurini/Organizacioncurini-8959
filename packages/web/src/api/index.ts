import { Hono } from "hono";
import { eq, like, or, desc, asc, and, inArray, lte, gte, isNull, isNotNull, ne, lt, sql } from "drizzle-orm";
import { database as db } from "./database/index";
import {
  users,
  companies,
  insureds,
  policies,
  sessions,
  payments,
  paymentSplits,
  paymentBatches,
  paymentBatchSplits,
  receivedChecks,
  deliveries,
  rebillings,
  claims,
  policyInstallments,
  policyInsuredPersons,
  policyFleetVehicles,
  taskTemplates,
  tasks,
  importLogs,
  cashEntries,
  cashDebts,
  cashExpenses,
  remittances,
  remittanceItems,
  remittanceAllocations,
  commissionEntries,
  ivaEntries,
  ownMoneyMovements,
  insuredAccountMovements,
} from "./database/schema";
import { buildFullBackup, validateFullBackup, EXPECTED_BUSINESS_TABLES } from "./backup/full-backup";
import { nanoid } from "nanoid";
import {
  gmailSearch,
  gmailDownloadAttachment,
  findTxtAttachment,
  gmailConfigured,
} from "../lib/gmail-client";
import { parseElNorteTxtV2 } from "../lib/parsers/el-norte-v2";
import { isValidCalendarDate, buildInstallmentPlan, InstallmentPlanError, addCalendarDays } from "../lib/installments/plan";
import { classifyInstallmentsForRebuild, runInstallmentRebuildTransaction, RebuildConflictError, PolicyNotFoundError } from "../lib/installments/rebuild";
import { parseRebillingPayload, RebillingPayloadError, buildRebillingInstallmentPlan, hasRebillingGroupActivity } from "../lib/installments/rebilling-plan";
import { classifyRebillingGroupForRebuild, runRebillingRebuildTransaction, RebillingRebuildConflictError, RebillingNotFoundError } from "../lib/installments/rebilling-rebuild";
import { validateAndNormalizeSplits, SplitValidationError, classifySplitGroup, isDirectCompanyPaymentMethod, type SplitGroup } from "../lib/payments/splits";
import { recalculateInstallmentPaymentStatus } from "../lib/payments/installment-status";
import { toArgentinaCalendarDay, resolveArgentinaMonthKey } from "../lib/dates/argentina-date";
import {
  validateCancellationEffectiveDate, validatePolicyCancellationState, classifyInstallmentsForCancellation,
  appendCancellationNote, isInstallmentNonCollectible, PolicyCancellationValidationError, PolicyAlreadyCancelledError,
  type InstallmentForCancellation,
} from "../lib/policies/cancellation";
import {
  normalizeBatchItems, normalizeBatchSplits, validateInstallmentsEligibility,
  calculateBaseAmountCents, resolveBatchSplitGroup, calculateApplicableRivadaviaSurcharges,
  calculateBatchTotals, resolveBatchInsuredId, PaymentBatchValidationError,
  SURCHARGE_AMOUNT_CENTS, type BatchItemContext, type NormalizedPaymentBatchSplit,
  type NormalizedPaymentBatchItem,
  checkBatchCancellable, findDisallowedBatchPatchFields, canPatchBatch,
  type BatchCancelChildPayment, type BatchCancelCheck,
} from "../lib/payments/batches";
import {
  normalizeReceivedCheck, validateChecksMatchSplit, findPossibleCheckDuplicates,
  validateCheckStatusTransition, ReceivedCheckValidationError, type NormalizedReceivedCheck,
  isCheckActiveForDuplicateCheck, type ExistingCheckForDuplicateCheck,
} from "../lib/payments/received-checks";
import {
  resolveStandalonePaymentInstruments, resolveCashEntryInstrument, resolveBatchChildPaymentInstrument,
  buildRemittanceAllocations, validateAllocationOwnership, validateAllocationTotals,
  calculateExpectedCollectedCents, classifyRemittanceAllocationState,
  RemittanceAllocationValidationError, type ResolvedInstrument, type CollectedAmountSource,
} from "../lib/payments/remittance-allocations";
import {
  applyStandalonePaymentToCartera, applyBatchToCartera, applyStandaloneSurchargeToCartera,
  applyManualCashEntryToCartera, collectDistinctExpectedSources, classifyRemittanceForRendido,
  accumulateRemittanceContribution, emptyMoneyBucket, emptyDirectCompanyBucket, emptyRendidoAccumulator,
  centsToPesos, buildAdeudadosDetalle, assertAdeudadosDetalleMatchesTotal, AdeudadosSumMismatchError,
  isContableMethod, calculateCajaNetaTotalCents, type CarteraInconsistency, type BatchForCartera,
} from "../lib/payments/caja-summary";
import {
  calculateBatchReceivedAppliedDifference, validateInsuredAccountMovement, InsuredAccountValidationError,
  summarizeInsuredAccountBalances, calculateCreditActiveInCaja, calculateCreditRegularizedInCaja,
  calculateCobroSaldoDeudorInCaja, isSafeToCancelAccountMovementOrigin, type InsuredAccountMovementForCaja,
} from "../lib/payments/insured-account";

const app = new Hono().basePath("/api");

const SURCHARGE_AMOUNT = 800;

// ─── Auth Middleware ───────────────────────────────────────────────────────────
async function getUser(c: any) {
  const sessionId = c.req.header("x-session-id");
  if (!sessionId) return null;
  const session = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (!session || new Date(session.expiresAt) < new Date()) return null;
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .get();
  return user || null;
}

function requireAuth(handler: Function) {
  return async (c: any) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: "No autorizado" }, 401);
    if (user.active === 0) return c.json({ error: "Usuario suspendido. Contactá al administrador." }, 403);
    c.set("user", user);
    return handler(c);
  };
}

// ─── Normalize policy type ─────────────────────────────────────────────────────
function serverNormalizeType(val: string): string {
  const v = (val || "").toLowerCase().trim();
  if (v === "automotor" || v === "auto") return "automotor";
  if (v === "motovehiculo" || v === "motovehículo" || v === "moto") return "motovehiculo";
  if (v.includes("motoveh")) return "motovehiculo";
  if (v.includes("auto") || v.includes("vehiculo") || v.includes("vehículo")) return "automotor";
  if (v.includes("moto")) return "motovehiculo";
  if (v.includes("hogar") || v.includes("propiedad") || v.includes("inmueble")) return "hogar";
  if (v.includes("accidente") || v.includes("personal")) return "accidentes";
  if (v.includes("art") || v.includes("riesgo trabajo")) return "art";
  if (v.includes("eco") || v.includes("bicicleta") || v.includes("monopatin")) return "ecomovilidad";
  if (v.includes("resp") && v.includes("civil")) return "responsabilidad_civil";
  if (v.includes("casco")) return "cascos";
  if (v.includes("incendio") && !v.includes("integral")) return "incendio";
  if (v.includes("integral") || v.includes("comercial") || v.includes("empresa")) return "comercial";
  return v || "automotor";
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────
app.post("/auth/login", async (c) => {
  const body = await c.req.json();
  const { email, password } = body;
  const user = await db.select().from(users).where(eq(users.email, email)).get();
  if (!user) return c.json({ error: "Credenciales inválidas" }, 401);
  if (user.active === 0) return c.json({ error: "Usuario suspendido. Contactá al administrador." }, 403);
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (user.password !== hash) return c.json({ error: "Credenciales inválidas" }, 401);
  const sessionId = nanoid(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ id: sessionId, userId: user.id, expiresAt });
  return c.json({ sessionId, user: { id: user.id, name: user.name, email: user.email, role: user.role } }, 200);
});

app.post("/auth/logout", async (c) => {
  const sessionId = c.req.header("x-session-id");
  if (sessionId) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
  return c.json({ ok: true }, 200);
});

app.get("/auth/me", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "No autorizado" }, 401);
  if (user.active === 0) return c.json({ error: "Usuario suspendido. Contactá al administrador." }, 403);
  return c.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } }, 200);
});

// ─── COMPANIES ────────────────────────────────────────────────────────────────
app.get("/companies", requireAuth(async (c: any) => {
  const list = await db.select().from(companies).orderBy(companies.name).all();
  return c.json(list, 200);
}));

app.post("/companies", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const [company] = await db.insert(companies).values(body).returning();
  return c.json(company, 201);
}));

app.put("/companies/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const [company] = await db.update(companies).set(body).where(eq(companies.id, Number(c.req.param("id")))).returning();
  return c.json(company, 200);
}));

app.delete("/companies/:id", requireAuth(async (c: any) => {
  await db.delete(companies).where(eq(companies.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// ─── INSUREDS ─────────────────────────────────────────────────────────────────
app.get("/insureds", requireAuth(async (c: any) => {
  const q = c.req.query("q");
  if (q) {
    const results = await db
      .select()
      .from(insureds)
      .where(or(like(insureds.name, `%${q}%`), like(insureds.dni, `%${q}%`)))
      .orderBy(insureds.name)
      .all();
    return c.json(results, 200);
  }
  const list = await db.select().from(insureds).orderBy(insureds.name).all();
  return c.json(list, 200);
}));

app.post("/insureds", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const [insured] = await db.insert(insureds).values(body).returning();
  return c.json(insured, 201);
}));

app.put("/insureds/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const [insured] = await db
    .update(insureds)
    .set(body)
    .where(eq(insureds.id, Number(c.req.param("id"))))
    .returning();
  return c.json(insured, 200);
}));

// ─── POLICIES ─────────────────────────────────────────────────────────────────
app.get("/policies", requireAuth(async (c: any) => {
  const { q, type, status, companyId } = c.req.query();
  let results = await db
    .select({ policy: policies, company: companies, insured: insureds })
    .from(policies)
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .where(isNull(policies.parentPolicyId))
    .orderBy(desc(policies.createdAt))
    .all();
  if (q) {
    const lower = q.toLowerCase();
    results = results.filter(
      (r) =>
        r.insured?.name.toLowerCase().includes(lower) ||
        r.company?.name.toLowerCase().includes(lower) ||
        r.policy.policyNumber.toLowerCase().includes(lower)
    );
  }
  if (type) results = results.filter((r) => r.policy.type === type);
  if (status) results = results.filter((r) => r.policy.status === status);
  if (companyId) results = results.filter((r) => r.policy.companyId === Number(companyId));
  return c.json(results, 200);
}));

app.get("/policies/:id", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  const result = await db
    .select({ policy: policies, company: companies, insured: insureds })
    .from(policies)
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .where(eq(policies.id, id))
    .get();
  if (!result) return c.json({ error: "No encontrada" }, 404);
  const policyRebillings = await db
    .select()
    .from(rebillings)
    .where(eq(rebillings.policyId, id))
    .orderBy(desc(rebillings.billingStart));
  const today = toArgentinaCalendarDay();
  const instRows = await db
    .select()
    .from(policyInstallments)
    .where(eq(policyInstallments.policyId, id))
    .orderBy(policyInstallments.number);
  // auto-mark vencida
  for (const row of instRows) {
    if (row.status === "pendiente" && row.dueDate < today) {
      await db.update(policyInstallments).set({ status: "vencida" }).where(eq(policyInstallments.id, row.id));
      row.status = "vencida";
    }
  }
  // Nombre del usuario que anuló (si la póliza fue anulada manualmente y
  // cancelledBy quedó cargado) — solo para mostrar en el detalle, no cambia
  // ningún campo de policies.
  let cancelledByName: string | null = null;
  if (result.policy.cancelledBy != null) {
    const cancelledByUser = await db.select({ name: users.name }).from(users)
      .where(eq(users.id, result.policy.cancelledBy)).get();
    cancelledByName = cancelledByUser?.name ?? null;
  }

  // Subpólizas accesoria (accidentes_pasajeros con parentPolicyId = id)
  const subPolicies = await db
    .select({ policy: policies, company: companies, insured: insureds })
    .from(policies)
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .where(eq(policies.parentPolicyId, id));

  return c.json({ ...result, rebillings: policyRebillings, installments: instRows, subPolicies, cancelledByName }, 200);
}));

// ─── Rebillings ───────────────────────────────────────────────────────────────

// Señales de control de flujo dentro de db.transaction — nunca se exponen
// tal cual al cliente, el endpoint las mapea a la respuesta HTTP apropiada
// (mismo patrón que RebuildConflictError en rebuild.ts).
class RebillingDuplicateError extends Error {}

app.get("/policies/:id/rebillings", requireAuth(async (c: any) => {
  const rows = await db
    .select()
    .from(rebillings)
    .where(eq(rebillings.policyId, Number(c.req.param("id"))))
    .orderBy(desc(rebillings.billingStart));
  return c.json(rows, 200);
}));

// Cuotas vinculadas a una refacturación puntual, exclusivamente por
// rebilling_id (nunca por policyId ni por rango de fechas). Refacturaciones
// históricas sin cuotas vinculadas simplemente devuelven [] acá — ese es
// justamente el caso que PUT (caso A) sabe completar.
async function loadRebillingGroup(dbClient: any, rebillingId: number) {
  return dbClient
    .select({ id: policyInstallments.id, status: policyInstallments.status, rendered: policyInstallments.rendered })
    .from(policyInstallments)
    .where(eq(policyInstallments.rebillingId, rebillingId))
    .all();
}

async function rebillingGroupActivitySets(dbClient: any, installmentIds: number[]) {
  let paidInstallmentIds = new Set<number>();
  let remittedInstallmentIds = new Set<number>();
  if (installmentIds.length > 0) {
    const payRows = await dbClient.select({ installmentId: payments.installmentId }).from(payments)
      .where(inArray(payments.installmentId, installmentIds)).all();
    paidInstallmentIds = new Set(payRows.map((r: any) => r.installmentId).filter((id: any) => id !== null));

    const remRows = await dbClient.select({ sourceId: remittanceItems.sourceId }).from(remittanceItems)
      .where(and(eq(remittanceItems.source, "installment"), inArray(remittanceItems.sourceId, installmentIds))).all();
    remittedInstallmentIds = new Set(remRows.map((r: any) => r.sourceId).filter((id: any) => id !== null));
  }
  return { paidInstallmentIds, remittedInstallmentIds };
}

// Mensajes separados por endpoint — DELETE conserva el texto original tal
// cual (ver rebilling-installments.test.ts, Caso E, que ya lo verifica
// literal); PUT tiene el suyo porque la acción bloqueada es "editar", no
// "eliminar".
const REB_DELETE_BLOCK_MSG = "No se puede eliminar la refacturación porque tiene cuotas pagadas, rendidas o con movimientos asociados.";
const REB_EDIT_BLOCK_MSG = "No se puede editar la refacturación porque tiene cuotas pagadas, rendidas o con movimientos asociados.";

app.post("/policies/:id/rebillings", requireAuth(async (c: any) => {
  const user = c.get("user");
  const policyId = Number(c.req.param("id"));
  const body = await c.req.json();

  // 1. validar póliza
  const policy = await db.select({ id: policies.id }).from(policies).where(eq(policies.id, policyId)).get();
  if (!policy) return c.json({ error: "La póliza no existe." }, 404);

  // 2. validar payload
  let payload;
  try {
    payload = parseRebillingPayload(body);
  } catch (e: any) {
    if (e instanceof RebillingPayloadError) return c.json({ error: e.message }, 400);
    throw e;
  }

  // 5. construir plan (antes de escribir nada — pura, sin DB)
  let plan;
  try {
    plan = buildRebillingInstallmentPlan(payload);
  } catch (e: any) {
    if (e instanceof InstallmentPlanError) return c.json({ error: e.message }, 400);
    throw e;
  }

  try {
    const result = await db.transaction(async (tx) => {
      // 3. comprobar duplicado (dentro de la transacción — check-then-insert atómico)
      const duplicate = await checkDuplicateRebilling(policyId, payload.billingStart, payload.billingEnd, payload.premium, tx);
      if (duplicate) {
        throw new RebillingDuplicateError(
          `Ya existe una refacturación para esta póliza con el mismo período (${payload.billingStart} a ${payload.billingEnd}) y la misma prima.`
        );
      }

      // 4. insertar rebilling
      const [rebilling] = await tx.insert(rebillings).values({
        policyId,
        billingStart: payload.billingStart,
        billingEnd: payload.billingEnd,
        premium: payload.premium,
        monthlyFee: payload.monthlyFee,
        sumInsured: payload.sumInsured,
        installmentCount: payload.installmentCount,
        firstDueDate: payload.firstDueDate,
        deductible: payload.deductible,
        notes: payload.notes,
        createdBy: user.id,
      }).returning();

      // 6. insertar N policy_installments
      const insertedInstallments = await tx.insert(policyInstallments).values(
        plan.installments.map((row) => ({
          policyId,
          number: row.number,
          dueDate: row.dueDate,
          amount: row.amount,
          status: "pendiente",
          rendered: 0,
          rebillingId: rebilling!.id,
        }))
      ).returning();

      // 7. incrementar policies.installments en N
      await tx.update(policies)
        .set({ installments: sql`COALESCE(${policies.installments}, 0) + ${plan.installments.length}` })
        .where(eq(policies.id, policyId));

      // 8. si deductible fue informado, actualizar la franquicia vigente
      if (payload.deductible !== null) {
        await tx.update(policies).set({ deductible: payload.deductible }).where(eq(policies.id, policyId));
      }

      return { rebilling, installments: insertedInstallments };
    });

    return c.json({ ...result.rebilling, installments: result.installments }, 201);
  } catch (e: any) {
    if (e instanceof RebillingDuplicateError) return c.json({ error: e.message }, 409);
    throw e;
  }
}));

app.put("/rebillings/:id", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "ID de refacturación inválido." }, 400);
  }
  const body = await c.req.json();

  const existing = await db.select().from(rebillings).where(eq(rebillings.id, id)).get();
  if (!existing) return c.json({ error: "La refacturación ya no existe" }, 404);

  const currentGroup = await loadRebillingGroup(db, id);
  const currentInstallmentIds = currentGroup.map((i: any) => i.id);
  const { paidInstallmentIds, remittedInstallmentIds } = await rebillingGroupActivitySets(db, currentInstallmentIds);
  const groupHasActivity = hasRebillingGroupActivity(currentGroup, paidInstallmentIds, remittedInstallmentIds);

  // CASO C — hay actividad: bloquear cualquier cambio que afecte fechas,
  // importe o cantidad de cuotas. Solo notes puede cambiar sin riesgo.
  if (groupHasActivity) {
    const touchesPlan =
      body.billingStart !== undefined || body.billingEnd !== undefined ||
      body.monthlyFee !== undefined || body.installmentCount !== undefined ||
      body.firstDueDate !== undefined || body.premium !== undefined || body.deductible !== undefined;
    if (touchesPlan) return c.json({ error: REB_EDIT_BLOCK_MSG }, 409);

    const [row] = await db.update(rebillings)
      .set({ notes: body.notes !== undefined ? (body.notes || null) : existing.notes })
      .where(eq(rebillings.id, id))
      .returning();
    return c.json(row, 200);
  }

  // Sin actividad: si el body no trae installmentCount/firstDueDate, es una
  // edición de METADATA (fecha, período, importe, franquicia, observaciones,
  // etc.) — nunca toca policy_installments. Esta es la única rama que la UI
  // nueva de "Editar datos de la refacturación" usa. Si el body trae esos
  // campos, se toma como el camino LEGACY de regeneración de plan (ver nota
  // más abajo) — la UI nueva nunca los envía desde acá; para corregir el plan
  // existe la acción separada POST /rebillings/:id/installments/rebuild.
  const wantsPlan = body.installmentCount !== undefined || body.firstDueDate !== undefined;
  if (!wantsPlan) {
    const [row] = await db.update(rebillings).set({
      billingStart: body.billingStart ?? existing.billingStart,
      billingEnd: body.billingEnd ?? existing.billingEnd,
      premium: body.premium !== undefined ? (body.premium ? Number(body.premium) : null) : existing.premium,
      monthlyFee: body.monthlyFee !== undefined ? (body.monthlyFee ? Number(body.monthlyFee) : null) : existing.monthlyFee,
      sumInsured: body.sumInsured !== undefined ? (body.sumInsured ? Number(body.sumInsured) : null) : existing.sumInsured,
      deductible: body.deductible !== undefined ? (body.deductible ? Number(body.deductible) : null) : existing.deductible,
      notes: body.notes !== undefined ? (body.notes || null) : existing.notes,
    }).where(eq(rebillings.id, id)).returning();

    // Igual que en el alta y en la corrección de plan: si se informó
    // franquicia, también actualiza la vigente de la póliza. Nunca toca
    // cuotas — esta rama es puramente metadata.
    if (body.deductible !== undefined && body.deductible) {
      await db.update(policies).set({ deductible: Number(body.deductible) }).where(eq(policies.id, existing.policyId));
    }
    return c.json(row, 200);
  }

  // ── CAMINO LEGACY (regenera el plan a través de PUT) ──────────────────────
  // Se conserva por compatibilidad hacia atrás — algún caller antiguo podría
  // seguir enviando installmentCount/firstDueDate acá — pero la UI nueva
  // (RebillingModal en modo "Editar datos") NUNCA envía estos campos, así que
  // nunca cae en esta rama. Para corregir el plan de forma explícita y
  // confirmada, usar POST /rebillings/:id/installments/rebuild (misma lógica
  // de fondo, vía runRebillingRebuildTransaction — no hay dos implementaciones
  // distintas de "borrar y regenerar", solo dos puertas de entrada).
  let payload;
  try {
    payload = parseRebillingPayload({
      billingStart: body.billingStart ?? existing.billingStart,
      billingEnd: body.billingEnd ?? existing.billingEnd,
      premium: body.premium !== undefined ? body.premium : existing.premium,
      monthlyFee: body.monthlyFee !== undefined ? body.monthlyFee : existing.monthlyFee,
      installmentCount: body.installmentCount ?? existing.installmentCount,
      firstDueDate: body.firstDueDate ?? existing.firstDueDate,
      sumInsured: body.sumInsured !== undefined ? body.sumInsured : existing.sumInsured,
      deductible: body.deductible !== undefined ? body.deductible : existing.deductible,
      notes: body.notes !== undefined ? body.notes : existing.notes,
    });
  } catch (e: any) {
    if (e instanceof RebillingPayloadError) return c.json({ error: e.message }, 400);
    throw e;
  }

  let plan;
  try {
    plan = buildRebillingInstallmentPlan(payload);
  } catch (e: any) {
    if (e instanceof InstallmentPlanError) return c.json({ error: e.message }, 400);
    throw e;
  }

  const result = await db.transaction(async (tx) => runRebillingRebuildTransaction(tx, id, plan, payload))
    .catch((e: any) => {
      if (e instanceof RebillingRebuildConflictError) return null;
      throw e;
    });

  if (result === null) return c.json({ error: REB_EDIT_BLOCK_MSG }, 409);
  return c.json({ ...result.rebilling, installments: result.insertedRows }, 200);
}));

// Consulta de solo lectura: ¿se puede corregir el plan de cuotas de ESTA
// refacturación puntual? No modifica nada — ver classifyRebillingGroupForRebuild
// (lib/installments/rebilling-rebuild.ts). Acción separada de PUT /rebillings/:id:
// esta es la única vía pensada para reemplazar el grupo de cuotas.
app.get("/rebillings/:id/installments/rebuild-check", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "ID de refacturación inválido." }, 400);
  }
  try {
    const result = await classifyRebillingGroupForRebuild(db, id);
    return c.json(result, 200);
  } catch (e: any) {
    if (e instanceof RebillingNotFoundError) return c.json({ error: "La refacturación ya no existe" }, 404);
    throw e;
  }
}));

// Reconstruye el plan de cuotas de UNA refacturación puntual: borra solo las
// cuotas de ese rebillingId (nunca la emisión original ni otra refacturación)
// y las reemplaza por un plan nuevo. Bloquea completamente si hay actividad
// real (pagada, rendida, payment o remittance_item vinculados).
app.post("/rebillings/:id/installments/rebuild", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "ID de refacturación inválido." }, 400);
  }
  const existing = await db.select().from(rebillings).where(eq(rebillings.id, id)).get();
  if (!existing) return c.json({ error: "La refacturación ya no existe" }, 404);

  const body = await c.req.json();

  let payload;
  try {
    payload = parseRebillingPayload({
      billingStart: body.billingStart ?? existing.billingStart,
      billingEnd: body.billingEnd ?? existing.billingEnd,
      premium: body.premium !== undefined ? body.premium : existing.premium,
      monthlyFee: body.monthlyFee !== undefined ? body.monthlyFee : existing.monthlyFee,
      installmentCount: body.installmentCount,
      firstDueDate: body.firstDueDate,
      sumInsured: body.sumInsured !== undefined ? body.sumInsured : existing.sumInsured,
      deductible: body.deductible !== undefined ? body.deductible : existing.deductible,
      notes: body.notes !== undefined ? body.notes : existing.notes,
    });
  } catch (e: any) {
    if (e instanceof RebillingPayloadError) return c.json({ error: e.message }, 400);
    throw e;
  }

  let plan;
  try {
    plan = buildRebillingInstallmentPlan(payload);
  } catch (e: any) {
    if (e instanceof InstallmentPlanError) return c.json({ error: e.message }, 400);
    throw e;
  }

  // Chequeo previo (fuera de la transacción): informativo, para devolver 409
  // rápido sin abrir una transacción de escritura innecesaria. La única
  // autorización real para borrar es la reclasificación que
  // runRebillingRebuildTransaction hace con `tx`, inmediatamente antes.
  let precheck;
  try {
    precheck = await classifyRebillingGroupForRebuild(db, id);
  } catch (e: any) {
    if (e instanceof RebillingNotFoundError) return c.json({ error: "La refacturación ya no existe" }, 404);
    throw e;
  }
  if (precheck.classification === "REQUIRES_MANUAL_REVIEW") {
    return c.json({
      error: "La refacturación tiene cuotas con actividad — no se puede corregir el plan.",
      blockingInstallments: precheck.blockingInstallments,
    }, 409);
  }

  try {
    const result = await db.transaction(async (tx) => runRebillingRebuildTransaction(tx, id, plan, payload));
    return c.json({
      rebuilt: true,
      rebillingId: id,
      policyId: result.policyId,
      previousCount: result.previousCount,
      insertedCount: result.insertedRows.length,
      rebilling: result.rebilling,
      installments: result.insertedRows,
    }, 200);
  } catch (e: any) {
    if (e instanceof RebillingRebuildConflictError) {
      return c.json({ error: e.message, blockingInstallments: e.blockingInstallments }, 409);
    }
    if (e instanceof RebillingNotFoundError) return c.json({ error: "La refacturación ya no existe" }, 404);
    console.error("[POST /rebillings/:id/installments/rebuild]", e?.message, e);
    return c.json({ error: "No se pudo corregir el plan de cuotas." }, 500);
  }
}));

app.delete("/rebillings/:id", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "ID de refacturación inválido." }, 400);
  }

  const rebilling = await db.select({ id: rebillings.id, policyId: rebillings.policyId }).from(rebillings).where(eq(rebillings.id, id)).get();
  if (!rebilling) return c.json({ error: "La refacturación ya no existe" }, 404);

  const linkedInstallments = await loadRebillingGroup(db, id);
  const installmentIds = linkedInstallments.map((i: any) => i.id);
  const { paidInstallmentIds, remittedInstallmentIds } = await rebillingGroupActivitySets(db, installmentIds);
  if (hasRebillingGroupActivity(linkedInstallments, paidInstallmentIds, remittedInstallmentIds)) {
    return c.json({ error: REB_DELETE_BLOCK_MSG }, 409);
  }

  const deletedInstallments = await db.transaction(async (tx) => {
    if (installmentIds.length > 0) {
      await tx.delete(policyInstallments).where(eq(policyInstallments.rebillingId, id));
    }
    await tx.delete(rebillings).where(eq(rebillings.id, id));
    // Nunca por debajo de 0 — refacturaciones históricas sin cuotas (o con
    // policies.installments ya desincronizado) no deben producir un valor negativo.
    if (installmentIds.length > 0) {
      await tx.update(policies)
        .set({ installments: sql`MAX(0, COALESCE(${policies.installments}, 0) - ${installmentIds.length})` })
        .where(eq(policies.id, rebilling.policyId));
    }
    return installmentIds.length;
  });

  return c.json({ ok: true, deleted: { rebilling: 1, installments: deletedInstallments } }, 200);
}));

// ─── INSTALLMENTS ─────────────────────────────────────────────────────────────
app.get("/policies/:id/installments", requireAuth(async (c: any) => {
  const rows = await db
    .select()
    .from(policyInstallments)
    .where(eq(policyInstallments.policyId, Number(c.req.param("id"))))
    .orderBy(policyInstallments.number);
  // auto-update vencida status
  const today = toArgentinaCalendarDay();
  for (const row of rows) {
    if (row.status === "pendiente" && row.dueDate < today) {
      await db.update(policyInstallments).set({ status: "vencida" }).where(eq(policyInstallments.id, row.id));
      row.status = "vencida";
    }
  }
  return c.json(rows, 200);
}));

// Generate installments for a policy — only for new policies without existing installments
app.post("/policies/:id/installments/generate", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  const body = await c.req.json();
  // 409 if installments already exist — prevents accidental destruction of historical data
  const existing = await db
    .select({ id: policyInstallments.id })
    .from(policyInstallments)
    .where(eq(policyInstallments.policyId, policyId))
    .limit(1)
    .get();
  if (existing) {
    return c.json({
      error: "Esta póliza ya tiene cuotas. La regeneración debe realizarse desde la administración de cuotas.",
    }, 409);
  }
  if (!body.installments?.length) return c.json([], 200);
  const rows = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(policyInstallments)
      .values(body.installments.map((inst: any) => ({
        policyId,
        number: inst.number,
        dueDate: inst.dueDate,
        amount: Number(inst.amount),
        status: "pendiente",
        notes: inst.notes || null,
      })))
      .returning();
    await tx.update(policies).set({ installments: body.installments.length }).where(eq(policies.id, policyId));
    return inserted;
  });
  return c.json(rows, 201);
}));

// Update a single installment
app.put("/installments/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const update: any = {};
  if ("dueDate" in body) update.dueDate = body.dueDate;
  if ("amount" in body) update.amount = Number(body.amount);
  if ("status" in body) update.status = body.status;
  if ("notes" in body) update.notes = body.notes || null;
  const [row] = await db
    .update(policyInstallments)
    .set(update)
    .where(eq(policyInstallments.id, Number(c.req.param("id"))))
    .returning();
  return c.json(row, 200);
}));

// Consulta de solo lectura: ¿se puede reconstruir el plan de cuotas de esta póliza?
// No modifica nada — ver classifyInstallmentsForRebuild (lib/installments/rebuild.ts).
app.get("/policies/:id/installments/rebuild-check", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  if (!Number.isInteger(policyId) || policyId <= 0) {
    return c.json({ error: "ID de póliza inválido." }, 400);
  }
  const policy = await db.select({ id: policies.id }).from(policies).where(eq(policies.id, policyId)).get();
  if (!policy) return c.json({ error: "La póliza no existe." }, 404);

  // classifyInstallmentsForRebuild también valida existencia por su cuenta
  // (PolicyNotFoundError) — este catch es la red de seguridad si esa póliza
  // desaparece entre el chequeo de arriba y esta llamada.
  try {
    const result = await classifyInstallmentsForRebuild(db, policyId);
    return c.json(result, 200);
  } catch (e: any) {
    if (e instanceof PolicyNotFoundError) return c.json({ error: "La póliza no existe." }, 404);
    throw e;
  }
}));

// Reconstruye el plan de cuotas de una póliza: borra las cuotas actuales (solo si
// ninguna tiene actividad real) y las reemplaza por un plan nuevo construido con
// buildInstallmentPlan. Nunca acepta filas de cuotas prearmadas desde el cliente.
app.post("/policies/:id/installments/rebuild", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  if (!Number.isInteger(policyId) || policyId <= 0) {
    return c.json({ error: "ID de póliza inválido." }, 400);
  }
  const policy = await db.select({ id: policies.id }).from(policies).where(eq(policies.id, policyId)).get();
  if (!policy) return c.json({ error: "La póliza no existe." }, 404);

  const body = await c.req.json();

  let plan;
  try {
    plan = buildInstallmentPlan({
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      periodAmount: Number(body.periodAmount),
      installmentCount: Number(body.installmentCount),
      firstDueDate: body.firstDueDate || undefined,
      installmentIntervalMonths: body.installmentIntervalMonths != null ? Number(body.installmentIntervalMonths) : undefined,
    });
  } catch (e: any) {
    if (e instanceof InstallmentPlanError) return c.json({ error: e.message }, 400);
    throw e;
  }

  // Chequeo previo (fuera de la transacción): puramente informativo, para
  // devolver 409 rápido y evitar abrir una transacción de escritura cuando ya
  // se sabe que la póliza no es reconstruible. NO autoriza nada por sí mismo —
  // la única autorización real para borrar es la reclasificación que
  // runInstallmentRebuildTransaction hace con el cliente transaccional `tx`,
  // inmediatamente antes del borrado (ver ese archivo).
  let precheck;
  try {
    precheck = await classifyInstallmentsForRebuild(db, policyId);
  } catch (e: any) {
    if (e instanceof PolicyNotFoundError) return c.json({ error: "La póliza no existe." }, 404);
    throw e;
  }
  if (precheck.classification === "REQUIRES_MANUAL_REVIEW") {
    return c.json({
      error: "La póliza tiene cuotas con actividad — no se puede reconstruir el plan.",
      blockingInstallments: precheck.blockingInstallments,
    }, 409);
  }

  try {
    const result = await db.transaction(async (tx) =>
      runInstallmentRebuildTransaction(tx, policyId, plan, {
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        periodAmount: Number(body.periodAmount),
      })
    );

    return c.json({
      rebuilt: true,
      previousCount: result.previousCount,
      insertedCount: result.insertedRows.length,
      previousExpectedCount: result.previousExpectedCount,
      newExpectedCount: result.insertedRows.length,
      installments: result.insertedRows,
    }, 200);
  } catch (e: any) {
    if (e instanceof RebuildConflictError) {
      return c.json({
        error: e.message,
        blockingInstallments: e.blockingInstallments,
      }, 409);
    }
    if (e instanceof PolicyNotFoundError) return c.json({ error: "La póliza no existe." }, 404);
    console.error("[POST /policies/:id/installments/rebuild]", e?.message, e);
    return c.json({ error: "No se pudo reconstruir el plan de cuotas." }, 500);
  }
}));

app.post("/policies", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  // Normalize and validate billingCycle
  if (!body.billingCycle) body.billingCycle = null;
  else if (!["mensual", "trimestral", "cuatrimestral", "semestral"].includes(body.billingCycle))
    return c.json({ error: `Frecuencia de refacturación inválida: "${body.billingCycle}"` }, 400);
  // Normalize and validate vigencyPeriod
  // "mensual" NUNCA es una vigencia contractual normal (no hay pólizas de
  // vigencia real de 1 mes) — es tolerancia LEGACY únicamente: 15 pólizas
  // de dev.db ya quedaron así por un bug del importador de Mercantil Andina
  // (resolveVigencyPeriod más abajo confundía "período importado de 1 mes" =
  // refacturación mensual con "vigencia de 1 mes"). Se acepta acá solo para
  // que esas pólizas ya existentes se puedan seguir editando/guardando (el
  // <select> de PolicyModal.tsx deliberadamente NO ofrece "mensual" como
  // opción — ver aviso "Vigencia mensual detectada" en el modal). El caso
  // correcto de "la compañía refactura mes a mes" es vigencyPeriod="anual" +
  // billingCycle="mensual", nunca vigencyPeriod="mensual".
  if (!body.vigencyPeriod) body.vigencyPeriod = null;
  else if (!["anual", "semestral", "cuatrimestral", "mensual"].includes(body.vigencyPeriod))
    return c.json({ error: `Período de vigencia inválido: "${body.vigencyPeriod}"` }, 400);
  // Normalize and validate nextRebillingDate: nullable, fecha real, nunca texto arbitrario.
  if (!body.nextRebillingDate) body.nextRebillingDate = null;
  else if (!isValidCalendarDate(body.nextRebillingDate))
    return c.json({ error: `Próxima fecha de refacturación inválida: "${body.nextRebillingDate}"` }, 400);
  const today = toArgentinaCalendarDay();
  const daysToEnd = Math.ceil(
    (new Date(body.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
  );
  let status = "activa";
  if (daysToEnd < 0) status = "vencida";
  else if (daysToEnd <= 30) status = "por_vencer";
  body.status = status;
  body.createdBy = user.id;
  // If renewal, mark previous policy as renovada
  if (body.renewedFromId) {
    await db.update(policies).set({ status: "renovada" }).where(eq(policies.id, Number(body.renewedFromId)));
  }
  const [policy] = await db.insert(policies).values(body).returning();
  return c.json(policy, 201);
}));

app.put("/policies/:id", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();

  // Cierra la vía lateral: este PUT genérico no gestiona anulaciones. Si el
  // body trae status="cancelada" (venga cual venga el status actual), o si
  // la póliza YA está cancelada y el body trae cualquier otro status
  // (intento de "rehabilitar" por esta vía), se rechaza — la única forma de
  // anular es POST /policies/:id/cancel, y no hay rehabilitación manual en
  // esta versión (ver src/lib/policies/cancellation.ts).
  const current = await db.select({ status: policies.status }).from(policies).where(eq(policies.id, id)).get();
  if (!current) return c.json({ error: "La póliza no existe." }, 404);
  if ("status" in body && (body.status === "cancelada" || current.status === "cancelada")) {
    return c.json({ error: "Las anulaciones deben gestionarse mediante la acción específica \"Anular póliza\"." }, 400);
  }

  // Normalize and validate billingCycle
  if ("billingCycle" in body) {
    if (!body.billingCycle) body.billingCycle = null;
    else if (!["mensual", "trimestral", "cuatrimestral", "semestral"].includes(body.billingCycle))
      return c.json({ error: `Frecuencia de refacturación inválida: "${body.billingCycle}"` }, 400);
  }
  // Normalize and validate vigencyPeriod (ver comentario en POST /policies —
  // "mensual" es un valor real que produce el importador de Mercantil Andina).
  if ("vigencyPeriod" in body) {
    if (!body.vigencyPeriod) body.vigencyPeriod = null;
    else if (!["anual", "semestral", "cuatrimestral", "mensual"].includes(body.vigencyPeriod))
      return c.json({ error: `Período de vigencia inválido: "${body.vigencyPeriod}"` }, 400);
  }
  // Normalize and validate nextRebillingDate — solo si se envía (edición parcial no la toca).
  if ("nextRebillingDate" in body) {
    if (!body.nextRebillingDate) body.nextRebillingDate = null;
    else if (!isValidCalendarDate(body.nextRebillingDate))
      return c.json({ error: `Próxima fecha de refacturación inválida: "${body.nextRebillingDate}"` }, 400);
  }
  // El recálculo automático de status por fecha nunca corre sobre una póliza
  // cancelada — ya se rechazó arriba cualquier `status` explícito en el body
  // para ese caso, pero sin este guard este bloque igual recalcularía y
  // pisaría el status con "activa"/"vencida"/"por_vencer" (vía `!body.status`)
  // al editar cualquier otro campo (ej. solo `notes`), "rehabilitando"
  // silenciosamente la póliza sin pasar por ningún endpoint de rehabilitación.
  if (current.status !== "cancelada") {
    const today = toArgentinaCalendarDay();
    const daysToEnd = Math.ceil(
      (new Date(body.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (!body.status || body.status === "activa" || body.status === "por_vencer" || body.status === "vencida") {
      if (daysToEnd < 0) body.status = "vencida";
      else if (daysToEnd <= 30) body.status = "por_vencer";
      else body.status = "activa";
    }
  }
  body.updatedAt = new Date();
  const [policy] = await db
    .update(policies)
    .set(body)
    .where(eq(policies.id, id))
    .returning();
  return c.json(policy, 200);
}));

app.delete("/policies/:id", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "ID de póliza inválido." }, 400);
  }

  const existing = await db.select({ id: policies.id }).from(policies).where(eq(policies.id, id)).get();
  if (!existing) return c.json({ error: "La póliza ya no existe" }, 404);

  const BLOCK_MSG = "No se puede eliminar la póliza porque tiene pagos, cuotas pagadas o rendidas, rendiciones, siniestros o envíos asociados.";

  // Obtener ids de cuotas para checks transitivos
  const instRows = await db.select({ id: policyInstallments.id }).from(policyInstallments)
    .where(eq(policyInstallments.policyId, id)).all();
  const installmentIds = instRows.map(r => r.id);

  // Pagos directos por policyId
  const directPay = await db.select({ id: payments.id }).from(payments)
    .where(eq(payments.policyId, id)).get();
  if (directPay) return c.json({ error: BLOCK_MSG }, 409);

  // Cuotas pagadas o rendidas
  const pagada = await db.select({ id: policyInstallments.id }).from(policyInstallments)
    .where(and(eq(policyInstallments.policyId, id), eq(policyInstallments.status, "pagada"))).get();
  if (pagada) return c.json({ error: BLOCK_MSG }, 409);

  const rendered = await db.select({ id: policyInstallments.id }).from(policyInstallments)
    .where(and(eq(policyInstallments.policyId, id), eq(policyInstallments.rendered, 1))).get();
  if (rendered) return c.json({ error: BLOCK_MSG }, 409);

  if (installmentIds.length > 0) {
    // Pagos vinculados por installmentId
    const payByInst = await db.select({ id: payments.id }).from(payments)
      .where(inArray(payments.installmentId, installmentIds)).get();
    if (payByInst) return c.json({ error: BLOCK_MSG }, 409);

    // Remittance items source=installment
    const remByInst = await db.select({ id: remittanceItems.id }).from(remittanceItems)
      .where(and(eq(remittanceItems.source, "installment"), inArray(remittanceItems.sourceId, installmentIds))).get();
    if (remByInst) return c.json({ error: BLOCK_MSG }, 409);
  }

  // Siniestros
  const claim = await db.select({ id: claims.id }).from(claims)
    .where(eq(claims.policyId, id)).get();
  if (claim) return c.json({ error: BLOCK_MSG }, 409);

  // Envíos
  const delivery = await db.select({ id: deliveries.id }).from(deliveries)
    .where(eq(deliveries.policyId, id)).get();
  if (delivery) return c.json({ error: BLOCK_MSG }, 409);

  // Conteos para respuesta
  const [rebRows, persRows, vehRows] = await Promise.all([
    db.select({ id: rebillings.id }).from(rebillings).where(eq(rebillings.policyId, id)).all(),
    db.select({ id: policyInsuredPersons.id }).from(policyInsuredPersons).where(eq(policyInsuredPersons.policyId, id)).all(),
    db.select({ id: policyFleetVehicles.id }).from(policyFleetVehicles).where(eq(policyFleetVehicles.policyId, id)).all(),
  ]);

  try {
    await db.transaction(async (tx) => {
      if (installmentIds.length > 0)
        await tx.delete(policyInstallments).where(eq(policyInstallments.policyId, id));
      if (rebRows.length > 0)
        await tx.delete(rebillings).where(eq(rebillings.policyId, id));
      if (persRows.length > 0)
        await tx.delete(policyInsuredPersons).where(eq(policyInsuredPersons.policyId, id));
      if (vehRows.length > 0)
        await tx.delete(policyFleetVehicles).where(eq(policyFleetVehicles.policyId, id));
      await tx.delete(policies).where(eq(policies.id, id));
    });
    return c.json({
      ok: true,
      deleted: {
        installments: installmentIds.length,
        rebillings: rebRows.length,
        insuredPersons: persRows.length,
        fleetVehicles: vehRows.length,
      },
    });
  } catch (e: any) {
    console.error("[DELETE /policies/:id]", e?.message, e);
    return c.json({ error: "No se pudo eliminar la póliza." }, 500);
  }
}));

// ─── ANULACIÓN MANUAL DE PÓLIZAS ───────────────────────────────────────────────
// La póliza NUNCA se borra: status pasa a "cancelada" (mismo valor que ya
// escriben los importadores), conservando todo su historial. Solo las cuotas
// pendientes/vencidas con dueDate >= effectiveDate dejan de ser exigibles
// (status="no_exigible") — pagadas, rendidas, y deuda anterior a effectiveDate
// nunca se tocan. Sin rehabilitación en esta versión (ver diagnóstico).
// Ver src/lib/policies/cancellation.ts para el detalle de cada validación.

async function countPendingPaymentsToRender(policyId: number, installmentIds: number[]): Promise<number> {
  const orConditions = installmentIds.length > 0
    ? or(eq(payments.policyId, policyId), inArray(payments.installmentId, installmentIds))
    : eq(payments.policyId, policyId);
  const rows = await db.select({ id: payments.id }).from(payments)
    .where(and(orConditions, eq(payments.rendered, 0), eq(payments.status, "confirmado")))
    .all();
  return rows.length;
}

// POST /api/policies/:id/cancel/preview — solo lectura, no escribe nada.
// Muestra exactamente lo que haría POST /cancel con la misma effectiveDate,
// para que la UI pueda mostrar un resumen antes de pedir confirmación.
app.post("/policies/:id/cancel/preview", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "ID de póliza inválido." }, 400);
  }
  const policy = await db.select().from(policies).where(eq(policies.id, id)).get();
  if (!policy) return c.json({ error: "La póliza no existe." }, 404);

  const body = await c.req.json();

  try {
    validateCancellationEffectiveDate(body.effectiveDate, { startDate: policy.startDate, endDate: policy.endDate });
  } catch (e: any) {
    if (e instanceof PolicyCancellationValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }

  const installmentRows = await db.select({
    id: policyInstallments.id, dueDate: policyInstallments.dueDate,
    status: policyInstallments.status, rendered: policyInstallments.rendered,
  }).from(policyInstallments).where(eq(policyInstallments.policyId, id)).all();

  const classification = classifyInstallmentsForCancellation(installmentRows as InstallmentForCancellation[], body.effectiveDate);
  const pendingPaymentsToRender = await countPendingPaymentsToRender(id, installmentRows.map((i) => i.id));

  return c.json({
    policy,
    effectiveDate: body.effectiveDate,
    installments: {
      paidUnchanged: classification.paidUnchanged.length,
      renderedUnchanged: classification.renderedUnchanged.length,
      priorDebtUnchanged: classification.priorDebtUnchanged.length,
      markedNonCollectible: classification.futureNonCollectible.length,
    },
    pendingPaymentsToRender,
  }, 200);
}));

// POST /api/policies/:id/cancel — anulación real, transaccional.
app.post("/policies/:id/cancel", requireAuth(async (c: any) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "ID de póliza inválido." }, 400);
  }

  const body = await c.req.json();
  if (!body.reason || typeof body.reason !== "string" || !body.reason.trim()) {
    return c.json({ error: "El motivo de la anulación es obligatorio." }, 400);
  }
  const reason = body.reason.trim();
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;

  // Chequeo previo (fuera de la transacción): informativo, para devolver
  // 404/409/400 rápido sin abrir una transacción de escritura. La única
  // autorización real es la re-lectura dentro de la transacción, más abajo
  // (mismo patrón que /installments/rebuild-check vs. /rebuild).
  const precheck = await db.select().from(policies).where(eq(policies.id, id)).get();
  if (!precheck) return c.json({ error: "La póliza no existe." }, 404);

  const stateCheck = validatePolicyCancellationState(precheck.status);
  if (!stateCheck.valid) return c.json({ error: stateCheck.errorMessage }, 409);

  try {
    validateCancellationEffectiveDate(body.effectiveDate, { startDate: precheck.startDate, endDate: precheck.endDate });
  } catch (e: any) {
    if (e instanceof PolicyCancellationValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }

  try {
    const result = await db.transaction(async (tx) => {
      // 1-2. Releer dentro de la transacción y validar que no se canceló
      // concurrentemente entre el precheck y acá.
      const current = await tx.select().from(policies).where(eq(policies.id, id)).get();
      if (!current) throw new PolicyCancellationValidationError("La póliza no existe.");
      const txStateCheck = validatePolicyCancellationState(current.status);
      if (!txStateCheck.valid) throw new PolicyAlreadyCancelledError(txStateCheck.errorMessage!);

      // 3. Cargar todas las cuotas de la póliza.
      const installmentRows = await tx.select({
        id: policyInstallments.id, dueDate: policyInstallments.dueDate,
        status: policyInstallments.status, rendered: policyInstallments.rendered,
      }).from(policyInstallments).where(eq(policyInstallments.policyId, id)).all();

      // 4. Clasificar.
      const classification = classifyInstallmentsForCancellation(installmentRows as InstallmentForCancellation[], body.effectiveDate);

      // 5. Actualizar policies.
      const now = new Date();
      await tx.update(policies).set({
        status: "cancelada",
        cancelledAt: now,
        cancellationEffectiveDate: body.effectiveDate,
        cancellationReason: reason,
        cancellationNotes: notes,
        notes: appendCancellationNote(current.notes, reason, notes),
        cancelledBy: user.id,
        cancellationSource: "manual",
        updatedAt: now,
      }).where(eq(policies.id, id));

      // 6. Actualizar únicamente las cuotas futuras no cobrables. 7. Todo lo
      // demás (pagadas, rendidas, deuda anterior, payments, rendiciones,
      // rebillings, siniestros, tareas) queda intacto — no se toca acá.
      const nonCollectibleIds = classification.futureNonCollectible.map((i) => i.id);
      if (nonCollectibleIds.length > 0) {
        await tx.update(policyInstallments).set({ status: "no_exigible" })
          .where(inArray(policyInstallments.id, nonCollectibleIds));
      }

      return { classification, installmentIds: installmentRows.map((i) => i.id) };
    });

    const updatedPolicy = await db.select().from(policies).where(eq(policies.id, id)).get();
    const pendingPaymentsToRender = await countPendingPaymentsToRender(id, result.installmentIds);

    return c.json({
      policy: updatedPolicy,
      effectiveDate: body.effectiveDate,
      installments: {
        paidUnchanged: result.classification.paidUnchanged.length,
        renderedUnchanged: result.classification.renderedUnchanged.length,
        priorDebtUnchanged: result.classification.priorDebtUnchanged.length,
        markedNonCollectible: result.classification.futureNonCollectible.length,
      },
      pendingPaymentsToRender,
    }, 200);
  } catch (e: any) {
    if (e instanceof PolicyAlreadyCancelledError) return c.json({ error: e.message }, 409);
    if (e instanceof PolicyCancellationValidationError) return c.json({ error: e.message }, 404);
    console.error("[POST /policies/:id/cancel]", e?.message, e);
    return c.json({ error: "No se pudo anular la póliza." }, 500);
  }
}));

// ─── DASHBOARD STATS ──────────────────────────────────────────────────────────
app.get("/stats", requireAuth(async (c: any) => {
  const allPolicies = await db
    .select({ policy: policies, company: companies })
    .from(policies)
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .where(isNull(policies.parentPolicyId))
    .all();
  const activas = allPolicies.filter((p) => p.policy.status === "activa").length;
  const vencidas = allPolicies.filter((p) => p.policy.status === "vencida").length;
  const porVencer = allPolicies.filter((p) => p.policy.status === "por_vencer").length;
  const canceladas = allPolicies.filter((p) => p.policy.status === "cancelada").length;
  const vigentes = allPolicies.filter((p) => p.policy.status === "activa" || p.policy.status === "por_vencer");
  const total = vigentes.length;
  const byType: Record<string, number> = {};
  for (const p of vigentes) {
    const t = p.policy.type || "otro";
    byType[t] = (byType[t] || 0) + 1;
  }
  const byCompany: Record<string, { count: number; premium: number }> = {};
  for (const p of vigentes) {
    const cname = p.company?.name || "Sin compañía";
    if (!byCompany[cname]) byCompany[cname] = { count: 0, premium: 0 };
    byCompany[cname].count++;
    byCompany[cname].premium += p.policy.premium || 0;
  }
  const totalPremium = vigentes.reduce((s, p) => s + (p.policy.premium || 0), 0);
  const today = toArgentinaCalendarDay();
  // in30 = today + 30 días calendario (aritmética UTC pura, ver
  // addCalendarDays) — nunca Date.now()+30d.toISOString(), que mezclaría el
  // día de Argentina (today) con un cálculo en UTC real, corriendo el rango
  // en la ventana 21:00–23:59 Arg.
  const in30 = addCalendarDays(today, 30);
  const upcoming = allPolicies.filter((p) => p.policy.endDate >= today && p.policy.endDate <= in30).length;
  return c.json({ total, activas, vencidas, porVencer, canceladas, byType, byCompany, totalPremium, upcoming }, 200);
}));

// ─── BULK IMPORT ──────────────────────────────────────────────────────────────
app.post("/policies/import", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const rows: any[] = body.rows || [];
  if (!rows.length) return c.json({ error: "Sin filas" }, 400);
  const results = { imported: 0, skipped: 0, errors: [] as string[] };
  for (const row of rows) {
    try {
      let companyId: number | null = null;
      if (row.company) {
        const existing = await db.select().from(companies).where(eq(companies.name, row.company)).get();
        if (existing) {
          companyId = existing.id;
        } else {
          const [nc] = await db.insert(companies).values({ name: row.company }).returning({ id: companies.id });
          companyId = nc.id;
        }
      }
      let insuredId: number | null = null;
      if (row.insured) {
        const existing = await db.select().from(insureds).where(eq(insureds.name, row.insured)).get();
        if (existing) {
          insuredId = existing.id;
        } else {
          const [ni] = await db
            .insert(insureds)
            .values({ name: row.insured, dni: row.dni || null, phone: row.phone || null, email: row.email || null })
            .returning({ id: insureds.id });
          insuredId = ni.id;
        }
      }
      if (!companyId || !insuredId || !row.policyNumber || !row.startDate || !row.endDate) {
        results.skipped++;
        results.errors.push(`Fila ${results.imported + results.skipped}: datos incompletos`);
        continue;
      }
      const today = toArgentinaCalendarDay();
      const daysToEnd = Math.ceil(
        (new Date(row.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
      );
      let status = "activa";
      if (daysToEnd < 0) status = "vencida";
      else if (daysToEnd <= 30) status = "por_vencer";
      const normalizedType = serverNormalizeType(row.type || "automotor");
      const isMoto = normalizedType === "motovehiculo";
      await db.insert(policies).values({
        policyNumber: String(row.policyNumber),
        type: normalizedType,
        status,
        companyId,
        insuredId,
        premium: row.premium ? Number(row.premium) : null,
        sumInsured: row.sumInsured ? Number(row.sumInsured) : null,
        startDate: row.startDate,
        endDate: row.endDate,
        notes: row.notes || null,
        vehicleBrand: isMoto ? null : row.vehicleBrand || null,
        vehicleModel: isMoto ? null : row.vehicleModel || null,
        vehicleYear: isMoto ? null : row.vehicleYear ? Number(row.vehicleYear) : null,
        vehiclePlate: isMoto ? null : row.vehiclePlate || null,
        motoBrand: isMoto ? row.vehicleBrand || null : null,
        motoModel: isMoto ? row.vehicleModel || null : null,
        motoYear: isMoto ? (row.vehicleYear ? Number(row.vehicleYear) : null) : null,
        motoPlate: isMoto ? row.vehiclePlate || null : null,
        motoEngine: row.motoEngine || null,
        coverageType: row.coverageType || null,
        monthlyFee: row.monthlyFee ? Number(row.monthlyFee) : null,
        deductible: row.deductible ? Number(row.deductible) : null,
        billingCycle: row.billingCycle || null,
        installments: row.installments ? Number(row.installments) : null,
        vigencyPeriod: row.vigencyPeriod || "anual",
        propertyAddress: row.propertyAddress || null,
        businessName: row.businessName || null,
        businessActivity: row.businessActivity || null,
        isRebilling: row.isRebilling ? 1 : 0,
        createdBy: user.id,
      });
      results.imported++;
    } catch (e: any) {
      results.skipped++;
      results.errors.push(`Error en fila: ${e.message}`);
    }
  }
  return c.json(results, 200);
}));

// ─── POLICY INSURED PERSONS ──────────────────────────────────────────────────
app.get("/policies/:id/insured-persons", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  const list = await db.select().from(policyInsuredPersons)
    .where(eq(policyInsuredPersons.policyId, policyId))
    .orderBy(asc(policyInsuredPersons.createdAt));
  return c.json(list, 200);
}));

app.post("/policies/:id/insured-persons", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  const body = await c.req.json();
  const [row] = await db.insert(policyInsuredPersons).values({
    policyId,
    name: body.name,
    dni: body.dni || null,
    birthDate: body.birthDate || null,
    relationship: body.relationship || null,
    phone: body.phone || null,
    email: body.email || null,
    notes: body.notes || null,
  }).returning();
  return c.json(row, 201);
}));

app.put("/policies/:id/insured-persons/:personId", requireAuth(async (c: any) => {
  const personId = Number(c.req.param("personId"));
  const body = await c.req.json();
  const update: any = {};
  if ("name" in body) update.name = body.name;
  if ("dni" in body) update.dni = body.dni || null;
  if ("birthDate" in body) update.birthDate = body.birthDate || null;
  if ("relationship" in body) update.relationship = body.relationship || null;
  if ("phone" in body) update.phone = body.phone || null;
  if ("email" in body) update.email = body.email || null;
  if ("notes" in body) update.notes = body.notes || null;
  const [row] = await db.update(policyInsuredPersons).set(update)
    .where(eq(policyInsuredPersons.id, personId)).returning();
  return c.json(row, 200);
}));

app.delete("/policies/:id/insured-persons/:personId", requireAuth(async (c: any) => {
  const personId = Number(c.req.param("personId"));
  await db.delete(policyInsuredPersons).where(eq(policyInsuredPersons.id, personId));
  return c.json({ ok: true }, 200);
}));

// ─── FLEET VEHICLES ──────────────────────────────────────────────────────────
app.get("/policies/:id/fleet-vehicles", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  const list = await db.select().from(policyFleetVehicles)
    .where(eq(policyFleetVehicles.policyId, policyId))
    .orderBy(asc(policyFleetVehicles.createdAt));
  return c.json(list);
}));

app.post("/policies/:id/fleet-vehicles", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  const body = await c.req.json();
  const [row] = await db.insert(policyFleetVehicles).values({
    policyId,
    brand: body.brand || null,
    model: body.model || null,
    year: body.year ? Number(body.year) : null,
    plate: body.plate || null,
    chasis: body.chasis || null,
    engine: body.engine || null,
    color: body.color || null,
    sumInsured: body.sumInsured ? Number(body.sumInsured) : null,
    notes: body.notes || null,
  }).returning();
  return c.json(row, 201);
}));

app.put("/policies/:id/fleet-vehicles/:vehicleId", requireAuth(async (c: any) => {
  const vehicleId = Number(c.req.param("vehicleId"));
  const body = await c.req.json();
  const update: any = {};
  if (body.brand !== undefined) update.brand = body.brand;
  if (body.model !== undefined) update.model = body.model;
  if (body.year !== undefined) update.year = body.year ? Number(body.year) : null;
  if (body.plate !== undefined) update.plate = body.plate;
  if (body.chasis !== undefined) update.chasis = body.chasis;
  if (body.engine !== undefined) update.engine = body.engine;
  if (body.color !== undefined) update.color = body.color;
  if (body.sumInsured !== undefined) update.sumInsured = body.sumInsured ? Number(body.sumInsured) : null;
  if (body.notes !== undefined) update.notes = body.notes;
  const [row] = await db.update(policyFleetVehicles).set(update)
    .where(eq(policyFleetVehicles.id, vehicleId)).returning();
  return c.json(row);
}));

app.delete("/policies/:id/fleet-vehicles/:vehicleId", requireAuth(async (c: any) => {
  const vehicleId = Number(c.req.param("vehicleId"));
  await db.delete(policyFleetVehicles).where(eq(policyFleetVehicles.id, vehicleId));
  return c.json({ ok: true }, 200);
}));

// ─── PAYMENTS ────────────────────────────────────────────────────────────────
app.get("/payments", requireAuth(async (c: any) => {
  const { policyId, method, status, from, to } = c.req.query();
  let results = await db
    .select({ payment: payments, policy: policies, insured: insureds, company: companies, installment: policyInstallments })
    .from(payments)
    .leftJoin(policies, eq(payments.policyId, policies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .leftJoin(policyInstallments, eq(payments.installmentId, policyInstallments.id))
    .orderBy(desc(payments.createdAt))
    .all();
  if (policyId) results = results.filter((r) => r.payment.policyId === Number(policyId));
  if (status) results = results.filter((r) => r.payment.status === status);
  if (from) results = results.filter((r) => r.payment.paymentDate >= from);
  if (to) results = results.filter((r) => r.payment.paymentDate <= to);
  const paymentIds = results.map(r => r.payment.id);
  const surchargeSet = new Set<number>();
  const splitsByPayment = new Map<number, { method: string; amountCents: number; notes: string | null }[]>();
  const paymentIdsWithChecks = new Set<number>();
  if (paymentIds.length > 0) {
    const sRows = await db.select({ paymentId: cashEntries.paymentId })
      .from(cashEntries)
      .where(and(inArray(cashEntries.paymentId, paymentIds), eq(cashEntries.entryType, "pronto_pago_surcharge")))
      .all();
    for (const s of sRows) { if (s.paymentId != null) surchargeSet.add(s.paymentId); }

    // Etapa 3A: splits solo de forma aditiva — no reemplaza amount/paymentMethod.
    const splitRows = await db.select({
      id: paymentSplits.id, paymentId: paymentSplits.paymentId, method: paymentSplits.method,
      amountCents: paymentSplits.amountCents, notes: paymentSplits.notes,
    }).from(paymentSplits).where(inArray(paymentSplits.paymentId, paymentIds))
      .orderBy(asc(paymentSplits.id)).all();
    for (const s of splitRows) {
      const arr = splitsByPayment.get(s.paymentId) ?? [];
      arr.push({ method: s.method, amountCents: s.amountCents, notes: s.notes });
      splitsByPayment.set(s.paymentId, arr);
    }

    // Migración 0028: hasChecks — la UI lo usa para no ofrecer "Eliminar"
    // (DELETE ya lo rechaza con 409, pero mostrar el botón como si fuera una
    // acción normal es confuso) y en cambio ofrecer "Anular pago" para
    // pagos con cheques reales asociados.
    const splitIds = splitRows.map((s) => s.id);
    if (splitIds.length > 0) {
      const splitIdToPaymentId = new Map(splitRows.map((s) => [s.id, s.paymentId]));
      const checkRows = await db.select({ paymentSplitId: receivedChecks.paymentSplitId })
        .from(receivedChecks).where(inArray(receivedChecks.paymentSplitId, splitIds)).all();
      for (const chk of checkRows) {
        if (chk.paymentSplitId == null) continue;
        const pId = splitIdToPaymentId.get(chk.paymentSplitId);
        if (pId != null) paymentIdsWithChecks.add(pId);
      }
    }
  }
  // Etapa 3B: el filtro `method` matchea si CUALQUIER split del payment usa
  // ese método — payments.paymentMethod puede valer "combinado" y no
  // representa ningún método real por sí solo. Se filtra recién acá (con los
  // splits ya cargados en el query de arriba) para no hacer N+1 consultas.
  if (method) {
    results = results.filter((r) => (splitsByPayment.get(r.payment.id) ?? []).some((s) => s.method === method));
  }
  return c.json(results.map(r => ({
    ...r,
    payment: {
      ...r.payment,
      hasSurcharge: surchargeSet.has(r.payment.id),
      hasChecks: paymentIdsWithChecks.has(r.payment.id),
      dueDate: (r.installment?.dueDate ?? r.payment.dueDate ?? null) as string | null,
      splits: splitsByPayment.get(r.payment.id) ?? [],
    },
  })), 200);
}));

app.post("/payments", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const hasPolicyId = body.policyId != null && body.policyId !== "";
  const paymentStatus = body.status || "confirmado";
  const isConfirmed = paymentStatus === "confirmado";

  if (body.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) {
    return c.json({ error: "Formato de fecha de vencimiento inválido. Use YYYY-MM-DD." }, 400);
  }

  // Etapa 3A: todo payment nuevo tiene siempre >=1 payment_splits. El frontend
  // actual no envía `splits` — se arma internamente un único split desde
  // paymentMethod/amount, igual que antes.
  // Etapa 3B: se habilitan 2+ splits (medios combinados), con la restricción
  // de que todos deben pertenecer al mismo grupo (own vs. direct_company) —
  // ver classifySplitGroup. Mezclar ambos grupos se rechaza más abajo, antes
  // de cualquier escritura.
  const rawSplits = Array.isArray(body.splits) && body.splits.length > 0
    ? body.splits
    : [{ method: body.paymentMethod, amount: Number(body.amount), notes: null }];

  let normalizedSplits;
  try {
    normalizedSplits = validateAndNormalizeSplits({ paymentAmount: Number(body.amount), splits: rawSplits });
  } catch (e: any) {
    if (e instanceof SplitValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }

  const splitGroup = classifySplitGroup(normalizedSplits.splits);
  if (splitGroup === "mixed") {
    return c.json({ error: "No se pueden combinar medios propios con pagos directos a la compañía en un mismo cobro." }, 400);
  }

  // Migración 0028: un split method="cheque" de un pago INDIVIDUAL puede
  // traer checks[] con la misma forma que ya acepta POST /payment-batches
  // (ver normalizeReceivedCheck/validateChecksMatchSplit en
  // lib/payments/received-checks.ts) — ningún otro método puede traer
  // cheques. Se valida entero antes de tocar la base, igual que el resto de
  // esta ruta.
  interface SplitWithChecks { method: string; amountCents: number; notes: string | null; checks: NormalizedReceivedCheck[] }
  let splitsWithChecks: SplitWithChecks[];
  try {
    splitsWithChecks = normalizedSplits.splits.map((split, i) => {
      const rawChecks = rawSplits[i]?.checks;
      if (split.method === "cheque") {
        if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
          throw new ReceivedCheckValidationError(`El medio de pago cheque (ítem ${i + 1}) debe incluir al menos un cheque.`);
        }
        const checks = rawChecks.map((raw: any, j: number) => normalizeReceivedCheck(raw, `cheque ${j + 1} del ítem ${i + 1}`));
        const totalsCheck = validateChecksMatchSplit(checks, split.amountCents);
        if (!totalsCheck.valid) throw new ReceivedCheckValidationError(totalsCheck.errorMessage!);
        return { ...split, checks };
      }
      if (Array.isArray(rawChecks) && rawChecks.length > 0) {
        throw new ReceivedCheckValidationError(`El ítem ${i + 1} (${split.method}) no puede incluir cheques.`);
      }
      return { ...split, checks: [] };
    });
  } catch (e: any) {
    if (e instanceof ReceivedCheckValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }

  // paymentMethod del padre: con un solo split, su método real (nunca el
  // body.paymentMethod crudo, garantiza por construcción que coincidan). Con
  // 2+ splits, "combinado" — un valor resumen solo para mostrar en UI/listas
  // legacy; ningún cálculo monetario por método debe leer este campo cuando
  // vale "combinado" (ver GET /payments, stats, Caja: todos suman por
  // payment_splits, no por payments.paymentMethod).
  const resolvedPaymentMethod = normalizedSplits.splits.length === 1
    ? normalizedSplits.splits[0]!.method
    : "combinado";

  // Resolve company/insured from DB (never trust frontend for surcharge decision)
  let resolvedCompany: string | null = null;
  let resolvedClient: string | null = null;
  let resolvedPolicyNumber: string | null = null;
  if (hasPolicyId) {
    const pRow = await db.select({
      companyName: companies.name,
      insuredName: insureds.name,
      policyNumber: policies.policyNumber,
    }).from(policies)
      .innerJoin(companies, eq(policies.companyId, companies.id))
      .innerJoin(insureds, eq(policies.insuredId, insureds.id))
      .where(eq(policies.id, Number(body.policyId))).get();
    resolvedCompany = pRow?.companyName ?? null;
    resolvedClient = pRow?.insuredName ?? null;
    resolvedPolicyNumber = pRow?.policyNumber ?? null;
  } else {
    resolvedCompany = body.manualCompany ?? null;
    resolvedClient = body.manualPayer ?? null;
    resolvedPolicyNumber = body.manualPolicyNumber ?? null;
  }

  // Etapa 3B: la calificación para Pronto Pago se decide por el GRUPO de
  // splits, no por payments.paymentMethod (que puede valer "combinado", un
  // string que no representa ningún método real). splitGroup ya está
  // garantizado no-mixed en este punto (se rechazó más arriba), así que
  // "own" significa "todos los splits son propios".
  const isRivadavia = resolvedCompany?.toLowerCase().includes("rivadavia") ?? false;
  const qualifiesForProntoPago = isRivadavia && splitGroup === "own" && isConfirmed;
  const shouldCreateSurcharge = qualifiesForProntoPago && body.applyProntoPagoSurcharge !== false;

  // La cuota indicada debe existir siempre que se envíe installmentId, sin
  // importar el status — una FK inválida no la rechaza la base (foreign_keys
  // no está activado acá), así que se valida a mano. Si también viene
  // policyId, deben pertenecer a la misma póliza (evita marcar por error la
  // cuota de otra póliza con un id equivocado).
  let installmentRow: { id: number; amount: number; policyId: number; status: string } | null = null;
  if (body.installmentId) {
    installmentRow = await db.select({
      id: policyInstallments.id, amount: policyInstallments.amount,
      policyId: policyInstallments.policyId, status: policyInstallments.status,
    }).from(policyInstallments).where(eq(policyInstallments.id, Number(body.installmentId))).get() ?? null;
    if (!installmentRow) return c.json({ error: "La cuota indicada no existe." }, 404);
    if (hasPolicyId && installmentRow.policyId !== Number(body.policyId)) {
      return c.json({ error: "La cuota indicada no pertenece a la póliza indicada." }, 400);
    }
    // Anulación manual de la póliza (POST /policies/:id/cancel): esta cuota
    // vence en o después de la fecha efectiva de anulación y ya no es
    // exigible. Se bloquea sin importar isConfirmed — ni siquiera un pago
    // "pendiente" tiene sentido sobre una cuota que la póliza ya no cubre.
    if (isInstallmentNonCollectible(installmentRow.status)) {
      return c.json({ error: "La cuota indicada no es exigible: la póliza fue anulada antes de su vencimiento." }, 409);
    }
  }

  // Importe vs. cuota: solo aplica a pagos confirmados vinculados a una cuota.
  // No existe pago parcial todavía — el importe confirmado debe coincidir
  // exactamente en centavos con el importe de la cuota (ver diagnóstico:
  // el recargo Pronto Pago se modela aparte, en cashEntries, nunca se suma a
  // payments.amount — no hay excepción real que justifique aceptar un
  // importe distinto acá). Tampoco se acepta un segundo pago confirmado sobre
  // una cuota que ya está "pagada" — evita duplicar el cobro de una cuota.
  if (installmentRow && isConfirmed) {
    if (installmentRow.status === "pagada") {
      return c.json({ error: "La cuota indicada ya está pagada." }, 409);
    }
    const expectedCents = Math.round(installmentRow.amount * 100);
    if (normalizedSplits.totalCents !== expectedCents) {
      return c.json({
        error: `El importe del pago ($${(normalizedSplits.totalCents / 100).toFixed(2)}) no coincide con el importe de la cuota ($${(expectedCents / 100).toFixed(2)}). Los pagos parciales todavía no están habilitados.`,
      }, 400);
    }
  }

  const [payment] = await db.transaction(async (tx) => {
    const [p] = await tx.insert(payments).values({
      policyId: hasPolicyId ? Number(body.policyId) : null,
      installmentId: body.installmentId ? Number(body.installmentId) : null,
      manualPayer: body.manualPayer || null,
      manualPolicyNumber: body.manualPolicyNumber || null,
      manualCompany: body.manualCompany || null,
      amount: Number(body.amount),
      paymentMethod: resolvedPaymentMethod,
      paymentDate: body.paymentDate,
      periodMonth: body.periodMonth || null,
      notes: body.notes || null,
      status: paymentStatus,
      // dueDate: solo para pagos sin installment; con installment la fuente es policy_installments
      dueDate: body.installmentId ? null : (body.dueDate || null),
      createdBy: user.id,
    }).returning();

    // Splits uno por uno (no bulk) porque un split cheque necesita su propio
    // id ya generado antes de poder insertar los cheques que cuelgan de él
    // (payment_split_id) — mismo criterio que POST /payment-batches.
    for (const s of splitsWithChecks) {
      const [insertedSplit] = await tx.insert(paymentSplits).values({
        paymentId: p.id, method: s.method, amountCents: s.amountCents, notes: s.notes,
      }).returning();

      if (s.checks.length > 0) {
        await tx.insert(receivedChecks).values(s.checks.map((chk) => ({
          paymentSplitId: insertedSplit!.id,
          checkNumber: chk.checkNumber,
          bankName: chk.bankName,
          bankCode: chk.bankCode,
          drawerName: chk.drawerName,
          drawerDocument: chk.drawerDocument,
          issueDate: chk.issueDate,
          dueDate: chk.dueDate,
          amountCents: chk.amountCents,
          currency: chk.currency,
          status: "en_cartera",
          notes: chk.notes,
          receivedAt: new Date(),
          createdBy: user.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })));
      }
    }

    if (body.installmentId && isConfirmed) {
      await tx.update(policyInstallments).set({ status: "pagada" })
        .where(eq(policyInstallments.id, Number(body.installmentId)));
    }

    if (shouldCreateSurcharge) {
      const existing = await db.select({ id: cashEntries.id }).from(cashEntries)
        .where(and(eq(cashEntries.paymentId, p.id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).get();
      if (!existing) {
        await tx.insert(cashEntries).values({
          clientName: resolvedClient ?? "—",
          policyNumber: resolvedPolicyNumber ?? null,
          companyName: resolvedCompany ?? null,
          amount: SURCHARGE_AMOUNT,
          paymentMethod: resolvedPaymentMethod,
          paymentDate: body.paymentDate,
          entryType: "pronto_pago_surcharge",
          paymentId: p.id,
          rendered: 0,
          notes: "Recargo Pronto Pago Rivadavia",
          createdBy: user.id,
        });
      }
    }

    return [p];
  });

  const splitsRows = await db.select().from(paymentSplits).where(eq(paymentSplits.paymentId, payment.id)).all();
  const splitIds = splitsRows.map((s) => s.id);
  const checksRows = splitIds.length
    ? await db.select().from(receivedChecks).where(inArray(receivedChecks.paymentSplitId, splitIds)).all()
    : [];
  const checksBySplitId = new Map<number, typeof checksRows>();
  for (const chk of checksRows) {
    const arr = checksBySplitId.get(chk.paymentSplitId!) ?? [];
    arr.push(chk);
    checksBySplitId.set(chk.paymentSplitId!, arr);
  }
  const splitsWithChecksOut = splitsRows.map((s) => ({ ...s, checks: checksBySplitId.get(s.id) ?? [] }));
  return c.json({ ...payment, splits: splitsWithChecksOut }, 201);
}));

app.put("/payments/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const id = Number(c.req.param("id"));

  const current = await db.select().from(payments).where(eq(payments.id, id)).get();
  if (!current) return c.json({ error: "Pago no encontrado" }, 404);

  const update: any = {};
  const fields = ["policyId", "installmentId", "manualPayer", "manualPolicyNumber", "manualCompany",
    "amount", "paymentMethod", "paymentDate", "periodMonth", "notes", "status", "dueDate"];
  for (const f of fields) { if (f in body) update[f] = body[f]; }
  if ("policyId" in update && (update.policyId === "" || update.policyId == null)) {
    update.policyId = null;
  } else if ("policyId" in update) {
    update.policyId = Number(update.policyId);
  }
  if ("installmentId" in update && (update.installmentId === "" || update.installmentId == null)) {
    update.installmentId = null;
  } else if ("installmentId" in update) {
    update.installmentId = Number(update.installmentId);
  }
  if ("dueDate" in update && !update.dueDate) {
    update.dueDate = null;
  } else if ("dueDate" in update && !/^\d{4}-\d{2}-\d{2}$/.test(update.dueDate)) {
    return c.json({ error: "Formato de fecha de vencimiento inválido. Use YYYY-MM-DD." }, 400);
  }

  const CONTABLE = ["amount", "paymentMethod", "paymentDate", "policyId", "installmentId", "manualCompany", "status", "dueDate"];
  const bodyHasSplits = Array.isArray(body.splits);
  const hasContableChange = CONTABLE.some(f => f in update) || bodyHasSplits;

  // Etapa 4A: un hijo de un cobro múltiple (payment_batches) no se edita como
  // si fuera un payment standalone — sus medios reales viven en
  // payment_batch_splits del batch, no en payment_splits propios, y su
  // amount/installmentId no se pueden tocar sin dejar baseAmountCents /
  // totalReceivedCents del batch inconsistentes. Cualquier corrección
  // monetaria o de cuota debe hacerse administrando el batch completo (no
  // implementado todavía en 4A — ver src/lib/payments/batches.ts). Las notas
  // sí se pueden editar sin restricción.
  if (current.batchId != null && hasContableChange) {
    return c.json({ error: "Este pago pertenece a un cobro múltiple y debe administrarse desde el cobro completo." }, 409);
  }

  if (current.rendered && hasContableChange) {
    return c.json({ error: "Este pago ya fue rendido. Anulá la rendición primero." }, 409);
  }

  // Enforce: si el payment resultante tiene installmentId, payments.dueDate debe ser null
  const effectiveInstallmentId = "installmentId" in update ? update.installmentId : current.installmentId;
  if (effectiveInstallmentId != null) {
    update.dueDate = null;
  }

  // Etapa 3B: se necesita conocer el desglose actual tanto para decidir si
  // un edit "legacy" (sin `splits`) es seguro, como para clasificar el grupo
  // (own/direct_company) cuando ni amount ni paymentMethod cambian.
  const existingSplitsCheck = await db.select({ id: paymentSplits.id, method: paymentSplits.method, amountCents: paymentSplits.amountCents })
    .from(paymentSplits).where(eq(paymentSplits.paymentId, id)).all();

  const effectiveAmount = Number("amount" in update ? update.amount : current.amount);
  const effectivePaymentMethodForSplit = ("paymentMethod" in update ? update.paymentMethod : current.paymentMethod) as string;
  const splitFieldsChanged = ("amount" in update) || ("paymentMethod" in update);

  // Migración 0028: si algún split actual tiene received_checks reales
  // colgando (payment_split_id), reemplazar/reconstruir el desglose (bulk
  // `splits`, o el atajo legacy de amount/paymentMethod que hace
  // DELETE+INSERT o UPDATE in-place del split) dejaría esos cheques
  // huérfanos o con datos desalineados. Se rechaza explícitamente — mismo
  // criterio que current.rendered/current.batchId más arriba.
  if (bodyHasSplits || splitFieldsChanged) {
    const existingSplitIds = existingSplitsCheck.map((s) => s.id);
    const attachedChecks = existingSplitIds.length > 0
      ? await db.select({ id: receivedChecks.id }).from(receivedChecks)
        .where(inArray(receivedChecks.paymentSplitId, existingSplitIds)).all()
      : [];
    if (attachedChecks.length > 0) {
      return c.json({ error: "Este pago tiene cheques asociados. Para corregirlo, anulá el pago y cargalo nuevamente." }, 409);
    }
  }

  let normalizedSplitUpdate: ReturnType<typeof validateAndNormalizeSplits> | null = null;
  let finalSplitGroup: SplitGroup;

  if (bodyHasSplits) {
    // Reemplazo completo del desglose — se valida entero antes de tocar nada.
    try {
      normalizedSplitUpdate = validateAndNormalizeSplits({ paymentAmount: effectiveAmount, splits: body.splits });
    } catch (e: any) {
      if (e instanceof SplitValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
    finalSplitGroup = classifySplitGroup(normalizedSplitUpdate.splits);
    if (finalSplitGroup === "mixed") {
      return c.json({ error: "No se pueden combinar medios propios con pagos directos a la compañía en un mismo cobro." }, 400);
    }
    // Igual que en POST: con `splits` explícito, el paymentMethod del padre
    // nunca sale del valor crudo que haya mandado el caller — se deriva.
    update.paymentMethod = normalizedSplitUpdate.splits.length === 1
      ? normalizedSplitUpdate.splits[0]!.method
      : "combinado";
  } else if (splitFieldsChanged) {
    // Compatibilidad con clientes que todavía no envían `splits`: solo es
    // seguro reconstruir un único split si el payment tiene EXACTAMENTE uno
    // hoy. Si ya es un combinado (o está en un estado 0/2+ inconsistente), no
    // se puede adivinar cómo redistribuir amount/paymentMethod entre splits
    // existentes — se rechaza pidiendo el desglose completo, en vez de
    // corromper silenciosamente un cobro combinado.
    if (existingSplitsCheck.length !== 1) {
      return c.json({
        error: `El pago tiene ${existingSplitsCheck.length} split(s) — para modificar el importe o el método de un cobro combinado debe enviarse el desglose completo (\`splits\`).`,
      }, 409);
    }
    try {
      normalizedSplitUpdate = validateAndNormalizeSplits({
        paymentAmount: effectiveAmount,
        splits: [{ method: effectivePaymentMethodForSplit, amount: effectiveAmount }],
      });
    } catch (e: any) {
      if (e instanceof SplitValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
    finalSplitGroup = classifySplitGroup(normalizedSplitUpdate.splits);
  } else {
    // Ni `splits` ni amount/paymentMethod cambian — el grupo se deriva del
    // desglose actual sin tocarlo (ej. anulación, cambio de notas, etc.).
    finalSplitGroup = classifySplitGroup(existingSplitsCheck);
  }

  // Si cambia installmentId a un valor no nulo, la nueva cuota debe existir y
  // (si también hay policyId efectivo) pertenecerle — mismo criterio que POST.
  const effectivePolicyIdForInstallment = ("policyId" in update ? update.policyId : current.policyId) as number | null;
  let newInstallmentRow: { id: number; amount: number; policyId: number; status: string } | null = null;
  if ("installmentId" in update && update.installmentId != null) {
    newInstallmentRow = await db.select({
      id: policyInstallments.id, amount: policyInstallments.amount,
      policyId: policyInstallments.policyId, status: policyInstallments.status,
    }).from(policyInstallments).where(eq(policyInstallments.id, Number(update.installmentId))).get() ?? null;
    if (!newInstallmentRow) return c.json({ error: "La cuota indicada no existe." }, 404);
    if (effectivePolicyIdForInstallment != null && newInstallmentRow.policyId !== effectivePolicyIdForInstallment) {
      return c.json({ error: "La cuota indicada no pertenece a la póliza indicada." }, 400);
    }
    // Mismo bloqueo que POST /payments: no se puede mover un pago a una cuota
    // que la anulación de su póliza ya dejó no exigible.
    if (isInstallmentNonCollectible(newInstallmentRow.status)) {
      return c.json({ error: "La cuota indicada no es exigible: la póliza fue anulada antes de su vencimiento." }, 409);
    }
  }

  // Importe vs. cuota: mismo criterio que POST — un pago confirmado vinculado
  // a una cuota debe coincidir exactamente en centavos con el importe de esa
  // cuota, y esa cuota no puede tener ya otro pago confirmado válido (evita
  // duplicar el cobro). Solo se revalida si algo relevante cambió.
  const effectiveStatusForAmountCheck = ("status" in update ? update.status : current.status) as string;
  const amountVsInstallmentRelevant = ("amount" in update) || ("installmentId" in update) || ("status" in update);
  if (amountVsInstallmentRelevant && effectiveInstallmentId != null && effectiveStatusForAmountCheck === "confirmado") {
    const installmentRow = newInstallmentRow ?? await db.select({
      id: policyInstallments.id, amount: policyInstallments.amount,
      policyId: policyInstallments.policyId, status: policyInstallments.status,
    }).from(policyInstallments).where(eq(policyInstallments.id, Number(effectiveInstallmentId))).get();
    if (!installmentRow) return c.json({ error: "La cuota indicada no existe." }, 404);
    const expectedCents = Math.round(installmentRow.amount * 100);
    const gotCents = Math.round(effectiveAmount * 100);
    if (gotCents !== expectedCents) {
      return c.json({
        error: `El importe del pago ($${(gotCents / 100).toFixed(2)}) no coincide con el importe de la cuota ($${(expectedCents / 100).toFixed(2)}). Los pagos parciales todavía no están habilitados.`,
      }, 400);
    }
    if (installmentRow.status === "pagada") {
      const otherConfirmed = await db.select({ id: payments.id, amount: payments.amount }).from(payments)
        .where(and(eq(payments.installmentId, installmentRow.id), eq(payments.status, "confirmado"), ne(payments.id, id))).all();
      const hasOtherValid = otherConfirmed.some((p) => Math.round(p.amount * 100) === expectedCents);
      if (hasOtherValid) {
        return c.json({ error: "La cuota indicada ya tiene otro pago confirmado que la cubre." }, 409);
      }
    }
  }

  // Read existing surcharge before transaction
  const existingSurcharge = await db.select().from(cashEntries)
    .where(and(eq(cashEntries.paymentId, id), eq(cashEntries.entryType, "pronto_pago_surcharge"))).get();

  // Effective values after update (for surcharge sync/creation)
  const effectivePolicyId = ("policyId" in update ? update.policyId : current.policyId) as number | null;
  const effectivePaymentMethod = ("paymentMethod" in update ? update.paymentMethod : current.paymentMethod) as string;
  const effectivePaymentDate = ("paymentDate" in update ? update.paymentDate : current.paymentDate) as string;
  const effectiveStatus = ("status" in update ? update.status : current.status) as string;

  // Un recargo ya rendido no se puede tocar sin anular la rendición primero,
  // sin importar si la baja viene de applyProntoPagoSurcharge=false o de
  // anular el payment que lo generó — mismo criterio en ambos casos.
  if ((body.applyProntoPagoSurcharge === false || effectiveStatus === "anulado") && existingSurcharge?.rendered) {
    return c.json({ error: "El recargo ya fue rendido. Anulá la rendición primero." }, 409);
  }

  // Resolve company/insured (needed unless we're only deleting the surcharge)
  let resolvedCompany: string | null = null;
  let resolvedClient: string | null = null;
  let resolvedPolicyNumber: string | null = null;
  if (body.applyProntoPagoSurcharge !== false) {
    if (effectivePolicyId) {
      const pRow = await db.select({
        companyName: companies.name,
        insuredName: insureds.name,
        policyNumber: policies.policyNumber,
      }).from(policies)
        .innerJoin(companies, eq(policies.companyId, companies.id))
        .innerJoin(insureds, eq(policies.insuredId, insureds.id))
        .where(eq(policies.id, effectivePolicyId)).get();
      resolvedCompany = pRow?.companyName ?? null;
      resolvedClient = pRow?.insuredName ?? null;
      resolvedPolicyNumber = pRow?.policyNumber ?? null;
    } else {
      resolvedCompany = ("manualCompany" in update ? update.manualCompany : current.manualCompany) ?? null;
      resolvedClient = ("manualPayer" in update ? update.manualPayer : current.manualPayer) ?? null;
      resolvedPolicyNumber = ("manualPolicyNumber" in update ? update.manualPolicyNumber : current.manualPolicyNumber) ?? null;
    }
  }

  const oldInstallmentId = current.installmentId;
  const newInstallmentId = "installmentId" in update ? update.installmentId : current.installmentId;
  const shouldRecalcInstallment = ("installmentId" in update) || ("status" in update) || ("amount" in update);

  const [payment] = await db.transaction(async (tx) => {
    // `update` puede quedar vacío si el body solo trae applyProntoPagoSurcharge
    // (sin ningún campo de la tabla payments) — drizzle no acepta un
    // .set({}) vacío, así que en ese caso no se toca `payments` en absoluto.
    const [p] = Object.keys(update).length > 0
      ? await tx.update(payments).set(update).where(eq(payments.id, id)).returning()
      : [current];

    if (bodyHasSplits && normalizedSplitUpdate) {
      // Etapa 3B: reemplazo completo del desglose (no diff por id) — se
      // valida entero antes de la transacción, así que acá solo se aplica.
      await tx.delete(paymentSplits).where(eq(paymentSplits.paymentId, id));
      await tx.insert(paymentSplits).values(normalizedSplitUpdate.splits.map((s) => ({
        paymentId: id, method: s.method, amountCents: s.amountCents, notes: s.notes,
      })));
    } else if (normalizedSplitUpdate) {
      // Compatibilidad legacy (sin `splits`, payment con exactamente 1 split
      // hoy): se actualiza in-place, no se borra/recrea — conserva el mismo
      // split.id, igual que en Etapa 3A.
      const existingSplits = await tx.select({ id: paymentSplits.id }).from(paymentSplits)
        .where(eq(paymentSplits.paymentId, id)).all();
      if (existingSplits.length !== 1) {
        throw new Error(`El pago ${id} tiene ${existingSplits.length} splits — se esperaba exactamente 1 para esta ruta de compatibilidad.`);
      }
      const onlySplit = normalizedSplitUpdate.splits[0]!;
      await tx.update(paymentSplits).set({
        method: onlySplit.method, amountCents: onlySplit.amountCents,
      }).where(eq(paymentSplits.id, existingSplits[0]!.id));
    }

    if (shouldRecalcInstallment) {
      if (oldInstallmentId != null) await recalculateInstallmentPaymentStatus(tx, oldInstallmentId);
      if (newInstallmentId != null && newInstallmentId !== oldInstallmentId) {
        await recalculateInstallmentPaymentStatus(tx, newInstallmentId);
      }
    }

    if (effectiveStatus === "anulado") {
      // Un pago anulado nunca debe dejar un recargo Pronto Pago activo
      // colgado (contaría indefinidamente en recargosProntoPago aunque el
      // cobro que lo originó ya no valga) — se borra sin importar qué mandó
      // el caller en applyProntoPagoSurcharge. Ya se validó arriba que, si
      // existe, no está rendido (si lo estuviera, se rechazó con 409 antes
      // de llegar a la transacción).
      if (existingSurcharge && !existingSurcharge.rendered) {
        await tx.delete(cashEntries).where(eq(cashEntries.id, existingSurcharge.id));
      }
      // Migración 0028: un pago anulado no debe dejar sus received_checks
      // en_cartera como si siguieran siendo cobrables — se transicionan a
      // anulado, nunca se borran (mismo criterio que POST
      // /payment-batches/:id/cancel). Este pago nunca llega acá si ya está
      // rendido (bloqueado más arriba), así que sus cheques, si existen,
      // están siempre en_cartera todavía — la transición nunca puede fallar
      // por estado.
      const splitIdsForCancel = existingSplitsCheck.map((s) => s.id);
      const checksToCancel = splitIdsForCancel.length > 0
        ? await tx.select({ id: receivedChecks.id, status: receivedChecks.status }).from(receivedChecks)
          .where(inArray(receivedChecks.paymentSplitId, splitIdsForCancel)).all()
        : [];
      for (const chk of checksToCancel) {
        validateCheckStatusTransition(chk.status as any, "anulado");
        await tx.update(receivedChecks).set({ status: "anulado", cancelledAt: new Date(), updatedAt: new Date() })
          .where(eq(receivedChecks.id, chk.id));
      }
    } else if (body.applyProntoPagoSurcharge === false) {
      if (existingSurcharge) {
        await tx.delete(cashEntries).where(eq(cashEntries.id, existingSurcharge.id));
      }
    } else if (body.applyProntoPagoSurcharge === true) {
      // Etapa 3B: calificación por grupo de splits (finalSplitGroup), no por
      // effectivePaymentMethod — que puede valer "combinado" y no representa
      // ningún método real. finalSplitGroup ya está garantizado no-mixed.
      const isRivadavia = resolvedCompany?.toLowerCase().includes("rivadavia") ?? false;
      if (isRivadavia && finalSplitGroup === "own" && effectiveStatus !== "anulado") {
        if (!existingSurcharge) {
          await tx.insert(cashEntries).values({
            clientName: resolvedClient ?? "—",
            policyNumber: resolvedPolicyNumber ?? null,
            companyName: resolvedCompany ?? null,
            amount: SURCHARGE_AMOUNT,
            paymentMethod: effectivePaymentMethod,
            paymentDate: effectivePaymentDate,
            entryType: "pronto_pago_surcharge",
            paymentId: id,
            rendered: 0,
            notes: "Recargo Pronto Pago Rivadavia",
            createdBy: p.createdBy,
          });
        } else if (!existingSurcharge.rendered) {
          await tx.update(cashEntries).set({
            paymentMethod: effectivePaymentMethod,
            paymentDate: effectivePaymentDate,
            clientName: resolvedClient ?? "—",
            policyNumber: resolvedPolicyNumber ?? null,
            companyName: resolvedCompany ?? null,
          }).where(eq(cashEntries.id, existingSurcharge.id));
        }
      }
    } else {
      // applyProntoPagoSurcharge absent: el caller no tocó el checkbox (el
      // frontend deja de mandarlo apenas la póliza/compañía efectiva deja de
      // ser Rivadavia — ver showSurchargeCheckbox en cobranzas.tsx), pero el
      // pago puede haber dejado de calificar igual (se corrigió la póliza a
      // otra compañía, o el grupo de medios dejó de ser "own"). Sin este
      // chequeo el recargo existente quedaba huérfano sin borrarse: seguía
      // contando como real en GET /remittances/pending y en el total de
      // POST /remittances aunque el pago ya no fuera de Rivadavia (hotfix
      // Pronto Pago Rivadavia — mismo criterio de "sigue calificando" que la
      // rama applyProntoPagoSurcharge===true de arriba).
      if (existingSurcharge && !existingSurcharge.rendered) {
        const isRivadavia = resolvedCompany?.toLowerCase().includes("rivadavia") ?? false;
        const stillQualifies = isRivadavia && finalSplitGroup === "own" && effectiveStatus !== "anulado";
        if (!stillQualifies) {
          await tx.delete(cashEntries).where(eq(cashEntries.id, existingSurcharge.id));
        } else if (hasContableChange) {
          await tx.update(cashEntries).set({
            paymentMethod: effectivePaymentMethod,
            paymentDate: effectivePaymentDate,
            clientName: resolvedClient ?? existingSurcharge.clientName,
            policyNumber: resolvedPolicyNumber ?? existingSurcharge.policyNumber,
            companyName: resolvedCompany ?? existingSurcharge.companyName,
          }).where(eq(cashEntries.id, existingSurcharge.id));
        }
      }
    }

    return [p];
  });

  const splitsRows = await db.select().from(paymentSplits).where(eq(paymentSplits.paymentId, payment.id)).all();
  return c.json({ ...payment, splits: splitsRows }, 200);
}));

app.delete("/payments/:id", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  const current = await db.select({ id: payments.id, rendered: payments.rendered, installmentId: payments.installmentId, batchId: payments.batchId })
    .from(payments).where(eq(payments.id, id)).get();
  if (!current) return c.json({ error: "Pago no encontrado" }, 404);
  // Etapa 4A: no se borra un hijo de batch por separado — ver mismo criterio
  // en PUT /payments/:id.
  if (current.batchId != null) {
    return c.json({ error: "Este pago pertenece a un cobro múltiple y debe administrarse desde el cobro completo." }, 409);
  }
  if (current.rendered) return c.json({ error: "Este pago ya fue rendido. Anulá la rendición primero." }, 409);

  // Migración 0028: un split cheque de este pago puede tener received_checks
  // reales colgando (payment_split_id) — borrar payment_splits físicamente
  // los dejaría huérfanos. Mismo criterio que ya usa 0022/0023 para
  // payment_batch_splits (ON DELETE RESTRICT documental): se prefiere
  // rechazar explícitamente antes que perder en silencio la trazabilidad de
  // un cheque real. anulá (PUT status="anulado") en cambio — no toca splits.
  const existingSplitIdsForDelete = await db.select({ id: paymentSplits.id }).from(paymentSplits)
    .where(eq(paymentSplits.paymentId, id)).all();
  if (existingSplitIdsForDelete.length > 0) {
    const attachedChecks = await db.select({ id: receivedChecks.id }).from(receivedChecks)
      .where(inArray(receivedChecks.paymentSplitId, existingSplitIdsForDelete.map((s) => s.id))).all();
    if (attachedChecks.length > 0) {
      return c.json({ error: "Este pago tiene cheques asociados. Para corregirlo, anulá el pago y cargalo nuevamente." }, 409);
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(cashEntries).where(
      and(eq(cashEntries.paymentId, id), eq(cashEntries.entryType, "pronto_pago_surcharge"), eq(cashEntries.rendered, 0))
    );
    await tx.delete(paymentSplits).where(eq(paymentSplits.paymentId, id));
    await tx.delete(payments).where(eq(payments.id, id));
    // Etapa 3A: borrar el pago no debe dejar la cuota "pagada" sin ningún
    // payment confirmado vinculado — se recalcula tras el borrado.
    if (current.installmentId != null) {
      await recalculateInstallmentPaymentStatus(tx, current.installmentId);
    }
  });
  return c.json({ ok: true }, 200);
}));

// ─── CUOTAS PENDIENTES DE COBRO (para "Cobrar en lote") ────────────────────────
// Solo lectura. Lista cuotas realmente cobrables — mismo criterio de
// elegibilidad que POST /payment-batches (ver validateInstallmentsEligibility
// en lib/payments/batches.ts), para que el frontend nunca ofrezca seleccionar
// algo que el backend va a rechazar. No es la única autoridad: el POST vuelve
// a validar todo desde cero antes de escribir.
app.get("/installments/pending-for-payment", requireAuth(async (c: any) => {
  const { insuredId, search, companyId, policyId } = c.req.query();

  const conditions = [
    inArray(policyInstallments.status, ["pendiente", "vencida"]),
    eq(policyInstallments.rendered, 0),
    eq(policies.status, "activa"),
  ];
  if (insuredId) conditions.push(eq(policies.insuredId, Number(insuredId)));
  if (companyId) conditions.push(eq(policies.companyId, Number(companyId)));
  if (policyId) conditions.push(eq(policyInstallments.policyId, Number(policyId)));

  let rows = await db.select({
    installmentId: policyInstallments.id,
    installmentNumber: policyInstallments.number,
    dueDate: policyInstallments.dueDate,
    amount: policyInstallments.amount,
    status: policyInstallments.status,
    rebillingId: policyInstallments.rebillingId,
    policyId: policies.id,
    policyNumber: policies.policyNumber,
    policyType: policies.type,
    parentPolicyId: policies.parentPolicyId,
    insuredId: policies.insuredId,
    insuredName: insureds.name,
    companyId: companies.id,
    companyName: companies.name,
  }).from(policyInstallments)
    .innerJoin(policies, eq(policyInstallments.policyId, policies.id))
    .innerJoin(insureds, eq(policies.insuredId, insureds.id))
    .innerJoin(companies, eq(policies.companyId, companies.id))
    .where(and(...conditions))
    .all();

  // Excluir cuotas con un payment confirmado ya existente (standalone o hijo
  // de otro batch) — mismo chequeo que el POST hace antes de escribir, para
  // que la lista nunca ofrezca algo que el backend va a rechazar igual.
  if (rows.length > 0) {
    const candidateIds = rows.map((r) => r.installmentId);
    const confirmedRows = await db.select({ installmentId: payments.installmentId })
      .from(payments)
      .where(and(inArray(payments.installmentId, candidateIds), eq(payments.status, "confirmado")))
      .all();
    const confirmedIds = new Set(confirmedRows.map((p) => p.installmentId));
    rows = rows.filter((r) => !confirmedIds.has(r.installmentId));
  }

  if (search) {
    const needle = String(search).toLowerCase();
    rows = rows.filter((r) =>
      (r.insuredName ?? "").toLowerCase().includes(needle) ||
      (r.policyNumber ?? "").toLowerCase().includes(needle)
    );
  }

  rows.sort((a, b) =>
    (a.insuredName ?? "").localeCompare(b.insuredName ?? "") ||
    (a.dueDate ?? "").localeCompare(b.dueDate ?? "") ||
    (a.policyNumber ?? "").localeCompare(b.policyNumber ?? "") ||
    a.installmentNumber - b.installmentNumber
  );

  // parentPolicyNumber: solo para la pista visual "Accesoria de póliza X" en
  // el carrito de Cobrar en lote (ver policy-economic-group.ts) — nunca se
  // usa para decidir agrupación real (eso lo hace el backend con
  // parentPolicyId/type, no con el número mostrado). Una sola consulta
  // extra, no N+1, y se degrada a null sin romper nada si la principal no
  // está en este listado (ej. ya no tiene cuotas pendientes).
  const parentPolicyIds = [...new Set(rows.map((r) => r.parentPolicyId).filter((id): id is number => id != null))];
  const parentNumberById = new Map<number, string>();
  if (parentPolicyIds.length > 0) {
    const parentRows = await db.select({ id: policies.id, policyNumber: policies.policyNumber })
      .from(policies).where(inArray(policies.id, parentPolicyIds)).all();
    for (const p of parentRows) parentNumberById.set(p.id, p.policyNumber);
  }
  const result = rows.map((r) => ({
    ...r,
    parentPolicyNumber: r.parentPolicyId != null ? (parentNumberById.get(r.parentPolicyId) ?? null) : null,
  }));

  return c.json(result, 200);
}));

// ─── PAYMENT BATCHES (Etapa 4A/4B + cobro manual real) ─────────────────────────
// Un payment_batch es el encabezado de un cobro que imputa varios ítems del
// mismo asegurado en un solo evento real (ej. un cheque que cubre varias
// cuotas juntas). Cada ítem sigue siendo un payment hijo individual
// (payments.batchId), sin payment_splits propios — los medios reales viven
// una sola vez en payment_batch_splits. Ver src/lib/payments/batches.ts para
// el detalle de cada validación.
//
// Un ítem puede ser source="installment" (cuota existente, installmentId
// real) o source="manual_payment" (cobro real contra una póliza sin cuota
// puntual — mismo concepto que ya existía para POST /payments standalone
// cuando se manda policyId con installmentId vacío). UN COBRO MANUAL NUNCA ES
// UNA DEUDA: su payment hijo queda confirmado igual que cualquier otro,
// cuenta en Caja y se rinde como dinero real — la única diferencia es que
// installmentId queda NULL y no dispara recalculateInstallmentPaymentStatus
// (no hay cuota que recalcular). Nunca crea policy_installments, cash_debts,
// ni un remittance_item source='manual_debt'. Body legacy sin `source` (solo
// `{installmentId}`) sigue aceptándose como source="installment" — ver
// normalizeBatchItems.
//
// Etapa 4B agrega received_checks colgando de los splits method='cheque' —
// ver src/lib/payments/received-checks.ts. Bloqueos vigentes por ausencia
// deliberada de endpoints (documentado acá para Etapa 4C/4D, que sí los
// necesitará): no existe PUT/DELETE genérico de payment_batches ni de
// payment_batch_splits, así que ningún batch ni ningún split con cheques
// puede anularse/editarse/eliminarse todavía por ninguna vía pública; ningún
// payment hijo se borra individualmente (ver PUT/DELETE /payments/:id más
// abajo, que ya rechazan con 409 cualquier cambio monetario o baja de un
// hijo de batch); y no existe ningún endpoint para cambiar el status de un
// received_checks ni para entregarlo en una rendición — cuando se
// implemente, debe usar validateCheckStatusTransition/
// isCheckAvailableForRemittance de received-checks.ts, nunca escribir status
// a mano.
//
// LÍMITE CONOCIDO — doble submit / idempotencia: no existe una idempotency
// key persistida ni un constraint a nivel DB que impida crear dos batches
// para las mismas cuotas si dos requests llegan verdaderamente en paralelo
// (carrera real, no solo doble click con red normal). La mitigación de esta
// vuelta es de dos capas, ninguna de las cuales requiere migración:
//   1. Frontend: un "submission lock" (deshabilita el botón de confirmar
//      mientras la petición está en vuelo) — evita el caso común (doble
//      click), pero no una carrera entre dos pestañas/usuarios distintos.
//   2. Backend: el chequeo "sin payment confirmado ya existente" se repite
//      DENTRO de la transacción real (con `tx`, no con `db`), inmediatamente
//      antes de insertar — si la otra request ya escribió mientras esta
//      esperaba, esta aborta con 409 y no inserta nada (ver
//      PaymentBatchRaceConditionError más abajo). Esto reduce la ventana de
//      la carrera al mínimo posible sin cambiar el esquema, pero SQLite no
//      tiene aislamiento serializable real entre transacciones concurrentes
//      del mismo proceso salvo por el lock de escritura global que ya usa
//      libsql — en la práctica esto es suficiente para este volumen de uso,
//      pero no es una garantía formal de idempotencia. Una idempotency key
//      persistida (columna nueva + índice único) queda pendiente para
//      cuando se justifique una migración.
class PaymentBatchRaceConditionError extends Error {
  constructor(public installmentIds: number[]) {
    super(`Otra solicitud ya cobró la(s) cuota(s) ${installmentIds.join(", ")} mientras se procesaba este pedido.`);
  }
}
app.post("/payment-batches", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();

  if (!body.paymentDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.paymentDate)) {
    return c.json({ error: "Falta o es inválida la fecha de pago (YYYY-MM-DD)." }, 400);
  }
  // Etapa "lote multi-asegurado": ya NO se exige body.insuredId ni un
  // cliente elegido de antemano — un batch es una operación de cobro, no un
  // asegurado. Cada ítem resuelve su propio insuredId (o ninguno, si es una
  // imputación completamente manual) más abajo; el insuredId legacy del
  // batch se DERIVA al final (resolveBatchInsuredId), nunca se exige en el
  // body ni se valida contra él.

  // 1. Validación básica de forma (pura, sin tocar la base todavía).
  let normalizedItems;
  try {
    normalizedItems = normalizeBatchItems(body.items);
  } catch (e: any) {
    if (e instanceof PaymentBatchValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
  let normalizedSplits;
  try {
    normalizedSplits = normalizeBatchSplits(body.splits);
  } catch (e: any) {
    if (e instanceof PaymentBatchValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }

  // Etapa 4B: cheques por split cheque. Un split method='cheque' debe traer
  // ≥1 cheque cuya suma sea exacta al importe del split; ningún otro split
  // puede traer cheques. Los cheques nunca se vinculan a un payment hijo —
  // solo al split cheque que representan (ver received-checks.ts).
  interface SplitWithChecks { split: NormalizedPaymentBatchSplit; checks: NormalizedReceivedCheck[] }
  let splitsWithChecks: SplitWithChecks[];
  try {
    splitsWithChecks = normalizedSplits.map((split, i) => {
      const rawChecks = body.splits[i]?.checks;
      if (split.method === "cheque") {
        if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
          throw new PaymentBatchValidationError(`El split cheque (medio ${i + 1}) debe incluir al menos un cheque.`);
        }
        const checks = rawChecks.map((raw: any, j: number) => normalizeReceivedCheck(raw, `cheque ${j + 1} del medio ${i + 1}`));
        const totalsCheck = validateChecksMatchSplit(checks, split.amountCents);
        if (!totalsCheck.valid) throw new PaymentBatchValidationError(totalsCheck.errorMessage!);
        return { split, checks };
      }
      if (Array.isArray(rawChecks) && rawChecks.length > 0) {
        throw new PaymentBatchValidationError(`El medio ${i + 1} (${split.method}) no puede incluir cheques.`);
      }
      return { split, checks: [] };
    });
  } catch (e: any) {
    if (e instanceof PaymentBatchValidationError || e instanceof ReceivedCheckValidationError) {
      return c.json({ error: e.message }, 400);
    }
    throw e;
  }

  // 2-3. Cargar TODOS los orígenes reales — cuotas existentes y, para cobros
  // manuales, las pólizas indicadas — nunca se confía en
  // policyId/amount/companyId/insuredId/descripción del body. `contexts` se
  // llena por POSICIÓN (idx), nunca por matching de valor: un cobro manual
  // no tiene ningún id propio antes de insertarse (y dos cobros manuales del
  // mismo request pueden compartir policyId), así que installmentId no sirve
  // como clave universal como sí servía cuando todos los ítems eran cuotas.
  const installmentEntries: { item: Extract<NormalizedPaymentBatchItem, { source: "installment" }>; idx: number }[] = [];
  const policyManualEntries: { item: Extract<NormalizedPaymentBatchItem, { source: "policy_manual_payment" }>; idx: number }[] = [];
  const manualEntries: { item: Extract<NormalizedPaymentBatchItem, { source: "manual_payment" }>; idx: number }[] = [];
  normalizedItems.forEach((item, idx) => {
    if (item.source === "installment") installmentEntries.push({ item, idx });
    else if (item.source === "policy_manual_payment") policyManualEntries.push({ item, idx });
    else manualEntries.push({ item, idx });
  });

  const installmentIds = installmentEntries.map((x) => x.item.installmentId);
  const installmentRows = installmentIds.length > 0 ? await db.select({
    installmentId: policyInstallments.id,
    amount: policyInstallments.amount,
    installmentStatus: policyInstallments.status,
    rendered: policyInstallments.rendered,
    policyId: policies.id,
    policyNumber: policies.policyNumber,
    policyType: policies.type,
    parentPolicyId: policies.parentPolicyId,
    policyStatus: policies.status,
    insuredId: policies.insuredId,
    insuredName: insureds.name,
    companyName: companies.name,
  }).from(policyInstallments)
    .innerJoin(policies, eq(policyInstallments.policyId, policies.id))
    .innerJoin(insureds, eq(policies.insuredId, insureds.id))
    .innerJoin(companies, eq(policies.companyId, companies.id))
    .where(inArray(policyInstallments.id, installmentIds))
    .all() : [];

  if (installmentRows.length !== installmentIds.length) {
    const foundIds = new Set(installmentRows.map((r) => r.installmentId));
    const missing = installmentIds.filter((id) => !foundIds.has(id));
    return c.json({ error: `Las siguientes cuotas no existen: ${missing.join(", ")}.` }, 404);
  }
  const installmentRowsById = new Map(installmentRows.map((r) => [r.installmentId, r]));

  // Cobros manuales CON póliza real: la póliza debe existir de verdad —
  // asegurado/compañía se resuelven SIEMPRE desde ella, nunca del body
  // (mismo criterio que POST /payments para su modo "vincular a póliza, sin
  // cuota"). isRivadavia sale de la compañía REAL de esa póliza — misma
  // fuente confiable que un installment.
  const policyManualIds = [...new Set(policyManualEntries.map((x) => x.item.policyId))];
  const policyManualRows = policyManualIds.length > 0 ? await db.select({
    policyId: policies.id,
    policyNumber: policies.policyNumber,
    policyType: policies.type,
    parentPolicyId: policies.parentPolicyId,
    policyStatus: policies.status,
    insuredId: policies.insuredId,
    insuredName: insureds.name,
    companyName: companies.name,
  }).from(policies)
    .innerJoin(insureds, eq(policies.insuredId, insureds.id))
    .innerJoin(companies, eq(policies.companyId, companies.id))
    .where(inArray(policies.id, policyManualIds))
    .all() : [];

  if (policyManualRows.length !== policyManualIds.length) {
    const foundPolicyIds = new Set(policyManualRows.map((r) => r.policyId));
    const missing = policyManualIds.filter((id) => !foundPolicyIds.has(id));
    return c.json({ error: `Las siguientes pólizas no existen: ${missing.join(", ")}.` }, 404);
  }
  const policyManualRowsById = new Map(policyManualRows.map((r) => [r.policyId, r]));

  interface ItemDisplay { insuredName: string | null; policyNumber: string | null; companyName: string | null }
  const contexts: BatchItemContext[] = new Array(normalizedItems.length);
  const displays: ItemDisplay[] = new Array(normalizedItems.length);

  for (const { item, idx } of installmentEntries) {
    const r = installmentRowsById.get(item.installmentId)!;
    contexts[idx] = {
      kind: "installment",
      installmentId: r.installmentId,
      policyId: r.policyId,
      insuredId: r.insuredId,
      amount: r.amount,
      installmentStatus: r.installmentStatus,
      rendered: r.rendered,
      policyStatus: r.policyStatus,
      isRivadavia: (r.companyName ?? "").toLowerCase().includes("rivadavia"),
      policyType: r.policyType,
      parentPolicyId: r.parentPolicyId,
      description: null,
      manualPayer: null, manualPolicyNumber: null, manualCompany: null,
    };
    displays[idx] = { insuredName: r.insuredName, policyNumber: r.policyNumber, companyName: r.companyName };
  }
  for (const { item, idx } of policyManualEntries) {
    const r = policyManualRowsById.get(item.policyId)!;
    contexts[idx] = {
      kind: "policy_manual_payment",
      installmentId: null,
      policyId: r.policyId,
      insuredId: r.insuredId,
      amount: item.amountCents / 100,
      installmentStatus: null,
      rendered: null,
      policyStatus: r.policyStatus,
      isRivadavia: (r.companyName ?? "").toLowerCase().includes("rivadavia"),
      policyType: r.policyType,
      parentPolicyId: r.parentPolicyId,
      description: item.description,
      manualPayer: null, manualPolicyNumber: null, manualCompany: null,
    };
    displays[idx] = { insuredName: r.insuredName, policyNumber: r.policyNumber, companyName: r.companyName };
  }
  // Imputación completamente manual: sin ninguna fila real detrás — ni
  // póliza ni asegurado. insuredId SIEMPRE null (no hay ninguna fuente real
  // de la que derivarlo; ver resolveBatchInsuredId). isRivadavia SIEMPRE
  // false: una compañía tipeada a mano no es una fuente confiable para un
  // recargo automático de $800 (a diferencia del standalone histórico en
  // POST /payments, que sí lo hace por compatibilidad con datos viejos —
  // ver comentario de cabecera de batches.ts para la decisión completa).
  for (const { item, idx } of manualEntries) {
    contexts[idx] = {
      kind: "manual_payment",
      installmentId: null,
      policyId: null,
      insuredId: null,
      amount: item.amountCents / 100,
      installmentStatus: null,
      rendered: null,
      policyStatus: null,
      isRivadavia: false,
      policyType: null,
      parentPolicyId: null,
      description: item.description,
      manualPayer: item.manualPayer, manualPolicyNumber: item.manualPolicyNumber, manualCompany: item.manualCompany,
    };
    displays[idx] = { insuredName: item.manualPayer, policyNumber: item.manualPolicyNumber, companyName: item.manualCompany };
  }

  // 4. insuredId legacy del batch: DERIVADO de los ítems, nunca exigido ni
  // validado contra el body — un batch puede mezclar libremente ítems de
  // distintos asegurados (ver resolveBatchInsuredId). null si hay más de un
  // asegurado real entre los ítems, o si ninguno tiene uno.
  const derivedInsuredId = resolveBatchInsuredId(contexts);

  // 5. Estado de cada cuota + ausencia de pago confirmado ya existente.
  // Se distingue "ya pagada standalone" (batchId NULL) de "ya pertenece a
  // otro cobro por lote" (batchId NOT NULL) — mismo hecho de fondo (ya existe
  // un payment confirmado para esa cuota), pero el mensaje debe orientar al
  // usuario a la causa real en cada caso, no a una redacción genérica única.
  const alreadyPaidRows = await db.select({ installmentId: payments.installmentId, batchId: payments.batchId })
    .from(payments)
    .where(and(inArray(payments.installmentId, installmentIds), eq(payments.status, "confirmado")))
    .all();
  if (alreadyPaidRows.length > 0) {
    const standaloneIds = alreadyPaidRows.filter((p) => p.batchId == null).map((p) => p.installmentId);
    const batchChildIds = alreadyPaidRows.filter((p) => p.batchId != null).map((p) => p.installmentId);
    const messages = [
      ...standaloneIds.map((id) => `La cuota ${id} ya está pagada.`),
      ...batchChildIds.map((id) => `La cuota ${id} ya pertenece a otro cobro por lote.`),
    ];
    return c.json({
      error: messages.join(" "),
      blockingInstallmentIds: alreadyPaidRows.map((p) => p.installmentId),
    }, 409);
  }
  try {
    validateInstallmentsEligibility(contexts);
  } catch (e: any) {
    if (e instanceof PaymentBatchValidationError) return c.json({ error: e.message }, 409);
    throw e;
  }

  // 6. Base = suma de las cuotas (importe exacto de cada una, sin parciales
  // — el body nunca manda un importe por cuota, ver normalizeBatchItems).
  const baseAmountCents = calculateBaseAmountCents(contexts);

  // 7. Grupo de los medios — mixed se rechaza antes de cualquier escritura.
  let splitGroup: SplitGroup;
  try {
    splitGroup = resolveBatchSplitGroup(normalizedSplits);
  } catch (e: any) {
    if (e instanceof PaymentBatchValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }

  // 8. Recargos Pronto Pago aplicables: $800 por ítem Rivadavia (cuota o
  // cobro manual), solo si TODOS los medios son "own" — nunca por recibo ni
  // por póliza. calculateApplicableRivadaviaSurcharges devuelve los
  // contextos concretos (no ids: un cobro manual no tiene installmentId) —
  // se comparan por identidad de objeto contra `contexts`, con el que
  // comparten referencia porque salen de filtrar ese mismo array.
  const applyProntoPagoSurcharge = body.applyProntoPagoSurcharge !== false;
  const applicableSurchargeContexts = applyProntoPagoSurcharge
    ? calculateApplicableRivadaviaSurcharges(contexts, splitGroup)
    : [];
  const applicableSurchargeSet = new Set(applicableSurchargeContexts);
  const surchargeAmountCents = applicableSurchargeContexts.length * SURCHARGE_AMOUNT_CENTS;

  // 9. Total APLICADO = base + recargos (totals.totalReceivedCents — columna
  // legacy, sin cambio de nombre ni de significado: sigue siendo lo imputado
  // a cuotas, nunca dinero real por sí sola).
  const totals = calculateBatchTotals(baseAmountCents, surchargeAmountCents);

  // 10. Dinero real RECIBIDO vs APLICADO (Fase 2B — sobrantes/faltantes, ver
  // diagnóstico de diseño cerrado 2026-07-21 y Migración 0030).
  // receivedCents = SUM(splits) — dinero real: un cheque nunca se "achica"
  // para cerrar contra las cuotas elegidas (validateChecksMatchSplit, sin
  // cambios, sigue exigiendo que la suma de cheques cierre EXACTO contra su
  // split cheque — la diferencia se resuelve acá, a nivel de TOTAL del
  // cobro, nunca a nivel de un instrumento físico individual).
  // appliedCents = totals.totalReceivedCents, lo imputado a las cuotas
  // elegidas — no cambia con esta fase.
  //
  // Si difieren, el caller debe resolverlo EXPLÍCITAMENTE con
  // accountDifferenceResolution — el backend nunca inventa a qué asegurado
  // atribuir la diferencia, ni aplica un saldo a favor preexistente todavía
  // (fase posterior). Sin diferencia, comportamiento idéntico al de antes de
  // esta fase (ni siquiera se mira accountDifferenceResolution si vino).
  const appliedCents = totals.totalReceivedCents;
  const receivedCents = normalizedSplits.reduce((sum, s) => sum + s.amountCents, 0);
  const difference = calculateBatchReceivedAppliedDifference(receivedCents, appliedCents);

  let accountMovementToCreate: { type: "saldo_a_favor" | "saldo_deudor"; reason: string | null } | null = null;

  if (difference.kind !== "exacto") {
    const expectedAction = difference.kind; // "saldo_a_favor" | "saldo_deudor" — únicas 2 acciones soportadas en esta fase
    const resolution = body.accountDifferenceResolution;

    if (resolution == null || typeof resolution !== "object") {
      return c.json({
        error:
          `La suma de los medios ($${(receivedCents / 100).toFixed(2)}) no coincide con el total a aplicar a las cuotas ` +
          `($${(appliedCents / 100).toFixed(2)}). Indicá accountDifferenceResolution.action ("saldo_a_favor" o ` +
          `"saldo_deudor") para continuar.`,
        code: "PAYMENT_BATCH_AMOUNT_DIFFERENCE",
        receivedCents, appliedCents, differenceCents: difference.differenceCents,
      }, 400);
    }
    // Cualquier action fuera de las 2 soportadas hoy (incluido, a propósito,
    // un futuro "ajuste_manual"/"devolucion_inmediata" — Caso D, no
    // implementado todavía) se rechaza acá con un mensaje explícito, en vez
    // de caer silenciosamente a ningún branch.
    if (resolution.action !== "saldo_a_favor" && resolution.action !== "saldo_deudor") {
      return c.json({ error: `accountDifferenceResolution.action no soportada en esta etapa: "${resolution.action}".` }, 400);
    }
    if (resolution.action !== expectedAction) {
      return c.json({
        error:
          `accountDifferenceResolution.action ("${resolution.action}") no coincide con el sentido real de la diferencia ` +
          `("${expectedAction}").`,
      }, 400);
    }
    // Multiasegurado (Regla 5) y 100% manual_payment sin asegurado real
    // (Caso B) comparten la misma señal: resolveBatchInsuredId ya devuelve
    // null en ambos casos — ningún dueño único al que atribuir la diferencia.
    if (derivedInsuredId == null) {
      return c.json({
        error:
          "No se puede determinar un único asegurado real para asignar la diferencia de este cobro (el cobro mezcla más de " +
          "un asegurado, o es una imputación 100% manual sin asegurado real). Separá este cobro para poder generar el saldo.",
      }, 400);
    }
    const reason = typeof resolution.reason === "string" && resolution.reason.trim() ? resolution.reason.trim() : null;
    try {
      validateInsuredAccountMovement({
        insuredId: derivedInsuredId,
        type: resolution.action,
        signedAmountCents: difference.differenceCents,
        reason,
      });
    } catch (e: any) {
      if (e instanceof InsuredAccountValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
    accountMovementToCreate = { type: resolution.action, reason };
  }

  // Detección informativa de posibles cheques duplicados (banco+número contra
  // la cartera VIGENTE — ver loadActiveExistingChecksForDuplicateCheck, un
  // cheque de una operación anulada nunca cuenta). Nunca bloquea sola — solo
  // si hay coincidencia Y el caller no mandó confirmPossibleDuplicates:true.
  // La confirmación NO saltea ninguna otra validación (ya corrieron todas
  // arriba).
  const allNewChecks = splitsWithChecks.flatMap((s) => s.checks);
  if (allNewChecks.length > 0) {
    const bankNames = [...new Set(allNewChecks.map((chk) => chk.bankName))];
    const existingChecks = await loadActiveExistingChecksForDuplicateCheck(db, bankNames);

    const duplicates = allNewChecks
      .map((chk) => ({ bankName: chk.bankName, checkNumber: chk.checkNumber, matches: findPossibleCheckDuplicates(chk, existingChecks) }))
      .filter((d) => d.matches.length > 0);

    if (duplicates.length > 0 && body.confirmPossibleDuplicates !== true) {
      return c.json({
        error: "Se detectaron posibles cheques duplicados (mismo banco y número que cheques ya cargados). Confirmá para continuar.",
        code: "CHECK_POSSIBLE_DUPLICATE",
        duplicates,
      }, 409);
    }
  }

  // 11-16. Todo o nada: batch, splits, hijos, recargos y recálculo de cuotas
  // en una sola transacción real.
  let batchId: number;
  try {
    batchId = await db.transaction(async (tx) => {
    // El batch se inserta PRIMERO — así la transacción abre en modo escritura
    // desde su primera sentencia (igual que antes de este cambio), en vez de
    // abrir con un SELECT (modo deferred) y recién escalar a escritura en el
    // primer INSERT — ese patrón generaba contención real de locks bajo
    // corridas concurrentes (comprobado: agregar el SELECT como primera
    // sentencia hizo que la suite completa de tests pasara de ~18s a >800s
    // con fallas intermitentes). El re-chequeo de la carrera (ver nota de
    // "LÍMITE CONOCIDO" arriba) sigue siendo real: si encuentra un pago
    // confirmado que no estaba antes, tira la excepción y toda la
    // transacción — incluido este insert — se revierte igual.
    const [batch] = await tx.insert(paymentBatches).values({
      insuredId: derivedInsuredId,
      baseAmountCents: totals.baseAmountCents,
      surchargeAmountCents: totals.surchargeAmountCents,
      totalReceivedCents: totals.totalReceivedCents,
      // Fase 2B: dinero real recibido — SIEMPRE SUM(splits), sin excepción
      // (Regla 3), esté o no esté "exacto" contra lo aplicado.
      receivedAmountCents: receivedCents,
      paymentDate: body.paymentDate,
      status: "confirmado",
      notes: body.notes || null,
      createdBy: user.id,
    }).returning();

    // Re-chequeo DENTRO de la transacción real, ya en modo escritura (ver
    // comentario arriba). Si otra request confirmó un pago para alguna de
    // estas cuotas entre el chequeo de más arriba (fuera de la tx) y este
    // punto, se aborta acá — el rollback deshace también el insert del batch
    // recién hecho, así que no queda nada a medias.
    const raceCheck = await tx.select({ installmentId: payments.installmentId })
      .from(payments)
      .where(and(inArray(payments.installmentId, installmentIds), eq(payments.status, "confirmado")))
      .all();
    if (raceCheck.length > 0) {
      throw new PaymentBatchRaceConditionError(raceCheck.map((p: any) => p.installmentId));
    }

    // Splits uno por uno (no bulk) porque cada split cheque necesita su
    // propio id ya generado antes de poder insertar los cheques que cuelgan
    // de él — nunca se confía en un id de split que mande el frontend.
    for (const { split, checks } of splitsWithChecks) {
      const [insertedSplit] = await tx.insert(paymentBatchSplits).values({
        batchId: batch!.id, method: split.method, amountCents: split.amountCents, notes: split.notes,
      }).returning();

      if (checks.length > 0) {
        await tx.insert(receivedChecks).values(checks.map((chk) => ({
          batchSplitId: insertedSplit!.id,
          checkNumber: chk.checkNumber,
          bankName: chk.bankName,
          bankCode: chk.bankCode,
          drawerName: chk.drawerName,
          drawerDocument: chk.drawerDocument,
          issueDate: chk.issueDate,
          dueDate: chk.dueDate,
          amountCents: chk.amountCents,
          currency: chk.currency,
          status: "en_cartera",
          notes: chk.notes,
          receivedAt: new Date(),
          createdBy: user.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })));
      }
    }

    // Único hijo "sin ambigüedad" del batch — solo se usa para
    // relatedPaymentId/relatedInstallmentId de un eventual saldo_deudor (ver
    // más abajo). Con 2+ ítems no hay forma no ambigua de elegir "la cuota
    // relacionada" entre varias, así que esos campos quedan null a propósito
    // (decisión documentada, ver Regla 4C del pedido).
    let singleChildId: number | null = null;

    for (let idx = 0; idx < contexts.length; idx++) {
      const ctxItem = contexts[idx]!;
      const display = displays[idx]!;

      // installmentId/policyId NULL para una imputación completamente
      // manual (sin ninguna fila real detrás); policyId real para un cobro
      // manual con póliza. notes = la descripción cargada (cualquier tipo de
      // cobro manual) — un payment hijo de cuota nunca tuvo notes propias en
      // este flujo. manualPayer/manualPolicyNumber/manualCompany solo se
      // completan para la imputación completamente libre — mismas columnas
      // que ya usa POST /payments standalone para su modo "Imputación
      // manual" (ver batches.ts).
      const [child] = await tx.insert(payments).values({
        policyId: ctxItem.policyId,
        installmentId: ctxItem.installmentId,
        amount: ctxItem.amount,
        paymentMethod: "lote",
        paymentDate: body.paymentDate,
        notes: ctxItem.kind !== "installment" ? ctxItem.description : null,
        manualPayer: ctxItem.kind === "manual_payment" ? ctxItem.manualPayer : null,
        manualPolicyNumber: ctxItem.kind === "manual_payment" ? ctxItem.manualPolicyNumber : null,
        manualCompany: ctxItem.kind === "manual_payment" ? ctxItem.manualCompany : null,
        status: "confirmado",
        batchId: batch!.id,
        createdBy: user.id,
      }).returning();

      if (contexts.length === 1) singleChildId = child!.id;

      if (applicableSurchargeSet.has(ctxItem)) {
        await tx.insert(cashEntries).values({
          clientName: display.insuredName ?? "—",
          policyNumber: display.policyNumber ?? null,
          companyName: display.companyName ?? null,
          amount: SURCHARGE_AMOUNT_CENTS / 100,
          paymentMethod: "lote",
          paymentDate: body.paymentDate,
          entryType: "pronto_pago_surcharge",
          paymentId: child!.id,
          rendered: 0,
          notes: "Recargo Pronto Pago Rivadavia",
          createdBy: user.id,
        });
      }

      // Solo una cuota real tiene un status que recalcular — un cobro
      // manual no tiene installmentId ni policy_installments detrás.
      if (ctxItem.kind === "installment") {
        await recalculateInstallmentPaymentStatus(tx, ctxItem.installmentId!);
      }
    }

    // Fase 2B: movimiento de cuenta corriente por la diferencia
    // recibido/aplicado, ya validado por completo antes de abrir esta
    // transacción (derivedInsuredId real único + accountDifferenceResolution
    // consistente) — acá solo se escribe.
    if (accountMovementToCreate) {
      const singleItem = contexts.length === 1 ? contexts[0]! : null;
      await tx.insert(insuredAccountMovements).values({
        insuredId: derivedInsuredId!,
        type: accountMovementToCreate.type,
        signedAmountCents: difference.differenceCents,
        status: "activo",
        originBatchId: batch!.id,
        relatedPaymentId: accountMovementToCreate.type === "saldo_deudor" ? singleChildId : null,
        relatedInstallmentId:
          accountMovementToCreate.type === "saldo_deudor" && singleItem?.kind === "installment"
            ? singleItem.installmentId
            : null,
        reason: accountMovementToCreate.reason,
        createdBy: user.id,
        createdAt: new Date(),
      });
    }

    return batch!.id;
    });
  } catch (e: any) {
    if (e instanceof PaymentBatchRaceConditionError) {
      return c.json({ error: e.message, blockingInstallmentIds: e.installmentIds }, 409);
    }
    // Contención real de escritura (dos requests verdaderamente simultáneas
    // — no solo secuenciales, ver "LÍMITE CONOCIDO" arriba). SQLite/libsql
    // puede rechazar la segunda transacción con SQLITE_BUSY en vez de
    // encolarla — se mapea a 409 en vez de dejar escapar un 500 crudo, para
    // que el frontend lo trate igual que cualquier otro conflicto de lote.
    const code = e?.code ?? e?.cause?.code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      return c.json({ error: "Otra operación está en curso sobre estas cuotas — reintentá en unos segundos." }, 409);
    }
    throw e;
  }

  return c.json({ id: batchId }, 201);
}));

// ─── Identificación de un batch multi-asegurado ────────────────────────────
// payment_batches.insured_id es un dato DERIVADO y con frecuencia NULL desde
// la migración 0026 (mezcla real, o batch 100% manual) — GET listado/detalle
// nunca deben depender de él como única fuente. Esta función arma, a partir
// de los hijos reales (payments) de un batch, una etiqueta siempre presente:
//   - "Varios asegurados" si hay más de una identidad real distinta entre
//     los hijos (dos+ insuredId reales, o mezcla de insuredId real + manual);
//   - el nombre real, si todos los hijos comparten el mismo insuredId;
//   - el pagador/póliza manual, si el batch es 100% manual_payment
//     (ninguna identidad real) — normalmente un único ítem, pero también
//     cubre el caso de varios manual_payment del mismo pagador;
//   - "Cobro múltiple" como fallback neutral (batch sin hijos, no debería
//     pasar nunca, pero nunca se deja sin etiqueta).
interface BatchChildIdentity {
  insuredId: number | null;
  insuredName: string | null;
  manualPayer: string | null;
  manualPolicyNumber: string | null;
}
interface BatchInsuredDisplay {
  insuredId: number | null;
  insuredName: string | null;
  insuredDisplay: string;
}
function computeBatchInsuredDisplay(children: BatchChildIdentity[]): BatchInsuredDisplay {
  if (children.length === 0) return { insuredId: null, insuredName: null, insuredDisplay: "Cobro múltiple" };
  const identities = new Map<string, string>();
  for (const c of children) {
    if (c.insuredId != null) {
      identities.set(`insured:${c.insuredId}`, c.insuredName ?? `Asegurado #${c.insuredId}`);
    } else {
      const label = c.manualPayer || c.manualPolicyNumber || "Cobro manual";
      identities.set(`manual:${label}`, label);
    }
  }
  if (identities.size > 1) return { insuredId: null, insuredName: null, insuredDisplay: "Varios asegurados" };
  const onlyLabel = [...identities.values()][0]!;
  const onlyRealChild = children.find((c) => c.insuredId != null) ?? null;
  return {
    insuredId: onlyRealChild?.insuredId ?? null,
    insuredName: onlyRealChild?.insuredName ?? null,
    insuredDisplay: onlyLabel,
  };
}

// GET /api/payment-batches — listado resumido, filtrable. Cada fila es un
// batch (nunca se multiplica por sus items/splits/checks) — los conteos se
// calculan aparte, agrupados por batchId, y se mezclan en memoria.
app.get("/payment-batches", requireAuth(async (c: any) => {
  const { insuredId, dateFrom, dateTo, status, limit, offset } = c.req.query();

  const conditions = [];
  // El filtro insuredId ya NO puede leerse directo de payment_batches.
  // insured_id (con frecuencia NULL) — busca batches que tengan ALGÚN hijo
  // cuya póliza pertenezca a ese asegurado, sin importar si el batch tiene
  // otros ítems de otros asegurados o manuales mezclados.
  if (insuredId) {
    const matchingBatchIdRows = await db.select({ batchId: payments.batchId })
      .from(payments)
      .innerJoin(policies, eq(payments.policyId, policies.id))
      .where(and(eq(policies.insuredId, Number(insuredId)), isNotNull(payments.batchId)))
      .all();
    const matchingBatchIds = [...new Set(matchingBatchIdRows.map((r) => r.batchId!))];
    conditions.push(matchingBatchIds.length > 0 ? inArray(paymentBatches.id, matchingBatchIds) : sql`0`);
  }
  if (dateFrom) conditions.push(gte(paymentBatches.paymentDate, String(dateFrom)));
  if (dateTo) conditions.push(lte(paymentBatches.paymentDate, String(dateTo)));
  if (status) conditions.push(eq(paymentBatches.status, String(status)));

  const parsedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const parsedOffset = Math.max(Number(offset) || 0, 0);

  const batchRows = await db.select({
    id: paymentBatches.id,
    paymentDate: paymentBatches.paymentDate,
    insuredId: paymentBatches.insuredId,
    insuredName: insureds.name,
    status: paymentBatches.status,
    baseAmountCents: paymentBatches.baseAmountCents,
    totalReceivedCents: paymentBatches.totalReceivedCents,
    // Fase 2G: dinero REAL recibido (ver comentario de cabecera de
    // receivedAmountCents en schema.ts) — sin este campo, el listado
    // "Cobros por lote recientes" no tiene forma de distinguir un
    // sobrante/faltante de un cobro exacto. Mismo campo ya expuesto en
    // GET /payment-batches/:id (Fase 2F) — nunca se cambia su significado.
    receivedAmountCents: paymentBatches.receivedAmountCents,
    notes: paymentBatches.notes,
    createdAt: paymentBatches.createdAt,
  }).from(paymentBatches)
    .leftJoin(insureds, eq(paymentBatches.insuredId, insureds.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(paymentBatches.paymentDate), desc(paymentBatches.id))
    .limit(parsedLimit)
    .offset(parsedOffset)
    .all();

  const batchIds = batchRows.map((b) => b.id);
  let itemCounts = new Map<number, number>();
  let splitCounts = new Map<number, number>();
  let checkCounts = new Map<number, number>();
  // Solo se recalcula por-hijo para los batches SIN insuredId propio — el
  // caso común (un solo asegurado real) ya viene resuelto por el JOIN de
  // arriba, sin consultas extra.
  let insuredDisplayByBatchId = new Map<number, BatchInsuredDisplay>();

  if (batchIds.length > 0) {
    const itemRows = await db.select({ batchId: payments.batchId, n: sql<number>`COUNT(*)` })
      .from(payments).where(inArray(payments.batchId, batchIds)).groupBy(payments.batchId).all();
    itemCounts = new Map(itemRows.map((r) => [r.batchId!, Number(r.n)]));

    const splitRows = await db.select({ batchId: paymentBatchSplits.batchId, n: sql<number>`COUNT(*)` })
      .from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIds)).groupBy(paymentBatchSplits.batchId).all();
    splitCounts = new Map(splitRows.map((r) => [r.batchId, Number(r.n)]));

    const checkRows = await db.select({ batchId: paymentBatchSplits.batchId, n: sql<number>`COUNT(*)` })
      .from(receivedChecks)
      .innerJoin(paymentBatchSplits, eq(receivedChecks.batchSplitId, paymentBatchSplits.id))
      .where(inArray(paymentBatchSplits.batchId, batchIds))
      .groupBy(paymentBatchSplits.batchId).all();
    checkCounts = new Map(checkRows.map((r) => [r.batchId, Number(r.n)]));

    const nullInsuredBatchIds = batchRows.filter((b) => b.insuredId == null).map((b) => b.id);
    if (nullInsuredBatchIds.length > 0) {
      const childRows = await db.select({
        batchId: payments.batchId,
        manualPayer: payments.manualPayer,
        manualPolicyNumber: payments.manualPolicyNumber,
        insuredId: policies.insuredId,
        insuredName: insureds.name,
      }).from(payments)
        .leftJoin(policies, eq(payments.policyId, policies.id))
        .leftJoin(insureds, eq(policies.insuredId, insureds.id))
        .where(inArray(payments.batchId, nullInsuredBatchIds))
        .all();
      const childrenByBatch = new Map<number, BatchChildIdentity[]>();
      for (const r of childRows) {
        const arr = childrenByBatch.get(r.batchId!) ?? [];
        arr.push({ insuredId: r.insuredId, insuredName: r.insuredName, manualPayer: r.manualPayer, manualPolicyNumber: r.manualPolicyNumber });
        childrenByBatch.set(r.batchId!, arr);
      }
      for (const bId of nullInsuredBatchIds) {
        insuredDisplayByBatchId.set(bId, computeBatchInsuredDisplay(childrenByBatch.get(bId) ?? []));
      }
    }
  }

  const result = batchRows.map((b) => {
    const display = b.insuredId != null
      ? { insuredId: b.insuredId, insuredName: b.insuredName, insuredDisplay: b.insuredName ?? "—" }
      : insuredDisplayByBatchId.get(b.id)!;
    return {
      id: b.id,
      paymentDate: b.paymentDate,
      insuredId: display.insuredId,
      insuredName: display.insuredName,
      insuredDisplay: display.insuredDisplay,
      status: b.status,
      totalAmountCents: b.baseAmountCents,
      totalReceivedCents: b.totalReceivedCents,
      receivedAmountCents: b.receivedAmountCents,
      itemCount: itemCounts.get(b.id) ?? 0,
      splitCount: splitCounts.get(b.id) ?? 0,
      checkCount: checkCounts.get(b.id) ?? 0,
      notes: b.notes,
      createdAt: b.createdAt,
    };
  });

  return c.json(result, 200);
}));

// GET /api/payment-batches/:id — lectura de auditoría (batch + hijos + cuotas
// + pólizas + compañías + splits + recargos + integridad recalculada). No
// integra todavía con GET /payments ni con Caja.
app.get("/payment-batches/:id", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, id)).get();
  if (!batch) return c.json({ error: "Cobro no encontrado" }, 404);

  const splitsRows = await db.select().from(paymentBatchSplits)
    .where(eq(paymentBatchSplits.batchId, id)).orderBy(asc(paymentBatchSplits.id)).all();

  // Etapa 4B: cheques de cada split cheque, en una sola consulta (sin N+1).
  const splitIds = splitsRows.map((s) => s.id);
  const checksRows = splitIds.length > 0
    ? await db.select().from(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).all()
    : [];
  const checksBySplitId = new Map<number, typeof checksRows>();
  for (const chk of checksRows) {
    const arr = checksBySplitId.get(chk.batchSplitId) ?? [];
    arr.push(chk);
    checksBySplitId.set(chk.batchSplitId, arr);
  }
  const splitsWithChecksOut = splitsRows.map((s) => ({ ...s, checks: checksBySplitId.get(s.id) ?? [] }));

  const childRows = await db.select({
    payment: payments, installment: policyInstallments, policy: policies, company: companies, insured: insureds,
  }).from(payments)
    .leftJoin(policyInstallments, eq(payments.installmentId, policyInstallments.id))
    .leftJoin(policies, eq(payments.policyId, policies.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .where(eq(payments.batchId, id))
    .all();

  // Etapa "lote multi-asegurado": el resumen de identificación se recalcula
  // SIEMPRE desde los hijos reales, sin importar qué haya quedado guardado
  // en batch.insuredId (dato derivado, puede ser null) — una sola fuente de
  // verdad, misma función que usa el listado.
  const insuredSummary = computeBatchInsuredDisplay(childRows.map((r) => ({
    insuredId: r.insured?.id ?? null,
    insuredName: r.insured?.name ?? null,
    manualPayer: r.payment.manualPayer,
    manualPolicyNumber: r.payment.manualPolicyNumber,
  })));

  const childIds = childRows.map((r) => r.payment.id);
  const surcharges = childIds.length > 0
    ? await db.select().from(cashEntries)
      .where(and(inArray(cashEntries.paymentId, childIds), eq(cashEntries.entryType, "pronto_pago_surcharge")))
      .all()
    : [];

  // Fase 2F: movimiento de cuenta corriente que este batch (o alguno de sus
  // hijos) originó por un sobrante/faltante (Fase 2B) — mismo criterio de
  // búsqueda que loadBatchCancelContext (Fase 2D, sección de anulación más
  // abajo), reutilizado acá SOLO para lectura/mostrar en el comprobante
  // (nunca se anula ni se crea nada desde este endpoint GET). Como máximo hay
  // un movimiento propio de este batch en la práctica (accountMovementToCreate
  // es 0 o 1 por creación, ver POST /payment-batches), pero se devuelve el
  // array completo tal cual, sin asumir cardinalidad, para no ocultar un caso
  // inesperado (ej. status="anulado" tras una anulación posterior del batch).
  const accountMovementConditions = [eq(insuredAccountMovements.originBatchId, id)];
  if (childIds.length > 0) accountMovementConditions.push(inArray(insuredAccountMovements.originPaymentId, childIds));
  const accountMovements = await db.select({
    id: insuredAccountMovements.id,
    insuredId: insuredAccountMovements.insuredId,
    type: insuredAccountMovements.type,
    signedAmountCents: insuredAccountMovements.signedAmountCents,
    status: insuredAccountMovements.status,
    reason: insuredAccountMovements.reason,
  }).from(insuredAccountMovements).where(or(...accountMovementConditions)).all();

  const baseFromChildren = childRows.reduce((s, r) => s + Math.round(r.payment.amount * 100), 0);
  const surchargeFromEntries = surcharges.reduce((s, e) => s + Math.round(e.amount * 100), 0);
  const splitsSum = splitsRows.reduce((s, sp) => s + sp.amountCents, 0);

  // Etapa 4B: integridad cheque-específica. cuequeSplitIds = únicamente los
  // splits method='cheque' de ESTE batch — la base de comparación de
  // "checksBelongOnlyToCheckSplits" (ningún cheque debería colgar de otro
  // split, algo que la FK ya impide, pero se verifica igual como chequeo de
  // integridad explícito, no solo implícito por construcción).
  const chequeSplitIds = new Set(splitsRows.filter((s) => s.method === "cheque").map((s) => s.id));
  const CHECK_VALID_STATUSES = new Set(["en_cartera", "entregado_compania", "cobrado", "rechazado", "anulado"]);

  const checkSplitsHaveChecks = [...chequeSplitIds].every((sid) => (checksBySplitId.get(sid)?.length ?? 0) > 0);
  const checkAmountsMatchSplits = splitsRows
    .filter((s) => s.method === "cheque")
    .every((s) => (checksBySplitId.get(s.id) ?? []).reduce((sum, chk) => sum + chk.amountCents, 0) === s.amountCents);
  const checksBelongOnlyToCheckSplits = checksRows.every((chk) => chequeSplitIds.has(chk.batchSplitId));
  const invalidCheckStatuses = checksRows.filter((chk) => !CHECK_VALID_STATUSES.has(chk.status)).map((chk) => chk.id);

  // Posibles duplicados entre los cheques de ESTE batch y la cartera VIGENTE
  // (incluye otros batches, excluye operaciones anuladas) — una sola
  // consulta por los bancos involucrados.
  let possibleDuplicateChecks: Array<{ checkId: number; matches: ReturnType<typeof findPossibleCheckDuplicates> }> = [];
  if (checksRows.length > 0) {
    const bankNames = [...new Set(checksRows.map((chk) => chk.bankName))];
    const candidates = await loadActiveExistingChecksForDuplicateCheck(db, bankNames);
    possibleDuplicateChecks = checksRows
      .map((chk) => ({ checkId: chk.id, matches: findPossibleCheckDuplicates(chk, candidates.filter((o) => o.id !== chk.id)) }))
      .filter((d) => d.matches.length > 0);
  }

  const integrity = {
    baseMatchesChildren: baseFromChildren === batch.baseAmountCents,
    surchargeMatchesEntries: surchargeFromEntries === batch.surchargeAmountCents,
    totalMatchesBasePlusSurcharge: (batch.baseAmountCents + batch.surchargeAmountCents) === batch.totalReceivedCents,
    // Fase 2B: splitsSum (dinero real) puede diferir de totalReceivedCents
    // (aplicado) A PROPÓSITO cuando el batch tiene un sobrante/faltante
    // resuelto vía accountDifferenceResolution — comparar contra
    // receivedAmountCents (siempre = SUM(splits) en batches nuevos, Regla 3)
    // en vez de totalReceivedCents evita marcar esos batches como
    // "inconsistentes". Fallback a totalReceivedCents solo por si alguna
    // fila quedara sin backfillear (no debería pasar — Migración 0030
    // backfillea el 100%).
    splitsMatchTotal: splitsSum === (batch.receivedAmountCents ?? batch.totalReceivedCents),
    checkSplitsHaveChecks,
    checkAmountsMatchSplits,
    checksBelongOnlyToCheckSplits,
    invalidCheckStatuses,
    possibleDuplicateChecks,
  };

  return c.json({ batch, insuredSummary, items: childRows, splits: splitsWithChecksOut, surcharges, integrity, accountMovements }, 200);
}));

// ─── ANULACIÓN DE UN LOTE CONFIRMADO (corrección segura, con trazabilidad) ──
//
// "Corregir" un cobro por lote NUNCA es una edición monetaria — es anular
// (con trazabilidad: quién/cuándo/por qué) y cargar un lote nuevo. Un batch
// confirmado solo se puede anular mientras no generó ninguna actividad
// posterior (ver checkBatchCancellable en lib/payments/batches.ts): sin
// hijos rendidos, sin remittance_allocations/remittance_items vinculados, y
// con todos sus cheques todavía "en_cartera". Si CUALQUIERA de esas
// condiciones existe, se bloquea entero (nunca una anulación parcial).
//
// Nunca se hace DELETE físico de payment_batches/payments/
// payment_batch_splits/received_checks/cash_entries — todo permanece como
// historial, solo cambia de status.

/** Datos ya resueltos de la base para decidir si un batch es anulable — reutilizado por cancel-check y cancel. */
async function loadBatchCancelContext(dbOrTx: any, batchId: number) {
  const batch = await dbOrTx.select().from(paymentBatches).where(eq(paymentBatches.id, batchId)).get();
  if (!batch) return null;

  const childRows = await dbOrTx.select({
    payment: payments, installment: policyInstallments, policy: policies,
  }).from(payments)
    .leftJoin(policyInstallments, eq(payments.installmentId, policyInstallments.id))
    .leftJoin(policies, eq(payments.policyId, policies.id))
    .where(eq(payments.batchId, batchId))
    .all();
  const childIds = childRows.map((r: any) => r.payment.id as number);

  const surcharges = childIds.length > 0
    ? await dbOrTx.select().from(cashEntries)
      .where(and(inArray(cashEntries.paymentId, childIds), eq(cashEntries.entryType, "pronto_pago_surcharge")))
      .all()
    : [];
  const surchargeIds = surcharges.map((s: any) => s.id as number);

  const splitsRows = await dbOrTx.select().from(paymentBatchSplits).where(eq(paymentBatchSplits.batchId, batchId)).all();
  const splitIds = splitsRows.map((s: any) => s.id as number);
  const checkRows = splitIds.length > 0
    ? await dbOrTx.select().from(receivedChecks).where(inArray(receivedChecks.batchSplitId, splitIds)).all()
    : [];

  const allocationRows = await dbOrTx.select({ id: remittanceAllocations.id })
    .from(remittanceAllocations).where(eq(remittanceAllocations.paymentBatchId, batchId)).all();

  const itemConditions = [] as any[];
  if (childIds.length > 0) itemConditions.push(and(eq(remittanceItems.source, "payment"), inArray(remittanceItems.sourceId, childIds)));
  if (surchargeIds.length > 0) itemConditions.push(and(eq(remittanceItems.source, "cash_entry"), inArray(remittanceItems.sourceId, surchargeIds)));
  const itemRows = itemConditions.length > 0
    ? await dbOrTx.select({ id: remittanceItems.id }).from(remittanceItems).where(or(...itemConditions)).all()
    : [];

  // Fase 2D: insured_account_movements que "claramente pertenecen" a este
  // batch — originados directo por él (originBatchId), o por alguno de sus
  // pagos hijos (originPaymentId). Ningún endpoint escribe originPaymentId
  // todavía (solo originBatchId, vía POST /payment-batches con
  // accountDifferenceResolution — Fase 2B), pero se contempla para no dejar
  // un movimiento futuro huérfano si algún día se genera así.
  const accountMovementConditions = [eq(insuredAccountMovements.originBatchId, batchId)];
  if (childIds.length > 0) accountMovementConditions.push(inArray(insuredAccountMovements.originPaymentId, childIds));
  const accountMovements = await dbOrTx.select().from(insuredAccountMovements)
    .where(or(...accountMovementConditions)).all();
  const accountPlan = await resolveAccountMovementCancelPlan(dbOrTx, accountMovements);

  return {
    batch, childRows, childIds, surcharges, checkRows,
    allocationCount: allocationRows.length, itemCount: itemRows.length,
    accountMovements, accountPlan,
  };
}

// ─── Fase 2D: seguridad de cuenta corriente al cancelar un batch ───────────
interface AccountMovementCancelPlan {
  safe: boolean;
  blockReasons: string[];
  movementIdsToVoid: number[];
}

/**
 * Para cada insured_account_movement activo que este batch (o alguno de sus
 * hijos) originó, decide si anularlo es matemáticamente seguro — ver
 * isSafeToCancelAccountMovementOrigin (insured-account.ts). Un movimiento ya
 * anulado no vuelve a evaluarse (nada que anular de nuevo — idempotencia).
 * Nunca escribe nada: solo decide qué haría falta anular y qué lo bloquea.
 */
async function resolveAccountMovementCancelPlan(
  dbOrTx: any,
  accountMovements: ReadonlyArray<any>
): Promise<AccountMovementCancelPlan> {
  const activeOwnMovements = accountMovements.filter((m: any) => m.status === "activo");
  if (activeOwnMovements.length === 0) return { safe: true, blockReasons: [], movementIdsToVoid: [] };

  const blockReasons: string[] = [];
  const movementIdsToVoid: number[] = [];

  for (const m of activeOwnMovements as any[]) {
    if (m.type !== "saldo_a_favor" && m.type !== "saldo_deudor") {
      // Otro tipo originado directo por un batch/pago (ningún endpoint lo
      // genera así hoy) — no consume ni cierra nada del pool por sí mismo,
      // se anula sin chequeo adicional.
      movementIdsToVoid.push(m.id);
      continue;
    }

    // Pool GLOBAL del mismo asegurado, sin este movimiento — nunca se
    // escribe nada acá, solo lectura para decidir.
    const siblingRows = await dbOrTx.select().from(insuredAccountMovements)
      .where(and(eq(insuredAccountMovements.insuredId, m.insuredId), ne(insuredAccountMovements.id, m.id)))
      .all();
    const activeSiblings = (siblingRows as any[]).filter((s) => s.status === "activo");

    const thisOriginAmountCents = Math.abs(m.signedAmountCents);
    let totalActivePoolCents = thisOriginAmountCents;
    let totalActiveConsumptionCents = 0;

    if (m.type === "saldo_a_favor") {
      for (const s of activeSiblings) {
        if (s.type === "saldo_a_favor") totalActivePoolCents += s.signedAmountCents;
        else if (s.type === "aplicacion_saldo_favor" || s.type === "devolucion_saldo_favor") {
          totalActiveConsumptionCents += Math.abs(s.signedAmountCents);
        } else if (s.type === "ajuste_manual" && s.signedAmountCents < 0) {
          totalActiveConsumptionCents += Math.abs(s.signedAmountCents);
        }
      }
    } else {
      // saldo_deudor
      for (const s of activeSiblings) {
        if (s.type === "saldo_deudor") totalActivePoolCents += Math.abs(s.signedAmountCents);
        else if (s.type === "cobro_saldo_deudor") totalActiveConsumptionCents += Math.abs(s.signedAmountCents);
      }
    }

    const safe = isSafeToCancelAccountMovementOrigin({ thisOriginAmountCents, totalActivePoolCents, totalActiveConsumptionCents });
    if (safe) {
      movementIdsToVoid.push(m.id);
    } else {
      blockReasons.push(
        `El movimiento de cuenta corriente ${m.id} (${m.type}) del asegurado ${m.insuredId} ya fue parcial o totalmente ` +
        `consumido/cobrado por otra operación de su cuenta corriente — no se puede determinar de forma segura que ` +
        `anularlo no afecte esa otra operación. Requiere revisión manual antes de anular este cobro.`
      );
    }
  }

  return { safe: blockReasons.length === 0, blockReasons, movementIdsToVoid };
}

function buildCancelCheckInput(ctx: NonNullable<Awaited<ReturnType<typeof loadBatchCancelContext>>>) {
  const childPayments: BatchCancelChildPayment[] = ctx.childRows.map((r: any) => ({
    id: r.payment.id, status: r.payment.status, rendered: r.payment.rendered,
  }));
  const checks: BatchCancelCheck[] = ctx.checkRows.map((c: any) => ({ id: c.id, status: c.status }));
  return {
    batchStatus: ctx.batch.status,
    childPayments,
    remittanceAllocationCount: ctx.allocationCount,
    remittanceItemCount: ctx.itemCount,
    checks,
  };
}

app.get("/payment-batches/:id/cancel-check", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  const ctx = await loadBatchCancelContext(db, id);
  if (!ctx) return c.json({ error: "Cobro no encontrado" }, 404);

  const result = checkBatchCancellable(buildCancelCheckInput(ctx));

  return c.json({
    canCancel: result.canCancel,
    status: ctx.batch.status,
    blockingReasons: result.blockingReasons,
    affectedPayments: ctx.childRows.map((r: any) => ({
      id: r.payment.id, amount: r.payment.amount,
      installmentId: r.payment.installmentId, policyId: r.payment.policyId,
      manualPayer: r.payment.manualPayer,
    })),
    affectedInstallments: ctx.childRows
      .filter((r: any) => r.installment != null)
      .map((r: any) => ({ id: r.installment.id, number: r.installment.number, dueDate: r.installment.dueDate, amount: r.installment.amount, currentStatus: r.installment.status })),
    checks: ctx.checkRows.map((chk: any) => ({ id: chk.id, checkNumber: chk.checkNumber, bankName: chk.bankName, amountCents: chk.amountCents, status: chk.status })),
    remittanceLinks: { allocationCount: ctx.allocationCount, itemCount: ctx.itemCount },
    surchargeEntries: ctx.surcharges.map((s: any) => ({ id: s.id, amountCents: Math.round(s.amount * 100), rendered: s.rendered })),
    // Fase 2D: movimientos de cuenta corriente que este cobro originó y si
    // anularlos es seguro — ver resolveAccountMovementCancelPlan.
    accountMovements: {
      canCancel: ctx.accountPlan.safe,
      blockReasons: ctx.accountPlan.blockReasons,
      items: ctx.accountMovements.map((m: any) => ({
        id: m.id, type: m.type, signedAmountCents: m.signedAmountCents, status: m.status, insuredId: m.insuredId,
      })),
    },
  }, 200);
}));

class BatchCancelRaceConditionError extends Error {
  constructor(public reasons: string[]) {
    super(`El cobro cambió mientras se procesaba la anulación: ${reasons.join(" ")}`);
  }
}

// Fase 2D: distinto de BatchCancelRaceConditionError a propósito — esto
// nunca es una condición de carrera (el batch en sí sigue siendo anulable),
// es una ambigüedad real e inherente al pool GLOBAL de cuenta corriente (ver
// isSafeToCancelAccountMovementOrigin) que requiere ojo humano, nunca una
// reversa automática adivinada.
class AccountMovementReviewRequiredError extends Error {
  constructor(public reasons: string[]) {
    super(`Requiere revisión manual de cuenta corriente antes de anular: ${reasons.join(" ")}`);
  }
}

app.post("/payment-batches/:id/cancel", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const user = c.get("user");

  if (body.confirm !== true) {
    return c.json({ error: "Se requiere confirmación explícita (confirm: true) para anular un cobro." }, 400);
  }
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

  const preCtx = await loadBatchCancelContext(db, id);
  if (!preCtx) return c.json({ error: "Cobro no encontrado" }, 404);

  if (preCtx.batch.status === "anulado") {
    // Idempotente: una segunda llamada sobre un batch ya anulado no vuelve a
    // tocar nada — responde éxito con el estado actual, no un error.
    return c.json({ ok: true, alreadyCancelled: true, batch: preCtx.batch }, 200);
  }

  const preCheck = checkBatchCancellable(buildCancelCheckInput(preCtx));
  if (!preCheck.canCancel) {
    return c.json({ error: "No se puede anular este cobro.", blockingReasons: preCheck.blockingReasons }, 409);
  }
  // Fase 2D: chequeo aparte del anterior — nunca se mezcla con
  // blockingReasons genéricos, para que el caller pueda distinguir "estado
  // del batch/cheques/rendición" de "ambigüedad real de cuenta corriente".
  if (!preCtx.accountPlan.safe) {
    return c.json({
      error: "No se puede anular este cobro sin revisión manual de su cuenta corriente.",
      code: "ACCOUNT_MOVEMENT_REQUIRES_MANUAL_REVIEW",
      blockingReasons: preCtx.accountPlan.blockReasons,
    }, 409);
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Revalidación completa DENTRO de la transacción — nunca confiar en el
      // chequeo de arriba, hecho fuera de cualquier lock de escritura.
      const ctx = await loadBatchCancelContext(tx, id);
      if (!ctx) throw new BatchCancelRaceConditionError(["El cobro fue eliminado."]);
      if (ctx.batch.status === "anulado") {
        return { alreadyCancelled: true, batch: ctx.batch };
      }
      const check = checkBatchCancellable(buildCancelCheckInput(ctx));
      if (!check.canCancel) throw new BatchCancelRaceConditionError(check.blockingReasons);
      if (!ctx.accountPlan.safe) throw new AccountMovementReviewRequiredError(ctx.accountPlan.blockReasons);

      const now = new Date();

      const [updatedBatch] = await tx.update(paymentBatches).set({
        status: "anulado", cancelledAt: now, cancelledBy: user?.id ?? null, cancellationReason: reason, updatedAt: now,
      }).where(eq(paymentBatches.id, id)).returning();

      for (const r of ctx.childRows as any[]) {
        await tx.update(payments).set({ status: "anulado" }).where(eq(payments.id, r.payment.id));
      }
      // Recalcular DESPUÉS de anular todos los hijos — si dos hijos distintos
      // apuntaran a la misma cuota (no debería pasar, pero el recálculo es
      // idempotente y barato), el resultado final es el mismo sin importar
      // el orden.
      for (const r of ctx.childRows as any[]) {
        if (r.payment.installmentId != null) {
          await recalculateInstallmentPaymentStatus(tx, r.payment.installmentId);
        }
      }

      if (ctx.surcharges.length > 0) {
        await tx.update(cashEntries).set({ status: "anulado", voidedAt: now })
          .where(and(inArray(cashEntries.id, ctx.surcharges.map((s: any) => s.id)), eq(cashEntries.status, "activo")));
      }

      for (const chk of ctx.checkRows as any[]) {
        validateCheckStatusTransition(chk.status, "anulado");
        await tx.update(receivedChecks).set({ status: "anulado", cancelledAt: now, updatedAt: now }).where(eq(receivedChecks.id, chk.id));
      }

      // Fase 2D: insured_account_movements que este batch (o alguno de sus
      // hijos) originó, ya confirmados como seguros de anular por
      // resolveAccountMovementCancelPlan — nunca se borran, nunca se crea un
      // movimiento nuevo, solo status→anulado. El WHERE con status='activo'
      // es defensivo (idempotencia): si por cualquier motivo ya estaba
      // anulado, este UPDATE no hace nada.
      if (ctx.accountPlan.movementIdsToVoid.length > 0) {
        await tx.update(insuredAccountMovements).set({
          status: "anulado",
          notes: `Anulado automáticamente al cancelar el cobro ${id}.`,
        }).where(and(
          inArray(insuredAccountMovements.id, ctx.accountPlan.movementIdsToVoid),
          eq(insuredAccountMovements.status, "activo"),
        ));
      }

      return {
        alreadyCancelled: false,
        batch: updatedBatch,
        cancelledPaymentIds: ctx.childRows.map((r: any) => r.payment.id),
        freedInstallmentIds: ctx.childRows.filter((r: any) => r.payment.installmentId != null).map((r: any) => r.payment.installmentId),
        voidedSurchargeEntryIds: ctx.surcharges.map((s: any) => s.id),
        voidedCheckIds: ctx.checkRows.map((chk: any) => chk.id),
        voidedAccountMovementIds: ctx.accountPlan.movementIdsToVoid,
      };
    });
    return c.json({ ok: true, ...result }, 200);
  } catch (e: any) {
    if (e instanceof BatchCancelRaceConditionError) {
      return c.json({ error: "No se puede anular este cobro.", blockingReasons: e.reasons }, 409);
    }
    if (e instanceof AccountMovementReviewRequiredError) {
      return c.json({
        error: "No se puede anular este cobro sin revisión manual de su cuenta corriente.",
        code: "ACCOUNT_MOVEMENT_REQUIRES_MANUAL_REVIEW",
        blockingReasons: e.reasons,
      }, 409);
    }
    throw e;
  }
}));

// ─── EDICIÓN ADMINISTRATIVA (solo fecha/notas, nunca datos monetarios) ─────
//
// paymentDate/notes son los únicos campos editables de un batch confirmado
// sin rendir — items/importes/splits/cheques/insuredId/recargos/totales
// exigen anular (POST .../cancel) y crear un lote nuevo. Cambiar paymentDate
// NO mueve dinero entre períodos de Caja: la cartera pendiente (GET
// /cash/summary, sección "cartera") nunca filtra por fecha — es "todo lo
// confirmado y no rendido ahora mismo", sin importar paymentDate. Sí cambia
// qué filtros por rango de fecha (ej. el listado de lotes recientes) van a
// mostrar este batch.
app.patch("/payment-batches/:id", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));

  const disallowed = findDisallowedBatchPatchFields(body);
  if (disallowed.length > 0) {
    return c.json({
      error: `Solo se pueden editar paymentDate y notes. Campo(s) no permitido(s): ${disallowed.join(", ")}. ` +
        `Para cambiar importes, cuotas o medios de pago, anulá este cobro y creá uno nuevo.`,
    }, 400);
  }
  if (Object.keys(body).length === 0) {
    return c.json({ error: "No se indicó ningún campo para editar." }, 400);
  }
  if ("paymentDate" in body && !/^\d{4}-\d{2}-\d{2}$/.test(body.paymentDate)) {
    return c.json({ error: "Formato de fecha inválido. Use YYYY-MM-DD." }, 400);
  }

  const batch = await db.select().from(paymentBatches).where(eq(paymentBatches.id, id)).get();
  if (!batch) return c.json({ error: "Cobro no encontrado" }, 404);

  const childRows = await db.select({ id: payments.id, status: payments.status, rendered: payments.rendered })
    .from(payments).where(eq(payments.batchId, id)).all();
  const childPayments: BatchCancelChildPayment[] = childRows.map((r) => ({ id: r.id, status: r.status, rendered: r.rendered }));

  const patchCheck = canPatchBatch(batch.status as any, childPayments);
  if (!patchCheck.canPatch) {
    return c.json({ error: "No se pueden editar los datos de este cobro.", blockingReasons: patchCheck.blockingReasons }, 409);
  }

  const update: any = { updatedAt: new Date() };
  if ("paymentDate" in body) update.paymentDate = body.paymentDate;
  if ("notes" in body) update.notes = body.notes || null;

  const [updated] = await db.update(paymentBatches).set(update).where(eq(paymentBatches.id, id)).returning();
  return c.json(updated, 200);
}));

// ─── RECEIVED CHECKS — cartera de cheques (Etapa 4B) ───────────────────────────
// Lectura de solo lectura sobre received_checks. No implementa todavía
// endpoints para entregar cheques en una rendición ni para cambiar su estado
// (Etapa 4C/4D) — hasta entonces, ningún cheque puede modificarse ni
// anularse desde acá; el único punto de escritura es POST /payment-batches.
// Migración 0028: un received_checks puede colgar de un payment_batch_splits
// ("batch", igual que antes) O de un payment_splits ("payment", pago
// individual) — nunca ambos (CHECK XOR de la migración 0028). Estos dos
// endpoints ya NO pueden usar un único INNER JOIN contra
// payment_batch_splits (eso excluiría en silencio todo cheque de pago
// individual): se resuelven ambos orígenes por separado y se devuelve
// `source` para que el frontend sepa cuál de los dos (`batch`/`payment`)
// viene poblado.
// PROBLEMA 3 del hotfix de cheques: la detección de posibles duplicados
// (findPossibleCheckDuplicates) solo debe comparar contra cheques VIGENTES.
// Un cheque cuyo batch o payment de origen fue anulado no debe bloquear ni
// advertir como duplicado un alta nueva con el mismo banco+número, aunque el
// propio received_checks.status no haya quedado sincronizado (legacy, antes
// de la migración 0028) — ver isCheckActiveForDuplicateCheck. Una sola
// consulta con LEFT JOIN a ambos orígenes posibles (batch xor payment, nunca
// ambos) cubre los tres casos: cheque anulado, batch anulado, payment
// anulado.
async function loadActiveExistingChecksForDuplicateCheck(
  dbOrTx: any,
  bankNames: string[]
): Promise<ExistingCheckForDuplicateCheck[]> {
  if (bankNames.length === 0) return [];
  const rows = await dbOrTx.select({
    id: receivedChecks.id,
    checkNumber: receivedChecks.checkNumber,
    bankName: receivedChecks.bankName,
    amountCents: receivedChecks.amountCents,
    dueDate: receivedChecks.dueDate,
    drawerName: receivedChecks.drawerName,
    checkStatus: receivedChecks.status,
    batchStatus: paymentBatches.status,
    paymentStatus: payments.status,
  }).from(receivedChecks)
    .leftJoin(paymentBatchSplits, eq(receivedChecks.batchSplitId, paymentBatchSplits.id))
    .leftJoin(paymentBatches, eq(paymentBatchSplits.batchId, paymentBatches.id))
    .leftJoin(paymentSplits, eq(receivedChecks.paymentSplitId, paymentSplits.id))
    .leftJoin(payments, eq(paymentSplits.paymentId, payments.id))
    .where(inArray(receivedChecks.bankName, bankNames))
    .all();

  return (rows as any[]).filter(isCheckActiveForDuplicateCheck);
}

async function loadBatchOriginChecks(dbOrTx: any, extraWhere?: any) {
  const conditions = [isNotNull(receivedChecks.batchSplitId)];
  if (extraWhere) conditions.push(extraWhere);
  return dbOrTx.select({
    check: receivedChecks, split: paymentBatchSplits, batch: paymentBatches,
  }).from(receivedChecks)
    .innerJoin(paymentBatchSplits, eq(receivedChecks.batchSplitId, paymentBatchSplits.id))
    .innerJoin(paymentBatches, eq(paymentBatchSplits.batchId, paymentBatches.id))
    .where(and(...conditions))
    .all();
}

async function loadPaymentOriginChecks(dbOrTx: any, extraWhere?: any) {
  const conditions = [isNotNull(receivedChecks.paymentSplitId)];
  if (extraWhere) conditions.push(extraWhere);
  return dbOrTx.select({
    check: receivedChecks, split: paymentSplits, payment: payments, policy: policies, company: companies, insured: insureds,
  }).from(receivedChecks)
    .innerJoin(paymentSplits, eq(receivedChecks.paymentSplitId, paymentSplits.id))
    .innerJoin(payments, eq(paymentSplits.paymentId, payments.id))
    .leftJoin(policies, eq(payments.policyId, policies.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .where(and(...conditions))
    .all();
}

function applyCommonCheckFilters<T extends { check: typeof receivedChecks.$inferSelect }>(
  rows: T[], filters: { status?: string; bank?: string; dueFrom?: string; dueTo?: string }
): T[] {
  let out = rows;
  if (filters.status) out = out.filter((r) => r.check.status === filters.status);
  if (filters.bank) out = out.filter((r) => r.check.bankName.toLowerCase().includes(filters.bank!.toLowerCase()));
  if (filters.dueFrom) out = out.filter((r) => r.check.dueDate >= filters.dueFrom!);
  if (filters.dueTo) out = out.filter((r) => r.check.dueDate <= filters.dueTo!);
  return out;
}

app.get("/received-checks", requireAuth(async (c: any) => {
  const { status, bank, dueFrom, dueTo, batchId, insuredId, companyId } = c.req.query();
  const commonFilters = { status, bank, dueFrom, dueTo };

  // batch.insuredId ya no es una fuente confiable (nullable, "lote
  // multi-asegurado") — no se joinea acá. La identificación real de cada
  // cheque de batch se arma más abajo desde los hijos reales del batch al
  // que pertenece (computeBatchInsuredDisplay), igual que en GET
  // /payment-batches y /payment-batches/:id.
  let batchRows = applyCommonCheckFilters(await loadBatchOriginChecks(db), commonFilters);
  if (batchId) batchRows = batchRows.filter((r) => r.batch.id === Number(batchId));

  // batchId es un filtro exclusivo de cheques de lote — un cheque de pago
  // individual nunca pertenece a ningún batch.
  let paymentRows = batchId ? [] : applyCommonCheckFilters(await loadPaymentOriginChecks(db), commonFilters);

  // Hijos (payments) de todos los batches involucrados, en una sola consulta
  // — sin N+1 aunque haya muchos cheques de muchos batches distintos. Se
  // trae también el asegurado real de cada hijo (vía su póliza) para poder
  // filtrar por insuredId y para armar el resumen de identificación.
  const batchIds = [...new Set(batchRows.map((r) => r.batch.id))];
  const childRows = batchIds.length > 0
    ? await db.select({ payment: payments, policy: policies, company: companies, insured: insureds })
      .from(payments)
      .leftJoin(policies, eq(payments.policyId, policies.id))
      .leftJoin(companies, eq(policies.companyId, companies.id))
      .leftJoin(insureds, eq(policies.insuredId, insureds.id))
      .where(inArray(payments.batchId, batchIds))
      .all()
    : [];
  const childrenByBatchId = new Map<number, typeof childRows>();
  for (const row of childRows) {
    const bId = row.payment.batchId!;
    const arr = childrenByBatchId.get(bId) ?? [];
    arr.push(row);
    childrenByBatchId.set(bId, arr);
  }

  // insuredId/companyId: para cheques de batch, "algún hijo de este batch
  // pertenece a ese asegurado/compañía" (no payment_batches.insured_id, que
  // puede ser null en un lote mixto); para cheques de pago individual, el
  // asegurado/compañía real del payment (vía su póliza).
  if (insuredId) {
    const wantedInsuredId = Number(insuredId);
    batchRows = batchRows.filter((r) => (childrenByBatchId.get(r.batch.id) ?? []).some((ch) => ch.insured?.id === wantedInsuredId));
    paymentRows = paymentRows.filter((r) => r.insured?.id === wantedInsuredId);
  }
  if (companyId) {
    const wantedCompanyId = Number(companyId);
    batchRows = batchRows.filter((r) => (childrenByBatchId.get(r.batch.id) ?? []).some((ch) => ch.company?.id === wantedCompanyId));
    paymentRows = paymentRows.filter((r) => r.company?.id === wantedCompanyId);
  }

  // Posibles duplicados: una sola consulta contra los bancos involucrados
  // (de ambos orígenes juntos, porque received_checks es una única tabla
  // compartida), no una por cheque. Solo cheques vigentes — ver
  // loadActiveExistingChecksForDuplicateCheck.
  const bankNames = [...new Set([...batchRows.map((r) => r.check.bankName), ...paymentRows.map((r) => r.check.bankName)])];
  const duplicateCandidates = await loadActiveExistingChecksForDuplicateCheck(db, bankNames);

  const batchResult = batchRows.map((r) => {
    const children = childrenByBatchId.get(r.batch.id) ?? [];
    const companiesInvolved = [...new Map(children.filter((ch) => ch.company).map((ch) => [ch.company!.id, ch.company])).values()];
    const possibleDuplicates = findPossibleCheckDuplicates(r.check, duplicateCandidates.filter((o) => o.id !== r.check.id));
    const insuredSummary = computeBatchInsuredDisplay(children.map((ch) => ({
      insuredId: ch.insured?.id ?? null, insuredName: ch.insured?.name ?? null,
      manualPayer: ch.payment.manualPayer, manualPolicyNumber: ch.payment.manualPolicyNumber,
    })));
    return {
      source: "batch" as const,
      check: r.check,
      split: r.split,
      batch: r.batch,
      payment: null,
      insuredSummary,
      installments: children.map((ch) => ({
        paymentId: ch.payment.id, installmentId: ch.payment.installmentId, amount: ch.payment.amount,
        policyId: ch.policy?.id ?? null, policyNumber: ch.policy?.policyNumber ?? null,
      })),
      companies: companiesInvolved,
      possibleDuplicates,
    };
  });

  const paymentResult = paymentRows.map((r) => {
    const possibleDuplicates = findPossibleCheckDuplicates(r.check, duplicateCandidates.filter((o) => o.id !== r.check.id));
    const insuredSummary = computeBatchInsuredDisplay([{
      insuredId: r.insured?.id ?? null, insuredName: r.insured?.name ?? null,
      manualPayer: r.payment.manualPayer, manualPolicyNumber: r.payment.manualPolicyNumber,
    }]);
    return {
      source: "payment" as const,
      check: r.check,
      split: r.split,
      batch: null,
      payment: r.payment,
      insuredSummary,
      installments: [{
        paymentId: r.payment.id, installmentId: r.payment.installmentId, amount: r.payment.amount,
        policyId: r.policy?.id ?? null, policyNumber: r.policy?.policyNumber ?? null,
      }],
      companies: r.company ? [r.company] : [],
      possibleDuplicates,
    };
  });

  const result = [...batchResult, ...paymentResult].sort((a, b) => b.check.receivedAt.getTime() - a.check.receivedAt.getTime());

  return c.json(result, 200);
}));

app.get("/received-checks/:id", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));

  const [batchRow] = await loadBatchOriginChecks(db, eq(receivedChecks.id, id));
  const [paymentRow] = batchRow ? [] : await loadPaymentOriginChecks(db, eq(receivedChecks.id, id));
  if (!batchRow && !paymentRow) return c.json({ error: "Cheque no encontrado" }, 404);

  if (batchRow) {
    const childRows = await db.select({ payment: payments, policy: policies, company: companies, insured: insureds })
      .from(payments)
      .leftJoin(policies, eq(payments.policyId, policies.id))
      .leftJoin(companies, eq(policies.companyId, companies.id))
      .leftJoin(insureds, eq(policies.insuredId, insureds.id))
      .where(eq(payments.batchId, batchRow.batch.id))
      .all();
    const companiesInvolved = [...new Map(childRows.filter((ch) => ch.company).map((ch) => [ch.company!.id, ch.company])).values()];
    const insuredSummary = computeBatchInsuredDisplay(childRows.map((ch) => ({
      insuredId: ch.insured?.id ?? null, insuredName: ch.insured?.name ?? null,
      manualPayer: ch.payment.manualPayer, manualPolicyNumber: ch.payment.manualPolicyNumber,
    })));
    const otherChecksSameBank = (await loadActiveExistingChecksForDuplicateCheck(db, [batchRow.check.bankName]))
      .filter((o) => o.id !== id);
    const possibleDuplicates = findPossibleCheckDuplicates(batchRow.check, otherChecksSameBank);

    return c.json({
      source: "batch",
      check: batchRow.check,
      split: batchRow.split,
      batch: batchRow.batch,
      payment: null,
      insuredSummary,
      installments: childRows.map((ch) => ({
        paymentId: ch.payment.id, installmentId: ch.payment.installmentId, amount: ch.payment.amount,
        policyId: ch.policy?.id ?? null, policyNumber: ch.policy?.policyNumber ?? null,
      })),
      companies: companiesInvolved,
      possibleDuplicates,
    }, 200);
  }

  const insuredSummary = computeBatchInsuredDisplay([{
    insuredId: paymentRow.insured?.id ?? null, insuredName: paymentRow.insured?.name ?? null,
    manualPayer: paymentRow.payment.manualPayer, manualPolicyNumber: paymentRow.payment.manualPolicyNumber,
  }]);
  const otherChecksSameBank = (await loadActiveExistingChecksForDuplicateCheck(db, [paymentRow.check.bankName]))
    .filter((o) => o.id !== id);
  const possibleDuplicates = findPossibleCheckDuplicates(paymentRow.check, otherChecksSameBank);

  return c.json({
    source: "payment",
    check: paymentRow.check,
    split: paymentRow.split,
    batch: null,
    payment: paymentRow.payment,
    insuredSummary,
    installments: [{
      paymentId: paymentRow.payment.id, installmentId: paymentRow.payment.installmentId, amount: paymentRow.payment.amount,
      policyId: paymentRow.policy?.id ?? null, policyNumber: paymentRow.policy?.policyNumber ?? null,
    }],
    companies: paymentRow.company ? [paymentRow.company] : [],
    possibleDuplicates,
  }, 200);
}));

app.get("/payments/stats", requireAuth(async (c: any) => {
  const all = await db.select({ payment: payments }).from(payments).all();
  const confirmed = all.filter((r) => r.payment.status === "confirmado");
  // Total general: una sola vez por payment, desde el padre — no se duplica
  // ni se recalcula desde splits (evita error de redondeo centavo a centavo
  // acumulado sobre montos en pesos).
  const total = confirmed.reduce((s, r) => s + r.payment.amount, 0);

  // Etapa 3B: byMethod se arma sumando payment_splits.amount_cents, NUNCA
  // payments.amount — payments.paymentMethod puede valer "combinado" (no es
  // un método real), y sumar por ahí perdería el importe de cada método real
  // dentro de un cobro combinado (ver diagnóstico de Etapa 3B, sección 4).
  const confirmedIds = confirmed.map((r) => r.payment.id);
  const byMethod: Record<string, number> = {};
  let combinadoCount = 0;
  if (confirmedIds.length > 0) {
    const splitRows = await db.select({
      paymentId: paymentSplits.paymentId, method: paymentSplits.method, amountCents: paymentSplits.amountCents,
    }).from(paymentSplits).where(inArray(paymentSplits.paymentId, confirmedIds)).all();
    const splitsCountByPayment = new Map<number, number>();
    for (const s of splitRows) {
      byMethod[s.method] = (byMethod[s.method] || 0) + s.amountCents / 100;
      splitsCountByPayment.set(s.paymentId, (splitsCountByPayment.get(s.paymentId) ?? 0) + 1);
    }
    for (const splitCount of splitsCountByPayment.values()) {
      if (splitCount > 1) combinadoCount++;
    }
  }
  // Conteo puramente visual (cuántos payments confirmados son combinados) —
  // nunca un importe, para no confundirlo con un método real al sumar todo
  // byMethod.* como si fueran plata.
  byMethod.combinadoCount = combinadoCount;

  const byMonth: Record<string, number> = {};
  for (const r of confirmed) {
    const month = r.payment.paymentDate.substring(0, 7);
    byMonth[month] = (byMonth[month] || 0) + r.payment.amount;
  }
  return c.json({ total, count: confirmed.length, byMethod, byMonth }, 200);
}));

// ─── DELIVERIES ───────────────────────────────────────────────────────────────
app.get("/deliveries", requireAuth(async (c: any) => {
  const { policyId, channel, status, documentType } = c.req.query();
  let results = await db
    .select({ delivery: deliveries, policy: policies, insured: insureds, company: companies })
    .from(deliveries)
    .leftJoin(policies, eq(deliveries.policyId, policies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .orderBy(desc(deliveries.createdAt))
    .all();
  if (policyId) results = results.filter((r) => r.delivery.policyId === Number(policyId));
  if (channel) results = results.filter((r) => r.delivery.channel === channel);
  if (status) results = results.filter((r) => r.delivery.status === status);
  if (documentType) results = results.filter((r) => r.delivery.documentType === documentType);
  return c.json(results, 200);
}));

app.post("/deliveries", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const hasPolicyId = body.policyId != null && body.policyId !== "";
  const [delivery] = await db
    .insert(deliveries)
    .values({
      policyId: hasPolicyId ? Number(body.policyId) : null,
      manualRecipient: body.manualRecipient || null,
      manualPolicyNumber: body.manualPolicyNumber || null,
      manualCompany: body.manualCompany || null,
      documentType: body.documentType,
      channel: body.channel,
      status: body.status || "pendiente",
      scheduledDate: body.scheduledDate || null,
      notes: body.notes || null,
      createdBy: user.id,
    })
    .returning();
  return c.json(delivery, 201);
}));

app.put("/deliveries/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const id = Number(c.req.param("id"));
  const update: any = {};
  const fields = ["policyId", "manualRecipient", "manualPolicyNumber", "manualCompany", "documentType", "channel", "status", "scheduledDate", "completedDate", "notes"];
  for (const f of fields) {
    if (f in body) update[f] = body[f];
  }
  if ("policyId" in update && (update.policyId === "" || update.policyId == null)) {
    update.policyId = null;
  } else if ("policyId" in update) {
    update.policyId = Number(update.policyId);
  }
  const [delivery] = await db.update(deliveries).set(update).where(eq(deliveries.id, id)).returning();
  return c.json(delivery, 200);
}));

app.patch("/deliveries/:id/complete", requireAuth(async (c: any) => {
  const today = toArgentinaCalendarDay();
  const [delivery] = await db
    .update(deliveries)
    .set({ status: "realizado", completedDate: today })
    .where(eq(deliveries.id, Number(c.req.param("id"))))
    .returning();
  return c.json(delivery, 200);
}));

app.delete("/deliveries/:id", requireAuth(async (c: any) => {
  await db.delete(deliveries).where(eq(deliveries.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// ─── USERS (admin only) ────────────────────────────────────────────────────────
app.get("/users", requireAuth(async (c: any) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const list = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active, createdAt: users.createdAt })
    .from(users)
    .all();
  return c.json(list, 200);
}));

app.post("/users", requireAuth(async (c: any) => {
  const actor = c.get("user");
  if (actor.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json();
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.password));
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const [user] = await db
    .insert(users)
    .values({ ...body, password: hash })
    .returning({ id: users.id, name: users.name, email: users.email, role: users.role });
  return c.json(user, 201);
}));

app.put("/users/:id", requireAuth(async (c: any) => {
  const actor = c.get("user");
  if (actor.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const targetId = Number(c.req.param("id"));
  const body = await c.req.json();
  const update: any = {};
  if (body.name) update.name = body.name;
  if (body.email) update.email = body.email;
  if (body.role) update.role = body.role;
  if (typeof body.active === "number") update.active = body.active;
  if (body.password) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.password));
    update.password = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  const [updated] = await db
    .update(users)
    .set(update)
    .where(eq(users.id, targetId))
    .returning({ id: users.id, name: users.name, email: users.email, role: users.role });
  return c.json(updated, 200);
}));

app.delete("/users/:id", requireAuth(async (c: any) => {
  const actor = c.get("user");
  if (actor.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const targetId = Number(c.req.param("id"));
  if (targetId === actor.id) return c.json({ error: "No podés eliminar tu propio usuario" }, 400);
  await db.delete(sessions).where(eq(sessions.userId, targetId));
  await db.update(policies).set({ createdBy: null }).where(eq(policies.createdBy, targetId));
  await db.update(payments).set({ createdBy: null }).where(eq(payments.createdBy, targetId));
  await db.update(deliveries).set({ createdBy: null }).where(eq(deliveries.createdBy, targetId));
  await db.update(claims).set({ createdBy: null }).where(eq(claims.createdBy, targetId));
  await db.update(rebillings).set({ createdBy: null }).where(eq(rebillings.createdBy, targetId));
  await db.update(insureds).set({ createdBy: null }).where(eq(insureds.createdBy, targetId));
  await db.delete(users).where(eq(users.id, targetId));
  return c.json({ ok: true }, 200);
}));

// ─── CLAIMS (Siniestros) ──────────────────────────────────────────────────────
const CLAIM_STATUSES = ["pendiente", "nuevo", "en_curso", "reclamo_tercero", "resuelto"];

app.get("/claims", requireAuth(async (c: any) => {
  const q = c.req.query("search") || "";
  const statusFilter = c.req.query("status") || "";
  let result = await db
    .select({ claim: claims, policy: policies, insured: insureds, company: companies })
    .from(claims)
    .leftJoin(policies, eq(claims.policyId, policies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .orderBy(desc(claims.createdAt));
  if (statusFilter) result = result.filter((r) => r.claim.status === statusFilter);
  if (q) {
    const lq = q.toLowerCase();
    result = result.filter(
      (r) =>
        r.policy?.policyNumber?.toLowerCase().includes(lq) ||
        r.insured?.name?.toLowerCase().includes(lq) ||
        r.claim.claimNumber?.toLowerCase().includes(lq) ||
        r.claim.incidentLocation?.toLowerCase().includes(lq)
    );
  }
  return c.json(result, 200);
}));

app.get("/claims/stats", requireAuth(async (c: any) => {
  const all = await db.select({ status: claims.status }).from(claims);
  const stats = { total: all.length, pendiente: 0, nuevo: 0, en_curso: 0, reclamo_tercero: 0, resuelto: 0 };
  for (const r of all) {
    if (r.status in stats) (stats as any)[r.status]++;
  }
  return c.json(stats, 200);
}));

app.get("/claims/:id", requireAuth(async (c: any) => {
  const result = await db
    .select({ claim: claims, policy: policies, insured: insureds, company: companies })
    .from(claims)
    .leftJoin(policies, eq(claims.policyId, policies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .where(eq(claims.id, Number(c.req.param("id"))))
    .get();
  if (!result) return c.json({ error: "No encontrado" }, 404);
  return c.json(result, 200);
}));

app.post("/claims", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const hasPolicyId = body.policyId != null && body.policyId !== "";
  const hasStatus = body.status != null && body.status !== "";
  if (hasStatus && !CLAIM_STATUSES.includes(body.status)) {
    return c.json({ error: "Estado de siniestro inválido." }, 400);
  }
  const status = hasStatus ? body.status : "pendiente";
  if (status === "nuevo" && !hasPolicyId) {
    return c.json({ error: "No se puede crear un siniestro definitivo sin una póliza real asociada." }, 400);
  }
  const [row] = await db
    .insert(claims)
    .values({
      policyId: hasPolicyId ? Number(body.policyId) : null,
      claimNumber: body.claimNumber || null,
      status,
      manualInsured: body.manualInsured || null,
      manualCompany: body.manualCompany || null,
      manualPolicyNumber: body.manualPolicyNumber || null,
      manualPolicyType: body.manualPolicyType || null,
      manualNotes: body.manualNotes || null,
      createdBy: user.id,
    })
    .returning();
  return c.json(row, 201);
}));

app.put("/claims/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const id = Number(c.req.param("id"));
  const existing = await db.select().from(claims).where(eq(claims.id, id)).get();
  if (!existing) return c.json({ error: "No encontrado" }, 404);

  const hasStatusKey = "status" in body;
  if (hasStatusKey && (body.status == null || body.status === "" || !CLAIM_STATUSES.includes(body.status))) {
    return c.json({ error: "Estado de siniestro inválido." }, 400);
  }

  const hasPolicyIdKey = "policyId" in body;
  const effectivePolicyId = hasPolicyIdKey
    ? (body.policyId != null && body.policyId !== "" ? Number(body.policyId) : null)
    : existing.policyId;
  const effectiveStatus = hasStatusKey ? body.status : existing.status;
  if (effectiveStatus === "nuevo" && !effectivePolicyId) {
    return c.json({ error: "No se puede marcar como definitivo un siniestro sin una póliza real asociada." }, 400);
  }

  const update: any = { updatedAt: new Date() };
  const fields = [
    "policyId", "claimNumber", "status", "incidentDate", "incidentTime", "incidentLocation",
    "incidentDescription", "damages",
    "thirdPartyName", "thirdPartyDni", "thirdPartyPhone", "thirdPartyVehiclePlate",
    "thirdPartyVehicleBrand", "thirdPartyVehicleModel", "thirdPartyInsurer", "thirdPartyPolicyNumber",
    "claimFiled", "claimFiledDate", "claimCompany", "claimNumberThird", "claimNotes",
    "resolved", "resolvedDate", "resolutionNotes", "resolutionAmount",
    "manualInsured", "manualCompany", "manualPolicyNumber", "manualPolicyType", "manualNotes",
  ];
  for (const f of fields) {
    if (f in body) update[f] = body[f];
  }
  const [row] = await db.update(claims).set(update).where(eq(claims.id, id)).returning();
  return c.json(row, 200);
}));

app.delete("/claims/:id", requireAuth(async (c: any) => {
  await db.delete(claims).where(eq(claims.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// ─── TASK TEMPLATES ───────────────────────────────────────────────────────────
app.get("/task-templates", requireAuth(async (c: any) => {
  const user = c.get("user");
  const isAdmin = user.role === "admin";
  const all = await db
    .select()
    .from(taskTemplates)
    .where(eq(taskTemplates.active, 1))
    .orderBy(asc(taskTemplates.order), asc(taskTemplates.id));
  // Non-admins don't see admin-only templates
  const list = isAdmin ? all : all.filter(t => !t.isAdminOnly);
  return c.json(list, 200);
}));

app.post("/task-templates", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const all = await db.select({ order: taskTemplates.order }).from(taskTemplates).all();
  const maxOrder = all.length ? Math.max(...all.map((t) => t.order)) : 0;
  const day = body.dayOfMonth ? parseInt(body.dayOfMonth, 10) : null;
  const isAdminOnly = user.role === "admin" && !!body.isAdminOnly ? 1 : 0;
  const [row] = await db
    .insert(taskTemplates)
    .values({ title: body.title, description: body.description || null, dayOfMonth: day, order: maxOrder + 1, isAdminOnly, createdBy: user.id })
    .returning();
  return c.json(row, 201);
}));

app.put("/task-templates/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const update: any = {};
  if ("title" in body) update.title = body.title;
  if ("description" in body) update.description = body.description || null;
  if ("dayOfMonth" in body) update.dayOfMonth = body.dayOfMonth ? parseInt(body.dayOfMonth, 10) : null;
  if ("order" in body) update.order = body.order;
  if ("active" in body) update.active = body.active;
  if ("isAdminOnly" in body) update.isAdminOnly = body.isAdminOnly ? 1 : 0;
  const [row] = await db.update(taskTemplates).set(update).where(eq(taskTemplates.id, Number(c.req.param("id")))).returning();
  return c.json(row, 200);
}));

app.delete("/task-templates/:id", requireAuth(async (c: any) => {
  // soft-delete
  await db.update(taskTemplates).set({ active: 0 }).where(eq(taskTemplates.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// ─── TASKS ────────────────────────────────────────────────────────────────────
// GET /tasks?month=2026-05  — returns all tasks for that month, auto-generates recurring ones
app.get("/tasks", requireAuth(async (c: any) => {
  const user = c.get("user");
  const isAdmin = user.role === "admin";
  // mes operativo de Argentina — new Date().toISOString().substring(0,7) daba
  // el mes UTC, que se adelanta un mes entero durante las últimas ~3h de
  // Argentina del último día del mes (ver diagnóstico de fechas locales).
  const monthYear = c.req.query("month") || toArgentinaCalendarDay().slice(0, 7);

  // Auto-generate recurring tasks from active templates if not yet created for this month
  const allTemplates = await db.select().from(taskTemplates).where(eq(taskTemplates.active, 1)).all();
  // Only generate from templates visible to this user
  const visibleTemplates = allTemplates.filter(t => isAdmin || !t.isAdminOnly);
  for (const tpl of visibleTemplates) {
    const existing = await db
      .select()
      .from(tasks)
      .where(eq(tasks.templateId, tpl.id))
      .all();
    const existsForMonth = existing.some((t) => t.monthYear === monthYear);
    if (!existsForMonth) {
      let dueDate: string | null = null;
      if (tpl.dayOfMonth) {
        const [y, m] = monthYear.split("-").map(Number);
        const lastDay = new Date(y, m, 0).getDate();
        const day = Math.min(tpl.dayOfMonth, lastDay);
        dueDate = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
      await db.insert(tasks).values({
        templateId: tpl.id,
        monthYear,
        title: tpl.title,
        description: tpl.description,
        dueDate,
        status: "pendiente",
        isRecurring: 1,
        isAdminOnly: tpl.isAdminOnly,
        createdBy: user.id,
      });
    }
  }

  const allTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.monthYear, monthYear))
    .orderBy(desc(tasks.isRecurring), asc(tasks.createdAt));

  // Filter out admin-only tasks for non-admin users
  const list = isAdmin ? allTasks : allTasks.filter(t => !t.isAdminOnly);
  return c.json(list, 200);
}));

app.post("/tasks", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  // Only admins can create admin-only tasks
  const isAdminOnly = user.role === "admin" && !!body.isAdminOnly ? 1 : 0;
  const [row] = await db
    .insert(tasks)
    .values({
      templateId: null,
      monthYear: body.monthYear,
      title: body.title,
      description: body.description || null,
      dueDate: body.dueDate || null,
      status: "pendiente",
      isRecurring: 0,
      isAdminOnly,
      createdBy: user.id,
    })
    .returning();
  return c.json(row, 201);
}));

app.put("/tasks/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const update: any = {};
  if ("status" in body) {
    update.status = body.status;
    update.completedAt = body.status === "realizada" ? new Date() : null;
  }
  if ("title" in body) update.title = body.title;
  if ("description" in body) update.description = body.description || null;
  if ("dueDate" in body) update.dueDate = body.dueDate || null;
  const [row] = await db.update(tasks).set(update).where(eq(tasks.id, Number(c.req.param("id")))).returning();
  return c.json(row, 200);
}));

app.delete("/tasks/:id", requireAuth(async (c: any) => {
  await db.delete(tasks).where(eq(tasks.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// GET /backup — full DB dump, todas las tablas de negocio (admin only)
app.get("/backup", requireAuth(async (c: any) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

  const backup = await buildFullBackup(db.$client, {
    environment: process.env.NODE_ENV ?? "production",
    databaseUrl: process.env.DATABASE_URL ?? "",
  });

  const validation = validateFullBackup(backup, EXPECTED_BUSINESS_TABLES);
  if (!validation.ok) {
    return c.json({ error: "Backup incompleto o inconsistente", details: validation.errors }, 500);
  }
  if (validation.warnings.length > 0) {
    console.warn("GET /backup — warnings:", validation.warnings);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `organizacion-curini-full-backup-${ts}.json`;
  return new Response(JSON.stringify(backup, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}));

app.post("/import/el-norte", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsedPolicies: any[] = body.policies || [];
  if (!parsedPolicies.length) return c.json({ error: "Sin pólizas" }, 400);

  const results = {
    imported: 0,
    rebillings: 0,
    cancelled: 0,
    skipped: 0,
    errors: [] as string[],
  };

  // Buscar o crear la compañía El Norte
  let companyId: number;
  const existingCompany = await db.select().from(companies).where(eq(companies.name, "El Norte")).get();
  if (existingCompany) {
    companyId = existingCompany.id;
  } else {
    const [nc] = await db.insert(companies).values({ name: "El Norte" }).returning({ id: companies.id });
    companyId = nc.id;
  }

  // Helper: buscar o crear asegurado
  async function resolveInsured(p: any): Promise<number> {
    let existing = null;
    if (p.insuredDni) {
      existing = await db.select().from(insureds).where(eq(insureds.dni, String(p.insuredDni))).get();
    }
    if (!existing) {
      existing = await db.select().from(insureds).where(eq(insureds.name, p.insuredName)).get();
    }
    if (existing) {
      if (p.insuredEmail && !existing.email) await db.update(insureds).set({ email: p.insuredEmail }).where(eq(insureds.id, existing.id));
      if (p.insuredPhone && !existing.phone) await db.update(insureds).set({ phone: p.insuredPhone }).where(eq(insureds.id, existing.id));
      return existing.id;
    }
    const [ni] = await db.insert(insureds).values({
      name: p.insuredName,
      dni: p.insuredDni || null,
      phone: p.insuredPhone || null,
      email: p.insuredEmail || null,
      address: p.insuredAddress || null,
      createdBy: user.id,
    }).returning({ id: insureds.id });
    return ni.id;
  }

  // Helper: insertar cuotas. rebillingId=null → cuota base; con valor → generada por esa refacturación.
  async function insertInstallments(exec: any, policyId: number, installments: any[], rebillingId: number | null = null) {
    for (const inst of installments) {
      await exec.insert(policyInstallments).values({
        policyId,
        number: inst.number,
        dueDate: inst.dueDate,
        amount: inst.amount,
        status: "pendiente",
        rebillingId,
      });
    }
  }

  // Helper: determinar tipo y status
  function resolveTypeAndStatus(p: any) {
    const vt = (p.vehicleType || "").toLowerCase();
    const brand = (p.vehicleBrand || "").toUpperCase();
    const model = (p.vehicleModel || "").toUpperCase();
    let polType: string;
    if (vt === "motovehiculo" || vt === "moto") polType = "motovehiculo";
    else if (vt.includes("accidentes_pasajeros") || vt.includes("accidente")) polType = "accidentes";
    // XR aplica solo si la marca es Honda (Peugeot 206 XR → automotor)
    else if (brand === "HONDA" && /\b(WAVE|BIZ|TITAN|XR)\b/.test(model)) polType = "motovehiculo";
    else polType = "automotor";
    const today = toArgentinaCalendarDay();
    const daysToEnd = Math.ceil((new Date(p.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24));
    let status = "activa";
    if (daysToEnd < 0) status = "vencida";
    else if (daysToEnd <= 30) status = "por_vencer";
    return { polType, status };
  }

  for (const p of parsedPolicies) {
    try {
      const mov = (p.movType || "").toUpperCase();

      // ── ANULACION: cancelar póliza existente ──────────────────────────────
      if (mov.includes("ANULACION")) {
        const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
        if (existing) {
          await db.update(policies).set({ status: "cancelada", notes: (existing.notes ? existing.notes + " | " : "") + "Anulada por importación El Norte" }).where(eq(policies.id, existing.id));
          results.cancelled++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // ── NOTA DE CREDITO: ignorar ──────────────────────────────────────────
      if (mov.includes("NOTA DE CREDITO") || mov.includes("NOTA_DE_CREDITO")) {
        results.skipped++;
        continue;
      }

      // ── PRORROGA: refacturación sobre póliza existente ────────────────────
      if (mov.includes("PRORROGA")) {
        const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
        if (existing) {
          // Rebilling + cuotas en una única transacción: si falla una cuota, no queda rebilling.
          await db.transaction(async (tx) => {
            const [reb] = await tx.insert(rebillings).values({
              policyId: existing.id,
              billingStart: p.startDate,
              billingEnd: p.endDate,
              premium: p.premium || null,
              sumInsured: p.sumInsured || null,
              notes: `Importado de El Norte. Prórroga endoso ${p.endoso || ""}`,
              createdBy: user.id,
            }).returning({ id: rebillings.id });
            if (p.installments?.length > 0) await insertInstallments(tx, existing.id, p.installments, reb!.id);
            const { status } = resolveTypeAndStatus(p);
            await tx.update(policies).set({ endDate: p.endDate, status, premium: p.premium || existing.premium }).where(eq(policies.id, existing.id));
          });
          results.rebillings++;
          continue;
        }
        // Si no existe la póliza original pero hay datos base del frontend → crear base + rebilling
        if (p._baseStartDate) {
          const insuredId = await resolveInsured(p);
          const { polType } = resolveTypeAndStatus(p);
          const isMoto = polType === "motovehiculo";

          // 1. Crear póliza base con los datos provistos manualmente
          const basePolRows = await db.insert(policies).values({
            policyNumber: String(p.policyNumber),
            type: polType,
            status: "vencida",
            companyId,
            insuredId,
            premium: p._basePremium || p.premium || null,
            sumInsured: p._baseSumInsured || p.sumInsured || null,
            coverageType: p._baseCoverage || p.coverageLabel || null,
            startDate: p._baseStartDate,
            endDate: p._baseEndDate || p.startDate,
            isRebilling: 0,
            vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
            vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
            vehicleYear: !isMoto ? (p.vehicleYear || null) : null,
            vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
            motoBrand: isMoto ? (p.vehicleBrand || null) : null,
            motoModel: isMoto ? (p.vehicleModel || null) : null,
            motoYear: isMoto ? (p.vehicleYear || null) : null,
            motoPlate: isMoto ? (p.vehiclePlate || null) : null,
            motoEngine: isMoto ? (p.engineNumber || null) : null,
            notes: p._baseNotes || "Póliza base creada manualmente al importar prórroga",
            createdBy: user.id,
          }).returning({ id: policies.id });

          // 2. Agregar la prórroga como rebilling encima de la base (rebilling + cuotas en una transacción)
          const basePolId = basePolRows[0]!.id;
          const { status } = resolveTypeAndStatus(p);
          await db.transaction(async (tx) => {
            const [reb] = await tx.insert(rebillings).values({
              policyId: basePolId,
              billingStart: p.startDate,
              billingEnd: p.endDate,
              premium: p.premium || null,
              sumInsured: p.sumInsured || null,
              notes: `Importado de El Norte. Prórroga endoso ${p.endoso || ""}`,
              createdBy: user.id,
            }).returning({ id: rebillings.id });
            // Actualizar estado de la póliza base con datos de la prórroga
            await tx.update(policies).set({ endDate: p.endDate, status, premium: p.premium || null }).where(eq(policies.id, basePolId));
            if (p.installments?.length > 0) await insertInstallments(tx, basePolId, p.installments, reb!.id);
          });
          results.rebillings++;
          continue;
        }
        // Sin datos base → caer en creación marcada como rebilling (huérfana)
      }

      // ── RENOVACION o PRORROGA sin póliza existente: crear nueva ──────────
      const existingPol = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
      if (existingPol && !mov.includes("PRORROGA")) {
        results.skipped++;
        continue;
      }

      const insuredId = await resolveInsured(p);
      const { polType, status } = resolveTypeAndStatus(p);
      const isMoto = polType === "motovehiculo";
      const isRebilling = mov.includes("PRORROGA") ? 1 : 0;

      const [newPolicy] = await db.insert(policies).values({
        policyNumber: String(p.policyNumber),
        type: polType,
        status,
        companyId,
        insuredId,
        premium: p.premium || null,
        sumInsured: p.sumInsured || null,
        coverageType: p.coverageLabel || null,
        startDate: p.startDate,
        endDate: p.endDate,
        installments: p.installments?.length || null,
        isRebilling,
        vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
        vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
        vehicleYear: !isMoto ? (p.vehicleYear || null) : null,
        vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
        motoBrand: isMoto ? (p.vehicleBrand || null) : null,
        motoModel: isMoto ? (p.vehicleModel || null) : null,
        motoYear: isMoto ? (p.vehicleYear || null) : null,
        motoPlate: isMoto ? (p.vehicleModel || null) : null,
        motoEngine: isMoto ? (p.engineNumber || null) : null,
        notes: `Importado de El Norte. Movimiento: ${p.movType || "RENOVACION"}`,
        createdBy: user.id,
      }).returning({ id: policies.id });

      if (p.installments?.length > 0) await insertInstallments(db, newPolicy.id, p.installments, null);

      isRebilling ? results.rebillings++ : results.imported++;

    } catch (e: any) {
      results.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      results.skipped++;
    }
  }

  return c.json(results, 200);
}));

// ── /import/rivadavia ────────────────────────────────────────────────────────
// Misma lógica de inserción que El Norte. El parsing ya viene hecho desde el frontend.
// Diferencias: nombre de compañía "Rivadavia", tipo REDUCCION → skip
app.post("/import/rivadavia", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsedPolicies: any[] = body.policies || [];
  if (!parsedPolicies.length) return c.json({ error: "Sin pólizas" }, 400);

  const results = { imported: 0, rebillings: 0, cancelled: 0, skipped: 0, errors: [] as string[] };

  // Buscar o crear la compañía Rivadavia
  let companyId: number;
  const existingCompany = await db.select().from(companies).where(eq(companies.name, "Rivadavia")).get();
  if (existingCompany) {
    companyId = existingCompany.id;
  } else {
    const [nc] = await db.insert(companies).values({ name: "Rivadavia" }).returning({ id: companies.id });
    companyId = nc.id;
  }

  async function resolveInsured(p: any): Promise<number> {
    let existing = null;
    if (p.insuredDni) existing = await db.select().from(insureds).where(eq(insureds.dni, String(p.insuredDni))).get();
    if (!existing) existing = await db.select().from(insureds).where(eq(insureds.name, p.insuredName)).get();
    if (existing) {
      if (p.insuredEmail && !existing.email) await db.update(insureds).set({ email: p.insuredEmail }).where(eq(insureds.id, existing.id));
      if (p.insuredPhone && !existing.phone) await db.update(insureds).set({ phone: p.insuredPhone }).where(eq(insureds.id, existing.id));
      return existing.id;
    }
    const [ni] = await db.insert(insureds).values({
      name: p.insuredName, dni: p.insuredDni ? String(p.insuredDni) : null,
      email: p.insuredEmail || null, phone: p.insuredPhone || null,
      address: p.insuredAddress || null, createdBy: user.id,
    }).returning({ id: insureds.id });
    return ni.id;
  }

  async function insertInstallments(exec: any, policyId: number, installments: any[], rebillingId: number | null = null) {
    for (const inst of installments) {
      await exec.insert(policyInstallments).values({
        policyId, number: inst.number, dueDate: inst.dueDate, amount: inst.amount, status: "pendiente", rebillingId,
      });
    }
  }

  function resolveTypeAndStatus(p: any) {
    const vt = (p.vehicleType || "").toLowerCase();
    let polType: string;
    if      (vt === "motovehiculo" || vt === "moto") polType = "motovehiculo";
    else if (vt === "accidentes_pasajeros")           polType = "accidentes_pasajeros";
    else if (vt === "hogar")                          polType = "hogar";
    else if (vt === "riesgos_varios")                 polType = "riesgos_varios";
    else if (vt === "integral_comercio")              polType = "integral_comercio";
    else polType = "automotor";
    const today = toArgentinaCalendarDay();
    const daysToEnd = Math.ceil((new Date(p.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24));
    let status = "activa";
    if (daysToEnd < 0) status = "vencida";
    else if (daysToEnd <= 30) status = "por_vencer";
    return { polType, status };
  }

  // Buscar póliza automotor 02 de un asegurado con endDate exacto (evita picks incorrectos)
  async function findParentAutoPolicyId(insuredDni: string, insuredName: string, endDate: string): Promise<number | null> {
    try {
      let ins = insuredDni
        ? await db.select().from(insureds).where(eq(insureds.dni, String(insuredDni))).get()
        : null;
      if (!ins && insuredName) ins = await db.select().from(insureds).where(eq(insureds.name, insuredName)).get();
      if (!ins) return null;
      const autoPol = await db.select().from(policies)
        .where(and(
          eq(policies.insuredId, ins.id),
          eq(policies.companyId, companyId),
          eq(policies.type, "automotor"),
          eq(policies.endDate, endDate),
        ))
        .orderBy(desc(policies.startDate))
        .limit(1)
        .get();
      return autoPol ? autoPol.id : null;
    } catch { return null; }
  }

  // ── Pasada 1: pólizas principales 02/04/05/09/20 ────────────────────────────
  // Mapa para vincular 10s del mismo batch: `${dni}|${endDate}` → policyId automotor
  const batchAutomotorMap = new Map<string, number>(); // clave: `${dni}|${startDate}|${endDate}`
  const mainPolicies = parsedPolicies.filter(p => !String(p.policyNumber).startsWith("09-10-"));
  const tenPolicies  = parsedPolicies.filter(p =>  String(p.policyNumber).startsWith("09-10-"));

  for (const p of mainPolicies) {
    try {
      const mov = (p.movType || "").toUpperCase();

      // REDUCCION → skip
      if (mov.includes("REDUCCION")) { results.skipped++; continue; }

      // ANULACION
      if (mov.includes("ANULACION")) {
        const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
        if (existing) {
          await db.update(policies).set({ status: "cancelada", notes: (existing.notes ? existing.notes + " | " : "") + "Anulada por importación Rivadavia" }).where(eq(policies.id, existing.id));
          results.cancelled++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // PRORROGA
      if (mov.includes("PRORROGA")) {
        let existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
        if (!existing && p._renovacionRef) {
          const refNum = String(p._renovacionRef).split("/").pop() || "";
          if (refNum) {
            const candidates = await db.select().from(policies).where(like(policies.policyNumber, `%${refNum}%`)).all();
            if (candidates.length > 0) existing = candidates[0];
          }
        }
        if (existing) {
          await db.transaction(async (tx) => {
            const [reb] = await tx.insert(rebillings).values({
              policyId: existing.id,
              billingStart: p.startDate, billingEnd: p.endDate,
              premium: p.premium || null, sumInsured: p.sumInsured || null,
              notes: `Importado de Rivadavia`,
              createdBy: user.id,
            }).returning({ id: rebillings.id });
            if (p.installments?.length > 0) await insertInstallments(tx, existing.id, p.installments, reb!.id);
            const { status } = resolveTypeAndStatus(p);
            await tx.update(policies).set({ endDate: p.endDate, status, premium: p.premium || existing.premium }).where(eq(policies.id, existing.id));
          });
          if (existing.type === "automotor" && p.insuredDni) {
            batchAutomotorMap.set(`${p.insuredDni}|${p.startDate}|${p.endDate}`, existing.id);
          }
          results.rebillings++;
          continue;
        }
        // Huérfana con datos base provistos
        if (p._baseStartDate) {
          const insuredId = await resolveInsured(p);
          const { polType } = resolveTypeAndStatus(p);
          const isMoto = polType === "motovehiculo";
          const basePolRows = await db.insert(policies).values({
            policyNumber: String(p.policyNumber), type: polType, status: "vencida",
            companyId, insuredId,
            premium: p._basePremium || p.premium || null,
            sumInsured: p._baseSumInsured || p.sumInsured || null,
            coverageType: p._baseCoverage || p.coverageLabel || null,
            startDate: p._baseStartDate, endDate: p._baseEndDate || p.startDate,
            isRebilling: 0,
            vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
            vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
            vehicleYear: !isMoto ? (p.vehicleYear || null) : null,
            vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
            motoBrand: isMoto ? (p.vehicleBrand || null) : null,
            motoModel: isMoto ? (p.vehicleModel || null) : null,
            motoYear: isMoto ? (p.vehicleYear || null) : null,
            motoPlate: isMoto ? (p.vehiclePlate || null) : null,
            motoEngine: isMoto ? (p.engineNumber || null) : null,
            notes: p._baseNotes || "Póliza base creada manualmente al importar prórroga",
            createdBy: user.id,
          }).returning({ id: policies.id });
          const basePolId = basePolRows[0]!.id;
          const { status } = resolveTypeAndStatus(p);
          await db.transaction(async (tx) => {
            const [reb] = await tx.insert(rebillings).values({
              policyId: basePolId, billingStart: p.startDate, billingEnd: p.endDate,
              premium: p.premium || null, sumInsured: p.sumInsured || null,
              notes: `Importado de Rivadavia`, createdBy: user.id,
            }).returning({ id: rebillings.id });
            await tx.update(policies).set({ endDate: p.endDate, status, premium: p.premium || null }).where(eq(policies.id, basePolId));
            if (p.installments?.length > 0) await insertInstallments(tx, basePolId, p.installments, reb!.id);
          });
          if (polType === "automotor" && p.insuredDni) {
            batchAutomotorMap.set(`${p.insuredDni}|${p.startDate}|${p.endDate}`, basePolId);
          }
          results.rebillings++;
          continue;
        }
        // Sin datos base → crear como póliza nueva marcada isRebilling
      }

      // PÓLIZA NUEVA
      const existingPol = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
      if (existingPol && !mov.includes("PRORROGA")) { results.skipped++; continue; }

      const insuredId = await resolveInsured(p);
      const { polType, status } = resolveTypeAndStatus(p);
      const isMoto = polType === "motovehiculo";
      const isRebilling = mov.includes("PRORROGA") ? 1 : 0;

      const [newPolicy] = await db.insert(policies).values({
        policyNumber: String(p.policyNumber), type: polType, status,
        companyId, insuredId,
        premium: p.premium || null, sumInsured: p.sumInsured || null,
        coverageType: p.coverageLabel || null,
        startDate: p.startDate, endDate: p.endDate,
        installments: p.installments?.length || null,
        isRebilling,
        vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
        vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
        vehicleYear: !isMoto ? (p.vehicleYear || null) : null,
        vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
        motoBrand: isMoto ? (p.vehicleBrand || null) : null,
        motoModel: isMoto ? (p.vehicleModel || null) : null,
        motoYear: isMoto ? (p.vehicleYear || null) : null,
        motoPlate: isMoto ? (p.vehiclePlate || null) : null,
        motoEngine: isMoto ? (p.engineNumber || null) : null,
        notes: `Importado de Rivadavia. Movimiento: ${p.movType || "RENOVACION"}`,
        createdBy: user.id,
      }).returning({ id: policies.id });

      if (p.installments?.length > 0) await insertInstallments(db, newPolicy.id, p.installments, null);
      if (polType === "automotor" && p.insuredDni) {
        batchAutomotorMap.set(`${p.insuredDni}|${p.startDate}|${p.endDate}`, newPolicy!.id);
      }
      isRebilling ? results.rebillings++ : results.imported++;

    } catch (e: any) {
      results.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      results.skipped++;
    }
  }

  // ── Pasada 2: pólizas 10 (accidentes_pasajeros) ──────────────────────────────
  for (const p of tenPolicies) {
    try {
      const mov = (p.movType || "").toUpperCase();

      if (mov.includes("REDUCCION")) { results.skipped++; continue; }

      // ANULACION de 10 existente
      if (mov.includes("ANULACION")) {
        const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
        if (existing) {
          await db.update(policies).set({ status: "cancelada", notes: (existing.notes ? existing.notes + " | " : "") + "Anulada por importación Rivadavia" }).where(eq(policies.id, existing.id));
          results.cancelled++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // PRORROGA de 10 existente
      if (mov.includes("PRORROGA")) {
        let existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
        if (!existing && p._renovacionRef) {
          const refNum = String(p._renovacionRef).split("/").pop() || "";
          if (refNum) {
            const candidates = await db.select().from(policies).where(like(policies.policyNumber, `%${refNum}%`)).all();
            if (candidates.length > 0) existing = candidates[0];
          }
        }
        if (existing) {
          await db.transaction(async (tx) => {
            const [reb] = await tx.insert(rebillings).values({
              policyId: existing.id,
              billingStart: p.startDate, billingEnd: p.endDate,
              premium: p.premium || null, sumInsured: p.sumInsured || null,
              notes: `Importado de Rivadavia`,
              createdBy: user.id,
            }).returning({ id: rebillings.id });
            if (p.installments?.length > 0) await insertInstallments(tx, existing.id, p.installments, reb!.id);
            const { status } = resolveTypeAndStatus(p);
            await tx.update(policies).set({ endDate: p.endDate, status, premium: p.premium || existing.premium }).where(eq(policies.id, existing.id));
          });
          results.rebillings++;
          continue;
        }
        // Sin 10 previa → crear nueva con padre (fall through)
      }

      // Duplicado check
      const existingPol = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
      if (existingPol && !mov.includes("PRORROGA")) { results.skipped++; continue; }

      // Buscar padre 02 en batch del mismo TXT, luego en DB con endDate exacto
      const batchKey = `${p.insuredDni}|${p.startDate}|${p.endDate}`;
      let parentPolicyId = batchAutomotorMap.get(batchKey) ?? null;
      if (!parentPolicyId) {
        parentPolicyId = await findParentAutoPolicyId(p.insuredDni, p.insuredName, p.endDate);
      }
      if (!parentPolicyId) {
        results.errors.push(`Póliza ${p.policyNumber} (acc. pasajeros): sin automotor 02 para DNI ${p.insuredDni}, venc. ${p.endDate}. Revisar manualmente.`);
        results.skipped++;
        continue;
      }

      const insuredId = await resolveInsured(p);
      const { status } = resolveTypeAndStatus(p);
      const isRebilling = mov.includes("PRORROGA") ? 1 : 0;

      const [newPolicy] = await db.insert(policies).values({
        policyNumber: String(p.policyNumber), type: "accidentes_pasajeros", status,
        companyId, insuredId,
        premium: p.premium || null, sumInsured: p.sumInsured || null,
        coverageType: p.coverageLabel || null,
        startDate: p.startDate, endDate: p.endDate,
        installments: p.installments?.length || null,
        isRebilling,
        parentPolicyId,
        notes: `Importado de Rivadavia. Movimiento: ${p.movType || "RENOVACION"}`,
        createdBy: user.id,
      }).returning({ id: policies.id });

      if (p.installments?.length > 0) await insertInstallments(db, newPolicy.id, p.installments, null);
      isRebilling ? results.rebillings++ : results.imported++;

    } catch (e: any) {
      results.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      results.skipped++;
    }
  }

  return c.json(results, 200);
}));
// ─────────────────────────────────────────────────────────────────────────────

// ── /import/cooperacion ──────────────────────────────────────────────────────
app.post("/import/cooperacion", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsedPolicies: any[] = body.policies || [];
  if (!parsedPolicies.length) return c.json({ error: "Sin pólizas" }, 400);

  const results = { imported: 0, rebillings: 0, cancelled: 0, skipped: 0, errors: [] as string[] };

  // Buscar o crear la compañía Cooperación
  let companyId: number;
  const existingCompany = await db.select().from(companies).where(eq(companies.name, "Cooperación")).get();
  if (existingCompany) {
    companyId = existingCompany.id;
  } else {
    const [nc] = await db.insert(companies).values({ name: "Cooperación" }).returning({ id: companies.id });
    companyId = nc.id;
  }

  async function resolveInsured(p: any): Promise<number> {
    let existing = null;
    if (p.insuredDni) existing = await db.select().from(insureds).where(eq(insureds.dni, String(p.insuredDni))).get();
    if (!existing) existing = await db.select().from(insureds).where(eq(insureds.name, p.insuredName)).get();
    if (existing) {
      if (p.insuredAddress && !existing.address) await db.update(insureds).set({ address: p.insuredAddress }).where(eq(insureds.id, existing.id));
      return existing.id;
    }
    const [ni] = await db.insert(insureds).values({
      name: p.insuredName, dni: p.insuredDni ? String(p.insuredDni) : null,
      address: p.insuredAddress || null, createdBy: user.id,
    }).returning({ id: insureds.id });
    return ni.id;
  }

  function resolveStatus(endDate: string): string {
    const today = toArgentinaCalendarDay();
    const days = Math.ceil((new Date(endDate).getTime() - new Date(today).getTime()) / 86400000);
    if (days < 0) return "vencida";
    if (days <= 30) return "por_vencer";
    return "activa";
  }

  // Buscar póliza principal por número (para subpólizas con _parentPolicyNumber)
  async function findParentByNumber(policyNumber: string): Promise<number | null> {
    if (!policyNumber) return null;
    const found = await db.select().from(policies)
      .where(and(eq(policies.policyNumber, policyNumber), eq(policies.companyId, companyId)))
      .get();
    return found ? found.id : null;
  }

  // Busca padre auto/moto del mismo asegurado en Cooperación.
  // Paso 1: vigencia exacta. Paso 2: superposición. Con 0 o >1 por superposición → null.
  async function findParentByDniVigencia(insuredDni: string, startDate: string, endDate: string): Promise<number | null> {
    if (!insuredDni) return null;
    const ins = await db.select().from(insureds).where(eq(insureds.dni, String(insuredDni))).get();
    if (!ins) return null;

    const exact = await db.select().from(policies)
      .where(and(
        eq(policies.insuredId, ins.id),
        eq(policies.companyId, companyId),
        inArray(policies.type, ["automotor", "motovehiculo"]),
        eq(policies.startDate, startDate),
        eq(policies.endDate, endDate),
      ))
      .limit(1).get();
    if (exact) return exact.id;

    const candidates = await db.select().from(policies)
      .where(and(
        eq(policies.insuredId, ins.id),
        eq(policies.companyId, companyId),
        inArray(policies.type, ["automotor", "motovehiculo"]),
        lte(policies.startDate, endDate),
        gte(policies.endDate, startDate),
      ))
      .all();

    return candidates.length === 1 ? candidates[0].id : null;
  }

  // Pasada 1: principales (ramo 32, 31 standalone, 46)
  // Pasada 2: hijas (ramo 41 con 14- o 1405..., ramo 31 con 12-)
  const mainPolicies = parsedPolicies.filter((p: any) => !p._parentPolicyNumber && !p._findParentByDni);
  const childPolicies = parsedPolicies.filter((p: any) =>  p._parentPolicyNumber || p._findParentByDni);

  for (const p of [...mainPolicies, ...childPolicies]) {
    try {
      const mov = (p.movType || "").toUpperCase();

      // ANULACION
      if (mov === "ANULACION") {
        const existing = await db.select().from(policies).where(and(
          eq(policies.policyNumber, String(p.policyNumber)),
          eq(policies.companyId, companyId),
        )).get();
        if (existing) {
          await db.update(policies).set({ status: "cancelada", notes: (existing.notes ? existing.notes + " | " : "") + "Anulada por importación Cooperación" }).where(eq(policies.id, existing.id));
          results.cancelled++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // ENDOSO → skip por ahora
      if (mov === "ENDOSO") { results.skipped++; continue; }

      // RENOVACION / ALTA: si ya existe actualizar fechas y status, si no crear
      const existing = await db.select().from(policies).where(and(
        eq(policies.policyNumber, String(p.policyNumber)),
        eq(policies.companyId, companyId),
      )).get();

      const vt = (p.vehicleType || "").toLowerCase();
      const isMoto = vt === "motovehiculo";
      const isAccPas = vt === "accidentes_pasajeros";
      const isHogar = vt === "hogar";
      const isCascos = vt === "cascos";
      const status = resolveStatus(p.endDate);

      // Resolver parentPolicyId si es subpóliza
      let parentPolicyId: number | null = null;
      if (p._parentPolicyNumber) {
        parentPolicyId = await findParentByNumber(p._parentPolicyNumber);
      }
      if (p._findParentByDni) {
        parentPolicyId = await findParentByDniVigencia(p.insuredDni, p.startDate, p.endDate);
      }
      // Ramo 41 nueva sin padre confirmado → no importar
      if (vt === "accidentes_pasajeros" && parentPolicyId === null && !existing) {
        results.skipped++;
        results.errors.push(`Póliza ${p.policyNumber}: ramo 41 sin póliza principal asociable`);
        continue;
      }

      if (existing) {
        // Ya existe → actualizar vigencia
        await db.update(policies).set({
          startDate: p.startDate, endDate: p.endDate, status,
          sumInsured: p.sumInsured || existing.sumInsured,
          coverageType: p.coverageLabel || existing.coverageType,
          parentPolicyId: parentPolicyId ?? existing.parentPolicyId,
          updatedAt: new Date(),
        }).where(eq(policies.id, existing.id));
        results.rebillings++;
        continue;
      }

      // Crear nueva
      const insuredId = await resolveInsured(p);
      await db.insert(policies).values({
        policyNumber: String(p.policyNumber),
        type: vt || "automotor",
        status,
        companyId,
        insuredId,
        premium: p.premium || null,
        sumInsured: p.sumInsured || null,
        coverageType: p.coverageLabel || null,
        startDate: p.startDate,
        endDate: p.endDate,
        vigencyPeriod: "cuatrimestral",
        isRebilling: 0,
        vehicleBrand: (!isMoto && !isAccPas && !isHogar && !isCascos) ? (p.vehicleBrand || null) : null,
        vehicleModel: (!isMoto && !isAccPas && !isHogar && !isCascos) ? (p.vehicleModel || null) : null,
        vehiclePlate: (!isMoto && !isAccPas && !isHogar && !isCascos) ? (p.vehiclePlate || null) : null,
        motoBrand: isMoto ? (p.vehicleBrand || null) : null,
        motoModel: isMoto ? (p.vehicleModel || null) : null,
        motoPlate: isMoto ? (p.vehiclePlate || null) : null,
        parentPolicyId,
        notes: `Importado de Cooperación. Ramo: ${p.coverageCode || ""}`,
        createdBy: user.id,
      });
      results.imported++;

    } catch (e: any) {
      results.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      results.skipped++;
    }
  }

  return c.json(results, 200);
}));
// ── /import/mercantil-andina ──────────────────────────────────────────────────
app.post("/import/mercantil-andina", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsedPolicies: any[] = body.policies || [];
  if (!parsedPolicies.length) return c.json({ error: "Sin pólizas" }, 400);

  const results = { imported: 0, rebillings: 0, cancelled: 0, skipped: 0, errors: [] as string[] };

  // Buscar o crear la compañía
  let companyId: number;
  const existingCompany = await db.select().from(companies).where(eq(companies.name, "Mercantil Andina")).get();
  if (existingCompany) {
    companyId = existingCompany.id;
  } else {
    const [nc] = await db.insert(companies).values({ name: "Mercantil Andina" }).returning({ id: companies.id });
    companyId = nc.id;
  }

  async function resolveInsured(p: any): Promise<number> {
    let existing = null;
    if (p.insuredDni) existing = await db.select().from(insureds).where(eq(insureds.dni, String(p.insuredDni))).get();
    if (!existing) existing = await db.select().from(insureds).where(eq(insureds.name, p.insuredName)).get();
    if (existing) {
      if (p.insuredAddress && !existing.address)
        await db.update(insureds).set({ address: p.insuredAddress }).where(eq(insureds.id, existing.id));
      return existing.id;
    }
    const [ni] = await db.insert(insureds).values({
      name: p.insuredName,
      dni: p.insuredDni ? String(p.insuredDni) : null,
      address: p.insuredAddress || null,
      createdBy: user.id,
    }).returning({ id: insureds.id });
    return ni.id;
  }

  function resolveStatus(endDate: string): string {
    const today = toArgentinaCalendarDay();
    const days = Math.ceil((new Date(endDate).getTime() - new Date(today).getTime()) / 86400000);
    if (days < 0) return "vencida";
    if (days <= 30) return "por_vencer";
    return "activa";
  }

  // Vigencia dinámica según duración en meses
  function resolveVigencyPeriod(startDate: string, endDate: string): string {
    if (!startDate || !endDate) return "anual";
    const start = new Date(startDate);
    const end = new Date(endDate);
    const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    if (months <= 1) return "mensual";
    if (months <= 4) return "cuatrimestral";
    if (months <= 6) return "semestral";
    return "anual";
  }

  // Para accidentes_pasajeros: buscar auto activo en Mercantil Andina con mismo DNI
  async function findParentByDni(dni: string): Promise<number | null> {
    if (!dni) return null;
    const insured = await db.select().from(insureds).where(eq(insureds.dni, String(dni))).get();
    if (!insured) return null;
    const found = await db.select().from(policies).where(and(
      eq(policies.insuredId, insured.id),
      eq(policies.companyId, companyId),
      eq(policies.type, "automotor"),
    )).get();
    return found ? found.id : null;
  }

  for (const p of parsedPolicies) {
    try {
      const mov = (p.movType || "").toUpperCase();
      const vt = (p.vehicleType || "").toLowerCase();
      const isAccPas = vt === "accidentes_pasajeros";
      const isMoto = vt === "motovehiculo";
      const isHogar = vt === "hogar";
      const status = resolveStatus(p.endDate);

      // ── ANULACION ──
      if (mov === "ANULACION") {
        const existing = await db.select().from(policies).where(and(
          eq(policies.policyNumber, String(p.policyNumber)),
          eq(policies.companyId, companyId),
        )).get();
        if (existing) {
          await db.update(policies).set({
            status: "cancelada",
            notes: (existing.notes ? existing.notes + " | " : "") + "Anulada por importación Mercantil Andina",
          }).where(eq(policies.id, existing.id));
          results.cancelled++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // ── RENOVACION: extensión vigencia → rebilling sobre póliza existente ──
      if (mov === "RENOVACION") {
        const existing = await db.select().from(policies).where(and(
          eq(policies.policyNumber, String(p.policyNumber)),
          eq(policies.companyId, companyId),
        )).get();
        if (existing) {
          await db.insert(rebillings).values({
            policyId: existing.id,
            billingStart: p.startDate,
            billingEnd: p.endDate,
            premium: p.premium || null,
            sumInsured: p.sumInsured || null,
            notes: `Importado de Mercantil Andina. Extensión de vigencia.`,
            createdBy: user.id,
          });
          // Actualizar endDate y status de la póliza base
          await db.update(policies).set({
            endDate: p.endDate,
            status,
            premium: p.premium || existing.premium,
            updatedAt: new Date(),
          }).where(eq(policies.id, existing.id));
          results.rebillings++;
          continue;
        }
        // Si no existe la póliza aún, caer en creación (ALTA implícita)
      }

      // ── ALTA (o RENOVACION sin póliza existente): crear nueva ──
      // Resolver parentPolicyId
      let parentPolicyId: number | null = null;
      if (isAccPas && p._linkByDni && p.insuredDni) {
        parentPolicyId = await findParentByDni(String(p.insuredDni));
      }

      const insuredId = await resolveInsured(p);
      const vigencyPeriod = resolveVigencyPeriod(p.startDate, p.endDate);

      await db.insert(policies).values({
        policyNumber: String(p.policyNumber),
        type: vt || "automotor",
        status,
        companyId,
        insuredId,
        premium: p.premium || null,
        sumInsured: p.sumInsured || null,
        coverageType: p.coverageLabel || null,
        startDate: p.startDate,
        endDate: p.endDate,
        vigencyPeriod,
        isRebilling: 0,
        vehicleBrand: (!isMoto && !isAccPas && !isHogar) ? (p.vehicleBrand || null) : null,
        vehicleModel: (!isMoto && !isAccPas && !isHogar) ? (p.vehicleModel || null) : null,
        vehicleYear: (!isMoto && !isAccPas && !isHogar) ? (p.vehicleYear || null) : null,
        vehiclePlate: (!isMoto && !isAccPas && !isHogar) ? (p.vehiclePlate || null) : null,
        motoBrand: isMoto ? (p.vehicleBrand || null) : null,
        motoModel: isMoto ? (p.vehicleModel || null) : null,
        motoYear: isMoto ? (p.vehicleYear || null) : null,
        motoPlate: isMoto ? (p.vehiclePlate || null) : null,
        parentPolicyId,
        notes: `Importado de Mercantil Andina. Sec: ${p.coverageCode || ""}`,
        createdBy: user.id,
      });
      results.imported++;

    } catch (e: any) {
      results.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      results.skipped++;
    }
  }

  return c.json(results, 200);
}));
// ─────────────────────────────────────────────────────────────────────────────

// ── Jobs en memoria — El Norte Gmail ─────────────────────────────────────────
const elNorteJobs = new Map<string, {
  status: "running" | "done" | "error";
  phase: string;
  totalMails: number;
  processed: number;
  imported: number;
  rebillings: number;
  endosos: number;
  anulaciones: number;
  duplicados: number;
  revisar: number;
  skipped: number;
  errors: string[];
  startedAt: number;
  finishedAt?: number;
}>();

// ── Helpers internos El Norte v2 ──────────────────────────────────────────────
async function enResolveInsured(p: any, userId: number): Promise<number> {
  let existing: any = null;
  if (p.insuredDni) existing = await db.select().from(insureds).where(eq(insureds.dni, String(p.insuredDni))).get();
  if (!existing) existing = await db.select().from(insureds).where(eq(insureds.name, p.insuredName)).get();
  if (existing) {
    if (p.insuredEmail && !existing.email) await db.update(insureds).set({ email: p.insuredEmail }).where(eq(insureds.id, existing.id));
    if (p.insuredPhone && !existing.phone) await db.update(insureds).set({ phone: p.insuredPhone }).where(eq(insureds.id, existing.id));
    return existing.id;
  }
  const [ni] = await db.insert(insureds).values({
    name: p.insuredName, dni: p.insuredDni || null,
    phone: p.insuredPhone || null, email: p.insuredEmail || null,
    address: p.insuredAddress || null, createdBy: userId,
  }).returning({ id: insureds.id });
  return ni.id;
}

function normalizePremiumCents(premium: number | null | undefined): number {
  return Math.round((premium ?? 0) * 100);
}

// Genérico — no específico del importador de El Norte (a pesar del nombre
// histórico de los call sites que la usaban primero): mismo criterio de
// duplicado para el importador y para POST /policies/:id/rebillings (alta
// manual) — policyId + billingStart + billingEnd + premium exactos.
async function checkDuplicateRebilling(
  policyId: number, billingStart: string, billingEnd: string, premium: number | null | undefined, dbClient: any = db
): Promise<boolean> {
  const rows = await dbClient.select({ premium: rebillings.premium })
    .from(rebillings)
    .where(and(
      eq(rebillings.policyId, policyId),
      eq(rebillings.billingStart, billingStart),
      eq(rebillings.billingEnd, billingEnd),
    ))
    .all();
  const targetCents = normalizePremiumCents(premium);
  return rows.some((r: any) => normalizePremiumCents(r.premium) === targetCents);
}

function enDeduplicateBatch(policiesArr: any[]): { deduped: any[]; inBatchDuplicates: number } {
  const seen = new Set<string>();
  const deduped: any[] = [];
  let inBatchDuplicates = 0;
  for (const p of policiesArr) {
    const key = [
      String(p.policyNumber || "").trim(),
      String(p.startDate || ""),
      String(p.endDate || ""),
      normalizePremiumCents(p.premium),
      String(p.movType || "").toUpperCase().trim(),
    ].join("|");
    if (seen.has(key)) {
      inBatchDuplicates++;
    } else {
      seen.add(key);
      deduped.push(p);
    }
  }
  return { deduped, inBatchDuplicates };
}

async function enInsertInstallments(policyId: number, insts: any[], rebillingId: number | null = null): Promise<number> {
  for (const inst of insts) {
    await db.insert(policyInstallments).values({
      policyId, number: inst.number, dueDate: inst.dueDate, amount: inst.amount, status: "pendiente", rebillingId,
    });
  }
  return insts.length;
}

function enResolveTypeAndStatus(p: any): { polType: string; status: string } {
  const policyNumber = String(p.policyNumber || "").trim().toLowerCase();
  const vt = (p.vehicleType || "").toLowerCase();
  const brand = (p.vehicleBrand || "").toUpperCase();
  const vehicleSignals = [
    p.vehicleType,
    p.vehicleBrand,
    p.vehicleModel,
    p.coverageLabel,
    p.coverageCode,
  ].filter(Boolean).join(" ").toLowerCase();
  let polType: string;
  if (policyNumber.startsWith("3-")) polType = "motovehiculo";
  else if (policyNumber.startsWith("4-")) polType = "automotor";
  else if (vt.includes("accidentes_pasajeros") || vt.includes("accidente")) polType = "accidentes";
  else if (
    vt === "motovehiculo" ||
    vt === "motovehículo" ||
    vt === "moto" ||
    vehicleSignals.includes("motoveh") ||
    vehicleSignals.includes("moto") ||
    vehicleSignals.includes("honda wave") ||
    vehicleSignals.includes("wave") ||
    vehicleSignals.includes("biz") ||
    // XR y Titan: solo si la marca es Honda (Peugeot 206 XR → automotor)
    (brand === "HONDA" && (vehicleSignals.includes("xr") || vehicleSignals.includes("titan")))
  ) polType = "motovehiculo";
  else polType = "automotor";
  const today = toArgentinaCalendarDay();
  const daysToEnd = Math.ceil((new Date(p.endDate).getTime() - new Date(today).getTime()) / 86400000);
  let status = "activa";
  if (daysToEnd < 0) status = "vencida";
  else if (daysToEnd <= 30) status = "por_vencer";
  return { polType, status };
}

type ImportCounts = {
  imported: number; rebillings: number; endosos: number;
  anulaciones: number; duplicados: number; revisar: number; skipped: number;
  installmentsCreated: number;
  errors: string[];
};

async function enImportOne(p: any, companyId: number, userId: number, counts: ImportCounts) {
  const mov = (p.movType || "").toUpperCase();

  if (mov.includes("NOTA DE CREDITO") || mov.includes("NOTA_DE_CREDITO")) {
    counts.skipped++;
    return;
  }

  if (mov.includes("ANULACION")) {
    const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
    if (existing) {
      await db.update(policies).set({ status: "cancelada", notes: (existing.notes ? existing.notes + " | " : "") + "Anulada por importación El Norte" }).where(eq(policies.id, existing.id));
      counts.anulaciones++;
    } else {
      counts.skipped++;
    }
    return;
  }

  if (mov.includes("ENDOSO")) {
    const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
    if (existing) {
      if (await checkDuplicateRebilling(existing.id, p.startDate, p.endDate, p.premium)) {
        counts.duplicados++;
        return;
      }
      const { status } = enResolveTypeAndStatus(p);
      const installmentValues = (p.installments || []).map((inst: any) => ({
        policyId: existing.id, number: inst.number, dueDate: inst.dueDate,
        amount: inst.amount, status: "pendiente" as const,
      }));
      await db.transaction(async (tx) => {
        const [reb] = await tx.insert(rebillings).values({
          policyId: existing.id, billingStart: p.startDate, billingEnd: p.endDate,
          premium: p.premium || null, sumInsured: p.sumInsured || null,
          notes: `Importado de El Norte v2. Endoso ${p.endoso || ""}`, createdBy: userId,
        }).returning({ id: rebillings.id });
        if (installmentValues.length > 0) {
          await tx.insert(policyInstallments).values(installmentValues.map(v => ({ ...v, rebillingId: reb!.id })));
        }
        await tx.update(policies).set({ endDate: p.endDate, status, premium: p.premium || existing.premium }).where(eq(policies.id, existing.id));
      });
      counts.endosos++;
      counts.installmentsCreated += installmentValues.length;
    } else {
      counts.revisar++;
    }
    return;
  }

  if (mov.includes("PRORROGA")) {
    const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
    if (existing) {
      if (await checkDuplicateRebilling(existing.id, p.startDate, p.endDate, p.premium)) {
        counts.duplicados++;
        return;
      }
      const { status } = enResolveTypeAndStatus(p);
      const installmentValues = (p.installments || []).map((inst: any) => ({
        policyId: existing.id, number: inst.number, dueDate: inst.dueDate,
        amount: inst.amount, status: "pendiente" as const,
      }));
      await db.transaction(async (tx) => {
        const [reb] = await tx.insert(rebillings).values({
          policyId: existing.id, billingStart: p.startDate, billingEnd: p.endDate,
          premium: p.premium || null, sumInsured: p.sumInsured || null,
          notes: `Importado de El Norte v2. Prórroga endoso ${p.endoso || ""}`, createdBy: userId,
        }).returning({ id: rebillings.id });
        if (installmentValues.length > 0) {
          await tx.insert(policyInstallments).values(installmentValues.map(v => ({ ...v, rebillingId: reb!.id })));
        }
        await tx.update(policies).set({ endDate: p.endDate, status, premium: p.premium || existing.premium }).where(eq(policies.id, existing.id));
      });
      counts.rebillings++;
      counts.installmentsCreated += installmentValues.length;
      return;
    }
    if (p._baseStartDate) {
      const insuredId = await enResolveInsured(p, userId);
      const { polType, status } = enResolveTypeAndStatus(p);
      const isMoto = polType === "motovehiculo";
      const installmentsData = (p.installments || []).map((inst: any) => ({
        number: inst.number, dueDate: inst.dueDate, amount: inst.amount, status: "pendiente" as const,
      }));
      await db.transaction(async (tx) => {
        const [bp] = await tx.insert(policies).values({
          policyNumber: String(p.policyNumber), type: polType, status: "vencida", companyId, insuredId,
          premium: p._basePremium || p.premium || null, sumInsured: p._baseSumInsured || p.sumInsured || null,
          coverageType: p._baseCoverage || p.coverageLabel || null,
          startDate: p._baseStartDate, endDate: p._baseEndDate || p.startDate, isRebilling: 0,
          vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
          vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
          vehicleYear: !isMoto ? (p.vehicleYear || null) : null,
          vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
          motoBrand: isMoto ? (p.vehicleBrand || null) : null,
          motoModel: isMoto ? (p.vehicleModel || null) : null,
          motoYear: isMoto ? (p.vehicleYear || null) : null,
          motoPlate: isMoto ? (p.vehiclePlate || null) : null,
          motoEngine: isMoto ? (p.engineNumber || null) : null,
          notes: p._baseNotes || "Póliza base creada al importar prórroga El Norte",
          createdBy: userId,
        }).returning({ id: policies.id });
        const [reb] = await tx.insert(rebillings).values({
          policyId: bp.id, billingStart: p.startDate, billingEnd: p.endDate,
          premium: p.premium || null, sumInsured: p.sumInsured || null,
          notes: `Importado de El Norte v2. Prórroga endoso ${p.endoso || ""}`, createdBy: userId,
        }).returning({ id: rebillings.id });
        await tx.update(policies).set({ endDate: p.endDate, status, premium: p.premium || null }).where(eq(policies.id, bp.id));
        if (installmentsData.length > 0) {
          await tx.insert(policyInstallments).values(installmentsData.map(inst => ({ ...inst, policyId: bp.id, rebillingId: reb!.id })));
        }
      });
      counts.rebillings++;
      counts.installmentsCreated += installmentsData.length;
      return;
    }
  }

  const existingPol = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
  if (existingPol && !mov.includes("PRORROGA")) {
    counts.duplicados++;
    return;
  }

  const insuredId = await enResolveInsured(p, userId);
  const { polType, status } = enResolveTypeAndStatus(p);
  const isMoto = polType === "motovehiculo";
  const isRebilling = mov.includes("PRORROGA") ? 1 : 0;

  const [newPol] = await db.insert(policies).values({
    policyNumber: String(p.policyNumber), type: polType, status, companyId, insuredId,
    premium: p.premium || null, sumInsured: p.sumInsured || null,
    coverageType: p.coverageLabel || null, startDate: p.startDate, endDate: p.endDate,
    installments: p.installments?.length || null, isRebilling,
    vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
    vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
    vehicleYear: !isMoto ? (p.vehicleYear || null) : null,
    vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
    motoBrand: isMoto ? (p.vehicleBrand || null) : null,
    motoModel: isMoto ? (p.vehicleModel || null) : null,
    motoYear: isMoto ? (p.vehicleYear || null) : null,
    motoPlate: isMoto ? (p.vehiclePlate || null) : null,
    motoEngine: isMoto ? (p.engineNumber || null) : null,
    notes: `Importado de El Norte v2. Movimiento: ${p.movType || "RENOVACION"}`,
    createdBy: userId,
  }).returning({ id: policies.id });

  if (p.installments?.length > 0) await enInsertInstallments(newPol.id, p.installments);
  isRebilling ? counts.rebillings++ : counts.imported++;
}

async function enGetOrCreateCompany(): Promise<number> {
  const existing = await db.select().from(companies).where(eq(companies.name, "El Norte")).get();
  if (existing) return existing.id;
  const [nc] = await db.insert(companies).values({ name: "El Norte" }).returning({ id: companies.id });
  return nc.id;
}

async function enInsertImportLog(values: typeof importLogs.$inferInsert): Promise<number | null> {
  if (values.gmailMessageId) {
    const existing = await db
      .select({ id: importLogs.id })
      .from(importLogs)
      .where(eq(importLogs.gmailMessageId, values.gmailMessageId))
      .get();
    if (existing) return existing.id;
  }

  try {
    const [log] = await db.insert(importLogs).values(values).returning({ id: importLogs.id });
    return log?.id ?? null;
  } catch (e: any) {
    const message = String(e?.message || "");
    const isDuplicateGmailMessageId =
      !!values.gmailMessageId &&
      (message.includes("UNIQUE constraint failed: import_logs.gmail_message_id") ||
        message.includes("import_logs_gmail_message_id_unique"));
    if (!isDuplicateGmailMessageId) throw e;

    const existing = await db
      .select({ id: importLogs.id })
      .from(importLogs)
      .where(eq(importLogs.gmailMessageId, values.gmailMessageId))
      .get();
    if (existing) return existing.id;
    throw e;
  }
}

function isSqliteBusy(e: any): boolean {
  const code = String(e?.code ?? "");
  const msg  = String(e?.message ?? "");
  return code.includes("SQLITE_BUSY") || msg.includes("SQLITE_BUSY");
}

export async function withImportLogRetry(
  doInsert: () => Promise<number | null>,
  retryDelays: number[] = [100, 250, 500],
): Promise<{ logId: number | null; logWarning?: string }> {
  let lastError: any = null;

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, retryDelays[attempt - 1]));
    try {
      const logId = await doInsert();
      return { logId };
    } catch (e: any) {
      lastError = e;
      if (!isSqliteBusy(e)) break; // errores no-BUSY no se reintentan
    }
  }

  // Log interno sin exponer SQL, credenciales ni stack trace
  const safeCode = String(lastError?.code ?? String(lastError?.message ?? "").split("\n")[0]).substring(0, 120);
  console.error("[importLog] No se pudo registrar el log de importación:", safeCode);

  return {
    logId: null,
    logWarning: "La importación se completó, pero no pudo registrarse el archivo como procesado.",
  };
}

// ── POST /import/el-norte/preview ─────────────────────────────────────────────
app.post("/import/el-norte/preview", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const content: string = body.content || "";
  if (!content) return c.json({ error: "Sin contenido" }, 400);
  const result = parseElNorteTxtV2(content);
  return c.json(result, 200);
}));

// ── POST /import/el-norte/confirm ─────────────────────────────────────────────
app.post("/import/el-norte/confirm", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const rawPolicies: any[] = body.policies || [];
  if (!rawPolicies.length) return c.json({ error: "Sin pólizas" }, 400);

  // Pre-check: si este gmailMessageId ya fue procesado, omitir completamente
  if (body.gmailMessageId) {
    const alreadyLogged = await db.select({ id: importLogs.id })
      .from(importLogs)
      .where(eq(importLogs.gmailMessageId, body.gmailMessageId))
      .get();
    if (alreadyLogged) {
      return c.json({
        imported: 0, rebillings: 0, endosos: 0, anulaciones: 0,
        duplicados: 0, revisar: 0, skipped: 0, installmentsCreated: 0,
        errors: [], gmailAlreadyProcessed: true, logId: alreadyLogged.id,
      }, 200);
    }
  }

  // Deduplicar movimientos repetidos dentro del mismo array antes de tocar la DB
  const { deduped: parsedPolicies, inBatchDuplicates } = enDeduplicateBatch(rawPolicies);

  const companyId = await enGetOrCreateCompany();
  const counts: ImportCounts = {
    imported: 0, rebillings: 0, endosos: 0, anulaciones: 0,
    duplicados: inBatchDuplicates, revisar: 0, skipped: 0, installmentsCreated: 0, errors: [],
  };

  for (const p of parsedPolicies) {
    try {
      await enImportOne(p, companyId, user.id, counts);
    } catch (e: any) {
      counts.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      counts.skipped++;
    }
  }

  const logStatus = counts.errors.length === 0 ? "ok" : counts.imported + counts.rebillings > 0 ? "partial" : "error";
  const { logId, logWarning } = await withImportLogRetry(() => enInsertImportLog({
    source: "manual",
    filename: body.filename || null,
    gmailMessageId: body.gmailMessageId || null,
    fechaArchivo: body.fechaArchivo || null,
    status: logStatus,
    registrosImportados: counts.imported,
    rebillings: counts.rebillings,
    endosos: counts.endosos,
    anulaciones: counts.anulaciones,
    duplicados: counts.duplicados,
    revisar: counts.revisar,
    skipped: counts.skipped,
    errors: JSON.stringify(counts.errors),
    createdBy: user.id,
  }));

  return c.json({ ...counts, logId, ...(logWarning ? { logWarning } : {}) }, 200);
}));

// ── POST /gmail/el-norte/latest ───────────────────────────────────────────────
app.post("/gmail/el-norte/latest", requireAuth(async (c: any) => {
  if (!gmailConfigured) return c.json({ error: "Gmail no configurado" }, 503);
  try {
    const msgs = await gmailSearch(
      'from:gestorweb@elnorte.com.ar subject:"Archivo de Emision"', 1
    );
    if (!msgs.length) return c.json({ error: "No se encontraron mails de El Norte" }, 404);
    const msg = msgs[0];
    const att = findTxtAttachment(msg);
    if (!att) return c.json({ error: "El mail no tiene adjunto TXT" }, 404);
    const content = await gmailDownloadAttachment(msg.id, att.attachmentId);
    const parsed = parseElNorteTxtV2(content);
    const subject = msg.payload?.headers?.find((h: any) => h.name === "Subject")?.value || "";
    const date = msg.payload?.headers?.find((h: any) => h.name === "Date")?.value || "";
    return c.json({ messageId: msg.id, subject, date, filename: att.filename, ...parsed }, 200);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
}));

// ── GET /gmail/el-norte/job/:jobId ────────────────────────────────────────────
app.get("/gmail/el-norte/job/:jobId", requireAuth(async (c: any) => {
  const job = elNorteJobs.get(c.req.param("jobId"));
  if (!job) return c.json({ error: "Job no encontrado" }, 404);
  return c.json(job, 200);
}));

// ── GET /import/el-norte/logs ─────────────────────────────────────────────────
app.get("/import/el-norte/logs", requireAuth(async (c: any) => {
  const logs = await db.select().from(importLogs).orderBy(desc(importLogs.importedAt)).all();
  return c.json(logs, 200);
}));

// ── POST /gmail/el-norte/batch-preview ───────────────────────────────────────
app.post("/gmail/el-norte/batch-preview", requireAuth(async (c: any) => {
  if (!gmailConfigured) return c.json({ error: "Gmail no configurado" }, 503);
  try {
    const body = await c.req.json();
    const desde: string = body.desde || "";
    const hasta: string = body.hasta || "";
    if (!desde) return c.json({ error: "Se requiere campo 'desde'" }, 400);
    const q = `from:gestorweb@elnorte.com.ar subject:"Archivo de Emision" after:${desde.replace(/-/g, "/")}${hasta ? ` before:${hasta.replace(/-/g, "/")}` : ""}`;
    const msgs = await gmailSearch(q, 200);
    msgs.sort((a: any, b: any) => parseInt(a.internalDate || "0") - parseInt(b.internalDate || "0"));

    const previews: any[] = [];
    for (const msg of msgs) {
      const att = findTxtAttachment(msg);
      if (!att) continue;
      try {
        const content = await gmailDownloadAttachment(msg.id, att.attachmentId);
        const parsed = parseElNorteTxtV2(content);
        const subject = msg.payload?.headers?.find((h: any) => h.name === "Subject")?.value || "";
        const date = msg.payload?.headers?.find((h: any) => h.name === "Date")?.value || "";
        previews.push({ messageId: msg.id, subject, date, filename: att.filename, ...parsed });
      } catch (e: any) {
        previews.push({ messageId: msg.id, error: e.message });
      }
    }
    return c.json({ total: previews.length, previews }, 200);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
}));

// ── POST /gmail/el-norte/batch-import ────────────────────────────────────────
app.post("/gmail/el-norte/batch-import", requireAuth(async (c: any) => {
  if (!gmailConfigured) return c.json({ error: "Gmail no configurado" }, 503);
  const user = c.get("user");
  const body = await c.req.json();
  const desde: string = body.desde || "";
  if (!desde) return c.json({ error: "Se requiere campo 'desde'" }, 400);
  const hasta: string = body.hasta || "";

  const jobId = `en_batch_${Date.now()}`;
  const job = {
    status: "running" as const, phase: "Iniciando...",
    totalMails: 0, processed: 0, imported: 0, rebillings: 0,
    endosos: 0, anulaciones: 0, duplicados: 0, revisar: 0, skipped: 0,
    gmailSkipped: 0, installmentsCreated: 0,
    errors: [] as string[], startedAt: Date.now(),
  };
  elNorteJobs.set(jobId, job);

  (async () => {
    try {
      const q = `from:gestorweb@elnorte.com.ar subject:"Archivo de Emision" after:${desde.replace(/-/g, "/")}${hasta ? ` before:${hasta.replace(/-/g, "/")}` : ""}`;
      job.phase = "Buscando mails en Gmail...";
      const msgs = await gmailSearch(q, 200);
      msgs.sort((a: any, b: any) => parseInt(a.internalDate || "0") - parseInt(b.internalDate || "0"));
      job.totalMails = msgs.length;
      if (!msgs.length) { (job as any).status = "error"; job.phase = "Sin mails en el período"; (job as any).finishedAt = Date.now(); return; }

      const companyId = await enGetOrCreateCompany();

      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        const subject = msg.payload?.headers?.find((h: any) => h.name === "Subject")?.value || "sin-asunto";
        job.phase = `Procesando ${i + 1}/${msgs.length}: ${subject.slice(0, 40)}`;
        const att = findTxtAttachment(msg);
        if (!att) { job.errors.push(`Mail "${subject}": sin adjunto TXT`); job.skipped++; continue; }

        // Pre-check gmailMessageId ANTES de descargar el adjunto
        const alreadyProcessed = await db.select({ id: importLogs.id })
          .from(importLogs)
          .where(eq(importLogs.gmailMessageId, msg.id))
          .get();
        if (alreadyProcessed) { job.gmailSkipped++; job.processed++; continue; }

        try {
          const content = await gmailDownloadAttachment(msg.id, att.attachmentId);
          const { policies: parsedRaw, errors: parseErrs } = parseElNorteTxtV2(content);
          if (parseErrs.length) parseErrs.forEach(e => job.errors.push(`[parse] ${e}`));
          const { deduped: parsed, inBatchDuplicates } = enDeduplicateBatch(parsedRaw);
          const counts: ImportCounts = { imported: 0, rebillings: 0, endosos: 0, anulaciones: 0, duplicados: inBatchDuplicates, revisar: 0, skipped: 0, installmentsCreated: 0, errors: [] };
          for (const p of parsed) {
            try { await enImportOne(p, companyId, user.id, counts); } catch (e: any) { counts.errors.push(`Póliza ${p.policyNumber}: ${e.message}`); counts.skipped++; }
          }
          job.imported += counts.imported;
          job.rebillings += counts.rebillings;
          job.endosos += counts.endosos;
          job.anulaciones += counts.anulaciones;
          job.duplicados += counts.duplicados;
          job.revisar += counts.revisar;
          job.skipped += counts.skipped;
          job.installmentsCreated += counts.installmentsCreated;
          if (counts.errors.length) counts.errors.forEach(e => job.errors.push(e));
          await enInsertImportLog({
            source: "gmail", filename: att.filename, gmailMessageId: msg.id,
            status: counts.errors.length === 0 ? "ok" : "partial",
            registrosImportados: counts.imported, rebillings: counts.rebillings,
            endosos: counts.endosos, anulaciones: counts.anulaciones,
            duplicados: counts.duplicados, revisar: counts.revisar, skipped: counts.skipped,
            errors: JSON.stringify(counts.errors), createdBy: user.id,
          });
          job.processed++;
        } catch (e: any) { job.errors.push(`Mail "${subject}": ${e.message}`); job.skipped++; }
      }
      (job as any).status = "done"; job.phase = "Completado"; (job as any).finishedAt = Date.now();
    } catch (e: any) {
      (job as any).status = "error"; job.phase = `Error: ${e.message}`; (job as any).finishedAt = Date.now();
    }
  })();

  return c.json({ jobId }, 200);
}));

// ── POST /gmail/el-norte/daily ────────────────────────────────────────────────
app.post("/gmail/el-norte/daily", requireAuth(async (c: any) => {
  if (!gmailConfigured) return c.json({ error: "Gmail no configurado" }, 503);
  const user = c.get("user");
  const hasta = toArgentinaCalendarDay();
  const desde = addCalendarDays(hasta, -1);

  const jobId = `en_daily_${Date.now()}`;
  const job = {
    status: "running" as const, phase: "Iniciando...",
    totalMails: 0, processed: 0, imported: 0, rebillings: 0,
    endosos: 0, anulaciones: 0, duplicados: 0, revisar: 0, skipped: 0,
    gmailSkipped: 0, installmentsCreated: 0,
    errors: [] as string[], startedAt: Date.now(),
  };
  elNorteJobs.set(jobId, job);

  (async () => {
    try {
      const q = `from:gestorweb@elnorte.com.ar subject:"Archivo de Emision" after:${desde.replace(/-/g, "/")} before:${hasta.replace(/-/g, "/")}`;
      job.phase = "Buscando mails del día anterior...";
      const msgs = await gmailSearch(q, 20);
      job.totalMails = msgs.length;
      if (!msgs.length) { (job as any).status = "done"; job.phase = "Sin mails nuevos"; (job as any).finishedAt = Date.now(); return; }

      const companyId = await enGetOrCreateCompany();

      for (const msg of msgs) {
        const subject = msg.payload?.headers?.find((h: any) => h.name === "Subject")?.value || "sin-asunto";
        const att = findTxtAttachment(msg);
        if (!att) { job.skipped++; continue; }

        // Pre-check gmailMessageId ANTES de descargar el adjunto
        const alreadyProcessed = await db.select({ id: importLogs.id })
          .from(importLogs)
          .where(eq(importLogs.gmailMessageId, msg.id))
          .get();
        if (alreadyProcessed) { job.gmailSkipped++; job.processed++; continue; }

        try {
          const content = await gmailDownloadAttachment(msg.id, att.attachmentId);
          const { policies: parsedRaw, errors: parseErrs } = parseElNorteTxtV2(content);
          if (parseErrs.length) parseErrs.forEach(e => job.errors.push(`[parse] ${e}`));
          const { deduped: parsed, inBatchDuplicates } = enDeduplicateBatch(parsedRaw);
          const counts: ImportCounts = { imported: 0, rebillings: 0, endosos: 0, anulaciones: 0, duplicados: inBatchDuplicates, revisar: 0, skipped: 0, installmentsCreated: 0, errors: [] };
          for (const p of parsed) {
            try { await enImportOne(p, companyId, user.id, counts); } catch (e: any) { counts.errors.push(`Póliza ${p.policyNumber}: ${e.message}`); counts.skipped++; }
          }
          job.imported += counts.imported;
          job.rebillings += counts.rebillings;
          job.endosos += counts.endosos;
          job.anulaciones += counts.anulaciones;
          job.duplicados += counts.duplicados;
          job.revisar += counts.revisar;
          job.skipped += counts.skipped;
          job.installmentsCreated += counts.installmentsCreated;
          if (counts.errors.length) counts.errors.forEach(e => job.errors.push(e));
          await enInsertImportLog({
            source: "gmail", filename: att.filename, gmailMessageId: msg.id,
            fechaArchivo: desde, status: counts.errors.length === 0 ? "ok" : "partial",
            registrosImportados: counts.imported, rebillings: counts.rebillings,
            endosos: counts.endosos, anulaciones: counts.anulaciones,
            duplicados: counts.duplicados, revisar: counts.revisar, skipped: counts.skipped,
            errors: JSON.stringify(counts.errors), createdBy: user.id,
          });
          job.processed++;
        } catch (e: any) { job.errors.push(`Mail "${subject}": ${e.message}`); job.skipped++; }
      }
      (job as any).status = "done"; job.phase = "Completado"; (job as any).finishedAt = Date.now();
    } catch (e: any) {
      (job as any).status = "error"; job.phase = `Error: ${e.message}`; (job as any).finishedAt = Date.now();
    }
  })();

  return c.json({ jobId, desde, hasta }, 200);
}));

// ── Cron diario El Norte — DESACTIVADO
// El procesamiento diario queda disponible solo como disparo manual:
// POST /gmail/el-norte/daily

// ── /admin/audit/coop-orphans ─────────────────────────────────────────────────
app.get("/admin/audit/coop-orphans", requireAuth(async (c: any) => {
  const coop = await db.select().from(companies).where(eq(companies.name, "Cooperación")).get();
  if (!coop) return c.json({ error: "Compañía Cooperación no encontrada" }, 404);

  const orphans = await db.select().from(policies)
    .where(and(
      eq(policies.companyId, coop.id),
      eq(policies.type, "accidentes_pasajeros"),
      isNull(policies.parentPolicyId),
      ne(policies.status, "cancelada"),
    ))
    .all();

  const report = await Promise.all(orphans.map(async (orphan) => {
    const insured = await db.select().from(insureds).where(eq(insureds.id, orphan.insuredId)).get();

    let candidates: { id: number; policyNumber: string; startDate: string; endDate: string }[] = [];
    if (insured) {
      candidates = await db.select({
        id: policies.id,
        policyNumber: policies.policyNumber,
        startDate: policies.startDate,
        endDate: policies.endDate,
      }).from(policies)
        .where(and(
          eq(policies.insuredId, insured.id),
          eq(policies.companyId, coop.id),
          inArray(policies.type, ["automotor", "motovehiculo"]),
          lte(policies.startDate, orphan.endDate),
          gte(policies.endDate, orphan.startDate),
        ))
        .all();
    }

    const action =
      candidates.length === 1 ? "link" :
      candidates.length  > 1  ? "ambiguous" :
                                 "no_parent";

    return {
      policyId:     orphan.id,
      policyNumber: orphan.policyNumber,
      insuredName:  insured?.name ?? "(sin asegurado)",
      insuredDni:   insured?.dni  ?? null,
      startDate:    orphan.startDate,
      endDate:      orphan.endDate,
      status:       orphan.status,
      candidates,
      action,
    };
  }));

  return c.json({
    total:     report.length,
    link:      report.filter(r => r.action === "link").length,
    ambiguous: report.filter(r => r.action === "ambiguous").length,
    no_parent: report.filter(r => r.action === "no_parent").length,
    policies:  report,
  }, 200);
}));

// ── /admin/preview/coop-orphans ──────────────────────────────────────────────
app.get("/admin/preview/coop-orphans", requireAuth(async (c: any) => {
  const coop = await db.select().from(companies)
    .where(eq(companies.name, "Cooperación")).get();
  if (!coop) return c.json({ error: "Compañía Cooperación no encontrada" }, 404);

  const orphans = await db.select().from(policies)
    .where(and(
      eq(policies.companyId, coop.id),
      eq(policies.type, "accidentes_pasajeros"),
      isNull(policies.parentPolicyId),
      ne(policies.status, "cancelada"),
    ))
    .all();

  const detail = await Promise.all(orphans.map(async (orphan) => {
    const candidates = await db.select({
      id:           policies.id,
      policyNumber: policies.policyNumber,
    }).from(policies)
      .where(and(
        eq(policies.insuredId, orphan.insuredId),
        eq(policies.companyId, coop.id),
        inArray(policies.type, ["automotor", "motovehiculo"]),
        lte(policies.startDate, orphan.endDate),
        gte(policies.endDate, orphan.startDate),
      ))
      .all();

    return {
      id:                 orphan.id,
      policyNumber:       orphan.policyNumber,
      insuredId:          orphan.insuredId,
      startDate:          orphan.startDate,
      endDate:            orphan.endDate,
      cantidadCandidatos: candidates.length,
      candidatos:         candidates,
    };
  }));

  return c.json({
    total:          detail.length,
    conUnCandidato: detail.filter(d => d.cantidadCandidatos === 1).length,
    sinCandidatos:  detail.filter(d => d.cantidadCandidatos === 0).length,
    ambiguos:       detail.filter(d => d.cantidadCandidatos  > 1).length,
    policies:       detail,
  }, 200);
}));

// ── /admin/fix/coop-orphans ───────────────────────────────────────────────────
// Vincula huérfanas con candidato único. Omite las de 0 y >1 candidatos.
// La guardia AND parentPolicyId IS NULL impide pisar datos ya corregidos.
app.post("/admin/fix/coop-orphans", requireAuth(async (c: any) => {
  const coop = await db.select().from(companies)
    .where(eq(companies.name, "Cooperación")).get();
  if (!coop) return c.json({ error: "Compañía Cooperación no encontrada" }, 404);

  const orphans = await db.select().from(policies)
    .where(and(
      eq(policies.companyId, coop.id),
      eq(policies.type, "accidentes_pasajeros"),
      isNull(policies.parentPolicyId),
      ne(policies.status, "cancelada"),
    ))
    .all();

  let fixed = 0, skipped = 0;
  const errors: string[] = [];

  for (const orphan of orphans) {
    // Paso 1: exact match por fechas
    const exact = await db.select({
      id:           policies.id,
      policyNumber: policies.policyNumber,
    }).from(policies)
      .where(and(
        eq(policies.insuredId, orphan.insuredId),
        eq(policies.companyId, coop.id),
        inArray(policies.type, ["automotor", "motovehiculo"]),
        eq(policies.startDate, orphan.startDate),
        eq(policies.endDate, orphan.endDate),
      ))
      .all();

    let chosen: { id: number; policyNumber: string } | null = null;

    if (exact.length === 1) {
      chosen = exact[0];
    } else if (exact.length === 0) {
      // Paso 2: fallback overlap
      const overlap = await db.select({
        id:           policies.id,
        policyNumber: policies.policyNumber,
      }).from(policies)
        .where(and(
          eq(policies.insuredId, orphan.insuredId),
          eq(policies.companyId, coop.id),
          inArray(policies.type, ["automotor", "motovehiculo"]),
          lte(policies.startDate, orphan.endDate),
          gte(policies.endDate, orphan.startDate),
        ))
        .all();

      if (overlap.length === 1) chosen = overlap[0];
    }

    if (!chosen) {
      errors.push(`Póliza ${orphan.policyNumber}: exact=${exact.length} — omitida`);
      skipped++;
      continue;
    }

    await db.update(policies)
      .set({ parentPolicyId: chosen.id })
      .where(and(
        eq(policies.id, orphan.id),
        isNull(policies.parentPolicyId),
      ));
    fixed++;
  }

  return c.json({ fixed, skipped, errors }, 200);
}));

// ─────────────────────────────────────────────────────────────────────────────

// ── POST /import/ssn-gde ──────────────────────────────────────────────────────
// SSN-GDE CSV (formato Rivadavia vía plataforma SSN).
// El parsing viene hecho desde el frontend (parseSsnGdeCsv en importar.tsx).
app.post("/import/ssn-gde", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsedPolicies: any[] = body.policies || [];
  if (!parsedPolicies.length) return c.json({ error: "Sin pólizas" }, 400);

  const counts = {
    imported: 0, rebillings: 0, anulaciones: 0, rehabilitadas: 0,
    duplicados: 0, revisar: 0, skipped: 0, errors: [] as string[],
  };

  // Reusar la compañía Rivadavia existente (misma que el importador TXT)
  let companyId: number;
  const existingCo = await db.select().from(companies).where(eq(companies.name, "Rivadavia")).get();
  if (existingCo) {
    companyId = existingCo.id;
  } else {
    const [nc] = await db.insert(companies).values({ name: "Rivadavia" }).returning({ id: companies.id });
    companyId = nc!.id;
  }

  async function ssnResolveInsured(p: any): Promise<number> {
    let existing = null;
    if (p.insuredDni) existing = await db.select().from(insureds).where(eq(insureds.dni, String(p.insuredDni))).get();
    if (!existing) existing = await db.select().from(insureds).where(eq(insureds.name, p.insuredName)).get();
    if (existing) return existing.id;
    const [ni] = await db.insert(insureds).values({
      name: p.insuredName, dni: p.insuredDni ? String(p.insuredDni) : null,
      email: null, phone: null, address: p.insuredAddress || null, createdBy: user.id,
    }).returning({ id: insureds.id });
    return ni!.id;
  }

  function ssnResolveTypeAndStatus(p: any): { polType: string; status: string } {
    const vt = (p.vehicleType || "").toLowerCase();
    let polType: string;
    if      (vt === "motovehiculo")      polType = "motovehiculo";
    else if (vt === "hogar")             polType = "hogar";
    else if (vt === "riesgos_varios")    polType = "riesgos_varios";
    else if (vt === "integral_comercio") polType = "integral_comercio";
    else                                 polType = "automotor";
    const today = toArgentinaCalendarDay();
    const daysToEnd = Math.ceil((new Date(p.endDate as string).getTime() - new Date(today).getTime()) / 86400000);
    let status = "activa";
    if (daysToEnd < 0) status = "vencida";
    else if (daysToEnd <= 30) status = "por_vencer";
    return { polType, status };
  }

  async function ssnInsertPolicy(p: any, noteStr: string): Promise<void> {
    const insuredId = await ssnResolveInsured(p);
    const { polType, status } = ssnResolveTypeAndStatus(p);
    const isMoto = polType === "motovehiculo";
    await db.insert(policies).values({
      policyNumber: String(p.policyNumber), type: polType, status, companyId, insuredId,
      premium: null, sumInsured: p.sumInsured || null,
      coverageType: p.coverageLabel || null,
      startDate: p.startDate, endDate: p.endDate,
      isRebilling: 0,
      vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
      vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
      vehicleYear:  !isMoto ? (p.vehicleYear  || null) : null,
      vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
      motoBrand: isMoto ? (p.vehicleBrand || null) : null,
      motoModel: isMoto ? (p.vehicleModel || null) : null,
      motoYear:  isMoto ? (p.vehicleYear  || null) : null,
      motoPlate: isMoto ? (p.vehiclePlate || null) : null,
      notes: noteStr,
      createdBy: user.id,
    });
  }

  // Pasada 1: crear/encontrar pólizas base (ALTA, RENOVACION, REFACTURACION)
  const creatables = parsedPolicies.filter(
    p => ["ALTA", "RENOVACION", "REFACTURACION"].includes((p.movType || "").toUpperCase())
  );
  for (const p of creatables) {
    try {
      const mov = (p.movType || "").toUpperCase();
      const polNum = String(p.policyNumber);
      const mes = p._ssnMes || body.fechaArchivo || "";
      const orden = p._ssnOrden ?? 0;

      // ── ALTA / RENOVACION ──────────────────────────────────────────────────
      if (mov === "ALTA" || mov === "RENOVACION") {
        const exists = await db.select({ id: policies.id })
          .from(policies).where(eq(policies.policyNumber, polNum)).get();
        if (exists) { counts.duplicados++; continue; }
        await ssnInsertPolicy(p, `Importado SSN-GDE ${mes}. Mov: ${mov}`);
        counts.imported++;
        continue;
      }

      // ── REFACTURACION ──────────────────────────────────────────────────────
      if (mov === "REFACTURACION") {
        const existing = await db.select().from(policies).where(eq(policies.policyNumber, polNum)).get();
        if (!existing) {
          // Base no encontrada: crear como póliza nueva con nota
          await ssnInsertPolicy(p, `Importado SSN-GDE ${mes}. REFACTURACION Orden ${orden} (base no encontrada)`);
          counts.imported++;
          continue;
        }
        // Período idéntico al de la póliza base → es la vigencia original, no un rebilling
        if (existing.startDate === p.startDate && existing.endDate === p.endDate) {
          counts.duplicados++;
          continue;
        }
        // Dedup: no insertar rebilling si ya existe el mismo período
        const dupRebilling = await db.select({ id: rebillings.id })
          .from(rebillings)
          .where(and(
            eq(rebillings.policyId, existing.id),
            eq(rebillings.billingStart, p.startDate),
            eq(rebillings.billingEnd, p.endDate),
          )).get();
        if (dupRebilling) { counts.duplicados++; continue; }
        await db.insert(rebillings).values({
          policyId: existing.id,
          billingStart: p.startDate, billingEnd: p.endDate,
          premium: null, sumInsured: p.sumInsured || null,
          notes: `SSN-GDE ${mes}. Orden ${orden}`,
          createdBy: user.id,
        });
        const { status } = ssnResolveTypeAndStatus(p);
        await db.update(policies)
          .set({ endDate: p.endDate, status })
          .where(eq(policies.id, existing.id));
        counts.rebillings++;
      }

    } catch (e: any) {
      counts.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      counts.skipped++;
    }
  }

  // Pasada 2: actuar sobre pólizas ya creadas/encontradas (ANULACION, REHABILITACION)
  const actables = parsedPolicies.filter(
    p => ["ANULACION", "REHABILITACION"].includes((p.movType || "").toUpperCase())
  );
  for (const p of actables) {
    try {
      const mov = (p.movType || "").toUpperCase();
      const polNum = String(p.policyNumber);
      const mes = p._ssnMes || body.fechaArchivo || "";
      const suplemento = p._ssnSuplemento ?? 0;

      // ── ANULACION ──────────────────────────────────────────────────────────
      if (mov === "ANULACION") {
        const existing = await db.select().from(policies).where(eq(policies.policyNumber, polNum)).get();
        if (!existing) { counts.skipped++; continue; }
        await db.update(policies).set({
          status: "cancelada",
          notes: (existing.notes ? existing.notes + " | " : "") +
            `Anulada SSN-GDE ${mes}. Supl: ${suplemento}`,
        }).where(eq(policies.id, existing.id));
        counts.anulaciones++;
        continue;
      }

      // ── REHABILITACION ─────────────────────────────────────────────────────
      if (mov === "REHABILITACION") {
        const existing = await db.select().from(policies).where(eq(policies.policyNumber, polNum)).get();
        if (!existing) {
          counts.revisar++;
          counts.errors.push(`REHABILITACION: póliza ${polNum} no encontrada`);
          continue;
        }
        const { status } = ssnResolveTypeAndStatus(p);
        await db.update(policies).set({
          status, endDate: p.endDate,
          notes: (existing.notes ? existing.notes + " | " : "") +
            `Rehabilitada SSN-GDE ${mes}. Supl: ${suplemento}`,
        }).where(eq(policies.id, existing.id));
        counts.rehabilitadas++;
        continue;
      }

      // Movimiento no reconocido en pasada 2
      counts.errors.push(`Póliza ${polNum}: movType desconocido "${p.movType}"`);
      counts.skipped++;

    } catch (e: any) {
      counts.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      counts.skipped++;
    }
  }

  const logStatus = counts.errors.length === 0 ? "ok"
    : counts.imported + counts.rebillings > 0 ? "partial" : "error";

  let logId: number | null = null;
  let logWarning: string | undefined;
  try {
    logId = await enInsertImportLog({
      source: "manual",
      filename: body.filename || null,
      gmailMessageId: null,
      fechaArchivo: body.fechaArchivo || null,
      status: logStatus,
      registrosImportados: counts.imported,
      rebillings: counts.rebillings,
      endosos: 0,
      anulaciones: counts.anulaciones,
      duplicados: counts.duplicados,
      revisar: counts.revisar + counts.rehabilitadas,
      skipped: counts.skipped,
      errors: JSON.stringify(counts.errors),
      createdBy: user.id,
    });
  } catch {
    logWarning = "Import registrado pero log no pudo guardarse";
  }

  return c.json({ ...counts, logId, ...(logWarning ? { logWarning } : {}) }, 200);
}));

// ─── REPORTES ─────────────────────────────────────────────────────────────────

const REPORT_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const REPORT_VALID_TYPES = new Set([
  "automotor","motovehiculo","hogar","accidentes_pasajeros","riesgos_varios",
  "integral_comercio","accidentes","art","ecomovilidad","comercial",
  "responsabilidad_civil","cascos","incendio",
]);
const REPORT_VALID_MOVEMENT_TYPES = new Set([
  "rebilling","renovation_confirmed","renovation_imported","new_policy","pending_installment",
]);
const REPORT_VALID_REBILLING_TYPES = new Set([
  "prorroga","endoso","extension_vigencia","renovacion","rehabilitacion","otro",
]);

function reportRebillingType(notes: string | null): string {
  const n = (notes ?? "").toLowerCase();
  if (n.includes("endoso")) return "endoso";
  if (n.includes("extensión de vigencia") || n.includes("extension de vigencia")) return "extension_vigencia";
  if (n.includes("prórroga") || n.includes("prorroga")) return "prorroga";
  if (n.includes("importado de rivadavia")) return "prorroga";
  if (n.includes("ssn-gde")) return "prorroga";
  return "otro";
}

function reportSourceImporter(notes: string | null): string {
  const n = (notes ?? "").toLowerCase();
  if (n.includes("el norte v2")) return "el_norte_v2";
  if (n.includes("ssn-gde")) return "rivadavia_ssn_gde";
  if (n.includes("rivadavia")) return "rivadavia";
  if (n.includes("el norte")) return "el_norte_v1";
  if (n.includes("mercantil andina")) return "mercantil_andina";
  return "manual";
}

function reportClassificationReason(notes: string | null, importer: string): string {
  const n = (notes ?? "").toLowerCase();
  if (n.includes("refacturacion") && (n.includes("sin base") || n.includes("base no encontrada"))) {
    return "refacturacion_sin_base";
  }
  if (importer === "mercantil_andina") return "sin_antecedente_de_poliza";
  return "alta_directa";
}

function reportIsRenovationImported(notes: string | null): boolean {
  const n = (notes ?? "").toLowerCase();
  return n.includes("movimiento: renovacion") || n.includes("mov: renovacion");
}

// Bien asegurado: mismo detalle descriptivo que polizas.tsx/poliza-detail.tsx usan por tipo.
// No sustituye por el ramo — si el tipo no tiene campos propios, devuelve null (el frontend muestra "—").
interface ReportAssetFields {
  type: string;
  isFleet: number | boolean | null;
  vehicleBrand: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  vehiclePlate: string | null;
  motoBrand: string | null;
  motoModel: string | null;
  motoYear: number | null;
  motoPlate: string | null;
  propertyAddress: string | null;
  businessName: string | null;
  businessActivity: string | null;
}

function reportInsuredAsset(row: ReportAssetFields, policyId: number, fleetCounts: Map<number, number>): string | null {
  if (row.type === "automotor") {
    if (row.isFleet) {
      const count = fleetCounts.get(policyId) ?? 0;
      return count > 0 ? `Flota: ${count} vehículo${count !== 1 ? "s" : ""}` : "Flota";
    }
    const desc = [row.vehicleBrand, row.vehicleModel, row.vehicleYear ? String(row.vehicleYear) : null]
      .filter(Boolean).join(" ");
    const plate = row.vehiclePlate ? `${desc ? " · " : ""}${row.vehiclePlate}` : "";
    return (desc + plate) || null;
  }
  if (row.type === "motovehiculo") {
    const desc = [row.motoBrand, row.motoModel, row.motoYear ? String(row.motoYear) : null]
      .filter(Boolean).join(" ");
    const plate = row.motoPlate ? `${desc ? " · " : ""}${row.motoPlate}` : "";
    return (desc + plate) || null;
  }
  if (row.type === "hogar") {
    return row.propertyAddress || null;
  }
  if (row.type === "comercial") {
    if (row.businessName && row.businessActivity) return `${row.businessName} (${row.businessActivity})`;
    return row.businessName || row.businessActivity || null;
  }
  return null;
}

app.get("/reports/renewals-rebillings", requireAuth(async (c: any) => {
  const {
    month,
    companyId: companyIdStr,
    type,
    movementType,
    rebillingType,
    q,
    sortBy,
    sortOrder,
  } = c.req.query();

  if (!month || !REPORT_MONTH_RE.test(month)) {
    return c.json({ error: "Parámetro month requerido (formato YYYY-MM)" }, 400);
  }

  const companyId =
    companyIdStr && /^\d+$/.test(companyIdStr) && Number(companyIdStr) > 0
      ? Number(companyIdStr)
      : null;
  const validType = REPORT_VALID_TYPES.has(type) ? type : null;
  const validMovementType = REPORT_VALID_MOVEMENT_TYPES.has(movementType) ? movementType : null;
  const validRebillingType = REPORT_VALID_REBILLING_TYPES.has(rebillingType) ? rebillingType : null;
  const validSortOrder: "asc" | "desc" = sortOrder === "desc" ? "desc" : "asc";
  const qLower = q ? String(q).toLowerCase() : null;

  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const mon = Number(monthStr);
  const startDate = `${month}-01`;
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  const endDateExclusive = `${nextYear}-${String(nextMon).padStart(2, "0")}-01`;

  // ── 1. Rebillings — dedup by (policyId, billingStart, billingEnd, premiumCents) ──
  const rebConditions: any[] = [
    gte(rebillings.billingStart, startDate),
    lt(rebillings.billingStart, endDateExclusive),
  ];
  if (companyId) rebConditions.push(eq(policies.companyId, companyId));
  if (validType) rebConditions.push(eq(policies.type, validType));

  const rebRaw = await db
    .select({
      rebillingId: sql<number>`MIN(${rebillings.id})`,
      policyId: rebillings.policyId,
      billingStart: rebillings.billingStart,
      billingEnd: rebillings.billingEnd,
      premium: rebillings.premium,
      monthlyFee: rebillings.monthlyFee,
      notes: rebillings.notes,
      duplicateCount: sql<number>`COUNT(*)`,
      policyNumber: policies.policyNumber,
      policyOriginalStart: policies.startDate,
      billingCycle: policies.billingCycle,
      policyType: policies.type,
      policyCompanyId: policies.companyId,
      insuredName: insureds.name,
      companyName: companies.name,
      isFleet: policies.isFleet,
      vehicleBrand: policies.vehicleBrand,
      vehicleModel: policies.vehicleModel,
      vehicleYear: policies.vehicleYear,
      vehiclePlate: policies.vehiclePlate,
      motoBrand: policies.motoBrand,
      motoModel: policies.motoModel,
      motoYear: policies.motoYear,
      motoPlate: policies.motoPlate,
      propertyAddress: policies.propertyAddress,
      businessName: policies.businessName,
      businessActivity: policies.businessActivity,
    })
    .from(rebillings)
    .innerJoin(policies, eq(rebillings.policyId, policies.id))
    .innerJoin(insureds, eq(policies.insuredId, insureds.id))
    .innerJoin(companies, eq(policies.companyId, companies.id))
    .where(and(...rebConditions))
    .groupBy(
      rebillings.policyId,
      rebillings.billingStart,
      rebillings.billingEnd,
      sql`ROUND(COALESCE(${rebillings.premium}, 0) * 100)`,
    )
    .orderBy(asc(rebillings.billingStart), sql`MIN(${rebillings.id})`)
    .all();

  // ── 2. Policies starting in month ──
  const polConditions: any[] = [
    gte(policies.startDate, startDate),
    lt(policies.startDate, endDateExclusive),
  ];
  if (companyId) polConditions.push(eq(policies.companyId, companyId));
  if (validType) polConditions.push(eq(policies.type, validType));

  const polRaw = await db
    .select({
      policyId: policies.id,
      policyNumber: policies.policyNumber,
      type: policies.type,
      startDate: policies.startDate,
      endDate: policies.endDate,
      premium: policies.premium,
      monthlyFee: policies.monthlyFee,
      notes: policies.notes,
      renewedFromId: policies.renewedFromId,
      companyId: policies.companyId,
      insuredName: insureds.name,
      companyName: companies.name,
      isFleet: policies.isFleet,
      vehicleBrand: policies.vehicleBrand,
      vehicleModel: policies.vehicleModel,
      vehicleYear: policies.vehicleYear,
      vehiclePlate: policies.vehiclePlate,
      motoBrand: policies.motoBrand,
      motoModel: policies.motoModel,
      motoYear: policies.motoYear,
      motoPlate: policies.motoPlate,
      propertyAddress: policies.propertyAddress,
      businessName: policies.businessName,
      businessActivity: policies.businessActivity,
    })
    .from(policies)
    .innerJoin(insureds, eq(policies.insuredId, insureds.id))
    .innerJoin(companies, eq(policies.companyId, companies.id))
    .where(and(...polConditions))
    .orderBy(asc(policies.startDate))
    .all();

  // ── 3. Cuotas pendientes con vencimiento en el mes (proyección de cartera) ──
  // A diferencia de 1 y 2 (que muestran eventos YA registrados: refacturaciones
  // creadas, pólizas dadas de alta), esta sección proyecta hacia adelante por
  // policyInstallments.dueDate — por eso puede mostrar meses futuros aunque no
  // exista todavía ninguna rebilling ni póliza nueva cargada para ese mes.
  // No depende de payments/cash_entries (Caja es un concepto aparte, ver
  // GET /cash/summary): una cuota "pendiente"/"vencida" se muestra exista o no
  // un pago asociado.
  const instConditions: any[] = [
    gte(policyInstallments.dueDate, startDate),
    lt(policyInstallments.dueDate, endDateExclusive),
    inArray(policyInstallments.status, ["pendiente", "vencida"]),
    eq(policyInstallments.rendered, 0),
  ];
  if (companyId) instConditions.push(eq(policies.companyId, companyId));
  if (validType) instConditions.push(eq(policies.type, validType));

  const instRaw = await db
    .select({
      installmentId: policyInstallments.id,
      installmentNumber: policyInstallments.number,
      policyId: policies.id,
      policyNumber: policies.policyNumber,
      dueDate: policyInstallments.dueDate,
      amount: policyInstallments.amount,
      status: policyInstallments.status,
      type: policies.type,
      companyId: policies.companyId,
      insuredName: insureds.name,
      companyName: companies.name,
      isFleet: policies.isFleet,
      vehicleBrand: policies.vehicleBrand,
      vehicleModel: policies.vehicleModel,
      vehicleYear: policies.vehicleYear,
      vehiclePlate: policies.vehiclePlate,
      motoBrand: policies.motoBrand,
      motoModel: policies.motoModel,
      motoYear: policies.motoYear,
      motoPlate: policies.motoPlate,
      propertyAddress: policies.propertyAddress,
      businessName: policies.businessName,
      businessActivity: policies.businessActivity,
    })
    .from(policyInstallments)
    .innerJoin(policies, eq(policyInstallments.policyId, policies.id))
    .innerJoin(insureds, eq(policies.insuredId, insureds.id))
    .innerJoin(companies, eq(policies.companyId, companies.id))
    .where(and(...instConditions))
    .orderBy(asc(policyInstallments.dueDate))
    .all();

  // ── Bien asegurado: conteo de flota en un solo query batched (sin N+1) ──
  const fleetPolicyIds = [
    ...rebRaw.filter((r) => r.isFleet).map((r) => Number(r.policyId)),
    ...polRaw.filter((r) => r.isFleet).map((r) => Number(r.policyId)),
    ...instRaw.filter((r) => r.isFleet).map((r) => Number(r.policyId)),
  ];
  const fleetCounts = new Map<number, number>();
  if (fleetPolicyIds.length > 0) {
    const fleetRows = await db
      .select({ policyId: policyFleetVehicles.policyId, count: sql<number>`COUNT(*)` })
      .from(policyFleetVehicles)
      .where(inArray(policyFleetVehicles.policyId, fleetPolicyIds))
      .groupBy(policyFleetVehicles.policyId)
      .all();
    for (const fr of fleetRows) fleetCounts.set(Number(fr.policyId), Number(fr.count));
  }

  let rebillingRows = rebRaw.map((r) => ({
    rebillingId: Number(r.rebillingId),
    policyId: Number(r.policyId),
    policyNumber: String(r.policyNumber),
    insuredName: String(r.insuredName),
    companyName: String(r.companyName),
    type: String(r.policyType),
    billingStart: String(r.billingStart),
    billingEnd: String(r.billingEnd),
    premium: r.premium != null ? Number(r.premium) : null,
    monthlyFee: r.monthlyFee != null ? Number(r.monthlyFee) : null,
    policyOriginalStart: String(r.policyOriginalStart),
    billingCycle: r.billingCycle ? String(r.billingCycle) : null,
    rebillingType: reportRebillingType(r.notes as string | null),
    duplicateCount: Number(r.duplicateCount),
    extraDuplicateRows: Number(r.duplicateCount) - 1,
    insuredAsset: reportInsuredAsset(
      { ...r, type: String(r.policyType) } as ReportAssetFields,
      Number(r.policyId),
      fleetCounts,
    ),
  }));

  let pendingInstallmentRows = instRaw.map((r) => ({
    installmentId: Number(r.installmentId),
    installmentNumber: Number(r.installmentNumber),
    policyId: Number(r.policyId),
    policyNumber: String(r.policyNumber),
    insuredName: String(r.insuredName),
    companyName: String(r.companyName),
    type: String(r.type),
    dueDate: String(r.dueDate),
    amount: Number(r.amount),
    status: String(r.status),
    insuredAsset: reportInsuredAsset(
      { ...r, type: String(r.type) } as ReportAssetFields,
      Number(r.policyId),
      fleetCounts,
    ),
  }));

  // Lookup old policies for renewedFromId
  const renewedFromIds = polRaw
    .filter((r) => r.renewedFromId != null)
    .map((r) => r.renewedFromId as number);
  const oldPoliciesMap = new Map<number, { policyNumber: string; endDate: string }>();
  if (renewedFromIds.length > 0) {
    const oldPols = await db
      .select({ id: policies.id, policyNumber: policies.policyNumber, endDate: policies.endDate })
      .from(policies)
      .where(inArray(policies.id, renewedFromIds))
      .all();
    for (const op of oldPols) {
      oldPoliciesMap.set(op.id, { policyNumber: op.policyNumber, endDate: op.endDate });
    }
  }

  // Classify policies into sections
  const renovationsConfirmed: any[] = [];
  const renovationsImported: any[] = [];
  const newPolicies: any[] = [];

  for (const p of polRaw) {
    const notes = p.notes as string | null;
    const renewedFromId = p.renewedFromId as number | null;
    if (renewedFromId != null) {
      const old = oldPoliciesMap.get(renewedFromId);
      renovationsConfirmed.push({
        policyId: p.policyId,
        policyNumber: p.policyNumber,
        insuredName: p.insuredName,
        companyName: p.companyName,
        type: p.type,
        startDate: p.startDate,
        endDate: p.endDate,
        premium: p.premium != null ? Number(p.premium) : null,
        monthlyFee: p.monthlyFee != null ? Number(p.monthlyFee) : null,
        renewedFromPolicyNumber: old?.policyNumber ?? null,
        renewedFromEndDate: old?.endDate ?? null,
        insuredAsset: reportInsuredAsset(p as ReportAssetFields, Number(p.policyId), fleetCounts),
      });
    } else if (reportIsRenovationImported(notes)) {
      renovationsImported.push({
        policyId: p.policyId,
        policyNumber: p.policyNumber,
        insuredName: p.insuredName,
        companyName: p.companyName,
        type: p.type,
        startDate: p.startDate,
        endDate: p.endDate,
        premium: p.premium != null ? Number(p.premium) : null,
        monthlyFee: p.monthlyFee != null ? Number(p.monthlyFee) : null,
        sourceImporter: reportSourceImporter(notes),
        insuredAsset: reportInsuredAsset(p as ReportAssetFields, Number(p.policyId), fleetCounts),
      });
    } else {
      const importer = reportSourceImporter(notes);
      newPolicies.push({
        policyId: p.policyId,
        policyNumber: p.policyNumber,
        insuredName: p.insuredName,
        companyName: p.companyName,
        type: p.type,
        startDate: p.startDate,
        endDate: p.endDate,
        premium: p.premium != null ? Number(p.premium) : null,
        monthlyFee: p.monthlyFee != null ? Number(p.monthlyFee) : null,
        movementType: "new_policy" as const,
        sourceImporter: importer,
        classificationReason: reportClassificationReason(notes, importer),
        insuredAsset: reportInsuredAsset(p as ReportAssetFields, Number(p.policyId), fleetCounts),
      });
    }
  }

  // ── 3. Apply filters ──
  const matchesQ = (r: { policyNumber: string; insuredName: string }) =>
    !qLower ||
    r.policyNumber.toLowerCase().includes(qLower) ||
    r.insuredName.toLowerCase().includes(qLower);

  if (validRebillingType) {
    rebillingRows = rebillingRows.filter((r) => r.rebillingType === validRebillingType);
  }

  let filteredRebillings    = validMovementType && validMovementType !== "rebilling"            ? [] : rebillingRows.filter(matchesQ);
  let filteredConfirmed     = validMovementType && validMovementType !== "renovation_confirmed"  ? [] : renovationsConfirmed.filter(matchesQ);
  let filteredImported      = validMovementType && validMovementType !== "renovation_imported"   ? [] : renovationsImported.filter(matchesQ);
  let filteredNew           = validMovementType && validMovementType !== "new_policy"            ? [] : newPolicies.filter(matchesQ);
  let filteredPending       = validMovementType && validMovementType !== "pending_installment"    ? [] : pendingInstallmentRows.filter(matchesQ);

  // ── 4. Sort ──
  const VALID_SORT_KEYS_REBILLING   = new Set(["billingStart","billingEnd","policyNumber","insuredName","companyName","premium","type","rebillingType"]);
  const VALID_SORT_KEYS_POLICY      = new Set(["startDate","endDate","policyNumber","insuredName","companyName","premium","type"]);
  const VALID_SORT_KEYS_INSTALLMENT = new Set(["dueDate","policyNumber","insuredName","companyName","amount","status"]);

  function applySortRebilling(arr: typeof filteredRebillings): typeof filteredRebillings {
    if (!sortBy || !VALID_SORT_KEYS_REBILLING.has(sortBy)) return arr;
    return [...arr].sort((a, b) => {
      const va = (a as any)[sortBy] ?? "";
      const vb = (b as any)[sortBy] ?? "";
      const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb));
      return validSortOrder === "desc" ? -cmp : cmp;
    });
  }
  function applySortPolicy(arr: any[]): any[] {
    if (!sortBy || !VALID_SORT_KEYS_POLICY.has(sortBy)) return arr;
    return [...arr].sort((a, b) => {
      const va = a[sortBy] ?? "";
      const vb = b[sortBy] ?? "";
      const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb));
      return validSortOrder === "desc" ? -cmp : cmp;
    });
  }
  function applySortInstallment(arr: typeof filteredPending): typeof filteredPending {
    if (!sortBy || !VALID_SORT_KEYS_INSTALLMENT.has(sortBy)) return arr;
    return [...arr].sort((a, b) => {
      const va = (a as any)[sortBy] ?? "";
      const vb = (b as any)[sortBy] ?? "";
      const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb));
      return validSortOrder === "desc" ? -cmp : cmp;
    });
  }

  filteredRebillings = applySortRebilling(filteredRebillings);
  filteredConfirmed  = applySortPolicy(filteredConfirmed);
  filteredImported   = applySortPolicy(filteredImported);
  filteredNew        = applySortPolicy(filteredNew);
  filteredPending    = applySortInstallment(filteredPending);

  // ── 5. Totals ──
  const rebillingsDuplicateGroups = filteredRebillings.filter((r) => r.duplicateCount > 1).length;
  const rebillingsExtraRows       = filteredRebillings.reduce((s, r) => s + r.extraDuplicateRows, 0);
  const totalPremiumRebillings    = filteredRebillings.reduce((s, r) => s + (r.premium ?? 0), 0);
  const totalPremiumRenovations   =
    [...filteredConfirmed, ...filteredImported].reduce((s, r) => s + (r.premium ?? 0), 0);
  const pendingInstallmentsOverdueCount = filteredPending.filter((r) => r.status === "vencida").length;
  const totalPendingInstallmentsAmount  = filteredPending.reduce((s, r) => s + (r.amount ?? 0), 0);

  return c.json({
    month,
    rebillings:            filteredRebillings,
    renovationsConfirmed:  filteredConfirmed,
    renovationsImported:   filteredImported,
    newPolicies:           filteredNew,
    // Proyección de cartera — no se suma a totalMovements (concepto distinto:
    // cuotas por vencer, no eventos de póliza ya registrados).
    pendingInstallments:   filteredPending,
    totals: {
      rebillingsCount:           filteredRebillings.length,
      rebillingsDuplicateGroups,
      rebillingsExtraRows,
      totalPremiumRebillings:    Math.round(totalPremiumRebillings * 100) / 100,
      renovationsConfirmedCount: filteredConfirmed.length,
      renovationsImportedCount:  filteredImported.length,
      totalPremiumRenovations:   Math.round(totalPremiumRenovations * 100) / 100,
      newPoliciesCount:          filteredNew.length,
      totalMovements:
        filteredRebillings.length + filteredConfirmed.length +
        filteredImported.length + filteredNew.length,
      pendingInstallmentsCount:        filteredPending.length,
      pendingInstallmentsOverdueCount,
      totalPendingInstallmentsAmount:  Math.round(totalPendingInstallmentsAmount * 100) / 100,
    },
  }, 200);
}));

// ─── CAJA ─────────────────────────────────────────────────────────────────────

// Validadores compartidos por todos los handlers de Caja
const CAJA_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CAJA_DATE_RE  = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function cajaIsRealDate(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function requireAdmin(handler: any) {
  return requireAuth(async (c: any) => {
    const user = c.get ? c.get("user") : null;
    // get user from session
    const sessionId = c.req.header("x-session-id");
    if (!sessionId) return c.json({ error: "No autenticado" }, 401);
    const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) return c.json({ error: "Sesión inválida" }, 401);
    const usr = await db.select().from(users).where(eq(users.id, session.userId)).get();
    if (!usr || usr.role !== "admin") return c.json({ error: "No tenés permisos para acceder a Caja." }, 403);
    c.set("cajaUser", usr);
    return handler(c);
  });
}

// GET /api/cash/entries — listar cobros manuales
app.get("/cash/entries", requireAdmin(async (c: any) => {
  const entries = await db.select().from(cashEntries).orderBy(desc(cashEntries.createdAt)).all();
  return c.json(entries);
}));

// POST /api/cash/entries — crear cobro manual
app.post("/cash/entries", requireAdmin(async (c: any) => {
  const body = await c.req.json();
  const sessionId = c.req.header("x-session-id");
  const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  const result = await db.insert(cashEntries).values({
    clientName: body.clientName,
    policyNumber: body.policyNumber || null,
    companyName: body.companyName || null,
    amount: Number(body.amount),
    paymentMethod: body.paymentMethod,
    paymentDate: body.paymentDate,
    dueDate: body.dueDate || null,
    notes: body.notes || null,
    rendered: 0,
    createdBy: session?.userId || null,
    createdAt: new Date(),
  }).returning().get();
  return c.json(result, 201);
}));

// PUT /api/cash/entries/:id — editar cobro manual
app.put("/cash/entries/:id", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const result = await db.update(cashEntries).set({
    clientName: body.clientName,
    policyNumber: body.policyNumber || null,
    companyName: body.companyName || null,
    amount: Number(body.amount),
    paymentMethod: body.paymentMethod,
    paymentDate: body.paymentDate,
    dueDate: body.dueDate || null,
    notes: body.notes || null,
  }).where(eq(cashEntries.id, id)).returning().get();
  if (!result) return c.json({ error: "No encontrado" }, 404);
  return c.json(result);
}));

// DELETE /api/cash/entries/:id
app.delete("/cash/entries/:id", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  await db.delete(cashEntries).where(eq(cashEntries.id, id));
  return c.json({ ok: true });
}));

// PATCH /api/cash/entries/:id/render — marcar rendido / no rendido
app.patch("/cash/entries/:id/render", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const rendered = body.rendered ? 1 : 0;
  const result = await db.update(cashEntries).set({
    rendered,
    renderedAt: rendered ? new Date() : null,
  }).where(eq(cashEntries.id, id)).returning().get();
  if (!result) return c.json({ error: "No encontrado" }, 404);
  return c.json(result);
}));

// PATCH /api/cash/payments/:id/render — marcar rendido en payment de Cobranzas
app.patch("/cash/payments/:id/render", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const rendered = body.rendered ? 1 : 0;
  const result = await db.update(payments).set({
    rendered,
    renderedAt: rendered ? new Date() : null,
  }).where(eq(payments.id, id)).returning().get();
  if (!result) return c.json({ error: "No encontrado" }, 404);
  return c.json(result);
}));

// GET /api/cash/payments/transferencias — cobros por transferencia_compania con estado de rendición
app.get("/cash/payments/transferencias", requireAdmin(async (c: any) => {
  // Etapa 3B: incluye un payment si tiene AL MENOS un split transferencia_compania
  // (no solo si payments.paymentMethod === "transferencia_compania", que deja
  // afuera a un combinado direct_company, ej. transferencia_compania + link_pago).
  const splitRows = await db.select({
    paymentId: paymentSplits.paymentId, amountCents: paymentSplits.amountCents,
  }).from(paymentSplits).where(eq(paymentSplits.method, "transferencia_compania")).all();
  if (splitRows.length === 0) return c.json([]);

  const portionCentsByPaymentId = new Map<number, number>();
  for (const s of splitRows) {
    portionCentsByPaymentId.set(s.paymentId, (portionCentsByPaymentId.get(s.paymentId) ?? 0) + s.amountCents);
  }
  const paymentIds = [...portionCentsByPaymentId.keys()];

  const rows = await db
    .select({
      id: payments.id,
      policyId: payments.policyId,
      manualPayer: payments.manualPayer,
      manualPolicyNumber: payments.manualPolicyNumber,
      manualCompany: payments.manualCompany,
      amount: payments.amount,
      paymentMethod: payments.paymentMethod,
      paymentDate: payments.paymentDate,
      periodMonth: payments.periodMonth,
      notes: payments.notes,
      status: payments.status,
      rendered: payments.rendered,
      renderedAt: payments.renderedAt,
      insuredName: insureds.name,
      policyNumber: policies.policyNumber,
      companyName: companies.name,
    })
    .from(payments)
    .leftJoin(policies, eq(payments.policyId, policies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .where(inArray(payments.id, paymentIds))
    .orderBy(desc(payments.paymentDate))
    .all();

  // Ampliación aditiva: `amount` sigue siendo el total del payment
  // (compatibilidad con consumidores existentes, y coincide con la porción
  // en el caso de un solo split); `transferenciaCompaniaAmount` es la
  // porción real de ESTE método — nunca se presenta el total completo del
  // payment como si fuera todo transferencia_compania.
  return c.json(rows.map((r) => ({
    ...r,
    transferenciaCompaniaAmount: (portionCentsByPaymentId.get(r.id) ?? 0) / 100,
  })));
}));

// GET /api/cash/debts — listar adeudados
app.get("/cash/debts", requireAdmin(async (c: any) => {
  const debts = await db.select().from(cashDebts).orderBy(desc(cashDebts.createdAt)).all();
  return c.json(debts);
}));

// POST /api/cash/debts — crear adeudado
app.post("/cash/debts", requireAdmin(async (c: any) => {
  const body = await c.req.json();
  const sessionId = c.req.header("x-session-id");
  const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  const result = await db.insert(cashDebts).values({
    clientName: body.clientName,
    policyNumber: body.policyNumber || null,
    companyName: body.companyName || null,
    amount: Number(body.amount),
    dueDate: body.dueDate || null,
    notes: body.notes || null,
    status: "pendiente",
    createdBy: session?.userId || null,
    createdAt: new Date(),
  }).returning().get();
  return c.json(result, 201);
}));

// PUT /api/cash/debts/:id
app.put("/cash/debts/:id", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const result = await db.update(cashDebts).set({
    clientName: body.clientName,
    policyNumber: body.policyNumber || null,
    companyName: body.companyName || null,
    amount: Number(body.amount),
    dueDate: body.dueDate || null,
    notes: body.notes || null,
    status: body.status || "pendiente",
  }).where(eq(cashDebts.id, id)).returning().get();
  if (!result) return c.json({ error: "No encontrado" }, 404);
  return c.json(result);
}));

// DELETE /api/cash/debts/:id
app.delete("/cash/debts/:id", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  await db.delete(cashDebts).where(eq(cashDebts.id, id));
  return c.json({ ok: true });
}));

// PATCH /api/cash/debts/:id/status — marcar cobrado
app.patch("/cash/debts/:id/status", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const result = await db.update(cashDebts).set({
    status: body.status,
  }).where(eq(cashDebts.id, id)).returning().get();
  if (!result) return c.json({ error: "No encontrado" }, 404);
  return c.json(result);
}));

// ─── CAJA PROPIA: movimientos propios ────────────────────────────────────────

// GET /api/cash/own-movements
app.get("/cash/own-movements", requireAdmin(async (c: any) => {
  const rows = await db.select().from(ownMoneyMovements)
    .orderBy(desc(ownMoneyMovements.date)).all();
  return c.json(rows);
}));

// POST /api/cash/own-movements
app.post("/cash/own-movements", requireAdmin(async (c: any) => {
  const cajaUser = c.get("cajaUser");
  const body = await c.req.json();

  if (!body.date || !CAJA_DATE_RE.test(body.date) || !cajaIsRealDate(body.date))
    return c.json({ error: "Fecha inválida. Formato esperado: YYYY-MM-DD" }, 400);

  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0)
    return c.json({ error: "El monto debe ser mayor a cero" }, 400);

  const type = body.type;
  if (!["aporte", "reintegro"].includes(type))
    return c.json({ error: "type inválido. Valores: aporte | reintegro" }, 400);

  const paymentMethod = body.paymentMethod ?? "efectivo";
  if (!["efectivo", "transferencia"].includes(paymentMethod))
    return c.json({ error: "paymentMethod inválido. Valores: efectivo | transferencia" }, 400);

  const status = body.status ?? "registrado";
  if (!["registrado", "anulado"].includes(status))
    return c.json({ error: "status inválido. Valores: registrado | anulado" }, 400);

  if (type === "reintegro" && status === "registrado") {
    const activos = await db.select().from(ownMoneyMovements)
      .where(eq(ownMoneyMovements.status, "registrado")).all();
    const totalAportes    = activos.filter((m: any) => m.type === "aporte").reduce((s: number, m: any) => s + m.amount, 0);
    const totalReintegros = activos.filter((m: any) => m.type === "reintegro").reduce((s: number, m: any) => s + m.amount, 0);
    if (totalAportes < totalReintegros + amount)
      return c.json({ error: `Saldo insuficiente. Aportes: ${totalAportes.toFixed(2)}, ya reintegrado: ${totalReintegros.toFixed(2)}, disponible: ${(totalAportes - totalReintegros).toFixed(2)}` }, 400);
  }

  const result = await db.insert(ownMoneyMovements).values({
    type,
    date: body.date,
    amount,
    paymentMethod,
    status,
    notes: body.notes || null,
    createdBy: cajaUser?.id ?? null,
  }).returning().get();
  return c.json(result, 201);
}));

// PUT /api/cash/own-movements/:id
app.put("/cash/own-movements/:id", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();

  const existing = await db.select().from(ownMoneyMovements).where(eq(ownMoneyMovements.id, id)).get();
  if (!existing) return c.json({ error: "No encontrado" }, 404);
  if (existing.status === "anulado") return c.json({ error: "No se puede editar un movimiento anulado" }, 400);

  if (!body.date || !CAJA_DATE_RE.test(body.date) || !cajaIsRealDate(body.date))
    return c.json({ error: "Fecha inválida. Formato esperado: YYYY-MM-DD" }, 400);

  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0)
    return c.json({ error: "El monto debe ser mayor a cero" }, 400);

  const type = body.type ?? existing.type;
  if (!["aporte", "reintegro"].includes(type))
    return c.json({ error: "type inválido. Valores: aporte | reintegro" }, 400);

  const paymentMethod = body.paymentMethod ?? existing.paymentMethod ?? "efectivo";
  if (!["efectivo", "transferencia"].includes(paymentMethod))
    return c.json({ error: "paymentMethod inválido. Valores: efectivo | transferencia" }, 400);

  const status = body.status ?? existing.status ?? "registrado";
  if (!["registrado", "anulado"].includes(status))
    return c.json({ error: "status inválido. Valores: registrado | anulado" }, 400);

  if (type === "reintegro" && status === "registrado") {
    const activos = await db.select().from(ownMoneyMovements)
      .where(and(eq(ownMoneyMovements.status, "registrado"), ne(ownMoneyMovements.id, id))).all();
    const totalAportes    = activos.filter((m: any) => m.type === "aporte").reduce((s: number, m: any) => s + m.amount, 0);
    const totalReintegros = activos.filter((m: any) => m.type === "reintegro").reduce((s: number, m: any) => s + m.amount, 0);
    if (totalAportes < totalReintegros + amount)
      return c.json({ error: `Saldo insuficiente. Aportes: ${totalAportes.toFixed(2)}, ya reintegrado: ${totalReintegros.toFixed(2)}, disponible: ${(totalAportes - totalReintegros).toFixed(2)}` }, 400);
  }

  const result = await db.update(ownMoneyMovements).set({
    type,
    date: body.date,
    amount,
    paymentMethod,
    status,
    notes: body.notes !== undefined ? (body.notes || null) : existing.notes,
  }).where(eq(ownMoneyMovements.id, id)).returning().get();
  return c.json(result);
}));

// DELETE /api/cash/own-movements/:id — soft-delete
app.delete("/cash/own-movements/:id", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  const existing = await db.select().from(ownMoneyMovements).where(eq(ownMoneyMovements.id, id)).get();
  if (!existing) return c.json({ error: "No encontrado" }, 404);
  if (existing.status === "anulado") return c.json({ error: "El movimiento ya está anulado" }, 400);
  await db.update(ownMoneyMovements).set({ status: "anulado" }).where(eq(ownMoneyMovements.id, id));
  return c.json({ ok: true, anulado: true });
}));

// GET /api/cash/summary — resumen completo de caja
// Parámetros opcionales: ?month=YYYY-MM  |  ?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get("/cash/summary", requireAdmin(async (c: any) => {
  // ── Validación de parámetros de período ───────────────────────────────────
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const DATE_RE  = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

  // Devuelve true solo si la fecha existe en el calendario (ej. rechaza 2026-02-31)
  function isRealDate(s: string): boolean {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  const rawMonth = c.req.query("month");
  const rawFrom  = c.req.query("from");
  const rawTo    = c.req.query("to");

  let periodFrom: string | null = null;
  let periodTo:   string | null = null;

  if (rawMonth) {
    if (!MONTH_RE.test(rawMonth)) {
      return c.json({ error: "Parámetro 'month' inválido. Formato esperado: YYYY-MM (ej. 2025-06)" }, 400);
    }
    const [y, m] = rawMonth.split("-");
    const lastDay = new Date(Number(y), Number(m), 0).getDate();
    periodFrom = `${y}-${m}-01`;
    periodTo   = `${y}-${m}-${String(lastDay).padStart(2, "0")}`;
  } else if (rawFrom || rawTo) {
    if (!rawFrom || !rawTo) {
      return c.json({ error: "Se requieren ambos parámetros 'from' y 'to'" }, 400);
    }
    if (!DATE_RE.test(rawFrom) || !DATE_RE.test(rawTo)) {
      return c.json({ error: "Formato de fecha inválido. Esperado: YYYY-MM-DD (ej. 2025-06-01)" }, 400);
    }
    if (!isRealDate(rawFrom)) {
      return c.json({ error: `La fecha 'from' (${rawFrom}) no existe en el calendario` }, 400);
    }
    if (!isRealDate(rawTo)) {
      return c.json({ error: `La fecha 'to' (${rawTo}) no existe en el calendario` }, 400);
    }
    if (rawFrom > rawTo) {
      return c.json({ error: "'from' debe ser anterior o igual a 'to'" }, 400);
    }
    periodFrom = rawFrom;
    periodTo   = rawTo;
  }

  // ── Consultas principales ─────────────────────────────────────────────────
  // Cobros manuales en cartera (no rendidos)
  const manualInCartera = await db.select().from(cashEntries)
    .where(eq(cashEntries.rendered, 0)).all();

  // Cobros manuales rendidos
  const manualRendered = await db.select().from(cashEntries)
    .where(eq(cashEntries.rendered, 1)).all();

  // Payments de Cobranzas: todos confirmados (no anulados)
  const allPayments = await db.select().from(payments)
    .where(eq(payments.status, "confirmado")).all();

  const paymentsInCartera = allPayments.filter((p: any) => !p.rendered);
  const paymentsRendered = allPayments.filter((p: any) => p.rendered);

  // Etapa 3B: los buckets por método real (efectivo/transferencia/cheque/
  // transferencia_compania/link_pago) deben armarse sumando payment_splits,
  // nunca payments.paymentMethod — que puede valer "combinado" y no
  // representa ningún método real. También se usa para clasificar el grupo
  // (own/direct_company) de cada payment por sus splits reales, en vez de
  // comparar payments.paymentMethod contra la lista de métodos directos.
  const allPaymentIdsForSplits = allPayments.map((p: any) => p.id as number);
  const splitsByPaymentId = new Map<number, { method: string; amountCents: number }[]>();
  if (allPaymentIdsForSplits.length > 0) {
    const splitRowsForCash = await db.select({
      paymentId: paymentSplits.paymentId, method: paymentSplits.method, amountCents: paymentSplits.amountCents,
    }).from(paymentSplits).where(inArray(paymentSplits.paymentId, allPaymentIdsForSplits)).all();
    for (const s of splitRowsForCash) {
      const arr = splitsByPaymentId.get(s.paymentId) ?? [];
      arr.push({ method: s.method, amountCents: s.amountCents });
      splitsByPaymentId.set(s.paymentId, arr);
    }
  }
  const paymentGroupById = new Map<number, SplitGroup>();
  for (const [pid, splits] of splitsByPaymentId) {
    paymentGroupById.set(pid, classifySplitGroup(splits));
  }

  // Adeudados de rendiciones (cuotas rendidas pero asegurado aún no pagó).
  // Mismas columnas que consume buildAdeudadosDetalle (src/lib/payments/
  // caja-summary.ts) — una sola query, sin duplicar la lógica de totalAdeudado.
  const remittanceDebtItems = await db.select({
    id: remittanceItems.id,
    amount: remittanceItems.amount,
    paidAt: remittanceItems.paidAt,
    source: remittanceItems.source,
    sourceId: remittanceItems.sourceId,
    policyNumber: remittanceItems.policyNumber,
    debtorName: remittanceItems.clientName,
    companyName: remittanceItems.companyName,
    debtorStatus: remittanceItems.debtorStatus,
    remittanceDate: remittances.date,
  }).from(remittanceItems)
    .innerJoin(remittances, eq(remittanceItems.remittanceId, remittances.id))
    .where(eq(remittanceItems.debtorStatus, "adeudado"))
    .all();
  const unpaidDebtItems = remittanceDebtItems.filter((i: any) => !i.paidAt);

  // Rendiciones confirmadas — para calcular lo ya rendido por método
  const confirmedRemittances = await db.select().from(remittances)
    .where(eq(remittances.status, "confirmada")).all();

  // Adeudados clásicos (módulo antiguo — por compatibilidad)
  const debtsLegacy = await db.select().from(cashDebts)
    .where(eq(cashDebts.status, "pendiente")).all();

  // ── Adelantos/recuperos de cuotas reales rendidas como adeudadas ──────────
  // Fuente única: remittance_items con source='installment' de rendiciones
  // confirmadas. El ADELANTO (salida de Caja) es CUALQUIER ítem así, sin
  // importar su debtorStatus actual — es un hecho histórico fechado por
  // remittances.date que no se borra cuando la deuda se cobra después (regla
  // de negocio: el adelanto queda visible aunque se recupere). El RECUPERO
  // (ingreso) es el subconjunto ya cerrado (debtorStatus='pagado' con paidAt
  // seteado, ver POST /remittances/items/:id/collect) — su importe YA está
  // contado en totalCobrado/cobradoPeriodo a través del payment real que
  // collect crea (payments.status='confirmado' entra en allPayments/
  // periodPayments sin importar payments.rendered), así que acá es solo un
  // SUBTOTAL informativo: nunca se vuelve a sumar a cajaNeta/totalCobrado/
  // diferencia/cobradoPeriodo.
  const installmentDebtItems = await db.select({
    id: remittanceItems.id,
    amount: remittanceItems.amount,
    debtorStatus: remittanceItems.debtorStatus,
    paidAt: remittanceItems.paidAt,
    sourceId: remittanceItems.sourceId,
    remittanceDate: remittances.date,
  }).from(remittanceItems)
    .innerJoin(remittances, eq(remittanceItems.remittanceId, remittances.id))
    .where(and(eq(remittanceItems.source, "installment"), eq(remittances.status, "confirmada")))
    .all();

  const adelantosAdeudados = installmentDebtItems.reduce((s: number, i: any) => s + i.amount, 0);
  const recuperoItems = installmentDebtItems.filter((i: any) => i.debtorStatus === "pagado" && i.paidAt != null);
  const recuperosAdeudados = recuperoItems.reduce((s: number, i: any) => s + i.amount, 0);

  // ── Cartera pendiente — instrumentos reales (src/lib/payments/caja-summary.ts) ──
  // recargosProntoPago es una categoría separada — el recargo fijo de $800
  // no es plata cobrada en efectivo/transferencia/cheque, es un cargo
  // administrativo aparte. Nunca se le atribuye a un método.
  const carteraBucket = emptyMoneyBucket();
  const directoCompaniaBucket = emptyDirectCompanyBucket();
  const carteraInconsistencias: CarteraInconsistency[] = [];

  // A. Pagos standalone confirmados y rendered=0 — sus payment_splits reales
  // (nunca payments.paymentMethod, que puede valer "combinado").
  for (const p of paymentsInCartera) {
    if (p.batchId != null) continue; // hijos de batch: se procesan agrupados más abajo
    const splits = splitsByPaymentId.get(p.id) ?? [];
    applyStandalonePaymentToCartera(
      { paymentId: p.id, amountCents: Math.round(p.amount * 100), splits },
      carteraBucket, directoCompaniaBucket, carteraInconsistencias,
    );
  }

  // B/C. Cobros múltiples (payment_batches) — agrupados una sola vez por
  // batch, con sus splits y (si corresponde) received_checks reales.
  const batchIdsInCartera = new Set<number>();
  for (const p of allPayments) if (p.batchId != null) batchIdsInCartera.add(p.batchId);
  if (batchIdsInCartera.size > 0) {
    const batchIdsArr = [...batchIdsInCartera];
    const batchRows = await db.select().from(paymentBatches).where(inArray(paymentBatches.id, batchIdsArr)).all();
    const childRows = await db.select({
      id: payments.id, batchId: payments.batchId, status: payments.status, rendered: payments.rendered, amount: payments.amount,
    }).from(payments).where(inArray(payments.batchId, batchIdsArr)).all();
    const batchSplitRows = await db.select().from(paymentBatchSplits).where(inArray(paymentBatchSplits.batchId, batchIdsArr)).all();
    const batchSplitIdsArr = batchSplitRows.map((s: any) => s.id);
    const batchCheckRows = batchSplitIdsArr.length
      ? await db.select().from(receivedChecks).where(inArray(receivedChecks.batchSplitId, batchSplitIdsArr)).all()
      : [];
    const checksBySplitId = new Map<number, { id: number; amountCents: number }[]>();
    for (const chk of batchCheckRows as any[]) {
      const arr = checksBySplitId.get(chk.batchSplitId) ?? [];
      arr.push({ id: chk.id, amountCents: chk.amountCents });
      checksBySplitId.set(chk.batchSplitId, arr);
    }
    const splitsByBatchId = new Map<number, { method: string; amountCents: number; checks: { id: number; amountCents: number }[] }[]>();
    for (const s of batchSplitRows as any[]) {
      const arr = splitsByBatchId.get(s.batchId) ?? [];
      arr.push({ method: s.method, amountCents: s.amountCents, checks: checksBySplitId.get(s.id) ?? [] });
      splitsByBatchId.set(s.batchId, arr);
    }
    const childrenByBatchId = new Map<number, { paymentId: number; status: string; rendered: number; amountCents: number }[]>();
    for (const c of childRows as any[]) {
      const arr = childrenByBatchId.get(c.batchId) ?? [];
      arr.push({ paymentId: c.id, status: c.status, rendered: c.rendered, amountCents: Math.round(c.amount * 100) });
      childrenByBatchId.set(c.batchId, arr);
    }
    for (const b of batchRows as any[]) {
      const batchForCartera: BatchForCartera = {
        batchId: b.id, status: b.status,
        splits: splitsByBatchId.get(b.id) ?? [],
        children: childrenByBatchId.get(b.id) ?? [],
        // Fase 2C: dinero APLICADO del batch — si difiere de SUM(splits) por
        // un sobrante/faltante resuelto (Fase 2B), applyBatchToCartera nunca
        // cuenta acá más que esto (el sobrante vive en creditoActivoEnCajaCents).
        appliedAmountCents: b.totalReceivedCents,
      };
      applyBatchToCartera(batchForCartera, carteraBucket, directoCompaniaBucket, carteraInconsistencias);
    }
  }

  // D/E/G. cash_entries: recargo Pronto Pago standalone (nunca el de un hijo
  // de batch, ya incluido en su payment_batch_splits) e ingresos manuales
  // normales por su método real.
  const surchargePaymentIds = manualInCartera
    .filter((e: any) => e.entryType === "pronto_pago_surcharge" && e.paymentId != null)
    .map((e: any) => e.paymentId as number);
  const surchargeParentPayments = surchargePaymentIds.length
    ? await db.select({ id: payments.id, batchId: payments.batchId }).from(payments).where(inArray(payments.id, surchargePaymentIds)).all()
    : [];
  const surchargeParentBatchIdByPaymentId = new Map<number, number | null>(surchargeParentPayments.map((p: any) => [p.id, p.batchId]));

  for (const e of manualInCartera) {
    if (e.entryType === "pronto_pago_surcharge") {
      const parentBatchId = e.paymentId != null ? surchargeParentBatchIdByPaymentId.get(e.paymentId) : null;
      if (parentBatchId != null) continue; // ya incluido en el split del batch — no contar aparte
      applyStandaloneSurchargeToCartera(Math.round(e.amount * 100), carteraBucket);
      continue;
    }
    applyManualCashEntryToCartera(e.paymentMethod as string, Math.round(e.amount * 100), carteraBucket, directoCompaniaBucket);
  }

  const cartera = {
    efectivo: centsToPesos(carteraBucket.efectivoCents),
    transferencia: centsToPesos(carteraBucket.transferenciaCents),
    cheque: centsToPesos(carteraBucket.chequeCents),
    recargosProntoPago: centsToPesos(carteraBucket.recargosProntoPagoCents),
    total: centsToPesos(carteraBucket.totalCents),
  };
  const directoCompania = {
    transferencia_compania: centsToPesos(directoCompaniaBucket.transferenciaCompaniaCents),
    link_pago: centsToPesos(directoCompaniaBucket.linkPagoCents),
    total: centsToPesos(directoCompaniaBucket.totalCents),
  };

  // ── Rendido por método — remittance_allocations con fallback legacy ────────
  // Cada rendición usa una única fuente (nunca paymentBreakdown + allocations
  // + totalPaid al mismo tiempo): allocations si existen (exactas, contra
  // instrumentos reales), paymentBreakdown legacy si no hay ninguna
  // allocation pero la rendición sí tuvo dinero real, o cero si la rendición
  // es nueva y solo tiene deuda/cuotas no cobradas.
  const confirmedRemittanceIds = confirmedRemittances.map((r: any) => r.id as number);

  const remittanceItemsForRendido = confirmedRemittanceIds.length
    ? await db.select({ remittanceId: remittanceItems.remittanceId, source: remittanceItems.source })
        .from(remittanceItems).where(inArray(remittanceItems.remittanceId, confirmedRemittanceIds)).all()
    : [];
  const hasRealMoneyItemsByRemittanceId = new Map<number, boolean>();
  for (const it of remittanceItemsForRendido as any[]) {
    if (it.source === "payment" || it.source === "cash_entry") hasRealMoneyItemsByRemittanceId.set(it.remittanceId, true);
  }

  const allocationsForRendido = confirmedRemittanceIds.length
    ? await db.select().from(remittanceAllocations).where(inArray(remittanceAllocations.remittanceId, confirmedRemittanceIds)).all()
    : [];
  const allocationsByRemittanceId = new Map<number, typeof allocationsForRendido>();
  for (const a of allocationsForRendido as any[]) {
    const arr = allocationsByRemittanceId.get(a.remittanceId) ?? [];
    arr.push(a);
    allocationsByRemittanceId.set(a.remittanceId, arr);
  }

  // Instrumentos reales referenciados por TODAS las allocations, resueltos
  // una sola vez (dedupeados) para todas las rendiciones — nunca resumando
  // las mismas allocations (ver calculateExpectedCollectedCents).
  const distinctAllForRendido = collectDistinctExpectedSources(allocationsForRendido as any[]);
  const expectedPaymentRows = distinctAllForRendido.standalonePaymentIds.length
    ? await db.select({ id: payments.id, amount: payments.amount }).from(payments).where(inArray(payments.id, distinctAllForRendido.standalonePaymentIds)).all()
    : [];
  const expectedPaymentAmountCentsById = new Map<number, number>(expectedPaymentRows.map((p: any) => [p.id, Math.round(p.amount * 100)]));

  const expectedBatchRows = distinctAllForRendido.batchIds.length
    ? await db.select({ id: paymentBatches.id, totalReceivedCents: paymentBatches.totalReceivedCents }).from(paymentBatches).where(inArray(paymentBatches.id, distinctAllForRendido.batchIds)).all()
    : [];
  const expectedBatchTotalCentsById = new Map<number, number>(expectedBatchRows.map((b: any) => [b.id, b.totalReceivedCents]));

  const expectedCashEntryRows = distinctAllForRendido.cashEntryIds.length
    ? await db.select({ id: cashEntries.id, amount: cashEntries.amount, entryType: cashEntries.entryType }).from(cashEntries).where(inArray(cashEntries.id, distinctAllForRendido.cashEntryIds)).all()
    : [];
  const expectedCashEntryAmountCentsById = new Map<number, number>(expectedCashEntryRows.map((e: any) => [e.id, Math.round(e.amount * 100)]));
  const isProntoPagoSurchargeByCashEntryId = new Map<number, boolean>(expectedCashEntryRows.map((e: any) => [e.id, e.entryType === "pronto_pago_surcharge"]));

  const rendidoAcc = emptyRendidoAccumulator();
  const remittanceContributionById = new Map<number, { ownCents: number; directCents: number }>();

  for (const r of confirmedRemittances) {
    const allocationsRaw = (allocationsByRemittanceId.get(r.id) ?? []) as any[];
    const allocationsForClassify = allocationsRaw.map((a) => ({
      method: a.method, amountCents: a.amountCents,
      isProntoPagoSurcharge: a.cashEntryId != null ? (isProntoPagoSurchargeByCashEntryId.get(a.cashEntryId) ?? false) : false,
    }));

    let expectedCollectedCents = 0;
    if (allocationsRaw.length > 0) {
      const distinct = collectDistinctExpectedSources(allocationsRaw);
      const sources: CollectedAmountSource[] = [
        ...distinct.standalonePaymentIds.map((id) => ({ kind: "standalone_payment" as const, amountCents: expectedPaymentAmountCentsById.get(id) ?? 0 })),
        ...distinct.batchIds.map((id) => ({ kind: "batch" as const, amountCents: expectedBatchTotalCentsById.get(id) ?? 0 })),
        ...distinct.cashEntryIds.map((id) => ({ kind: "cash_entry" as const, amountCents: expectedCashEntryAmountCentsById.get(id) ?? 0 })),
      ];
      expectedCollectedCents = calculateExpectedCollectedCents(sources);
    }

    const contribution = classifyRemittanceForRendido({
      remittanceId: r.id, date: r.date, allocations: allocationsForClassify,
      expectedCollectedCents, hasRealMoneyItems: hasRealMoneyItemsByRemittanceId.get(r.id) ?? false,
      legacyPaymentBreakdownRaw: r.paymentBreakdown || "{}",
    });
    accumulateRemittanceContribution(contribution, rendidoAcc);
    remittanceContributionById.set(r.id, {
      ownCents: contribution.contributionOwnCents, directCents: contribution.contributionDirectCompaniaCents,
    });
  }

  const rendidoPorMetodo = {
    efectivo: centsToPesos(rendidoAcc.cartera.efectivoCents),
    transferencia: centsToPesos(rendidoAcc.cartera.transferenciaCents),
    cheque: centsToPesos(rendidoAcc.cartera.chequeCents),
    pronto_pago: centsToPesos(rendidoAcc.cartera.recargosProntoPagoCents),
    otros: centsToPesos(rendidoAcc.otrosLegacyCents),
    total: centsToPesos(rendidoAcc.cartera.totalCents + rendidoAcc.otrosLegacyCents),
  };
  const rendidoDirectoCompania = {
    transferencia_compania: centsToPesos(rendidoAcc.directoCompania.transferenciaCompaniaCents),
    link_pago: centsToPesos(rendidoAcc.directoCompania.linkPagoCents),
    total: centsToPesos(rendidoAcc.directoCompania.totalCents),
  };
  const allocationsModel = {
    remittancesLegacyCount: rendidoAcc.remittancesLegacyCount,
    remittancesCompleteCount: rendidoAcc.remittancesCompleteCount,
    remittancesZeroCollectedCount: rendidoAcc.remittancesZeroCollectedCount,
    inconsistencias: rendidoAcc.inconsistencias,
    legacyUnknownMethods: rendidoAcc.legacyUnknownMethods,
  };

  // Total cobrado histórico (en cartera + ya rendido + directo compañía)
  const totalCobrado = cartera.total + directoCompania.total +
    manualRendered.reduce((s: number, e: any) => s + e.amount, 0) +
    paymentsRendered.reduce((s: number, p: any) => s + p.amount, 0);

  // Total adeudado = adeudados de rendiciones sin pagar + legacy
  const totalAdeudadoRendiciones = unpaidDebtItems.reduce((s: number, i: any) => s + i.amount, 0);
  const totalAdeudadoLegacy = debtsLegacy.reduce((s: number, d: any) => s + d.amount, 0);
  const totalAdeudado = totalAdeudadoRendiciones + totalAdeudadoLegacy;

  // Detalle fila por fila de esos mismos adeudados (mismas filas de arriba,
  // sin re-consultar ni recalcular el total — ver buildAdeudadosDetalle).
  const adeudadosDetalle = buildAdeudadosDetalle(unpaidDebtItems, debtsLegacy);
  try {
    assertAdeudadosDetalleMatchesTotal(adeudadosDetalle, totalAdeudado);
  } catch (e) {
    if (e instanceof AdeudadosSumMismatchError) {
      return c.json({ error: e.message }, 500);
    }
    throw e;
  }

  // Gastos registrados (excluye anulados)
  const allExpenses = await db.select().from(cashExpenses).all();
  const totalGastos = allExpenses.filter((e: any) => e.status !== "anulado").reduce((s: number, e: any) => s + e.amount, 0);

  // Movimientos propios registrados (aportes y reintegros)
  const ownMovements = await db.select().from(ownMoneyMovements)
    .where(eq(ownMoneyMovements.status, "registrado")).all();

  // Mes y año actuales
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const currentYear = String(now.getFullYear());

  // Comisiones
  const allCommissions = await db
    .select({ id: commissionEntries.id, date: commissionEntries.date, amount: commissionEntries.amount, companyId: commissionEntries.companyId, companyName: companies.name, notes: commissionEntries.notes, status: commissionEntries.status, createdAt: commissionEntries.createdAt })
    .from(commissionEntries)
    .leftJoin(companies, eq(commissionEntries.companyId, companies.id))
    .orderBy(desc(commissionEntries.date))
    .all();
  const comisionesMes = allCommissions
    .filter((c: any) => c.status !== "anulado" && c.date && c.date.startsWith(currentMonth))
    .reduce((s: number, c: any) => s + c.amount, 0);
  const comisionesAnio = allCommissions
    .filter((c: any) => c.status !== "anulado" && c.date && c.date.startsWith(currentYear))
    .reduce((s: number, c: any) => s + c.amount, 0);

  // IVA
  const allIva = await db
    .select({ id: ivaEntries.id, date: ivaEntries.date, amount: ivaEntries.amount, companyId: ivaEntries.companyId, companyName: companies.name, notes: ivaEntries.notes, createdAt: ivaEntries.createdAt })
    .from(ivaEntries)
    .leftJoin(companies, eq(ivaEntries.companyId, companies.id))
    .orderBy(desc(ivaEntries.date))
    .all();
  const ivaMes = allIva
    .filter((i: any) => i.date && i.date.startsWith(currentMonth))
    .reduce((s: number, i: any) => s + i.amount, 0);
  const ivaAnio = allIva
    .filter((i: any) => i.date && i.date.startsWith(currentYear))
    .reduce((s: number, i: any) => s + i.amount, 0);

  // Gastos del mes (excluye anulados)
  const gastosMes = allExpenses
    .filter((e: any) => e.status !== "anulado" && e.date && e.date.startsWith(currentMonth))
    .reduce((s: number, e: any) => s + e.amount, 0);

  // Ganancia neta del mes = comisiones del mes - gastos del mes
  const gananciaNeta = comisionesMes - gastosMes;

  // ── Fase 2C: cuenta corriente de asegurados (sobrantes/faltantes) ─────────
  // Fuente única: insured_account_movements (Migración 0030) — nunca se
  // mezcla con cash_debts/Adeudados/remittance_items (Regla 6 del pedido).
  // relatedPaymentId solo importa para aplicacion_saldo_favor (necesita saber
  // si esa cuota futura ya se rindió, ver calculateCreditActiveInCaja) — se
  // resuelve con una sola query adicional, batcheada.
  const accountMovementRows = await db.select({
    id: insuredAccountMovements.id,
    insuredId: insuredAccountMovements.insuredId,
    type: insuredAccountMovements.type,
    signedAmountCents: insuredAccountMovements.signedAmountCents,
    status: insuredAccountMovements.status,
    relatedPaymentId: insuredAccountMovements.relatedPaymentId,
  }).from(insuredAccountMovements).all();

  const relatedPaymentIdsForCredit = [...new Set(
    accountMovementRows
      .filter((m: any) => m.type === "aplicacion_saldo_favor" && m.relatedPaymentId != null)
      .map((m: any) => m.relatedPaymentId as number)
  )];
  const relatedPaymentRenderedById = new Map<number, boolean>();
  if (relatedPaymentIdsForCredit.length > 0) {
    const relatedRows = await db.select({ id: payments.id, rendered: payments.rendered })
      .from(payments).where(inArray(payments.id, relatedPaymentIdsForCredit)).all();
    for (const r of relatedRows as any[]) relatedPaymentRenderedById.set(r.id, r.rendered === 1);
  }

  const movementsForCaja: InsuredAccountMovementForCaja[] = accountMovementRows.map((m: any) => ({
    type: m.type,
    signedAmountCents: m.signedAmountCents,
    status: m.status,
    relatedPaymentRendered: m.relatedPaymentId != null ? (relatedPaymentRenderedById.get(m.relatedPaymentId) ?? false) : null,
  }));

  const insuredBalances = summarizeInsuredAccountBalances(accountMovementRows as any);
  const creditoActivoEnCajaCents = calculateCreditActiveInCaja(movementsForCaja);
  const creditoRegularizadoCents = calculateCreditRegularizedInCaja(movementsForCaja);
  const cobrosSaldoDeudorCents = calculateCobroSaldoDeudorInCaja(movementsForCaja);

  const cuentaCorriente = {
    saldosAFavorPendientes: centsToPesos(insuredBalances.saldosAFavorPendientesCents),
    saldosDeudoresPendientes: centsToPesos(insuredBalances.saldosDeudoresPendientesCents),
    creditoActivoEnCaja: centsToPesos(creditoActivoEnCajaCents),
    creditoRegularizado: centsToPesos(creditoRegularizadoCents),
    cobrosSaldoDeudor: centsToPesos(cobrosSaldoDeudorCents),
    byInsured: insuredBalances.byInsured.map((b) => ({ insuredId: b.insuredId, balance: centsToPesos(b.balanceCents) })),
  };

  // ── Caja propia — histórico ───────────────────────────────────────────────
  const cpComisiones  = allCommissions.filter((c: any) => c.status !== "anulado").reduce((s: number, c: any) => s + c.amount, 0);
  const cpAportes     = ownMovements.filter((m: any) => m.type === "aporte").reduce((s: number, m: any) => s + m.amount, 0);
  const cpReintegros  = ownMovements.filter((m: any) => m.type === "reintegro").reduce((s: number, m: any) => s + m.amount, 0);
  const cpGastosOp    = allExpenses.filter((e: any) => e.type === "gasto_operativo" && e.status !== "anulado").reduce((s: number, e: any) => s + e.amount, 0);
  const cpSueldos     = allExpenses.filter((e: any) => e.type === "sueldo" && e.status !== "anulado").reduce((s: number, e: any) => s + e.amount, 0);
  const cpResultadoOp = cpComisiones - cpGastosOp - cpSueldos;
  const cpSaldoPropio = cpComisiones + cpAportes - cpGastosOp - cpSueldos - cpReintegros;
  const cpAportesPend = cpAportes - cpReintegros;

  // Pendiente de rendir actual: lo cobrado en cuentas propias que aún no fue rendido.
  // cajaNeta = cartera.total (ítems no rendidos, métodos propios) + cuenta
  // corriente de asegurados (Fase 2C — ver calculateCajaNetaTotalCents):
  // sobrante todavía activo/no consumido, su reclasificación por ajuste
  // manual (se cancelan entre sí, nunca mueven el total) y cobros reales de
  // saldo deudor. Nunca se resta cuentaCorriente.saldosAFavorPendientes ni se
  // suma saldosDeudoresPendientes acá — son puramente informativos.
  // No se resta rendidoPorMetodo porque cartera ya excluye ítems rendidos (rendered=0).
  const cajaEfectivo = cartera.efectivo;
  const cajaTransferencia = cartera.transferencia;
  const cajaCheque = cartera.cheque;
  const cajaRecargosProntoPago = cartera.recargosProntoPago;
  const cajaNeta = centsToPesos(calculateCajaNetaTotalCents({
    carteraTotalCents: carteraBucket.totalCents,
    creditoActivoEnCajaCents,
    creditoRegularizadoCents,
    cobrosSaldoDeudorCents,
  })); // Pendiente de rendir actual + cuenta corriente de asegurados

  // Diferencia de caja/cartera = pendiente total de rendir (cajaNeta) menos
  // adeudados. Los gastos NO se restan acá — son un movimiento de Caja
  // propia (ver cpResultadoOp/cpSaldoPropio más abajo), no parte de la
  // cartera pendiente de rendir del asegurado (hotfix: restarlos generaba
  // una diferencia negativa incorrecta que no reflejaba ningún faltante
  // real de cartera).
  const diferencia = cajaNeta - totalAdeudado;

  // ── Totales del período (solo si se recibieron parámetros válidos) ─────────
  let cobradoPeriodo = 0;
  let rendidoPeriodo = 0;
  let gastosPeriodo  = 0;
  let adelantosAdeudadosPeriodo = 0;
  let recuperosAdeudadosPeriodo = 0;
  let cpPComisiones  = 0;
  let cpPAportes     = 0;
  let cpPReintegros  = 0;
  let cpPGastosOp    = 0;
  let cpPSueldos     = 0;

  if (periodFrom && periodTo) {
    const DIRECTO_COMPANIA_LOCAL = ["transferencia_compania", "link_pago"];

    // Payments confirmados, grupo propio, dentro del período. Se clasifica
    // por los splits reales (paymentGroupById), no por payments.paymentMethod
    // — un combinado "combinado" con splits direct_company no matchea contra
    // DIRECTO_COMPANIA_LOCAL por string y quedaría mal incluido acá si se
    // comparara el paymentMethod crudo.
    const periodPayments = allPayments.filter((p: any) =>
      p.status === "confirmado" &&
      paymentGroupById.get(p.id) !== "direct_company" &&
      p.paymentDate >= periodFrom! && p.paymentDate <= periodTo!
    );

    // Cash entries (rendidos + no rendidos), métodos propios, dentro del período
    const allManual = [...manualInCartera, ...manualRendered];
    const periodEntries = allManual.filter((e: any) =>
      !DIRECTO_COMPANIA_LOCAL.includes(e.paymentMethod as string) &&
      e.paymentDate >= periodFrom! && e.paymentDate <= periodTo!
    );

    cobradoPeriodo =
      periodPayments.reduce((s: number, p: any) => s + (p.amount || 0), 0) +
      periodEntries.reduce((s: number, e: any) => s + (e.amount || 0), 0);

    // Rendiciones confirmadas cuya fecha cae en el período — misma fuente
    // única por rendición que rendidoPorMetodo (nunca totalPaid).
    rendidoPeriodo = confirmedRemittances
      .filter((r: any) => r.date >= periodFrom! && r.date <= periodTo!)
      .reduce((s: number, r: any) => {
        const c = remittanceContributionById.get(r.id);
        return s + (c ? centsToPesos(c.ownCents + c.directCents) : 0);
      }, 0);

    // Gastos del período
    gastosPeriodo = allExpenses
      .filter((e: any) => e.date >= periodFrom! && e.date <= periodTo!)
      .reduce((s: number, e: any) => s + (e.amount || 0), 0);

    // Adelanto del período: fechado por remittances.date (cuándo Curini puso
    // la plata), nunca por remittance_items.paidAt (eso es la fecha en la
    // que la deuda se cerró, no en la que salió el adelanto).
    adelantosAdeudadosPeriodo = installmentDebtItems
      .filter((i: any) => i.remittanceDate >= periodFrom! && i.remittanceDate <= periodTo!)
      .reduce((s: number, i: any) => s + i.amount, 0);

    // Recupero del período: fechado por payments.paymentDate (el cobro real
    // posterior a través de POST /remittances/items/:id/collect), nunca por
    // remittance_items.paidAt — paidAt solo cierra la deuda, no es una fecha
    // de movimiento de Caja (regla de negocio explícita: "si paidAt se usa
    // solo para cerrar deuda, no usarlo para sumar ingreso si ya existe
    // paymentDate"). Este importe YA está adentro de cobradoPeriodo (allPayments
    // no filtra por rendered) — acá se recalcula aparte solo para exponerlo
    // como subtotal informativo, JAMÁS se suma de nuevo a cobradoPeriodo/flujoNeto.
    const recuperoInstallmentIds = recuperoItems
      .map((i: any) => i.sourceId)
      .filter((sid: any): sid is number => sid != null);
    if (recuperoInstallmentIds.length > 0) {
      const recoveryPaymentRows = await db.select({
        installmentId: payments.installmentId, amount: payments.amount, paymentDate: payments.paymentDate,
      }).from(payments)
        .where(and(inArray(payments.installmentId, recuperoInstallmentIds), eq(payments.status, "confirmado")))
        .all();
      recuperosAdeudadosPeriodo = recoveryPaymentRows
        .filter((p: any) => (p.paymentDate as string) >= periodFrom! && (p.paymentDate as string) <= periodTo!)
        .reduce((s: number, p: any) => s + p.amount, 0);
    }

    // Caja propia del período
    cpPComisiones = allCommissions.filter((c: any) => c.status !== "anulado" && c.date >= periodFrom! && c.date <= periodTo!).reduce((s: number, c: any) => s + c.amount, 0);
    cpPAportes    = ownMovements.filter((m: any) => m.type === "aporte" && m.date >= periodFrom! && m.date <= periodTo!).reduce((s: number, m: any) => s + m.amount, 0);
    cpPReintegros = ownMovements.filter((m: any) => m.type === "reintegro" && m.date >= periodFrom! && m.date <= periodTo!).reduce((s: number, m: any) => s + m.amount, 0);
    cpPGastosOp   = allExpenses.filter((e: any) => e.type === "gasto_operativo" && e.status !== "anulado" && e.date >= periodFrom! && e.date <= periodTo!).reduce((s: number, e: any) => s + e.amount, 0);
    cpPSueldos    = allExpenses.filter((e: any) => e.type === "sueldo" && e.status !== "anulado" && e.date >= periodFrom! && e.date <= periodTo!).reduce((s: number, e: any) => s + e.amount, 0);
  }

  return c.json({
    cartera,
    directoCompania,
    // Neto en caja después de rendiciones
    cajaNeta: {
      efectivo: Math.max(0, cajaEfectivo),
      transferencia: Math.max(0, cajaTransferencia),
      cheque: Math.max(0, cajaCheque),
      recargosProntoPago: Math.max(0, cajaRecargosProntoPago),
      total: cajaNeta,
    },
    rendidoPorMetodo,
    rendidoDirectoCompania,
    allocationsModel,
    carteraInconsistencias,
    totalRendiciones: confirmedRemittances.length,
    totalCobrado,
    totalRendido: rendidoPorMetodo.total + rendidoDirectoCompania.total,
    totalAdeudado,
    totalAdeudadoRendiciones,
    totalAdeudadoLegacy,
    // Histórico completo (todas las rendiciones confirmadas) de cuotas
    // reales rendidas como adeudadas — ver query de installmentDebtItems más
    // arriba. adelantosAdeudados NUNCA baja cuando una deuda se cobra (queda
    // como hecho histórico); recuperosAdeudados es un subtotal informativo ya
    // incluido en totalCobrado, no se resta de cajaNeta/diferencia acá.
    adelantosAdeudados,
    recuperosAdeudados,
    adeudadosDetalle,
    totalGastos,
    gastosMes,
    diferencia,
    // Fase 2C: cuenta corriente de asegurados (sobrantes/faltantes) — nunca
    // se mezcla con adeudadosDetalle/totalAdeudado (Regla 6 del pedido).
    cuentaCorriente,
    comisiones: {
      totalMes: comisionesMes,
      totalAnio: comisionesAnio,
    },
    iva: {
      totalMes: ivaMes,
      totalAnio: ivaAnio,
    },
    gananciaNeta,
    counts: {
      manualInCartera: manualInCartera.length,
      manualRendered: manualRendered.length,
      paymentsInCartera: paymentsInCartera.length,
      paymentsRendered: paymentsRendered.length,
      debts: debtsLegacy.length,
      adeudadosRendiciones: unpaidDebtItems.length,
      gastos: allExpenses.length,
      comisiones: allCommissions.length,
      iva: allIva.length,
    },
    // Totales del período solicitado (null si no se pasaron parámetros).
    // adelantosAdeudados: salida real de Caja del período (fechada por
    // remittances.date) — se resta en flujoNeto porque es plata que salió y
    // ningún otro campo del período la contaba hasta ahora. recuperosAdeudados
    // es informativo: ya está adentro de `cobrado` (payments.rendered no
    // filtra ahí), así que NO se suma de nuevo en flujoNeto — solo se expone
    // para poder mostrar cuánto de `cobrado` es recuperación de adeudadas.
    periodo: periodFrom && periodTo ? {
      from:       periodFrom,
      to:         periodTo,
      cobrado:    cobradoPeriodo,
      rendido:    rendidoPeriodo,
      gastos:     gastosPeriodo,
      adelantosAdeudados: adelantosAdeudadosPeriodo,
      recuperosAdeudados: recuperosAdeudadosPeriodo,
      flujoNeto:  cobradoPeriodo - rendidoPeriodo - gastosPeriodo - adelantosAdeudadosPeriodo,
    } : null,
    cajaPropia: {
      historico: {
        comisiones:        cpComisiones,
        aportes:           cpAportes,
        reintegros:        cpReintegros,
        gastosOperativos:  cpGastosOp,
        sueldos:           cpSueldos,
        resultadoOperativo: cpResultadoOp,
        saldoPropio:       cpSaldoPropio,
        aportesPendientes: cpAportesPend,
      },
      periodo: periodFrom && periodTo ? {
        from:               periodFrom,
        to:                 periodTo,
        comisiones:         cpPComisiones,
        aportes:            cpPAportes,
        reintegros:         cpPReintegros,
        gastosOperativos:   cpPGastosOp,
        sueldos:            cpPSueldos,
        resultadoOperativo: cpPComisiones - cpPGastosOp - cpPSueldos,
        flujoPropio:        cpPComisiones + cpPAportes - cpPGastosOp - cpPSueldos - cpPReintegros,
      } : null,
    },
  });
}));

// GET /api/cash/payments — payments de Cobranzas para Caja (con datos enriquecidos)
app.get("/cash/payments", requireAdmin(async (c: any) => {
  const allPayments = await db
    .select({
      id: payments.id,
      policyId: payments.policyId,
      manualPayer: payments.manualPayer,
      manualPolicyNumber: payments.manualPolicyNumber,
      manualCompany: payments.manualCompany,
      amount: payments.amount,
      paymentMethod: payments.paymentMethod,
      paymentDate: payments.paymentDate,
      periodMonth: payments.periodMonth,
      notes: payments.notes,
      status: payments.status,
      rendered: payments.rendered,
      renderedAt: payments.renderedAt,
      createdAt: payments.createdAt,
      insuredName: insureds.name,
      policyNumber: policies.policyNumber,
      companyName: companies.name,
    })
    .from(payments)
    .leftJoin(policies, eq(payments.policyId, policies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .where(eq(payments.status, "confirmado"))
    .orderBy(desc(payments.createdAt))
    .all();
  return c.json(allPayments);
}));

// GET /api/cash/stats — estadísticas históricas por mes
app.get("/cash/stats", requireAdmin(async (c: any) => {
  // Todos los cobros manuales
  const allEntries = await db.select().from(cashEntries).all();
  // Todos los payments confirmados
  const allPays = await db.select().from(payments).where(eq(payments.status, "confirmado")).all();

  // Agrupar por mes "YYYY-MM"
  const monthMap: Record<string, { cobrado: number; rendido: number }> = {};

  // Agrupa por mes calendario Argentina — paymentDate (texto "YYYY-MM-DD")
  // o, si falta, createdAt (timestamp real) vía resolveArgentinaMonthKey.
  // Antes usaba getFullYear()/getMonth() sobre new Date(...) (hora local
  // del proceso, no de Argentina) — mismo patrón de bug que la rendición
  // #115, aplicado a mes en vez de día. Ver lib/dates/argentina-date.ts.
  for (const e of allEntries) {
    const m = resolveArgentinaMonthKey(e.paymentDate || e.createdAt);
    if (!m) continue;
    if (!monthMap[m]) monthMap[m] = { cobrado: 0, rendido: 0 };
    monthMap[m].cobrado += e.amount;
    if (e.rendered) monthMap[m].rendido += e.amount;
  }

  for (const p of allPays) {
    const m = resolveArgentinaMonthKey(p.paymentDate || p.createdAt);
    if (!m) continue;
    if (!monthMap[m]) monthMap[m] = { cobrado: 0, rendido: 0 };
    monthMap[m].cobrado += p.amount;
    if ((p as any).rendered) monthMap[m].rendido += p.amount;
  }

  // Ordenar por mes y calcular acumulado
  const sorted = Object.entries(monthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, v]) => ({ mes, ...v }));

  let acumuladoCobrado = 0;
  let acumuladoRendido = 0;
  const result = sorted.map((row) => {
    acumuladoCobrado += row.cobrado;
    acumuladoRendido += row.rendido;
    return { ...row, acumuladoCobrado, acumuladoRendido };
  });

  return c.json(result);
}));

// ─── RENDICIONES ─────────────────────────────────────────────────────────────

// GET /api/remittances — listar rendiciones con totales
app.get("/remittances", requireAuth(async (c: any) => {
  const all = await db.select().from(remittances).orderBy(desc(remittances.date)).all();
  // Para cada rendición traer cantidad de items
  const result = await Promise.all(all.map(async (r: any) => {
    const items = await db.select().from(remittanceItems)
      .where(eq(remittanceItems.remittanceId, r.id)).all();
    const adeudados = items.filter((i: any) => i.debtorStatus === "adeudado" && !i.paidAt);
    return {
      ...r,
      paymentBreakdown: JSON.parse(r.paymentBreakdown || "{}"),
      itemCount: items.length,
      adeudadoCount: adeudados.length,
      adeudadoTotal: adeudados.reduce((s: number, i: any) => s + i.amount, 0),
    };
  }));
  return c.json(result);
}));

// GET /api/remittances/:id/items — detalle de items de una rendición
app.get("/remittances/:id/items", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  const items = await db.select().from(remittanceItems)
    .where(eq(remittanceItems.remittanceId, id)).all();
  return c.json(items);
}));

// POST /api/remittances — crear nueva rendición
app.post("/remittances", requireAuth(async (c: any) => {
  const body = await c.req.json();
  // body: { date, canal, notes, paymentBreakdown, prontoPagoSurcharge, items: [{source, sourceId, amount, debtorStatus, clientName, policyNumber, companyName, paymentMethod}] }
  const user = c.get("user");
  try {
    const items: any[] = body.items || [];
    const breakdown = body.paymentBreakdown || {};
    const totalBase: number = items.reduce((s: number, i: any) => s + (i.amount || 0), 0);
    const totalPaid: number = Object.values(breakdown).reduce((s: number, v: any) => s + (Number(v) || 0), 0);

    // GUARD — un cobro confirmado (source='payment') nunca puede rendirse
    // como adeudado: representa dinero ya recibido (standalone con o sin
    // installmentId, o hijo de un payment_batch con o sin installmentId).
    // Las deudas solo pueden originarse en source='installment' (cuota no
    // cobrada) o source='manual_debt' (deuda cargada a mano, sin FK real) —
    // nunca en un payment ya confirmado. No confiar únicamente en que la UI
    // no ofrezca el checkbox: se rechaza acá, antes de cualquier escritura,
    // incluso si el body llega armado a mano o desde un cliente viejo.
    const invalidDebtorPaymentItems = items.filter(
      (i: any) => i.source === "payment" && i.debtorStatus != null && i.debtorStatus !== "pagado"
    );
    if (invalidDebtorPaymentItems.length > 0) {
      return c.json({ error: "Un cobro confirmado no puede registrarse como adeudado." }, 400);
    }

    // GUARD: reject any item that is a surcharge cash_entry (must be auto-included by backend only)
    const cashEntryIds = items
      .filter((i: any) => i.source === "cash_entry" && i.sourceId != null)
      .map((i: any) => i.sourceId as number);
    if (cashEntryIds.length > 0) {
      const surchargeCheck = await db.select({ id: cashEntries.id }).from(cashEntries)
        .where(and(inArray(cashEntries.id, cashEntryIds), eq(cashEntries.entryType, "pronto_pago_surcharge")))
        .all();
      if (surchargeCheck.length > 0) {
        return c.json({ error: "No se puede incluir manualmente un recargo Pronto Pago. El backend lo agrega automáticamente por paymentId." }, 400);
      }
    }

    // PRE-VALIDATION: batch-lookup surcharge entries for pronto_pago rendiciones (before transaction)
    let surchargeExtra = 0;
    const surchargeMap = new Map<number, any>(); // paymentId → cash_entry row
    if (body.canal === "pronto_pago") {
      const paymentSourceIds = items
        .filter((i: any) => i.source === "payment" && i.sourceId != null)
        .map((i: any) => i.sourceId as number);
      if (paymentSourceIds.length > 0) {
        const sRows = await db.select().from(cashEntries)
          .where(and(
            inArray(cashEntries.paymentId, paymentSourceIds),
            eq(cashEntries.entryType, "pronto_pago_surcharge"),
            eq(cashEntries.rendered, 0),
          )).all();
        // Defensa (hotfix Pronto Pago Rivadavia): un cash_entry de recargo
        // puede haber quedado huérfano si el pago que lo originó fue editado
        // después a otra compañía sin pasar por applyProntoPagoSurcharge
        // (ver PUT /payments) — nunca confiar en la sola existencia del
        // cash_entry, siempre re-validar contra la compañía ACTUAL del pago
        // antes de sumarlo al total a cobrar.
        const surchargePaymentIds = sRows.map((s: any) => s.paymentId).filter((id: any) => id != null);
        const currentCompanyByPaymentId = new Map<number, string>();
        if (surchargePaymentIds.length > 0) {
          const currentCompanyRows = await db.select({
            id: payments.id, manualCompany: payments.manualCompany, companyName: companies.name,
          }).from(payments)
            .leftJoin(policies, eq(payments.policyId, policies.id))
            .leftJoin(companies, eq(policies.companyId, companies.id))
            .where(inArray(payments.id, surchargePaymentIds)).all();
          for (const r of currentCompanyRows) {
            currentCompanyByPaymentId.set(r.id, (r.companyName ?? r.manualCompany ?? "") as string);
          }
        }
        for (const s of sRows) {
          if (s.paymentId == null) continue;
          const currentCompany = currentCompanyByPaymentId.get(s.paymentId) ?? "";
          if (!currentCompany.toLowerCase().includes("rivadavia")) continue;
          surchargeMap.set(s.paymentId, s);
          surchargeExtra += s.amount;
        }
      }
      // Recargo por manual_debt de Rivadavia (sin cash_entry previo — se suma al total de la rendición)
      const manualDebtRivadaviaCount = items.filter((item: any) =>
        item.source === "manual_debt" &&
        String(item.companyName ?? "").trim().toLowerCase().includes("rivadavia")
      ).length;
      surchargeExtra += manualDebtRivadaviaCount * SURCHARGE_AMOUNT;
    }

    const finalTotalAmount = totalBase + surchargeExtra;
    if (Math.abs(totalPaid - finalTotalAmount) > 1) {
      return c.json({
        error: `El desglose declarado ($${Math.round(totalPaid)}) no coincide con el total a rendir ($${Math.round(finalTotalAmount)}).`,
      }, 400);
    }

    const remId = await db.transaction(async (tx) => {
      // ── 1. Reconsultar orígenes reales dentro de la transacción — rechazar
      // rendered=1, status distinto de confirmado, o cuota no_exigible ──
      const paymentSourceItems = items.filter((i: any) => i.source === "payment");
      const cashEntrySourceItems = items.filter((i: any) => i.source === "cash_entry");
      const installmentSourceItems = items.filter((i: any) => i.source === "installment");

      const paymentIds = paymentSourceItems.map((i: any) => i.sourceId);
      const paymentRows = paymentIds.length
        ? await tx.select().from(payments).where(inArray(payments.id, paymentIds)).all()
        : [];
      const paymentsById = new Map(paymentRows.map((p: any) => [p.id, p]));
      for (const item of paymentSourceItems) {
        const p = paymentsById.get(item.sourceId);
        if (!p) throw new RemittanceAllocationValidationError(`El pago ${item.sourceId} no existe.`);
        if (p.rendered) throw new RemittanceAllocationValidationError(`El pago ${item.sourceId} ya fue rendido.`);
        if (p.status !== "confirmado") throw new RemittanceAllocationValidationError(`El pago ${item.sourceId} no está confirmado (status=${p.status}).`);
      }

      const cashEntryIds2 = cashEntrySourceItems.map((i: any) => i.sourceId);
      const cashEntryRows = cashEntryIds2.length
        ? await tx.select().from(cashEntries).where(inArray(cashEntries.id, cashEntryIds2)).all()
        : [];
      for (const item of cashEntrySourceItems) {
        const e = cashEntryRows.find((r: any) => r.id === item.sourceId);
        if (!e) throw new RemittanceAllocationValidationError(`El cobro manual ${item.sourceId} no existe.`);
        if (e.rendered) throw new RemittanceAllocationValidationError(`El cobro manual ${item.sourceId} ya fue rendido.`);
      }

      const installmentIds2 = installmentSourceItems.map((i: any) => i.sourceId);
      const installmentRows = installmentIds2.length
        ? await tx.select().from(policyInstallments).where(inArray(policyInstallments.id, installmentIds2)).all()
        : [];
      for (const item of installmentSourceItems) {
        const inst = installmentRows.find((r: any) => r.id === item.sourceId);
        if (!inst) throw new RemittanceAllocationValidationError(`La cuota ${item.sourceId} no existe.`);
        if (inst.rendered) throw new RemittanceAllocationValidationError(`La cuota ${item.sourceId} ya fue rendida.`);
        if (inst.status === "no_exigible") throw new RemittanceAllocationValidationError(`La cuota ${item.sourceId} no es exigible y no puede rendirse.`);
      }

      // Recargos pronto_pago auto-incluidos: reconsultar dentro de la tx.
      const surchargeIds = [...surchargeMap.values()].map((s: any) => s.id);
      const surchargeRowsTx = surchargeIds.length
        ? await tx.select().from(cashEntries).where(inArray(cashEntries.id, surchargeIds)).all()
        : [];
      for (const s of surchargeRowsTx as any[]) {
        if (s.rendered) throw new RemittanceAllocationValidationError(`El recargo Pronto Pago ${s.id} ya fue rendido.`);
      }
      const allCashEntryRowsById = new Map<number, any>([...cashEntryRows, ...surchargeRowsTx].map((e: any) => [e.id, e]));

      // ── 2. Hijos de batch — rendición por cuota, NO por lote ──
      // Cobrar por lote (payment_batches) agrupa cuotas solo para cobrarlas
      // más rápido; NO define cómo se rinden después. Cada payment hijo se
      // rinde de forma independiente de sus hermanos — ver GUARD de arriba
      // (rendered/status) para la protección real contra doble rendición.
      // No se arrastra el instrumento de COBRANZA del batch (payment_batch_
      // splits/received_checks son cómo entró la plata, no cómo se rinde) —
      // ver resolveBatchChildPaymentInstrument en remittance-allocations.ts
      // (Migración 0029) y el paso 5 más abajo, donde se arma el instrumento
      // de SALIDA propio de cada item.

      // ── 3. Crear remittance ──
      const [rem] = await tx.insert(remittances).values({
        date: body.date,
        canal: body.canal || "directo",
        notes: body.notes || null,
        paymentBreakdown: JSON.stringify(breakdown),
        prontoPagoSurcharge: body.prontoPagoSurcharge || 0,
        totalAmount: finalTotalAmount,
        totalPaid: totalPaid as number,
        status: "confirmada",
        createdBy: user?.id || null,
        createdAt: new Date(),
      }).returning();

      // ── 4. Crear remittance_items (los del body + recargos pronto_pago auto-incluidos) ──
      const effectiveItems = [
        ...items,
        ...(surchargeRowsTx as any[]).map((s) => ({
          source: "cash_entry", sourceId: s.id, amount: s.amount, debtorStatus: "pagado",
          clientName: s.clientName, policyNumber: s.policyNumber, companyName: s.companyName, paymentMethod: s.paymentMethod,
        })),
      ];

      const insertedItems: { item: any; row: any }[] = [];
      for (const item of effectiveItems) {
        const [row] = await tx.insert(remittanceItems).values({
          remittanceId: rem!.id,
          source: item.source,
          sourceId: item.sourceId,
          amount: item.amount,
          debtorStatus: item.debtorStatus || "pagado",
          clientName: item.clientName || null,
          policyNumber: item.policyNumber || null,
          companyName: item.companyName || null,
          paymentMethod: item.paymentMethod || null,
          createdAt: new Date(),
        }).returning();
        insertedItems.push({ item, row: row! });
      }

      // ── 5. Construir allocations + expectedCollectedCents desde instrumentos reales ──
      const allInstruments: ResolvedInstrument[] = [];
      const collectedSources: CollectedAmountSource[] = [];

      for (const { item, row } of insertedItems) {
        if (item.source === "payment") {
          const p = paymentsById.get(item.sourceId);
          if (p.batchId != null) {
            // Rendición por cuota (Migración 0029): este payment hijo de
            // batch se rinde por su cuenta, con su propio instrumento de
            // SALIDA — nunca el instrumento de cobranza del batch entero (ver
            // comentario del paso 2). method es obligatorio acá porque deja
            // de poder inferirse de payment_batch_splits: representa cómo
            // Curini le paga a la compañía esta cuota puntual, no cómo cobró
            // originalmente al cliente.
            const method = item.paymentMethod;
            if (!method || !isContableMethod(method)) {
              throw new RemittanceAllocationValidationError(
                `El pago ${item.sourceId} (hijo de un cobro por lote) necesita un método de rendición real (efectivo, transferencia, cheque, link_pago o transferencia_compania) para poder rendirse por separado del resto del lote.`
              );
            }
            const amountCents = Math.round(p.amount * 100);
            const instrument = resolveBatchChildPaymentInstrument({
              remittanceItemId: row.id, paymentId: p.id, paymentBatchId: p.batchId, method, amountCents,
            });
            allInstruments.push(instrument);
            collectedSources.push({ kind: "batch_child_payment", amountCents });
          } else {
            const splitsRows = await tx.select().from(paymentSplits).where(eq(paymentSplits.paymentId, item.sourceId)).all();
            // Migración 0028: un split method='cheque' de este pago standalone
            // puede tener received_checks reales (payment_split_id) — se
            // resuelven acá, en la misma tx, igual que ya se hace para
            // splits de batch (batchInstrumentsByBatchId más arriba).
            const splitIdsForPayment = (splitsRows as any[]).map((s) => s.id);
            const checksBySplitIdForPayment = new Map<number, any[]>();
            if (splitIdsForPayment.length > 0) {
              const checkRowsForPayment = await tx.select().from(receivedChecks)
                .where(inArray(receivedChecks.paymentSplitId, splitIdsForPayment)).all();
              for (const chk of checkRowsForPayment as any[]) {
                const arr = checksBySplitIdForPayment.get(chk.paymentSplitId!) ?? [];
                arr.push(chk);
                checksBySplitIdForPayment.set(chk.paymentSplitId!, arr);
              }
            }
            const instruments = resolveStandalonePaymentInstruments({
              remittanceItemId: row.id,
              paymentId: item.sourceId,
              splits: (splitsRows as any[]).map((s) => ({
                id: s.id, method: s.method, amountCents: s.amountCents,
                checks: (checksBySplitIdForPayment.get(s.id) ?? []).map((chk: any) => ({ id: chk.id, amountCents: chk.amountCents })),
              })),
            });
            validateAllocationOwnership(instruments, { paymentId: item.sourceId });
            allInstruments.push(...instruments);
            collectedSources.push({ kind: "standalone_payment", amountCents: Math.round(p.amount * 100) });
          }
        } else if (item.source === "cash_entry") {
          // Rendición por cuota (Migración 0029): un recargo Pronto Pago de
          // un hijo de batch YA NO comparte instrumento con ningún split del
          // batch (el batch entero dejó de arrastrarse) — necesita su propia
          // allocation, exactamente igual que el recargo de un pago
          // standalone. Antes de esta migración se omitía a propósito
          // (`isBatchSurcharge`) porque ese dinero ya estaba una sola vez en
          // la allocation del payment_batch_split del batch; ese camino ya
          // no existe.
          const e = allCashEntryRowsById.get(item.sourceId);
          let method = e.paymentMethod;
          if (e.entryType === "pronto_pago_surcharge" && e.paymentId != null) {
            const linkedPayment = paymentsById.get(e.paymentId);
            if (linkedPayment?.batchId != null) {
              // cash_entries.paymentMethod de un recargo de batch es "lote"
              // (heredado del padre al crearlo, nunca un método real — ver
              // POST /payment-batches) — se usa el método de rendición
              // elegido para la cuota que lo generó, en esta misma request
              // (ya validado como método contable real más arriba).
              const parentItem = paymentSourceItems.find((it: any) => it.sourceId === e.paymentId);
              method = parentItem?.paymentMethod ?? method;
            }
          }
          const instrument = resolveCashEntryInstrument({
            remittanceItemId: row.id, cashEntryId: item.sourceId, method, amountCents: Math.round(e.amount * 100),
          });
          allInstruments.push(instrument);
          collectedSources.push({ kind: "cash_entry", amountCents: Math.round(e.amount * 100) });
        }
        // installment / manual_debt: sin instrumento real, cero allocations.
      }

      const allocationDrafts = buildRemittanceAllocations(allInstruments);
      const expectedCollectedCents = calculateExpectedCollectedCents(collectedSources);

      // ── 6. Validar suma exacta contra instrumentos reales (nunca contra totalPaid) ──
      const totalCheck = validateAllocationTotals(allocationDrafts, expectedCollectedCents);
      if (!totalCheck.valid) {
        throw new RemittanceAllocationValidationError(totalCheck.errorMessage!);
      }
      const state = classifyRemittanceAllocationState({
        allocationCount: allocationDrafts.length,
        allocationSumCents: allocationDrafts.reduce((s, a) => s + a.amountCents, 0),
        expectedCollectedCents,
        createdUnderAllocationsModel: true,
      });
      if (state === "inconsistent") {
        throw new RemittanceAllocationValidationError(
          "Las allocations construidas no son consistentes con el dinero real esperado de esta rendición — abortando antes de insertar nada."
        );
      }

      // ── 7. Insertar allocations ──
      if (allocationDrafts.length > 0) {
        await tx.insert(remittanceAllocations).values(allocationDrafts.map((d) => ({
          remittanceId: rem!.id,
          remittanceItemId: d.remittanceItemId,
          paymentId: d.paymentId,
          paymentSplitId: d.paymentSplitId,
          paymentBatchId: d.paymentBatchId,
          paymentBatchSplitId: d.paymentBatchSplitId,
          receivedCheckId: d.receivedCheckId,
          cashEntryId: d.cashEntryId,
          method: d.method,
          amountCents: d.amountCents,
          createdAt: new Date(),
        })));
      }

      // ── 8. Marcar orígenes como rendered ──
      for (const { item } of insertedItems) {
        if (item.source === "payment") {
          await tx.update(payments).set({ rendered: 1, renderedAt: new Date() }).where(eq(payments.id, item.sourceId));
        } else if (item.source === "cash_entry") {
          await tx.update(cashEntries).set({ rendered: 1, renderedAt: new Date() }).where(eq(cashEntries.id, item.sourceId));
        } else if (item.source === "installment") {
          await tx.update(policyInstallments).set({ rendered: 1, renderedAt: new Date() }).where(eq(policyInstallments.id, item.sourceId));
        }
      }

      return rem!.id;
    });

    return c.json({ ok: true, id: remId });
  } catch (e: any) {
    if (e instanceof RemittanceAllocationValidationError) {
      return c.json({ error: e.message }, 409);
    }
    console.error("[POST /remittances]", e?.message, e);
    return c.json({ error: "No se pudo guardar la rendición" }, 500);
  }
}));

// DELETE /api/remittances/:id — eliminar rendición (des-rinde las cuotas,
// revierte allocations) — transaccional completo (antes no lo era).
app.delete("/remittances/:id", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  try {
    await db.transaction(async (tx) => {
      const rem = await tx.select().from(remittances).where(eq(remittances.id, id)).get();
      if (!rem) throw new RemittanceAllocationValidationError(`La rendición ${id} no existe.`);

      const items = await tx.select().from(remittanceItems).where(eq(remittanceItems.remittanceId, id)).all();
      const allocations = await tx.select().from(remittanceAllocations).where(eq(remittanceAllocations.remittanceId, id)).all();

      // Des-rendir fuentes. Para hijos de batch: cada remittance_item sigue
      // representando un payment hijo puntual — se revierte ese payment como
      // cualquier otro, sin tocar payment_batch_splits ni received_checks (el
      // batch y sus instrumentos reales no se alteran, solo se borran las
      // allocations que los vinculaban a esta rendición).
      for (const item of items as any[]) {
        if (item.source === "payment") {
          await tx.update(payments).set({ rendered: 0, renderedAt: null }).where(eq(payments.id, item.sourceId));
        } else if (item.source === "cash_entry") {
          await tx.update(cashEntries).set({ rendered: 0, renderedAt: null }).where(eq(cashEntries.id, item.sourceId));
        } else if (item.source === "installment") {
          await tx.update(policyInstallments).set({ rendered: 0, renderedAt: null }).where(eq(policyInstallments.id, item.sourceId));
        }
      }

      if (allocations.length > 0) {
        await tx.delete(remittanceAllocations).where(eq(remittanceAllocations.remittanceId, id));
      }
      await tx.delete(remittanceItems).where(eq(remittanceItems.remittanceId, id));
      await tx.delete(remittances).where(eq(remittances.id, id));
    });
    return c.json({ ok: true });
  } catch (e: any) {
    if (e instanceof RemittanceAllocationValidationError) {
      return c.json({ error: e.message }, 404);
    }
    console.error("[DELETE /remittances/:id]", e?.message, e);
    return c.json({ error: "No se pudo eliminar la rendición" }, 500);
  }
}));

// PATCH /api/remittances/items/:id/paid — marcar adeudado como cobrado. Solo
// para manual_debt (deuda de mostrador, sin cuota real detrás) — un
// source="installment" tiene una policy_installment real esperando quedar
// "pagada" y un cobro real que registrar, así que debe pasar siempre por
// POST /remittances/items/:id/collect (ver más abajo), nunca por acá. Sin
// esta guarda, este toggle podía "cerrar" una deuda real sin dejar rastro
// del cobro ni actualizar policy_installments — exactamente la inconsistencia
// que collect existe para evitar.
app.patch("/remittances/items/:id/paid", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  const item = await db.select({ source: remittanceItems.source }).from(remittanceItems)
    .where(eq(remittanceItems.id, id)).get();
  if (item?.source === "installment") {
    return c.json({
      error: "Esta adeudada corresponde a una cuota real — registrá el cobro con POST /remittances/items/:id/collect, no con este endpoint.",
    }, 409);
  }
  await db.update(remittanceItems).set({ debtorStatus: "pagado", paidAt: new Date() })
    .where(eq(remittanceItems.id, id));
  return c.json({ ok: true });
}));

// POST /api/remittances/items/:id/collect — cobro real posterior de una
// cuota que se rindió como adeudada (source="installment"): el asegurado le
// paga a Curini el importe que la agencia ya había adelantado a la compañía
// al rendirla (ver GUARD de POST /remittances más abajo, sección "installment
// / manual_debt: sin instrumento real"). Cierra la deuda con un payment real
// que nace YA rendido (rendered=1) — esa plata NUNCA vuelve a rendirse a la
// compañía, porque ya fue reportada como adeudada en su momento. No crea
// remittance_allocations (no hay instrumento de rendición nuevo que
// reconciliar: esto no es una rendición, es el cierre de una deuda) ni toca
// la rendición original salvo el estado de este ítem puntual.
app.post("/remittances/items/:id/collect", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  if (body.paymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.paymentDate)) {
    return c.json({ error: "Formato de fecha de pago inválido. Use YYYY-MM-DD." }, 400);
  }

  try {
    const payment = await db.transaction(async (tx) => {
      // Reconsultar dentro de la tx (mismo criterio que POST /remittances):
      // nunca confiar en un estado leído antes de tomar el lock de escritura.
      const item = await tx.select().from(remittanceItems).where(eq(remittanceItems.id, id)).get();
      if (!item) throw new RemittanceAllocationValidationError(`El ítem de rendición ${id} no existe.`);
      if (item.source !== "installment") {
        throw new RemittanceAllocationValidationError(
          `El ítem ${id} no corresponde a una cuota real (source="${item.source}") — solo cuotas reales pueden cobrarse por esta vía.`
        );
      }
      if (item.debtorStatus !== "adeudado") {
        throw new RemittanceAllocationValidationError(
          `El ítem ${id} no está adeudado (debtorStatus="${item.debtorStatus}") — ya fue cobrado o nunca fue una deuda.`
        );
      }
      if (item.sourceId == null) {
        throw new RemittanceAllocationValidationError(`El ítem ${id} no tiene una cuota real vinculada (sourceId nulo).`);
      }

      const installmentRow = await tx.select({
        id: policyInstallments.id, amount: policyInstallments.amount,
        policyId: policyInstallments.policyId, status: policyInstallments.status,
      }).from(policyInstallments).where(eq(policyInstallments.id, item.sourceId)).get();
      if (!installmentRow) throw new RemittanceAllocationValidationError(`La cuota ${item.sourceId} no existe.`);
      // Mismo criterio que POST /payments: nunca un segundo pago confirmado
      // sobre una cuota ya pagada — acá además es la señal de que este mismo
      // collect ya se ejecutó antes (double-submit), incluso si por alguna
      // corrupción de datos debtorStatus no se llegó a actualizar.
      if (installmentRow.status === "pagada") {
        throw new RemittanceAllocationValidationError(`La cuota ${item.sourceId} ya está pagada.`);
      }

      // Nunca pagos parciales (mismo invariante que POST /payments): el
      // importe del cobro es siempre el de la cuota real, nunca lo que
      // mande el body — solo su desglose de medios puede variar.
      const rawSplits = Array.isArray(body.splits) && body.splits.length > 0
        ? body.splits
        : [{ method: body.paymentMethod, amount: installmentRow.amount, notes: null }];

      let normalizedSplits;
      try {
        normalizedSplits = validateAndNormalizeSplits({ paymentAmount: installmentRow.amount, splits: rawSplits });
      } catch (e: any) {
        if (e instanceof SplitValidationError) throw new RemittanceAllocationValidationError(e.message);
        throw e;
      }

      const splitGroup = classifySplitGroup(normalizedSplits.splits);
      if (splitGroup === "mixed") {
        throw new RemittanceAllocationValidationError(
          "No se pueden combinar medios propios con pagos directos a la compañía en el cobro de una adeudada."
        );
      }

      let splitsWithChecks: { method: string; amountCents: number; notes: string | null; checks: NormalizedReceivedCheck[] }[];
      try {
        splitsWithChecks = normalizedSplits.splits.map((split, i) => {
          const rawChecks = rawSplits[i]?.checks;
          if (split.method === "cheque") {
            if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
              throw new ReceivedCheckValidationError(`El medio de pago cheque (ítem ${i + 1}) debe incluir al menos un cheque.`);
            }
            const checks = rawChecks.map((raw: any, j: number) => normalizeReceivedCheck(raw, `cheque ${j + 1} del ítem ${i + 1}`));
            const totalsCheck = validateChecksMatchSplit(checks, split.amountCents);
            if (!totalsCheck.valid) throw new ReceivedCheckValidationError(totalsCheck.errorMessage!);
            return { ...split, checks };
          }
          if (Array.isArray(rawChecks) && rawChecks.length > 0) {
            throw new ReceivedCheckValidationError(`El ítem ${i + 1} (${split.method}) no puede incluir cheques.`);
          }
          return { ...split, checks: [] };
        });
      } catch (e: any) {
        if (e instanceof ReceivedCheckValidationError) throw new RemittanceAllocationValidationError(e.message);
        throw e;
      }

      const resolvedPaymentMethod = normalizedSplits.splits.length === 1
        ? normalizedSplits.splits[0]!.method
        : "combinado";

      const [p] = await tx.insert(payments).values({
        policyId: installmentRow.policyId,
        installmentId: installmentRow.id,
        amount: installmentRow.amount,
        paymentMethod: resolvedPaymentMethod,
        paymentDate: body.paymentDate || toArgentinaCalendarDay(),
        notes: body.notes || null,
        status: "confirmado",
        // Nace YA rendido — ver comentario del endpoint. Nunca debe
        // ofrecerse en /remittances/pending ni en los selectores de cobro
        // (que ya excluyen policy_installments.rendered=1, no payments.
        // rendered, así que esto es lo único que lo saca de circulación).
        rendered: 1,
        renderedAt: new Date(),
        createdBy: user?.id || null,
      }).returning();

      for (const s of splitsWithChecks) {
        const [insertedSplit] = await tx.insert(paymentSplits).values({
          paymentId: p!.id, method: s.method, amountCents: s.amountCents, notes: s.notes,
        }).returning();
        if (s.checks.length > 0) {
          await tx.insert(receivedChecks).values(s.checks.map((chk) => ({
            paymentSplitId: insertedSplit!.id,
            checkNumber: chk.checkNumber,
            bankName: chk.bankName,
            bankCode: chk.bankCode,
            drawerName: chk.drawerName,
            drawerDocument: chk.drawerDocument,
            issueDate: chk.issueDate,
            dueDate: chk.dueDate,
            amountCents: chk.amountCents,
            currency: chk.currency,
            status: "en_cartera",
            notes: chk.notes,
            receivedAt: new Date(),
            createdBy: user.id,
            createdAt: new Date(),
            updatedAt: new Date(),
          })));
        }
      }

      // Cierre atómico: la cuota real queda pagada y el ítem de rendición
      // deja de estar adeudado — nunca se toca remittances (la rendición
      // original) ni se crea una allocation nueva (sección "NO" del pedido).
      await tx.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, installmentRow.id));
      await tx.update(remittanceItems).set({ debtorStatus: "pagado", paidAt: new Date() }).where(eq(remittanceItems.id, id));

      return p!;
    });

    const splitsRows = await db.select().from(paymentSplits).where(eq(paymentSplits.paymentId, payment.id)).all();
    return c.json({ ok: true, payment: { ...payment, splits: splitsRows } }, 201);
  } catch (e: any) {
    if (e instanceof RemittanceAllocationValidationError) {
      return c.json({ error: e.message }, 409);
    }
    console.error("[POST /remittances/items/:id/collect]", e?.message, e);
    return c.json({ error: "No se pudo registrar el cobro" }, 500);
  }
}));

// GET /api/remittances/uncollected — cuotas no cobradas y no rendidas (para rendir sin cobro previo)
// Filtros opcionales: ?insured=&policy=&company=&month=YYYY-MM
app.get("/remittances/uncollected", requireAuth(async (c: any) => {
  const { insured: insuredQ, policy: policyQ, company: companyQ, month } = c.req.query();

  let rows = await db
    .select({
      id: policyInstallments.id,
      policyId: policyInstallments.policyId,
      number: policyInstallments.number,
      dueDate: policyInstallments.dueDate,
      amount: policyInstallments.amount,
      status: policyInstallments.status,
      insuredName: insureds.name,
      policyNumber: policies.policyNumber,
      companyName: companies.name,
    })
    .from(policyInstallments)
    .innerJoin(policies, eq(policyInstallments.policyId, policies.id))
    .innerJoin(insureds, eq(policies.insuredId, insureds.id))
    .innerJoin(companies, eq(policies.companyId, companies.id))
    .where(and(
      ne(policyInstallments.status, "pagada"),
      ne(policyInstallments.status, "no_exigible"),
      eq(policyInstallments.rendered, 0),
      ne(policies.status, "cancelada"),
    ))
    .orderBy(asc(policyInstallments.dueDate))
    .all();

  if (insuredQ) rows = rows.filter((r: any) => r.insuredName?.toLowerCase().includes(insuredQ.toLowerCase()));
  if (policyQ) rows = rows.filter((r: any) => r.policyNumber?.toLowerCase().includes(policyQ.toLowerCase()));
  if (companyQ) rows = rows.filter((r: any) => r.companyName?.toLowerCase().includes(companyQ.toLowerCase()));
  if (month) rows = rows.filter((r: any) => r.dueDate?.startsWith(month));

  return c.json(rows);
}));

// GET /api/remittances/pending — cobros aún no rendidos (para seleccionar al crear rendición)
app.get("/remittances/pending", requireAuth(async (c: any) => {
  // payments no rendidos y confirmados
  const pendingPayments = await db
    .select({
      id: payments.id,
      amount: payments.amount,
      paymentMethod: payments.paymentMethod,
      paymentDate: payments.paymentDate,
      policyId: payments.policyId,
      batchId: payments.batchId,
      manualPayer: payments.manualPayer,
      manualPolicyNumber: payments.manualPolicyNumber,
      manualCompany: payments.manualCompany,
      notes: payments.notes,
      insuredName: insureds.name,
      policyNumber: policies.policyNumber,
      companyName: companies.name,
      installmentDueDate: policyInstallments.dueDate,
      paymentDueDate: payments.dueDate,
    })
    .from(payments)
    .leftJoin(policies, eq(payments.policyId, policies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .leftJoin(policyInstallments, eq(payments.installmentId, policyInstallments.id))
    .where(and(eq(payments.rendered, 0), eq(payments.status, "confirmado")))
    .orderBy(desc(payments.paymentDate))
    .all();

  // cashEntries no rendidas — nunca una anulada (ej. el recargo Pronto Pago
  // de un payment_batches cancelado, ver POST /payment-batches/:id/cancel).
  // Defensa adicional: POST /remittances ya rechaza igual cualquier
  // cash_entry de tipo pronto_pago_surcharge enviado a mano, pero no tiene
  // sentido seguir ofreciéndola acá para elegir.
  const pendingEntries = await db.select().from(cashEntries)
    .where(and(eq(cashEntries.rendered, 0), eq(cashEntries.status, "activo")))
    .orderBy(desc(cashEntries.paymentDate))
    .all();

  const pendingPaymentIds = pendingPayments.map((p: any) => p.id as number);
  const surchargePmtSet = new Set<number>();
  // Etapa 3B: se expone el desglose de splits y su grupo (own/direct_company)
  // de forma aditiva — paymentMethod puede seguir siendo "combinado" (útil
  // para listados legacy), pero el modal de rendición necesita esto para
  // clasificar correctamente propios vs. directo a compañía sin adivinar a
  // partir de un string resumen que no representa ningún método real.
  const splitsByPaymentId = new Map<number, { method: string; amountCents: number; notes: string | null }[]>();
  if (pendingPaymentIds.length > 0) {
    const sRows = await db.select({ paymentId: cashEntries.paymentId })
      .from(cashEntries)
      .where(and(inArray(cashEntries.paymentId, pendingPaymentIds), eq(cashEntries.entryType, "pronto_pago_surcharge"), eq(cashEntries.rendered, 0)))
      .all();
    for (const s of sRows) { if (s.paymentId != null) surchargePmtSet.add(s.paymentId); }

    const splitRows = await db.select({
      paymentId: paymentSplits.paymentId, method: paymentSplits.method,
      amountCents: paymentSplits.amountCents, notes: paymentSplits.notes,
    }).from(paymentSplits).where(inArray(paymentSplits.paymentId, pendingPaymentIds))
      .orderBy(asc(paymentSplits.id)).all();
    for (const s of splitRows) {
      const arr = splitsByPaymentId.get(s.paymentId) ?? [];
      arr.push({ method: s.method, amountCents: s.amountCents, notes: s.notes });
      splitsByPaymentId.set(s.paymentId, arr);
    }
  }

  const result = [
    ...pendingPayments.map((p: any) => {
      const splits = splitsByPaymentId.get(p.id) ?? [];
      const paymentGroup: SplitGroup | null = splits.length > 0 ? classifySplitGroup(splits) : null;
      return {
        source: "payment" as const,
        sourceId: p.id,
        amount: p.amount,
        paymentMethod: p.paymentMethod,
        // Rendición por cuota (Migración 0029): el frontend necesita saber
        // si este payment es hijo de un cobro por lote (batchId != null) para
        // saber si el "medio de rendición" que el usuario elija en el modal
        // realmente reemplaza el instrumento contable (hijo de lote, sí) o
        // es solo informativo (standalone, pendiente de backend — ver
        // resolveStandalonePaymentInstruments, que sigue atado a los
        // payment_splits reales).
        batchId: p.batchId,
        paymentDate: p.paymentDate,
        dueDate: (p.installmentDueDate as string | null) ?? (p.paymentDueDate as string | null) ?? null,
        clientName: p.insuredName || p.manualPayer || "—",
        policyNumber: p.policyNumber || p.manualPolicyNumber || "—",
        companyName: p.companyName || p.manualCompany || "—",
        notes: p.notes,
        // Defensa (hotfix Pronto Pago Rivadavia): igual que en POST
        // /remittances, la sola presencia del cash_entry no alcanza — si el
        // pago fue editado después a otra compañía sin pasar por
        // applyProntoPagoSurcharge, el cash_entry puede haber quedado
        // huérfano. Re-validar contra la compañía ACTUAL evita que el
        // preview del modal muestre un recargo que el backend no va a
        // cobrar (y viceversa).
        hasSurcharge: surchargePmtSet.has(p.id) && String(p.companyName ?? p.manualCompany ?? "").toLowerCase().includes("rivadavia"),
        splits,
        paymentGroup,
      };
    }),
    ...pendingEntries.map((e: any) => ({
      source: "cash_entry" as const,
      sourceId: e.id,
      amount: e.amount,
      paymentMethod: e.paymentMethod,
      paymentDate: e.paymentDate,
      dueDate: (e.dueDate as string | null) ?? null,
      clientName: e.clientName,
      policyNumber: e.policyNumber || "—",
      companyName: e.companyName || "—",
      notes: e.notes,
      entryType: e.entryType,
      splits: null as null,
      paymentGroup: (isDirectCompanyPaymentMethod(e.paymentMethod as string) ? "direct_company" : "own") as SplitGroup,
    })),
  ].sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));

  return c.json(result);
}));

// GET /api/remittances/adeudados — items adeudados no cobrados aún
app.get("/remittances/adeudados", requireAuth(async (c: any) => {
  const items = await db.select({
    id: remittanceItems.id,
    remittanceId: remittanceItems.remittanceId,
    source: remittanceItems.source,
    sourceId: remittanceItems.sourceId,
    amount: remittanceItems.amount,
    clientName: remittanceItems.clientName,
    policyNumber: remittanceItems.policyNumber,
    companyName: remittanceItems.companyName,
    paymentMethod: remittanceItems.paymentMethod,
    createdAt: remittanceItems.createdAt,
    paidAt: remittanceItems.paidAt,
    remittanceDate: remittances.date,
    remittanceCanal: remittances.canal,
  })
    .from(remittanceItems)
    .innerJoin(remittances, eq(remittanceItems.remittanceId, remittances.id))
    .where(eq(remittanceItems.debtorStatus, "adeudado"))
    .orderBy(desc(remittances.date))
    .all();

  // Solo los no pagados (paidAt null)
  const unpaid = items.filter((i: any) => !i.paidAt);
  return c.json(unpaid);
}));

// ─────────────────────────────────────────────────────────────────────────────
// GASTOS (cash expenses)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/cash/expenses
app.get("/cash/expenses", requireAuth(async (c: any) => {
  const user = c.get("user");
  const isAdmin = user?.role === "admin";
  const rows = isAdmin
    ? await db.select().from(cashExpenses).where(ne(cashExpenses.status, "anulado")).orderBy(desc(cashExpenses.date)).all()
    : await db.select().from(cashExpenses).where(and(eq(cashExpenses.type, "gasto_operativo"), ne(cashExpenses.status, "anulado"))).orderBy(desc(cashExpenses.date)).all();
  return c.json(rows);
}));

// POST /api/cash/expenses
app.post("/cash/expenses", requireAuth(async (c: any) => {
  const user = c.get("user");
  const isAdmin = user?.role === "admin";
  const body = await c.req.json();

  if (!body.date || !CAJA_DATE_RE.test(body.date) || !cajaIsRealDate(body.date))
    return c.json({ error: "Fecha inválida. Formato esperado: YYYY-MM-DD" }, 400);

  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0)
    return c.json({ error: "El monto debe ser mayor a cero" }, 400);

  const type = body.type ?? "gasto_operativo";
  if (!["gasto_operativo", "sueldo"].includes(type))
    return c.json({ error: "type inválido. Valores: gasto_operativo | sueldo" }, 400);
  if (type === "sueldo" && !isAdmin)
    return c.json({ error: "Solo administradores pueden registrar sueldos" }, 403);

  const paymentMethod = body.paymentMethod ?? "efectivo";
  if (!["efectivo", "transferencia"].includes(paymentMethod))
    return c.json({ error: "paymentMethod inválido. Valores: efectivo | transferencia" }, 400);

  const status = body.status ?? "registrado";
  if (!["registrado", "conciliado", "anulado"].includes(status))
    return c.json({ error: "status inválido. Valores: registrado | conciliado | anulado" }, 400);
  if (status === "conciliado" && !isAdmin)
    return c.json({ error: "Solo administradores pueden marcar gastos como conciliados" }, 403);

  const payeeName = body.payeeName || null;
  const salaryPeriod = body.salaryPeriod || null;

  if (type === "sueldo") {
    if (!payeeName)
      return c.json({ error: "Para sueldos, payeeName es obligatorio" }, 400);
    if (!salaryPeriod || !CAJA_MONTH_RE.test(salaryPeriod))
      return c.json({ error: "Para sueldos, salaryPeriod es obligatorio y debe tener formato YYYY-MM" }, 400);
  }
  if (salaryPeriod && !CAJA_MONTH_RE.test(salaryPeriod))
    return c.json({ error: "salaryPeriod inválido. Formato esperado: YYYY-MM" }, 400);

  const reconciledAt = status === "conciliado" ? new Date() : null;

  const result = await db.insert(cashExpenses).values({
    date: body.date,
    description: body.description,
    amount,
    category: body.category || null,
    notes: body.notes || null,
    type,
    paymentMethod,
    payeeName,
    salaryPeriod,
    status,
    reconciledAt,
    createdBy: user.id,
  }).returning().get();
  return c.json(result, 201);
}));

// PUT /api/cash/expenses/:id
app.put("/cash/expenses/:id", requireAuth(async (c: any) => {
  const user = c.get("user");
  const isAdmin = user?.role === "admin";
  const id = Number(c.req.param("id"));
  const body = await c.req.json();

  const existing = await db.select().from(cashExpenses).where(eq(cashExpenses.id, id)).get();
  if (!existing) return c.json({ error: "No encontrado" }, 404);
  if (existing.type === "sueldo" && !isAdmin)
    return c.json({ error: "Solo administradores pueden modificar sueldos" }, 403);

  if (!body.date || !CAJA_DATE_RE.test(body.date) || !cajaIsRealDate(body.date))
    return c.json({ error: "Fecha inválida. Formato esperado: YYYY-MM-DD" }, 400);

  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0)
    return c.json({ error: "El monto debe ser mayor a cero" }, 400);

  const type = body.type ?? existing.type ?? "gasto_operativo";
  if (!["gasto_operativo", "sueldo"].includes(type))
    return c.json({ error: "type inválido. Valores: gasto_operativo | sueldo" }, 400);
  if (type === "sueldo" && !isAdmin)
    return c.json({ error: "Solo administradores pueden registrar sueldos" }, 403);

  const paymentMethod = body.paymentMethod ?? existing.paymentMethod ?? "efectivo";
  if (!["efectivo", "transferencia"].includes(paymentMethod))
    return c.json({ error: "paymentMethod inválido. Valores: efectivo | transferencia" }, 400);

  const status = body.status ?? existing.status ?? "registrado";
  if (!["registrado", "conciliado", "anulado"].includes(status))
    return c.json({ error: "status inválido. Valores: registrado | conciliado | anulado" }, 400);
  if (status === "conciliado" && !isAdmin)
    return c.json({ error: "Solo administradores pueden marcar gastos como conciliados" }, 403);

  const payeeName = body.payeeName !== undefined ? (body.payeeName || null) : existing.payeeName;
  const salaryPeriod = body.salaryPeriod !== undefined ? (body.salaryPeriod || null) : existing.salaryPeriod;

  if (type === "sueldo") {
    if (!payeeName)
      return c.json({ error: "Para sueldos, payeeName es obligatorio" }, 400);
    if (!salaryPeriod || !CAJA_MONTH_RE.test(salaryPeriod))
      return c.json({ error: "Para sueldos, salaryPeriod es obligatorio y debe tener formato YYYY-MM" }, 400);
  }
  if (salaryPeriod && !CAJA_MONTH_RE.test(salaryPeriod))
    return c.json({ error: "salaryPeriod inválido. Formato esperado: YYYY-MM" }, 400);

  let reconciledAt: Date | null = existing.reconciledAt ?? null;
  if (status === "conciliado" && !reconciledAt) reconciledAt = new Date();
  if (status !== "conciliado") reconciledAt = null;

  const result = await db.update(cashExpenses).set({
    date: body.date,
    description: body.description,
    amount,
    category: body.category !== undefined ? (body.category || null) : existing.category,
    notes: body.notes !== undefined ? (body.notes || null) : existing.notes,
    type,
    paymentMethod,
    payeeName,
    salaryPeriod,
    status,
    reconciledAt,
  }).where(eq(cashExpenses.id, id)).returning().get();
  return c.json(result);
}));

// DELETE /api/cash/expenses/:id — soft-delete: marca status = 'anulado'.
app.delete("/cash/expenses/:id", requireAuth(async (c: any) => {
  const user = c.get("user");
  const isAdmin = user?.role === "admin";
  const id = Number(c.req.param("id"));
  const existing = await db.select().from(cashExpenses).where(eq(cashExpenses.id, id)).get();
  if (!existing) return c.json({ error: "No encontrado" }, 404);
  if (existing.type === "sueldo" && !isAdmin)
    return c.json({ error: "Solo administradores pueden anular sueldos" }, 403);
  await db.update(cashExpenses).set({ status: "anulado" }).where(eq(cashExpenses.id, id));
  return c.json({ ok: true, anulado: true });
}));

// ─── COMISIONES ──────────────────────────────────────────────────────────────

// GET /api/cash/commissions
app.get("/cash/commissions", requireAdmin(async (c: any) => {
  const rows = await db
    .select({
      id: commissionEntries.id,
      date: commissionEntries.date,
      amount: commissionEntries.amount,
      companyId: commissionEntries.companyId,
      companyName: companies.name,
      notes: commissionEntries.notes,
      paymentMethod: commissionEntries.paymentMethod,
      periodMonth: commissionEntries.periodMonth,
      status: commissionEntries.status,
      createdBy: commissionEntries.createdBy,
      createdAt: commissionEntries.createdAt,
    })
    .from(commissionEntries)
    .leftJoin(companies, eq(commissionEntries.companyId, companies.id))
    .orderBy(desc(commissionEntries.date))
    .all();
  return c.json(rows);
}));

// POST /api/cash/commissions
app.post("/cash/commissions", requireAdmin(async (c: any) => {
  const user = c.get("cajaUser") || c.get("user");
  const body = await c.req.json();

  if (!body.date || !CAJA_DATE_RE.test(body.date) || !cajaIsRealDate(body.date))
    return c.json({ error: "Fecha inválida. Formato esperado: YYYY-MM-DD" }, 400);

  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0)
    return c.json({ error: "El monto debe ser mayor a cero" }, 400);

  const paymentMethod = body.paymentMethod ?? "transferencia";
  if (!["efectivo", "transferencia"].includes(paymentMethod))
    return c.json({ error: "paymentMethod inválido. Valores: efectivo | transferencia" }, 400);

  const periodMonth = body.periodMonth ?? null;
  if (periodMonth !== null && !CAJA_MONTH_RE.test(periodMonth))
    return c.json({ error: "periodMonth inválido. Formato esperado: YYYY-MM (ej. 2025-06)" }, 400);

  const status = body.status ?? "registrado";
  if (!["registrado", "anulado"].includes(status))
    return c.json({ error: "status inválido. Valores: registrado | anulado" }, 400);

  const result = await db.insert(commissionEntries).values({
    companyId: body.companyId ? Number(body.companyId) : null,
    date: body.date,
    amount,
    notes: body.notes || null,
    paymentMethod,
    periodMonth,
    status,
    createdBy: user?.id ?? null,
  }).returning().get();
  return c.json(result, 201);
}));

// PUT /api/cash/commissions/:id
app.put("/cash/commissions/:id", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();

  if (!body.date || !CAJA_DATE_RE.test(body.date) || !cajaIsRealDate(body.date))
    return c.json({ error: "Fecha inválida. Formato esperado: YYYY-MM-DD" }, 400);

  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0)
    return c.json({ error: "El monto debe ser mayor a cero" }, 400);

  const paymentMethod = body.paymentMethod ?? "transferencia";
  if (!["efectivo", "transferencia"].includes(paymentMethod))
    return c.json({ error: "paymentMethod inválido. Valores: efectivo | transferencia" }, 400);

  const periodMonth = body.periodMonth ?? null;
  if (periodMonth !== null && !CAJA_MONTH_RE.test(periodMonth))
    return c.json({ error: "periodMonth inválido. Formato esperado: YYYY-MM" }, 400);

  const status = body.status ?? "registrado";
  if (!["registrado", "anulado"].includes(status))
    return c.json({ error: "status inválido. Valores: registrado | anulado" }, 400);

  const result = await db.update(commissionEntries).set({
    companyId: body.companyId ? Number(body.companyId) : null,
    date: body.date,
    amount,
    notes: body.notes || null,
    paymentMethod,
    periodMonth,
    status,
  }).where(eq(commissionEntries.id, id)).returning().get();
  if (!result) return c.json({ error: "No encontrado" }, 404);
  return c.json(result);
}));

// DELETE /api/cash/commissions/:id — soft-delete: marca status = 'anulado'.
// Se preserva el historial ahora que existe el campo status; el DELETE físico
// quedaría sin audit trail y rompería cálculos retrospectivos.
app.delete("/cash/commissions/:id", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  const result = await db.update(commissionEntries)
    .set({ status: "anulado" })
    .where(eq(commissionEntries.id, id))
    .returning().get();
  if (!result) return c.json({ error: "No encontrado" }, 404);
  return c.json({ ok: true, anulado: true });
}));

// ─── IVA ─────────────────────────────────────────────────────────────────────

// GET /api/cash/iva
app.get("/cash/iva", requireAdmin(async (c: any) => {
  const rows = await db
    .select({ id: ivaEntries.id, date: ivaEntries.date, amount: ivaEntries.amount, companyId: ivaEntries.companyId, companyName: companies.name, notes: ivaEntries.notes, createdAt: ivaEntries.createdAt })
    .from(ivaEntries)
    .leftJoin(companies, eq(ivaEntries.companyId, companies.id))
    .orderBy(desc(ivaEntries.date))
    .all();
  return c.json(rows);
}));

// POST /api/cash/iva
app.post("/cash/iva", requireAdmin(async (c: any) => {
  const body = await c.req.json();
  const result = await db.insert(ivaEntries).values({
    companyId: body.companyId ? Number(body.companyId) : null,
    date: body.date,
    amount: Number(body.amount),
    notes: body.notes || null,
  }).returning().get();
  return c.json(result, 201);
}));

// PUT /api/cash/iva/:id
app.put("/cash/iva/:id", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const result = await db.update(ivaEntries).set({
    companyId: body.companyId ? Number(body.companyId) : null,
    date: body.date,
    amount: Number(body.amount),
    notes: body.notes || null,
  }).where(eq(ivaEntries.id, id)).returning().get();
  if (!result) return c.json({ error: "No encontrado" }, 404);
  return c.json(result);
}));

// DELETE /api/cash/iva/:id
app.delete("/cash/iva/:id", requireAdmin(async (c: any) => {
  const id = Number(c.req.param("id"));
  await db.delete(ivaEntries).where(eq(ivaEntries.id, id));
  return c.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────────

export default app;
export type AppType = typeof app;
