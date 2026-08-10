/**
 * Compatibilidad del auto-generador de tareas recurrentes (GET /tasks,
 * index.ts) durante la ventana de despliegue en la que 0032 ya corrió pero
 * 0033 todavía no (p.ej. porque el preflight de producción encontró
 * duplicados preexistentes y la bloqueó — ver scripts/preflight-0033-prod.ts).
 * En ese estado el código NO debe romperse bajo ninguna circunstancia.
 *
 * Usa @libsql/client + drizzle-orm/libsql en modo archivo — el mismo driver
 * que produce database/index.ts contra Turso — para no depender de una
 * particularidad de bun:sqlite. Reutiliza el objeto `tasks` real de
 * database/schema.ts para que el INSERT ejercitado sea exactamente el mismo
 * que corre index.ts, no una reimplementación.
 *
 * Tres estados:
 *   A) ANTES de 0032 — referencia: confirma que el esquema previo no tiene
 *      `dismissed` (por eso 0032 es prerequisito, no solo aditivo por
 *      prolijidad).
 *   B) DESPUÉS de 0032, ANTES de 0033 — el sistema sigue funcionando: el
 *      INSERT con onConflictDoNothing() SIN target no revienta (a
 *      diferencia de la versión anterior CON target, que si revienta).
 *      Sin el índice de 0033 todavía no hay garantía anti-duplicado — eso
 *      es esperado en este estado, no un bug.
 *   C) DESPUÉS de 0032 + 0033 — dos inserts concurrentes (simulando dos GET
 *      simultáneos) generan como máximo una fila por template/mes.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { tasks } from "../database/schema";

let tmpDir: string | null = null;
let client: Client | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  if (tmpDir) {
    const dir = tmpDir;
    tmpDir = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (attempt === 14) throw e;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}, 15000);

async function newFileClient(name: string): Promise<Client> {
  tmpDir = mkdtempSync(join(tmpdir(), "tasks-migration-sequence-"));
  const c = createClient({ url: `file:${join(tmpDir, name)}` });
  client = c;
  return c;
}

// Esquema tal como está hoy en schema.ts, MENOS `dismissed` — llegó por
// db:push directo, sin migración .sql propia (mismo criterio que
// migration-0032-tasks-dismissed.test.ts).
async function createPreexistingTaskTables(c: Client): Promise<void> {
  await c.execute(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  await c.execute(`
    CREATE TABLE task_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      day_of_month INTEGER,
      "order" INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      is_admin_only INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at INTEGER
    )
  `);
  await c.execute(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER REFERENCES task_templates(id),
      month_year TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'pendiente',
      is_recurring INTEGER NOT NULL DEFAULT 0,
      is_admin_only INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at INTEGER,
      completed_at INTEGER
    )
  `);
}

// task_templates.id=1 y 2 — necesarios porque tasks.template_id referencia
// task_templates(id) y @libsql/client aplica foreign_keys=ON por defecto.
async function seedTemplates(c: Client): Promise<void> {
  await c.execute(`INSERT INTO task_templates (id, title) VALUES (1, 'QA Template A'), (2, 'QA Template B')`);
}

async function applyMigration0032(c: Client): Promise<void> {
  await c.execute(`ALTER TABLE tasks ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0`);
}

async function applyMigration0033(c: Client): Promise<void> {
  await c.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_template_month_unique ON tasks(template_id, month_year)`);
}

function autogenInsertValues(templateId: number, monthYear: string) {
  return {
    templateId,
    monthYear,
    title: "QA Recurrente",
    description: null,
    dueDate: null,
    status: "pendiente" as const,
    isRecurring: 1,
    isAdminOnly: 0,
    createdBy: null,
  };
}

describe("Estado A — antes de 0032 (referencia)", () => {
  test("el esquema previo no tiene la columna dismissed que el código actual requiere", async () => {
    const c = await newFileClient("state-a.db");
    await createPreexistingTaskTables(c);

    const cols = await c.execute(`PRAGMA table_info(tasks)`);
    expect(cols.rows.some((r: any) => r.name === "dismissed")).toBe(false);

    // Cualquier consulta que dependa de `dismissed` (como el GET /tasks
    // actual) falla contra este esquema — por eso 0032 es prerequisito
    // real, no solo una mejora aditiva "por las dudas".
    await expect(c.execute(`SELECT dismissed FROM tasks`)).rejects.toThrow();
  });
});

describe("Estado B — después de 0032, antes de 0033", () => {
  test("con conflict target explícito (código viejo): el INSERT revienta sin el índice único", async () => {
    const c = await newFileClient("state-b-old.db");
    await createPreexistingTaskTables(c);
    await seedTemplates(c);
    await applyMigration0032(c);
    const db = drizzle(c);

    let thrown: Error | null = null;
    try {
      await db.insert(tasks).values(autogenInsertValues(1, "2027-01"))
        .onConflictDoNothing({ target: [tasks.templateId, tasks.monthYear] });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    // Drizzle envuelve el error original de SQLite en DrizzleQueryError — el
    // mensaje de bajo nivel ("ON CONFLICT clause does not match...") queda
    // en `cause`, no en `message`.
    const rootMessage = (thrown as any)?.cause?.message ?? thrown!.message;
    expect(rootMessage).toMatch(/ON CONFLICT clause does not match/i);
  });

  test("sin conflict target (código corregido): el INSERT no revienta aunque no exista el índice único todavía", async () => {
    const c = await newFileClient("state-b-new.db");
    await createPreexistingTaskTables(c);
    await seedTemplates(c);
    await applyMigration0032(c);
    const db = drizzle(c);

    // No debe lanzar — este es el requisito central: el sistema sigue
    // funcionando en este estado de transición.
    await db.insert(tasks).values(autogenInsertValues(1, "2027-01")).onConflictDoNothing();

    const rows = await c.execute(`SELECT * FROM tasks`);
    expect(rows.rows.length).toBe(1);
  });

  test("sin conflict target: dos GET secuenciales del mismo mes SÍ pueden duplicar (esperado — sin garantía UNIQUE todavía)", async () => {
    const c = await newFileClient("state-b-race.db");
    await createPreexistingTaskTables(c);
    await seedTemplates(c);
    await applyMigration0032(c);
    const db = drizzle(c);

    // Simula dos GET que ambos pasan el chequeo "no existe" antes de
    // insertar (la condición de carrera real ocurre en index.ts al leer
    // `existing` antes de este INSERT). Acá solo se verifica la mitad que
    // depende del esquema: el INSERT en sí no protege contra el duplicado
    // sin el índice de 0033 — comportamiento aceptado explícitamente para
    // este estado de transición, no una regresión.
    await db.insert(tasks).values(autogenInsertValues(1, "2027-01")).onConflictDoNothing();
    await db.insert(tasks).values(autogenInsertValues(1, "2027-01")).onConflictDoNothing();

    const rows = await c.execute(`SELECT * FROM tasks WHERE template_id = 1 AND month_year = '2027-01'`);
    expect(rows.rows.length).toBe(2); // documenta la ausencia de garantía, no la exige
  });
});

describe("Estado C — después de 0032 + 0033", () => {
  test("dos inserts concurrentes generan como máximo una fila por template/mes", async () => {
    const c = await newFileClient("state-c.db");
    await createPreexistingTaskTables(c);
    await seedTemplates(c);
    await applyMigration0032(c);
    await applyMigration0033(c);
    const db = drizzle(c);

    await Promise.all([
      db.insert(tasks).values(autogenInsertValues(1, "2027-02")).onConflictDoNothing(),
      db.insert(tasks).values(autogenInsertValues(1, "2027-02")).onConflictDoNothing(),
    ]);

    const rows = await c.execute(`SELECT * FROM tasks WHERE template_id = 1 AND month_year = '2027-02'`);
    expect(rows.rows.length).toBe(1); // la garantía UNIQUE + onConflictDoNothing() se aprovecha automáticamente
  });

  test("templates/meses distintos no compiten entre sí (NULL/valores distintos no colisionan)", async () => {
    const c = await newFileClient("state-c-distinct.db");
    await createPreexistingTaskTables(c);
    await seedTemplates(c);
    await applyMigration0032(c);
    await applyMigration0033(c);
    const db = drizzle(c);

    await db.insert(tasks).values(autogenInsertValues(1, "2027-03")).onConflictDoNothing();
    await db.insert(tasks).values(autogenInsertValues(2, "2027-03")).onConflictDoNothing(); // otro template
    await db.insert(tasks).values(autogenInsertValues(1, "2027-04")).onConflictDoNothing(); // otro mes

    const rows = await c.execute(`SELECT * FROM tasks`);
    expect(rows.rows.length).toBe(3);
  });
});
