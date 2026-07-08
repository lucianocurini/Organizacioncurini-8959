// Lógica reutilizable de la migración 0024 (remittance_allocations) — Etapa
// 4C. Usada tanto por el script local
// (packages/web/scripts/apply_0024_local.ts) como por los tests. Depende
// estructuralmente de payment_batches (0021), payment_batch_splits (0022) y
// received_checks (0023) ya aplicadas — no las reaplica, solo asume que esas
// tablas existen (mismo criterio de encadenamiento que
// apply-0023-received-checks.ts).
//
// A diferencia de 0021-0023 (que solo validan nombres de columna), este
// aplicador SÍ valida el contenido real de FKs/CHECKs/índices — remittance_
// allocations es la única fuente de verdad de dinero real repartido entre
// rendiciones, así que una tabla preexistente con un CHECK faltante o un
// índice mal definido debe rechazarse explícitamente, no darse por buena
// solo porque el nombre de columna coincide.
//
// Sin backfill: las 6 rendiciones históricas existentes hoy quedan con cero
// allocations (ver clasificador legacy/completa/inconsistente en
// src/lib/payments/remittance-allocations.ts). Idempotente — correrla una
// segunda vez no duplica nada ni falla.

export interface Sql0024Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0024Summary {
  tableAlreadyExisted: boolean;
  allocationsCountBefore: number;
  allocationsCountAfter: number;
}

/**
 * Se lanza cuando falla el ROLLBACK después de un error (del cuerpo de la
 * migración o del propio COMMIT) — la conexión queda en un estado que no se
 * puede afirmar con certeza (puede haber quedado una transacción abierta, o
 * el commit puede haber aplicado parcialmente). Nunca se debe interpretar
 * como "la migración se aplicó" ni como "se revirtió limpiamente".
 */
export class Migration0024UncertainStateError extends Error {
  constructor(
    message: string,
    public readonly originalError: unknown,
    public readonly rollbackError: unknown
  ) {
    super(message);
  }
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS remittance_allocations (
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
  )
)`.trim();

const CREATE_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_remittance_allocations_remittance_id ON remittance_allocations(remittance_id)",
  "CREATE INDEX IF NOT EXISTS idx_remittance_allocations_remittance_item_id ON remittance_allocations(remittance_item_id)",
  "CREATE INDEX IF NOT EXISTS idx_remittance_allocations_method ON remittance_allocations(method)",
  "CREATE INDEX IF NOT EXISTS idx_remittance_allocations_payment_id ON remittance_allocations(payment_id)",
  "CREATE INDEX IF NOT EXISTS idx_remittance_allocations_payment_batch_id ON remittance_allocations(payment_batch_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_payment_split ON remittance_allocations(payment_split_id) WHERE payment_split_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_batch_split_no_check ON remittance_allocations(payment_batch_split_id) WHERE payment_batch_split_id IS NOT NULL AND received_check_id IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_received_check ON remittance_allocations(received_check_id) WHERE received_check_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_cash_entry ON remittance_allocations(cash_entry_id) WHERE cash_entry_id IS NOT NULL",
];

const EXPECTED_COLUMNS = [
  "id", "remittance_id", "remittance_item_id", "payment_id", "payment_split_id",
  "payment_batch_id", "payment_batch_split_id", "received_check_id", "cash_entry_id",
  "method", "amount_cents", "created_at",
];

interface ExpectedForeignKey { column: string; table: string; toColumn: string }

const EXPECTED_FOREIGN_KEYS: ExpectedForeignKey[] = [
  { column: "remittance_id", table: "remittances", toColumn: "id" },
  { column: "remittance_item_id", table: "remittance_items", toColumn: "id" },
  { column: "payment_id", table: "payments", toColumn: "id" },
  { column: "payment_split_id", table: "payment_splits", toColumn: "id" },
  { column: "payment_batch_id", table: "payment_batches", toColumn: "id" },
  { column: "payment_batch_split_id", table: "payment_batch_splits", toColumn: "id" },
  { column: "received_check_id", table: "received_checks", toColumn: "id" },
  { column: "cash_entry_id", table: "cash_entries", toColumn: "id" },
];

interface ExpectedIndex { name: string; unique: boolean; partial: boolean; columns: string[] }

const EXPECTED_INDEXES: ExpectedIndex[] = [
  { name: "idx_remittance_allocations_remittance_id", unique: false, partial: false, columns: ["remittance_id"] },
  { name: "idx_remittance_allocations_remittance_item_id", unique: false, partial: false, columns: ["remittance_item_id"] },
  { name: "idx_remittance_allocations_method", unique: false, partial: false, columns: ["method"] },
  { name: "idx_remittance_allocations_payment_id", unique: false, partial: false, columns: ["payment_id"] },
  { name: "idx_remittance_allocations_payment_batch_id", unique: false, partial: false, columns: ["payment_batch_id"] },
  { name: "ux_remittance_allocations_payment_split", unique: true, partial: true, columns: ["payment_split_id"] },
  { name: "ux_remittance_allocations_batch_split_no_check", unique: true, partial: true, columns: ["payment_batch_split_id"] },
  { name: "ux_remittance_allocations_received_check", unique: true, partial: true, columns: ["received_check_id"] },
  { name: "ux_remittance_allocations_cash_entry", unique: true, partial: true, columns: ["cash_entry_id"] },
];

// Fragmentos (ya en minúscula, con espacios colapsados) que deben aparecer en
// la cláusula WHERE real del índice, tal cual quedó grabada en
// sqlite_master.sql — no solo que el índice "exista con ese nombre".
const EXPECTED_PARTIAL_WHERE: Record<string, string[]> = {
  ux_remittance_allocations_payment_split: ["payment_split_id is not null"],
  ux_remittance_allocations_batch_split_no_check: ["payment_batch_split_id is not null", "received_check_id is null"],
  ux_remittance_allocations_received_check: ["received_check_id is not null"],
  ux_remittance_allocations_cash_entry: ["cash_entry_id is not null"],
};

async function tableExists(db: Sql0024Client, name: string): Promise<boolean> {
  const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return r.rows.length > 0;
}

async function countRows(db: Sql0024Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

/** PRAGMA foreign_key_list(remittance_allocations) — valida columna origen, tabla y columna destino reales, no solo que "alguna FK" exista. */
async function validateForeignKeys(db: Sql0024Client): Promise<void> {
  const r = await db.execute("PRAGMA foreign_key_list(remittance_allocations)");
  const rows = r.rows as any[];
  const problems: string[] = [];

  for (const expected of EXPECTED_FOREIGN_KEYS) {
    const match = rows.find((row) => row.from === expected.column);
    if (!match) {
      problems.push(`falta la foreign key de ${expected.column} -> ${expected.table}(${expected.toColumn})`);
      continue;
    }
    if (match.table !== expected.table || match.to !== expected.toColumn) {
      problems.push(
        `la foreign key de ${expected.column} apunta a ${match.table}(${match.to}), se esperaba ${expected.table}(${expected.toColumn})`
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`remittance_allocations tiene foreign keys inválidas o faltantes: ${problems.join("; ")}.`);
  }
}

/** Lee el SQL real de creación de la tabla desde sqlite_master — es la única forma de inspeccionar CHECKs en SQLite (no hay PRAGMA para eso). */
async function getTableCreateSql(db: Sql0024Client): Promise<string> {
  const r = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='remittance_allocations'");
  if (r.rows.length === 0) {
    throw new Error("remittance_allocations no existe — no se puede validar su SQL de creación.");
  }
  return normalizeSql(String(r.rows[0].sql ?? ""));
}

/**
 * Valida los 4 CHECK constraints reales sobre el texto de creación de la
 * tabla (no alcanza con que la tabla "tenga columnas con esos nombres" — un
 * CHECK ausente o incompleto no se detecta por PRAGMA table_info).
 */
async function validateChecks(db: Sql0024Client): Promise<void> {
  const normalized = await getTableCreateSql(db);
  const problems: string[] = [];

  const methodMatch = normalized.match(/method\s+text\s+not\s+null\s+check\s*\(\s*method\s+in\s*\(([^)]*)\)\s*\)/);
  if (!methodMatch) {
    problems.push("falta el CHECK de method (o no tiene la forma 'method TEXT NOT NULL CHECK (method IN (...))')");
  } else {
    const values = methodMatch[1]!.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
    const expectedMethods = ["efectivo", "transferencia", "cheque", "link_pago", "transferencia_compania"];
    const missing = expectedMethods.filter((v) => !values.includes(v));
    const extra = values.filter((v) => !expectedMethods.includes(v));
    if (missing.length > 0 || extra.length > 0) {
      problems.push(
        `el CHECK de method no contiene exactamente los 5 métodos esperados ` +
        `(faltan: ${missing.join(", ") || "ninguno"}; de más: ${extra.join(", ") || "ninguno"})`
      );
    }
  }

  if (!/amount_cents\s+integer\s+not\s+null\s+check\s*\(\s*amount_cents\s*>\s*0\s*\)/.test(normalized)) {
    problems.push("falta el CHECK amount_cents > 0");
  }

  if (
    !/check\s*\(\s*\(payment_split_id\s+is\s+not\s+null\)\s*\+\s*\(payment_batch_split_id\s+is\s+not\s+null\)\s*\+\s*\(cash_entry_id\s+is\s+not\s+null\)\s*=\s*1\s*\)/.test(
      normalized
    )
  ) {
    problems.push("falta el CHECK de 'exactamente un leaf' (payment_split_id / payment_batch_split_id / cash_entry_id = 1)");
  }

  if (!/check\s*\(\s*received_check_id\s+is\s+null\s+or\s+payment_batch_split_id\s+is\s+not\s+null\s*\)/.test(normalized)) {
    problems.push("falta el CHECK que exige payment_batch_split_id cuando hay received_check_id");
  }

  if (problems.length > 0) {
    throw new Error(`remittance_allocations tiene CHECKs inválidos o faltantes: ${problems.join("; ")}.`);
  }
}

/**
 * Valida los 5 índices simples y los 4 unique parciales: presencia,
 * unicidad, columna indexada real (PRAGMA index_info) y — para los
 * parciales — que la cláusula WHERE real (leída de sqlite_master.sql, PRAGMA
 * no la expone) contenga las condiciones esperadas. Un índice con el nombre
 * correcto pero WHERE distinto (o sin WHERE) se rechaza.
 */
async function validateIndexes(db: Sql0024Client): Promise<void> {
  const r = await db.execute("PRAGMA index_list(remittance_allocations)");
  const rows = r.rows as any[];
  const byName = new Map(rows.map((row) => [row.name, row]));
  const problems: string[] = [];

  for (const expected of EXPECTED_INDEXES) {
    const found = byName.get(expected.name);
    if (!found) {
      problems.push(`falta el índice ${expected.name}`);
      continue;
    }

    const isUnique = Number(found.unique) === 1;
    if (isUnique !== expected.unique) {
      problems.push(`el índice ${expected.name} tiene unique=${isUnique}, se esperaba ${expected.unique}`);
    }

    const isPartial = Number(found.partial) === 1;
    if (isPartial !== expected.partial) {
      problems.push(`el índice ${expected.name} tiene partial=${isPartial}, se esperaba ${expected.partial}`);
    }

    const infoR = await db.execute(`PRAGMA index_info(${expected.name})`);
    const cols = (infoR.rows as any[]).map((c) => c.name);
    const sameColumns = cols.length === expected.columns.length && expected.columns.every((c, i) => cols[i] === c);
    if (!sameColumns) {
      problems.push(`el índice ${expected.name} indexa columnas [${cols.join(", ")}], se esperaba [${expected.columns.join(", ")}]`);
    }

    if (expected.partial) {
      const sqlR = await db.execute("SELECT sql FROM sqlite_master WHERE type='index' AND name=?", [expected.name]);
      const idxSql = normalizeSql(String(sqlR.rows[0]?.sql ?? ""));
      const whereMatch = idxSql.match(/where\s+(.*)$/);
      if (!whereMatch) {
        problems.push(`el índice ${expected.name} no tiene cláusula WHERE (debería ser parcial)`);
      } else {
        const requiredFragments = EXPECTED_PARTIAL_WHERE[expected.name] ?? [];
        const missingFragments = requiredFragments.filter((fragment) => !whereMatch[1]!.includes(fragment));
        if (missingFragments.length > 0) {
          problems.push(
            `el índice ${expected.name} tiene una condición WHERE distinta a la esperada ` +
            `("${whereMatch[1]}" no contiene: ${missingFragments.join(", ")})`
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`remittance_allocations tiene índices inválidos o faltantes: ${problems.join("; ")}.`);
  }
}

async function runMigration(db: Sql0024Client): Promise<Migration0024Summary> {
  const batchesExist = await tableExists(db, "payment_batches");
  if (!batchesExist) {
    throw new Error("payment_batches no existe todavía — aplicá primero la migración 0021.");
  }
  const splitsExist = await tableExists(db, "payment_batch_splits");
  if (!splitsExist) {
    throw new Error("payment_batch_splits no existe todavía — aplicá primero la migración 0022.");
  }
  const checksExist = await tableExists(db, "received_checks");
  if (!checksExist) {
    throw new Error("received_checks no existe todavía — aplicá primero la migración 0023.");
  }

  const tableAlreadyExisted = await tableExists(db, "remittance_allocations");
  const allocationsCountBefore = tableAlreadyExisted ? await countRows(db, "remittance_allocations") : 0;

  // CREATE TABLE IF NOT EXISTS es un no-op si la tabla ya existe con
  // cualquier definición — por eso la validación real de columnas/FKs/CHECKs/
  // índices de más abajo corre SIEMPRE después, sin importar si la tabla era
  // nueva o preexistente. Si preexistía con un esquema incorrecto, esta
  // migración debe rechazarla explícitamente, no darla por buena.
  await db.execute(CREATE_TABLE_SQL);

  const cols = await db.execute("PRAGMA table_info(remittance_allocations)");
  const colNames = new Set(cols.rows.map((r: any) => r.name));
  const missingColumns = EXPECTED_COLUMNS.filter((c) => !colNames.has(c));
  if (missingColumns.length > 0) {
    throw new Error(
      `remittance_allocations existe pero le faltan columnas esperadas: ${missingColumns.join(", ")}. ` +
      `Abortando — no se puede confiar en el esquema actual de la tabla.`
    );
  }

  await validateForeignKeys(db);
  await validateChecks(db);

  for (const sql of CREATE_INDEXES_SQL) {
    await db.execute(sql);
  }

  await validateIndexes(db);

  const allocationsCountAfter = await countRows(db, "remittance_allocations");
  if (allocationsCountAfter !== allocationsCountBefore) {
    throw new Error("Integridad violada: remittance_allocations cambió de cantidad de filas en una migración sin backfill.");
  }

  return { tableAlreadyExisted, allocationsCountBefore, allocationsCountAfter };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * BEGIN/COMMIT/ROLLBACK como texto (mismo patrón que 0021-0023 — este
 * aplicador es local, sobre bun:sqlite, no un cliente libsql de producción).
 * A diferencia de esas migraciones, acá el manejo de errores distingue
 * explícitamente los 4 desenlaces posibles: cuerpo falla + rollback ok
 * (se propaga el error original); cuerpo falla + rollback también falla
 * (estado incierto, se informan ambos errores); COMMIT falla + rollback
 * subsiguiente ok (se informa que no se aplicó nada); COMMIT falla + rollback
 * también falla (estado incierto). Nunca se devuelve `summary` (es decir,
 * nunca se afirma éxito) salvo que el COMMIT haya resuelto realmente.
 */
export async function applyMigration0024RemittanceAllocations(db: Sql0024Client): Promise<Migration0024Summary> {
  await db.execute("BEGIN");
  let summary: Migration0024Summary;
  try {
    summary = await runMigration(db);
  } catch (bodyError) {
    try {
      await db.execute("ROLLBACK");
    } catch (rollbackError) {
      throw new Migration0024UncertainStateError(
        `Error original: ${errMsg(bodyError)}. ADEMÁS falló el ROLLBACK: ${errMsg(rollbackError)}. ` +
        `Estado incierto — no se puede afirmar si la conexión quedó con una transacción abierta.`,
        bodyError,
        rollbackError
      );
    }
    throw bodyError;
  }

  try {
    await db.execute("COMMIT");
  } catch (commitError) {
    try {
      await db.execute("ROLLBACK");
    } catch (rollbackError) {
      throw new Migration0024UncertainStateError(
        `Falló el COMMIT: ${errMsg(commitError)}. ADEMÁS falló el ROLLBACK posterior: ${errMsg(rollbackError)}. ` +
        `Estado incierto — no se puede afirmar si los cambios quedaron aplicados.`,
        commitError,
        rollbackError
      );
    }
    throw new Error(
      `Falló el COMMIT (se hizo ROLLBACK exitosamente después — ningún cambio quedó aplicado): ${errMsg(commitError)}`
    );
  }

  return summary;
}
