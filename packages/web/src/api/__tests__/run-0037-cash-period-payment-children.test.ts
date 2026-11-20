/**
 * Ejecutor (run-0037) y auditor de solo lectura (audit-0037) de la migración
 * 0037, corridos como PROCESO HIJO igual que en el deploy, contra bases
 * libsql de archivo en el directorio temporal del sistema con un esquema
 * pre-0037 mínimo y datos sintéticos. Nunca dev.db ni Turso: las URL remotas
 * de abajo se rechazan antes de conectar (no hay tráfico de red).
 */
import { test, expect, describe, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createClient } from "@libsql/client";
import {
  runMigration0037InTransaction, Migration0037CommitUncertainError, dryRunTargetRejection,
} from "../../lib/migrations/run-0037-cash-period-payment-children";
import { runAudit0037 } from "../../lib/migrations/audit-0037-cash-period-payment-children";

const MIGRATIONS = join(import.meta.dir, "..", "..", "lib", "migrations");
const RUNNER = join(MIGRATIONS, "run-0037-cash-period-payment-children.ts");
const AUDITOR = join(MIGRATIONS, "audit-0037-cash-period-payment-children.ts");
const WEB_ROOT = join(import.meta.dir, "..", "..", "..");
const dir = mkdtempSync(join(tmpdir(), "run-0037-"));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: archivo aún bloqueado */ } });

let n = 0;
/** Base pre-0037: un contado histórico (refacturación 10, 3 cuotas), un lote común y un pago suelto. */
function preMigrationDb(extra?: (db: Database) => void): string {
  const path = join(dir, `db-${++n}.db`);
  const db = new Database(path);
  db.run("PRAGMA foreign_keys=ON");
  db.run(`CREATE TABLE policies (id INTEGER PRIMARY KEY AUTOINCREMENT, policy_number TEXT)`);
  db.run(`CREATE TABLE rebillings (id INTEGER PRIMARY KEY AUTOINCREMENT, policy_id INTEGER NOT NULL REFERENCES policies(id))`);
  db.run(`CREATE TABLE policy_installments (id INTEGER PRIMARY KEY AUTOINCREMENT, policy_id INTEGER NOT NULL REFERENCES policies(id),
    rebilling_id INTEGER REFERENCES rebillings(id), amount REAL NOT NULL)`);
  db.run(`CREATE TABLE payment_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, total_received_cents INTEGER NOT NULL)`);
  db.run(`CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, policy_id INTEGER REFERENCES policies(id), amount REAL NOT NULL,
    installment_id INTEGER REFERENCES policy_installments(id), batch_id INTEGER REFERENCES payment_batches(id))`);
  db.run(`CREATE TABLE cash_period_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_batch_id INTEGER NOT NULL REFERENCES payment_batches(id),
    policy_id INTEGER NOT NULL REFERENCES policies(id), rebilling_id INTEGER REFERENCES rebillings(id), cash_amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmado', rendered INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE UNIQUE INDEX ux_cash_period_payments_batch_id ON cash_period_payments(payment_batch_id)`);
  db.run(`INSERT INTO policies (id, policy_number) VALUES (1, 'SYN-1'), (2, 'SYN-2')`);
  db.run(`INSERT INTO rebillings (id, policy_id) VALUES (10, 1)`);
  db.run(`INSERT INTO policy_installments (id, policy_id, rebilling_id, amount) VALUES
    (100, 1, 10, 10000), (101, 1, 10, 10000), (102, 1, 10, 10000), (200, 2, NULL, 5000), (201, 2, NULL, 5000)`);
  db.run(`INSERT INTO payment_batches (id, total_received_cents) VALUES (1, 2700000), (2, 500000)`);
  db.run(`INSERT INTO cash_period_payments (id, payment_batch_id, policy_id, rebilling_id, cash_amount_cents) VALUES (7, 1, 1, 10, 2700000)`);
  db.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id) VALUES
    (1000, 1, 10000, 100, 1), (1001, 1, 10000, 101, 1), (1002, 1, 10000, 102, 1), (2000, 2, 5000, 200, 2), (3000, 2, 5000, 201, NULL)`);
  extra?.(db);
  db.close();
  return path;
}

async function cli(script: string, url: string, ...args: string[]) {
  // Igual que en el procedimiento: --no-env-file, nunca se cargan .env.
  const proc = Bun.spawn([process.execPath, "--no-env-file", script, ...args], {
    cwd: WEB_ROOT, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, DATABASE_URL: url, DATABASE_AUTH_TOKEN: "token-sintetico-no-usar" },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT_JSON:"));
  return { code, stdout, stderr, result: line ? JSON.parse(line.slice("RESULT_JSON:".length)) : null };
}
const runCli = (path: string, ...args: string[]) => cli(RUNNER, `file:${path}`, ...args);
const auditCli = (path: string, ...args: string[]) => cli(AUDITOR, `file:${path}`, ...args);

function read(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasColumn = (db.query("PRAGMA table_info(payments)").all() as any[]).some((c) => c.name === "cash_period_payment_id");
    const hasIndex = db.query("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_payments_cash_period_payment_id'").all().length === 1;
    const links = hasColumn
      ? Object.fromEntries((db.query("SELECT id, cash_period_payment_id c FROM payments ORDER BY id").all() as any[]).map((r) => [r.id, r.c]))
      : null;
    return { hasColumn, hasIndex, links };
  } finally {
    db.close();
  }
}

/** Contado registrado por la versión anterior después de migrar (cuotas sin vínculo), opcionalmente con un hijo ajeno. */
function addUnlinkedContado(path: string, opts: { foreignChild?: boolean; rebillingId: number; batchId: number; cppId: number; base: number }) {
  const db = new Database(path);
  db.run(`INSERT INTO rebillings (id, policy_id) VALUES (${opts.rebillingId}, 1)`);
  db.run(`INSERT INTO policy_installments (id, policy_id, rebilling_id, amount) VALUES (${opts.base}, 1, ${opts.rebillingId}, 10000)`);
  db.run(`INSERT INTO payment_batches (id, total_received_cents) VALUES (${opts.batchId}, 900000)`);
  db.run(`INSERT INTO cash_period_payments (id, payment_batch_id, policy_id, rebilling_id, cash_amount_cents) VALUES (${opts.cppId}, ${opts.batchId}, 1, ${opts.rebillingId}, 900000)`);
  db.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id) VALUES (${opts.base * 10}, 1, 10000, ${opts.base}, ${opts.batchId})`);
  if (opts.foreignChild) {
    db.run(`INSERT INTO policy_installments (id, policy_id, rebilling_id, amount) VALUES (${opts.base + 1}, 2, NULL, 5000)`);
    db.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id) VALUES (${opts.base * 10 + 1}, 2, 5000, ${opts.base + 1}, ${opts.batchId})`);
  }
  db.close();
}

// ─── Ejecutor ───────────────────────────────────────────────────────────────

describe("run-0037 — ensayo (escribe y revierte): solo SQLite temporal", () => {
  test("contra un SQLite temporal: calcula el resumen, revierte y no deja nada escrito", async () => {
    const path = preMigrationDb();
    const r = await runCli(path);
    expect(r.code).toBe(0);
    expect(r.result).toMatchObject({ mode: "dry-run", outcome: "rolled_back", summary: { backfilledRows: 3 } });
    expect(read(path)).toEqual({ hasColumn: false, hasIndex: false, links: null });
    expect(r.stdout).toMatch(/ensayo \(escribe y revierte\)/);
    expect(r.stdout).not.toContain(dir);
    expect(r.stdout + r.stderr).not.toContain("token-sintetico-no-usar");
  });

  test("rechaza URL remotas sin conectar (exit 2)", async () => {
    for (const url of ["libsql://ejemplo.invalid", "https://ejemplo.invalid", "wss://ejemplo.invalid"]) {
      const r = await cli(RUNNER, url);
      expect(r.code).toBe(2);
      expect(r.result).toMatchObject({ mode: "dry-run", outcome: "refused" });
      expect(r.result.error).toMatch(/solo se admite contra un SQLite temporal/);
      expect(r.stdout).not.toContain("ejemplo.invalid");
    }
  });

  test("rechaza archivos fuera del directorio temporal y cualquier dev.db", async () => {
    const outside = await cli(RUNNER, `file:${RUNNER}`); // archivo existente fuera del temporal: no se abre como base
    expect(outside.code).toBe(2);
    expect(outside.result.error).toMatch(/directorio temporal/);
    const fakeDev = join(dir, "dev.db");
    writeFileSync(fakeDev, "");
    const dev = await cli(RUNNER, `file:${fakeDev}`);
    expect(dev.code).toBe(2);
    expect(dev.result.error).toMatch(/dev\.db/);
    expect(dryRunTargetRejection(`file:${join(dir, "db-1.db")}`)).toBe(null);
  });

  test("un archivo inexistente se rechaza en ambos modos y no se crea", async () => {
    const missing = join(dir, "no-existe.db");
    expect((await runCli(missing)).code).toBe(2);
    expect((await runCli(missing, "--commit")).code).toBe(2);
    expect(existsSync(missing)).toBe(false);
  });
});

describe("run-0037 --commit — una sola transacción", () => {
  test("primera ejecución vincula las 3 cuotas; la segunda no cambia nada", async () => {
    const path = preMigrationDb();
    const first = await runCli(path, "--commit");
    expect(first.code).toBe(0);
    expect(first.result.summary).toMatchObject({ columnAdded: true, indexCreated: true, backfilledRows: 3, linkedChildren: 3, alreadyApplied: false, paymentsBefore: 5, paymentsAfter: 5 });
    expect(read(path)).toEqual({ hasColumn: true, hasIndex: true, links: { 1000: 7, 1001: 7, 1002: 7, 2000: null, 3000: null } });
    const second = await runCli(path, "--commit");
    expect(second.code).toBe(0);
    expect(second.result.summary).toMatchObject({ columnAdded: false, indexCreated: false, backfilledRows: 0, alreadyApplied: true, linkedChildren: 3 });
    expect(read(path).links).toEqual({ 1000: 7, 1001: 7, 1002: 7, 2000: null, 3000: null });
  });

  test("lote mixto registrado después: re-ejecutar conserva sus cuotas comunes sin vincular", async () => {
    const path = preMigrationDb();
    expect((await runCli(path, "--commit")).code).toBe(0);
    const db = new Database(path);
    db.run(`INSERT INTO rebillings (id, policy_id) VALUES (11, 1)`);
    db.run(`INSERT INTO policy_installments (id, policy_id, rebilling_id, amount) VALUES (103, 1, 11, 10000), (202, 2, NULL, 5000), (203, 2, NULL, 5000)`);
    db.run(`INSERT INTO payment_batches (id, total_received_cents) VALUES (3, 1900000)`);
    db.run(`INSERT INTO cash_period_payments (id, payment_batch_id, policy_id, rebilling_id, cash_amount_cents) VALUES (8, 3, 1, 11, 900000)`);
    db.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id, cash_period_payment_id) VALUES
      (4000, 1, 10000, 103, 3, 8), (4001, 2, 5000, 202, 3, NULL), (4002, 2, 5000, 203, 3, NULL)`);
    db.close();
    const again = await runCli(path, "--commit");
    expect(again.code).toBe(0);
    expect(again.result.summary).toMatchObject({ backfilledRows: 0, alreadyApplied: true, linkedChildren: 4 });
    const links = read(path).links!;
    expect([links[4000], links[4001], links[4002]]).toEqual([8, null, null]);
  });

  test("dato inconsistente en la primera ejecución: exit 1 y se revierte TODO", async () => {
    const path = preMigrationDb((db) => db.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id) VALUES (1003, 2, 5000, 201, 1)`));
    const r = await runCli(path, "--commit");
    expect(r.code).toBe(1);
    expect(r.result.outcome).toBe("aborted");
    expect(r.result.error).toMatch(/Migración 0037 abortada: 1 pago/);
    expect(read(path)).toEqual({ hasColumn: false, hasIndex: false, links: null });
  });

  test("dato inconsistente en una re-ejecución: exit 1 y no vincula ni el contado válido de la misma corrida", async () => {
    const path = preMigrationDb();
    expect((await runCli(path, "--commit")).code).toBe(0);
    addUnlinkedContado(path, { rebillingId: 12, batchId: 4, cppId: 9, base: 104 });
    addUnlinkedContado(path, { rebillingId: 13, batchId: 5, cppId: 10, base: 110, foreignChild: true });
    const before = read(path).links;
    const r = await runCli(path, "--commit");
    expect(r.code).toBe(1);
    expect(read(path).links).toEqual(before);
    expect(read(path).links![1040]).toBe(null);
  });
});

describe("run-0037 — falla al confirmar (COMMIT): resultado incierto", () => {
  /** Cliente libsql real cuyo commit falla: antes de confirmar (no aplicado) o después (aplicado). */
  function clientWithFailingCommit(path: string, when: "before" | "after") {
    const real = createClient({ url: `file:${path}` });
    const wrapped = {
      async transaction(mode: "write") {
        const tx = await real.transaction(mode);
        return {
          execute: (stmt: any) => tx.execute(stmt),
          rollback: () => tx.rollback(),
          close: () => tx.close(),
          async commit() {
            if (when === "after") await tx.commit(); else await tx.rollback();
            throw new Error("conexión perdida (simulada) al confirmar");
          },
        };
      },
      close: () => real.close(),
    };
    return { client: wrapped as any, real };
  }

  test("el ejecutor informa INCIERTO en ambos casos; solo el auditor dice si se aplicó", async () => {
    for (const when of ["before", "after"] as const) {
      const path = preMigrationDb();
      const { client, real } = clientWithFailingCommit(path, when);
      let err: unknown = null;
      try { await runMigration0037InTransaction(client, { commit: true }); } catch (e) { err = e; }
      real.close();
      expect(err).toBeInstanceOf(Migration0037CommitUncertainError);
      expect(String((err as Error).message)).toMatch(/Resultado incierto.*Mantené la pausa de escrituras y no reintentes.*--previous/);
      expect((err as Migration0037CommitUncertainError).summary.backfilledRows).toBe(3);
      const audit = await auditCli(path);
      if (when === "before") {
        expect(audit.result.phase).toBe("pre"); // no se aplicó: se puede reintentar
        expect(audit.result.values.vinculos_a_crear).toBe(3);
      } else {
        expect(audit.result.phase).toBe("post"); // sí se aplicó: NO reintentar la primera ejecución a ciegas
        expect(audit.result.values.hijos_vinculados).toBe(3);
        expect(audit.result.alerts).toEqual([]);
      }
    }
  });

  test("un error ANTES del COMMIT no es incierto: es el error original y no queda nada escrito", async () => {
    const path = preMigrationDb((db) => db.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id) VALUES (1003, 2, 5000, 201, 1)`));
    const client = createClient({ url: `file:${path}` });
    let err: unknown = null;
    try { await runMigration0037InTransaction(client, { commit: true }); } catch (e) { err = e; }
    client.close();
    expect(err).not.toBeInstanceOf(Migration0037CommitUncertainError);
    expect(String((err as Error).message)).toMatch(/Migración 0037 abortada/);
    expect(read(path).hasColumn).toBe(false);
  });
});

// ─── Auditor de solo lectura ────────────────────────────────────────────────

describe("audit-0037 — solo lectura", () => {
  const bytes = (p: string) => Bun.hash(readFileSync(p));

  test("antes de migrar: fase pre, vínculos a crear, sin alertas y sin modificar el archivo", async () => {
    const path = preMigrationDb();
    const before = bytes(path);
    const r = await auditCli(path);
    expect(r.code).toBe(0);
    expect(r.result.phase).toBe("pre");
    expect(r.result.values).toMatchObject({ columna_existe: 0, indice_existe: 0, contados_total: 1, hijos_de_lotes_con_contado: 3, hijos_inconsistentes: 0, vinculos_a_crear: 3, payments_total: 5 });
    expect(r.result.alerts).toEqual([]);
    expect(bytes(path)).toBe(before);
    expect(r.stdout + r.stderr).not.toContain("token-sintetico-no-usar");
  });

  test("antes de migrar con un dato inconsistente: alerta (exit 1)", async () => {
    const path = preMigrationDb((db) => db.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id) VALUES (1003, 2, 5000, 201, 1)`));
    const r = await auditCli(path);
    expect(r.code).toBe(1);
    expect(r.result.alerts.map((a: any) => a.key)).toEqual(["hijos_inconsistentes"]);
  });

  test("después de migrar: fase post y sin alertas; detecta un contado sin vincular y un lote mixto", async () => {
    const path = preMigrationDb();
    expect((await runCli(path, "--commit")).code).toBe(0);
    const ok = await auditCli(path);
    expect(ok.code).toBe(0);
    expect(ok.result.phase).toBe("post");
    expect(ok.result.values).toMatchObject({ hijos_vinculados: 3, contados_sin_vinculo: 0, vinculos_periodo_incorrecto: 0, vinculos_otro_lote: 0, lotes_mixtos: 0 });

    addUnlinkedContado(path, { rebillingId: 12, batchId: 4, cppId: 9, base: 104 });
    const pending = await auditCli(path);
    expect(pending.code).toBe(1);
    expect(pending.result.alerts.map((a: any) => a.key)).toEqual(["contados_sin_vinculo"]);
    expect((await runCli(path, "--commit")).result.summary.backfilledRows).toBe(1);
    expect((await auditCli(path)).code).toBe(0);

    const db = new Database(path);
    db.run(`INSERT INTO rebillings (id, policy_id) VALUES (11, 1)`);
    db.run(`INSERT INTO policy_installments (id, policy_id, rebilling_id, amount) VALUES (103, 1, 11, 10000), (202, 2, NULL, 5000)`);
    db.run(`INSERT INTO payment_batches (id, total_received_cents) VALUES (3, 1400000)`);
    db.run(`INSERT INTO cash_period_payments (id, payment_batch_id, policy_id, rebilling_id, cash_amount_cents) VALUES (8, 3, 1, 11, 900000)`);
    db.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id, cash_period_payment_id) VALUES (4000, 1, 10000, 103, 3, 8), (4001, 2, 5000, 202, 3, NULL)`);
    db.close();
    const mixed = await auditCli(path);
    expect(mixed.code).toBe(0);
    expect(mixed.result.values.lotes_mixtos).toBe(1);
  });

  test("con la base migrada y un contado sin vincular con hijo ajeno: alerta antes de re-ejecutar", async () => {
    const path = preMigrationDb();
    expect((await runCli(path, "--commit")).code).toBe(0);
    addUnlinkedContado(path, { rebillingId: 13, batchId: 5, cppId: 10, base: 110, foreignChild: true });
    const r = await auditCli(path);
    expect(r.code).toBe(1);
    expect(r.result.alerts.map((a: any) => a.key).sort()).toEqual(["contados_sin_vinculo", "hijos_inconsistentes_pendientes"]);
  });

  test("archivo inexistente: exit 2 y no se crea; URL remota no se toca en las pruebas", async () => {
    const missing = join(dir, "no-existe-auditoria.db");
    expect((await auditCli(missing)).code).toBe(2);
    expect(existsSync(missing)).toBe(false);
  });

  test("después de migrar, sin el índice: alerta indice_presente (exit 1)", async () => {
    const path = preMigrationDb();
    expect((await runCli(path, "--commit")).code).toBe(0);
    const db = new Database(path);
    db.run("DROP INDEX idx_payments_cash_period_payment_id");
    db.close();
    const r = await auditCli(path);
    expect(r.code).toBe(1);
    expect(r.result.phase).toBe("post");
    expect(r.result.values.indice_presente).toBe(0);
    expect(r.result.alerts.map((a: any) => a.key)).toEqual(["indice_presente"]);
  });

  test("runAudit0037 usado como función devuelve lo mismo que el CLI", async () => {
    const path = preMigrationDb();
    const client = createClient({ url: `file:${path}` });
    const r = await runAudit0037(client);
    client.close();
    expect(r.phase).toBe("pre");
    expect(r.values.vinculos_a_crear).toBe(3);
  });
});

// ─── Procedimiento tras exit 3 (resultado incierto) ─────────────────────────

describe("exit 3 — comparación con la auditoría inmediatamente anterior (auditor --previous)", () => {
  /** Ejecuta la migración con un COMMIT que falla: "before" = no se aplicó, "after" = sí se aplicó. */
  async function uncertainRun(path: string, when: "before" | "after") {
    const real = createClient({ url: `file:${path}` });
    const client = {
      async transaction(mode: "write") {
        const tx = await real.transaction(mode);
        return {
          execute: (stmt: any) => tx.execute(stmt), rollback: () => tx.rollback(), close: () => tx.close(),
          async commit() {
            if (when === "after") await tx.commit(); else await tx.rollback();
            throw new Error("conexión perdida (simulada) al confirmar");
          },
        };
      },
      close: () => real.close(),
    } as any;
    let err: unknown = null;
    try { await runMigration0037InTransaction(client, { commit: true }); } catch (e) { err = e; }
    real.close();
    expect(err).toBeInstanceOf(Migration0037CommitUncertainError);
  }
  const previousFile = () => join(dir, `prev-${++n}.json`);
  async function auditTo(path: string) {
    const file = previousFile();
    const r = await auditCli(path, "--out", file);
    expect(r.code).toBe(0);
    expect(existsSync(file)).toBe(true);
    return file;
  }

  test("primera aplicación incierta que NO se aplicó → no_aplicada (no avanzar, no reintentar solo)", async () => {
    const path = preMigrationDb();
    const prev = await auditTo(path);
    await uncertainRun(path, "before");
    const r = await auditCli(path, "--previous", prev);
    expect(r.code).toBe(0);
    expect(r.result.phase).toBe("pre");
    expect(r.result.assessment.verdict).toBe("no_aplicada");
    expect(r.result.assessment.message).toMatch(/Mantené la pausa de escrituras\. No reintentes automáticamente/);
  });

  test("primera aplicación incierta que SÍ se aplicó → coincide_con_aplicada (columna, índice y vínculos esperados), sin confirmar", async () => {
    const path = preMigrationDb();
    const prev = await auditTo(path);
    await uncertainRun(path, "after");
    const r = await auditCli(path, "--previous", prev);
    expect(r.code).toBe(0);
    expect(r.result.assessment.verdict).toBe("coincide_con_aplicada");
    expect(r.result.assessment.expected).toEqual({ columna: 1, indice: 1, vinculos: 3, payments_total: 5 });
    expect(r.result.assessment.actual).toMatchObject({ columna: 1, indice: 1, vinculos: 3, payments_total: 5, alertas: 0 });
    expect(r.result.assessment.message).toMatch(/no se pudo confirmar el resultado de esa ejecución/);
  });

  test("segunda ejecución incierta con la base ya en post y sin pendientes → compatible_sin_confirmar", async () => {
    for (const when of ["before", "after"] as const) {
      const path = preMigrationDb();
      expect((await runCli(path, "--commit")).code).toBe(0);
      const prev = await auditTo(path);
      await uncertainRun(path, when);
      const r = await auditCli(path, "--previous", prev);
      expect(r.code).toBe(0);
      expect(r.result.assessment.verdict).toBe("compatible_sin_confirmar");
      expect(r.result.assessment.message).toMatch(/compatible con lo esperado, pero no se pudo confirmar el resultado de esa ejecución/);
    }
  });

  test("segunda ejecución incierta con un contado pendiente: no aplicada vs. aplicada", async () => {
    for (const when of ["before", "after"] as const) {
      const path = preMigrationDb();
      expect((await runCli(path, "--commit")).code).toBe(0);
      addUnlinkedContado(path, { rebillingId: 12, batchId: 4, cppId: 9, base: 104 });
      const prevRun = await auditCli(path, "--out", join(dir, `prev-${++n}.json`));
      expect(prevRun.code).toBe(1); // contados_sin_vinculo: alerta esperada antes de la segunda ejecución
      const prev = join(dir, `prev-${n}.json`);
      await uncertainRun(path, when);
      const r = await auditCli(path, "--previous", prev);
      if (when === "before") {
        // Igual que antes (misma alerta preexistente, mismo pendiente): no se aplicó.
        expect(r.code).toBe(0);
        expect(r.result.assessment.verdict).toBe("no_aplicada");
        expect(r.result.values.vinculos_pendientes).toBe(1);
      } else {
        expect(r.code).toBe(0);
        expect(r.result.assessment.verdict).toBe("coincide_con_aplicada");
        expect(r.result.assessment.expected.vinculos).toBe(4);
      }
    }
  });

  test("un estado que no coincide (índice faltante o pagos que cambiaron) → discrepancia (exit 1)", async () => {
    const path = preMigrationDb();
    const prev = await auditTo(path);
    await uncertainRun(path, "after");
    const db = new Database(path);
    db.run("DROP INDEX idx_payments_cash_period_payment_id");
    db.close();
    const noIndex = await auditCli(path, "--previous", prev);
    expect(noIndex.code).toBe(1);
    expect(noIndex.result.assessment.verdict).toBe("discrepancia");

    const path2 = preMigrationDb();
    const prev2 = await auditTo(path2);
    const db2 = new Database(path2);
    db2.run(`INSERT INTO payments (id, policy_id, amount, installment_id, batch_id) VALUES (9000, 2, 5000, 201, NULL)`);
    db2.close();
    const moved = await auditCli(path2, "--previous", prev2);
    expect(moved.code).toBe(1);
    expect(moved.result.assessment.verdict).toBe("discrepancia");
    expect(moved.result.assessment.message).toMatch(/cantidad de pagos cambió/);
  });

  test("--previous con un archivo inválido o argumentos desconocidos → exit 2", async () => {
    const path = preMigrationDb();
    const bad = join(dir, "no-es-json.json");
    writeFileSync(bad, "nada");
    expect((await auditCli(path, "--previous", bad)).code).toBe(2);
    expect((await auditCli(path, "--otra")).code).toBe(2);
    expect((await auditCli(path, "--out")).code).toBe(2);
  });
});
