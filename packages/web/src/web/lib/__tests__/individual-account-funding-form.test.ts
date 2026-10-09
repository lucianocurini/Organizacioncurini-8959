import { describe, test, expect } from "bun:test";
import {
  emptyIndividualFundingState, resetFundingForPolicyChange, resetFundingForInstallmentChange, invalidateFundingKey,
  setFundingDebtAuthorized, isIndividualFundingEligible, individualFundingSurchargeCents, individualFundingTargetCents,
  validateIndividualFundingSplits, removeFundingSplitRow, realSplitsTotalCents, validateIndividualFundingFields,
  computeIndividualFundingPreview, shortfallAfterAllCreditCents, buildIndividualFundingSummary,
  maxApplicableCreditCents, effectiveFundingSplits, shouldRebalanceSingleFundingSplit, rebalanceSingleSplitForCredit,
  buildAccountFundedPaymentPayload, computeIndividualFundingFingerprint, resolveIdempotencyKey,
  describeIndividualAccountFundingRow, type IndividualFundingFormState,
} from "../individual-account-funding-form";
import { createBatchSplitRow } from "../payment-batch-form";

const CUOTA = 10000000;

function state(patch: Partial<IndividualFundingFormState> = {}): IndividualFundingFormState {
  return { ...emptyIndividualFundingState(), enabled: true, ...patch };
}

describe("estado y reinicios", () => {
  const dirty = state({ creditAppliedInput: "30000", roundingCoverageInput: "3", debtAuthorized: true, debtReason: "x", idempotencyKey: "k", keyFingerprint: "f" });
  test("cambiar de póliza reinicia todo (incluido el toggle)", () => {
    expect(resetFundingForPolicyChange()).toEqual(emptyIndividualFundingState());
  });
  test("cambiar cuota/importe reinicia saldo, redondeo, deuda y clave, conserva el toggle", () => {
    expect(resetFundingForInstallmentChange(dirty)).toEqual({ ...emptyIndividualFundingState(), enabled: true });
  });
  test("cambiar fecha solo invalida la clave", () => {
    expect(invalidateFundingKey(dirty)).toEqual({ ...dirty, idempotencyKey: null, keyFingerprint: null });
    const clean = state();
    expect(invalidateFundingKey(clean)).toBe(clean);
  });
  test("desautorizar deuda limpia el motivo", () => {
    expect(setFundingDebtAuthorized(dirty, false).debtReason).toBe("");
    expect(setFundingDebtAuthorized(state({ debtReason: "x" }), true).debtReason).toBe("x");
  });
});

describe("elegibilidad", () => {
  const base = { editing: false, manualMode: false, showCuotaFields: true, installmentId: "9", status: "confirmado", policyInsuredId: 3 };
  test("pago nuevo, póliza con asegurado, cuota, confirmado → elegible", () => {
    expect(isIndividualFundingEligible(base)).toBe(true);
  });
  test("fuera de alcance: edición, manual, sin cuota, contado, pendiente/anulado, sin asegurado", () => {
    expect(isIndividualFundingEligible({ ...base, editing: true })).toBe(false);
    expect(isIndividualFundingEligible({ ...base, manualMode: true })).toBe(false);
    expect(isIndividualFundingEligible({ ...base, installmentId: "" })).toBe(false);
    expect(isIndividualFundingEligible({ ...base, showCuotaFields: false })).toBe(false);
    expect(isIndividualFundingEligible({ ...base, status: "pendiente" })).toBe(false);
    expect(isIndividualFundingEligible({ ...base, policyInsuredId: null })).toBe(false);
  });
});

describe("total a cancelar con Pronto Pago", () => {
  test("Rivadavia + aplicado + medios propios (o cero medios) → $800 dentro del total", () => {
    expect(individualFundingSurchargeCents({ isRivadavia: true, applyProntoPagoSurcharge: true, splits: [{ method: "efectivo" }] })).toBe(80000);
    expect(individualFundingSurchargeCents({ isRivadavia: true, applyProntoPagoSurcharge: true, splits: [] })).toBe(80000);
    expect(individualFundingTargetCents(CUOTA, 80000)).toBe(CUOTA + 80000);
  });
  test("medios directos, no aplicado o no Rivadavia → sin recargo", () => {
    expect(individualFundingSurchargeCents({ isRivadavia: true, applyProntoPagoSurcharge: true, splits: [{ method: "link_pago" }] })).toBe(0);
    expect(individualFundingSurchargeCents({ isRivadavia: true, applyProntoPagoSurcharge: false, splits: [] })).toBe(0);
    expect(individualFundingSurchargeCents({ isRivadavia: false, applyProntoPagoSurcharge: true, splits: [] })).toBe(0);
  });
});

describe("medios reales", () => {
  test("pueden diferir del total; cero medios solo con saldo aplicado", () => {
    expect(validateIndividualFundingSplits(CUOTA, [createBatchSplitRow("efectivo", "110000")], 0).valid).toBe(true);
    expect(validateIndividualFundingSplits(CUOTA, [], CUOTA).valid).toBe(true);
    const noCredit = validateIndividualFundingSplits(CUOTA, [], 0);
    expect(noCredit.valid).toBe(false);
    expect(noCredit.group).toBe("own");
  });
  test("mezcla propio + directo sigue rechazada", () => {
    expect(validateIndividualFundingSplits(CUOTA, [createBatchSplitRow("efectivo", "1"), createBatchSplitRow("link_pago", "1")], 0).valid).toBe(false);
  });
  test("se puede quitar el último medio (a diferencia del pago tradicional)", () => {
    const row = createBatchSplitRow("efectivo", "1");
    expect(removeFundingSplitRow([row], row.uid)).toEqual([]);
  });
  test("total real ignora filas inválidas", () => {
    expect(realSplitsTotalCents([createBatchSplitRow("efectivo", "70000"), createBatchSplitRow("efectivo", "")])).toBe(7000000);
  });
});

describe("campos económicos", () => {
  test("saldo > disponible, redondeo > $5, deuda sin motivo → inválidos", () => {
    expect(validateIndividualFundingFields(state({ creditAppliedInput: "300.01" }), 30000).valid).toBe(false);
    expect(validateIndividualFundingFields(state({ roundingCoverageInput: "5.01" }), 0).valid).toBe(false);
    expect(validateIndividualFundingFields(state({ debtAuthorized: true, debtReason: "  " }), 0).valid).toBe(false);
    expect(validateIndividualFundingFields(state({ creditAppliedInput: "abc" }), 0).valid).toBe(false);
    expect(validateIndividualFundingFields(state({ creditAppliedInput: "300", roundingCoverageInput: "5", debtAuthorized: true, debtReason: "x" }), 30000).valid).toBe(true);
  });
  test("saldo máximo aplicable y faltante después de agotar el saldo", () => {
    const one = (amount: string) => [createBatchSplitRow("efectivo", amount)];
    const two = (a: string, b: string) => [createBatchSplitRow("efectivo", a), createBatchSplitRow("transferencia", b)];
    // Un único medio (se reduce solo): min(disponible, total), aunque el medio ya cubra todo.
    expect(maxApplicableCreditCents({ availableCreditCents: 3000000, targetCents: CUOTA, splits: one("100000") })).toBe(3000000);
    expect(maxApplicableCreditCents({ availableCreditCents: 20000000, targetCents: CUOTA, splits: one("100000") })).toBe(CUOTA);
    expect(maxApplicableCreditCents({ availableCreditCents: 20000000, targetCents: CUOTA, splits: [] })).toBe(CUOTA);
    // Varios medios (no se tocan): solo lo no cubierto, nunca negativo.
    expect(maxApplicableCreditCents({ availableCreditCents: 3000000, targetCents: CUOTA, splits: two("40000", "30000") })).toBe(3000000);
    expect(maxApplicableCreditCents({ availableCreditCents: 100, targetCents: CUOTA, splits: two("60000", "50000") })).toBe(0);
    // Disponible negativo / no finito → 0.
    expect(maxApplicableCreditCents({ availableCreditCents: -500, targetCents: CUOTA, splits: one("100000") })).toBe(0);
    expect(maxApplicableCreditCents({ availableCreditCents: Number.NaN, targetCents: CUOTA, splits: one("100000") })).toBe(0);
    expect(maxApplicableCreditCents({ availableCreditCents: Number.POSITIVE_INFINITY, targetCents: CUOTA, splits: one("100000") })).toBe(0);
    expect(shortfallAfterAllCreditCents({ targetCents: CUOTA, realCents: 5000000, availableCreditCents: 2000000, roundingCoverageCents: 0 })).toBe(3000000);
    expect(shortfallAfterAllCreditCents({ targetCents: CUOTA, realCents: 5000000, availableCreditCents: 9000000, roundingCoverageCents: 0 })).toBe(0);
  });
});

describe("preview y resumen", () => {
  test("30.000 saldo + 70.000 real: líneas en orden, sin deuda ni saldo nuevo", () => {
    const p = computeIndividualFundingPreview({
      targetCents: CUOTA, splits: [createBatchSplitRow("transferencia", "70000")], creditAppliedCents: 3000000,
      roundingCoverageCents: 0, availableCreditCents: 3000000, debtAuthorized: false,
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(buildIndividualFundingSummary({ installmentAmountCents: CUOTA, surchargeCents: 0, plan: p.plan }).map((l) => [l.key, l.amountCents]))
      .toEqual([["cuota", CUOTA], ["total", CUOTA], ["saldo", 3000000], ["medios", 7000000]]);
  });
  test("Pronto Pago con deuda: recargo explícito y nueva deuda", () => {
    const p = computeIndividualFundingPreview({
      targetCents: CUOTA + 80000, splits: [], creditAppliedCents: CUOTA, roundingCoverageCents: 0, availableCreditCents: CUOTA, debtAuthorized: true,
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const lines = buildIndividualFundingSummary({ installmentAmountCents: CUOTA, surchargeCents: 80000, plan: p.plan });
    expect(lines.map((l) => l.key)).toEqual(["cuota", "recargo", "total", "saldo", "medios", "deuda"]);
    expect(lines.find((l) => l.key === "medios")!.amountCents).toBe(0);
    expect(lines.find((l) => l.key === "deuda")!.amountCents).toBe(80000);
  });
  test("sobrante sin saldo → nuevo saldo a favor; con saldo → error", () => {
    const ok = computeIndividualFundingPreview({ targetCents: CUOTA, splits: [createBatchSplitRow("efectivo", "110000")], creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: false });
    expect(ok.ok && ok.plan.newSaldoAFavorCents).toBe(1000000);
    const bad = computeIndividualFundingPreview({ targetCents: CUOTA, splits: [createBatchSplitRow("efectivo", "100000")], creditAppliedCents: 100, roundingCoverageCents: 0, availableCreditCents: 100, debtAuthorized: false });
    expect(bad.ok).toBe(false);
  });
});

describe("resumen con deuda previa del asegurado (sobrante que netea)", () => {
  function surplusPlan(realPesos: string) {
    const p = computeIndividualFundingPreview({
      targetCents: CUOTA, splits: [createBatchSplitRow("efectivo", realPesos)], creditAppliedCents: 0,
      roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: false,
    });
    if (!p.ok) throw new Error(p.errorMessage);
    return p.plan;
  }
  test("debe 30.000 y sobran 10.000: cancela deuda anterior, NO 'nuevo saldo a favor', saldo final deudor 20.000", () => {
    const lines = buildIndividualFundingSummary({ installmentAmountCents: CUOTA, surchargeCents: 0, plan: surplusPlan("110000"), priorBalanceCents: -3000000 });
    expect(lines.map((l) => [l.key, l.label, l.amountCents])).toEqual([
      ["cuota", "Cuota", CUOTA], ["total", "Importe a cancelar", CUOTA], ["medios", "Dinero real ingresado", 11000000],
      ["cancela_deuda", "Cancela deuda anterior", 1000000], ["saldo_final", "Saldo final de la cuenta (deudor)", 2000000],
    ]);
  });
  test("debe 30.000 y sobran 40.000: cancela 30.000, nuevo saldo a favor 10.000, saldo final a favor 10.000", () => {
    const lines = buildIndividualFundingSummary({ installmentAmountCents: CUOTA, surchargeCents: 0, plan: surplusPlan("140000"), priorBalanceCents: -3000000 });
    expect(lines.filter((l) => ["cancela_deuda", "nuevo_saldo", "saldo_final"].includes(l.key)).map((l) => [l.label, l.amountCents]))
      .toEqual([["Cancela deuda anterior", 3000000], ["Nuevo saldo a favor", 1000000], ["Saldo final de la cuenta (a favor)", 1000000]]);
  });
  test("sobrante exacto a la deuda: saldo final 0", () => {
    const lines = buildIndividualFundingSummary({ installmentAmountCents: CUOTA, surchargeCents: 0, plan: surplusPlan("130000"), priorBalanceCents: -3000000 });
    expect(lines.some((l) => l.key === "nuevo_saldo")).toBe(false);
    expect(lines.find((l) => l.key === "saldo_final")).toEqual({ key: "saldo_final", label: "Saldo final de la cuenta", amountCents: 0, kind: "neutral" });
  });
  test("sin deuda previa el sobrante sí es nuevo saldo a favor", () => {
    const lines = buildIndividualFundingSummary({ installmentAmountCents: CUOTA, surchargeCents: 0, plan: surplusPlan("110000"), priorBalanceCents: 0 });
    expect(lines.some((l) => l.key === "cancela_deuda")).toBe(false);
    expect(lines.find((l) => l.key === "nuevo_saldo")?.amountCents).toBe(1000000);
  });
  test("saldo previo desconocido (cargando/error): sobrante neutral, sin 'Nuevo saldo a favor' ni saldo final", () => {
    const lines = buildIndividualFundingSummary({ installmentAmountCents: CUOTA, surchargeCents: 0, plan: surplusPlan("110000") });
    expect(lines.filter((l) => ["cancela_deuda", "nuevo_saldo", "sobrante", "saldo_final"].includes(l.key)).map((l) => [l.label, l.amountCents]))
      .toEqual([["Sobrante a cuenta corriente", 1000000]]);
  });
  test("deuda previa + deuda nueva: el saldo final las suma", () => {
    const p = computeIndividualFundingPreview({ targetCents: CUOTA, splits: [createBatchSplitRow("efectivo", "70000")], creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: true });
    if (!p.ok) throw new Error(p.errorMessage);
    const final = buildIndividualFundingSummary({ installmentAmountCents: CUOTA, surchargeCents: 0, plan: p.plan, priorBalanceCents: -1000000 }).find((l) => l.key === "saldo_final");
    expect([final?.label, final?.amountCents]).toEqual(["Saldo final de la cuenta (deudor)", 4000000]);
  });
});

describe("payload, huella e idempotencia", () => {
  const params = {
    policyId: 3, installmentId: 9, paymentDate: "2028-02-01", splits: [createBatchSplitRow("efectivo", "70000")], notes: "  nota  ",
    applyProntoPagoSurcharge: true, creditAppliedCents: 0, roundingCoverageCents: 0, debtAuthorized: false, debtReason: "ignorado", idempotencyKey: "k1",
  };
  test("nunca incluye titular ni importe; motivo null sin deuda; notas recortadas", () => {
    const p = buildAccountFundedPaymentPayload(params);
    expect("accountHolderInsuredId" in p).toBe(false);
    expect("amount" in p).toBe(false);
    expect(p.debtReason).toBeNull();
    expect(p.notes).toBe("nota");
    expect(p.splits).toEqual([{ method: "efectivo", amount: 70000 }]);
    expect("confirmPossibleDuplicates" in p).toBe(false);
    expect(buildAccountFundedPaymentPayload({ ...params, debtAuthorized: true, debtReason: " x " }).debtReason).toBe("x");
  });
  test("la huella ignora clave y confirmación de cheque duplicado, cambia con datos económicos", () => {
    const a = computeIndividualFundingFingerprint(buildAccountFundedPaymentPayload(params));
    expect(computeIndividualFundingFingerprint(buildAccountFundedPaymentPayload({ ...params, idempotencyKey: "otra", confirmPossibleDuplicates: true }))).toBe(a);
    expect(computeIndividualFundingFingerprint(buildAccountFundedPaymentPayload({ ...params, paymentDate: "2028-02-02" }))).not.toBe(a);
    expect(computeIndividualFundingFingerprint(buildAccountFundedPaymentPayload({ ...params, creditAppliedCents: 1 }))).not.toBe(a);
  });
  test("la clave se reutiliza mientras la huella no cambie; si cambia, se genera otra", () => {
    let n = 0;
    const gen = () => `key-${++n}`;
    const first = resolveIdempotencyKey(state(), "fp-1", gen);
    expect(first.key).toBe("key-1");
    const retry = resolveIdempotencyKey(first.state, "fp-1", gen);
    expect(retry.key).toBe("key-1");
    const changed = resolveIdempotencyKey(retry.state, "fp-2", gen);
    expect(changed.key).toBe("key-2");
  });
});

describe("presentación en el listado", () => {
  const row = {
    kind: "individual_account_funded" as const, batchId: 1, batchStatus: "confirmado",
    totalCancelledCents: CUOTA, realReceivedCents: 7000000, creditAppliedCents: 0, newDebtCents: 3000000, newCreditCents: 0, roundingCoveredCents: 0,
  };
  test("saldo deudor, medios reales y total cancelado; omite lo que vale 0", () => {
    expect(describeIndividualAccountFundingRow(row).map((l) => [l.label, l.amountCents]))
      .toEqual([["Saldo deudor", 3000000], ["Medios reales", 7000000], ["Total cancelado", CUOTA]]);
  });
  test("el sobrante se rotula neutro en el listado (pudo cancelar deuda previa)", () => {
    expect(describeIndividualAccountFundingRow({ ...row, newDebtCents: 0, newCreditCents: 1000000 }).map((l) => l.label))
      .toEqual(["Sobrante a cuenta corriente", "Medios reales", "Total cancelado"]);
  });
  test("saldo aplicado sin medios reales", () => {
    expect(describeIndividualAccountFundingRow({ ...row, creditAppliedCents: CUOTA, newDebtCents: 0, realReceivedCents: 0 }).map((l) => l.label))
      .toEqual(["Saldo aplicado", "Medios reales", "Total cancelado"]);
  });
});

// Caso del smoke test de producción: cuota $143.014,24, un único medio
// (efectivo por el total) y $13.845,60 de saldo a favor.
describe("saldo aplicado con un único medio real (rebalanceo)", () => {
  const TOTAL = 14301424;
  const SALDO = 1384560;
  const efectivo = (amount: string) => [createBatchSplitRow("efectivo", amount)];
  const INVALID_TEXT = /--|—|NaN|Infinity|-\s?\$|\$\s?-/;

  test("143.014,24 de cuota y 13.845,60 de saldo: el efectivo queda en 129.168,64 y el plan cierra sin sobrante", () => {
    const splits = rebalanceSingleSplitForCredit(efectivo("143014.24"), TOTAL, SALDO);
    expect(splits[0]!.amount).toBe("129168.64");
    const p = computeIndividualFundingPreview({
      targetCents: TOTAL, splits, creditAppliedCents: SALDO, roundingCoverageCents: 0, availableCreditCents: SALDO, debtAuthorized: false,
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.plan.creditAppliedCents + p.plan.realSplitsTotalCents).toBe(TOTAL);
    expect(p.plan.newSaldoAFavorCents).toBe(0);
    expect(p.plan.newSaldoDeudorCents).toBe(0);
  });

  test("'Aplicar saldo máximo' con el efectivo cubriendo todo ofrece el saldo disponible (antes daba 0)", () => {
    expect(maxApplicableCreditCents({ availableCreditCents: SALDO, targetCents: TOTAL, splits: efectivo("143014.24") })).toBe(SALDO);
  });

  test("saldo mayor que la cuota: saldo aplicado = cuota y el medio queda en 0 (cuenta como cero medios reales)", () => {
    const credit = maxApplicableCreditCents({ availableCreditCents: 20000000, targetCents: TOTAL, splits: efectivo("143014.24") });
    expect(credit).toBe(TOTAL);
    const splits = rebalanceSingleSplitForCredit(efectivo("143014.24"), TOTAL, credit);
    expect(splits[0]!.amount).toBe("0.00");
    expect(effectiveFundingSplits(splits)).toEqual([]);
    expect(validateIndividualFundingSplits(TOTAL, effectiveFundingSplits(splits), credit).valid).toBe(true);
    const payload = buildAccountFundedPaymentPayload({
      policyId: 1, installmentId: 2, paymentDate: "2026-10-08", splits: effectiveFundingSplits(splits), notes: null,
      applyProntoPagoSurcharge: true, creditAppliedCents: credit, roundingCoverageCents: 0, debtAuthorized: false, debtReason: "", idempotencyKey: "k",
    });
    expect(payload.splits).toEqual([]);
    expect(payload.creditAppliedCents).toBe(TOTAL);
  });

  test("Pronto Pago con saldo parcial: el medio cubre cuota + recargo − saldo", () => {
    const target = individualFundingTargetCents(TOTAL, individualFundingSurchargeCents({ isRivadavia: true, applyProntoPagoSurcharge: true, splits: efectivo("143014.24") }));
    expect(target).toBe(TOTAL + 80000);
    const splits = rebalanceSingleSplitForCredit(efectivo("143014.24"), target, SALDO);
    expect(splits[0]!.amount).toBe("129968.64");
    const p = computeIndividualFundingPreview({ targetCents: target, splits, creditAppliedCents: SALDO, roundingCoverageCents: 0, availableCreditCents: SALDO, debtAuthorized: false });
    expect(p.ok && p.plan.creditAppliedCents + p.plan.realSplitsTotalCents).toBe(target);
  });

  test("escritura manual progresiva del saldo mantiene saldo + medio = total en cada paso", () => {
    let splits = efectivo("143014.24");
    for (const input of ["1", "13", "138", "1384", "13845", "13845.6"]) {
      const credit = Math.round(Number(input) * 100);
      splits = rebalanceSingleSplitForCredit(splits, TOTAL, credit);
      expect(Math.round(Number(splits[0]!.amount) * 100) + credit).toBe(TOTAL);
    }
    // Borrar el saldo vuelve a cubrir el total con el medio.
    expect(rebalanceSingleSplitForCredit(splits, TOTAL, 0)[0]!.amount).toBe("143014.24");
  });

  test("nunca produce importes negativos; sin cambios devuelve el mismo array", () => {
    expect(rebalanceSingleSplitForCredit(efectivo("1"), TOTAL, TOTAL + 5000)[0]!.amount).toBe("0.00");
    const same = efectivo("129168.64");
    expect(rebalanceSingleSplitForCredit(same, TOTAL, SALDO)).toBe(same);
  });

  test("varios medios o un cheque: nunca se alteran", () => {
    const multi = [createBatchSplitRow("efectivo", "100000"), createBatchSplitRow("transferencia", "43014.24")];
    expect(rebalanceSingleSplitForCredit(multi, TOTAL, SALDO)).toBe(multi);
    const cheque = [createBatchSplitRow("cheque", "143014.24")];
    expect(rebalanceSingleSplitForCredit(cheque, TOTAL, SALDO)).toBe(cheque);
  });

  test("varios medios con sobrepago: indica cuánto redistribuir, sin '--', NaN, Infinity ni máximos negativos", () => {
    const multi = [createBatchSplitRow("efectivo", "100000"), createBatchSplitRow("transferencia", "43014.24")];
    const p = computeIndividualFundingPreview({ targetCents: TOTAL, splits: multi, creditAppliedCents: SALDO, roundingCoverageCents: 0, availableCreditCents: SALDO, debtAuthorized: false });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    const msg = p.errorMessage.replace(/ /g, " ");
    expect(msg).toContain("Redistribuí los medios reales para que sumen $ 129.168,64");
    expect(msg).toContain("reducilos en $ 13.845,60");
    expect(msg).not.toMatch(INVALID_TEXT);
  });

  test("un medio sin rebalancear (editado a mano después) o saldo > total: mensajes claros y sin texto inválido", () => {
    const single = computeIndividualFundingPreview({ targetCents: TOTAL, splits: efectivo("143014.24"), creditAppliedCents: SALDO, roundingCoverageCents: 0, availableCreditCents: SALDO, debtAuthorized: false });
    expect(!single.ok && single.errorMessage.replace(/ /g, " ")).toContain("El medio de pago debe ser $ 129.168,64");
    const over = computeIndividualFundingPreview({ targetCents: TOTAL, splits: [], creditAppliedCents: TOTAL + 100, roundingCoverageCents: 0, availableCreditCents: 20000000, debtAuthorized: false });
    expect(!over.ok && over.errorMessage.replace(/ /g, " ")).toContain("Aplicá como máximo $ 143.014,24");
    for (const r of [single, over]) expect(!r.ok && r.errorMessage).not.toMatch(INVALID_TEXT);
  });

  test("redondeo o deuda armados a propósito: no se rebalancea", () => {
    expect(shouldRebalanceSingleFundingSplit(state({ creditAppliedInput: "13845.60" }), efectivo("143014.24"))).toBe(true);
    expect(shouldRebalanceSingleFundingSplit(state({ creditAppliedInput: "13845.60", roundingCoverageInput: "2" }), efectivo("1"))).toBe(false);
    expect(shouldRebalanceSingleFundingSplit(state({ debtAuthorized: true, debtReason: "x" }), efectivo("1"))).toBe(false);
    expect(shouldRebalanceSingleFundingSplit(state({ creditAppliedInput: "abc" }), efectivo("1"))).toBe(false);
    expect(shouldRebalanceSingleFundingSplit({ ...state(), enabled: false }, efectivo("1"))).toBe(false);
  });
});
