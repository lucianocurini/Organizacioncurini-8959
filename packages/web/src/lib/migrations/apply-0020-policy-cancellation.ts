// Lógica reutilizable de la migración 0020 (anulación manual de pólizas).
// Usada tanto por el script local (packages/web/scripts/apply_0020_local.ts,
// gitignorado como todo scripts/) como por los tests, contra cualquier
// cliente compatible con @libsql/client (Turso o un archivo SQLite local).
//
// Idempotente. Sin backfill: ninguna fila existente cambia de valor — las 6
// columnas nuevas quedan NULL en pólizas ya existentes (activas, vencidas, o
// ya canceladas por un importador antes de esta migración).

export interface Sql0020Client {
  execute(sql: string): Promise<{ rows: any[] }>;
}

export interface Migration0020Summary {
  columnsAdded: string[];
  alreadyApplied: boolean;
  policiesBefore: number;
  policiesAfter: number;
  populatedAfter: number; // filas con cancelled_at no nulo justo después de agregar columnas — debe ser 0
}

const NEW_COLUMNS: { name: string; ddl: string }[] = [
  { name: "cancelled_at", ddl: "ALTER TABLE policies ADD COLUMN cancelled_at INTEGER" },
  { name: "cancellation_effective_date", ddl: "ALTER TABLE policies ADD COLUMN cancellation_effective_date TEXT" },
  { name: "cancellation_reason", ddl: "ALTER TABLE policies ADD COLUMN cancellation_reason TEXT" },
  { name: "cancellation_notes", ddl: "ALTER TABLE policies ADD COLUMN cancellation_notes TEXT" },
  { name: "cancelled_by", ddl: "ALTER TABLE policies ADD COLUMN cancelled_by INTEGER REFERENCES users(id)" },
  { name: "cancellation_source", ddl: "ALTER TABLE policies ADD COLUMN cancellation_source TEXT" },
];

const INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_policies_cancellation_effective_date ON policies(cancellation_effective_date)",
  "CREATE INDEX IF NOT EXISTS idx_policies_cancelled_by ON policies(cancelled_by)",
];

async function existingColumnNames(db: Sql0020Client): Promise<Set<string>> {
  const cols = await db.execute("PRAGMA table_info(policies)");
  return new Set(cols.rows.map((r: any) => r.name));
}

async function countPolicies(db: Sql0020Client): Promise<number> {
  const r = await db.execute("SELECT COUNT(*) as c FROM policies");
  return Number(r.rows[0].c);
}

async function countPopulated(db: Sql0020Client): Promise<number> {
  const r = await db.execute("SELECT COUNT(*) as c FROM policies WHERE cancelled_at IS NOT NULL");
  return Number(r.rows[0].c);
}

export async function applyMigration0020PolicyCancellation(db: Sql0020Client): Promise<Migration0020Summary> {
  const policiesBefore = await countPolicies(db);
  const before = await existingColumnNames(db);
  const alreadyApplied = NEW_COLUMNS.every((c) => before.has(c.name));

  const columnsAdded: string[] = [];
  if (!alreadyApplied) {
    for (const col of NEW_COLUMNS) {
      if (!before.has(col.name)) {
        await db.execute(col.ddl);
        columnsAdded.push(col.name);
      }
    }
  }

  for (const sql of INDEXES_SQL) {
    await db.execute(sql);
  }

  const after = await existingColumnNames(db);
  const missing = NEW_COLUMNS.filter((c) => !after.has(c.name));
  if (missing.length > 0) {
    throw new Error(`Faltan columnas tras la migración: ${missing.map((c) => c.name).join(", ")}.`);
  }

  const policiesAfter = await countPolicies(db);
  if (policiesAfter !== policiesBefore) {
    throw new Error("la cantidad de filas en policies cambió durante la migración.");
  }

  const populatedAfter = await countPopulated(db);
  if (columnsAdded.length > 0 && populatedAfter !== 0) {
    throw new Error("hay pólizas con cancelled_at ya asignado inmediatamente después de agregar las columnas.");
  }

  return { columnsAdded, alreadyApplied, policiesBefore, policiesAfter, populatedAfter };
}
