// Lógica reutilizable de la migración 0026 (payment_batches.insured_id
// nullable — Etapa "lote multi-asegurado"). Mismo patrón que
// apply-0021-payment-batches.ts, pero esta vez SQLite exige recrear la tabla
// completa (no hay "ALTER COLUMN ... DROP NOT NULL"): se sigue el
// procedimiento de 12 pasos documentado por SQLite para cambios de esquema
// no soportados por ALTER TABLE (https://www.sqlite.org/lang_altertable.html
// #making_other_kinds_of_table_schema_changes), ya usado en este proyecto
// para volver nullable policies_id/manual_debt_source en 0008/0009/0010/0014
// (aunque esas corrieron antes de que existiera este patrón de aplicador TS
// idempotente).
//
// PRAGMA foreign_keys es un no-op dentro de una transacción — por eso se
// apaga ANTES de abrir la transacción, se hace todo el trabajo (crear tabla
// nueva, copiar filas, borrar la vieja, renombrar, recrear índices), se
// corre PRAGMA foreign_key_check ANTES de confirmar (aborta si encuentra
// alguna referencia rota — no debería, porque el rename preserva las FKs de
// payments.batch_id / payment_batch_splits.batch_id /
// remittance_allocations.payment_batch_id, que apuntan por nombre de tabla),
// se hace COMMIT, y recién ahí se reactiva foreign_keys. Idempotente:
// si insured_id ya es nullable, no hace nada.
//
// Sin backfill: ninguna fila cambia de valor — todas conservan su
// insured_id actual (NOT NULL hoy, sigue teniendo el mismo valor real
// después). Los batches NUEVOS multi-asegurado/100%-manuales son los únicos
// que en adelante pueden insertar NULL — eso lo decide POST
// /payment-batches (resolveBatchInsuredId en src/lib/payments/batches.ts),
// no esta migración.

export interface Sql0026Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0026Summary {
  alreadyNullable: boolean;
  paymentBatchesCountBefore: number;
  paymentBatchesCountAfter: number;
}

export const EXPECTED_COLUMNS = [
  "id", "insured_id", "base_amount_cents", "surcharge_amount_cents",
  "total_received_cents", "payment_date", "status", "notes",
  "created_by", "created_at", "updated_at",
];

export const CREATE_NEW_TABLE_SQL = `
CREATE TABLE payment_batches_new (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  insured_id             INTEGER REFERENCES insureds(id),
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

export const INSERT_INTO_NEW_TABLE_SQL = `
INSERT INTO payment_batches_new (
  id, insured_id, base_amount_cents, surcharge_amount_cents, total_received_cents,
  payment_date, status, notes, created_by, created_at, updated_at
)
SELECT
  id, insured_id, base_amount_cents, surcharge_amount_cents, total_received_cents,
  payment_date, status, notes, created_by, created_at, updated_at
FROM payment_batches
`.trim();

export const DROP_OLD_TABLE_SQL = "DROP TABLE payment_batches";
export const RENAME_TABLE_SQL = "ALTER TABLE payment_batches_new RENAME TO payment_batches";

export const CREATE_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_payment_batches_insured_id ON payment_batches(insured_id)",
  "CREATE INDEX IF NOT EXISTS idx_payment_batches_payment_date ON payment_batches(payment_date)",
  "CREATE INDEX IF NOT EXISTS idx_payment_batches_status ON payment_batches(status)",
];

// Misma secuencia de trabajo (sin BEGIN/COMMIT/PRAGMA, que en el runner de
// Turso los agrega client.migrate() automáticamente alrededor de este mismo
// arreglo — ver apply-0026-prod.ts). Se exporta para que ese runner nunca
// tenga que reescribir o duplicar este SQL a mano.
export const MIGRATION_0026_WORK_STATEMENTS: string[] = [
  CREATE_NEW_TABLE_SQL,
  INSERT_INTO_NEW_TABLE_SQL,
  DROP_OLD_TABLE_SQL,
  RENAME_TABLE_SQL,
  ...CREATE_INDEXES_SQL,
];

async function tableExists(db: Sql0026Client, name: string): Promise<boolean> {
  const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return r.rows.length > 0;
}

export async function isInsuredIdNullable(db: Sql0026Client): Promise<boolean> {
  const cols = await db.execute("PRAGMA table_info(payment_batches)");
  const insuredCol = cols.rows.find((r: any) => r.name === "insured_id");
  if (!insuredCol) {
    throw new Error("payment_batches.insured_id no existe — no se puede aplicar esta migración sobre este esquema.");
  }
  return Number(insuredCol.notnull) === 0;
}

async function countRows(db: Sql0026Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

export async function applyMigration0026PaymentBatchesNullableInsured(db: Sql0026Client): Promise<Migration0026Summary> {
  if (!(await tableExists(db, "payment_batches"))) {
    throw new Error("payment_batches no existe — corré primero la migración 0021.");
  }

  const alreadyNullable = await isInsuredIdNullable(db);
  const paymentBatchesCountBefore = await countRows(db, "payment_batches");

  if (alreadyNullable) {
    // Idempotente: ya aplicada (o la tabla ya nació nullable). No se toca nada.
    return { alreadyNullable: true, paymentBatchesCountBefore, paymentBatchesCountAfter: paymentBatchesCountBefore };
  }

  // 1. foreign_keys es un no-op dentro de una transacción — se apaga ANTES.
  await db.execute("PRAGMA foreign_keys=OFF");

  try {
    await db.execute("BEGIN");
    try {
      await db.execute(CREATE_NEW_TABLE_SQL);

      const newCols = await db.execute("PRAGMA table_info(payment_batches_new)");
      const newColNames = new Set(newCols.rows.map((r: any) => r.name));
      const missing = EXPECTED_COLUMNS.filter((c) => !newColNames.has(c));
      if (missing.length > 0) {
        throw new Error(`payment_batches_new quedó sin columnas esperadas: ${missing.join(", ")}. Abortando.`);
      }

      await db.execute(INSERT_INTO_NEW_TABLE_SQL);

      await db.execute(DROP_OLD_TABLE_SQL);
      await db.execute(RENAME_TABLE_SQL);

      for (const sql of CREATE_INDEXES_SQL) {
        await db.execute(sql);
      }

      const paymentBatchesCountAfter = await countRows(db, "payment_batches");
      if (paymentBatchesCountAfter !== paymentBatchesCountBefore) {
        throw new Error(
          `Integridad violada: payment_batches tenía ${paymentBatchesCountBefore} filas antes y ${paymentBatchesCountAfter} después de una migración sin backfill.`
        );
      }

      // 8 (del procedimiento de 12 pasos de SQLite): verificar que ninguna FK
      // relacionada con payment_batches quedó rota antes de confirmar — con
      // foreign_keys=OFF esto no se chequea automáticamente en cada INSERT,
      // así que se valida a mano acá. PRAGMA foreign_key_check revisa TODA
      // la base, no solo la tabla que tocamos — se filtra a violaciones cuyo
      // `parent` o `table` sea payment_batches (payments.batch_id,
      // payment_batch_splits.batch_id, remittance_allocations.
      // payment_batch_id → payment_batches; o payment_batches.insured_id →
      // insureds). Cualquier otra violación preexistente y no relacionada
      // (ej. huérfanos históricos de payment_splits/cash_entries → payments,
      // ya documentados como una flakiness de limpieza de tests conocida) no
      // es responsabilidad de esta migración y no debe bloquearla.
      const allFkViolations = await db.execute("PRAGMA foreign_key_check");
      const fkViolations = {
        rows: allFkViolations.rows.filter((r: any) => r.parent === "payment_batches" || r.table === "payment_batches"),
      };
      if (fkViolations.rows.length > 0) {
        throw new Error(
          `foreign_key_check encontró ${fkViolations.rows.length} violación(es) relacionada(s) con payment_batches después de recrearla — abortando antes de confirmar: ${JSON.stringify(fkViolations.rows)}`
        );
      }

      await db.execute("COMMIT");
      return { alreadyNullable: false, paymentBatchesCountBefore, paymentBatchesCountAfter };
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
