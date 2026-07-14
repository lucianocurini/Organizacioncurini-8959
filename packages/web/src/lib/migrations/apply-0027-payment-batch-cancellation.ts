// Lógica reutilizable de la migración 0027 (anulación segura de
// payment_batches con trazabilidad — ver diagnóstico completo en
// 0027_payment_batch_cancellation.sql). Usada tanto por el script local
// (packages/web/scripts/apply_0027_local.ts, gitignorado como todo scripts/)
// como por los tests, contra cualquier cliente compatible con @libsql/client
// (Turso o un archivo SQLite local).
//
// Idempotente. Sin backfill: ninguna fila existente cambia de valor — las 3
// columnas nuevas de payment_batches quedan NULL, cash_entries.status queda
// en su DEFAULT 'activo' para todas las filas existentes (ninguna se
// reinterpreta como "anulada" retroactivamente), voided_at queda NULL.

export interface Sql0027Client {
  execute(sql: string): Promise<{ rows: any[] }>;
}

export interface Migration0027Summary {
  paymentBatchesColumnsAdded: string[];
  cashEntriesColumnsAdded: string[];
  alreadyApplied: boolean;
  paymentBatchesBefore: number;
  paymentBatchesAfter: number;
  cashEntriesBefore: number;
  cashEntriesAfter: number;
  nonActiveCashEntriesAfter: number; // cash_entries con status != 'activo' justo después de agregar la columna — debe ser 0
}

const PAYMENT_BATCHES_NEW_COLUMNS: { name: string; ddl: string }[] = [
  { name: "cancelled_at", ddl: "ALTER TABLE payment_batches ADD COLUMN cancelled_at INTEGER" },
  { name: "cancelled_by", ddl: "ALTER TABLE payment_batches ADD COLUMN cancelled_by INTEGER REFERENCES users(id)" },
  { name: "cancellation_reason", ddl: "ALTER TABLE payment_batches ADD COLUMN cancellation_reason TEXT" },
];

const CASH_ENTRIES_NEW_COLUMNS: { name: string; ddl: string }[] = [
  { name: "status", ddl: "ALTER TABLE cash_entries ADD COLUMN status TEXT NOT NULL DEFAULT 'activo'" },
  { name: "voided_at", ddl: "ALTER TABLE cash_entries ADD COLUMN voided_at INTEGER" },
];

const INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_payment_batches_cancelled_by ON payment_batches(cancelled_by)",
  "CREATE INDEX IF NOT EXISTS idx_cash_entries_status ON cash_entries(status)",
];

async function existingColumnNames(db: Sql0027Client, table: string): Promise<Set<string>> {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  return new Set(cols.rows.map((r: any) => r.name));
}

async function countRows(db: Sql0027Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

export async function applyMigration0027PaymentBatchCancellation(db: Sql0027Client): Promise<Migration0027Summary> {
  const paymentBatchesBefore = await countRows(db, "payment_batches");
  const cashEntriesBefore = await countRows(db, "cash_entries");

  const beforeBatchCols = await existingColumnNames(db, "payment_batches");
  const beforeCashCols = await existingColumnNames(db, "cash_entries");
  const alreadyApplied =
    PAYMENT_BATCHES_NEW_COLUMNS.every((c) => beforeBatchCols.has(c.name)) &&
    CASH_ENTRIES_NEW_COLUMNS.every((c) => beforeCashCols.has(c.name));

  const paymentBatchesColumnsAdded: string[] = [];
  const cashEntriesColumnsAdded: string[] = [];

  if (!alreadyApplied) {
    for (const col of PAYMENT_BATCHES_NEW_COLUMNS) {
      if (!beforeBatchCols.has(col.name)) {
        await db.execute(col.ddl);
        paymentBatchesColumnsAdded.push(col.name);
      }
    }
    for (const col of CASH_ENTRIES_NEW_COLUMNS) {
      if (!beforeCashCols.has(col.name)) {
        await db.execute(col.ddl);
        cashEntriesColumnsAdded.push(col.name);
      }
    }
  }

  for (const sql of INDEXES_SQL) {
    await db.execute(sql);
  }

  const afterBatchCols = await existingColumnNames(db, "payment_batches");
  const afterCashCols = await existingColumnNames(db, "cash_entries");
  const missingBatch = PAYMENT_BATCHES_NEW_COLUMNS.filter((c) => !afterBatchCols.has(c.name));
  const missingCash = CASH_ENTRIES_NEW_COLUMNS.filter((c) => !afterCashCols.has(c.name));
  if (missingBatch.length > 0 || missingCash.length > 0) {
    throw new Error(
      `Faltan columnas tras la migración: payment_batches[${missingBatch.map((c) => c.name).join(", ")}] ` +
      `cash_entries[${missingCash.map((c) => c.name).join(", ")}].`
    );
  }

  const paymentBatchesAfter = await countRows(db, "payment_batches");
  const cashEntriesAfter = await countRows(db, "cash_entries");
  if (paymentBatchesAfter !== paymentBatchesBefore) {
    throw new Error("la cantidad de filas en payment_batches cambió durante la migración.");
  }
  if (cashEntriesAfter !== cashEntriesBefore) {
    throw new Error("la cantidad de filas en cash_entries cambió durante la migración.");
  }

  const nonActiveRow = await db.execute("SELECT COUNT(*) as c FROM cash_entries WHERE status != 'activo'");
  const nonActiveCashEntriesAfter = Number(nonActiveRow.rows[0].c);
  if (cashEntriesColumnsAdded.includes("status") && nonActiveCashEntriesAfter !== 0) {
    throw new Error("hay cash_entries con status != 'activo' inmediatamente después de agregar la columna (debería ser el DEFAULT para todas).");
  }

  return {
    paymentBatchesColumnsAdded, cashEntriesColumnsAdded, alreadyApplied,
    paymentBatchesBefore, paymentBatchesAfter, cashEntriesBefore, cashEntriesAfter,
    nonActiveCashEntriesAfter,
  };
}
