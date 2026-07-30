/**
 * Prueba el aplicador idempotente de la migración 0031 (deliveries.rebilling_id
 * + deliveries.sent_date). Puramente aditiva (ninguna tabla se recrea) — se
 * arma una base temporal en el scratchpad del sistema con el esquema PRE-0031
 * de deliveries (tal como quedó tras la migración 0010) más los mínimos
 * necesarios de policies/rebillings/users/companies/insureds. PRAGMA
 * foreign_keys=ON para poder probar la FK real de rebilling_id (mismo
 * criterio que migration-0026/0030...test.ts). Se borra al finalizar. No toca
 * dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0031DeliveriesRebillingTracking,
  applyMigration0031DeliveriesRebillingTrackingWork,
  type Sql0031Client,
} from "../../lib/migrations/apply-0031-deliveries-rebilling-tracking";

function wrapBunSqlite(db: Database): Sql0031Client {
  return {
    async execute(sql: string, params: any[] = []) {
      // db.prepare()+finalize() en vez de db.query() (que cachea el
      // Statement sin finalizarlo) — evita EBUSY al borrar el directorio
      // temporal en Windows (mismo fix que 0021-0022/0024/0028/0030...test.ts).
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

function makePreMigrationDb(): Sql0031Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0031-test-"));
  const dbPath = join(tmpDir, "pre-0031.db");
  db = new Database(dbPath);
  db.run("PRAGMA foreign_keys=ON");
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  db.run(`CREATE TABLE companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  db.run(`CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  db.run(`
    CREATE TABLE policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_number TEXT NOT NULL,
      company_id INTEGER REFERENCES companies(id),
      insured_id INTEGER REFERENCES insureds(id),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE rebillings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL REFERENCES policies(id),
      billing_start TEXT NOT NULL,
      billing_end TEXT NOT NULL
    )
  `);
  // Esquema exacto tras la migración 0010 (deliveries_nullable_policy) —
  // el estado inmediatamente PRE-0031.
  db.run(`
    CREATE TABLE deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER REFERENCES policies(id),
      manual_recipient TEXT,
      manual_policy_number TEXT,
      manual_company TEXT,
      document_type TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendiente',
      scheduled_date TEXT,
      completed_date TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at INTEGER
    )
  `);
  return wrapBunSqlite(db);
}

function insertPolicy(companyId: number, insuredId: number): number {
  const row = db!.query(
    `INSERT INTO policies (policy_number, company_id, insured_id, start_date, end_date)
     VALUES ('TEST-POL-0031', ?, ?, '2027-01-01', '2027-12-31') RETURNING id`
  ).get(companyId, insuredId) as any;
  return row.id;
}

function insertRebilling(policyId: number): number {
  const row = db!.query(
    `INSERT INTO rebillings (policy_id, billing_start, billing_end) VALUES (?, '2027-06-01', '2027-06-30') RETURNING id`
  ).get(policyId) as any;
  return row.id;
}

function insertDelivery(policyId: number | null, documentType = "poliza", channel = "email"): number {
  const row = db!.query(
    `INSERT INTO deliveries (policy_id, document_type, channel, status, created_at) VALUES (?, ?, ?, 'pendiente', 0) RETURNING id`
  ).get(policyId, documentType, channel) as any;
  return row.id;
}

describe("0031 — agrega las columnas", () => {
  test("rebilling_id y sent_date no existen antes, existen después", async () => {
    const client = makePreMigrationDb();
    const before = await client.execute("PRAGMA table_info(deliveries)");
    expect((before.rows as any[]).some((c) => c.name === "rebilling_id")).toBe(false);
    expect((before.rows as any[]).some((c) => c.name === "sent_date")).toBe(false);

    const summary = await applyMigration0031DeliveriesRebillingTracking(client);
    expect(summary.rebillingIdColumnAdded).toBe(true);
    expect(summary.sentDateColumnAdded).toBe(true);

    const after = await client.execute("PRAGMA table_info(deliveries)");
    expect((after.rows as any[]).some((c) => c.name === "rebilling_id")).toBe(true);
    expect((after.rows as any[]).some((c) => c.name === "sent_date")).toBe(true);
  });

  test("crea los índices de policy_id y rebilling_id", async () => {
    const client = makePreMigrationDb();
    const summary = await applyMigration0031DeliveriesRebillingTracking(client);
    expect(summary.policyIdIndexCreated).toBe(true);
    expect(summary.rebillingIdIndexCreated).toBe(true);

    const idx = await client.execute("PRAGMA index_list(deliveries)");
    const names = (idx.rows as any[]).map((r) => r.name);
    expect(names).toContain("idx_deliveries_policy_id");
    expect(names).toContain("idx_deliveries_rebilling_id");
  });
});

describe("0031 — conserva filas históricas", () => {
  test("no cambia la cantidad de filas de deliveries", async () => {
    const client = makePreMigrationDb();
    const companyId = (db!.query("INSERT INTO companies (name) VALUES ('Cia') RETURNING id").get() as any).id;
    const insuredId = (db!.query("INSERT INTO insureds (name) VALUES ('Aseg') RETURNING id").get() as any).id;
    const policyId = insertPolicy(companyId, insuredId);
    insertDelivery(policyId);
    insertDelivery(null, "poliza"); // manual

    const summary = await applyMigration0031DeliveriesRebillingTracking(client);
    expect(summary.deliveriesBefore).toBe(2);
    expect(summary.deliveriesAfter).toBe(2);
  });

  test("una fila histórica conserva todos sus campos originales intactos", async () => {
    const client = makePreMigrationDb();
    const companyId = (db!.query("INSERT INTO companies (name) VALUES ('Cia') RETURNING id").get() as any).id;
    const insuredId = (db!.query("INSERT INTO insureds (name) VALUES ('Aseg') RETURNING id").get() as any).id;
    const policyId = insertPolicy(companyId, insuredId);
    const deliveryId = insertDelivery(policyId, "refacturacion", "whatsapp");
    db!.run("UPDATE deliveries SET status = 'realizado', completed_date = '2027-03-01' WHERE id = ?", [deliveryId]);

    await applyMigration0031DeliveriesRebillingTracking(client);

    const row = db!.query("SELECT * FROM deliveries WHERE id = ?").get(deliveryId) as any;
    expect(row.policy_id).toBe(policyId);
    expect(row.document_type).toBe("refacturacion");
    expect(row.channel).toBe("whatsapp");
    expect(row.status).toBe("realizado"); // NUNCA reinterpretado
    expect(row.completed_date).toBe("2027-03-01");
  });
});

describe("0031 — valores históricos quedan NULL", () => {
  test("rebilling_id y sent_date quedan NULL para toda fila existente", async () => {
    const client = makePreMigrationDb();
    const companyId = (db!.query("INSERT INTO companies (name) VALUES ('Cia') RETURNING id").get() as any).id;
    const insuredId = (db!.query("INSERT INTO insureds (name) VALUES ('Aseg') RETURNING id").get() as any).id;
    const policyId = insertPolicy(companyId, insuredId);
    insertDelivery(policyId);
    insertDelivery(policyId);

    await applyMigration0031DeliveriesRebillingTracking(client);

    const stillNull = db!.query(
      "SELECT COUNT(*) as c FROM deliveries WHERE rebilling_id IS NULL AND sent_date IS NULL"
    ).get() as any;
    expect(stillNull.c).toBe(2);
  });
});

describe("0031 — foreign key válida", () => {
  test("rebilling_id acepta un id real de rebillings", async () => {
    const client = makePreMigrationDb();
    await applyMigration0031DeliveriesRebillingTracking(client);
    const companyId = (db!.query("INSERT INTO companies (name) VALUES ('Cia') RETURNING id").get() as any).id;
    const insuredId = (db!.query("INSERT INTO insureds (name) VALUES ('Aseg') RETURNING id").get() as any).id;
    const policyId = insertPolicy(companyId, insuredId);
    const rebillingId = insertRebilling(policyId);

    expect(() =>
      db!.run(
        "INSERT INTO deliveries (policy_id, rebilling_id, document_type, channel, status, created_at) VALUES (?, ?, 'refacturacion', 'email', 'pendiente', 0)",
        [policyId, rebillingId]
      )
    ).not.toThrow();
  });

  test("rebilling_id rechaza un id inexistente (FK real, foreign_keys=ON)", async () => {
    const client = makePreMigrationDb();
    await applyMigration0031DeliveriesRebillingTracking(client);
    const companyId = (db!.query("INSERT INTO companies (name) VALUES ('Cia') RETURNING id").get() as any).id;
    const insuredId = (db!.query("INSERT INTO insureds (name) VALUES ('Aseg') RETURNING id").get() as any).id;
    const policyId = insertPolicy(companyId, insuredId);

    expect(() =>
      db!.run(
        "INSERT INTO deliveries (policy_id, rebilling_id, document_type, channel, status, created_at) VALUES (?, 999999, 'refacturacion', 'email', 'pendiente', 0)",
        [policyId]
      )
    ).toThrow();
  });
});

describe("0031 — idempotencia", () => {
  test("segunda corrida no duplica columnas ni índices, alreadyApplied=true", async () => {
    const client = makePreMigrationDb();
    const companyId = (db!.query("INSERT INTO companies (name) VALUES ('Cia') RETURNING id").get() as any).id;
    const insuredId = (db!.query("INSERT INTO insureds (name) VALUES ('Aseg') RETURNING id").get() as any).id;
    const policyId = insertPolicy(companyId, insuredId);
    insertDelivery(policyId);

    const first = await applyMigration0031DeliveriesRebillingTracking(client);
    expect(first.alreadyApplied).toBe(false);
    expect(first.rebillingIdColumnAdded).toBe(true);
    expect(first.sentDateColumnAdded).toBe(true);

    const second = await applyMigration0031DeliveriesRebillingTracking(client);
    expect(second.alreadyApplied).toBe(true);
    expect(second.rebillingIdColumnAdded).toBe(false);
    expect(second.sentDateColumnAdded).toBe(false);
    expect(second.rebillingIdIndexCreated).toBe(false);
    expect(second.policyIdIndexCreated).toBe(false);
    expect(second.deliveriesAfter).toBe(1);

    const idx = await client.execute("PRAGMA index_list(deliveries)");
    const names = (idx.rows as any[]).map((r) => r.name);
    expect(names.filter((n) => n === "idx_deliveries_policy_id").length).toBe(1);
    expect(names.filter((n) => n === "idx_deliveries_rebilling_id").length).toBe(1);
  });
});

describe("0031 — estado parcial (una columna ya existe, la otra no)", () => {
  test("solo rebilling_id existía — agrega sent_date e índices, no toca rebilling_id", async () => {
    const client = makePreMigrationDb();
    db!.run("ALTER TABLE deliveries ADD COLUMN rebilling_id INTEGER REFERENCES rebillings(id)");
    const companyId = (db!.query("INSERT INTO companies (name) VALUES ('Cia') RETURNING id").get() as any).id;
    const insuredId = (db!.query("INSERT INTO insureds (name) VALUES ('Aseg') RETURNING id").get() as any).id;
    const policyId = insertPolicy(companyId, insuredId);
    const rebillingId = insertRebilling(policyId);
    const deliveryId = insertDelivery(policyId);
    db!.run("UPDATE deliveries SET rebilling_id = ? WHERE id = ?", [rebillingId, deliveryId]);

    const summary = await applyMigration0031DeliveriesRebillingTrackingWork(client);
    expect(summary.rebillingIdColumnAdded).toBe(false);
    expect(summary.sentDateColumnAdded).toBe(true);

    const row = db!.query("SELECT rebilling_id FROM deliveries WHERE id = ?").get(deliveryId) as any;
    expect(row.rebilling_id).toBe(rebillingId); // no se pisa el valor ya cargado
  });
});

// ─── Work vs. wrapper local — no controla transacciones por sí misma ────────
// Mismo criterio que apply-0030-insured-account-movements.ts (Fase 2H): un
// futuro apply-0031-*-prod.ts envolverá el Work con client.transaction("write")
// de Turso — nunca debe emitir su propio control de transacción.

describe("0031 — applyMigration0031DeliveriesRebillingTrackingWork no controla transacciones", () => {
  function wrapRecording(base: Sql0031Client): { client: Sql0031Client; sqlLog: string[] } {
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

    await applyMigration0031DeliveriesRebillingTrackingWork(client);

    const controlStatements = sqlLog.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql));
    expect(controlStatements).toEqual([]);
  });

  test("el wrapper local sí emite BEGIN y COMMIT", async () => {
    const base = makePreMigrationDb();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0031DeliveriesRebillingTracking(client);

    expect(sqlLog.some((sql) => /^BEGIN\b/i.test(sql))).toBe(true);
    expect(sqlLog.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
  });
});
