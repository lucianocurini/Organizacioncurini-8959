/**
 * Migración 0035 — invalidación trazable de cuotas/refacturaciones
 * duplicadas. Tests de regresión END-TO-END (vía HTTP, app.fetch) que
 * cubren los consumidores restantes que no tienen su propio archivo de
 * helpers puros: POST /payments, PUT /payments/:id, POST /payment-batches,
 * GET /installments/pending-for-payment, GET /remittances/uncollected,
 * POST /remittances, PUT /installments/:id.
 *
 * Aislamiento de PROCESO (no solo de DB): este archivo NUNCA importa `app`
 * (src/api/index.ts) ni `database` (src/api/database/index.ts) — ni directa
 * ni indirectamente — dentro del proceso principal de `bun test`. Esos dos
 * módulos abren su conexión a `process.env.DATABASE_URL` una sola vez, al
 * importarse, y ESM cachea el módulo por proceso: si CUALQUIER otro archivo
 * de la suite completa los importaba primero, el intento anterior de este
 * archivo de "apuntar DATABASE_URL a una DB descartable antes del import"
 * llegaba tarde — el import dinámico devolvía el módulo ya cacheado
 * apuntando a `dev.db` real, y las verificaciones de acá terminaban
 * escribiendo fixtures reales (incluida una cuota `status='duplicada'`) en
 * `dev.db`, contaminando otro archivo de la suite completa (+1 fail que no
 * aparecía corriendo este archivo solo).
 *
 * Por eso todo el trabajo real (DB descartable en un tmpdir, import de
 * `app`/`database`, las 8 verificaciones) vive en un PROCESO HIJO nuevo —
 * duplicate-invalidation-consumers.runner.ts, lanzado acá vía Bun.spawn — que
 * jamás comparte caché de módulos con el resto de la suite. Este archivo
 * solo orquesta ese proceso hijo y transcribe sus resultados a
 * test()/expect() para que la suite completa los reporte igual que antes.
 */
import { test, expect, beforeAll, describe } from "bun:test";
import { join } from "path";

const RUNNER_PATH = join(import.meta.dir, "duplicate-invalidation-consumers.runner.ts");
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

describe("Proceso hijo aislado (duplicate-invalidation-consumers.runner.ts)", () => {
  test("termina con exit code 0 y reporta las 8 verificaciones", () => {
    if (setupError) {
      throw new Error(`${setupError}${sanitizedStderr ? `\n--- stderr del proceso hijo ---\n${sanitizedStderr}` : ""}`);
    }
    if (exitCode !== 0) {
      throw new Error(`exit code ${exitCode} (esperado 0).${sanitizedStderr ? `\n--- stderr del proceso hijo ---\n${sanitizedStderr}` : ""}`);
    }
    expect(results.length).toBe(8);
  });
});

describe("POST /payments — rechaza imputar sobre una cuota 'duplicada' (Cobranzas / Imputar pago)", () => {
  test("409, no crea ningún payment, la cuota queda intacta", () => {
    assertCheck("POST /payments — 409, no crea ningún payment, la cuota queda intacta");
  });
});

describe("GET /installments/pending-for-payment — una cuota 'duplicada' nunca aparece (Cobrar en lote)", () => {
  test("cuota duplicada ausente de la lista; su gemela real sí aparece", () => {
    assertCheck("GET /installments/pending-for-payment — cuota duplicada ausente, gemela real presente");
  });
});

describe("POST /payment-batches — rechaza un ítem installment que es 'duplicada' (Cobrar en lote)", () => {
  test("409, no crea el lote ni ningún payment", () => {
    assertCheck("POST /payment-batches — 409, no crea el lote ni ningún payment");
  });
});

describe("GET /remittances/uncollected — una cuota 'duplicada' nunca se ofrece como adeudada (Rendiciones)", () => {
  test("cuota duplicada ausente de la lista de adeudadas", () => {
    assertCheck("GET /remittances/uncollected — cuota duplicada ausente de adeudadas");
  });
});

describe("POST /remittances — rechaza declarar como adeudada una cuota 'duplicada' (defensa en profundidad)", () => {
  test("409, no crea la rendición", () => {
    assertCheck("POST /remittances — 409, no crea la rendición");
  });
});

describe("PUT /installments/:id — protege el registro de auditoría 'duplicada' (Migración 0035)", () => {
  test("editar una cuota ya 'duplicada' → 409, no cambia nada", () => {
    assertCheck("PUT /installments/:id — editar duplicada → 409, no cambia nada");
  });

  test("marcar una cuota real como 'duplicada' desde esta vía genérica → 400, rechazada", () => {
    assertCheck("PUT /installments/:id — marcar real como duplicada vía genérica → 400, rechazada");
  });

  test("editar una cuota real (no duplicada) sigue funcionando normalmente (200)", () => {
    assertCheck("PUT /installments/:id — editar real (no duplicada) sigue funcionando (200)");
  });
});
