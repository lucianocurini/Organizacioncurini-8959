// Lógica reutilizable de la migración 0035 ("Invalidación trazable de
// cuotas y refacturaciones duplicadas" — ver
// src/api/migrations/0035_traceable_duplicate_invalidation.sql para el
// diseño completo). Mismo criterio que el resto de los aplicadores de este
// proyecto desde 0017 en adelante: función pura sin BEGIN/COMMIT propio +
// wrapper local que sí los agrega, usable contra cualquier cliente
// compatible con @libsql/client (Turso o un archivo SQLite local).
//
// Puramente aditiva: 4 columnas nullable en policy_installments + 1 columna
// NOT NULL DEFAULT + 4 columnas nullable en rebillings + 4 índices no-únicos
// — ninguna tabla se recrea, ninguna fila histórica cambia. Idempotente.
// Sin índice UNIQUE (a propósito — ver comentario de cabecera del .sql).

export interface Sql0035Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0035Summary {
  installmentsColumnsAdded: string[];
  rebillingsColumnsAdded: string[];
  indexesCreated: string[];
  alreadyApplied: boolean;
  policyInstallmentsBefore: number;
  policyInstallmentsAfter: number;
  rebillingsBefore: number;
  rebillingsAfter: number;
}

const INSTALLMENTS_COLUMNS: { name: string; ddl: string }[] = [
  { name: "duplicate_of_installment_id", ddl: "ALTER TABLE policy_installments ADD COLUMN duplicate_of_installment_id INTEGER REFERENCES policy_installments(id)" },
  { name: "invalidated_at", ddl: "ALTER TABLE policy_installments ADD COLUMN invalidated_at INTEGER" },
  { name: "invalidated_by", ddl: "ALTER TABLE policy_installments ADD COLUMN invalidated_by INTEGER REFERENCES users(id)" },
  { name: "invalidation_reason", ddl: "ALTER TABLE policy_installments ADD COLUMN invalidation_reason TEXT" },
];

const REBILLINGS_COLUMNS: { name: string; ddl: string }[] = [
  { name: "status", ddl: "ALTER TABLE rebillings ADD COLUMN status TEXT NOT NULL DEFAULT 'activa'" },
  { name: "duplicate_of_rebilling_id", ddl: "ALTER TABLE rebillings ADD COLUMN duplicate_of_rebilling_id INTEGER REFERENCES rebillings(id)" },
  { name: "invalidated_at", ddl: "ALTER TABLE rebillings ADD COLUMN invalidated_at INTEGER" },
  { name: "invalidated_by", ddl: "ALTER TABLE rebillings ADD COLUMN invalidated_by INTEGER REFERENCES users(id)" },
  { name: "invalidation_reason", ddl: "ALTER TABLE rebillings ADD COLUMN invalidation_reason TEXT" },
];

const INDEXES: { name: string; ddl: string }[] = [
  { name: "idx_policy_installments_status", ddl: "CREATE INDEX IF NOT EXISTS idx_policy_installments_status ON policy_installments(status)" },
  { name: "idx_policy_installments_duplicate_of", ddl: "CREATE INDEX IF NOT EXISTS idx_policy_installments_duplicate_of ON policy_installments(duplicate_of_installment_id)" },
  { name: "idx_rebillings_status", ddl: "CREATE INDEX IF NOT EXISTS idx_rebillings_status ON rebillings(status)" },
  { name: "idx_rebillings_duplicate_of", ddl: "CREATE INDEX IF NOT EXISTS idx_rebillings_duplicate_of ON rebillings(duplicate_of_rebilling_id)" },
];

async function columnExists(db: Sql0035Client, table: string, column: string): Promise<boolean> {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  return cols.rows.some((r: any) => r.name === column);
}

async function indexExists(db: Sql0035Client, indexName: string): Promise<boolean> {
  const r = await db.execute(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, [indexName]);
  return r.rows.length > 0;
}

async function countRows(db: Sql0035Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

/**
 * Trabajo puro de la migración 0035 — SOLO statements de lectura/escritura
 * (ALTER/CREATE/SELECT/PRAGMA), SIN emitir BEGIN/COMMIT/ROLLBACK. Mismo
 * criterio que 0031/0032/0033/0034: quien llama decide la atomicidad según
 * el entorno (BEGIN/COMMIT local vs. client.transaction("write") en Turso).
 */
export async function applyMigration0035TraceableDuplicateInvalidationWork(db: Sql0035Client): Promise<Migration0035Summary> {
  const policyInstallmentsBefore = await countRows(db, "policy_installments");
  const rebillingsBefore = await countRows(db, "rebillings");

  const installmentsColumnsAdded: string[] = [];
  let installmentsAlreadyHadAll = true;
  for (const col of INSTALLMENTS_COLUMNS) {
    const existed = await columnExists(db, "policy_installments", col.name);
    if (!existed) {
      await db.execute(col.ddl);
      installmentsColumnsAdded.push(col.name);
      installmentsAlreadyHadAll = false;
    }
  }

  const rebillingsColumnsAdded: string[] = [];
  let rebillingsAlreadyHadAll = true;
  for (const col of REBILLINGS_COLUMNS) {
    const existed = await columnExists(db, "rebillings", col.name);
    if (!existed) {
      await db.execute(col.ddl);
      rebillingsColumnsAdded.push(col.name);
      rebillingsAlreadyHadAll = false;
    }
  }

  const indexesCreated: string[] = [];
  let indexesAlreadyExisted = true;
  for (const idx of INDEXES) {
    const existed = await indexExists(db, idx.name);
    if (!existed) {
      await db.execute(idx.ddl);
      indexesCreated.push(idx.name);
      indexesAlreadyExisted = false;
    }
  }

  const policyInstallmentsAfter = await countRows(db, "policy_installments");
  const rebillingsAfter = await countRows(db, "rebillings");
  if (policyInstallmentsAfter !== policyInstallmentsBefore || rebillingsAfter !== rebillingsBefore) {
    throw new Error("Integridad violada: la cantidad de filas en policy_installments/rebillings cambió durante una migración puramente aditiva.");
  }

  // Ninguna fila existente puede quedar "duplicada" ni con duplicate_of_*
  // completado como efecto de esta migración — arranca 100% NULL/'activa'
  // para todo lo histórico (sin backfill, sin reinterpretar nada).
  const unexpectedInstallments = await db.execute(`SELECT COUNT(*) as c FROM policy_installments WHERE status = 'duplicada' OR duplicate_of_installment_id IS NOT NULL`);
  if (Number(unexpectedInstallments.rows[0].c) > 0 && installmentsColumnsAdded.length > 0) {
    throw new Error("Integridad violada: hay cuotas con status='duplicada' o duplicate_of_installment_id no nulo inmediatamente después de agregar las columnas (no debería haber backfill).");
  }
  const unexpectedRebillings = await db.execute(`SELECT COUNT(*) as c FROM rebillings WHERE status != 'activa' OR duplicate_of_rebilling_id IS NOT NULL`);
  if (Number(unexpectedRebillings.rows[0].c) > 0 && rebillingsColumnsAdded.length > 0) {
    throw new Error("Integridad violada: hay refacturaciones con status != 'activa' o duplicate_of_rebilling_id no nulo inmediatamente después de agregar las columnas (no debería haber backfill).");
  }

  return {
    installmentsColumnsAdded,
    rebillingsColumnsAdded,
    indexesCreated,
    alreadyApplied: installmentsAlreadyHadAll && rebillingsAlreadyHadAll && indexesAlreadyExisted,
    policyInstallmentsBefore,
    policyInstallmentsAfter,
    rebillingsBefore,
    rebillingsAfter,
  };
}

/**
 * Uso local/tests (dev.db, bun:sqlite): agrega BEGIN/COMMIT/ROLLBACK
 * alrededor del trabajo puro de arriba — válido acá porque una única
 * conexión bun:sqlite sí mantiene sesión real entre execute() sueltos.
 * NUNCA reutilizar este wrapper contra Turso (@libsql/client sobre HTTP no
 * mantiene sesión entre llamadas) — un futuro script productivo debe
 * envolver el Work con client.transaction("write") o client.migrate().
 */
export async function applyMigration0035TraceableDuplicateInvalidation(db: Sql0035Client): Promise<Migration0035Summary> {
  await db.execute("BEGIN");
  let summary: Migration0035Summary;
  try {
    summary = await applyMigration0035TraceableDuplicateInvalidationWork(db);
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
  await db.execute("COMMIT");
  return summary;
}
