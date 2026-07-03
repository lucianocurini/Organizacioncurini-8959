/**
 * Tests de la función pura y única de plan de cuotas (Etapa 2).
 * Reemplaza los dos algoritmos que existían por separado en
 * PolicyModal.tsx y poliza-detail.tsx.
 * No toca dev.db ni Turso — función pura en memoria.
 */

import { test, expect, describe } from "bun:test";
import {
  buildInstallmentPlan,
  addCalendarMonths,
  isValidCalendarDate,
  InstallmentPlanError,
} from "../../lib/installments/plan";

function sum(amounts: number[]): number {
  return Math.round(amounts.reduce((s, a) => s + a, 0) * 100) / 100;
}

describe("Caso A — anual, refacturación semestral (período real, no la vigencia completa)", () => {
  test("6 cuotas mensuales, suma exacta, vencimientos dentro del período", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
      periodAmount: 600000,
      installmentCount: 6,
    });
    expect(result.installments.length).toBe(6);
    expect(sum(result.installments.map(i => i.amount))).toBe(600000);
    expect(result.totalAmount).toBe(600000);
    expect(result.installments.map(i => i.dueDate)).toEqual([
      "2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01",
    ]);
    // Ninguna cuota posterior al período facturado.
    for (const inst of result.installments) {
      expect(inst.dueDate <= "2026-06-30").toBe(true);
    }
    expect(result.warnings).toEqual([]);
  });
});

describe("Caso B — anual, refacturación cuatrimestral", () => {
  test("4 cuotas de 100.000, suma exacta", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01",
      periodEnd: "2026-04-30",
      periodAmount: 400000,
      installmentCount: 4,
    });
    expect(result.installments.length).toBe(4);
    expect(result.installments.every(i => i.amount === 100000)).toBe(true);
    expect(sum(result.installments.map(i => i.amount))).toBe(400000);
  });
});

describe("Caso C — anual sin refacturación, 10 cuotas (no 12)", () => {
  test("exactamente 10 cuotas, suma exacta, los últimos 2 meses de vigencia quedan sin vencimiento", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31", // vigencia completa: es el período facturado en este caso
      periodAmount: 1000000,
      installmentCount: 10, // entrada explícita — no se infiere de los 12 meses de vigencia
    });
    expect(result.installments.length).toBe(10);
    expect(result.installments.length).not.toBe(12);
    expect(sum(result.installments.map(i => i.amount))).toBe(1000000);
    // La cuota 10 vence en octubre — noviembre y diciembre quedan documentadamente sin cuota
    // (no se generan filas de $0; el plan simplemente no cubre esos dos meses).
    expect(result.installments[9]!.dueDate).toBe("2026-10-01");
    expect(result.installments.some(i => i.dueDate.startsWith("2026-11"))).toBe(false);
    expect(result.installments.some(i => i.dueDate.startsWith("2026-12"))).toBe(false);
  });
});

describe("Caso D — vigencia de 4 meses, cantidad de cuotas configurable (2, no 4)", () => {
  test("2 cuotas, no se generan 4 automáticamente", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01",
      periodEnd: "2026-04-30", // vigencia de 4 meses
      periodAmount: 200000,
      installmentCount: 2, // configurable — el período dura 4 meses pero se pidieron 2 cuotas
    });
    expect(result.installments.length).toBe(2);
    expect(result.installments.length).not.toBe(4);
    expect(sum(result.installments.map(i => i.amount))).toBe(200000);
  });
});

describe("Caso E — Rivadavia: período real abril-julio, no la vigencia anual completa", () => {
  test("3 cuotas, suma exacta, sin extenderse a fin de vigencia anual", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-04-01",
      periodEnd: "2026-07-31", // próxima refacturación en julio
      periodAmount: 300000,
      installmentCount: 3,
    });
    expect(result.installments.length).toBe(3);
    expect(result.installments.every(i => i.amount === 100000)).toBe(true);
    expect(result.installments.map(i => i.dueDate)).toEqual(["2026-04-01", "2026-05-01", "2026-06-01"]);
    expect(sum(result.installments.map(i => i.amount))).toBe(300000);
    // La función ni siquiera recibe la vigencia anual como parámetro: no hay forma
    // de que "se cuele" en el cálculo.
  });
});

describe("Caso F — división con centavos", () => {
  test("100.000 / 3 distribuye la diferencia de redondeo en una sola cuota, suma exacta", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      periodAmount: 100000,
      installmentCount: 3,
    });
    expect(result.installments.length).toBe(3);
    expect(sum(result.installments.map(i => i.amount))).toBe(100000);
    // Dos cuotas iguales, una absorbe el centavo restante.
    const amounts = result.installments.map(i => i.amount);
    expect(amounts[0]).toBe(33333.33);
    expect(amounts[1]).toBe(33333.33);
    expect(amounts[2]).toBe(33333.34);
    // Nunca se pierde ni se agrega un centavo.
    expect(Math.round(sum(amounts) * 100)).toBe(Math.round(100000 * 100));
  });

  test("caso sin resto no genera diferencias artificiales", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01", periodEnd: "2026-03-31", periodAmount: 300000, installmentCount: 3,
    });
    expect(result.installments.map(i => i.amount)).toEqual([100000, 100000, 100000]);
  });
});

describe("Caso G — fechas y valores inválidos: error claro, sin cuotas parciales", () => {
  test("fin anterior al inicio", () => {
    expect(() => buildInstallmentPlan({
      periodStart: "2026-06-01", periodEnd: "2026-01-01", periodAmount: 1000, installmentCount: 3,
    })).toThrow(InstallmentPlanError);
  });

  test("cantidad de cuotas 0", () => {
    expect(() => buildInstallmentPlan({
      periodStart: "2026-01-01", periodEnd: "2026-12-31", periodAmount: 1000, installmentCount: 0,
    })).toThrow(InstallmentPlanError);
  });

  test("cantidad de cuotas negativa o no entera", () => {
    expect(() => buildInstallmentPlan({
      periodStart: "2026-01-01", periodEnd: "2026-12-31", periodAmount: 1000, installmentCount: -2,
    })).toThrow(InstallmentPlanError);
    expect(() => buildInstallmentPlan({
      periodStart: "2026-01-01", periodEnd: "2026-12-31", periodAmount: 1000, installmentCount: 2.5,
    })).toThrow(InstallmentPlanError);
  });

  test("importe negativo", () => {
    expect(() => buildInstallmentPlan({
      periodStart: "2026-01-01", periodEnd: "2026-12-31", periodAmount: -500, installmentCount: 3,
    })).toThrow(InstallmentPlanError);
  });

  test("fecha inválida (formato incorrecto)", () => {
    expect(() => buildInstallmentPlan({
      periodStart: "01-01-2026", periodEnd: "2026-12-31", periodAmount: 1000, installmentCount: 3,
    })).toThrow(InstallmentPlanError);
  });

  test("fecha inválida (no existe en el calendario)", () => {
    expect(() => buildInstallmentPlan({
      periodStart: "2026-02-30", periodEnd: "2026-12-31", periodAmount: 1000, installmentCount: 3,
    })).toThrow(InstallmentPlanError);
  });

  test("ningún error deja cuotas parciales (la función no tiene efectos secundarios)", () => {
    let thrown = false;
    let result: any = undefined;
    try {
      result = buildInstallmentPlan({
        periodStart: "2026-06-01", periodEnd: "2026-01-01", periodAmount: 1000, installmentCount: 3,
      });
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);
    expect(result).toBeUndefined();
  });
});

describe("Rango de fechas: la última cuota nunca puede caer después de periodEnd (bloqueante)", () => {
  test("si el plan excedería periodEnd, lanza error y no genera ningún plan parcial", () => {
    let thrown = false;
    let result: any = undefined;
    try {
      result = buildInstallmentPlan({
        periodStart: "2026-01-01",
        periodEnd: "2026-01-01", // período de un solo día
        periodAmount: 3000,
        installmentCount: 3, // 3 cuotas mensuales exceden necesariamente ese período
      });
    } catch (e) {
      thrown = e instanceof InstallmentPlanError;
    }
    expect(thrown).toBe(true);
    expect(result).toBeUndefined();
  });

  test("mensaje de error identifica cantidad, frecuencia y fecha de la última cuota", () => {
    try {
      buildInstallmentPlan({
        periodStart: "2026-01-01", periodEnd: "2026-01-01", periodAmount: 3000, installmentCount: 3,
      });
      throw new Error("no debería llegar acá");
    } catch (e: any) {
      expect(e).toBeInstanceOf(InstallmentPlanError);
      expect(e.message).toContain("no entran en el período facturado");
    }
  });

  test("6 cuotas mensuales caben exactamente en un período semestral (borde: última = periodEnd)", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01",
      periodEnd: "2026-06-01", // exactamente igual a la fecha de la última cuota
      periodAmount: 600000,
      installmentCount: 6,
    });
    expect(result.installments.length).toBe(6);
    expect(result.installments[5]!.dueDate).toBe("2026-06-01"); // igual a periodEnd — límite inclusivo
  });

  test("6 cuotas mensuales NO caben si el período semestral termina un día antes de la última cuota", () => {
    expect(() => buildInstallmentPlan({
      periodStart: "2026-01-01",
      periodEnd: "2026-05-31", // un día antes de la fecha en que vencería la cuota 6 (2026-06-01)
      periodAmount: 600000,
      installmentCount: 6,
    })).toThrow(InstallmentPlanError);
  });

  test("4 cuotas mensuales caben en un período cuatrimestral", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01", periodEnd: "2026-04-30", periodAmount: 400000, installmentCount: 4,
    });
    expect(result.installments.length).toBe(4);
    expect(result.installments[3]!.dueDate).toBe("2026-04-01");
  });

  test("10 cuotas mensuales caben dentro de un período anual", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01", periodEnd: "2026-12-31", periodAmount: 1000000, installmentCount: 10,
    });
    expect(result.installments.length).toBe(10);
    expect(result.installments[9]!.dueDate).toBe("2026-10-01");
  });
});

describe("Rango de fechas: firstDueDate dentro del período (bloqueante)", () => {
  test("firstDueDate anterior a periodStart → error, sin plan parcial", () => {
    let thrown = false;
    let result: any = undefined;
    try {
      result = buildInstallmentPlan({
        periodStart: "2026-01-01", periodEnd: "2026-12-31", periodAmount: 300000,
        installmentCount: 3, firstDueDate: "2025-12-15",
      });
    } catch (e) {
      thrown = e instanceof InstallmentPlanError;
    }
    expect(thrown).toBe(true);
    expect(result).toBeUndefined();
  });

  test("firstDueDate posterior a periodEnd → error, sin plan parcial", () => {
    let thrown = false;
    let result: any = undefined;
    try {
      result = buildInstallmentPlan({
        periodStart: "2026-01-01", periodEnd: "2026-03-31", periodAmount: 300000,
        installmentCount: 3, firstDueDate: "2026-04-01",
      });
    } catch (e) {
      thrown = e instanceof InstallmentPlanError;
    }
    expect(thrown).toBe(true);
    expect(result).toBeUndefined();
  });

  test("firstDueDate igual a periodStart es válido", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01", periodEnd: "2026-03-31", periodAmount: 300000,
      installmentCount: 3, firstDueDate: "2026-01-01",
    });
    expect(result.installments[0]!.dueDate).toBe("2026-01-01");
  });

  test("firstDueDate igual a periodEnd es válido cuando la única cuota vence ese mismo día", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01", periodEnd: "2026-01-31", periodAmount: 1000,
      installmentCount: 1, firstDueDate: "2026-01-31",
    });
    expect(result.installments.length).toBe(1);
    expect(result.installments[0]!.dueDate).toBe("2026-01-31");
  });
});

describe("Primera fecha de vencimiento explícita (día de vencimiento configurable)", () => {
  test("firstDueDate distinto del inicio del período se respeta y se propaga mensualmente", () => {
    const result = buildInstallmentPlan({
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      periodAmount: 300000,
      installmentCount: 3,
      firstDueDate: "2026-01-15",
    });
    expect(result.installments.map(i => i.dueDate)).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
  });
});

describe("addCalendarMonths — fechas calendario, sin desplazamientos por UTC", () => {
  test("31 de enero + 1 mes → 28 de febrero (año no bisiesto)", () => {
    expect(addCalendarMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
  test("31 de enero + 1 mes → 29 de febrero (año bisiesto)", () => {
    expect(addCalendarMonths("2024-01-31", 1)).toBe("2024-02-29");
  });
  test("cambio de mes simple preserva el día", () => {
    expect(addCalendarMonths("2026-01-15", 1)).toBe("2026-02-15");
  });
  test("cambio de año", () => {
    expect(addCalendarMonths("2026-12-15", 1)).toBe("2027-01-15");
  });
  test("31 de marzo + 1 mes → 30 de abril (abril tiene 30 días)", () => {
    expect(addCalendarMonths("2026-03-31", 1)).toBe("2026-04-30");
  });
  test("sumar 0 meses devuelve la misma fecha", () => {
    expect(addCalendarMonths("2026-05-20", 0)).toBe("2026-05-20");
  });
});

describe("isValidCalendarDate", () => {
  test("acepta fechas reales", () => {
    expect(isValidCalendarDate("2026-01-31")).toBe(true);
    expect(isValidCalendarDate("2024-02-29")).toBe(true); // bisiesto
  });
  test("rechaza fechas inexistentes", () => {
    expect(isValidCalendarDate("2026-02-30")).toBe(false);
    expect(isValidCalendarDate("2026-02-29")).toBe(false); // no bisiesto
    expect(isValidCalendarDate("2026-13-01")).toBe(false);
    expect(isValidCalendarDate("2026-00-01")).toBe(false);
  });
  test("rechaza formatos inválidos", () => {
    expect(isValidCalendarDate("01-01-2026")).toBe(false);
    expect(isValidCalendarDate("not-a-date")).toBe(false);
    expect(isValidCalendarDate("")).toBe(false);
  });
});
