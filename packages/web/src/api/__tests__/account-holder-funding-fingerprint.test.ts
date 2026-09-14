// Etapa 1B-2B-iii — tests puros de canonicalizeFundingRequest. Sin DB, sin
// HTTP — datos 100% sintéticos. Ver account-holder-funding-fingerprint.ts
// para el diseño completo.

import { test, expect, describe } from "bun:test";
import {
  canonicalizeFundingRequest,
  FundingRequestFingerprintInputError,
  type FundingRequestFingerprintInput,
  type FingerprintItemInput,
  type FingerprintCheckInput,
} from "../../lib/payments/account-holder-funding-fingerprint";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function legacyInput(overrides: Partial<FundingRequestFingerprintInput> = {}): FundingRequestFingerprintInput {
  return {
    paymentDate: "2027-01-01",
    accountHolderInsuredId: null,
    items: [{ source: "installment", installmentId: 1 }],
    splits: [{ method: "efectivo", amountCents: 100000, notes: null, checks: [] }],
    notes: null,
    applyProntoPagoSurcharge: true,
    accountDifferenceResolution: null,
    creditAppliedCents: 0,
    roundingCoverageCents: 0,
    debtAuthorized: false,
    debtReason: null,
    ...overrides,
  };
}

function newFlowInput(overrides: Partial<FundingRequestFingerprintInput> = {}): FundingRequestFingerprintInput {
  return {
    paymentDate: "2027-01-01",
    accountHolderInsuredId: 10,
    items: [{ source: "installment", installmentId: 1 }],
    splits: [{ method: "efectivo", amountCents: 100000, notes: null, checks: [] }],
    notes: null,
    applyProntoPagoSurcharge: true,
    accountDifferenceResolution: null,
    creditAppliedCents: 5000,
    roundingCoverageCents: 300,
    debtAuthorized: false,
    debtReason: null,
    ...overrides,
  };
}

function check(overrides: Partial<FingerprintCheckInput> = {}): FingerprintCheckInput {
  return {
    checkNumber: "CHK-1", bankName: "Banco Test", bankCode: null,
    drawerName: null, drawerDocument: null, issueDate: null,
    dueDate: "2027-06-01", amountCents: 50000, notes: null,
    ...overrides,
  };
}

// ─── Salida string / JSON válido ────────────────────────────────────────────

describe("salida", () => {
  test("devuelve un string", () => {
    const result = canonicalizeFundingRequest(legacyInput());
    expect(typeof result).toBe("string");
  });
  test("es JSON válido", () => {
    const result = canonicalizeFundingRequest(legacyInput());
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

// ─── Snapshot exacto del formato v1 ─────────────────────────────────────────

describe("snapshot exacto v1", () => {
  test("input completo (titular + crédito + redondeo + deuda + cheques) produce la forma canónica exacta esperada", () => {
    const input: FundingRequestFingerprintInput = {
      paymentDate: "2027-03-15",
      accountHolderInsuredId: 42,
      items: [
        { source: "installment", installmentId: 7 },
        { source: "policy_manual_payment", policyId: 3, amountCents: 150000, description: "pago manual" },
        { source: "manual_payment", manualPayer: "Juan Pérez", manualPolicyNumber: null, manualCompany: "ACME", amountCents: 20000, description: null },
      ],
      splits: [
        {
          method: "cheque", amountCents: 100000, notes: "medio 1",
          checks: [
            check({ checkNumber: "B", bankName: "Banco B", amountCents: 60000 }),
            check({ checkNumber: "A", bankName: "Banco A", amountCents: 40000 }),
          ],
        },
      ],
      notes: "lote de prueba",
      applyProntoPagoSurcharge: false,
      accountDifferenceResolution: null,
      creditAppliedCents: 10000,
      roundingCoverageCents: 300,
      debtAuthorized: true,
      debtReason: "faltante autorizado por gerencia",
    };

    const result = canonicalizeFundingRequest(input);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({
      version: "account-holder-funding-request.v1",
      endpoint: "POST /payment-batches",
      paymentDate: "2027-03-15",
      accountHolderInsuredId: 42,
      items: [
        { source: "installment", installmentId: 7 },
        { source: "policy_manual_payment", policyId: 3, amountCents: 150000, description: "pago manual" },
        { source: "manual_payment", manualPayer: "Juan Pérez", manualPolicyNumber: null, manualCompany: "ACME", amountCents: 20000, description: null },
      ],
      splits: [
        {
          method: "cheque", amountCents: 100000, notes: "medio 1",
          checks: [
            // Ordenados canónicamente por bankName primero: "Banco A" < "Banco B".
            { checkNumber: "A", bankName: "Banco A", bankCode: null, drawerName: null, drawerDocument: null, issueDate: null, dueDate: "2027-06-01", amountCents: 40000, notes: null },
            { checkNumber: "B", bankName: "Banco B", bankCode: null, drawerName: null, drawerDocument: null, issueDate: null, dueDate: "2027-06-01", amountCents: 60000, notes: null },
          ],
        },
      ],
      notes: "lote de prueba",
      applyProntoPagoSurcharge: false,
      accountDifferenceResolution: null,
      creditAppliedCents: 10000,
      roundingCoverageCents: 300,
      debtAuthorized: true,
      debtReason: "faltante autorizado por gerencia",
    });
  });

  test("input legacy mínimo produce la forma canónica exacta esperada", () => {
    const result = canonicalizeFundingRequest(legacyInput({ accountDifferenceResolution: { action: "saldo_a_favor", reason: null } }));
    expect(JSON.parse(result)).toEqual({
      version: "account-holder-funding-request.v1",
      endpoint: "POST /payment-batches",
      paymentDate: "2027-01-01",
      accountHolderInsuredId: null,
      items: [{ source: "installment", installmentId: 1 }],
      splits: [{ method: "efectivo", amountCents: 100000, notes: null, checks: [] }],
      notes: null,
      applyProntoPagoSurcharge: true,
      accountDifferenceResolution: { action: "saldo_a_favor", reason: null },
      creditAppliedCents: 0,
      roundingCoverageCents: 0,
      debtAuthorized: false,
      debtReason: null,
    });
  });
});

// ─── Determinismo y no mutación ─────────────────────────────────────────────

describe("determinismo y no mutación", () => {
  test("misma entrada produce el mismo string en llamadas repetidas", () => {
    const input = newFlowInput();
    expect(canonicalizeFundingRequest(input)).toBe(canonicalizeFundingRequest(input));
  });

  test("no muta input.items ni input.splits", () => {
    const items: FingerprintItemInput[] = [{ source: "installment", installmentId: 1 }, { source: "installment", installmentId: 2 }];
    const splits = [{ method: "efectivo", amountCents: 100000, notes: null, checks: [] }];
    const input = legacyInput({ items, splits });
    const itemsSnapshot = JSON.parse(JSON.stringify(items));
    const splitsSnapshot = JSON.parse(JSON.stringify(splits));

    canonicalizeFundingRequest(input);

    expect(JSON.parse(JSON.stringify(items))).toEqual(itemsSnapshot);
    expect(JSON.parse(JSON.stringify(splits))).toEqual(splitsSnapshot);
  });

  test("no muta ni reordena el array checks original de un split", () => {
    const originalChecks = [check({ checkNumber: "Z", bankName: "Banco Z" }), check({ checkNumber: "A", bankName: "Banco A" })];
    const input = legacyInput({ splits: [{ method: "cheque", amountCents: 100000, notes: null, checks: originalChecks }] });
    const before = originalChecks.map((c) => c.checkNumber);

    canonicalizeFundingRequest(input);

    expect(originalChecks.map((c) => c.checkNumber)).toEqual(before); // sigue ["Z", "A"], sin ordenar
  });
});

// ─── Orden sensible en items/splits, insensible en checks ──────────────────

describe("orden", () => {
  test("invertir el orden de items produce un string distinto", () => {
    const a = legacyInput({ items: [{ source: "installment", installmentId: 1 }, { source: "installment", installmentId: 2 }] });
    const b = legacyInput({ items: [{ source: "installment", installmentId: 2 }, { source: "installment", installmentId: 1 }] });
    expect(canonicalizeFundingRequest(a)).not.toBe(canonicalizeFundingRequest(b));
  });

  test("invertir el orden de splits produce un string distinto", () => {
    const a = legacyInput({
      splits: [
        { method: "efectivo", amountCents: 50000, notes: null, checks: [] },
        { method: "transferencia", amountCents: 50000, notes: null, checks: [] },
      ],
    });
    const b = legacyInput({
      splits: [
        { method: "transferencia", amountCents: 50000, notes: null, checks: [] },
        { method: "efectivo", amountCents: 50000, notes: null, checks: [] },
      ],
    });
    expect(canonicalizeFundingRequest(a)).not.toBe(canonicalizeFundingRequest(b));
  });

  test("invertir el orden de checks dentro de un split produce el MISMO string", () => {
    const c1 = check({ checkNumber: "A", bankName: "Banco A", amountCents: 40000 });
    const c2 = check({ checkNumber: "B", bankName: "Banco B", amountCents: 60000 });
    const a = legacyInput({ splits: [{ method: "cheque", amountCents: 100000, notes: null, checks: [c1, c2] }] });
    const b = legacyInput({ splits: [{ method: "cheque", amountCents: 100000, notes: null, checks: [c2, c1] }] });
    expect(canonicalizeFundingRequest(a)).toBe(canonicalizeFundingRequest(b));
  });

  test("cheques duplicados idénticos se preservan (no se deduplican al ordenar)", () => {
    const c = check({ checkNumber: "DUP", bankName: "Banco Dup", amountCents: 50000 });
    const input = legacyInput({ splits: [{ method: "cheque", amountCents: 100000, notes: null, checks: [c, { ...c }] }] });
    const parsed = JSON.parse(canonicalizeFundingRequest(input));
    expect(parsed.splits[0].checks).toHaveLength(2);
    expect(parsed.splits[0].checks[0]).toEqual(parsed.splits[0].checks[1]);
  });
});

// ─── Insensibilidad al orden de propiedades del objeto de origen ──────────

describe("insensibilidad al orden de claves del objeto JS de origen", () => {
  test("un input con las mismas propiedades declaradas en distinto orden produce el mismo string", () => {
    const a = legacyInput();
    // Reconstruye el mismo contenido con las claves insertadas en otro orden real (no solo TS) — JS respeta el orden de inserción del literal.
    const b: FundingRequestFingerprintInput = {
      debtReason: null, debtAuthorized: false, roundingCoverageCents: 0, creditAppliedCents: 0,
      accountDifferenceResolution: null, applyProntoPagoSurcharge: true, notes: null,
      splits: [{ checks: [], notes: null, amountCents: 100000, method: "efectivo" }],
      items: [{ installmentId: 1, source: "installment" }],
      accountHolderInsuredId: null, paymentDate: "2027-01-01",
    };
    expect(canonicalizeFundingRequest(a)).toBe(canonicalizeFundingRequest(b));
  });

  test("un cheque con las mismas propiedades en distinto orden produce el mismo string", () => {
    const c1 = check({ checkNumber: "X", bankName: "Banco X" });
    const c2: FingerprintCheckInput = {
      notes: null, amountCents: 50000, dueDate: "2027-06-01", issueDate: null,
      drawerDocument: null, drawerName: null, bankCode: null, bankName: "Banco X", checkNumber: "X",
    };
    const a = legacyInput({ splits: [{ method: "cheque", amountCents: 100000, notes: null, checks: [c1] }] });
    const b = legacyInput({ splits: [{ method: "cheque", amountCents: 100000, notes: null, checks: [c2] }] });
    expect(canonicalizeFundingRequest(a)).toBe(canonicalizeFundingRequest(b));
  });
});

// ─── Propiedades inesperadas rechazadas en cada nivel ──────────────────────

describe("propiedades inesperadas rechazadas", () => {
  test("nivel input", () => {
    const bad = { ...legacyInput(), extra: 1 } as any;
    expect(() => canonicalizeFundingRequest(bad)).toThrow(FundingRequestFingerprintInputError);
  });
  test("nivel item (installment)", () => {
    const input = legacyInput({ items: [{ source: "installment", installmentId: 1, extra: 1 } as any] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("nivel item (policy_manual_payment)", () => {
    const input = legacyInput({ items: [{ source: "policy_manual_payment", policyId: 1, amountCents: 1000, description: null, extra: 1 } as any] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("nivel item (manual_payment)", () => {
    const input = legacyInput({
      items: [{ source: "manual_payment", manualPayer: "X", manualPolicyNumber: null, manualCompany: null, amountCents: 1000, description: null, extra: 1 } as any],
    });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("nivel split", () => {
    const input = legacyInput({ splits: [{ method: "efectivo", amountCents: 1000, notes: null, checks: [], extra: 1 } as any] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("nivel check", () => {
    const input = legacyInput({ splits: [{ method: "cheque", amountCents: 1000, notes: null, checks: [{ ...check(), amountCents: 1000, extra: 1 } as any] }] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("nivel accountDifferenceResolution", () => {
    const input = legacyInput({ accountDifferenceResolution: { action: "saldo_a_favor", reason: null, extra: 1 } as any });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });

  test("propiedad faltante en input lanza", () => {
    const { notes, ...rest } = legacyInput();
    expect(() => canonicalizeFundingRequest(rest as any)).toThrow(FundingRequestFingerprintInputError);
  });
  test("undefined explícito en vez de null lanza", () => {
    const input = { ...legacyInput(), notes: undefined } as any;
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
});

// ─── Tres variantes de items ────────────────────────────────────────────────

describe("tres variantes de items", () => {
  test("installment válido", () => {
    const input = legacyInput({ items: [{ source: "installment", installmentId: 5 }] });
    expect(() => canonicalizeFundingRequest(input)).not.toThrow();
  });
  test("installment: installmentId inválido lanza", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const input = legacyInput({ items: [{ source: "installment", installmentId: bad as number }] });
      expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
    }
  });

  test("policy_manual_payment válido", () => {
    const input = legacyInput({ items: [{ source: "policy_manual_payment", policyId: 3, amountCents: 15000, description: "pago manual" }] });
    expect(() => canonicalizeFundingRequest(input)).not.toThrow();
  });
  test("policy_manual_payment: policyId/amountCents inválidos lanzan", () => {
    const badPolicy = legacyInput({ items: [{ source: "policy_manual_payment", policyId: 0, amountCents: 15000, description: null }] });
    expect(() => canonicalizeFundingRequest(badPolicy)).toThrow(FundingRequestFingerprintInputError);
    const badAmount = legacyInput({ items: [{ source: "policy_manual_payment", policyId: 3, amountCents: 0, description: null }] });
    expect(() => canonicalizeFundingRequest(badAmount)).toThrow(FundingRequestFingerprintInputError);
  });
  test("policy_manual_payment: description con espacios sin recortar lanza", () => {
    const input = legacyInput({ items: [{ source: "policy_manual_payment", policyId: 3, amountCents: 15000, description: " x " }] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });

  test("manual_payment válido", () => {
    const input = legacyInput({
      items: [{ source: "manual_payment", manualPayer: "Juan", manualPolicyNumber: null, manualCompany: null, amountCents: 20000, description: null }],
    });
    expect(() => canonicalizeFundingRequest(input)).not.toThrow();
  });
  test("manual_payment: amountCents inválido lanza", () => {
    const input = legacyInput({
      items: [{ source: "manual_payment", manualPayer: "Juan", manualPolicyNumber: null, manualCompany: null, amountCents: -1, description: null }],
    });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });

  test("source desconocido lanza", () => {
    const input = legacyInput({ items: [{ source: "otro" } as any] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
});

// ─── Tres variantes discriminadas de accountDifferenceResolution ──────────

describe("accountDifferenceResolution — tres variantes discriminadas", () => {
  test("saldo_a_favor con reason null: válido", () => {
    const input = legacyInput({ accountDifferenceResolution: { action: "saldo_a_favor", reason: null } });
    expect(() => canonicalizeFundingRequest(input)).not.toThrow();
  });
  test("saldo_a_favor con reason string no vacío: válido", () => {
    const input = legacyInput({ accountDifferenceResolution: { action: "saldo_a_favor", reason: "motivo" } });
    expect(() => canonicalizeFundingRequest(input)).not.toThrow();
  });
  test("saldo_a_favor con reason vacío lanza", () => {
    const input = legacyInput({ accountDifferenceResolution: { action: "saldo_a_favor", reason: "" } as any });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });

  test("saldo_deudor con reason string no vacío: válido", () => {
    const input = legacyInput({ accountDifferenceResolution: { action: "saldo_deudor", reason: "faltante acordado" } });
    expect(() => canonicalizeFundingRequest(input)).not.toThrow();
  });
  test("saldo_deudor con reason null lanza", () => {
    const input = legacyInput({ accountDifferenceResolution: { action: "saldo_deudor", reason: null } as any });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("saldo_deudor con reason vacío lanza", () => {
    const input = legacyInput({ accountDifferenceResolution: { action: "saldo_deudor", reason: "" } as any });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });

  test("ajuste_redondeo con reason string no vacío (ya resuelto): válido", () => {
    const input = legacyInput({ accountDifferenceResolution: { action: "ajuste_redondeo", reason: "Ajuste por redondeo autorizado en cobro en lote" } });
    expect(() => canonicalizeFundingRequest(input)).not.toThrow();
  });
  test("ajuste_redondeo con reason null lanza", () => {
    const input = legacyInput({ accountDifferenceResolution: { action: "ajuste_redondeo", reason: null } as any });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });

  test("action desconocida lanza", () => {
    const input = legacyInput({ accountDifferenceResolution: { action: "ajuste_manual", reason: "x" } as any });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
});

// ─── Reglas completas de debtReason ─────────────────────────────────────────

describe("debtReason", () => {
  test("titular + debtAuthorized=true + debtReason con motivo: válido", () => {
    const input = newFlowInput({ debtAuthorized: true, debtReason: "faltante autorizado" });
    expect(() => canonicalizeFundingRequest(input)).not.toThrow();
  });
  test("titular + debtAuthorized=true + debtReason=null: lanza", () => {
    const input = newFlowInput({ debtAuthorized: true, debtReason: null });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("titular + debtAuthorized=false + debtReason=null: válido", () => {
    const input = newFlowInput({ debtAuthorized: false, debtReason: null });
    expect(() => canonicalizeFundingRequest(input)).not.toThrow();
  });
  test("titular + debtAuthorized=false + debtReason con motivo: lanza", () => {
    const input = newFlowInput({ debtAuthorized: false, debtReason: "motivo sobrante" });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("legacy (sin titular) + debtAuthorized=false + debtReason=null: válido", () => {
    const input = legacyInput({ debtAuthorized: false, debtReason: null });
    expect(() => canonicalizeFundingRequest(input)).not.toThrow();
  });
  test("legacy (sin titular) + debtAuthorized=true: lanza", () => {
    const input = legacyInput({ debtAuthorized: true, debtReason: "x" });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("legacy (sin titular) + debtReason con motivo (aunque debtAuthorized=false): lanza", () => {
    const input = legacyInput({ debtAuthorized: false, debtReason: "x" } as any);
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
});

// ─── Exclusión mutua legacy / nuevo ─────────────────────────────────────────

describe("exclusión mutua legacy / flujo con titular", () => {
  test("titular presente + accountDifferenceResolution presente: lanza", () => {
    const input = newFlowInput({ accountDifferenceResolution: { action: "saldo_a_favor", reason: null } });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("legacy + creditAppliedCents > 0: lanza", () => {
    const input = legacyInput({ creditAppliedCents: 100 });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("legacy + roundingCoverageCents > 0: lanza", () => {
    const input = legacyInput({ roundingCoverageCents: 100 });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("titular presente + accountDifferenceResolution=null + crédito/redondeo/deuda en 0: válido", () => {
    const input = newFlowInput({ creditAppliedCents: 0, roundingCoverageCents: 0, debtAuthorized: false, debtReason: null });
    expect(() => canonicalizeFundingRequest(input)).not.toThrow();
  });
});

// ─── Validación estricta y overflow ─────────────────────────────────────────

describe("validación runtime estricta", () => {
  test("input no objeto lanza", () => {
    expect(() => canonicalizeFundingRequest("no-object" as any)).toThrow(FundingRequestFingerprintInputError);
    expect(() => canonicalizeFundingRequest(null as any)).toThrow(FundingRequestFingerprintInputError);
    expect(() => canonicalizeFundingRequest([] as any)).toThrow(FundingRequestFingerprintInputError);
  });
  test("items/splits no-array lanzan", () => {
    expect(() => canonicalizeFundingRequest(legacyInput({ items: "x" as any }))).toThrow(FundingRequestFingerprintInputError);
    expect(() => canonicalizeFundingRequest(legacyInput({ splits: "x" as any }))).toThrow(FundingRequestFingerprintInputError);
  });
  test("paymentDate inválido (formato o fecha calendario) lanza", () => {
    for (const bad of ["2027/01/01", "2027-13-01", "2027-02-30", "", "not-a-date"]) {
      expect(() => canonicalizeFundingRequest(legacyInput({ paymentDate: bad }))).toThrow(FundingRequestFingerprintInputError);
    }
  });
  test("accountHolderInsuredId inválido (no null, no entero seguro positivo) lanza", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => canonicalizeFundingRequest(legacyInput({ accountHolderInsuredId: bad as number }))).toThrow(FundingRequestFingerprintInputError);
    }
  });
  test("split.method no permitido lanza", () => {
    const input = legacyInput({ splits: [{ method: "lote", amountCents: 1000, notes: null, checks: [] }] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("split.amountCents inválido lanza", () => {
    for (const bad of [0, -100, 1.5]) {
      const input = legacyInput({ splits: [{ method: "efectivo", amountCents: bad, notes: null, checks: [] }] });
      expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
    }
  });
  test("check.dueDate inválido lanza", () => {
    const input = legacyInput({ splits: [{ method: "cheque", amountCents: 50000, notes: null, checks: [check({ dueDate: "31/12/2027" })] }] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("check.issueDate inválido (no null) lanza", () => {
    const input = legacyInput({ splits: [{ method: "cheque", amountCents: 50000, notes: null, checks: [check({ issueDate: "bad-date" })] }] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("check.amountCents inválido lanza", () => {
    const input = legacyInput({ splits: [{ method: "cheque", amountCents: 50000, notes: null, checks: [check({ amountCents: 0 })] }] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("string con espacios al inicio/fin lanza (notes, checkNumber, bankName)", () => {
    expect(() => canonicalizeFundingRequest(legacyInput({ notes: " x " }))).toThrow(FundingRequestFingerprintInputError);
    const badCheckNumber = legacyInput({ splits: [{ method: "cheque", amountCents: 50000, notes: null, checks: [check({ checkNumber: " CHK ", bankName: "Banco Test" })] }] });
    expect(() => canonicalizeFundingRequest(badCheckNumber)).toThrow(FundingRequestFingerprintInputError);
  });
  test("string vacío en vez de null lanza (notes)", () => {
    expect(() => canonicalizeFundingRequest(legacyInput({ notes: "" }))).toThrow(FundingRequestFingerprintInputError);
  });
  test("applyProntoPagoSurcharge/debtAuthorized no estrictamente booleanos lanzan", () => {
    expect(() => canonicalizeFundingRequest(legacyInput({ applyProntoPagoSurcharge: 1 as any }))).toThrow(FundingRequestFingerprintInputError);
    expect(() => canonicalizeFundingRequest(legacyInput({ applyProntoPagoSurcharge: "true" as any }))).toThrow(FundingRequestFingerprintInputError);
    expect(() => canonicalizeFundingRequest(newFlowInput({ debtAuthorized: 1 as any }))).toThrow(FundingRequestFingerprintInputError);
  });
  test("creditAppliedCents/roundingCoverageCents negativos lanzan", () => {
    expect(() => canonicalizeFundingRequest(newFlowInput({ creditAppliedCents: -1 }))).toThrow(FundingRequestFingerprintInputError);
    expect(() => canonicalizeFundingRequest(newFlowInput({ roundingCoverageCents: -1 }))).toThrow(FundingRequestFingerprintInputError);
  });
  test("overflow: amountCents por encima de Number.MAX_SAFE_INTEGER lanza", () => {
    const input = legacyInput({ splits: [{ method: "efectivo", amountCents: Number.MAX_SAFE_INTEGER + 10, notes: null, checks: [] }] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
  test("overflow: installmentId por encima de Number.MAX_SAFE_INTEGER lanza", () => {
    const input = legacyInput({ items: [{ source: "installment", installmentId: Number.MAX_SAFE_INTEGER + 10 }] });
    expect(() => canonicalizeFundingRequest(input)).toThrow(FundingRequestFingerprintInputError);
  });
});

// ─── Diferencias mínimas producen strings distintos ────────────────────────

describe("cualquier diferencia real produce un string distinto", () => {
  test("un centavo de diferencia en un split", () => {
    const a = legacyInput({ splits: [{ method: "efectivo", amountCents: 100000, notes: null, checks: [] }] });
    const b = legacyInput({ splits: [{ method: "efectivo", amountCents: 100001, notes: null, checks: [] }] });
    expect(canonicalizeFundingRequest(a)).not.toBe(canonicalizeFundingRequest(b));
  });
  test("distinto accountHolderInsuredId", () => {
    const a = newFlowInput({ accountHolderInsuredId: 10 });
    const b = newFlowInput({ accountHolderInsuredId: 11 });
    expect(canonicalizeFundingRequest(a)).not.toBe(canonicalizeFundingRequest(b));
  });
  test("distinta paymentDate", () => {
    const a = legacyInput({ paymentDate: "2027-01-01" });
    const b = legacyInput({ paymentDate: "2027-01-02" });
    expect(canonicalizeFundingRequest(a)).not.toBe(canonicalizeFundingRequest(b));
  });
  test("distintas notes", () => {
    const a = legacyInput({ notes: "a" });
    const b = legacyInput({ notes: "b" });
    expect(canonicalizeFundingRequest(a)).not.toBe(canonicalizeFundingRequest(b));
  });
  test("distinto applyProntoPagoSurcharge", () => {
    const a = legacyInput({ applyProntoPagoSurcharge: true });
    const b = legacyInput({ applyProntoPagoSurcharge: false });
    expect(canonicalizeFundingRequest(a)).not.toBe(canonicalizeFundingRequest(b));
  });
  test("distinta reason en accountDifferenceResolution", () => {
    const a = legacyInput({ accountDifferenceResolution: { action: "saldo_deudor", reason: "motivo A" } });
    const b = legacyInput({ accountDifferenceResolution: { action: "saldo_deudor", reason: "motivo B" } });
    expect(canonicalizeFundingRequest(a)).not.toBe(canonicalizeFundingRequest(b));
  });
  test("distinto debtReason", () => {
    const a = newFlowInput({ debtAuthorized: true, debtReason: "motivo A" });
    const b = newFlowInput({ debtAuthorized: true, debtReason: "motivo B" });
    expect(canonicalizeFundingRequest(a)).not.toBe(canonicalizeFundingRequest(b));
  });
});
