// Test de regresión estático (sin ejecutar componentes React): barre el
// código fuente para confirmar que
//   (a) todos los sitios corregidos en esta ronda siguen usando el helper
//       único toArgentinaCalendarDay, importado del MISMO módulo tanto desde
//       el backend (api/index.ts, lib/payments/*) como desde el frontend
//       (web/pages/*, web/components/*) — nadie duplicó la función;
//   (b) ninguno de esos archivos volvió a introducir el patrón viejo
//       (new Date().toISOString().slice(0,10) / .split("T")[0]);
//   (c) los sitios "frágiles pero hoy correctos" que se decidió NO tocar
//       (cancelación simétrica UTC↔local, ver diagnóstico) siguen intactos.
//
// Si este test falla porque alguien agregó un nuevo default de fecha con el
// patrón viejo, es una señal real: hay que usar el helper, no ajustar este
// test.
//
// Ejecutar con: bun test packages/web/src/lib/dates/__tests__/no-utc-calendar-day-regression.test.ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";

const ROOT = resolve(import.meta.dir, "..", "..", ".."); // packages/web/src
const CANONICAL_MODULE = resolve(ROOT, "lib/dates/argentina-date.ts");

const BANNED_PATTERNS = [
  /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/,
  /new Date\(\)\.toISOString\(\)\.split\("T"\)\[0\]/,
];

function readSrc(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf-8");
}

// Extrae el primer especificador de import que apunta a .../argentina-date
// (con o sin extensión) y lo resuelve a ruta absoluta desde la carpeta del
// archivo que lo importa.
function resolveArgentinaDateImport(relPath: string, content: string): string | null {
  const match = content.match(/from\s+["']([^"']*argentina-date)["']/);
  if (!match) return null;
  const fileDir = dirname(resolve(ROOT, relPath));
  return resolve(fileDir, `${match[1]}.ts`);
}

// Archivos corregidos en la ronda 1 → cantidad mínima esperada de llamadas
// toArgentinaCalendarDay( en cada uno (guarda contra un revert parcial).
const FIXED_SITES: Record<string, number> = {
  "api/index.ts": 16,
  "lib/payments/caja-summary.ts": 3,
  "lib/payments/installment-status.ts": 1,
  "web/components/payments/PendingInstallmentsBatchTab.tsx": 1,
  "web/components/policies/PolicyModal.tsx": 1,
  "web/lib/utils.ts": 1,
  "web/pages/caja.tsx": 10,
  "web/pages/cobranzas.tsx": 7,
  "web/pages/importar.tsx": 1,
  "web/pages/poliza-detail.tsx": 1,
  "web/pages/siniestro-detail.tsx": 3,
  "web/pages/siniestros.tsx": 1,
};

describe("Bug A — todos los sitios corregidos comparten el mismo helper (caso 15)", () => {
  for (const relPath of Object.keys(FIXED_SITES)) {
    test(`${relPath} importa toArgentinaCalendarDay desde el módulo canónico`, () => {
      const content = readSrc(relPath);
      const resolved = resolveArgentinaDateImport(relPath, content);
      expect(resolved).not.toBeNull();
      expect(resolved).toBe(CANONICAL_MODULE);
    });
  }
});

describe("Bug A — cantidad de reemplazos no retrocede (caso 14: defaults usan el helper)", () => {
  for (const [relPath, minCalls] of Object.entries(FIXED_SITES)) {
    test(`${relPath} llama toArgentinaCalendarDay( al menos ${minCalls} vez/veces`, () => {
      const content = readSrc(relPath);
      const calls = content.match(/toArgentinaCalendarDay\(/g) ?? [];
      expect(calls.length).toBeGreaterThanOrEqual(minCalls);
    });
  }
});

describe("Bug A — no queda el patrón viejo en los sitios corregidos", () => {
  for (const relPath of Object.keys(FIXED_SITES)) {
    test(`${relPath} no contiene new Date().toISOString().slice/split de calendario`, () => {
      const content = readSrc(relPath);
      for (const pattern of BANNED_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});

// ─── Caso 13 — timestamps/rangos UTC legítimos que NO se tocaron ───────────
// Estos sitios se dejaron intactos a propósito: o son aritmética de
// calendario que se cancela simétricamente (parseo UTC + reconversión UTC,
// ver diagnóstico), o son un timestamp real que no representa un "día
// calendario de negocio" (nombre de archivo de backup). Si alguno de estos
// asserts falla, alguien tocó código que esta ronda dejó explícitamente sin
// modificar — revisar antes de "arreglarlo".
describe("Sitios frágiles-pero-correctos y timestamps UTC legítimos — sin modificar (caso 13)", () => {
  test("PolicyModal.calcEndDate sigue parseando con new Date(start) + toISOString (cancelación simétrica)", () => {
    const content = readSrc("web/components/policies/PolicyModal.tsx");
    expect(content).toContain('return d.toISOString().split("T")[0];');
  });

  test("poliza-detail nextStart sigue igual (billingEnd + 1 día, cancelación simétrica)", () => {
    const content = readSrc("web/pages/poliza-detail.tsx");
    expect(content).toContain('nextStart = d.toISOString().split("T")[0];');
  });

  test("importar.getMonthRanges sigue igual (rangos mensuales, correcto para offset negativo)", () => {
    const content = readSrc("web/pages/importar.tsx");
    expect(content).toContain('const fromStr = firstDay.toISOString().split("T")[0];');
    expect(content).toContain('const toStr = lastDay.toISOString().split("T")[0];');
  });

  test("ImportModal.normalizeDate (fallback de formato no reconocido) sigue igual", () => {
    const content = readSrc("web/components/policies/ImportModal.tsx");
    expect(content).toContain('if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];');
  });

  test("GET /backup: el nombre de archivo sigue usando el timestamp UTC real (no es un día calendario de negocio)", () => {
    const content = readSrc("api/index.ts");
    expect(content).toContain('const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);');
  });
});

// ─── Ronda 2 — los 3 hallazgos nuevos, ya corregidos ───────────────────────
// Se encontraron al implementar la ronda 1, quedaron documentados como
// pendientes, y Luciano autorizó corregirlos en la ronda 2. Los tres
// representan un mes/día calendario operativo (no un instante UTC), así que
// usan el helper compartido — nunca duplicado localmente.
describe("Ronda 2 — GET /tasks usa toArgentinaCalendarDay para el mes por defecto", () => {
  test("ya no contiene el default viejo en UTC", () => {
    const content = readSrc("api/index.ts");
    expect(content).not.toContain('new Date().toISOString().substring(0, 7)');
  });

  test("el default de monthYear usa toArgentinaCalendarDay()", () => {
    const content = readSrc("api/index.ts");
    expect(content).toContain('const monthYear = c.req.query("month") || toArgentinaCalendarDay().slice(0, 7);');
  });
});

describe("Ronda 2 — GET /cash/stats agrupa por mes vía resolveArgentinaMonthKey", () => {
  test("ya no contiene el getMonth/tsToStr viejo (getters locales del proceso)", () => {
    const content = readSrc("api/index.ts");
    expect(content).not.toMatch(/return `\$\{d\.getFullYear\(\)\}-\$\{String\(d\.getMonth\(\) \+ 1\)/);
  });

  test("usa resolveArgentinaMonthKey, importado del módulo canónico", () => {
    const content = readSrc("api/index.ts");
    const calls = content.match(/resolveArgentinaMonthKey\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2); // allEntries + allPays

    const match = content.match(/from\s+["']([^"']*argentina-date)["']/);
    expect(match).not.toBeNull();
    const fileDir = dirname(resolve(ROOT, "api/index.ts"));
    expect(resolve(fileDir, `${match![1]}.ts`)).toBe(CANONICAL_MODULE);
    // El mismo import debe traer también resolveArgentinaMonthKey.
    expect(content).toMatch(/import\s*\{[^}]*resolveArgentinaMonthKey[^}]*\}\s*from\s*["'][^"']*argentina-date["']/);
  });
});

describe("Ronda 2 — monthlyData (gráfico de 6 meses de Cobranzas) usa shiftArgentinaMonth", () => {
  test("ya no contiene el key viejo en UTC (d.toISOString().substring(0, 7))", () => {
    const content = readSrc("web/pages/cobranzas.tsx");
    expect(content).not.toContain('const key = d.toISOString().substring(0, 7);');
  });

  test("usa shiftArgentinaMonth, importado del módulo canónico", () => {
    const content = readSrc("web/pages/cobranzas.tsx");
    expect(content).toContain("const key = shiftArgentinaMonth(-(5 - i));");
    expect(content).toMatch(/import\s*\{[^}]*shiftArgentinaMonth[^}]*\}\s*from\s*["'][^"']*argentina-date["']/);
  });
});
