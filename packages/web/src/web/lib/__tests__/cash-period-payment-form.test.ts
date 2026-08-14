import { test, expect, describe } from "bun:test";
import {
  isCashPeriodEligible, validateCashPeriodSplitsForm, buildCashPeriodPaymentPayload,
  validateCashPeriodDifferenceResolution, calculateBatchReceivedAppliedDifference,
  cashPeriodCandidateKey, cashPeriodCandidateLabel, resolveSelectedCashPeriodCandidate,
  buildCashPeriodGroupFromCandidate, resolveCashPeriodModalityAvailability,
  type CashPeriodSearchRow,
} from "../cash-period-payment-form";
import { createBatchSplitRow, addCheckToSplit, updateCheckInSplit, type BatchSplitFormRow } from "../payment-batch-form";

describe("isCashPeriodEligible", () => {
  test("false sin importe contado cargado", () => {
    expect(isCashPeriodEligible(null, [{ status: "pendiente", rendered: 0 }])).toBe(false);
    expect(isCashPeriodEligible(undefined, [{ status: "pendiente", rendered: 0 }])).toBe(false);
  });
  test("false con importe contado 0 o negativo", () => {
    expect(isCashPeriodEligible(0, [{ status: "pendiente", rendered: 0 }])).toBe(false);
  });
  test("false sin cuotas", () => {
    expect(isCashPeriodEligible(38000000, [])).toBe(false);
  });
  test("true con importe cargado y todas las cuotas pendientes/vencidas sin actividad", () => {
    expect(isCashPeriodEligible(38000000, [
      { status: "pendiente", rendered: 0 },
      { status: "vencida", rendered: 0 },
    ])).toBe(true);
  });
  test("false si alguna cuota ya está pagada (todo o nada)", () => {
    expect(isCashPeriodEligible(38000000, [
      { status: "pendiente", rendered: 0 },
      { status: "pagada", rendered: 0 },
    ])).toBe(false);
  });
  test("false si alguna cuota ya fue rendida", () => {
    expect(isCashPeriodEligible(38000000, [{ status: "pendiente", rendered: 1 }])).toBe(false);
  });
  test("false si alguna cuota es no_exigible", () => {
    expect(isCashPeriodEligible(38000000, [{ status: "no_exigible", rendered: 0 }])).toBe(false);
  });
});

describe("validateCashPeriodSplitsForm", () => {
  test("acepta suma exacta al contado", () => {
    const splits = [createBatchSplitRow("efectivo", "380000")];
    const result = validateCashPeriodSplitsForm(38000000, splits);
    expect(result.valid).toBe(true);
  });
  // Ronda 2: esta función solo valida la FORMA de los splits — admite que la
  // suma difiera del contado (allowAmountDifference:true), igual que "Cobrar
  // en lote". Si esa diferencia puede aceptarse o no (tolerancia de
  // redondeo) lo decide validateCashPeriodDifferenceResolution, no esta.
  test("suma menor: válida a nivel de forma — la tolerancia se valida aparte", () => {
    const splits = [createBatchSplitRow("efectivo", "379999")];
    const result = validateCashPeriodSplitsForm(38000000, splits);
    expect(result.valid).toBe(true);
  });
  test("suma mayor: válida a nivel de forma — la tolerancia se valida aparte", () => {
    const splits = [createBatchSplitRow("efectivo", "380001")];
    const result = validateCashPeriodSplitsForm(38000000, splits);
    expect(result.valid).toBe(true);
  });
  test("medios combinados que suman exacto", () => {
    const splits = [createBatchSplitRow("efectivo", "180000"), createBatchSplitRow("transferencia", "200000")];
    const result = validateCashPeriodSplitsForm(38000000, splits);
    expect(result.valid).toBe(true);
  });
});

// ─── Ronda 2 — tolerancia de redondeo ──────────────────────────────────────
describe("validateCashPeriodDifferenceResolution", () => {
  test("exacto: siempre válido, sin necesidad de aceptación", () => {
    const difference = calculateBatchReceivedAppliedDifference(380000 * 100, 380000 * 100);
    expect(validateCashPeriodDifferenceResolution(difference, false).valid).toBe(true);
  });
  test("faltante dentro del límite ($4,99), sin aceptar: inválido", () => {
    const difference = calculateBatchReceivedAppliedDifference(37999501, 38000000);
    const result = validateCashPeriodDifferenceResolution(difference, false);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("menos");
  });
  test("faltante dentro del límite ($4,99), aceptado: válido", () => {
    const difference = calculateBatchReceivedAppliedDifference(37999501, 38000000);
    expect(validateCashPeriodDifferenceResolution(difference, true).valid).toBe(true);
  });
  test("sobrante dentro del límite, aceptado: válido", () => {
    const difference = calculateBatchReceivedAppliedDifference(38000300, 38000000);
    expect(validateCashPeriodDifferenceResolution(difference, true).valid).toBe(true);
  });
  test("límite exacto $5,00: aceptado es válido", () => {
    const difference = calculateBatchReceivedAppliedDifference(38000500, 38000000);
    expect(validateCashPeriodDifferenceResolution(difference, true).valid).toBe(true);
  });
  test("$5,01: inválido aunque esté aceptado — nunca supera el tope", () => {
    const difference = calculateBatchReceivedAppliedDifference(38000501, 38000000);
    const result = validateCashPeriodDifferenceResolution(difference, true);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("$5,00");
  });
});

describe("buildCashPeriodPaymentPayload", () => {
  test("arma el payload sin items (a diferencia de payment-batches genérico)", () => {
    const splits = [createBatchSplitRow("efectivo", "380000")];
    const payload = buildCashPeriodPaymentPayload({
      policyId: 5, rebillingId: null, paymentDate: "2027-06-15", splits,
    });
    expect(payload).toEqual({
      policyId: 5, rebillingId: null, paymentDate: "2027-06-15",
      splits: [{ method: "efectivo", amount: 380000 }],
      notes: null, confirmPossibleDuplicates: undefined, accountDifferenceResolution: null,
    });
  });

  test("incluye accountDifferenceResolution cuando se acepta un ajuste por redondeo", () => {
    const splits = [createBatchSplitRow("efectivo", "379999.66")];
    const payload = buildCashPeriodPaymentPayload({
      policyId: 5, rebillingId: null, paymentDate: "2027-06-15", splits,
      accountDifferenceResolution: { action: "ajuste_redondeo" },
    });
    expect(payload.accountDifferenceResolution).toEqual({ action: "ajuste_redondeo" });
  });

  test("incluye rebillingId cuando corresponde", () => {
    const splits = [createBatchSplitRow("transferencia", "340000")];
    const payload = buildCashPeriodPaymentPayload({
      policyId: 5, rebillingId: 42, paymentDate: "2027-07-15", splits,
    });
    expect(payload.rebillingId).toBe(42);
  });

  test("incluye cheques con sus campos, en el split cheque", () => {
    let split: BatchSplitFormRow = createBatchSplitRow("cheque", "380000");
    split = addCheckToSplit([split], split.uid)[0]!;
    const checkUid = split.checks[0]!.uid;
    split = updateCheckInSplit([split], split.uid, checkUid, {
      checkNumber: "123", bankName: "Banco QA", dueDate: "2027-07-01", amount: "380000",
    })[0]!;

    const payload = buildCashPeriodPaymentPayload({
      policyId: 5, rebillingId: null, paymentDate: "2027-06-15", splits: [split],
    });
    expect(payload.splits[0]!.checks).toEqual([{
      checkNumber: "123", bankName: "Banco QA", bankCode: null, drawerName: null,
      drawerDocument: null, issueDate: null, dueDate: "2027-07-01", amount: 380000, notes: null,
    }]);
  });
});

// ─── Modal "Imputar pago" — modalidad de pago (contado vs. cuota) ──────────
// Único lugar de Cobranzas donde se elige la modalidad — estas funciones
// deciden qué mostrar a partir de GET /policies/cash-period-search.

function mkCandidate(overrides: Partial<CashPeriodSearchRow> = {}): CashPeriodSearchRow {
  return {
    policyId: 10, policyNumber: "POL-1", insuredId: 1, insuredName: "Juan Pérez",
    companyId: 1, companyName: "Cooperación", rebillingId: null,
    cashPaymentAmountCents: 38000000, nominalAmountCents: 40000000, discountAmountCents: 2000000,
    installmentCount: 4, periodStartDate: "2026-08-13", deadline: "2026-09-12",
    deadlineStatus: "vigente", eligible: true, ineligibleReasons: [],
    ...overrides,
  };
}

describe("cashPeriodCandidateKey", () => {
  test("emisión (rebillingId null) → sufijo 'emision'", () => {
    expect(cashPeriodCandidateKey({ policyId: 10, rebillingId: null })).toBe("10-emision");
  });
  test("refacturación → sufijo con el rebillingId real, nunca confundido con la emisión", () => {
    expect(cashPeriodCandidateKey({ policyId: 10, rebillingId: 42 })).toBe("10-42");
  });
  test("dos refacturaciones distintas de la misma póliza nunca colisionan", () => {
    expect(cashPeriodCandidateKey({ policyId: 10, rebillingId: 42 }))
      .not.toBe(cashPeriodCandidateKey({ policyId: 10, rebillingId: 43 }));
  });
});

describe("cashPeriodCandidateLabel", () => {
  test("emisión/renovación", () => {
    expect(cashPeriodCandidateLabel({ rebillingId: null })).toBe("Emisión/renovación");
  });
  test("refacturación identifica su propio id — nunca dice solo 'Refacturación' a secas", () => {
    expect(cashPeriodCandidateLabel({ rebillingId: 42 })).toBe("Refacturación #42");
  });
});

describe("resolveSelectedCashPeriodCandidate", () => {
  test("un único candidato elegible se resuelve solo, sin necesitar selectedKey", () => {
    const only = mkCandidate();
    expect(resolveSelectedCashPeriodCandidate([only], "")).toBe(only);
  });
  test("2+ candidatos: se resuelve por la clave elegida explícitamente", () => {
    const emision = mkCandidate({ rebillingId: null });
    const refact = mkCandidate({ rebillingId: 42, cashPaymentAmountCents: 25000000 });
    expect(resolveSelectedCashPeriodCandidate([emision, refact], cashPeriodCandidateKey(refact))).toBe(refact);
    expect(resolveSelectedCashPeriodCandidate([emision, refact], cashPeriodCandidateKey(emision))).toBe(emision);
  });
  test("2+ candidatos sin clave elegida: undefined — nunca asume 'el primero'", () => {
    const emision = mkCandidate({ rebillingId: null });
    const refact = mkCandidate({ rebillingId: 42 });
    expect(resolveSelectedCashPeriodCandidate([emision, refact], "")).toBeUndefined();
  });
});

describe("buildCashPeriodGroupFromCandidate", () => {
  test("mapea 1:1 los campos del candidato, cashAmountCents desde cashPaymentAmountCents", () => {
    const c = mkCandidate({ rebillingId: 42, cashPaymentAmountCents: 25000000, nominalAmountCents: 27000000, installmentCount: 3, deadline: "2026-09-12", deadlineStatus: "vencido" });
    expect(buildCashPeriodGroupFromCandidate(c)).toEqual({
      policyId: 10, rebillingId: 42, label: "Refacturación #42",
      installmentCount: 3, nominalAmountCents: 27000000, cashAmountCents: 25000000,
      deadline: "2026-09-12", deadlineStatus: "vencido",
    });
  });
  test("cashPaymentAmountCents null nunca produce cashAmountCents null (defensivo)", () => {
    const c = mkCandidate({ cashPaymentAmountCents: null });
    expect(buildCashPeriodGroupFromCandidate(c).cashAmountCents).toBe(0);
  });
});

describe("resolveCashPeriodModalityAvailability", () => {
  test("sin candidatos → 'none'", () => {
    expect(resolveCashPeriodModalityAvailability([])).toEqual({ kind: "none" });
  });
  test("un candidato elegible → 'available' con ese candidato", () => {
    const c = mkCandidate();
    expect(resolveCashPeriodModalityAvailability([c])).toEqual({ kind: "available", eligibleCandidates: [c] });
  });
  test("un candidato no elegible (actividad) → 'unavailable' con el primer motivo", () => {
    const c = mkCandidate({ eligible: false, ineligibleReasons: ["La cuota 1 ya está pagada.", "La cuota 1 ya tiene un pago confirmado."] });
    expect(resolveCashPeriodModalityAvailability([c])).toEqual({
      kind: "unavailable", cashPaymentAmountCents: 38000000, firstReason: "La cuota 1 ya está pagada.",
    });
  });
  test("sin importe de contado configurado → 'none', nunca 'unavailable' (no hay nada que informar)", () => {
    const c = mkCandidate({ cashPaymentAmountCents: null, eligible: false, ineligibleReasons: [] });
    expect(resolveCashPeriodModalityAvailability([c])).toEqual({ kind: "none" });
  });
  test("emisión con actividad pero refacturación elegible → 'available' (prioriza cualquier período disponible)", () => {
    const emisionConActividad = mkCandidate({ rebillingId: null, eligible: false, ineligibleReasons: ["La cuota 1 ya está pagada."] });
    const refactElegible = mkCandidate({ rebillingId: 42, cashPaymentAmountCents: 25000000, eligible: true, ineligibleReasons: [] });
    const result = resolveCashPeriodModalityAvailability([emisionConActividad, refactElegible]);
    expect(result).toEqual({ kind: "available", eligibleCandidates: [refactElegible] });
  });
  test("motivo por defecto cuando ineligibleReasons viene vacío (defensivo)", () => {
    const c = mkCandidate({ eligible: false, ineligibleReasons: [] });
    const result = resolveCashPeriodModalityAvailability([c]);
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") expect(result.firstReason).toBe("el período ya tiene actividad.");
  });
});
