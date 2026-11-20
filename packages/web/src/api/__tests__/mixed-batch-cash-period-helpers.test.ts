// Tests puros (sin DB) del contado por período en un lote mixto — Migración 0037.
import { describe, test, expect } from "bun:test";
import { apportionCashPeriodChildrenCents, isMixedCashPeriodBatch } from "../../lib/payments/cash-period-payments";
import { normalizeBatchItems, PaymentBatchValidationError, CASH_PERIOD_ITEM_LIMIT_ERROR } from "../../lib/payments/batches";
import { canonicalizeFundingRequest, FundingRequestFingerprintInputError } from "../../lib/payments/account-holder-funding-fingerprint";

describe("apportionCashPeriodChildrenCents", () => {
  test("reparte el contado en proporción al nominal, sin drift", () => {
    const m = apportionCashPeriodChildrenCents(2700000, [
      { paymentId: 3, nominalCents: 1000000 }, { paymentId: 1, nominalCents: 1000000 }, { paymentId: 2, nominalCents: 1000000 },
    ]);
    expect([...m.values()].reduce((s, v) => s + v, 0)).toBe(2700000);
    expect(m.get(1)).toBe(900000);
    expect(m.get(2)).toBe(900000);
    expect(m.get(3)).toBe(900000);
  });

  test("centavos indivisibles: suma exacta y resultado independiente del orden de entrada", () => {
    const children = [{ paymentId: 10, nominalCents: 333333 }, { paymentId: 11, nominalCents: 333333 }, { paymentId: 12, nominalCents: 333334 }];
    const a = apportionCashPeriodChildrenCents(1000001, children);
    const b = apportionCashPeriodChildrenCents(1000001, [...children].reverse());
    expect([...a.values()].reduce((s, v) => s + v, 0)).toBe(1000001);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  test("nominales desiguales: proporcional", () => {
    const m = apportionCashPeriodChildrenCents(900000, [{ paymentId: 1, nominalCents: 500000 }, { paymentId: 2, nominalCents: 500000 }, { paymentId: 3, nominalCents: 0 }]);
    expect(m.get(3)).toBe(0);
    expect(m.get(1)! + m.get(2)!).toBe(900000);
  });

  test("isMixedCashPeriodBatch: mixto si algún hijo no es del contado", () => {
    expect(isMixedCashPeriodBatch([{ cashPeriodPaymentId: 7 }, { cashPeriodPaymentId: 7 }])).toBe(false);
    expect(isMixedCashPeriodBatch([{ cashPeriodPaymentId: 7 }, { cashPeriodPaymentId: null }])).toBe(true);
  });
});

describe("normalizeBatchItems — source cash_period", () => {
  test("emisión (rebillingId null) y refacturación", () => {
    expect(normalizeBatchItems([{ source: "cash_period", policyId: 5, rebillingId: null } as any]))
      .toEqual([{ source: "cash_period", policyId: 5, rebillingId: null }]);
    expect(normalizeBatchItems([{ source: "cash_period", policyId: 5, rebillingId: 9 } as any, { source: "installment", installmentId: 3 }]))
      .toEqual([{ source: "cash_period", policyId: 5, rebillingId: 9 }, { source: "installment", installmentId: 3 }]);
  });

  test("rechaza ids inválidos, un importe en el ítem y más de un contado", () => {
    expect(() => normalizeBatchItems([{ source: "cash_period", policyId: 0, rebillingId: null } as any])).toThrow(PaymentBatchValidationError);
    expect(() => normalizeBatchItems([{ source: "cash_period", policyId: 5, rebillingId: -1 } as any])).toThrow(PaymentBatchValidationError);
    expect(() => normalizeBatchItems([{ source: "cash_period", policyId: 5, rebillingId: null, amount: 100 } as any])).toThrow(/no admite importe/);
    expect(() => normalizeBatchItems([
      { source: "cash_period", policyId: 5, rebillingId: null } as any,
      { source: "cash_period", policyId: 6, rebillingId: 2 } as any,
    ])).toThrow(CASH_PERIOD_ITEM_LIMIT_ERROR);
  });
});

describe("canonicalizeFundingRequest — ítem cash_period", () => {
  const base = {
    paymentDate: "2028-02-01", accountHolderInsuredId: null, splits: [{ method: "efectivo", amountCents: 100, notes: null, checks: [] }],
    notes: null, applyProntoPagoSurcharge: true, accountDifferenceResolution: null,
    creditAppliedCents: 0, roundingCoverageCents: 0, debtAuthorized: false, debtReason: null,
  };
  test("acepta el ítem y distingue emisión de refacturación en la huella", () => {
    const a = canonicalizeFundingRequest({ ...base, items: [{ source: "cash_period", policyId: 5, rebillingId: null }] } as any, { endpoint: "POST /payment-batches" } as any);
    const b = canonicalizeFundingRequest({ ...base, items: [{ source: "cash_period", policyId: 5, rebillingId: 9 }] } as any, { endpoint: "POST /payment-batches" } as any);
    expect(typeof a).toBe("string");
    expect(a).not.toBe(b);
  });
  test("rechaza claves extra en el ítem", () => {
    expect(() => canonicalizeFundingRequest({ ...base, items: [{ source: "cash_period", policyId: 5, rebillingId: null, amountCents: 1 }] } as any, { endpoint: "POST /payment-batches" } as any))
      .toThrow(FundingRequestFingerprintInputError);
  });
});
