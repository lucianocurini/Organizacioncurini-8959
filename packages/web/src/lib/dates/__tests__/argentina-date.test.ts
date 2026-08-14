// Tests puros del helper único de "día calendario Argentina" — ver
// diagnóstico de fechas locales (rendición #115: creada 28/07/2026 22:16:56
// hora Argentina, guardada como 2026-07-29 porque el default del formulario
// calculaba new Date().toISOString().slice(0,10), que da SIEMPRE el día UTC).
//
// Ejecutar con: bun test packages/web/src/lib/dates/__tests__/argentina-date.test.ts
import { describe, test, expect } from "bun:test";
import {
  toArgentinaCalendarDay, parseCalendarDayToUtcOrdinal, diffCalendarDays,
  shiftArgentinaMonth, resolveArgentinaMonthKey, addCalendarDays,
} from "../argentina-date";

describe("toArgentinaCalendarDay", () => {
  test("caso real #115: 2026-07-29T01:16:56Z (28/07 22:16:56 Arg) → 2026-07-28", () => {
    expect(toArgentinaCalendarDay(new Date("2026-07-29T01:16:56.000Z"))).toBe("2026-07-28");
  });

  test("28/07/2026 23:59:59 Argentina (2026-07-29T02:59:59Z) → 2026-07-28", () => {
    expect(toArgentinaCalendarDay(new Date("2026-07-29T02:59:59.000Z"))).toBe("2026-07-28");
  });

  test("29/07/2026 00:00:00 Argentina (2026-07-29T03:00:00Z) → 2026-07-29", () => {
    expect(toArgentinaCalendarDay(new Date("2026-07-29T03:00:00.000Z"))).toBe("2026-07-29");
  });

  test("fin de mes: 31/07/2026 23:00 Argentina (2026-08-01T02:00:00Z) → 2026-07-31", () => {
    expect(toArgentinaCalendarDay(new Date("2026-08-01T02:00:00.000Z"))).toBe("2026-07-31");
  });

  test("fin de año: 31/12/2026 23:00 Argentina (2027-01-01T02:00:00Z) → 2026-12-31", () => {
    expect(toArgentinaCalendarDay(new Date("2027-01-01T02:00:00.000Z"))).toBe("2026-12-31");
  });

  test("independiente de process.env.TZ — mismo resultado corriendo en UTC, en Argentina o en un huso opuesto", () => {
    const instant = new Date("2026-07-29T01:16:56.000Z");
    const original = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const inUtc = toArgentinaCalendarDay(instant);
      process.env.TZ = "America/Argentina/Buenos_Aires";
      const inArgentina = toArgentinaCalendarDay(instant);
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14, el huso más adelantado del mundo
      const inOpuesto = toArgentinaCalendarDay(instant);
      expect(inUtc).toBe("2026-07-28");
      expect(inArgentina).toBe("2026-07-28");
      expect(inOpuesto).toBe("2026-07-28");
    } finally {
      process.env.TZ = original;
    }
  });

  test("instante inválido (Date inválida) → lanza con mensaje claro", () => {
    expect(() => toArgentinaCalendarDay(new Date("no-es-una-fecha"))).toThrow(/instante inválido/);
    expect(() => toArgentinaCalendarDay(NaN)).toThrow(/instante inválido/);
  });

  test("default (sin argumento) usa el instante actual — no lanza y devuelve YYYY-MM-DD", () => {
    expect(toArgentinaCalendarDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("reproduce el bug viejo de formatDebtLegacyDate: medianoche UTC ya es el día anterior en Argentina", () => {
    // Antes: new Date("2027-06-01T00:00:00.000Z").toISOString().slice(0,10) → "2027-06-01" (bug).
    // Ahora: el día calendario real en Argentina es el 31/05.
    expect(toArgentinaCalendarDay(new Date("2027-06-01T00:00:00.000Z"))).toBe("2027-05-31");
  });
});

describe("parseCalendarDayToUtcOrdinal", () => {
  test("formato inválido (no YYYY-MM-DD) → lanza", () => {
    expect(() => parseCalendarDayToUtcOrdinal("29-07-2026")).toThrow(/formato inválido/);
    expect(() => parseCalendarDayToUtcOrdinal("2026-7-29")).toThrow(/formato inválido/);
    expect(() => parseCalendarDayToUtcOrdinal("2026/07/29")).toThrow(/formato inválido/);
    expect(() => parseCalendarDayToUtcOrdinal("")).toThrow(/formato inválido/);
  });

  test("fecha calendario inexistente (30 de febrero) → lanza", () => {
    expect(() => parseCalendarDayToUtcOrdinal("2026-02-30")).toThrow(/fecha calendario inexistente/);
  });

  test("29 de febrero en año no bisiesto → lanza; en año bisiesto → no lanza", () => {
    expect(() => parseCalendarDayToUtcOrdinal("2026-02-29")).toThrow();
    expect(() => parseCalendarDayToUtcOrdinal("2028-02-29")).not.toThrow();
  });

  test("dos fechas consecutivas difieren en exactamente 1 ordinal", () => {
    expect(parseCalendarDayToUtcOrdinal("2026-07-29") - parseCalendarDayToUtcOrdinal("2026-07-28")).toBe(1);
  });
});

describe("diffCalendarDays", () => {
  test("mismo día → 0", () => {
    expect(diffCalendarDays("2026-07-28", "2026-07-28")).toBe(0);
  });

  test("un día calendario que no debe desplazarse: fecha date-only, sin pasar por Date", () => {
    // "2026-01-01" y "2026-12-31" son fechas TEXT tal como se guardan en las
    // tablas — la diferencia se calcula por componentes, nunca vía new Date().
    expect(diffCalendarDays("2026-01-01", "2026-12-31")).toBe(364); // 2026 no es bisiesto
  });

  test("cruza fin de año correctamente", () => {
    expect(diffCalendarDays("2026-12-31", "2027-01-01")).toBe(1);
  });
});

describe("addCalendarDays", () => {
  test("suma 30 días corridos dentro del mismo mes", () => {
    expect(addCalendarDays("2026-07-01", 30)).toBe("2026-07-31");
  });

  test("suma 30 días corridos cruzando de mes", () => {
    expect(addCalendarDays("2026-07-15", 30)).toBe("2026-08-14");
  });

  test("cruza fin de año", () => {
    expect(addCalendarDays("2026-12-15", 30)).toBe("2027-01-14");
  });

  test("29 de febrero en año bisiesto se respeta al sumar días", () => {
    expect(addCalendarDays("2028-02-01", 28)).toBe("2028-02-29");
  });

  test("days = 0 devuelve el mismo día", () => {
    expect(addCalendarDays("2026-07-29", 0)).toBe("2026-07-29");
  });

  test("days negativo resta días calendario", () => {
    expect(addCalendarDays("2026-07-31", -30)).toBe("2026-07-01");
  });

  test("formato de entrada inválido → lanza (delega en parseCalendarDayToUtcOrdinal)", () => {
    expect(() => addCalendarDays("29-07-2026", 30)).toThrow(/formato inválido/);
  });

  test("es aritmética de calendario puro: no depende de process.env.TZ", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const inUtc = addCalendarDays("2026-07-15", 30);
      process.env.TZ = "America/Argentina/Buenos_Aires";
      const inArgentina = addCalendarDays("2026-07-15", 30);
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      const inOpuesto = addCalendarDays("2026-07-15", 30);
      expect(inUtc).toBe("2026-08-14");
      expect(inArgentina).toBe("2026-08-14");
      expect(inOpuesto).toBe("2026-08-14");
    } finally {
      process.env.TZ = original;
    }
  });
});

// ─── Segunda ronda — hallazgos nuevos: GET /tasks, agrupador mensual de Caja
// (getMonth/tsToStr) y monthlyData del gráfico de 6 meses en cobranzas.tsx.
// Los tres representan un "mes operativo" de negocio, no un instante UTC —
// deben usar Argentina, mismo criterio que el día calendario.
describe("GET /tasks — mes por defecto (toArgentinaCalendarDay().slice(0,7))", () => {
  test("31/07/2026 23:00 Argentina (2026-08-01T02:00:00Z) NO se convierte en agosto", () => {
    // Éste es literalmente el default de GET /tasks: monthYear = ... ||
    // toArgentinaCalendarDay().slice(0,7). Antes usaba
    // new Date().toISOString().substring(0,7), que en este instante daba
    // "2026-08" (bug) en vez de "2026-07".
    const instant = new Date("2026-08-01T02:00:00.000Z");
    expect(toArgentinaCalendarDay(instant).slice(0, 7)).toBe("2026-07");
  });

  test("31/12/2026 23:00 Argentina (2027-01-01T02:00:00Z) selecciona diciembre, no enero", () => {
    const instant = new Date("2027-01-01T02:00:00.000Z");
    expect(toArgentinaCalendarDay(instant).slice(0, 7)).toBe("2026-12");
  });
});

describe("resolveArgentinaMonthKey — agrupador mensual (GET /cash/stats: getMonth/tsToStr)", () => {
  test("paymentDate ya es YYYY-MM-DD (fecha de negocio) — se recorta directo, sin pasar por Date", () => {
    expect(resolveArgentinaMonthKey("2026-07-15")).toBe("2026-07");
  });

  test("createdAt como Date, 31/07 23:00 Argentina (medianoche UTC del 01/08) → julio, no agosto", () => {
    expect(resolveArgentinaMonthKey(new Date("2026-08-01T02:00:00.000Z"))).toBe("2026-07");
  });

  test("createdAt como string ISO completo (fallback de tsToStr) → mismo criterio que Date", () => {
    expect(resolveArgentinaMonthKey("2026-08-01T02:00:00.000Z")).toBe("2026-07");
  });

  test("cambio de diciembre a enero: 31/12 23:00 Argentina → diciembre del año viejo", () => {
    expect(resolveArgentinaMonthKey(new Date("2027-01-01T02:00:00.000Z"))).toBe("2026-12");
  });

  test("null/undefined/string vacío → null (nunca agrupa bajo una clave falsa)", () => {
    expect(resolveArgentinaMonthKey(null)).toBeNull();
    expect(resolveArgentinaMonthKey(undefined)).toBeNull();
    expect(resolveArgentinaMonthKey("")).toBeNull();
  });

  test("string no parseable → null", () => {
    expect(resolveArgentinaMonthKey("no-es-una-fecha")).toBeNull();
  });

  test("independiente de process.env.TZ del proceso", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const inUtc = resolveArgentinaMonthKey(new Date("2026-08-01T02:00:00.000Z"));
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      const inOpuesto = resolveArgentinaMonthKey(new Date("2026-08-01T02:00:00.000Z"));
      expect(inUtc).toBe("2026-07");
      expect(inOpuesto).toBe("2026-07");
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("shiftArgentinaMonth — gráfico de 6 meses de Cobranzas (monthlyData)", () => {
  test("offset 0 en 31/07 23:00 Argentina → julio, no agosto", () => {
    const instant = new Date("2026-08-01T02:00:00.000Z");
    expect(shiftArgentinaMonth(0, instant)).toBe("2026-07");
  });

  test("cambio de diciembre a enero: offset +1 desde diciembre → enero del año siguiente", () => {
    expect(shiftArgentinaMonth(1, new Date("2026-12-15T15:00:00.000Z"))).toBe("2027-01");
  });

  test("cambio de enero a diciembre: offset -1 desde enero → diciembre del año anterior", () => {
    expect(shiftArgentinaMonth(-1, new Date("2027-01-15T15:00:00.000Z"))).toBe("2026-12");
  });

  test("los últimos 6 meses desde 31/07 23:00 Argentina terminan en julio, no en agosto", () => {
    const instant = new Date("2026-08-01T02:00:00.000Z"); // 31/07 23:00 Arg
    const last6 = Array.from({ length: 6 }, (_, i) => shiftArgentinaMonth(-(5 - i), instant));
    expect(last6).toEqual(["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]);
  });

  test("gráfico de 6 meses da la misma serie corriendo en UTC, Argentina o UTC+14", () => {
    const instant = new Date("2026-08-01T02:00:00.000Z"); // 31/07 23:00 Arg
    const original = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const inUtc = Array.from({ length: 6 }, (_, i) => shiftArgentinaMonth(-(5 - i), instant));
      process.env.TZ = "America/Argentina/Buenos_Aires";
      const inArgentina = Array.from({ length: 6 }, (_, i) => shiftArgentinaMonth(-(5 - i), instant));
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      const inOpuesto = Array.from({ length: 6 }, (_, i) => shiftArgentinaMonth(-(5 - i), instant));
      expect(inUtc).toEqual(inArgentina);
      expect(inArgentina).toEqual(inOpuesto);
      expect(inUtc[5]).toBe("2026-07"); // el mes actual sigue siendo julio en los tres casos
    } finally {
      process.env.TZ = original;
    }
  });
});
