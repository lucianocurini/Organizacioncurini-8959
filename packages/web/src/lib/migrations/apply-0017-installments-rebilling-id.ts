// Lógica reutilizable de la migración 0017 (policy_installments.rebilling_id).
// Usada tanto por el script productivo (packages/web/scripts/apply-0017-prod.ts,
// gitignorado como todo scripts/) como por los tests, contra cualquier cliente
// compatible con @libsql/client (Turso o un archivo SQLite local).
//
// Idempotente. No hace backfill. No modifica filas existentes.

export interface Sql0017Client {
  execute(sql: string): Promise<{ rows: any[] }>;
}

export interface Migration0017Summary {
  columnAdded: boolean;
  indexCreated: boolean;
  alreadyApplied: boolean;
  installmentsBefore: number;
  installmentsAfter: number;
  linkedInstallments: number;
  columnType: string | null;
  columnNullable: boolean;
}

async function columnInfo(db: Sql0017Client): Promise<{ type: string; notNull: boolean } | null> {
  const cols = await db.execute("PRAGMA table_info(policy_installments)");
  const col = cols.rows.find((r: any) => r.name === "rebilling_id");
  if (!col) return null;
  return { type: String(col.type ?? ""), notNull: Number(col.notnull) === 1 };
}

async function indexExists(db: Sql0017Client): Promise<boolean> {
  const idx = await db.execute("PRAGMA index_list(policy_installments)");
  return idx.rows.some((r: any) => r.name === "idx_policy_installments_rebilling_id");
}

async function countInstallments(db: Sql0017Client): Promise<number> {
  const r = await db.execute("SELECT COUNT(*) as c FROM policy_installments");
  return Number(r.rows[0].c);
}

async function countLinked(db: Sql0017Client): Promise<number> {
  const r = await db.execute("SELECT COUNT(*) as c FROM policy_installments WHERE rebilling_id IS NOT NULL");
  return Number(r.rows[0].c);
}

export async function applyMigration0017(db: Sql0017Client): Promise<Migration0017Summary> {
  const installmentsBefore = await countInstallments(db);

  const colBefore = await columnInfo(db);
  const idxBefore = await indexExists(db);

  let columnAdded = false;
  let indexCreated = false;
  const alreadyApplied = !!colBefore && idxBefore;

  if (!alreadyApplied) {
    if (!colBefore) {
      await db.execute("ALTER TABLE policy_installments ADD COLUMN rebilling_id INTEGER REFERENCES rebillings(id)");
      columnAdded = true;
    }
    // Si la columna recién se creó, el índice seguro no existe todavía (falta chequearlo de nuevo).
    const idxNow = columnAdded ? false : idxBefore;
    if (!idxNow) {
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_policy_installments_rebilling_id ON policy_installments(rebilling_id)"
      );
      indexCreated = true;
    }
  }

  const colAfter = await columnInfo(db);
  const idxAfter = await indexExists(db);
  const installmentsAfter = await countInstallments(db);
  const linkedInstallments = await countLinked(db);

  if (!colAfter) throw new Error("rebilling_id no aparece en PRAGMA table_info tras la migración.");
  if (!idxAfter) throw new Error("el índice no aparece en PRAGMA index_list tras la migración.");
  if (installmentsAfter !== installmentsBefore) {
    throw new Error("la cantidad de filas en policy_installments cambió durante la migración.");
  }
  if (linkedInstallments !== 0) {
    throw new Error("hay cuotas con rebilling_id ya asignado inmediatamente después de agregar la columna.");
  }

  return {
    columnAdded, indexCreated, alreadyApplied,
    installmentsBefore, installmentsAfter, linkedInstallments,
    columnType: colAfter.type, columnNullable: !colAfter.notNull,
  };
}
