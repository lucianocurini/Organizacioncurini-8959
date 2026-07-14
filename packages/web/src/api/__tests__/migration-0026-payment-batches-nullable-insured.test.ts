/**
 * Prueba el aplicador idempotente de la migración 0026 (payment_batches.
 * insured_id nullable — Etapa "lote multi-asegurado"). A diferencia de
 * 0020/0025 (solo ALTER TABLE ADD COLUMN), esta migración recrea la tabla
 * completa (procedimiento de 12 pasos de SQLite), así que además de columnas
 * hay que verificar: ids/createdAt/status/totals/notes preservados sin
 * backfill, los índices recreados, y que las FKs de las tablas hijas
 * (payments.batch_id, payment_batch_splits.batch_id,
 * remittance_allocations.payment_batch_id) siguen apuntando a las mismas
 * filas después del rename. Se arma una base temporal mínima a mano en el
 * scratchpad del sistema — se borra al finalizar. No toca dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0026PaymentBatchesNullableInsured,
  type Sql0026Client,
} from "../../lib/migrations/apply-0026-payment-batches-nullable-insured";

// Mismo wrapper que scripts/apply_0026_local.ts (no el simplificado de
// 0020/0025) — esta migración usa PRAGMA y consultas parametrizadas
// (tableExists), así que necesita soportar ambos casos.
function wrapBunSqlite(db: Database): Sql0026Client {
  return {
    async execute(sql: string, params: any[] = []) {
      const trimmed = sql.trim();
      const kind = trimmed.slice(0, 6).toUpperCase();
      if (kind === "SELECT" || trimmed.toUpperCase().startsWith("PRAGMA")) {
        return { rows: db.query(sql).all(...params) as any[] };
      }
      db.query(sql).run(...params);
      return { rows: [] };
    },
  };
}

let tmpDir: string | null = null;
let db: Database | null = null;

afterEach(async () => {
  db?.close();
  db = null;
  if (tmpDir) {
    const dir = tmpDir;
    tmpDir = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (attempt === 14) throw e;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

function makePreMigrationDb(): Sql0026Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0026-payment-batches-nullable-insured-test-"));
  const dbPath = join(tmpDir, "pre-0026.db");
  db = new Database(dbPath);
  db.run("PRAGMA foreign_keys=ON");
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  db.run(`CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  // Esquema tal como quedó tras la migración 0021 — insured_id NOT NULL.
  db.run(`
    CREATE TABLE payment_batches (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      insured_id             INTEGER NOT NULL REFERENCES insureds(id),
      base_amount_cents      INTEGER NOT NULL CHECK (base_amount_cents > 0),
      surcharge_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (surcharge_amount_cents >= 0),
      total_received_cents   INTEGER NOT NULL CHECK (total_received_cents > 0),
      payment_date           TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'confirmado' CHECK (status IN ('confirmado', 'anulado')),
      notes                  TEXT,
      created_by             INTEGER REFERENCES users(id),
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    )
  `);
  // Tablas hijas reales que referencian payment_batches por nombre de tabla
  // (no por rowid interno) — deben seguir funcionando después del rename.
  db.run(`
    CREATE TABLE payment_batch_splits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES payment_batches(id),
      method TEXT NOT NULL,
      amount_cents INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE remittance_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_batch_id INTEGER REFERENCES payment_batches(id),
      amount_cents INTEGER NOT NULL
    )
  `);
  return wrapBunSqlite(db);
}

function insertInsured(name: string): number {
  db!.run("INSERT INTO insureds (name) VALUES (?)", [name]);
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

function insertBatch(insuredId: number, notes: string | null = null): number {
  db!.run(
    `INSERT INTO payment_batches (insured_id, base_amount_cents, total_received_cents, payment_date, status, notes, created_at, updated_at)
     VALUES (?, 100000, 100000, '2027-06-01', 'confirmado', ?, 1000, 1000)`,
    [insuredId, notes]
  );
  return Number(db!.query("SELECT last_insert_rowid() as id").get()!.id);
}

describe("0026 — payment_batches.insured_id nullable (recreación completa de tabla)", () => {
  test("primera corrida vuelve insured_id nullable, sin backfill (mismas filas, mismos valores)", async () => {
    const client = makePreMigrationDb();
    const insuredA = insertInsured("Juan Pérez");
    const batchId = insertBatch(insuredA, "nota original");

    const summary = await applyMigration0026PaymentBatchesNullableInsured(client);

    expect(summary.alreadyNullable).toBe(false);
    expect(summary.paymentBatchesCountBefore).toBe(1);
    expect(summary.paymentBatchesCountAfter).toBe(1);

    const cols = await client.execute("PRAGMA table_info(payment_batches)");
    const insuredCol = (cols.rows as any[]).find((c) => c.name === "insured_id");
    expect(Number(insuredCol.notnull)).toBe(0);

    const row = db!.query("SELECT id, insured_id, notes, status, total_received_cents, created_at FROM payment_batches WHERE id = ?").get(batchId) as any;
    expect(row.id).toBe(batchId);
    expect(row.insured_id).toBe(insuredA);
    expect(row.notes).toBe("nota original");
    expect(row.status).toBe("confirmado");
    expect(row.total_received_cents).toBe(100000);
    expect(row.created_at).toBe(1000);
  });

  test("los índices originales quedan recreados", async () => {
    const client = makePreMigrationDb();
    await applyMigration0026PaymentBatchesNullableInsured(client);
    const idx = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
    const names = (idx.rows as any[]).map((r) => r.name);
    expect(names).toContain("idx_payment_batches_insured_id");
    expect(names).toContain("idx_payment_batches_payment_date");
    expect(names).toContain("idx_payment_batches_status");
  });

  test("las FKs de tablas hijas (splits, remittance_allocations) siguen apuntando a las mismas filas tras el rename", async () => {
    const client = makePreMigrationDb();
    const insuredA = insertInsured("Juan Pérez");
    const batchId = insertBatch(insuredA);
    db!.run("INSERT INTO payment_batch_splits (batch_id, method, amount_cents) VALUES (?, 'efectivo', 100000)", [batchId]);
    db!.run("INSERT INTO remittance_allocations (payment_batch_id, amount_cents) VALUES (?, 100000)", [batchId]);

    await applyMigration0026PaymentBatchesNullableInsured(client);

    const split = db!.query("SELECT batch_id FROM payment_batch_splits WHERE batch_id = ?").get(batchId) as any;
    expect(split.batch_id).toBe(batchId);
    const alloc = db!.query("SELECT payment_batch_id FROM remittance_allocations WHERE payment_batch_id = ?").get(batchId) as any;
    expect(alloc.payment_batch_id).toBe(batchId);

    const fkCheck = await client.execute("PRAGMA foreign_key_check");
    expect(fkCheck.rows.length).toBe(0);
  });

  test("después de migrar, un batch nuevo puede insertarse con insured_id NULL (100% manual)", async () => {
    const client = makePreMigrationDb();
    await applyMigration0026PaymentBatchesNullableInsured(client);

    db!.run(`
      INSERT INTO payment_batches (insured_id, base_amount_cents, total_received_cents, payment_date, status, created_at, updated_at)
      VALUES (NULL, 50000, 50000, '2027-06-02', 'confirmado', 2000, 2000)
    `);
    const row = db!.query("SELECT insured_id FROM payment_batches WHERE payment_date = '2027-06-02'").get() as any;
    expect(row.insured_id).toBeNull();
  });

  test("segunda corrida es idempotente — no toca nada, alreadyNullable=true", async () => {
    const client = makePreMigrationDb();
    const insuredA = insertInsured("Juan Pérez");
    insertBatch(insuredA);

    const first = await applyMigration0026PaymentBatchesNullableInsured(client);
    expect(first.alreadyNullable).toBe(false);

    const second = await applyMigration0026PaymentBatchesNullableInsured(client);
    expect(second.alreadyNullable).toBe(true);
    expect(second.paymentBatchesCountBefore).toBe(1);
    expect(second.paymentBatchesCountAfter).toBe(1);
  });

  test("lanza un error explícito si payment_batches no existe todavía", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "migration-0026-no-table-test-"));
    const dbPath = join(tmpDir, "empty.db");
    db = new Database(dbPath);
    const client = wrapBunSqlite(db);
    await expect(applyMigration0026PaymentBatchesNullableInsured(client)).rejects.toThrow(/no existe/);
  });
});
