/**
 * Tests del helper puro de payment_batches (Etapa 4A). Sin DB, sin HTTP —
 * src/lib/payments/batches.ts. Complementa payment-batches.test.ts (que
 * ejercita estos mismos helpers a través del endpoint real).
 */

import { test, expect, describe } from "bun:test";
import {
  normalizeBatchItems, normalizeBatchSplits, validateSameInsured, validateInstallmentsEligibility,
  calculateBaseAmountCents, resolveBatchSplitGroup, calculateApplicableRivadaviaSurcharges,
  calculateBatchTotals, validateBatchTotals, validateBatchStatusTransition,
  PaymentBatchValidationError, BATCH_MIXED_GROUP_ERROR, SURCHARGE_AMOUNT_CENTS,
  type BatchInstallmentContext,
} from "../../lib/payments/batches";

function ctx(overrides: Partial<BatchInstallmentContext>): BatchInstallmentContext {
  return {
    installmentId: 1, policyId: 1, insuredId: 1, amount: 1000,
    installmentStatus: "pendiente", policyStatus: "activa", isRivadavia: false,
    ...overrides,
  };
}

describe("normalizeBatchItems", () => {
  test("rechaza array vacío", () => {
    expect(() => normalizeBatchItems([])).toThrow(PaymentBatchValidationError);
  });
  test("rechaza installmentId repetido", () => {
    expect(() => normalizeBatchItems([{ installmentId: 5 }, { installmentId: 5 }])).toThrow(/repetida/);
  });
  test("rechaza installmentId inválido", () => {
    expect(() => normalizeBatchItems([{ installmentId: 0 }])).toThrow(PaymentBatchValidationError);
    expect(() => normalizeBatchItems([{ installmentId: -1 }])).toThrow(PaymentBatchValidationError);
  });
  test("acepta varios ids distintos, preserva el orden", () => {
    const result = normalizeBatchItems([{ installmentId: 3 }, { installmentId: 1 }, { installmentId: 2 }]);
    expect(result.map(r => r.installmentId)).toEqual([3, 1, 2]);
  });
});

describe("normalizeBatchSplits", () => {
  test("rechaza array vacío", () => {
    expect(() => normalizeBatchSplits([])).toThrow(PaymentBatchValidationError);
  });
  test("rechaza método no permitido", () => {
    expect(() => normalizeBatchSplits([{ method: "bitcoin", amount: 100 }])).toThrow(PaymentBatchValidationError);
  });
  test("rechaza 'lote' y 'combinado' como método individual", () => {
    expect(() => normalizeBatchSplits([{ method: "lote", amount: 100 }])).toThrow(PaymentBatchValidationError);
    expect(() => normalizeBatchSplits([{ method: "combinado", amount: 100 }])).toThrow(PaymentBatchValidationError);
  });
  test("rechaza importe <= 0", () => {
    expect(() => normalizeBatchSplits([{ method: "efectivo", amount: 0 }])).toThrow(PaymentBatchValidationError);
    expect(() => normalizeBatchSplits([{ method: "efectivo", amount: -5 }])).toThrow(PaymentBatchValidationError);
  });
  test("rechaza más de dos decimales reales", () => {
    expect(() => normalizeBatchSplits([{ method: "efectivo", amount: 100.567 }])).toThrow(PaymentBatchValidationError);
  });
  test("normaliza correctamente a centavos, preservando notes", () => {
    const result = normalizeBatchSplits([{ method: "cheque", amount: 1234.56, notes: "  cheque nro 1  " }]);
    expect(result).toEqual([{ method: "cheque", amountCents: 123456, notes: "cheque nro 1" }]);
  });
});

describe("validateSameInsured", () => {
  test("no lanza si todos son del mismo insuredId", () => {
    expect(() => validateSameInsured([ctx({ insuredId: 7 }), ctx({ insuredId: 7 })])).not.toThrow();
  });
  test("lanza si hay un insuredId distinto", () => {
    expect(() => validateSameInsured([ctx({ insuredId: 7, installmentId: 1 }), ctx({ insuredId: 8, installmentId: 2 })]))
      .toThrow(/mismo asegurado/);
  });
  test("array vacío no lanza (caso trivial)", () => {
    expect(() => validateSameInsured([])).not.toThrow();
  });
});

describe("validateInstallmentsEligibility", () => {
  test("rechaza cuota pagada", () => {
    expect(() => validateInstallmentsEligibility([ctx({ installmentStatus: "pagada" })])).toThrow(/ya está pagada/);
  });
  test("rechaza póliza cancelada", () => {
    expect(() => validateInstallmentsEligibility([ctx({ policyStatus: "cancelada" })])).toThrow(/cancelada/);
  });
  test("acepta pendiente y vencida", () => {
    expect(() => validateInstallmentsEligibility([ctx({ installmentStatus: "pendiente" })])).not.toThrow();
    expect(() => validateInstallmentsEligibility([ctx({ installmentStatus: "vencida" })])).not.toThrow();
  });
});

describe("calculateBaseAmountCents", () => {
  test("suma en centavos sin arrastre de floats", () => {
    const total = calculateBaseAmountCents([ctx({ amount: 333.33 }), ctx({ amount: 333.33 }), ctx({ amount: 333.34 })]);
    expect(total).toBe(100000);
  });
});

describe("resolveBatchSplitGroup", () => {
  test("own para medios propios", () => {
    const splits = normalizeBatchSplits([{ method: "efectivo", amount: 100 }]);
    expect(resolveBatchSplitGroup(splits)).toBe("own");
  });
  test("direct_company para medios directos", () => {
    const splits = normalizeBatchSplits([{ method: "transferencia_compania", amount: 100 }]);
    expect(resolveBatchSplitGroup(splits)).toBe("direct_company");
  });
  test("rechaza mixed con el mensaje esperado", () => {
    const splits = normalizeBatchSplits([{ method: "efectivo", amount: 50 }, { method: "link_pago", amount: 50 }]);
    expect(() => resolveBatchSplitGroup(splits)).toThrow(BATCH_MIXED_GROUP_ERROR);
  });
});

describe("calculateApplicableRivadaviaSurcharges", () => {
  test("cero recargos si el grupo no es 'own'", () => {
    const result = calculateApplicableRivadaviaSurcharges([ctx({ isRivadavia: true, installmentId: 1 })], "direct_company");
    expect(result).toEqual([]);
  });
  test("solo las cuotas Rivadavia generan recargo, el resto no", () => {
    const result = calculateApplicableRivadaviaSurcharges([
      ctx({ isRivadavia: true, installmentId: 1 }),
      ctx({ isRivadavia: false, installmentId: 2 }),
      ctx({ isRivadavia: true, installmentId: 3 }),
    ], "own");
    expect(result).toEqual([1, 3]);
  });
  test("SURCHARGE_AMOUNT_CENTS es $800", () => {
    expect(SURCHARGE_AMOUNT_CENTS).toBe(80000);
  });
});

describe("calculateBatchTotals / validateBatchTotals", () => {
  test("total = base + recargo", () => {
    const totals = calculateBatchTotals(100000, 160000);
    expect(totals).toEqual({ baseAmountCents: 100000, surchargeAmountCents: 160000, totalReceivedCents: 260000 });
  });
  test("splits que suman exacto → válido", () => {
    const totals = calculateBatchTotals(100000, 0);
    const splits = normalizeBatchSplits([{ method: "efectivo", amount: 1000 }]);
    const result = validateBatchTotals(totals, splits);
    expect(result.valid).toBe(true);
    expect(result.errorMessage).toBeNull();
  });
  test("splits que no suman exacto → inválido, con mensaje", () => {
    const totals = calculateBatchTotals(100000, 0);
    const splits = normalizeBatchSplits([{ method: "efectivo", amount: 900 }]);
    const result = validateBatchTotals(totals, splits);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("no coincide");
  });
});

describe("validateBatchStatusTransition", () => {
  test("confirmado → anulado es válida", () => {
    expect(() => validateBatchStatusTransition("confirmado", "anulado")).not.toThrow();
  });
  test("anulado es terminal — no puede volver a confirmado", () => {
    expect(() => validateBatchStatusTransition("anulado", "confirmado")).toThrow(PaymentBatchValidationError);
  });
});
