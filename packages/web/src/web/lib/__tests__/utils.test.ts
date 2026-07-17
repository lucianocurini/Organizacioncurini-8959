// Tests de formatCurrencyCents — helper acotado para el editor de medios de
// pago (Cobrar en lote / Imputar pago individual), que SIEMPRE muestra los
// centavos reales a partir de un importe en centavos enteros. formatCurrency
// (redondeo a peso entero, usado en dashboards/reportes) no se toca acá.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/utils.test.ts
import { describe, test, expect } from "bun:test";
import { formatCurrencyCents } from "../utils";
import { createSplitRow, computeSplitTotals } from "../payment-splits-form";

describe("formatCurrencyCents", () => {
  test("24991194 centavos → $249.911,94 (dos decimales reales, nunca redondeado a peso)", () => {
    expect(formatCurrencyCents(24991194)).toMatch(/^\$\s*249\.911,94$/);
  });

  test("-6 centavos → -$0,06, nunca '-$0' (caso reportado: diferencia fantasma)", () => {
    const result = formatCurrencyCents(-6);
    expect(result).toMatch(/^-\$\s*0,06$/);
    expect(result).not.toBe("-$0");
    expect(result).not.toBe("$0");
  });

  test("0 centavos → $0,00", () => {
    expect(formatCurrencyCents(0)).toMatch(/^\$\s*0,00$/);
  });

  test("null/undefined → '—' (mismo criterio que formatCurrency)", () => {
    expect(formatCurrencyCents(null)).toBe("—");
    expect(formatCurrencyCents(undefined)).toBe("—");
  });

  test("6 centavos positivos → $0,06", () => {
    expect(formatCurrencyCents(6)).toMatch(/^\$\s*0,06$/);
  });
});

// ─── Caso de regresión — "Se excede por $0.06" mostrado como "-$0" ──────────
// Reproduce el escenario reportado: total real con centavos ($249.911,94),
// distribuido en pesos enteros (cheque $249.900 + efectivo $12 = $249.912) →
// diferencia real de -6 centavos, que formatCurrency (redondeo a peso)
// mostraba como "-$0", ocultando que en realidad sobraban $0,06.

describe("Caso de regresión — diferencia de centavos visible con formatCurrencyCents", () => {
  test("cheque $249.900 + efectivo $12 contra un total de $249.911,94 → diferencia real de -6 centavos", () => {
    const splits = [createSplitRow("cheque", "249900"), createSplitRow("efectivo", "12")];
    const totals = computeSplitTotals("249911.94", splits);

    expect(totals.totalCents).toBe(24991194);
    expect(totals.distributedCents).toBe(24991200);
    expect(totals.diferenciaCents).toBe(-6);

    // Con el helper viejo (formatCurrency, redondeo a peso) esto se veía como "-$0".
    const displayed = formatCurrencyCents(totals.diferenciaCents);
    expect(displayed).toMatch(/^-\$\s*0,06$/);
    expect(displayed).not.toBe("-$0");
  });

  test("si el efectivo se ajusta a $11,94 la diferencia cierra en 0 (sin exceso ni falta)", () => {
    const splits = [createSplitRow("cheque", "249900"), createSplitRow("efectivo", "11.94")];
    const totals = computeSplitTotals("249911.94", splits);
    expect(totals.diferenciaCents).toBe(0);
    expect(formatCurrencyCents(totals.diferenciaCents)).toMatch(/^\$\s*0,00$/);
  });
});
