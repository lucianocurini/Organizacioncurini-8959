import { test, expect, describe } from "bun:test";
import {
  type PendingInstallmentForPayment, type BatchSplitFormRow, type BatchCartItem,
  type ManualPaymentFormState, type PaymentBatchDetailItem, type PaymentBatchCancelCheckResponse,
  type BatchDifferenceResolutionFormState, type BatchDetailAccountMovement, type PaymentBatchDetail,
  type BatchDetailAmountAdjustment,
  summarizeCartInsureds, calculateCartTotal, getInstallmentRowState, addInstallmentToCart, removeFromCart, cartItemKey,
  emptyManualPaymentForm, validateManualPaymentForm, buildManualCartItemFromForm, addManualPaymentToCart,
  estimateProntoPagoSurchargeCents, calculateBatchTargetAmountCents,
  createBatchSplitRow, addBatchSplitRow, removeBatchSplitRow, updateBatchSplitRow,
  syncSingleBatchSplitAmount, addCheckToSplit, removeCheckFromSplit, updateCheckInSplit,
  validateBatchSplitsForm, validateCheckRow, sumCheckRowsCents, amountStringToCentsStrict,
  isBatchSubmitDisabled, buildPaymentBatchPayload, normalizeBatchSubmitError,
  isManualBatchDetailItem, isFreeformManualBatchDetailItem, describeBatchDetailItem, batchDetailItemInsuredLabel,
  describeBatchCancelImpact, canShowCancelButton, canShowEditButton, isCancelConfirmationValid, buildBatchCancelPayload,
  isBatchTrulyCancellable, combinedCancelBlockingReasons,
  emptyBatchEditForm, validateBatchEditForm, buildBatchPatchPayload, BATCH_CORRECTION_HINT,
  MIXED_GROUP_ERROR, SURCHARGE_AMOUNT_CENTS,
  updateSplitMethodPreservingChecks, splitsToPaymentSplitsPayload,
  calculateBatchReceivedAppliedDifference, emptyBatchDifferenceResolutionForm, validateBatchDifferenceResolution,
  buildAccountDifferenceResolutionPayload, receivedCentsOf, findBatchDifferenceResolution, summarizeBatchResolution,
  syncChequeSplitAmounts, isRoundingAdjustmentEligible, buildRoundingAdjustmentPayload,
  validateBatchDifferenceResolutionWithRounding, MAX_ROUNDING_ADJUSTMENT_CENTS,
} from "../payment-batch-form";
import { formatCurrencyCents } from "../utils";

function pendingItem(overrides: Partial<PendingInstallmentForPayment> = {}): PendingInstallmentForPayment {
  return {
    installmentId: 1, policyId: 10, policyNumber: "POL-1",
    policyType: "automotor", parentPolicyId: null, parentPolicyNumber: null,
    insuredId: 100, insuredName: "Juan Pérez", companyId: 200, companyName: "Compañía A",
    installmentNumber: 1, dueDate: "2027-06-01", amount: 1000, status: "pendiente",
    rebillingId: null, ...overrides,
  };
}

function installmentCartItem(overrides: Partial<Extract<BatchCartItem, { kind: "installment" }>> = {}): BatchCartItem {
  return {
    kind: "installment", installmentId: 1, policyId: 10, policyNumber: "POL-1",
    policyType: "automotor", parentPolicyId: null, parentPolicyNumber: null,
    insuredId: 100, insuredName: "Juan Pérez", companyId: 200, companyName: "Compañía A",
    installmentNumber: 1, dueDate: "2027-06-01", amount: 1000, status: "pendiente",
    ...overrides,
  };
}

/** Cobro manual vinculado a una póliza real (source="policy_manual_payment"). */
function policyManualCartItem(overrides: Partial<Extract<BatchCartItem, { kind: "policy_manual_payment" }>> = {}): BatchCartItem {
  return {
    kind: "policy_manual_payment", localId: "manual-test-1", policyId: 20, policyNumber: "POL-2",
    policyType: "automotor", parentPolicyId: null, parentPolicyNumber: null,
    insuredId: 100, insuredName: "Juan Pérez", companyId: 200, companyName: "Compañía A",
    amount: 500, description: "cuota faltante",
    ...overrides,
  };
}

/** Imputación completamente libre (source="manual_payment") — SIEMPRE insuredId/insuredName null. */
function freeManualCartItem(overrides: Partial<Extract<BatchCartItem, { kind: "manual_payment" }>> = {}): BatchCartItem {
  return {
    kind: "manual_payment", localId: "manual-free-1", insuredId: null, insuredName: null,
    manualPayer: "Juan Pérez", manualPolicyNumber: null, manualCompany: null,
    amount: 500, description: "cuota faltante",
    ...overrides,
  };
}

function policyManualForm(overrides: Partial<ManualPaymentFormState> = {}): ManualPaymentFormState {
  return {
    ...emptyManualPaymentForm(),
    linkPolicy: true,
    policyId: "20", policyNumber: "POL-2", policyStatus: "activa",
    policyInsuredId: "100", policyInsuredName: "Juan Pérez", policyCompanyId: "200", policyCompanyName: "Compañía A",
    amount: "500", description: "cuota faltante",
    ...overrides,
  };
}

function freeManualForm(overrides: Partial<ManualPaymentFormState> = {}): ManualPaymentFormState {
  return {
    ...emptyManualPaymentForm(),
    linkPolicy: false,
    manualPayer: "Juan Pérez", manualPolicyNumber: "", manualCompany: "",
    amount: "500", description: "cuota faltante",
    ...overrides,
  };
}

describe("carrito — agregar cuota existente (sin restricción de asegurado)", () => {
  test("carrito vacío: cualquier cuota es agregable", () => {
    const state = getInstallmentRowState(pendingItem(), []);
    expect(state.addable).toBe(true);
  });

  test("addInstallmentToCart agrega la cuota", () => {
    const result = addInstallmentToCart([], pendingItem({ insuredId: 55 }));
    expect(result.error).toBeNull();
    expect(result.cart.length).toBe(1);
  });

  test("agregar una segunda cuota del mismo asegurado funciona", () => {
    const first = addInstallmentToCart([], pendingItem({ insuredId: 100, installmentId: 1 }));
    const second = addInstallmentToCart(first.cart, pendingItem({ insuredId: 100, installmentId: 2, policyId: 20 }));
    expect(second.error).toBeNull();
    expect(second.cart.length).toBe(2);
  });

  test("otro asegurado ya NO queda bloqueado — se agrega igual (caso familiar)", () => {
    const first = addInstallmentToCart([], pendingItem({ insuredId: 100, installmentId: 1 }));
    const second = addInstallmentToCart(first.cart, pendingItem({ insuredId: 999, installmentId: 2 }));
    expect(second.error).toBeNull();
    expect(second.cart.length).toBe(2);
  });

  test("getInstallmentRowState nunca bloquea por asegurado distinto, solo por duplicado", () => {
    const cart = addInstallmentToCart([], pendingItem({ insuredId: 100 })).cart;
    const state = getInstallmentRowState(pendingItem({ insuredId: 999, installmentId: 2 }), cart);
    expect(state.addable).toBe(true);
  });

  test("la misma cuota no se puede agregar dos veces", () => {
    const first = addInstallmentToCart([], pendingItem({ installmentId: 7 }));
    const second = addInstallmentToCart(first.cart, pendingItem({ installmentId: 7 }));
    expect(second.error).not.toBeNull();
    expect(second.cart.length).toBe(1);
    expect(getInstallmentRowState(pendingItem({ installmentId: 7 }), first.cart).alreadyInCart).toBe(true);
  });

  test("varias pólizas y compañías del mismo asegurado son agregables", () => {
    const a = addInstallmentToCart([], pendingItem({ insuredId: 100, policyId: 10, companyId: 200, installmentId: 1 }));
    const b = addInstallmentToCart(a.cart, pendingItem({ insuredId: 100, policyId: 20, companyId: 300, installmentId: 2 }));
    expect(b.error).toBeNull();
    expect(b.cart.length).toBe(2);
  });

  test("3 cuotas de 3 asegurados distintos — caso familiar real, todas se agregan", () => {
    let cart: BatchCartItem[] = [];
    cart = addInstallmentToCart(cart, pendingItem({ insuredId: 100, installmentId: 1 })).cart;
    cart = addInstallmentToCart(cart, pendingItem({ insuredId: 200, installmentId: 2 })).cart;
    cart = addInstallmentToCart(cart, pendingItem({ insuredId: 300, installmentId: 3 })).cart;
    expect(cart.length).toBe(3);
  });
});

describe("carrito — quitar ítem y vaciar", () => {
  test("removeFromCart quita por key, deja el resto intacto", () => {
    const a = installmentCartItem({ installmentId: 1 });
    const b = installmentCartItem({ installmentId: 2 });
    const cart = removeFromCart([a, b], cartItemKey(a));
    expect(cart).toEqual([b]);
  });

  test("vaciar completamente el carrito", () => {
    const cart = removeFromCart([installmentCartItem()], cartItemKey(installmentCartItem()));
    expect(cart.length).toBe(0);
  });
});

describe("summarizeCartInsureds — solo para MOSTRAR, nunca bloquea", () => {
  test("carrito vacío", () => {
    expect(summarizeCartInsureds([]).kind).toBe("empty");
  });
  test("un solo asegurado real → 'single' con su nombre", () => {
    const cart = [installmentCartItem({ insuredId: 100, insuredName: "Juan Pérez" })];
    const summary = summarizeCartInsureds(cart);
    expect(summary.kind).toBe("single");
    expect(summary.label).toBe("Juan Pérez");
  });
  test("dos asegurados reales distintos → 'multiple' / Varios asegurados", () => {
    const cart = [installmentCartItem({ insuredId: 100 }), installmentCartItem({ insuredId: 200 })];
    const summary = summarizeCartInsureds(cart);
    expect(summary.kind).toBe("multiple");
    expect(summary.label).toBe("Varios asegurados");
  });
  test("100% manual_payment (sin ningún asegurado real) → 'manual-only'", () => {
    const cart = [freeManualCartItem()];
    expect(summarizeCartInsureds(cart).kind).toBe("manual-only");
  });
  test("cuota + manual_payment libre (mismo o sin asegurado) → 'single' con el real", () => {
    const cart = [installmentCartItem({ insuredId: 100, insuredName: "Juan Pérez" }), freeManualCartItem()];
    const summary = summarizeCartInsureds(cart);
    expect(summary.kind).toBe("single");
    expect(summary.label).toBe("Juan Pérez");
  });
});

describe("cobro manual con póliza vinculada (linkPolicy=true) — validación", () => {
  test("sin póliza seleccionada → bloqueado", () => {
    const result = validateManualPaymentForm(policyManualForm({ policyId: "" }));
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("Seleccioná una póliza");
  });

  test("póliza cancelada → bloqueado", () => {
    const result = validateManualPaymentForm(policyManualForm({ policyStatus: "cancelada" }));
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("cancelada");
  });

  test("importe inválido (vacío, cero, negativo, 3 decimales) → bloqueado", () => {
    expect(validateManualPaymentForm(policyManualForm({ amount: "" })).valid).toBe(false);
    expect(validateManualPaymentForm(policyManualForm({ amount: "0" })).valid).toBe(false);
    expect(validateManualPaymentForm(policyManualForm({ amount: "-100" })).valid).toBe(false);
    expect(validateManualPaymentForm(policyManualForm({ amount: "100.999" })).valid).toBe(false);
  });

  test("importe válido con dos decimales → aceptado", () => {
    expect(validateManualPaymentForm(policyManualForm({ amount: "1234.56" })).valid).toBe(true);
  });

  test("cualquier asegurado de la póliza real es aceptado — ya no existe 'asegurado fijado'", () => {
    const result = validateManualPaymentForm(policyManualForm({ policyInsuredId: "999" }));
    expect(result.valid).toBe(true);
  });
});

describe("imputación completamente manual (linkPolicy=false) — validación", () => {
  test("sin pagador ni N° de póliza manual → bloqueado", () => {
    const result = validateManualPaymentForm(freeManualForm({ manualPayer: "", manualPolicyNumber: "" }));
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("pagador");
  });

  test("con solo N° de póliza manual (sin pagador) → aceptado", () => {
    const result = validateManualPaymentForm(freeManualForm({ manualPayer: "", manualPolicyNumber: "12345" }));
    expect(result.valid).toBe(true);
  });

  test("con solo pagador (sin N° de póliza) → aceptado", () => {
    const result = validateManualPaymentForm(freeManualForm({ manualPayer: "Juan Pérez", manualPolicyNumber: "" }));
    expect(result.valid).toBe(true);
  });

  test("nunca exige ningún asegurado previo — puede ser el primer ítem de un carrito vacío", () => {
    const result = validateManualPaymentForm(freeManualForm());
    expect(result.valid).toBe(true);
  });

  test("importe inválido → bloqueado", () => {
    const result = validateManualPaymentForm(freeManualForm({ amount: "0" }));
    expect(result.valid).toBe(false);
  });

  test("nunca exige policyId — jamás se pide una póliza real", () => {
    const result = validateManualPaymentForm(freeManualForm({ manualPolicyNumber: "999" }));
    expect(result.valid).toBe(true);
  });
});

describe("cobro manual — agregar al carrito", () => {
  test("con linkPolicy=true agrega un PolicyManualPaymentCartItem con localId estable", () => {
    const result = addManualPaymentToCart([], policyManualForm());
    expect(result.error).toBeNull();
    expect(result.cart.length).toBe(1);
    const added = result.cart[0]!;
    expect(added.kind).toBe("policy_manual_payment");
    expect((added as any).localId).toMatch(/^manual-/);
    expect(added.amount).toBe(500);
  });

  test("con linkPolicy=false agrega un ManualPaymentCartItem libre, sin ningún asegurado", () => {
    const result = addManualPaymentToCart([], freeManualForm());
    expect(result.error).toBeNull();
    expect(result.cart.length).toBe(1);
    const added = result.cart[0]!;
    expect(added.kind).toBe("manual_payment");
    expect(added.insuredId).toBeNull();
    expect((added as any).manualPayer).toBe("Juan Pérez");
  });

  test("linkPolicy=false en un carrito completamente vacío funciona igual (primer ítem 100% manual)", () => {
    const result = addManualPaymentToCart([], freeManualForm());
    expect(result.error).toBeNull();
    expect(result.cart.length).toBe(1);
  });

  test("dos cobros manuales agregados consecutivamente tienen localId distinto", () => {
    const a = buildManualCartItemFromForm(policyManualForm());
    const b = buildManualCartItemFromForm(policyManualForm());
    expect((a as any).localId).not.toBe((b as any).localId);
  });

  test("policy_manual_payment sin póliza no se agrega (bloqueado)", () => {
    const result = addManualPaymentToCart([], policyManualForm({ policyId: "" }));
    expect(result.error).not.toBeNull();
    expect(result.cart.length).toBe(0);
  });

  test("cobro manual con importe inválido no se agrega", () => {
    const result = addManualPaymentToCart([], policyManualForm({ amount: "0" }));
    expect(result.error).not.toBeNull();
    expect(result.cart.length).toBe(0);
  });

  test("policy_manual_payment de un asegurado distinto al resto del carrito se agrega igual (caso familiar)", () => {
    const cart = [installmentCartItem({ insuredId: 100 })];
    const result = addManualPaymentToCart(cart, policyManualForm({ policyInsuredId: "999" }));
    expect(result.error).toBeNull();
    expect(result.cart.length).toBe(2);
  });

  test("manual_payment libre agregado junto a una cuota nunca hereda su insuredId — siempre queda null", () => {
    const cart = [installmentCartItem({ insuredId: 100, insuredName: "Juan Pérez" })];
    const result = addManualPaymentToCart(cart, freeManualForm());
    expect(result.error).toBeNull();
    expect(result.cart.length).toBe(2);
    expect((result.cart[1] as any).insuredId).toBeNull();
  });

  test("mezclar cuota existente + policy_manual_payment de asegurados distintos en un carrito", () => {
    const withInstallment = addInstallmentToCart([], pendingItem({ insuredId: 100 }));
    const withManual = addManualPaymentToCart(withInstallment.cart, policyManualForm({ policyInsuredId: "200" }));
    expect(withManual.error).toBeNull();
    expect(withManual.cart.length).toBe(2);
    expect(withManual.cart.map((i) => i.kind)).toEqual(["installment", "policy_manual_payment"]);
  });

  test("mezclar cuota existente + manual_payment libre", () => {
    const withInstallment = addInstallmentToCart([], pendingItem({ insuredId: 100, insuredName: "Juan Pérez" }));
    const withManual = addManualPaymentToCart(withInstallment.cart, freeManualForm());
    expect(withManual.error).toBeNull();
    expect(withManual.cart.length).toBe(2);
    const added = withManual.cart[1]! as any;
    expect(added.kind).toBe("manual_payment");
    expect(added.insuredId).toBeNull();
  });

  test("caso familiar completo: cuota de A + policy_manual_payment de B + manual_payment libre, todo en un carrito", () => {
    let cart: BatchCartItem[] = [];
    cart = addInstallmentToCart(cart, pendingItem({ insuredId: 100, installmentId: 1 })).cart;
    cart = addManualPaymentToCart(cart, policyManualForm({ policyInsuredId: "200" })).cart;
    cart = addManualPaymentToCart(cart, freeManualForm()).cart;
    expect(cart.length).toBe(3);
    expect(summarizeCartInsureds(cart).kind).toBe("multiple");
  });
});

describe("calculateCartTotal — total mixto", () => {
  test("suma cuotas + manuales (con y sin póliza) en pesos", () => {
    const cart = [installmentCartItem({ amount: 1000 }), policyManualCartItem({ amount: 500 }), freeManualCartItem({ amount: 300 })];
    expect(calculateCartTotal(cart)).toBe(1800);
  });
  test("carrito vacío → total 0", () => {
    expect(calculateCartTotal([])).toBe(0);
  });
});

describe("recargo Pronto Pago estimado", () => {
  test("un ítem Rivadavia (cuota) suma $800 estimados", () => {
    const cart = [installmentCartItem({ companyName: "Rivadavia" })];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(SURCHARGE_AMOUNT_CENTS);
  });
  test("un policy_manual_payment Rivadavia (compañía REAL) también suma $800 estimados", () => {
    const cart = [policyManualCartItem({ companyName: "Rivadavia Seguros" })];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(SURCHARGE_AMOUNT_CENTS);
  });
  test("un manual_payment libre con manualCompany='Rivadavia' NUNCA suma recargo (texto libre, sin fuente confiable)", () => {
    const cart = [freeManualCartItem({ manualCompany: "Rivadavia" })];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(0);
  });
  test("ítems no Rivadavia no suman recargo", () => {
    const cart = [installmentCartItem({ companyName: "Mercantil Andina" })];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(0);
  });
  test("varios ítems Rivadavia (mezcla cuota+policy_manual_payment) suman uno por cada uno, el manual_payment libre no cuenta", () => {
    const cart = [
      installmentCartItem({ companyName: "Rivadavia" }),
      policyManualCartItem({ companyName: "Rivadavia" }),
      freeManualCartItem({ manualCompany: "Rivadavia" }),
    ];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(SURCHARGE_AMOUNT_CENTS * 2);
  });

  test("calculateBatchTargetAmountCents incluye el recargo si el grupo es 'own'", () => {
    const cart = [installmentCartItem({ amount: 1000, companyName: "Rivadavia" })];
    const splits = [createBatchSplitRow("efectivo", "1000")];
    expect(calculateBatchTargetAmountCents(cart, splits)).toBe(100000 + SURCHARGE_AMOUNT_CENTS);
  });
  test("calculateBatchTargetAmountCents NO incluye el recargo si el grupo es direct_company", () => {
    const cart = [installmentCartItem({ amount: 1000, companyName: "Rivadavia" })];
    const splits = [createBatchSplitRow("transferencia_compania", "1000")];
    expect(calculateBatchTargetAmountCents(cart, splits)).toBe(100000);
  });
  test("calculateBatchTargetAmountCents sin splits cargados devuelve solo la base", () => {
    const cart = [installmentCartItem({ amount: 1000, companyName: "Rivadavia" })];
    expect(calculateBatchTargetAmountCents(cart, [])).toBe(100000);
  });

  // ─── Grupo económico Rivadavia + Accidentes de Pasajeros asociada ─────────
  // Mismo criterio que calculateApplicableRivadaviaSurcharges del backend
  // (src/lib/payments/batches.ts) — frontend y backend deben coincidir
  // siempre en el conteo, ver policy-economic-group.ts (fuente única).

  test("A. Rivadavia principal sola → $800", () => {
    const cart = [installmentCartItem({ companyName: "Rivadavia", policyId: 100, policyType: "automotor" })];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(SURCHARGE_AMOUNT_CENTS);
  });

  test("B. principal + accesoria accidentes_pasajeros vinculada (parentPolicyId en el cart) → $800, no $1600", () => {
    // Mismo ejemplo del pedido: principal $78.171 + accesoria $1.300 → recargo único $800.
    const cart = [
      installmentCartItem({ amount: 78171, companyName: "Rivadavia", policyId: 100, policyType: "automotor" }),
      installmentCartItem({
        amount: 1300, companyName: "Rivadavia", policyId: 200,
        policyType: "accidentes_pasajeros", parentPolicyId: 100, installmentId: 2,
      }),
    ];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(SURCHARGE_AMOUNT_CENTS);
    expect(calculateCartTotal(cart)).toBe(79471);
  });

  test("C. dos pólizas Rivadavia independientes → $1600", () => {
    const cart = [
      installmentCartItem({ companyName: "Rivadavia", policyId: 100, policyType: "automotor" }),
      installmentCartItem({ companyName: "Rivadavia", policyId: 300, policyType: "automotor", installmentId: 2 }),
    ];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(SURCHARGE_AMOUNT_CENTS * 2);
  });

  test("D. accesoria sin parentPolicyId → no agrupa, cuenta su propio recargo", () => {
    const cart = [installmentCartItem({
      companyName: "Rivadavia", policyId: 200, policyType: "accidentes_pasajeros", parentPolicyId: null,
    })];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(SURCHARGE_AMOUNT_CENTS);
  });

  test("D. accesoria cuyo parentPolicyId no está en el cart → no agrupa, cuenta su propio recargo", () => {
    const cart = [installmentCartItem({
      companyName: "Rivadavia", policyId: 200, policyType: "accidentes_pasajeros", parentPolicyId: 999,
    })];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(SURCHARGE_AMOUNT_CENTS);
  });

  test("otras compañías (misma forma principal+accesoria) → $0", () => {
    const cart = [
      installmentCartItem({ companyName: "El Norte", policyId: 100, policyType: "automotor" }),
      installmentCartItem({
        companyName: "El Norte", policyId: 200, policyType: "accidentes_pasajeros",
        parentPolicyId: 100, installmentId: 2,
      }),
    ];
    expect(estimateProntoPagoSurchargeCents(cart)).toBe(0);
  });
});

describe("splits — un solo medio autocompleta el total", () => {
  test("con un solo split, syncSingleBatchSplitAmount fija su importe al total", () => {
    const splits = [createBatchSplitRow("efectivo", "0")];
    const synced = syncSingleBatchSplitAmount(splits, "1500");
    expect(synced[0]!.amount).toBe("1500");
  });

  test("con dos o más splits, no autocompleta (reparto manual)", () => {
    let splits = [createBatchSplitRow("efectivo", "1000")];
    splits = addBatchSplitRow(splits, "transferencia");
    const synced = syncSingleBatchSplitAmount(splits, "1500");
    expect(synced).toEqual(splits); // sin cambios
  });

  test("agregar y quitar splits", () => {
    let splits = [createBatchSplitRow("efectivo", "1000")];
    splits = addBatchSplitRow(splits, "transferencia");
    expect(splits.length).toBe(2);
    splits = removeBatchSplitRow(splits, splits[0]!.uid);
    expect(splits.length).toBe(1);
    // no permite eliminar la última fila
    splits = removeBatchSplitRow(splits, splits[0]!.uid);
    expect(splits.length).toBe(1);
  });

  test("updateBatchSplitRow actualiza método/importe preservando checks", () => {
    let splits = [createBatchSplitRow("efectivo", "1000")];
    splits = updateBatchSplitRow(splits, splits[0]!.uid, { method: "transferencia" });
    expect(splits[0]!.method).toBe("transferencia");
    expect(splits[0]!.checks).toEqual([]);
  });
});

describe("validateBatchSplitsForm — métodos propios vs. directos (importe objetivo en centavos)", () => {
  test("mezclar efectivo con transferencia_compania → inválido con el mensaje compartido", () => {
    const splits: BatchSplitFormRow[] = [
      createBatchSplitRow("efectivo", "500"),
      createBatchSplitRow("transferencia_compania", "500"),
    ];
    const result = validateBatchSplitsForm(100000, splits);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe(MIXED_GROUP_ERROR);
  });

  test("dos medios propios combinados (efectivo + transferencia) → válido", () => {
    const splits: BatchSplitFormRow[] = [
      createBatchSplitRow("efectivo", "600"),
      createBatchSplitRow("transferencia", "400"),
    ];
    const result = validateBatchSplitsForm(100000, splits);
    expect(result.valid).toBe(true);
    expect(result.group).toBe("own");
  });

  test("dos medios directos combinados (link_pago + transferencia_compania) → válido", () => {
    const splits: BatchSplitFormRow[] = [
      createBatchSplitRow("link_pago", "600"),
      createBatchSplitRow("transferencia_compania", "400"),
    ];
    const result = validateBatchSplitsForm(100000, splits);
    expect(result.valid).toBe(true);
    expect(result.group).toBe("direct_company");
  });

  test("suma de splits distinta al objetivo → inválido", () => {
    const splits: BatchSplitFormRow[] = [createBatchSplitRow("efectivo", "900")];
    const result = validateBatchSplitsForm(100000, splits);
    expect(result.valid).toBe(false);
  });

  test("objetivo con recargo incluido (ej. $800) exige que los splits sumen ese total, no solo la base", () => {
    const splits: BatchSplitFormRow[] = [createBatchSplitRow("efectivo", "1000")];
    const result = validateBatchSplitsForm(100000 + SURCHARGE_AMOUNT_CENTS, splits);
    expect(result.valid).toBe(false); // faltan los $800 del recargo
    const okSplits: BatchSplitFormRow[] = [createBatchSplitRow("efectivo", "1800")];
    expect(validateBatchSplitsForm(100000 + SURCHARGE_AMOUNT_CENTS, okSplits).valid).toBe(true);
  });
});

// ─── Fase 2E — validateBatchSplitsForm con allowAmountDifference (sobrantes/faltantes) ──

describe("validateBatchSplitsForm — options.allowAmountDifference (Cobrar en lote)", () => {
  test("sin options: sigue exigiendo coincidencia exacta (comportamiento sin cambios)", () => {
    const splits: BatchSplitFormRow[] = [createBatchSplitRow("efectivo", "900")];
    expect(validateBatchSplitsForm(100000, splits).valid).toBe(false);
  });

  test("con allowAmountDifference:true, un faltante en el total ya no bloquea", () => {
    const splits: BatchSplitFormRow[] = [createBatchSplitRow("efectivo", "900")];
    const result = validateBatchSplitsForm(100000, splits, { allowAmountDifference: true });
    expect(result.valid).toBe(true);
  });

  test("con allowAmountDifference:true, un sobrante en el total ya no bloquea", () => {
    const splits: BatchSplitFormRow[] = [createBatchSplitRow("efectivo", "1500")];
    const result = validateBatchSplitsForm(100000, splits, { allowAmountDifference: true });
    expect(result.valid).toBe(true);
  });

  test("con allowAmountDifference:true, un cheque real mayor al target (600) vs cuota (500) es válido — el cheque nunca se achica", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "600")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[0]!.uid, {
      checkNumber: "1", bankName: "Nación", dueDate: "2027-06-01", amount: "600",
    });
    const result = validateBatchSplitsForm(50000, splits, { allowAmountDifference: true });
    expect(result.valid).toBe(true);
  });

  test("con allowAmountDifference:true, el cheque sigue exigiendo que su propia suma cierre exacto contra SU split (nunca se relaja)", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "600")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[0]!.uid, {
      checkNumber: "1", bankName: "Nación", dueDate: "2027-06-01", amount: "550", // no coincide con el split (600)
    });
    const result = validateBatchSplitsForm(50000, splits, { allowAmountDifference: true });
    expect(result.valid).toBe(false);
  });

  test("con allowAmountDifference:true, 'mixed' sigue bloqueando igual que siempre", () => {
    const splits: BatchSplitFormRow[] = [
      createBatchSplitRow("efectivo", "500"), createBatchSplitRow("transferencia_compania", "500"),
    ];
    const result = validateBatchSplitsForm(100000, splits, { allowAmountDifference: true });
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe(MIXED_GROUP_ERROR);
  });
});

// ─── Fase 2E — calculateBatchReceivedAppliedDifference / validateBatchDifferenceResolution ──

describe("calculateBatchReceivedAppliedDifference (re-exportado de insured-account.ts)", () => {
  test("recibido == aplicado → 'exacto'", () => {
    expect(calculateBatchReceivedAppliedDifference(100000, 100000)).toEqual({ kind: "exacto", differenceCents: 0 });
  });
  test("recibido > aplicado → 'saldo_a_favor' (sobrante)", () => {
    const result = calculateBatchReceivedAppliedDifference(150000, 100000);
    expect(result.kind).toBe("saldo_a_favor");
    expect(result.differenceCents).toBe(50000);
  });
  test("recibido < aplicado → 'saldo_deudor' (faltante)", () => {
    const result = calculateBatchReceivedAppliedDifference(80000, 100000);
    expect(result.kind).toBe("saldo_deudor");
    expect(result.differenceCents).toBe(-20000);
  });
});

describe("validateBatchDifferenceResolution", () => {
  function resolution(overrides: Partial<BatchDifferenceResolutionFormState> = {}): BatchDifferenceResolutionFormState {
    return { ...emptyBatchDifferenceResolutionForm(), ...overrides };
  }

  test("sin diferencia ('exacto'): siempre válido, sin importar la resolución ni el carrito", () => {
    const exact = calculateBatchReceivedAppliedDifference(100000, 100000);
    expect(validateBatchDifferenceResolution(exact, resolution(), "multiple").valid).toBe(true);
  });

  test("sobrante sin ninguna acción elegida → inválido, pide elegir saldo a favor", () => {
    const sobrante = calculateBatchReceivedAppliedDifference(150000, 100000);
    const result = validateBatchDifferenceResolution(sobrante, resolution(), "single");
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("Saldo a favor");
  });

  test("sobrante con acción 'saldo_a_favor' → válido, sin necesidad de motivo", () => {
    const sobrante = calculateBatchReceivedAppliedDifference(150000, 100000);
    const result = validateBatchDifferenceResolution(sobrante, resolution({ action: "saldo_a_favor" }), "single");
    expect(result.valid).toBe(true);
  });

  test("sobrante con acción incorrecta ('saldo_deudor') → inválido", () => {
    const sobrante = calculateBatchReceivedAppliedDifference(150000, 100000);
    const result = validateBatchDifferenceResolution(sobrante, resolution({ action: "saldo_deudor" }), "single");
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("no coincide");
  });

  test("faltante sin ninguna acción elegida → inválido, pide elegir saldo deudor", () => {
    const faltante = calculateBatchReceivedAppliedDifference(80000, 100000);
    const result = validateBatchDifferenceResolution(faltante, resolution(), "single");
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("Saldo deudor");
  });

  test("faltante con acción correcta pero SIN motivo → inválido (motivo obligatorio)", () => {
    const faltante = calculateBatchReceivedAppliedDifference(80000, 100000);
    const result = validateBatchDifferenceResolution(faltante, resolution({ action: "saldo_deudor", reason: "" }), "single");
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("motivo");
  });

  test("faltante con acción correcta Y motivo → válido", () => {
    const faltante = calculateBatchReceivedAppliedDifference(80000, 100000);
    const result = validateBatchDifferenceResolution(
      faltante, resolution({ action: "saldo_deudor", reason: "cheque rechazado parcialmente" }), "single",
    );
    expect(result.valid).toBe(true);
  });

  test("carrito 'multiple' (varios asegurados) → siempre inválido aunque haya acción y motivo", () => {
    const faltante = calculateBatchReceivedAppliedDifference(80000, 100000);
    const result = validateBatchDifferenceResolution(
      faltante, resolution({ action: "saldo_deudor", reason: "motivo" }), "multiple",
    );
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("único asegurado real");
  });

  test("carrito 'manual-only' (100% manual, sin asegurado real) → siempre inválido", () => {
    const sobrante = calculateBatchReceivedAppliedDifference(150000, 100000);
    const result = validateBatchDifferenceResolution(sobrante, resolution({ action: "saldo_a_favor" }), "manual-only");
    expect(result.valid).toBe(false);
  });

  test("carrito 'empty' → inválido (no hay ningún asegurado que identificar)", () => {
    const sobrante = calculateBatchReceivedAppliedDifference(150000, 100000);
    expect(validateBatchDifferenceResolution(sobrante, resolution({ action: "saldo_a_favor" }), "empty").valid).toBe(false);
  });
});

describe("buildAccountDifferenceResolutionPayload", () => {
  test("action null → null (nada que mandar)", () => {
    expect(buildAccountDifferenceResolutionPayload(emptyBatchDifferenceResolutionForm())).toBeNull();
  });
  test("saldo_a_favor sin motivo → reason null", () => {
    const payload = buildAccountDifferenceResolutionPayload({ action: "saldo_a_favor", reason: "" });
    expect(payload).toEqual({ action: "saldo_a_favor", reason: null });
  });
  test("saldo_deudor con motivo → reason recortado", () => {
    const payload = buildAccountDifferenceResolutionPayload({ action: "saldo_deudor", reason: "  cheque menor  " });
    expect(payload).toEqual({ action: "saldo_deudor", reason: "cheque menor" });
  });
});

describe("buildPaymentBatchPayload — accountDifferenceResolution (Fase 2E)", () => {
  test("sin accountDifferenceResolution: la clave no aparece en el payload (importe exacto, comportamiento sin cambios)", () => {
    const payload = buildPaymentBatchPayload({
      paymentDate: "2027-06-01",
      cart: [installmentCartItem({ amount: 1000 })],
      splits: [createBatchSplitRow("efectivo", "1000")],
    });
    expect("accountDifferenceResolution" in payload).toBe(false);
  });

  test("accountDifferenceResolution: null explícito → tampoco se incluye la clave", () => {
    const payload = buildPaymentBatchPayload({
      paymentDate: "2027-06-01",
      cart: [installmentCartItem({ amount: 1000 })],
      splits: [createBatchSplitRow("efectivo", "1000")],
      accountDifferenceResolution: null,
    });
    expect("accountDifferenceResolution" in payload).toBe(false);
  });

  test("con sobrante resuelto: se incluye exactamente {action, reason}", () => {
    const payload = buildPaymentBatchPayload({
      paymentDate: "2027-06-01",
      cart: [installmentCartItem({ amount: 500 })],
      splits: [createBatchSplitRow("efectivo", "600")],
      accountDifferenceResolution: { action: "saldo_a_favor", reason: null },
    });
    expect(payload.accountDifferenceResolution).toEqual({ action: "saldo_a_favor", reason: null });
  });

  test("con faltante resuelto: incluye el motivo tal cual se lo pasaron", () => {
    const payload = buildPaymentBatchPayload({
      paymentDate: "2027-06-01",
      cart: [installmentCartItem({ amount: 500 })],
      splits: [createBatchSplitRow("efectivo", "400")],
      accountDifferenceResolution: { action: "saldo_deudor", reason: "cheque rechazado parcialmente" },
    });
    expect(payload.accountDifferenceResolution).toEqual({ action: "saldo_deudor", reason: "cheque rechazado parcialmente" });
  });
});

describe("cheques — obligatorios y validados por split método=cheque", () => {
  test("split cheque sin ningún cheque cargado → inválido", () => {
    const splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "1000")];
    const result = validateBatchSplitsForm(100000, splits);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("al menos un cheque");
  });

  test("validateCheckRow exige número, banco y vencimiento", () => {
    const base = { uid: "c1", checkNumber: "", bankName: "", bankCode: "", drawerName: "", drawerDocument: "", issueDate: "", dueDate: "", amount: "1000", currency: "ARS", notes: "" };
    expect(validateCheckRow(base).valid).toBe(false);
    expect(validateCheckRow({ ...base, checkNumber: "123" }).valid).toBe(false); // falta banco
    expect(validateCheckRow({ ...base, checkNumber: "123", bankName: "Nación" }).valid).toBe(false); // falta vencimiento
    expect(validateCheckRow({ ...base, checkNumber: "123", bankName: "Nación", dueDate: "2027-06-01" }).valid).toBe(true);
  });

  test("varios cheques en un mismo split — suma debe igualar el importe del split", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "1000")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = addCheckToSplit(splits, splits[0]!.uid);
    const [c1, c2] = splits[0]!.checks;
    splits = updateCheckInSplit(splits, splits[0]!.uid, c1!.uid, { checkNumber: "1", bankName: "Nación", dueDate: "2027-06-01", amount: "600" });
    splits = updateCheckInSplit(splits, splits[0]!.uid, c2!.uid, { checkNumber: "2", bankName: "Galicia", dueDate: "2027-06-01", amount: "400" });

    expect(sumCheckRowsCents(splits[0]!.checks)).toBe(100000); // 1000.00 en centavos
    const result = validateBatchSplitsForm(100000, splits);
    expect(result.valid).toBe(true);
  });

  test("suma de cheques distinta al importe del split → inválido con mensaje de diferencia", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "1000")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    const c1 = splits[0]!.checks[0]!;
    splits = updateCheckInSplit(splits, splits[0]!.uid, c1.uid, { checkNumber: "1", bankName: "Nación", dueDate: "2027-06-01", amount: "600" });
    const result = validateBatchSplitsForm(100000, splits);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("Faltan distribuir");
  });

  test("removeCheckFromSplit no permite quitar el último cheque de un split cheque", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "1000")];
    splits = addCheckToSplit(splits, splits[0]!.uid); // 1 cheque
    const onlyCheckUid = splits[0]!.checks[0]!.uid;
    splits = removeCheckFromSplit(splits, splits[0]!.uid, onlyCheckUid);
    expect(splits[0]!.checks.length).toBe(1); // no se pudo quitar
  });
});

describe("isBatchSubmitDisabled", () => {
  test("deshabilitado mientras saving=true, aunque el resto sea válido", () => {
    expect(isBatchSubmitDisabled(true, true, true)).toBe(true);
  });
  test("deshabilitado sin carrito", () => {
    expect(isBatchSubmitDisabled(false, true, false)).toBe(true);
  });
  test("deshabilitado si los splits no son válidos", () => {
    expect(isBatchSubmitDisabled(false, false, true)).toBe(true);
  });
  test("habilitado cuando no está guardando, splits válidos y hay carrito", () => {
    expect(isBatchSubmitDisabled(false, true, true)).toBe(false);
  });
});

describe("buildPaymentBatchPayload — payload discriminado (3 sources), sin insuredId (derivado server-side)", () => {
  test("un ítem installment nunca incluye importe — solo source+installmentId", () => {
    const payload = buildPaymentBatchPayload({
      paymentDate: "2027-06-01",
      cart: [installmentCartItem({ installmentId: 5, amount: 1234 })],
      splits: [createBatchSplitRow("efectivo", "1234")],
    });
    expect(payload.items).toEqual([{ source: "installment", installmentId: 5 }]);
    expect((payload.items[0] as any).amount).toBeUndefined();
    expect((payload as any).insuredId).toBeUndefined();
  });

  test("un ítem policy_manual_payment incluye source+policyId+amount+description", () => {
    const payload = buildPaymentBatchPayload({
      paymentDate: "2027-06-01",
      cart: [policyManualCartItem({ policyId: 42, amount: 777, description: "cuota faltante" })],
      splits: [createBatchSplitRow("efectivo", "777")],
    });
    expect(payload.items).toEqual([{ source: "policy_manual_payment", policyId: 42, amount: 777, description: "cuota faltante" }]);
  });

  test("un ítem manual_payment libre incluye source+manualPayer/manualPolicyNumber/manualCompany+amount+description", () => {
    const payload = buildPaymentBatchPayload({
      paymentDate: "2027-06-01",
      cart: [freeManualCartItem({ manualPayer: "Juan Pérez", manualPolicyNumber: "999", manualCompany: "MAPFRE", amount: 300, description: "pago suelto" })],
      splits: [createBatchSplitRow("efectivo", "300")],
    });
    expect(payload.items).toEqual([{
      source: "manual_payment", manualPayer: "Juan Pérez", manualPolicyNumber: "999", manualCompany: "MAPFRE",
      amount: 300, description: "pago suelto",
    }]);
  });

  test("policy_manual_payment sin descripción manda description: null", () => {
    const payload = buildPaymentBatchPayload({
      paymentDate: "2027-06-01",
      cart: [policyManualCartItem({ description: "" })],
      splits: [createBatchSplitRow("efectivo", "500")],
    });
    expect((payload.items[0] as any).description).toBeNull();
  });

  test("carrito con los 3 sources, de asegurados distintos, produce un array de items en orden", () => {
    const payload = buildPaymentBatchPayload({
      paymentDate: "2027-06-01",
      cart: [
        installmentCartItem({ installmentId: 1, insuredId: 100 }),
        policyManualCartItem({ policyId: 9, insuredId: 200 }),
        freeManualCartItem({ manualPayer: "Juan Pérez" }),
      ],
      splits: [createBatchSplitRow("efectivo", "1500")],
    });
    expect(payload.items).toEqual([
      { source: "installment", installmentId: 1 },
      { source: "policy_manual_payment", policyId: 9, amount: 500, description: "cuota faltante" },
      { source: "manual_payment", manualPayer: "Juan Pérez", manualPolicyNumber: null, manualCompany: null, amount: 500, description: "cuota faltante" },
    ]);
  });

  test("split cheque incluye el array checks con los campos exactos, split no-cheque no lo incluye", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "1000")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[0]!.uid, {
      checkNumber: "999", bankName: "Nación", dueDate: "2027-06-01", amount: "1000",
    });
    const payload = buildPaymentBatchPayload({
      paymentDate: "2027-06-01",
      cart: [installmentCartItem({ amount: 1000 })],
      splits,
    });
    expect(payload.splits[0]!.checks).toBeDefined();
    expect(payload.splits[0]!.checks![0]!.checkNumber).toBe("999");

    const efectivoPayload = buildPaymentBatchPayload({
      paymentDate: "2027-06-01",
      cart: [installmentCartItem({ amount: 1000 })],
      splits: [createBatchSplitRow("efectivo", "1000")],
    });
    expect(efectivoPayload.splits[0]!.checks).toBeUndefined();
  });
});

// ─── Fase 2F — comprobante consistente con sobrantes/faltantes ─────────────

function batchOf(overrides: Partial<PaymentBatchDetail["batch"]> = {}): PaymentBatchDetail["batch"] {
  return {
    id: 1, insuredId: 100, baseAmountCents: 100000, surchargeAmountCents: 0,
    totalReceivedCents: 100000, receivedAmountCents: 100000,
    paymentDate: "2027-06-01", status: "confirmado", notes: null, createdAt: "2027-06-01T00:00:00.000Z",
    cancelledAt: null, cancellationReason: null,
    ...overrides,
  };
}

describe("receivedCentsOf", () => {
  test("batch exacto: devuelve receivedAmountCents (igual a totalReceivedCents)", () => {
    expect(receivedCentsOf(batchOf())).toBe(100000);
  });

  test("sobrante: devuelve receivedAmountCents real, distinto de totalReceivedCents", () => {
    const batch = batchOf({ totalReceivedCents: 100000, receivedAmountCents: 110000 });
    expect(receivedCentsOf(batch)).toBe(110000);
  });

  test("faltante: devuelve receivedAmountCents real, menor a totalReceivedCents", () => {
    const batch = batchOf({ totalReceivedCents: 100000, receivedAmountCents: 90000 });
    expect(receivedCentsOf(batch)).toBe(90000);
  });

  test("batch histórico sin receivedAmountCents (null): fallback seguro a totalReceivedCents", () => {
    const batch = batchOf({ totalReceivedCents: 75000, receivedAmountCents: null });
    expect(receivedCentsOf(batch)).toBe(75000);
    // La diferencia calculada sobre el fallback siempre da "exacto" — nunca inventa un sobrante/faltante inexistente.
    expect(calculateBatchReceivedAppliedDifference(receivedCentsOf(batch), batch.totalReceivedCents).kind).toBe("exacto");
  });
});

describe("findBatchDifferenceResolution", () => {
  function movement(overrides: Partial<BatchDetailAccountMovement> = {}): BatchDetailAccountMovement {
    return { id: 1, insuredId: 100, type: "saldo_a_favor", signedAmountCents: 10000, status: "activo", reason: null, ...overrides };
  }

  test("sin movimientos → null (batch exacto, nunca tuvo diferencia)", () => {
    expect(findBatchDifferenceResolution([])).toBeNull();
  });

  test("con un movimiento saldo_a_favor → lo encuentra con su motivo", () => {
    const result = findBatchDifferenceResolution([movement({ type: "saldo_a_favor", reason: "cheque redondeado" })]);
    expect(result).toEqual({ action: "saldo_a_favor", reason: "cheque redondeado", status: "activo" });
  });

  test("con un movimiento saldo_deudor → lo encuentra, reason puede ser null si no vino", () => {
    const result = findBatchDifferenceResolution([movement({ type: "saldo_deudor", reason: null })]);
    expect(result).toEqual({ action: "saldo_deudor", reason: null, status: "activo" });
  });

  test("movimiento anulado (batch cancelado después) → status se preserva como 'anulado'", () => {
    const result = findBatchDifferenceResolution([movement({ status: "anulado" })]);
    expect(result?.status).toBe("anulado");
  });

  test("ignora otros tipos de movimiento que no son la resolución de diferencia (defensivo)", () => {
    const result = findBatchDifferenceResolution([
      movement({ id: 1, type: "ajuste_manual" as any }),
      movement({ id: 2, type: "saldo_deudor" }),
    ]);
    expect(result?.action).toBe("saldo_deudor");
  });
});

// ─── summarizeBatchResolution — gap del detalle/comprobante (amountAdjustments) ──

describe("summarizeBatchResolution", () => {
  function movement(overrides: Partial<BatchDetailAccountMovement> = {}): BatchDetailAccountMovement {
    return { id: 1, insuredId: 100, type: "saldo_a_favor", signedAmountCents: 10000, status: "activo", reason: null, ...overrides };
  }
  function adjustment(overrides: Partial<BatchDetailAmountAdjustment> = {}): BatchDetailAmountAdjustment {
    return {
      id: 1, paymentBatchId: 55, amountCents: -234,
      reason: "Ajuste por redondeo autorizado en cobro en lote",
      authorizedBy: 7, createdBy: 7, createdAt: "2027-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  test("sin movimientos y sin ajustes → kind='none', nunca se confunde con una resolución real", () => {
    const result = summarizeBatchResolution([], [], "confirmado");
    expect(result).toEqual({ kind: "none", accountMovement: null, roundingAdjustment: null });
  });

  test("caso real (faltante -234, batch confirmado) → kind='rounding_adjustment', label exacto 'Faltante por ajuste de redondeo: $2,34'", () => {
    const result = summarizeBatchResolution([], [adjustment({ amountCents: -234 })], "confirmado");
    expect(result.kind).toBe("rounding_adjustment");
    expect(result.accountMovement).toBeNull();
    expect(result.roundingAdjustment).not.toBeNull();
    expect(result.roundingAdjustment!.amountCents).toBe(-234);
    expect(result.roundingAdjustment!.label).toBe(`Faltante por ajuste de redondeo: ${formatCurrencyCents(234)}`);
    expect(result.roundingAdjustment!.reason).toBe("Ajuste por redondeo autorizado en cobro en lote");
    expect(result.roundingAdjustment!.contributesToCaja).toBe(true);
  });

  test("sobrante (+500, batch confirmado) → label 'Sobrante por ajuste de redondeo: $5,00'", () => {
    const result = summarizeBatchResolution([], [adjustment({ amountCents: 500 })], "confirmado");
    expect(result.roundingAdjustment!.label).toBe(`Sobrante por ajuste de redondeo: ${formatCurrencyCents(500)}`);
    expect(result.roundingAdjustment!.contributesToCaja).toBe(true);
  });

  test("batch anulado → contributesToCaja=false, pero el ajuste sigue presente (histórico, kind sin cambios)", () => {
    const result = summarizeBatchResolution([], [adjustment({ amountCents: 400 })], "anulado");
    expect(result.kind).toBe("rounding_adjustment");
    expect(result.roundingAdjustment!.amountCents).toBe(400);
    expect(result.roundingAdjustment!.contributesToCaja).toBe(false);
  });

  test("flujo existente saldo_a_favor/saldo_deudor sin regresión: mismo resultado que findBatchDifferenceResolution, kind='account_movement'", () => {
    const movements = [movement({ type: "saldo_deudor", reason: "acordado con el asegurado" })];
    const result = summarizeBatchResolution(movements, [], "confirmado");
    expect(result.kind).toBe("account_movement");
    expect(result.roundingAdjustment).toBeNull();
    expect(result.accountMovement).toEqual(findBatchDifferenceResolution(movements));
  });

  test("ambos presentes a la vez (dato anómalo) → kind='inconsistent_both', ninguno de los dos se oculta", () => {
    const movements = [movement({ type: "saldo_a_favor", reason: "movimiento real" })];
    const adjustments = [adjustment({ amountCents: -234 })];
    const result = summarizeBatchResolution(movements, adjustments, "confirmado");
    expect(result.kind).toBe("inconsistent_both");
    expect(result.accountMovement).not.toBeNull();
    expect(result.accountMovement!.reason).toBe("movimiento real");
    expect(result.roundingAdjustment).not.toBeNull();
    expect(result.roundingAdjustment!.amountCents).toBe(-234);
  });

  test("nunca devuelve kind='none' cuando existe un ajuste válido, incluso con reason vacío en accountMovements", () => {
    const result = summarizeBatchResolution([], [adjustment()], "confirmado");
    expect(result.kind).not.toBe("none");
  });
});

describe("comprobante — descripción de ítems (cuota / cobro manual con póliza / imputación libre)", () => {
  function detailItem(overrides: Partial<PaymentBatchDetailItem> = {}): PaymentBatchDetailItem {
    return {
      payment: {
        id: 1, amount: 1000, policyId: 10, installmentId: 5, paymentDate: "2027-06-01", status: "confirmado", notes: null,
        manualPayer: null, manualPolicyNumber: null, manualCompany: null,
      },
      installment: { id: 5, number: 1, dueDate: "2027-06-01", amount: 1000 },
      policy: { id: 10, policyNumber: "POL-1" },
      company: { id: 200, name: "Compañía A" },
      insured: { id: 100, name: "Juan Pérez" },
      ...overrides,
    };
  }

  test("un ítem con installment no es manual", () => {
    expect(isManualBatchDetailItem(detailItem())).toBe(false);
    expect(isFreeformManualBatchDetailItem(detailItem())).toBe(false);
  });
  test("un ítem sin installment pero con policy es manual, no libre", () => {
    const item = detailItem({
      installment: null,
      payment: { id: 2, amount: 500, policyId: 20, installmentId: null, paymentDate: "2027-06-01", status: "confirmado", notes: null, manualPayer: null, manualPolicyNumber: null, manualCompany: null },
      policy: { id: 20, policyNumber: "POL-2" },
      insured: { id: 200, name: "María Gómez" },
    });
    expect(isManualBatchDetailItem(item)).toBe(true);
    expect(isFreeformManualBatchDetailItem(item)).toBe(false);
  });
  test("un ítem sin installment ni policy es manual libre, sin insured real", () => {
    const item = detailItem({
      installment: null, policy: null, company: null, insured: null,
      payment: { id: 3, amount: 300, policyId: null, installmentId: null, paymentDate: "2027-06-01", status: "confirmado", notes: null, manualPayer: "Juan Pérez", manualPolicyNumber: null, manualCompany: null },
    });
    expect(isManualBatchDetailItem(item)).toBe(true);
    expect(isFreeformManualBatchDetailItem(item)).toBe(true);
    expect(batchDetailItemInsuredLabel(item)).toBe("Juan Pérez");
  });

  test("batchDetailItemInsuredLabel usa el asegurado real si existe", () => {
    expect(batchDetailItemInsuredLabel(detailItem())).toBe("Juan Pérez");
  });

  test("batchDetailItemInsuredLabel cae a '—' si no hay asegurado real ni pagador manual", () => {
    const item = detailItem({ insured: null, payment: { id: 4, amount: 100, policyId: null, installmentId: null, paymentDate: "2027-06-01", status: "confirmado", notes: null, manualPayer: null, manualPolicyNumber: null, manualCompany: null } });
    expect(batchDetailItemInsuredLabel(item)).toBe("—");
  });

  test("describeBatchDetailItem de una cuota existente", () => {
    const label = describeBatchDetailItem(detailItem());
    expect(label).toBe("Cuota 1 — vence 2027-06-01 — póliza POL-1");
  });

  test("describeBatchDetailItem de un cobro manual con póliza real y descripción", () => {
    const label = describeBatchDetailItem(detailItem({
      installment: null,
      payment: { id: 2, amount: 500, policyId: 20, installmentId: null, paymentDate: "2027-06-01", status: "confirmado", notes: "cuota faltante", manualPayer: null, manualPolicyNumber: null, manualCompany: null },
      policy: { id: 20, policyNumber: "POL-2" },
    }));
    expect(label).toBe("Cobro manual — póliza POL-2 — cuota faltante");
  });

  test("describeBatchDetailItem de una imputación completamente libre con los 3 datos manuales", () => {
    const label = describeBatchDetailItem(detailItem({
      installment: null, policy: null, company: null, insured: null,
      payment: {
        id: 3, amount: 300, policyId: null, installmentId: null, paymentDate: "2027-06-01", status: "confirmado",
        notes: "pago suelto", manualPayer: "Juan Pérez", manualPolicyNumber: "999", manualCompany: "MAPFRE",
      },
    }));
    expect(label).toBe("Cobro manual — pagador Juan Pérez — póliza manual 999 — compañía MAPFRE — pago suelto");
  });

  test("describeBatchDetailItem de una imputación libre solo con pagador, sin descripción", () => {
    const label = describeBatchDetailItem(detailItem({
      installment: null, policy: null, company: null, insured: null,
      payment: {
        id: 3, amount: 300, policyId: null, installmentId: null, paymentDate: "2027-06-01", status: "confirmado",
        notes: null, manualPayer: "Juan Pérez", manualPolicyNumber: null, manualCompany: null,
      },
    }));
    expect(label).toBe("Cobro manual — pagador Juan Pérez");
  });
});

describe("normalizeBatchSubmitError", () => {
  test("usa err.body.error si existe", () => {
    const normalized = normalizeBatchSubmitError({ body: { error: "La cuota 5 ya está pagada." } });
    expect(normalized.message).toBe("La cuota 5 ya está pagada.");
  });
  test("cae a err.message si no hay body.error", () => {
    const normalized = normalizeBatchSubmitError({ message: "network error" });
    expect(normalized.message).toBe("network error");
  });
  test("expone blockingInstallmentIds y code si vienen en el body", () => {
    const normalized = normalizeBatchSubmitError({ body: { error: "x", blockingInstallmentIds: [1, 2], code: "CHECK_POSSIBLE_DUPLICATE" } });
    expect(normalized.blockingInstallmentIds).toEqual([1, 2]);
    expect(normalized.code).toBe("CHECK_POSSIBLE_DUPLICATE");
  });
});

// ─── Anulación de un lote confirmado ────────────────────────────────────────

function cancelCheckResponse(overrides: Partial<PaymentBatchCancelCheckResponse> = {}): PaymentBatchCancelCheckResponse {
  return {
    canCancel: true,
    status: "confirmado",
    blockingReasons: [],
    affectedPayments: [
      { id: 1, amount: 1000, installmentId: 10, policyId: 20, manualPayer: null },
      { id: 2, amount: 500, installmentId: null, policyId: null, manualPayer: "Juan Pérez" },
    ],
    affectedInstallments: [
      { id: 10, number: 1, dueDate: "2027-06-01", amount: 1000, currentStatus: "pendiente" },
    ],
    checks: [],
    remittanceLinks: { allocationCount: 0, itemCount: 0 },
    surchargeEntries: [],
    accountMovements: { canCancel: true, blockReasons: [], items: [] },
    ...overrides,
  };
}

describe("describeBatchCancelImpact", () => {
  test("resume pagos afectados, cuotas liberadas y cobros manuales", () => {
    const lines = describeBatchCancelImpact(cancelCheckResponse());
    expect(lines[0]).toContain("2 pago(s)");
    expect(lines[0]).toContain("$1500.00");
    expect(lines.some((l) => l.includes("1 cuota(s)"))).toBe(true);
    expect(lines.some((l) => l.includes("1 cobro(s) manual(es)"))).toBe(true);
  });

  test("sin cuotas, cheques ni recargo → solo la línea de pagos", () => {
    const lines = describeBatchCancelImpact(cancelCheckResponse({ affectedInstallments: [], affectedPayments: [{ id: 1, amount: 500, installmentId: null, policyId: null, manualPayer: "X" }] }));
    expect(lines.length).toBe(2); // pagos + manuales (sigue siendo 100% manual)
  });

  test("con cheques → agrega una línea con banco y número", () => {
    const lines = describeBatchCancelImpact(cancelCheckResponse({
      checks: [{ id: 1, checkNumber: "123", bankName: "Nación", amountCents: 100000, status: "en_cartera" }],
    }));
    expect(lines.some((l) => l.includes("1 cheque(s)") && l.includes("Nación #123"))).toBe(true);
  });

  test("con recargo → agrega una línea con el monto", () => {
    const lines = describeBatchCancelImpact(cancelCheckResponse({
      surchargeEntries: [{ id: 1, amountCents: 80000, rendered: 0 }],
    }));
    expect(lines.some((l) => l.includes("recargo Pronto Pago") && l.includes("$800.00"))).toBe(true);
  });
});

describe("canShowCancelButton / canShowEditButton", () => {
  test("confirmado → ambos botones visibles", () => {
    expect(canShowCancelButton("confirmado")).toBe(true);
    expect(canShowEditButton("confirmado")).toBe(true);
  });
  test("anulado → ninguno de los dos", () => {
    expect(canShowCancelButton("anulado")).toBe(false);
    expect(canShowEditButton("anulado")).toBe(false);
  });
});

describe("isCancelConfirmationValid", () => {
  test("check null → inválido aunque el checkbox esté tildado", () => {
    expect(isCancelConfirmationValid(null, true)).toBe(false);
  });
  test("canCancel=false → inválido aunque el checkbox esté tildado", () => {
    expect(isCancelConfirmationValid(cancelCheckResponse({ canCancel: false, blockingReasons: ["x"] }), true)).toBe(false);
  });
  test("canCancel=true pero checkbox sin tildar → inválido", () => {
    expect(isCancelConfirmationValid(cancelCheckResponse(), false)).toBe(false);
  });
  test("canCancel=true y checkbox tildado → válido", () => {
    expect(isCancelConfirmationValid(cancelCheckResponse(), true)).toBe(true);
  });

  // ─── Fase 2D/2E — seguridad de cuenta corriente al anular (accountMovements) ──
  test("canCancel=true pero accountMovements.canCancel=false → inválido aunque el checkbox esté tildado", () => {
    const check = cancelCheckResponse({
      accountMovements: { canCancel: false, blockReasons: ["requiere revisión manual"], items: [] },
    });
    expect(isCancelConfirmationValid(check, true)).toBe(false);
  });
  test("ambos canCancel=true (batch y cuenta corriente) y checkbox tildado → válido", () => {
    const check = cancelCheckResponse({
      accountMovements: { canCancel: true, blockReasons: [], items: [] },
    });
    expect(isCancelConfirmationValid(check, true)).toBe(true);
  });
});

describe("isBatchTrulyCancellable / combinedCancelBlockingReasons (Fase 2D)", () => {
  test("ambos canCancel=true → truly cancellable, sin razones de bloqueo", () => {
    const check = cancelCheckResponse();
    expect(isBatchTrulyCancellable(check)).toBe(true);
    expect(combinedCancelBlockingReasons(check)).toEqual([]);
  });

  test("batch bloqueado (canCancel=false) pero cuenta corriente segura → sigue sin ser anulable", () => {
    const check = cancelCheckResponse({ canCancel: false, blockingReasons: ["hay una rendición vinculada"] });
    expect(isBatchTrulyCancellable(check)).toBe(false);
    expect(combinedCancelBlockingReasons(check)).toEqual(["hay una rendición vinculada"]);
  });

  test("batch anulable pero cuenta corriente requiere revisión manual → no es realmente anulable", () => {
    const check = cancelCheckResponse({
      accountMovements: { canCancel: false, blockReasons: ["el movimiento 5 ya fue consumido por otra operación"], items: [] },
    });
    expect(isBatchTrulyCancellable(check)).toBe(false);
    expect(combinedCancelBlockingReasons(check)).toEqual(["el movimiento 5 ya fue consumido por otra operación"]);
  });

  test("combinedCancelBlockingReasons junta ambas listas cuando las dos bloquean", () => {
    const check = cancelCheckResponse({
      canCancel: false, blockingReasons: ["razón de estado"],
      accountMovements: { canCancel: false, blockReasons: ["razón de cuenta corriente"], items: [] },
    });
    expect(combinedCancelBlockingReasons(check)).toEqual(["razón de estado", "razón de cuenta corriente"]);
  });
});

describe("buildBatchCancelPayload", () => {
  test("siempre manda confirm:true", () => {
    expect(buildBatchCancelPayload("motivo").confirm).toBe(true);
  });
  test("recorta el motivo y lo incluye", () => {
    expect(buildBatchCancelPayload("  error de carga  ").reason).toBe("error de carga");
  });
  test("motivo vacío → reason null, nunca string vacío", () => {
    expect(buildBatchCancelPayload("   ").reason).toBeNull();
  });
});

// ─── Edición administrativa (PATCH) ──────────────────────────────────────────

describe("emptyBatchEditForm / validateBatchEditForm / buildBatchPatchPayload", () => {
  test("emptyBatchEditForm usa notes vacío si viene null", () => {
    const form = emptyBatchEditForm("2027-06-01", null);
    expect(form).toEqual({ paymentDate: "2027-06-01", notes: "" });
  });

  test("validateBatchEditForm exige paymentDate con formato YYYY-MM-DD", () => {
    expect(validateBatchEditForm({ paymentDate: "", notes: "" }).valid).toBe(false);
    expect(validateBatchEditForm({ paymentDate: "01/06/2027", notes: "" }).valid).toBe(false);
    expect(validateBatchEditForm({ paymentDate: "2027-06-01", notes: "" }).valid).toBe(true);
  });

  test("buildBatchPatchPayload nunca incluye ningún campo monetario", () => {
    const payload = buildBatchPatchPayload({ paymentDate: "2027-06-01", notes: "  nota  " });
    expect(payload).toEqual({ paymentDate: "2027-06-01", notes: "nota" });
    expect(Object.keys(payload).sort()).toEqual(["notes", "paymentDate"]);
  });

  test("buildBatchPatchPayload con notes vacío manda null", () => {
    expect(buildBatchPatchPayload({ paymentDate: "2027-06-01", notes: "   " }).notes).toBeNull();
  });
});

describe("BATCH_CORRECTION_HINT", () => {
  test("texto operativo fijo de corrección por anular + recrear", () => {
    expect(BATCH_CORRECTION_HINT).toContain("anulá este cobro");
    expect(BATCH_CORRECTION_HINT).toContain("creá uno nuevo");
  });
});

// ─── Migración 0028 — cheques en cobranzas individuales ─────────────────────
// updateSplitMethodPreservingChecks/splitsToPaymentSplitsPayload son
// reutilizados por el modal de "Imputar pago individual" (cobranzas.tsx) —
// se testean acá, junto al resto de los helpers de splits/cheques que ya
// reutiliza, en vez de en un archivo de tests de componentes React (este
// proyecto no usa ese tipo de test — ver el resto de web/lib/__tests__).

describe("updateSplitMethodPreservingChecks", () => {
  test("cambiar A cheque agrega una fila de cheque vacía", () => {
    const splits = [createBatchSplitRow("efectivo", "1000")];
    const updated = updateSplitMethodPreservingChecks(splits, splits[0]!.uid, "cheque");
    expect(updated[0]!.method).toBe("cheque");
    expect(updated[0]!.checks.length).toBe(1);
    expect(updated[0]!.checks[0]!.checkNumber).toBe("");
  });

  test("cambiar cheque->cheque (no-op de método) no descarta cheques ya cargados", () => {
    let splits = [createBatchSplitRow("cheque", "1000")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[0]!.uid, { checkNumber: "0001" });
    const updated = updateSplitMethodPreservingChecks(splits, splits[0]!.uid, "cheque");
    expect(updated[0]!.checks.length).toBe(1);
    expect(updated[0]!.checks[0]!.checkNumber).toBe("0001");
  });

  test("cambiar DE cheque a otro método descarta los cheques cargados", () => {
    let splits = [createBatchSplitRow("cheque", "1000")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[0]!.uid, { checkNumber: "0001" });
    const updated = updateSplitMethodPreservingChecks(splits, splits[0]!.uid, "efectivo");
    expect(updated[0]!.method).toBe("efectivo");
    expect(updated[0]!.checks).toEqual([]);
  });

  test("no toca otros splits", () => {
    const a = createBatchSplitRow("efectivo", "500");
    const b = createBatchSplitRow("transferencia", "500");
    const updated = updateSplitMethodPreservingChecks([a, b], a.uid, "cheque");
    expect(updated[1]).toEqual(b);
  });
});

// ─── Caso reportado — cheque + efectivo con centavos reales ─────────────────
// Total real $249.911,94 (24991194 centavos): cheque $249.900 + efectivo $12
// suman $249.912 en pesos enteros, pero faltan/sobran 6 centavos reales. La
// validación siempre operó en centavos (no cambia acá) — estos tests
// reproducen el escenario exacto reportado para dejar constancia de que la
// suma en centavos ya bloqueaba correctamente; el bug real era de display
// (ver utils.test.ts, formatCurrencyCents).

describe("validateBatchSplitsForm — caso reportado: cheque + efectivo con centavos reales", () => {
  function chequeMasEfectivo(efectivoAmount: string): BatchSplitFormRow[] {
    let splits: BatchSplitFormRow[] = [
      createBatchSplitRow("cheque", "249900"),
      createBatchSplitRow("efectivo", efectivoAmount),
    ];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[0]!.uid, {
      checkNumber: "1", bankName: "Nación", dueDate: "2027-06-01", amount: "249900",
    });
    return splits;
  }

  test("cheque $249.900 + efectivo $12 contra objetivo $249.911,94 → inválido, sobran $0,06 (no debe poder confirmarse)", () => {
    const result = validateBatchSplitsForm(24991194, chequeMasEfectivo("12"));
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("Se excede");
  });

  test("ajustando el efectivo a $11,94 el total cierra exacto en centavos → válido (sí puede confirmarse)", () => {
    const result = validateBatchSplitsForm(24991194, chequeMasEfectivo("11.94"));
    expect(result.valid).toBe(true);
  });

  test("efectivo insuficiente ($11,93) sigue bloqueado por 1 centavo real de diferencia", () => {
    const result = validateBatchSplitsForm(24991194, chequeMasEfectivo("11.93"));
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("Faltan distribuir");
  });
});

describe("hint de CheckSubForm — importe objetivo del split con centavos reales", () => {
  test("cheque como único medio: split.amount sincronizado al total conserva los centavos exactos", () => {
    const cart = [installmentCartItem({ amount: 249911.94 })];
    const target = calculateBatchTargetAmountCents(cart, [createBatchSplitRow("cheque")]);
    const synced = syncSingleBatchSplitAmount([createBatchSplitRow("cheque")], String(target / 100));
    // Mismo cálculo que usa CheckSubForm para el hint "El importe total de
    // cheques debe ser exactamente $X" — nunca redondeado a peso entero.
    expect(amountStringToCentsStrict(synced[0]!.amount)).toBe(24991194);
  });

  test("split cheque combinado con otro medio: el hint usa el importe de ESE split, no el total del lote", () => {
    let splits: BatchSplitFormRow[] = [
      createBatchSplitRow("cheque", "249900"),
      createBatchSplitRow("efectivo", "12.06"),
    ];
    expect(amountStringToCentsStrict(splits[0]!.amount)).toBe(24990000);
  });
});

describe("splitsToPaymentSplitsPayload", () => {
  test("split no-cheque nunca incluye la clave `checks`", () => {
    const splits = [createBatchSplitRow("efectivo", "1000")];
    const payload = splitsToPaymentSplitsPayload(splits);
    expect(payload).toEqual([{ method: "efectivo", amount: 1000 }]);
    expect("checks" in payload[0]!).toBe(false);
  });

  test("split cheque incluye checks[] recortados y normalizados", () => {
    let splits = [createBatchSplitRow("cheque", "1000")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[0]!.uid, {
      checkNumber: "  0001  ", bankName: "  Banco Nación  ", dueDate: "2027-08-01", amount: "1000",
    });
    const payload = splitsToPaymentSplitsPayload(splits);
    expect(payload[0]!.checks).toEqual([{
      checkNumber: "0001", bankName: "Banco Nación", bankCode: null, drawerName: null,
      drawerDocument: null, issueDate: null, dueDate: "2027-08-01", amount: 1000, notes: null,
    }]);
  });

  test("dos splits — cada uno mapeado independientemente", () => {
    const a = createBatchSplitRow("efectivo", "600");
    const b = createBatchSplitRow("transferencia", "400");
    const payload = splitsToPaymentSplitsPayload([a, b]);
    expect(payload).toEqual([
      { method: "efectivo", amount: 600 },
      { method: "transferencia", amount: 400 },
    ]);
  });
});

// ─── syncChequeSplitAmounts — el usuario ya no escribe el importe a mano ───

describe("syncChequeSplitAmounts", () => {
  test("caso real: 3 cheques ($770.499,67 + $580.462,77 + $401.096,22) → split.amount = $1.752.058,66 exacto", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "1752061")]; // arranca en el nominal (target), como antes
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = addCheckToSplit(splits, splits[0]!.uid);
    const [c1, c2, c3] = splits[0]!.checks;
    splits = updateCheckInSplit(splits, splits[0]!.uid, c1!.uid, { checkNumber: "14572565", bankName: "Banco A", dueDate: "2027-06-01", amount: "770499.67" });
    splits = updateCheckInSplit(splits, splits[0]!.uid, c2!.uid, { checkNumber: "14572566", bankName: "Banco A", dueDate: "2027-06-01", amount: "580462.77" });
    splits = updateCheckInSplit(splits, splits[0]!.uid, c3!.uid, { checkNumber: "14572567", bankName: "Banco A", dueDate: "2027-06-01", amount: "401096.22" });

    const synced = syncChequeSplitAmounts(splits);
    expect(synced[0]!.amount).toBe("1752058.66");
    expect(amountStringToCentsStrict(synced[0]!.amount)).toBe(175205866);
  });

  test("no-op para splits que no son cheque — nunca toca su amount", () => {
    const splits: BatchSplitFormRow[] = [createBatchSplitRow("efectivo", "1000")];
    const synced = syncChequeSplitAmounts(splits);
    expect(synced[0]!.amount).toBe("1000");
  });

  test("split cheque sin ningún cheque cargado → amount se recalcula a 0.00, nunca queda con un valor stale", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "1752061")];
    const synced = syncChequeSplitAmounts(splits);
    expect(synced[0]!.amount).toBe("0.00");
  });

  test("funciona con varios medios de pago a la vez — cada split cheque se sincroniza independiente, los demás no se tocan", () => {
    let splits: BatchSplitFormRow[] = [
      createBatchSplitRow("efectivo", "500"),
      createBatchSplitRow("cheque", "1000"),
    ];
    splits = addCheckToSplit(splits, splits[1]!.uid);
    splits = updateCheckInSplit(splits, splits[1]!.uid, splits[1]!.checks[0]!.uid, {
      checkNumber: "1", bankName: "Nación", dueDate: "2027-06-01", amount: "999.99",
    });
    const synced = syncChequeSplitAmounts(splits);
    expect(synced[0]!.amount).toBe("500"); // efectivo, sin cambios
    expect(synced[1]!.amount).toBe("999.99"); // cheque, recalculado
  });

  test("recalcula al agregar un segundo cheque (simula 'agregar')", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "1000")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[0]!.uid, { checkNumber: "1", bankName: "Nación", dueDate: "2027-06-01", amount: "600" });
    splits = syncChequeSplitAmounts(splits);
    expect(splits[0]!.amount).toBe("600.00");

    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[1]!.uid, { checkNumber: "2", bankName: "Galicia", dueDate: "2027-06-01", amount: "400" });
    splits = syncChequeSplitAmounts(splits);
    expect(splits[0]!.amount).toBe("1000.00"); // recalculado, sin intervención manual
  });

  test("recalcula al editar el importe de un cheque existente", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "1000")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[0]!.uid, { checkNumber: "1", bankName: "Nación", dueDate: "2027-06-01", amount: "600" });
    splits = syncChequeSplitAmounts(splits);
    expect(splits[0]!.amount).toBe("600.00");

    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[0]!.uid, { amount: "650.50" });
    splits = syncChequeSplitAmounts(splits);
    expect(splits[0]!.amount).toBe("650.50");
  });

  test("recalcula al quitar un cheque", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "1000")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = addCheckToSplit(splits, splits[0]!.uid);
    const [c1, c2] = splits[0]!.checks;
    splits = updateCheckInSplit(splits, splits[0]!.uid, c1!.uid, { checkNumber: "1", bankName: "Nación", dueDate: "2027-06-01", amount: "600" });
    splits = updateCheckInSplit(splits, splits[0]!.uid, c2!.uid, { checkNumber: "2", bankName: "Galicia", dueDate: "2027-06-01", amount: "400" });
    splits = syncChequeSplitAmounts(splits);
    expect(splits[0]!.amount).toBe("1000.00");

    splits = removeCheckFromSplit(splits, splits[0]!.uid, c2!.uid);
    splits = syncChequeSplitAmounts(splits);
    expect(splits[0]!.amount).toBe("600.00");
  });

  test("idempotente — aplicarlo dos veces seguidas da el mismo resultado", () => {
    let splits: BatchSplitFormRow[] = [createBatchSplitRow("cheque", "1000")];
    splits = addCheckToSplit(splits, splits[0]!.uid);
    splits = updateCheckInSplit(splits, splits[0]!.uid, splits[0]!.checks[0]!.uid, { checkNumber: "1", bankName: "Nación", dueDate: "2027-06-01", amount: "999.99" });
    const once = syncChequeSplitAmounts(splits);
    const twice = syncChequeSplitAmounts(once);
    expect(twice).toEqual(once);
  });
});

// ─── Tolerancia de redondeo — isRoundingAdjustmentEligible / buildRoundingAdjustmentPayload ──

describe("MAX_ROUNDING_ADJUSTMENT_CENTS", () => {
  test("re-exportado de insured-account.ts, vale 500", () => {
    expect(MAX_ROUNDING_ADJUSTMENT_CENTS).toBe(500);
  });
});

describe("isRoundingAdjustmentEligible", () => {
  test("diferencia 0 → no elegible (no hay nada que aceptar)", () => {
    expect(isRoundingAdjustmentEligible(0)).toBe(false);
  });
  test("caso real: -234 centavos ($2,34 faltante) → elegible", () => {
    expect(isRoundingAdjustmentEligible(-234)).toBe(true);
  });
  test("+234 centavos (sobrante) → elegible", () => {
    expect(isRoundingAdjustmentEligible(234)).toBe(true);
  });
  test("-500 / +500 (límite exacto de $5,00) → elegible", () => {
    expect(isRoundingAdjustmentEligible(-500)).toBe(true);
    expect(isRoundingAdjustmentEligible(500)).toBe(true);
  });
  test("-501 / +501 ($5,01) → NO elegible, sigue el flujo general", () => {
    expect(isRoundingAdjustmentEligible(-501)).toBe(false);
    expect(isRoundingAdjustmentEligible(501)).toBe(false);
  });
});

describe("buildRoundingAdjustmentPayload", () => {
  test("siempre { action: 'ajuste_redondeo' }, sin reason (el backend autogenera el motivo estándar)", () => {
    expect(buildRoundingAdjustmentPayload()).toEqual({ action: "ajuste_redondeo" });
  });
});

describe("validateBatchDifferenceResolutionWithRounding", () => {
  function resolution(overrides: Partial<BatchDifferenceResolutionFormState> = {}): BatchDifferenceResolutionFormState {
    return { ...emptyBatchDifferenceResolutionForm(), ...overrides };
  }

  test("sin diferencia ('exacto') → siempre válido, sin importar nada más", () => {
    const exact = calculateBatchReceivedAppliedDifference(100000, 100000);
    expect(validateBatchDifferenceResolutionWithRounding(exact, resolution(), false, "manual-only").valid).toBe(true);
  });

  test("caso real (faltante $2,34, elegible) con checkbox tildado → válido para asegurado único, SIN elegir saldo_deudor ni cargar motivo", () => {
    const faltante = calculateBatchReceivedAppliedDifference(175205866, 175206100);
    const result = validateBatchDifferenceResolutionWithRounding(faltante, resolution(), true, "single");
    expect(result.valid).toBe(true);
  });

  test("faltante elegible con checkbox tildado → válido en MULTIASEGURADO, sin exigir ningún insuredId (payment_amount_adjustments no lo necesita)", () => {
    const faltante = calculateBatchReceivedAppliedDifference(175205866, 175206100);
    const result = validateBatchDifferenceResolutionWithRounding(faltante, resolution(), true, "multiple");
    expect(result.valid).toBe(true);
  });

  test("faltante elegible con checkbox tildado → válido en 100% MANUAL, sin exigir ningún insuredId", () => {
    const faltante = calculateBatchReceivedAppliedDifference(175205866, 175206100);
    const result = validateBatchDifferenceResolutionWithRounding(faltante, resolution(), true, "manual-only");
    expect(result.valid).toBe(true);
  });

  test("faltante elegible pero checkbox SIN tildar, asegurado único → delega en el flujo existente (pide elegir saldo deudor)", () => {
    const faltante = calculateBatchReceivedAppliedDifference(80000, 100000); // faltante $200, elegible? |diff|=20000 > 500 → NO elegible
    const result = validateBatchDifferenceResolutionWithRounding(faltante, resolution(), false, "single");
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("Saldo deudor");
  });

  test("faltante elegible ($2,34) pero checkbox SIN tildar, asegurado único → delega en validateBatchDifferenceResolution (pide elegir una resolución)", () => {
    const faltante = calculateBatchReceivedAppliedDifference(175205866, 175206100);
    const result = validateBatchDifferenceResolutionWithRounding(faltante, resolution(), false, "single");
    expect(result.valid).toBe(false); // ninguna de las dos vías fue elegida todavía
  });

  test("faltante elegible ($2,34), asegurado único, SIN checkbox y SIN resolución elegida → mensaje combinado exacto (redondeo o saldo deudor)", () => {
    const faltante = calculateBatchReceivedAppliedDifference(175205866, 175206100);
    const result = validateBatchDifferenceResolutionWithRounding(faltante, resolution(), false, "single");
    expect(result.errorMessage).toBe(
      "Elegí aceptar el ajuste por redondeo o registrar la diferencia como saldo deudor para confirmar el cobro.",
    );
  });

  test("sobrante elegible ($5,00), asegurado único, SIN checkbox y SIN resolución elegida → mensaje combinado exacto (redondeo o saldo a favor)", () => {
    const sobrante = calculateBatchReceivedAppliedDifference(175206600, 175206100); // +$5,00, elegible (tope inclusive)
    const result = validateBatchDifferenceResolutionWithRounding(sobrante, resolution(), false, "single");
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe(
      "Elegí aceptar el ajuste por redondeo o registrar la diferencia como saldo a favor para confirmar el cobro.",
    );
  });

  test("faltante elegible pero YA con saldo_deudor elegido sin motivo → vuelve al mensaje específico de motivo obligatorio, no al combinado", () => {
    const faltante = calculateBatchReceivedAppliedDifference(175205866, 175206100);
    const result = validateBatchDifferenceResolutionWithRounding(
      faltante, resolution({ action: "saldo_deudor", reason: "" }), false, "single",
    );
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe("El motivo es obligatorio para registrar un saldo deudor.");
  });

  test("asegurado único, faltante elegible, checkbox SIN tildar pero SÍ eligió saldo_deudor con motivo → válido (flujo existente intacto, sin regresión)", () => {
    const faltante = calculateBatchReceivedAppliedDifference(175205866, 175206100);
    const result = validateBatchDifferenceResolutionWithRounding(
      faltante, resolution({ action: "saldo_deudor", reason: "acordado con el asegurado" }), false, "single",
    );
    expect(result.valid).toBe(true);
  });

  test("diferencia >$5,00 en multiasegurado → sigue bloqueada aunque roundingAccepted sea true (no elegible, no hay checkbox real)", () => {
    const faltante = calculateBatchReceivedAppliedDifference(80000, 100000); // |diff|=20000 > 500
    const result = validateBatchDifferenceResolutionWithRounding(faltante, resolution(), true, "multiple");
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("único asegurado real");
  });

  test("diferencia >$5,00 en asegurado único → EXACTAMENTE el flujo general existente, sin cambios", () => {
    const sobrante = calculateBatchReceivedAppliedDifference(150000, 100000); // |diff|=50000 > 500
    const withoutRounding = validateBatchDifferenceResolution(sobrante, resolution({ action: "saldo_a_favor" }), "single");
    const withRoundingWrapper = validateBatchDifferenceResolutionWithRounding(sobrante, resolution({ action: "saldo_a_favor" }), false, "single");
    expect(withRoundingWrapper).toEqual(withoutRounding);
  });
});
