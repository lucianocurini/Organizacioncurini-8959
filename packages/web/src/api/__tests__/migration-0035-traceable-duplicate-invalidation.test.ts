/**
 * Prueba el aplicador idempotente de la migración 0035 (invalidación
 * trazable de cuotas/refacturaciones duplicadas). Puramente aditiva — se
 * arma una base temporal en el scratchpad del sistema con el esquema
 * PRE-0035 mínimo necesario (users/policies/policy_installments/rebillings).
 * Se borra al finalizar. No toca dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0035TraceableDuplicateInvalidation,
  applyMigration0035TraceableDuplicateInvalidationWork,
  type Sql0035Client,
} from "../../lib/migrations/apply-0035-traceable-duplicate-invalidation";

function wrapBunSqlite(db: Database): Sql0035Client {
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
}, 15000);

function makePreMigrationDb(): Sql0035Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0035-test-"));
  const dbPath = join(tmpDir, "pre-0035.db");
  db = new Database(dbPath);
  db.run("PRAGMA foreign_keys=ON");
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  db.run(`
    CREATE TABLE policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_number TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE rebillings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL REFERENCES policies(id),
      billing_start TEXT NOT NULL,
      billing_end TEXT NOT NULL,
      premium REAL
    )
  `);
  db.run(`
    CREATE TABLE policy_installments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL REFERENCES policies(id),
      number INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendiente',
      rebilling_id INTEGER REFERENCES rebillings(id)
    )
  `);
  return wrapBunSqlite(db);
}

function insertPolicy(): number {
  return (db!.query(`INSERT INTO policies (policy_number) VALUES ('TEST-0035') RETURNING id`).get() as any).id;
}

function insertInstallment(policyId: number, opts: { number?: number; dueDate?: string; amount?: number; status?: string } = {}): number {
  const row = db!.query(
    `INSERT INTO policy_installments (policy_id, number, due_date, amount, status) VALUES (?, ?, ?, ?, ?) RETURNING id`
  ).get(policyId, opts.number ?? 1, opts.dueDate ?? "2026-01-01", opts.amount ?? 1000, opts.status ?? "pendiente") as any;
  return row.id;
}

function insertRebilling(policyId: number): number {
  const row = db!.query(
    `INSERT INTO rebillings (policy_id, billing_start, billing_end, premium) VALUES (?, '2026-01-01', '2026-04-01', 5000) RETURNING id`
  ).get(policyId) as any;
  return row.id;
}

describe("0035 — agrega las columnas nuevas", () => {
  test("policy_installments: las 4 columnas no existen antes, existen después, todas nullable", async () => {
    const client = makePreMigrationDb();
    const before = await client.execute("PRAGMA table_info(policy_installments)");
    for (const col of ["duplicate_of_installment_id", "invalidated_at", "invalidated_by", "invalidation_reason"]) {
      expect((before.rows as any[]).some((c) => c.name === col)).toBe(false);
    }

    const summary = await applyMigration0035TraceableDuplicateInvalidation(client);
    expect(summary.installmentsColumnsAdded.sort()).toEqual(
      ["duplicate_of_installment_id", "invalidated_at", "invalidated_by", "invalidation_reason"].sort()
    );

    const after = await client.execute("PRAGMA table_info(policy_installments)");
    for (const col of ["duplicate_of_installment_id", "invalidated_at", "invalidated_by", "invalidation_reason"]) {
      const c = (after.rows as any[]).find((r) => r.name === col);
      expect(c).toBeDefined();
      expect(c.notnull).toBe(0);
    }
  });

  test("rebillings: status llega NOT NULL DEFAULT 'activa', el resto nullable", async () => {
    const client = makePreMigrationDb();
    const summary = await applyMigration0035TraceableDuplicateInvalidation(client);
    expect(summary.rebillingsColumnsAdded.sort()).toEqual(
      ["status", "duplicate_of_rebilling_id", "invalidated_at", "invalidated_by", "invalidation_reason"].sort()
    );

    const after = await client.execute("PRAGMA table_info(rebillings)");
    const statusCol = (after.rows as any[]).find((c) => c.name === "status");
    expect(statusCol.notnull).toBe(1);
    expect(statusCol.dflt_value).toBe("'activa'");
    const dupCol = (after.rows as any[]).find((c) => c.name === "duplicate_of_rebilling_id");
    expect(dupCol.notnull).toBe(0);
  });

  test("crea los 4 índices no-únicos", async () => {
    const client = makePreMigrationDb();
    await applyMigration0035TraceableDuplicateInvalidation(client);

    const idxInstallments = (await client.execute("PRAGMA index_list(policy_installments)")).rows as any[];
    expect(idxInstallments.some((i) => i.name === "idx_policy_installments_status")).toBe(true);
    expect(idxInstallments.some((i) => i.name === "idx_policy_installments_duplicate_of")).toBe(true);
    // Ninguno de los índices creados por esta migración es único.
    expect(idxInstallments.filter((i) => ["idx_policy_installments_status", "idx_policy_installments_duplicate_of"].includes(i.name)).every((i) => i.unique === 0)).toBe(true);

    const idxRebillings = (await client.execute("PRAGMA index_list(rebillings)")).rows as any[];
    expect(idxRebillings.some((i) => i.name === "idx_rebillings_status")).toBe(true);
    expect(idxRebillings.some((i) => i.name === "idx_rebillings_duplicate_of")).toBe(true);
  });

  test("NO crea ningún índice UNIQUE (a propósito, histórico sin sanear todavía)", async () => {
    const client = makePreMigrationDb();
    await applyMigration0035TraceableDuplicateInvalidation(client);

    const idxInstallments = (await client.execute("PRAGMA index_list(policy_installments)")).rows as any[];
    const idxRebillings = (await client.execute("PRAGMA index_list(rebillings)")).rows as any[];
    expect(idxInstallments.every((i) => i.unique === 0)).toBe(true);
    expect(idxRebillings.every((i) => i.unique === 0)).toBe(true);
  });
});

describe("0035 — conserva filas históricas sin reinterpretarlas", () => {
  test("no cambia la cantidad de filas de policy_installments/rebillings", async () => {
    const client = makePreMigrationDb();
    const policyId = insertPolicy();
    insertInstallment(policyId);
    insertInstallment(policyId, { number: 2 });
    insertRebilling(policyId);

    const summary = await applyMigration0035TraceableDuplicateInvalidation(client);
    expect(summary.policyInstallmentsBefore).toBe(2);
    expect(summary.policyInstallmentsAfter).toBe(2);
    expect(summary.rebillingsBefore).toBe(1);
    expect(summary.rebillingsAfter).toBe(1);
  });

  test("toda cuota histórica queda con status intacto, duplicate_of_installment_id NULL", async () => {
    const client = makePreMigrationDb();
    const policyId = insertPolicy();
    const pagadaId = insertInstallment(policyId, { status: "pagada" });
    const pendienteId = insertInstallment(policyId, { number: 2, status: "pendiente" });

    await applyMigration0035TraceableDuplicateInvalidation(client);

    const pagada = db!.query("SELECT status, duplicate_of_installment_id FROM policy_installments WHERE id = ?").get(pagadaId) as any;
    expect(pagada.status).toBe("pagada");
    expect(pagada.duplicate_of_installment_id).toBeNull();

    const pendiente = db!.query("SELECT status, duplicate_of_installment_id FROM policy_installments WHERE id = ?").get(pendienteId) as any;
    expect(pendiente.status).toBe("pendiente");
    expect(pendiente.duplicate_of_installment_id).toBeNull();
  });

  test("toda refacturación histórica queda con status='activa', duplicate_of_rebilling_id NULL", async () => {
    const client = makePreMigrationDb();
    const policyId = insertPolicy();
    const rebId = insertRebilling(policyId);

    await applyMigration0035TraceableDuplicateInvalidation(client);

    const reb = db!.query("SELECT status, duplicate_of_rebilling_id FROM rebillings WHERE id = ?").get(rebId) as any;
    expect(reb.status).toBe("activa");
    expect(reb.duplicate_of_rebilling_id).toBeNull();
  });
});

describe("0035 — autorreferencia funciona de verdad", () => {
  test("una cuota puede apuntar a otra cuota de la misma tabla como su canónica", async () => {
    const client = makePreMigrationDb();
    await applyMigration0035TraceableDuplicateInvalidation(client);
    const policyId = insertPolicy();
    const canonicalId = insertInstallment(policyId, { status: "pendiente" });
    const duplicateId = insertInstallment(policyId, { number: 1, status: "pendiente" });

    const userId = (db!.query(`INSERT INTO users (name) VALUES ('QA') RETURNING id`).get() as any).id;
    db!.run(
      `UPDATE policy_installments SET status='duplicada', duplicate_of_installment_id=?, invalidated_at=0, invalidated_by=?, invalidation_reason='dup exacta' WHERE id=?`,
      [canonicalId, userId, duplicateId]
    );

    const row = db!.query("SELECT * FROM policy_installments WHERE id = ?").get(duplicateId) as any;
    expect(row.status).toBe("duplicada");
    expect(row.duplicate_of_installment_id).toBe(canonicalId);
    expect(row.invalidation_reason).toBe("dup exacta");

    const fk = db!.query("PRAGMA foreign_key_check").all();
    expect(fk).toEqual([]);
  });

  test("una refacturación puede apuntar a otra refacturación de la misma tabla como su canónica", async () => {
    const client = makePreMigrationDb();
    await applyMigration0035TraceableDuplicateInvalidation(client);
    const policyId = insertPolicy();
    const canonicalId = insertRebilling(policyId);
    const duplicateId = insertRebilling(policyId);

    const userId = (db!.query(`INSERT INTO users (name) VALUES ('QA') RETURNING id`).get() as any).id;
    db!.run(
      `UPDATE rebillings SET status='duplicada', duplicate_of_rebilling_id=?, invalidated_at=0, invalidated_by=?, invalidation_reason='dup exacta' WHERE id=?`,
      [canonicalId, userId, duplicateId]
    );

    const row = db!.query("SELECT * FROM rebillings WHERE id = ?").get(duplicateId) as any;
    expect(row.status).toBe("duplicada");
    expect(row.duplicate_of_rebilling_id).toBe(canonicalId);

    const fk = db!.query("PRAGMA foreign_key_check").all();
    expect(fk).toEqual([]);
  });

  test("un FK autorreferencial hacia un id inexistente es rechazado (foreign_keys=ON)", async () => {
    const client = makePreMigrationDb();
    await applyMigration0035TraceableDuplicateInvalidation(client);
    const policyId = insertPolicy();
    const duplicateId = insertInstallment(policyId);

    expect(() => {
      db!.run(`UPDATE policy_installments SET duplicate_of_installment_id = 999999 WHERE id = ?`, [duplicateId]);
    }).toThrow();
  });
});

describe("0035 — idempotencia", () => {
  test("segunda corrida no duplica columnas ni índices, alreadyApplied=true", async () => {
    const client = makePreMigrationDb();
    const policyId = insertPolicy();
    insertInstallment(policyId);

    const first = await applyMigration0035TraceableDuplicateInvalidation(client);
    expect(first.alreadyApplied).toBe(false);

    const second = await applyMigration0035TraceableDuplicateInvalidation(client);
    expect(second.alreadyApplied).toBe(true);
    expect(second.installmentsColumnsAdded).toEqual([]);
    expect(second.rebillingsColumnsAdded).toEqual([]);
    expect(second.indexesCreated).toEqual([]);

    const cols = await client.execute("PRAGMA table_info(policy_installments)");
    expect((cols.rows as any[]).filter((c) => c.name === "duplicate_of_installment_id").length).toBe(1);
  });

  test("tercera corrida sobre datos ya invalidados no los toca ni falla", async () => {
    const client = makePreMigrationDb();
    await applyMigration0035TraceableDuplicateInvalidation(client);
    const policyId = insertPolicy();
    const canonicalId = insertInstallment(policyId);
    const duplicateId = insertInstallment(policyId, { number: 2 });
    const userId = (db!.query(`INSERT INTO users (name) VALUES ('QA') RETURNING id`).get() as any).id;
    db!.run(
      `UPDATE policy_installments SET status='duplicada', duplicate_of_installment_id=?, invalidated_by=? WHERE id=?`,
      [canonicalId, userId, duplicateId]
    );

    await applyMigration0035TraceableDuplicateInvalidation(client);

    const row = db!.query("SELECT status, duplicate_of_installment_id FROM policy_installments WHERE id = ?").get(duplicateId) as any;
    expect(row.status).toBe("duplicada");
    expect(row.duplicate_of_installment_id).toBe(canonicalId);
  });
});

// ─── Work vs. wrapper local — no controla transacciones por sí misma ────────
describe("0035 — applyMigration0035TraceableDuplicateInvalidationWork no controla transacciones", () => {
  function wrapRecording(base: Sql0035Client): { client: Sql0035Client; sqlLog: string[] } {
    const sqlLog: string[] = [];
    return {
      sqlLog,
      client: {
        async execute(sql: string, params: any[] = []) {
          sqlLog.push(sql.trim());
          return base.execute(sql, params);
        },
      },
    };
  }

  test("no emite BEGIN/COMMIT/ROLLBACK", async () => {
    const base = makePreMigrationDb();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0035TraceableDuplicateInvalidationWork(client);

    const controlStatements = sqlLog.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql));
    expect(controlStatements).toEqual([]);
  });

  test("el wrapper local sí emite BEGIN y COMMIT", async () => {
    const base = makePreMigrationDb();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0035TraceableDuplicateInvalidation(client);

    expect(sqlLog.some((sql) => /^BEGIN\b/i.test(sql))).toBe(true);
    expect(sqlLog.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
  });
});
