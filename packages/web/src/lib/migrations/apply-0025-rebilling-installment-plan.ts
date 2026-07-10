// Lógica reutilizable de la migración 0025 (refacturación genera su propio
// grupo de cuotas). Usada tanto por el script local
// (packages/web/scripts/apply_0025_local.ts, gitignorado como todo scripts/)
// como por los tests, contra cualquier cliente compatible con
// @libsql/client (Turso o un archivo SQLite local).
//
// Idempotente. Sin backfill: ninguna fila existente de rebillings cambia de
// valor — las 3 columnas nuevas quedan NULL en refacturaciones ya existentes
// (incluidas las históricas sin cuotas, que es justamente el bug que motiva
// esta migración — se completan recién vía PUT /rebillings/:id).

export interface Sql0025Client {
  execute(sql: string): Promise<{ rows: any[] }>;
}

export interface Migration0025Summary {
  columnsAdded: string[];
  alreadyApplied: boolean;
  rebillingsBefore: number;
  rebillingsAfter: number;
  populatedAfter: number; // filas con installment_count no nulo justo después de agregar columnas — debe ser 0
}

const NEW_COLUMNS: { name: string; ddl: string }[] = [
  { name: "installment_count", ddl: "ALTER TABLE rebillings ADD COLUMN installment_count INTEGER" },
  { name: "first_due_date", ddl: "ALTER TABLE rebillings ADD COLUMN first_due_date TEXT" },
  { name: "deductible", ddl: "ALTER TABLE rebillings ADD COLUMN deductible REAL" },
];

async function existingColumnNames(db: Sql0025Client): Promise<Set<string>> {
  const cols = await db.execute("PRAGMA table_info(rebillings)");
  return new Set(cols.rows.map((r: any) => r.name));
}

async function countRebillings(db: Sql0025Client): Promise<number> {
  const r = await db.execute("SELECT COUNT(*) as c FROM rebillings");
  return Number(r.rows[0].c);
}

async function countPopulated(db: Sql0025Client): Promise<number> {
  const r = await db.execute("SELECT COUNT(*) as c FROM rebillings WHERE installment_count IS NOT NULL");
  return Number(r.rows[0].c);
}

export async function applyMigration0025RebillingInstallmentPlan(db: Sql0025Client): Promise<Migration0025Summary> {
  const rebillingsBefore = await countRebillings(db);
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

  const after = await existingColumnNames(db);
  const missing = NEW_COLUMNS.filter((c) => !after.has(c.name));
  if (missing.length > 0) {
    throw new Error(`Faltan columnas tras la migración: ${missing.map((c) => c.name).join(", ")}.`);
  }

  const rebillingsAfter = await countRebillings(db);
  if (rebillingsAfter !== rebillingsBefore) {
    throw new Error("la cantidad de filas en rebillings cambió durante la migración.");
  }

  const populatedAfter = await countPopulated(db);
  if (columnsAdded.length > 0 && populatedAfter !== 0) {
    throw new Error("hay refacturaciones con installment_count ya asignado inmediatamente después de agregar las columnas.");
  }

  return { columnsAdded, alreadyApplied, rebillingsBefore, rebillingsAfter, populatedAfter };
}
