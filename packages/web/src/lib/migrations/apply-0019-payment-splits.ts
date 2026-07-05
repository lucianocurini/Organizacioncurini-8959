// Lógica reutilizable de la migración 0019 (payment_splits).
// Usada tanto por el script local (packages/web/scripts/apply_0019_local.ts)
// como por los tests, contra cualquier cliente compatible con esta interfaz
// (bun:sqlite local hoy; Turso más adelante, cuando exista un script de
// producción — no autorizado todavía en Etapa 3A).
//
// Crea la tabla/índice si faltan (idempotente vía IF NOT EXISTS) y hace
// backfill: por cada payment sin ningún split, inserta exactamente uno
// (method = payments.paymentMethod, amountCents = round(payments.amount*100)).
//
// Toda la función corre dentro de una única transacción real (BEGIN/COMMIT/
// ROLLBACK acá adentro, no responsabilidad del caller) — SQLite soporta DDL
// transaccional, así que un ROLLBACK deshace también la CREATE TABLE/INDEX
// si esta corrida las creó recién. Ningún caller (script local o tests) tiene
// que recordar envolver la llamada — queda garantizado acá.
//
// Decisiones explícitas sobre datos históricos anómalos (no se normalizan
// silenciosamente):
// - amount <= 0 (cero o negativo) → NO backfilleable. amount_cents tiene un
//   CHECK (amount_cents > 0) a nivel de tabla — insertar ahí sería o bien
//   violar el CHECK (si <=0) o mentir sobre un cobro que no existió. Se
//   aborta toda la migración sin insertar nada, listando los payment.id
//   problemáticos, para que se decida manualmente qué hacer con esas filas.
// - paymentMethod vacío → NO backfilleable, mismo motivo: no hay un valor
//   real que copiar. Se aborta igual que el caso anterior.
// - amount con más de dos decimales reales (no representable exactamente en
//   centavos) → TAMPOCO backfilleable. Corregido respecto a una versión
//   anterior que redondeaba silenciosamente con Math.round — eso contradecía
//   la regla "no normalizar datos anómalos". Ahora se detecta con el mismo
//   criterio (isMultipleOfCent, tolerancia 1e-9 para el error de
//   representación binaria de JS) que ya usa validateAndNormalizeSplits para
//   pagos nuevos — la política queda alineada entre altas nuevas y backfill
//   histórico: ambas rechazan una tercera cifra decimal real.
//
// Validación de integridad: no se limita a los payments recién backfilleados
// — todo chequeo posterior (cero splits, suma exacta, amount_cents>0, método
// permitido, splits huérfanos) corre sobre TODA la tabla payment_splits, para
// detectar también inconsistencias preexistentes que esta corrida no generó
// pero que de todos modos vuelven la migración no confiable si están.

import { isMultipleOfCent, isAllowedPaymentMethod } from "../payments/splits";

export interface Sql0019Client {
  execute(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface Migration0019Summary {
  tableAlreadyExisted: boolean;
  paymentsTotal: number;
  paymentsWithSplitsBefore: number;
  paymentsBackfilled: number;
  paymentsWithSplitsAfter: number;
  paymentsWithZeroSplitsAfter: number; // debe ser 0 al terminar
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS payment_splits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  INTEGER NOT NULL REFERENCES payments(id),
  method      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  notes       TEXT,
  created_at  INTEGER
)`.trim();

const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_payment_splits_payment_id
ON payment_splits(payment_id)`.trim();

const EXPECTED_COLUMNS = ["id", "payment_id", "method", "amount_cents", "notes", "created_at"];

async function runMigration(db: Sql0019Client): Promise<Migration0019Summary> {
  const existsBefore = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='payment_splits'"
  );
  const tableAlreadyExisted = existsBefore.rows.length > 0;

  await db.execute(CREATE_TABLE_SQL);
  await db.execute(CREATE_INDEX_SQL);

  const cols = await db.execute("PRAGMA table_info(payment_splits)");
  const colNames = new Set(cols.rows.map((r: any) => r.name));
  const missing = EXPECTED_COLUMNS.filter((c) => !colNames.has(c));
  if (missing.length > 0) {
    throw new Error(
      `payment_splits existe pero le faltan columnas esperadas: ${missing.join(", ")}. ` +
      `Abortando — no se puede confiar en el esquema actual de la tabla.`
    );
  }

  const totalRes = await db.execute("SELECT COUNT(*) as c FROM payments");
  const paymentsTotal = Number(totalRes.rows[0].c);

  const candidatesRes = await db.execute(`
    SELECT p.id as id, p.amount as amount, p.payment_method as paymentMethod
    FROM payments p
    WHERE NOT EXISTS (SELECT 1 FROM payment_splits ps WHERE ps.payment_id = p.id)
  `);
  const candidates = candidatesRes.rows as Array<{ id: number; amount: number; paymentMethod: string | null }>;
  const paymentsWithSplitsBefore = paymentsTotal - candidates.length;

  // ── Paso 1: importes que no se pueden representar exactamente en centavos ──
  // Se revisa ANTES que cualquier otra cosa y ANTES de insertar una sola fila.
  const nonExactCents = candidates.filter((p) => Number.isFinite(p.amount) && !isMultipleOfCent(p.amount));
  if (nonExactCents.length > 0) {
    throw new Error(
      `Backfill abortado — ${nonExactCents.length} payment(s) con importe que no se puede representar ` +
      `exactamente en centavos (más de dos decimales reales). Requieren revisión manual, no se redondean ` +
      `automáticamente:\n` +
      nonExactCents.map((p) => `  - payment ${p.id}: amount=${p.amount}`).join("\n")
    );
  }

  // ── Paso 2: método vacío / amount no finito o <=0 ─────────────────────────
  const failures: string[] = [];
  const toInsert: Array<{ id: number; method: string; amountCents: number }> = [];

  for (const p of candidates) {
    const method = (p.paymentMethod ?? "").trim();
    if (!method) {
      failures.push(`payment ${p.id}: paymentMethod vacío/null — no backfilleable sin inventar un método.`);
      continue;
    }
    if (!Number.isFinite(p.amount)) {
      failures.push(`payment ${p.id}: amount no es un número finito (${p.amount}).`);
      continue;
    }
    const amountCents = Math.round(p.amount * 100);
    if (amountCents <= 0) {
      failures.push(`payment ${p.id}: amount=${p.amount} (amount_cents=${amountCents}) no es backfilleable — violaría CHECK(amount_cents > 0).`);
      continue;
    }
    toInsert.push({ id: p.id, method, amountCents });
  }

  if (failures.length > 0) {
    throw new Error(
      `Backfill abortado — ${failures.length} payment(s) no backfilleable(s) sin decisión manual:\n` +
      failures.map((f) => `  - ${f}`).join("\n")
    );
  }

  // ── Insertar (ya validado: todo lo que sigue debe poder insertarse) ──────
  const nowSeconds = Math.floor(Date.now() / 1000); // mismo formato que $defaultFn(() => new Date()) de Drizzle (segundos, no ms)
  for (const row of toInsert) {
    await db.execute(
      "INSERT INTO payment_splits (payment_id, method, amount_cents, notes, created_at) VALUES (?, ?, ?, NULL, ?)",
      [row.id, row.method, row.amountCents, nowSeconds]
    );
  }

  // ── Verificaciones posteriores sobre TODA la tabla, no solo lo backfilleado ──
  const zeroSplitsRes = await db.execute(`
    SELECT COUNT(*) as c FROM payments p
    WHERE NOT EXISTS (SELECT 1 FROM payment_splits ps WHERE ps.payment_id = p.id)
  `);
  const paymentsWithZeroSplitsAfter = Number(zeroSplitsRes.rows[0].c);
  if (paymentsWithZeroSplitsAfter !== 0) {
    throw new Error(`Integridad violada: ${paymentsWithZeroSplitsAfter} payment(s) quedaron sin ningún split tras el backfill.`);
  }

  // Chequeos más "fundamentales" primero (un split individualmente inválido
  // explica por sí solo cualquier suma incorrecta que produzca) — así el
  // mensaje de error señala la causa raíz, no un síntoma derivado.
  const negativeOrZeroRes = await db.execute("SELECT COUNT(*) as c FROM payment_splits WHERE amount_cents <= 0");
  const negativeOrZero = Number(negativeOrZeroRes.rows[0].c);
  if (negativeOrZero !== 0) {
    throw new Error(`Integridad violada: ${negativeOrZero} fila(s) de payment_splits con amount_cents <= 0.`);
  }

  const allMethodsRes = await db.execute("SELECT DISTINCT method FROM payment_splits");
  const badMethods = allMethodsRes.rows.map((r: any) => r.method as string).filter((m) => !isAllowedPaymentMethod(m));
  if (badMethods.length > 0) {
    throw new Error(`Integridad violada: método(s) no permitido(s) en payment_splits: ${badMethods.join(", ")}`);
  }

  const orphanRes = await db.execute(`
    SELECT COUNT(*) as c FROM payment_splits ps
    WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = ps.payment_id)
  `);
  const orphanCount = Number(orphanRes.rows[0].c);
  if (orphanCount !== 0) {
    throw new Error(`Integridad violada: ${orphanCount} split(s) huérfano(s) sin payment asociado.`);
  }

  const mismatchRes = await db.execute(`
    SELECT p.id as id, p.amount as amount, SUM(ps.amount_cents) as sumCents
    FROM payments p
    JOIN payment_splits ps ON ps.payment_id = p.id
    GROUP BY p.id
    HAVING sumCents != CAST(ROUND(p.amount * 100) AS INTEGER)
  `);
  if (mismatchRes.rows.length > 0) {
    const ids = mismatchRes.rows.map((r: any) => r.id).join(", ");
    throw new Error(`Integridad violada: la suma de splits no coincide con payments.amount en centavos para payment(s): ${ids}`);
  }

  const withSplitsAfterRes = await db.execute("SELECT COUNT(DISTINCT payment_id) as c FROM payment_splits");
  const paymentsWithSplitsAfter = Number(withSplitsAfterRes.rows[0].c);

  return {
    tableAlreadyExisted,
    paymentsTotal,
    paymentsWithSplitsBefore,
    paymentsBackfilled: toInsert.length,
    paymentsWithSplitsAfter,
    paymentsWithZeroSplitsAfter,
  };
}

/**
 * Corre toda la migración (estructura + backfill + verificaciones) dentro de
 * una única transacción real. Si cualquier paso lanza, se hace ROLLBACK y no
 * queda ni la tabla/índice (si esta corrida los creó) ni ningún split a
 * medio insertar — todo o nada.
 */
export async function applyMigration0019PaymentSplits(db: Sql0019Client): Promise<Migration0019Summary> {
  await db.execute("BEGIN");
  let summary: Migration0019Summary;
  try {
    summary = await runMigration(db);
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
  await db.execute("COMMIT");
  return summary;
}
