/**
 * Prueba el aplicador idempotente de la migración 0019 (payment_splits).
 * No existe un backup histórico real pre-0019 (la tabla es nueva), así que
 * se arma una base temporal mínima a mano (solo la tabla payments, tal como
 * existía antes de esta migración) en el scratchpad del sistema — se borra
 * al finalizar. No toca dev.db ni Turso.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyMigration0019PaymentSplits,
  type Sql0019Client,
} from "../../lib/migrations/apply-0019-payment-splits";

function wrapBunSqlite(db: Database): Sql0019Client {
  return {
    async execute(sql: string, params: any[] = []) {
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
        return { rows: db.query(sql).all(...params) as any[] };
      }
      db.query(sql).run(...params);
      return { rows: [] };
    },
  };
}

let tmpDir: string | null = null;
let db: Database | null = null;

afterEach(() => {
  db?.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  db = null;
  tmpDir = null;
});

function makePreMigrationDb(): Sql0019Client {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-0019-test-"));
  const dbPath = join(tmpDir, "pre-0019.db");
  db = new Database(dbPath);
  db.run(`
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmado',
      installment_id INTEGER,
      created_at INTEGER
    )
  `);
  return wrapBunSqlite(db);
}

function insertPayment(amount: number, method: string | null): number {
  db!.run(
    "INSERT INTO payments (amount, payment_method, payment_date, status) VALUES (?, ?, '2027-01-01', 'confirmado')",
    [amount, method]
  );
  return (db!.query("SELECT last_insert_rowid() as id").get() as any).id;
}

// Para probar splits ya existentes (previos a correr la migración), la tabla
// tiene que existir de antemano con la misma forma que crea la migración.
function createPaymentSplitsTableWithCheck() {
  db!.run(`
    CREATE TABLE payment_splits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id  INTEGER NOT NULL REFERENCES payments(id),
      method      TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      notes       TEXT,
      created_at  INTEGER
    )
  `);
}

function insertSplit(paymentId: number, method: string, amountCents: number) {
  db!.run(
    "INSERT INTO payment_splits (payment_id, method, amount_cents, notes, created_at) VALUES (?, ?, ?, NULL, 0)",
    [paymentId, method, amountCents]
  );
}

// Si el fallo ocurre en la misma corrida que creó la tabla (CREATE TABLE
// IF NOT EXISTS todavía no existía antes), el ROLLBACK deshace también la
// tabla — no queda nada, ni siquiera vacía, para consultar directamente.
function paymentSplitsTableExists(client: Sql0019Client) {
  return client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_splits'")
    .then((r) => r.rows.length > 0);
}

describe("1. La migración crea la tabla y el índice", () => {
  test("payment_splits e idx_payment_splits_payment_id aparecen tras correrla sobre una base sin ninguna", async () => {
    const client = makePreMigrationDb();
    await applyMigration0019PaymentSplits(client);

    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_splits'");
    expect(tables.rows.length).toBe(1);
    const indexes = await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_payment_splits_payment_id'");
    expect(indexes.rows.length).toBe(1);
  });
});

describe("2. Backfill de un pago histórico", () => {
  test("un payment sin splits recibe exactamente un split con method/amountCents copiados", async () => {
    const client = makePreMigrationDb();
    insertPayment(1500.5, "efectivo");

    const summary = await applyMigration0019PaymentSplits(client);
    expect(summary.paymentsTotal).toBe(1);
    expect(summary.paymentsBackfilled).toBe(1);
    expect(summary.paymentsWithZeroSplitsAfter).toBe(0);

    const rows = await client.execute("SELECT payment_id, method, amount_cents FROM payment_splits");
    expect(rows.rows).toEqual([{ payment_id: 1, method: "efectivo", amount_cents: 150050 }]);
  });
});

describe("3. Segunda ejecución no duplica", () => {
  test("correr la migración dos veces deja exactamente un split por payment", async () => {
    const client = makePreMigrationDb();
    insertPayment(1000, "transferencia");

    const first = await applyMigration0019PaymentSplits(client);
    expect(first.paymentsBackfilled).toBe(1);

    const second = await applyMigration0019PaymentSplits(client);
    expect(second.paymentsBackfilled).toBe(0);
    expect(second.tableAlreadyExisted).toBe(true);

    const rows = await client.execute("SELECT COUNT(*) as c FROM payment_splits");
    expect(rows.rows[0].c).toBe(1);
  });
});

describe("Anomalías — comportamiento explícito, sin normalizar silenciosamente", () => {
  test("amount = 0 aborta el backfill completo, sin insertar nada", async () => {
    const client = makePreMigrationDb();
    insertPayment(1000, "efectivo"); // backfilleable
    insertPayment(0, "efectivo");    // NO backfilleable

    await expect(applyMigration0019PaymentSplits(client)).rejects.toThrow();

    // Todo o nada: como la tabla se creó recién en esta misma corrida
    // fallida, el ROLLBACK la deshace también — no queda ni vacía.
    expect(await paymentSplitsTableExists(client)).toBe(false);
  });

  test("amount negativo aborta el backfill completo", async () => {
    const client = makePreMigrationDb();
    insertPayment(-500, "efectivo");

    await expect(applyMigration0019PaymentSplits(client)).rejects.toThrow();
    expect(await paymentSplitsTableExists(client)).toBe(false);
  });

  test("paymentMethod vacío aborta el backfill completo", async () => {
    // payment_method es NOT NULL en el esquema real — el caso realista de
    // "vacío" es un string en blanco, no un NULL literal (eso ya lo impide
    // la propia constraint de la tabla).
    const client = makePreMigrationDb();
    insertPayment(1000, "   ");

    await expect(applyMigration0019PaymentSplits(client)).rejects.toThrow();
    expect(await paymentSplitsTableExists(client)).toBe(false);
  });

  test("un pago histórico con 3 decimales reales bloquea el backfill completo (ya NO se redondea silenciosamente)", async () => {
    const client = makePreMigrationDb();
    const goodId = insertPayment(1000, "efectivo");     // representable en centavos
    const badId = insertPayment(100.567, "cheque");     // NO representable exactamente

    let error: any = null;
    try {
      await applyMigration0019PaymentSplits(client);
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeNull();
    // El mensaje debe traer cantidad, IDs e importes originales — no silencioso.
    expect(String(error.message)).toContain("1 payment(s)");
    expect(String(error.message)).toContain(`payment ${badId}`);
    expect(String(error.message)).toContain("100.567");

    // No queda ninguna fila parcial — ni siquiera el payment que sí era válido.
    // La tabla se creó recién en esta corrida fallida, así que el ROLLBACK
    // la deshace también (no queda ni vacía).
    expect(await paymentSplitsTableExists(client)).toBe(false);
    // payments no se tocó (ni el importe, ni se borró nada).
    const payments = await client.execute("SELECT id, amount FROM payments ORDER BY id");
    expect(payments.rows).toEqual([
      { id: goodId, amount: 1000 },
      { id: badId, amount: 100.567 },
    ]);
  });

  test("si la tabla/índice se crean recién en esta corrida y el backfill falla por 3 decimales, el rollback también deshace la CREATE TABLE/INDEX", async () => {
    const client = makePreMigrationDb();
    insertPayment(100.567, "efectivo"); // fuerza el abort

    await expect(applyMigration0019PaymentSplits(client)).rejects.toThrow();

    // payment_splits NUNCA debería quedar creada — todo el CREATE TABLE +
    // CREATE INDEX vive en la misma transacción que el backfill fallido.
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_splits'");
    expect(tables.rows.length).toBe(0);
    const indexes = await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_payment_splits_payment_id'");
    expect(indexes.rows.length).toBe(0);
  });
});

describe("Validación exhaustiva — no se limita a payments recién backfilleados", () => {
  test("un payment con un split existente cuya suma no coincide aborta la migración entera", async () => {
    const client = makePreMigrationDb();
    createPaymentSplitsTableWithCheck();
    const id = insertPayment(1000, "efectivo");
    insertSplit(id, "efectivo", 50000); // debería ser 100000 — suma incompleta

    await expect(applyMigration0019PaymentSplits(client)).rejects.toThrow(/suma de splits no coincide/);
  });

  test("un payment con dos splits existentes cuya suma sí coincide no se toca (no es un error)", async () => {
    const client = makePreMigrationDb();
    createPaymentSplitsTableWithCheck();
    const id = insertPayment(1000, "efectivo");
    insertSplit(id, "efectivo", 40000);
    insertSplit(id, "transferencia", 60000);

    const summary = await applyMigration0019PaymentSplits(client);
    expect(summary.paymentsBackfilled).toBe(0); // ya tenía splits, no se re-backfillea
    expect(summary.paymentsWithZeroSplitsAfter).toBe(0);

    const rows = await client.execute("SELECT COUNT(*) as c FROM payment_splits WHERE payment_id = ?", [id]);
    expect(rows.rows[0].c).toBe(2); // sigue habiendo 2, no se colapsan ni se duplican
  });

  test("un split con método no permitido aborta la migración, aunque la suma coincida", async () => {
    const client = makePreMigrationDb();
    createPaymentSplitsTableWithCheck();
    const id = insertPayment(1000, "efectivo");
    insertSplit(id, "bitcoin", 100000);

    await expect(applyMigration0019PaymentSplits(client)).rejects.toThrow(/método\(s\) no permitido/);
  });

  test("un split con amount_cents <= 0 aborta la migración (defensivo, más allá del CHECK)", async () => {
    const client = makePreMigrationDb();
    // El CHECK real de SQLite se aplica siempre — para poder insertar una
    // fila inválida y probar que la migración la detecta IGUAL (no depende
    // solo del CHECK), se crea la tabla a mano SIN esa constraint, simulando
    // una versión de esquema anterior o una migración manual incompleta.
    db!.run(`
      CREATE TABLE payment_splits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER NOT NULL,
        method TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        notes TEXT,
        created_at INTEGER
      )
    `);
    const id = insertPayment(1000, "efectivo");
    db!.run("INSERT INTO payment_splits (payment_id, method, amount_cents, notes, created_at) VALUES (?, ?, ?, NULL, 0)", [id, "efectivo", 0]);

    await expect(applyMigration0019PaymentSplits(client)).rejects.toThrow(/amount_cents <= 0/);
  });

  test("un split huérfano (payment_id inexistente) aborta la migración", async () => {
    const client = makePreMigrationDb();
    await applyMigration0019PaymentSplits(client); // crea la tabla
    db!.run("INSERT INTO payment_splits (payment_id, method, amount_cents, notes, created_at) VALUES (999999, 'efectivo', 1000, NULL, 0)");

    await expect(applyMigration0019PaymentSplits(client)).rejects.toThrow(/huérfano/);
  });
});
