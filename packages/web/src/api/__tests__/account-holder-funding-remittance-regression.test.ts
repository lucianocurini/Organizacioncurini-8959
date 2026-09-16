/**
 * Etapa 1B-3-D — regresión de Rendiciones: confirma, con instrumentos
 * reales (nunca sintéticos/heurísticos), que un batch del modo titular
 * (accountHolderInsuredId != null) se puede rendir EXACTAMENTE igual que un
 * batch legacy — sin ningún cambio en remittance-allocations.ts (no
 * reescrito, no tocado en esta etapa).
 *
 * No hace falta DB: resolveBatchInstruments/resolveBatchChildPaymentInstrument/
 * resolveCashEntryInstrument/buildRemittanceAllocations/
 * validateAllocationOwnership/calculateExpectedCollectedCents/
 * validateAllocationTotals/classifyRemittanceAllocationState son TODAS
 * funciones puras que reciben snapshots ya resueltos — ninguna de ellas
 * conoce ni acepta accountHolderInsuredId en su firma (confirmado leyendo el
 * archivo completo): estructuralmente no pueden distinguir un batch titular
 * de uno legacy, la única diferencia entre los dos escenarios de cada test
 * pareado de abajo es cosmética (ids/nombres), nunca de comportamiento.
 */

import { test, expect, describe } from "bun:test";
import {
  resolveBatchInstruments,
  resolveBatchChildPaymentInstrument,
  resolveCashEntryInstrument,
  buildRemittanceAllocations,
  validateAllocationOwnership,
  calculateExpectedCollectedCents,
  validateAllocationTotals,
  classifyRemittanceAllocationState,
  RemittanceAllocationValidationError,
  type BatchSplitRow,
  type CollectedAmountSource,
} from "../../lib/payments/remittance-allocations";

// ─── 1. Rendición de un batch COMPLETO (todos sus hijos a la vez) ─────────

describe("1. batch completo — titular rinde igual que legacy", () => {
  function runBatchScenario(paymentBatchId: number, totalReceivedCents: number, splits: BatchSplitRow[]) {
    const instruments = resolveBatchInstruments({ paymentBatchId, splits });
    validateAllocationOwnership(instruments, { paymentBatchId });
    const drafts = buildRemittanceAllocations(instruments);
    const sources: CollectedAmountSource[] = [{ kind: "batch", amountCents: totalReceivedCents }];
    const expectedCollectedCents = calculateExpectedCollectedCents(sources);
    const totalCheck = validateAllocationTotals(instruments, expectedCollectedCents);
    const state = classifyRemittanceAllocationState({
      allocationCount: drafts.length,
      allocationSumCents: drafts.reduce((s, d) => s + d.amountCents, 0),
      expectedCollectedCents,
      createdUnderAllocationsModel: true,
    });
    return { instruments, drafts, totalCheck, state };
  }

  test("batch legacy (splits efectivo+transferencia): completo, sin inconsistencias", () => {
    const result = runBatchScenario(501, 100000, [
      { id: 1, method: "efectivo", amountCents: 60000, checks: [] },
      { id: 2, method: "transferencia", amountCents: 40000, checks: [] },
    ]);
    expect(result.totalCheck.valid).toBe(true);
    expect(result.state).toBe("complete");
    expect(result.drafts).toHaveLength(2);
  });

  test("batch TITULAR (mismos splits, otro id): resultado byte-a-byte equivalente al legacy — solo cambia paymentBatchId", () => {
    const result = runBatchScenario(9501, 100000, [
      { id: 1, method: "efectivo", amountCents: 60000, checks: [] },
      { id: 2, method: "transferencia", amountCents: 40000, checks: [] },
    ]);
    expect(result.totalCheck.valid).toBe(true);
    expect(result.state).toBe("complete");
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts.every((d) => d.paymentBatchId === 9501)).toBe(true);
  });

  test("batch titular con cheques: mismo tratamiento de instrumento-por-cheque que un batch legacy", () => {
    const splits: BatchSplitRow[] = [
      { id: 10, method: "cheque", amountCents: 50000, checks: [{ id: 100, amountCents: 30000 }, { id: 101, amountCents: 20000 }] },
    ];
    const result = runBatchScenario(9502, 50000, splits);
    expect(result.instruments).toHaveLength(2);
    expect(result.instruments.every((i) => i.kind === "batch_split_check")).toBe(true);
    expect(result.state).toBe("complete");
  });

  test("cheques de un batch titular que no cierran contra el split: RemittanceAllocationValidationError, igual que legacy", () => {
    const splits: BatchSplitRow[] = [
      { id: 11, method: "cheque", amountCents: 50000, checks: [{ id: 102, amountCents: 10000 }] }, // no cierra
    ];
    expect(() => resolveBatchInstruments({ paymentBatchId: 9503, splits })).toThrow(RemittanceAllocationValidationError);
  });

  test("ownership: instrumentos de OTRO batch (titular) nunca pasan validateAllocationOwnership — mismo chequeo defensivo que legacy", () => {
    const instruments = resolveBatchInstruments({
      paymentBatchId: 9504,
      splits: [{ id: 20, method: "efectivo", amountCents: 1000, checks: [] }],
    });
    expect(() => validateAllocationOwnership(instruments, { paymentBatchId: 9999 })).toThrow(RemittanceAllocationValidationError);
  });
});

// ─── 2. Rendición POR CUOTA — un solo hijo de un batch (Migración 0029) ───

describe("2. rendición por cuota — hijo de batch titular se rinde igual que hijo de batch legacy", () => {
  function runChildScenario(paymentBatchId: number, paymentId: number, amountCents: number, method: string) {
    const instrument = resolveBatchChildPaymentInstrument({ remittanceItemId: 1, paymentId, paymentBatchId, method, amountCents });
    const drafts = buildRemittanceAllocations([instrument]);
    const expectedCollectedCents = calculateExpectedCollectedCents([{ kind: "batch_child_payment", amountCents }]);
    const totalCheck = validateAllocationTotals([instrument], expectedCollectedCents);
    return { instrument, drafts, totalCheck };
  }

  test("hijo de batch legacy: instrumento batch_child_payment, cierra exacto", () => {
    const result = runChildScenario(601, 6001, 25000, "efectivo");
    expect(result.instrument.kind).toBe("batch_child_payment");
    expect(result.totalCheck.valid).toBe(true);
    expect(result.drafts[0]).toMatchObject({ paymentId: 6001, paymentBatchId: 601, method: "efectivo", amountCents: 25000 });
  });

  test("hijo de batch TITULAR: mismo resultado exacto, solo cambia el id del batch — nunca distingue el modelo", () => {
    const result = runChildScenario(9601, 6001, 25000, "efectivo");
    expect(result.instrument.kind).toBe("batch_child_payment");
    expect(result.totalCheck.valid).toBe(true);
    expect(result.drafts[0]).toMatchObject({ paymentId: 6001, paymentBatchId: 9601, method: "efectivo", amountCents: 25000 });
  });

  test("hijo de batch titular con recargo Pronto Pago (cash_entry) propio: se resuelve igual que el de un batch legacy", () => {
    const childInstrument = resolveBatchChildPaymentInstrument({ remittanceItemId: 2, paymentId: 6002, paymentBatchId: 9602, method: "transferencia", amountCents: 40000 });
    const surchargeInstrument = resolveCashEntryInstrument({ remittanceItemId: 3, cashEntryId: 700, method: "pronto_pago", amountCents: 800 });
    const drafts = buildRemittanceAllocations([childInstrument, surchargeInstrument]);
    const expectedCollectedCents = calculateExpectedCollectedCents([
      { kind: "batch_child_payment", amountCents: 40000 },
      { kind: "cash_entry", amountCents: 800 },
    ]);
    const totalCheck = validateAllocationTotals([childInstrument, surchargeInstrument], expectedCollectedCents);
    expect(totalCheck.valid).toBe(true);
    expect(drafts).toHaveLength(2);
    expect(drafts.find((d) => d.cashEntryId === 700)).toMatchObject({ method: "pronto_pago", amountCents: 800 });
  });
});

// ─── 3. Clasificación histórica — un batch titular puede quedar "legacy"/"inconsistent" con las mismas reglas ───

describe("3. classifyRemittanceAllocationState — mismas reglas sin importar el origen del dinero", () => {
  test("0 allocations, no creado bajo el modelo nuevo: legacy (aplica igual a datos históricos de cualquier origen)", () => {
    const state = classifyRemittanceAllocationState({
      allocationCount: 0, allocationSumCents: 0, expectedCollectedCents: 50000, createdUnderAllocationsModel: false,
    });
    expect(state).toBe("legacy");
  });

  test("suma de instrumentos titulares que no cierra contra expectedCollectedCents: inconsistent, mismo criterio que legacy", () => {
    const state = classifyRemittanceAllocationState({
      allocationCount: 1, allocationSumCents: 40000, expectedCollectedCents: 50000, createdUnderAllocationsModel: true,
    });
    expect(state).toBe("inconsistent");
  });

  test("0 allocations bajo el modelo nuevo con expectedCollectedCents=0 (batch titular 100% deuda/no cobrado): complete", () => {
    const state = classifyRemittanceAllocationState({
      allocationCount: 0, allocationSumCents: 0, expectedCollectedCents: 0, createdUnderAllocationsModel: true,
    });
    expect(state).toBe("complete");
  });
});
