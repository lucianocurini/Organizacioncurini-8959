/**
 * Tests del helper compartido de backup completo (packages/web/src/api/backup/full-backup.ts),
 * usado tanto por GET /api/backup (ver backup-endpoint.test.ts) como por
 * scripts/backup-prod-full.ts. Arma una base sqlite temporal a mano (bun:sqlite,
 * en el scratchpad del sistema, se borra al finalizar) — no toca dev.db ni Turso,
 * y no depende de tener las 27 tablas reales de negocio para poder testear la
 * lógica de exclusión/checksum/validación en aislamiento.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listBackupTables, isBackupExcludedTable, dumpTable, buildFullBackup,
  validateFullBackup, computeTableChecksum, maskDatabaseUrl, type BackupClient,
} from "../backup/full-backup";

function wrapBunSqlite(db: Database): BackupClient {
  return {
    async execute(sql: string, params: any[] = []) {
      const stmt = db.prepare(sql);
      try {
        const upper = sql.trim().toUpperCase();
        if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
          return { rows: stmt.all(...params) as any[] };
        }
        stmt.run(...params);
        return { rows: [] };
      } finally {
        stmt.finalize();
      }
    },
  };
}

function makeTempDb(): { db: Database; dir: string; client: BackupClient } {
  const dir = mkdtempSync(join(tmpdir(), "full-backup-test-"));
  const db = new Database(join(dir, "test.db"));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, password TEXT NOT NULL);
    CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL, value INTEGER NOT NULL);
    CREATE INDEX widgets_label_idx ON widgets(label);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));
    -- residuo de un ALTER TABLE de 12 pasos interrumpido a mitad de camino
    CREATE TABLE widgets_new (id INTEGER PRIMARY KEY, label TEXT);
  `);
  db.exec(`INSERT INTO users (id, name, email, password) VALUES (1, 'Ana', 'ana@test.local', 'super-secret-hash')`);
  db.exec(`INSERT INTO widgets (id, label, value) VALUES (1, 'a', 10), (2, 'b', 20)`);
  db.exec(`INSERT INTO sessions (id, user_id) VALUES ('sess-1', 1)`);
  db.exec(`INSERT INTO widgets_new (id, label) VALUES (1, 'residuo')`);
  return { db, dir, client: wrapBunSqlite(db) };
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows EBUSY ocasional, no crítico en test */ }
  }
});

describe("isBackupExcludedTable", () => {
  test("excluye sessions", () => {
    expect(isBackupExcludedTable("sessions")).toBe(true);
  });
  test("excluye tablas sqlite_%", () => {
    expect(isBackupExcludedTable("sqlite_sequence")).toBe(true);
    expect(isBackupExcludedTable("sqlite_master")).toBe(true);
  });
  test("excluye tablas *_new (residuo de ALTER TABLE interrumpido)", () => {
    expect(isBackupExcludedTable("widgets_new")).toBe(true);
    expect(isBackupExcludedTable("received_checks_new")).toBe(true);
  });
  test("incluye tablas de negocio normales", () => {
    expect(isBackupExcludedTable("widgets")).toBe(false);
    expect(isBackupExcludedTable("payment_batches")).toBe(false);
  });
});

describe("listBackupTables", () => {
  test("detecta tablas dinámicamente desde sqlite_master y excluye sessions/sqlite_%/*_new", async () => {
    const { client, dir } = makeTempDb();
    cleanupDirs.push(dir);
    const tables = await listBackupTables(client);
    expect(tables).toContain("users");
    expect(tables).toContain("widgets");
    expect(tables).not.toContain("sessions");
    expect(tables).not.toContain("widgets_new");
    expect(tables.some((t) => t.startsWith("sqlite_"))).toBe(false);
  });
});

describe("dumpTable", () => {
  test("users: excluye la columna password de rows y de la lista de columnas exportadas", async () => {
    const { client, dir } = makeTempDb();
    cleanupDirs.push(dir);
    const dump = await dumpTable(client, "users");
    expect(dump.rowCount).toBe(1);
    expect(dump.columns).not.toContain("password");
    expect(dump.rows[0]).not.toHaveProperty("password");
    expect(dump.rows[0].email).toBe("ana@test.local");
  });

  test("widgets: incluye schema, createSql, índices y todas las filas", async () => {
    const { client, dir } = makeTempDb();
    cleanupDirs.push(dir);
    const dump = await dumpTable(client, "widgets");
    expect(dump.rowCount).toBe(2);
    expect(dump.rows.map((r: any) => r.label).sort()).toEqual(["a", "b"]);
    expect(dump.indexes).toContain("widgets_label_idx");
    expect(dump.createSql).toContain("CREATE TABLE widgets");
    expect(dump.schema.map((c: any) => c.name)).toEqual(["id", "label", "value"]);
  });
});

describe("computeTableChecksum — determinismo", () => {
  test("mismo input produce el mismo checksum", () => {
    const rows = [{ id: 1, label: "a" }, { id: 2, label: "b" }];
    const c1 = computeTableChecksum(rows, ["id", "label"]);
    const c2 = computeTableChecksum(rows, ["id", "label"]);
    expect(c1).toBe(c2);
  });
  test("cambiar un valor cambia el checksum", () => {
    const base = computeTableChecksum([{ id: 1, label: "a" }], ["id", "label"]);
    const changed = computeTableChecksum([{ id: 1, label: "b" }], ["id", "label"]);
    expect(base).not.toBe(changed);
  });
});

describe("buildFullBackup + validateFullBackup", () => {
  test("backup completo incluye solo tablas de negocio, con metadata coherente", async () => {
    const { client, dir } = makeTempDb();
    cleanupDirs.push(dir);
    const payload = await buildFullBackup(client, { environment: "test", databaseUrl: "file:test.db", gitCommit: "abc123" });

    expect(Object.keys(payload.tables).sort()).toEqual(["users", "widgets"]);
    expect(payload.tableCount).toBe(2);
    expect(payload.totalRows).toBe(3); // 1 user + 2 widgets
    expect(payload.foreignKeyCheck.violations).toBe(0);
    expect(payload.gitCommit).toBe("abc123");
    expect(payload.environment).toBe("test");

    const validation = validateFullBackup(payload, ["users", "widgets"]);
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test("validateFullBackup detecta tabla esperada faltante", async () => {
    const { client, dir } = makeTempDb();
    cleanupDirs.push(dir);
    const payload = await buildFullBackup(client, { environment: "test", databaseUrl: "file:test.db" });
    const validation = validateFullBackup(payload, ["users", "widgets", "tabla_que_no_existe"]);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((e) => e.includes("tabla_que_no_existe"))).toBe(true);
  });

  test("validateFullBackup detecta un checksum manipulado después de generado", async () => {
    const { client, dir } = makeTempDb();
    cleanupDirs.push(dir);
    const payload = await buildFullBackup(client, { environment: "test", databaseUrl: "file:test.db" });
    payload.tables.widgets!.rows[0].value = 999999; // alteración post-generación, checksum queda desactualizado
    const validation = validateFullBackup(payload, ["users", "widgets"]);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((e) => e.includes("checksum"))).toBe(true);
  });

  test("foreign_key_check con violaciones es warning, no bloquea el backup (dato real de la base, no defecto del export)", async () => {
    const { client, dir, db } = makeTempDb();
    cleanupDirs.push(dir);
    db.exec("INSERT INTO sessions (id, user_id) VALUES ('sess-orphan', 9999)"); // violación real, sin enforcement (foreign_keys OFF por default)
    const payload = await buildFullBackup(client, { environment: "test", databaseUrl: "file:test.db" });
    expect(payload.foreignKeyCheck.violations).toBeGreaterThan(0);
    const validation = validateFullBackup(payload, ["users", "widgets"]);
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings.some((w) => w.includes("foreign_key_check"))).toBe(true);
  });
});

describe("maskDatabaseUrl", () => {
  test("enmascara host de libsql://, nunca imprime la URL completa", () => {
    const masked = maskDatabaseUrl("libsql://organizacioncurini-lucianocurini.aws-us-east-1.turso.io");
    expect(masked.startsWith("libsql://organiza")).toBe(true);
    expect(masked).toContain("*");
    expect(masked).not.toContain("lucianocurini.aws-us-east-1.turso.io");
  });
  test("no enmascara rutas file: (no son secretas)", () => {
    expect(maskDatabaseUrl("file:./dev.db")).toBe("file:./dev.db");
  });
});
