/**
 * Etapa 1B-4 — tests de loadAccountHolderBalanceSummary (GET
 * /insureds/:id/account-holder-balance).
 *
 * Harness DB: @libsql/client + drizzle-orm/libsql en modo archivo temporal
 * (mkdtempSync) — mismo driver que produce database/index.ts, apuntado a un
 * archivo descartable, nunca a dev.db ni a Turso. Esquema mínimo (solo
 * users/insureds/insured_account_movements, columnas reales de
 * database/schema.ts) — sin drizzle-kit. No importa `app` ni `database`: esta
 * función es un módulo puro-adyacente que recibe el cliente Drizzle
 * inyectado, así que no hace falta el aislamiento de proceso que exige tocar
 * esos singletons (ver cabecera de payment-batch-titular-endpoint.test.ts).
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAccountHolderBalanceSummary } from "../account-holder-balance";

let tmpDir: string | null = null;
let client: Client | null = null;
let db: any;
let userId: number;
let insuredId: number;

async function createSchema(c: Client): Promise<void> {
  await c.execute(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  await c.execute(`CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  await c.execute(`
    CREATE TABLE insured_account_movements (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      insured_id              INTEGER NOT NULL REFERENCES insureds(id),
      type                    TEXT NOT NULL,
      signed_amount_cents     INTEGER NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'activo',
      origin_payment_id       INTEGER,
      origin_batch_id         INTEGER,
      related_payment_id      INTEGER,
      related_installment_id  INTEGER,
      reason                  TEXT,
      authorized_by           INTEGER REFERENCES users(id),
      created_by              INTEGER NOT NULL REFERENCES users(id),
      created_at              INTEGER NOT NULL,
      settled_at              INTEGER,
      notes                   TEXT,
      effective_date          TEXT
    )
  `);
}

async function insertMovement(params: { insuredId: number; type: string; signedAmountCents: number; status: "activo" | "anulado" }): Promise<void> {
  await client!.execute({
    sql: `INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [params.insuredId, params.type, params.signedAmountCents, params.status, userId, Date.now()],
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "account-holder-balance-"));
  const c = createClient({ url: `file:${join(tmpDir, "shared.db")}` });
  client = c;
  await createSchema(c);
  const u = await c.execute(`INSERT INTO users (name) VALUES ('QA') RETURNING id`);
  const i = await c.execute(`INSERT INTO insureds (name) VALUES ('QA titular') RETURNING id`);
  userId = Number(u.rows[0]!.id);
  insuredId = Number(i.rows[0]!.id);
  db = drizzle(c);
});

beforeEach(async () => {
  await client!.execute(`DELETE FROM insured_account_movements`);
});

/** Reintentos con espera — en Windows el handle del archivo sqlite puede tardar un instante en liberarse tras close() (mismo criterio que account-holder-funding-batch.test.ts). */
async function rmDirWithRetries(dir: string, attempts: number, delayMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt === attempts - 1) return false;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

afterAll(async () => {
  client?.close();
  client = null;
  if (!tmpDir) return;
  const dir = tmpDir;
  tmpDir = null;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const ok = await rmDirWithRetries(dir, 30, 200);
  if (!ok) {
    console.error(`[account-holder-balance.test.ts] No se pudo eliminar el directorio temporal tras reintentos: ${dir}. Requiere limpieza manual.`);
  }
}, 20000);

describe("loadAccountHolderBalanceSummary", () => {
  test("asegurado inexistente -> null (el caller lo traduce a 404, nunca saldo=0 silencioso)", async () => {
    const result = await loadAccountHolderBalanceSummary(db, 999999);
    expect(result).toBeNull();
  });

  test("sin movimientos -> saldo 0, crédito disponible 0", async () => {
    const result = await loadAccountHolderBalanceSummary(db, insuredId);
    expect(result).toEqual({ insuredId, balanceCents: 0, availableCreditCents: 0 });
  });

  test("solo movimientos activos -> suma con signo", async () => {
    await insertMovement({ insuredId, type: "saldo_a_favor", signedAmountCents: 150000, status: "activo" });
    await insertMovement({ insuredId, type: "aplicacion_saldo_favor", signedAmountCents: -40000, status: "activo" });
    const result = await loadAccountHolderBalanceSummary(db, insuredId);
    expect(result).toEqual({ insuredId, balanceCents: 110000, availableCreditCents: 110000 });
  });

  test("movimientos anulados nunca se cuentan", async () => {
    await insertMovement({ insuredId, type: "saldo_a_favor", signedAmountCents: 150000, status: "activo" });
    await insertMovement({ insuredId, type: "saldo_a_favor", signedAmountCents: 999999, status: "anulado" });
    const result = await loadAccountHolderBalanceSummary(db, insuredId);
    expect(result).toEqual({ insuredId, balanceCents: 150000, availableCreditCents: 150000 });
  });

  test("saldo negativo (titular deudor) -> availableCreditCents clampeado a 0, balanceCents conserva el signo", async () => {
    await insertMovement({ insuredId, type: "saldo_deudor", signedAmountCents: -50000, status: "activo" });
    const result = await loadAccountHolderBalanceSummary(db, insuredId);
    expect(result).toEqual({ insuredId, balanceCents: -50000, availableCreditCents: 0 });
  });

  test("nunca mezcla el saldo de otro asegurado", async () => {
    const other = await client!.execute(`INSERT INTO insureds (name) VALUES ('Otro') RETURNING id`);
    const otherInsuredId = Number(other.rows[0]!.id);
    await insertMovement({ insuredId, type: "saldo_a_favor", signedAmountCents: 100000, status: "activo" });
    await insertMovement({ insuredId: otherInsuredId, type: "saldo_a_favor", signedAmountCents: 500000, status: "activo" });
    const result = await loadAccountHolderBalanceSummary(db, insuredId);
    expect(result).toEqual({ insuredId, balanceCents: 100000, availableCreditCents: 100000 });
  });
});
