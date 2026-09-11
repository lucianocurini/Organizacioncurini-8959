/**
 * Prueba el aplicador idempotente de la migración 0036 (titular de cuenta
 * explícito + payment_batch_funding_allocations + idempotencia de
 * financiación). Puramente aditiva — se arma una base temporal en el
 * scratchpad del sistema con el esquema PRE-0036 mínimo necesario (users,
 * insureds, payment_batches, payment_batch_splits,
 * insured_account_movements, payment_amount_adjustments, payments,
 * cash_entries). Se borra al finalizar, incluso si un test falla. No toca
 * dev.db ni Turso.
 *
 * Todos los datos son 100% sintéticos: nombres genéricos ("QA"), sin
 * pólizas, importes ni IDs del caso real.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0036AccountHolderFunding,
  applyMigration0036AccountHolderFundingWork,
  type Sql0036Client,
} from "../../lib/migrations/apply-0036-account-holder-funding";

function wrapBunSqlite(db: Database): Sql0036Client {
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

function makePreMigrationDb(): Sql0036Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0036-test-"));
  const dbPath = join(tmpDir, "pre-0036.db");
  db = new Database(dbPath);
  db.run("PRAGMA foreign_keys=ON");

  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  db.run(`CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  db.run(`
    CREATE TABLE payment_batches (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      insured_id             INTEGER REFERENCES insureds(id),
      base_amount_cents      INTEGER NOT NULL,
      surcharge_amount_cents INTEGER NOT NULL DEFAULT 0,
      total_received_cents   INTEGER NOT NULL,
      payment_date           TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'confirmado',
      created_by             INTEGER REFERENCES users(id),
      created_at             INTEGER,
      received_amount_cents  INTEGER
    )
  `);
  db.run(`
    CREATE TABLE payment_batch_splits (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id     INTEGER NOT NULL REFERENCES payment_batches(id),
      method       TEXT NOT NULL,
      amount_cents INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE insured_account_movements (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      insured_id          INTEGER NOT NULL REFERENCES insureds(id),
      type                TEXT NOT NULL,
      signed_amount_cents INTEGER NOT NULL,
      status              TEXT NOT NULL DEFAULT 'activo',
      created_by          INTEGER NOT NULL REFERENCES users(id),
      created_at          INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE payment_amount_adjustments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id       INTEGER,
      payment_batch_id INTEGER REFERENCES payment_batches(id),
      amount_cents     INTEGER NOT NULL,
      reason           TEXT NOT NULL,
      authorized_by    INTEGER NOT NULL REFERENCES users(id),
      created_by       INTEGER NOT NULL REFERENCES users(id),
      created_at       INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE payments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id       INTEGER REFERENCES payment_batches(id),
      amount         REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_date   TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'confirmado',
      created_at     INTEGER
    )
  `);
  db.run(`
    CREATE TABLE cash_entries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name    TEXT NOT NULL,
      amount         REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_date   TEXT NOT NULL,
      entry_type     TEXT NOT NULL DEFAULT 'normal',
      payment_id     INTEGER REFERENCES payments(id),
      created_at     INTEGER
    )
  `);
  return wrapBunSqlite(db);
}

// ─── Helpers de datos sintéticos ────────────────────────────────────────────

function insertUser(): number {
  return (db!.query(`INSERT INTO users (name) VALUES ('QA') RETURNING id`).get() as any).id;
}
function insertInsured(): number {
  return (db!.query(`INSERT INTO insureds (name) VALUES ('QA') RETURNING id`).get() as any).id;
}
function insertBatch(userId: number): number {
  return (
    db!
      .query(
        `INSERT INTO payment_batches (base_amount_cents, total_received_cents, payment_date, created_by, created_at) VALUES (100000, 100000, '2026-01-01', ?, 0) RETURNING id`
      )
      .get(userId) as any
  ).id;
}
function insertBatchSplit(batchId: number): number {
  return (
    db!.query(`INSERT INTO payment_batch_splits (batch_id, method, amount_cents) VALUES (?, 'efectivo', 1000) RETURNING id`).get(batchId) as any
  ).id;
}
function insertMovement(insuredId: number, userId: number): number {
  return (
    db!
      .query(
        `INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, created_by, created_at) VALUES (?, 'aplicacion_saldo_favor', -1000, ?, 0) RETURNING id`
      )
      .get(insuredId, userId) as any
  ).id;
}
function insertAdjustment(batchId: number, userId: number): number {
  return (
    db!
      .query(
        `INSERT INTO payment_amount_adjustments (payment_batch_id, amount_cents, reason, authorized_by, created_by, created_at) VALUES (?, -300, 'QA', ?, ?, 0) RETURNING id`
      )
      .get(batchId, userId, userId) as any
  ).id;
}
function insertPayment(batchId: number): number {
  return (
    db!.query(`INSERT INTO payments (batch_id, amount, payment_method, payment_date) VALUES (?, 1000, 'lote', '2026-01-01') RETURNING id`).get(batchId) as any
  ).id;
}
function insertCashEntry(): number {
  return (
    db!
      .query(`INSERT INTO cash_entries (client_name, amount, payment_method, payment_date, entry_type) VALUES ('QA', 800, 'lote', '2026-01-01', 'pronto_pago_surcharge') RETURNING id`)
      .get() as any
  ).id;
}

describe("0036 — aplicación exitosa desde estado pre-0036", () => {
  test("agrega las 3 columnas nuevas y las 2 tablas nuevas", async () => {
    const client = makePreMigrationDb();
    const summary = await applyMigration0036AccountHolderFunding(client);

    expect(summary.paymentBatchesColumnAdded).toBe(true);
    expect(summary.insuredAccountMovementsColumnAdded).toBe(true);
    expect(summary.paymentAmountAdjustmentsColumnAdded).toBe(true);
    expect(summary.fundingAllocationsTableCreated).toBe(true);
    expect(summary.idempotencyKeysTableCreated).toBe(true);
    expect(summary.alreadyApplied).toBe(false);
    expect(summary.indexesCreated.length).toBe(16); // 7 simples + 9 únicos parciales
  });
});

describe("0036 — segunda aplicación es no-op (idempotencia)", () => {
  test("no duplica columnas, tablas ni índices; alreadyApplied=true", async () => {
    const client = makePreMigrationDb();
    const first = await applyMigration0036AccountHolderFunding(client);
    expect(first.alreadyApplied).toBe(false);

    const second = await applyMigration0036AccountHolderFunding(client);
    expect(second.alreadyApplied).toBe(true);
    expect(second.paymentBatchesColumnAdded).toBe(false);
    expect(second.insuredAccountMovementsColumnAdded).toBe(false);
    expect(second.paymentAmountAdjustmentsColumnAdded).toBe(false);
    expect(second.fundingAllocationsTableCreated).toBe(false);
    expect(second.idempotencyKeysTableCreated).toBe(false);
    expect(second.indexesCreated).toEqual([]);

    const cols = await client.execute("PRAGMA table_info(payment_batches)");
    expect((cols.rows as any[]).filter((c) => c.name === "account_holder_insured_id").length).toBe(1);
  });
});

describe("0036 — columnas nuevas: tipo y nulabilidad", () => {
  test("payment_batches.account_holder_insured_id es INTEGER nullable", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const cols = (await client.execute("PRAGMA table_info(payment_batches)")).rows as any[];
    const col = cols.find((c) => c.name === "account_holder_insured_id");
    expect(col).toBeDefined();
    expect(col.type).toBe("INTEGER");
    expect(col.notnull).toBe(0);
  });

  test("insured_account_movements.effective_date es TEXT nullable", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const cols = (await client.execute("PRAGMA table_info(insured_account_movements)")).rows as any[];
    const col = cols.find((c) => c.name === "effective_date");
    expect(col).toBeDefined();
    expect(col.type).toBe("TEXT");
    expect(col.notnull).toBe(0);
  });

  test("payment_amount_adjustments.effective_date es TEXT nullable", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const cols = (await client.execute("PRAGMA table_info(payment_amount_adjustments)")).rows as any[];
    const col = cols.find((c) => c.name === "effective_date");
    expect(col).toBeDefined();
    expect(col.type).toBe("TEXT");
    expect(col.notnull).toBe(0);
  });
});

describe("0036 — tablas nuevas existen", () => {
  test("payment_batch_funding_allocations y account_holder_funding_idempotency_keys", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows as any[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("payment_batch_funding_allocations");
    expect(names).toContain("account_holder_funding_idempotency_keys");
  });
});

describe("0036 — índices: 7 simples + 9 UNIQUE parciales", () => {
  test("payment_batch_funding_allocations tiene los 16 índices esperados", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const idx = (await client.execute("PRAGMA index_list(payment_batch_funding_allocations)")).rows as any[];

    const simples = [
      "idx_pbfa_payment_batch_id",
      "idx_pbfa_payment_batch_split_id",
      "idx_pbfa_source_account_movement_id",
      "idx_pbfa_payment_amount_adjustment_id",
      "idx_pbfa_payment_id",
      "idx_pbfa_cash_entry_id",
      "idx_pbfa_destination_account_movement_id",
    ];
    const unicos = [
      "ux_pbfa_split_payment",
      "ux_pbfa_split_cash_entry",
      "ux_pbfa_split_new_credit",
      "ux_pbfa_srcmov_payment",
      "ux_pbfa_srcmov_cash_entry",
      "ux_pbfa_srcmov_new_credit",
      "ux_pbfa_adj_payment",
      "ux_pbfa_adj_cash_entry",
      "ux_pbfa_adj_new_credit",
    ];

    for (const name of simples) {
      const row = idx.find((i) => i.name === name);
      expect(row).toBeDefined();
      expect(row.unique).toBe(0);
    }
    for (const name of unicos) {
      const row = idx.find((i) => i.name === name);
      expect(row).toBeDefined();
      expect(row.unique).toBe(1);
    }
    expect(idx.length).toBe(simples.length + unicos.length);
  });

  test("account_holder_funding_idempotency_keys tiene su índice simple y su UNIQUE compuesto", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const idx = (await client.execute("PRAGMA index_list(account_holder_funding_idempotency_keys)")).rows as any[];
    expect(idx.some((i) => i.name === "idx_ahf_idempotency_batch_id" && i.unique === 0)).toBe(true);
    expect(idx.some((i) => i.unique === 1)).toBe(true); // el UNIQUE(created_by, endpoint, idempotency_key), autogenerado
  });
});

describe("0036 — 9 combinaciones fuente×destino válidas", () => {
  test("cada combinación fuente×destino se inserta sin error", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);

    const userId = insertUser();
    const insuredId = insertInsured();
    const batchId = insertBatch(userId);
    const splitId = insertBatchSplit(batchId);
    const adjustmentId = insertAdjustment(batchId, userId);

    const fuentes: { col: string; makeId: () => number }[] = [
      { col: "payment_batch_split_id", makeId: () => splitId },
      { col: "source_account_movement_id", makeId: () => insertMovement(insuredId, userId) },
      { col: "payment_amount_adjustment_id", makeId: () => adjustmentId },
    ];
    const destinos: { col: string; makeId: () => number }[] = [
      { col: "payment_id", makeId: () => insertPayment(batchId) },
      { col: "cash_entry_id", makeId: () => insertCashEntry() },
      { col: "destination_account_movement_id", makeId: () => insertMovement(insuredId, userId) },
    ];

    for (const fuente of fuentes) {
      for (const destino of destinos) {
        const fuenteId = fuente.makeId();
        const destinoId = destino.makeId();
        expect(() => {
          db!.run(
            `INSERT INTO payment_batch_funding_allocations (payment_batch_id, ${fuente.col}, ${destino.col}, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
            [batchId, fuenteId, destinoId, userId]
          );
        }).not.toThrow();
      }
    }

    const count = (db!.query("SELECT COUNT(*) as c FROM payment_batch_funding_allocations").get() as any).c;
    expect(count).toBe(9);
  });
});

describe("0036 — rechazo de cero o múltiples fuentes", () => {
  test("cero fuentes (las 3 en NULL) es rechazado", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const userId = insertUser();
    const batchId = insertBatch(userId);
    const paymentId = insertPayment(batchId);

    expect(() => {
      db!.run(
        `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, 100, ?, 0)`,
        [batchId, paymentId, userId]
      );
    }).toThrow();
  });

  test("dos fuentes a la vez es rechazado", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const userId = insertUser();
    const insuredId = insertInsured();
    const batchId = insertBatch(userId);
    const splitId = insertBatchSplit(batchId);
    const movementId = insertMovement(insuredId, userId);
    const paymentId = insertPayment(batchId);

    expect(() => {
      db!.run(
        `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, source_account_movement_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, ?, 100, ?, 0)`,
        [batchId, splitId, movementId, paymentId, userId]
      );
    }).toThrow();
  });
});

describe("0036 — rechazo de cero o múltiples destinos", () => {
  test("cero destinos (los 3 en NULL) es rechazado", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const userId = insertUser();
    const batchId = insertBatch(userId);
    const splitId = insertBatchSplit(batchId);

    expect(() => {
      db!.run(
        `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, amount_cents, created_by, created_at) VALUES (?, ?, 100, ?, 0)`,
        [batchId, splitId, userId]
      );
    }).toThrow();
  });

  test("dos destinos a la vez es rechazado", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const userId = insertUser();
    const batchId = insertBatch(userId);
    const splitId = insertBatchSplit(batchId);
    const paymentId = insertPayment(batchId);
    const cashEntryId = insertCashEntry();

    expect(() => {
      db!.run(
        `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, payment_id, cash_entry_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, ?, 100, ?, 0)`,
        [batchId, splitId, paymentId, cashEntryId, userId]
      );
    }).toThrow();
  });
});

describe("0036 — rechazo de amount_cents <= 0", () => {
  test("amount_cents = 0 es rechazado", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const userId = insertUser();
    const batchId = insertBatch(userId);
    const splitId = insertBatchSplit(batchId);
    const paymentId = insertPayment(batchId);

    expect(() => {
      db!.run(
        `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 0, ?, 0)`,
        [batchId, splitId, paymentId, userId]
      );
    }).toThrow();
  });

  test("amount_cents negativo es rechazado", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const userId = insertUser();
    const batchId = insertBatch(userId);
    const splitId = insertBatchSplit(batchId);
    const paymentId = insertPayment(batchId);

    expect(() => {
      db!.run(
        `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, -100, ?, 0)`,
        [batchId, splitId, paymentId, userId]
      );
    }).toThrow();
  });
});

describe("0036 — rechazo de cada UNIQUE parcial (mismo par fuente-destino dos veces)", () => {
  test("las 9 combinaciones fuente×destino rechazan un duplicado exacto", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);

    const userId = insertUser();
    const insuredId = insertInsured();
    const batchId = insertBatch(userId);

    const fuentes: { col: string }[] = [
      { col: "payment_batch_split_id" },
      { col: "source_account_movement_id" },
      { col: "payment_amount_adjustment_id" },
    ];
    const destinos: { col: string }[] = [
      { col: "payment_id" },
      { col: "cash_entry_id" },
      { col: "destination_account_movement_id" },
    ];

    const makeSourceId = (col: string) =>
      col === "payment_batch_split_id"
        ? insertBatchSplit(batchId)
        : col === "source_account_movement_id"
        ? insertMovement(insuredId, userId)
        : insertAdjustment(batchId, userId);
    const makeDestinationId = (col: string) =>
      col === "payment_id" ? insertPayment(batchId) : col === "cash_entry_id" ? insertCashEntry() : insertMovement(insuredId, userId);

    for (const fuente of fuentes) {
      for (const destino of destinos) {
        const fuenteId = makeSourceId(fuente.col);
        const destinoId = makeDestinationId(destino.col);
        db!.run(
          `INSERT INTO payment_batch_funding_allocations (payment_batch_id, ${fuente.col}, ${destino.col}, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
          [batchId, fuenteId, destinoId, userId]
        );
        expect(() => {
          db!.run(
            `INSERT INTO payment_batch_funding_allocations (payment_batch_id, ${fuente.col}, ${destino.col}, amount_cents, created_by, created_at) VALUES (?, ?, ?, 50, ?, 0)`,
            [batchId, fuenteId, destinoId, userId]
          );
        }).toThrow();
      }
    }
  });
});

describe("0036 — rechazo del mismo movimiento como fuente y destino", () => {
  test("source_account_movement_id = destination_account_movement_id es rechazado", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const userId = insertUser();
    const insuredId = insertInsured();
    const batchId = insertBatch(userId);
    const movementId = insertMovement(insuredId, userId);

    expect(() => {
      db!.run(
        `INSERT INTO payment_batch_funding_allocations (payment_batch_id, source_account_movement_id, destination_account_movement_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
        [batchId, movementId, movementId, userId]
      );
    }).toThrow();
  });
});

describe("0036 — idempotencia de financiación: fila completa aceptada", () => {
  test("una fila con los 4 campos obligatorios completos se inserta sin error", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const userId = insertUser();
    const batchId = insertBatch(userId);

    expect(() => {
      db!.run(
        `INSERT INTO account_holder_funding_idempotency_keys (created_by, endpoint, idempotency_key, request_fingerprint, payment_batch_id, response_status, response_snapshot, created_at) VALUES (?, 'POST /payment-batches', 'qa-key-1', 'fingerprint-qa-1', ?, 201, '{"id":1}', 0)`,
        [userId, batchId]
      );
    }).not.toThrow();

    const row = db!.query("SELECT * FROM account_holder_funding_idempotency_keys").get() as any;
    expect(row.idempotency_key).toBe("qa-key-1");
    expect(row.response_status).toBe(201);
  });
});

describe("0036 — rechazo individual de cada NOT NULL de la idempotencia", () => {
  test("faltar cualquiera de los campos obligatorios rechaza el insert", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const userId = insertUser();
    const batchId = insertBatch(userId);

    const fullRow = {
      created_by: userId,
      endpoint: "POST /payment-batches",
      idempotency_key: "qa-key-2",
      request_fingerprint: "fingerprint-qa-2",
      payment_batch_id: batchId,
      response_status: 201,
      response_snapshot: '{"id":1}',
      created_at: 0,
    };
    const requiredFields = Object.keys(fullRow);

    for (const omitted of requiredFields) {
      const fields = requiredFields.filter((f) => f !== omitted);
      const values = fields.map((f) => (fullRow as any)[f]);
      const placeholders = fields.map(() => "?").join(", ");
      expect(() => {
        db!.run(`INSERT INTO account_holder_funding_idempotency_keys (${fields.join(", ")}) VALUES (${placeholders})`, values);
      }).toThrow();
    }
  });
});

describe("0036 — rechazo del UNIQUE de idempotencia", () => {
  test("misma (created_by, endpoint, idempotency_key) dos veces es rechazado", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const userId = insertUser();
    const batchId1 = insertBatch(userId);
    const batchId2 = insertBatch(userId);

    db!.run(
      `INSERT INTO account_holder_funding_idempotency_keys (created_by, endpoint, idempotency_key, request_fingerprint, payment_batch_id, response_status, response_snapshot, created_at) VALUES (?, 'POST /payment-batches', 'qa-key-dup', 'fp-a', ?, 201, '{}', 0)`,
      [userId, batchId1]
    );
    expect(() => {
      db!.run(
        `INSERT INTO account_holder_funding_idempotency_keys (created_by, endpoint, idempotency_key, request_fingerprint, payment_batch_id, response_status, response_snapshot, created_at) VALUES (?, 'POST /payment-batches', 'qa-key-dup', 'fp-b', ?, 201, '{}', 0)`,
        [userId, batchId2]
      );
    }).toThrow();
  });
});

describe("0036 — compatibilidad de filas legacy con effective_date NULL", () => {
  test("una fila de insured_account_movements insertada antes de la migración sigue intacta y sin effective_date", async () => {
    const client = makePreMigrationDb();
    const userId = insertUser();
    const insuredId = insertInsured();
    const legacyId = insertMovement(insuredId, userId);

    await applyMigration0036AccountHolderFunding(client);

    const row = db!.query("SELECT * FROM insured_account_movements WHERE id = ?").get(legacyId) as any;
    expect(row.effective_date).toBeNull();
    expect(row.signed_amount_cents).toBe(-1000);
  });

  test("una fila de payment_amount_adjustments insertada antes de la migración sigue intacta y sin effective_date", async () => {
    const client = makePreMigrationDb();
    const userId = insertUser();
    const batchId = insertBatch(userId);
    const legacyId = insertAdjustment(batchId, userId);

    await applyMigration0036AccountHolderFunding(client);

    const row = db!.query("SELECT * FROM payment_amount_adjustments WHERE id = ?").get(legacyId) as any;
    expect(row.effective_date).toBeNull();
    expect(row.reason).toBe("QA");
  });

  test("insertar effective_date explícito después de la migración funciona", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);
    const userId = insertUser();
    const insuredId = insertInsured();

    db!.run(
      `INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, created_by, created_at, effective_date) VALUES (?, 'saldo_a_favor', 1000, ?, 0, '2026-03-15')`,
      [insuredId, userId]
    );
    const row = db!.query("SELECT effective_date FROM insured_account_movements ORDER BY id DESC LIMIT 1").get() as any;
    expect(row.effective_date).toBe("2026-03-15");
  });
});

describe("0036 — PRAGMA foreign_key_check vacío", () => {
  test("después de poblar todas las tablas con datos sintéticos válidos, sin violaciones de FK", async () => {
    const client = makePreMigrationDb();
    await applyMigration0036AccountHolderFunding(client);

    const userId = insertUser();
    const insuredId = insertInsured();
    const batchId = insertBatch(userId);
    const splitId = insertBatchSplit(batchId);
    const movementSourceId = insertMovement(insuredId, userId);
    const movementDestId = insertMovement(insuredId, userId);
    const adjustmentId = insertAdjustment(batchId, userId);
    const paymentId = insertPayment(batchId);
    const cashEntryId = insertCashEntry();

    db!.run(
      `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
      [batchId, splitId, paymentId, userId]
    );
    db!.run(
      `INSERT INTO payment_batch_funding_allocations (payment_batch_id, source_account_movement_id, cash_entry_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 200, ?, 0)`,
      [batchId, movementSourceId, cashEntryId, userId]
    );
    db!.run(
      `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_amount_adjustment_id, destination_account_movement_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 300, ?, 0)`,
      [batchId, adjustmentId, movementDestId, userId]
    );
    db!.run(
      `INSERT INTO account_holder_funding_idempotency_keys (created_by, endpoint, idempotency_key, request_fingerprint, payment_batch_id, response_status, response_snapshot, created_at) VALUES (?, 'POST /payment-batches', 'qa-fk-check', 'fp', ?, 201, '{}', 0)`,
      [userId, batchId]
    );

    const fk = db!.query("PRAGMA foreign_key_check").all();
    expect(fk).toEqual([]);
  });
});

describe("0036 — PRAGMA foreign_key_check detiene una aplicación con violación preexistente", () => {
  test("falla, el wrapper hace rollback completo y no queda ninguna columna/tabla de 0036 aplicada parcialmente", async () => {
    const client = makePreMigrationDb();

    // Violación FK preexistente, NO originada por esta migración — se crea
    // con foreign_keys=OFF (SQLite no revalida filas ya insertadas al volver
    // a activar el pragma) para simular una base cuya integridad ya estaba
    // comprometida ANTES de aplicar 0036, y confirmar que el aplicador no
    // informa éxito en ese escenario aunque sus propios ALTER/CREATE hayan
    // funcionado bien.
    db!.run("PRAGMA foreign_keys=OFF");
    db!.run(`INSERT INTO payment_batch_splits (batch_id, method, amount_cents) VALUES (999999, 'efectivo', 100)`);
    db!.run("PRAGMA foreign_keys=ON");

    await expect(applyMigration0036AccountHolderFunding(client)).rejects.toThrow(/foreign_key_check|clave foránea/i);

    // Rollback completo: ninguna columna ni tabla nueva de 0036 quedó
    // aplicada — el ALTER TABLE/CREATE TABLE que sí llegaron a ejecutarse
    // antes del chequeo final se deshacen junto con el resto de la
    // transacción.
    const batchCols = (await client.execute("PRAGMA table_info(payment_batches)")).rows as any[];
    expect(batchCols.some((c) => c.name === "account_holder_insured_id")).toBe(false);

    const movementCols = (await client.execute("PRAGMA table_info(insured_account_movements)")).rows as any[];
    expect(movementCols.some((c) => c.name === "effective_date")).toBe(false);

    const adjustmentCols = (await client.execute("PRAGMA table_info(payment_amount_adjustments)")).rows as any[];
    expect(adjustmentCols.some((c) => c.name === "effective_date")).toBe(false);

    const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows as any[];
    const names = tables.map((t) => t.name);
    expect(names).not.toContain("payment_batch_funding_allocations");
    expect(names).not.toContain("account_holder_funding_idempotency_keys");

    // La violación preexistente sigue ahí, intacta — el rollback no borra
    // datos, solo deshace lo que esta migración intentó agregar.
    const dangling = db!.query("SELECT batch_id FROM payment_batch_splits WHERE batch_id = 999999").get() as any;
    expect(dangling).toBeTruthy();
  });
});

describe("0036 — rechazo por padre inexistente en las 11 FKs nuevas/afectadas", () => {
  interface FkBaseline {
    userId: number;
    insuredId: number;
    batchId: number;
    splitId: number;
    sourceMovementId: number;
    destMovementId: number;
    adjustmentId: number;
    paymentId: number;
    cashEntryId: number;
  }
  interface FkCase {
    name: string;
    build: (b: FkBaseline, badId: number) => { sql: string; params: any[] };
  }

  const BAD_ID = 999999;

  function setupFkBaseline(): FkBaseline {
    const userId = insertUser();
    const insuredId = insertInsured();
    const batchId = insertBatch(userId);
    const splitId = insertBatchSplit(batchId);
    const sourceMovementId = insertMovement(insuredId, userId);
    const destMovementId = insertMovement(insuredId, userId);
    const adjustmentId = insertAdjustment(batchId, userId);
    const paymentId = insertPayment(batchId);
    const cashEntryId = insertCashEntry();
    return { userId, insuredId, batchId, splitId, sourceMovementId, destMovementId, adjustmentId, paymentId, cashEntryId };
  }

  // Cada caso cambia ÚNICAMENTE el id del padre bajo prueba a BAD_ID — todo
  // el resto de columnas/FKs de la fila queda con datos válidos de
  // setupFkBaseline(), para que el rechazo sea inequívocamente por esa FK
  // puntual y no por otra causa (CHECK de fuente/destino, NOT NULL, etc.).
  const FK_CASES: FkCase[] = [
    {
      name: "payment_batches.account_holder_insured_id",
      build: (b, bad) => ({
        sql: `INSERT INTO payment_batches (base_amount_cents, total_received_cents, payment_date, created_by, created_at, account_holder_insured_id) VALUES (100, 100, '2026-01-01', ?, 0, ?)`,
        params: [b.userId, bad],
      }),
    },
    {
      name: "payment_batch_funding_allocations.payment_batch_id",
      build: (b, bad) => ({
        sql: `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
        params: [bad, b.splitId, b.paymentId, b.userId],
      }),
    },
    {
      name: "payment_batch_funding_allocations.payment_batch_split_id",
      build: (b, bad) => ({
        sql: `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
        params: [b.batchId, bad, b.paymentId, b.userId],
      }),
    },
    {
      name: "payment_batch_funding_allocations.source_account_movement_id",
      build: (b, bad) => ({
        sql: `INSERT INTO payment_batch_funding_allocations (payment_batch_id, source_account_movement_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
        params: [b.batchId, bad, b.paymentId, b.userId],
      }),
    },
    {
      name: "payment_batch_funding_allocations.payment_amount_adjustment_id",
      build: (b, bad) => ({
        sql: `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_amount_adjustment_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
        params: [b.batchId, bad, b.paymentId, b.userId],
      }),
    },
    {
      name: "payment_batch_funding_allocations.payment_id",
      build: (b, bad) => ({
        sql: `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
        params: [b.batchId, b.splitId, bad, b.userId],
      }),
    },
    {
      name: "payment_batch_funding_allocations.cash_entry_id",
      build: (b, bad) => ({
        sql: `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, cash_entry_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
        params: [b.batchId, b.splitId, bad, b.userId],
      }),
    },
    {
      name: "payment_batch_funding_allocations.destination_account_movement_id",
      build: (b, bad) => ({
        sql: `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, destination_account_movement_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
        params: [b.batchId, b.splitId, bad, b.userId],
      }),
    },
    {
      name: "payment_batch_funding_allocations.created_by",
      build: (b, bad) => ({
        sql: `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, 100, ?, 0)`,
        params: [b.batchId, b.splitId, b.paymentId, bad],
      }),
    },
    {
      name: "account_holder_funding_idempotency_keys.created_by",
      build: (b, bad) => ({
        sql: `INSERT INTO account_holder_funding_idempotency_keys (created_by, endpoint, idempotency_key, request_fingerprint, payment_batch_id, response_status, response_snapshot, created_at) VALUES (?, 'X', 'fk-case-created-by', 'fp', ?, 201, '{}', 0)`,
        params: [bad, b.batchId],
      }),
    },
    {
      name: "account_holder_funding_idempotency_keys.payment_batch_id",
      build: (b, bad) => ({
        sql: `INSERT INTO account_holder_funding_idempotency_keys (created_by, endpoint, idempotency_key, request_fingerprint, payment_batch_id, response_status, response_snapshot, created_at) VALUES (?, 'X', 'fk-case-batch-id', 'fp', ?, 201, '{}', 0)`,
        params: [b.userId, bad],
      }),
    },
  ];

  for (const fkCase of FK_CASES) {
    test(`${fkCase.name}: rechaza un id padre inexistente por FOREIGN KEY (no por otro constraint)`, async () => {
      const client = makePreMigrationDb();
      await applyMigration0036AccountHolderFunding(client);
      const baseline = setupFkBaseline();
      const { sql, params } = fkCase.build(baseline, BAD_ID);

      let thrown: Error | null = null;
      try {
        db!.run(sql, params);
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown).not.toBeNull();
      const message = thrown?.message ?? "";
      expect(message).toMatch(/FOREIGN KEY constraint/i);
      expect(message).not.toMatch(/CHECK constraint|NOT NULL constraint|UNIQUE constraint/i);
    });
  }

  test("cobertura completa: las 11 FKs pedidas están representadas, ni una menos", () => {
    expect(FK_CASES.length).toBe(11);
    expect(new Set(FK_CASES.map((c) => c.name)).size).toBe(11);
  });
});

describe("0036 — paridad estructural permanente entre el SQL crudo y el aplicador", () => {
  const AFFECTED_TABLES = [
    "payment_batches",
    "insured_account_movements",
    "payment_amount_adjustments",
    "payment_batch_funding_allocations",
    "account_holder_funding_idempotency_keys",
  ];

  function buildIsolatedPreMigrationSchema(target: Database): void {
    target.run("PRAGMA foreign_keys=ON");
    target.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
    target.run(`CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
    target.run(`
      CREATE TABLE payment_batches (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        insured_id             INTEGER REFERENCES insureds(id),
        base_amount_cents      INTEGER NOT NULL,
        surcharge_amount_cents INTEGER NOT NULL DEFAULT 0,
        total_received_cents   INTEGER NOT NULL,
        payment_date           TEXT NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'confirmado',
        created_by             INTEGER REFERENCES users(id),
        created_at             INTEGER,
        received_amount_cents  INTEGER
      )
    `);
    target.run(`
      CREATE TABLE payment_batch_splits (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id     INTEGER NOT NULL REFERENCES payment_batches(id),
        method       TEXT NOT NULL,
        amount_cents INTEGER NOT NULL
      )
    `);
    target.run(`
      CREATE TABLE insured_account_movements (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        insured_id          INTEGER NOT NULL REFERENCES insureds(id),
        type                TEXT NOT NULL,
        signed_amount_cents INTEGER NOT NULL,
        status              TEXT NOT NULL DEFAULT 'activo',
        created_by          INTEGER NOT NULL REFERENCES users(id),
        created_at          INTEGER NOT NULL
      )
    `);
    target.run(`
      CREATE TABLE payment_amount_adjustments (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id       INTEGER,
        payment_batch_id INTEGER REFERENCES payment_batches(id),
        amount_cents     INTEGER NOT NULL,
        reason           TEXT NOT NULL,
        authorized_by    INTEGER NOT NULL REFERENCES users(id),
        created_by       INTEGER NOT NULL REFERENCES users(id),
        created_at       INTEGER NOT NULL
      )
    `);
    target.run(`
      CREATE TABLE payments (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id       INTEGER REFERENCES payment_batches(id),
        amount         REAL NOT NULL,
        payment_method TEXT NOT NULL,
        payment_date   TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'confirmado',
        created_at     INTEGER
      )
    `);
    target.run(`
      CREATE TABLE cash_entries (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name    TEXT NOT NULL,
        amount         REAL NOT NULL,
        payment_method TEXT NOT NULL,
        payment_date   TEXT NOT NULL,
        entry_type     TEXT NOT NULL DEFAULT 'normal',
        payment_id     INTEGER REFERENCES payments(id),
        created_at     INTEGER
      )
    `);
  }

  // Nunca compara valores inestables (rootpage, rutas de archivo, rowids
  // internos) — solo columnas/tipos/nulabilidad (table_info), FKs
  // declaradas (foreign_key_list), índices y su unicidad/parcialidad
  // (index_list/index_info), y el SQL de creación normalizado (sin
  // rootpage, whitespace colapsado).
  function structuralSnapshot(target: Database): Record<string, any> {
    const snap: Record<string, any> = {};
    for (const t of AFFECTED_TABLES) {
      snap[`table_info:${t}`] = target.query(`PRAGMA table_info(${t})`).all();
      snap[`foreign_key_list:${t}`] = target.query(`PRAGMA foreign_key_list(${t})`).all();
      const indexList = target.query(`PRAGMA index_list(${t})`).all() as any[];
      snap[`index_list:${t}`] = indexList;
      for (const idx of indexList) {
        snap[`index_info:${t}:${idx.name}`] = target.query(`PRAGMA index_info(${idx.name})`).all();
      }
    }
    const master = target
      .query(
        `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN (${AFFECTED_TABLES.map((t) => `'${t}'`).join(",")}) ORDER BY type, name`
      )
      .all() as any[];
    snap["sqlite_master_normalized"] = master.map((row: any) => ({
      type: row.type,
      name: row.name,
      tbl_name: row.tbl_name,
      sql:
        typeof row.sql === "string"
          ? row.sql
              // Quita comentarios de línea "-- ..." (el .sql crudo los tiene
              // dentro del CREATE TABLE, p.ej. "-- Fuente...", el aplicador
              // nunca los tuvo en su template literal) antes de colapsar
              // whitespace — la comparación es de ESTRUCTURA, nunca de
              // comentarios/indentación.
              .replace(/--[^\n]*/g, " ")
              .replace(/\s+/g, " ")
              .trim()
          : row.sql,
    }));
    return snap;
  }

  async function removeDirWithRetry(dir: string): Promise<void> {
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch (e) {
        // En Windows el handle de SQLite puede tardar en liberarse tras
        // close() — reintentar sin espera (como en un primer intento fallido
        // de esta misma prueba) deja el archivo huérfano; se espera entre
        // intentos, mismo criterio que el afterEach de arriba.
        if (attempt === 14) throw e;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  test("el .sql crudo (leído del archivo real) y el aplicador producen el mismo esquema en las 5 tablas afectadas", async () => {
    // Lectura robusta y multiplataforma: import.meta.dir (no __dirname, que
    // no existe en módulos ESM) + path.join, nunca una ruta armada a mano
    // con separadores de un solo SO.
    const sqlPath = join(import.meta.dir, "..", "migrations", "0036_account_holder_funding.sql");
    const rawSql = readFileSync(sqlPath, "utf-8");

    const localTmpDir = mkdtempSync(join(tmpdir(), "migration-0036-parity-test-"));
    const dbA = new Database(join(localTmpDir, "a.db"));
    const dbB = new Database(join(localTmpDir, "b.db"));
    try {
      buildIsolatedPreMigrationSchema(dbA);
      buildIsolatedPreMigrationSchema(dbB);

      // DB A — SQL crudo, vía la capacidad multi-statement NATIVA de
      // bun:sqlite (Database.exec), nunca un parser de ';' artesanal.
      dbA.exec(rawSql);

      // DB B — aplicador productivo real (el mismo import de arriba).
      await applyMigration0036AccountHolderFunding(wrapBunSqlite(dbB));

      const snapA = structuralSnapshot(dbA);
      const snapB = structuralSnapshot(dbB);
      const keys = new Set([...Object.keys(snapA), ...Object.keys(snapB)]);
      for (const key of keys) {
        expect(snapB[key]).toEqual(snapA[key]);
      }
    } finally {
      dbA.close();
      dbB.close();
      await removeDirWithRetry(localTmpDir);
    }
  });
});

// ─── Work vs. wrapper local — no controla transacciones por sí misma ────────
describe("0036 — applyMigration0036AccountHolderFundingWork no controla transacciones", () => {
  function wrapRecording(base: Sql0036Client): { client: Sql0036Client; sqlLog: string[] } {
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

    await applyMigration0036AccountHolderFundingWork(client);

    const controlStatements = sqlLog.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql));
    expect(controlStatements).toEqual([]);
  });

  test("el wrapper local sí emite BEGIN y COMMIT", async () => {
    const base = makePreMigrationDb();
    const { client, sqlLog } = wrapRecording(base);

    await applyMigration0036AccountHolderFunding(client);

    expect(sqlLog.some((sql) => /^BEGIN\b/i.test(sql))).toBe(true);
    expect(sqlLog.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
  });
});
