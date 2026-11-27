// Contado por período en "Cobrar en lote" (Migración 0037) — helpers puros del carrito,
// del payload, del comprobante y de la rendición. Sin DOM, sin red.
import { test, expect, describe } from "bun:test";
import {
  type BatchCartItem, type CashPeriodCandidateForCart, type PendingInstallmentForPayment, type PaymentBatchDetailItem,
  addCashPeriodToCart, getCashPeriodRowState, addInstallmentToCart, getInstallmentRowState, calculateCartTotal,
  estimateProntoPagoSurchargeCents, calculateBatchTargetAmountCents, buildPaymentBatchPayload, cartItemKey,
  cartCashPeriodItem, buildBatchReceiptRows, createBatchSplitRow, removeFromCart,
} from "../payment-batch-form";
import { isMixedCashPeriodPendingItem, attachRendicionMethod } from "../rendicion-pending";

const candidate = (over: Partial<CashPeriodCandidateForCart> = {}): CashPeriodCandidateForCart => ({
  policyId: 1, policyNumber: "SYN-1", insuredId: 10, insuredName: "Asegurado Uno", companyId: 100, companyName: "Compañía A",
  rebillingId: 9, cashPaymentAmountCents: 2700000, nominalAmountCents: 3000000, installmentCount: 3, eligible: true, ...over,
});
const installment = (over: Partial<PendingInstallmentForPayment> = {}): PendingInstallmentForPayment => ({
  installmentId: 50, policyId: 2, policyNumber: "SYN-2", policyType: "automotor", parentPolicyId: null, parentPolicyNumber: null,
  insuredId: 20, insuredName: "Asegurado Dos", companyId: 200, companyName: "Compañía B", installmentNumber: 1,
  dueDate: "2028-02-01", amount: 5000, status: "pendiente", rebillingId: null, ...over,
});

describe("carrito con contado del período", () => {
  test("agrega el contado por su importe de contado y lo suma al total", () => {
    let cart: BatchCartItem[] = [];
    cart = addCashPeriodToCart(cart, candidate()).cart;
    cart = addInstallmentToCart(cart, installment()).cart;
    cart = addInstallmentToCart(cart, installment({ installmentId: 51 })).cart;
    expect(calculateCartTotal(cart)).toBe(37000);
    expect(cartCashPeriodItem(cart)?.amount).toBe(27000);
    expect(cartItemKey(cartCashPeriodItem(cart)!)).toBe("cash-period-1-9");
  });

  test("una cuota del período no se puede agregar suelta si el contado está en el carrito", () => {
    const cart = addCashPeriodToCart([], candidate()).cart;
    const own = installment({ installmentId: 60, policyId: 1, rebillingId: 9 });
    expect(getInstallmentRowState(own, cart).addable).toBe(false);
    expect(addInstallmentToCart(cart, own).error).toMatch(/contado del período/);
    // Una cuota de OTRO período de la misma póliza sí.
    expect(getInstallmentRowState(installment({ installmentId: 61, policyId: 1, rebillingId: null }), cart).addable).toBe(true);
  });

  test("el contado no se agrega si ya hay cuotas sueltas del período, otro contado, o no es elegible", () => {
    const withLoose = addInstallmentToCart([], installment({ installmentId: 60, policyId: 1, rebillingId: 9 })).cart;
    expect(getCashPeriodRowState(candidate(), withLoose).addable).toBe(false);
    const withCash = addCashPeriodToCart([], candidate()).cart;
    expect(getCashPeriodRowState(candidate({ policyId: 3, rebillingId: null }), withCash).reason).toMatch(/un solo contado/);
    expect(getCashPeriodRowState(candidate(), withCash).alreadyInCart).toBe(true);
    expect(getCashPeriodRowState(candidate({ eligible: false, ineligibleReasons: ["La cuota 7 ya está pagada."] }), []).reason).toBe("La cuota 7 ya está pagada.");
    // Quitar el contado vuelve a permitir las cuotas.
    const removed = removeFromCart(withCash, "cash-period-1-9");
    expect(removed.length).toBe(0);
  });

  test("recargo estimado: el contado nunca suma, las cuotas comunes Rivadavia sí", () => {
    let cart: BatchCartItem[] = addCashPeriodToCart([], candidate({ companyName: "Rivadavia Seguros" })).cart;
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(0);
    cart = addInstallmentToCart(cart, installment({ companyName: "Rivadavia Seguros" })).cart;
    const onlyCommon = addInstallmentToCart([], installment({ companyName: "Rivadavia Seguros" })).cart;
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(estimateProntoPagoSurchargeCents(onlyCommon));
    const target = calculateBatchTargetAmountCents(cart, [createBatchSplitRow("efectivo", "1")]);
    expect(target).toBe(3200000 + estimateProntoPagoSurchargeCents(onlyCommon));
  });

  test("payload: el contado viaja sin importe, como source cash_period", () => {
    let cart: BatchCartItem[] = addCashPeriodToCart([], candidate()).cart;
    cart = addInstallmentToCart(cart, installment()).cart;
    const payload = buildPaymentBatchPayload({
      paymentDate: "2028-02-01", cart, splits: [{ ...createBatchSplitRow("cheque", "32000"), checks: [] }],
    });
    expect(payload.items).toEqual([
      { source: "cash_period", policyId: 1, rebillingId: 9 },
      { source: "installment", installmentId: 50 },
    ]);
    expect("accountDifferenceResolution" in payload).toBe(false);
  });
});

describe("comprobante del lote", () => {
  const item = (id: number, amount: number, cashPeriodPaymentId: number | null, number: number): PaymentBatchDetailItem => ({
    payment: {
      id, amount, policyId: 1, installmentId: id, paymentDate: "2028-02-01", status: "confirmado", notes: null,
      manualPayer: null, manualPolicyNumber: null, manualCompany: null, cashPeriodPaymentId,
    },
    installment: { id, number, dueDate: "2028-02-01", amount },
    policy: { id: 1, policyNumber: "SYN-1" }, company: { id: 100, name: "Compañía A" }, insured: { id: 10, name: "Asegurado Uno" },
  });

  test("las cuotas del contado se muestran como UNA partida por el importe de contado", () => {
    const rows = buildBatchReceiptRows(
      [item(1, 10000, 7, 1), item(2, 10000, 7, 2), item(3, 10000, 7, 3), item(4, 5000, null, 1)],
      { id: 7, policyId: 1, rebillingId: 9, nominalAmountCents: 3000000, cashAmountCents: 2700000, discountAmountCents: 300000, status: "confirmado", rendered: 0 },
    );
    expect(rows.length).toBe(2);
    expect(rows[0]!.kind).toBe("cash_period");
    expect(rows[0]!.amountCents).toBe(2700000);
    expect(rows[0]!.label).toMatch(/Refacturación #9/);
    expect(rows[1]!.kind).toBe("item");
    expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(3200000);
  });

  test("sin contado, el comprobante es el de siempre", () => {
    const rows = buildBatchReceiptRows([item(4, 5000, null, 1)], null);
    expect(rows.map((r) => r.kind)).toEqual(["item"]);
  });
});

describe("rendición del contado de un lote mixto", () => {
  test("se reconoce como mixto y viaja con el medio de rendición elegido", () => {
    const mixed = { source: "payment_batch", cashPeriodPayment: { mixedBatch: true } };
    const pure = { source: "payment_batch", cashPeriodPayment: { mixedBatch: false } };
    expect(isMixedCashPeriodPendingItem(mixed)).toBe(true);
    expect(isMixedCashPeriodPendingItem(pure)).toBe(false);
    const [mixedOut, pureOut] = attachRendicionMethod(
      [{ source: "payment_batch", cashPeriodRealMethod: null }, { source: "payment_batch", cashPeriodRealMethod: "cheque" }],
      "transferencia",
    );
    expect(mixedOut!.paymentMethod).toBe("transferencia");
    expect(pureOut!.paymentMethod).toBe("cheque");
  });
});
