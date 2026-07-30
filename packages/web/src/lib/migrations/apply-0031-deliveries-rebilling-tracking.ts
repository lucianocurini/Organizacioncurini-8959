// Lógica reutilizable de la migración 0031 (deliveries.rebilling_id +
// deliveries.sent_date — integración formal de Envíos y Entregas con
// Pólizas/Refacturaciones, Paso A). Usada tanto por el script local/productivo
// como por los tests, contra cualquier cliente compatible con @libsql/client
// (Turso o un archivo SQLite local) — mismo criterio que el resto de los
// aplicadores de este proyecto desde 0017 en adelante.
//
// Puramente aditiva: 2 columnas nullable + 2 índices, ninguna tabla se
// recrea, sin backfill (todo lo histórico queda NULL). Idempotente.

export interface Sql0031Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0031Summary {
  rebillingIdColumnAdded: boolean;
  sentDateColumnAdded: boolean;
  rebillingIdIndexCreated: boolean;
  policyIdIndexCreated: boolean;
  alreadyApplied: boolean;
  deliveriesBefore: number;
  deliveriesAfter: number;
  rebillingIdPopulatedAfter: number; // debe ser 0 justo después de agregar la columna
  sentDatePopulatedAfter: number; // ídem
}

async function columnExists(db: Sql0031Client, table: string, column: string): Promise<boolean> {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  return cols.rows.some((r: any) => r.name === column);
}

async function indexExists(db: Sql0031Client, table: string, indexName: string): Promise<boolean> {
  const idx = await db.execute(`PRAGMA index_list(${table})`);
  return idx.rows.some((r: any) => r.name === indexName);
}

async function countRows(db: Sql0031Client, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(r.rows[0].c);
}

async function countPopulated(db: Sql0031Client, column: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) as c FROM deliveries WHERE ${column} IS NOT NULL`);
  return Number(r.rows[0].c);
}

/**
 * Trabajo puro de la migración 0031 — SOLO statements de lectura/escritura
 * (ALTER/CREATE INDEX IF NOT EXISTS/SELECT/PRAGMA), SIN emitir
 * BEGIN/COMMIT/ROLLBACK ni tocar PRAGMA foreign_keys. Mismo criterio que
 * applyMigration0030InsuredAccountMovementsWork (ver comentario completo de
 * diseño ahí): quien llama decide cómo envolver la atomicidad según el
 * entorno — bun:sqlite local (dev.db/tests) le agrega BEGIN/COMMIT sueltos
 * (más abajo); un futuro script contra Turso producción debe envolver esta
 * misma función con client.transaction("write"), nunca con execute()
 * sueltos (@libsql/client sobre HTTP no mantiene sesión entre llamadas).
 */
export async function applyMigration0031DeliveriesRebillingTrackingWork(db: Sql0031Client): Promise<Migration0031Summary> {
  const deliveriesBefore = await countRows(db, "deliveries");

  // ─── rebilling_id ───────────────────────────────────────────────────────
  const rebillingIdExisted = await columnExists(db, "deliveries", "rebilling_id");
  let rebillingIdColumnAdded = false;
  if (!rebillingIdExisted) {
    await db.execute("ALTER TABLE deliveries ADD COLUMN rebilling_id INTEGER REFERENCES rebillings(id)");
    rebillingIdColumnAdded = true;
  }

  // ─── sent_date ──────────────────────────────────────────────────────────
  const sentDateExisted = await columnExists(db, "deliveries", "sent_date");
  let sentDateColumnAdded = false;
  if (!sentDateExisted) {
    await db.execute("ALTER TABLE deliveries ADD COLUMN sent_date TEXT");
    sentDateColumnAdded = true;
  }

  // ─── índices ────────────────────────────────────────────────────────────
  const policyIdIndexExisted = await indexExists(db, "deliveries", "idx_deliveries_policy_id");
  if (!policyIdIndexExisted) {
    await db.execute("CREATE INDEX IF NOT EXISTS idx_deliveries_policy_id ON deliveries(policy_id)");
  }
  const rebillingIdIndexExisted = await indexExists(db, "deliveries", "idx_deliveries_rebilling_id");
  if (!rebillingIdIndexExisted) {
    await db.execute("CREATE INDEX IF NOT EXISTS idx_deliveries_rebilling_id ON deliveries(rebilling_id)");
  }

  const deliveriesAfter = await countRows(db, "deliveries");
  const rebillingIdPopulatedAfter = await countPopulated(db, "rebilling_id");
  const sentDatePopulatedAfter = await countPopulated(db, "sent_date");

  if (deliveriesAfter !== deliveriesBefore) {
    throw new Error("Integridad violada: la cantidad de filas en deliveries cambió durante una migración sin backfill de filas.");
  }
  if (rebillingIdColumnAdded && rebillingIdPopulatedAfter !== 0) {
    throw new Error("Integridad violada: hay deliveries con rebilling_id ya asignado inmediatamente después de agregar la columna.");
  }
  if (sentDateColumnAdded && sentDatePopulatedAfter !== 0) {
    throw new Error("Integridad violada: hay deliveries con sent_date ya asignado inmediatamente después de agregar la columna.");
  }

  return {
    rebillingIdColumnAdded,
    sentDateColumnAdded,
    rebillingIdIndexCreated: !rebillingIdIndexExisted,
    policyIdIndexCreated: !policyIdIndexExisted,
    alreadyApplied: rebillingIdExisted && sentDateExisted && policyIdIndexExisted && rebillingIdIndexExisted,
    deliveriesBefore,
    deliveriesAfter,
    rebillingIdPopulatedAfter,
    sentDatePopulatedAfter,
  };
}

/**
 * Uso local/tests (dev.db, bun:sqlite): agrega BEGIN/COMMIT/ROLLBACK
 * alrededor del trabajo puro de arriba — válido acá porque una única
 * conexión bun:sqlite sí mantiene sesión real entre execute() sueltos. NUNCA
 * reutilizar este wrapper contra Turso — ver el comentario de
 * applyMigration0031DeliveriesRebillingTrackingWork.
 */
export async function applyMigration0031DeliveriesRebillingTracking(db: Sql0031Client): Promise<Migration0031Summary> {
  await db.execute("BEGIN");
  let summary: Migration0031Summary;
  try {
    summary = await applyMigration0031DeliveriesRebillingTrackingWork(db);
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
  await db.execute("COMMIT");
  return summary;
}
