/**
 * Contado por período en un lote mixto (Migración 0037) — test HTTP real
 * (app.fetch) contra una SQLite descartable en un PROCESO HIJO
 * (mixed-batch-cash-period-endpoint.runner.ts). Este archivo nunca importa
 * `app`/`database`: solo orquesta el proceso hijo y transcribe sus resultados.
 * Datos 100% sintéticos; nunca dev.db ni Turso.
 */
import { test, expect, beforeAll, describe } from "bun:test";
import { join } from "path";

const RUNNER_PATH = join(import.meta.dir, "mixed-batch-cash-period-endpoint.runner.ts");
const WEB_ROOT = join(import.meta.dir, "..", "..", "..");
const CHILD_TIMEOUT_MS = 180_000;

const EXPECTED_CHECKS = [
  "C1. un cheque de $37.000: contado de la refacturación ($27.000) + 2 cuotas de otra póliza; cheque registrado una vez, base sin nominal",
  "C2. dos cheques ($20.000 y $17.000) que no coinciden con los subtotales: se registran ambos por su importe real",
  "C3. recibido distinto de lo imputado → 400 sin crear nada (ni con ajuste por redondeo ni con saldo)",
  "C4. cuota del período también como ítem suelto → 400; dos contados en un lote → 400; importe en el ítem → 400",
  "C5. contado ya cobrado → 409 (sin duplicar); período con una cuota ya cobrada → 409",
  "C6. recargo Pronto Pago: mismas reglas para las cuotas comunes; el contado nunca suma recargo",
  "C7. pendientes de rendir: el contado es UNA partida por $27.000 (no bloqueada) y las cuotas comunes siguen sueltas",
  "C8. rendición parcial: cuotas comunes por transferencia y el contado aparte; revertir el contado no toca las comunes; Caja sin inconsistencias",
  "C9. anulación: bloqueada con una partida rendida; sin rendir anula todo, cheque incluido, y el contado vuelve a estar disponible",
  "C10. GET /payments: el contado del lote mixto es una fila por $27.000 ('lote'); las cuotas comunes siguen como filas; stats sin nominal",
  "C11. contado individual (POST /payment-batches/cash-period-payment): vincula sus cuotas, se rinde con sus instrumentos reales y se revierte igual que antes",
  "C12. un contado creado antes de 0037 (hijos sin vínculo) queda vinculado por el backfill y sigue funcionando",
];

interface CheckResult { name: string; pass: boolean; message?: string }

function sanitize(text: string): string {
  return text
    .replace(/(?:libsql|https?|file):\/\/\S+/gi, "[url-redactada]")
    .replace(/(DATABASE_AUTH_TOKEN|authToken)\s*[=:]\s*\S+/gi, "$1=[redactado]");
}

let exitCode: number | null = null;
let results: CheckResult[] = [];
let setupError: string | null = null;
let sanitizedStderr = "";

beforeAll(async () => {
  const proc = Bun.spawn(["bun", RUNNER_PATH], { env: { ...process.env }, cwd: WEB_ROOT, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, CHILD_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  exitCode = code;
  sanitizedStderr = sanitize(stderr);
  const marker = "RESULT_JSON:";
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) {
    setupError = timedOut ? `El proceso hijo no terminó dentro de ${CHILD_TIMEOUT_MS}ms.` : "El proceso hijo no imprimió resultados.";
    return;
  }
  try {
    results = (JSON.parse(stdout.slice(idx + marker.length).trim()) as { results: CheckResult[] }).results;
  } catch {
    setupError = "No se pudo parsear el JSON de resultados del proceso hijo.";
  }
}, CHILD_TIMEOUT_MS + 10_000);

function assertCheck(name: string): void {
  const stderrNote = sanitizedStderr ? `\n--- stderr del proceso hijo ---\n${sanitizedStderr}` : "";
  if (setupError) throw new Error(`${setupError}${stderrNote}`);
  const r = results.find((x) => x.name === name);
  if (!r) throw new Error(`El proceso hijo no reportó "${name}".${stderrNote}`);
  if (!r.pass) throw new Error(`${r.message ?? "falló sin mensaje"}${stderrNote}`);
  expect(r.pass).toBe(true);
}

describe("Proceso hijo aislado (mixed-batch-cash-period-endpoint.runner.ts)", () => {
  test("exit code 0 y exactamente los checks esperados", () => {
    if (setupError) throw new Error(`${setupError}\n${sanitizedStderr}`);
    expect(results.map((r) => r.name).sort()).toEqual([...EXPECTED_CHECKS].sort());
    expect(exitCode).toBe(0);
  });
});

describe("Contado por período en un lote mixto", () => {
  for (const name of EXPECTED_CHECKS) {
    test(name, () => assertCheck(name));
  }
});
