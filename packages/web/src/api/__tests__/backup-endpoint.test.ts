/**
 * Tests de GET /api/backup (backup manual, admin only) — corre exclusivamente
 * contra dev.db local (nunca Turso). Verifica que sigue admin-only, que ahora
 * usa el helper compartido de packages/web/src/api/backup/full-backup.ts (las
 * mismas tablas críticas que antes faltaban: remittances, payment_batches,
 * received_checks, etc — ver diagnóstico previo, GET /backup exportaba solo
 * 14/28 tablas) y que sigue sin filtrar password de users.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import { users, sessions } from "../database/schema";
import { eq } from "drizzle-orm";
import { EXPECTED_BUSINESS_TABLES, validateFullBackup } from "../backup/full-backup";

const ADMIN_SESSION_ID = "test-session-backup-admin-001";
const ADMIN_EMAIL = "test-backup-admin@test.local";
const NON_ADMIN_SESSION_ID = "test-session-backup-nonadmin-001";
const NON_ADMIN_EMAIL = "test-backup-nonadmin@test.local";

let adminUserId: number;
let nonAdminUserId: number;

async function purgeStaleUser(email: string) {
  const prev = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  if (!prev) return;
  await db.delete(sessions).where(eq(sessions.userId, prev.id));
  await db.delete(users).where(eq(users.id, prev.id));
}

beforeAll(async () => {
  await purgeStaleUser(ADMIN_EMAIL);
  await purgeStaleUser(NON_ADMIN_EMAIL);

  const [admin] = await db.insert(users).values({
    name: "Test Backup Admin", email: ADMIN_EMAIL, password: "hashed-dummy", role: "admin", active: 1,
  }).returning({ id: users.id });
  adminUserId = admin!.id;
  await db.insert(sessions).values({ id: ADMIN_SESSION_ID, userId: adminUserId, expiresAt: new Date(Date.now() + 86400000) });

  const [nonAdmin] = await db.insert(users).values({
    name: "Test Backup NonAdmin", email: NON_ADMIN_EMAIL, password: "hashed-dummy", role: "user", active: 1,
  }).returning({ id: users.id });
  nonAdminUserId = nonAdmin!.id;
  await db.insert(sessions).values({ id: NON_ADMIN_SESSION_ID, userId: nonAdminUserId, expiresAt: new Date(Date.now() + 86400000) });
});

afterAll(async () => {
  await db.delete(sessions).where(eq(sessions.id, ADMIN_SESSION_ID));
  await db.delete(sessions).where(eq(sessions.id, NON_ADMIN_SESSION_ID));
  await db.delete(users).where(eq(users.id, adminUserId));
  await db.delete(users).where(eq(users.id, nonAdminUserId));
});

async function callBackup(sessionId?: string) {
  const headers: Record<string, string> = {};
  if (sessionId) headers["x-session-id"] = sessionId;
  const res = await app.fetch(new Request("http://localhost/api/backup", { headers }));
  return res;
}

describe("GET /api/backup — autorización", () => {
  test("sin sesión devuelve 401", async () => {
    const res = await callBackup();
    expect(res.status).toBe(401);
  });

  test("con sesión de usuario no-admin devuelve 403", async () => {
    const res = await callBackup(NON_ADMIN_SESSION_ID);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/backup — contenido del backup completo", () => {
  test("admin recibe 200 con Content-Disposition de archivo .json con el nombre nuevo", async () => {
    const res = await callBackup(ADMIN_SESSION_ID);
    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("organizacion-curini-full-backup-");
    expect(disposition).toContain(".json");
  });

  test("incluye las tablas críticas que el endpoint anterior dejaba afuera", async () => {
    const res = await callBackup(ADMIN_SESSION_ID);
    const body = await res.json();
    const tableNames = Object.keys(body.tables);
    for (const critical of [
      "remittances", "remittance_items", "remittance_allocations",
      "payment_batches", "payment_splits", "received_checks", "cash_entries",
    ]) {
      expect(tableNames).toContain(critical);
    }
  });

  test("incluye todas las tablas de negocio esperadas y ninguna excluida", async () => {
    const res = await callBackup(ADMIN_SESSION_ID);
    const body = await res.json();
    const tableNames = Object.keys(body.tables);
    for (const expected of EXPECTED_BUSINESS_TABLES) expect(tableNames).toContain(expected);
    expect(tableNames).not.toContain("sessions");
    expect(tableNames.some((t) => t.endsWith("_new"))).toBe(false);
  });

  test("users no incluye password/hash", async () => {
    const res = await callBackup(ADMIN_SESSION_ID);
    const body = await res.json();
    expect(body.tables.users.columns).not.toContain("password");
    for (const row of body.tables.users.rows) {
      expect(row).not.toHaveProperty("password");
    }
  });

  test("metadata: environment, databaseMasked, tableCount, totalRows, foreignKeyCheck presentes y coherentes", async () => {
    const res = await callBackup(ADMIN_SESSION_ID);
    const body = await res.json();
    expect(typeof body.environment).toBe("string");
    expect(typeof body.databaseMasked).toBe("string");
    expect(body.tableCount).toBe(Object.keys(body.tables).length);
    // No asserta 0: dev.db puede tener violaciones preexistentes de corridas
    // anteriores (no bloquean el backup, ver validateFullBackup) — solo que
    // el campo tiene la forma correcta.
    expect(typeof body.foreignKeyCheck.violations).toBe("number");
    expect(Array.isArray(body.foreignKeyCheck.details)).toBe(true);
    expect(typeof body.totalRows).toBe("number");
  });

  test("el payload completo pasa validateFullBackup (mismo helper que usa el script)", async () => {
    const res = await callBackup(ADMIN_SESSION_ID);
    const body = await res.json();
    const validation = validateFullBackup(body, EXPECTED_BUSINESS_TABLES);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});
