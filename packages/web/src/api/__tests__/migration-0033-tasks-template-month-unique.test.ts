/**
 * Prueba el aplicador idempotente de la migración 0033 (índice único
 * (template_id, month_year) en tasks). A diferencia de 0031/0032, esta
 * migración puede fallar de forma legítima si ya existen duplicados —
 * exactamente el escenario que el usuario reportó como posible en
 * producción. El foco de esta suite es probar ambos caminos: sin
 * duplicados (crea el índice) y CON duplicados preexistentes (se bloquea
 * sin tocar ninguna fila, sin deduplicar nada automáticamente).
 *
 * Base temporal en el scratchpad del sistema con el esquema POST-0032 de
 * tasks (ya con dismissed, como quedaría en cualquier entorno real donde
 * 0033 se aplica después de 0032). Se borra al finalizar. No toca dev.db
 * ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0033TasksTemplateMonthUnique,
  applyMigration0033TasksTemplateMonthUniqueWork,
  findDuplicateTemplateMonthGroups,
  type Sql0033Client,
} from "../../lib/migrations/apply-0033-tasks-template-month-unique";

function wrapBunSqlite(db: Database): Sql0033Client {
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

function makePost0032Db(): Sql0033Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0033-test-"));
  const dbPath = join(tmpDir, "post-0032.db");
  db = new Database(dbPath);
  db.run("PRAGMA foreign_keys=ON");
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  db.run(`
    CREATE TABLE task_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      "order" INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER REFERENCES task_templates(id),
      month_year TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendiente',
      is_recurring INTEGER NOT NULL DEFAULT 0,
      dismissed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER
    )
  `);
  return wrapBunSqlite(db);
}

function insertTemplate(title = "Template QA"): number {
  const row = db!.query(`INSERT INTO task_templates (title, "order", created_at) VALUES (?, 1, 0) RETURNING id`).get(title) as any;
  return row.id;
}

function insertTask(templateId: number | null, monthYear: string, isRecurring = 1, dismissed = 0): number {
  const row = db!.query(
    `INSERT INTO tasks (template_id, month_year, title, is_recurring, dismissed, created_at) VALUES (?, ?, 'Tarea', ?, ?, 0) RETURNING id`
  ).get(templateId, monthYear, isRecurring, dismissed) as any;
  return row.id;
}

describe("0033 — sin duplicados: crea el índice", () => {
  test("crea idx_tasks_template_month_unique cuando no hay colisiones", async () => {
    const client = makePost0032Db();
    const tplA = insertTemplate("A");
    const tplB = insertTemplate("B");
    insertTask(tplA, "2026-08");
    insertTask(tplB, "2026-08"); // mismo mes, template distinto → OK
    insertTask(tplA, "2026-09"); // mismo template, mes distinto → OK

    const summary = await applyMigration0033TasksTemplateMonthUnique(client);
    expect(summary.indexCreated).toBe(true);
    expect(summary.blockedByDuplicates).toBe(false);
    expect(summary.duplicateGroups).toEqual([]);
    expect(summary.tasksAfter).toBe(summary.tasksBefore);

    const idx = await client.execute("PRAGMA index_list(tasks)");
    expect((idx.rows as any[]).some((r) => r.name === "idx_tasks_template_month_unique")).toBe(true);
  });

  test("no restringe tareas únicas (template_id NULL) repetidas en el mismo mes", async () => {
    const client = makePost0032Db();
    insertTask(null, "2026-08", 0);
    insertTask(null, "2026-08", 0);
    insertTask(null, "2026-08", 0);

    const summary = await applyMigration0033TasksTemplateMonthUnique(client);
    expect(summary.indexCreated).toBe(true);
    expect(summary.blockedByDuplicates).toBe(false);

    // Confirmar que el índice realmente no bloquea nuevos inserts de únicas
    expect(() => db!.run(`INSERT INTO tasks (template_id, month_year, title) VALUES (NULL, '2026-08', 'Otra única')`)).not.toThrow();
  });

  test("después de creado, el índice SÍ rechaza un duplicado nuevo (template_id, month_year)", async () => {
    const client = makePost0032Db();
    const tpl = insertTemplate();
    insertTask(tpl, "2026-08");
    await applyMigration0033TasksTemplateMonthUnique(client);

    expect(() => db!.run(`INSERT INTO tasks (template_id, month_year, title) VALUES (?, '2026-08', 'Duplicada')`, [tpl])).toThrow();
  });
});

describe("0033 — CON duplicados preexistentes: se bloquea, no se toca nada", () => {
  test("detecta el/los grupo(s) duplicados y NO crea el índice", async () => {
    const client = makePost0032Db();
    const tpl = insertTemplate("Cierre de mes");
    const dupIdA = insertTask(tpl, "2026-08"); // duplicado real: mismo template+mes,
    const dupIdB = insertTask(tpl, "2026-08"); // dos filas — el escenario reportado por el usuario

    const summary = await applyMigration0033TasksTemplateMonthUnique(client);

    expect(summary.indexCreated).toBe(false);
    expect(summary.blockedByDuplicates).toBe(true);
    expect(summary.duplicateGroups).toEqual([{ templateId: tpl, monthYear: "2026-08", count: 2 }]);

    // No se creó el índice
    const idx = await client.execute("PRAGMA index_list(tasks)");
    expect((idx.rows as any[]).some((r) => r.name === "idx_tasks_template_month_unique")).toBe(false);

    // Ninguna fila fue tocada/borrada/fusionada — ambos duplicados siguen ahí intactos
    expect(summary.tasksAfter).toBe(summary.tasksBefore);
    const rows = db!.query("SELECT id FROM tasks WHERE id IN (?, ?)").all(dupIdA, dupIdB) as any[];
    expect(rows.length).toBe(2);
  });

  test("un grupo dismissed=1 duplicado también bloquea (dismissed no exime de la unicidad)", async () => {
    const client = makePost0032Db();
    const tpl = insertTemplate();
    insertTask(tpl, "2026-08", 1, 1); // dismissed
    insertTask(tpl, "2026-08", 1, 0); // activa — mismo template/mes que la dismissed

    const summary = await applyMigration0033TasksTemplateMonthUnique(client);
    expect(summary.blockedByDuplicates).toBe(true);
    expect(summary.duplicateGroups[0]!.count).toBe(2);
  });

  test("con múltiples templates duplicados, reporta cada grupo por separado", async () => {
    const client = makePost0032Db();
    const tplA = insertTemplate("A");
    const tplB = insertTemplate("B");
    insertTask(tplA, "2026-08");
    insertTask(tplA, "2026-08"); // dup en A/2026-08
    insertTask(tplB, "2026-09");
    insertTask(tplB, "2026-09"); // dup en B/2026-09
    insertTask(tplB, "2026-09"); // triplicado

    const summary = await applyMigration0033TasksTemplateMonthUnique(client);
    expect(summary.blockedByDuplicates).toBe(true);
    expect(summary.duplicateGroups.length).toBe(2);
    const groupB = summary.duplicateGroups.find((g) => g.templateId === tplB);
    expect(groupB?.count).toBe(3);
  });

  test("findDuplicateTemplateMonthGroups es utilizable de forma independiente (para un preflight de solo lectura)", async () => {
    const client = makePost0032Db();
    const tpl = insertTemplate();
    insertTask(tpl, "2026-08");
    insertTask(tpl, "2026-08");

    const groups = await findDuplicateTemplateMonthGroups(client);
    expect(groups).toEqual([{ templateId: tpl, monthYear: "2026-08", count: 2 }]);
  });
});

describe("0033 — idempotencia", () => {
  test("segunda corrida no falla, alreadyApplied=true", async () => {
    const client = makePost0032Db();
    insertTask(insertTemplate(), "2026-08");

    const first = await applyMigration0033TasksTemplateMonthUnique(client);
    expect(first.indexCreated).toBe(true);

    const second = await applyMigration0033TasksTemplateMonthUnique(client);
    expect(second.alreadyApplied).toBe(true);
    expect(second.indexCreated).toBe(false);
    expect(second.blockedByDuplicates).toBe(false);

    const idx = await client.execute("PRAGMA index_list(tasks)");
    expect((idx.rows as any[]).filter((r) => r.name === "idx_tasks_template_month_unique").length).toBe(1);
  });
});

// ─── Work vs. wrapper local — no controla transacciones por sí misma ────────
describe("0033 — applyMigration0033TasksTemplateMonthUniqueWork no controla transacciones", () => {
  function wrapRecording(base: Sql0033Client): { client: Sql0033Client; sqlLog: string[] } {
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
    const base = makePost0032Db();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0033TasksTemplateMonthUniqueWork(client);

    const controlStatements = sqlLog.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql));
    expect(controlStatements).toEqual([]);
  });

  test("el wrapper local sí emite BEGIN y COMMIT", async () => {
    const base = makePost0032Db();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0033TasksTemplateMonthUnique(client);

    expect(sqlLog.some((sql) => /^BEGIN\b/i.test(sql))).toBe(true);
    expect(sqlLog.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
  });
});
