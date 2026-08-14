import { test, expect, describe } from "bun:test";
import {
  validateRebillingForm, buildRebillingEditPayload, buildRebillingCreatePayload,
  computePlanAmountMismatchWarning, type RebillingModalFormState,
} from "../rebilling-modal";

function baseForm(overrides: Partial<RebillingModalFormState> = {}): RebillingModalFormState {
  return {
    billingStart: "2027-06-01",
    billingEnd: "2027-08-31",
    premium: "3000",
    monthlyFee: "1000",
    installmentCount: "3",
    firstDueDate: "2027-06-01",
    sumInsured: "",
    deductible: "",
    notes: "",
    cashPaymentAmount: "",
    ...overrides,
  };
}

describe("validateRebillingForm — modo alta exige datos de plan", () => {
  test("sin installmentCount devuelve error", () => {
    const err = validateRebillingForm(baseForm({ installmentCount: "" }), false);
    expect(err).not.toBeNull();
  });
  test("sin firstDueDate devuelve error", () => {
    const err = validateRebillingForm(baseForm({ firstDueDate: "" }), false);
    expect(err).not.toBeNull();
  });
  test("sin monthlyFee devuelve error", () => {
    const err = validateRebillingForm(baseForm({ monthlyFee: "" }), false);
    expect(err).not.toBeNull();
  });
  test("con todos los datos de plan, pasa", () => {
    const err = validateRebillingForm(baseForm(), false);
    expect(err).toBeNull();
  });
});

describe("validateRebillingForm — modo edición NO exige datos de plan", () => {
  test("sin installmentCount, firstDueDate ni monthlyFee, pasa igual", () => {
    const err = validateRebillingForm(baseForm({ installmentCount: "", firstDueDate: "", monthlyFee: "" }), true);
    expect(err).toBeNull();
  });
  test("solo fechas de vigencia son obligatorias en edición", () => {
    const err = validateRebillingForm(baseForm({ billingStart: "", installmentCount: "", firstDueDate: "", monthlyFee: "" }), true);
    expect(err).not.toBeNull();
  });
  test("franquicia negativa sigue rechazándose en ambos modos", () => {
    expect(validateRebillingForm(baseForm({ deductible: "-5" }), true)).not.toBeNull();
    expect(validateRebillingForm(baseForm({ deductible: "-5" }), false)).not.toBeNull();
  });
});

describe("buildRebillingEditPayload — nunca incluye installmentCount ni firstDueDate", () => {
  test("el payload de edición no tiene esas claves", () => {
    const payload = buildRebillingEditPayload(baseForm());
    expect(payload).not.toHaveProperty("installmentCount");
    expect(payload).not.toHaveProperty("firstDueDate");
  });
  test("cambiar solo billingStart/billingEnd se refleja en el payload sin tocar nada del plan", () => {
    const payload = buildRebillingEditPayload(baseForm({ billingStart: "2027-07-01", billingEnd: "2027-09-30" }));
    expect(payload.billingStart).toBe("2027-07-01");
    expect(payload.billingEnd).toBe("2027-09-30");
    expect(payload).not.toHaveProperty("installmentCount");
    expect(payload).not.toHaveProperty("firstDueDate");
  });
  test("cambiar solo deductible (franquicia) se refleja en el payload sin tocar el plan", () => {
    const payload = buildRebillingEditPayload(baseForm({ deductible: "50000" }));
    expect(payload.deductible).toBe(50000);
    expect(payload).not.toHaveProperty("installmentCount");
    expect(payload).not.toHaveProperty("firstDueDate");
  });
  test("deductible vacío se envía como null, no se omite", () => {
    const payload = buildRebillingEditPayload(baseForm({ deductible: "" }));
    expect(payload.deductible).toBeNull();
  });
});

describe("buildRebillingCreatePayload — siempre incluye el plan completo", () => {
  test("incluye installmentCount y firstDueDate", () => {
    const payload = buildRebillingCreatePayload(baseForm());
    expect(payload.installmentCount).toBe(3);
    expect(payload.firstDueDate).toBe("2027-06-01");
  });
});

describe("computePlanAmountMismatchWarning", () => {
  test("sin installmentCount existente, no hay advertencia", () => {
    expect(computePlanAmountMismatchWarning("1000", "3000", null)).toBeNull();
    expect(computePlanAmountMismatchWarning("1000", "3000", undefined)).toBeNull();
  });
  test("cuando monthlyFee × installmentCount coincide con premium, no hay advertencia", () => {
    expect(computePlanAmountMismatchWarning("1000", "3000", 3)).toBeNull();
  });
  test("cuando no coincide, devuelve un mensaje informativo mencionando 'Corregir plan de cuotas'", () => {
    const warning = computePlanAmountMismatchWarning("2000", "3000", 3);
    expect(warning).not.toBeNull();
    expect(warning).toContain("Corregir plan de cuotas");
  });
  test("premium vacío no genera advertencia (nada que comparar)", () => {
    expect(computePlanAmountMismatchWarning("2000", "", 3)).toBeNull();
  });
});

describe("validateRebillingForm — importe contado (Migración 0034)", () => {
  test("vacío es válido (opcional)", () => {
    expect(validateRebillingForm(baseForm({ cashPaymentAmount: "" }), false)).toBeNull();
  });
  test("un valor positivo es válido", () => {
    expect(validateRebillingForm(baseForm({ cashPaymentAmount: "340000" }), true)).toBeNull();
  });
  test("rechaza cero o negativo", () => {
    expect(validateRebillingForm(baseForm({ cashPaymentAmount: "0" }), true)).not.toBeNull();
    expect(validateRebillingForm(baseForm({ cashPaymentAmount: "-100" }), true)).not.toBeNull();
  });
});

describe("buildRebillingEditPayload/buildRebillingCreatePayload — cashPaymentAmountCents", () => {
  test("convierte pesos a centavos", () => {
    const payload = buildRebillingEditPayload(baseForm({ cashPaymentAmount: "340000" }));
    expect(payload.cashPaymentAmountCents).toBe(34000000);
  });
  test("vacío es null", () => {
    const payload = buildRebillingEditPayload(baseForm({ cashPaymentAmount: "" }));
    expect(payload.cashPaymentAmountCents).toBeNull();
  });
  test("se propaga también al payload de alta", () => {
    const payload = buildRebillingCreatePayload(baseForm({ cashPaymentAmount: "340000" }));
    expect(payload.cashPaymentAmountCents).toBe(34000000);
  });
});
