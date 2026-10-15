/**
 * Sincronización transaccional de policies.next_rebilling_date en los caminos
 * manuales que escriben refacturaciones desde la ficha (alta, edición, rebuild
 * y borrado) — lib/policies/next-rebilling-sync.ts. Los importadores fueron de
 * carga inicial, no se usan y no se tocan.
 * Corre contra la SQLite local de test (DATABASE_URL=file:…), nunca Turso.
 * Fechas relativas a hoy (la sincronización usa el día real de Argentina).
 * El rollback se fuerza con triggers SQLite temporales (RAISE(ABORT)).
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import { users, sessions, policies, rebillings, policyInstallments, companies, insureds, importLogs } from "../database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { shiftArgentinaMonth, addCalendarDays } from "../../lib/dates/argentina-date";
import { captureNextRebillingBaseline, syncPolicyNextRebillingDate, NextRebillingSyncConflictError } from "../../lib/policies/next-rebilling-sync";

const SESSION_ID = "test-session-next-reb-sync-001";
const USER_EMAIL = "test-next-reb-sync@test.local";
const PREFIX = "TEST-NRSYNC";

let userId: number;
let insuredId: number;
let companyId: number;
const policyIdsToClean: number[] = [];

const d = (k: number, day = "01") => `${shiftArgentinaMonth(k)}-${day}`;
const lastDayBefore = (k: number) => addCalendarDays(d(k), -1);

function headers() {
  return { "x-session-id": SESSION_ID, "Content-Type": "application/json" };
}
async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://localhost/api${path}`, {
    method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

let seq = 0;
async function mkPolicy(over: Partial<typeof policies.$inferInsert> = {}): Promise<number> {
  const [p] = await db.insert(policies).values({
    policyNumber: `${PREFIX}-${Date.now()}-${++seq}`, type: "automotor", status: "activa",
    companyId, insuredId, startDate: d(-6), endDate: d(12), billingCycle: "trimestral",
    nextRebillingDate: null, isRebilling: 0, createdBy: userId, ...over,
  }).returning({ id: policies.id });
  policyIdsToClean.push(p!.id);
  return p!.id;
}
async function mkReb(policyId: number, billingStart: string, billingEnd: string, notes: string | null = null): Promise<number> {
  const [r] = await db.insert(rebillings).values({ policyId, billingStart, billingEnd, premium: 3000, notes, createdBy: userId })
    .returning({ id: rebillings.id });
  return r!.id;
}
async function policyRow(id: number) {
  return (await db.select().from(policies).where(eq(policies.id, id)).get())!;
}
async function rebsOf(policyId: number) {
  return db.select().from(rebillings).where(eq(rebillings.policyId, policyId)).all();
}
async function instsOf(policyId: number) {
  return db.select().from(policyInstallments).where(eq(policyInstallments.policyId, policyId)).all();
}
function fichaBody(billingStart: string, billingEnd: string, extra: Record<string, unknown> = {}) {
  return { billingStart, billingEnd, monthlyFee: 1000, installmentCount: 3, firstDueDate: billingStart, ...extra };
}

// Trigger que aborta cualquier escritura de next_rebilling_date (rollback forzado).
async function withAbortOn(triggerSql: string, fn: () => Promise<void>) {
  await db.run(sql.raw("DROP TRIGGER IF EXISTS test_nrsync_abort"));
  await db.run(sql.raw(triggerSql));
  try { await fn(); } finally { await db.run(sql.raw("DROP TRIGGER IF EXISTS test_nrsync_abort")); }
}
const ABORT_ON_NEXT_DATE =
  "CREATE TRIGGER test_nrsync_abort BEFORE UPDATE OF next_rebilling_date ON policies " +
  "WHEN NEW.next_rebilling_date IS NOT OLD.next_rebilling_date BEGIN SELECT RAISE(ABORT, 'test abort next_rebilling_date'); END";

beforeAll(async () => {
  const prev = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prev) {
    const prevPols = (await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, prev.id)).all()).map((p) => p.id);
    if (prevPols.length) {
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, prevPols)).catch(() => {});
      await db.delete(rebillings).where(inArray(rebillings.policyId, prevPols)).catch(() => {});
      await db.delete(policies).where(inArray(policies.id, prevPols)).catch(() => {});
    }
    await db.delete(importLogs).where(eq(importLogs.createdBy, prev.id)).catch(() => {});
    await db.delete(insureds).where(eq(insureds.createdBy, prev.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prev.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prev.id)).catch(() => {});
  }
  const [u] = await db.insert(users).values({ name: "Test NR Sync", email: USER_EMAIL, password: "x", role: "admin", active: 1 })
    .returning({ id: users.id });
  userId = u!.id;
  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });
  const [ins] = await db.insert(insureds).values({ name: `${PREFIX} Asegurado`, createdBy: userId }).returning({ id: insureds.id });
  insuredId = ins!.id;
  const co = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, `${PREFIX} Co`)).get();
  companyId = co?.id ?? (await db.insert(companies).values({ name: `${PREFIX} Co` }).returning({ id: companies.id }))[0]!.id;
});

afterAll(async () => {
  await db.run(sql.raw("DROP TRIGGER IF EXISTS test_nrsync_abort"));
  const me = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  const created = me ? (await db.select({ id: policies.id }).from(policies).where(eq(policies.createdBy, me.id)).all()).map((p) => p.id) : [];
  const ids = [...new Set([...policyIdsToClean, ...created])];
  if (ids.length) {
    await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, ids)).catch(() => {});
    await db.delete(rebillings).where(inArray(rebillings.policyId, ids)).catch(() => {});
    await db.delete(policies).where(inArray(policies.id, ids)).catch(() => {});
  }
  if (me) {
    await db.delete(importLogs).where(eq(importLogs.createdBy, me.id)).catch(() => {});
    await db.delete(insureds).where(eq(insureds.createdBy, me.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, me.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, me.id)).catch(() => {});
  }
});

// ── Alta desde ficha ──────────────────────────────────────────────────────────

describe("POST /policies/:id/rebillings (ficha)", () => {
  test("guardada NULL + período seguro → escribe la derivada en la misma transacción", async () => {
    const id = await mkPolicy();
    const r = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    expect(r.status).toBe(201);
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "updated", before: null, after: d(2) });
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));
  });

  test("guardada consumida (≤ inicio del período) → se actualiza", async () => {
    const id = await mkPolicy({ nextRebillingDate: d(-1) });
    const r = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "updated", before: d(-1), after: d(2) });
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));
  });

  test("guardada posterior válida → nunca se pisa", async () => {
    const id = await mkPolicy({ nextRebillingDate: d(6) });
    const r = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    expect(r.body.nextRebillingDateSync.status).toBe("kept_explicit");
    expect((await policyRow(id)).nextRebillingDate).toBe(d(6));
  });

  test("fin usado como inicio siguiente (forma b) → la misma fecha de fin, sin ambigüedad", async () => {
    const id = await mkPolicy({ nextRebillingDate: d(-1) });
    const r = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), d(2)));
    expect(r.status).toBe(201);
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "updated", before: d(-1), after: d(2) });
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));
  });

  test("período irregular → no inventa: conserva el dato y devuelve el motivo", async () => {
    const id = await mkPolicy({ nextRebillingDate: d(-1) });
    const r = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), d(1, "20")));
    expect(r.status).toBe(201);
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "review", reason: "periodo_irregular", before: d(-1), after: d(-1) });
    expect(r.body.nextRebillingDateSync.reasonLabel).toBeTruthy();
    expect((await policyRow(id)).nextRebillingDate).toBe(d(-1));
  });

  test("período cargado por adelantado → la fecha que salía del período anterior queda sin respaldo: se limpia e informa revisión", async () => {
    const id = await mkPolicy();
    await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    const r = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(2), lastDayBefore(5)));
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "cleared", before: d(2), after: null, reason: "periodo_futuro_ya_cargado" });
    expect((await policyRow(id)).nextRebillingDate).toBeNull();
  });

  test("período cargado por adelantado con guardada posterior distinta → se conserva", async () => {
    const id = await mkPolicy({ nextRebillingDate: d(7) });
    await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    const r = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(2), lastDayBefore(5)));
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "kept_explicit", after: d(7) });
    expect((await policyRow(id)).nextRebillingDate).toBe(d(7));
  });

  test("período cargado por adelantado sin guardada → a revisar, no escribe", async () => {
    const id = await mkPolicy();
    const r = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(2), lastDayBefore(5)));
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "review", reason: "periodo_futuro_ya_cargado", before: null, after: null });
    expect((await policyRow(id)).nextRebillingDate).toBeNull();
  });

  test("rollback: si falla la escritura de la próxima refacturación, no queda ni la refacturación ni sus cuotas", async () => {
    const id = await mkPolicy({ installments: 2 });
    await withAbortOn(ABORT_ON_NEXT_DATE, async () => {
      const r = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
      expect(r.status).toBe(500);
    });
    expect(await rebsOf(id)).toHaveLength(0);
    expect(await instsOf(id)).toHaveLength(0);
    const p = await policyRow(id);
    expect(p.installments).toBe(2);
    expect(p.nextRebillingDate).toBeNull();
  });
});

// ── Edición (PUT) ─────────────────────────────────────────────────────────────

describe("PUT /rebillings/:id", () => {
  test("metadata: mover el período recalcula (la guardada derivada del período anterior no se trata como explícita)", async () => {
    const id = await mkPolicy();
    const created = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));
    const r = await call("PUT", `/rebillings/${created.body.id}`, { billingStart: d(-2), billingEnd: lastDayBefore(1) });
    expect(r.status).toBe(200);
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "updated", before: d(2), after: d(1) });
    expect((await policyRow(id)).nextRebillingDate).toBe(d(1));
  });

  test("metadata sin cambio de fechas → sin cambios", async () => {
    const id = await mkPolicy();
    const created = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    const r = await call("PUT", `/rebillings/${created.body.id}`, { premium: 5000 });
    expect(r.body.nextRebillingDateSync).toBeNull();
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));
  });

  test("metadata: una guardada posterior que NO salió del período editado se respeta", async () => {
    const id = await mkPolicy({ nextRebillingDate: d(7) });
    const created = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    const r = await call("PUT", `/rebillings/${created.body.id}`, { billingStart: d(-2), billingEnd: lastDayBefore(1) });
    expect(r.body.nextRebillingDateSync.status).toBe("kept_explicit");
    expect((await policyRow(id)).nextRebillingDate).toBe(d(7));
  });

  test("rollback de metadata: el período queda como estaba", async () => {
    const id = await mkPolicy();
    const created = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    await withAbortOn(ABORT_ON_NEXT_DATE, async () => {
      const r = await call("PUT", `/rebillings/${created.body.id}`, { billingStart: d(-2), billingEnd: lastDayBefore(1), premium: 9999 });
      expect(r.status).toBe(500);
    });
    const reb = (await rebsOf(id))[0]!;
    expect([reb.billingStart, reb.billingEnd, reb.premium]).toEqual([d(-1), lastDayBefore(2), null]);
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));
  });

  test("metadata: editar las fechas y volver irregular el período limpia la fecha que dependía de él e informa revisión", async () => {
    const id = await mkPolicy();
    const created = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));
    const r = await call("PUT", `/rebillings/${created.body.id}`, { billingEnd: d(2, "10") });
    expect(r.status).toBe(200);
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "cleared", before: d(2), after: null, kind: "review", reason: "periodo_irregular" });
    expect(r.body.nextRebillingDateSync.reasonLabel).toBeTruthy();
    expect((await policyRow(id)).nextRebillingDate).toBeNull();
  });

  test("metadata: una guardada posterior distinta se conserva aunque el período quede irregular", async () => {
    const id = await mkPolicy({ nextRebillingDate: d(7) });
    const created = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    const r = await call("PUT", `/rebillings/${created.body.id}`, { billingEnd: d(2, "10") });
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "kept_explicit", after: d(7) });
    expect((await policyRow(id)).nextRebillingDate).toBe(d(7));
  });

  test("cambiar solo las notas (sin actividad) no recalcula ni cambia nada", async () => {
    const id = await mkPolicy();
    const rebId = await mkReb(id, d(-1), lastDayBefore(2)); // insertada sin sincronizar: guardada NULL
    const r = await call("PUT", `/rebillings/${rebId}`, { notes: "nota nueva" });
    expect(r.status).toBe(200);
    expect(r.body.nextRebillingDateSync).toBeNull();
    expect((await policyRow(id)).nextRebillingDate).toBeNull();
  });

  test("cambiar solo las notas (grupo con actividad, rama de HEAD) no recalcula ni cambia nada", async () => {
    const id = await mkPolicy();
    const rebId = await mkReb(id, d(-1), lastDayBefore(2));
    await db.insert(policyInstallments).values({ policyId: id, number: 1, dueDate: d(-1), amount: 1000, status: "pagada", rebillingId: rebId });
    const r = await call("PUT", `/rebillings/${rebId}`, { notes: "nota nueva" });
    expect(r.status).toBe(200);
    expect(r.body.nextRebillingDateSync).toBeUndefined();
    expect((await policyRow(id)).nextRebillingDate).toBeNull();
  });

  test("camino legacy (regenera el plan): recalcula y revierte todo ante error", async () => {
    const id = await mkPolicy();
    const created = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    const before = (await instsOf(id)).map((i) => i.id).sort();
    await withAbortOn(ABORT_ON_NEXT_DATE, async () => {
      const r = await call("PUT", `/rebillings/${created.body.id}`, { ...fichaBody(d(-2), lastDayBefore(1)), installmentCount: 2 });
      expect(r.status).toBe(500);
    });
    expect((await instsOf(id)).map((i) => i.id).sort()).toEqual(before);
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));

    const r = await call("PUT", `/rebillings/${created.body.id}`, { ...fichaBody(d(-2), lastDayBefore(1)), installmentCount: 2 });
    expect(r.status).toBe(200);
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "updated", after: d(1) });
  });
});

// ── Rebuild y borrado ─────────────────────────────────────────────────────────

describe("POST /rebillings/:id/installments/rebuild", () => {
  test("recalcula al cambiar el período, y ante error deja cuotas y fecha intactas", async () => {
    const id = await mkPolicy();
    const created = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    const before = (await instsOf(id)).map((i) => i.id).sort();
    await withAbortOn(ABORT_ON_NEXT_DATE, async () => {
      const r = await call("POST", `/rebillings/${created.body.id}/installments/rebuild`, fichaBody(d(-2), lastDayBefore(1), { installmentCount: 2 }));
      expect(r.status).toBe(500);
    });
    expect((await instsOf(id)).map((i) => i.id).sort()).toEqual(before);
    expect((await rebsOf(id))[0]!.billingStart).toBe(d(-1));

    const r = await call("POST", `/rebillings/${created.body.id}/installments/rebuild`, fichaBody(d(-2), lastDayBefore(1), { installmentCount: 2 }));
    expect(r.status).toBe(200);
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "updated", before: d(2), after: d(1) });
    expect((await policyRow(id)).nextRebillingDate).toBe(d(1));
  });
});

describe("DELETE /rebillings/:id", () => {
  test("borrar la única refacturación cuya fecha derivada coincide con la guardada → queda NULL", async () => {
    const id = await mkPolicy();
    const created = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));
    const r = await call("DELETE", `/rebillings/${created.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "cleared", before: d(2), after: null, kind: "review", reason: "sin_refacturaciones" });
    expect((await policyRow(id)).nextRebillingDate).toBeNull();
  });

  test("si lo que queda no da una fecha segura, limpia la fecha sin respaldo e informa el motivo", async () => {
    const id = await mkPolicy();
    await mkReb(id, d(-4), lastDayBefore(-1));
    const cur = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));
    const r = await call("DELETE", `/rebillings/${cur.body.id}`);
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "cleared", reason: "ultimo_periodo_vencido", after: null });
    expect((await policyRow(id)).nextRebillingDate).toBeNull();
  });

  test("borrar dejando otro período seguro reemplaza la fecha por la nueva", async () => {
    // Período duplicado activo: mientras existan los dos, no hay fecha segura.
    const id = await mkPolicy({ nextRebillingDate: d(-1) });
    await mkReb(id, d(-1), lastDayBefore(2));
    const dup = await mkReb(id, d(-1), lastDayBefore(2));
    const r = await call("DELETE", `/rebillings/${dup}`);
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "updated", before: d(-1), after: d(2) });
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));
  });

  test("una guardada posterior distinta se conserva al borrar", async () => {
    const id = await mkPolicy({ nextRebillingDate: d(7) });
    const created = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    const r = await call("DELETE", `/rebillings/${created.body.id}`);
    expect(r.body.nextRebillingDateSync).toMatchObject({ status: "kept_explicit", after: d(7) });
    expect((await policyRow(id)).nextRebillingDate).toBe(d(7));
  });

  test("rollback: si falla la limpieza, la refacturación sigue existiendo y la fecha no cambia", async () => {
    const id = await mkPolicy();
    const created = await call("POST", `/policies/${id}/rebillings`, fichaBody(d(-1), lastDayBefore(2)));
    await withAbortOn(ABORT_ON_NEXT_DATE, async () => {
      const r = await call("DELETE", `/rebillings/${created.body.id}`);
      expect(r.status).toBe(500);
    });
    expect((await rebsOf(id)).some((r) => r.id === created.body.id)).toBe(true);
    expect((await instsOf(id)).length).toBe(3);
    expect((await policyRow(id)).nextRebillingDate).toBe(d(2));
  });
});

// ── Guarda de concurrencia ────────────────────────────────────────────────────

describe("guarda sobre el valor leído (compare-and-set)", () => {
  // Cliente transaccional real, pero el UPDATE con guarda no encuentra la fila
  // (simula que otro proceso cambió next_rebilling_date entre la lectura y la
  // escritura): debe lanzar y revertir TODO lo hecho en la transacción.
  async function runWithLostRace(id: number, mutate: (tx: any) => Promise<void>) {
    let threw: unknown = null;
    try {
      await db.transaction(async (tx) => {
        const proxied = new Proxy(tx, {
          get(target: any, prop) {
            if (prop === "update") return () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) });
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        const today = d(0, "02");
        const baseline = await captureNextRebillingBaseline(tx, id, today);
        await tx.update(policies).set({ notes: "tocada dentro de la tx" }).where(eq(policies.id, id));
        await mutate(tx);
        await syncPolicyNextRebillingDate(proxied, id, { today, baseline });
      });
    } catch (e) { threw = e; }
    return threw;
  }

  test("al escribir una fecha nueva", async () => {
    const id = await mkPolicy();
    await mkReb(id, d(-1), lastDayBefore(2));
    const threw = await runWithLostRace(id, async () => {});
    expect(threw).toBeInstanceOf(NextRebillingSyncConflictError);
    const p = await policyRow(id);
    expect([p.notes, p.nextRebillingDate]).toEqual([null, null]);
  });

  test("al limpiar una fecha sin respaldo (el borrado también se revierte)", async () => {
    const id = await mkPolicy({ nextRebillingDate: d(2) });
    const rebId = await mkReb(id, d(-1), lastDayBefore(2));
    const threw = await runWithLostRace(id, async (tx) => { await tx.delete(rebillings).where(eq(rebillings.id, rebId)); });
    expect(threw).toBeInstanceOf(NextRebillingSyncConflictError);
    const p = await policyRow(id);
    expect([p.notes, p.nextRebillingDate]).toEqual([null, d(2)]);
    expect((await rebsOf(id)).map((r) => r.id)).toEqual([rebId]);
  });
});
