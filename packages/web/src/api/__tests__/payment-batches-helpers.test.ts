/**
 * Tests del helper puro de payment_batches (Etapa 4A + cobro manual real).
 * Sin DB, sin HTTP — src/lib/payments/batches.ts. Complementa
 * payment-batches.test.ts (que ejercita estos mismos helpers a través del
 * endpoint real).
 */

import { test, expect, describe } from "bun:test";
import {
  normalizeBatchItems, normalizeBatchSplits, validateInstallmentsEligibility,
  calculateBaseAmountCents, resolveBatchSplitGroup, calculateApplicableRivadaviaSurcharges,
  calculateBatchTotals, validateBatchTotals, validateBatchStatusTransition, resolveBatchInsuredId,
  checkBatchCancellable, findDisallowedBatchPatchFields, canPatchBatch,
  PaymentBatchValidationError, BATCH_MIXED_GROUP_ERROR, SURCHARGE_AMOUNT_CENTS,
  type BatchItemContext, type BatchCancelInput, type BatchCancelChildPayment,
} from "../../lib/payments/batches";

function ctx(overrides: Partial<BatchItemContext>): BatchItemContext {
  return {
    kind: "installment", installmentId: 1, policyId: 1, insuredId: 1, amount: 1000,
    installmentStatus: "pendiente", rendered: 0, policyStatus: "activa", isRivadavia: false,
    policyType: null, parentPolicyId: null,
    description: null, manualPayer: null, manualPolicyNumber: null, manualCompany: null,
    ...overrides,
  } as BatchItemContext;
}

/** Cobro manual vinculado a una póliza real (kind="policy_manual_payment"). */
function manualCtx(overrides: Partial<BatchItemContext>): BatchItemContext {
  return ctx({
    kind: "policy_manual_payment", installmentId: null, installmentStatus: null, rendered: null,
    description: "Cobro manual de prueba",
    ...overrides,
  } as Partial<BatchItemContext>);
}

/**
 * Imputación completamente libre, sin póliza NI asegurado real
 * (kind="manual_payment") — insuredId siempre null por defecto, igual que
 * lo construye el endpoint real (nunca lo hereda de ningún "cliente
 * fijado", ese concepto ya no existe).
 */
function freeManualCtx(overrides: Partial<BatchItemContext>): BatchItemContext {
  return ctx({
    kind: "manual_payment", installmentId: null, installmentStatus: null, rendered: null,
    policyId: null, policyStatus: null, insuredId: null, description: "Imputación libre de prueba",
    manualPayer: "Juan Pérez", manualPolicyNumber: null, manualCompany: null,
    ...overrides,
  } as Partial<BatchItemContext>);
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
    expect(result.map((r: any) => r.installmentId)).toEqual([3, 1, 2]);
  });
  test("legacy sin source se normaliza como installment (compatibilidad)", () => {
    const result = normalizeBatchItems([{ installmentId: 7 }]);
    expect(result).toEqual([{ source: "installment", installmentId: 7 }]);
  });
  test("source='installment' explícito funciona igual que legacy", () => {
    const result = normalizeBatchItems([{ source: "installment", installmentId: 7 } as any]);
    expect(result).toEqual([{ source: "installment", installmentId: 7 }]);
  });

  test("acepta manual_payment con policyId/amount/description", () => {
    const result = normalizeBatchItems([
      { source: "policy_manual_payment", policyId: 42, amount: 1234.56, description: "  cuota faltante  " } as any,
    ]);
    expect(result).toEqual([{ source: "policy_manual_payment", policyId: 42, amountCents: 123456, description: "cuota faltante" }]);
  });
  test("manual_payment sin description queda null", () => {
    const result = normalizeBatchItems([{ source: "policy_manual_payment", policyId: 42, amount: 100 } as any]);
    expect((result[0] as any).description).toBeNull();
  });
  test("manual_payment rechaza policyId inválido", () => {
    expect(() => normalizeBatchItems([{ source: "policy_manual_payment", policyId: 0, amount: 100 } as any]))
      .toThrow(/policyId inválido/);
  });
  test("manual_payment rechaza amount <= 0", () => {
    expect(() => normalizeBatchItems([{ source: "policy_manual_payment", policyId: 1, amount: 0 } as any]))
      .toThrow(PaymentBatchValidationError);
    expect(() => normalizeBatchItems([{ source: "policy_manual_payment", policyId: 1, amount: -50 } as any]))
      .toThrow(PaymentBatchValidationError);
  });
  test("manual_payment rechaza más de dos decimales reales", () => {
    expect(() => normalizeBatchItems([{ source: "policy_manual_payment", policyId: 1, amount: 100.567 } as any]))
      .toThrow(PaymentBatchValidationError);
  });
  test("rechaza source desconocido", () => {
    expect(() => normalizeBatchItems([{ source: "cash_entry", policyId: 1 } as any]))
      .toThrow(/source inválido/);
  });
  test("no deduplica manual_payment entre sí (dos cobros manuales iguales son válidos)", () => {
    const result = normalizeBatchItems([
      { source: "policy_manual_payment", policyId: 1, amount: 100 } as any,
      { source: "policy_manual_payment", policyId: 1, amount: 100 } as any,
    ]);
    expect(result.length).toBe(2);
  });
  test("mezcla installment + manual_payment en el mismo request", () => {
    const result = normalizeBatchItems([
      { installmentId: 5 },
      { source: "policy_manual_payment", policyId: 9, amount: 300 } as any,
    ]);
    expect(result).toEqual([
      { source: "installment", installmentId: 5 },
      { source: "policy_manual_payment", policyId: 9, amountCents: 30000, description: null },
    ]);
  });

  // ─── manual_payment: imputación completamente libre (sin póliza real) ───
  test("acepta manual_payment libre con solo manualPayer", () => {
    const result = normalizeBatchItems([
      { source: "manual_payment", manualPayer: "Juan Pérez", amount: 500 } as any,
    ]);
    expect(result).toEqual([{
      source: "manual_payment", manualPayer: "Juan Pérez", manualPolicyNumber: null, manualCompany: null,
      amountCents: 50000, description: null,
    }]);
  });
  test("acepta manual_payment libre con solo manualPolicyNumber (sin pagador)", () => {
    const result = normalizeBatchItems([
      { source: "manual_payment", manualPolicyNumber: "999", amount: 500 } as any,
    ]);
    expect((result[0] as any).manualPayer).toBeNull();
    expect((result[0] as any).manualPolicyNumber).toBe("999");
  });
  test("rechaza manual_payment libre sin pagador ni N° de póliza", () => {
    expect(() => normalizeBatchItems([{ source: "manual_payment", amount: 500 } as any]))
      .toThrow(/al menos el pagador o el N° de póliza manual/);
    expect(() => normalizeBatchItems([{ source: "manual_payment", manualPayer: "  ", manualPolicyNumber: "  ", amount: 500 } as any]))
      .toThrow(PaymentBatchValidationError);
  });
  test("manual_payment libre nunca exige policyId — no lo mira aunque venga en el body", () => {
    const result = normalizeBatchItems([
      { source: "manual_payment", manualPayer: "Juan Pérez", policyId: 999, amount: 500 } as any,
    ]);
    expect((result[0] as any).policyId).toBeUndefined();
  });
  test("manual_payment libre rechaza amount <= 0 y más de dos decimales", () => {
    expect(() => normalizeBatchItems([{ source: "manual_payment", manualPayer: "X", amount: 0 } as any]))
      .toThrow(PaymentBatchValidationError);
    expect(() => normalizeBatchItems([{ source: "manual_payment", manualPayer: "X", amount: 100.567 } as any]))
      .toThrow(PaymentBatchValidationError);
  });
  test("manual_payment libre recorta espacios y preserva description/manualCompany", () => {
    const result = normalizeBatchItems([
      { source: "manual_payment", manualPayer: "  Juan Pérez  ", manualCompany: "  MAPFRE  ", amount: 500, description: "  pago suelto  " } as any,
    ]);
    expect(result).toEqual([{
      source: "manual_payment", manualPayer: "Juan Pérez", manualPolicyNumber: null, manualCompany: "MAPFRE",
      amountCents: 50000, description: "pago suelto",
    }]);
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

describe("resolveBatchInsuredId — insuredId legacy DERIVADO, nunca una restricción", () => {
  test("todos los ítems con el mismo insuredId real → se guarda ese id", () => {
    const result = resolveBatchInsuredId([ctx({ insuredId: 7, installmentId: 1 }), ctx({ insuredId: 7, installmentId: 2 })]);
    expect(result).toBe(7);
  });
  test("dos insuredId reales distintos (lote familiar) → null", () => {
    const result = resolveBatchInsuredId([ctx({ insuredId: 7, installmentId: 1 }), ctx({ insuredId: 8, installmentId: 2 })]);
    expect(result).toBeNull();
  });
  test("tres insuredId reales distintos → null", () => {
    const result = resolveBatchInsuredId([
      ctx({ insuredId: 7, installmentId: 1 }), ctx({ insuredId: 8, installmentId: 2 }), ctx({ insuredId: 9, installmentId: 3 }),
    ]);
    expect(result).toBeNull();
  });
  test("100% manual_payment libre (ningún insuredId real) → null", () => {
    const result = resolveBatchInsuredId([freeManualCtx({}), freeManualCtx({ manualPayer: "Otro" })]);
    expect(result).toBeNull();
  });
  test("cuota + manual_payment libre del mismo insuredId real → se guarda ese id (el manual no cuenta como 'otro asegurado')", () => {
    const result = resolveBatchInsuredId([ctx({ insuredId: 7 }), freeManualCtx({ insuredId: null })]);
    expect(result).toBe(7);
  });
  test("policy_manual_payment con insuredId real + manual_payment libre → se guarda el real", () => {
    const result = resolveBatchInsuredId([manualCtx({ insuredId: 12 }), freeManualCtx({ insuredId: null })]);
    expect(result).toBe(12);
  });
  test("cuota de un asegurado + policy_manual_payment de OTRO asegurado real → null", () => {
    const result = resolveBatchInsuredId([ctx({ insuredId: 7 }), manualCtx({ insuredId: 8 })]);
    expect(result).toBeNull();
  });
  test("array vacío → null (caso trivial)", () => {
    expect(resolveBatchInsuredId([])).toBeNull();
  });
});

describe("validateInstallmentsEligibility", () => {
  test("rechaza cuota pagada", () => {
    expect(() => validateInstallmentsEligibility([ctx({ installmentStatus: "pagada" })])).toThrow(/ya está pagada/);
  });
  test("rechaza cuota no_exigible", () => {
    expect(() => validateInstallmentsEligibility([ctx({ installmentStatus: "no_exigible" })])).toThrow(/no es exigible/);
  });
  // Migración 0035: una cuota duplicada nunca es cobrable, ni siquiera en lote.
  test("rechaza cuota duplicada", () => {
    expect(() => validateInstallmentsEligibility([ctx({ installmentStatus: "duplicada" })])).toThrow(/duplicado invalidado/);
  });
  test("rechaza cuota rendered=1", () => {
    expect(() => validateInstallmentsEligibility([ctx({ rendered: 1 })])).toThrow(/ya fue rendida/);
  });
  test("rechaza póliza cancelada (cuota)", () => {
    expect(() => validateInstallmentsEligibility([ctx({ policyStatus: "cancelada" })])).toThrow(/cancelada/);
  });
  test("acepta pendiente y vencida", () => {
    expect(() => validateInstallmentsEligibility([ctx({ installmentStatus: "pendiente" })])).not.toThrow();
    expect(() => validateInstallmentsEligibility([ctx({ installmentStatus: "vencida" })])).not.toThrow();
  });
  test("manual_payment acepta póliza activa", () => {
    expect(() => validateInstallmentsEligibility([manualCtx({ policyStatus: "activa" })])).not.toThrow();
  });
  test("manual_payment rechaza póliza cancelada", () => {
    expect(() => validateInstallmentsEligibility([manualCtx({ policyStatus: "cancelada" })]))
      .toThrow(/cobro manual \(póliza 1\) está cancelada/);
  });
  test("manual_payment ignora status/rendered de cuota (no aplican)", () => {
    expect(() => validateInstallmentsEligibility([manualCtx({ policyStatus: "activa" })])).not.toThrow();
  });
  test("imputación libre (manual_payment sin póliza) siempre es elegible — no hay fila real que validar", () => {
    expect(() => validateInstallmentsEligibility([freeManualCtx({})])).not.toThrow();
    expect(() => validateInstallmentsEligibility([freeManualCtx({ policyStatus: null })])).not.toThrow();
  });
});

describe("calculateBaseAmountCents", () => {
  test("suma en centavos sin arrastre de floats (solo cuotas)", () => {
    const total = calculateBaseAmountCents([ctx({ amount: 333.33 }), ctx({ amount: 333.33 }), ctx({ amount: 333.34 })]);
    expect(total).toBe(100000);
  });
  test("suma cuotas + manuales", () => {
    const total = calculateBaseAmountCents([ctx({ amount: 1000 }), manualCtx({ amount: 500 })]);
    expect(total).toBe(150000);
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
  test("solo los ítems Rivadavia generan recargo, el resto no (cuotas)", () => {
    const a = ctx({ isRivadavia: true, installmentId: 1 });
    const b = ctx({ isRivadavia: false, installmentId: 2 });
    const c = ctx({ isRivadavia: true, installmentId: 3 });
    const result = calculateApplicableRivadaviaSurcharges([a, b, c], "own");
    expect(result).toEqual([a, c]);
  });
  test("un cobro manual Rivadavia también genera recargo", () => {
    const inst = ctx({ isRivadavia: false, installmentId: 1 });
    const manual = manualCtx({ isRivadavia: true, policyId: 9 });
    const result = calculateApplicableRivadaviaSurcharges([inst, manual], "own");
    expect(result).toEqual([manual]);
  });
  test("SURCHARGE_AMOUNT_CENTS es $800", () => {
    expect(SURCHARGE_AMOUNT_CENTS).toBe(80000);
  });

  // ─── Grupo económico Rivadavia + Accidentes de Pasajeros ──────────────────

  test("A. Rivadavia principal sola → 1 recargo", () => {
    const principal = ctx({ isRivadavia: true, installmentId: 1, policyId: 100, policyType: "automotor" });
    const result = calculateApplicableRivadaviaSurcharges([principal], "own");
    expect(result).toEqual([principal]);
  });

  test("B. principal + accesoria accidentes_pasajeros (parentPolicyId presente en el batch) → 1 solo recargo total", () => {
    const principal = ctx({ isRivadavia: true, installmentId: 1, policyId: 100, policyType: "automotor" });
    const accesoria = ctx({
      isRivadavia: true, installmentId: 2, policyId: 200,
      policyType: "accidentes_pasajeros", parentPolicyId: 100,
    });
    const result = calculateApplicableRivadaviaSurcharges([principal, accesoria], "own");
    expect(result).toEqual([principal]);
    expect(result.length).toBe(1);
  });

  test("C. dos pólizas Rivadavia independientes → 2 recargos", () => {
    const p1 = ctx({ isRivadavia: true, installmentId: 1, policyId: 100, policyType: "automotor" });
    const p2 = ctx({ isRivadavia: true, installmentId: 2, policyId: 300, policyType: "automotor" });
    const result = calculateApplicableRivadaviaSurcharges([p1, p2], "own");
    expect(result).toEqual([p1, p2]);
  });

  test("D. accesoria SIN parentPolicyId → no agrupa, genera su propio recargo", () => {
    const accesoria = ctx({
      isRivadavia: true, installmentId: 1, policyId: 200,
      policyType: "accidentes_pasajeros", parentPolicyId: null,
    });
    const result = calculateApplicableRivadaviaSurcharges([accesoria], "own");
    expect(result).toEqual([accesoria]);
  });

  test("D. accesoria cuyo parentPolicyId NO está en el batch → no agrupa, genera su propio recargo", () => {
    const accesoria = ctx({
      isRivadavia: true, installmentId: 1, policyId: 200,
      policyType: "accidentes_pasajeros", parentPolicyId: 999, // 999 no está entre los items de este batch
    });
    const result = calculateApplicableRivadaviaSurcharges([accesoria], "own");
    expect(result).toEqual([accesoria]);
  });

  test("dos cuotas de la MISMA póliza principal (sin accesoria) siguen generando 2 recargos — no se agrupa por póliza sola", () => {
    const cuota1 = ctx({ isRivadavia: true, installmentId: 1, policyId: 100, policyType: "automotor" });
    const cuota2 = ctx({ isRivadavia: true, installmentId: 2, policyId: 100, policyType: "automotor" });
    const result = calculateApplicableRivadaviaSurcharges([cuota1, cuota2], "own");
    expect(result).toEqual([cuota1, cuota2]);
  });

  test("otras compañías (isRivadavia=false) no generan recargo aunque tengan type/parentPolicyId de accesoria", () => {
    const noRivadavia = ctx({
      isRivadavia: false, installmentId: 1, policyId: 200,
      policyType: "accidentes_pasajeros", parentPolicyId: 100,
    });
    const result = calculateApplicableRivadaviaSurcharges([noRivadavia], "own");
    expect(result).toEqual([]);
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

// ─── checkBatchCancellable ──────────────────────────────────────────────────

function cancelInput(overrides: Partial<BatchCancelInput> = {}): BatchCancelInput {
  return {
    batchStatus: "confirmado",
    childPayments: [{ id: 1, status: "confirmado", rendered: 0 }],
    remittanceAllocationCount: 0,
    remittanceItemCount: 0,
    checks: [],
    ...overrides,
  };
}

describe("checkBatchCancellable", () => {
  test("sin ninguna actividad posterior → permitido, sin motivos", () => {
    const result = checkBatchCancellable(cancelInput());
    expect(result.canCancel).toBe(true);
    expect(result.blockingReasons).toEqual([]);
  });

  test("batch ya anulado → bloqueado", () => {
    const result = checkBatchCancellable(cancelInput({ batchStatus: "anulado" }));
    expect(result.canCancel).toBe(false);
    expect(result.blockingReasons[0]).toContain('status="anulado"');
  });

  test("un hijo rendido → bloqueado", () => {
    const result = checkBatchCancellable(cancelInput({
      childPayments: [{ id: 1, status: "confirmado", rendered: 1 }],
    }));
    expect(result.canCancel).toBe(false);
    expect(result.blockingReasons[0]).toContain("ya rendido(s): 1");
  });

  test("con remittance_allocations vinculadas → bloqueado", () => {
    const result = checkBatchCancellable(cancelInput({ remittanceAllocationCount: 2 }));
    expect(result.canCancel).toBe(false);
    expect(result.blockingReasons[0]).toContain("2 asignación(es) de rendición");
  });

  test("con remittance_items vinculados → bloqueado", () => {
    const result = checkBatchCancellable(cancelInput({ remittanceItemCount: 3 }));
    expect(result.canCancel).toBe(false);
    expect(result.blockingReasons[0]).toContain("3 ítem(s) de rendición");
  });

  test("con un cheque entregado a compañía → bloqueado", () => {
    const result = checkBatchCancellable(cancelInput({
      checks: [{ id: 9, status: "entregado_compania" }],
    }));
    expect(result.canCancel).toBe(false);
    expect(result.blockingReasons[0]).toContain("1 cheque(s)");
  });

  test("con un cheque cobrado → bloqueado", () => {
    const result = checkBatchCancellable(cancelInput({ checks: [{ id: 9, status: "cobrado" }] }));
    expect(result.canCancel).toBe(false);
  });

  test("con un cheque rechazado → bloqueado", () => {
    const result = checkBatchCancellable(cancelInput({ checks: [{ id: 9, status: "rechazado" }] }));
    expect(result.canCancel).toBe(false);
  });

  test("con un cheque ya anulado individualmente → también bloqueado (no es un 'ya está bien')", () => {
    const result = checkBatchCancellable(cancelInput({ checks: [{ id: 9, status: "anulado" }] }));
    expect(result.canCancel).toBe(false);
  });

  test("cheques todos en_cartera → no bloquean", () => {
    const result = checkBatchCancellable(cancelInput({
      checks: [{ id: 1, status: "en_cartera" }, { id: 2, status: "en_cartera" }],
    }));
    expect(result.canCancel).toBe(true);
  });

  test("acumula TODOS los motivos de bloqueo a la vez, no corta en el primero", () => {
    const result = checkBatchCancellable(cancelInput({
      childPayments: [{ id: 1, status: "confirmado", rendered: 1 }],
      remittanceAllocationCount: 1,
      remittanceItemCount: 1,
      checks: [{ id: 9, status: "cobrado" }],
    }));
    expect(result.canCancel).toBe(false);
    expect(result.blockingReasons.length).toBe(4);
  });

  test("varios hijos confirmados sin rendir, sin ninguna actividad → permitido", () => {
    const result = checkBatchCancellable(cancelInput({
      childPayments: [
        { id: 1, status: "confirmado", rendered: 0 },
        { id: 2, status: "confirmado", rendered: 0 },
        { id: 3, status: "confirmado", rendered: 0 },
      ],
    }));
    expect(result.canCancel).toBe(true);
  });
});

// ─── PATCH administrativo ────────────────────────────────────────────────────

describe("findDisallowedBatchPatchFields", () => {
  test("paymentDate y notes solos → sin campos rechazados", () => {
    expect(findDisallowedBatchPatchFields({ paymentDate: "2027-06-01", notes: "x" })).toEqual([]);
  });
  test("solo notes → sin campos rechazados", () => {
    expect(findDisallowedBatchPatchFields({ notes: "x" })).toEqual([]);
  });
  test("items/amount/splits/insuredId → todos rechazados", () => {
    const rejected = findDisallowedBatchPatchFields({ items: [], amount: 100, splits: [], insuredId: 5 });
    expect(rejected.sort()).toEqual(["amount", "insuredId", "items", "splits"]);
  });
  test("mezcla de permitido y no permitido → solo lista lo no permitido", () => {
    expect(findDisallowedBatchPatchFields({ notes: "x", totalReceivedCents: 100 })).toEqual(["totalReceivedCents"]);
  });
  test("body vacío → sin campos rechazados", () => {
    expect(findDisallowedBatchPatchFields({})).toEqual([]);
  });
});

describe("canPatchBatch", () => {
  const okChild: BatchCancelChildPayment = { id: 1, status: "confirmado", rendered: 0 };
  test("confirmado y sin hijos rendidos → permitido", () => {
    expect(canPatchBatch("confirmado", [okChild]).canPatch).toBe(true);
  });
  test("anulado → bloqueado", () => {
    const result = canPatchBatch("anulado", [okChild]);
    expect(result.canPatch).toBe(false);
    expect(result.blockingReasons[0]).toContain('status="anulado"');
  });
  test("con un hijo rendido → bloqueado aunque el batch siga confirmado", () => {
    const result = canPatchBatch("confirmado", [{ id: 1, status: "confirmado", rendered: 1 }]);
    expect(result.canPatch).toBe(false);
  });
});
