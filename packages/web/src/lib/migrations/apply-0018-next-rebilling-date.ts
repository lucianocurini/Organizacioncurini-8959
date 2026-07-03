// Lógica reutilizable de la migración 0018 (policies.next_rebilling_date).
// Usada tanto por el script productivo (packages/web/scripts/apply-0018-prod.ts,
// gitignorado como todo scripts/) como por los tests, contra cualquier cliente
// compatible con @libsql/client (Turso o un archivo SQLite local).
//
// Idempotente. No hace backfill. No modifica filas existentes — queda NULL.

export interface Sql0018Client {
  execute(sql: string): Promise<{ rows: any[] }>;
}

export interface Migration0018Summary {
  columnAdded: boolean;
  alreadyApplied: boolean;
  policiesBefore: number;
  policiesAfter: number;
  populatedAfter: number; // filas con next_rebilling_date no nulo (debe ser 0 justo después de agregar la columna)
  columnType: string | null;
  columnNullable: boolean;
}

async function columnInfo(db: Sql0018Client): Promise<{ type: string; notNull: boolean } | null> {
  const cols = await db.execute("PRAGMA table_info(policies)");
  const col = cols.rows.find((r: any) => r.name === "next_rebilling_date");
  if (!col) return null;
  return { type: String(col.type ?? ""), notNull: Number(col.notnull) === 1 };
}

async function countPolicies(db: Sql0018Client): Promise<number> {
  const r = await db.execute("SELECT COUNT(*) as c FROM policies");
  return Number(r.rows[0].c);
}

async function countPopulated(db: Sql0018Client): Promise<number> {
  const r = await db.execute("SELECT COUNT(*) as c FROM policies WHERE next_rebilling_date IS NOT NULL");
  return Number(r.rows[0].c);
}

export async function applyMigration0018(db: Sql0018Client): Promise<Migration0018Summary> {
  const policiesBefore = await countPolicies(db);
  const colBefore = await columnInfo(db);
  const alreadyApplied = !!colBefore;

  let columnAdded = false;
  if (!alreadyApplied) {
    await db.execute("ALTER TABLE policies ADD COLUMN next_rebilling_date TEXT");
    columnAdded = true;
  }

  const colAfter = await columnInfo(db);
  const policiesAfter = await countPolicies(db);
  const populatedAfter = await countPopulated(db);

  if (!colAfter) throw new Error("next_rebilling_date no aparece en PRAGMA table_info tras la migración.");
  if (policiesAfter !== policiesBefore) {
    throw new Error("la cantidad de filas en policies cambió durante la migración.");
  }
  if (columnAdded && populatedAfter !== 0) {
    throw new Error("hay pólizas con next_rebilling_date ya asignado inmediatamente después de agregar la columna.");
  }

  return {
    columnAdded, alreadyApplied,
    policiesBefore, policiesAfter, populatedAfter,
    columnType: colAfter.type, columnNullable: !colAfter.notNull,
  };
}
