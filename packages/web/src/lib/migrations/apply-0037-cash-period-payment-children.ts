// Lógica reutilizable de la migración 0037 ("Contado por período en un lote
// mixto" — ver src/api/migrations/0037_cash_period_payment_children.sql para
// el diseño completo). Mismo criterio que el resto de los aplicadores desde
// 0017: función pura sin BEGIN/COMMIT propio + wrapper local que sí los
// agrega, usable contra cualquier cliente compatible con @libsql/client
// (Turso o un archivo SQLite local).
//
// Aditiva: 1 columna nullable en payments + 1 índice no único + backfill
// determinístico de los hijos de los contados ya existentes (hasta esta
// migración, TODOS los hijos de un lote con fila en cash_period_payments son
// cuotas de ese período — POST /payment-batches/cash-period-payment nunca
// creó otra cosa). Ninguna tabla se recrea, ninguna fila se borra, ningún
// importe cambia. Idempotente: re-ejecutarla no vuelve a tocar nada.

export interface Sql0037Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0037Summary {
  columnAdded: boolean;
  indexCreated: boolean;
  backfilledRows: number;
  alreadyApplied: boolean;
  paymentsBefore: number;
  paymentsAfter: number;
  cashPeriodPayments: number;
  linkedChildren: number;
}

export const MIGRATION_0037_COLUMN_DDL =
  "ALTER TABLE payments ADD COLUMN cash_period_payment_id INTEGER REFERENCES cash_period_payments(id)";
export const MIGRATION_0037_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_payments_cash_period_payment_id ON payments(cash_period_payment_id)";
// Lotes con contado que todavía NO tienen ningún hijo vinculado: solo pueden
// ser contados creados antes de esta migración (100% cuotas del período). Un
// lote creado después ya nace con sus cuotas del contado vinculadas, y sus
// cuotas comunes (lote mixto) quedan en NULL a propósito: re-ejecutar el
// backfill nunca debe tocarlas. El índice único ux_cash_period_payments_batch_id
// (0034) garantiza que el subselect devuelve como máximo una fila.
const UNMIGRATED_CASH_PERIOD_BATCHES_SQL = `SELECT cpp.payment_batch_id FROM cash_period_payments cpp
    WHERE NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.cash_period_payment_id = cpp.id)`;
export const MIGRATION_0037_BACKFILL_SQL = `UPDATE payments
  SET cash_period_payment_id = (
    SELECT cpp.id FROM cash_period_payments cpp WHERE cpp.payment_batch_id = payments.batch_id
  )
  WHERE cash_period_payment_id IS NULL
    AND batch_id IS NOT NULL
    AND batch_id IN (${UNMIGRATED_CASH_PERIOD_BATCHES_SQL})`;

async function columnExists(db: Sql0037Client, table: string, column: string): Promise<boolean> {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  return cols.rows.some((r: any) => r.name === column);
}

async function indexExists(db: Sql0037Client, indexName: string): Promise<boolean> {
  const r = await db.execute(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, [indexName]);
  return r.rows.length > 0;
}

async function count(db: Sql0037Client, sql: string): Promise<number> {
  const r = await db.execute(sql);
  return Number(r.rows[0].c);
}

/**
 * Trabajo puro de la migración 0037 — SOLO statements de lectura/escritura,
 * SIN BEGIN/COMMIT/ROLLBACK (quien llama decide la atomicidad: BEGIN/COMMIT
 * local o client.transaction("write") en Turso).
 *
 * Antes de escribir verifica que cada hijo a vincular sea realmente una cuota
 * del período de su contado (misma póliza; misma refacturación, o ninguna
 * para el período de emisión). Si algún dato histórico no cumple, aborta sin
 * vincular nada: nunca se inventa una relación dudosa.
 */
export async function applyMigration0037CashPeriodPaymentChildrenWork(db: Sql0037Client): Promise<Migration0037Summary> {
  const paymentsBefore = await count(db, "SELECT COUNT(*) as c FROM payments");

  let columnAdded = false;
  if (!(await columnExists(db, "payments", "cash_period_payment_id"))) {
    await db.execute(MIGRATION_0037_COLUMN_DDL);
    columnAdded = true;
  }
  let indexCreated = false;
  if (!(await indexExists(db, "idx_payments_cash_period_payment_id"))) {
    await db.execute(MIGRATION_0037_INDEX_DDL);
    indexCreated = true;
  }

  // Validación previa al backfill: hijos de un contado cuya cuota no es del
  // período del contado (o que no tienen cuota). Debería dar 0 siempre.
  const mismatched = await count(db, `SELECT COUNT(*) as c FROM payments p
    INNER JOIN cash_period_payments cpp ON cpp.payment_batch_id = p.batch_id
    LEFT JOIN policy_installments pi ON pi.id = p.installment_id
    WHERE p.cash_period_payment_id IS NULL
      AND p.batch_id IN (${UNMIGRATED_CASH_PERIOD_BATCHES_SQL})
      AND (
        p.installment_id IS NULL
        OR pi.id IS NULL
        OR p.policy_id IS NOT cpp.policy_id
        OR pi.policy_id IS NOT cpp.policy_id
        OR pi.rebilling_id IS NOT cpp.rebilling_id
      )`);
  if (mismatched > 0) {
    throw new Error(
      `Migración 0037 abortada: ${mismatched} pago(s) hijo(s) de un contado no corresponden a una cuota de su período ` +
      `(póliza/refacturación distinta o sin cuota). Requiere revisión manual antes de vincular.`
    );
  }

  const pendingBefore = await count(db, `SELECT COUNT(*) as c FROM payments
    WHERE cash_period_payment_id IS NULL AND batch_id IN (${UNMIGRATED_CASH_PERIOD_BATCHES_SQL})`);
  if (pendingBefore > 0) await db.execute(MIGRATION_0037_BACKFILL_SQL);
  // Todo contado con al menos un hijo debe quedar con al menos un hijo vinculado.
  const contadosSinVinculo = await count(db, `SELECT COUNT(*) as c FROM cash_period_payments cpp
    WHERE EXISTS (SELECT 1 FROM payments p WHERE p.batch_id = cpp.payment_batch_id)
      AND NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.cash_period_payment_id = cpp.id)`);
  if (contadosSinVinculo !== 0) {
    throw new Error(`Integridad violada: quedaron ${contadosSinVinculo} contado(s) con hijos sin vincular después del backfill.`);
  }

  // Todo vínculo apunta al contado de su propio lote (nunca a otro).
  const crossLinked = await count(db, `SELECT COUNT(*) as c FROM payments p
    INNER JOIN cash_period_payments cpp ON cpp.id = p.cash_period_payment_id
    WHERE p.batch_id IS NOT cpp.payment_batch_id`);
  if (crossLinked > 0) {
    throw new Error(`Integridad violada: ${crossLinked} pago(s) vinculados a un contado de otro lote.`);
  }

  const paymentsAfter = await count(db, "SELECT COUNT(*) as c FROM payments");
  if (paymentsAfter !== paymentsBefore) {
    throw new Error("Integridad violada: la cantidad de filas de payments cambió durante la migración 0037.");
  }

  return {
    columnAdded,
    indexCreated,
    backfilledRows: pendingBefore,
    alreadyApplied: !columnAdded && !indexCreated && pendingBefore === 0,
    paymentsBefore,
    paymentsAfter,
    cashPeriodPayments: await count(db, "SELECT COUNT(*) as c FROM cash_period_payments"),
    linkedChildren: await count(db, "SELECT COUNT(*) as c FROM payments WHERE cash_period_payment_id IS NOT NULL"),
  };
}

/**
 * Uso local/tests (bun:sqlite): agrega BEGIN/COMMIT/ROLLBACK alrededor del
 * trabajo puro. NUNCA reutilizar este wrapper contra Turso (@libsql/client
 * sobre HTTP no mantiene sesión entre llamadas) — un script productivo debe
 * envolver el Work con client.transaction("write").
 */
export async function applyMigration0037CashPeriodPaymentChildren(db: Sql0037Client): Promise<Migration0037Summary> {
  await db.execute("BEGIN");
  try {
    const summary = await applyMigration0037CashPeriodPaymentChildrenWork(db);
    await db.execute("COMMIT");
    return summary;
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
}
