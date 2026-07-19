/**
 * Lógica compartida de backup completo — usada por GET /api/backup (index.ts)
 * y por scripts/backup-prod-full.ts. Antes, GET /backup exportaba una lista
 * de 14 tablas hardcodeada que quedó desactualizada apenas se agregaron
 * payment_batches/received_checks/remittance_allocations/etc (etapas
 * 4A-4F) — acá las tablas se detectan dinámicamente desde sqlite_master
 * para que eso no vuelva a pasar.
 */
import { createHash } from "crypto";

/** Mismo contrato que expone @libsql/client (y database.$client de drizzle). */
export interface BackupClient {
  execute(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface TableBackup {
  schema: any[];
  createSql: string | null;
  indexes: string[];
  /** Columnas efectivamente exportadas (ya sin las excluidas, ej. users.password). */
  columns: string[];
  rowCount: number;
  checksum: string;
  rows: any[];
}

export interface ForeignKeyCheckResult {
  violations: number;
  details: any[];
}

export interface FullBackupPayload {
  version: number;
  exportedAt: string;
  environment: string;
  databaseMasked: string;
  gitCommit: string | null;
  tableCount: number;
  totalRows: number;
  foreignKeyCheck: ForeignKeyCheckResult;
  tables: Record<string, TableBackup>;
}

// Tablas de negocio que un backup completo actual debe tener — usado solo
// como lista de referencia para validar (no para decidir qué exportar, eso
// se detecta dinámicamente vía sqlite_master).
export const EXPECTED_BUSINESS_TABLES = [
  "users", "companies", "insureds", "policies", "payments", "payment_splits",
  "payment_batches", "payment_batch_splits", "received_checks", "deliveries",
  "claims", "policy_insured_persons", "policy_fleet_vehicles", "policy_installments",
  "rebillings", "task_templates", "tasks", "import_logs", "cash_entries", "cash_debts",
  "remittances", "remittance_items", "remittance_allocations", "cash_expenses",
  "commission_entries", "iva_entries", "own_money_movements",
] as const;

// sessions: tokens de auth efímeros, no dato de negocio recuperable — nunca
// entra a un backup. sqlite_% y *_new (residuos de un ALTER TABLE de 12 pasos
// interrumpido a mitad de camino) tampoco.
const ALWAYS_EXCLUDED_TABLES = new Set(["sessions"]);

// Columnas que se excluyen aunque la tabla sí entre al backup.
const EXCLUDED_COLUMNS: Record<string, ReadonlySet<string>> = {
  users: new Set(["password"]),
};

export function isBackupExcludedTable(tableName: string): boolean {
  if (tableName.startsWith("sqlite_")) return true;
  if (tableName.endsWith("_new")) return true;
  if (ALWAYS_EXCLUDED_TABLES.has(tableName)) return true;
  return false;
}

export async function listBackupTables(client: BackupClient): Promise<string[]> {
  const res = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  return (res.rows as any[])
    .map((r) => String(r.name))
    .filter((name) => !isBackupExcludedTable(name));
}

/** Nunca imprime el token ni la URL completa — mismo criterio que los scripts backup-prod-before-*.ts. */
export function maskDatabaseUrl(url: string): string {
  if (url.startsWith("file:")) return url; // ruta local, no es secreta
  const withoutScheme = url.replace(/^libsql:\/\//, "");
  const host = withoutScheme.split(/[/?]/)[0] ?? "";
  return `libsql://${host.slice(0, 8)}${"*".repeat(Math.max(host.length - 8, 3))}`;
}

export async function foreignKeyCheck(client: BackupClient): Promise<ForeignKeyCheckResult> {
  const res = await client.execute("PRAGMA foreign_key_check");
  return { violations: res.rows.length, details: res.rows };
}

export function computeTableChecksum(rows: any[], columns: string[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(columns.map((c) => String(row[c] ?? "␀")).join("|") + "\n");
  }
  return hash.digest("hex");
}

export async function dumpTable(client: BackupClient, name: string): Promise<TableBackup> {
  const schemaRes = await client.execute(`PRAGMA table_info(${name})`);
  const schema = schemaRes.rows as any[];
  const allColumns = schema.map((c) => String(c.name));
  const excluded = EXCLUDED_COLUMNS[name] ?? new Set<string>();
  const columns = allColumns.filter((c) => !excluded.has(c));

  const createSqlRes = await client.execute(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [name]
  );
  const createSql = (createSqlRes.rows[0] as any)?.sql ?? null;

  const indexRes = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?", [name]
  );
  const indexes = (indexRes.rows as any[]).map((r) => String(r.name));

  const dataRes = await client.execute(`SELECT * FROM ${name} ORDER BY id`);
  const rows = (dataRes.rows as any[]).map((row) => {
    if (excluded.size === 0) return { ...row };
    const copy: Record<string, unknown> = {};
    for (const col of columns) copy[col] = row[col];
    return copy;
  });

  const checksum = computeTableChecksum(rows, columns);

  return { schema, createSql, indexes, columns, rowCount: rows.length, checksum, rows };
}

/**
 * Busca el commit actual para incluir en la metadata. En Railway viene por
 * env var (RAILWAY_GIT_COMMIT_SHA); si no está (ej. corriendo el script
 * local), intenta `git rev-parse HEAD`. Si ninguno funciona, null — nunca
 * lanza ni bloquea el backup por esto.
 */
export function resolveGitCommit(): string | null {
  const fromEnv = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;
  if (fromEnv) return fromEnv;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require("child_process") as typeof import("child_process");
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

export interface BuildFullBackupOptions {
  environment: string;
  databaseUrl: string;
  /** Pasar explícitamente para no llamar a resolveGitCommit() (útil en tests). */
  gitCommit?: string | null;
}

export async function buildFullBackup(client: BackupClient, opts: BuildFullBackupOptions): Promise<FullBackupPayload> {
  const tableNames = await listBackupTables(client);
  const fkCheck = await foreignKeyCheck(client);

  const tables: Record<string, TableBackup> = {};
  let totalRows = 0;
  for (const name of tableNames) {
    const dump = await dumpTable(client, name);
    tables[name] = dump;
    totalRows += dump.rowCount;
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    environment: opts.environment,
    databaseMasked: maskDatabaseUrl(opts.databaseUrl),
    gitCommit: opts.gitCommit !== undefined ? opts.gitCommit : resolveGitCommit(),
    tableCount: tableNames.length,
    totalRows,
    foreignKeyCheck: fkCheck,
    tables,
  };
}

export interface BackupValidationResult {
  ok: boolean;
  errors: string[];
  /** Problemas reales de datos (ej. foreign_key_check) — se reportan pero NO bloquean el backup: negar un backup justo cuando la base tiene un problema es el peor momento para no tener un respaldo. */
  warnings: string[];
}

/**
 * Valida un payload ya generado (en memoria o releído de un archivo/JSON).
 * No vuelve a tocar la base — todo lo que chequea sale del propio payload,
 * incluido el checksum (se recalcula desde payload.tables[x].rows y se
 * compara contra payload.tables[x].checksum, así detecta si el archivo fue
 * alterado después de generarse).
 *
 * `errors` (bloqueante) es solo para fallas de la propia mecánica de export
 * (tabla excluida colada, tabla esperada ausente, checksum/rowCount no
 * reproducible) — nunca por el ESTADO de los datos de negocio. Un
 * foreign_key_check con violaciones es un dato real sobre la base, no un
 * defecto del backup en sí, así que va a `warnings` (mismo criterio que ya
 * usan los scripts backup-prod-before-*.ts: lo loguean, no abortan).
 */
export function validateFullBackup(payload: FullBackupPayload, expectedTables: readonly string[]): BackupValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tableNames = Object.keys(payload.tables);

  for (const name of tableNames) {
    if (isBackupExcludedTable(name)) errors.push(`tabla excluida presente en el backup: ${name}`);
  }
  for (const expected of expectedTables) {
    if (!tableNames.includes(expected)) errors.push(`falta tabla esperada: ${expected}`);
  }
  if (payload.foreignKeyCheck.violations > 0) {
    warnings.push(`foreign_key_check con ${payload.foreignKeyCheck.violations} violaciones (preexistentes en los datos — ver foreignKeyCheck.details)`);
  }

  let totalRows = 0;
  for (const [name, t] of Object.entries(payload.tables)) {
    if (t.rowCount !== t.rows.length) errors.push(`rowCount no coincide con rows.length en ${name}`);
    const recomputed = computeTableChecksum(t.rows, t.columns);
    if (recomputed !== t.checksum) errors.push(`checksum no reproducible en ${name}`);
    totalRows += t.rowCount;
  }
  if (totalRows !== payload.totalRows) {
    errors.push(`totalRows del payload (${payload.totalRows}) no coincide con la suma real (${totalRows})`);
  }
  if (payload.tableCount !== tableNames.length) {
    errors.push("tableCount no coincide con la cantidad real de tablas");
  }

  return { ok: errors.length === 0, errors, warnings };
}
