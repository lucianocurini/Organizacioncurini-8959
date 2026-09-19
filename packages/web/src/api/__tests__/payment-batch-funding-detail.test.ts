/**
 * Etapa 1B-4 — loadBatchFundingDetail (parte de GET /payment-batches/:id).
 * SQLite temporal (libsql en archivo descartable), esquema mínimo con las
 * columnas reales de payment_batch_funding_allocations. Datos 100% sintéticos.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadBatchFundingDetail } from "../payment-batch-funding-detail";

let tmpDir: string | null = null;
let client: Client | null = null;
let db: any;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "batch-funding-detail-"));
  const c = createClient({ url: `file:${join(tmpDir, "shared.db")}` });
  client = c;
  await c.execute(`CREATE TABLE insureds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  await c.execute(`
    CREATE TABLE payment_batch_funding_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_batch_id INTEGER NOT NULL,
      payment_batch_split_id INTEGER,
      source_account_movement_id INTEGER,
      payment_amount_adjustment_id INTEGER,
      payment_id INTEGER,
      cash_entry_id INTEGER,
      destination_account_movement_id INTEGER,
      amount_cents INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await c.execute(`INSERT INTO insureds (id, name) VALUES (7, 'QA Titular Sintético')`);
  const rows: Array<[number, number | null, number | null, number | null, number, number]> = [
    [1, null, 90, null, 30000, 10],
    [1, null, null, 5, 300, 10],
    [1, 4, null, null, 69700, 10],
    [2, 5, null, null, 999, 11],
  ];
  for (const [batchId, splitId, srcMov, adj, cents, paymentId] of rows) {
    await c.execute({
      sql: `INSERT INTO payment_batch_funding_allocations (payment_batch_id, payment_batch_split_id, source_account_movement_id, payment_amount_adjustment_id, payment_id, amount_cents, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
      args: [batchId, splitId, srcMov, adj, paymentId, cents],
    });
  }
  db = drizzle(c);
});

/** En Windows el handle del archivo sqlite puede tardar un instante en liberarse tras close(). */
async function rmDirWithRetries(dir: string, attempts: number, delayMs: number): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === attempts - 1) console.error(`[payment-batch-funding-detail.test.ts] No se pudo eliminar ${dir}; requiere limpieza manual.`);
      else await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

afterAll(async () => {
  client?.close();
  client = null;
  if (!tmpDir) return;
  const dir = tmpDir;
  tmpDir = null;
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rmDirWithRetries(dir, 30, 200);
});

describe("loadBatchFundingDetail", () => {
  test("batch legacy (accountHolderInsuredId null): sin titular y sin allocations", async () => {
    expect(await loadBatchFundingDetail(db, 1, null)).toEqual({ accountHolder: null, fundingAllocations: [] });
  });

  test("batch titular: devuelve el titular y solo las allocations de ese batch, en orden, sumando el aplicado", async () => {
    const r = await loadBatchFundingDetail(db, 1, 7);
    expect(r.accountHolder).toEqual({ id: 7, name: "QA Titular Sintético" });
    expect(r.fundingAllocations.map((a) => a.amountCents)).toEqual([30000, 300, 69700]);
    expect(r.fundingAllocations.reduce((s, a) => s + a.amountCents, 0)).toBe(100000);
    expect(r.fundingAllocations[2]!.paymentBatchSplitId).toBe(4);
  });

  test("titular inexistente: accountHolder null, allocations igual se devuelven", async () => {
    const r = await loadBatchFundingDetail(db, 1, 999);
    expect(r.accountHolder).toBeNull();
    expect(r.fundingAllocations.length).toBe(3);
  });
});
