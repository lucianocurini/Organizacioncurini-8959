/**
 * Pruebas de deduplicación de importación El Norte.
 * Ejecutar con: bun test --env-file=packages/web/.env.test packages/web/src/api/__tests__/en-dedup.test.ts
 *
 * LIMITACIÓN DOCUMENTADA: sin UNIQUE INDEX en rebillings(policy_id, billing_start, billing_end, premium),
 * dos requests verdaderamente simultáneos (ventana <1ms) pueden crear duplicados.
 * SQLite serializa escrituras en modo archivo, lo que reduce el riesgo, pero no lo elimina totalmente.
 * La protección absoluta requiere el índice único — ver Caso G.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app, { withImportLogRetry } from "../index";
import { database as db } from "../database/index";
import {
  users, sessions, policies, rebillings, policyInstallments,
  importLogs, companies, insureds,
} from "../database/schema";
import { eq } from "drizzle-orm";

// ── Constantes de test ────────────────────────────────────────────────────────

const TEST_SESSION_ID = "test-session-en-dedup-001";
const TEST_USER_EMAIL = "test-en-dedup@test.local";
const TEST_POLICY_NUMBER = "TEST-EN-DEDUP-001";
const GMAIL_MSG_A = "test-gmail-msg-dedup-A";
const GMAIL_MSG_B = "test-gmail-msg-dedup-B";

let testUserId: number;
let testPolicyId: number;
let testInsuredId: number;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePolicy(overrides: Record<string, any> = {}) {
  return {
    policyNumber: TEST_POLICY_NUMBER,
    movType: "PRORROGA",
    startDate: "2026-06-01",
    endDate: "2026-10-01",
    premium: 100000,
    sumInsured: 5000000,
    endoso: "1",
    insuredName: "PRUEBA TEST DEDUP",
    installments: [
      { number: 1, dueDate: "2026-06-01", amount: 25000 },
      { number: 2, dueDate: "2026-07-01", amount: 25000 },
      { number: 3, dueDate: "2026-08-01", amount: 25000 },
      { number: 4, dueDate: "2026-09-01", amount: 25000 },
    ],
    ...overrides,
  };
}

async function callConfirm(pols: any[], extras: Record<string, any> = {}) {
  return app.fetch(
    new Request("http://localhost/api/import/el-norte/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": TEST_SESSION_ID },
      body: JSON.stringify({ policies: pols, ...extras }),
    })
  );
}

async function countRebillings() {
  const rows = await db.select({ id: rebillings.id })
    .from(rebillings).where(eq(rebillings.policyId, testPolicyId)).all();
  return rows.length;
}

async function countInstallments() {
  const rows = await db.select({ id: policyInstallments.id })
    .from(policyInstallments).where(eq(policyInstallments.policyId, testPolicyId)).all();
  return rows.length;
}

async function cleanTestRebillings() {
  await db.delete(policyInstallments).where(eq(policyInstallments.policyId, testPolicyId));
  await db.delete(rebillings).where(eq(rebillings.policyId, testPolicyId));
}

async function cleanGmailLog(gmailMessageId: string) {
  await db.delete(importLogs).where(eq(importLogs.gmailMessageId, gmailMessageId));
}

function makeBusyError(): Error {
  const e: any = new Error("SQLITE_BUSY: cannot commit transaction - SQL statements in progress");
  e.code = "SQLITE_BUSY";
  return e;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Pre-cleanup: eliminar datos de corridas anteriores que pudieron quedar si el afterAll falló
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, TEST_USER_EMAIL)).get();
  if (prevUser) {
    const prevPolicy = await db.select({ id: policies.id }).from(policies).where(eq(policies.policyNumber, TEST_POLICY_NUMBER)).get();
    if (prevPolicy) {
      await db.delete(policyInstallments).where(eq(policyInstallments.policyId, prevPolicy.id));
      await db.delete(rebillings).where(eq(rebillings.policyId, prevPolicy.id));
      await db.delete(policies).where(eq(policies.id, prevPolicy.id));
    }
    // import_logs referencia createdBy → eliminar antes que el usuario
    await db.delete(importLogs).where(eq(importLogs.createdBy, prevUser.id));
    // insureds referencia createdBy → eliminar antes que el usuario (después de policies)
    await db.delete(insureds).where(eq(insureds.createdBy, prevUser.id));
    await db.delete(sessions).where(eq(sessions.id, TEST_SESSION_ID));
    await db.delete(users).where(eq(users.id, prevUser.id));
  }

  // Crear usuario de test
  const [u] = await db.insert(users).values({
    name: "Test Dedup User",
    email: TEST_USER_EMAIL,
    password: "hashed-dummy",
    role: "admin",
    active: 1,
  }).returning({ id: users.id });
  testUserId = u!.id;

  // Crear sesión de test
  await db.insert(sessions).values({
    id: TEST_SESSION_ID,
    userId: testUserId,
    expiresAt: new Date(Date.now() + 86400000),
  });

  // Asegurar que existe la compañía El Norte
  let co = await db.select({ id: companies.id })
    .from(companies).where(eq(companies.name, "El Norte")).get();
  if (!co) {
    [co] = await db.insert(companies).values({ name: "El Norte" }).returning({ id: companies.id });
  }

  // Crear asegurado de test
  const [ins] = await db.insert(insureds).values({
    name: "PRUEBA TEST DEDUP", createdBy: testUserId,
  }).returning({ id: insureds.id });
  testInsuredId = ins!.id;

  // Crear póliza base que recibirá las PRORROGA/ENDOSO
  const [pol] = await db.insert(policies).values({
    policyNumber: TEST_POLICY_NUMBER,
    type: "automotor",
    status: "activa",
    companyId: co!.id,
    insuredId: ins!.id,
    startDate: "2025-06-01",
    endDate: "2026-05-31",
    isRebilling: 0,
    createdBy: testUserId,
  }).returning({ id: policies.id });
  testPolicyId = pol!.id;
});

afterAll(async () => {
  try { await db.delete(policyInstallments).where(eq(policyInstallments.policyId, testPolicyId)); } catch {}
  try { await db.delete(rebillings).where(eq(rebillings.policyId, testPolicyId)); } catch {}
  try { await db.delete(policies).where(eq(policies.id, testPolicyId)); } catch {}
  // import_logs y insureds referencian createdBy → eliminar antes que el usuario
  try { await db.delete(importLogs).where(eq(importLogs.createdBy, testUserId)); } catch {}
  try { await db.delete(insureds).where(eq(insureds.id, testInsuredId)); } catch {}
  try { await db.delete(sessions).where(eq(sessions.id, TEST_SESSION_ID)); } catch {}
  try { await db.delete(users).where(eq(users.id, testUserId)); } catch {}
});

// ── CASO A: mismo movimiento dos veces en la misma llamada ───────────────────

describe("Caso A — duplicado dentro del mismo array", () => {
  test("dos movimientos idénticos → 1 rebilling, 4 cuotas, duplicados=1", async () => {
    await cleanTestRebillings();

    const pol = makePolicy({ startDate: "2026-06-01", endDate: "2026-10-01", premium: 100000 });
    const res = await callConfirm([pol, { ...pol }]);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.rebillings).toBe(1);
    expect(body.duplicados).toBeGreaterThanOrEqual(1);
    expect(body.installmentsCreated).toBe(4);

    expect(await countRebillings()).toBe(1);
    expect(await countInstallments()).toBe(4);

    await cleanTestRebillings();
  });
});

// ── CASO B: repetir la misma importación ─────────────────────────────────────

describe("Caso B — repetir la misma importación", () => {
  test("primera ejecución crea 1 rebilling y 4 cuotas", async () => {
    await cleanTestRebillings();
    const pol = makePolicy({ startDate: "2026-07-01", endDate: "2026-11-01", premium: 110000 });
    const res = await callConfirm([pol]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rebillings).toBe(1);
    expect(body.installmentsCreated).toBe(4);
    expect(await countRebillings()).toBe(1);
    expect(await countInstallments()).toBe(4);
  });

  test("segunda ejecución idéntica no crea nada, reporta duplicado", async () => {
    const pol = makePolicy({ startDate: "2026-07-01", endDate: "2026-11-01", premium: 110000 });
    const res = await callConfirm([pol]);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.rebillings).toBe(0);
    expect(body.duplicados).toBeGreaterThanOrEqual(1);

    // Los conteos en DB no deben haber cambiado
    expect(await countRebillings()).toBe(1);
    expect(await countInstallments()).toBe(4);

    await cleanTestRebillings();
  });
});

// ── CASO C: dos archivos distintos con el mismo movimiento ────────────────────

describe("Caso C — dos archivos distintos, mismo movimiento", () => {
  test("primera importación (gmailMessageId=A) crea el rebilling", async () => {
    await cleanTestRebillings();
    await cleanGmailLog(GMAIL_MSG_A);

    const pol = makePolicy({ startDate: "2026-08-01", endDate: "2026-12-01", premium: 120000 });
    const res = await callConfirm([pol], { gmailMessageId: GMAIL_MSG_A, filename: "TRAN-FILE-A.TXT" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rebillings).toBe(1);
    expect(await countRebillings()).toBe(1);
  });

  test("segunda importación (gmailMessageId=B, mismo movimiento) detecta duplicado en DB", async () => {
    await cleanGmailLog(GMAIL_MSG_B);

    const pol = makePolicy({ startDate: "2026-08-01", endDate: "2026-12-01", premium: 120000 });
    const res = await callConfirm([pol], { gmailMessageId: GMAIL_MSG_B, filename: "TRAN-FILE-B.TXT" });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.rebillings).toBe(0);
    expect(body.duplicados).toBeGreaterThanOrEqual(1);
    expect(await countRebillings()).toBe(1);
    expect(await countInstallments()).toBe(4);

    await cleanTestRebillings();
    await cleanGmailLog(GMAIL_MSG_A);
    await cleanGmailLog(GMAIL_MSG_B);
  });
});

// ── CASO D: mismo gmailMessageId en dos llamadas ─────────────────────────────

describe("Caso D — mismo gmailMessageId", () => {
  test("primera llamada procesa normalmente", async () => {
    await cleanTestRebillings();
    await cleanGmailLog(GMAIL_MSG_A);

    const pol = makePolicy({ startDate: "2026-09-01", endDate: "2027-01-01", premium: 130000 });
    const res = await callConfirm([pol], { gmailMessageId: GMAIL_MSG_A });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rebillings).toBe(1);
    expect(body.gmailAlreadyProcessed).toBeUndefined();
    expect(await countRebillings()).toBe(1);
  });

  test("segunda llamada con mismo gmailMessageId → omitida antes de importar, sin datos nuevos", async () => {
    const pol = makePolicy({ startDate: "2026-09-01", endDate: "2027-01-01", premium: 130000 });
    const res = await callConfirm([pol], { gmailMessageId: GMAIL_MSG_A });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.gmailAlreadyProcessed).toBe(true);
    expect(body.rebillings).toBe(0);
    // Los conteos en DB no deben haber cambiado
    expect(await countRebillings()).toBe(1);
    expect(await countInstallments()).toBe(4);

    await cleanTestRebillings();
    await cleanGmailLog(GMAIL_MSG_A);
  });
});

// ── CASO E: mismo período, premio diferente ───────────────────────────────────

describe("Caso E — mismo período, premio diferente", () => {
  test("dos movimientos con mismo período pero distinto premium → ambos se crean", async () => {
    await cleanTestRebillings();

    const pol1 = makePolicy({ startDate: "2026-10-01", endDate: "2027-02-01", premium: 200000, endoso: "2" });
    const pol2 = makePolicy({ startDate: "2026-10-01", endDate: "2027-02-01", premium: 200001, endoso: "3" });

    // Primera importación
    const r1 = await callConfirm([pol1]);
    expect((await r1.json()).rebillings).toBe(1);
    expect(await countRebillings()).toBe(1);

    // Segunda importación: mismo período, premio diferente → NO es duplicado
    const r2 = await callConfirm([pol2]);
    const body2 = await r2.json();
    expect(body2.rebillings).toBe(1);
    expect(body2.duplicados).toBe(0);
    expect(await countRebillings()).toBe(2);

    await cleanTestRebillings();
  });
});

// ── CASO F: rollback por error en cuota ──────────────────────────────────────

describe("Caso F — rollback si falla inserción de cuota", () => {
  test("error en amount=null → no queda rebilling ni cuota parcial", async () => {
    await cleanTestRebillings();

    const pol = makePolicy({
      startDate: "2026-11-01",
      endDate: "2027-03-01",
      premium: 150000,
      endoso: "4",
      installments: [
        { number: 1, dueDate: "2026-11-01", amount: null }, // ← fuerza NOT NULL violation
      ],
    });

    const res = await callConfirm([pol]);
    expect(res.status).toBe(200);
    const body = await res.json();

    // El error debe aparecer en la lista, el movimiento se skipea
    expect(body.skipped).toBeGreaterThanOrEqual(1);
    expect(body.rebillings).toBe(0);

    // La transacción hizo rollback: ni rebilling ni cuota deben existir
    expect(await countRebillings()).toBe(0);
    expect(await countInstallments()).toBe(0);
  });
});

// ── CASO G: doble solicitud simultánea ───────────────────────────────────────

describe("Caso G — doble solicitud simultánea", () => {
  /**
   * LIMITACIÓN: un proceso único con SQLite file: comparte un solo cliente de DB.
   * Promise.all con dos app.fetch() que usan el mismo cliente deja cursores abiertos
   * al interleave, lo cual invalida la conexión para transacciones subsiguientes
   * ("cannot commit transaction - SQL statements in progress").
   *
   * Por eso usamos dos requests secuenciales rápidos. El resultado demuestra que
   * enCheckDuplicateRebilling detecta el duplicado después de que R1 confirma.
   * La ventana de carrera real (<1 ms, dos procesos distintos) requeriría
   * UNIQUE INDEX para protección absoluta — ver comentario al inicio del archivo.
   */
  test("dos requests secuenciales rápidos — R2 detecta el duplicado que dejó R1", async () => {
    await cleanTestRebillings();

    const pol = makePolicy({ startDate: "2026-12-01", endDate: "2027-04-01", premium: 160000, endoso: "5" });

    const res1 = await callConfirm([pol]);
    const body1 = await res1.json();

    const res2 = await callConfirm([{ ...pol }]);
    const body2 = await res2.json();

    expect(res1.status).toBe(200);
    expect(body1.rebillings).toBe(1);

    expect(res2.status).toBe(200);
    expect(body2.rebillings).toBe(0);
    expect(body2.duplicados).toBeGreaterThanOrEqual(1);

    expect(await countRebillings()).toBe(1);

    await cleanTestRebillings();
  });
});

// ── CASO H: regresión — flujos existentes no rotos ───────────────────────────

describe("Caso H — regresión", () => {
  test("póliza nueva (ALTA/RENOVACION) se importa sin interferir con dedup de rebillings", async () => {
    // Una póliza nueva (sin PRORROGA/ENDOSO) usa policyNumber distinto
    const newPolicyNumber = "TEST-EN-DEDUP-NEW-001";

    // Limpiar si quedó de una corrida anterior
    const existingPol = await db.select({ id: policies.id })
      .from(policies).where(eq(policies.policyNumber, newPolicyNumber)).get();
    if (existingPol) {
      await db.delete(policyInstallments).where(eq(policyInstallments.policyId, existingPol.id));
      await db.delete(policies).where(eq(policies.id, existingPol.id));
    }

    const newPol = {
      policyNumber: newPolicyNumber,
      movType: "ALTA",
      startDate: "2026-06-01",
      endDate: "2027-06-01",
      premium: 50000,
      insuredName: "PRUEBA REGRESION ALTA",
      installments: [
        { number: 1, dueDate: "2026-06-01", amount: 12500 },
        { number: 2, dueDate: "2026-09-01", amount: 12500 },
      ],
    };

    const res = await callConfirm([newPol]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);

    // Segunda llamada → duplicado de póliza detectado (lógica existente)
    const res2 = await callConfirm([newPol]);
    const body2 = await res2.json();
    expect(body2.imported).toBe(0);
    expect(body2.duplicados).toBeGreaterThanOrEqual(1);

    // Limpieza
    const pol = await db.select({ id: policies.id })
      .from(policies).where(eq(policies.policyNumber, newPolicyNumber)).get();
    if (pol) {
      await db.delete(policyInstallments).where(eq(policyInstallments.policyId, pol.id));
      await db.delete(policies).where(eq(policies.id, pol.id));
    }
  });

  test("PRORROGA y ENDOSO conviven para la misma póliza en períodos distintos", async () => {
    await cleanTestRebillings();

    const prorroga = makePolicy({ startDate: "2026-06-01", endDate: "2026-10-01", premium: 100000, movType: "PRORROGA", endoso: "1" });
    const endoso   = makePolicy({ startDate: "2026-10-01", endDate: "2027-02-01", premium: 105000, movType: "ENDOSO",   endoso: "2" });

    const r1 = await callConfirm([prorroga]);
    expect((await r1.json()).rebillings).toBe(1);

    const r2 = await callConfirm([endoso]);
    const body2 = await r2.json();
    expect(body2.endosos).toBe(1);
    expect(body2.duplicados).toBe(0);

    expect(await countRebillings()).toBe(2);

    await cleanTestRebillings();
  });
});

// ── CASOS I–M: retry de withImportLogRetry ────────────────────────────────────

const FAST_DELAYS = [1, 1, 1]; // delays mínimos para que los tests sean rápidos
const SAFE_WARNING = "La importación se completó, pero no pudo registrarse el archivo como procesado.";

describe("Casos I–M — withImportLogRetry", () => {
  test("I — primer intento exitoso: logId presente, sin logWarning", async () => {
    await cleanTestRebillings();

    const pol = makePolicy({ startDate: "2027-01-01", endDate: "2027-05-01", premium: 170000, endoso: "10" });
    const res = await callConfirm([pol]);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.rebillings).toBe(1);
    expect(typeof body.logId).toBe("number");
    expect(body.logWarning).toBeUndefined();

    await cleanTestRebillings();
  });

  test("J — falla una vez con SQLITE_BUSY, luego tiene éxito", async () => {
    let calls = 0;
    const doInsert = async (): Promise<number | null> => {
      calls++;
      if (calls === 1) throw makeBusyError();
      return 9999;
    };

    const result = await withImportLogRetry(doInsert, FAST_DELAYS);

    expect(result.logId).toBe(9999);
    expect(result.logWarning).toBeUndefined();
    expect(calls).toBe(2); // 1 fallo + 1 éxito
  });

  test("K — tres reintentos SQLITE_BUSY: logId null, logWarning seguro", async () => {
    let calls = 0;
    const doInsert = async (): Promise<number | null> => {
      calls++;
      throw makeBusyError();
    };

    const result = await withImportLogRetry(doInsert, FAST_DELAYS);

    expect(result.logId).toBeNull();
    expect(result.logWarning).toBe(SAFE_WARNING);
    expect(calls).toBe(4); // intento inicial + 3 reintentos
  });

  test("L — error no-BUSY: sin reintentos, advertencia segura", async () => {
    let calls = 0;
    const doInsert = async (): Promise<number | null> => {
      calls++;
      const e: any = new Error("UNIQUE constraint failed: import_logs.gmail_message_id");
      e.code = "SQLITE_CONSTRAINT";
      throw e;
    };

    const result = await withImportLogRetry(doInsert, FAST_DELAYS);

    expect(result.logId).toBeNull();
    expect(result.logWarning).toBe(SAFE_WARNING);
    expect(calls).toBe(1); // sin reintentos para errores no-BUSY
  });

  test("M — logWarning no contiene SQL, URL, token ni stack trace", async () => {
    const sensitivePatterns = [
      /\b(SELECT|INSERT|DELETE|UPDATE|FROM|WHERE|VALUES)\b/i,
      /https?:\/\//i,
      /libsql:\/\//i,
      /eyJ[a-zA-Z0-9_-]{5,}/,   // patrón JWT
      /\s+at\s+\w/,              // stack trace ("  at functionName")
      /constraint failed/i,
    ];

    // Escenario K: SQLITE_BUSY x4
    const rK = await withImportLogRetry(
      () => Promise.reject(makeBusyError()),
      FAST_DELAYS,
    );

    // Escenario L: error no-BUSY con mensaje que contiene SQL y URL
    const rL = await withImportLogRetry(
      () => {
        const e: any = new Error("UNIQUE constraint failed: import_logs.gmail -- libsql://secret.turso.io eyJtoken");
        e.code = "SQLITE_CONSTRAINT";
        return Promise.reject(e);
      },
      FAST_DELAYS,
    );

    for (const { logWarning } of [rK, rL]) {
      expect(typeof logWarning).toBe("string");
      for (const pattern of sensitivePatterns) {
        expect(logWarning ?? "").not.toMatch(pattern);
      }
    }
  });
});
