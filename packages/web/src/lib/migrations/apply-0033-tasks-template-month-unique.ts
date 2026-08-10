// Lógica reutilizable de la migración 0033 (índice único (template_id,
// month_year) en tasks). Usada tanto por un futuro script local/productivo
// como por los tests, contra cualquier cliente compatible con
// @libsql/client (Turso o un archivo SQLite local).
//
// A diferencia de 0031/0032 (puramente aditivas y sin riesgo de fallar),
// esta migración PUEDE fallar de forma legítima si ya existen filas
// duplicadas para el mismo (template_id, month_year) — exactamente el
// escenario que el usuario reportó como posible en producción. Por eso
// este aplicador NUNCA ejecuta el CREATE UNIQUE INDEX a ciegas: primero
// corre un preflight de solo lectura (findDuplicateTemplateMonthGroups) y,
// si encuentra duplicados, se detiene ANTES de intentar crear el índice —
// sin borrar, fusionar ni modificar ninguna fila. Ninguna deduplicación
// automática: eso queda para una decisión humana explícita, informada por
// el resultado de este preflight.

export interface Sql0033Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface DuplicateTemplateMonthGroup {
  templateId: number;
  monthYear: string;
  count: number;
}

export interface Migration0033Summary {
  indexCreated: boolean;
  alreadyApplied: boolean;
  blockedByDuplicates: boolean;
  duplicateGroups: DuplicateTemplateMonthGroup[];
  tasksBefore: number;
  tasksAfter: number;
}

async function indexExists(db: Sql0033Client, table: string, indexName: string): Promise<boolean> {
  const idx = await db.execute(`PRAGMA index_list(${table})`);
  return idx.rows.some((r: any) => r.name === indexName);
}

async function countRows(db: Sql0033Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

/**
 * Preflight de SOLO LECTURA: agrupa tasks por (template_id, month_year)
 * ignorando template_id NULL (las tareas únicas nunca compiten por
 * duplicado) y devuelve los grupos con más de una fila. Reutilizable tal
 * cual contra Turso — no depende de ningún estado local.
 */
export async function findDuplicateTemplateMonthGroups(db: Sql0033Client): Promise<DuplicateTemplateMonthGroup[]> {
  const r = await db.execute(`
    SELECT template_id as templateId, month_year as monthYear, COUNT(*) as count
    FROM tasks
    WHERE template_id IS NOT NULL
    GROUP BY template_id, month_year
    HAVING COUNT(*) > 1
  `);
  return r.rows.map((row: any) => ({
    templateId: Number(row.templateId),
    monthYear: String(row.monthYear),
    count: Number(row.count),
  }));
}

/**
 * Trabajo puro de la migración 0033 — SOLO statements de lectura/escritura
 * (CREATE INDEX/SELECT/PRAGMA), SIN emitir BEGIN/COMMIT/ROLLBACK. Mismo
 * criterio que 0031/0032: quien llama decide la atomicidad según el
 * entorno.
 *
 * Si ya hay duplicados, esta función NO lanza una excepción: devuelve
 * blockedByDuplicates=true con el detalle de los grupos, sin tocar la
 * tabla. Se modela como resultado esperado (no como error) porque un
 * futuro script productivo necesita poder reportarlo con claridad — no un
 * stack trace de SQLite genérico.
 */
export async function applyMigration0033TasksTemplateMonthUniqueWork(db: Sql0033Client): Promise<Migration0033Summary> {
  const tasksBefore = await countRows(db, "tasks");

  const existed = await indexExists(db, "tasks", "idx_tasks_template_month_unique");
  if (existed) {
    return {
      indexCreated: false,
      alreadyApplied: true,
      blockedByDuplicates: false,
      duplicateGroups: [],
      tasksBefore,
      tasksAfter: tasksBefore,
    };
  }

  const duplicateGroups = await findDuplicateTemplateMonthGroups(db);
  if (duplicateGroups.length > 0) {
    return {
      indexCreated: false,
      alreadyApplied: false,
      blockedByDuplicates: true,
      duplicateGroups,
      tasksBefore,
      tasksAfter: tasksBefore,
    };
  }

  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_template_month_unique ON tasks(template_id, month_year)");

  const tasksAfter = await countRows(db, "tasks");
  if (tasksAfter !== tasksBefore) {
    throw new Error("Integridad violada: la cantidad de filas en tasks cambió al crear un índice (no debería alterar filas).");
  }

  return {
    indexCreated: true,
    alreadyApplied: false,
    blockedByDuplicates: false,
    duplicateGroups: [],
    tasksBefore,
    tasksAfter,
  };
}

/**
 * Uso local/tests (dev.db, bun:sqlite): agrega BEGIN/COMMIT/ROLLBACK
 * alrededor del trabajo puro de arriba. NUNCA reutilizar este wrapper
 * contra Turso — un futuro script productivo debe envolver el Work con
 * client.transaction("write"), y sólo debe invocarse tras un preflight
 * aparte que ya haya confirmado ausencia de duplicados (ver comentario de
 * la migración 0033 en el .sql).
 */
export async function applyMigration0033TasksTemplateMonthUnique(db: Sql0033Client): Promise<Migration0033Summary> {
  await db.execute("BEGIN");
  let summary: Migration0033Summary;
  try {
    summary = await applyMigration0033TasksTemplateMonthUniqueWork(db);
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
  await db.execute("COMMIT");
  return summary;
}
