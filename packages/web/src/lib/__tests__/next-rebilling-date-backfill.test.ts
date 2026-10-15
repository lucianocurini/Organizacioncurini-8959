// Backfill de policies.next_rebilling_date (lib/backfill/next-rebilling-date-backfill.ts)
// contra una SQLite temporal propia (os.tmpdir(), nunca el repo ni Turso).
// Casos seguros sintéticos (períodos leídos por su forma matemática; la
// columna notes existe como en producción pero nunca decide) más un caso por
// cada exclusión obligatoria. Sin cantidad fija: la aplicación exige la
// cantidad y la huella del dry-run aprobado.
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planNextRebillingDateBackfill,
  applyNextRebillingDateBackfill,
  checkNextRebillingBackfillPreconditions,
  NextRebillingBackfillAbortError,
  type NextRebillingBackfillClient,
} from "../backfill/next-rebilling-date-backfill";

const TODAY = "2026-10-14";
const EN_V2 = "Importado de El Norte v2. Prórroga endoso 1";
const RIV = "Importado de Rivadavia";

let dir: string;
let client: Client;
const dirs: string[] = [];

type P = { id: number; status?: string; end?: string; cycle?: string | null; next?: string | null };
type R = { policyId: number; start: string; end: string; notes?: string | null; status?: string };

const POLICIES: P[] = [];
const REBILLINGS: R[] = [];
const ELIGIBLE_IDS: number[] = [];
const EXCLUDED: Record<string, number> = {};

function add(p: P, rebs: Omit<R, "policyId">[], eligible: boolean | string) {
  POLICIES.push(p);
  for (const r of rebs) REBILLINGS.push({ ...r, policyId: p.id });
  if (eligible === true) ELIGIBLE_IDS.push(p.id);
  else if (typeof eligible === "string") EXCLUDED[eligible] = p.id;
}

// ── elegibles ────────────────────────────────────────────────────────────────
// El Norte, caso sintético B (consumida).
add({ id: 101, cycle: "cuatrimestral", next: "2026-07-01", end: "2027-03-01" }, [{ start: "2026-07-01", end: "2026-11-01", notes: EN_V2 }], true);
for (let i = 0; i < 7; i++) { // 7 consumidas más (ficha trimestral, inicio 08-0x)
  const day = String(i + 2).padStart(2, "0");
  add({ id: 102 + i, cycle: "trimestral", next: `2026-08-${day}`, end: "2027-08-31" },
    [{ start: `2026-08-${day}`, end: `2026-11-${String(i + 1).padStart(2, "0")}`, notes: "Prórroga" }], true);
}
for (let i = 0; i < 5; i++) { // 5 nulas (importador cuatrimestral)
  const day = String(i + 10).padStart(2, "0");
  add({ id: 110 + i, cycle: "cuatrimestral", next: null, end: "2027-07-31" },
    [{ start: `2026-07-${day}`, end: `2026-11-${day}`, notes: RIV }], true);
}
// Rivadavia, caso sintético A (consumida, fin = inicio siguiente).
add({ id: 201, cycle: "trimestral", next: "2026-08-01", end: "2027-02-01" }, [{ start: "2026-08-01", end: "2026-11-01", notes: "Prórroga" }], true);
// Histórico de importador con fin inclusivo: la forma manda, no las notas.
add({ id: 202, cycle: "trimestral", next: null }, [{ start: "2026-09-01", end: "2026-11-30", notes: RIV }], true);
// ── exclusiones obligatorias ─────────────────────────────────────────────────
add({ id: 215, cycle: "trimestral", next: null }, [{ start: "2026-08-05", end: "2026-10-20", notes: RIV }], "revision_periodo_irregular");
add({ id: 203, cycle: "trimestral", next: null }, [{ start: "2026-06-01", end: "2026-09-30" }, { start: "2026-09-01", end: "2026-11-30" }], "revision_superposicion");
add({ id: 204, cycle: "trimestral", next: null }, [{ start: "2026-05-01", end: "2026-07-31" }], "revision_ultimo_periodo_vencido");
add({ id: 205, cycle: "trimestral", next: "2026-09-01" }, [], "revision_explicita_vencida");
add({ id: 206, cycle: "trimestral", next: null }, [{ start: "2026-09-01", end: "2026-11-30" }, { start: "2026-09-01", end: "2026-11-30" }], "duplicado_activo");
add({ id: 207, cycle: "cuatrimestral", next: "2026-07-01", end: "2026-11-01" }, [{ start: "2026-07-01", end: "2026-11-01", notes: EN_V2 }], "coincide_con_renovacion");
add({ id: 208, cycle: "trimestral", next: "0206-07-08" }, [{ start: "2026-09-01", end: "2026-11-30" }], "anio_0206_guardada");
add({ id: 209, cycle: "trimestral", next: null }, [{ start: "0206-07-08", end: "2026-11-30" }], "anio_0206_refacturacion");
add({ id: 210, cycle: "trimestral", next: "2027-01-10" }, [{ start: "2026-09-01", end: "2026-11-30" }], "explicita_posterior");
add({ id: 211, cycle: "trimestral", next: "2026-12-01" }, [{ start: "2026-09-01", end: "2026-11-30" }], "ya_sincronizada");
add({ id: 212, cycle: "cuatrimestral", next: null, end: "2027-11-01" }, [{ start: "2026-07-01", end: "2026-11-01", notes: RIV }, { start: "2026-11-01", end: "2027-03-01", notes: RIV }], "ultimo_periodo_cargado_por_adelantado");
add({ id: 213, status: "vencida", cycle: "cuatrimestral", next: "2026-07-01" }, [{ start: "2026-07-01", end: "2026-11-01", notes: EN_V2 }], "no_vigente");
add({ id: 214, cycle: "trimestral", next: null }, [{ start: "2026-09-01", end: "2026-11-30" }, { start: "2026-09-01", end: "2026-11-30", status: "duplicada" }], false);
ELIGIBLE_IDS.push(214); // duplicada invalidada: no bloquea → elegible (nula), pero cae en 2026-12

async function seed(c: Client) {
  await c.execute("CREATE TABLE policies (id INTEGER PRIMARY KEY, status TEXT NOT NULL, end_date TEXT, billing_cycle TEXT, next_rebilling_date TEXT)");
  await c.execute("CREATE TABLE rebillings (id INTEGER PRIMARY KEY AUTOINCREMENT, policy_id INTEGER NOT NULL, billing_start TEXT NOT NULL, billing_end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'activa', notes TEXT)");
  for (const p of POLICIES) {
    await c.execute({ sql: "INSERT INTO policies VALUES (?, ?, ?, ?, ?)", args: [p.id, p.status ?? "activa", p.end ?? "2027-12-31", p.cycle ?? null, p.next ?? null] });
  }
  for (const r of REBILLINGS) {
    await c.execute({ sql: "INSERT INTO rebillings (policy_id, billing_start, billing_end, status, notes) VALUES (?, ?, ?, ?, ?)", args: [r.policyId, r.start, r.end, r.status ?? "activa", r.notes ?? null] });
  }
}
async function snapshot(c: Client) {
  return (await c.execute("SELECT id, next_rebilling_date FROM policies ORDER BY id")).rows.map((r) => [Number(r.id), r.next_rebilling_date]);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nrb-backfill-"));
  dirs.push(dir);
  client = createClient({ url: `file:${join(dir, "backfill.db").replace(/\\/g, "/")}` });
  await seed(client);
});
afterEach(() => {
  client.close();
});
// En Windows el archivo puede seguir bloqueado un instante después de close():
// el borrado de las bases temporales es de mejor esfuerzo, al final.
afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* temporal fuera del repo */ }
  }
});

describe("dry-run", () => {
  test("solo los casos seguros; ninguna exclusión obligatoria entra", async () => {
    const before = await snapshot(client);
    const plan = await planNextRebillingDateBackfill(client, TODAY);
    expect(await snapshot(client)).toEqual(before); // solo lectura
    expect(plan.eligible.map((e) => e.policyId).sort((a, b) => a - b)).toEqual([...ELIGIBLE_IDS].sort((a, b) => a - b));
    for (const [, id] of Object.entries(EXCLUDED)) expect(plan.eligible.some((e) => e.policyId === id)).toBe(false);
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.vigentePolicies).toBe(POLICIES.filter((p) => (p.status ?? "activa") !== "vencida").length);
  });

  test("El Norte (caso sintético B) y Rivadavia (caso sintético A) entran con 01/11/2026", async () => {
    const plan = await planNextRebillingDateBackfill(client, TODAY);
    expect(plan.eligible.find((e) => e.policyId === 101)).toMatchObject({ before: "2026-07-01", after: "2026-11-01", state: "atrasado_derivable" });
    expect(plan.eligible.find((e) => e.policyId === 201)).toMatchObject({ before: "2026-08-01", after: "2026-11-01", state: "atrasado_derivable" });
    expect(plan.eligible.find((e) => e.policyId === 202)).toMatchObject({ before: null, after: "2026-12-01", state: "nulo_derivable" });
  });

  test("conteo por categoría (diagnóstico del dry-run)", async () => {
    const plan = await planNextRebillingDateBackfill(client, TODAY);
    expect(plan.eligible.filter((e) => e.state === "atrasado_derivable")).toHaveLength(9);
    expect(plan.eligible.filter((e) => e.state === "nulo_derivable")).toHaveLength(7);
    expect(plan.excluded["review:nulo_sin_derivacion_segura:periodo_irregular"]).toBe(1);
    expect(plan.excluded["review:nulo_sin_derivacion_segura:periodo_futuro_ya_cargado"]).toBe(1);
    expect(plan.excluded["renewal:coincide_con_renovacion"]).toBe(1);
  });
});

describe("aplicación", () => {
  test("cantidad distinta de la aprobada → aborta sin escribir", async () => {
    const plan = await planNextRebillingDateBackfill(client, TODAY);
    const before = await snapshot(client);
    await expect(applyNextRebillingDateBackfill(client, { today: TODAY, expectedCount: plan.eligible.length - 1, expectedFingerprint: plan.fingerprint }))
      .rejects.toBeInstanceOf(NextRebillingBackfillAbortError);
    expect(await snapshot(client)).toEqual(before);
  });

  test("huella distinta del dry-run → aborta sin escribir", async () => {
    const plan = await planNextRebillingDateBackfill(client, TODAY);
    const before = await snapshot(client);
    await expect(applyNextRebillingDateBackfill(client, { today: TODAY, expectedCount: plan.eligible.length, expectedFingerprint: "0".repeat(64) }))
      .rejects.toBeInstanceOf(NextRebillingBackfillAbortError);
    expect(await snapshot(client)).toEqual(before);
  });

  test("aplica solo los elegibles, y la segunda pasada produce cero cambios", async () => {
    const plan = await planNextRebillingDateBackfill(client, TODAY);
    const before = new Map(await snapshot(client) as [number, unknown][]);
    const result = await applyNextRebillingDateBackfill(client, { today: TODAY, expectedCount: plan.eligible.length, expectedFingerprint: plan.fingerprint });
    expect(result.applied).toBe(plan.eligible.length);
    expect(result.remainingAfter).toBe(0);

    const after = new Map(await snapshot(client) as [number, unknown][]);
    for (const [id, value] of after) {
      const item = plan.eligible.find((e) => e.policyId === id);
      expect(value).toBe(item ? item.after : before.get(id));
    }

    const second = await applyNextRebillingDateBackfill(client, { today: TODAY, expectedCount: plan.eligible.length, expectedFingerprint: plan.fingerprint });
    expect(second).toEqual({ applied: 0, items: [], remainingAfter: 0 });
    expect(new Map(await snapshot(client) as [number, unknown][])).toEqual(after);
    expect((await planNextRebillingDateBackfill(client, TODAY)).eligible).toEqual([]);
  });

  test("guarda de concurrencia: si una fila cambió entre la lectura y la escritura, no se aplica NINGUNA", async () => {
    const plan = await planNextRebillingDateBackfill(client, TODAY);
    // Otro proceso cambia la póliza 105 justo antes del batch.
    const racing: NextRebillingBackfillClient = {
      execute: (stmt) => client.execute(stmt as any),
      batch: async (stmts, mode) => {
        await client.execute("UPDATE policies SET next_rebilling_date = '2026-12-24' WHERE id = 105");
        return client.batch(stmts as any, mode);
      },
    };
    const before = new Map(await snapshot(client) as [number, unknown][]);
    await expect(applyNextRebillingDateBackfill(racing, { today: TODAY, expectedCount: plan.eligible.length, expectedFingerprint: plan.fingerprint }))
      .rejects.toThrow();
    const after = new Map(await snapshot(client) as [number, unknown][]);
    for (const [id, value] of after) expect(value).toBe(id === 105 ? "2026-12-24" : before.get(id));
  });

  test("una póliza que dejó de estar vigente entre plan y batch también aborta todo", async () => {
    const plan = await planNextRebillingDateBackfill(client, TODAY);
    const racing: NextRebillingBackfillClient = {
      execute: (stmt) => client.execute(stmt as any),
      batch: async (stmts, mode) => {
        await client.execute("UPDATE policies SET status = 'cancelada' WHERE id = 110");
        return client.batch(stmts as any, mode);
      },
    };
    const before = await snapshot(client);
    await expect(applyNextRebillingDateBackfill(racing, { today: TODAY, expectedCount: plan.eligible.length, expectedFingerprint: plan.fingerprint }))
      .rejects.toThrow();
    expect(await snapshot(client)).toEqual(before);
  });
});

describe("precondiciones de la aplicación real", () => {
  const ok = {
    confirm: "1", systemPaused: "1", expectedCount: "16", expectedFingerprint: "a".repeat(64),
    backup: { path: "backup.json", sizeBytes: 1000, modifiedAtMs: 1_000_000 }, nowMs: 1_000_000 + 60_000,
  };
  test("todo presente → OK", () => {
    expect(checkNextRebillingBackfillPreconditions(ok)).toEqual([]);
  });
  test("sin confirmación, sin pausa, sin backup, backup viejo o vacío, sin conteo/huella → rechaza", () => {
    expect(checkNextRebillingBackfillPreconditions({ ...ok, confirm: undefined })).toHaveLength(1);
    expect(checkNextRebillingBackfillPreconditions({ ...ok, systemPaused: "0" })).toHaveLength(1);
    expect(checkNextRebillingBackfillPreconditions({ ...ok, backup: { path: undefined, sizeBytes: null, modifiedAtMs: null } })).toHaveLength(1);
    expect(checkNextRebillingBackfillPreconditions({ ...ok, backup: { path: "x", sizeBytes: null, modifiedAtMs: null } })).toHaveLength(1);
    expect(checkNextRebillingBackfillPreconditions({ ...ok, backup: { ...ok.backup, sizeBytes: 0 } })).toHaveLength(1);
    expect(checkNextRebillingBackfillPreconditions({ ...ok, nowMs: ok.backup.modifiedAtMs + 7 * 3600 * 1000 })).toHaveLength(1);
    expect(checkNextRebillingBackfillPreconditions({ ...ok, expectedCount: "0" })).toHaveLength(1);
    expect(checkNextRebillingBackfillPreconditions({ ...ok, expectedFingerprint: "xyz" })).toHaveLength(1);
  });
});
