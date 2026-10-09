/**
 * GET /api/cash/expenses?month=YYYY-MM (listado de Cobranzas → Gastos) y su
 * aislamiento respecto de Caja. Corre contra la SQLite de DATABASE_URL
 * (nunca Turso). Las fixtures usan meses lejanos (2031/2032) e IDs propios
 * para no depender de otras filas: el listado se compara por los IDs de este
 * archivo y Caja por igualdad completa antes/después.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import { users, sessions, cashExpenses } from "../database/schema";
import { eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";

const ADMIN_SESSION = "test-session-expenses-month-admin";
const USER_SESSION = "test-session-expenses-month-user";
const ADMIN_EMAIL = "test-expenses-month-admin@test.local";
const USER_EMAIL = "test-expenses-month-user@test.local";
const PREFIX = "TEST-EXPENSES-MONTH";

let adminId: number;
let userId: number;
const fixtureIds: number[] = [];

async function getJson(path: string, session = ADMIN_SESSION, init: RequestInit = {}) {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    ...init, headers: { "x-session-id": session, "Content-Type": "application/json" },
  }));
  return { status: res.status, body: await res.json() as any };
}

async function mkExpense(values: { date: string; amount: number; type?: string; status?: string; description?: string }) {
  const [row] = await db.insert(cashExpenses).values({
    date: values.date, description: values.description ?? `${PREFIX} ${values.date}`, amount: values.amount,
    type: values.type ?? "gasto_operativo", paymentMethod: "efectivo", status: values.status ?? "registrado", createdBy: adminId,
  }).returning({ id: cashExpenses.id });
  fixtureIds.push(row!.id);
  return row!.id;
}

const mine = (rows: any[]) => rows.filter((r) => typeof r.description === "string" && r.description.startsWith(PREFIX));

async function purge() {
  const stale = await db.select({ id: cashExpenses.id, description: cashExpenses.description }).from(cashExpenses).all();
  const ids = stale.filter((r) => r.description.startsWith(PREFIX)).map((r) => r.id);
  if (ids.length) await db.delete(cashExpenses).where(inArray(cashExpenses.id, ids));
  for (const email of [ADMIN_EMAIL, USER_EMAIL]) {
    const u = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    if (u) {
      await db.delete(sessions).where(eq(sessions.userId, u.id));
      await db.delete(users).where(eq(users.id, u.id));
    }
  }
}

beforeAll(async () => {
  await purge();
  const [a] = await db.insert(users).values({ name: "Test Expenses Admin", email: ADMIN_EMAIL, password: "x", role: "admin", active: 1 }).returning({ id: users.id });
  adminId = a!.id;
  const [u] = await db.insert(users).values({ name: "Test Expenses User", email: USER_EMAIL, password: "x", role: "user", active: 1 }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: ADMIN_SESSION, userId: adminId, expiresAt: new Date(Date.now() + 86400000) });
  await db.insert(sessions).values({ id: USER_SESSION, userId, expiresAt: new Date(Date.now() + 86400000) });

  // Diciembre 2031: primer y último día + un sueldo + un anulado.
  await mkExpense({ date: "2031-12-01", amount: 100 });
  await mkExpense({ date: "2031-12-31", amount: 200.5 });
  await mkExpense({ date: "2031-12-15", amount: 1000, type: "sueldo" });
  await mkExpense({ date: "2031-12-20", amount: 777, status: "anulado" });
  // Fuera del período, pegados al borde: 30/11 y 01/01 del año siguiente.
  await mkExpense({ date: "2031-11-30", amount: 40 });
  await mkExpense({ date: "2032-01-01", amount: 60 });
  // Febrero 2032 sin gastos (mes vacío).
});

afterAll(async () => {
  if (fixtureIds.length) await db.delete(cashExpenses).where(inArray(cashExpenses.id, fixtureIds));
  await purge();
});

describe("GET /api/cash/expenses?month=", () => {
  test("mes: intervalo [01, 01 del mes siguiente) — incluye primer y último día, excluye bordes ajenos y anulados", async () => {
    const { status, body } = await getJson("/api/cash/expenses?month=2031-12");
    expect(status).toBe(200);
    const dates = mine(body).map((r: any) => r.date).sort();
    expect(dates).toEqual(["2031-12-01", "2031-12-15", "2031-12-31"]);
    expect(mine(body).every((r: any) => r.status !== "anulado")).toBe(true);
    // Todo lo devuelto (de este u otros archivos) pertenece al mes.
    expect(body.every((r: any) => r.date >= "2031-12-01" && r.date < "2032-01-01")).toBe(true);
  });

  test("enero del año siguiente y noviembre anterior: cada borde en su mes", async () => {
    const jan = mine((await getJson("/api/cash/expenses?month=2032-01")).body).map((r: any) => r.date);
    const nov = mine((await getJson("/api/cash/expenses?month=2031-11")).body).map((r: any) => r.date);
    expect(jan).toEqual(["2032-01-01"]);
    expect(nov).toEqual(["2031-11-30"]);
  });

  test("mes vacío → []", async () => {
    const { status, body } = await getJson("/api/cash/expenses?month=2032-02");
    expect(status).toBe(200);
    expect(mine(body)).toEqual([]);
  });

  test("sin parámetro y ?month=all → histórico (mismas filas)", async () => {
    const none = (await getJson("/api/cash/expenses")).body;
    const all = (await getJson("/api/cash/expenses?month=all")).body;
    expect(mine(none).map((r: any) => r.id).sort()).toEqual(mine(all).map((r: any) => r.id).sort());
    expect(mine(none).map((r: any) => r.date).sort()).toEqual(["2031-11-30", "2031-12-01", "2031-12-15", "2031-12-31", "2032-01-01"]);
  });

  test("parámetro inválido → 400 (nunca se ignora en silencio)", async () => {
    for (const bad of ["2031-13", "2031-00", "2031-1", "31-12", "2031-12-01", "abc", "", "ALL", "2031-12%20"]) {
      const { status, body } = await getJson(`/api/cash/expenses?month=${bad}`);
      expect({ bad, status }).toEqual({ bad, status: 400 });
      expect(body.error).toContain("month inválido");
    }
  });

  test("se combina con los filtros existentes: usuario no admin no ve sueldos; nadie ve anulados", async () => {
    const userRows = mine((await getJson("/api/cash/expenses?month=2031-12", USER_SESSION)).body);
    expect(userRows.map((r: any) => r.date).sort()).toEqual(["2031-12-01", "2031-12-31"]);
    expect(userRows.every((r: any) => r.type === "gasto_operativo")).toBe(true);
    const adminRows = mine((await getJson("/api/cash/expenses?month=2031-12")).body);
    expect(adminRows.some((r: any) => r.type === "sueldo")).toBe(true);
  });

  test("sin paginación: un mes con 150 gastos devuelve los 150 y el total los suma todos", async () => {
    const ids: number[] = [];
    try {
      for (let i = 0; i < 150; i++) ids.push(await mkExpense({ date: `2033-03-${String((i % 28) + 1).padStart(2, "0")}`, amount: 10.01 }));
      const rows = mine((await getJson("/api/cash/expenses?month=2033-03")).body);
      expect(rows.length).toBe(150);
      const cents = rows.reduce((s: number, r: any) => s + Math.round(r.amount * 100), 0);
      expect(cents).toBe(150 * 1001);
    } finally {
      await db.delete(cashExpenses).where(inArray(cashExpenses.id, ids));
    }
  });

  test("alta, edición a otro mes y anulación se reflejan en el listado del mes", async () => {
    const created = await getJson("/api/cash/expenses", ADMIN_SESSION, {
      method: "POST", body: JSON.stringify({ date: "2032-02-10", description: `${PREFIX} alta`, amount: 50 }),
    });
    expect(created.status).toBe(201);
    fixtureIds.push(created.body.id);
    expect(mine((await getJson("/api/cash/expenses?month=2032-02")).body).map((r: any) => r.id)).toEqual([created.body.id]);

    const edited = await getJson(`/api/cash/expenses/${created.body.id}`, ADMIN_SESSION, {
      method: "PUT", body: JSON.stringify({ date: "2032-03-05", description: `${PREFIX} alta`, amount: 50 }),
    });
    expect(edited.status).toBe(200);
    expect(mine((await getJson("/api/cash/expenses?month=2032-02")).body)).toEqual([]);
    expect(mine((await getJson("/api/cash/expenses?month=2032-03")).body).map((r: any) => r.id)).toEqual([created.body.id]);

    const del = await getJson(`/api/cash/expenses/${created.body.id}`, ADMIN_SESSION, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(mine((await getJson("/api/cash/expenses?month=2032-03")).body)).toEqual([]);
  });
});

describe("Caja no depende del mes elegido en Cobranzas → Gastos", () => {
  test("consultar Gastos por distintos meses no cambia /cash/summary (histórico ni período propio)", async () => {
    const summaryPaths = ["/api/cash/summary", "/api/cash/summary?month=2031-12", "/api/cash/summary?month=2032-01"];
    const before = await Promise.all(summaryPaths.map(async (p) => (await getJson(p)).body));
    for (const m of ["2031-11", "2031-12", "2032-01", "2032-02", "all"]) {
      expect((await getJson(`/api/cash/expenses?month=${m}`)).status).toBe(200);
    }
    const after = await Promise.all(summaryPaths.map(async (p) => (await getJson(p)).body));
    expect(after).toEqual(before);
    // Y el período propio de Caja sigue contando sus gastos como antes
    // (diciembre: 100 + 200,50 + 1000 de sueldo; el anulado lo trata Caja con
    // su propia regla, sin cambios).
    expect(before[1].periodo.gastos).toBeGreaterThanOrEqual(1300.5);
  });

  test("Caja sigue pidiendo el histórico completo (GET /api/cash/expenses sin month)", async () => {
    const src = readFileSync(new URL("../../web/pages/caja.tsx", import.meta.url), "utf8");
    expect(src).toContain('api.get("/api/cash/expenses")');
    expect(src).not.toMatch(/\/api\/cash\/expenses\?month=/);
  });
});
