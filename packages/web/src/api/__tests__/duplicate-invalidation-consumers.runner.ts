/**
 * Runner de PROCESO HIJO para duplicate-invalidation-consumers.test.ts.
 *
 * Por qué existe: `app` (src/api/index.ts) y `database` (src/api/database/
 * index.ts) abren su conexión a `process.env.DATABASE_URL` UNA sola vez, al
 * importarse, y ESM cachea el módulo por proceso. Cuando este archivo vivía
 * en el proceso principal de `bun test`, si CUALQUIER otro archivo de la
 * suite completa ya había importado `app`/`database` antes de que este
 * `beforeAll` corriera (algo que no se puede controlar ni predecir — depende
 * del orden de descubrimiento de `bun test`), el import dinámico de acá
 * devolvía el módulo YA cacheado apuntando a `dev.db` real, no a la DB
 * descartable de este archivo. Resultado: los `app.fetch(...)` de este
 * archivo escribían fixtures reales (incluida una cuota `status='duplicada'`)
 * en `dev.db`, contaminando otro test de la suite completa (+1 fail que no
 * aparecía corriendo este archivo solo).
 *
 * La única forma de garantizar que `app`/`database` se importen por primera
 * vez apuntando a la DB descartable es que ese primer import ocurra en un
 * PROCESO NUEVO que no comparte caché de módulos con el resto de la suite —
 * de ahí este archivo, lanzado vía Bun.spawn desde el wrapper
 * (duplicate-invalidation-consumers.test.ts), nunca importado directamente.
 *
 * No matchea *.test.ts a propósito: `bun test` no lo descubre ni lo corre
 * como test propio; solo existe como script standalone invocado por spawn.
 *
 * Contrato con el wrapper: imprime una única línea "RESULT_JSON:{...}" con
 * los resultados de las 8 verificaciones y termina con exit code 0 solo si
 * las 8 pasaron (1 en cualquier otro caso, incluyendo fallas de setup antes
 * de poder correr ninguna verificación).
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SESSION_ID = "test-session-dup-invalidation-001";
const USER_EMAIL = "test-dup-invalidation@test.local";
const PREFIX = "TEST-DUP-INVALIDATION";

const tmpDir = mkdtempSync(join(tmpdir(), "duplicate-invalidation-consumers-"));
const dbPath = join(tmpDir, "disposable.db");

// Defensa en profundidad, además de la guarda real en
// src/api/database/assert-safe-environment.ts: forzamos ACÁ, ANTES de
// importar cualquier módulo que abra una conexión, a que apunten
// exclusivamente a este archivo descartable de este proceso — nunca a
// dev.db ni a Turso, sin importar qué haya en el entorno heredado del
// proceso padre.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.DATABASE_AUTH_TOKEN = "local-test-disposable";

if (!process.env.DATABASE_URL.startsWith("file:")) {
  console.error("REFUSED: DATABASE_URL debe apuntar a un archivo local descartable, nunca a libsql://.");
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

function assertMatch(actual: string, re: RegExp, label: string): void {
  if (!re.test(actual ?? "")) {
    throw new Error(`${label}: "${actual}" no matchea ${re}`);
  }
}

// Tablas que ninguna migración de src/api/migrations/*.sql CREA (existían
// antes de que este repo empezara a trackear migraciones con drizzle-kit;
// las posteriores solo las ALTERan) — mismo hallazgo y mismas 3 tablas que
// scripts/local-qa-build-db.ts documenta para reconstruir dev.db localmente.
function bootstrapPreMigrationTables(sqlite: Database): void {
  sqlite.run(`
    CREATE TABLE policy_installments (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      policy_id integer NOT NULL,
      number integer NOT NULL,
      due_date text NOT NULL,
      amount real NOT NULL,
      status text NOT NULL DEFAULT 'pendiente',
      notes text,
      created_at integer,
      FOREIGN KEY (policy_id) REFERENCES policies(id) ON UPDATE no action ON DELETE no action
    )
  `);
  sqlite.run(`
    CREATE TABLE task_templates (
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
    )
  `);
  sqlite.run(`
    CREATE TABLE tasks (
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
    )
  `);
}

function applyRealMigrations0000to0034(sqlite: Database): void {
  const migrationsDir = join(import.meta.dir, "..", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && f !== "0035_traceable_duplicate_invalidation.sql")
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) sqlite.run(stmt);
  }
}

// Columnas de schema.ts que existen en la DB real pero que NINGÚN archivo de
// src/api/migrations/*.sql agrega (confirmado con grep) — llegaron por
// db:push directo en algún momento. Mismo hallazgo que
// scripts/local-qa-build-db.ts para policies/insureds; payments.installment_id
// es central para los endpoints que este runner ejercita.
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
  const sqlite = new Database(path);
  try {
    sqlite.run("PRAGMA foreign_keys=ON");
    bootstrapPreMigrationTables(sqlite);
    applyRealMigrations0000to0034(sqlite);
    bootstrapUntrackedColumns(sqlite);
    await applyMigration0035TraceableDuplicateInvalidation({
      async execute(sql: string, params: any[] = []) {
        const stmt = sqlite.prepare(sql);
        try {
          const upper = sql.trim().toUpperCase();
          if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
            return { rows: stmt.all(...params) as any[] };
          }
          stmt.run(...params);
          return { rows: [] };
        } finally {
          stmt.finalize();
        }
      },
    });
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
  const {
    users, sessions, policies, companies, insureds, policyInstallments,
    payments, remittanceItems,
  } = await import("../database/schema");
  const { eq } = await import("drizzle-orm");

  const [u] = await db.insert(users).values({
    name: "Test Dup Invalidation", email: USER_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  const userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });

  const [company] = await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id });
  const companyId = company!.id;

  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  const insuredId = ins!.id;

  async function mkPolicy(): Promise<number> {
    const [p] = await db.insert(policies).values({
      policyNumber: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: "automotor", status: "activa", companyId, insuredId,
      startDate: "2027-01-01", endDate: "2027-12-31", isRebilling: 0, createdBy: userId,
    }).returning({ id: policies.id });
    return p!.id;
  }

  async function mkInstallment(policyId: number, dueDate: string, amount: number, status = "pendiente"): Promise<number> {
    const [i] = await db.insert(policyInstallments).values({
      policyId, number: 1, dueDate, amount, status, rendered: 0,
    }).returning({ id: policyInstallments.id });
    return i!.id;
  }

  await check("POST /payments — 409, no crea ningún payment, la cuota queda intacta", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2027-06-01", 1000, "duplicada");

    const res = await app.fetch(new Request("http://localhost/api/payments", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ policyId, installmentId: instId, amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-06-01", splits: [{ method: "efectivo", amount: 1000 }] }),
    }));
    assertEqual(res.status, 409, "status");
    const body = await res.json();
    assertMatch(body.error, /duplicado invalidado/, "body.error");

    const payRows = await db.select({ id: payments.id }).from(payments).where(eq(payments.installmentId, instId)).all();
    assertEqual(payRows.length, 0, "payments creados");
    const inst = await db.select({ status: policyInstallments.status }).from(policyInstallments).where(eq(policyInstallments.id, instId)).get();
    assertEqual(inst?.status, "duplicada", "status de la cuota");
  });

  await check("GET /installments/pending-for-payment — cuota duplicada ausente, gemela real presente", async () => {
    const policyId = await mkPolicy();
    const dupId = await mkInstallment(policyId, "2027-06-01", 1000, "duplicada");
    const realId = await mkInstallment(policyId, "2027-07-01", 1000, "pendiente");

    const res = await app.fetch(new Request(`http://localhost/api/installments/pending-for-payment?policyId=${policyId}`, { headers: authHeaders() }));
    const body: any[] = await res.json();
    const ids = body.map((r) => r.installmentId);
    if (ids.includes(dupId)) throw new Error("la cuota duplicada aparece en pending-for-payment");
    if (!ids.includes(realId)) throw new Error("la cuota real (gemela) no aparece en pending-for-payment");
  });

  await check("POST /payment-batches — 409, no crea el lote ni ningún payment", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2027-06-01", 1000, "duplicada");

    const res = await app.fetch(new Request("http://localhost/api/payment-batches", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        paymentDate: "2027-06-01",
        items: [{ source: "installment", installmentId: instId }],
        splits: [{ method: "efectivo", amount: 1000 }],
      }),
    }));
    assertEqual(res.status, 409, "status");
    const body = await res.json();
    assertMatch(body.error, /duplicado invalidado/, "body.error");

    const payRows = await db.select({ id: payments.id }).from(payments).where(eq(payments.installmentId, instId)).all();
    assertEqual(payRows.length, 0, "payments creados");
  });

  await check("GET /remittances/uncollected — cuota duplicada ausente de adeudadas", async () => {
    const policyId = await mkPolicy();
    const dupId = await mkInstallment(policyId, "2027-06-01", 1000, "duplicada");

    const res = await app.fetch(new Request("http://localhost/api/remittances/uncollected", { headers: authHeaders() }));
    const body: any[] = await res.json();
    if (body.map((r) => r.id).includes(dupId)) throw new Error("la cuota duplicada aparece como adeudada");
  });

  await check("POST /remittances — 409, no crea la rendición", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2027-06-01", 1000, "duplicada");
    const insured = await db.select({ name: insureds.name }).from(insureds).where(eq(insureds.id, insuredId)).get();
    const policyRow = await db.select({ policyNumber: policies.policyNumber }).from(policies).where(eq(policies.id, policyId)).get();
    const company = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).get();

    const res = await app.fetch(new Request("http://localhost/api/remittances", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        date: "2027-06-01", canal: "efectivo",
        paymentBreakdown: { efectivo: 1000 },
        items: [{
          source: "installment", sourceId: instId, amount: 1000, debtorStatus: "adeudado",
          clientName: insured?.name, policyNumber: policyRow?.policyNumber, companyName: company?.name, paymentMethod: "efectivo",
        }],
      }),
    }));
    assertEqual(res.status, 409, "status");
    const body = await res.json();
    assertMatch(body.error, /duplicado invalidado/, "body.error");

    const remRows = await db.select({ id: remittanceItems.id }).from(remittanceItems).where(eq(remittanceItems.sourceId, instId)).all();
    assertEqual(remRows.length, 0, "remittance items creados");
  });

  await check("PUT /installments/:id — editar duplicada → 409, no cambia nada", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2027-06-01", 1000, "duplicada");

    const res = await app.fetch(new Request(`http://localhost/api/installments/${instId}`, {
      method: "PUT", headers: authHeaders(), body: JSON.stringify({ amount: 9999 }),
    }));
    assertEqual(res.status, 409, "status");

    const row = await db.select({ amount: policyInstallments.amount, status: policyInstallments.status }).from(policyInstallments).where(eq(policyInstallments.id, instId)).get();
    assertEqual(row?.amount, 1000, "amount");
    assertEqual(row?.status, "duplicada", "status");
  });

  await check("PUT /installments/:id — marcar real como duplicada vía genérica → 400, rechazada", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2027-06-01", 1000, "pendiente");

    const res = await app.fetch(new Request(`http://localhost/api/installments/${instId}`, {
      method: "PUT", headers: authHeaders(), body: JSON.stringify({ status: "duplicada" }),
    }));
    assertEqual(res.status, 400, "status");

    const row = await db.select({ status: policyInstallments.status }).from(policyInstallments).where(eq(policyInstallments.id, instId)).get();
    assertEqual(row?.status, "pendiente", "status");
  });

  await check("PUT /installments/:id — editar real (no duplicada) sigue funcionando (200)", async () => {
    const policyId = await mkPolicy();
    const instId = await mkInstallment(policyId, "2027-06-01", 1000, "pendiente");

    const res = await app.fetch(new Request(`http://localhost/api/installments/${instId}`, {
      method: "PUT", headers: authHeaders(), body: JSON.stringify({ notes: "nota normal" }),
    }));
    assertEqual(res.status, 200, "status");
    const row = await db.select({ notes: policyInstallments.notes }).from(policyInstallments).where(eq(policyInstallments.id, instId)).get();
    assertEqual(row?.notes, "nota normal", "notes");
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
  console.error(`[duplicate-invalidation-consumers.runner] fallo antes de completar las verificaciones: ${e?.stack ?? e}`);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
