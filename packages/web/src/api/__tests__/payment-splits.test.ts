/**
 * Tests del helper puro de validación/normalización de payment_splits
 * (Etapa 3A) y de clasificación de grupos de medios (Etapa 3B).
 * Sin DB, sin HTTP — src/lib/payments/splits.ts.
 */

import { test, expect, describe } from "bun:test";
import {
  validateAndNormalizeSplits, SplitValidationError,
  isOwnPaymentMethod, isDirectCompanyPaymentMethod, classifySplitGroup,
} from "../../lib/payments/splits";

describe("Caso A — un solo medio", () => {
  test("un split que cubre el total exacto es válido", () => {
    const result = validateAndNormalizeSplits({
      paymentAmount: 1000,
      splits: [{ method: "efectivo", amount: 1000 }],
    });
    expect(result.totalCents).toBe(100000);
    expect(result.splits).toEqual([{ method: "efectivo", amountCents: 100000, notes: null }]);
  });

  test("conserva notes si viene, null si no", () => {
    const result = validateAndNormalizeSplits({
      paymentAmount: 500,
      splits: [{ method: "cheque", amount: 500, notes: "cheque nro 123" }],
    });
    expect(result.splits[0]!.notes).toBe("cheque nro 123");
  });
});

describe("Caso B — varios medios", () => {
  test("suma exacta entre 3 medios", () => {
    const result = validateAndNormalizeSplits({
      paymentAmount: 100000,
      splits: [
        { method: "efectivo", amount: 40000 },
        { method: "transferencia", amount: 35000 },
        { method: "cheque", amount: 25000 },
      ],
    });
    expect(result.totalCents).toBe(10000000);
    expect(result.splits.map(s => s.amountCents)).toEqual([4000000, 3500000, 2500000]);
  });
});

describe("Caso C — suma exacta en centavos (no floats)", () => {
  test("centavos que no cierran por error de punto flotante se detectan igual", () => {
    // 0.1 + 0.2 !== 0.3 en floats — la validación debe operar en centavos enteros.
    expect(() => validateAndNormalizeSplits({
      paymentAmount: 0.3,
      splits: [{ method: "efectivo", amount: 0.1 }, { method: "transferencia", amount: 0.2 }],
    })).not.toThrow();
  });
});

describe("Caso D — más de dos decimales", () => {
  test("rechaza un importe con más de dos decimales reales", () => {
    expect(() => validateAndNormalizeSplits({
      paymentAmount: 100.567,
      splits: [{ method: "efectivo", amount: 100.567 }],
    })).toThrow(SplitValidationError);
  });
});

describe("Caso E — importe incompleto", () => {
  test("splits que suman menos que el total se rechazan", () => {
    expect(() => validateAndNormalizeSplits({
      paymentAmount: 1000,
      splits: [{ method: "efectivo", amount: 400 }],
    })).toThrow(SplitValidationError);
  });
});

describe("Caso F — importe superior", () => {
  test("splits que suman más que el total se rechazan", () => {
    expect(() => validateAndNormalizeSplits({
      paymentAmount: 1000,
      splits: [{ method: "efectivo", amount: 1500 }],
    })).toThrow(SplitValidationError);
  });
});

describe("Caso G — método inválido", () => {
  test("rechaza un método fuera de la lista permitida", () => {
    expect(() => validateAndNormalizeSplits({
      paymentAmount: 1000,
      splits: [{ method: "bitcoin", amount: 1000 }],
    })).toThrow(SplitValidationError);
  });

  test("rechaza 'combinado' como método de un split individual", () => {
    expect(() => validateAndNormalizeSplits({
      paymentAmount: 1000,
      splits: [{ method: "combinado", amount: 1000 }],
    })).toThrow(SplitValidationError);
  });

  test("rechaza método vacío", () => {
    expect(() => validateAndNormalizeSplits({
      paymentAmount: 1000,
      splits: [{ method: "", amount: 1000 }],
    })).toThrow(SplitValidationError);
  });
});

describe("Caso H — cero, negativo, NaN, Infinity", () => {
  test("rechaza paymentAmount cero", () => {
    expect(() => validateAndNormalizeSplits({ paymentAmount: 0, splits: [{ method: "efectivo", amount: 0 }] }))
      .toThrow(SplitValidationError);
  });
  test("rechaza paymentAmount negativo", () => {
    expect(() => validateAndNormalizeSplits({ paymentAmount: -100, splits: [{ method: "efectivo", amount: -100 }] }))
      .toThrow(SplitValidationError);
  });
  test("rechaza paymentAmount NaN", () => {
    expect(() => validateAndNormalizeSplits({ paymentAmount: NaN, splits: [{ method: "efectivo", amount: 100 }] }))
      .toThrow(SplitValidationError);
  });
  test("rechaza paymentAmount Infinity", () => {
    expect(() => validateAndNormalizeSplits({ paymentAmount: Infinity, splits: [{ method: "efectivo", amount: 100 }] }))
      .toThrow(SplitValidationError);
  });
  test("rechaza un split con amount cero", () => {
    expect(() => validateAndNormalizeSplits({ paymentAmount: 1000, splits: [{ method: "efectivo", amount: 0 }, { method: "transferencia", amount: 1000 }] }))
      .toThrow(SplitValidationError);
  });
  test("rechaza un split con amount negativo", () => {
    expect(() => validateAndNormalizeSplits({ paymentAmount: 1000, splits: [{ method: "efectivo", amount: -50 }] }))
      .toThrow(SplitValidationError);
  });
  test("rechaza un split con amount NaN", () => {
    expect(() => validateAndNormalizeSplits({ paymentAmount: 1000, splits: [{ method: "efectivo", amount: NaN }] }))
      .toThrow(SplitValidationError);
  });
  test("rechaza un split con amount Infinity", () => {
    expect(() => validateAndNormalizeSplits({ paymentAmount: 1000, splits: [{ method: "efectivo", amount: Infinity }] }))
      .toThrow(SplitValidationError);
  });
});

describe("Caso I — al menos un split", () => {
  test("rechaza un array vacío de splits", () => {
    expect(() => validateAndNormalizeSplits({ paymentAmount: 1000, splits: [] }))
      .toThrow(SplitValidationError);
  });
});

describe("Caso J — no muta la entrada", () => {
  test("el array y los objetos originales quedan intactos", () => {
    const input = { paymentAmount: 1000, splits: [{ method: "efectivo", amount: 1000, notes: "orig" }] };
    const inputCopy = JSON.parse(JSON.stringify(input));
    validateAndNormalizeSplits(input);
    expect(input).toEqual(inputCopy);
  });
});

describe("Caso K — strings numéricos", () => {
  test("paymentAmount y amount como string numérico se coercionan correctamente", () => {
    const result = validateAndNormalizeSplits({
      paymentAmount: "1000" as any,
      splits: [{ method: "efectivo", amount: "1000" as any }],
    });
    expect(result.totalCents).toBe(100000);
  });

  test("un string no numérico sigue rechazándose", () => {
    expect(() => validateAndNormalizeSplits({
      paymentAmount: "no-es-un-numero" as any,
      splits: [{ method: "efectivo", amount: 1000 }],
    })).toThrow(SplitValidationError);
  });
});

describe("Caso L — amount = -0", () => {
  test("-0 se rechaza igual que cualquier importe <= 0", () => {
    expect(() => validateAndNormalizeSplits({
      paymentAmount: 1000,
      splits: [{ method: "efectivo", amount: -0 }],
    })).toThrow(SplitValidationError);
  });
});

describe("Caso M — notas vacías", () => {
  test("notes vacío o solo espacios se normaliza a null", () => {
    const result = validateAndNormalizeSplits({
      paymentAmount: 1000,
      splits: [{ method: "efectivo", amount: 1000, notes: "   " }],
    });
    expect(result.splits[0]!.notes).toBeNull();
  });

  test("notes ausente también es null", () => {
    const result = validateAndNormalizeSplits({ paymentAmount: 1000, splits: [{ method: "efectivo", amount: 1000 }] });
    expect(result.splits[0]!.notes).toBeNull();
  });
});

describe("Caso N — métodos repetidos dentro de un mismo desglose", () => {
  test("dos splits del mismo método se aceptan (ej. dos transferencias a cuentas distintas en 3B)", () => {
    const result = validateAndNormalizeSplits({
      paymentAmount: 1000,
      splits: [{ method: "transferencia", amount: 400 }, { method: "transferencia", amount: 600 }],
    });
    expect(result.splits.map(s => s.method)).toEqual(["transferencia", "transferencia"]);
    expect(result.totalCents).toBe(100000);
  });
});

// ─── Etapa 3B — isOwnPaymentMethod / isDirectCompanyPaymentMethod ────────────

describe("Caso O — clasificación individual de métodos", () => {
  test("efectivo, transferencia y cheque son propios", () => {
    expect(isOwnPaymentMethod("efectivo")).toBe(true);
    expect(isOwnPaymentMethod("transferencia")).toBe(true);
    expect(isOwnPaymentMethod("cheque")).toBe(true);
  });

  test("transferencia_compania y link_pago son directos a compañía", () => {
    expect(isDirectCompanyPaymentMethod("transferencia_compania")).toBe(true);
    expect(isDirectCompanyPaymentMethod("link_pago")).toBe(true);
  });

  test("un método propio no es directo a compañía y viceversa", () => {
    expect(isDirectCompanyPaymentMethod("efectivo")).toBe(false);
    expect(isOwnPaymentMethod("link_pago")).toBe(false);
  });

  test("un método fuera de ambas listas (ej. 'combinado') no es ninguno de los dos", () => {
    expect(isOwnPaymentMethod("combinado")).toBe(false);
    expect(isDirectCompanyPaymentMethod("combinado")).toBe(false);
  });
});

// ─── Etapa 3B — classifySplitGroup ────────────────────────────────────────────

describe("Caso P — classifySplitGroup", () => {
  test("un solo split propio → 'own'", () => {
    expect(classifySplitGroup([{ method: "efectivo" }])).toBe("own");
  });

  test("varios splits propios → 'own'", () => {
    expect(classifySplitGroup([{ method: "efectivo" }, { method: "transferencia" }, { method: "cheque" }])).toBe("own");
  });

  test("un solo split directo a compañía → 'direct_company'", () => {
    expect(classifySplitGroup([{ method: "transferencia_compania" }])).toBe("direct_company");
  });

  test("varios splits directos a compañía → 'direct_company'", () => {
    expect(classifySplitGroup([{ method: "transferencia_compania" }, { method: "link_pago" }])).toBe("direct_company");
  });

  test("mezcla de propio y directo a compañía → 'mixed'", () => {
    expect(classifySplitGroup([{ method: "efectivo" }, { method: "transferencia_compania" }])).toBe("mixed");
  });

  test("métodos repetidos del mismo grupo no rompen la clasificación", () => {
    expect(classifySplitGroup([{ method: "transferencia" }, { method: "transferencia" }])).toBe("own");
  });

  test("no muta el array ni los objetos de entrada", () => {
    const input = [{ method: "efectivo" }, { method: "transferencia_compania" }];
    const inputCopy = JSON.parse(JSON.stringify(input));
    classifySplitGroup(input);
    expect(input).toEqual(inputCopy);
  });
});
