// Etapa 1B-3-A — tests puros de parseFundingRequest. Sin DB, sin HTTP —
// datos 100% sintéticos. Ver account-holder-funding-request.ts para el
// diseño completo.

import { test, expect, describe } from "bun:test";
import {
  parseFundingRequest,
  AccountHolderFundingRequestError,
} from "../../lib/payments/account-holder-funding-request";
import { PaymentBatchValidationError } from "../../lib/payments/batches";
import { ReceivedCheckValidationError } from "../../lib/payments/received-checks";
import { FundingRequestFingerprintInputError } from "../../lib/payments/account-holder-funding-fingerprint";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function legacyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentDate: "2027-01-01",
    items: [{ source: "installment", installmentId: 1 }],
    splits: [{ method: "efectivo", amount: 1000 }],
    notes: null,
    ...overrides,
  };
}

function titularBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentDate: "2027-01-01",
    accountHolderInsuredId: 10,
    idempotencyKey: "batch-agosto-bas-1",
    items: [{ source: "installment", installmentId: 1 }],
    splits: [{ method: "efectivo", amount: 1000 }],
    notes: null,
    ...overrides,
  };
}

function chequeSplit(overrides: Record<string, unknown> = {}) {
  return {
    method: "cheque",
    amount: 500,
    checks: [{ checkNumber: "CHK-1", bankName: "Banco Test", dueDate: "2027-06-01", amount: 500 }],
    ...overrides,
  };
}

// ─── legacy actual sin campos nuevos ────────────────────────────────────────

describe("legacy sin campos nuevos", () => {
  test("body típico de hoy: mode=legacy, sin lanzar", () => {
    const result = parseFundingRequest(legacyBody());
    expect(result.mode).toBe("legacy");
    expect(result.dto.accountHolderInsuredId).toBeNull();
    expect(result.dto.creditAppliedCents).toBe(0);
    expect(result.dto.roundingCoverageCents).toBe(0);
    expect(result.dto.debtAuthorized).toBe(false);
    expect(result.dto.debtReason).toBeNull();
    expect(result.idempotencyKey).toBeNull();
  });

  test("legacy con accountDifferenceResolution conserva el flujo actual", () => {
    const result = parseFundingRequest(legacyBody({ accountDifferenceResolution: { action: "saldo_a_favor", reason: "sobrante" } }));
    expect(result.mode).toBe("legacy");
    expect(result.dto.accountDifferenceResolution).toEqual({ action: "saldo_a_favor", reason: "sobrante" });
  });

  test("legacy, ajuste_redondeo sin reason usa el default (ROUNDING_ADJUSTMENT_REASON)", () => {
    const result = parseFundingRequest(legacyBody({ accountDifferenceResolution: { action: "ajuste_redondeo" } }));
    expect(result.dto.accountDifferenceResolution).toEqual({ action: "ajuste_redondeo", reason: "Ajuste por redondeo autorizado en cobro en lote" });
  });
});

// ─── legacy con valores neutrales explícitos ────────────────────────────────

describe("legacy con valores neutrales explícitos", () => {
  test("accountHolderInsuredId:null, creditAppliedCents:0, roundingCoverageCents:0, debtAuthorized:false, debtReason:null, idempotencyKey:null — no lanza", () => {
    const result = parseFundingRequest(legacyBody({
      accountHolderInsuredId: null, creditAppliedCents: 0, roundingCoverageCents: 0,
      debtAuthorized: false, debtReason: null, idempotencyKey: null,
    }));
    expect(result.mode).toBe("legacy");
  });
});

// ─── cada campo no neutral sin titular debe rechazarse ─────────────────────

describe("campos no neutros sin titular — request ambiguo", () => {
  test("creditAppliedCents > 0 sin accountHolderInsuredId lanza", () => {
    expect(() => parseFundingRequest(legacyBody({ creditAppliedCents: 100 }))).toThrow(AccountHolderFundingRequestError);
  });
  test("roundingCoverageCents > 0 sin accountHolderInsuredId lanza", () => {
    expect(() => parseFundingRequest(legacyBody({ roundingCoverageCents: 100 }))).toThrow(AccountHolderFundingRequestError);
  });
  test("debtAuthorized:true sin accountHolderInsuredId lanza", () => {
    expect(() => parseFundingRequest(legacyBody({ debtAuthorized: true }))).toThrow(AccountHolderFundingRequestError);
  });
  test("debtReason no nulo sin accountHolderInsuredId lanza", () => {
    expect(() => parseFundingRequest(legacyBody({ debtReason: "x" }))).toThrow(AccountHolderFundingRequestError);
  });
  test("idempotencyKey no nula sin accountHolderInsuredId lanza", () => {
    expect(() => parseFundingRequest(legacyBody({ idempotencyKey: "x" }))).toThrow(AccountHolderFundingRequestError);
  });
});

// ─── titular válido ──────────────────────────────────────────────────────

describe("titular válido", () => {
  test("sin crédito (creditAppliedCents omitido -> 0), no lanza", () => {
    const result = parseFundingRequest(titularBody());
    expect(result.mode).toBe("titular");
    expect(result.dto.accountHolderInsuredId).toBe(10);
    expect(result.dto.creditAppliedCents).toBe(0);
  });
  test("con crédito aplicado, no lanza", () => {
    const result = parseFundingRequest(titularBody({ creditAppliedCents: 5000 }));
    expect(result.dto.creditAppliedCents).toBe(5000);
  });
  test("con redondeo, no lanza", () => {
    const result = parseFundingRequest(titularBody({ roundingCoverageCents: 300 }));
    expect(result.dto.roundingCoverageCents).toBe(300);
  });
  test("con deuda y razón, no lanza", () => {
    const result = parseFundingRequest(titularBody({ debtAuthorized: true, debtReason: "faltante autorizado" }));
    expect(result.dto.debtAuthorized).toBe(true);
    expect(result.dto.debtReason).toBe("faltante autorizado");
  });
});

// ─── deuda sin razón / razón sin deuda ──────────────────────────────────────

describe("debtAuthorized / debtReason — reglas cruzadas", () => {
  test("deuda sin razón lanza", () => {
    expect(() => parseFundingRequest(titularBody({ debtAuthorized: true }))).toThrow(AccountHolderFundingRequestError);
  });
  test("deuda con debtReason vacío (recorta a null) lanza", () => {
    expect(() => parseFundingRequest(titularBody({ debtAuthorized: true, debtReason: "   " }))).toThrow(AccountHolderFundingRequestError);
  });
  test("razón sin deuda (debtAuthorized omitido) lanza", () => {
    expect(() => parseFundingRequest(titularBody({ debtReason: "x" }))).toThrow(AccountHolderFundingRequestError);
  });
  test("razón con debtAuthorized:false explícito lanza", () => {
    expect(() => parseFundingRequest(titularBody({ debtAuthorized: false, debtReason: "x" }))).toThrow(AccountHolderFundingRequestError);
  });
});

// ─── titular con accountDifferenceResolution ────────────────────────────────

describe("exclusión mutua titular / accountDifferenceResolution", () => {
  test("titular con accountDifferenceResolution presente lanza", () => {
    expect(() => parseFundingRequest(titularBody({ accountDifferenceResolution: { action: "saldo_a_favor", reason: null } }))).toThrow(AccountHolderFundingRequestError);
  });
});

// ─── idempotencyKey ausente, vacía o con espacios ──────────────────────────

describe("idempotencyKey en modo titular", () => {
  test("ausente lanza", () => {
    const body = titularBody();
    delete body.idempotencyKey;
    expect(() => parseFundingRequest(body)).toThrow(AccountHolderFundingRequestError);
  });
  test("string vacía lanza", () => {
    expect(() => parseFundingRequest(titularBody({ idempotencyKey: "" }))).toThrow(AccountHolderFundingRequestError);
  });
  test("solo espacios lanza", () => {
    expect(() => parseFundingRequest(titularBody({ idempotencyKey: "   " }))).toThrow(AccountHolderFundingRequestError);
  });
  test("con espacios al inicio/fin se recorta", () => {
    const result = parseFundingRequest(titularBody({ idempotencyKey: "  clave-valida  " }));
    expect(result.idempotencyKey).toBe("clave-valida");
  });
  test("null lanza (obligatoria en modo titular)", () => {
    expect(() => parseFundingRequest(titularBody({ idempotencyKey: null }))).toThrow(AccountHolderFundingRequestError);
  });
});

// ─── idempotencyKey — límite de longitud (migración 0036: CHECK 1..200) ────

describe("idempotencyKey — límite de longitud (1..200 caracteres Unicode)", () => {
  test("exactamente 1 carácter: acepta", () => {
    const result = parseFundingRequest(titularBody({ idempotencyKey: "x" }));
    expect(result.idempotencyKey).toBe("x");
  });

  test("exactamente 200 caracteres: acepta", () => {
    const key = "x".repeat(200);
    const result = parseFundingRequest(titularBody({ idempotencyKey: key }));
    expect(result.idempotencyKey).toBe(key);
    expect(result.idempotencyKey!.length).toBe(200);
  });

  test("201 caracteres: lanza AccountHolderFundingRequestError", () => {
    const key = "x".repeat(201);
    expect(() => parseFundingRequest(titularBody({ idempotencyKey: key }))).toThrow(AccountHolderFundingRequestError);
  });

  test("el límite se aplica DESPUÉS del recorte: 200 caracteres reales + espacios alrededor acepta", () => {
    const key = "  " + "x".repeat(200) + "  ";
    const result = parseFundingRequest(titularBody({ idempotencyKey: key }));
    expect(result.idempotencyKey!.length).toBe(200);
  });

  test("201 caracteres reales + espacios alrededor lanza (el recorte no lo salva)", () => {
    const key = "  " + "x".repeat(201) + "  ";
    expect(() => parseFundingRequest(titularBody({ idempotencyKey: key }))).toThrow(AccountHolderFundingRequestError);
  });

  test("conteo por code point Unicode, no por unidad UTF-16 ni por byte: 200 emoji (fuera del BMP) acepta", () => {
    // "😀" es 1 code point pero 2 unidades UTF-16 (surrogate pair) y 4 bytes
    // UTF-8 — si el conteo fuera por .length (UTF-16) o por bytes, 200 emoji
    // ya superaría 200 de forma incorrecta. El CHECK de SQLite cuenta
    // caracteres, no bytes/unidades UTF-16 — este test lo confirma acá.
    const key = "😀".repeat(200);
    const result = parseFundingRequest(titularBody({ idempotencyKey: key }));
    expect(result.idempotencyKey).toBe(key);
    expect(key.length).toBe(400); // unidades UTF-16 — confirma que .length NO es lo que se usa para validar
  });

  test("201 emoji (fuera del BMP) lanza — el conteo por code point sigue rechazando el exceso real", () => {
    const key = "😀".repeat(201);
    expect(() => parseFundingRequest(titularBody({ idempotencyKey: key }))).toThrow(AccountHolderFundingRequestError);
  });

  // Cada caso envuelto en su propio array (forma idiomática de test.each):
  // un caso [[]] sin envolver hace que bun test.each cuelgue el runner
  // (confirmado por repro aislado) — no es parte del contrato del helper.
  test.each([[123], [true], [[]], [{}]])("idempotencyKey con tipo no-string (%p) lanza", (bad) => {
    expect(() => parseFundingRequest(titularBody({ idempotencyKey: bad as any }))).toThrow(AccountHolderFundingRequestError);
  });
});

// ─── Normalización: ítems, splits, cheques, notas, Pronto Pago ─────────────

describe("normalización de ítems", () => {
  test("installment", () => {
    const result = parseFundingRequest(legacyBody({ items: [{ source: "installment", installmentId: 7 }] }));
    expect(result.normalizedItems).toEqual([{ source: "installment", installmentId: 7 }]);
    expect(result.dto.items).toEqual([{ source: "installment", installmentId: 7 }]);
  });
  test("policy_manual_payment", () => {
    const result = parseFundingRequest(legacyBody({ items: [{ source: "policy_manual_payment", policyId: 3, amount: 150, description: " pago manual " }] }));
    expect(result.normalizedItems).toEqual([{ source: "policy_manual_payment", policyId: 3, amountCents: 15000, description: "pago manual" }]);
  });
  test("manual_payment", () => {
    const result = parseFundingRequest(legacyBody({ items: [{ source: "manual_payment", manualPayer: "Juan", amount: 200 }] }));
    expect(result.normalizedItems).toEqual([{ source: "manual_payment", manualPayer: "Juan", manualPolicyNumber: null, manualCompany: null, amountCents: 20000, description: null }]);
  });
});

describe("normalización de splits y cheques", () => {
  test("split efectivo simple", () => {
    const result = parseFundingRequest(legacyBody({ splits: [{ method: "efectivo", amount: 1000, notes: " nota " }] }));
    expect(result.splitsWithChecks).toEqual([{ split: { method: "efectivo", amountCents: 100000, notes: "nota" }, checks: [] }]);
  });

  test("split cheque: checks normalizados en splitsWithChecks, sin currency en dto.splits", () => {
    const result = parseFundingRequest(legacyBody({ splits: [chequeSplit()] }));
    expect(result.splitsWithChecks[0]!.checks).toHaveLength(1);
    expect(result.splitsWithChecks[0]!.checks[0]!.currency).toBe("ARS");
    expect(result.dto.splits[0]!.checks).toHaveLength(1);
    expect("currency" in (result.dto.splits[0]!.checks[0] as object)).toBe(false);
    expect(result.dto.splits[0]!.checks[0]).toEqual({
      checkNumber: "CHK-1", bankName: "Banco Test", bankCode: null, drawerName: null,
      drawerDocument: null, issueDate: null, dueDate: "2027-06-01", amountCents: 50000, notes: null,
    });
  });

  test("split cheque sin cheques lanza PaymentBatchValidationError", () => {
    const input = legacyBody({ splits: [{ method: "cheque", amount: 500 }] });
    expect(() => parseFundingRequest(input)).toThrow(PaymentBatchValidationError);
  });

  test("split no-cheque con cheques lanza PaymentBatchValidationError", () => {
    const input = legacyBody({ splits: [{ method: "efectivo", amount: 500, checks: [{ checkNumber: "X", bankName: "B", dueDate: "2027-06-01", amount: 500 }] }] });
    expect(() => parseFundingRequest(input)).toThrow(PaymentBatchValidationError);
  });

  test("suma de cheques distinta al split lanza PaymentBatchValidationError", () => {
    const input = legacyBody({ splits: [{ method: "cheque", amount: 500, checks: [{ checkNumber: "X", bankName: "B", dueDate: "2027-06-01", amount: 400 }] }] });
    expect(() => parseFundingRequest(input)).toThrow(PaymentBatchValidationError);
  });

  test("cheque malformado (sin checkNumber) lanza ReceivedCheckValidationError", () => {
    const input = legacyBody({ splits: [{ method: "cheque", amount: 500, checks: [{ bankName: "B", dueDate: "2027-06-01", amount: 500 }] }] });
    expect(() => parseFundingRequest(input)).toThrow(ReceivedCheckValidationError);
  });
});

describe("normalización de notes", () => {
  test("con espacios se recorta", () => {
    const result = parseFundingRequest(legacyBody({ notes: "  hola  " }));
    expect(result.dto.notes).toBe("hola");
  });
  test("string vacía pasa a null", () => {
    const result = parseFundingRequest(legacyBody({ notes: "" }));
    expect(result.dto.notes).toBeNull();
  });
  test("ausente pasa a null", () => {
    const body = legacyBody();
    delete body.notes;
    const result = parseFundingRequest(body);
    expect(result.dto.notes).toBeNull();
  });
});

describe("normalización de applyProntoPagoSurcharge", () => {
  test("ausente -> true", () => {
    const result = parseFundingRequest(legacyBody());
    expect(result.dto.applyProntoPagoSurcharge).toBe(true);
  });
  test("true explícito -> true", () => {
    const result = parseFundingRequest(legacyBody({ applyProntoPagoSurcharge: true }));
    expect(result.dto.applyProntoPagoSurcharge).toBe(true);
  });
  test("false explícito -> false", () => {
    const result = parseFundingRequest(legacyBody({ applyProntoPagoSurcharge: false }));
    expect(result.dto.applyProntoPagoSurcharge).toBe(false);
  });
});

// ─── Fingerprint determinista ────────────────────────────────────────────

describe("fingerprint determinista", () => {
  test("mismo body produce el mismo fingerprint en llamadas repetidas", () => {
    const a = parseFundingRequest(titularBody());
    const b = parseFundingRequest(titularBody());
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

// ─── confirmPossibleDuplicates / idempotencyKey excluidos del fingerprint ──

describe("confirmPossibleDuplicates e idempotencyKey excluidos del fingerprint", () => {
  test("el JSON del fingerprint nunca contiene esas claves", () => {
    const result = parseFundingRequest(titularBody({ confirmPossibleDuplicates: true }));
    const parsed = JSON.parse(result.fingerprint);
    expect(JSON.stringify(parsed)).not.toContain("confirmPossibleDuplicates");
    expect(JSON.stringify(parsed)).not.toContain("idempotencyKey");
  });

  test("distinto confirmPossibleDuplicates produce el MISMO fingerprint", () => {
    const a = parseFundingRequest(titularBody({ confirmPossibleDuplicates: true }));
    const b = parseFundingRequest(titularBody({ confirmPossibleDuplicates: false }));
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test("distinto idempotencyKey produce el MISMO fingerprint", () => {
    const a = parseFundingRequest(titularBody({ idempotencyKey: "clave-1" }));
    const b = parseFundingRequest(titularBody({ idempotencyKey: "clave-2" }));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.idempotencyKey).toBe("clave-1");
    expect(b.idempotencyKey).toBe("clave-2");
  });

  test("confirmPossibleDuplicates se normaliza a boolean estricto (=== true)", () => {
    const a = parseFundingRequest(legacyBody({ confirmPossibleDuplicates: "true" as any }));
    const b = parseFundingRequest(legacyBody());
    expect(a.confirmPossibleDuplicates).toBe(false); // solo `true` literal cuenta
    expect(b.confirmPossibleDuplicates).toBe(false);
  });
});

// ─── Validaciones runtime estrictas ─────────────────────────────────────────

describe("validaciones runtime estrictas", () => {
  test("body no-objeto lanza AccountHolderFundingRequestError", () => {
    expect(() => parseFundingRequest("no-object" as any)).toThrow(AccountHolderFundingRequestError);
    expect(() => parseFundingRequest(null as any)).toThrow(AccountHolderFundingRequestError);
    expect(() => parseFundingRequest([] as any)).toThrow(AccountHolderFundingRequestError);
  });

  test("items malformados propagan PaymentBatchValidationError (no una clase propia)", () => {
    expect(() => parseFundingRequest(legacyBody({ items: [] }))).toThrow(PaymentBatchValidationError);
    expect(() => parseFundingRequest(legacyBody({ items: [{ source: "installment", installmentId: -1 }] }))).toThrow(PaymentBatchValidationError);
  });

  test("splits malformados propagan PaymentBatchValidationError", () => {
    expect(() => parseFundingRequest(legacyBody({ splits: [] }))).toThrow(PaymentBatchValidationError);
    expect(() => parseFundingRequest(legacyBody({ splits: [{ method: "lote", amount: 1000 }] }))).toThrow(PaymentBatchValidationError);
  });

  test("paymentDate inválido propaga FundingRequestFingerprintInputError (delegado, no duplicado acá)", () => {
    expect(() => parseFundingRequest(legacyBody({ paymentDate: "2027/01/01" }))).toThrow(FundingRequestFingerprintInputError);
  });

  test.each([0, -1, 1.5, "10", Number.NaN])("accountHolderInsuredId inválido (%p) lanza", (bad) => {
    expect(() => parseFundingRequest(titularBody({ accountHolderInsuredId: bad as any }))).toThrow(AccountHolderFundingRequestError);
  });

  test.each([-1, 1.5, "100"])("creditAppliedCents inválido (%p) en modo titular lanza", (bad) => {
    expect(() => parseFundingRequest(titularBody({ creditAppliedCents: bad as any }))).toThrow(AccountHolderFundingRequestError);
  });

  test.each([1, "true", null])("debtAuthorized no estrictamente booleano (%p) en modo titular lanza", (bad) => {
    expect(() => parseFundingRequest(titularBody({ debtAuthorized: bad as any }))).toThrow(AccountHolderFundingRequestError);
  });

  test("debtReason con tipo incorrecto (número) lanza", () => {
    expect(() => parseFundingRequest(titularBody({ debtAuthorized: true, debtReason: 123 as any }))).toThrow(AccountHolderFundingRequestError);
  });

  test("idempotencyKey con tipo incorrecto (número) lanza", () => {
    expect(() => parseFundingRequest(titularBody({ idempotencyKey: 123 as any }))).toThrow(AccountHolderFundingRequestError);
  });
});

// ─── No mutación ─────────────────────────────────────────────────────────

describe("no mutación", () => {
  test("no muta el body de entrada", () => {
    const body = titularBody({ splits: [chequeSplit()], creditAppliedCents: 1000, debtAuthorized: true, debtReason: "motivo" });
    const snapshot = JSON.parse(JSON.stringify(body));

    parseFundingRequest(body);

    expect(JSON.parse(JSON.stringify(body))).toEqual(snapshot);
  });
});
