// Lógica reutilizable de la migración 0034 ("Pago de contado por período de
// facturación" — ver src/api/migrations/0034_cash_period_payments.sql para
// el diseño completo). Usada tanto por un futuro script local/productivo
// como por los tests, contra cualquier cliente compatible con
// @libsql/client (Turso o un archivo SQLite local) — mismo criterio que el
// resto de los aplicadores de este proyecto desde 0017 en adelante.
//
// Puramente aditiva: 2 columnas nullable (policies/rebillings) + 1 tabla
// nueva sin backfill — ninguna tabla existente se recrea, ninguna fila
// histórica cambia. Idempotente.

export interface Sql0034Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0034Summary {
  policiesColumnAdded: boolean;
  rebillingsColumnAdded: boolean;
  tableCreated: boolean;
  alreadyApplied: boolean;
  policiesBefore: number;
  policiesAfter: number;
  rebillingsBefore: number;
  rebillingsAfter: number;
  cashPeriodPaymentsCountAfter: number;
}

async function columnExists(db: Sql0034Client, table: string, column: string): Promise<boolean> {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  return cols.rows.some((r: any) => r.name === column);
}

async function tableExists(db: Sql0034Client, table: string): Promise<boolean> {
  const r = await db.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]);
  return r.rows.length > 0;
}

async function countRows(db: Sql0034Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

/**
 * Trabajo puro de la migración 0034 — SOLO statements de lectura/escritura
 * (ALTER/CREATE/SELECT/PRAGMA), SIN emitir BEGIN/COMMIT/ROLLBACK. Mismo
 * criterio que 0031/0032/0033: quien llama decide la atomicidad según el
 * entorno (BEGIN/COMMIT local vs. client.transaction("write") en Turso).
 */
export async function applyMigration0034CashPeriodPaymentsWork(db: Sql0034Client): Promise<Migration0034Summary> {
  const policiesBefore = await countRows(db, "policies");
  const rebillingsBefore = await countRows(db, "rebillings");

  const policiesColumnExisted = await columnExists(db, "policies", "cash_payment_amount_cents");
  let policiesColumnAdded = false;
  if (!policiesColumnExisted) {
    await db.execute("ALTER TABLE policies ADD COLUMN cash_payment_amount_cents INTEGER");
    policiesColumnAdded = true;
  }

  const rebillingsColumnExisted = await columnExists(db, "rebillings", "cash_payment_amount_cents");
  let rebillingsColumnAdded = false;
  if (!rebillingsColumnExisted) {
    await db.execute("ALTER TABLE rebillings ADD COLUMN cash_payment_amount_cents INTEGER");
    rebillingsColumnAdded = true;
  }

  const tableExisted = await tableExists(db, "cash_period_payments");
  let tableCreated = false;
  if (!tableExisted) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS cash_period_payments (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_batch_id       INTEGER NOT NULL REFERENCES payment_batches(id),
        policy_id              INTEGER NOT NULL REFERENCES policies(id),
        rebilling_id           INTEGER REFERENCES rebillings(id),
        nominal_amount_cents   INTEGER NOT NULL CHECK (nominal_amount_cents > 0),
        cash_amount_cents      INTEGER NOT NULL CHECK (cash_amount_cents > 0),
        discount_amount_cents  INTEGER NOT NULL CHECK (discount_amount_cents >= 0),
        status                 TEXT NOT NULL DEFAULT 'confirmado' CHECK (status IN ('confirmado', 'anulado')),
        rendered               INTEGER NOT NULL DEFAULT 0,
        rendered_at            INTEGER,
        cancelled_at           INTEGER,
        cancelled_by           INTEGER REFERENCES users(id),
        created_by             INTEGER NOT NULL REFERENCES users(id),
        created_at             INTEGER NOT NULL,
        CHECK (cash_amount_cents <= nominal_amount_cents)
      )
    `);
    await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_period_payments_batch_id ON cash_period_payments(payment_batch_id)");
    await db.execute("CREATE INDEX IF NOT EXISTS idx_cash_period_payments_policy_rebilling ON cash_period_payments(policy_id, rebilling_id)");
    tableCreated = true;
  }

  const policiesAfter = await countRows(db, "policies");
  const rebillingsAfter = await countRows(db, "rebillings");
  if (policiesAfter !== policiesBefore || rebillingsAfter !== rebillingsBefore) {
    throw new Error("Integridad violada: la cantidad de filas en policies/rebillings cambió durante una migración sin backfill de filas.");
  }

  const cashPeriodPaymentsCountAfter = await countRows(db, "cash_period_payments");
  if (tableCreated && cashPeriodPaymentsCountAfter !== 0) {
    throw new Error("Integridad violada: cash_period_payments tiene filas inmediatamente después de crear la tabla (sin backfill).");
  }

  return {
    policiesColumnAdded,
    rebillingsColumnAdded,
    tableCreated,
    alreadyApplied: policiesColumnExisted && rebillingsColumnExisted && tableExisted,
    policiesBefore,
    policiesAfter,
    rebillingsBefore,
    rebillingsAfter,
    cashPeriodPaymentsCountAfter,
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
export async function applyMigration0034CashPeriodPayments(db: Sql0034Client): Promise<Migration0034Summary> {
  await db.execute("BEGIN");
  let summary: Migration0034Summary;
  try {
    summary = await applyMigration0034CashPeriodPaymentsWork(db);
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
  await db.execute("COMMIT");
  return summary;
}
