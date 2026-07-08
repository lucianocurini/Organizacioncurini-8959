/**
 * Tests de los helpers puros de remittance_allocations (Etapa 4C) —
 * src/lib/payments/remittance-allocations.ts. Sin DB, sin red — solo lógica.
 */

import { test, expect, describe } from "bun:test";
import {
  resolveStandalonePaymentInstruments, resolveBatchInstruments, resolveCashEntryInstrument,
  buildRemittanceAllocations, validateAllocationOwnership, validateAllocationTotals,
  calculateExpectedCollectedCents, classifyRemittanceAllocationState, assertCompletePaymentBatches,
  RemittanceAllocationValidationError,
} from "../../lib/payments/remittance-allocations";

describe("resolveStandalonePaymentInstruments", () => {
  test("pago simple: un split -> un instrumento", () => {
    const instruments = resolveStandalonePaymentInstruments({
      remittanceItemId: 10, paymentId: 3,
      splits: [{ id: 5, method: "efectivo", amountCents: 100000 }],
    });
    expect(instruments).toEqual([
      { kind: "payment_split", remittanceItemId: 10, paymentId: 3, paymentSplitId: 5, method: "efectivo", amountCents: 100000 },
    ]);
  });

  test("pago combinado: N splits -> N instrumentos, todos con el mismo remittanceItemId", () => {
    const instruments = resolveStandalonePaymentInstruments({
      remittanceItemId: 10, paymentId: 3,
      splits: [
        { id: 5, method: "efectivo", amountCents: 60000 },
        { id: 6, method: "transferencia", amountCents: 40000 },
      ],
    });
    expect(instruments.length).toBe(2);
    expect(instruments.every((i) => i.remittanceItemId === 10)).toBe(true);
    expect(instruments.reduce((s, i) => s + i.amountCents, 0)).toBe(100000);
  });

  test("rechaza un pago sin ningún payment_split real", () => {
    expect(() => resolveStandalonePaymentInstruments({ remittanceItemId: 10, paymentId: 3, splits: [] }))
      .toThrow(RemittanceAllocationValidationError);
  });
});

describe("resolveBatchInstruments", () => {
  test("split no-cheque -> un instrumento por split completo", () => {
    const instruments = resolveBatchInstruments({
      paymentBatchId: 7,
      splits: [{ id: 1, method: "transferencia", amountCents: 280000, checks: [] }],
    });
    expect(instruments).toEqual([
      { kind: "batch_split", paymentBatchId: 7, paymentBatchSplitId: 1, method: "transferencia", amountCents: 280000 },
    ]);
  });

  test("split cheque con un cheque -> un instrumento por cheque", () => {
    const instruments = resolveBatchInstruments({
      paymentBatchId: 7,
      splits: [{ id: 2, method: "cheque", amountCents: 100000, checks: [{ id: 55, amountCents: 100000 }] }],
    });
    expect(instruments).toEqual([
      { kind: "batch_split_check", paymentBatchId: 7, paymentBatchSplitId: 2, receivedCheckId: 55, amountCents: 100000 },
    ]);
  });

  test("split cheque con varios cheques -> un instrumento por cada uno", () => {
    const instruments = resolveBatchInstruments({
      paymentBatchId: 7,
      splits: [{
        id: 2, method: "cheque", amountCents: 200000,
        checks: [{ id: 55, amountCents: 120000 }, { id: 56, amountCents: 80000 }],
      }],
    });
    expect(instruments.length).toBe(2);
    expect(instruments.map((i: any) => i.receivedCheckId).sort()).toEqual([55, 56]);
  });

  test("varios splits mezclados (cheque + no cheque) -> instrumentos combinados correctamente", () => {
    const instruments = resolveBatchInstruments({
      paymentBatchId: 7,
      splits: [
        { id: 1, method: "transferencia", amountCents: 100000, checks: [] },
        { id: 2, method: "cheque", amountCents: 50000, checks: [{ id: 55, amountCents: 50000 }] },
      ],
    });
    expect(instruments.length).toBe(2);
    expect(instruments[0]!.kind).toBe("batch_split");
    expect(instruments[1]!.kind).toBe("batch_split_check");
  });

  test("split cheque sin ningún received_check real -> rechaza", () => {
    expect(() => resolveBatchInstruments({
      paymentBatchId: 7,
      splits: [{ id: 2, method: "cheque", amountCents: 100000, checks: [] }],
    })).toThrow(RemittanceAllocationValidationError);
  });

  test("suma de cheques distinta al importe del split -> rechaza", () => {
    expect(() => resolveBatchInstruments({
      paymentBatchId: 7,
      splits: [{ id: 2, method: "cheque", amountCents: 100000, checks: [{ id: 55, amountCents: 90000 }] }],
    })).toThrow(/no coincide con su importe/);
  });
});

describe("resolveCashEntryInstrument", () => {
  test("produce un único instrumento con los datos reales", () => {
    const instrument = resolveCashEntryInstrument({ remittanceItemId: 20, cashEntryId: 9, method: "efectivo", amountCents: 80000 });
    expect(instrument).toEqual({ kind: "cash_entry", remittanceItemId: 20, cashEntryId: 9, method: "efectivo", amountCents: 80000 });
  });
});

describe("buildRemittanceAllocations", () => {
  test("traduce cada tipo de instrumento a su AllocationDraft correspondiente", () => {
    const drafts = buildRemittanceAllocations([
      { kind: "payment_split", remittanceItemId: 1, paymentId: 2, paymentSplitId: 3, method: "efectivo", amountCents: 1000 },
      { kind: "batch_split", paymentBatchId: 4, paymentBatchSplitId: 5, method: "transferencia", amountCents: 2000 },
      { kind: "batch_split_check", paymentBatchId: 4, paymentBatchSplitId: 6, receivedCheckId: 7, amountCents: 3000 },
      { kind: "cash_entry", remittanceItemId: 8, cashEntryId: 9, method: "efectivo", amountCents: 4000 },
    ]);
    expect(drafts).toEqual([
      { remittanceItemId: 1, paymentId: 2, paymentSplitId: 3, paymentBatchId: null, paymentBatchSplitId: null, receivedCheckId: null, cashEntryId: null, method: "efectivo", amountCents: 1000 },
      { remittanceItemId: null, paymentId: null, paymentSplitId: null, paymentBatchId: 4, paymentBatchSplitId: 5, receivedCheckId: null, cashEntryId: null, method: "transferencia", amountCents: 2000 },
      { remittanceItemId: null, paymentId: null, paymentSplitId: null, paymentBatchId: 4, paymentBatchSplitId: 6, receivedCheckId: 7, cashEntryId: null, method: "cheque", amountCents: 3000 },
      { remittanceItemId: 8, paymentId: null, paymentSplitId: null, paymentBatchId: null, paymentBatchSplitId: null, receivedCheckId: null, cashEntryId: 9, method: "efectivo", amountCents: 4000 },
    ]);
  });
});

describe("validateAllocationOwnership", () => {
  test("no lanza cuando el payment_split pertenece al pago esperado", () => {
    expect(() => validateAllocationOwnership(
      [{ kind: "payment_split", remittanceItemId: 1, paymentId: 3, paymentSplitId: 5, method: "efectivo", amountCents: 1000 }],
      { paymentId: 3 }
    )).not.toThrow();
  });

  test("lanza cuando el payment_split pertenece a otro pago", () => {
    expect(() => validateAllocationOwnership(
      [{ kind: "payment_split", remittanceItemId: 1, paymentId: 999, paymentSplitId: 5, method: "efectivo", amountCents: 1000 }],
      { paymentId: 3 }
    )).toThrow(RemittanceAllocationValidationError);
  });

  test("lanza cuando el payment_batch_split pertenece a otro batch", () => {
    expect(() => validateAllocationOwnership(
      [{ kind: "batch_split", paymentBatchId: 999, paymentBatchSplitId: 5, method: "efectivo", amountCents: 1000 }],
      { paymentBatchId: 7 }
    )).toThrow(RemittanceAllocationValidationError);
  });
});

describe("validateAllocationTotals / calculateExpectedCollectedCents", () => {
  test("suma exacta -> valid", () => {
    const expected = calculateExpectedCollectedCents([{ kind: "standalone_payment", amountCents: 100000 }]);
    const result = validateAllocationTotals([{ amountCents: 100000 }], expected);
    expect(result.valid).toBe(true);
  });

  test("diferencia de un centavo -> inválida (sin tolerancia)", () => {
    const expected = calculateExpectedCollectedCents([{ kind: "standalone_payment", amountCents: 100000 }]);
    const result = validateAllocationTotals([{ amountCents: 99999 }], expected);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toMatch(/no coincide/);
  });

  test("no depende de totalPaid: expectedCollectedCents se arma solo con instrumentos reales", () => {
    // Una rendición con manual_debt de $8000 y un pago real de $3000 declarado
    // en totalPaid=$11000 (igual que en los datos históricos de dev.db) —
    // expectedCollectedCents debe ser $3000, nunca $11000.
    const expected = calculateExpectedCollectedCents([{ kind: "standalone_payment", amountCents: 300000 }]);
    expect(expected).toBe(300000);
    const result = validateAllocationTotals([{ amountCents: 300000 }], expected);
    expect(result.valid).toBe(true);
  });

  test("batch: se cuenta una sola vez aunque haya varios pagos hijos", () => {
    // Simula lo que hace el endpoint: agrega el batch a collectedSources UNA
    // sola vez sin importar cuántos remittance_items (uno por hijo) lo referencien.
    const expected = calculateExpectedCollectedCents([{ kind: "batch", amountCents: 280000 }]);
    expect(expected).toBe(280000);
  });

  test("batch con recargo Pronto Pago: no se duplica el cash_entry del recargo", () => {
    // El endpoint NO debe agregar un source "cash_entry" aparte para el
    // recargo de un hijo de batch — el total ya viene una sola vez desde
    // el batch (totalReceivedCents = base + surcharge).
    const expected = calculateExpectedCollectedCents([{ kind: "batch", amountCents: 280000 }]); // base 2000 + surcharge 800
    const allocationsSum = 280000; // allocations del batch, sin allocation aparte del cash_entry
    const result = validateAllocationTotals([{ amountCents: allocationsSum }], expected);
    expect(result.valid).toBe(true);
  });
});

describe("assertCompletePaymentBatches", () => {
  test("no lanza cuando todos los hijos pendientes cobrables están incluidos", () => {
    expect(() => assertCompletePaymentBatches({
      batchId: 1,
      siblings: [
        { id: 10, status: "confirmado", rendered: 0 },
        { id: 11, status: "confirmado", rendered: 0 },
      ],
      includedPaymentIds: new Set([10, 11]),
    })).not.toThrow();
  });

  test("rechaza si falta un hijo pendiente cobrable", () => {
    expect(() => assertCompletePaymentBatches({
      batchId: 1,
      siblings: [
        { id: 10, status: "confirmado", rendered: 0 },
        { id: 11, status: "confirmado", rendered: 0 },
      ],
      includedPaymentIds: new Set([10]),
    })).toThrow(/debe rendirse completo/);
  });

  test("ignora hijos anulados o ya rendidos al exigir completitud", () => {
    expect(() => assertCompletePaymentBatches({
      batchId: 1,
      siblings: [
        { id: 10, status: "confirmado", rendered: 0 },
        { id: 11, status: "anulado", rendered: 0 },
        { id: 12, status: "confirmado", rendered: 1 },
      ],
      includedPaymentIds: new Set([10]),
    })).not.toThrow();
  });

  test("rechaza si se incluye un hijo anulado", () => {
    expect(() => assertCompletePaymentBatches({
      batchId: 1,
      siblings: [{ id: 10, status: "anulado", rendered: 0 }],
      includedPaymentIds: new Set([10]),
    })).toThrow(/anulado/);
  });

  test("rechaza si se incluye un hijo ya rendido", () => {
    expect(() => assertCompletePaymentBatches({
      batchId: 1,
      siblings: [{ id: 10, status: "confirmado", rendered: 1 }],
      includedPaymentIds: new Set([10]),
    })).toThrow(/ya rendido/);
  });
});

describe("classifyRemittanceAllocationState", () => {
  test("legacy: sin allocations y no creada bajo el modelo nuevo", () => {
    expect(classifyRemittanceAllocationState({
      allocationCount: 0, allocationSumCents: 0, expectedCollectedCents: 300000, createdUnderAllocationsModel: false,
    })).toBe("legacy");
  });

  test("complete: rendición nueva compuesta solo por manual_debt/no cobrada -> expected=0 y count=0", () => {
    expect(classifyRemittanceAllocationState({
      allocationCount: 0, allocationSumCents: 0, expectedCollectedCents: 0, createdUnderAllocationsModel: true,
    })).toBe("complete");
  });

  test("inconsistent: rendición nueva sin allocations pero con dinero real esperado", () => {
    expect(classifyRemittanceAllocationState({
      allocationCount: 0, allocationSumCents: 0, expectedCollectedCents: 300000, createdUnderAllocationsModel: true,
    })).toBe("inconsistent");
  });

  test("complete: con allocations y suma exacta", () => {
    expect(classifyRemittanceAllocationState({
      allocationCount: 1, allocationSumCents: 300000, expectedCollectedCents: 300000, createdUnderAllocationsModel: true,
    })).toBe("complete");
  });

  test("inconsistent: con allocations pero suma distinta", () => {
    expect(classifyRemittanceAllocationState({
      allocationCount: 1, allocationSumCents: 100000, expectedCollectedCents: 300000, createdUnderAllocationsModel: true,
    })).toBe("inconsistent");
  });
});
