/**
 * Runner de PROCESO HIJO para payment-batch-titular-endpoint.test.ts —
 * Etapa 1B-3-E, cierre HTTP.
 *
 * Por qué existe (mismo motivo, palabra por palabra, que
 * duplicate-invalidation-consumers.runner.ts): `app` (src/api/index.ts) y
 * `database` (src/api/database/index.ts) abren su conexión a
 * `process.env.DATABASE_URL` UNA sola vez, al importarse, y ESM cachea el
 * módulo por proceso. Si este archivo viviera en el proceso principal de
 * `bun test`, y CUALQUIER otro archivo de la suite completa ya hubiera
 * importado `app`/`database` antes de que su setup corriera (orden de
 * descubrimiento de `bun test`, no controlable — p.ej. database-safety.test.ts,
 * que importa `database` a propósito contra dev.db), el import dinámico de
 * acá recibiría el módulo YA cacheado apuntando a dev.db real. La única
 * forma de garantizar que `app`/`database` se importen por primera vez
 * apuntando a la DB descartable de este archivo es que ese primer import
 * ocurra en un PROCESO NUEVO que no comparte caché de módulos con el resto
 * de la suite — de ahí este archivo, lanzado vía Bun.spawn desde el wrapper
 * (payment-batch-titular-endpoint.test.ts), nunca importado directamente.
 *
 * No matchea *.test.ts a propósito: `bun test` no lo descubre ni lo corre
 * como test propio; solo existe como script standalone invocado por spawn.
 *
 * Contrato con el wrapper: imprime una única línea "RESULT_JSON:{...}" con
 * los resultados de las verificaciones y termina con exit code 0 solo si
 * todas pasaron (1 en cualquier otro caso, incluyendo fallas de setup antes
 * de poder correr ninguna verificación).
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SESSION_ID = "test-session-titular-http-001";
const USER_EMAIL = "test-titular-http@test.local";
const PREFIX = "TEST-TITULAR-HTTP";
const FIXTURE_DATE = "2028-02-01";
const ENDPOINT = "POST /payment-batches";

const tmpDir = mkdtempSync(join(tmpdir(), "payment-batch-titular-endpoint-"));
const dbPath = join(tmpDir, "disposable.db");

// ─── Defensa explícita — ANTES de importar cualquier módulo que abra una
// conexión: DATABASE_URL debe ser EXACTAMENTE el archivo que este mismo
// proceso acaba de crear en su propio tmpDir, sin importar qué haya en el
// entorno heredado del proceso padre (que podría traer un DATABASE_URL de
// dev.db o Turso desde fuera). No alcanza con "empieza con file:" (un
// file: a dev.db también lo cumpliría) — se exige coincidencia EXACTA con
// el path recién generado.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.DATABASE_AUTH_TOKEN = "local-test-disposable";

if (process.env.DATABASE_URL !== `file:${dbPath}`) {
  console.error("REFUSED: DATABASE_URL no coincide exactamente con el archivo temporal recién creado por este runner — abortando antes de importar app/database.");
  process.exit(1);
}
if (!process.env.DATABASE_URL.startsWith("file:")) {
  console.error("REFUSED: DATABASE_URL debe apuntar a un archivo local descartable, nunca a libsql://.");
  process.exit(1);
}
if (process.env.DATABASE_URL.toLowerCase().includes("dev.db")) {
  console.error("REFUSED: DATABASE_URL no puede apuntar a dev.db, ni siquiera con esquema file:.");
  process.exit(1);
}

interface CheckResult {
  name: string;
  pass: boolean;
  message?: string;
}
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
  if (actual !== expected) {
    throw new Error(`${label}: esperado ${JSON.stringify(expected)}, obtuve ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(`${label}: esperado true`);
}

function assertNotMatch(text: string, re: RegExp, label: string): void {
  if (re.test(text)) throw new Error(`${label}: "${text}" no debería matchear ${re}`);
}

// ─── Bootstrap de schema real — mismo mecanismo ya probado en
// duplicate-invalidation-consumers.runner.ts: bun:sqlite directo (nunca
// @libsql/client, para no abrir la conexión real antes de tiempo), aplicando
// los .sql reales de src/api/migrations + los 2 aplicadores TS (0035,
// necesario porque schema.ts ya declara sus columnas en
// policy_installments/rebillings; 0036, la migración de esta etapa) + las 3
// tablas pre-migración y las columnas untracked que ese mismo runner ya
// identificó y documentó.

function bootstrapPreMigrationTables(sqlite: Database): void {
  sqlite.run(`CREATE TABLE policy_installments (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    policy_id integer NOT NULL,
    number integer NOT NULL,
    due_date text NOT NULL,
    amount real NOT NULL,
    status text NOT NULL DEFAULT 'pendiente',
    notes text,
    created_at integer,
    FOREIGN KEY (policy_id) REFERENCES policies(id) ON UPDATE no action ON DELETE no action
  )`);
  sqlite.run(`CREATE TABLE task_templates (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    title text NOT NULL,
    description text,
    day_of_month integer,
    "order" integer NOT NULL DEFAULT 0,
    active integer NOT NULL DEFAULT 1,
    is_admin_only integer NOT NULL DEFAULT 0,
    created_by integer,
    created_at integer,
    FOREIGN KEY (created_by) REFERENCES users(id) ON UPDATE no action ON DELETE no action
  )`);
  sqlite.run(`CREATE TABLE tasks (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    template_id integer,
    month_year text NOT NULL,
    title text NOT NULL,
    description text,
    due_date text,
    status text NOT NULL DEFAULT 'pendiente',
    is_recurring integer NOT NULL DEFAULT 0,
    is_admin_only integer NOT NULL DEFAULT 0,
    created_by integer,
    created_at integer,
    completed_at integer,
    FOREIGN KEY (template_id) REFERENCES task_templates(id) ON UPDATE no action ON DELETE no action,
    FOREIGN KEY (created_by) REFERENCES users(id) ON UPDATE no action ON DELETE no action
  )`);
}

/** Aplica todos los .sql reales de src/api/migrations excepto los indicados en `excluded` (0035/0036 se aplican acá vía sus propios helpers TS, no como SQL crudo). */
function applyRealMigrationsExcept(sqlite: Database, migrationsDir: string, excluded: ReadonlySet<string>): void {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && !excluded.has(f))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) sqlite.run(stmt);
  }
}

/** Columnas de schema.ts que ninguna migración .sql agrega (llegaron por db:push directo) — mismas 6 que duplicate-invalidation-consumers.runner.ts ya documentó y usa. */
function bootstrapUntrackedColumns(sqlite: Database): void {
  sqlite.run(`ALTER TABLE policies ADD COLUMN is_fleet integer NOT NULL DEFAULT 0`);
  sqlite.run(`ALTER TABLE policies ADD COLUMN is_rebilling integer NOT NULL DEFAULT 0`);
  sqlite.run(`ALTER TABLE policies ADD COLUMN renewed_from_id integer`);
  sqlite.run(`ALTER TABLE policies ADD COLUMN parent_policy_id integer`);
  sqlite.run(`ALTER TABLE insureds ADD COLUMN created_by integer REFERENCES users(id)`);
  sqlite.run(`ALTER TABLE payments ADD COLUMN installment_id integer REFERENCES policy_installments(id)`);
}

async function buildDisposableSchema(path: string): Promise<void> {
  const { applyMigration0035TraceableDuplicateInvalidation } = await import(
    "../../lib/migrations/apply-0035-traceable-duplicate-invalidation"
  );
  const { applyMigration0036AccountHolderFunding } = await import(
    "../../lib/migrations/apply-0036-account-holder-funding"
  );
  const sqlite = new Database(path);
  try {
    sqlite.run("PRAGMA foreign_keys=ON");
    bootstrapPreMigrationTables(sqlite);
    const migrationsDir = join(import.meta.dir, "..", "migrations");
    applyRealMigrationsExcept(sqlite, migrationsDir, new Set([
      "0035_traceable_duplicate_invalidation.sql",
      "0036_account_holder_funding.sql",
    ]));
    bootstrapUntrackedColumns(sqlite);

    const sqlClient = {
      async execute(sql: string, params: unknown[] = []) {
        const stmt = sqlite.prepare(sql);
        try {
          const upper = sql.trim().toUpperCase();
          if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
            return { rows: stmt.all(...(params as any[])) as any[] };
          }
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

  // Único punto de este proceso donde se importan `app`/`database` — recién
  // acá, con DATABASE_URL ya validado y apuntando al temporal.
  const { default: app } = await import("../index");
  const { database: db } = await import("../database/index");
  const schema = await import("../database/schema");
  const { eq } = await import("drizzle-orm");
  const { parseFundingRequest } = await import("../../lib/payments/account-holder-funding-request");
  const { FundingIdempotencyConflictError } = await import("../account-holder-funding-batch");
  const { mapAccountHolderFundingBatchError, formatAccountHolderFundingBatchSuccess } = await import("../payment-batch-titular-response");

  async function countAll(table: any): Promise<number> {
    return (await db.select().from(table).all()).length;
  }

  const [u] = await db.insert(schema.users).values({
    name: "QA Titular HTTP", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: schema.users.id });
  const userId = u!.id;
  await db.insert(schema.sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const [company] = await db.insert(schema.companies).values({ name: `${PREFIX} Company` }).returning({ id: schema.companies.id });
  const companyId = company!.id;

  const [ins] = await db.insert(schema.insureds).values({ name: `${PREFIX} Titular`, createdBy: userId }).returning({ id: schema.insureds.id });
  const insuredId = ins!.id;

  const [p] = await db.insert(schema.policies).values({
    policyNumber: `${PREFIX}-${Date.now()}`, type: "automotor", status: "activa",
    companyId, insuredId, startDate: "2028-01-01", endDate: "2028-12-31", isRebilling: 0, createdBy: userId,
  }).returning({ id: schema.policies.id });
  const policyId = p!.id;

  async function mkInstallment(amount: number, dueDate: string = FIXTURE_DATE): Promise<number> {
    const [row] = await db.insert(schema.policyInstallments).values({
      policyId, number: 1, dueDate, amount, status: "pendiente", rendered: 0,
    }).returning({ id: schema.policyInstallments.id });
    return row!.id;
  }

  // ─── Caso 1 representativo — crédito preexistente aplicado + medios
  // reales POR MENOS del destino + ajuste de redondeo, todos combinados en
  // el mismo cobro (mismos montos que ya usa
  // payment-batch-titular-integration.test.ts, sección 1, para no inventar
  // una segunda combinación sin precedente: nominal 100000 = crédito 30000 +
  // redondeo 300 + cheque real 69700).
  const IDEMPOTENCY_KEY_1 = "qa-http-titular-1";
  let installment1Id!: number;
  let batch1Id!: number;

  function buildCase1Body() {
    return {
      paymentDate: FIXTURE_DATE,
      accountHolderInsuredId: insuredId,
      idempotencyKey: IDEMPOTENCY_KEY_1,
      creditAppliedCents: 30000,
      roundingCoverageCents: 300,
      items: [{ source: "installment", installmentId: installment1Id }],
      splits: [{
        method: "cheque",
        amount: 697, // 69700 centavos — real, MENOR al nominal de 1000 ($100000)
        checks: [{ checkNumber: "HTTP-1001", bankName: "Banco QA HTTP", dueDate: "2028-06-01", amount: 697 }],
      }],
    };
  }

  await check("1. primer request titular válido — crédito+medios(<destino)+redondeo: 201, movimientos/allocations/idempotencia correctos", async () => {
    installment1Id = await mkInstallment(1000); // $1000 = 100000 centavos

    // Crédito preexistente del titular — saldo_a_favor activo, sin
    // originBatchId (no nace de este cobro, ya existía antes).
    await db.insert(schema.insuredAccountMovements).values({
      insuredId, type: "saldo_a_favor", signedAmountCents: 30000, status: "activo", createdBy: userId, createdAt: new Date(),
    });

    const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
      method: "POST", headers: authHeaders(), body: JSON.stringify(buildCase1Body()),
    }));
    assertEqual(res.status, 201, "status");
    const json: any = await res.json();
    assertEqual(Object.keys(json).join(","), "id", "claves del body");
    assertEqual(typeof json.id, "number", "typeof json.id");
    batch1Id = json.id;

    const batchRows = await db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, batch1Id)).all();
    assertEqual(batchRows.length, 1, "cantidad de batches con este id");
    assertEqual(batchRows[0]!.accountHolderInsuredId, insuredId, "batch.accountHolderInsuredId");
    assertEqual(batchRows[0]!.status, "confirmado", "batch.status");
    assertEqual(batchRows[0]!.receivedAmountCents, 69700, "batch.receivedAmountCents (solo el medio real)");
    assertEqual(batchRows[0]!.totalReceivedCents, 100000, "batch.totalReceivedCents (nominal aplicado a la cuota)");

    const splitRows = await db.select().from(schema.paymentBatchSplits).where(eq(schema.paymentBatchSplits.batchId, batch1Id)).all();
    assertEqual(splitRows.length, 1, "cantidad de splits");
    const checkRows = await db.select().from(schema.receivedChecks).where(eq(schema.receivedChecks.batchSplitId, splitRows[0]!.id)).all();
    assertEqual(checkRows.length, 1, "cantidad de cheques");
    assertEqual(checkRows[0]!.checkNumber, "HTTP-1001", "checkNumber");
    assertEqual(checkRows[0]!.status, "en_cartera", "check.status");

    const paymentRows = await db.select().from(schema.payments).where(eq(schema.payments.batchId, batch1Id)).all();
    assertEqual(paymentRows.length, 1, "cantidad de payments");
    assertEqual(paymentRows[0]!.installmentId, installment1Id, "payment.installmentId");
    const paymentId = paymentRows[0]!.id;

    // Movimiento aplicacion_saldo_favor con signo correcto (negativo: consume
    // crédito) — solo el que NACE de este batch (originBatchId=batch1Id), no
    // el saldo_a_favor sembrado antes (ese queda con originBatchId=null).
    const movementRows = await db.select().from(schema.insuredAccountMovements).where(eq(schema.insuredAccountMovements.originBatchId, batch1Id)).all();
    assertEqual(movementRows.length, 1, "cantidad de movimientos originados por este batch");
    assertEqual(movementRows[0]!.type, "aplicacion_saldo_favor", "tipo del movimiento");
    assertEqual(movementRows[0]!.signedAmountCents, -30000, "signo del movimiento de crédito aplicado");
    const creditMovementId = movementRows[0]!.id;

    // Ajuste de redondeo con signo correcto (negativo: cubre faltante).
    const roundingRows = await db.select().from(schema.paymentAmountAdjustments).where(eq(schema.paymentAmountAdjustments.paymentBatchId, batch1Id)).all();
    assertEqual(roundingRows.length, 1, "cantidad de ajustes de redondeo");
    assertEqual(roundingRows[0]!.amountCents, -300, "signo/monto del ajuste de redondeo");
    const roundingAdjustmentId = roundingRows[0]!.id;

    // Funding allocations completas: las 3 fuentes (split real, movimiento de
    // crédito, ajuste de redondeo) financian el ÚNICO destino (el payment),
    // y la suma cierra exacto contra el nominal.
    const allocRows = await db.select().from(schema.paymentBatchFundingAllocations).where(eq(schema.paymentBatchFundingAllocations.paymentBatchId, batch1Id)).all();
    const allocsToPayment = allocRows.filter((r: any) => r.paymentId === paymentId);
    assertEqual(allocsToPayment.length, 3, "cantidad de allocations hacia el payment (split + crédito + redondeo)");
    const totalToPayment = allocsToPayment.reduce((s: number, r: any) => s + r.amountCents, 0);
    assertEqual(totalToPayment, 100000, "suma de allocations hacia el payment == nominal");
    assertTrue(allocsToPayment.some((r: any) => r.paymentBatchSplitId === splitRows[0]!.id), "una allocation referencia el split real");
    assertTrue(allocsToPayment.some((r: any) => r.sourceAccountMovementId === creditMovementId), "una allocation referencia el movimiento de crédito");
    assertTrue(allocsToPayment.some((r: any) => r.paymentAmountAdjustmentId === roundingAdjustmentId), "una allocation referencia el ajuste de redondeo");

    const idempRows = await db.select().from(schema.accountHolderFundingIdempotencyKeys).where(eq(schema.accountHolderFundingIdempotencyKeys.idempotencyKey, IDEMPOTENCY_KEY_1)).all();
    assertEqual(idempRows.length, 1, "cantidad de filas de idempotencia para esta key");
    assertEqual(idempRows[0]!.paymentBatchId, batch1Id, "idempotencia.paymentBatchId");
    assertEqual(idempRows[0]!.responseStatus, 201, "idempotencia.responseStatus");
    assertEqual(JSON.stringify(JSON.parse(idempRows[0]!.responseSnapshot)), JSON.stringify({ id: batch1Id }), "idempotencia.responseSnapshot");

    const instRow = await db.select().from(schema.policyInstallments).where(eq(schema.policyInstallments.id, installment1Id)).get();
    assertEqual(instRow?.status, "pagada", "installment.status");
  });

  await check("2. replay idéntico — mismo status/body/id, sin advertencias, cero filas nuevas", async () => {
    const instBefore = await db.select({ status: schema.policyInstallments.status }).from(schema.policyInstallments).where(eq(schema.policyInstallments.id, installment1Id)).get();
    assertEqual(instBefore?.status, "pagada", "precondición: la cuota ya está pagada");
    const checksBefore = await countAll(schema.receivedChecks);
    assertTrue(checksBefore > 0, "precondición: ya hay al menos un cheque registrado");

    const beforeBatches = await countAll(schema.paymentBatches);
    const beforePayments = await countAll(schema.payments);
    const beforeSplits = await countAll(schema.paymentBatchSplits);
    const beforeChecks = await countAll(schema.receivedChecks);
    const beforeIdemp = await countAll(schema.accountHolderFundingIdempotencyKeys);
    const beforeAllocs = await countAll(schema.paymentBatchFundingAllocations);
    const beforeMovements = await countAll(schema.insuredAccountMovements);
    const beforeAdjustments = await countAll(schema.paymentAmountAdjustments);

    const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
      method: "POST", headers: authHeaders(), body: JSON.stringify(buildCase1Body()),
    }));

    assertEqual(res.status, 201, "status del replay");
    const json: any = await res.json();
    assertEqual(JSON.stringify(json), JSON.stringify({ id: batch1Id }), "body del replay");

    assertEqual(await countAll(schema.paymentBatches), beforeBatches, "payment_batches sin filas nuevas");
    assertEqual(await countAll(schema.payments), beforePayments, "payments sin filas nuevas");
    assertEqual(await countAll(schema.paymentBatchSplits), beforeSplits, "payment_batch_splits sin filas nuevas");
    assertEqual(await countAll(schema.receivedChecks), beforeChecks, "received_checks sin filas nuevas");
    assertEqual(await countAll(schema.accountHolderFundingIdempotencyKeys), beforeIdemp, "idempotencia sin filas nuevas");
    assertEqual(await countAll(schema.paymentBatchFundingAllocations), beforeAllocs, "allocations sin filas nuevas");
    assertEqual(await countAll(schema.insuredAccountMovements), beforeMovements, "movimientos sin filas nuevas");
    assertEqual(await countAll(schema.paymentAmountAdjustments), beforeAdjustments, "ajustes de redondeo sin filas nuevas");
  });

  await check("3. misma idempotencyKey, contenido distinto — 409 de dominio, sin filas nuevas", async () => {
    const body: any = buildCase1Body();
    body.notes = "contenido distinto a propósito — debe cambiar el fingerprint";

    const beforeBatches = await countAll(schema.paymentBatches);
    const beforePayments = await countAll(schema.payments);
    const beforeIdemp = await countAll(schema.accountHolderFundingIdempotencyKeys);

    const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
      method: "POST", headers: authHeaders(), body: JSON.stringify(body),
    }));

    assertEqual(res.status, 409, "status");
    const json: any = await res.json();
    assertEqual(typeof json.error, "string", "typeof body.error");
    assertTrue(json.error.length > 0, "body.error no vacío");
    assertNotMatch(JSON.stringify(json), /SQLITE|UNIQUE constraint|node_modules|\.ts:\d+:\d+|at Object\.|at async/i, "body no expone detalles internos");

    assertEqual(await countAll(schema.paymentBatches), beforeBatches, "payment_batches sin filas nuevas");
    assertEqual(await countAll(schema.payments), beforePayments, "payments sin filas nuevas");
    assertEqual(await countAll(schema.accountHolderFundingIdempotencyKeys), beforeIdemp, "idempotencia sin filas nuevas");
  });

  await check("4. snapshot de idempotencia cacheado inválido — 500 seguro, sin fugas, sin filas nuevas", async () => {
    const installment4Id = await mkInstallment(500);
    const idemKey4 = "qa-http-titular-4";
    const body = {
      paymentDate: FIXTURE_DATE,
      accountHolderInsuredId: insuredId,
      idempotencyKey: idemKey4,
      items: [{ source: "installment", installmentId: installment4Id }],
      splits: [{ method: "efectivo", amount: 500 }],
    };

    const parsed = parseFundingRequest(body);
    const corruptSnapshot = "{esto no es json valido, falta cerrar la llave";
    await db.insert(schema.accountHolderFundingIdempotencyKeys).values({
      createdBy: userId,
      endpoint: ENDPOINT,
      idempotencyKey: idemKey4,
      requestFingerprint: parsed.fingerprint,
      paymentBatchId: batch1Id,
      responseStatus: 201,
      responseSnapshot: corruptSnapshot,
      createdAt: new Date(),
    });

    const beforeBatches = await countAll(schema.paymentBatches);
    const beforePayments = await countAll(schema.payments);

    const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
      method: "POST", headers: authHeaders(), body: JSON.stringify(body),
    }));

    assertEqual(res.status, 500, "status");
    const json: any = await res.json();
    assertEqual(json.error, "No se pudo interpretar la respuesta almacenada del cobro con titular — contactá soporte.", "body.error");

    const rawText = JSON.stringify(json);
    assertTrue(!rawText.includes("esto no es json valido"), "no filtra el snapshot crudo");
    assertNotMatch(rawText, /SyntaxError|Unexpected token|node_modules|\.ts:\d+:\d+|at Object\.|SQLITE/i, "no filtra stack/errores internos");

    assertEqual(await countAll(schema.paymentBatches), beforeBatches, "payment_batches sin filas nuevas");
    assertEqual(await countAll(schema.payments), beforePayments, "payments sin filas nuevas");

    const instRow = await db.select({ status: schema.policyInstallments.status }).from(schema.policyInstallments).where(eq(schema.policyInstallments.id, installment4Id)).get();
    assertEqual(instRow?.status, "pendiente", "la cuota nunca se procesó");
  });

  await check("5a. FundingIdempotencyConflictError pasa por mapAccountHolderFundingBatchError -> 409 { error }", async () => {
    const mapped = mapAccountHolderFundingBatchError(new FundingIdempotencyConflictError("mensaje de dominio cualquiera"));
    assertTrue(mapped !== null, "mapped no es null");
    assertEqual(mapped!.status, 409, "status mapeado");
    assertTrue(Object.prototype.hasOwnProperty.call(mapped!.body as object, "error"), "body mapeado tiene 'error'");
  });

  await check("5b. snapshot corrupto lo resuelve formatAccountHolderFundingBatchSuccess (nunca lanza, nunca pasa por mapAccountHolderFundingBatchError)", async () => {
    const formatted = formatAccountHolderFundingBatchSuccess({
      paymentBatchId: batch1Id,
      responseStatus: 201,
      responseSnapshot: "{esto no es json valido, falta cerrar la llave",
    });
    assertEqual(formatted.status, 500, "status");
    assertEqual(
      JSON.stringify(formatted.body),
      JSON.stringify({ error: "No se pudo interpretar la respuesta almacenada del cobro con titular — contactá soporte." }),
      "body"
    );
  });

  const allPass = results.every((r) => r.pass);
  process.stdout.write(`RESULT_JSON:${JSON.stringify({ results })}\n`);

  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Mismo motivo que el resto de la suite: la conexión @libsql/client
    // sigue abierta hasta que termina el proceso (nunca la cierra
    // database/index.ts), así que en Windows el archivo puede quedar
    // bloqueado (EBUSY). Es un tmpdir de un solo uso de este proceso hijo
    // que está por terminar de todos modos — el SO lo recicla.
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((e: any) => {
  console.error(`[payment-batch-titular-endpoint.runner] fallo antes de completar las verificaciones: ${e?.stack ?? e}`);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
