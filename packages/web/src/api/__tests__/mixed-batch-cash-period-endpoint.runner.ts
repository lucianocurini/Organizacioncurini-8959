/**
 * Runner de PROCESO HIJO para mixed-batch-cash-period-endpoint.test.ts —
 * contado por período dentro de un lote mixto (Migración 0037).
 *
 * Mismo aislamiento que individual-account-funded-endpoint.runner.ts:
 * `app`/`database` se importan por primera vez en este proceso nuevo,
 * apuntando a una SQLite descartable creada acá con el esquema real
 * (migraciones .sql + aplicadores 0035/0036/0037). Nunca dev.db ni Turso.
 * Todos los datos son sintéticos (prefijo TEST-MIX).
 *
 * No matchea *.test.ts: solo lo lanza el wrapper vía Bun.spawn. Imprime una
 * línea "RESULT_JSON:{...}" y termina con exit 0 solo si todo pasó.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SESSION_ID = "test-session-mixed-cash-period-001";
const USER_EMAIL = "test-mixed-cash-period@test.local";
const PREFIX = "TEST-MIX";
const PAYMENT_DATE = "2028-02-01";

const tmpDir = mkdtempSync(join(tmpdir(), "mixed-batch-cash-period-"));
const dbPath = join(tmpDir, "disposable.db");

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.DATABASE_AUTH_TOKEN = "local-test-disposable";
if (process.env.DATABASE_URL !== `file:${dbPath}` || process.env.DATABASE_URL.toLowerCase().includes("dev.db")) {
  console.error("REFUSED: DATABASE_URL no apunta exactamente al archivo temporal de este runner.");
  process.exit(1);
}

interface CheckResult { name: string; pass: boolean; message?: string }
const results: CheckResult[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (e: any) {
    results.push({ name, pass: false, message: String(e?.stack ?? e?.message ?? e) });
  }
}
function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: esperado ${JSON.stringify(expected)}, obtuve ${JSON.stringify(actual)}`);
}
function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(`${label}: esperado true`);
}

// ─── Esquema real descartable (mismo bootstrap que los demás runners) ──────
function bootstrapPreMigrationTables(sqlite: Database): void {
  sqlite.run(`CREATE TABLE policy_installments (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL, policy_id integer NOT NULL, number integer NOT NULL,
    due_date text NOT NULL, amount real NOT NULL, status text NOT NULL DEFAULT 'pendiente', notes text, created_at integer,
    FOREIGN KEY (policy_id) REFERENCES policies(id) ON UPDATE no action ON DELETE no action
  )`);
  sqlite.run(`CREATE TABLE task_templates (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL, title text NOT NULL, description text, day_of_month integer,
    "order" integer NOT NULL DEFAULT 0, active integer NOT NULL DEFAULT 1, is_admin_only integer NOT NULL DEFAULT 0,
    created_by integer, created_at integer,
    FOREIGN KEY (created_by) REFERENCES users(id) ON UPDATE no action ON DELETE no action
  )`);
  sqlite.run(`CREATE TABLE tasks (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL, template_id integer, month_year text NOT NULL, title text NOT NULL,
    description text, due_date text, status text NOT NULL DEFAULT 'pendiente', is_recurring integer NOT NULL DEFAULT 0,
    is_admin_only integer NOT NULL DEFAULT 0, created_by integer, created_at integer, completed_at integer,
    FOREIGN KEY (template_id) REFERENCES task_templates(id) ON UPDATE no action ON DELETE no action,
    FOREIGN KEY (created_by) REFERENCES users(id) ON UPDATE no action ON DELETE no action
  )`);
}

async function buildDisposableSchema(path: string): Promise<void> {
  const { applyMigration0035TraceableDuplicateInvalidation } = await import("../../lib/migrations/apply-0035-traceable-duplicate-invalidation");
  const { applyMigration0036AccountHolderFunding } = await import("../../lib/migrations/apply-0036-account-holder-funding");
  const { applyMigration0037CashPeriodPaymentChildren } = await import("../../lib/migrations/apply-0037-cash-period-payment-children");
  const sqlite = new Database(path);
  try {
    sqlite.run("PRAGMA foreign_keys=ON");
    bootstrapPreMigrationTables(sqlite);
    const migrationsDir = join(import.meta.dir, "..", "migrations");
    // 0037 se aplica con su aplicador (valida integridad), no como .sql suelto.
    const excluded = new Set(["0035_traceable_duplicate_invalidation.sql", "0036_account_holder_funding.sql", "0037_cash_period_payment_children.sql"]);
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql") && !excluded.has(f)).sort()) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      for (const stmt of sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) sqlite.run(stmt);
    }
    sqlite.run(`ALTER TABLE policies ADD COLUMN is_fleet integer NOT NULL DEFAULT 0`);
    sqlite.run(`ALTER TABLE policies ADD COLUMN is_rebilling integer NOT NULL DEFAULT 0`);
    sqlite.run(`ALTER TABLE policies ADD COLUMN renewed_from_id integer`);
    sqlite.run(`ALTER TABLE policies ADD COLUMN parent_policy_id integer`);
    sqlite.run(`ALTER TABLE insureds ADD COLUMN created_by integer REFERENCES users(id)`);
    sqlite.run(`ALTER TABLE payments ADD COLUMN installment_id integer REFERENCES policy_installments(id)`);
    const sqlClient = {
      async execute(sql: string, params: unknown[] = []) {
        const stmt = sqlite.prepare(sql);
        try {
          const upper = sql.trim().toUpperCase();
          if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) return { rows: stmt.all(...(params as any[])) as any[] };
          stmt.run(...(params as any[]));
          return { rows: [] };
        } finally {
          stmt.finalize();
        }
      },
    };
    await applyMigration0035TraceableDuplicateInvalidation(sqlClient as any);
    await applyMigration0036AccountHolderFunding(sqlClient as any);
    await applyMigration0037CashPeriodPaymentChildren(sqlClient as any);
  } finally {
    sqlite.close();
  }
}

async function main(): Promise<void> {
  await buildDisposableSchema(dbPath);

  const { default: app } = await import("../index");
  const { database: db } = await import("../database/index");
  const schema = await import("../database/schema");
  const { eq, and, isNull } = await import("drizzle-orm");
  const { SURCHARGE_AMOUNT_CENTS } = await import("../../lib/payments/batches");

  const [u] = await db.insert(schema.users).values({
    name: "QA Lote mixto", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: schema.users.id });
  const userId = u!.id;
  await db.insert(schema.sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const [coA] = await db.insert(schema.companies).values({ name: `${PREFIX} Compañía A` }).returning({ id: schema.companies.id });
  const [coB] = await db.insert(schema.companies).values({ name: `${PREFIX} Compañía B` }).returning({ id: schema.companies.id });
  const [coR] = await db.insert(schema.companies).values({ name: `${PREFIX} Rivadavia Seguros` }).returning({ id: schema.companies.id });
  const companyA = coA!.id, companyB = coB!.id, rivadavia = coR!.id;

  let seq = 0;
  async function mkInsured(): Promise<number> {
    const [ins] = await db.insert(schema.insureds).values({ name: `${PREFIX} Asegurado ${++seq}`, createdBy: userId }).returning({ id: schema.insureds.id });
    return ins!.id;
  }
  async function mkPolicy(insuredId: number, companyId: number): Promise<number> {
    const [p] = await db.insert(schema.policies).values({
      policyNumber: `${PREFIX}-${++seq}`, type: "automotor", status: "activa",
      companyId, insuredId, startDate: "2028-01-01", endDate: "2028-12-31", isRebilling: 0, createdBy: userId,
    }).returning({ id: schema.policies.id });
    return p!.id;
  }
  async function mkInstallment(policyId: number, amount: number, rebillingId: number | null = null): Promise<number> {
    const [row] = await db.insert(schema.policyInstallments).values({
      policyId, number: ++seq, dueDate: PAYMENT_DATE, amount, status: "pendiente", rendered: 0, rebillingId,
    }).returning({ id: schema.policyInstallments.id });
    return row!.id;
  }
  /** Póliza con una refacturación de 3 cuotas de $10.000 y contado de $27.000 (compañía A por defecto). */
  async function refacturada(companyId = companyA) {
    const insuredId = await mkInsured();
    const policyId = await mkPolicy(insuredId, companyId);
    const [rb] = await db.insert(schema.rebillings).values({
      policyId, billingStart: "2028-01-01", billingEnd: "2028-12-31", installmentCount: 3, cashPaymentAmountCents: 2700000, createdBy: userId,
    }).returning({ id: schema.rebillings.id });
    const rebillingId = rb!.id;
    const installmentIds = [
      await mkInstallment(policyId, 10000, rebillingId),
      await mkInstallment(policyId, 10000, rebillingId),
      await mkInstallment(policyId, 10000, rebillingId),
    ];
    return { insuredId, policyId, rebillingId, installmentIds };
  }
  /** Otra póliza con 2 cuotas comunes de $5.000 (compañía B por defecto). */
  async function comun(companyId = companyB) {
    const insuredId = await mkInsured();
    const policyId = await mkPolicy(insuredId, companyId);
    const installmentIds = [await mkInstallment(policyId, 5000), await mkInstallment(policyId, 5000)];
    return { insuredId, policyId, installmentIds };
  }

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.fetch(new Request(`http://localhost/api${path}`, {
      method, headers: { "x-session-id": SESSION_ID, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }
  let chequeSeq = 0;
  const cheque = (amount: number) => ({
    checkNumber: `${PREFIX}-CH-${++chequeSeq}`, bankName: `${PREFIX} Banco`, dueDate: "2028-02-15", amount, drawerName: `${PREFIX} Librador`,
  });
  const cashItem = (s: { policyId: number; rebillingId: number }) => ({ source: "cash_period", policyId: s.policyId, rebillingId: s.rebillingId });
  const instItems = (ids: number[]) => ids.map((installmentId) => ({ source: "installment", installmentId }));
  const postBatch = (body: Record<string, unknown>) => call("POST", "/payment-batches", { paymentDate: PAYMENT_DATE, ...body });

  async function summary() {
    const r = await call("GET", "/cash/summary");
    if (r.status !== 200) throw new Error(`GET /cash/summary -> ${r.status}`);
    assertEqual((r.body.carteraInconsistencias ?? []).length, 0, "Caja sin inconsistencias de cartera");
    assertEqual((r.body.allocationsModel?.inconsistencias ?? []).length, 0, "Caja sin rendiciones inconsistentes");
    return {
      carteraTotal: Math.round(r.body.cartera.total * 100),
      carteraCheque: Math.round(r.body.cartera.cheque * 100),
      carteraTransferencia: Math.round(r.body.cartera.transferencia * 100),
      totalCobrado: Math.round(r.body.totalCobrado * 100),
    };
  }
  async function installmentStatus(id: number) {
    return (await db.select({ s: schema.policyInstallments.status }).from(schema.policyInstallments).where(eq(schema.policyInstallments.id, id)).get())?.s;
  }
  async function batchChildren(batchId: number) {
    return db.select().from(schema.payments).where(eq(schema.payments.batchId, batchId)).all();
  }
  async function count(table: any): Promise<number> {
    return (await db.select().from(table).all()).length;
  }
  async function pendingItems() {
    const r = await call("GET", "/remittances/pending");
    if (r.status !== 200) throw new Error(`GET /remittances/pending -> ${r.status}`);
    return r.body as any[];
  }
  async function render(items: Array<{ source: string; sourceId: number; amount: number; paymentMethod: string }>) {
    const byMethod: Record<string, number> = {};
    for (const i of items) byMethod[i.paymentMethod] = (byMethod[i.paymentMethod] ?? 0) + i.amount;
    return call("POST", "/remittances", {
      date: PAYMENT_DATE, canal: "directo", paymentBreakdown: byMethod,
      items: items.map((i) => ({ ...i, debtorStatus: "pagado", clientName: "x", policyNumber: "x", companyName: "x" })),
    });
  }
  async function cashEligible(s: { policyId: number; rebillingId: number }) {
    const r = await call("GET", `/policies/cash-period-search?policyId=${s.policyId}&paymentDate=${PAYMENT_DATE}`);
    return (r.body as any[]).find((x) => x.rebillingId === s.rebillingId)?.eligible as boolean;
  }

  // ─── C1. Un solo cheque para todo el lote ─────────────────────────────────
  let c1: { batchId: number; p1: Awaited<ReturnType<typeof refacturada>>; p2: Awaited<ReturnType<typeof comun>> } | null = null;
  await check("C1. un cheque de $37.000: contado de la refacturación ($27.000) + 2 cuotas de otra póliza; cheque registrado una vez, base sin nominal", async () => {
    const p1 = await refacturada();
    const p2 = await comun();
    const caja0 = await summary();
    const checksBefore = await count(schema.receivedChecks);
    const res = await postBatch({
      items: [cashItem(p1), ...instItems(p2.installmentIds)],
      splits: [{ method: "cheque", amount: 37000, checks: [cheque(37000)] }],
    });
    assertEqual(res.status, 201, `status (${JSON.stringify(res.body)})`);
    const batchId = res.body.id as number;
    const batch = await db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, batchId)).get();
    assertEqual(batch!.baseAmountCents, 3700000, "base = contado 27.000 + cuotas 10.000 (nunca el nominal 30.000)");
    assertEqual(batch!.surchargeAmountCents, 0, "sin recargo");
    assertEqual(batch!.totalReceivedCents, 3700000, "imputado");
    assertEqual(batch!.receivedAmountCents, 3700000, "recibido real");
    assertEqual(await count(schema.receivedChecks) - checksBefore, 1, "un único cheque registrado");
    const cpp = await db.select().from(schema.cashPeriodPayments).where(eq(schema.cashPeriodPayments.paymentBatchId, batchId)).get();
    assertEqual(cpp!.nominalAmountCents, 3000000, "nominal");
    assertEqual(cpp!.cashAmountCents, 2700000, "contado");
    assertEqual(cpp!.discountAmountCents, 300000, "descuento");
    assertEqual(cpp!.rebillingId, p1.rebillingId, "refacturación");
    const children = await batchChildren(batchId);
    assertEqual(children.length, 5, "5 hijos (3 del contado + 2 comunes)");
    const cashChildren = children.filter((ch) => ch.cashPeriodPaymentId === cpp!.id);
    assertEqual(cashChildren.length, 3, "3 cuotas vinculadas al contado");
    assertTrue(cashChildren.every((ch) => ch.paymentMethod === "contado" && ch.amount === 10000), "cuotas del contado al nominal, modalidad contado");
    const common = children.filter((ch) => ch.cashPeriodPaymentId == null);
    assertEqual(common.length, 2, "2 cuotas comunes sin vínculo");
    assertTrue(common.every((ch) => ch.paymentMethod === "lote"), "cuotas comunes como hijo de lote");
    for (const id of [...p1.installmentIds, ...p2.installmentIds]) assertEqual(await installmentStatus(id), "pagada", `cuota ${id} pagada`);
    assertEqual(await cashEligible(p1), false, "el contado ya no es elegible");
    const caja1 = await summary();
    assertEqual(caja1.carteraTotal - caja0.carteraTotal, 3700000, "pendiente de rendir +37.000");
    assertEqual(caja1.carteraCheque - caja0.carteraCheque, 3700000, "cobrado con cheque sin rendir +37.000");
    assertEqual(caja1.totalCobrado - caja0.totalCobrado, 3700000, "total cobrado +37.000 (nunca el nominal)");
    const detail = await call("GET", `/payment-batches/${batchId}`);
    assertEqual(detail.body.integrity.baseMatchesChildren, true, "integridad: base = cuotas comunes + contado");
    assertEqual(detail.body.cashPeriodPayment?.cashAmountCents, 2700000, "detalle expone el contado");
    c1 = { batchId, p1, p2 };
  });

  // ─── C2. Dos cheques que no coinciden con los subtotales ─────────────────
  await check("C2. dos cheques ($20.000 y $17.000) que no coinciden con los subtotales: se registran ambos por su importe real", async () => {
    const p1 = await refacturada();
    const p2 = await comun();
    const checksBefore = await count(schema.receivedChecks);
    const res = await postBatch({
      items: [cashItem(p1), ...instItems(p2.installmentIds)],
      splits: [{ method: "cheque", amount: 37000, checks: [cheque(20000), cheque(17000)] }],
    });
    assertEqual(res.status, 201, `status (${JSON.stringify(res.body)})`);
    const batchId = res.body.id as number;
    assertEqual(await count(schema.receivedChecks) - checksBefore, 2, "dos cheques");
    const splits = await db.select().from(schema.paymentBatchSplits).where(eq(schema.paymentBatchSplits.batchId, batchId)).all();
    const chks = await db.select().from(schema.receivedChecks).where(eq(schema.receivedChecks.batchSplitId, splits[0]!.id)).all();
    assertEqual(chks.map((c) => c.amountCents).sort().join(","), "1700000,2000000", "importes reales de los cheques");
    // Variante: dos medios cheque distintos.
    const p3 = await refacturada();
    const p4 = await comun();
    const res2 = await postBatch({
      items: [cashItem(p3), ...instItems(p4.installmentIds)],
      splits: [
        { method: "cheque", amount: 20000, checks: [cheque(20000)] },
        { method: "cheque", amount: 17000, checks: [cheque(17000)] },
      ],
    });
    assertEqual(res2.status, 201, `dos medios cheque (${JSON.stringify(res2.body)})`);
  });

  // ─── C3. Recibido ≠ imputado → 400 sin escribir nada ─────────────────────
  await check("C3. recibido distinto de lo imputado → 400 sin crear nada (ni con ajuste por redondeo ni con saldo)", async () => {
    const p1 = await refacturada();
    const p2 = await comun();
    const before = { batches: await count(schema.paymentBatches), checks: await count(schema.receivedChecks), cpp: await count(schema.cashPeriodPayments) };
    const r1 = await postBatch({ items: [cashItem(p1), ...instItems(p2.installmentIds)], splits: [{ method: "cheque", amount: 36999, checks: [cheque(36999)] }] });
    assertEqual(r1.status, 400, `de menos (${JSON.stringify(r1.body)})`);
    assertEqual(r1.body.code, "CASH_PERIOD_BATCH_AMOUNT_MISMATCH", "código");
    const r2 = await postBatch({ items: [cashItem(p1), ...instItems(p2.installmentIds)], splits: [{ method: "efectivo", amount: 40000 }] });
    assertEqual(r2.status, 400, "de más (ej. nominal en vez de contado)");
    const r3 = await postBatch({
      items: [cashItem(p1), ...instItems(p2.installmentIds)], splits: [{ method: "efectivo", amount: 36999 }],
      accountDifferenceResolution: { action: "ajuste_redondeo" },
    });
    assertEqual(r3.status, 400, "ajuste por redondeo rechazado");
    assertEqual(r3.body.code, "CASH_PERIOD_BATCH_DIFFERENCE_NOT_SUPPORTED", "código redondeo");
    const r4 = await postBatch({
      items: [cashItem(p1)], splits: [{ method: "efectivo", amount: 27000 }],
      accountHolderInsuredId: p1.insuredId, idempotencyKey: "mix-key-1",
    });
    assertEqual(r4.status, 400, "titular de cuenta rechazado");
    assertEqual(r4.body.code, "CASH_PERIOD_TITULAR_NOT_SUPPORTED", "código titular");
    assertEqual(await count(schema.paymentBatches), before.batches, "sin lotes nuevos");
    assertEqual(await count(schema.receivedChecks), before.checks, "sin cheques nuevos");
    assertEqual(await count(schema.cashPeriodPayments), before.cpp, "sin contados nuevos");
    for (const id of p1.installmentIds) assertEqual(await installmentStatus(id), "pendiente", "cuotas del período intactas");
  });

  // ─── C4. Las cuotas del contado no se agregan también sueltas ─────────────
  await check("C4. cuota del período también como ítem suelto → 400; dos contados en un lote → 400; importe en el ítem → 400", async () => {
    const p1 = await refacturada();
    const p5 = await refacturada();
    const r1 = await postBatch({ items: [cashItem(p1), { source: "installment", installmentId: p1.installmentIds[0] }], splits: [{ method: "efectivo", amount: 37000 }] });
    assertEqual(r1.status, 400, `cuota repetida (${JSON.stringify(r1.body)})`);
    assertEqual(r1.body.code, "CASH_PERIOD_INSTALLMENT_DUPLICATED_IN_BATCH", "código");
    const r2 = await postBatch({ items: [cashItem(p1), cashItem(p5)], splits: [{ method: "efectivo", amount: 54000 }] });
    assertEqual(r2.status, 400, "dos contados");
    const r3 = await postBatch({ items: [{ ...cashItem(p1), amount: 30000 }], splits: [{ method: "efectivo", amount: 30000 }] });
    assertEqual(r3.status, 400, "importe en el ítem de contado");
    for (const id of p1.installmentIds) assertEqual(await installmentStatus(id), "pendiente", "nada cobrado");
  });

  // ─── C5. Contado ya cobrado / período con actividad ──────────────────────
  await check("C5. contado ya cobrado → 409 (sin duplicar); período con una cuota ya cobrada → 409", async () => {
    assertTrue(c1 != null, "C1 debe haber corrido");
    const p2b = await comun();
    const r1 = await postBatch({ items: [cashItem(c1!.p1), ...instItems(p2b.installmentIds)], splits: [{ method: "efectivo", amount: 37000 }] });
    assertEqual(r1.status, 409, `contado ya cobrado (${JSON.stringify(r1.body)})`);
    const p6 = await refacturada();
    const one = await postBatch({ items: instItems([p6.installmentIds[0]!]), splits: [{ method: "efectivo", amount: 10000 }] });
    assertEqual(one.status, 201, "cobro de una cuota del período");
    const r2 = await postBatch({ items: [cashItem(p6)], splits: [{ method: "efectivo", amount: 27000 }] });
    assertEqual(r2.status, 409, "período con actividad");
    assertEqual(await installmentStatus(p2b.installmentIds[0]!), "pendiente", "la cuota común del intento fallido sigue pendiente");
  });

  // ─── C6. Recargos vigentes para las cuotas comunes ───────────────────────
  await check("C6. recargo Pronto Pago: mismas reglas para las cuotas comunes; el contado nunca suma recargo", async () => {
    // Control: dos cuotas Rivadavia solas — el backend informa el imputado
    // (con las reglas de recargo vigentes) al rechazar un importe sin recargo.
    const ctrl = await comun(rivadavia);
    const probe = await postBatch({ items: instItems(ctrl.installmentIds), splits: [{ method: "efectivo", amount: 10000 }] });
    assertEqual(probe.status, 400, `sin recargo se rechaza (${JSON.stringify(probe.body)})`);
    const ctrlApplied = probe.body.appliedCents as number;
    const ctrlRes = await postBatch({ items: instItems(ctrl.installmentIds), splits: [{ method: "efectivo", amount: ctrlApplied / 100 }] });
    assertEqual(ctrlRes.status, 201, `control (${JSON.stringify(ctrlRes.body)})`);
    const ctrlSurcharge = (await db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, ctrlRes.body.id)).get())!.surchargeAmountCents;
    assertTrue(ctrlSurcharge > 0 && ctrlSurcharge % SURCHARGE_AMOUNT_CENTS === 0, "el control tiene recargo vigente");
    // Mismo par de cuotas Rivadavia + contado de una refacturación Rivadavia.
    const riv = await comun(rivadavia);
    const p1r = await refacturada(rivadavia);
    const res = await postBatch({
      items: [cashItem(p1r), ...instItems(riv.installmentIds)],
      splits: [{ method: "efectivo", amount: 37000 + ctrlSurcharge / 100 }],
    });
    assertEqual(res.status, 201, `lote con contado Rivadavia (${JSON.stringify(res.body)})`);
    const b = await db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, res.body.id)).get();
    assertEqual(b!.surchargeAmountCents, ctrlSurcharge, "mismo recargo que sin contado (el contado no suma)");
    assertEqual(b!.baseAmountCents, 3700000, "base");
    // Con medio directo a compañía no hay recargo (regla vigente).
    const riv2 = await comun(rivadavia);
    const p2r = await refacturada(rivadavia);
    const res2 = await postBatch({ items: [cashItem(p2r), ...instItems(riv2.installmentIds)], splits: [{ method: "transferencia_compania", amount: 37000 }] });
    assertEqual(res2.status, 201, `directo compañía (${JSON.stringify(res2.body)})`);
    const b2 = await db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, res2.body.id)).get();
    assertEqual(b2!.surchargeAmountCents, 0, "sin recargo con medio directo");
  });

  // ─── C7. Pendientes de rendición del lote mixto ───────────────────────────
  await check("C7. pendientes de rendir: el contado es UNA partida por $27.000 (no bloqueada) y las cuotas comunes siguen sueltas", async () => {
    assertTrue(c1 != null, "C1 debe haber corrido");
    const items = await pendingItems();
    const cashItems = items.filter((i) => i.source === "payment_batch" && i.sourceId === c1!.batchId);
    assertEqual(cashItems.length, 1, "un ítem de contado");
    assertEqual(cashItems[0].amount, 27000, "importe de contado");
    assertEqual(cashItems[0].blocked, false, "no bloqueado");
    assertEqual(cashItems[0].cashPeriodPayment.mixedBatch, true, "marcado como lote mixto");
    assertEqual(cashItems[0].cashPeriodPayment.installmentCount, 3, "3 cuotas");
    const children = await batchChildren(c1!.batchId);
    const commonIds = children.filter((c) => c.cashPeriodPaymentId == null).map((c) => c.id);
    const cashIds = children.filter((c) => c.cashPeriodPaymentId != null).map((c) => c.id);
    const listedPayments = items.filter((i) => i.source === "payment").map((i) => i.sourceId);
    assertTrue(commonIds.every((id) => listedPayments.includes(id)), "las cuotas comunes se listan sueltas");
    assertTrue(cashIds.every((id) => !listedPayments.includes(id)), "las cuotas del contado nunca se listan sueltas");
  });

  // ─── C8. Rendir/revertir el contado no afecta las otras partidas ─────────
  await check("C8. rendición parcial: cuotas comunes por transferencia y el contado aparte; revertir el contado no toca las comunes; Caja sin inconsistencias", async () => {
    assertTrue(c1 != null, "C1 debe haber corrido");
    const { batchId } = c1!;
    const children = await batchChildren(batchId);
    const common = children.filter((c) => c.cashPeriodPaymentId == null);
    const cashChildren = children.filter((c) => c.cashPeriodPaymentId != null);
    const caja0 = await summary();

    const remCommon = await render(common.map((c) => ({ source: "payment", sourceId: c.id, amount: c.amount, paymentMethod: "transferencia" })));
    assertEqual(remCommon.status, 200, `rendir cuotas comunes (${JSON.stringify(remCommon.body)})`);
    const caja1 = await summary();
    assertEqual(caja0.carteraTotal - caja1.carteraTotal, 1000000, "pendiente baja exactamente $10.000 (no 9.250 por nominal)");
    assertEqual(caja0.totalCobrado, caja1.totalCobrado, "total cobrado no cambia al rendir");
    for (const ch of cashChildren) {
      const p = await db.select().from(schema.payments).where(eq(schema.payments.id, ch.id)).get();
      assertEqual(p!.rendered, 0, "las cuotas del contado siguen sin rendir");
    }
    const stillPending = (await pendingItems()).filter((i) => i.source === "payment_batch" && i.sourceId === batchId);
    assertEqual(stillPending.length, 1, "el contado sigue pendiente");

    // Rendir el contado: importe nominal → 400; sin medio real → 400; cuota suelta → 400.
    const bad1 = await render([{ source: "payment_batch", sourceId: batchId, amount: 30000, paymentMethod: "cheque" }]);
    assertEqual(bad1.status, 409, "nominal rechazado");
    const bad2 = await render([{ source: "payment_batch", sourceId: batchId, amount: 27000, paymentMethod: "lote" }]);
    assertEqual(bad2.status, 409, "medio no contable rechazado");
    const bad3 = await render([{ source: "payment", sourceId: cashChildren[0]!.id, amount: 10000, paymentMethod: "cheque" }]);
    assertEqual(bad3.status, 409, "cuota del contado suelta rechazada");

    const remCash = await render([{ source: "payment_batch", sourceId: batchId, amount: 27000, paymentMethod: "cheque" }]);
    assertEqual(remCash.status, 200, `rendir el contado (${JSON.stringify(remCash.body)})`);
    const caja2 = await summary();
    assertEqual(caja0.carteraTotal - caja2.carteraTotal, 3700000, "todo rendido: sale el lote completo");
    const allocs = await db.select().from(schema.remittanceAllocations).where(eq(schema.remittanceAllocations.remittanceId, remCash.body.id)).all();
    assertEqual(allocs.reduce((s, a) => s + a.amountCents, 0), 2700000, "allocations del contado suman exactamente $27.000");
    assertTrue(allocs.every((a) => a.receivedCheckId == null), "rendir el contado no consume el cheque del lote");
    const cpp = await db.select().from(schema.cashPeriodPayments).where(eq(schema.cashPeriodPayments.paymentBatchId, batchId)).get();
    assertEqual(cpp!.rendered, 1, "contado rendido");

    // Revertir el contado: solo sus cuotas vuelven a pendiente de rendir.
    const delCash = await call("DELETE", `/remittances/${remCash.body.id}`);
    assertEqual(delCash.status, 200, "anular rendición del contado");
    const after = await batchChildren(batchId);
    assertTrue(after.filter((c) => c.cashPeriodPaymentId != null).every((c) => c.rendered === 0), "cuotas del contado sin rendir");
    assertTrue(after.filter((c) => c.cashPeriodPaymentId == null).every((c) => c.rendered === 1), "cuotas comunes siguen rendidas");
    const caja3 = await summary();
    assertEqual(caja3.carteraTotal, caja1.carteraTotal, "Caja vuelve al estado con solo las comunes rendidas");

    // Orden inverso: revertir las comunes, rendir el contado primero.
    assertEqual((await call("DELETE", `/remittances/${remCommon.body.id}`)).status, 200, "anular rendición de las comunes");
    assertEqual((await summary()).carteraTotal, caja0.carteraTotal, "Caja vuelve al inicio");
    const remCash2 = await render([{ source: "payment_batch", sourceId: batchId, amount: 27000, paymentMethod: "efectivo" }]);
    assertEqual(remCash2.status, 200, "rendir el contado primero");
    assertEqual(caja0.carteraTotal - (await summary()).carteraTotal, 2700000, "pendiente baja exactamente $27.000");
    const again = await render([{ source: "payment_batch", sourceId: batchId, amount: 27000, paymentMethod: "efectivo" }]);
    assertEqual(again.status, 409, "doble rendición del contado rechazada");
    assertEqual((await call("DELETE", `/remittances/${remCash2.body.id}`)).status, 200, "anular");
    assertEqual((await summary()).carteraTotal, caja0.carteraTotal, "Caja vuelve al inicio");
  });

  // ─── C9. Anulación del lote mixto ─────────────────────────────────────────
  await check("C9. anulación: bloqueada con una partida rendida; sin rendir anula todo, cheque incluido, y el contado vuelve a estar disponible", async () => {
    const p1 = await refacturada();
    const p2 = await comun();
    const caja0 = await summary();
    const res = await postBatch({ items: [cashItem(p1), ...instItems(p2.installmentIds)], splits: [{ method: "cheque", amount: 37000, checks: [cheque(37000)] }] });
    assertEqual(res.status, 201, "lote");
    const batchId = res.body.id as number;
    const common = (await batchChildren(batchId)).filter((c) => c.cashPeriodPaymentId == null);
    const rem = await render([{ source: "payment", sourceId: common[0]!.id, amount: 5000, paymentMethod: "transferencia" }]);
    assertEqual(rem.status, 200, "rendir una cuota común");
    const blocked = await call("POST", `/payment-batches/${batchId}/cancel`, { confirm: true, reason: null });
    assertEqual(blocked.status, 409, "anulación bloqueada");
    assertEqual((await call("DELETE", `/remittances/${rem.body.id}`)).status, 200, "anular rendición");
    const ok = await call("POST", `/payment-batches/${batchId}/cancel`, { confirm: true, reason: null });
    assertEqual(ok.status, 200, `anular lote (${JSON.stringify(ok.body)})`);
    for (const id of [...p1.installmentIds, ...p2.installmentIds]) assertEqual(await installmentStatus(id), "pendiente", `cuota ${id} pendiente`);
    const cpp = await db.select().from(schema.cashPeriodPayments).where(eq(schema.cashPeriodPayments.paymentBatchId, batchId)).get();
    assertEqual(cpp!.status, "anulado", "contado anulado");
    const splits = await db.select().from(schema.paymentBatchSplits).where(eq(schema.paymentBatchSplits.batchId, batchId)).all();
    const chks = await db.select().from(schema.receivedChecks).where(eq(schema.receivedChecks.batchSplitId, splits[0]!.id)).all();
    assertTrue(chks.every((c) => c.status === "anulado"), "cheque anulado");
    assertEqual(await cashEligible(p1), true, "el contado vuelve a estar disponible");
    const caja1 = await summary();
    assertEqual(caja1.carteraTotal, caja0.carteraTotal, "Caja vuelve al estado previo");
    assertEqual(caja1.totalCobrado, caja0.totalCobrado, "total cobrado vuelve al estado previo");
  });

  // ─── C10. Listados ────────────────────────────────────────────────────────
  await check("C10. GET /payments: el contado del lote mixto es una fila por $27.000 ('lote'); las cuotas comunes siguen como filas; stats sin nominal", async () => {
    assertTrue(c1 != null, "C1 debe haber corrido");
    const r = await call("GET", "/payments");
    const rows = (r.body as any[]).filter((x) => x.payment.batchId === c1!.batchId);
    const synthetic = rows.filter((x) => x.payment.isCashPeriodPayment === true);
    assertEqual(synthetic.length, 1, "una fila de contado");
    assertEqual(synthetic[0].payment.amount, 27000, "importe de contado");
    assertEqual(synthetic[0].payment.paymentMethod, "lote", "medio 'lote' (los medios pagan todo el lote)");
    assertEqual(rows.filter((x) => x.payment.isCashPeriodPayment !== true).length, 2, "dos cuotas comunes");
    const total = rows.reduce((s, x) => s + x.payment.amount, 0);
    assertEqual(total, 37000, "suma del lote = recibido");
    const det = await call("GET", `/cash-period-payments/${c1!.batchId}`);
    assertEqual(det.status, 200, "detalle del contado");
    assertEqual(det.body.cancelledInstallments.length, 3, "solo las 3 cuotas del contado");
    assertEqual(det.body.mixedBatch, true, "mixto");
    assertEqual(det.body.actualReceivedCents, 2700000, "recibido atribuible al contado");
    const commonChild = (await batchChildren(c1!.batchId)).find((c) => c.cashPeriodPaymentId == null)!;
    const cashChild = (await batchChildren(c1!.batchId)).find((c) => c.cashPeriodPaymentId != null)!;
    assertEqual((await call("PATCH", `/cash/payments/${cashChild.id}/render`, { rendered: true })).status, 409, "cuota del contado no se marca suelta");
    const okRender = await call("PATCH", `/cash/payments/${commonChild.id}/render`, { rendered: false });
    assertEqual(okRender.status, 200, "cuota común sí");
  });

  // ─── C11. Contado histórico (cobro individual) sigue igual ───────────────
  await check("C11. contado individual (POST /payment-batches/cash-period-payment): vincula sus cuotas, se rinde con sus instrumentos reales y se revierte igual que antes", async () => {
    const p1 = await refacturada();
    const caja0 = await summary();
    const res = await call("POST", "/payment-batches/cash-period-payment", {
      policyId: p1.policyId, rebillingId: p1.rebillingId, paymentDate: PAYMENT_DATE,
      splits: [{ method: "cheque", amount: 27000, checks: [cheque(27000)] }],
    });
    assertEqual(res.status, 201, `contado individual (${JSON.stringify(res.body)})`);
    const batchId = res.body.id as number;
    const children = await batchChildren(batchId);
    assertEqual(children.length, 3, "3 cuotas");
    assertTrue(children.every((c) => c.cashPeriodPaymentId === res.body.cashPeriodPaymentId), "todas vinculadas a su contado");
    const pend = (await pendingItems()).find((i) => i.source === "payment_batch" && i.sourceId === batchId);
    assertEqual(pend?.cashPeriodPayment?.mixedBatch, false, "no mixto");
    assertEqual(pend?.paymentMethod, "cheque", "medio real del cobro");
    const rem = await render([{ source: "payment_batch", sourceId: batchId, amount: 27000, paymentMethod: "cheque" }]);
    assertEqual(rem.status, 200, `rendir (${JSON.stringify(rem.body)})`);
    const allocs = await db.select().from(schema.remittanceAllocations).where(eq(schema.remittanceAllocations.remittanceId, rem.body.id)).all();
    assertEqual(allocs.length, 1, "una allocation");
    assertTrue(allocs[0]!.receivedCheckId != null, "instrumento real: el cheque del cobro (comportamiento histórico)");
    assertEqual((await summary()).carteraTotal, caja0.carteraTotal, "rendido: Caja vuelve al inicio");
    assertEqual((await call("DELETE", `/remittances/${rem.body.id}`)).status, 200, "revertir");
    const after = await batchChildren(batchId);
    assertTrue(after.every((c) => c.rendered === 0), "cuotas sin rendir otra vez");
    assertEqual((await summary()).carteraTotal - caja0.carteraTotal, 2700000, "Caja vuelve a +27.000");
  });

  // ─── C12. Contado histórico sin vínculo (pre-0037) migrado por el aplicador ─
  await check("C12. un contado creado antes de 0037 (hijos sin vínculo) queda vinculado por el backfill y sigue funcionando", async () => {
    const p1 = await refacturada();
    const res = await call("POST", "/payment-batches/cash-period-payment", {
      policyId: p1.policyId, rebillingId: p1.rebillingId, paymentDate: PAYMENT_DATE, splits: [{ method: "efectivo", amount: 27000 }],
    });
    assertEqual(res.status, 201, "contado");
    const batchId = res.body.id as number;
    // Simula el dato histórico: hijos sin cash_period_payment_id.
    await db.update(schema.payments).set({ cashPeriodPaymentId: null }).where(eq(schema.payments.batchId, batchId));
    const { MIGRATION_0037_BACKFILL_SQL } = await import("../../lib/migrations/apply-0037-cash-period-payment-children");
    const { sql } = await import("drizzle-orm");
    await db.run(sql.raw(MIGRATION_0037_BACKFILL_SQL));
    const children = await batchChildren(batchId);
    assertTrue(children.every((c) => c.cashPeriodPaymentId === res.body.cashPeriodPaymentId), "backfill vincula al contado de su lote");
    const unlinked = await db.select().from(schema.payments)
      .where(and(eq(schema.payments.batchId, c1!.batchId), isNull(schema.payments.cashPeriodPaymentId))).all();
    assertEqual(unlinked.length, 2, "el backfill nunca toca las cuotas comunes de un lote mixto ya vinculado");
    const pend = (await pendingItems()).find((i) => i.source === "payment_batch" && i.sourceId === batchId);
    assertEqual(pend?.amount, 27000, "sigue listándose como contado");
  });
}

main()
  .catch((e) => {
    results.push({ name: "__setup__", pass: false, message: String(e?.stack ?? e) });
  })
  .finally(() => {
    console.log(`RESULT_JSON:${JSON.stringify({ results })}`);
    process.exit(results.every((r) => r.pass) ? 0 : 1);
  });
