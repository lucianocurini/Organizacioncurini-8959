/**
 * Tests de los helpers puros de impacto en Caja de las allocations de
 * financiación — src/lib/payments/account-holder-funding-caja.ts (Etapa
 * 1B-2B-i). Sin DB, sin HTTP.
 *
 * Todos los escenarios son SINTÉTICOS: sourceId/amountCents inventados para
 * ejercitar la aritmética, sin asegurados, pólizas, notas ni datos del caso
 * real.
 */

import { test, expect, describe } from "bun:test";
import {
  calculateAllocationRenderedCajaImpact,
  AccountHolderFundingCajaError,
  type FundingAllocationRenderStatus,
} from "../../lib/payments/account-holder-funding-caja";

function allocation(overrides: Partial<FundingAllocationRenderStatus>): FundingAllocationRenderStatus {
  return {
    sourceKind: "credit_movement",
    sourceId: 1,
    amountCents: 1000,
    destinationRendered: false,
    ...overrides,
  };
}

const ZERO_IMPACT = {
  creditConsumedPendingCents: 0,
  creditConsumedRenderedCents: 0,
  debtPendingCents: 0,
  debtRenderedExpenseCents: 0,
  roundingPendingCents: 0,
  roundingRenderedExpenseCents: 0,
};

// ─── 1: allocations vacías ───────────────────────────────────────────────

describe("1. allocations vacías", () => {
  test("array vacío devuelve todos los totales en 0, sin lanzar", () => {
    expect(calculateAllocationRenderedCajaImpact([])).toEqual(ZERO_IMPACT);
  });
});

// ─── 2-4: crédito ─────────────────────────────────────────────────────────

describe("2. crédito totalmente pendiente", () => {
  test("ningún destino rendido: todo queda en creditConsumedPendingCents", () => {
    const result = calculateAllocationRenderedCajaImpact([
      allocation({ sourceKind: "credit_movement", sourceId: 10, amountCents: 30000, destinationRendered: false }),
      allocation({ sourceKind: "credit_movement", sourceId: 10, amountCents: 20000, destinationRendered: false }),
    ]);
    expect(result.creditConsumedPendingCents).toBe(50000);
    expect(result.creditConsumedRenderedCents).toBe(0);
    expect(result).toEqual({ ...ZERO_IMPACT, creditConsumedPendingCents: 50000 });
  });
});

describe("3. crédito totalmente rendido", () => {
  test("todos los destinos rendidos: todo queda en creditConsumedRenderedCents", () => {
    const result = calculateAllocationRenderedCajaImpact([
      allocation({ sourceKind: "credit_movement", sourceId: 10, amountCents: 30000, destinationRendered: true }),
      allocation({ sourceKind: "credit_movement", sourceId: 10, amountCents: 20000, destinationRendered: true }),
    ]);
    expect(result).toEqual({ ...ZERO_IMPACT, creditConsumedRenderedCents: 50000 });
  });
});

describe("4. crédito parcialmente rendido entre varios destinos", () => {
  test("un mismo movimiento (mismo sourceId) financia 3 destinos, solo 2 rendidos", () => {
    const result = calculateAllocationRenderedCajaImpact([
      allocation({ sourceKind: "credit_movement", sourceId: 7, amountCents: 10000, destinationRendered: true }),
      allocation({ sourceKind: "credit_movement", sourceId: 7, amountCents: 15000, destinationRendered: true }),
      allocation({ sourceKind: "credit_movement", sourceId: 7, amountCents: 25000, destinationRendered: false }),
    ]);
    expect(result.creditConsumedRenderedCents).toBe(25000);
    expect(result.creditConsumedPendingCents).toBe(25000);
  });

  test("movimientos de crédito distintos (distinto sourceId) se suman juntos, el pool es global", () => {
    const result = calculateAllocationRenderedCajaImpact([
      allocation({ sourceKind: "credit_movement", sourceId: 1, amountCents: 10000, destinationRendered: true }),
      allocation({ sourceKind: "credit_movement", sourceId: 2, amountCents: 5000, destinationRendered: true }),
      allocation({ sourceKind: "credit_movement", sourceId: 3, amountCents: 7000, destinationRendered: false }),
    ]);
    expect(result.creditConsumedRenderedCents).toBe(15000);
    expect(result.creditConsumedPendingCents).toBe(7000);
  });
});

// ─── 5-6: saldo deudor ──────────────────────────────────────────────────

describe("5. saldo deudor pendiente y rendido", () => {
  test("no rendido: no afecta Caja (0 en ambos buckets salvo debtPendingCents)", () => {
    const result = calculateAllocationRenderedCajaImpact([
      allocation({ sourceKind: "debt_movement", sourceId: 20, amountCents: 40000, destinationRendered: false }),
    ]);
    expect(result).toEqual({ ...ZERO_IMPACT, debtPendingCents: 40000 });
  });

  test("rendido: se reconoce como gasto real de Caja", () => {
    const result = calculateAllocationRenderedCajaImpact([
      allocation({ sourceKind: "debt_movement", sourceId: 20, amountCents: 40000, destinationRendered: true }),
    ]);
    expect(result).toEqual({ ...ZERO_IMPACT, debtRenderedExpenseCents: 40000 });
  });
});

describe("6. saldo deudor parcialmente rendido", () => {
  test("2 destinos del mismo saldo deudor, 1 rendido y 1 no", () => {
    const result = calculateAllocationRenderedCajaImpact([
      allocation({ sourceKind: "debt_movement", sourceId: 20, amountCents: 12000, destinationRendered: true }),
      allocation({ sourceKind: "debt_movement", sourceId: 20, amountCents: 8000, destinationRendered: false }),
    ]);
    expect(result.debtRenderedExpenseCents).toBe(12000);
    expect(result.debtPendingCents).toBe(8000);
  });
});

// ─── 7-8: redondeo ──────────────────────────────────────────────────────

describe("7. redondeo pendiente y rendido", () => {
  test("no rendido: no afecta Caja", () => {
    const result = calculateAllocationRenderedCajaImpact([
      allocation({ sourceKind: "rounding_adjustment", sourceId: 30, amountCents: 300, destinationRendered: false }),
    ]);
    expect(result).toEqual({ ...ZERO_IMPACT, roundingPendingCents: 300 });
  });

  test("rendido: se reconoce como gasto real de Caja", () => {
    const result = calculateAllocationRenderedCajaImpact([
      allocation({ sourceKind: "rounding_adjustment", sourceId: 30, amountCents: 300, destinationRendered: true }),
    ]);
    expect(result).toEqual({ ...ZERO_IMPACT, roundingRenderedExpenseCents: 300 });
  });
});

describe("8. redondeo parcialmente rendido", () => {
  test("2 destinos del mismo ajuste de redondeo, 1 rendido y 1 no", () => {
    const result = calculateAllocationRenderedCajaImpact([
      allocation({ sourceKind: "rounding_adjustment", sourceId: 30, amountCents: 150, destinationRendered: true }),
      allocation({ sourceKind: "rounding_adjustment", sourceId: 30, amountCents: 150, destinationRendered: false }),
    ]);
    expect(result.roundingRenderedExpenseCents).toBe(150);
    expect(result.roundingPendingCents).toBe(150);
  });
});

// ─── 9: reversión ────────────────────────────────────────────────────────

describe("9. reversión al desrendir un destino", () => {
  test("cambiar un destino de rendido a no rendido elimina exactamente ese impacto, sin tocar el resto", () => {
    const before: FundingAllocationRenderStatus[] = [
      allocation({ sourceKind: "debt_movement", sourceId: 20, amountCents: 12000, destinationRendered: true }),
      allocation({ sourceKind: "debt_movement", sourceId: 20, amountCents: 8000, destinationRendered: false }),
      allocation({ sourceKind: "rounding_adjustment", sourceId: 30, amountCents: 150, destinationRendered: true }),
    ];
    const resultBefore = calculateAllocationRenderedCajaImpact(before);
    expect(resultBefore.debtRenderedExpenseCents).toBe(12000);
    expect(resultBefore.debtPendingCents).toBe(8000);
    expect(resultBefore.roundingRenderedExpenseCents).toBe(150);

    // Se anula la rendición del primer destino: su allocation vuelve a destinationRendered=false.
    // Nada más cambia — no se crea ningún movimiento inverso, es literalmente el mismo cálculo
    // con el flag actualizado (ver comentario de cabecera del módulo).
    const after: FundingAllocationRenderStatus[] = [
      { ...before[0]!, destinationRendered: false },
      before[1]!,
      before[2]!,
    ];
    const resultAfter = calculateAllocationRenderedCajaImpact(after);

    expect(resultAfter.debtRenderedExpenseCents).toBe(0);
    expect(resultAfter.debtPendingCents).toBe(20000); // 12000 + 8000, ambos ahora pendientes
    // El impacto de redondeo, ajeno al destino revertido, queda exactamente igual.
    expect(resultAfter.roundingRenderedExpenseCents).toBe(resultBefore.roundingRenderedExpenseCents);
  });

  test("desrender y volver a rendir el mismo destino reproduce el resultado original exacto", () => {
    const rendered = [allocation({ sourceKind: "credit_movement", sourceId: 5, amountCents: 9000, destinationRendered: true })];
    const unrendered = [{ ...rendered[0]!, destinationRendered: false }];
    const reRendered = [{ ...rendered[0]!, destinationRendered: true }];

    expect(calculateAllocationRenderedCajaImpact(unrendered).creditConsumedPendingCents).toBe(9000);
    expect(calculateAllocationRenderedCajaImpact(reRendered)).toEqual(calculateAllocationRenderedCajaImpact(rendered));
  });
});

// ─── 10: conservación de totales ────────────────────────────────────────

describe("10. conservación de totales", () => {
  test("pendiente + rendido == total de entrada, para cualquier mezcla y cualquier sourceKind", () => {
    const allocations: FundingAllocationRenderStatus[] = [
      allocation({ sourceKind: "credit_movement", sourceId: 1, amountCents: 11000, destinationRendered: true }),
      allocation({ sourceKind: "credit_movement", sourceId: 1, amountCents: 22000, destinationRendered: false }),
      allocation({ sourceKind: "debt_movement", sourceId: 2, amountCents: 33000, destinationRendered: true }),
      allocation({ sourceKind: "debt_movement", sourceId: 2, amountCents: 44000, destinationRendered: false }),
      allocation({ sourceKind: "rounding_adjustment", sourceId: 3, amountCents: 100, destinationRendered: true }),
      allocation({ sourceKind: "rounding_adjustment", sourceId: 3, amountCents: 200, destinationRendered: false }),
    ];
    const result = calculateAllocationRenderedCajaImpact(allocations);

    expect(result.creditConsumedPendingCents + result.creditConsumedRenderedCents).toBe(11000 + 22000);
    expect(result.debtPendingCents + result.debtRenderedExpenseCents).toBe(33000 + 44000);
    expect(result.roundingPendingCents + result.roundingRenderedExpenseCents).toBe(100 + 200);

    const totalIn = allocations.reduce((s, a) => s + a.amountCents, 0);
    const totalOut = Object.values(result).reduce((s, v) => s + v, 0);
    expect(totalOut).toBe(totalIn);
  });
});

// ─── 11: determinismo ───────────────────────────────────────────────────

describe("11. determinismo", () => {
  test("misma entrada produce salida byte-a-byte equivalente", () => {
    const allocations: FundingAllocationRenderStatus[] = [
      allocation({ sourceKind: "credit_movement", sourceId: 1, amountCents: 11000, destinationRendered: true }),
      allocation({ sourceKind: "debt_movement", sourceId: 2, amountCents: 44000, destinationRendered: false }),
      allocation({ sourceKind: "rounding_adjustment", sourceId: 3, amountCents: 200, destinationRendered: true }),
    ];
    const resultA = calculateAllocationRenderedCajaImpact(allocations);
    const resultB = calculateAllocationRenderedCajaImpact(allocations);
    expect(JSON.stringify(resultA)).toBe(JSON.stringify(resultB));
  });

  test("el orden de las allocations no cambia los totales agregados", () => {
    const a1 = allocation({ sourceKind: "credit_movement", sourceId: 1, amountCents: 11000, destinationRendered: true });
    const a2 = allocation({ sourceKind: "debt_movement", sourceId: 2, amountCents: 44000, destinationRendered: false });
    const resultA = calculateAllocationRenderedCajaImpact([a1, a2]);
    const resultB = calculateAllocationRenderedCajaImpact([a2, a1]);
    expect(resultA).toEqual(resultB);
  });
});

// ─── 12-17: validaciones — nunca TypeError crudo ────────────────────────

describe("12. rechazo de allocations superior mal formada", () => {
  test("allocations undefined/null/no-array", () => {
    for (const invalid of [undefined, null, "x", 42, {}]) {
      expect(() => calculateAllocationRenderedCajaImpact(invalid as unknown as any)).toThrow(AccountHolderFundingCajaError);
    }
  });

  test("ninguno de los casos anteriores escapa como TypeError", () => {
    for (const invalid of [undefined, null, "x", 42, {}]) {
      try {
        calculateAllocationRenderedCajaImpact(invalid as unknown as any);
        throw new Error("se esperaba que lanzara");
      } catch (err) {
        expect(err).toBeInstanceOf(AccountHolderFundingCajaError);
        expect(err).not.toBeInstanceOf(TypeError);
      }
    }
  });
});

describe("13. rechazo de elementos null/no objeto dentro de allocations", () => {
  test("un elemento null en la posición 0", () => {
    expect(() => calculateAllocationRenderedCajaImpact([null] as unknown as any)).toThrow(AccountHolderFundingCajaError);
  });

  test("un elemento primitivo o array", () => {
    for (const invalid of ["x", 5, true, []]) {
      expect(() => calculateAllocationRenderedCajaImpact([invalid] as unknown as any)).toThrow(AccountHolderFundingCajaError);
    }
  });
});

describe("14. rechazo de sourceKind inválido", () => {
  test("sourceKind fuera del vocabulario permitido", () => {
    expect(() =>
      calculateAllocationRenderedCajaImpact([allocation({ sourceKind: "refund" as unknown as any })])
    ).toThrow(AccountHolderFundingCajaError);
  });

  test("sourceKind ausente, null o numérico", () => {
    for (const invalid of [undefined, null, 1]) {
      expect(() =>
        calculateAllocationRenderedCajaImpact([{ ...allocation({}), sourceKind: invalid as unknown as any }])
      ).toThrow(AccountHolderFundingCajaError);
    }
  });
});

describe("15. rechazo de sourceId inválido", () => {
  test("sourceId no entero, cero, negativo, NaN o Infinity", () => {
    for (const invalid of [1.5, 0, -1, NaN, Infinity, -Infinity]) {
      expect(() => calculateAllocationRenderedCajaImpact([allocation({ sourceId: invalid })])).toThrow(
        AccountHolderFundingCajaError
      );
    }
  });

  test("sourceId no numérico", () => {
    for (const invalid of ["1", null, undefined, {}]) {
      expect(() => calculateAllocationRenderedCajaImpact([allocation({ sourceId: invalid as unknown as any })])).toThrow(
        AccountHolderFundingCajaError
      );
    }
  });
});

describe("16. rechazo de amountCents inválido", () => {
  test("amountCents no entero, cero, negativo, NaN o Infinity", () => {
    for (const invalid of [1.5, 0, -1000, NaN, Infinity, -Infinity]) {
      expect(() => calculateAllocationRenderedCajaImpact([allocation({ amountCents: invalid })])).toThrow(
        AccountHolderFundingCajaError
      );
    }
  });

  test("amountCents no numérico", () => {
    for (const invalid of ["1000", null, undefined, {}]) {
      expect(() =>
        calculateAllocationRenderedCajaImpact([allocation({ amountCents: invalid as unknown as any })])
      ).toThrow(AccountHolderFundingCajaError);
    }
  });
});

describe("17. destinationRendered estrictamente booleano — nunca por coerción truthy/falsy", () => {
  test("acepta exactamente true y exactamente false", () => {
    expect(() => calculateAllocationRenderedCajaImpact([allocation({ destinationRendered: true })])).not.toThrow();
    expect(() => calculateAllocationRenderedCajaImpact([allocation({ destinationRendered: false })])).not.toThrow();
  });

  test('el string truthy "false" NUNCA se interpreta como rendido — no se acepta por coerción', () => {
    let thrown: unknown;
    try {
      calculateAllocationRenderedCajaImpact([allocation({ destinationRendered: "false" as unknown as any })]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AccountHolderFundingCajaError);
  });

  test("rechaza destinationRendered ausente, null, 0/1 y otros valores truthy/falsy", () => {
    for (const invalid of [undefined, null, 0, 1, "true", [], {}]) {
      expect(() =>
        calculateAllocationRenderedCajaImpact([allocation({ destinationRendered: invalid as unknown as any })])
      ).toThrow(AccountHolderFundingCajaError);
    }
  });
});

// ─── 18: overflow seguro ─────────────────────────────────────────────────

describe("18. overflow seguro", () => {
  test("amountCents individual por encima de Number.MAX_SAFE_INTEGER es rechazado", () => {
    expect(() =>
      calculateAllocationRenderedCajaImpact([allocation({ amountCents: Number.MAX_SAFE_INTEGER + 2 })])
    ).toThrow(AccountHolderFundingCajaError);
  });

  test("la suma agregada de varias allocations que desborda Number.MAX_SAFE_INTEGER es rechazada", () => {
    expect(() =>
      calculateAllocationRenderedCajaImpact([
        allocation({ sourceKind: "credit_movement", sourceId: 1, amountCents: Number.MAX_SAFE_INTEGER, destinationRendered: false }),
        allocation({ sourceKind: "credit_movement", sourceId: 2, amountCents: Number.MAX_SAFE_INTEGER, destinationRendered: false }),
      ])
    ).toThrow(AccountHolderFundingCajaError);
  });

  test("el desborde en un bucket (rendido) no contamina otro bucket independiente (pendiente)", () => {
    expect(() =>
      calculateAllocationRenderedCajaImpact([
        allocation({ sourceKind: "debt_movement", sourceId: 1, amountCents: Number.MAX_SAFE_INTEGER, destinationRendered: true }),
        allocation({ sourceKind: "debt_movement", sourceId: 2, amountCents: Number.MAX_SAFE_INTEGER, destinationRendered: true }),
      ])
    ).toThrow(AccountHolderFundingCajaError);
  });
});
