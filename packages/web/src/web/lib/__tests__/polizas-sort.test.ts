// Tests del comparador puro del listado de Pólizas.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/polizas-sort.test.ts
import { describe, test, expect } from "bun:test";
import { sortPolicyRows, isValidDateStr, type PolicySortRow } from "../polizas-sort";

function row(id: number, startDate: string | null | undefined, endDate = "2025-12-31"): PolicySortRow {
  return {
    policy: { id, policyNumber: `P-${id}`, type: "automotor", status: "activa", startDate, endDate, premium: null },
    company: { name: "Cia" },
    insured: { name: "Asegurado" },
  };
}

describe("isValidDateStr", () => {
  test("acepta fechas YYYY-MM-DD válidas", () => {
    expect(isValidDateStr("2024-01-15")).toBe(true);
    expect(isValidDateStr("2024-02-29")).toBe(true); // 2024 es bisiesto
  });
  test("rechaza null, undefined y vacío", () => {
    expect(isValidDateStr(null)).toBe(false);
    expect(isValidDateStr(undefined)).toBe(false);
    expect(isValidDateStr("")).toBe(false);
  });
  test("rechaza formato inválido", () => {
    expect(isValidDateStr("15-01-2024")).toBe(false);
    expect(isValidDateStr("2024/01/15")).toBe(false);
    expect(isValidDateStr("2024-1-15")).toBe(false);
    expect(isValidDateStr("not-a-date")).toBe(false);
  });
  test("rechaza fechas de calendario inexistentes", () => {
    expect(isValidDateStr("2023-02-29")).toBe(false); // 2023 no es bisiesto
    expect(isValidDateStr("2024-02-30")).toBe(false);
    expect(isValidDateStr("2024-13-01")).toBe(false);
    expect(isValidDateStr("2024-00-01")).toBe(false);
  });
});

describe("sortPolicyRows — startDate default (desc, más recientes primero)", () => {
  test("ordena por fecha de inicio descendente", () => {
    const rows = [row(1, "2023-05-10"), row(2, "2025-01-01"), row(3, "2024-06-15")];
    const sorted = sortPolicyRows(rows, "startDate", "desc");
    expect(sorted.map(r => r.policy.id)).toEqual([2, 3, 1]);
  });

  test("startDate asc invierte el orden entre fechas válidas", () => {
    const rows = [row(1, "2023-05-10"), row(2, "2025-01-01"), row(3, "2024-06-15")];
    const sorted = sortPolicyRows(rows, "startDate", "asc");
    expect(sorted.map(r => r.policy.id)).toEqual([1, 3, 2]);
  });
});

describe("sortPolicyRows — fechas vacías/inválidas siempre al final", () => {
  test("startDate vacío o null queda al final en desc", () => {
    const rows = [row(1, ""), row(2, "2024-06-15"), row(3, null)];
    const sorted = sortPolicyRows(rows, "startDate", "desc");
    expect(sorted[0].policy.id).toBe(2);
    expect(sorted.slice(1).map(r => r.policy.id).sort()).toEqual([1, 3]);
  });

  test("startDate vacío o null queda al final en asc también", () => {
    const rows = [row(1, ""), row(2, "2024-06-15"), row(3, null)];
    const sorted = sortPolicyRows(rows, "startDate", "asc");
    expect(sorted[0].policy.id).toBe(2);
    expect(sorted.slice(1).map(r => r.policy.id).sort()).toEqual([1, 3]);
  });

  test("startDate con formato/calendario inválido queda al final en desc", () => {
    const rows = [row(1, "2024-02-30"), row(2, "2024-06-15"), row(3, "no-es-fecha")];
    const sorted = sortPolicyRows(rows, "startDate", "desc");
    expect(sorted[0].policy.id).toBe(2);
    expect(sorted.slice(1).map(r => r.policy.id).sort()).toEqual([1, 3]);
  });

  test("startDate con formato/calendario inválido queda al final en asc", () => {
    const rows = [row(1, "2024-02-30"), row(2, "2024-06-15"), row(3, "no-es-fecha")];
    const sorted = sortPolicyRows(rows, "startDate", "asc");
    expect(sorted[0].policy.id).toBe(2);
    expect(sorted.slice(1).map(r => r.policy.id).sort()).toEqual([1, 3]);
  });
});

describe("sortPolicyRows — desempate", () => {
  test("fechas de inicio iguales desempatan por id descendente", () => {
    const rows = [row(5, "2024-06-15"), row(2, "2024-06-15"), row(9, "2024-06-15")];
    const sorted = sortPolicyRows(rows, "startDate", "desc");
    expect(sorted.map(r => r.policy.id)).toEqual([9, 5, 2]);
  });

  test("el desempate por id descendente también aplica en asc", () => {
    const rows = [row(5, "2024-06-15"), row(2, "2024-06-15"), row(9, "2024-06-15")];
    const sorted = sortPolicyRows(rows, "startDate", "asc");
    expect(sorted.map(r => r.policy.id)).toEqual([9, 5, 2]);
  });
});

describe("sortPolicyRows — sortBy=endDate explícito mantiene el comportamiento anterior", () => {
  test("ordena por endDate sin el tratamiento especial de inválidos de startDate", () => {
    const rows = [
      row(1, "2024-01-01", "2025-03-01"),
      row(2, "2024-01-01", "2025-01-01"),
      row(3, "2024-01-01", "2025-06-01"),
    ];
    const sorted = sortPolicyRows(rows, "endDate", "desc");
    expect(sorted.map(r => r.policy.id)).toEqual([3, 1, 2]);
  });
});

describe("sortPolicyRows — ordena el conjunto completo, no una página", () => {
  test("el resultado conserva todas las filas recibidas (la paginación se aplica después, afuera)", () => {
    const rows = Array.from({ length: 120 }, (_, i) => row(i + 1, `2024-01-${String((i % 28) + 1).padStart(2, "0")}`));
    const sorted = sortPolicyRows(rows, "startDate", "desc");
    expect(sorted.length).toBe(120);
    expect(new Set(sorted.map(r => r.policy.id)).size).toBe(120);
  });
});
