/**
 * Prueba el aplicador idempotente de la migración 0030 (sobrantes/faltantes,
 * Fase 2A): payment_batches.received_amount_cents (+ backfill) e
 * insured_account_movements / payment_amount_adjustments nuevas. A diferencia
 * de 0026/0028/0029, esta migración es puramente aditiva (ninguna tabla
 * existente se recrea) — payment_batches se arma reutilizando el aplicador
 * real de la migración 0021 (mismo criterio que migration-0022/0028...test.ts:
 * una sola fuente de verdad para "cómo queda payment_batches", no una copia a
 * mano que puede desincronizarse). PRAGMA foreign_keys=ON para poder probar
 * las FKs básicas de las tablas nuevas (igual que migration-0026...test.ts).
 * Se arma una base temporal en el scratchpad del sistema — se borra al
 * finalizar. No toca dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyMigration0021PaymentBatches, type Sql0021Client } from "../../lib/migrations/apply-0021-payment-batches";
import {
  applyMigration0030InsuredAccountMovements,
  applyMigration0030InsuredAccountMovementsWork,
  type Sql0030Client,
} from "../../lib/migrations/apply-0030-insured-account-movements";

type Client = Sql0021Client & Sql0030Client;

function wrapBunSqlite(db: Database): Client {
  return {
    async execute(sql: string, params: any[] = []) {
      // db.prepare()+finalize() en vez de db.query() (que cachea el
      // Statement sin finalizarlo) — evita EBUSY al borrar el directorio
      // temporal en Windows (mismo fix que 0021-0022/0024/0028...test.ts).
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
});

async function makePreMigrationDb(): Promise<Client> {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0030-test-"));
  const dbPath = join(tmpDir, "pre-0030.db");
  db = new Database(dbPath);
  db.run("PRAGMA foreign_keys=ON");
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  db.run(`CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  db.run(`
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmado',
      installment_id INTEGER,
      batch_id INTEGER,
      rendered INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE policy_installments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendiente'
    )
  `);
  const client = wrapBunSqlite(db);
  // payment_batches tal como queda tras la migración 0021 (única columna que
  // 0030 lee/escribe: total_received_cents — el resto de las migraciones
  // posteriores de payment_batches, 0026/0027, son irrelevantes para 0030).
  await applyMigration0021PaymentBatches(client);
  return client;
}

function insertUser(): number {
  db!.run("INSERT INTO users (name) VALUES ('Test User')");
  return (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
}

function insertInsured(): number {
  db!.run("INSERT INTO insureds (name) VALUES ('Test Insured')");
  return (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
}

function insertBatch(insuredId: number, totalReceivedCents: number): number {
  db!.run(
    `INSERT INTO payment_batches
      (insured_id, base_amount_cents, surcharge_amount_cents, total_received_cents, payment_date, created_at, updated_at)
     VALUES (?, ?, 0, ?, '2027-01-01', 0, 0)`,
    [insuredId, totalReceivedCents, totalReceivedCents]
  );
  return (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
}

describe("0030 — payment_batches.received_amount_cents", () => {
  test("agrega la columna y no existía antes", async () => {
    const client = await makePreMigrationDb();
    const before = await client.execute("PRAGMA table_info(payment_batches)");
    expect((before.rows as any[]).some((c) => c.name === "received_amount_cents")).toBe(false);

    const summary = await applyMigration0030InsuredAccountMovements(client);
    expect(summary.receivedAmountColumnAdded).toBe(true);

    const after = await client.execute("PRAGMA table_info(payment_batches)");
    expect((after.rows as any[]).some((c) => c.name === "received_amount_cents")).toBe(true);
  });

  test("backfill correcto: received_amount_cents = total_received_cents para filas existentes", async () => {
    const client = await makePreMigrationDb();
    const insuredId = insertInsured();
    insertBatch(insuredId, 150000);
    insertBatch(insuredId, 80000);

    const summary = await applyMigration0030InsuredAccountMovements(client);
    expect(summary.receivedAmountBackfilledRows).toBe(2);

    const rows = await client.execute("SELECT total_received_cents, received_amount_cents FROM payment_batches ORDER BY id");
    for (const r of rows.rows as any[]) {
      expect(r.received_amount_cents).toBe(r.total_received_cents);
    }
  });

  test("no deja ninguna fila con received_amount_cents NULL tras el backfill", async () => {
    const client = await makePreMigrationDb();
    const insuredId = insertInsured();
    insertBatch(insuredId, 100000);

    await applyMigration0030InsuredAccountMovements(client);
    const stillNull = await client.execute("SELECT COUNT(*) as c FROM payment_batches WHERE received_amount_cents IS NULL");
    expect(Number((stillNull.rows[0] as any).c)).toBe(0);
  });

  test("no cambia la cantidad de filas de payment_batches", async () => {
    const client = await makePreMigrationDb();
    const insuredId = insertInsured();
    insertBatch(insuredId, 100000);
    insertBatch(insuredId, 200000);

    const summary = await applyMigration0030InsuredAccountMovements(client);
    expect(summary.paymentBatchesCountBefore).toBe(2);
    expect(summary.paymentBatchesCountAfter).toBe(2);
  });
});

describe("0030 — idempotencia", () => {
  test("segunda corrida no duplica columnas ni tablas, no vuelve a backfillear", async () => {
    const client = await makePreMigrationDb();
    const insuredId = insertInsured();
    insertBatch(insuredId, 100000);

    const first = await applyMigration0030InsuredAccountMovements(client);
    expect(first.receivedAmountColumnAdded).toBe(true);
    expect(first.receivedAmountBackfilledRows).toBe(1);
    expect(first.insuredAccountMovementsTableAlreadyExisted).toBe(false);
    expect(first.paymentAmountAdjustmentsTableAlreadyExisted).toBe(false);

    const second = await applyMigration0030InsuredAccountMovements(client);
    expect(second.receivedAmountColumnAdded).toBe(false);
    expect(second.receivedAmountBackfilledRows).toBe(0);
    expect(second.insuredAccountMovementsTableAlreadyExisted).toBe(true);
    expect(second.paymentAmountAdjustmentsTableAlreadyExisted).toBe(true);
    expect(second.paymentBatchesCountAfter).toBe(1);
  });
});

describe("0030 — insured_account_movements", () => {
  test("crea la tabla", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='insured_account_movements'");
    expect(tables.rows.length).toBe(1);
  });

  test("los índices quedan creados", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const idx = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
    const names = (idx.rows as any[]).map((r) => r.name);
    expect(names).toContain("idx_insured_account_movements_insured_id");
    expect(names).toContain("idx_insured_account_movements_origin_batch_id");
    expect(names).toContain("idx_insured_account_movements_origin_payment_id");
    expect(names).toContain("idx_insured_account_movements_related_payment_id");
    expect(names).toContain("idx_insured_account_movements_status");
    expect(names).toContain("idx_insured_account_movements_type");
  });

  test("CHECK signed_amount_cents != 0 rechaza un movimiento en 0", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const userId = insertUser();
    const insuredId = insertInsured();
    expect(() =>
      db!.run(
        "INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, created_by, created_at) VALUES (?, 'saldo_a_favor', 0, ?, 0)",
        [insuredId, userId]
      )
    ).toThrow();
  });

  test("CHECK type rechaza un valor fuera del vocabulario permitido", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const userId = insertUser();
    const insuredId = insertInsured();
    expect(() =>
      db!.run(
        "INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, created_by, created_at) VALUES (?, 'tipo_invalido', 1000, ?, 0)",
        [insuredId, userId]
      )
    ).toThrow();
  });

  test("CHECK status rechaza un valor fuera de activo/anulado", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const userId = insertUser();
    const insuredId = insertInsured();
    expect(() =>
      db!.run(
        "INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, status, created_by, created_at) VALUES (?, 'saldo_a_favor', 1000, 'pendiente', ?, 0)",
        [insuredId, userId]
      )
    ).toThrow();
  });

  test("insured_id NOT NULL — no se puede insertar sin asegurado", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const userId = insertUser();
    expect(() =>
      db!.run(
        "INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, created_by, created_at) VALUES (NULL, 'saldo_a_favor', 1000, ?, 0)",
        [userId]
      )
    ).toThrow();
  });

  test("FK básica: insured_id debe apuntar a un insured existente", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const userId = insertUser();
    expect(() =>
      db!.run(
        "INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, created_by, created_at) VALUES (999999, 'saldo_a_favor', 1000, ?, 0)",
        [userId]
      )
    ).toThrow();
  });

  test("inserción válida funciona", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const userId = insertUser();
    const insuredId = insertInsured();
    db!.run(
      "INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, created_by, created_at) VALUES (?, 'saldo_a_favor', 10000, ?, 0)",
      [insuredId, userId]
    );
    const rows = await client.execute("SELECT * FROM insured_account_movements");
    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as any).status).toBe("activo"); // DEFAULT
  });
});

describe("0030 — payment_amount_adjustments", () => {
  test("crea la tabla", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_amount_adjustments'");
    expect(tables.rows.length).toBe(1);
  });

  test("los índices quedan creados", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const idx = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
    const names = (idx.rows as any[]).map((r) => r.name);
    expect(names).toContain("idx_payment_amount_adjustments_payment_id");
    expect(names).toContain("idx_payment_amount_adjustments_payment_batch_id");
  });

  test("CHECK amount_cents != 0", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const userId = insertUser();
    db!.run(
      "INSERT INTO payments (amount, payment_method, payment_date) VALUES (1000, 'efectivo', '2027-01-01')"
    );
    const paymentId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
    expect(() =>
      db!.run(
        "INSERT INTO payment_amount_adjustments (payment_id, amount_cents, reason, authorized_by, created_by, created_at) VALUES (?, 0, 'motivo', ?, ?, 0)",
        [paymentId, userId, userId]
      )
    ).toThrow();
  });

  test("CHECK XOR: rechaza payment_id y payment_batch_id juntos", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const userId = insertUser();
    const insuredId = insertInsured();
    db!.run("INSERT INTO payments (amount, payment_method, payment_date) VALUES (1000, 'efectivo', '2027-01-01')");
    const paymentId = (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
    const batchId = insertBatch(insuredId, 100000);
    expect(() =>
      db!.run(
        "INSERT INTO payment_amount_adjustments (payment_id, payment_batch_id, amount_cents, reason, authorized_by, created_by, created_at) VALUES (?, ?, 1000, 'motivo', ?, ?, 0)",
        [paymentId, batchId, userId, userId]
      )
    ).toThrow();
  });

  test("CHECK XOR: rechaza ninguno de los dos", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const userId = insertUser();
    expect(() =>
      db!.run(
        "INSERT INTO payment_amount_adjustments (amount_cents, reason, authorized_by, created_by, created_at) VALUES (1000, 'motivo', ?, ?, 0)",
        [userId, userId]
      )
    ).toThrow();
  });

  test("inserción válida con solo payment_batch_id funciona", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const userId = insertUser();
    const insuredId = insertInsured();
    const batchId = insertBatch(insuredId, 100000);
    db!.run(
      "INSERT INTO payment_amount_adjustments (payment_batch_id, amount_cents, reason, authorized_by, created_by, created_at) VALUES (?, -500, 'motivo', ?, ?, 0)",
      [batchId, userId, userId]
    );
    const rows = await client.execute("SELECT * FROM payment_amount_adjustments");
    expect(rows.rows.length).toBe(1);
  });

  test("reason NOT NULL — no se puede insertar sin motivo", async () => {
    const client = await makePreMigrationDb();
    await applyMigration0030InsuredAccountMovements(client);
    const userId = insertUser();
    const insuredId = insertInsured();
    const batchId = insertBatch(insuredId, 100000);
    expect(() =>
      db!.run(
        "INSERT INTO payment_amount_adjustments (payment_batch_id, amount_cents, authorized_by, created_by, created_at) VALUES (?, 1000, ?, ?, 0)",
        [batchId, userId, userId]
      )
    ).toThrow();
  });
});

// ─── Fase 2H — refactor de atomicidad (statements puros vs. BEGIN/COMMIT) ───
// applyMigration0030InsuredAccountMovementsWork es el trabajo puro que un
// futuro apply-0030-prod.ts envolverá con client.transaction("write") de
// Turso — nunca debe emitir control de transacción por sí mismo (a
// diferencia de applyMigration0030InsuredAccountMovements, que sí lo hace,
// pero solo es válido contra bun:sqlite local). Ver comentario de cabecera
// en apply-0030-insured-account-movements.ts.

describe("0030 — applyMigration0030InsuredAccountMovementsWork no controla transacciones", () => {
  function wrapRecording(base: Client): { client: Client; sqlLog: string[] } {
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

  test("no emite BEGIN/COMMIT/ROLLBACK — solo ALTER/UPDATE/CREATE/SELECT/PRAGMA", async () => {
    const base = await makePreMigrationDb();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0030InsuredAccountMovementsWork(client);

    const controlStatements = sqlLog.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql));
    expect(controlStatements).toEqual([]);
  });

  test("el wrapper local (applyMigration0030InsuredAccountMovements) sí emite BEGIN y COMMIT — comportamiento sin cambios", async () => {
    const base = await makePreMigrationDb();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0030InsuredAccountMovements(client);

    expect(sqlLog.some((sql) => /^BEGIN\b/i.test(sql))).toBe(true);
    expect(sqlLog.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
    expect(sqlLog.some((sql) => /^ROLLBACK\b/i.test(sql))).toBe(false); // corrida exitosa, nunca hace rollback
  });

  test("applyMigration0030InsuredAccountMovementsWork funciona igual llamada directa, sin ningún BEGIN/COMMIT alrededor (uso 'crudo', como lo haría un caller que ya gestiona su propia transacción)", async () => {
    const client = await makePreMigrationDb();
    const insuredId = insertInsured();
    insertBatch(insuredId, 100000);

    const summary = await applyMigration0030InsuredAccountMovementsWork(client);
    expect(summary.receivedAmountColumnAdded).toBe(true);
    expect(summary.receivedAmountBackfilledRows).toBe(1);

    const rows = await client.execute("SELECT received_amount_cents, total_received_cents FROM payment_batches");
    expect((rows.rows[0] as any).received_amount_cents).toBe((rows.rows[0] as any).total_received_cents);
  });

  test("es reentrante llamada 2 veces seguidas sin transacción externa (mismo resultado que la versión con BEGIN/COMMIT)", async () => {
    const client = await makePreMigrationDb();
    const insuredId = insertInsured();
    insertBatch(insuredId, 100000);

    const first = await applyMigration0030InsuredAccountMovementsWork(client);
    expect(first.receivedAmountColumnAdded).toBe(true);

    const second = await applyMigration0030InsuredAccountMovementsWork(client);
    expect(second.receivedAmountColumnAdded).toBe(false);
    expect(second.receivedAmountBackfilledRows).toBe(0);
    expect(second.insuredAccountMovementsTableAlreadyExisted).toBe(true);
    expect(second.paymentAmountAdjustmentsTableAlreadyExisted).toBe(true);
  });
});

describe("0030 — estado parcial (una pieza ya existe, otras no)", () => {
  test("insured_account_movements ya existe pero falta la columna y payment_amount_adjustments — completa solo lo que falta, sin error", async () => {
    const client = await makePreMigrationDb();
    // Se crea manualmente la tabla insured_account_movements ANTES de correr
    // la migración (simula un estado parcial real: alguien corrió media
    // migración, o un despliegue previo interrumpido) — mismo esquema exacto
    // que crea la migración, para que la detección de columnas no falle.
    db!.run(`
      CREATE TABLE insured_account_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        insured_id INTEGER NOT NULL REFERENCES insureds(id),
        type TEXT NOT NULL CHECK (type IN ('saldo_a_favor','saldo_deudor','aplicacion_saldo_favor','cobro_saldo_deudor','devolucion_saldo_favor','ajuste_manual')),
        signed_amount_cents INTEGER NOT NULL CHECK (signed_amount_cents != 0),
        status TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','anulado')),
        origin_payment_id INTEGER REFERENCES payments(id),
        origin_batch_id INTEGER REFERENCES payment_batches(id),
        related_payment_id INTEGER REFERENCES payments(id),
        related_installment_id INTEGER REFERENCES policy_installments(id),
        reason TEXT,
        authorized_by INTEGER REFERENCES users(id),
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        notes TEXT
      )
    `);
    const insuredId = insertInsured();
    const userId = insertUser();
    db!.run(
      "INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, created_by, created_at) VALUES (?, 'saldo_a_favor', 5000, ?, 0)",
      [insuredId, userId]
    );
    insertBatch(insuredId, 100000);

    const summary = await applyMigration0030InsuredAccountMovementsWork(client);

    // received_amount_cents y payment_amount_adjustments faltaban -> se completan.
    expect(summary.receivedAmountColumnAdded).toBe(true);
    expect(summary.paymentAmountAdjustmentsTableAlreadyExisted).toBe(false);
    // insured_account_movements ya existía -> se reporta como tal, y NUNCA se recrea.
    expect(summary.insuredAccountMovementsTableAlreadyExisted).toBe(true);

    const paaTables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_amount_adjustments'");
    expect(paaTables.rows.length).toBe(1);
  });

  test("no recrea insured_account_movements si ya existía — la fila cargada antes de migrar sigue intacta", async () => {
    const client = await makePreMigrationDb();
    db!.run(`
      CREATE TABLE insured_account_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        insured_id INTEGER NOT NULL REFERENCES insureds(id),
        type TEXT NOT NULL CHECK (type IN ('saldo_a_favor','saldo_deudor','aplicacion_saldo_favor','cobro_saldo_deudor','devolucion_saldo_favor','ajuste_manual')),
        signed_amount_cents INTEGER NOT NULL CHECK (signed_amount_cents != 0),
        status TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','anulado')),
        origin_payment_id INTEGER REFERENCES payments(id),
        origin_batch_id INTEGER REFERENCES payment_batches(id),
        related_payment_id INTEGER REFERENCES payments(id),
        related_installment_id INTEGER REFERENCES policy_installments(id),
        reason TEXT,
        authorized_by INTEGER REFERENCES users(id),
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        notes TEXT
      )
    `);
    const insuredId = insertInsured();
    const userId = insertUser();
    db!.run(
      "INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, created_by, created_at) VALUES (?, 'saldo_deudor', -3000, ?, 0)",
      [insuredId, userId]
    );

    await applyMigration0030InsuredAccountMovementsWork(client);

    const rows = await client.execute("SELECT * FROM insured_account_movements");
    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as any).signed_amount_cents).toBe(-3000);
  });
});
