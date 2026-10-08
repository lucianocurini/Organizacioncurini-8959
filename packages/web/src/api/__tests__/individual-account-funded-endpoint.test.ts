/**
 * Pago individual con saldo de cuenta corriente — POST /payments/account-funded,
 * test HTTP real (app.fetch) contra una SQLite descartable en un PROCESO HIJO
 * (individual-account-funded-endpoint.runner.ts). Mismo motivo de aislamiento
 * que payment-batch-titular-endpoint.test.ts: este archivo nunca importa
 * `app`/`database`, solo orquesta el proceso hijo y transcribe sus resultados.
 *
 * Cubre: los 4 ejemplos económicos (con Caja antes/después del pago, después
 * de rendir, de anular la rendición y de anular el pago), Pronto Pago con
 * saldo total/parcial/insuficiente, medios propios/directos/combinados,
 * crédito antes que deuda (individual, lote con titular y lote legacy), cero
 * medios solo en el endpoint nuevo, titular siempre desde la póliza, rechazo
 * de campos de financiación en POST/PUT /payments, idempotencia (doble clic,
 * reintento, clave reutilizada), saldo que cambia dentro de la transacción,
 * fecha bloqueada, presentación como pago individual en GET /payments, ciclo
 * de vida y ausencia de la fila de idempotencia que lo identifica, y notas
 * editadas después del cobro.
 */
import { test, expect, beforeAll, describe } from "bun:test";
import { join } from "path";

const RUNNER_PATH = join(import.meta.dir, "individual-account-funded-endpoint.runner.ts");
const WEB_ROOT = join(import.meta.dir, "..", "..", "..");
const CHILD_TIMEOUT_MS = 120_000;

const EXPECTED_CHECKS = [
  "E1. 30.000 saldo + 70.000 transferencia: pagada, cuenta 0, Caja +70.000 real; rendir/anular rendición/anular pago restituyen exacto",
  "E1a. anular antes de anular la rendición → 409",
  "E2. 70.000 efectivo + 30.000 deuda: pagada, Caja +70.000, cuenta −30.000; al rendir la oficina adelanta 30.000",
  "E3. 100.000 de saldo sin medio real: cero splits, Caja sin dinero nuevo; rendición con cero medios reales",
  "E4. 110.000 reales: pagada, nuevo saldo a favor +10.000, Caja +110.000",
  "E4b. anulación con saldo ya consumido por un movimiento posterior → 409 revisión manual, nada cambia",
  "PP1. Pronto Pago con saldo total: el recargo $800 se mantiene y se cubre con saldo, cero medios",
  "PP2. Pronto Pago con saldo parcial + efectivo",
  "PP3. Pronto Pago con saldo insuficiente: sin deuda → 400 sin filas; con deuda autorizada → 201 con saldo deudor del recargo",
  "M1. saldo + transferencia_compania: el dinero directo no entra a Caja; rendición con medio directo",
  "M2. saldo + efectivo + cheque (combinado propio): cheque en cartera del split del cobro",
  "M3. medios propios + directos mezclados → 400",
  "C1. saldo disponible + deuda: exige agotar el saldo; con el saldo agotado sí crea la deuda",
  "C2. redondeo con saldo disponible sin aplicar → 400",
  "C3. redondeo hasta $5 con saldo agotado → 201; más de $5 → 400",
  "C4. sobrante real con saldo aplicado → 400 claro (no se consume saldo y se crea saldo nuevo a la vez)",
  "C5. lote con titular: misma regla (saldo sin agotar + deuda → 400)",
  "C6. lote legacy: saldo_deudor con saldo a favor disponible → 409 CREDIT_AVAILABLE_BEFORE_DEBT; sin saldo → 201",
  "Z1. cero medios sin saldo aplicado → 400",
  "Z2. cero medios rechazado en flujos tradicionales (POST /payments, lote legacy y lote con titular)",
  "T1. accountHolderInsuredId en el body → 400; campos desconocidos → 400; titular derivado de la póliza",
  "R1. POST /payments y PUT /payments/:id rechazan campos de financiación",
  "I1. doble clic (dos requests simultáneos con la misma clave) → un solo cobro, misma respuesta",
  "I2. la clave del pago individual no resuelve en /payment-batches (endpoint separado en la idempotencia)",
  "I3. dos claves distintas para la misma cuota → la segunda 409, sin cobro duplicado",
  "I4. lote con titular: doble clic simultáneo → un solo cobro y la base sigue operativa después",
  "S1. el saldo cambia dentro de la transacción → error y rollback total (sin lote, sin movimientos)",
  "D1. cobro con saldo: cambiar fecha → 409; notas → 200; edición contable del pago → 409",
  "D2. lote sin movimientos de cuenta: la fecha se sigue pudiendo cambiar; lote legacy con sobrante: fecha bloqueada",
  "P1. GET /payments: pago individual con saldo identificado estructuralmente; lote con titular común no",
  "A1. cuota financiada parcialmente (efectivo + deuda autorizada): pagada, fuera de /remittances/uncollected y no rendible como adeudada",
  "A2. cuota sin ningún ingreso: account-funded la rechaza sin crear artefactos y sigue el circuito normal de adeudadas",
  "A3. cobrar después esa adeudada funciona igual que una adeudada sin intento previo (mismo efecto en Caja y adeudados)",
  "A4. sin doble impacto en Caja: cuota pagada con deuda autorizada se rinde una vez, la deuda vive solo en cuenta corriente",
  "A5. saldo negativo previo + sobrante en un pago posterior: el saldo final se netea",
  "K1. la fila de idempotencia (marca de pago individual) sobrevive a la anulación: se sigue identificando y un reintento con la misma clave no recrea el cobro",
  "K2. si falta la fila de idempotencia: sin 500, el cobro se presenta como hijo de lote común, nada económico cambia y sigue administrable desde el lote",
  "N1. editar notas después de crear el cobro no altera la huella guardada ni nada económico; el replay del request original no revierte las notas",
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

describe("Proceso hijo aislado (individual-account-funded-endpoint.runner.ts)", () => {
  test("exit code 0 y exactamente los checks esperados", () => {
    if (setupError) throw new Error(`${setupError}\n${sanitizedStderr}`);
    expect(results.map((r) => r.name).sort()).toEqual([...EXPECTED_CHECKS].sort());
    expect(exitCode).toBe(0);
  });
});

describe("POST /payments/account-funded", () => {
  for (const name of EXPECTED_CHECKS) {
    test(name, () => assertCheck(name));
  }
});
