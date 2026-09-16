/**
 * Etapa 1B-3-D — regresión de cancelación: confirma que
 * resolveAccountMovementCancelPlan (account-holder-batch-cancel-plan.ts,
 * extraído SIN cambios de index.ts — ver cabecera de ese archivo) ya trata
 * correctamente los movimientos originados por un batch del modo titular
 * (originBatchId apuntando a un payment_batches con account_holder_insured_id
 * != null), sin necesitar ningún cambio: la función decide únicamente por
 * `type` y por el pool GLOBAL de insured_account_movements del mismo
 * insuredId, nunca por el origen del movimiento.
 *
 * Harness: @libsql/client + drizzle-orm/libsql en modo archivo temporal
 * (mkdtempSync) — nunca dev.db, nunca Turso, nunca importa index.ts (evita
 * abrir la conexión real de database/index.ts). Reutiliza el objeto real
 * `insuredAccountMovements` de database/schema.ts.
 */

import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveAccountMovementCancelPlan } from "../account-holder-batch-cancel-plan";

let tmpDir: string | null = null;
let client: Client | null = null;
let db: any;
let userId: number;
let insuredId: number;

const deferredCleanupDirs: string[] = [];

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

async function seedUserAndInsured(c: Client): Promise<{ userId: number; insuredId: number }> {
  const u = await c.execute(`INSERT INTO users (name) VALUES ('QA Cancel') RETURNING id`);
  const i = await c.execute(`INSERT INTO insureds (name) VALUES ('QA Titular Cancel') RETURNING id`);
  return { userId: Number(u.rows[0]!.id), insuredId: Number(i.rows[0]!.id) };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ahf-cancel-plan-"));
  const dbPath = join(tmpDir, "test.db");
  client = createClient({ url: `file:${dbPath}` });
  await createSchema(client);
  const seeded = await seedUserAndInsured(client);
  userId = seeded.userId;
  insuredId = seeded.insuredId;
  db = drizzle(client);
});

beforeEach(async () => {
  await client!.execute(`DELETE FROM insured_account_movements`);
});

afterAll(async () => {
  client?.close();
  client = null;
  if (!tmpDir) return;
  const dir = tmpDir;
  tmpDir = null;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const ok = await rmDirWithRetries(dir, 30, 200);
  if (ok) return;
  deferredCleanupDirs.push(dir);
  const finalOk = await rmDirWithRetries(dir, 15, 400);
  if (finalOk) {
    deferredCleanupDirs.pop();
    return;
  }
  console.error(
    `[account-holder-batch-cancel-plan.test.ts] No se pudo eliminar el directorio temporal tras reintentos: ${dir}. Requiere limpieza manual. Cola de pendientes: ${JSON.stringify(deferredCleanupDirs)}`
  );
});

async function mkMovement(params: {
  type: string; signedAmountCents: number; status?: "activo" | "anulado"; originBatchId?: number | null; insuredId?: number;
}) {
  const r = await client!.execute({
    sql: `INSERT INTO insured_account_movements (insured_id, type, signed_amount_cents, status, origin_batch_id, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [params.insuredId ?? insuredId, params.type, params.signedAmountCents, params.status ?? "activo", params.originBatchId ?? null, userId, Date.now()],
  });
  const id = Number(r.rows[0]!.id);
  return { id, type: params.type, signedAmountCents: params.signedAmountCents, status: params.status ?? "activo", insuredId: params.insuredId ?? insuredId, originBatchId: params.originBatchId ?? null };
}

const TITULAR_BATCH_ID = 9001; // id sintético — esta función nunca consulta payment_batches, no hace falta que exista.

describe("1. movimientos con forma titular (aplicacion_saldo_favor/saldo_deudor con originBatchId) — anular o bloquear", () => {
  test("aplicacion_saldo_favor titular: SIEMPRE se anula sin chequeo (consumo, nunca bloquea)", async () => {
    const credit = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -50000, originBatchId: TITULAR_BATCH_ID });
    const plan = await resolveAccountMovementCancelPlan(db, [credit]);
    expect(plan.safe).toBe(true);
    expect(plan.blockReasons).toEqual([]);
    expect(plan.movementIdsToVoid).toEqual([credit.id]);
  });

  test("saldo_deudor titular sin siblings: pool alcanza exactamente (thisOrigin = pool completo), se anula", async () => {
    const debt = await mkMovement({ type: "saldo_deudor", signedAmountCents: -8000, originBatchId: TITULAR_BATCH_ID });
    const plan = await resolveAccountMovementCancelPlan(db, [debt]);
    expect(plan.safe).toBe(true);
    expect(plan.movementIdsToVoid).toEqual([debt.id]);
  });

  test("saldo_deudor titular YA cobrado (cobro_saldo_deudor sibling consumió el pool): bloqueado, requiere revisión manual", async () => {
    const debt = await mkMovement({ type: "saldo_deudor", signedAmountCents: -10000, originBatchId: TITULAR_BATCH_ID });
    await mkMovement({ type: "cobro_saldo_deudor", signedAmountCents: 10000 }); // consumió el pool completo
    const plan = await resolveAccountMovementCancelPlan(db, [debt]);
    expect(plan.safe).toBe(false);
    expect(plan.blockReasons.length).toBe(1);
    expect(plan.blockReasons[0]).toContain(String(debt.id));
    expect(plan.movementIdsToVoid).toEqual([]);
  });

  test("saldo_a_favor titular (new_credit_movement) YA consumido por aplicacion_saldo_favor: bloqueado", async () => {
    const newCredit = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 20000, originBatchId: TITULAR_BATCH_ID });
    await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -20000, originBatchId: TITULAR_BATCH_ID + 1 }); // otro batch titular consumiendo el mismo pool
    const plan = await resolveAccountMovementCancelPlan(db, [newCredit]);
    expect(plan.safe).toBe(false);
    expect(plan.movementIdsToVoid).toEqual([]);
  });

  test("saldo_a_favor titular con crédito todavía sin consumir: se anula sin bloqueo", async () => {
    const newCredit = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 20000, originBatchId: TITULAR_BATCH_ID });
    const plan = await resolveAccountMovementCancelPlan(db, [newCredit]);
    expect(plan.safe).toBe(true);
    expect(plan.movementIdsToVoid).toEqual([newCredit.id]);
  });
});

describe("2. pool GLOBAL mezcla legacy y titular — mismo resultado sin importar el origen", () => {
  test("saldo_deudor titular bloqueado por un cobro_saldo_deudor LEGACY (sin originBatchId): el pool no distingue origen", async () => {
    const debtTitular = await mkMovement({ type: "saldo_deudor", signedAmountCents: -5000, originBatchId: TITULAR_BATCH_ID });
    await mkMovement({ type: "cobro_saldo_deudor", signedAmountCents: 5000, originBatchId: null }); // legacy, sin batch titular
    const plan = await resolveAccountMovementCancelPlan(db, [debtTitular]);
    expect(plan.safe).toBe(false);
  });

  test("saldo_a_favor LEGACY consumido por un aplicacion_saldo_favor TITULAR: el pool no distingue origen, igual se bloquea", async () => {
    const newCreditLegacy = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 7000, originBatchId: null });
    await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -7000, originBatchId: TITULAR_BATCH_ID });
    const plan = await resolveAccountMovementCancelPlan(db, [newCreditLegacy]);
    expect(plan.safe).toBe(false);
  });

  test("mezcla legacy+titular, pool suficiente (otro saldo_a_favor cubre el consumo ya hecho): ambos se anulan juntos sin bloqueo", async () => {
    // Otro saldo_a_favor legacy de fondo, ajeno a los 2 movimientos evaluados
    // — sin él, remover legacyCredit dejaría un pool de 0 para explicar los
    // 3000 ya consumidos por titularConsumption (bloqueado correctamente, ver
    // el test anterior de esta sección: la consumición SIEMPRE cuenta contra
    // el pool GLOBAL, sin importar qué otro movimiento se esté evaluando).
    await mkMovement({ type: "saldo_a_favor", signedAmountCents: 5000, originBatchId: null });
    const legacyCredit = await mkMovement({ type: "saldo_a_favor", signedAmountCents: 10000, originBatchId: null });
    const titularConsumption = await mkMovement({ type: "aplicacion_saldo_favor", signedAmountCents: -3000, originBatchId: TITULAR_BATCH_ID });
    const plan = await resolveAccountMovementCancelPlan(db, [legacyCredit, titularConsumption]);
    expect(plan.safe).toBe(true);
    expect(new Set(plan.movementIdsToVoid)).toEqual(new Set([legacyCredit.id, titularConsumption.id]));
  });
});

describe("3. idempotencia y forma", () => {
  test("movimiento ya anulado: no se reevalúa, plan vacío y seguro", async () => {
    const alreadyVoided = await mkMovement({ type: "saldo_deudor", signedAmountCents: -5000, status: "anulado", originBatchId: TITULAR_BATCH_ID });
    const plan = await resolveAccountMovementCancelPlan(db, [alreadyVoided]);
    expect(plan).toEqual({ safe: true, blockReasons: [], movementIdsToVoid: [] });
  });

  test("array vacío: plan vacío y seguro, sin ninguna query de siblings", async () => {
    const plan = await resolveAccountMovementCancelPlan(db, []);
    expect(plan).toEqual({ safe: true, blockReasons: [], movementIdsToVoid: [] });
  });
});
