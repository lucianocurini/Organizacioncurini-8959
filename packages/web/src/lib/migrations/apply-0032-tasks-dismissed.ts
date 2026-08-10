// Lógica reutilizable de la migración 0032 (tasks.dismissed — descarte
// explícito de una tarea recurrente por el usuario, separado de status).
// Usada tanto por el script local/productivo como por los tests, contra
// cualquier cliente compatible con @libsql/client (Turso o un archivo
// SQLite local) — mismo criterio que el resto de los aplicadores de este
// proyecto desde 0017 en adelante.
//
// Puramente aditiva: 1 columna NOT NULL DEFAULT 0, ninguna tabla se
// recrea, sin backfill real (todo lo histórico queda en 0 vía el DEFAULT).
// Idempotente.

export interface Sql0032Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0032Summary {
  dismissedColumnAdded: boolean;
  alreadyApplied: boolean;
  tasksBefore: number;
  tasksAfter: number;
  dismissedTrueAfter: number; // debe ser 0 justo después de agregar la columna
}

async function columnExists(db: Sql0032Client, table: string, column: string): Promise<boolean> {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  return cols.rows.some((r: any) => r.name === column);
}

async function countRows(db: Sql0032Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

/**
 * Trabajo puro de la migración 0032 — SOLO statements de lectura/escritura
 * (ALTER/SELECT/PRAGMA), SIN emitir BEGIN/COMMIT/ROLLBACK ni tocar PRAGMA
 * foreign_keys. Mismo criterio que applyMigration0031...Work: quien llama
 * decide cómo envolver la atomicidad según el entorno.
 */
export async function applyMigration0032TasksDismissedWork(db: Sql0032Client): Promise<Migration0032Summary> {
  const tasksBefore = await countRows(db, "tasks");

  const dismissedExisted = await columnExists(db, "tasks", "dismissed");
  let dismissedColumnAdded = false;
  if (!dismissedExisted) {
    await db.execute("ALTER TABLE tasks ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0");
    dismissedColumnAdded = true;
  }

  const tasksAfter = await countRows(db, "tasks");
  const dismissedTrueAfter = (await db.execute("SELECT COUNT(*) as c FROM tasks WHERE dismissed = 1")).rows[0].c;

  if (tasksAfter !== tasksBefore) {
    throw new Error("Integridad violada: la cantidad de filas en tasks cambió durante una migración sin backfill de filas.");
  }
  if (dismissedColumnAdded && Number(dismissedTrueAfter) !== 0) {
    throw new Error("Integridad violada: hay tareas con dismissed=1 inmediatamente después de agregar la columna.");
  }

  return {
    dismissedColumnAdded,
    alreadyApplied: dismissedExisted,
    tasksBefore,
    tasksAfter,
    dismissedTrueAfter: Number(dismissedTrueAfter),
  };
}

/**
 * Uso local/tests (dev.db, bun:sqlite): agrega BEGIN/COMMIT/ROLLBACK
 * alrededor del trabajo puro de arriba — válido acá porque una única
 * conexión bun:sqlite sí mantiene sesión real entre execute() sueltos.
 * NUNCA reutilizar este wrapper contra Turso (@libsql/client sobre HTTP no
 * mantiene sesión entre llamadas) — un futuro script productivo debe
 * envolver el Work con client.transaction("write").
 */
export async function applyMigration0032TasksDismissed(db: Sql0032Client): Promise<Migration0032Summary> {
  await db.execute("BEGIN");
  let summary: Migration0032Summary;
  try {
    summary = await applyMigration0032TasksDismissedWork(db);
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
  await db.execute("COMMIT");
  return summary;
}
