// Lógica reutilizable de la migración 0036 ("Titular de cuenta explícito +
// asignaciones de financiación fuente↔destino" — ver
// src/api/migrations/0036_account_holder_funding.sql para el diseño
// completo). Mismo criterio que el resto de los aplicadores de este
// proyecto desde 0017 en adelante: función pura sin BEGIN/COMMIT propio +
// wrapper local que sí los agrega, usable contra cualquier cliente
// compatible con @libsql/client (Turso o un archivo SQLite local).
//
// Puramente aditiva: 3 columnas nullable (payment_batches,
// insured_account_movements, payment_amount_adjustments) + 2 tablas nuevas
// sin backfill — ninguna tabla existente se recrea, ninguna fila histórica
// cambia. Idempotente. Esta migración NO reconstruye ninguna tabla (a
// diferencia de 0026), así que no hay necesidad técnica de desactivar
// foreign_keys en ningún momento — se deja tal cual esté en la conexión del
// caller.

export interface Sql0036Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0036Summary {
  paymentBatchesColumnAdded: boolean;
  insuredAccountMovementsColumnAdded: boolean;
  paymentAmountAdjustmentsColumnAdded: boolean;
  fundingAllocationsTableCreated: boolean;
  idempotencyKeysTableCreated: boolean;
  indexesCreated: string[];
  alreadyApplied: boolean;
  paymentBatchesBefore: number;
  paymentBatchesAfter: number;
  insuredAccountMovementsBefore: number;
  insuredAccountMovementsAfter: number;
  paymentAmountAdjustmentsBefore: number;
  paymentAmountAdjustmentsAfter: number;
  fundingAllocationsCountAfter: number;
  idempotencyKeysCountAfter: number;
}

async function columnExists(db: Sql0036Client, table: string, column: string): Promise<boolean> {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  return cols.rows.some((r: any) => r.name === column);
}

async function tableExists(db: Sql0036Client, table: string): Promise<boolean> {
  const r = await db.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]);
  return r.rows.length > 0;
}

async function indexExists(db: Sql0036Client, indexName: string): Promise<boolean> {
  const r = await db.execute(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, [indexName]);
  return r.rows.length > 0;
}

async function countRows(db: Sql0036Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

const FUNDING_ALLOCATIONS_INDEXES: { name: string; ddl: string }[] = [
  { name: "idx_pbfa_payment_batch_id", ddl: "CREATE INDEX IF NOT EXISTS idx_pbfa_payment_batch_id ON payment_batch_funding_allocations(payment_batch_id)" },
  { name: "idx_pbfa_payment_batch_split_id", ddl: "CREATE INDEX IF NOT EXISTS idx_pbfa_payment_batch_split_id ON payment_batch_funding_allocations(payment_batch_split_id)" },
  { name: "idx_pbfa_source_account_movement_id", ddl: "CREATE INDEX IF NOT EXISTS idx_pbfa_source_account_movement_id ON payment_batch_funding_allocations(source_account_movement_id)" },
  { name: "idx_pbfa_payment_amount_adjustment_id", ddl: "CREATE INDEX IF NOT EXISTS idx_pbfa_payment_amount_adjustment_id ON payment_batch_funding_allocations(payment_amount_adjustment_id)" },
  { name: "idx_pbfa_payment_id", ddl: "CREATE INDEX IF NOT EXISTS idx_pbfa_payment_id ON payment_batch_funding_allocations(payment_id)" },
  { name: "idx_pbfa_cash_entry_id", ddl: "CREATE INDEX IF NOT EXISTS idx_pbfa_cash_entry_id ON payment_batch_funding_allocations(cash_entry_id)" },
  { name: "idx_pbfa_destination_account_movement_id", ddl: "CREATE INDEX IF NOT EXISTS idx_pbfa_destination_account_movement_id ON payment_batch_funding_allocations(destination_account_movement_id)" },
  { name: "ux_pbfa_split_payment", ddl: "CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_split_payment ON payment_batch_funding_allocations(payment_batch_split_id, payment_id) WHERE payment_batch_split_id IS NOT NULL AND payment_id IS NOT NULL" },
  { name: "ux_pbfa_split_cash_entry", ddl: "CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_split_cash_entry ON payment_batch_funding_allocations(payment_batch_split_id, cash_entry_id) WHERE payment_batch_split_id IS NOT NULL AND cash_entry_id IS NOT NULL" },
  { name: "ux_pbfa_split_new_credit", ddl: "CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_split_new_credit ON payment_batch_funding_allocations(payment_batch_split_id, destination_account_movement_id) WHERE payment_batch_split_id IS NOT NULL AND destination_account_movement_id IS NOT NULL" },
  { name: "ux_pbfa_srcmov_payment", ddl: "CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_srcmov_payment ON payment_batch_funding_allocations(source_account_movement_id, payment_id) WHERE source_account_movement_id IS NOT NULL AND payment_id IS NOT NULL" },
  { name: "ux_pbfa_srcmov_cash_entry", ddl: "CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_srcmov_cash_entry ON payment_batch_funding_allocations(source_account_movement_id, cash_entry_id) WHERE source_account_movement_id IS NOT NULL AND cash_entry_id IS NOT NULL" },
  { name: "ux_pbfa_srcmov_new_credit", ddl: "CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_srcmov_new_credit ON payment_batch_funding_allocations(source_account_movement_id, destination_account_movement_id) WHERE source_account_movement_id IS NOT NULL AND destination_account_movement_id IS NOT NULL" },
  { name: "ux_pbfa_adj_payment", ddl: "CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_adj_payment ON payment_batch_funding_allocations(payment_amount_adjustment_id, payment_id) WHERE payment_amount_adjustment_id IS NOT NULL AND payment_id IS NOT NULL" },
  { name: "ux_pbfa_adj_cash_entry", ddl: "CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_adj_cash_entry ON payment_batch_funding_allocations(payment_amount_adjustment_id, cash_entry_id) WHERE payment_amount_adjustment_id IS NOT NULL AND cash_entry_id IS NOT NULL" },
  { name: "ux_pbfa_adj_new_credit", ddl: "CREATE UNIQUE INDEX IF NOT EXISTS ux_pbfa_adj_new_credit ON payment_batch_funding_allocations(payment_amount_adjustment_id, destination_account_movement_id) WHERE payment_amount_adjustment_id IS NOT NULL AND destination_account_movement_id IS NOT NULL" },
];

/**
 * Trabajo puro de la migración 0036 — SOLO statements de lectura/escritura
 * (ALTER/CREATE/SELECT/PRAGMA), SIN emitir BEGIN/COMMIT/ROLLBACK. Mismo
 * criterio que 0031/0032/0033/0034/0035: quien llama decide la atomicidad
 * según el entorno (BEGIN/COMMIT local vs. client.transaction("write") en
 * Turso).
 */
export async function applyMigration0036AccountHolderFundingWork(db: Sql0036Client): Promise<Migration0036Summary> {
  const paymentBatchesBefore = await countRows(db, "payment_batches");
  const insuredAccountMovementsBefore = await countRows(db, "insured_account_movements");
  const paymentAmountAdjustmentsBefore = await countRows(db, "payment_amount_adjustments");

  // ─── A. payment_batches.account_holder_insured_id ──────────────────────
  const paymentBatchesColumnExisted = await columnExists(db, "payment_batches", "account_holder_insured_id");
  let paymentBatchesColumnAdded = false;
  if (!paymentBatchesColumnExisted) {
    await db.execute("ALTER TABLE payment_batches ADD COLUMN account_holder_insured_id INTEGER REFERENCES insureds(id)");
    paymentBatchesColumnAdded = true;
  }
  const accountHolderIndexExisted = await indexExists(db, "idx_payment_batches_account_holder_insured_id");
  if (!accountHolderIndexExisted) {
    await db.execute("CREATE INDEX IF NOT EXISTS idx_payment_batches_account_holder_insured_id ON payment_batches(account_holder_insured_id)");
  }

  // ─── B. insured_account_movements.effective_date ───────────────────────
  const insuredAccountMovementsColumnExisted = await columnExists(db, "insured_account_movements", "effective_date");
  let insuredAccountMovementsColumnAdded = false;
  if (!insuredAccountMovementsColumnExisted) {
    await db.execute("ALTER TABLE insured_account_movements ADD COLUMN effective_date TEXT");
    insuredAccountMovementsColumnAdded = true;
  }

  // ─── C. payment_amount_adjustments.effective_date ──────────────────────
  const paymentAmountAdjustmentsColumnExisted = await columnExists(db, "payment_amount_adjustments", "effective_date");
  let paymentAmountAdjustmentsColumnAdded = false;
  if (!paymentAmountAdjustmentsColumnExisted) {
    await db.execute("ALTER TABLE payment_amount_adjustments ADD COLUMN effective_date TEXT");
    paymentAmountAdjustmentsColumnAdded = true;
  }

  // ─── D. payment_batch_funding_allocations ──────────────────────────────
  const fundingAllocationsTableExisted = await tableExists(db, "payment_batch_funding_allocations");
  let fundingAllocationsTableCreated = false;
  if (!fundingAllocationsTableExisted) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS payment_batch_funding_allocations (
        id                               INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_batch_id                 INTEGER NOT NULL REFERENCES payment_batches(id),
        payment_batch_split_id           INTEGER REFERENCES payment_batch_splits(id),
        source_account_movement_id       INTEGER REFERENCES insured_account_movements(id),
        payment_amount_adjustment_id     INTEGER REFERENCES payment_amount_adjustments(id),
        payment_id                       INTEGER REFERENCES payments(id),
        cash_entry_id                    INTEGER REFERENCES cash_entries(id),
        destination_account_movement_id  INTEGER REFERENCES insured_account_movements(id),
        amount_cents                     INTEGER NOT NULL CHECK (amount_cents > 0),
        created_by                       INTEGER NOT NULL REFERENCES users(id),
        created_at                       INTEGER NOT NULL,
        CHECK (
          (payment_batch_split_id IS NOT NULL) +
          (source_account_movement_id IS NOT NULL) +
          (payment_amount_adjustment_id IS NOT NULL) = 1
        ),
        CHECK (
          (payment_id IS NOT NULL) +
          (cash_entry_id IS NOT NULL) +
          (destination_account_movement_id IS NOT NULL) = 1
        ),
        CHECK (
          source_account_movement_id IS NULL
          OR destination_account_movement_id IS NULL
          OR source_account_movement_id != destination_account_movement_id
        )
      )
    `);
    fundingAllocationsTableCreated = true;
  }

  const indexesCreated: string[] = [];
  for (const idx of FUNDING_ALLOCATIONS_INDEXES) {
    const existed = await indexExists(db, idx.name);
    if (!existed) {
      await db.execute(idx.ddl);
      indexesCreated.push(idx.name);
    }
  }

  // ─── E. account_holder_funding_idempotency_keys ────────────────────────
  const idempotencyKeysTableExisted = await tableExists(db, "account_holder_funding_idempotency_keys");
  let idempotencyKeysTableCreated = false;
  if (!idempotencyKeysTableExisted) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS account_holder_funding_idempotency_keys (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        created_by            INTEGER NOT NULL REFERENCES users(id),
        endpoint              TEXT NOT NULL,
        idempotency_key       TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
        request_fingerprint   TEXT NOT NULL,
        payment_batch_id      INTEGER NOT NULL REFERENCES payment_batches(id),
        response_status       INTEGER NOT NULL,
        response_snapshot     TEXT NOT NULL,
        created_at            INTEGER NOT NULL,
        UNIQUE (created_by, endpoint, idempotency_key)
      )
    `);
    idempotencyKeysTableCreated = true;
  }
  const idempotencyIndexExisted = await indexExists(db, "idx_ahf_idempotency_batch_id");
  if (!idempotencyIndexExisted) {
    await db.execute("CREATE INDEX IF NOT EXISTS idx_ahf_idempotency_batch_id ON account_holder_funding_idempotency_keys(payment_batch_id)");
  }

  const paymentBatchesAfter = await countRows(db, "payment_batches");
  const insuredAccountMovementsAfter = await countRows(db, "insured_account_movements");
  const paymentAmountAdjustmentsAfter = await countRows(db, "payment_amount_adjustments");
  if (
    paymentBatchesAfter !== paymentBatchesBefore ||
    insuredAccountMovementsAfter !== insuredAccountMovementsBefore ||
    paymentAmountAdjustmentsAfter !== paymentAmountAdjustmentsBefore
  ) {
    throw new Error(
      "Integridad violada: la cantidad de filas en payment_batches/insured_account_movements/payment_amount_adjustments cambió durante una migración puramente aditiva."
    );
  }

  const fundingAllocationsCountAfter = await countRows(db, "payment_batch_funding_allocations");
  if (fundingAllocationsTableCreated && fundingAllocationsCountAfter !== 0) {
    throw new Error("Integridad violada: payment_batch_funding_allocations tiene filas inmediatamente después de crear la tabla (sin backfill).");
  }
  const idempotencyKeysCountAfter = await countRows(db, "account_holder_funding_idempotency_keys");
  if (idempotencyKeysTableCreated && idempotencyKeysCountAfter !== 0) {
    throw new Error("Integridad violada: account_holder_funding_idempotency_keys tiene filas inmediatamente después de crear la tabla (sin backfill).");
  }

  // Ninguna fila histórica puede quedar con account_holder_insured_id/
  // effective_date completados como efecto de esta migración — arranca
  // 100% NULL para todo lo existente (sin backfill, sin reinterpretar nada).
  if (paymentBatchesColumnAdded) {
    const unexpected = await db.execute(`SELECT COUNT(*) as c FROM payment_batches WHERE account_holder_insured_id IS NOT NULL`);
    if (Number(unexpected.rows[0].c) > 0) {
      throw new Error("Integridad violada: hay payment_batches con account_holder_insured_id no nulo inmediatamente después de agregar la columna.");
    }
  }
  if (insuredAccountMovementsColumnAdded) {
    const unexpected = await db.execute(`SELECT COUNT(*) as c FROM insured_account_movements WHERE effective_date IS NOT NULL`);
    if (Number(unexpected.rows[0].c) > 0) {
      throw new Error("Integridad violada: hay insured_account_movements con effective_date no nulo inmediatamente después de agregar la columna.");
    }
  }
  if (paymentAmountAdjustmentsColumnAdded) {
    const unexpected = await db.execute(`SELECT COUNT(*) as c FROM payment_amount_adjustments WHERE effective_date IS NOT NULL`);
    if (Number(unexpected.rows[0].c) > 0) {
      throw new Error("Integridad violada: hay payment_amount_adjustments con effective_date no nulo inmediatamente después de agregar la columna.");
    }
  }

  // Postcondición final, antes de informar éxito: ninguna violación de clave
  // foránea en TODA la base (no solo en los objetos de esta migración) — una
  // migración puramente aditiva nunca debería poder introducir una, pero se
  // verifica igual como último cierre defensivo, nunca delegado únicamente
  // al caller. El formato de respuesta del cliente genérico es siempre
  // `{ rows: any[] }` (mismo contrato que el resto de las consultas de este
  // archivo) — cada fila de PRAGMA foreign_key_check trae la tabla/rowid/
  // tabla-padre/índice de FK involucrados; nunca se registran ni se
  // exponen esos valores (podrían apuntar a datos reales de producción si
  // este aplicador se corre ahí) — solo se informa la cantidad.
  const fkViolations = await db.execute("PRAGMA foreign_key_check");
  if (fkViolations.rows.length > 0) {
    throw new Error(
      `Integridad violada: PRAGMA foreign_key_check encontró ${fkViolations.rows.length} violación(es) de clave foránea después de aplicar la migración 0036 — abortando sin informar éxito.`
    );
  }

  return {
    paymentBatchesColumnAdded,
    insuredAccountMovementsColumnAdded,
    paymentAmountAdjustmentsColumnAdded,
    fundingAllocationsTableCreated,
    idempotencyKeysTableCreated,
    indexesCreated,
    alreadyApplied:
      paymentBatchesColumnExisted &&
      accountHolderIndexExisted &&
      insuredAccountMovementsColumnExisted &&
      paymentAmountAdjustmentsColumnExisted &&
      fundingAllocationsTableExisted &&
      idempotencyKeysTableExisted &&
      idempotencyIndexExisted &&
      indexesCreated.length === 0,
    paymentBatchesBefore,
    paymentBatchesAfter,
    insuredAccountMovementsBefore,
    insuredAccountMovementsAfter,
    paymentAmountAdjustmentsBefore,
    paymentAmountAdjustmentsAfter,
    fundingAllocationsCountAfter,
    idempotencyKeysCountAfter,
  };
}

/**
 * Uso local/tests (dev.db, bun:sqlite): agrega BEGIN/COMMIT/ROLLBACK
 * alrededor del trabajo puro de arriba — válido acá porque una única
 * conexión bun:sqlite sí mantiene sesión real entre execute() sueltos.
 * NUNCA reutilizar este wrapper contra Turso (@libsql/client sobre HTTP no
 * mantiene sesión entre llamadas) — un futuro script productivo debe
 * envolver el Work con client.transaction("write") o client.migrate() (ese
 * futuro caller de Turso sigue siendo responsable de pasar un transaction
 * client real — este wrapper local no lo resuelve). Sin PRAGMA foreign_keys
 * =OFF en ningún punto: esta migración no reconstruye ninguna tabla (a
 * diferencia de 0026), así que no hay necesidad técnica de desactivarlo.
 * `applyMigration0036AccountHolderFundingWork` ya ejecuta PRAGMA
 * foreign_key_check como última postcondición antes de devolver éxito — si
 * encuentra alguna violación, lanza y este wrapper hace ROLLBACK completo
 * (incluye deshacer los ALTER TABLE/CREATE TABLE de esta misma corrida,
 * gracias a que SQLite soporta DDL transaccional).
 */
export async function applyMigration0036AccountHolderFunding(db: Sql0036Client): Promise<Migration0036Summary> {
  await db.execute("BEGIN");
  let summary: Migration0036Summary;
  try {
    summary = await applyMigration0036AccountHolderFundingWork(db);
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
  await db.execute("COMMIT");
  return summary;
}
