// Lógica reutilizable de la migración 0021 (payment_batches + payments.batch_id).
// Usada tanto por el script local (packages/web/scripts/apply_0021_local.ts)
// como por los tests, contra cualquier cliente compatible con esta interfaz
// (bun:sqlite local hoy; Turso más adelante, cuando exista un script de
// producción — no autorizado todavía en Etapa 4A).
//
// Sin backfill: no se crea ningún payment_batch para datos existentes, y
// ningún payment histórico recibe batch_id (queda NULL, mismo criterio que
// due_date en la migración 0016). Idempotente: correrla una segunda vez no
// duplica nada ni falla.
//
// Igual que en 0019, toda la función corre dentro de una única transacción
// real (BEGIN/COMMIT/ROLLBACK acá adentro, no responsabilidad del caller).

export interface Sql0021Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0021Summary {
  tableAlreadyExisted: boolean; // payment_batches
  columnAlreadyExisted: boolean; // payments.batch_id
  paymentBatchesCountBefore: number;
  paymentBatchesCountAfter: number;
  paymentsCountBefore: number;
  paymentsCountAfter: number;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS payment_batches (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  insured_id             INTEGER NOT NULL REFERENCES insureds(id),
  base_amount_cents      INTEGER NOT NULL CHECK (base_amount_cents > 0),
  surcharge_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (surcharge_amount_cents >= 0),
  total_received_cents   INTEGER NOT NULL CHECK (total_received_cents > 0),
  payment_date           TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'confirmado' CHECK (status IN ('confirmado', 'anulado')),
  notes                  TEXT,
  created_by             INTEGER REFERENCES users(id),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
)`.trim();

const CREATE_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_payment_batches_insured_id ON payment_batches(insured_id)",
  "CREATE INDEX IF NOT EXISTS idx_payment_batches_payment_date ON payment_batches(payment_date)",
  "CREATE INDEX IF NOT EXISTS idx_payment_batches_status ON payment_batches(status)",
  "CREATE INDEX IF NOT EXISTS idx_payments_batch_id ON payments(batch_id)",
];

const EXPECTED_COLUMNS = [
  "id", "insured_id", "base_amount_cents", "surcharge_amount_cents",
  "total_received_cents", "payment_date", "status", "notes",
  "created_by", "created_at", "updated_at",
];

async function tableExists(db: Sql0021Client, name: string): Promise<boolean> {
  const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return r.rows.length > 0;
}

async function columnExists(db: Sql0021Client, table: string, column: string): Promise<boolean> {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  return cols.rows.some((r: any) => r.name === column);
}

async function countRows(db: Sql0021Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

async function runMigration(db: Sql0021Client): Promise<Migration0021Summary> {
  const tableAlreadyExisted = await tableExists(db, "payment_batches");
  const columnAlreadyExisted = await columnExists(db, "payments", "batch_id");
  const paymentBatchesCountBefore = tableAlreadyExisted ? await countRows(db, "payment_batches") : 0;
  const paymentsCountBefore = await countRows(db, "payments");

  await db.execute(CREATE_TABLE_SQL);

  const cols = await db.execute("PRAGMA table_info(payment_batches)");
  const colNames = new Set(cols.rows.map((r: any) => r.name));
  const missing = EXPECTED_COLUMNS.filter((c) => !colNames.has(c));
  if (missing.length > 0) {
    throw new Error(
      `payment_batches existe pero le faltan columnas esperadas: ${missing.join(", ")}. ` +
      `Abortando — no se puede confiar en el esquema actual de la tabla.`
    );
  }

  // ALTER TABLE ADD COLUMN no es idempotente por sí solo (SQLite rechaza un
  // nombre de columna duplicado) — se verifica antes, igual que en 0018.
  if (!columnAlreadyExisted) {
    await db.execute("ALTER TABLE payments ADD COLUMN batch_id INTEGER REFERENCES payment_batches(id)");
  }

  for (const sql of CREATE_INDEXES_SQL) {
    await db.execute(sql);
  }

  const paymentBatchesCountAfter = await countRows(db, "payment_batches");
  const paymentsCountAfter = await countRows(db, "payments");

  // Sin backfill: ninguna de las dos tablas debe cambiar de cantidad de filas.
  if (paymentBatchesCountAfter !== paymentBatchesCountBefore) {
    throw new Error("Integridad violada: payment_batches cambió de cantidad de filas en una migración sin backfill.");
  }
  if (paymentsCountAfter !== paymentsCountBefore) {
    throw new Error("Integridad violada: payments cambió de cantidad de filas en una migración sin backfill.");
  }

  return {
    tableAlreadyExisted, columnAlreadyExisted,
    paymentBatchesCountBefore, paymentBatchesCountAfter,
    paymentsCountBefore, paymentsCountAfter,
  };
}

export async function applyMigration0021PaymentBatches(db: Sql0021Client): Promise<Migration0021Summary> {
  await db.execute("BEGIN");
  let summary: Migration0021Summary;
  try {
    summary = await runMigration(db);
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
  await db.execute("COMMIT");
  return summary;
}
