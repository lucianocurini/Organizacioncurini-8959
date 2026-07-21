// Lógica reutilizable de la migración 0030 — sobrantes/faltantes en cobros,
// Fase 2A (solo base técnica). Usada tanto por el script local
// (packages/web/scripts/apply_0030_local.ts, gitignorado como todo scripts/)
// como por los tests, contra cualquier cliente compatible con @libsql/client
// (Turso o un archivo SQLite local) — mismo criterio que el resto de los
// aplicadores de este proyecto desde 0017 en adelante.
//
// Tres cambios de esquema, todos aditivos (ninguna tabla existente se
// recrea):
//   A. payment_batches.received_amount_cents — columna nueva, con backfill
//      determinístico (= total_received_cents, porque hasta esta migración
//      ambos eran siempre iguales por invariante de validateBatchTotals).
//      Es el único aplicador de este proyecto con un UPDATE de backfill real
//      dentro de la migración (no un script aparte) — se justifica porque acá
//      el valor de backfill es 100% determinístico y sin ambigüedad (a
//      diferencia de, por ejemplo, rebilling_id en la migración 0017, que
//      necesitó un backfill posterior con criterio de negocio).
//   B. insured_account_movements — tabla nueva (cuenta corriente del
//      asegurado, ledger con signo).
//   C. payment_amount_adjustments — tabla nueva (ajuste manual puro, sin
//      asegurado real detrás).
//
// Ver el comentario completo de diseño en
// src/api/migrations/0030_insured_account_movements.sql.

export interface Sql0030Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0030Summary {
  receivedAmountColumnAdded: boolean;
  receivedAmountBackfilledRows: number;
  insuredAccountMovementsTableAlreadyExisted: boolean;
  paymentAmountAdjustmentsTableAlreadyExisted: boolean;
  paymentBatchesCountBefore: number;
  paymentBatchesCountAfter: number;
}

const INSURED_ACCOUNT_MOVEMENTS_EXPECTED_COLUMNS = [
  "id", "insured_id", "type", "signed_amount_cents", "status",
  "origin_payment_id", "origin_batch_id", "related_payment_id", "related_installment_id",
  "reason", "authorized_by", "created_by", "created_at", "settled_at", "notes",
];

const PAYMENT_AMOUNT_ADJUSTMENTS_EXPECTED_COLUMNS = [
  "id", "payment_id", "payment_batch_id", "amount_cents", "reason",
  "authorized_by", "created_by", "created_at",
];

const CREATE_INSURED_ACCOUNT_MOVEMENTS_SQL = `
CREATE TABLE IF NOT EXISTS insured_account_movements (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  insured_id              INTEGER NOT NULL REFERENCES insureds(id),
  type                    TEXT NOT NULL CHECK (
                            type IN (
                              'saldo_a_favor', 'saldo_deudor', 'aplicacion_saldo_favor',
                              'cobro_saldo_deudor', 'devolucion_saldo_favor', 'ajuste_manual'
                            )
                          ),
  signed_amount_cents     INTEGER NOT NULL CHECK (signed_amount_cents != 0),
  status                  TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'anulado')),
  origin_payment_id       INTEGER REFERENCES payments(id),
  origin_batch_id         INTEGER REFERENCES payment_batches(id),
  related_payment_id      INTEGER REFERENCES payments(id),
  related_installment_id  INTEGER REFERENCES policy_installments(id),
  reason                  TEXT,
  authorized_by           INTEGER REFERENCES users(id),
  created_by              INTEGER NOT NULL REFERENCES users(id),
  created_at              INTEGER NOT NULL,
  settled_at              INTEGER,
  notes                   TEXT
)`.trim();

const CREATE_INSURED_ACCOUNT_MOVEMENTS_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_insured_account_movements_insured_id ON insured_account_movements(insured_id)",
  "CREATE INDEX IF NOT EXISTS idx_insured_account_movements_origin_batch_id ON insured_account_movements(origin_batch_id)",
  "CREATE INDEX IF NOT EXISTS idx_insured_account_movements_origin_payment_id ON insured_account_movements(origin_payment_id)",
  "CREATE INDEX IF NOT EXISTS idx_insured_account_movements_related_payment_id ON insured_account_movements(related_payment_id)",
  "CREATE INDEX IF NOT EXISTS idx_insured_account_movements_status ON insured_account_movements(status)",
  "CREATE INDEX IF NOT EXISTS idx_insured_account_movements_type ON insured_account_movements(type)",
];

const CREATE_PAYMENT_AMOUNT_ADJUSTMENTS_SQL = `
CREATE TABLE IF NOT EXISTS payment_amount_adjustments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id        INTEGER REFERENCES payments(id),
  payment_batch_id  INTEGER REFERENCES payment_batches(id),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents != 0),
  reason            TEXT NOT NULL,
  authorized_by     INTEGER NOT NULL REFERENCES users(id),
  created_by        INTEGER NOT NULL REFERENCES users(id),
  created_at        INTEGER NOT NULL,
  CHECK (
    (payment_id IS NOT NULL) + (payment_batch_id IS NOT NULL) = 1
  )
)`.trim();

const CREATE_PAYMENT_AMOUNT_ADJUSTMENTS_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_payment_amount_adjustments_payment_id ON payment_amount_adjustments(payment_id)",
  "CREATE INDEX IF NOT EXISTS idx_payment_amount_adjustments_payment_batch_id ON payment_amount_adjustments(payment_batch_id)",
];

async function tableExists(db: Sql0030Client, name: string): Promise<boolean> {
  const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return r.rows.length > 0;
}

async function columnExists(db: Sql0030Client, table: string, column: string): Promise<boolean> {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  return cols.rows.some((r: any) => r.name === column);
}

async function countRows(db: Sql0030Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

async function tableColumnNames(db: Sql0030Client, table: string): Promise<Set<string>> {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  return new Set(cols.rows.map((r: any) => r.name));
}

async function runMigration(db: Sql0030Client): Promise<Migration0030Summary> {
  const paymentBatchesCountBefore = await countRows(db, "payment_batches");

  // ─── A. payment_batches.received_amount_cents ────────────────────────────
  const columnAlreadyExisted = await columnExists(db, "payment_batches", "received_amount_cents");
  let receivedAmountColumnAdded = false;
  if (!columnAlreadyExisted) {
    await db.execute("ALTER TABLE payment_batches ADD COLUMN received_amount_cents INTEGER");
    receivedAmountColumnAdded = true;
  }

  const nullBefore = await db.execute("SELECT COUNT(*) as c FROM payment_batches WHERE received_amount_cents IS NULL");
  const receivedAmountBackfilledRows = Number(nullBefore.rows[0].c);

  await db.execute(
    "UPDATE payment_batches SET received_amount_cents = total_received_cents WHERE received_amount_cents IS NULL"
  );

  const stillNull = await db.execute("SELECT COUNT(*) as c FROM payment_batches WHERE received_amount_cents IS NULL");
  if (Number(stillNull.rows[0].c) !== 0) {
    throw new Error(
      `Integridad violada: quedaron ${stillNull.rows[0].c} payment_batches con received_amount_cents NULL tras el backfill.`
    );
  }

  // ─── B. insured_account_movements ────────────────────────────────────────
  const insuredAccountMovementsTableAlreadyExisted = await tableExists(db, "insured_account_movements");
  await db.execute(CREATE_INSURED_ACCOUNT_MOVEMENTS_SQL);
  const insuredAccountMovementsCols = await tableColumnNames(db, "insured_account_movements");
  const missingIam = INSURED_ACCOUNT_MOVEMENTS_EXPECTED_COLUMNS.filter((c) => !insuredAccountMovementsCols.has(c));
  if (missingIam.length > 0) {
    throw new Error(`insured_account_movements existe pero le faltan columnas esperadas: ${missingIam.join(", ")}. Abortando.`);
  }
  for (const sql of CREATE_INSURED_ACCOUNT_MOVEMENTS_INDEXES_SQL) {
    await db.execute(sql);
  }

  // ─── C. payment_amount_adjustments ───────────────────────────────────────
  const paymentAmountAdjustmentsTableAlreadyExisted = await tableExists(db, "payment_amount_adjustments");
  await db.execute(CREATE_PAYMENT_AMOUNT_ADJUSTMENTS_SQL);
  const paymentAmountAdjustmentsCols = await tableColumnNames(db, "payment_amount_adjustments");
  const missingPaa = PAYMENT_AMOUNT_ADJUSTMENTS_EXPECTED_COLUMNS.filter((c) => !paymentAmountAdjustmentsCols.has(c));
  if (missingPaa.length > 0) {
    throw new Error(`payment_amount_adjustments existe pero le faltan columnas esperadas: ${missingPaa.join(", ")}. Abortando.`);
  }
  for (const sql of CREATE_PAYMENT_AMOUNT_ADJUSTMENTS_INDEXES_SQL) {
    await db.execute(sql);
  }

  const paymentBatchesCountAfter = await countRows(db, "payment_batches");
  if (paymentBatchesCountAfter !== paymentBatchesCountBefore) {
    throw new Error("Integridad violada: payment_batches cambió de cantidad de filas en una migración sin backfill de filas (solo de columna).");
  }

  return {
    receivedAmountColumnAdded,
    receivedAmountBackfilledRows,
    insuredAccountMovementsTableAlreadyExisted,
    paymentAmountAdjustmentsTableAlreadyExisted,
    paymentBatchesCountBefore,
    paymentBatchesCountAfter,
  };
}

export async function applyMigration0030InsuredAccountMovements(db: Sql0030Client): Promise<Migration0030Summary> {
  await db.execute("BEGIN");
  let summary: Migration0030Summary;
  try {
    summary = await runMigration(db);
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
  await db.execute("COMMIT");
  return summary;
}
