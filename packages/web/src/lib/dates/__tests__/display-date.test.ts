// Tests puros de los helpers de presentación de fechas (Etapa 1: UI).
//
// Ejecutar con: bun test packages/web/src/lib/dates/__tests__/display-date.test.ts
import { describe, test, expect } from "bun:test";
import {
  formatDisplayDate, formatDisplayDateRange, formatDisplayMonth,
  formatDisplayDateTime, formatDisplayTimestampDate, formatPreviewDate, isCalendarDay,
} from "../display-date";
import { formatDate } from "../../../web/lib/utils";

describe("formatDisplayDate (fecha pura YYYY-MM-DD)", () => {
  test("2026-10-09 → 09/10/2026 (con ceros a la izquierda)", () => {
    expect(formatDisplayDate("2026-10-09")).toBe("09/10/2026");
  });
  test("bordes de año: 2026-01-01 y 2026-12-31", () => {
    expect(formatDisplayDate("2026-01-01")).toBe("01/01/2026");
    expect(formatDisplayDate("2026-12-31")).toBe("31/12/2026");
  });
  test("bisiesto: 2024-02-29 válido; 2026-02-29 inexistente → —", () => {
    expect(formatDisplayDate("2024-02-29")).toBe("29/02/2024");
    expect(formatDisplayDate("2026-02-29")).toBe("—");
  });
  test("inválidos → —", () => {
    for (const v of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-1-9", "09/10/2026", "abc", " 2026-10-09", "2026-10-09 "]) {
      expect(formatDisplayDate(v)).toBe("—");
    }
  });
  test("vacío, null y undefined → —", () => {
    expect(formatDisplayDate("")).toBe("—");
    expect(formatDisplayDate(null)).toBe("—");
    expect(formatDisplayDate(undefined)).toBe("—");
  });
  test("un timestamp pasado al helper de fecha pura → — (nunca basura ni día corrido)", () => {
    expect(formatDisplayDate("2026-10-09T02:30:00.000Z")).toBe("—");
    expect(formatDisplayDate("2026-10-09 12:00:00")).toBe("—");
  });
  test("no depende del huso del proceso: nunca pasa por new Date()", () => {
    const original = Date;
    // Si el helper construyera un Date, este stub lo detectaría.
    (globalThis as any).Date = function () { throw new Error("no debe usar Date"); };
    try {
      expect(formatDisplayDate("2026-10-09")).toBe("09/10/2026");
    } finally {
      (globalThis as any).Date = original;
    }
  });
});

describe("formatDate (utils) reutiliza el helper central", () => {
  test("mismo resultado que formatDisplayDate", () => {
    expect(formatDate("2026-10-09")).toBe("09/10/2026");
    expect(formatDate(null)).toBe("—");
    expect(formatDate("2026-10-09T03:00:00.000Z")).toBe("—");
  });
});

describe("formatDisplayDateTime (timestamp → hora Argentina)", () => {
  test("medianoche Argentina/UTC: 2026-10-09T02:59Z es todavía 08/10 23:59 en Argentina", () => {
    expect(formatDisplayDateTime("2026-10-09T02:59:00.000Z")).toBe("08/10/2026 23:59");
  });
  test("2026-10-09T03:00Z es 09/10 00:00 en Argentina", () => {
    expect(formatDisplayDateTime("2026-10-09T03:00:00.000Z")).toBe("09/10/2026 00:00");
  });
  test("caso real #115: 2026-07-29T01:16:56Z → 28/07/2026 22:16", () => {
    expect(formatDisplayDateTime("2026-07-29T01:16:56.000Z")).toBe("28/07/2026 22:16");
  });
  test("acepta Date, epoch en segundos y en milisegundos", () => {
    const ms = Date.UTC(2026, 9, 9, 15, 5);
    expect(formatDisplayDateTime(new Date(ms))).toBe("09/10/2026 12:05");
    expect(formatDisplayDateTime(ms)).toBe("09/10/2026 12:05");
    expect(formatDisplayDateTime(ms / 1000)).toBe("09/10/2026 12:05");
  });
  test("acepta offset explícito", () => {
    expect(formatDisplayDateTime("2026-10-09T00:30:00-03:00")).toBe("09/10/2026 00:30");
  });
  test("hora 00 nunca se muestra como 24", () => {
    expect(formatDisplayDateTime("2026-12-31T03:00:00Z")).toBe("31/12/2026 00:00");
  });
  test("cambio de año: 2027-01-01T02:00Z es 31/12/2026 23:00 en Argentina", () => {
    expect(formatDisplayDateTime("2027-01-01T02:00:00Z")).toBe("31/12/2026 23:00");
  });
  test("una fecha pura pasada al helper de timestamp → — (no se corre a las 21:00 del día anterior)", () => {
    expect(formatDisplayDateTime("2026-10-09")).toBe("—");
    expect(formatDisplayTimestampDate("2026-10-09")).toBe("—");
  });
  test("sin zona explícita (ambiguo) → —", () => {
    expect(formatDisplayDateTime("2026-10-09T12:00:00")).toBe("—");
    expect(formatDisplayDateTime("2026-10-09 12:00:00")).toBe("—");
  });
  test("inválidos, vacío, null, NaN → —", () => {
    for (const v of ["", "abc", "2026-13-40T00:00:00Z", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date("x")]) {
      expect(formatDisplayDateTime(v as any)).toBe("—");
      expect(formatDisplayTimestampDate(v as any)).toBe("—");
    }
  });
});

describe("formatDisplayTimestampDate (solo el día Argentina)", () => {
  test("a ambos lados de medianoche Argentina", () => {
    expect(formatDisplayTimestampDate("2026-10-09T02:59:59Z")).toBe("08/10/2026");
    expect(formatDisplayTimestampDate("2026-10-09T03:00:00Z")).toBe("09/10/2026");
  });
});

describe("formatDisplayDateRange", () => {
  test("rango completo con 'al'", () => {
    expect(formatDisplayDateRange("2026-10-01", "2026-10-31")).toBe("01/10/2026 al 31/10/2026");
  });
  test("rango que cruza el año", () => {
    expect(formatDisplayDateRange("2026-12-15", "2027-01-14")).toBe("15/12/2026 al 14/01/2027");
  });
  test("un extremo inválido se muestra —; ambos inválidos → —", () => {
    expect(formatDisplayDateRange("2026-10-01", null)).toBe("01/10/2026 al —");
    expect(formatDisplayDateRange(null, undefined)).toBe("—");
    expect(formatDisplayDateRange("x", "y")).toBe("—");
  });
});

describe("formatDisplayMonth", () => {
  test("2026-10 → Octubre 2026", () => {
    expect(formatDisplayMonth("2026-10")).toBe("Octubre 2026");
  });
  test("enero y diciembre (cambio de año)", () => {
    expect(formatDisplayMonth("2026-12")).toBe("Diciembre 2026");
    expect(formatDisplayMonth("2027-01")).toBe("Enero 2027");
  });
  test("inválidos → —", () => {
    for (const v of ["2026-13", "2026-00", "2026-1", "2026-10-09", "", null, undefined, "Octubre 2026"]) {
      expect(formatDisplayMonth(v as any)).toBe("—");
    }
  });
});

describe("formatPreviewDate (vistas previas de importación)", () => {
  test("fecha normalizada → DD/MM/YYYY", () => {
    expect(formatPreviewDate("2026-10-09")).toBe("09/10/2026");
  });
  test("valor no normalizable se muestra crudo, para diagnóstico", () => {
    expect(formatPreviewDate("31/02/2026?")).toBe("31/02/2026?");
  });
  test("vacío → —", () => {
    expect(formatPreviewDate("")).toBe("—");
    expect(formatPreviewDate(null)).toBe("—");
  });
});

describe("isCalendarDay", () => {
  test("solo días reales", () => {
    expect(isCalendarDay("2024-02-29")).toBe(true);
    expect(isCalendarDay("2026-02-29")).toBe(false);
    expect(isCalendarDay(20261009)).toBe(false);
  });
});
