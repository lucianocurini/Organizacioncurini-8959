import { describe, test, expect } from "bun:test";
import {
  buildExpensesListUrl, buildGastosPath, describeSavedOutsideSelection, expensesEmptyLabel,
  expensesTotalLabel, isGastosTabInSearch, resolveGastosMonthFromSearch, sumExpensesCents,
} from "../gastos-month-filter";

const CURRENT = "2026-10";

describe("gastos-month-filter — URL", () => {
  test("sin parámetro → mes actual (no canónico, se reescribe)", () => {
    expect(resolveGastosMonthFromSearch("tab=gastos", CURRENT)).toEqual({ selection: CURRENT, isCanonical: false });
  });

  test("mes válido y 'all' se respetan (recarga / navegación)", () => {
    expect(resolveGastosMonthFromSearch("tab=gastos&gastosMes=2026-03", CURRENT)).toEqual({ selection: "2026-03", isCanonical: true });
    expect(resolveGastosMonthFromSearch("?tab=gastos&gastosMes=all", CURRENT)).toEqual({ selection: "all", isCanonical: true });
  });

  test("URL inválida vuelve de forma segura al mes actual", () => {
    for (const bad of ["2026-13", "2026-1", "abc", "", "2026-10-01", "<script>"]) {
      expect(resolveGastosMonthFromSearch(`tab=gastos&gastosMes=${encodeURIComponent(bad)}`, CURRENT))
        .toEqual({ selection: CURRENT, isCanonical: false });
    }
  });

  test("ida y vuelta: path ↔ selección; no usa el parámetro genérico 'month'", () => {
    const path = buildGastosPath("2027-01");
    expect(path).toBe("/cobranzas?tab=gastos&gastosMes=2027-01");
    const search = path.split("?")[1]!;
    expect(isGastosTabInSearch(search)).toBe(true);
    expect(resolveGastosMonthFromSearch(search, CURRENT).selection).toBe("2027-01");
    expect(new URLSearchParams(search).has("month")).toBe(false);
    expect(isGastosTabInSearch("")).toBe(false);
    expect(isGastosTabInSearch("tab=rendiciones")).toBe(false);
  });

  test("URL del listado siempre explícita", () => {
    expect(buildExpensesListUrl("2026-10")).toBe("/api/cash/expenses?month=2026-10");
    expect(buildExpensesListUrl("all")).toBe("/api/cash/expenses?month=all");
  });
});

describe("gastos-month-filter — total y textos", () => {
  test("total en centavos de todas las filas (sin errores de coma flotante)", () => {
    expect(sumExpensesCents([])).toBe(0);
    expect(sumExpensesCents([{ amount: 0.1 }, { amount: 0.2 }])).toBe(30);
    expect(sumExpensesCents(Array.from({ length: 150 }, () => ({ amount: 10.01 })))).toBe(150150);
  });

  test("etiquetas de total y vacío", () => {
    expect(expensesTotalLabel("2026-10")).toBe("Total de gastos — Octubre 2026");
    expect(expensesTotalLabel("all")).toBe("Total histórico de gastos");
    expect(expensesEmptyLabel("2026-02")).toBe("Sin gastos en Febrero 2026");
    expect(expensesEmptyLabel("all")).toBe("Sin gastos registrados");
  });

  test("guardado fuera del mes visible → aviso con el mes destino", () => {
    expect(describeSavedOutsideSelection("2026-10-31", "2026-10")).toBeNull();
    expect(describeSavedOutsideSelection("2026-11-01", "2026-10")).toEqual({ month: "2026-11", label: "Noviembre 2026" });
    expect(describeSavedOutsideSelection("2025-12-31", "2026-01")).toEqual({ month: "2025-12", label: "Diciembre 2025" });
    expect(describeSavedOutsideSelection("2020-05-05", "all")).toBeNull();
  });
});
