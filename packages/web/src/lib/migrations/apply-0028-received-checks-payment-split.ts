// Lógica reutilizable de la migración 0028 (received_checks.payment_split_id
// + relajar el CHECK de remittance_allocations — cheques en pagos
// individuales, no solo en cobros múltiples). Mismo patrón que
// apply-0026-payment-batches-nullable-insured.ts: SQLite no permite
// "ALTER COLUMN ... DROP NOT NULL" ni agregar/modificar un CHECK existente
// vía ALTER TABLE, así que se recrean AMBAS tablas (procedimiento de 12
// pasos: https://www.sqlite.org/lang_altertable.html
// #making_other_kinds_of_table_schema_changes).
//
// PRAGMA foreign_keys es un no-op dentro de una transacción — por eso se
// apaga ANTES de abrir la transacción, se hace todo el trabajo (crear tabla
// nueva, copiar filas, borrar la vieja, renombrar, recrear índices) para las
// DOS tablas dentro de la MISMA transacción (received_checks primero,
// porque remittance_allocations.received_check_id la referencia por
// nombre), se corre PRAGMA foreign_key_check antes de confirmar, se hace
// COMMIT, y recién ahí se reactiva foreign_keys.
//
// Idempotente: si received_checks.batch_split_id ya es nullable Y tiene la
// columna payment_split_id, no hace nada (se asume que ambas tablas ya
// quedaron migradas juntas, porque esta migración siempre las toca a la
// vez).
//
// Sin backfill: ninguna fila cambia de valor — todos los cheques de lote
// existentes conservan su batch_split_id real (payment_split_id queda NULL
// para ellos), y todas las allocations existentes conservan sus columnas
// tal cual.

export interface Sql0028Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0028Summary {
  alreadyApplied: boolean;
  receivedChecksCountBefore: number;
  receivedChecksCountAfter: number;
  remittanceAllocationsCountBefore: number;
  remittanceAllocationsCountAfter: number;
}

// ─── received_checks ────────────────────────────────────────────────────────

export const RECEIVED_CHECKS_EXPECTED_COLUMNS = [
  "id", "batch_split_id", "payment_split_id", "check_number", "bank_name", "bank_code",
  "drawer_name", "drawer_document", "issue_date", "due_date", "amount_cents", "currency",
  "status", "notes", "received_at", "delivered_at", "cleared_at", "rejected_at",
  "cancelled_at", "created_by", "created_at", "updated_at",
];

export const CREATE_RECEIVED_CHECKS_NEW_SQL = `
CREATE TABLE received_checks_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_split_id   INTEGER REFERENCES payment_batch_splits(id),
  payment_split_id INTEGER REFERENCES payment_splits(id),
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
  updated_at       INTEGER NOT NULL,
  CHECK (
    (batch_split_id IS NOT NULL) + (payment_split_id IS NOT NULL) = 1
  )
)`.trim();

export const INSERT_INTO_RECEIVED_CHECKS_NEW_SQL = `
INSERT INTO received_checks_new (
  id, batch_split_id, payment_split_id, check_number, bank_name, bank_code,
  drawer_name, drawer_document, issue_date, due_date, amount_cents, currency,
  status, notes, received_at, delivered_at, cleared_at, rejected_at,
  cancelled_at, created_by, created_at, updated_at
)
SELECT
  id, batch_split_id, NULL, check_number, bank_name, bank_code,
  drawer_name, drawer_document, issue_date, due_date, amount_cents, currency,
  status, notes, received_at, delivered_at, cleared_at, rejected_at,
  cancelled_at, created_by, created_at, updated_at
FROM received_checks
`.trim();

export const DROP_OLD_RECEIVED_CHECKS_SQL = "DROP TABLE received_checks";
export const RENAME_RECEIVED_CHECKS_SQL = "ALTER TABLE received_checks_new RENAME TO received_checks";

export const CREATE_RECEIVED_CHECKS_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_received_checks_batch_split_id ON received_checks(batch_split_id)",
  "CREATE INDEX IF NOT EXISTS idx_received_checks_payment_split_id ON received_checks(payment_split_id)",
  "CREATE INDEX IF NOT EXISTS idx_received_checks_status ON received_checks(status)",
  "CREATE INDEX IF NOT EXISTS idx_received_checks_due_date ON received_checks(due_date)",
  "CREATE INDEX IF NOT EXISTS idx_received_checks_bank_number ON received_checks(bank_name, check_number)",
];

// ─── remittance_allocations ─────────────────────────────────────────────────

export const REMITTANCE_ALLOCATIONS_EXPECTED_COLUMNS = [
  "id", "remittance_id", "remittance_item_id", "payment_id", "payment_split_id",
  "payment_batch_id", "payment_batch_split_id", "received_check_id", "cash_entry_id",
  "method", "amount_cents", "created_at",
];

export const CREATE_REMITTANCE_ALLOCATIONS_NEW_SQL = `
CREATE TABLE remittance_allocations_new (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  remittance_id           INTEGER NOT NULL REFERENCES remittances(id),
  remittance_item_id      INTEGER REFERENCES remittance_items(id),
  payment_id              INTEGER REFERENCES payments(id),
  payment_split_id        INTEGER REFERENCES payment_splits(id),
  payment_batch_id        INTEGER REFERENCES payment_batches(id),
  payment_batch_split_id  INTEGER REFERENCES payment_batch_splits(id),
  received_check_id       INTEGER REFERENCES received_checks(id),
  cash_entry_id           INTEGER REFERENCES cash_entries(id),
  method                  TEXT NOT NULL CHECK (
                            method IN ('efectivo', 'transferencia', 'cheque', 'link_pago', 'transferencia_compania')
                          ),
  amount_cents            INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at              INTEGER NOT NULL,
  CHECK (
    (payment_split_id IS NOT NULL) +
    (payment_batch_split_id IS NOT NULL) +
    (cash_entry_id IS NOT NULL) = 1
  ),
  CHECK (
    received_check_id IS NULL
    OR payment_batch_split_id IS NOT NULL
    OR payment_split_id IS NOT NULL
  )
)`.trim();

export const INSERT_INTO_REMITTANCE_ALLOCATIONS_NEW_SQL = `
INSERT INTO remittance_allocations_new (
  id, remittance_id, remittance_item_id, payment_id, payment_split_id,
  payment_batch_id, payment_batch_split_id, received_check_id, cash_entry_id,
  method, amount_cents, created_at
)
SELECT
  id, remittance_id, remittance_item_id, payment_id, payment_split_id,
  payment_batch_id, payment_batch_split_id, received_check_id, cash_entry_id,
  method, amount_cents, created_at
FROM remittance_allocations
`.trim();

export const DROP_OLD_REMITTANCE_ALLOCATIONS_SQL = "DROP TABLE remittance_allocations";
export const RENAME_REMITTANCE_ALLOCATIONS_SQL = "ALTER TABLE remittance_allocations_new RENAME TO remittance_allocations";

export const CREATE_REMITTANCE_ALLOCATIONS_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_remittance_allocations_remittance_id ON remittance_allocations(remittance_id)",
  "CREATE INDEX IF NOT EXISTS idx_remittance_allocations_remittance_item_id ON remittance_allocations(remittance_item_id)",
  "CREATE INDEX IF NOT EXISTS idx_remittance_allocations_method ON remittance_allocations(method)",
  "CREATE INDEX IF NOT EXISTS idx_remittance_allocations_payment_id ON remittance_allocations(payment_id)",
  "CREATE INDEX IF NOT EXISTS idx_remittance_allocations_payment_batch_id ON remittance_allocations(payment_batch_id)",
  // received_check_id IS NULL: un split cheque con N cheques genera N
  // allocations que comparten el mismo payment_split_id (una por cheque) —
  // sin esta condición el índice bloquearía en falso esa carga múltiple
  // legítima. Mismo criterio que ux_remittance_allocations_batch_split_no_check.
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_payment_split ON remittance_allocations(payment_split_id) WHERE payment_split_id IS NOT NULL AND received_check_id IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_batch_split_no_check ON remittance_allocations(payment_batch_split_id) WHERE payment_batch_split_id IS NOT NULL AND received_check_id IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_received_check ON remittance_allocations(received_check_id) WHERE received_check_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_cash_entry ON remittance_allocations(cash_entry_id) WHERE cash_entry_id IS NOT NULL",
];

// Se exporta para que un futuro runner de Turso (apply-0028-prod.ts, no
// preparado todavía) nunca tenga que reescribir o duplicar este SQL a mano —
// mismo criterio que MIGRATION_0026_WORK_STATEMENTS.
export const MIGRATION_0028_WORK_STATEMENTS: string[] = [
  CREATE_RECEIVED_CHECKS_NEW_SQL,
  INSERT_INTO_RECEIVED_CHECKS_NEW_SQL,
  DROP_OLD_RECEIVED_CHECKS_SQL,
  RENAME_RECEIVED_CHECKS_SQL,
  ...CREATE_RECEIVED_CHECKS_INDEXES_SQL,
  CREATE_REMITTANCE_ALLOCATIONS_NEW_SQL,
  INSERT_INTO_REMITTANCE_ALLOCATIONS_NEW_SQL,
  DROP_OLD_REMITTANCE_ALLOCATIONS_SQL,
  RENAME_REMITTANCE_ALLOCATIONS_SQL,
  ...CREATE_REMITTANCE_ALLOCATIONS_INDEXES_SQL,
];

async function tableExists(db: Sql0028Client, name: string): Promise<boolean> {
  const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return r.rows.length > 0;
}

async function countRows(db: Sql0028Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

/** true si received_checks ya tiene batch_split_id nullable Y la columna payment_split_id. */
export async function isReceivedChecksAlreadyMigrated(db: Sql0028Client): Promise<boolean> {
  const cols = await db.execute("PRAGMA table_info(received_checks)");
  const batchSplitCol = cols.rows.find((r: any) => r.name === "batch_split_id");
  if (!batchSplitCol) {
    throw new Error("received_checks.batch_split_id no existe — no se puede aplicar esta migración sobre este esquema.");
  }
  const hasPaymentSplitCol = cols.rows.some((r: any) => r.name === "payment_split_id");
  return Number(batchSplitCol.notnull) === 0 && hasPaymentSplitCol;
}

export async function applyMigration0028ReceivedChecksPaymentSplit(db: Sql0028Client): Promise<Migration0028Summary> {
  if (!(await tableExists(db, "received_checks"))) {
    throw new Error("received_checks no existe — corré primero la migración 0023.");
  }
  if (!(await tableExists(db, "remittance_allocations"))) {
    throw new Error("remittance_allocations no existe — corré primero la migración 0024.");
  }

  const alreadyApplied = await isReceivedChecksAlreadyMigrated(db);
  const receivedChecksCountBefore = await countRows(db, "received_checks");
  const remittanceAllocationsCountBefore = await countRows(db, "remittance_allocations");

  if (alreadyApplied) {
    // Idempotente: ya aplicada. No se toca nada.
    return {
      alreadyApplied: true,
      receivedChecksCountBefore,
      receivedChecksCountAfter: receivedChecksCountBefore,
      remittanceAllocationsCountBefore,
      remittanceAllocationsCountAfter: remittanceAllocationsCountBefore,
    };
  }

  // foreign_keys es un no-op dentro de una transacción — se apaga ANTES.
  await db.execute("PRAGMA foreign_keys=OFF");

  try {
    await db.execute("BEGIN");
    try {
      // ── A. received_checks ──
      await db.execute(CREATE_RECEIVED_CHECKS_NEW_SQL);

      const newReceivedChecksCols = await db.execute("PRAGMA table_info(received_checks_new)");
      const newReceivedChecksColNames = new Set(newReceivedChecksCols.rows.map((r: any) => r.name));
      const missingReceivedChecksCols = RECEIVED_CHECKS_EXPECTED_COLUMNS.filter((c) => !newReceivedChecksColNames.has(c));
      if (missingReceivedChecksCols.length > 0) {
        throw new Error(`received_checks_new quedó sin columnas esperadas: ${missingReceivedChecksCols.join(", ")}. Abortando.`);
      }

      await db.execute(INSERT_INTO_RECEIVED_CHECKS_NEW_SQL);
      await db.execute(DROP_OLD_RECEIVED_CHECKS_SQL);
      await db.execute(RENAME_RECEIVED_CHECKS_SQL);
      for (const sql of CREATE_RECEIVED_CHECKS_INDEXES_SQL) {
        await db.execute(sql);
      }

      const receivedChecksCountAfter = await countRows(db, "received_checks");
      if (receivedChecksCountAfter !== receivedChecksCountBefore) {
        throw new Error(
          `Integridad violada: received_checks tenía ${receivedChecksCountBefore} filas antes y ${receivedChecksCountAfter} después de una migración sin backfill.`
        );
      }

      // ── B. remittance_allocations ──
      await db.execute(CREATE_REMITTANCE_ALLOCATIONS_NEW_SQL);

      const newAllocCols = await db.execute("PRAGMA table_info(remittance_allocations_new)");
      const newAllocColNames = new Set(newAllocCols.rows.map((r: any) => r.name));
      const missingAllocCols = REMITTANCE_ALLOCATIONS_EXPECTED_COLUMNS.filter((c) => !newAllocColNames.has(c));
      if (missingAllocCols.length > 0) {
        throw new Error(`remittance_allocations_new quedó sin columnas esperadas: ${missingAllocCols.join(", ")}. Abortando.`);
      }

      await db.execute(INSERT_INTO_REMITTANCE_ALLOCATIONS_NEW_SQL);
      await db.execute(DROP_OLD_REMITTANCE_ALLOCATIONS_SQL);
      await db.execute(RENAME_REMITTANCE_ALLOCATIONS_SQL);
      for (const sql of CREATE_REMITTANCE_ALLOCATIONS_INDEXES_SQL) {
        await db.execute(sql);
      }

      const remittanceAllocationsCountAfter = await countRows(db, "remittance_allocations");
      if (remittanceAllocationsCountAfter !== remittanceAllocationsCountBefore) {
        throw new Error(
          `Integridad violada: remittance_allocations tenía ${remittanceAllocationsCountBefore} filas antes y ${remittanceAllocationsCountAfter} después de una migración sin backfill.`
        );
      }

      // Verificar que ninguna FK relacionada con las tablas tocadas quedó
      // rota antes de confirmar — con foreign_keys=OFF esto no se chequea
      // automáticamente en cada INSERT. Cualquier violación preexistente y
      // no relacionada con estas dos tablas no es responsabilidad de esta
      // migración y no debe bloquearla (mismo criterio que 0026).
      const relevantTables = new Set(["received_checks", "remittance_allocations"]);
      const allFkViolations = await db.execute("PRAGMA foreign_key_check");
      const fkViolations = {
        rows: allFkViolations.rows.filter((r: any) => relevantTables.has(r.parent) || relevantTables.has(r.table)),
      };
      if (fkViolations.rows.length > 0) {
        throw new Error(
          `foreign_key_check encontró ${fkViolations.rows.length} violación(es) relacionada(s) con received_checks/remittance_allocations después de recrearlas — abortando antes de confirmar: ${JSON.stringify(fkViolations.rows)}`
        );
      }

      await db.execute("COMMIT");
      return {
        alreadyApplied: false,
        receivedChecksCountBefore,
        receivedChecksCountAfter,
        remittanceAllocationsCountBefore,
        remittanceAllocationsCountAfter,
      };
    } catch (e) {
      await db.execute("ROLLBACK");
      throw e;
    }
  } finally {
    // Se reactiva pase lo que pase (éxito o rollback) — nunca dejar la
    // conexión con foreign_keys apagado por un error a mitad de camino.
    await db.execute("PRAGMA foreign_keys=ON");
  }
}
