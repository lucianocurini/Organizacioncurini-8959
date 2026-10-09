import { describe, test, expect } from "bun:test";
import {
  EXPENSES_ALL_MONTHS, expensesMonthOfDate, expensesMonthRange, formatExpensesMonthLabel,
  isDateInExpensesMonth, isValidExpensesMonth, parseExpensesMonthQuery, shiftExpensesMonth,
} from "../expenses-month";

describe("expenses-month", () => {
  test("valida YYYY-MM estricto", () => {
    for (const ok of ["2026-01", "2026-10", "2026-12", "1999-07"]) expect(isValidExpensesMonth(ok)).toBe(true);
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", "", "all", null, undefined, 202610])
      expect(isValidExpensesMonth(bad)).toBe(false);
  });

  test("anterior/siguiente cruzando enero/diciembre", () => {
    expect(shiftExpensesMonth("2026-10", -1)).toBe("2026-09");
    expect(shiftExpensesMonth("2026-10", 1)).toBe("2026-11");
    expect(shiftExpensesMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftExpensesMonth("2027-01", -1)).toBe("2026-12");
    expect(shiftExpensesMonth("2026-01", -13)).toBe("2024-12");
    expect(() => shiftExpensesMonth("2026-13", 1)).toThrow();
  });

  test("intervalo [inicio, inicio del mes siguiente)", () => {
    expect(expensesMonthRange("2026-10")).toEqual({ from: "2026-10-01", toExclusive: "2026-11-01" });
    expect(expensesMonthRange("2026-12")).toEqual({ from: "2026-12-01", toExclusive: "2027-01-01" });
    expect(expensesMonthRange("2028-02")).toEqual({ from: "2028-02-01", toExclusive: "2028-03-01" });
  });

  test("primer y último día adentro; bordes vecinos afuera; sin corrimiento UTC", () => {
    expect(isDateInExpensesMonth("2026-10-01", "2026-10")).toBe(true);
    expect(isDateInExpensesMonth("2026-10-31", "2026-10")).toBe(true);
    expect(isDateInExpensesMonth("2026-09-30", "2026-10")).toBe(false);
    expect(isDateInExpensesMonth("2026-11-01", "2026-10")).toBe(false);
    expect(isDateInExpensesMonth("2026-12-31", "2026-12")).toBe(true);
    expect(isDateInExpensesMonth("2027-01-01", "2026-12")).toBe(false);
    expect(isDateInExpensesMonth("2028-02-29", "2028-02")).toBe(true);
    expect(isDateInExpensesMonth(null, "2026-10")).toBe(false);
  });

  test("mes de una fecha y etiqueta legible", () => {
    expect(expensesMonthOfDate("2026-10-31")).toBe("2026-10");
    expect(expensesMonthOfDate("2026-1-3")).toBeNull();
    expect(formatExpensesMonthLabel("2026-10")).toBe("Octubre 2026");
    expect(formatExpensesMonthLabel("2027-01")).toBe("Enero 2027");
    expect(formatExpensesMonthLabel("2026-12")).toBe("Diciembre 2026");
    expect(formatExpensesMonthLabel(EXPENSES_ALL_MONTHS)).toBe("Todos los meses");
  });

  test("query del endpoint: ausente/all = histórico, YYYY-MM = mes, resto inválido", () => {
    expect(parseExpensesMonthQuery(undefined)).toEqual({ ok: true, month: null });
    expect(parseExpensesMonthQuery("all")).toEqual({ ok: true, month: null });
    expect(parseExpensesMonthQuery("2026-10")).toEqual({ ok: true, month: "2026-10" });
    for (const bad of ["", "ALL", "2026-13", "2026-10-01", "x"]) expect(parseExpensesMonthQuery(bad)).toEqual({ ok: false });
  });
});
