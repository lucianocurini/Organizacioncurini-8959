/**
 * Tests del helper puro de received_checks (Etapa 4B). Sin DB, sin HTTP —
 * src/lib/payments/received-checks.ts. Complementa payment-batches.test.ts
 * (que ejercita estos mismos helpers a través del endpoint real).
 */

import { test, expect, describe } from "bun:test";
import {
  normalizeReceivedCheck, validateReceivedCheckFields, validateCheckDate,
  sumReceivedChecksCents, validateChecksMatchSplit, validateCheckStatusTransition,
  findPossibleCheckDuplicates, isCheckAvailableForRemittance, isCheckActiveForDuplicateCheck,
  ReceivedCheckValidationError, type ReceivedCheckInput, type ExistingCheckForDuplicateCheck,
} from "../../lib/payments/received-checks";

function input(overrides: Partial<ReceivedCheckInput> = {}): ReceivedCheckInput {
  return {
    checkNumber: "00012345",
    bankName: "Banco Nación",
    dueDate: "2027-03-01",
    amount: 1000,
    ...overrides,
  };
}

// ─── 7/8. cheque válido / campos obligatorios ─────────────────────────────────

describe("normalizeReceivedCheck", () => {
  test("7. cheque válido con solo campos obligatorios → normaliza importe en centavos", () => {
    const result = normalizeReceivedCheck(input());
    expect(result.checkNumber).toBe("00012345");
    expect(result.bankName).toBe("Banco Nación");
    expect(result.dueDate).toBe("2027-03-01");
    expect(result.amountCents).toBe(100000);
    expect(result.currency).toBe("ARS");
    expect(result.bankCode).toBeNull();
    expect(result.drawerName).toBeNull();
  });

  test("cheque válido con todos los campos opcionales", () => {
    const result = normalizeReceivedCheck(input({
      bankCode: "011", drawerName: "Juan Pérez", drawerDocument: "20123456",
      issueDate: "2027-02-01", notes: "cheque diferido",
    }));
    expect(result.bankCode).toBe("011");
    expect(result.drawerName).toBe("Juan Pérez");
    expect(result.drawerDocument).toBe("20123456");
    expect(result.issueDate).toBe("2027-02-01");
    expect(result.notes).toBe("cheque diferido");
  });

  test("8. checkNumber vacío → rechaza", () => {
    expect(() => normalizeReceivedCheck(input({ checkNumber: "" }))).toThrow(ReceivedCheckValidationError);
    expect(() => normalizeReceivedCheck(input({ checkNumber: "   " }))).toThrow(ReceivedCheckValidationError);
  });

  test("8. bankName vacío → rechaza", () => {
    expect(() => normalizeReceivedCheck(input({ bankName: "" }))).toThrow(ReceivedCheckValidationError);
  });

  test("8. dueDate faltante → rechaza", () => {
    expect(() => normalizeReceivedCheck(input({ dueDate: "" as any }))).toThrow(ReceivedCheckValidationError);
    expect(() => normalizeReceivedCheck({ ...input(), dueDate: undefined as any })).toThrow(ReceivedCheckValidationError);
  });
});

describe("validateReceivedCheckFields", () => {
  // 9. importe cero/negativo
  test("9. importe cero → rechaza", () => {
    expect(() => validateReceivedCheckFields(input({ amount: 0 }))).toThrow(ReceivedCheckValidationError);
  });
  test("9. importe negativo → rechaza", () => {
    expect(() => validateReceivedCheckFields(input({ amount: -500 }))).toThrow(ReceivedCheckValidationError);
  });
  // 10. más de dos decimales
  test("10. importe con más de dos decimales reales → rechaza", () => {
    expect(() => validateReceivedCheckFields(input({ amount: 100.005 }))).toThrow(/dos decimales/);
  });
  test("importe con exactamente dos decimales → acepta", () => {
    expect(() => validateReceivedCheckFields(input({ amount: 100.55 }))).not.toThrow();
  });
});

// ─── 11/12. fechas ─────────────────────────────────────────────────────────────

describe("validateCheckDate", () => {
  test("11. dueDate no es una fecha calendario real → rechaza", () => {
    expect(() => validateCheckDate(null, "2027-02-30")).toThrow(ReceivedCheckValidationError);
    expect(() => validateCheckDate(null, "fecha-invalida")).toThrow(ReceivedCheckValidationError);
  });
  test("11. issueDate presente pero no es una fecha calendario real → rechaza", () => {
    expect(() => validateCheckDate("2027-13-01", "2027-03-01")).toThrow(ReceivedCheckValidationError);
  });
  test("12. dueDate anterior a issueDate → rechaza", () => {
    expect(() => validateCheckDate("2027-03-01", "2027-02-01")).toThrow(/anterior/);
  });
  test("dueDate igual a issueDate → acepta", () => {
    expect(() => validateCheckDate("2027-03-01", "2027-03-01")).not.toThrow();
  });
  test("sin issueDate → solo valida dueDate", () => {
    expect(() => validateCheckDate(null, "2027-03-01")).not.toThrow();
    expect(() => validateCheckDate(undefined, "2027-03-01")).not.toThrow();
  });
});

// ─── 13-16. suma exacta contra el split ────────────────────────────────────────

describe("sumReceivedChecksCents / validateChecksMatchSplit", () => {
  test("13. un cheque, suma exacta → válido", () => {
    const checks = [normalizeReceivedCheck(input({ amount: 1000 }))];
    expect(sumReceivedChecksCents(checks)).toBe(100000);
    expect(validateChecksMatchSplit(checks, 100000).valid).toBe(true);
  });

  test("14. varios cheques, suma exacta → válido", () => {
    const checks = [
      normalizeReceivedCheck(input({ checkNumber: "1", amount: 600 })),
      normalizeReceivedCheck(input({ checkNumber: "2", amount: 400 })),
    ];
    expect(sumReceivedChecksCents(checks)).toBe(100000);
    expect(validateChecksMatchSplit(checks, 100000).valid).toBe(true);
  });

  test("15. suma menor al importe del split → inválido, con mensaje", () => {
    const checks = [normalizeReceivedCheck(input({ amount: 900 }))];
    const result = validateChecksMatchSplit(checks, 100000);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("no coincide");
  });

  test("16. suma mayor al importe del split → inválido", () => {
    const checks = [normalizeReceivedCheck(input({ amount: 1100 }))];
    expect(validateChecksMatchSplit(checks, 100000).valid).toBe(false);
  });
});

// ─── 17/18. posibles duplicados ────────────────────────────────────────────────

describe("findPossibleCheckDuplicates", () => {
  function existing(overrides: Partial<ExistingCheckForDuplicateCheck> = {}): ExistingCheckForDuplicateCheck {
    return {
      id: 1, checkNumber: "00012345", bankName: "Banco Nación",
      amountCents: 100000, dueDate: "2027-03-01", drawerName: "Juan Pérez",
      ...overrides,
    };
  }

  test("17. mismo banco+número, todo lo demás igual → duplicado 'strong'", () => {
    const candidate = normalizeReceivedCheck(input({ drawerName: "Juan Pérez" }));
    const matches = findPossibleCheckDuplicates(candidate, [existing()]);
    expect(matches.length).toBe(1);
    expect(matches[0]!.strength).toBe("strong");
  });

  test("17. mismo banco+número pero importe distinto → duplicado 'weak'", () => {
    const candidate = normalizeReceivedCheck(input({ amount: 2000, drawerName: "Juan Pérez" }));
    const matches = findPossibleCheckDuplicates(candidate, [existing()]);
    expect(matches.length).toBe(1);
    expect(matches[0]!.strength).toBe("weak");
  });

  test("banco distinto → no es duplicado", () => {
    const candidate = normalizeReceivedCheck(input());
    const matches = findPossibleCheckDuplicates(candidate, [existing({ bankName: "Otro Banco" })]);
    expect(matches.length).toBe(0);
  });

  test("número distinto → no es duplicado", () => {
    const candidate = normalizeReceivedCheck(input());
    const matches = findPossibleCheckDuplicates(candidate, [existing({ checkNumber: "99999999" })]);
    expect(matches.length).toBe(0);
  });

  test("drawerName null en ambos lados no cuenta como coincidencia de librador (queda 'weak')", () => {
    const candidate = normalizeReceivedCheck(input());
    const matches = findPossibleCheckDuplicates(candidate, [existing({ drawerName: null })]);
    expect(matches.length).toBe(1);
    expect(matches[0]!.strength).toBe("weak");
  });

  // 18. no bloquea automáticamente — solo informa
  test("18. no lanza ninguna excepción aunque haya duplicado 'strong'", () => {
    const candidate = normalizeReceivedCheck(input({ drawerName: "Juan Pérez" }));
    expect(() => findPossibleCheckDuplicates(candidate, [existing()])).not.toThrow();
  });
});

// ─── PROBLEMA 3 (hotfix) — vigencia de un cheque existente para duplicados ────

describe("isCheckActiveForDuplicateCheck", () => {
  test("cheque en_cartera sin batch ni payment anulados → vigente", () => {
    expect(isCheckActiveForDuplicateCheck({ checkStatus: "en_cartera" })).toBe(true);
  });

  test("checkStatus='anulado' → no vigente, aunque no haya info de batch/payment", () => {
    expect(isCheckActiveForDuplicateCheck({ checkStatus: "anulado" })).toBe(false);
  });

  test("batchStatus='anulado' (aunque el cheque en sí no esté marcado) → no vigente (caso legacy)", () => {
    expect(isCheckActiveForDuplicateCheck({ checkStatus: "en_cartera", batchStatus: "anulado" })).toBe(false);
  });

  test("paymentStatus='anulado' (aunque el cheque en sí no esté marcado) → no vigente (caso legacy)", () => {
    expect(isCheckActiveForDuplicateCheck({ checkStatus: "entregado_compania", paymentStatus: "anulado" })).toBe(false);
  });

  test("batchStatus='confirmado' → vigente", () => {
    expect(isCheckActiveForDuplicateCheck({ checkStatus: "en_cartera", batchStatus: "confirmado" })).toBe(true);
  });

  test("paymentStatus='confirmado' → vigente", () => {
    expect(isCheckActiveForDuplicateCheck({ checkStatus: "en_cartera", paymentStatus: "confirmado" })).toBe(true);
  });
});

// ─── 19-21. transiciones de estado ──────────────────────────────────────────────

describe("validateCheckStatusTransition", () => {
  test("19. en_cartera -> entregado_compania: permitida", () => {
    expect(() => validateCheckStatusTransition("en_cartera", "entregado_compania")).not.toThrow();
  });
  test("19. en_cartera -> anulado: permitida", () => {
    expect(() => validateCheckStatusTransition("en_cartera", "anulado")).not.toThrow();
  });
  test("19. entregado_compania -> cobrado: permitida", () => {
    expect(() => validateCheckStatusTransition("entregado_compania", "cobrado")).not.toThrow();
  });
  test("19. entregado_compania -> rechazado: permitida", () => {
    expect(() => validateCheckStatusTransition("entregado_compania", "rechazado")).not.toThrow();
  });

  test("20. cobrado es terminal", () => {
    expect(() => validateCheckStatusTransition("cobrado", "en_cartera")).toThrow();
    expect(() => validateCheckStatusTransition("cobrado", "entregado_compania")).toThrow();
  });
  test("20. rechazado es terminal", () => {
    expect(() => validateCheckStatusTransition("rechazado", "en_cartera")).toThrow();
  });
  test("20. anulado es terminal", () => {
    expect(() => validateCheckStatusTransition("anulado", "en_cartera")).toThrow();
  });

  test("21. entregado_compania -> en_cartera sin contexto → rechaza", () => {
    expect(() => validateCheckStatusTransition("entregado_compania", "en_cartera")).toThrow();
  });
  test("21. entregado_compania -> en_cartera con reason distinto → rechaza", () => {
    expect(() => validateCheckStatusTransition("entregado_compania", "en_cartera", { reason: "otra_cosa" as any })).toThrow();
  });
  test("21. entregado_compania -> en_cartera con reason='remittance_reversal' → permitida", () => {
    expect(() => validateCheckStatusTransition("entregado_compania", "en_cartera", { reason: "remittance_reversal" })).not.toThrow();
  });

  test("en_cartera -> cobrado directo: no permitida (debe pasar por entregado_compania)", () => {
    expect(() => validateCheckStatusTransition("en_cartera", "cobrado")).toThrow();
  });
});

// ─── 22. disponibilidad para rendición ─────────────────────────────────────────

describe("isCheckAvailableForRemittance", () => {
  test("22. en_cartera → disponible", () => {
    expect(isCheckAvailableForRemittance({ status: "en_cartera" })).toBe(true);
  });
  test("22. entregado_compania/cobrado/rechazado/anulado → no disponible", () => {
    expect(isCheckAvailableForRemittance({ status: "entregado_compania" })).toBe(false);
    expect(isCheckAvailableForRemittance({ status: "cobrado" })).toBe(false);
    expect(isCheckAvailableForRemittance({ status: "rechazado" })).toBe(false);
    expect(isCheckAvailableForRemittance({ status: "anulado" })).toBe(false);
  });
});
