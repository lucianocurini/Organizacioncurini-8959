/**
 * Tests de los helpers puros de planificación financiera superior y matriz
 * de allocations — src/lib/payments/account-holder-funding-plan.ts (Etapa
 * 1B-2A). Sin DB, sin HTTP.
 *
 * Todos los escenarios son SINTÉTICOS: ids genéricos ("d1", "s1", "pay-a",
 * "cheque-1", ...), importes inventados para ejercitar la aritmética, sin
 * asegurados, pólizas, notas ni datos del caso real.
 */

import { test, expect, describe } from "bun:test";
import {
  planAccountHolderBatchFunding,
  validateAccountHolderFundingAllocations,
  AccountHolderFundingPlanError,
  type PlanAccountHolderBatchFundingInput,
  type FundingPlanSplitInput,
  type AccountHolderFundingPlanResult,
  type FundingAllocationDraft,
} from "../../lib/payments/account-holder-funding-plan";
import { FundingValidationError, type FundingDestinationInput } from "../../lib/payments/account-holder-funding";
import { MAX_ROUNDING_ADJUSTMENT_CENTS } from "../../lib/payments/insured-account";

function baseInput(overrides: Partial<PlanAccountHolderBatchFundingInput>): PlanAccountHolderBatchFundingInput {
  return {
    destinations: [{ id: "d1", kind: "payment", nominalCents: 100000 }],
    realSplits: [],
    creditAppliedCents: 0,
    roundingCoverageCents: 0,
    availableCreditCents: 0,
    debtAuthorized: false,
    ...overrides,
  };
}

function sumAllocationsBy(allocations: FundingAllocationDraft[], predicate: (a: FundingAllocationDraft) => boolean): number {
  return allocations.filter(predicate).reduce((s, a) => s + a.amountCents, 0);
}

// ─── 1-17: planAccountHolderBatchFunding ────────────────────────────────────

describe("1. pago exacto solo con splits", () => {
  test("realSplitsTotalCents === nominal, sin crédito/redondeo/deuda/favor", () => {
    const result = planAccountHolderBatchFunding(
      baseInput({ realSplits: [{ id: "s1", amountCents: 100000 }] })
    );
    expect(result.nominalTotalCents).toBe(100000);
    expect(result.realSplitsTotalCents).toBe(100000);
    expect(result.creditAppliedCents).toBe(0);
    expect(result.roundingCoverageCents).toBe(0);
    expect(result.newSaldoAFavorCents).toBe(0);
    expect(result.newSaldoDeudorCents).toBe(0);
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits: [{ id: "s1", amountCents: 100000 }] })).not.toThrow();
  });
});

describe("2. crédito parcial + dinero real", () => {
  test("cierra exacto combinando ambas fuentes", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 60000 }];
    const result = planAccountHolderBatchFunding(
      baseInput({ realSplits, creditAppliedCents: 40000, availableCreditCents: 40000 })
    );
    expect(result.realSplitsTotalCents).toBe(60000);
    expect(result.creditAppliedCents).toBe(40000);
    expect(result.newSaldoAFavorCents).toBe(0);
    expect(result.newSaldoDeudorCents).toBe(0);
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits })).not.toThrow();
  });
});

describe("3. 100% crédito, sin splits", () => {
  test("realSplits=[] financiado íntegramente por crédito", () => {
    const result = planAccountHolderBatchFunding(
      baseInput({ realSplits: [], creditAppliedCents: 100000, availableCreditCents: 100000 })
    );
    expect(result.realSplitsTotalCents).toBe(0);
    expect(result.creditAppliedCents).toBe(100000);
    expect(result.newSaldoAFavorCents).toBe(0);
    expect(result.newSaldoDeudorCents).toBe(0);
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits: [] })).not.toThrow();
  });
});

describe("4. crédito + redondeo + dinero real exacto", () => {
  test("las tres fuentes suman exactamente el nominal", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 59700 }];
    const result = planAccountHolderBatchFunding(
      baseInput({ realSplits, creditAppliedCents: 40000, roundingCoverageCents: 300, availableCreditCents: 40000 })
    );
    expect(result.roundingCoverageCents).toBe(300);
    expect(result.newSaldoAFavorCents).toBe(0);
    expect(result.newSaldoDeudorCents).toBe(0);
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits })).not.toThrow();
  });
});

describe("5. faltante autorizado como deuda", () => {
  test("debtAuthorized=true genera newSaldoDeudorCents por el faltante exacto", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }];
    const result = planAccountHolderBatchFunding(baseInput({ realSplits, debtAuthorized: true }));
    expect(result.newSaldoDeudorCents).toBe(30000);
    expect(result.newSaldoAFavorCents).toBe(0);
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits })).not.toThrow();
  });
});

describe("6. faltante sin autorización rechazado", () => {
  test("debtAuthorized=false lanza con el monto exacto del faltante", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }];
    expect(() => planAccountHolderBatchFunding(baseInput({ realSplits, debtAuthorized: false }))).toThrow(
      AccountHolderFundingPlanError
    );
    try {
      planAccountHolderBatchFunding(baseInput({ realSplits, debtAuthorized: false }));
      throw new Error("no debería llegar acá");
    } catch (e) {
      expect(e).toBeInstanceOf(AccountHolderFundingPlanError);
      expect((e as Error).message).toContain("300.00");
    }
  });
});

describe("7. dinero real excedente genera saldo a favor", () => {
  test("excedente sin crédito ni redondeo produce newSaldoAFavorCents exacto", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 120000 }];
    const result = planAccountHolderBatchFunding(baseInput({ realSplits }));
    expect(result.newSaldoAFavorCents).toBe(20000);
    expect(result.newSaldoDeudorCents).toBe(0);
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits })).not.toThrow();
  });
});

describe("8. crédito sobre-fondeado rechazado, sin reducción", () => {
  test("dinero real + crédito superan el nominal con crédito > 0: error explícito", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 50000 }];
    expect(() =>
      planAccountHolderBatchFunding(baseInput({ realSplits, creditAppliedCents: 60000, availableCreditCents: 60000 }))
    ).toThrow(AccountHolderFundingPlanError);
  });
});

describe("9. redondeo sin faltante rechazado", () => {
  test("real+crédito ya cubren el nominal exacto: redondeo > 0 es error", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    expect(() => planAccountHolderBatchFunding(baseInput({ realSplits, roundingCoverageCents: 50 }))).toThrow(
      AccountHolderFundingPlanError
    );
  });
});

describe("10. redondeo mayor al faltante rechazado", () => {
  test("el faltante real es menor al redondeo pedido", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 99700 }]; // faltante = 300
    expect(() => planAccountHolderBatchFunding(baseInput({ realSplits, roundingCoverageCents: 400 }))).toThrow(
      AccountHolderFundingPlanError
    );
  });
});

describe("11. redondeo sobre el máximo rechazado", () => {
  test("redondeo dentro del faltante pero por encima de MAX_ROUNDING_ADJUSTMENT_CENTS", () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 1000000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 998900 }]; // faltante = 1100
    const roundingCoverageCents = MAX_ROUNDING_ADJUSTMENT_CENTS + 100;
    expect(roundingCoverageCents).toBeLessThan(1100); // dentro del faltante, para aislar el chequeo de máximo
    expect(() =>
      planAccountHolderBatchFunding(baseInput({ destinations, realSplits, roundingCoverageCents }))
    ).toThrow(AccountHolderFundingPlanError);
  });
});

describe("12. crédito mayor al disponible rechazado", () => {
  test("creditAppliedCents > availableCreditCents, aunque quepa en los destinos", () => {
    expect(() =>
      planAccountHolderBatchFunding(baseInput({ creditAppliedCents: 50000, availableCreditCents: 40000 }))
    ).toThrow(AccountHolderFundingPlanError);
  });
});

describe("13. rechazo de decimales, NaN, Infinity y overflow", () => {
  test("creditAppliedCents decimal (validado por Etapa 0, reutilizada)", () => {
    expect(() => planAccountHolderBatchFunding(baseInput({ creditAppliedCents: 100.5, availableCreditCents: 1000000 }))).toThrow(
      FundingValidationError
    );
  });

  test("roundingCoverageCents decimal (validado por Etapa 0, reutilizada)", () => {
    expect(() => planAccountHolderBatchFunding(baseInput({ roundingCoverageCents: 1.5 }))).toThrow(FundingValidationError);
  });

  test("NaN/Infinity en creditAppliedCents", () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(() => planAccountHolderBatchFunding(baseInput({ creditAppliedCents: invalid, availableCreditCents: 1000000 }))).toThrow(
        FundingValidationError
      );
    }
  });

  test("availableCreditCents decimal rechazado por este módulo", () => {
    expect(() => planAccountHolderBatchFunding(baseInput({ availableCreditCents: 10.5 }))).toThrow(AccountHolderFundingPlanError);
  });

  test("NaN/Infinity en availableCreditCents rechazado por este módulo", () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(() => planAccountHolderBatchFunding(baseInput({ availableCreditCents: invalid }))).toThrow(
        AccountHolderFundingPlanError
      );
    }
  });

  test("amountCents decimal/NaN/Infinity en un split real", () => {
    for (const invalid of [100.5, NaN, Infinity, -Infinity]) {
      expect(() =>
        planAccountHolderBatchFunding(baseInput({ realSplits: [{ id: "s1", amountCents: invalid }], debtAuthorized: true }))
      ).toThrow(AccountHolderFundingPlanError);
    }
  });

  test("overflow: dos destinos en Number.MAX_SAFE_INTEGER (validado por Etapa 0, reutilizada)", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: Number.MAX_SAFE_INTEGER },
      { id: "d2", kind: "payment", nominalCents: Number.MAX_SAFE_INTEGER },
    ];
    expect(() => planAccountHolderBatchFunding(baseInput({ destinations }))).toThrow(FundingValidationError);
  });

  test("overflow: realSplitsTotalCents desborda Number.MAX_SAFE_INTEGER", () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100 }];
    const realSplits: FundingPlanSplitInput[] = [
      { id: "s1", amountCents: Number.MAX_SAFE_INTEGER },
      { id: "s2", amountCents: Number.MAX_SAFE_INTEGER },
    ];
    expect(() => planAccountHolderBatchFunding(baseInput({ destinations, realSplits, debtAuthorized: true }))).toThrow(
      AccountHolderFundingPlanError
    );
  });
});

describe("14. splits vacíos válidos cuando otra fuente cubre todo", () => {
  test("realSplits=[] con crédito exacto no lanza", () => {
    expect(() =>
      planAccountHolderBatchFunding(baseInput({ realSplits: [], creditAppliedCents: 100000, availableCreditCents: 100000 }))
    ).not.toThrow();
  });
});

describe("15. splits vacíos inválidos cuando queda faltante no autorizado", () => {
  test("realSplits=[] sin ninguna otra fuente y sin autorización de deuda lanza", () => {
    expect(() => planAccountHolderBatchFunding(baseInput({ realSplits: [], debtAuthorized: false }))).toThrow(
      AccountHolderFundingPlanError
    );
  });
});

describe("16. IDs de split vacíos/duplicados rechazados", () => {
  test("id vacío", () => {
    expect(() =>
      planAccountHolderBatchFunding(baseInput({ realSplits: [{ id: "", amountCents: 1000 }], debtAuthorized: true }))
    ).toThrow(AccountHolderFundingPlanError);
  });

  test("id compuesto solo de espacios", () => {
    expect(() =>
      planAccountHolderBatchFunding(baseInput({ realSplits: [{ id: "   ", amountCents: 1000 }], debtAuthorized: true }))
    ).toThrow(AccountHolderFundingPlanError);
  });

  test("ids duplicados", () => {
    expect(() =>
      planAccountHolderBatchFunding(
        baseInput({
          realSplits: [
            { id: "dup", amountCents: 500 },
            { id: "dup", amountCents: 500 },
          ],
        })
      )
    ).toThrow(AccountHolderFundingPlanError);
  });
});

describe("17. saldo a favor nunca coexistiendo con fuentes virtuales", () => {
  test("excedente real + crédito > 0 rechazado (no genera saldo a favor con crédito)", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 90000 }];
    expect(() =>
      planAccountHolderBatchFunding(baseInput({ realSplits, creditAppliedCents: 20000, availableCreditCents: 20000 }))
    ).toThrow(AccountHolderFundingPlanError);
  });

  test("excedente real + redondeo > 0 rechazado (no genera saldo a favor con redondeo)", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 120000 }];
    expect(() => planAccountHolderBatchFunding(baseInput({ realSplits, roundingCoverageCents: 10 }))).toThrow(
      AccountHolderFundingPlanError
    );
  });
});

// ─── 18-30: waterfall / matriz de allocations ───────────────────────────────

describe("18. una fuente financia varios destinos", () => {
  test("un único split cubre dos destinos payment", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 30000 },
      { id: "d2", kind: "payment", nominalCents: 20000 },
    ];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 50000 }];
    const result = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));

    const s1Rows = result.allocations.filter((a) => a.sourceKind === "split" && a.sourceKey === "s1");
    expect(s1Rows.length).toBe(2);
    expect(new Set(s1Rows.map((a) => a.destinationKey))).toEqual(new Set(["d1", "d2"]));
    expect(sumAllocationsBy(result.allocations, (a) => a.sourceKind === "split" && a.sourceKey === "s1")).toBe(50000);
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits })).not.toThrow();
  });
});

describe("19. un destino recibe varias fuentes", () => {
  test("dos splits distintos financian el mismo destino", () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 50000 }];
    const realSplits: FundingPlanSplitInput[] = [
      { id: "s1", amountCents: 20000 },
      { id: "s2", amountCents: 30000 },
    ];
    const result = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));

    const d1Rows = result.allocations.filter((a) => a.destinationKind === "payment" && a.destinationKey === "d1");
    expect(d1Rows.length).toBe(2);
    expect(new Set(d1Rows.map((a) => a.sourceKey))).toEqual(new Set(["s1", "s2"]));
    expect(sumAllocationsBy(result.allocations, (a) => a.destinationKey === "d1")).toBe(50000);
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits })).not.toThrow();
  });
});

describe("20. split + crédito + redondeo en un destino", () => {
  test("un mismo destino recibe las tres fuentes", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 59800 }];
    const result = planAccountHolderBatchFunding(
      baseInput({ realSplits, creditAppliedCents: 40000, roundingCoverageCents: 200, availableCreditCents: 40000 })
    );

    const d1Rows = result.allocations.filter((a) => a.destinationKey === "d1");
    const sourceKinds = new Set(d1Rows.map((a) => a.sourceKind));
    expect(sourceKinds).toEqual(new Set(["split", "credit_movement", "rounding_adjustment"]));
    expect(sumAllocationsBy(result.allocations, (a) => a.destinationKey === "d1")).toBe(100000);
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits })).not.toThrow();
  });
});

describe("21. deuda como última fuente", () => {
  test("el saldo deudor solo cubre lo que ningún split real alcanzó a cubrir", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 30000 },
      { id: "d2", kind: "payment", nominalCents: 40000 },
    ];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 50000 }];
    const result = planAccountHolderBatchFunding(baseInput({ destinations, realSplits, debtAuthorized: true }));

    expect(result.newSaldoDeudorCents).toBe(20000);
    const debtRows = result.allocations.filter((a) => a.sourceKind === "debt_movement");
    expect(debtRows.length).toBe(1);
    expect(debtRows[0]!.amountCents).toBe(20000);
    // La fila de deuda es la última allocation generada.
    expect(result.allocations[result.allocations.length - 1]!.sourceKind).toBe("debt_movement");
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits })).not.toThrow();
  });
});

describe("22. excedente real dirigido al destino saldo_a_favor", () => {
  test("el excedente se asigna a new_credit_movement, nunca a un destino real", () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 50000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }];
    const result = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));

    expect(result.newSaldoAFavorCents).toBe(20000);
    const newCreditRows = result.allocations.filter((a) => a.destinationKind === "new_credit_movement");
    expect(newCreditRows.length).toBe(1);
    expect(newCreditRows[0]!.amountCents).toBe(20000);
    expect(newCreditRows[0]!.sourceKind).toBe("split");
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits })).not.toThrow();
  });
});

describe("23. determinismo con la misma entrada", () => {
  test("misma entrada produce salida byte-a-byte equivalente", () => {
    const input = baseInput({
      destinations: [
        { id: "d1", kind: "payment", nominalCents: 30000 },
        { id: "d2", kind: "payment", nominalCents: 20000 },
        { id: "pp1", kind: "pronto_pago", nominalCents: 5000 },
      ],
      realSplits: [
        { id: "s1", amountCents: 25000 },
        { id: "s2", amountCents: 20000 },
      ],
      creditAppliedCents: 10000,
      roundingCoverageCents: 0,
      availableCreditCents: 10000,
    });
    const resultA = planAccountHolderBatchFunding(input);
    const resultB = planAccountHolderBatchFunding(input);
    expect(JSON.stringify(resultA)).toBe(JSON.stringify(resultB));
  });
});

describe("24. cambio de orden de splits puede cambiar matriz pero no totales", () => {
  test("mismos splits en distinto orden: allocations distintas, totales idénticos", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 30000 },
      { id: "d2", kind: "payment", nominalCents: 20000 },
    ];
    const splitsOrderA: FundingPlanSplitInput[] = [
      { id: "s1", amountCents: 25000 },
      { id: "s2", amountCents: 25000 },
    ];
    const splitsOrderB: FundingPlanSplitInput[] = [
      { id: "s2", amountCents: 25000 },
      { id: "s1", amountCents: 25000 },
    ];

    const resultA = planAccountHolderBatchFunding(baseInput({ destinations, realSplits: splitsOrderA }));
    const resultB = planAccountHolderBatchFunding(baseInput({ destinations, realSplits: splitsOrderB }));

    expect(resultA.allocations).not.toEqual(resultB.allocations);

    expect(resultA.nominalTotalCents).toBe(resultB.nominalTotalCents);
    expect(resultA.realSplitsTotalCents).toBe(resultB.realSplitsTotalCents);
    expect(resultA.newSaldoAFavorCents).toBe(resultB.newSaldoAFavorCents);
    expect(resultA.newSaldoDeudorCents).toBe(resultB.newSaldoDeudorCents);
    expect(resultA.totals).toEqual(resultB.totals);

    // El total por split y por destino no cambia, aunque el detalle de filas sí.
    for (const splitId of ["s1", "s2"]) {
      expect(sumAllocationsBy(resultA.allocations, (a) => a.sourceKind === "split" && a.sourceKey === splitId)).toBe(25000);
      expect(sumAllocationsBy(resultB.allocations, (a) => a.sourceKind === "split" && a.sourceKey === splitId)).toBe(25000);
    }
    for (const destId of ["d1", "d2"]) {
      const expectedNominal = destinations.find((d) => d.id === destId)!.nominalCents;
      expect(sumAllocationsBy(resultA.allocations, (a) => a.destinationKey === destId)).toBe(expectedNominal);
      expect(sumAllocationsBy(resultB.allocations, (a) => a.destinationKey === destId)).toBe(expectedNominal);
    }
  });
});

describe("25. cero allocations de monto 0", () => {
  test("ningún draft tiene amountCents === 0, con o sin crédito/redondeo", () => {
    const scenarios: PlanAccountHolderBatchFundingInput[] = [
      baseInput({ realSplits: [{ id: "s1", amountCents: 100000 }] }),
      baseInput({ realSplits: [], creditAppliedCents: 100000, availableCreditCents: 100000 }),
      baseInput({
        realSplits: [{ id: "s1", amountCents: 59700 }],
        creditAppliedCents: 40000,
        roundingCoverageCents: 300,
        availableCreditCents: 40000,
      }),
    ];
    for (const input of scenarios) {
      const result = planAccountHolderBatchFunding(input);
      expect(result.allocations.every((a) => a.amountCents > 0)).toBe(true);
    }
  });
});

describe("26. cierres exactos por fuente y destino", () => {
  test("validateAccountHolderFundingAllocations acepta un plan bien formado", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "pay-a", kind: "payment", nominalCents: 250000 },
      { id: "pay-b", kind: "payment", nominalCents: 150000 },
      { id: "pp-a", kind: "pronto_pago", nominalCents: 8000 },
    ];
    const realSplits: FundingPlanSplitInput[] = [
      { id: "cheque-1", amountCents: 100000 },
      { id: "efectivo-1", amountCents: 150000 },
    ];
    const result = planAccountHolderBatchFunding(
      baseInput({
        destinations,
        realSplits,
        creditAppliedCents: 90000,
        roundingCoverageCents: 50,
        availableCreditCents: 90000,
        debtAuthorized: true,
      })
    );
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits })).not.toThrow();
  });
});

describe("27. matriz adulterada detectada", () => {
  const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
  const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];

  function validPlan(): AccountHolderFundingPlanResult {
    return planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));
  }

  test("alterar el amountCents de una allocation es detectado", () => {
    const tampered: AccountHolderFundingPlanResult = JSON.parse(JSON.stringify(validPlan()));
    tampered.allocations[0]!.amountCents += 1;
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("alterar nominalTotalCents del plan es detectado", () => {
    const tampered: AccountHolderFundingPlanResult = JSON.parse(JSON.stringify(validPlan()));
    tampered.nominalTotalCents += 1;
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("alterar totals.sourcesTotalCents del plan es detectado", () => {
    const tampered: AccountHolderFundingPlanResult = JSON.parse(JSON.stringify(validPlan()));
    tampered.totals.sourcesTotalCents += 1;
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });
});

describe("28. fuente/destino desconocidos rechazados", () => {
  const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
  const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];

  test("sourceKind fuera del vocabulario permitido", () => {
    const plan = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));
    const tampered: AccountHolderFundingPlanResult = {
      ...plan,
      allocations: [{ ...plan.allocations[0]!, sourceKind: "refund" as unknown as FundingAllocationDraft["sourceKind"] }],
    };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("destinationKind fuera del vocabulario permitido", () => {
    const plan = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));
    const tampered: AccountHolderFundingPlanResult = {
      ...plan,
      allocations: [{ ...plan.allocations[0]!, destinationKind: "refund" as unknown as FundingAllocationDraft["destinationKind"] }],
    };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("destinationKey que no corresponde a ningún destino real del plan", () => {
    const plan = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));
    const tampered: AccountHolderFundingPlanResult = {
      ...plan,
      allocations: [{ ...plan.allocations[0]!, destinationKey: "d-inexistente" }],
    };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("new_credit_movement alimentado por una fuente que no es split", () => {
    const realSplitsExcess: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 120000 }];
    const plan = planAccountHolderBatchFunding(baseInput({ destinations, realSplits: realSplitsExcess }));
    const newCreditRowIndex = plan.allocations.findIndex((a) => a.destinationKind === "new_credit_movement");
    expect(newCreditRowIndex).toBeGreaterThanOrEqual(0);
    const tamperedAllocations = plan.allocations.map((a, i) => (i === newCreditRowIndex ? { ...a, sourceKind: "credit_movement" as const, sourceKey: "credit_movement" } : a));
    const tampered: AccountHolderFundingPlanResult = { ...plan, allocations: tamperedAllocations };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits: realSplitsExcess })).toThrow(
      AccountHolderFundingPlanError
    );
  });
});

describe("29. overflow agregado rechazado", () => {
  test("la suma de nominales de los destinos desborda Number.MAX_SAFE_INTEGER", () => {
    const corrupted: AccountHolderFundingPlanResult = {
      destinations: [
        { id: "d1", kind: "payment", nominalCents: Number.MAX_SAFE_INTEGER, creditCents: 0, roundingCents: 0, cashCents: Number.MAX_SAFE_INTEGER },
        { id: "d2", kind: "payment", nominalCents: Number.MAX_SAFE_INTEGER, creditCents: 0, roundingCents: 0, cashCents: Number.MAX_SAFE_INTEGER },
      ],
      nominalTotalCents: Number.MAX_SAFE_INTEGER,
      realSplitsTotalCents: 0,
      creditAppliedCents: 0,
      roundingCoverageCents: 0,
      newSaldoAFavorCents: 0,
      newSaldoDeudorCents: 0,
      allocations: [],
      totals: { sourcesTotalCents: 0, destinationsTotalCents: Number.MAX_SAFE_INTEGER },
    };
    expect(() => validateAccountHolderFundingAllocations(corrupted, { realSplits: [] })).toThrow(AccountHolderFundingPlanError);
  });
});

describe("30. escenario sintético combinado completo", () => {
  test("múltiples destinos payment/pronto_pago, múltiples splits, crédito, redondeo y deuda cierran exacto", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "pay-a", kind: "payment", nominalCents: 250000 },
      { id: "pay-b", kind: "payment", nominalCents: 150000 },
      { id: "pp-a", kind: "pronto_pago", nominalCents: 8000 },
    ];
    const realSplits: FundingPlanSplitInput[] = [
      { id: "cheque-1", amountCents: 100000 },
      { id: "efectivo-1", amountCents: 150000 },
    ];
    const result = planAccountHolderBatchFunding(
      baseInput({
        destinations,
        realSplits,
        creditAppliedCents: 90000,
        roundingCoverageCents: 50,
        availableCreditCents: 90000,
        debtAuthorized: true,
      })
    );

    expect(result.nominalTotalCents).toBe(408000);
    expect(result.realSplitsTotalCents).toBe(250000);
    expect(result.creditAppliedCents).toBe(90000);
    expect(result.roundingCoverageCents).toBe(50);
    expect(result.newSaldoDeudorCents).toBe(67950);
    expect(result.newSaldoAFavorCents).toBe(0);
    expect(result.totals).toEqual({ sourcesTotalCents: 408000, destinationsTotalCents: 408000 });
    expect(result.allocations.every((a) => a.amountCents > 0)).toBe(true);
    expect(() => validateAccountHolderFundingAllocations(result, { realSplits })).not.toThrow();
  });
});

// ─── 31-38: entradas superiores mal formadas, debtAuthorized estricto e ids canónicos ──

describe("31. planAccountHolderBatchFunding — entradas superiores mal formadas (nunca TypeError crudo)", () => {
  test("rechaza input undefined/null", () => {
    expect(() => planAccountHolderBatchFunding(undefined as unknown as any)).toThrow(AccountHolderFundingPlanError);
    expect(() => planAccountHolderBatchFunding(null as unknown as any)).toThrow(AccountHolderFundingPlanError);
  });

  test("rechaza input primitivo o array", () => {
    for (const invalid of ["x", 42, true, []]) {
      expect(() => planAccountHolderBatchFunding(invalid as unknown as any)).toThrow(AccountHolderFundingPlanError);
    }
  });

  test("rechaza destinations undefined/no-array — delegado a Etapa 0 (FundingValidationError)", () => {
    expect(() => planAccountHolderBatchFunding(baseInput({ destinations: undefined as unknown as any }))).toThrow(
      FundingValidationError
    );
    expect(() => planAccountHolderBatchFunding(baseInput({ destinations: "d1" as unknown as any }))).toThrow(
      FundingValidationError
    );
  });

  test("rechaza realSplits undefined/no-array — dueño de este módulo (AccountHolderFundingPlanError)", () => {
    expect(() => planAccountHolderBatchFunding(baseInput({ realSplits: undefined as unknown as any }))).toThrow(
      AccountHolderFundingPlanError
    );
    expect(() => planAccountHolderBatchFunding(baseInput({ realSplits: "s1" as unknown as any }))).toThrow(
      AccountHolderFundingPlanError
    );
  });

  test("ninguno de los casos anteriores escapa como TypeError", () => {
    const attempts: Array<() => void> = [
      () => planAccountHolderBatchFunding(undefined as unknown as any),
      () => planAccountHolderBatchFunding(null as unknown as any),
      () => planAccountHolderBatchFunding(baseInput({ destinations: undefined as unknown as any })),
      () => planAccountHolderBatchFunding(baseInput({ realSplits: undefined as unknown as any })),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        throw new Error("se esperaba que lanzara");
      } catch (err) {
        expect(err).not.toBeInstanceOf(TypeError);
        expect(err instanceof AccountHolderFundingPlanError || err instanceof FundingValidationError).toBe(true);
      }
    }
  });
});

describe("32. planAccountHolderBatchFunding — elementos null/no objeto en destinations y realSplits", () => {
  test("un destino null en destinations es rechazado por Etapa 0", () => {
    expect(() => planAccountHolderBatchFunding(baseInput({ destinations: [null] as unknown as any }))).toThrow(
      FundingValidationError
    );
  });

  test("un split null en realSplits es rechazado con la posición", () => {
    let thrown: unknown;
    try {
      planAccountHolderBatchFunding(baseInput({ realSplits: [null] as unknown as any }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AccountHolderFundingPlanError);
    expect((thrown as Error).message).toContain("posición 0");
  });

  test("un split primitivo (string/número) en realSplits es rechazado", () => {
    for (const invalid of ["s1", 5, true]) {
      expect(() => planAccountHolderBatchFunding(baseInput({ realSplits: [invalid] as unknown as any }))).toThrow(
        AccountHolderFundingPlanError
      );
    }
  });
});

describe("33. debtAuthorized estrictamente booleano — nunca por coerción truthy/falsy", () => {
  test("acepta exactamente true y exactamente false (con faltante autorizado/rechazado según corresponda)", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }];
    expect(() => planAccountHolderBatchFunding(baseInput({ realSplits, debtAuthorized: true }))).not.toThrow();
    expect(() => planAccountHolderBatchFunding(baseInput({ realSplits, debtAuthorized: false }))).toThrow(
      AccountHolderFundingPlanError
    );
  });

  test('rechaza debtAuthorized ausente (undefined)', () => {
    const input: any = baseInput({});
    delete input.debtAuthorized;
    expect(() => planAccountHolderBatchFunding(input)).toThrow(AccountHolderFundingPlanError);
  });

  test('el string truthy "false" NUNCA autoriza deuda — no se acepta por coerción', () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }]; // faltante real de 30000
    let thrown: unknown;
    try {
      planAccountHolderBatchFunding(baseInput({ realSplits, debtAuthorized: "false" as unknown as any }));
    } catch (err) {
      thrown = err;
    }
    // Si "false" se autorizara por coerción truthy (bug histórico: !"false" === false),
    // esto no lanzaría y generaría newSaldoDeudorCents=30000 sin autorización real.
    expect(thrown).toBeInstanceOf(AccountHolderFundingPlanError);
    expect((thrown as Error).message).not.toContain("faltante"); // se rechaza por tipo, antes de llegar a la decisión financiera
  });

  test('otros valores truthy tampoco autorizan deuda: "true", "0", "no", 1, {}, []', () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }];
    for (const invalid of ["true", "0", "no", 1, {}, []]) {
      expect(() => planAccountHolderBatchFunding(baseInput({ realSplits, debtAuthorized: invalid as unknown as any }))).toThrow(
        AccountHolderFundingPlanError
      );
    }
  });

  test("rechaza debtAuthorized null", () => {
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 70000 }];
    expect(() =>
      planAccountHolderBatchFunding(baseInput({ realSplits, debtAuthorized: null as unknown as any }))
    ).toThrow(AccountHolderFundingPlanError);
  });

  test("el chequeo de tipo ocurre antes de cualquier decisión financiera, incluso sin faltante real", () => {
    // Sin faltante (splits cubren el 100%) — debtAuthorized nunca se usaría en la
    // rama de faltante, pero igual debe rechazarse por tipo si está malformado.
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    expect(() =>
      planAccountHolderBatchFunding(baseInput({ realSplits, debtAuthorized: "false" as unknown as any }))
    ).toThrow(AccountHolderFundingPlanError);
  });
});

describe("34. IDs canónicos de splits reales — sin espacios al inicio/final", () => {
  test("rechaza un id con espacio inicial o final en vez de recortarlo silenciosamente", () => {
    for (const paddedId of [" s1", "s1 ", " s1 "]) {
      expect(() =>
        planAccountHolderBatchFunding(baseInput({ realSplits: [{ id: paddedId, amountCents: 1000 }], debtAuthorized: true }))
      ).toThrow(AccountHolderFundingPlanError);
    }
  });

  test('"s1" y " s1 " no coexisten: el segundo se rechaza por formato, no por duplicado', () => {
    expect(() =>
      planAccountHolderBatchFunding(
        baseInput({
          realSplits: [
            { id: "s1", amountCents: 50000 },
            { id: " s1 ", amountCents: 50000 },
          ],
        })
      )
    ).toThrow(AccountHolderFundingPlanError);
  });

  test("rechaza un id que no es string (número inyectado en runtime)", () => {
    expect(() =>
      planAccountHolderBatchFunding(baseInput({ realSplits: [{ id: 1 as unknown as string, amountCents: 1000 }] }))
    ).toThrow(AccountHolderFundingPlanError);
  });

  test("acepta espacios internos que no generan ambigüedad", () => {
    expect(() =>
      planAccountHolderBatchFunding(baseInput({ realSplits: [{ id: "split uno", amountCents: 100000 }] }))
    ).not.toThrow();
  });
});

describe("35. validateAccountHolderFundingAllocations — entradas superiores mal formadas (nunca TypeError crudo)", () => {
  const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
  function validPlan(): AccountHolderFundingPlanResult {
    return planAccountHolderBatchFunding(baseInput({ realSplits }));
  }

  test("rechaza plan undefined/null", () => {
    expect(() => validateAccountHolderFundingAllocations(undefined as unknown as any, { realSplits })).toThrow(
      AccountHolderFundingPlanError
    );
    expect(() => validateAccountHolderFundingAllocations(null as unknown as any, { realSplits })).toThrow(
      AccountHolderFundingPlanError
    );
  });

  test("rechaza expected undefined/null", () => {
    const plan = validPlan();
    expect(() => validateAccountHolderFundingAllocations(plan, undefined as unknown as any)).toThrow(
      AccountHolderFundingPlanError
    );
    expect(() => validateAccountHolderFundingAllocations(plan, null as unknown as any)).toThrow(
      AccountHolderFundingPlanError
    );
  });

  test("rechaza plan.destinations no-array", () => {
    const tampered = { ...validPlan(), destinations: "d1" as unknown as any };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("rechaza plan.allocations no-array", () => {
    const tampered = { ...validPlan(), allocations: "x" as unknown as any };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("rechaza expected.realSplits undefined/no-array", () => {
    const plan = validPlan();
    expect(() => validateAccountHolderFundingAllocations(plan, { realSplits: undefined as unknown as any })).toThrow(
      AccountHolderFundingPlanError
    );
    expect(() => validateAccountHolderFundingAllocations(plan, { realSplits: "s1" as unknown as any })).toThrow(
      AccountHolderFundingPlanError
    );
  });

  test("ninguno de los casos anteriores escapa como TypeError", () => {
    const plan = validPlan();
    const attempts: Array<() => void> = [
      () => validateAccountHolderFundingAllocations(undefined as unknown as any, { realSplits }),
      () => validateAccountHolderFundingAllocations(null as unknown as any, { realSplits }),
      () => validateAccountHolderFundingAllocations(plan, undefined as unknown as any),
      () => validateAccountHolderFundingAllocations({ ...plan, destinations: "x" as unknown as any }, { realSplits }),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        throw new Error("se esperaba que lanzara");
      } catch (err) {
        expect(err).toBeInstanceOf(AccountHolderFundingPlanError);
        expect(err).not.toBeInstanceOf(TypeError);
      }
    }
  });
});

describe("36. validateAccountHolderFundingAllocations — elementos null/no objeto en arrays recibidas", () => {
  const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
  function validPlan(): AccountHolderFundingPlanResult {
    return planAccountHolderBatchFunding(baseInput({ realSplits }));
  }

  test("rechaza un destino null en plan.destinations", () => {
    const tampered = { ...validPlan(), destinations: [null] as unknown as any };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("rechaza una allocation null en plan.allocations", () => {
    const tampered = { ...validPlan(), allocations: [null] as unknown as any };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("rechaza un split null en expected.realSplits, con la posición", () => {
    const plan = validPlan();
    let thrown: unknown;
    try {
      validateAccountHolderFundingAllocations(plan, { realSplits: [null] as unknown as any });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AccountHolderFundingPlanError);
    expect((thrown as Error).message).toContain("posición 0");
  });

  test("rechaza un split primitivo en expected.realSplits", () => {
    const plan = validPlan();
    for (const invalid of ["s1", 5, true]) {
      expect(() => validateAccountHolderFundingAllocations(plan, { realSplits: [invalid] as unknown as any })).toThrow(
        AccountHolderFundingPlanError
      );
    }
  });
});

describe("37. validateAccountHolderFundingAllocations — sourceKey/destinationKey no canónicos rechazados", () => {
  const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
  const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];

  test("un sourceKey con espacios al borde no matchea el split real (colisión por trim rechazada)", () => {
    const plan = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));
    const tampered: AccountHolderFundingPlanResult = {
      ...plan,
      allocations: plan.allocations.map((a) => (a.sourceKind === "split" ? { ...a, sourceKey: ` ${a.sourceKey} ` } : a)),
    };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("un destinationKey con espacios al borde no matchea el destino real", () => {
    const plan = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));
    const tampered: AccountHolderFundingPlanResult = {
      ...plan,
      allocations: plan.allocations.map((a) =>
        a.destinationKind === "payment" ? { ...a, destinationKey: `${a.destinationKey} ` } : a
      ),
    };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("un sourceKey/destinationKey vacío es rechazado", () => {
    const plan = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));
    const tamperedSource: AccountHolderFundingPlanResult = {
      ...plan,
      allocations: [{ ...plan.allocations[0]!, sourceKey: "" }],
    };
    expect(() => validateAccountHolderFundingAllocations(tamperedSource, { realSplits })).toThrow(AccountHolderFundingPlanError);

    const tamperedDest: AccountHolderFundingPlanResult = {
      ...plan,
      allocations: [{ ...plan.allocations[0]!, destinationKey: "" }],
    };
    expect(() => validateAccountHolderFundingAllocations(tamperedDest, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test('colisión aparente por trim en expected.realSplits ("s1" vs " s1 ") se rechaza por formato', () => {
    const plan = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));
    expect(() =>
      validateAccountHolderFundingAllocations(plan, { realSplits: [{ id: " s1 ", amountCents: 100000 }] })
    ).toThrow(AccountHolderFundingPlanError);
  });
});

describe("38. IDs de destino canónicos en plan.destinations (defensa contra un plan adulterado)", () => {
  test("rechaza un id de destino con espacios al borde inyectado directamente en el plan", () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));
    const tampered: AccountHolderFundingPlanResult = {
      ...plan,
      destinations: plan.destinations.map((d) => ({ ...d, id: ` ${d.id} ` })),
    };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });

  test("rechaza un id de destino duplicado inyectado directamente en el plan", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 50000 },
      { id: "d2", kind: "payment", nominalCents: 50000 },
    ];
    const realSplits: FundingPlanSplitInput[] = [{ id: "s1", amountCents: 100000 }];
    const plan = planAccountHolderBatchFunding(baseInput({ destinations, realSplits }));
    const tampered: AccountHolderFundingPlanResult = {
      ...plan,
      destinations: [plan.destinations[0]!, { ...plan.destinations[1]!, id: plan.destinations[0]!.id }],
    };
    expect(() => validateAccountHolderFundingAllocations(tampered, { realSplits })).toThrow(AccountHolderFundingPlanError);
  });
});
