/**
 * Tests de los helpers puros de distribución de fondos con titular de cuenta
 * — src/lib/payments/account-holder-funding.ts. Sin DB, sin HTTP.
 *
 * Todos los escenarios son SINTÉTICOS: nombres de destino genéricos
 * ("destino-N", "recargo-N"), sin asegurados, IDs, pólizas ni notas reales.
 * El escenario combinado reproduce la MISMA aritmética que sostuvo el diseño
 * (211.993 = 171.200 + 40.790 + 3) porque es solo un ejemplo numérico, no un
 * dato identificatorio.
 */

import { test, expect, describe } from "bun:test";
import {
  distributeAccountHolderFunding,
  validateFundingDistribution,
  roundingAdjustmentAmountCentsForShortfall,
  roundingCoverageCentsFromStoredAdjustment,
  FundingValidationError,
  type FundingDestinationInput,
  type FundingDistributionResult,
} from "../../lib/payments/account-holder-funding";

describe("distributeAccountHolderFunding — escenario combinado (211.993 = 171.200 + 40.790 + 3)", () => {
  const destinations: FundingDestinationInput[] = [
    { id: "destino-1", kind: "payment", nominalCents: 13635000 },
    { id: "destino-2", kind: "payment", nominalCents: 2170700 },
    { id: "destino-3", kind: "payment", nominalCents: 5233600 },
    { id: "recargo-1", kind: "pronto_pago", nominalCents: 80000 },
    { id: "recargo-2", kind: "pronto_pago", nominalCents: 80000 },
  ];

  test("reparte crédito y redondeo con cierre centavo-exacto por destino", () => {
    const result = distributeAccountHolderFunding({
      destinations,
      creditAppliedCents: 4079000,
      roundingCoverageCents: 300,
    });

    const byId = Object.fromEntries(result.destinations.map((d) => [d.id, d]));

    expect(byId["destino-1"]).toEqual({ id: "destino-1", kind: "payment", nominalCents: 13635000, creditCents: 2643489, roundingCents: 194, cashCents: 10991317 });
    expect(byId["destino-2"]).toEqual({ id: "destino-2", kind: "payment", nominalCents: 2170700, creditCents: 420845, roundingCents: 31, cashCents: 1749824 });
    expect(byId["destino-3"]).toEqual({ id: "destino-3", kind: "payment", nominalCents: 5233600, creditCents: 1014666, roundingCents: 75, cashCents: 4218859 });
    expect(byId["recargo-1"]).toEqual({ id: "recargo-1", kind: "pronto_pago", nominalCents: 80000, creditCents: 0, roundingCents: 0, cashCents: 80000 });
    expect(byId["recargo-2"]).toEqual({ id: "recargo-2", kind: "pronto_pago", nominalCents: 80000, creditCents: 0, roundingCents: 0, cashCents: 80000 });

    expect(result.creditConsumedCents).toBe(4079000);
    expect(result.roundingConsumedCents).toBe(300);
    expect(result.cashAggregateCents).toBe(17120000);
    expect(result.unconsumedCreditCents).toBe(0);
    expect(result.unconsumedRoundingCents).toBe(0);

    // Total global: cash + crédito + redondeo = suma de nominales de los 5 destinos.
    const totalNominal = destinations.reduce((s, d) => s + d.nominalCents, 0);
    expect(result.cashAggregateCents + 4079000 + 300).toBe(totalNominal);
    expect(totalNominal).toBe(21199300);

    expect(() => validateFundingDistribution(result, { creditAppliedCents: 4079000, roundingCoverageCents: 300 })).not.toThrow();
  });
});

describe("distributeAccountHolderFunding — crédito menor que las primas (sin overflow)", () => {
  test("todo el crédito queda dentro del tier de destinos payment", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 500000 },
      { id: "d2", kind: "payment", nominalCents: 300000 },
      { id: "recargo", kind: "pronto_pago", nominalCents: 20000 },
    ];
    const result = distributeAccountHolderFunding({ destinations, creditAppliedCents: 100000, roundingCoverageCents: 0 });

    const recargo = result.destinations.find((d) => d.id === "recargo")!;
    expect(recargo.creditCents).toBe(0);
    expect(recargo.cashCents).toBe(20000);

    const sumCredit = result.destinations.reduce((s, d) => s + d.creditCents, 0);
    expect(sumCredit).toBe(100000);
    expect(result.unconsumedCreditCents).toBe(0);
  });
});

describe("distributeAccountHolderFunding — crédito superior a las primas, overflow a pronto_pago", () => {
  test("el excedente de crédito, agotado el tier payment, se aplica a pronto_pago", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "prima", kind: "payment", nominalCents: 100000 },
      { id: "recargo", kind: "pronto_pago", nominalCents: 50000 },
    ];
    const result = distributeAccountHolderFunding({ destinations, creditAppliedCents: 120000, roundingCoverageCents: 0 });

    const prima = result.destinations.find((d) => d.id === "prima")!;
    const recargo = result.destinations.find((d) => d.id === "recargo")!;

    expect(prima).toEqual({ id: "prima", kind: "payment", nominalCents: 100000, creditCents: 100000, roundingCents: 0, cashCents: 0 });
    expect(recargo).toEqual({ id: "recargo", kind: "pronto_pago", nominalCents: 50000, creditCents: 20000, roundingCents: 0, cashCents: 30000 });
    expect(result.creditConsumedCents).toBe(120000);
    expect(result.unconsumedCreditCents).toBe(0);
  });
});

describe("distributeAccountHolderFunding — sin destinos pronto_pago en el lote", () => {
  test("un lote 100% primas reparte crédito y redondeo solo entre ellas", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 60000 },
      { id: "d2", kind: "payment", nominalCents: 40000 },
    ];
    const result = distributeAccountHolderFunding({ destinations, creditAppliedCents: 30000, roundingCoverageCents: 100 });

    expect(result.destinations.every((d) => d.kind === "payment")).toBe(true);
    const sum = result.destinations.reduce((s, d) => s + d.creditCents + d.roundingCents + d.cashCents, 0);
    expect(sum).toBe(100000);
    expect(() => validateFundingDistribution(result, { creditAppliedCents: 30000, roundingCoverageCents: 100 })).not.toThrow();
  });
});

describe("distributeAccountHolderFunding — centavos no divisibles", () => {
  test("el reparto Hamilton cierra exacto aunque los pesos no dividan parejo", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 10000 },
      { id: "d2", kind: "payment", nominalCents: 10000 },
      { id: "d3", kind: "payment", nominalCents: 10001 },
    ];
    const result = distributeAccountHolderFunding({ destinations, creditAppliedCents: 10000, roundingCoverageCents: 7 });

    // No se fija un reparto exacto por índice (depende del desempate de
    // Hamilton) — se valida la propiedad que SÍ debe cumplirse siempre: cada
    // destino cierra exacto y las sumas por fuente coinciden con lo pedido.
    expect(() => validateFundingDistribution(result, { creditAppliedCents: 10000, roundingCoverageCents: 7 })).not.toThrow();
    for (const d of result.destinations) {
      expect(d.cashCents + d.creditCents + d.roundingCents).toBe(d.nominalCents);
      expect(d.creditCents).toBeGreaterThanOrEqual(0);
      expect(d.roundingCents).toBeGreaterThanOrEqual(0);
      expect(d.cashCents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("distributeAccountHolderFunding — crédito y redondeo en cero", () => {
  test("sin crédito ni redondeo, todo el nominal queda como cash agregado", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 50000 },
      { id: "recargo", kind: "pronto_pago", nominalCents: 5000 },
    ];
    const result = distributeAccountHolderFunding({ destinations, creditAppliedCents: 0, roundingCoverageCents: 0 });

    for (const d of result.destinations) {
      expect(d.creditCents).toBe(0);
      expect(d.roundingCents).toBe(0);
      expect(d.cashCents).toBe(d.nominalCents);
    }
    expect(result.cashAggregateCents).toBe(55000);
  });
});

describe("distributeAccountHolderFunding — crédito/redondeo ofrecido en exceso, sin destino que lo absorba", () => {
  test("crédito solicitado mayor a la necesidad total de los destinos queda sin consumir, y la validación lo rechaza", () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 10000 }];
    const result = distributeAccountHolderFunding({ destinations, creditAppliedCents: 15000, roundingCoverageCents: 0 });

    expect(result.unconsumedCreditCents).toBe(5000);
    expect(() => validateFundingDistribution(result, { creditAppliedCents: 15000, roundingCoverageCents: 0 })).toThrow(FundingValidationError);
  });

  test("mismo caso, sin destinos pronto_pago que absorban el excedente", () => {
    const destinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: 10000 },
      { id: "d2", kind: "payment", nominalCents: 5000 },
    ];
    const result = distributeAccountHolderFunding({ destinations, creditAppliedCents: 20000, roundingCoverageCents: 0 });
    expect(result.unconsumedCreditCents).toBe(5000);
  });
});

describe("signo del ajuste de redondeo almacenado", () => {
  test("roundingAdjustmentAmountCentsForShortfall convierte positivo (dominio) a negativo (BD)", () => {
    expect(roundingAdjustmentAmountCentsForShortfall(300)).toBe(-300);
    expect(roundingAdjustmentAmountCentsForShortfall(1)).toBe(-1);
  });

  test("roundingCoverageCentsFromStoredAdjustment reconstruye el positivo desde el valor guardado", () => {
    expect(roundingCoverageCentsFromStoredAdjustment(-300)).toBe(300);
    expect(roundingCoverageCentsFromStoredAdjustment(-1)).toBe(1);
  });

  test("son inversas exactas — ida y vuelta sin pérdida", () => {
    for (const coverage of [1, 3, 300, 500]) {
      expect(roundingCoverageCentsFromStoredAdjustment(roundingAdjustmentAmountCentsForShortfall(coverage))).toBe(coverage);
    }
  });

  test("rechaza valores fuera de dominio en ambos sentidos", () => {
    expect(() => roundingAdjustmentAmountCentsForShortfall(0)).toThrow(FundingValidationError);
    expect(() => roundingAdjustmentAmountCentsForShortfall(-5)).toThrow(FundingValidationError);
    expect(() => roundingCoverageCentsFromStoredAdjustment(0)).toThrow(FundingValidationError);
    expect(() => roundingCoverageCentsFromStoredAdjustment(5)).toThrow(FundingValidationError);
  });
});

describe("validateFundingDistribution — sumas exactas por fuente y destino", () => {
  test("acepta un resultado bien formado", () => {
    const destinations: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 1000 }];
    const result = distributeAccountHolderFunding({ destinations, creditAppliedCents: 400, roundingCoverageCents: 0 });
    expect(() => validateFundingDistribution(result, { creditAppliedCents: 400, roundingCoverageCents: 0 })).not.toThrow();
  });

  test("rechaza un destino que no cierra (cash+crédito+redondeo != nominal)", () => {
    const corrupted: FundingDistributionResult = {
      destinations: [{ id: "d1", kind: "payment", nominalCents: 1000, creditCents: 400, roundingCents: 0, cashCents: 500 }], // 900 != 1000
      creditConsumedCents: 400,
      roundingConsumedCents: 0,
      cashAggregateCents: 500,
      unconsumedCreditCents: 0,
      unconsumedRoundingCents: 0,
    };
    expect(() => validateFundingDistribution(corrupted, { creditAppliedCents: 400, roundingCoverageCents: 0 })).toThrow(FundingValidationError);
  });

  test("rechaza si la suma de crédito por destino no coincide con lo solicitado", () => {
    const corrupted: FundingDistributionResult = {
      destinations: [{ id: "d1", kind: "payment", nominalCents: 1000, creditCents: 300, roundingCents: 0, cashCents: 700 }],
      creditConsumedCents: 400, // divergente de la suma real por destino (300)
      roundingConsumedCents: 0,
      cashAggregateCents: 700,
      unconsumedCreditCents: 0,
      unconsumedRoundingCents: 0,
    };
    expect(() => validateFundingDistribution(corrupted, { creditAppliedCents: 400, roundingCoverageCents: 0 })).toThrow(FundingValidationError);
  });

  test("rechaza una distribución adulterada con cashCents negativo en un destino", () => {
    const corrupted: FundingDistributionResult = {
      destinations: [{ id: "d1", kind: "payment", nominalCents: 1000, creditCents: 1100, roundingCents: 0, cashCents: -100 }],
      creditConsumedCents: 1100,
      roundingConsumedCents: 0,
      cashAggregateCents: -100,
      unconsumedCreditCents: 0,
      unconsumedRoundingCents: 0,
    };
    expect(() => validateFundingDistribution(corrupted, { creditAppliedCents: 1100, roundingCoverageCents: 0 })).toThrow(FundingValidationError);
  });

  test("rechaza una distribución adulterada con un componente no entero (decimal)", () => {
    const corrupted: FundingDistributionResult = {
      destinations: [{ id: "d1", kind: "payment", nominalCents: 1000, creditCents: 400.5, roundingCents: 0, cashCents: 599.5 }],
      creditConsumedCents: 400.5,
      roundingConsumedCents: 0,
      cashAggregateCents: 599.5,
      unconsumedCreditCents: 0,
      unconsumedRoundingCents: 0,
    };
    expect(() => validateFundingDistribution(corrupted, { creditAppliedCents: 400.5, roundingCoverageCents: 0 })).toThrow(FundingValidationError);
  });

  test("rechaza un resultado con ids de destino duplicados", () => {
    const corrupted: FundingDistributionResult = {
      destinations: [
        { id: "dup", kind: "payment", nominalCents: 500, creditCents: 0, roundingCents: 0, cashCents: 500 },
        { id: "dup", kind: "pronto_pago", nominalCents: 300, creditCents: 0, roundingCents: 0, cashCents: 300 },
      ],
      creditConsumedCents: 0,
      roundingConsumedCents: 0,
      cashAggregateCents: 800,
      unconsumedCreditCents: 0,
      unconsumedRoundingCents: 0,
    };
    expect(() => validateFundingDistribution(corrupted, { creditAppliedCents: 0, roundingCoverageCents: 0 })).toThrow(FundingValidationError);
  });
});

describe("distributeAccountHolderFunding — validación estricta de importes (Number.isSafeInteger)", () => {
  const oneDestination: FundingDestinationInput[] = [{ id: "d1", kind: "payment", nominalCents: 100000 }];

  test("rechaza creditAppliedCents decimal", () => {
    expect(() =>
      distributeAccountHolderFunding({ destinations: oneDestination, creditAppliedCents: 100.5, roundingCoverageCents: 0 })
    ).toThrow(FundingValidationError);
  });

  test("rechaza roundingCoverageCents decimal", () => {
    expect(() =>
      distributeAccountHolderFunding({ destinations: oneDestination, creditAppliedCents: 0, roundingCoverageCents: 1.5 })
    ).toThrow(FundingValidationError);
  });

  test("rechaza NaN e Infinity en creditAppliedCents", () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(() =>
        distributeAccountHolderFunding({ destinations: oneDestination, creditAppliedCents: invalid, roundingCoverageCents: 0 })
      ).toThrow(FundingValidationError);
    }
  });

  test("rechaza NaN e Infinity en roundingCoverageCents", () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(() =>
        distributeAccountHolderFunding({ destinations: oneDestination, creditAppliedCents: 0, roundingCoverageCents: invalid })
      ).toThrow(FundingValidationError);
    }
  });

  test("rechaza creditAppliedCents mayor a Number.MAX_SAFE_INTEGER", () => {
    expect(() =>
      distributeAccountHolderFunding({
        destinations: oneDestination,
        creditAppliedCents: Number.MAX_SAFE_INTEGER + 1,
        roundingCoverageCents: 0,
      })
    ).toThrow(FundingValidationError);
  });

  test("rechaza nominalCents mayor a Number.MAX_SAFE_INTEGER", () => {
    expect(() =>
      distributeAccountHolderFunding({
        destinations: [{ id: "d1", kind: "payment", nominalCents: Number.MAX_SAFE_INTEGER + 1 }],
        creditAppliedCents: 0,
        roundingCoverageCents: 0,
      })
    ).toThrow(FundingValidationError);
  });

  test("rechaza creditAppliedCents/roundingCoverageCents negativos", () => {
    expect(() =>
      distributeAccountHolderFunding({ destinations: oneDestination, creditAppliedCents: -1, roundingCoverageCents: 0 })
    ).toThrow(FundingValidationError);
    expect(() =>
      distributeAccountHolderFunding({ destinations: oneDestination, creditAppliedCents: 0, roundingCoverageCents: -1 })
    ).toThrow(FundingValidationError);
  });

  test("rechaza una suma agregada de nominales que deje de ser un entero seguro (desborde)", () => {
    const hugeDestinations: FundingDestinationInput[] = [
      { id: "d1", kind: "payment", nominalCents: Number.MAX_SAFE_INTEGER },
      { id: "d2", kind: "payment", nominalCents: Number.MAX_SAFE_INTEGER },
    ];
    expect(() =>
      distributeAccountHolderFunding({ destinations: hugeDestinations, creditAppliedCents: 0, roundingCoverageCents: 0 })
    ).toThrow(FundingValidationError);
  });
});

describe("distributeAccountHolderFunding — validación estricta de destinations", () => {
  test("rechaza destinations vacío, incluso con crédito y redondeo en cero", () => {
    expect(() => distributeAccountHolderFunding({ destinations: [], creditAppliedCents: 0, roundingCoverageCents: 0 })).toThrow(
      FundingValidationError
    );
  });

  test("rechaza un id de destino duplicado antes de construir el reparto", () => {
    const duplicated: FundingDestinationInput[] = [
      { id: "dup", kind: "payment", nominalCents: 1000 },
      { id: "dup", kind: "pronto_pago", nominalCents: 500 },
    ];
    expect(() =>
      distributeAccountHolderFunding({ destinations: duplicated, creditAppliedCents: 0, roundingCoverageCents: 0 })
    ).toThrow(FundingValidationError);
  });

  test("rechaza un id de destino vacío", () => {
    const blankId: FundingDestinationInput[] = [{ id: "", kind: "payment", nominalCents: 1000 }];
    expect(() => distributeAccountHolderFunding({ destinations: blankId, creditAppliedCents: 0, roundingCoverageCents: 0 })).toThrow(
      FundingValidationError
    );
  });

  test("rechaza un id de destino compuesto solo de espacios", () => {
    const blankId: FundingDestinationInput[] = [{ id: "   ", kind: "payment", nominalCents: 1000 }];
    expect(() => distributeAccountHolderFunding({ destinations: blankId, creditAppliedCents: 0, roundingCoverageCents: 0 })).toThrow(
      FundingValidationError
    );
  });

  test("rechaza un kind inválido inyectado en runtime (fuera del union type)", () => {
    const invalidKind = [{ id: "d1", kind: "refund", nominalCents: 1000 }] as unknown as FundingDestinationInput[];
    expect(() =>
      distributeAccountHolderFunding({ destinations: invalidKind, creditAppliedCents: 0, roundingCoverageCents: 0 })
    ).toThrow(FundingValidationError);
  });
});

describe("distributeAccountHolderFunding — entradas superiores mal formadas (nunca TypeError crudo)", () => {
  test("rechaza input undefined", () => {
    expect(() => distributeAccountHolderFunding(undefined as unknown as any)).toThrow(FundingValidationError);
  });

  test("rechaza input null", () => {
    expect(() => distributeAccountHolderFunding(null as unknown as any)).toThrow(FundingValidationError);
  });

  test("rechaza input primitivo (string, número, boolean)", () => {
    for (const invalid of ["x", 42, true]) {
      expect(() => distributeAccountHolderFunding(invalid as unknown as any)).toThrow(FundingValidationError);
    }
  });

  test("rechaza input array (no es un objeto plano)", () => {
    expect(() => distributeAccountHolderFunding([] as unknown as any)).toThrow(FundingValidationError);
  });

  test("rechaza destinations undefined", () => {
    expect(() =>
      distributeAccountHolderFunding({ destinations: undefined, creditAppliedCents: 0, roundingCoverageCents: 0 } as unknown as any)
    ).toThrow(FundingValidationError);
  });

  test("rechaza destinations no-array (objeto, string, número)", () => {
    for (const invalid of [{}, "d1", 5]) {
      expect(() =>
        distributeAccountHolderFunding({ destinations: invalid, creditAppliedCents: 0, roundingCoverageCents: 0 } as unknown as any)
      ).toThrow(FundingValidationError);
    }
  });

  test("ninguno de los casos anteriores escapa como TypeError", () => {
    const invalidInputs: unknown[] = [undefined, null, "x", 42, [], { destinations: undefined }, { destinations: "x" }];
    for (const invalid of invalidInputs) {
      try {
        distributeAccountHolderFunding(invalid as unknown as any);
        throw new Error("se esperaba que lanzara");
      } catch (err) {
        expect(err).toBeInstanceOf(FundingValidationError);
        expect(err).not.toBeInstanceOf(TypeError);
      }
    }
  });
});

describe("distributeAccountHolderFunding — elementos null/no objeto dentro de destinations", () => {
  test("rechaza un destino null en la posición 0", () => {
    expect(() =>
      distributeAccountHolderFunding({ destinations: [null], creditAppliedCents: 0, roundingCoverageCents: 0 } as unknown as any)
    ).toThrow(FundingValidationError);
  });

  test("rechaza un destino primitivo (string/número) e informa la posición", () => {
    const valid: FundingDestinationInput = { id: "d1", kind: "payment", nominalCents: 1000 };
    for (const invalid of ["x", 5, true]) {
      let thrown: unknown;
      try {
        distributeAccountHolderFunding({
          destinations: [valid, invalid],
          creditAppliedCents: 0,
          roundingCoverageCents: 0,
        } as unknown as any);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(FundingValidationError);
      expect((thrown as Error).message).toContain("posición 1");
    }
  });

  test("rechaza un destino array", () => {
    expect(() =>
      distributeAccountHolderFunding({
        destinations: [[]],
        creditAppliedCents: 0,
        roundingCoverageCents: 0,
      } as unknown as any)
    ).toThrow(FundingValidationError);
  });
});

describe("distributeAccountHolderFunding — ids canónicos (sin espacios al inicio/final, no vacíos)", () => {
  test("rechaza un id que no es string (número inyectado en runtime)", () => {
    expect(() =>
      distributeAccountHolderFunding({
        destinations: [{ id: 123, kind: "payment", nominalCents: 1000 }],
        creditAppliedCents: 0,
        roundingCoverageCents: 0,
      } as unknown as any)
    ).toThrow(FundingValidationError);
  });

  test("rechaza un id con espacio inicial o final en vez de recortarlo silenciosamente", () => {
    for (const paddedId of [" split-1", "split-1 ", " split-1 "]) {
      expect(() =>
        distributeAccountHolderFunding({
          destinations: [{ id: paddedId, kind: "payment", nominalCents: 1000 }],
          creditAppliedCents: 0,
          roundingCoverageCents: 0,
        })
      ).toThrow(FundingValidationError);
    }
  });

  test('"split-1" y " split-1 " no coexisten: el segundo se rechaza por formato, no se compara como duplicado silencioso', () => {
    expect(() =>
      distributeAccountHolderFunding({
        destinations: [
          { id: "split-1", kind: "payment", nominalCents: 1000 },
          { id: " split-1 ", kind: "payment", nominalCents: 500 },
        ],
        creditAppliedCents: 0,
        roundingCoverageCents: 0,
      })
    ).toThrow(FundingValidationError);
  });

  test("acepta espacios internos que no generan ambigüedad", () => {
    expect(() =>
      distributeAccountHolderFunding({
        destinations: [{ id: "split uno", kind: "payment", nominalCents: 1000 }],
        creditAppliedCents: 0,
        roundingCoverageCents: 0,
      })
    ).not.toThrow();
  });
});

describe("validateFundingDistribution — entradas superiores mal formadas (nunca TypeError crudo)", () => {
  const expected = { creditAppliedCents: 0, roundingCoverageCents: 0 };

  test("rechaza result undefined/null", () => {
    expect(() => validateFundingDistribution(undefined as unknown as any, expected)).toThrow(FundingValidationError);
    expect(() => validateFundingDistribution(null as unknown as any, expected)).toThrow(FundingValidationError);
  });

  test("rechaza expected undefined/null", () => {
    const result = distributeAccountHolderFunding({
      destinations: [{ id: "d1", kind: "payment", nominalCents: 1000 }],
      creditAppliedCents: 0,
      roundingCoverageCents: 0,
    });
    expect(() => validateFundingDistribution(result, undefined as unknown as any)).toThrow(FundingValidationError);
    expect(() => validateFundingDistribution(result, null as unknown as any)).toThrow(FundingValidationError);
  });

  test("rechaza result.destinations no-array", () => {
    const corrupted = {
      destinations: "no-array",
      creditConsumedCents: 0,
      roundingConsumedCents: 0,
      cashAggregateCents: 0,
      unconsumedCreditCents: 0,
      unconsumedRoundingCents: 0,
    };
    expect(() => validateFundingDistribution(corrupted as unknown as any, expected)).toThrow(FundingValidationError);
  });

  test("rechaza un destino null dentro de result.destinations", () => {
    const corrupted = {
      destinations: [null],
      creditConsumedCents: 0,
      roundingConsumedCents: 0,
      cashAggregateCents: 0,
      unconsumedCreditCents: 0,
      unconsumedRoundingCents: 0,
    };
    expect(() => validateFundingDistribution(corrupted as unknown as any, expected)).toThrow(FundingValidationError);
  });

  test("rechaza campos numéricos agregados faltantes (undefined) en result", () => {
    const corrupted = {
      destinations: [{ id: "d1", kind: "payment", nominalCents: 1000, creditCents: 0, roundingCents: 0, cashCents: 1000 }],
      creditConsumedCents: undefined,
      roundingConsumedCents: 0,
      cashAggregateCents: 1000,
      unconsumedCreditCents: 0,
      unconsumedRoundingCents: 0,
    };
    expect(() => validateFundingDistribution(corrupted as unknown as any, expected)).toThrow(FundingValidationError);
  });

  test("ninguno de los casos anteriores escapa como TypeError", () => {
    const attempts: Array<() => void> = [
      () => validateFundingDistribution(undefined as unknown as any, expected),
      () => validateFundingDistribution(null as unknown as any, expected),
      () => validateFundingDistribution({ destinations: null } as unknown as any, expected),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        throw new Error("se esperaba que lanzara");
      } catch (err) {
        expect(err).toBeInstanceOf(FundingValidationError);
        expect(err).not.toBeInstanceOf(TypeError);
      }
    }
  });
});
