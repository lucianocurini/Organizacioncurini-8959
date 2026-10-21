// Listado de Pólizas con estado efectivo: el filtro (server, lib/policies/
// policy-list.ts) resuelve el estado ANTES de filtrar; orden y paginación
// (client, polizas-sort.ts) trabajan sobre ese mismo conjunto, así que
// total, páginas y filas coinciden. Fixtures 100% sintéticos.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/polizas-effective-status.test.ts
import { describe, test, expect } from "bun:test";
import { applyPolicyListFilters } from "../../../lib/policies/policy-list";
import { sortPolicyRows, paginatePolicyRows, displayPolicyStatus } from "../polizas-sort";
import { addCalendarDays } from "../../../lib/dates/argentina-date";

const TODAY = "2026-10-19";

function mk(id: number, status: string, endOffset: number, extra: { type?: string; companyId?: number; insured?: string } = {}) {
  return {
    policy: {
      id, policyNumber: `SINT-${String(id).padStart(3, "0")}`, type: extra.type ?? "automotor", status,
      startDate: "2026-01-01", endDate: addCalendarDays(TODAY, endOffset), premium: 100, companyId: extra.companyId ?? 1,
    },
    company: { name: extra.companyId === 2 ? "Compañía Dos" : "Compañía Uno" },
    insured: { name: extra.insured ?? "Asegurado Sintético" },
  };
}

// 60 guardadas "activa" con fin pasado (vencidas efectivas), 55 activas
// reales, 10 por vencer reales, 5 por_vencer guardadas ya vencidas,
// 3 canceladas y 2 renovadas con fin pasado (terminales).
const ROWS = [
  ...Array.from({ length: 60 }, (_, i) => mk(1 + i, "activa", -1 - i)),
  ...Array.from({ length: 55 }, (_, i) => mk(100 + i, "activa", 31 + i)),
  ...Array.from({ length: 10 }, (_, i) => mk(200 + i, "activa", i * 3)),
  ...Array.from({ length: 5 }, (_, i) => mk(300 + i, "por_vencer", -2 - i, { companyId: 2 })),
  ...Array.from({ length: 3 }, (_, i) => mk(400 + i, "cancelada", -10)),
  ...Array.from({ length: 2 }, (_, i) => mk(500 + i, "renovada", -10, { type: "hogar" })),
];

const list = (filters: Parameters<typeof applyPolicyListFilters>[1]) => applyPolicyListFilters(ROWS, filters, TODAY);

describe("filtro por estado efectivo", () => {
  test("cada estado cuenta según la fecha final, no según lo guardado", () => {
    expect(list({ status: "vencida" })).toHaveLength(65);
    expect(list({ status: "activa" })).toHaveLength(55);
    expect(list({ status: "por_vencer" })).toHaveLength(10);
    expect(list({ status: "cancelada" })).toHaveLength(3);
    expect(list({ status: "renovada" })).toHaveLength(2);
    // Los cinco estados cubren todo, sin solaparse.
    expect(65 + 55 + 10 + 3 + 2).toBe(ROWS.length);
  });
  test("policy.status guardado no se modifica; effectiveStatus viaja aparte", () => {
    const r = list({ status: "vencida" }).find((x) => x.policy.id === 1)!;
    expect(r.policy.status).toBe("activa");
    expect(r.effectiveStatus).toBe("vencida");
    expect(displayPolicyStatus(r)).toBe("vencida");
  });
  test("fin = hoy figura por vencer, no vencida", () => {
    expect(list({ status: "por_vencer" }).some((r) => r.policy.id === 200)).toBe(true);
    expect(list({ status: "vencida" }).some((r) => r.policy.id === 200)).toBe(false);
  });
  test("combinado con compañía, ramo y búsqueda", () => {
    expect(list({ status: "vencida", companyId: "2" })).toHaveLength(5);
    expect(list({ status: "renovada", type: "hogar" })).toHaveLength(2);
    expect(list({ status: "activa", type: "hogar" })).toHaveLength(0);
    expect(list({ status: "vencida", q: "sint-30" }).map((r) => r.policy.id).sort()).toEqual([300, 301, 302, 303, 304]);
    expect(list({ q: "compañía dos" })).toHaveLength(5);
  });
  test("sin filtros devuelve todo con su estado efectivo", () => {
    const all = list({});
    expect(all).toHaveLength(ROWS.length);
    expect(all.every((r) => typeof r.effectiveStatus === "string")).toBe(true);
  });
});

describe("conteo y paginación sobre el conjunto filtrado", () => {
  test("vencidas: 65 → 2 páginas (50 + 15), sin filas repetidas ni perdidas", () => {
    const sorted = sortPolicyRows(list({ status: "vencida" }), "policyNumber", "asc");
    const p1 = paginatePolicyRows(sorted, 1);
    const p2 = paginatePolicyRows(sorted, 2);
    expect(p1).toMatchObject({ total: 65, totalPages: 2 });
    expect(p1.pageRows).toHaveLength(50);
    expect(p2.pageRows).toHaveLength(15);
    const ids = [...p1.pageRows, ...p2.pageRows].map((r) => r.policy.id);
    expect(new Set(ids).size).toBe(65);
    expect([...p1.pageRows, ...p2.pageRows].every((r) => r.effectiveStatus === "vencida")).toBe(true);
  });
  test("activas efectivas: 55 → 2 páginas; ninguna vencida guardada como activa se cuela", () => {
    const res = paginatePolicyRows(sortPolicyRows(list({ status: "activa" }), "startDate", "desc"), 2);
    expect(res).toMatchObject({ total: 55, totalPages: 2 });
    expect(res.pageRows).toHaveLength(5);
    expect(res.pageRows.every((r) => r.policy.id >= 100 && r.policy.id < 200)).toBe(true);
  });
  test("conjunto chico: 1 página; página fuera de rango vacía con el mismo total", () => {
    expect(paginatePolicyRows(list({ status: "cancelada" }), 1)).toMatchObject({ total: 3, totalPages: 1 });
    expect(paginatePolicyRows(list({ status: "cancelada" }), 3)).toMatchObject({ total: 3, totalPages: 1, pageRows: [] });
    expect(paginatePolicyRows([], 1)).toMatchObject({ total: 0, totalPages: 1, pageRows: [] });
  });
  test("ordenar por estado usa el efectivo", () => {
    const sorted = sortPolicyRows(list({}), "status", "asc");
    const order = [...new Set(sorted.map((r) => displayPolicyStatus(r)))];
    expect(order).toEqual(["activa", "cancelada", "por_vencer", "renovada", "vencida"]);
  });
});
