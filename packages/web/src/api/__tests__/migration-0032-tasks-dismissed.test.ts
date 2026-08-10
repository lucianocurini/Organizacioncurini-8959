/**
 * Prueba el aplicador idempotente de la migración 0032 (tasks.dismissed).
 * Puramente aditiva (ninguna tabla se recrea) — se arma una base temporal
 * en el scratchpad del sistema con el esquema PRE-0032 de tasks/
 * task_templates (tal como está hoy, sin dismissed) más el mínimo de users
 * necesario. Se borra al finalizar. No toca dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0032TasksDismissed,
  applyMigration0032TasksDismissedWork,
  type Sql0032Client,
} from "../../lib/migrations/apply-0032-tasks-dismissed";

function wrapBunSqlite(db: Database): Sql0032Client {
  return {
    async execute(sql: string, params: any[] = []) {
      const stmt = db.prepare(sql);
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
  };
}

let tmpDir: string | null = null;
let db: Database | null = null;

afterEach(async () => {
  db?.close();
  db = null;
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

function makePreMigrationDb(): Sql0032Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0032-test-"));
  const dbPath = join(tmpDir, "pre-0032.db");
  db = new Database(dbPath);
  db.run("PRAGMA foreign_keys=ON");
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  // Esquema exacto de task_templates/tasks tal como está hoy (sin
  // migración versionada previa — ver diagnóstico: estas tablas llegaron
  // por db:push directo, nunca tuvieron un archivo de migración propio).
  db.run(`
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
  db.run(`
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
  return wrapBunSqlite(db);
}

function insertTemplate(title = "Template QA"): number {
  const row = db!.query(
    `INSERT INTO task_templates (title, "order", created_at) VALUES (?, 1, 0) RETURNING id`
  ).get(title) as any;
  return row.id;
}

function insertTask(templateId: number | null, monthYear: string, isRecurring = 1): number {
  const row = db!.query(
    `INSERT INTO tasks (template_id, month_year, title, is_recurring, created_at) VALUES (?, ?, 'Tarea', ?, 0) RETURNING id`
  ).get(templateId, monthYear, isRecurring) as any;
  return row.id;
}

describe("0032 — agrega la columna", () => {
  test("dismissed no existe antes, existe después", async () => {
    const client = makePreMigrationDb();
    const before = await client.execute("PRAGMA table_info(tasks)");
    expect((before.rows as any[]).some((c) => c.name === "dismissed")).toBe(false);

    const summary = await applyMigration0032TasksDismissed(client);
    expect(summary.dismissedColumnAdded).toBe(true);

    const after = await client.execute("PRAGMA table_info(tasks)");
    const col = (after.rows as any[]).find((c) => c.name === "dismissed");
    expect(col).toBeDefined();
    expect(col.notnull).toBe(1);
    expect(col.dflt_value).toBe("0");
  });
});

describe("0032 — conserva filas históricas", () => {
  test("no cambia la cantidad de filas de tasks", async () => {
    const client = makePreMigrationDb();
    const tplId = insertTemplate();
    insertTask(tplId, "2026-08");
    insertTask(null, "2026-08", 0); // tarea única

    const summary = await applyMigration0032TasksDismissed(client);
    expect(summary.tasksBefore).toBe(2);
    expect(summary.tasksAfter).toBe(2);
  });

  test("filas existentes quedan dismissed=0 (comportamiento correcto: nada fue descartado)", async () => {
    const client = makePreMigrationDb();
    const tplId = insertTemplate();
    const taskId = insertTask(tplId, "2026-08");

    const summary = await applyMigration0032TasksDismissed(client);
    expect(summary.dismissedTrueAfter).toBe(0);

    const row = db!.query("SELECT dismissed FROM tasks WHERE id = ?").get(taskId) as any;
    expect(row.dismissed).toBe(0);
  });

  test("una fila histórica conserva todos sus demás campos intactos", async () => {
    const client = makePreMigrationDb();
    const tplId = insertTemplate("Cierre de mes");
    const taskId = insertTask(tplId, "2026-08");
    db!.run("UPDATE tasks SET status = 'realizada' WHERE id = ?", [taskId]);

    await applyMigration0032TasksDismissed(client);

    const row = db!.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
    expect(row.status).toBe("realizada");
    expect(row.template_id).toBe(tplId);
    expect(row.month_year).toBe("2026-08");
  });
});

describe("0032 — idempotencia", () => {
  test("segunda corrida no duplica la columna, alreadyApplied=true", async () => {
    const client = makePreMigrationDb();
    insertTask(insertTemplate(), "2026-08");

    const first = await applyMigration0032TasksDismissed(client);
    expect(first.alreadyApplied).toBe(false);
    expect(first.dismissedColumnAdded).toBe(true);

    const second = await applyMigration0032TasksDismissed(client);
    expect(second.alreadyApplied).toBe(true);
    expect(second.dismissedColumnAdded).toBe(false);
    expect(second.tasksAfter).toBe(1);

    const cols = await client.execute("PRAGMA table_info(tasks)");
    expect((cols.rows as any[]).filter((c) => c.name === "dismissed").length).toBe(1);
  });
});

// ─── Work vs. wrapper local — no controla transacciones por sí misma ────────
describe("0032 — applyMigration0032TasksDismissedWork no controla transacciones", () => {
  function wrapRecording(base: Sql0032Client): { client: Sql0032Client; sqlLog: string[] } {
    const sqlLog: string[] = [];
    return {
      sqlLog,
      client: {
        async execute(sql: string, params: any[] = []) {
          sqlLog.push(sql.trim());
          return base.execute(sql, params);
        },
      },
    };
  }

  test("no emite BEGIN/COMMIT/ROLLBACK", async () => {
    const base = makePreMigrationDb();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0032TasksDismissedWork(client);

    const controlStatements = sqlLog.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql));
    expect(controlStatements).toEqual([]);
  });

  test("el wrapper local sí emite BEGIN y COMMIT", async () => {
    const base = makePreMigrationDb();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0032TasksDismissed(client);

    expect(sqlLog.some((sql) => /^BEGIN\b/i.test(sql))).toBe(true);
    expect(sqlLog.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
  });
});
