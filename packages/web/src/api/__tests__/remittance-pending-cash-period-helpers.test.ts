// Tests puros de src/lib/payments/remittance-pending-cash-period.ts — sin DB.
// Ejecutar con: bun test packages/web/src/api/__tests__/remittance-pending-cash-period-helpers.test.ts
import { describe, test, expect } from "bun:test";
import {
  decideCashPeriodPending, buildCashPeriodPendingItem, excludeCashPeriodChildren,
  CASH_PERIOD_PENDING_BLOCKED_MESSAGES, type CashPeriodPendingSource,
} from "../../lib/payments/remittance-pending-cash-period";

function src(overrides: Partial<CashPeriodPendingSource> = {}): CashPeriodPendingSource {
  return {
    paymentBatchId: 70,
    cashPeriodPaymentId: 7,
    status: "confirmado",
    rendered: 0,
    policyId: 11,
    rebillingId: null,
    nominalAmountCents: 40000000,
    cashAmountCents: 38000000,
    discountAmountCents: 2000000,
    batch: { status: "confirmado", paymentDate: "2027-06-15", totalReceivedCents: 38000000, receivedAmountCents: 38000000, notes: null },
    splits: [{ method: "efectivo", amountCents: 38000000, notes: null, checks: [] }],
    children: [1, 2, 3, 4].map((n) => ({ paymentId: 100 + n, status: "confirmado", rendered: 0 })),
    policyNumber: "POL-1",
    insuredName: "Asegurado",
    companyName: "Compañía",
    periodStart: "2027-01-01",
    periodEnd: "2027-12-31",
    ...overrides,
  };
}

describe("decideCashPeriodPending", () => {
  test("contado confirmado, sin rendir, consistente → se ofrece", () => {
    expect(decideCashPeriodPending(src())).toEqual({ kind: "offer" });
  });

  test("anulado o ya rendido, con sus hijos acompañando → se omite", () => {
    const allRendered = src().children.map((c) => ({ ...c, rendered: 1 }));
    expect(decideCashPeriodPending(src({ rendered: 1, children: allRendered }))).toEqual({ kind: "hide" });
    const allCancelled = src().children.map((c) => ({ ...c, status: "anulado" }));
    expect(decideCashPeriodPending(src({ status: "anulado", children: allCancelled }))).toEqual({ kind: "hide" });
  });

  test("anulado o rendido pero con alguna cuota cobrada sin rendir → bloqueado (STATE_MISMATCH)", () => {
    expect(decideCashPeriodPending(src({ rendered: 1 }))).toEqual({ kind: "blocked", code: "CASH_PERIOD_STATE_MISMATCH" });
    expect(decideCashPeriodPending(src({ status: "anulado" }))).toEqual({ kind: "blocked", code: "CASH_PERIOD_STATE_MISMATCH" });
  });

  test("lote inexistente o no confirmado → bloqueado", () => {
    expect(decideCashPeriodPending(src({ batch: null })).kind).toBe("blocked");
    expect(decideCashPeriodPending(src({ batch: { ...src().batch!, status: "anulado" } })))
      .toEqual({ kind: "blocked", code: "CASH_PERIOD_BATCH_NOT_CONFIRMED" });
  });

  test("sin hijos, hijo no confirmado, o hijos rendidos a medias → bloqueado con su código", () => {
    expect(decideCashPeriodPending(src({ children: [] }))).toEqual({ kind: "blocked", code: "CASH_PERIOD_NO_CHILDREN" });
    const oneCancelled = src().children.map((c, i) => (i === 0 ? { ...c, status: "anulado" } : c));
    expect(decideCashPeriodPending(src({ children: oneCancelled }))).toEqual({ kind: "blocked", code: "CASH_PERIOD_CHILD_NOT_CONFIRMED" });
    const oneRendered = src().children.map((c, i) => (i === 0 ? { ...c, rendered: 1 } : c));
    expect(decideCashPeriodPending(src({ children: oneRendered }))).toEqual({ kind: "blocked", code: "CASH_PERIOD_CHILDREN_PARTIALLY_RENDERED" });
  });

  test("aplicado distinto del contado → bloqueado (POST /remittances lo rechazaría)", () => {
    expect(decideCashPeriodPending(src({ batch: { ...src().batch!, totalReceivedCents: 40000000 } })))
      .toEqual({ kind: "blocked", code: "CASH_PERIOD_AMOUNT_MISMATCH" });
  });

  test("splits: se comparan con received_amount_cents; total_received solo si received es NULL", () => {
    // Redondeo: recibido 380003, splits 380003 → OK aunque el aplicado sea 380000.
    const rounding = src({
      batch: { ...src().batch!, receivedAmountCents: 38000300 },
      splits: [{ method: "efectivo", amountCents: 38000300, notes: null, checks: [] }],
    });
    expect(decideCashPeriodPending(rounding)).toEqual({ kind: "offer" });
    // Splits que cierran contra el aplicado pero no contra el recibido real → bloqueado.
    expect(decideCashPeriodPending(src({ batch: { ...src().batch!, receivedAmountCents: 38000300 } })))
      .toEqual({ kind: "blocked", code: "CASH_PERIOD_SPLITS_MISMATCH" });
    // received NULL → fallback a total_received.
    expect(decideCashPeriodPending(src({ batch: { ...src().batch!, receivedAmountCents: null } }))).toEqual({ kind: "offer" });
    // received 0 es un valor, nunca se reemplaza por el fallback (sin truthiness).
    expect(decideCashPeriodPending(src({ batch: { ...src().batch!, receivedAmountCents: 0 } })))
      .toEqual({ kind: "blocked", code: "CASH_PERIOD_SPLITS_MISMATCH" });
  });

  test("sin splits, o cheque sin cheques / con cheques que no cierran → bloqueado", () => {
    expect(decideCashPeriodPending(src({ splits: [] }))).toEqual({ kind: "blocked", code: "CASH_PERIOD_SPLITS_MISMATCH" });
    expect(decideCashPeriodPending(src({ splits: [{ method: "cheque", amountCents: 38000000, notes: null, checks: [] }] })))
      .toEqual({ kind: "blocked", code: "CASH_PERIOD_SPLITS_MISMATCH" });
    expect(decideCashPeriodPending(src({ splits: [{ method: "cheque", amountCents: 38000000, notes: null, checks: [{ amountCents: 1 }] }] })))
      .toEqual({ kind: "blocked", code: "CASH_PERIOD_SPLITS_MISMATCH" });
    expect(decideCashPeriodPending(src({ splits: [{ method: "cheque", amountCents: 38000000, notes: null, checks: [{ amountCents: 38000000 }] }] })))
      .toEqual({ kind: "offer" });
  });
});

describe("buildCashPeriodPendingItem", () => {
  test("forma completa del ítem ofrecido", () => {
    expect(buildCashPeriodPendingItem(src())).toEqual({
      source: "payment_batch",
      sourceId: 70,
      paymentBatchId: 70,
      amount: 380000,
      paymentMethod: "efectivo",
      paymentDate: "2027-06-15",
      dueDate: null,
      clientName: "Asegurado",
      policyNumber: "POL-1",
      companyName: "Compañía",
      notes: null,
      hasSurcharge: false,
      splits: [{ method: "efectivo", amountCents: 38000000, notes: null }],
      paymentGroup: "own",
      isCashPeriodPayment: true,
      concept: "Pago de contado",
      cashPeriodPayment: {
        id: 7, policyId: 11, rebillingId: null, periodStart: "2027-01-01", periodEnd: "2027-12-31",
        installmentCount: 4, nominalAmountCents: 40000000, discountAmountCents: 2000000,
        cashAmountCents: 38000000, receivedAmountCents: 38000000, hasChecks: false,
      },
      blocked: false,
      blockedCode: null,
      blockedReason: null,
    });
  });

  test("el importe es el aplicado del lote (lo que POST exige), nunca el recibido real ni el nominal", () => {
    const item = buildCashPeriodPendingItem(src({
      batch: { ...src().batch!, receivedAmountCents: 38000300 },
      splits: [{ method: "efectivo", amountCents: 38000300, notes: null, checks: [] }],
    }))!;
    expect(item.amount).toBe(380000);
    expect(item.cashPeriodPayment.receivedAmountCents).toBe(38000300);
  });

  test("medio y grupo desde los splits reales: directo a compañía, combinado y cheque", () => {
    const direct = buildCashPeriodPendingItem(src({ splits: [{ method: "transferencia_compania", amountCents: 38000000, notes: null, checks: [] }] }))!;
    expect(direct.paymentMethod).toBe("transferencia_compania");
    expect(direct.paymentGroup).toBe("direct_company");

    const link = buildCashPeriodPendingItem(src({ splits: [{ method: "link_pago", amountCents: 38000000, notes: null, checks: [] }] }))!;
    expect(link.paymentGroup).toBe("direct_company");

    const combined = buildCashPeriodPendingItem(src({
      splits: [
        { method: "efectivo", amountCents: 18000000, notes: null, checks: [] },
        { method: "transferencia", amountCents: 20000000, notes: null, checks: [] },
      ],
    }))!;
    expect(combined.paymentMethod).toBe("combinado");
    expect(combined.paymentGroup).toBe("own");

    const cheque = buildCashPeriodPendingItem(src({ splits: [{ method: "cheque", amountCents: 38000000, notes: null, checks: [{ amountCents: 38000000 }] }] }))!;
    expect(cheque.paymentMethod).toBe("cheque");
    expect(cheque.paymentGroup).toBe("own");
    expect(cheque.cashPeriodPayment.hasChecks).toBe(true);
  });

  test("bloqueado: código y mensaje estables, visible (no null)", () => {
    const oneRendered = src().children.map((c, i) => (i === 0 ? { ...c, rendered: 1 } : c));
    const item = buildCashPeriodPendingItem(src({ children: oneRendered }))!;
    expect(item.blocked).toBe(true);
    expect(item.blockedCode).toBe("CASH_PERIOD_CHILDREN_PARTIALLY_RENDERED");
    expect(item.blockedReason).toBe(CASH_PERIOD_PENDING_BLOCKED_MESSAGES.CASH_PERIOD_CHILDREN_PARTIALLY_RENDERED);
  });

  test("bloqueado sin lote: no revienta y usa el contado como importe", () => {
    const item = buildCashPeriodPendingItem(src({ batch: null }))!;
    expect(item.blocked).toBe(true);
    expect(item.amount).toBe(380000);
    expect(item.paymentDate).toBeNull();
  });

  test("anulado/rendido consistente → null (no se lista)", () => {
    const allRendered = src().children.map((c) => ({ ...c, rendered: 1 }));
    expect(buildCashPeriodPendingItem(src({ rendered: 1, children: allRendered }))).toBeNull();
  });

  test("todos los códigos tienen mensaje", () => {
    for (const msg of Object.values(CASH_PERIOD_PENDING_BLOCKED_MESSAGES)) expect(msg.length).toBeGreaterThan(0);
  });
});

describe("excludeCashPeriodChildren", () => {
  test("saca solo los hijos de contados; standalone y lotes normales quedan", () => {
    const rows = [
      { id: 1, batchId: null },
      { id: 2, batchId: 70 },
      { id: 3, batchId: 70 },
      { id: 4, batchId: 80 },
    ];
    expect(excludeCashPeriodChildren(rows, new Set([70])).map((r) => r.id)).toEqual([1, 4]);
    expect(excludeCashPeriodChildren(rows, new Set()).map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });
});
