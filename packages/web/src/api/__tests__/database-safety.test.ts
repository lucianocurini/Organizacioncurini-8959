/**
 * Tests de seguridad — incidente 2026-07: fixtures TEST-/QA- terminaron
 * escritas en Turso producción porque nada validaba a qué DATABASE_URL se
 * estaba conectando. Cubre:
 *  - assertSafeDatabaseEnvironment (guarda central de database/index.ts)
 *  - scripts/qa-inspect.ts y scripts/qa-fixtures-cobrar-lote.ts: deben
 *    ignorar cualquier DATABASE_URL ambiente y forzar dev.db local.
 *
 * Nunca se conecta a Turso — los "libsql://" usados acá son hosts que no
 * resuelven, a propósito: si algún día alguno de estos escribiera ahí en vez
 * de en dev.db, el test colgaría/fallaría por timeout de red, nunca por un
 * error de SQL local.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { database as db } from "../database/index";
import { assertSafeDatabaseEnvironment } from "../database/assert-safe-environment";
import { users, insureds, policies, policyInstallments } from "../database/schema";
import { eq, inArray } from "drizzle-orm";

const FAKE_TURSO_URL = "libsql://this-host-does-not-exist-refused-test-db.turso.io";

describe("assertSafeDatabaseEnvironment", () => {
  test("NODE_ENV=test + libsql:// → aborta con REFUSED_TEST_DATABASE_CONNECTION", () => {
    expect(() => assertSafeDatabaseEnvironment({ nodeEnv: "test", databaseUrl: FAKE_TURSO_URL }))
      .toThrow("REFUSED_TEST_DATABASE_CONNECTION");
  });

  test("NODE_ENV=test + file: → permite", () => {
    expect(() => assertSafeDatabaseEnvironment({ nodeEnv: "test", databaseUrl: "file:dev.db" })).not.toThrow();
  });

  test("NODE_ENV=test + URL ausente → aborta (nunca crea un cliente con url undefined)", () => {
    expect(() => assertSafeDatabaseEnvironment({ nodeEnv: "test", databaseUrl: undefined }))
      .toThrow("REFUSED_TEST_DATABASE_CONNECTION");
  });

  test("NODE_ENV distinto de 'test' + libsql:// → no bloquea la conexión normal del servidor/producción", () => {
    expect(() => assertSafeDatabaseEnvironment({ nodeEnv: "production", databaseUrl: FAKE_TURSO_URL })).not.toThrow();
    expect(() => assertSafeDatabaseEnvironment({ nodeEnv: "development", databaseUrl: FAKE_TURSO_URL })).not.toThrow();
    expect(() => assertSafeDatabaseEnvironment({ nodeEnv: undefined, databaseUrl: FAKE_TURSO_URL })).not.toThrow();
  });

  test("el mensaje de error no imprime la URL completa ni un token", () => {
    try {
      assertSafeDatabaseEnvironment({ nodeEnv: "test", databaseUrl: `${FAKE_TURSO_URL}?authToken=super-secreto` });
      throw new Error("no debería llegar acá");
    } catch (e: any) {
      expect(e.message).not.toContain(FAKE_TURSO_URL);
      expect(e.message).not.toContain("super-secreto");
    }
  });
});

describe("scripts QA — nunca escriben/leen contra libsql:// aunque el ambiente esté mal configurado", () => {
  const QA_INSPECT = `${import.meta.dir}/../../../scripts/qa-inspect.ts`;
  const QA_FIXTURES = `${import.meta.dir}/../../../scripts/qa-fixtures-cobrar-lote.ts`;
  const createdInsuredIds: number[] = [];
  const createdPolicyIds: number[] = [];
  const createdUserIds: number[] = [];

  afterEach(async () => {
    if (createdPolicyIds.length) {
      await db.delete(policyInstallments).where(inArray(policyInstallments.policyId, createdPolicyIds));
      await db.delete(policies).where(inArray(policies.id, createdPolicyIds));
      createdPolicyIds.length = 0;
    }
    if (createdInsuredIds.length) {
      await db.delete(insureds).where(inArray(insureds.id, createdInsuredIds));
      createdInsuredIds.length = 0;
    }
    if (createdUserIds.length) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
      createdUserIds.length = 0;
    }
  });

  test("qa-inspect.ts ignora DATABASE_URL ambiente apuntando a Turso y lee dev.db local", async () => {
    const proc = Bun.spawn(["bun", QA_INSPECT], {
      env: { ...process.env, DATABASE_URL: FAKE_TURSO_URL, DATABASE_AUTH_TOKEN: "fake" },
      stdout: "pipe", stderr: "pipe",
      cwd: `${import.meta.dir}/../../..`,
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("MODE=QA_LOCAL_INSPECT");
    // Datos reales de dev.db (seed local), nunca del host Turso falso.
    expect(stdout).toContain("admin@test.com");
  }, 15000);

  test("qa-fixtures-cobrar-lote.ts ignora DATABASE_URL ambiente apuntando a Turso — nunca intenta esa conexión", async () => {
    // No se pre-limpia qa-cobrar-lote@test.local: puede ser una sesión QA real
    // en curso (ver historial de este repo) — este test no debe tocarla. Por
    // eso no exige que el script complete su lógica de negocio (podría chocar
    // con el email único de una fixture real ya existente en dev.db); solo
    // exige la propiedad de seguridad: pase lo que pase, jamás intenta hablar
    // con el host Turso falso.
    const proc = Bun.spawn(["bun", QA_FIXTURES], {
      env: { ...process.env, DATABASE_URL: FAKE_TURSO_URL, DATABASE_AUTH_TOKEN: "fake" },
      stdout: "pipe", stderr: "pipe",
      cwd: `${import.meta.dir}/../../..`,
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    expect(stdout).toContain("MODE=QA_LOCAL_FIXTURES");

    const fakeHost = "this-host-does-not-exist-refused-test-db";
    expect(stdout).not.toContain(fakeHost);
    expect(stderr).not.toContain(fakeHost);

    if (exitCode === 0) {
      const jsonStart = stdout.indexOf("{");
      const parsed = JSON.parse(stdout.slice(jsonStart));
      createdUserIds.push(parsed.qaUser.id);
      createdInsuredIds.push(...parsed.allIds.insureds);
      createdPolicyIds.push(...parsed.allIds.policies);
      // Si hubiera escrito contra el host Turso falso, esta fila no existiría
      // en dev.db (y el proceso ni siquiera habría terminado en 15s).
      const found = await db.select({ id: users.id }).from(users).where(eq(users.id, parsed.qaUser.id)).get();
      expect(found).toBeDefined();
    } else {
      // Falló por otra razón local (ej. email único ya existente en dev.db)
      // — nunca por no poder resolver/conectar al host Turso falso.
      expect(stderr).not.toContain("ENOTFOUND");
      expect(stderr).not.toContain("getaddrinfo");
    }
  }, 15000);
});
