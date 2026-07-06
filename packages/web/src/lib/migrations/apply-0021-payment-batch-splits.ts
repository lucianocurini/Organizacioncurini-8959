// Lógica reutilizable de la migración 0021 (payment_batch_splits).
// Usada tanto por el script local (packages/web/scripts/apply_0021_local.ts)
// como por los tests. Depende estructuralmente de payment_batches (0020) ya
// aplicada — no la reaplica, solo asume que la tabla existe.
//
// Sin backfill: no existe ningún payment_batch histórico para el que crear
// splits. Idempotente — correrla una segunda vez no duplica nada ni falla.

export interface Sql0021Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0021Summary {
  tableAlreadyExisted: boolean;
  splitsCountBefore: number;
  splitsCountAfter: number;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS payment_batch_splits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     INTEGER NOT NULL REFERENCES payment_batches(id) ON DELETE RESTRICT,
  method       TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'cheque', 'link_pago', 'transferencia_compania')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  notes        TEXT,
  created_at   INTEGER NOT NULL
)`.trim();

const CREATE_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_payment_batch_splits_batch_id ON payment_batch_splits(batch_id)",
  "CREATE INDEX IF NOT EXISTS idx_payment_batch_splits_method ON payment_batch_splits(method)",
];

const EXPECTED_COLUMNS = ["id", "batch_id", "method", "amount_cents", "notes", "created_at"];

async function tableExists(db: Sql0021Client, name: string): Promise<boolean> {
  const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return r.rows.length > 0;
}

async function countRows(db: Sql0021Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

async function runMigration(db: Sql0021Client): Promise<Migration0021Summary> {
  const batchesExist = await tableExists(db, "payment_batches");
  if (!batchesExist) {
    throw new Error("payment_batches no existe todavía — aplicá primero la migración 0020.");
  }

  const tableAlreadyExisted = await tableExists(db, "payment_batch_splits");
  const splitsCountBefore = tableAlreadyExisted ? await countRows(db, "payment_batch_splits") : 0;

  await db.execute(CREATE_TABLE_SQL);

  const cols = await db.execute("PRAGMA table_info(payment_batch_splits)");
  const colNames = new Set(cols.rows.map((r: any) => r.name));
  const missing = EXPECTED_COLUMNS.filter((c) => !colNames.has(c));
  if (missing.length > 0) {
    throw new Error(
      `payment_batch_splits existe pero le faltan columnas esperadas: ${missing.join(", ")}. ` +
      `Abortando — no se puede confiar en el esquema actual de la tabla.`
    );
  }

  for (const sql of CREATE_INDEXES_SQL) {
    await db.execute(sql);
  }

  const splitsCountAfter = await countRows(db, "payment_batch_splits");
  if (splitsCountAfter !== splitsCountBefore) {
    throw new Error("Integridad violada: payment_batch_splits cambió de cantidad de filas en una migración sin backfill.");
  }

  return { tableAlreadyExisted, splitsCountBefore, splitsCountAfter };
}

export async function applyMigration0021PaymentBatchSplits(db: Sql0021Client): Promise<Migration0021Summary> {
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
