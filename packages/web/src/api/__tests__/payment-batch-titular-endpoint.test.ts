/**
 * Etapa 1B-3-E — cierre: test HTTP REAL (app.fetch) del modo titular de
 * POST /payment-batches. Cubre lo que payment-batch-titular-integration.
 * test.ts explícitamente NO cubre (ver su propia cabecera: "no hay ningún
 * test HTTP contra app.fetch en este archivo") — el handler completo de
 * index.ts, incluidas las validaciones que corren ANTES de invocar
 * runAccountHolderFundingBatch (cuota ya pagada/elegibilidad, posible cheque
 * duplicado), que es exactamente donde vivía el bug real de idempotencia que
 * esta etapa corrigió: esas validaciones leían estado que el propio cobro
 * exitoso ya había mutado, y rechazaban un reintento legítimo con la misma
 * idempotencyKey en vez de devolver la respuesta cacheada.
 *
 * Aislamiento de PROCESO (no solo de DB) — mismo patrón y mismo motivo que
 * duplicate-invalidation-consumers.test.ts/.runner.ts: este archivo NUNCA
 * importa `app` (src/api/index.ts) ni `database` (src/api/database/index.ts)
 * — ni directa ni indirectamente — dentro del proceso principal de
 * `bun test`. Esos dos módulos abren su conexión a `process.env.DATABASE_URL`
 * una sola vez, al importarse, y ESM cachea el módulo por proceso: si
 * CUALQUIER otro archivo de la suite completa los importaba primero (orden
 * de descubrimiento de `bun test`, no controlable — p.ej. database-safety.
 * test.ts, que importa `database` a propósito contra dev.db), el import
 * dinámico de un test autocontenido llegaría tarde y recibiría el módulo YA
 * cacheado apuntando a dev.db real.
 *
 * Por eso todo el trabajo real (DB descartable en un tmpdir, import de
 * `app`/`database`, las verificaciones HTTP) vive en un PROCESO HIJO nuevo —
 * payment-batch-titular-endpoint.runner.ts, lanzado acá vía Bun.spawn — que
 * jamás comparte caché de módulos con el resto de la suite. Este archivo
 * solo orquesta ese proceso hijo y transcribe sus resultados a
 * test()/expect() para que la suite completa los reporte igual que
 * cualquier otro test, y puede correr mezclado con el resto de la suite
 * (incluidos archivos que sí importan `database/index.ts` contra dev.db)
 * sin ningún riesgo de contaminación cruzada.
 */
import { test, expect, beforeAll, describe } from "bun:test";
import { join } from "path";

const RUNNER_PATH = join(import.meta.dir, "payment-batch-titular-endpoint.runner.ts");
const WEB_ROOT = join(import.meta.dir, "..", "..", "..");
const CHILD_TIMEOUT_MS = 30_000;

interface CheckResult {
  name: string;
  pass: boolean;
  message?: string;
}

// Redacta cualquier URL con esquema (file:/https:/libsql:) y cualquier
// token/credencial antes de que el stderr del hijo pueda llegar a la salida
// del test — defensa en profundidad, aunque el hijo nunca debería imprimir
// ninguno de los dos.
function sanitize(text: string): string {
  return text
    .replace(/(?:libsql|https?|file):\/\/\S+/gi, "[url-redactada]")
    .replace(/(DATABASE_AUTH_TOKEN|authToken)\s*[=:]\s*\S+/gi, "$1=[redactado]");
}

let exitCode: number | null = null;
let timedOut = false;
let results: CheckResult[] = [];
let setupError: string | null = null;
let sanitizedStderr = "";
let rawStdout = "";

beforeAll(async () => {
  const proc = Bun.spawn(["bun", RUNNER_PATH], {
    env: { ...process.env },
    cwd: WEB_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, CHILD_TIMEOUT_MS);

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  exitCode = code;
  rawStdout = stdout;
  sanitizedStderr = sanitize(stderr);

  const marker = "RESULT_JSON:";
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex === -1) {
    setupError = timedOut
      ? `El proceso hijo no terminó dentro de ${CHILD_TIMEOUT_MS}ms (timeout).`
      : "El proceso hijo no imprimió resultados (falló antes de completar las verificaciones).";
    return;
  }

  try {
    const parsed = JSON.parse(stdout.slice(markerIndex + marker.length).trim()) as { results: CheckResult[] };
    results = parsed.results;
  } catch {
    setupError = "No se pudo parsear el JSON de resultados del proceso hijo.";
  }
}, CHILD_TIMEOUT_MS + 10_000);

function resultFor(name: string): CheckResult | undefined {
  return results.find((r) => r.name === name);
}

function assertCheck(name: string): void {
  if (setupError) {
    throw new Error(`${setupError}${sanitizedStderr ? `\n--- stderr del proceso hijo ---\n${sanitizedStderr}` : ""}`);
  }
  const r = resultFor(name);
  if (!r) {
    throw new Error(`El proceso hijo no reportó un resultado para "${name}".${sanitizedStderr ? `\n--- stderr ---\n${sanitizedStderr}` : ""}`);
  }
  if (!r.pass) {
    throw new Error(`${r.message ?? "falló sin mensaje"}${sanitizedStderr ? `\n--- stderr del proceso hijo ---\n${sanitizedStderr}` : ""}`);
  }
  expect(r.pass).toBe(true);
}

describe("Proceso hijo aislado (payment-batch-titular-endpoint.runner.ts)", () => {
  test("termina con exit code 0, reporta stdout estructurado (RESULT_JSON) y stderr limpio", () => {
    if (setupError) {
      throw new Error(`${setupError}${sanitizedStderr ? `\n--- stderr del proceso hijo ---\n${sanitizedStderr}` : ""}`);
    }
    if (exitCode !== 0) {
      throw new Error(`exit code ${exitCode} (esperado 0).${sanitizedStderr ? `\n--- stderr del proceso hijo ---\n${sanitizedStderr}` : ""}`);
    }
    // stdout estructurado: exactamente una línea RESULT_JSON parseable, ya
    // consumida arriba — acá se confirma además que no quedó texto crudo de
    // error/stack mezclado con ella.
    expect(rawStdout).toContain("RESULT_JSON:");
    expect(sanitizedStderr).toBe("");
    expect(results.length).toBe(6);
    expect(results.every((r) => r.pass)).toBe(true);
  });
});

describe("1. primer request titular válido — crédito preexistente + medios reales (<destino) + redondeo", () => {
  test("201, movimiento aplicacion_saldo_favor con signo correcto, ajuste de redondeo con signo correcto, allocations completas, filas únicas", () => {
    assertCheck("1. primer request titular válido — crédito+medios(<destino)+redondeo: 201, movimientos/allocations/idempotencia correctos");
  });
});

describe("2. replay idéntico", () => {
  test("mismo status/body/id, sin advertencias de cuota pagada ni cheque duplicado, cero filas nuevas en ninguna tabla", () => {
    assertCheck("2. replay idéntico — mismo status/body/id, sin advertencias, cero filas nuevas");
  });
});

describe("3. misma idempotencyKey, contenido distinto", () => {
  test("409 de dominio, nunca 500 ni error UNIQUE crudo, sin filas nuevas", () => {
    assertCheck("3. misma idempotencyKey, contenido distinto — 409 de dominio, sin filas nuevas");
  });
});

describe("4. snapshot de idempotencia cacheado inválido", () => {
  test("500 seguro y genérico, sin filtrar SQL/JSON crudo/stack, sin filas nuevas", () => {
    assertCheck("4. snapshot de idempotencia cacheado inválido — 500 seguro, sin fugas, sin filas nuevas");
  });
});

describe("5. el lookup temprano de idempotencia reutiliza el manejo de errores HTTP existente", () => {
  test("FundingIdempotencyConflictError pasa por mapAccountHolderFundingBatchError", () => {
    assertCheck("5a. FundingIdempotencyConflictError pasa por mapAccountHolderFundingBatchError -> 409 { error }");
  });

  test("snapshot corrupto lo resuelve formatAccountHolderFundingBatchSuccess (nunca lanza)", () => {
    assertCheck("5b. snapshot corrupto lo resuelve formatAccountHolderFundingBatchSuccess (nunca lanza, nunca pasa por mapAccountHolderFundingBatchError)");
  });
});
