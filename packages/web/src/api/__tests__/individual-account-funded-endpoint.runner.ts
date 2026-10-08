/**
 * Runner de PROCESO HIJO para individual-account-funded-endpoint.test.ts —
 * pago individual con saldo de cuenta corriente (POST /payments/account-funded).
 *
 * Mismo aislamiento que payment-batch-titular-endpoint.runner.ts (ver su
 * cabecera): `app`/`database` se importan por primera vez en este proceso
 * nuevo, apuntando a una SQLite descartable creada acá mismo con el esquema
 * real (migraciones .sql + aplicadores 0035/0036). Nunca dev.db ni Turso.
 *
 * No matchea *.test.ts: solo lo lanza el wrapper vía Bun.spawn. Imprime una
 * línea "RESULT_JSON:{...}" y termina con exit 0 solo si todo pasó.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SESSION_ID = "test-session-individual-funded-001";
const USER_EMAIL = "test-individual-funded@test.local";
const PREFIX = "TEST-IND-FUNDED";
const PAYMENT_DATE = "2028-02-01";

const tmpDir = mkdtempSync(join(tmpdir(), "individual-account-funded-endpoint-"));
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
    results.push({ name, pass: false, message: String(e?.message ?? e) });
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: esperado ${JSON.stringify(expected)}, obtuve ${JSON.stringify(actual)}`);
}
function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(`${label}: esperado true`);
}
function assertMatch(text: string, re: RegExp, label: string): void {
  if (!re.test(text)) throw new Error(`${label}: "${text}" no matchea ${re}`);
}

// ─── Esquema real descartable (mismo bootstrap que payment-batch-titular-endpoint.runner.ts) ──

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

function applyRealMigrationsExcept(sqlite: Database, migrationsDir: string, excluded: ReadonlySet<string>): void {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql") && !excluded.has(f)).sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) sqlite.run(stmt);
  }
}

function bootstrapUntrackedColumns(sqlite: Database): void {
  sqlite.run(`ALTER TABLE policies ADD COLUMN is_fleet integer NOT NULL DEFAULT 0`);
  sqlite.run(`ALTER TABLE policies ADD COLUMN is_rebilling integer NOT NULL DEFAULT 0`);
  sqlite.run(`ALTER TABLE policies ADD COLUMN renewed_from_id integer`);
  sqlite.run(`ALTER TABLE policies ADD COLUMN parent_policy_id integer`);
  sqlite.run(`ALTER TABLE insureds ADD COLUMN created_by integer REFERENCES users(id)`);
  sqlite.run(`ALTER TABLE payments ADD COLUMN installment_id integer REFERENCES policy_installments(id)`);
}

async function buildDisposableSchema(path: string): Promise<void> {
  const { applyMigration0035TraceableDuplicateInvalidation } = await import("../../lib/migrations/apply-0035-traceable-duplicate-invalidation");
  const { applyMigration0036AccountHolderFunding } = await import("../../lib/migrations/apply-0036-account-holder-funding");
  const sqlite = new Database(path);
  try {
    sqlite.run("PRAGMA foreign_keys=ON");
    bootstrapPreMigrationTables(sqlite);
    applyRealMigrationsExcept(sqlite, join(import.meta.dir, "..", "migrations"), new Set([
      "0035_traceable_duplicate_invalidation.sql", "0036_account_holder_funding.sql",
    ]));
    bootstrapUntrackedColumns(sqlite);
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
  } finally {
    sqlite.close();
  }
}

function authHeaders() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}

async function main(): Promise<void> {
  await buildDisposableSchema(dbPath);

  const { default: app } = await import("../index");
  const { database: db } = await import("../database/index");
  const schema = await import("../database/schema");
  const { eq, and } = await import("drizzle-orm");
  const { ACCOUNT_FUNDED_PAYMENT_ENDPOINT } = await import("../../lib/payments/account-holder-funding-fingerprint");
  const {
    runAccountHolderFundingBatch, loadActiveAccountHolderBalanceCents, FundingPlanRaceConditionError,
  } = await import("../account-holder-funding-batch");
  const { AccountHolderFundingPlanError } = await import("../../lib/payments/account-holder-funding-plan");
  const { insertPaymentBatchRow } = await import("../payment-batch-shared-inserts");

  const [u] = await db.insert(schema.users).values({
    name: "QA Pago individual", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: schema.users.id });
  const userId = u!.id;
  await db.insert(schema.sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const [co] = await db.insert(schema.companies).values({ name: `${PREFIX} Compañía` }).returning({ id: schema.companies.id });
  const companyId = co!.id;
  const [riv] = await db.insert(schema.companies).values({ name: `${PREFIX} Rivadavia Seguros` }).returning({ id: schema.companies.id });
  const rivadaviaId = riv!.id;

  let seq = 0;
  async function mkInsured(): Promise<number> {
    const [ins] = await db.insert(schema.insureds).values({ name: `${PREFIX} Asegurado ${++seq}`, createdBy: userId }).returning({ id: schema.insureds.id });
    return ins!.id;
  }
  async function mkPolicy(insuredId: number, company = companyId): Promise<number> {
    const [p] = await db.insert(schema.policies).values({
      policyNumber: `${PREFIX}-${++seq}`, type: "automotor", status: "activa",
      companyId: company, insuredId, startDate: "2028-01-01", endDate: "2028-12-31", isRebilling: 0, createdBy: userId,
    }).returning({ id: schema.policies.id });
    return p!.id;
  }
  async function mkInstallment(policyId: number, amount: number): Promise<number> {
    const [row] = await db.insert(schema.policyInstallments).values({
      policyId, number: ++seq, dueDate: PAYMENT_DATE, amount, status: "pendiente", rendered: 0,
    }).returning({ id: schema.policyInstallments.id });
    return row!.id;
  }
  /** Saldo a favor preexistente (sobrante real de un cobro anterior, sin lote de origen). */
  async function seedCredit(insuredId: number, cents: number): Promise<void> {
    await db.insert(schema.insuredAccountMovements).values({
      insuredId, type: "saldo_a_favor", signedAmountCents: cents, status: "activo", createdBy: userId, createdAt: new Date(),
    });
  }
  async function scenario(opts: { credit?: number; amount?: number; company?: number } = {}) {
    const insuredId = await mkInsured();
    const policyId = await mkPolicy(insuredId, opts.company);
    const installmentId = await mkInstallment(policyId, opts.amount ?? 100000);
    if (opts.credit) await seedCredit(insuredId, opts.credit);
    return { insuredId, policyId, installmentId };
  }
  let keySeq = 0;
  const newKey = () => `ind-key-${++keySeq}`;

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.fetch(new Request(`http://localhost/api${path}`, {
      method, headers: authHeaders(), body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }
  const postFunded = (body: unknown) => call("POST", "/payments/account-funded", body);
  async function cajaTotal(): Promise<number> {
    const r = await call("GET", "/cash/summary");
    if (r.status !== 200) throw new Error(`GET /cash/summary -> ${r.status}`);
    assertEqual((r.body.carteraInconsistencias ?? []).length, 0, "Caja sin inconsistencias de cartera");
    return Math.round(r.body.cajaNeta.total * 100);
  }
  async function directoTotal(): Promise<number> {
    const r = await call("GET", "/cash/summary");
    return Math.round((r.body.directoCompania?.total ?? 0) * 100);
  }
  const balance = (insuredId: number) => loadActiveAccountHolderBalanceCents(db, insuredId);
  async function childOf(batchId: number) {
    const rows = await db.select().from(schema.payments).where(eq(schema.payments.batchId, batchId)).all();
    assertEqual(rows.length, 1, "un único payment hijo");
    return rows[0]!;
  }
  async function installmentStatus(id: number) {
    return (await db.select({ s: schema.policyInstallments.status }).from(schema.policyInstallments).where(eq(schema.policyInstallments.id, id)).get())?.s;
  }
  async function countAll(table: any): Promise<number> {
    return (await db.select().from(table).all()).length;
  }
  async function render(paymentId: number, amountPesos: number, method: string) {
    const r = await call("POST", "/remittances", {
      date: PAYMENT_DATE, canal: "directo", paymentBreakdown: { [method]: amountPesos },
      items: [{ source: "payment", sourceId: paymentId, amount: amountPesos, paymentMethod: method }],
    });
    assertEqual(r.status, 200, `POST /remittances (${JSON.stringify(r.body)})`);
    return r.body.id as number;
  }
  async function renderWithSurcharge(paymentId: number, cuotaPesos: number, method: string) {
    const r = await call("POST", "/remittances", {
      date: PAYMENT_DATE, canal: "pronto_pago", paymentBreakdown: { [method]: cuotaPesos + 800 },
      items: [{ source: "payment", sourceId: paymentId, amount: cuotaPesos, paymentMethod: method }],
    });
    assertEqual(r.status, 200, `POST /remittances pronto_pago (${JSON.stringify(r.body)})`);
    return r.body.id as number;
  }
  const cancelBatch = (batchId: number) => call("POST", `/payment-batches/${batchId}/cancel`, { confirm: true, reason: null });
  const funded = (s: { policyId: number; installmentId: number }, extra: Record<string, unknown>) => ({
    policyId: s.policyId, installmentId: s.installmentId, paymentDate: PAYMENT_DATE, idempotencyKey: newKey(), ...extra,
  });

  // ─── Ejemplo 1: $30.000 saldo + $70.000 transferencia ──────────────────
  await check("E1. 30.000 saldo + 70.000 transferencia: pagada, cuenta 0, Caja +70.000 real; rendir/anular rendición/anular pago restituyen exacto", async () => {
    const caja0 = await cajaTotal();
    const s = await scenario({ credit: 3000000 });
    const cajaSeeded = await cajaTotal();
    assertEqual(cajaSeeded - caja0, 3000000, "el saldo a favor previo ya estaba en Caja (sobrante real anterior)");

    const res = await postFunded(funded(s, { creditAppliedCents: 3000000, splits: [{ method: "transferencia", amount: 70000 }] }));
    assertEqual(res.status, 201, `status (${JSON.stringify(res.body)})`);
    const batchId = res.body.id as number;
    const batch = await db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, batchId)).get();
    assertEqual(batch!.accountHolderInsuredId, s.insuredId, "titular = asegurado de la póliza");
    assertEqual(batch!.receivedAmountCents, 7000000, "dinero real");
    assertEqual(batch!.totalReceivedCents, 10000000, "cancelado");
    assertEqual(await installmentStatus(s.installmentId), "pagada", "cuota pagada");
    assertEqual(await balance(s.insuredId), 0, "cuenta en 0");
    assertEqual(await cajaTotal() - cajaSeeded, 7000000, "Caja recibe solo los 70.000 reales (el saldo no crea dinero)");
    const idem = await db.select().from(schema.accountHolderFundingIdempotencyKeys).where(eq(schema.accountHolderFundingIdempotencyKeys.paymentBatchId, batchId)).all();
    assertEqual(idem.length, 1, "fila de idempotencia");
    assertEqual(idem[0]!.endpoint, ACCOUNT_FUNDED_PAYMENT_ENDPOINT, "endpoint registrado");

    const child = await childOf(batchId);
    await check("E1a. anular antes de anular la rendición → 409", async () => {
      const remId = await render(child.id, 100000, "transferencia");
      assertEqual(await cajaTotal(), caja0, "después de rendir: Caja vuelve al valor previo al saldo (70.000 reales + 30.000 de saldo salieron a la compañía)");
      const blocked = await cancelBatch(batchId);
      assertEqual(blocked.status, 409, "un pago rendido no se puede anular");
      const del = await call("DELETE", `/remittances/${remId}`);
      assertEqual(del.status, 200, "anular rendición");
      assertEqual(await cajaTotal() - cajaSeeded, 7000000, "rendición anulada: Caja vuelve a +70.000");
    });
    const cancel = await cancelBatch(batchId);
    assertEqual(cancel.status, 200, `anular cobro (${JSON.stringify(cancel.body)})`);
    assertEqual(await balance(s.insuredId), 3000000, "saldo restituido exacto");
    assertEqual(await cajaTotal(), cajaSeeded, "Caja vuelve al estado previo al pago");
    assertEqual(await installmentStatus(s.installmentId), "pendiente", "cuota vuelve a pendiente");
  });

  // ─── Ejemplo 2: $70.000 efectivo + $30.000 deuda autorizada ─────────────
  await check("E2. 70.000 efectivo + 30.000 deuda: pagada, Caja +70.000, cuenta −30.000; al rendir la oficina adelanta 30.000", async () => {
    const s = await scenario();
    const caja0 = await cajaTotal();
    const res = await postFunded(funded(s, {
      splits: [{ method: "efectivo", amount: 70000 }], debtAuthorized: true, debtReason: "pagará la diferencia la semana próxima",
    }));
    assertEqual(res.status, 201, `status (${JSON.stringify(res.body)})`);
    const batchId = res.body.id as number;
    assertEqual(await installmentStatus(s.installmentId), "pagada", "cuota pagada");
    assertEqual(await balance(s.insuredId), -3000000, "cuenta −30.000");
    assertEqual(await cajaTotal() - caja0, 7000000, "la deuda no figura como dinero recibido");
    const child = await childOf(batchId);
    const remId = await render(child.id, 100000, "efectivo");
    assertEqual(await cajaTotal() - caja0, -3000000, "después de rendir: la oficina adelantó 30.000");
    assertEqual((await call("DELETE", `/remittances/${remId}`)).status, 200, "anular rendición");
    assertEqual(await cajaTotal() - caja0, 7000000, "rendición anulada");
    assertEqual((await cancelBatch(batchId)).status, 200, "anular cobro");
    assertEqual(await balance(s.insuredId), 0, "deuda anulada");
    assertEqual(await cajaTotal(), caja0, "Caja vuelve al estado previo");
  });

  // ─── Ejemplo 3: $100.000 de saldo, cero medios reales ───────────────────
  await check("E3. 100.000 de saldo sin medio real: cero splits, Caja sin dinero nuevo; rendición con cero medios reales", async () => {
    const s = await scenario({ credit: 10000000 });
    const cajaSeeded = await cajaTotal();
    const res = await postFunded(funded(s, { creditAppliedCents: 10000000, splits: [] }));
    assertEqual(res.status, 201, `status (${JSON.stringify(res.body)})`);
    const batchId = res.body.id as number;
    assertEqual(await countAll(schema.paymentBatchSplits) >= 0, true, "consulta");
    const splits = await db.select().from(schema.paymentBatchSplits).where(eq(schema.paymentBatchSplits.batchId, batchId)).all();
    assertEqual(splits.length, 0, "cero medios reales");
    const batch = await db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, batchId)).get();
    assertEqual(batch!.receivedAmountCents, 0, "dinero real 0");
    assertEqual(await installmentStatus(s.installmentId), "pagada", "cuota pagada");
    assertEqual(await balance(s.insuredId), 0, "saldo consumido");
    assertEqual(await cajaTotal(), cajaSeeded, "consumir saldo no crea dinero en Caja");
    const child = await childOf(batchId);
    const remId = await render(child.id, 100000, "efectivo");
    assertEqual(await cajaTotal() - cajaSeeded, -10000000, "rendir con cero medios: sale el saldo que estaba en la oficina");
    assertEqual((await call("DELETE", `/remittances/${remId}`)).status, 200, "anular rendición");
    assertEqual(await cajaTotal(), cajaSeeded, "rendición anulada");
  });

  // ─── Ejemplo 4: $110.000 reales → nuevo saldo +10.000 ───────────────────
  let e4: { insuredId: number; batchId: number } | null = null;
  await check("E4. 110.000 reales: pagada, nuevo saldo a favor +10.000, Caja +110.000", async () => {
    const s = await scenario();
    const caja0 = await cajaTotal();
    const res = await postFunded(funded(s, { splits: [{ method: "efectivo", amount: 110000 }] }));
    assertEqual(res.status, 201, `status (${JSON.stringify(res.body)})`);
    assertEqual(await installmentStatus(s.installmentId), "pagada", "cuota pagada");
    assertEqual(await balance(s.insuredId), 1000000, "nuevo saldo +10.000");
    assertEqual(await cajaTotal() - caja0, 11000000, "Caja recibe los 110.000 reales");
    e4 = { insuredId: s.insuredId, batchId: res.body.id };
  });

  await check("E4b. anulación con saldo ya consumido por un movimiento posterior → 409 revisión manual, nada cambia", async () => {
    const policyId = await mkPolicy(e4!.insuredId);
    const installmentId = await mkInstallment(policyId, 50000);
    const use = await postFunded(funded({ policyId, installmentId }, { creditAppliedCents: 1000000, splits: [{ method: "efectivo", amount: 40000 }] }));
    assertEqual(use.status, 201, `consumo del saldo (${JSON.stringify(use.body)})`);
    const blocked = await cancelBatch(e4!.batchId);
    assertEqual(blocked.status, 409, "409");
    assertEqual(blocked.body.code, "ACCOUNT_MOVEMENT_REQUIRES_MANUAL_REVIEW", "código");
    const b = await db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, e4!.batchId)).get();
    assertEqual(b!.status, "confirmado", "el cobro sigue confirmado");
  });

  // ─── Pronto Pago ─────────────────────────────────────────────────────
  await check("PP1. Pronto Pago con saldo total: el recargo $800 se mantiene y se cubre con saldo, cero medios", async () => {
    const s = await scenario({ credit: 10080000, company: rivadaviaId });
    const res = await postFunded(funded(s, { creditAppliedCents: 10080000, splits: [] }));
    assertEqual(res.status, 201, `status (${JSON.stringify(res.body)})`);
    const batch = await db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, res.body.id)).get();
    assertEqual(batch!.surchargeAmountCents, 80000, "recargo dentro del total");
    assertEqual(batch!.totalReceivedCents, 10080000, "total cancelado = cuota + recargo");
    const child = await childOf(res.body.id);
    const surcharge = await db.select().from(schema.cashEntries).where(and(eq(schema.cashEntries.paymentId, child.id), eq(schema.cashEntries.entryType, "pronto_pago_surcharge"))).all();
    assertEqual(surcharge.length, 1, "cash_entry de recargo");
    const allocs = await db.select().from(schema.paymentBatchFundingAllocations).where(eq(schema.paymentBatchFundingAllocations.cashEntryId, surcharge[0]!.id)).all();
    assertEqual(allocs.reduce((t: number, a: any) => t + a.amountCents, 0), 80000, "el recargo queda financiado por el saldo");
    assertEqual(await balance(s.insuredId), 0, "saldo consumido");
    const remId = await renderWithSurcharge(child.id, 100000, "efectivo");
    assertTrue(remId > 0, "rendición pronto pago con cero medios");
  });

  await check("PP2. Pronto Pago con saldo parcial + efectivo", async () => {
    const s = await scenario({ credit: 5000000, company: rivadaviaId });
    const res = await postFunded(funded(s, { creditAppliedCents: 5000000, splits: [{ method: "efectivo", amount: 50800 }] }));
    assertEqual(res.status, 201, `status (${JSON.stringify(res.body)})`);
    const batch = await db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, res.body.id)).get();
    assertEqual(batch!.surchargeAmountCents, 80000, "recargo");
    assertEqual(await balance(s.insuredId), 0, "cuenta 0");
  });

  await check("PP3. Pronto Pago con saldo insuficiente: sin deuda → 400 sin filas; con deuda autorizada → 201 con saldo deudor del recargo", async () => {
    const s = await scenario({ credit: 10000000, company: rivadaviaId });
    const beforeBatches = await countAll(schema.paymentBatches);
    const rejected = await postFunded(funded(s, { creditAppliedCents: 10000000, splits: [] }));
    assertEqual(rejected.status, 400, "faltante sin autorización");
    assertEqual(await countAll(schema.paymentBatches), beforeBatches, "sin filas nuevas");
    const ok = await postFunded(funded(s, { creditAppliedCents: 10000000, splits: [], debtAuthorized: true, debtReason: "falta el recargo" }));
    assertEqual(ok.status, 201, `status (${JSON.stringify(ok.body)})`);
    assertEqual(await balance(s.insuredId), -80000, "deuda por el recargo");
  });

  // ─── Medios propios, directos y combinados ───────────────────────────────
  await check("M1. saldo + transferencia_compania: el dinero directo no entra a Caja; rendición con medio directo", async () => {
    const s = await scenario({ credit: 3000000 });
    const cajaSeeded = await cajaTotal();
    const directo0 = await directoTotal();
    const res = await postFunded(funded(s, { creditAppliedCents: 3000000, splits: [{ method: "transferencia_compania", amount: 70000 }] }));
    assertEqual(res.status, 201, `status (${JSON.stringify(res.body)})`);
    assertEqual(await cajaTotal(), cajaSeeded, "Caja no recibe el pago directo ni dinero ficticio por el saldo");
    assertEqual(await directoTotal() - directo0, 7000000, "directo a compañía +70.000");
    const child = await childOf(res.body.id);
    await render(child.id, 100000, "transferencia_compania");
    assertEqual(await cajaTotal() - cajaSeeded, -3000000, "al rendir sale el saldo de la oficina");
  });

  await check("M2. saldo + efectivo + cheque (combinado propio): cheque en cartera del split del cobro", async () => {
    const s = await scenario({ credit: 2000000 });
    const res = await postFunded(funded(s, {
      creditAppliedCents: 2000000,
      splits: [
        { method: "efectivo", amount: 30000 },
        { method: "cheque", amount: 50000, checks: [{ checkNumber: "IND-1", bankName: "Banco QA", dueDate: "2028-06-01", amount: 50000 }] },
      ],
    }));
    assertEqual(res.status, 201, `status (${JSON.stringify(res.body)})`);
    const splits = await db.select().from(schema.paymentBatchSplits).where(eq(schema.paymentBatchSplits.batchId, res.body.id)).all();
    assertEqual(splits.length, 2, "dos medios reales");
    const checks = await db.select().from(schema.receivedChecks).where(eq(schema.receivedChecks.batchSplitId, splits.find((x: any) => x.method === "cheque")!.id)).all();
    assertEqual(checks[0]!.status, "en_cartera", "cheque en cartera");
  });

  await check("M3. medios propios + directos mezclados → 400", async () => {
    const s = await scenario({ credit: 1000000 });
    const res = await postFunded(funded(s, { creditAppliedCents: 1000000, splits: [{ method: "efectivo", amount: 40000 }, { method: "link_pago", amount: 50000 }] }));
    assertEqual(res.status, 400, "mixed");
  });

  // ─── Crédito antes que deuda ───────────────────────────────────────────
  await check("C1. saldo disponible + deuda: exige agotar el saldo; con el saldo agotado sí crea la deuda", async () => {
    const s = await scenario({ credit: 2000000 });
    const partial = await postFunded(funded(s, {
      creditAppliedCents: 1000000, splits: [{ method: "efectivo", amount: 50000 }], debtAuthorized: true, debtReason: "x",
    }));
    assertEqual(partial.status, 400, "saldo sin agotar");
    assertMatch(partial.body.error, /saldo a favor disponible sin aplicar/, "mensaje");
    const full = await postFunded(funded(s, {
      creditAppliedCents: 2000000, splits: [{ method: "efectivo", amount: 50000 }], debtAuthorized: true, debtReason: "x",
    }));
    assertEqual(full.status, 201, `status (${JSON.stringify(full.body)})`);
    assertEqual(await balance(s.insuredId), -3000000, "deuda solo por lo que falta después del saldo");
  });

  await check("C2. redondeo con saldo disponible sin aplicar → 400", async () => {
    const s = await scenario({ credit: 1000000 });
    const res = await postFunded(funded(s, { creditAppliedCents: 0, roundingCoverageCents: 300, splits: [{ method: "efectivo", amount: 99997 }] }));
    assertEqual(res.status, 400, "redondeo antes que saldo");
  });

  await check("C3. redondeo hasta $5 con saldo agotado → 201; más de $5 → 400", async () => {
    const s = await scenario();
    const over = await postFunded(funded(s, { roundingCoverageCents: 600, splits: [{ method: "efectivo", amount: 99994 }] }));
    assertEqual(over.status, 400, "más de $5");
    const ok = await postFunded(funded(s, { roundingCoverageCents: 300, splits: [{ method: "efectivo", amount: 99997 }] }));
    assertEqual(ok.status, 201, `status (${JSON.stringify(ok.body)})`);
    assertEqual(await balance(s.insuredId), 0, "el redondeo no es deuda del asegurado");
  });

  await check("C4. sobrante real con saldo aplicado → 400 claro (no se consume saldo y se crea saldo nuevo a la vez)", async () => {
    const s = await scenario({ credit: 1000000 });
    const res = await postFunded(funded(s, { creditAppliedCents: 1000000, splits: [{ method: "efectivo", amount: 100000 }] }));
    assertEqual(res.status, 400, "sobre-fondeo");
    assertMatch(res.body.error, /reducí el saldo aplicado/, "mensaje");
  });

  await check("C5. lote con titular: misma regla (saldo sin agotar + deuda → 400)", async () => {
    const s = await scenario({ credit: 2000000 });
    const res = await call("POST", "/payment-batches", {
      paymentDate: PAYMENT_DATE, accountHolderInsuredId: s.insuredId, idempotencyKey: newKey(),
      items: [{ source: "installment", installmentId: s.installmentId }],
      splits: [{ method: "efectivo", amount: 50000 }],
      creditAppliedCents: 1000000, debtAuthorized: true, debtReason: "x",
    });
    assertEqual(res.status, 400, "lote titular");
    assertMatch(res.body.error, /saldo a favor disponible sin aplicar/, "mensaje");
  });

  await check("C6. lote legacy: saldo_deudor con saldo a favor disponible → 409 CREDIT_AVAILABLE_BEFORE_DEBT; sin saldo → 201", async () => {
    const s = await scenario({ credit: 500000 });
    const res = await call("POST", "/payment-batches", {
      paymentDate: PAYMENT_DATE, items: [{ source: "installment", installmentId: s.installmentId }],
      splits: [{ method: "efectivo", amount: 90000 }],
      accountDifferenceResolution: { action: "saldo_deudor", reason: "x" },
    });
    assertEqual(res.status, 409, "legacy con saldo");
    assertEqual(res.body.code, "CREDIT_AVAILABLE_BEFORE_DEBT", "código");
    const s2 = await scenario();
    const ok = await call("POST", "/payment-batches", {
      paymentDate: PAYMENT_DATE, items: [{ source: "installment", installmentId: s2.installmentId }],
      splits: [{ method: "efectivo", amount: 90000 }],
      accountDifferenceResolution: { action: "saldo_deudor", reason: "x" },
    });
    assertEqual(ok.status, 201, "legacy sin saldo sigue funcionando");
  });

  // ─── Cero medios solo en el endpoint nuevo ─────────────────────────────
  await check("Z1. cero medios sin saldo aplicado → 400", async () => {
    const s = await scenario();
    const res = await postFunded(funded(s, { splits: [], debtAuthorized: true, debtReason: "x" }));
    assertEqual(res.status, 400, "sin saldo");
  });

  await check("Z2. cero medios rechazado en flujos tradicionales (POST /payments, lote legacy y lote con titular)", async () => {
    const s = await scenario({ credit: 10000000 });
    const p = await call("POST", "/payments", { policyId: s.policyId, installmentId: s.installmentId, amount: 100000, paymentDate: PAYMENT_DATE, splits: [], paymentMethod: "" });
    assertEqual(p.status, 400, "POST /payments");
    const legacy = await call("POST", "/payment-batches", { paymentDate: PAYMENT_DATE, items: [{ source: "installment", installmentId: s.installmentId }], splits: [] });
    assertEqual(legacy.status, 400, "lote legacy");
    const titular = await call("POST", "/payment-batches", {
      paymentDate: PAYMENT_DATE, accountHolderInsuredId: s.insuredId, idempotencyKey: newKey(),
      items: [{ source: "installment", installmentId: s.installmentId }], splits: [], creditAppliedCents: 10000000,
    });
    assertEqual(titular.status, 400, "lote con titular");
    assertEqual(await installmentStatus(s.installmentId), "pendiente", "nada se cobró");
  });

  // ─── Titular siempre desde la póliza ──────────────────────────────────
  await check("T1. accountHolderInsuredId en el body → 400; campos desconocidos → 400; titular derivado de la póliza", async () => {
    const other = await scenario({ credit: 5000000 });
    const s = await scenario();
    const withHolder = await postFunded({ ...funded(s, { creditAppliedCents: 5000000, splits: [{ method: "efectivo", amount: 50000 }] }), accountHolderInsuredId: other.insuredId });
    assertEqual(withHolder.status, 400, "titular en el body");
    assertMatch(withHolder.body.error, /titular de cuenta se obtiene siempre de la póliza/, "mensaje");
    const unknown = await postFunded({ ...funded(s, { splits: [{ method: "efectivo", amount: 100000 }] }), items: [] });
    assertEqual(unknown.status, 400, "campo desconocido");
    // El saldo de `other` nunca se puede usar para la póliza de `s`: el titular es el asegurado de `s` (sin saldo).
    const borrow = await postFunded(funded(s, { creditAppliedCents: 5000000, splits: [{ method: "efectivo", amount: 50000 }] }));
    assertEqual(borrow.status, 400, "no hay saldo del asegurado de la póliza");
    assertEqual(await balance(other.insuredId), 5000000, "el saldo del otro asegurado no se tocó");
    const mismatch = await postFunded(funded({ policyId: other.policyId, installmentId: s.installmentId }, { splits: [{ method: "efectivo", amount: 100000 }] }));
    assertEqual(mismatch.status, 400, "cuota de otra póliza");
  });

  // ─── Rechazo de campos de financiación en endpoints tradicionales ───────
  await check("R1. POST /payments y PUT /payments/:id rechazan campos de financiación", async () => {
    const s = await scenario({ credit: 1000000 });
    const post = await call("POST", "/payments", {
      policyId: s.policyId, installmentId: s.installmentId, amount: 100000, paymentDate: PAYMENT_DATE,
      splits: [{ method: "efectivo", amount: 90000 }], creditAppliedCents: 1000000,
    });
    assertEqual(post.status, 400, "POST");
    assertEqual(post.body.code, "ACCOUNT_FUNDING_FIELDS_NOT_ALLOWED", "código POST");
    const ok = await call("POST", "/payments", {
      policyId: s.policyId, installmentId: s.installmentId, amount: 100000, paymentDate: PAYMENT_DATE,
      splits: [{ method: "efectivo", amount: 100000 }],
    });
    assertEqual(ok.status, 201, "pago tradicional sin cambios");
    const put = await call("PUT", `/payments/${ok.body.id}`, { notes: "x", debtAuthorized: true });
    assertEqual(put.status, 400, "PUT");
    assertEqual(await balance(s.insuredId), 1000000, "el saldo no se tocó");
  });

  // ─── Idempotencia, doble clic y reintento ─────────────────────────────
  await check("I1. doble clic (dos requests simultáneos con la misma clave) → un solo cobro, misma respuesta", async () => {
    const s = await scenario({ credit: 3000000 });
    const body = funded(s, { creditAppliedCents: 3000000, splits: [{ method: "efectivo", amount: 70000 }] });
    const beforeBatches = await countAll(schema.paymentBatches);
    const [a, b] = await Promise.all([postFunded(body), postFunded(body)]);
    assertEqual(a.status, 201, `primero (${JSON.stringify(a.body)})`);
    assertEqual(b.status, 201, `segundo (${JSON.stringify(b.body)})`);
    assertEqual(a.body.id, b.body.id, "mismo cobro");
    assertEqual(await countAll(schema.paymentBatches), beforeBatches + 1, "un solo lote");
    assertEqual(await balance(s.insuredId), 0, "saldo consumido una sola vez");
    const retry = await postFunded(body);
    assertEqual(retry.status, 201, "reintento");
    assertEqual(retry.body.id, a.body.id, "reintento devuelve la respuesta guardada");
    assertEqual(await countAll(schema.paymentBatches), beforeBatches + 1, "sin filas nuevas en el reintento");
    const changed = await postFunded({ ...body, notes: "distinto" });
    assertEqual(changed.status, 409, "misma clave, contenido distinto");
  });

  await check("I2. la clave del pago individual no resuelve en /payment-batches (endpoint separado en la idempotencia)", async () => {
    const s = await scenario({ credit: 1000000 });
    const key = newKey();
    const ind = await postFunded({ ...funded(s, { creditAppliedCents: 1000000, splits: [{ method: "efectivo", amount: 90000 }] }), idempotencyKey: key });
    assertEqual(ind.status, 201, "individual");
    const s2 = await scenario();
    const lote = await call("POST", "/payment-batches", {
      paymentDate: PAYMENT_DATE, accountHolderInsuredId: s2.insuredId, idempotencyKey: key,
      items: [{ source: "installment", installmentId: s2.installmentId }], splits: [{ method: "efectivo", amount: 100000 }],
    });
    assertEqual(lote.status, 201, "lote con la misma clave es otro request");
    assertTrue(lote.body.id !== ind.body.id, "cobros distintos");
  });

  await check("I3. dos claves distintas para la misma cuota → la segunda 409, sin cobro duplicado", async () => {
    const s = await scenario();
    const r1 = await postFunded(funded(s, { splits: [{ method: "efectivo", amount: 110000 }] }));
    assertEqual(r1.status, 201, "primero");
    const r2 = await postFunded(funded(s, { splits: [{ method: "efectivo", amount: 110000 }] }));
    assertEqual(r2.status, 409, "cuota ya cobrada");
    assertEqual(await balance(s.insuredId), 1000000, "un solo sobrante");
  });

  await check("I4. lote con titular: doble clic simultáneo → un solo cobro y la base sigue operativa después", async () => {
    const s = await scenario({ credit: 3000000 });
    const body = {
      paymentDate: PAYMENT_DATE, accountHolderInsuredId: s.insuredId, idempotencyKey: newKey(),
      items: [{ source: "installment", installmentId: s.installmentId }], splits: [{ method: "efectivo", amount: 70000 }], creditAppliedCents: 3000000,
    };
    const beforeBatches = await countAll(schema.paymentBatches);
    const [a, b] = await Promise.all([call("POST", "/payment-batches", body), call("POST", "/payment-batches", body)]);
    assertEqual(a.status, 201, `primero (${JSON.stringify(a.body)})`);
    assertEqual(b.status, 201, `segundo (${JSON.stringify(b.body)})`);
    assertEqual(a.body.id, b.body.id, "mismo cobro");
    assertEqual(await countAll(schema.paymentBatches), beforeBatches + 1, "un solo lote");
    const s2 = await scenario();
    const next = await call("POST", "/payment-batches", {
      paymentDate: PAYMENT_DATE, items: [{ source: "installment", installmentId: s2.installmentId }], splits: [{ method: "efectivo", amount: 100000 }],
    });
    assertEqual(next.status, 201, "la siguiente escritura no queda bloqueada");
  });

  // ─── Saldo que cambia durante la operación ────────────────────────────
  await check("S1. el saldo cambia dentro de la transacción → error y rollback total (sin lote, sin movimientos)", async () => {
    const s = await scenario({ credit: 3000000 });
    const batchesBefore = await countAll(schema.paymentBatches);
    const movementsBefore = await countAll(schema.insuredAccountMovements);
    let thrown: unknown = null;
    try {
      await runAccountHolderFundingBatch({
        db, createdBy: userId, idempotencyKey: newKey(), requestFingerprint: "fp-race", accountHolderInsuredId: s.insuredId,
        paymentDate: PAYMENT_DATE, endpoint: ACCOUNT_FUNDED_PAYMENT_ENDPOINT,
        destinations: [{ id: "payment-0", kind: "payment", nominalCents: 10000000 }],
        realSplits: [{ id: "split-0", amountCents: 7000000 }],
        creditAppliedCents: 3000000, roundingCoverageCents: 0, debtAuthorized: false, debtReason: null,
        dependencies: {
          createBatch: async (tx: any) => {
            const batch = await insertPaymentBatchRow(tx, {
              insuredId: s.insuredId, baseAmountCents: 10000000, surchargeAmountCents: 0, totalReceivedCents: 10000000,
              receivedAmountCents: 7000000, paymentDate: PAYMENT_DATE, notes: null, createdBy: userId, accountHolderInsuredId: s.insuredId,
            });
            // Otra operación consumió parte del saldo entre la lectura preliminar y la transacción.
            await tx.insert(schema.insuredAccountMovements).values({
              insuredId: s.insuredId, type: "aplicacion_saldo_favor", signedAmountCents: -1000000, status: "activo", createdBy: userId, createdAt: new Date(),
            });
            return batch;
          },
          createChildRows: async () => { throw new Error("no debería llegar"); },
          buildResponseSnapshot: async () => { throw new Error("no debería llegar"); },
        },
      });
    } catch (e) {
      thrown = e;
    }
    assertTrue(thrown instanceof AccountHolderFundingPlanError || thrown instanceof FundingPlanRaceConditionError, `error de dominio (${String(thrown)})`);
    assertEqual(await countAll(schema.paymentBatches), batchesBefore, "sin lote");
    assertEqual(await countAll(schema.insuredAccountMovements), movementsBefore, "sin movimientos (rollback total)");
    assertEqual(await balance(s.insuredId), 3000000, "saldo intacto");
  });

  // ─── Edición posterior ─────────────────────────────────────────────────
  await check("D1. cobro con saldo: cambiar fecha → 409; notas → 200; edición contable del pago → 409", async () => {
    const s = await scenario({ credit: 1000000 });
    const res = await postFunded(funded(s, { creditAppliedCents: 1000000, splits: [{ method: "efectivo", amount: 90000 }] }));
    assertEqual(res.status, 201, "cobro");
    const date = await call("PATCH", `/payment-batches/${res.body.id}`, { paymentDate: "2028-02-02" });
    assertEqual(date.status, 409, "fecha bloqueada");
    assertEqual(date.body.code, "BATCH_DATE_LOCKED_BY_ACCOUNT_MOVEMENTS", "código");
    const notes = await call("PATCH", `/payment-batches/${res.body.id}`, { notes: "nota editada" });
    assertEqual(notes.status, 200, "notas");
    const child = await childOf(res.body.id);
    const put = await call("PUT", `/payments/${child.id}`, { amount: 1 });
    assertEqual(put.status, 409, "edición contable del hijo");
    const del = await call("DELETE", `/payments/${child.id}`);
    assertEqual(del.status, 409, "eliminación del hijo");
  });

  await check("D2. lote sin movimientos de cuenta: la fecha se sigue pudiendo cambiar; lote legacy con sobrante: fecha bloqueada", async () => {
    const s = await scenario();
    const plain = await call("POST", "/payment-batches", {
      paymentDate: PAYMENT_DATE, items: [{ source: "installment", installmentId: s.installmentId }], splits: [{ method: "efectivo", amount: 100000 }],
    });
    assertEqual(plain.status, 201, "lote normal");
    assertEqual((await call("PATCH", `/payment-batches/${plain.body.id}`, { paymentDate: "2028-02-02" })).status, 200, "fecha editable");
    const s2 = await scenario();
    const surplus = await call("POST", "/payment-batches", {
      paymentDate: PAYMENT_DATE, items: [{ source: "installment", installmentId: s2.installmentId }], splits: [{ method: "efectivo", amount: 110000 }],
      accountDifferenceResolution: { action: "saldo_a_favor", reason: null },
    });
    assertEqual(surplus.status, 201, "lote legacy con sobrante");
    assertEqual((await call("PATCH", `/payment-batches/${surplus.body.id}`, { paymentDate: "2028-02-02" })).status, 409, "fecha bloqueada");
  });

  // ─── Presentación ──────────────────────────────────────────────────────
  await check("P1. GET /payments: pago individual con saldo identificado estructuralmente; lote con titular común no", async () => {
    const s = await scenario();
    const ind = await postFunded(funded(s, { splits: [{ method: "efectivo", amount: 70000 }], debtAuthorized: true, debtReason: "x", notes: "nota del cobro" }));
    assertEqual(ind.status, 201, "individual");
    const s0 = await scenario({ credit: 10000000 });
    const zero = await postFunded(funded(s0, { creditAppliedCents: 10000000, splits: [] }));
    assertEqual(zero.status, 201, "cero medios");
    const s2 = await scenario();
    const lote = await call("POST", "/payment-batches", {
      paymentDate: PAYMENT_DATE, accountHolderInsuredId: s2.insuredId, idempotencyKey: newKey(),
      items: [{ source: "installment", installmentId: s2.installmentId }], splits: [{ method: "efectivo", amount: 100000 }],
    });
    assertEqual(lote.status, 201, "lote titular");

    const list = await call("GET", "/payments");
    const rowOf = (batchId: number) => (list.body as any[]).find((r) => r.payment.batchId === batchId);
    const indRow = rowOf(ind.body.id);
    assertEqual(indRow.payment.accountFunding?.kind, "individual_account_funded", "marca estructurada");
    assertEqual(indRow.payment.accountFunding.newDebtCents, 3000000, "saldo deudor");
    assertEqual(indRow.payment.accountFunding.realReceivedCents, 7000000, "medios reales");
    assertEqual(indRow.payment.accountFunding.totalCancelledCents, 10000000, "total cancelado");
    assertEqual(indRow.payment.paymentMethod, "efectivo", "método real (no 'lote')");
    assertEqual(indRow.payment.splits.length, 1, "medios del cobro");
    assertEqual(indRow.payment.notes, "nota del cobro", "notas del cobro");
    const zeroRow = rowOf(zero.body.id);
    assertEqual(zeroRow.payment.paymentMethod, "saldo_a_favor", "sin medio real");
    assertEqual(zeroRow.payment.accountFunding.creditAppliedCents, 10000000, "saldo aplicado");
    assertEqual(rowOf(lote.body.id).payment.accountFunding, undefined, "un lote con titular no se presenta como pago individual");
    const filtered = await call("GET", "/payments?method=efectivo");
    assertTrue((filtered.body as any[]).some((r) => r.payment.batchId === ind.body.id), "filtro por método usa los medios del cobro");
  });

  // ─── Adeudadas: circuito sin cambios, nunca a la vez con saldo deudor ────
  async function cashSnapshot() {
    const r = await call("GET", "/cash/summary");
    if (r.status !== 200) throw new Error(`GET /cash/summary -> ${r.status}`);
    return {
      neta: Math.round(r.body.cajaNeta.total * 100),
      adeudado: Math.round(r.body.totalAdeudado * 100),
      deudores: Math.round(r.body.cuentaCorriente.saldosDeudoresPendientes * 100),
      detalle: (r.body.adeudadosDetalle ?? []) as any[],
    };
  }
  async function uncollectedIds(): Promise<number[]> {
    const r = await call("GET", "/remittances/uncollected");
    return (r.body as any[]).map((x) => x.id);
  }
  async function renderAsDebt(installmentId: number, pesos: number) {
    return call("POST", "/remittances", {
      date: PAYMENT_DATE, canal: "directo", paymentBreakdown: { efectivo: pesos },
      items: [{ source: "installment", sourceId: installmentId, amount: pesos, debtorStatus: "adeudado" }],
    });
  }
  async function artifactCounts() {
    return {
      batches: await countAll(schema.paymentBatches), payments: await countAll(schema.payments),
      movements: await countAll(schema.insuredAccountMovements), adjustments: await countAll(schema.paymentAmountAdjustments),
      allocations: await countAll(schema.paymentBatchFundingAllocations), idempotency: await countAll(schema.accountHolderFundingIdempotencyKeys),
      splits: await countAll(schema.paymentBatchSplits), cashEntries: await countAll(schema.cashEntries),
    };
  }

  await check("A1. cuota financiada parcialmente (efectivo + deuda autorizada): pagada, fuera de /remittances/uncollected y no rendible como adeudada", async () => {
    const s = await scenario();
    const res = await postFunded(funded(s, { splits: [{ method: "efectivo", amount: 70000 }], debtAuthorized: true, debtReason: "resto la semana próxima" }));
    assertEqual(res.status, 201, `cobro (${JSON.stringify(res.body)})`);
    assertEqual(await installmentStatus(s.installmentId), "pagada", "cuota pagada");
    assertTrue(!(await uncollectedIds()).includes(s.installmentId), "no aparece en /remittances/uncollected");
    const before = await countAll(schema.remittances);
    const asDebt = await renderAsDebt(s.installmentId, 100000);
    assertTrue(asDebt.status >= 400, `rendir como adeudada se rechaza (${asDebt.status})`);
    assertMatch(String(asDebt.body.error), /ya tiene un cobro registrado/, "mensaje");
    assertEqual(await countAll(schema.remittances), before, "sin rendición creada");
  });

  let noIncome: { insuredId: number; installmentId: number; itemId: number } | null = null;
  await check("A2. cuota sin ningún ingreso: account-funded la rechaza sin crear artefactos y sigue el circuito normal de adeudadas", async () => {
    const s = await scenario();
    const before = await artifactCounts();
    const noMoney = await postFunded(funded(s, { splits: [] }));
    assertEqual(noMoney.status, 400, "sin medios ni saldo");
    const onlyDebt = await postFunded(funded(s, { splits: [], debtAuthorized: true, debtReason: "no pagó nada" }));
    assertEqual(onlyDebt.status, 400, "100% deuda sin ingreso");
    assertEqual(JSON.stringify(await artifactCounts()), JSON.stringify(before), "ningún artefacto (lote, pago, movimiento, ajuste, allocation, idempotencia, medio, recargo)");
    assertEqual(await installmentStatus(s.installmentId), "pendiente", "cuota intacta");
    assertTrue((await uncollectedIds()).includes(s.installmentId), "sigue en /remittances/uncollected");
    const rendered = await renderAsDebt(s.installmentId, 100000);
    assertEqual(rendered.status, 200, `rendir como adeudada (${JSON.stringify(rendered.body)})`);
    const items = await db.select().from(schema.remittanceItems).where(eq(schema.remittanceItems.remittanceId, rendered.body.id)).all();
    assertEqual(items[0]!.debtorStatus, "adeudado", "ítem adeudado");
    const afterRender = await artifactCounts();
    const funding = await postFunded(funded(s, { splits: [{ method: "efectivo", amount: 70000 }], debtAuthorized: true, debtReason: "x" }));
    assertTrue(funding.status === 409, `una adeudada no se cobra con saldo/deuda (${funding.status} ${JSON.stringify(funding.body)})`);
    assertEqual(JSON.stringify(await artifactCounts()), JSON.stringify(afterRender), "el intento sobre la adeudada no crea artefactos");
    assertEqual(await balance(s.insuredId), 0, "sin saldo deudor de cuenta corriente");
    noIncome = { insuredId: s.insuredId, installmentId: s.installmentId, itemId: items[0]!.id };
  });

  await check("A3. cobrar después esa adeudada funciona igual que una adeudada sin intento previo (mismo efecto en Caja y adeudados)", async () => {
    const control = await scenario();
    const c0 = await cashSnapshot();
    const renderedControl = await renderAsDebt(control.installmentId, 100000);
    assertEqual(renderedControl.status, 200, "rendir la adeudada de control");
    const c1 = await cashSnapshot();
    const controlItem = (await db.select().from(schema.remittanceItems).where(eq(schema.remittanceItems.remittanceId, renderedControl.body.id)).all())[0]!;
    const collectControl = await call("POST", `/remittances/items/${controlItem.id}/collect`, { paymentMethod: "efectivo", paymentDate: PAYMENT_DATE });
    assertEqual(collectControl.status, 201, "cobrar la de control");
    const c2 = await cashSnapshot();
    const movementsBefore = await countAll(schema.insuredAccountMovements);
    const batchesBefore = await countAll(schema.paymentBatches);
    const collect = await call("POST", `/remittances/items/${noIncome!.itemId}/collect`, { paymentMethod: "efectivo", paymentDate: PAYMENT_DATE });
    assertEqual(collect.status, 201, `cobrar la adeudada (${JSON.stringify(collect.body)})`);
    const c3 = await cashSnapshot();
    assertEqual(collect.body.payment.rendered, 1, "el pago nace rendido (como siempre)");
    assertEqual(collect.body.payment.batchId ?? null, null, "pago tradicional, sin lote");
    assertEqual(await installmentStatus(noIncome!.installmentId), "pagada", "cuota pagada");
    const item = await db.select().from(schema.remittanceItems).where(eq(schema.remittanceItems.id, noIncome!.itemId)).get();
    assertEqual(item!.debtorStatus, "pagado", "ítem pagado");
    assertEqual(await countAll(schema.insuredAccountMovements), movementsBefore, "sin movimientos de cuenta corriente");
    assertEqual(await countAll(schema.paymentBatches), batchesBefore, "sin lotes");
    assertEqual(c3.neta - c2.neta, c2.neta - c1.neta, "mismo impacto en Caja que la adeudada de control al cobrar");
    assertEqual(c3.adeudado - c2.adeudado, c2.adeudado - c1.adeudado, "mismo impacto en adeudados que la de control al cobrar");
    assertEqual(c1.adeudado - c0.adeudado, 10000000, "control: rendir como adeudada suma la cuota a adeudados");
    assertEqual(c3.deudores, c2.deudores, "la cuenta corriente no participa del circuito de adeudadas");
  });

  await check("A4. sin doble impacto en Caja: cuota pagada con deuda autorizada se rinde una vez, la deuda vive solo en cuenta corriente", async () => {
    const s = await scenario();
    const c0 = await cashSnapshot();
    const res = await postFunded(funded(s, { splits: [{ method: "efectivo", amount: 70000 }], debtAuthorized: true, debtReason: "x" }));
    assertEqual(res.status, 201, "cobro");
    const c1 = await cashSnapshot();
    assertEqual(c1.neta - c0.neta, 7000000, "Caja recibe solo los 70.000 reales");
    assertEqual(c1.adeudado, c0.adeudado, "no suma a adeudados");
    assertEqual(c1.deudores - c0.deudores, 3000000, "la deuda figura una sola vez, en cuenta corriente");
    const child = await childOf(res.body.id);
    await render(child.id, 100000, "efectivo");
    const c2 = await cashSnapshot();
    assertEqual(c2.neta - c0.neta, -3000000, "después de rendir: entra 70.000, sale 100.000 (una sola vez)");
    assertEqual(c2.adeudado, c0.adeudado, "rendirla no la convierte en adeudada");
    assertEqual(c2.deudores - c0.deudores, 3000000, "la deuda sigue una sola vez");
    assertEqual(c2.detalle.length, c0.detalle.length, "no aparece en el detalle de adeudados");
  });

  await check("A5. saldo negativo previo + sobrante en un pago posterior: el saldo final se netea", async () => {
    const s = await scenario();
    const debt = await postFunded(funded(s, { splits: [{ method: "efectivo", amount: 70000 }], debtAuthorized: true, debtReason: "x" }));
    assertEqual(debt.status, 201, "deuda previa");
    assertEqual(await balance(s.insuredId), -3000000, "debe 30.000");
    const p2 = await mkPolicy(s.insuredId);
    const i2 = await mkInstallment(p2, 100000);
    const c0 = await cashSnapshot();
    const partial = await postFunded(funded({ policyId: p2, installmentId: i2 }, { splits: [{ method: "efectivo", amount: 110000 }] }));
    assertEqual(partial.status, 201, `sobrante menor a la deuda (${JSON.stringify(partial.body)})`);
    assertEqual(await balance(s.insuredId), -2000000, "10.000 de sobrante cancelan parte: queda −20.000");
    const c1 = await cashSnapshot();
    assertEqual(c1.neta - c0.neta, 11000000, "Caja recibe los 110.000 reales");
    assertEqual(c0.deudores - c1.deudores, 1000000, "saldos deudores bajan 10.000");
    const i3 = await mkInstallment(p2, 100000);
    const over = await postFunded(funded({ policyId: p2, installmentId: i3 }, { splits: [{ method: "efectivo", amount: 130000 }] }));
    assertEqual(over.status, 201, "sobrante mayor a la deuda");
    assertEqual(await balance(s.insuredId), 1000000, "30.000 de sobrante: cancela los 20.000 y quedan +10.000");
  });

  // ─── Marca estructurada (fila de idempotencia): ciclo de vida y ausencia ──
  const idemRowsOf = (batchId: number) =>
    db.select().from(schema.accountHolderFundingIdempotencyKeys).where(eq(schema.accountHolderFundingIdempotencyKeys.paymentBatchId, batchId)).all();
  /** Todo lo económico del cobro (sin notas ni timestamps de edición). */
  async function economicSnapshot(batchId: number) {
    const b = await db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, batchId)).get();
    return JSON.stringify({
      batch: { status: b!.status, paymentDate: b!.paymentDate, total: b!.totalReceivedCents, received: b!.receivedAmountCents, holder: b!.accountHolderInsuredId },
      movements: await db.select().from(schema.insuredAccountMovements).where(eq(schema.insuredAccountMovements.originBatchId, batchId)).all(),
      allocations: await db.select().from(schema.paymentBatchFundingAllocations).where(eq(schema.paymentBatchFundingAllocations.paymentBatchId, batchId)).all(),
      splits: await db.select().from(schema.paymentBatchSplits).where(eq(schema.paymentBatchSplits.batchId, batchId)).all(),
      idempotency: await idemRowsOf(batchId),
    });
  }

  await check("K1. la fila de idempotencia (marca de pago individual) sobrevive a la anulación: se sigue identificando y un reintento con la misma clave no recrea el cobro", async () => {
    const s = await scenario({ credit: 3000000 });
    const body = funded(s, { creditAppliedCents: 3000000, splits: [{ method: "efectivo", amount: 70000 }] });
    const res = await postFunded(body);
    assertEqual(res.status, 201, "cobro");
    const before = await idemRowsOf(res.body.id);
    assertEqual(before.length, 1, "una fila de idempotencia");
    assertEqual((await cancelBatch(res.body.id)).status, 200, "anular");
    assertEqual(JSON.stringify(await idemRowsOf(res.body.id)), JSON.stringify(before), "la fila no se borra ni cambia al anular");
    const row = ((await call("GET", "/payments")).body as any[]).find((r) => r.payment.batchId === res.body.id);
    assertEqual(row?.payment.accountFunding?.batchStatus, "anulado", "sigue identificado como pago individual, anulado");
    const batchesBefore = await countAll(schema.paymentBatches);
    const movementsBefore = await countAll(schema.insuredAccountMovements);
    const replay = await postFunded(body);
    assertEqual(replay.status, 201, "replay de la respuesta guardada");
    assertEqual(replay.body.id, res.body.id, "mismo cobro (anulado), nunca uno nuevo");
    assertEqual(await countAll(schema.paymentBatches), batchesBefore, "sin lote nuevo");
    assertEqual(await countAll(schema.insuredAccountMovements), movementsBefore, "sin movimientos nuevos");
    assertEqual(await balance(s.insuredId), 3000000, "saldo restituido intacto");
    assertEqual(await installmentStatus(s.installmentId), "pendiente", "la cuota sigue pendiente");
  });

  await check("K2. si falta la fila de idempotencia: sin 500, el cobro se presenta como hijo de lote común, nada económico cambia y sigue administrable desde el lote", async () => {
    const s = await scenario({ credit: 3000000 });
    const body = funded(s, { creditAppliedCents: 3000000, splits: [{ method: "efectivo", amount: 70000 }] });
    const res = await postFunded(body);
    assertEqual(res.status, 201, "cobro");
    const batchId = res.body.id as number;
    const cajaBefore = await cajaTotal();
    await db.delete(schema.accountHolderFundingIdempotencyKeys).where(eq(schema.accountHolderFundingIdempotencyKeys.paymentBatchId, batchId));
    const list = await call("GET", "/payments");
    assertEqual(list.status, 200, "GET /payments sin error");
    const row = (list.body as any[]).find((r) => r.payment.batchId === batchId);
    assertTrue(row != null, "la fila sigue listada");
    assertEqual(row.payment.accountFunding, undefined, "sin marca: no se presenta como pago individual");
    assertEqual(row.payment.paymentMethod, "lote", "se presenta como hijo de lote (método persistido)");
    assertEqual(await balance(s.insuredId), 0, "saldo intacto");
    assertEqual(await cajaTotal(), cajaBefore, "Caja intacta");
    const child = await childOf(batchId);
    assertEqual((await call("PUT", `/payments/${child.id}`, { amount: 1 })).status, 409, "edición del hijo sigue bloqueada");
    assertEqual((await call("DELETE", `/payments/${child.id}`)).status, 409, "eliminación del hijo sigue bloqueada");
    const batchesBefore = await countAll(schema.paymentBatches);
    const retry = await postFunded(body);
    assertEqual(retry.status, 409, `reintento con la clave: la cuota ya está cobrada, sin duplicado (${JSON.stringify(retry.body)})`);
    assertEqual(await countAll(schema.paymentBatches), batchesBefore, "sin lote nuevo");
    assertEqual(await balance(s.insuredId), 0, "el reintento no consume saldo");
    assertEqual((await cancelBatch(batchId)).status, 200, "se anula desde el lote");
    assertEqual(await balance(s.insuredId), 3000000, "saldo restituido exacto");
    assertEqual(await installmentStatus(s.installmentId), "pendiente", "cuota pendiente");
  });

  await check("N1. editar notas después de crear el cobro no altera la huella guardada ni nada económico; el replay del request original no revierte las notas", async () => {
    const s = await scenario({ credit: 1000000 });
    const body = funded(s, { creditAppliedCents: 1000000, splits: [{ method: "efectivo", amount: 90000 }], notes: "nota original" });
    const res = await postFunded(body);
    assertEqual(res.status, 201, "cobro");
    const batchId = res.body.id as number;
    const econ0 = await economicSnapshot(batchId);
    const caja0 = await cajaTotal();
    assertEqual((await call("PATCH", `/payment-batches/${batchId}`, { notes: "nota editada" })).status, 200, "notas");
    assertEqual(await economicSnapshot(batchId), econ0, "lote, movimientos, allocations, medios y fila de idempotencia (huella + snapshot) idénticos");
    assertEqual(await cajaTotal(), caja0, "Caja idéntica");
    assertEqual(await balance(s.insuredId), 0, "saldo idéntico");
    const replay = await postFunded(body);
    assertEqual(replay.status, 201, "replay del request original (misma huella)");
    assertEqual(replay.body.id, batchId, "mismo cobro");
    const row = ((await call("GET", "/payments")).body as any[]).find((r) => r.payment.batchId === batchId);
    assertEqual(row.payment.notes, "nota editada", "el replay no revierte la nota editada");
    assertEqual(await economicSnapshot(batchId), econ0, "el replay tampoco cambia nada");
  });

  const allPass = results.every((r) => r.pass);
  process.stdout.write(`RESULT_JSON:${JSON.stringify({ results })}\n`);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EBUSY en Windows: tmpdir de un solo uso */ }
  process.exit(allPass ? 0 : 1);
}

main().catch((e: any) => {
  console.error(`[individual-account-funded-endpoint.runner] fallo antes de completar las verificaciones: ${e?.stack ?? e}`);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
