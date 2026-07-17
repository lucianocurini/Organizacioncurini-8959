// Lógica reutilizable de la migración 0029 — relaja el CHECK "exactamente un
// leaf" de remittance_allocations para permitir un cuarto tipo de leaf:
// payment_id SOLO (sin payment_split_id/payment_batch_split_id/cash_entry_id).
//
// Motivo (rendición por cuota, no por lote — ver diagnóstico de negocio):
// hasta esta migración, un payment HIJO de un payment_batches (batchId NOT
// NULL) solo podía rendirse arrastrando el instrumento de COBRANZA completo
// del batch (payment_batch_splits/received_checks, vía resolveBatchInstruments
// — "el batch se rinde completo o no se rinde", ver comentario histórico de
// la migración 0024). Eso conflaba dos cosas distintas: cómo entró la plata
// (instrumento de cobranza, real, físico) con cómo sale/se rinde a la
// compañía (instrumento de salida, propio de cada rendición). Esta migración
// NO toca cómo se resuelven/leen las allocations de batch existentes
// (payment_batch_split_id/received_check_id siguen funcionando exactamente
// igual, ver resolveBatchInstruments en remittance-allocations.ts) — solo
// habilita un camino nuevo, alternativo, para rendir un payment hijo de
// batch de forma independiente de sus hermanos: una allocation con
// payment_id (el payment puntual) + payment_batch_id (denormalizado, solo
// trazabilidad de "de qué lote vino") + method/amount_cents PROPIOS de esta
// rendición (el medio con el que Curini le paga a la compañía en ese
// momento, no necesariamente el medio de cobro original).
//
// SQLite no permite modificar un CHECK existente vía ALTER TABLE — se
// recrea la tabla completa, mismo procedimiento de 12 pasos ya usado en
// 0021/0022/0023/0024/0026/0028 (https://www.sqlite.org/lang_altertable.html
// #making_other_kinds_of_table_schema_changes). No se agrega ninguna columna
// nueva (payment_id ya existe desde 0024, hoy denormalizado junto a
// payment_split_id) — el único cambio de esquema real es el CHECK y un
// índice único nuevo.
//
// CHECK anterior:
//   (payment_split_id IS NOT NULL) +
//   (payment_batch_split_id IS NOT NULL) +
//   (cash_entry_id IS NOT NULL) = 1
// CHECK nuevo:
//   (payment_split_id IS NOT NULL) +
//   (payment_batch_split_id IS NOT NULL) +
//   (cash_entry_id IS NOT NULL) +
//   (payment_id IS NOT NULL AND payment_split_id IS NULL) = 1
//
// El término nuevo nunca interfiere con las filas existentes: un leaf
// payment_split/payment_split_check ya tiene payment_id Y payment_split_id
// seteados juntos (denormalización histórica, ver comentario de la migración
// 0024) — el "AND payment_split_id IS NULL" excluye exactamente ese caso, así
// que sigue contando 1 solo desde el término payment_split_id. Los leaves de
// batch (payment_batch_split_id) y cash_entry nunca tienen payment_id seteado
// (ver buildRemittanceAllocations en remittance-allocations.ts) — el término
// nuevo da 0 para ellos, sin cambios.
//
// El segundo CHECK (received_check_id IS NULL OR payment_batch_split_id IS
// NOT NULL OR payment_split_id IS NOT NULL) queda exactamente igual — el
// leaf nuevo nunca tiene received_check_id.
//
// Protección contra doble rendición del leaf nuevo: índice único parcial
// ux_remittance_allocations_payment_only sobre payment_id, acotado a las
// filas donde payment_id es la ÚNICA columna identificadora (las otras 3
// NULL) — un mismo payment hijo de batch no puede aparecer dos veces bajo
// este leaf en ninguna rendición, en todo el historial. Esto es ADEMÁS de la
// validación de aplicación (payments.rendered) que ya existe en POST
// /remittances — dos capas, igual que el resto de los leaves.
//
// Sin backfill: ninguna fila existente cambia de valor.

export interface Sql0029Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0029Summary {
  alreadyApplied: boolean;
  remittanceAllocationsCountBefore: number;
  remittanceAllocationsCountAfter: number;
}

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
    (cash_entry_id IS NOT NULL) +
    (payment_id IS NOT NULL AND payment_split_id IS NULL) = 1
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
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_payment_split ON remittance_allocations(payment_split_id) WHERE payment_split_id IS NOT NULL AND received_check_id IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_batch_split_no_check ON remittance_allocations(payment_batch_split_id) WHERE payment_batch_split_id IS NOT NULL AND received_check_id IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_received_check ON remittance_allocations(received_check_id) WHERE received_check_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_cash_entry ON remittance_allocations(cash_entry_id) WHERE cash_entry_id IS NOT NULL",
  // Leaf nuevo (0029): payment_id es la única columna identificadora (las
  // otras 3 NULL) — nunca choca con el índice ux_remittance_allocations_
  // payment_split de arriba, que exige payment_split_id IS NOT NULL.
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_payment_only ON remittance_allocations(payment_id) WHERE payment_id IS NOT NULL AND payment_split_id IS NULL AND payment_batch_split_id IS NULL AND cash_entry_id IS NULL",
];

export const MIGRATION_0029_WORK_STATEMENTS: string[] = [
  CREATE_REMITTANCE_ALLOCATIONS_NEW_SQL,
  INSERT_INTO_REMITTANCE_ALLOCATIONS_NEW_SQL,
  DROP_OLD_REMITTANCE_ALLOCATIONS_SQL,
  RENAME_REMITTANCE_ALLOCATIONS_SQL,
  ...CREATE_REMITTANCE_ALLOCATIONS_INDEXES_SQL,
];

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

async function tableExists(db: Sql0029Client, name: string): Promise<boolean> {
  const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return r.rows.length > 0;
}

async function countRows(db: Sql0029Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

/**
 * Única forma de inspeccionar un CHECK en SQLite: leer el SQL real de
 * creación desde sqlite_master (no hay PRAGMA para esto). Se considera "ya
 * migrada" si el CHECK de "exactamente un leaf" ya incluye el término nuevo
 * de payment_id — no alcanza con que la tabla/columna exista (payment_id ya
 * existía desde 0024).
 */
export async function isRemittanceAllocationsAlreadyMigrated(db: Sql0029Client): Promise<boolean> {
  const r = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='remittance_allocations'");
  if (r.rows.length === 0) {
    throw new Error("remittance_allocations no existe — no se puede validar su SQL de creación.");
  }
  const normalized = normalizeSql(String(r.rows[0]!.sql ?? ""));
  return normalized.includes("payment_id is not null and payment_split_id is null");
}

export async function applyMigration0029RemittanceAllocationsBatchChildPayment(
  db: Sql0029Client
): Promise<Migration0029Summary> {
  if (!(await tableExists(db, "remittance_allocations"))) {
    throw new Error("remittance_allocations no existe — corré primero la migración 0024.");
  }

  const alreadyApplied = await isRemittanceAllocationsAlreadyMigrated(db);
  const remittanceAllocationsCountBefore = await countRows(db, "remittance_allocations");

  if (alreadyApplied) {
    return {
      alreadyApplied: true,
      remittanceAllocationsCountBefore,
      remittanceAllocationsCountAfter: remittanceAllocationsCountBefore,
    };
  }

  // foreign_keys es un no-op dentro de una transacción — se apaga ANTES.
  await db.execute("PRAGMA foreign_keys=OFF");

  try {
    await db.execute("BEGIN");
    try {
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

      // Verificar que ninguna FK relacionada con remittance_allocations
      // quedó rota antes de confirmar — con foreign_keys=OFF esto no se
      // chequea automáticamente en cada INSERT. Cualquier violación
      // preexistente no relacionada con esta tabla no es responsabilidad de
      // esta migración y no debe bloquearla (mismo criterio que 0026/0028).
      const allFkViolations = await db.execute("PRAGMA foreign_key_check");
      const fkViolations = { rows: allFkViolations.rows.filter((r: any) => r.table === "remittance_allocations") };
      if (fkViolations.rows.length > 0) {
        throw new Error(
          `foreign_key_check encontró ${fkViolations.rows.length} violación(es) en remittance_allocations después de recrearla — abortando antes de confirmar: ${JSON.stringify(fkViolations.rows)}`
        );
      }

      await db.execute("COMMIT");
      return { alreadyApplied: false, remittanceAllocationsCountBefore, remittanceAllocationsCountAfter };
    } catch (e) {
      await db.execute("ROLLBACK");
      throw e;
    }
  } finally {
    await db.execute("PRAGMA foreign_keys=ON");
  }
}
