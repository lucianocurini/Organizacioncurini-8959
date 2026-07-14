/**
 * Guarda central: NODE_ENV=test nunca puede conectarse a libsql/Turso.
 * Función pura para poder testearla sin crear un cliente de base real —
 * ver src/api/database/index.ts, que la invoca ANTES de createClient().
 *
 * Origen: incidente 2026-07 — bun test corrido desde la raíz del repo
 * resolvía DATABASE_URL a producción (Bun saltea .env.local cuando
 * NODE_ENV=test, y la raíz no tenía .env.test propio) y varios tests
 * escribieron fixtures TEST-* directo en Turso.
 */
export interface DatabaseEnvironmentInput {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
}

export function assertSafeDatabaseEnvironment({ nodeEnv, databaseUrl }: DatabaseEnvironmentInput): void {
  if (nodeEnv !== "test") return;
  if ((databaseUrl ?? "").startsWith("file:")) return;

  throw new Error(
    "REFUSED_TEST_DATABASE_CONNECTION: NODE_ENV=test requiere que DATABASE_URL " +
    "empiece con 'file:'. Los tests nunca pueden conectarse a libsql/Turso " +
    "(producción), sin importar desde qué directorio se ejecuten."
  );
}
