/**
 * Tests de las funciones puras de src/lib/installments/rebilling-plan.ts
 * (validación de payload, plan de cuotas de una refacturación puntual,
 * detección de actividad sobre un grupo). Sin DB — mismo estilo que
 * installment-plan.test.ts / installments-rebuild.test.ts.
 */

import { test, expect, describe } from "bun:test";
import {
  parseRebillingPayload,
  RebillingPayloadError,
  buildRebillingInstallmentPlan,
  hasRebillingGroupActivity,
} from "../../lib/installments/rebilling-plan";
import { InstallmentPlanError } from "../../lib/installments/plan";

function sum(amounts: number[]): number {
  return Math.round(amounts.reduce((s, a) => s + a, 0) * 100) / 100;
}

describe("parseRebillingPayload", () => {
  const validBody = {
    billingStart: "2027-01-01",
    billingEnd: "2027-03-31",
    premium: 30000,
    monthlyFee: 10000,
    installmentCount: 3,
    firstDueDate: "2027-01-01",
    sumInsured: 500000,
    deductible: 50000,
    notes: "ajuste",
  };

  test("payload completo y válido se normaliza tal cual", () => {
    const p = parseRebillingPayload(validBody);
    expect(p.billingStart).toBe("2027-01-01");
    expect(p.installmentCount).toBe(3);
    expect(p.monthlyFee).toBe(10000);
    expect(p.deductible).toBe(50000);
  });

  test("falta billingStart → error claro", () => {
    expect(() => parseRebillingPayload({ ...validBody, billingStart: undefined })).toThrow(RebillingPayloadError);
  });

  test("falta firstDueDate → error claro", () => {
    expect(() => parseRebillingPayload({ ...validBody, firstDueDate: undefined })).toThrow(RebillingPayloadError);
  });

  test("installmentCount cero o negativo → error", () => {
    expect(() => parseRebillingPayload({ ...validBody, installmentCount: 0 })).toThrow(RebillingPayloadError);
    expect(() => parseRebillingPayload({ ...validBody, installmentCount: -2 })).toThrow(RebillingPayloadError);
  });

  test("installmentCount no entero → error", () => {
    expect(() => parseRebillingPayload({ ...validBody, installmentCount: 2.5 })).toThrow(RebillingPayloadError);
  });

  test("monthlyFee cero o negativo → error", () => {
    expect(() => parseRebillingPayload({ ...validBody, monthlyFee: 0 })).toThrow(RebillingPayloadError);
    expect(() => parseRebillingPayload({ ...validBody, monthlyFee: -100 })).toThrow(RebillingPayloadError);
  });

  test("deductible negativo → error", () => {
    expect(() => parseRebillingPayload({ ...validBody, deductible: -1 })).toThrow(RebillingPayloadError);
  });

  test("deductible ausente → null, sin error (opcional)", () => {
    const p = parseRebillingPayload({ ...validBody, deductible: undefined });
    expect(p.deductible).toBeNull();
  });

  test("deductible cero es válido (>= 0)", () => {
    const p = parseRebillingPayload({ ...validBody, deductible: 0 });
    expect(p.deductible).toBe(0);
  });

  test("premium ausente → null, sin error (opcional)", () => {
    const p = parseRebillingPayload({ ...validBody, premium: undefined });
    expect(p.premium).toBeNull();
  });
});

describe("buildRebillingInstallmentPlan", () => {
  test("el total del plan es monthlyFee * installmentCount, NUNCA premium", () => {
    const payload = parseRebillingPayload({
      billingStart: "2027-01-01", billingEnd: "2027-03-31",
      premium: 999999, // deliberadamente distinto del total real — no debe usarse
      monthlyFee: 10000, installmentCount: 3, firstDueDate: "2027-01-01",
    });
    const plan = buildRebillingInstallmentPlan(payload);
    expect(plan.installments.length).toBe(3);
    expect(sum(plan.installments.map((i) => i.amount))).toBe(30000); // 10000*3, no 999999
    expect(plan.totalAmount).toBe(30000);
  });

  test("numeración del grupo reinicia en 1", () => {
    const payload = parseRebillingPayload({
      billingStart: "2027-01-01", billingEnd: "2027-03-31",
      monthlyFee: 10000, installmentCount: 3, firstDueDate: "2027-01-01",
    });
    const plan = buildRebillingInstallmentPlan(payload);
    expect(plan.installments.map((i) => i.number)).toEqual([1, 2, 3]);
  });

  test("fechas de vencimiento caen dentro del período facturado", () => {
    const payload = parseRebillingPayload({
      billingStart: "2027-01-01", billingEnd: "2027-03-31",
      monthlyFee: 10000, installmentCount: 3, firstDueDate: "2027-01-15",
    });
    const plan = buildRebillingInstallmentPlan(payload);
    expect(plan.installments.map((i) => i.dueDate)).toEqual(["2027-01-15", "2027-02-15", "2027-03-15"]);
    for (const inst of plan.installments) {
      expect(inst.dueDate >= "2027-01-01" && inst.dueDate <= "2027-03-31").toBe(true);
    }
  });

  test("plan que no entra en el período lanza InstallmentPlanError", () => {
    const payload = parseRebillingPayload({
      billingStart: "2027-01-01", billingEnd: "2027-01-31",
      monthlyFee: 10000, installmentCount: 6, firstDueDate: "2027-01-01",
    });
    expect(() => buildRebillingInstallmentPlan(payload)).toThrow(InstallmentPlanError);
  });

  test("firstDueDate fuera del período lanza InstallmentPlanError", () => {
    const payload = parseRebillingPayload({
      billingStart: "2027-02-01", billingEnd: "2027-03-31",
      monthlyFee: 10000, installmentCount: 2, firstDueDate: "2027-01-15",
    });
    expect(() => buildRebillingInstallmentPlan(payload)).toThrow(InstallmentPlanError);
  });
});

describe("hasRebillingGroupActivity", () => {
  test("sin cuotas → sin actividad", () => {
    expect(hasRebillingGroupActivity([], new Set(), new Set())).toBe(false);
  });

  test("cuotas pendientes sin pagos ni rendiciones → sin actividad", () => {
    const installments = [{ id: 1, status: "pendiente", rendered: 0 }, { id: 2, status: "vencida", rendered: 0 }];
    expect(hasRebillingGroupActivity(installments, new Set(), new Set())).toBe(false);
  });

  test("una cuota pagada → actividad", () => {
    const installments = [{ id: 1, status: "pagada", rendered: 0 }];
    expect(hasRebillingGroupActivity(installments, new Set(), new Set())).toBe(true);
  });

  test("una cuota rendida (rendered=1) → actividad", () => {
    const installments = [{ id: 1, status: "pendiente", rendered: 1 }];
    expect(hasRebillingGroupActivity(installments, new Set(), new Set())).toBe(true);
  });

  test("una cuota con pago vinculado (payments.installmentId) → actividad", () => {
    const installments = [{ id: 1, status: "pendiente", rendered: 0 }];
    expect(hasRebillingGroupActivity(installments, new Set([1]), new Set())).toBe(true);
  });

  test("una cuota con rendición directa (remittance_items) → actividad", () => {
    const installments = [{ id: 1, status: "pendiente", rendered: 0 }];
    expect(hasRebillingGroupActivity(installments, new Set(), new Set([1]))).toBe(true);
  });
});
