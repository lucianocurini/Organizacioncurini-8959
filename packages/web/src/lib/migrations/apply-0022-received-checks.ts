// Lógica reutilizable de la migración 0022 (received_checks).
// Usada tanto por el script local (packages/web/scripts/apply_0022_local.ts)
// como por los tests. Depende estructuralmente de payment_batch_splits (0021)
// ya aplicada — no la reaplica, solo asume que la tabla existe.
//
// Sin backfill: no existe ningún payment_batch_splits histórico con
// method='cheque' para el que reconstruir cheques. Idempotente — correrla
// una segunda vez no duplica nada ni falla.

export interface Sql0022Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0022Summary {
  tableAlreadyExisted: boolean;
  checksCountBefore: number;
  checksCountAfter: number;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS received_checks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_split_id   INTEGER NOT NULL REFERENCES payment_batch_splits(id) ON DELETE RESTRICT,
  check_number     TEXT NOT NULL,
  bank_name        TEXT NOT NULL,
  bank_code        TEXT,
  drawer_name      TEXT,
  drawer_document  TEXT,
  issue_date       TEXT,
  due_date         TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  currency         TEXT NOT NULL DEFAULT 'ARS',
  status           TEXT NOT NULL DEFAULT 'en_cartera'
                     CHECK (status IN ('en_cartera', 'entregado_compania', 'cobrado', 'rechazado', 'anulado')),
  notes            TEXT,
  received_at      INTEGER NOT NULL,
  delivered_at     INTEGER,
  cleared_at       INTEGER,
  rejected_at      INTEGER,
  cancelled_at     INTEGER,
  created_by       INTEGER REFERENCES users(id),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
)`.trim();

const CREATE_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_received_checks_batch_split_id ON received_checks(batch_split_id)",
  "CREATE INDEX IF NOT EXISTS idx_received_checks_status ON received_checks(status)",
  "CREATE INDEX IF NOT EXISTS idx_received_checks_due_date ON received_checks(due_date)",
  "CREATE INDEX IF NOT EXISTS idx_received_checks_bank_number ON received_checks(bank_name, check_number)",
];

const EXPECTED_COLUMNS = [
  "id", "batch_split_id", "check_number", "bank_name", "bank_code", "drawer_name",
  "drawer_document", "issue_date", "due_date", "amount_cents", "currency", "status",
  "notes", "received_at", "delivered_at", "cleared_at", "rejected_at", "cancelled_at",
  "created_by", "created_at", "updated_at",
];

async function tableExists(db: Sql0022Client, name: string): Promise<boolean> {
  const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return r.rows.length > 0;
}

async function countRows(db: Sql0022Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

async function runMigration(db: Sql0022Client): Promise<Migration0022Summary> {
  const splitsExist = await tableExists(db, "payment_batch_splits");
  if (!splitsExist) {
    throw new Error("payment_batch_splits no existe todavía — aplicá primero la migración 0021.");
  }

  const tableAlreadyExisted = await tableExists(db, "received_checks");
  const checksCountBefore = tableAlreadyExisted ? await countRows(db, "received_checks") : 0;

  await db.execute(CREATE_TABLE_SQL);

  const cols = await db.execute("PRAGMA table_info(received_checks)");
  const colNames = new Set(cols.rows.map((r: any) => r.name));
  const missing = EXPECTED_COLUMNS.filter((c) => !colNames.has(c));
  if (missing.length > 0) {
    throw new Error(
      `received_checks existe pero le faltan columnas esperadas: ${missing.join(", ")}. ` +
      `Abortando — no se puede confiar en el esquema actual de la tabla.`
    );
  }

  for (const sql of CREATE_INDEXES_SQL) {
    await db.execute(sql);
  }

  const checksCountAfter = await countRows(db, "received_checks");
  if (checksCountAfter !== checksCountBefore) {
    throw new Error("Integridad violada: received_checks cambió de cantidad de filas en una migración sin backfill.");
  }

  return { tableAlreadyExisted, checksCountBefore, checksCountAfter };
}

export async function applyMigration0022ReceivedChecks(db: Sql0022Client): Promise<Migration0022Summary> {
  await db.execute("BEGIN");
  let summary: Migration0022Summary;
  try {
    summary = await runMigration(db);
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
  await db.execute("COMMIT");
  return summary;
}
