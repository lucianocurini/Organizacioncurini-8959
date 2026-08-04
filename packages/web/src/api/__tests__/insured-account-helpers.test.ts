/**
 * Tests de los helpers puros de cuenta corriente del asegurado (sobrantes/
 * faltantes en cobros, Migración 0030, Fase 2A). Sin DB, sin HTTP —
 * src/lib/payments/insured-account.ts. Ningún endpoint usa todavía estos
 * helpers (base técnica de esta fase, sin flujo de cobro completo).
 */

import { test, expect, describe } from "bun:test";
import {
  calculateBatchReceivedAppliedDifference,
  resolveSingleRealInsuredIdForBalance,
  calculateInsuredAccountBalance,
  summarizeInsuredAccountBalances,
  validateInsuredAccountMovement,
  validatePaymentAmountAdjustment,
  calculateCreditActiveInCaja,
  calculateCreditRegularizedInCaja,
  calculateCobroSaldoDeudorInCaja,
  isSafeToCancelAccountMovementOrigin,
  InsuredAccountValidationError,
  MAX_ROUNDING_ADJUSTMENT_CENTS,
  ROUNDING_ADJUSTMENT_REASON,
  validateRoundingAdjustment,
  calculatePaymentAmountAdjustmentCreditInCaja,
  type InsuredAccountMovementForBalance,
  type InsuredAccountMovementForCaja,
  type PaymentAmountAdjustmentForCaja,
} from "../../lib/payments/insured-account";

// ─── calculateBatchReceivedAppliedDifference ───────────────────────────────

describe("calculateBatchReceivedAppliedDifference", () => {
  test("pago exacto: diferencia 0", () => {
    const result = calculateBatchReceivedAppliedDifference(100000, 100000);
    expect(result.kind).toBe("exacto");
    expect(result.differenceCents).toBe(0);
  });

  test("cheque mayor: received > applied → saldo a favor", () => {
    const result = calculateBatchReceivedAppliedDifference(150000, 100000);
    expect(result.kind).toBe("saldo_a_favor");
    expect(result.differenceCents).toBe(50000);
  });

  test("cheque menor, aplicado igual: received < applied → saldo deudor", () => {
    const result = calculateBatchReceivedAppliedDifference(70000, 100000);
    expect(result.kind).toBe("saldo_deudor");
    expect(result.differenceCents).toBe(-30000);
  });
});

// ─── resolveSingleRealInsuredIdForBalance ──────────────────────────────────

describe("resolveSingleRealInsuredIdForBalance", () => {
  test("batch multiasegurado (2+ insuredId reales distintos) bloquea saldo automático", () => {
    expect(resolveSingleRealInsuredIdForBalance([1, 2])).toBeNull();
    expect(resolveSingleRealInsuredIdForBalance([1, null, 2])).toBeNull();
  });

  test("batch con único insuredId real permite saldo", () => {
    expect(resolveSingleRealInsuredIdForBalance([5, 5, null])).toBe(5);
  });

  test("batch 100% manual (sin ningún insuredId real) bloquea saldo automático", () => {
    expect(resolveSingleRealInsuredIdForBalance([null, null])).toBeNull();
    expect(resolveSingleRealInsuredIdForBalance([])).toBeNull();
  });
});

// ─── calculateInsuredAccountBalance / summarizeInsuredAccountBalances ─────

describe("calculateInsuredAccountBalance", () => {
  test("suma solo movimientos activo, ignora anulado", () => {
    const movements: Pick<InsuredAccountMovementForBalance, "signedAmountCents" | "status">[] = [
      { signedAmountCents: 10000, status: "activo" },
      { signedAmountCents: -3000, status: "activo" },
      { signedAmountCents: 99999, status: "anulado" },
    ];
    expect(calculateInsuredAccountBalance(movements)).toBe(7000);
  });

  test("saldo a favor + aplicación futura: cuenta corriente baja a 0 (SUM simple, sin condicionar por rendered)", () => {
    const movements: Pick<InsuredAccountMovementForBalance, "signedAmountCents" | "status">[] = [
      { signedAmountCents: 10000, status: "activo" }, // saldo_a_favor
      { signedAmountCents: -10000, status: "activo" }, // aplicacion_saldo_favor, relatedPayment aún no rendido
    ];
    expect(calculateInsuredAccountBalance(movements)).toBe(0);
  });
});

describe("summarizeInsuredAccountBalances", () => {
  test("separa saldos a favor y deudores pendientes por asegurado", () => {
    const movements: InsuredAccountMovementForBalance[] = [
      { insuredId: 1, signedAmountCents: 10000, status: "activo" },
      { insuredId: 1, signedAmountCents: 2000, status: "activo" },
      { insuredId: 2, signedAmountCents: -5000, status: "activo" },
      { insuredId: 3, signedAmountCents: 99999, status: "anulado" }, // ignorado
    ];
    const summary = summarizeInsuredAccountBalances(movements);
    expect(summary.saldosAFavorPendientesCents).toBe(12000);
    expect(summary.saldosDeudoresPendientesCents).toBe(5000);
    expect(summary.byInsured).toEqual(
      expect.arrayContaining([
        { insuredId: 1, balanceCents: 12000 },
        { insuredId: 2, balanceCents: -5000 },
      ])
    );
  });
});

// ─── validateInsuredAccountMovement ────────────────────────────────────────

describe("validateInsuredAccountMovement", () => {
  test("acepta saldo_a_favor válido (positivo, sin reason/authorizedBy)", () => {
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 1, type: "saldo_a_favor", signedAmountCents: 10000 })
    ).not.toThrow();
  });

  test("rechaza signedAmountCents en 0", () => {
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 1, type: "saldo_a_favor", signedAmountCents: 0 })
    ).toThrow(InsuredAccountValidationError);
  });

  test("rechaza type fuera de vocabulario", () => {
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 1, type: "no_existe" as any, signedAmountCents: 1000 })
    ).toThrow(InsuredAccountValidationError);
  });

  test("rechaza signo incorrecto: saldo_a_favor negativo", () => {
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 1, type: "saldo_a_favor", signedAmountCents: -1000 })
    ).toThrow(/positivo/);
  });

  test("rechaza signo incorrecto: saldo_deudor positivo", () => {
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 1, type: "saldo_deudor", signedAmountCents: 1000, reason: "motivo" })
    ).toThrow(/negativo/);
  });

  test("saldo_deudor requiere reason", () => {
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 1, type: "saldo_deudor", signedAmountCents: -1000 })
    ).toThrow(/reason/);
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 1, type: "saldo_deudor", signedAmountCents: -1000, reason: "cheque rechazado" })
    ).not.toThrow();
  });

  test("devolucion_saldo_favor requiere reason", () => {
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 1, type: "devolucion_saldo_favor", signedAmountCents: -5000 })
    ).toThrow(/reason/);
  });

  test("ajuste_manual requiere reason y authorizedBy", () => {
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 1, type: "ajuste_manual", signedAmountCents: -5000 })
    ).toThrow(/reason/);
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 1, type: "ajuste_manual", signedAmountCents: -5000, reason: "error de carga" })
    ).toThrow(/authorizedBy/);
    expect(() =>
      validateInsuredAccountMovement({
        insuredId: 1, type: "ajuste_manual", signedAmountCents: -5000, reason: "error de carga", authorizedBy: 7,
      })
    ).not.toThrow();
  });

  test("aplicacion_saldo_favor requiere relatedPaymentId", () => {
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 1, type: "aplicacion_saldo_favor", signedAmountCents: -5000 })
    ).toThrow(/relatedPaymentId/);
    expect(() =>
      validateInsuredAccountMovement({
        insuredId: 1, type: "aplicacion_saldo_favor", signedAmountCents: -5000, relatedPaymentId: 42,
      })
    ).not.toThrow();
  });

  test("rechaza insuredId inválido", () => {
    expect(() =>
      validateInsuredAccountMovement({ insuredId: 0, type: "saldo_a_favor", signedAmountCents: 1000 })
    ).toThrow(InsuredAccountValidationError);
  });
});

// ─── validatePaymentAmountAdjustment ───────────────────────────────────────

describe("validatePaymentAmountAdjustment", () => {
  test("acepta con solo paymentId", () => {
    expect(() =>
      validatePaymentAmountAdjustment({ paymentId: 1, amountCents: -500, reason: "ajuste", authorizedBy: 3 })
    ).not.toThrow();
  });

  test("acepta con solo paymentBatchId", () => {
    expect(() =>
      validatePaymentAmountAdjustment({ paymentBatchId: 1, amountCents: 500, reason: "ajuste", authorizedBy: 3 })
    ).not.toThrow();
  });

  test("rechaza ambos a la vez (XOR)", () => {
    expect(() =>
      validatePaymentAmountAdjustment({ paymentId: 1, paymentBatchId: 2, amountCents: 500, reason: "x", authorizedBy: 3 })
    ).toThrow(/exactamente uno/);
  });

  test("rechaza ninguno de los dos (XOR)", () => {
    expect(() =>
      validatePaymentAmountAdjustment({ amountCents: 500, reason: "x", authorizedBy: 3 })
    ).toThrow(/exactamente uno/);
  });

  test("rechaza amountCents en 0", () => {
    expect(() =>
      validatePaymentAmountAdjustment({ paymentId: 1, amountCents: 0, reason: "x", authorizedBy: 3 })
    ).toThrow(InsuredAccountValidationError);
  });

  test("reason y authorizedBy siempre obligatorios", () => {
    expect(() =>
      validatePaymentAmountAdjustment({ paymentId: 1, amountCents: 500, authorizedBy: 3 })
    ).toThrow(/reason/);
    expect(() =>
      validatePaymentAmountAdjustment({ paymentId: 1, amountCents: 500, reason: "x" })
    ).toThrow(/authorizedBy/);
  });
});

// ─── Contribución a Caja ────────────────────────────────────────────────────

function movCaja(overrides: Partial<InsuredAccountMovementForCaja>): InsuredAccountMovementForCaja {
  return { type: "saldo_a_favor", signedAmountCents: 10000, status: "activo", relatedPaymentRendered: null, ...overrides };
}

describe("calculateCreditActiveInCaja", () => {
  test("saldo_a_favor solo suma Caja", () => {
    const total = calculateCreditActiveInCaja([movCaja({ type: "saldo_a_favor", signedAmountCents: 10000 })]);
    expect(total).toBe(10000);
  });

  test("aplicacion_saldo_favor NO resta Caja mientras relatedPayment no está rendido", () => {
    const movements = [
      movCaja({ type: "saldo_a_favor", signedAmountCents: 10000 }),
      movCaja({ type: "aplicacion_saldo_favor", signedAmountCents: -10000, relatedPaymentRendered: false }),
    ];
    expect(calculateCreditActiveInCaja(movements)).toBe(10000); // el crédito sigue "activo" en Caja
  });

  test("aplicacion_saldo_favor SÍ resta Caja una vez que relatedPayment se rinde", () => {
    const movements = [
      movCaja({ type: "saldo_a_favor", signedAmountCents: 10000 }),
      movCaja({ type: "aplicacion_saldo_favor", signedAmountCents: -10000, relatedPaymentRendered: true }),
    ];
    expect(calculateCreditActiveInCaja(movements)).toBe(0);
  });

  test("devolucion baja Caja", () => {
    const movements = [
      movCaja({ type: "saldo_a_favor", signedAmountCents: 10000 }),
      movCaja({ type: "devolucion_saldo_favor", signedAmountCents: -4000 }),
    ];
    expect(calculateCreditActiveInCaja(movements)).toBe(6000);
  });

  test("ajuste_manual que reduce crédito baja creditoActivoEnCaja (se cancela con creditoRegularizado)", () => {
    const movements = [
      movCaja({ type: "saldo_a_favor", signedAmountCents: 10000 }),
      movCaja({ type: "ajuste_manual", signedAmountCents: -10000 }),
    ];
    expect(calculateCreditActiveInCaja(movements)).toBe(0);
  });

  test("ajuste_manual que AUMENTA crédito (signo positivo) se excluye entero — no suma Caja", () => {
    const movements = [
      movCaja({ type: "saldo_a_favor", signedAmountCents: 10000 }),
      movCaja({ type: "ajuste_manual", signedAmountCents: 3000 }),
    ];
    expect(calculateCreditActiveInCaja(movements)).toBe(10000); // el ajuste positivo no aporta plata real
  });

  test("saldo_deudor no suma Caja", () => {
    const movements = [movCaja({ type: "saldo_deudor", signedAmountCents: -5000 })];
    expect(calculateCreditActiveInCaja(movements)).toBe(0);
  });

  test("cobro_saldo_deudor no aparece en creditoActivoEnCaja (va en su propio bucket)", () => {
    const movements = [movCaja({ type: "cobro_saldo_deudor", signedAmountCents: 5000 })];
    expect(calculateCreditActiveInCaja(movements)).toBe(0);
  });

  test("movimientos status=anulado se ignoran", () => {
    const movements = [movCaja({ type: "saldo_a_favor", signedAmountCents: 10000, status: "anulado" })];
    expect(calculateCreditActiveInCaja(movements)).toBe(0);
  });
});

describe("calculateCreditRegularizedInCaja", () => {
  test("ajuste manual cierra cuenta corriente pero NO baja Caja neta (creditoRegularizado cancela a creditoActivo)", () => {
    const movements = [
      movCaja({ type: "saldo_a_favor", signedAmountCents: 10000 }),
      movCaja({ type: "ajuste_manual", signedAmountCents: -10000 }),
    ];
    const creditoActivo = calculateCreditActiveInCaja(movements);
    const creditoRegularizado = calculateCreditRegularizedInCaja(movements);
    expect(creditoRegularizado).toBe(10000);
    // Caja neta aportada por cuenta corriente = creditoActivo + creditoRegularizado, nunca se mueve por el ajuste.
    expect(creditoActivo + creditoRegularizado).toBe(10000); // igual a como estaba antes del ajuste
  });

  test("ajuste_manual que aumenta crédito no genera creditoRegularizado", () => {
    const movements = [movCaja({ type: "ajuste_manual", signedAmountCents: 3000 })];
    expect(calculateCreditRegularizedInCaja(movements)).toBe(0);
  });

  test("sin ajuste_manual, creditoRegularizado es 0", () => {
    const movements = [movCaja({ type: "saldo_a_favor", signedAmountCents: 10000 })];
    expect(calculateCreditRegularizedInCaja(movements)).toBe(0);
  });
});

describe("calculateCobroSaldoDeudorInCaja", () => {
  test("cobro_saldo_deudor suma Caja", () => {
    const movements = [movCaja({ type: "cobro_saldo_deudor", signedAmountCents: 7000 })];
    expect(calculateCobroSaldoDeudorInCaja(movements)).toBe(7000);
  });

  test("saldo_deudor no suma Caja (no aparece en este bucket tampoco)", () => {
    const movements = [movCaja({ type: "saldo_deudor", signedAmountCents: -7000 })];
    expect(calculateCobroSaldoDeudorInCaja(movements)).toBe(0);
  });

  test("ignora movimientos anulados", () => {
    const movements = [movCaja({ type: "cobro_saldo_deudor", signedAmountCents: 7000, status: "anulado" })];
    expect(calculateCobroSaldoDeudorInCaja(movements)).toBe(0);
  });
});

// ─── isSafeToCancelAccountMovementOrigin (Fase 2D) ─────────────────────────

describe("isSafeToCancelAccountMovementOrigin", () => {
  test("sin ningún consumo activo — siempre seguro", () => {
    const safe = isSafeToCancelAccountMovementOrigin({
      thisOriginAmountCents: 10000, totalActivePoolCents: 10000, totalActiveConsumptionCents: 0,
    });
    expect(safe).toBe(true);
  });

  test("único crédito del asegurado y ya fue consumido entero — no es seguro", () => {
    // pool=10000 (solo este origen), consumo=10000 → sin este origen quedan
    // 0, que no alcanzan para explicar el consumo de 10000.
    const safe = isSafeToCancelAccountMovementOrigin({
      thisOriginAmountCents: 10000, totalActivePoolCents: 10000, totalActiveConsumptionCents: 10000,
    });
    expect(safe).toBe(false);
  });

  test("hay OTRO crédito del mismo asegurado que alcanza para explicar todo el consumo — seguro", () => {
    // pool=25000 (10000 de este origen + 15000 de otro), consumo=15000 →
    // sin este origen quedan 15000, exactamente lo consumido: alcanza.
    const safe = isSafeToCancelAccountMovementOrigin({
      thisOriginAmountCents: 10000, totalActivePoolCents: 25000, totalActiveConsumptionCents: 15000,
    });
    expect(safe).toBe(true);
  });

  test("el consumo excede lo que explican los OTROS créditos por un solo peso — no es seguro (borde exacto)", () => {
    // pool=25000, consumo=15001 → sin este origen quedan 15000, no alcanza
    // por 1 centavo: una parte del consumo necesariamente vino de acá.
    const safe = isSafeToCancelAccountMovementOrigin({
      thisOriginAmountCents: 10000, totalActivePoolCents: 25000, totalActiveConsumptionCents: 15001,
    });
    expect(safe).toBe(false);
  });

  test("mismo razonamiento aplica simétrico para saldo_deudor/cobro_saldo_deudor (pool y consumo en valor absoluto)", () => {
    // deuda de este origen $100 + otra deuda $50 = pool $150; ya se cobraron
    // $50 → sin este origen quedan $50, exactamente lo cobrado: alcanza.
    const safe = isSafeToCancelAccountMovementOrigin({
      thisOriginAmountCents: 10000, totalActivePoolCents: 15000, totalActiveConsumptionCents: 5000,
    });
    expect(safe).toBe(true);
  });
});

// ─── validateRoundingAdjustment / MAX_ROUNDING_ADJUSTMENT_CENTS ────────────
// Tolerancia de redondeo (payment_amount_adjustments) — reutiliza la tabla
// del "caso sin asegurado real" para una diferencia CHICA y acotada,
// independiente de insured_account_movements.

describe("MAX_ROUNDING_ADJUSTMENT_CENTS", () => {
  test("es exactamente 500 (tope de $5,00)", () => {
    expect(MAX_ROUNDING_ADJUSTMENT_CENTS).toBe(500);
  });
});

describe("validateRoundingAdjustment", () => {
  test("caso real: faltante de -234 centavos ($2,34) → válido", () => {
    expect(() => validateRoundingAdjustment({ differenceCents: -234 })).not.toThrow();
  });

  test("diferencia 0 → rechaza (sin ajuste no hay nada que registrar)", () => {
    expect(() => validateRoundingAdjustment({ differenceCents: 0 })).toThrow(InsuredAccountValidationError);
  });

  test("-500 centavos ($5,00 faltante) → válido (límite inclusive)", () => {
    expect(() => validateRoundingAdjustment({ differenceCents: -500 })).not.toThrow();
  });

  test("+500 centavos ($5,00 sobrante) → válido (límite inclusive)", () => {
    expect(() => validateRoundingAdjustment({ differenceCents: 500 })).not.toThrow();
  });

  test("-501 centavos ($5,01 faltante) → rechaza", () => {
    expect(() => validateRoundingAdjustment({ differenceCents: -501 })).toThrow(InsuredAccountValidationError);
  });

  test("+501 centavos ($5,01 sobrante) → rechaza", () => {
    expect(() => validateRoundingAdjustment({ differenceCents: 501 })).toThrow(InsuredAccountValidationError);
  });

  test("diferencia grande (ej. $200.000) → rechaza, nunca se confía en que el frontend ya filtró", () => {
    expect(() => validateRoundingAdjustment({ differenceCents: -20000000 })).toThrow(InsuredAccountValidationError);
  });
});

describe("validatePaymentAmountAdjustment — reutilizado por el ajuste de redondeo", () => {
  test("acepta un ajuste de redondeo típico (paymentBatchId, amountCents negativo, reason estándar)", () => {
    expect(() => validatePaymentAmountAdjustment({
      paymentBatchId: 1, amountCents: -234, reason: ROUNDING_ADJUSTMENT_REASON, authorizedBy: 7,
    })).not.toThrow();
  });

  test("acepta amountCents positivo (sobrante) sin restricción de signo — a diferencia de insured_account_movements", () => {
    expect(() => validatePaymentAmountAdjustment({
      paymentBatchId: 1, amountCents: 300, reason: ROUNDING_ADJUSTMENT_REASON, authorizedBy: 7,
    })).not.toThrow();
  });
});

// ─── calculatePaymentAmountAdjustmentCreditInCaja ──────────────────────────

describe("calculatePaymentAmountAdjustmentCreditInCaja", () => {
  test("faltante (amountCents negativo) nunca suma Caja — ya excluido vía Math.min de applyBatchToCartera", () => {
    const adjustments: PaymentAmountAdjustmentForCaja[] = [{ amountCents: -234, parentActive: true }];
    expect(calculatePaymentAmountAdjustmentCreditInCaja(adjustments)).toBe(0);
  });

  test("sobrante (amountCents positivo) con lote activo → suma Caja", () => {
    const adjustments: PaymentAmountAdjustmentForCaja[] = [{ amountCents: 300, parentActive: true }];
    expect(calculatePaymentAmountAdjustmentCreditInCaja(adjustments)).toBe(300);
  });

  test("sobrante de un lote anulado → 0 (no contribuye, aunque la fila histórica siga existiendo)", () => {
    const adjustments: PaymentAmountAdjustmentForCaja[] = [{ amountCents: 300, parentActive: false }];
    expect(calculatePaymentAmountAdjustmentCreditInCaja(adjustments)).toBe(0);
  });

  test("varios ajustes mezclados — solo suma los sobrantes de lotes activos", () => {
    const adjustments: PaymentAmountAdjustmentForCaja[] = [
      { amountCents: 300, parentActive: true },   // suma
      { amountCents: -234, parentActive: true },  // no suma (faltante)
      { amountCents: 450, parentActive: false },  // no suma (lote anulado)
      { amountCents: 100, parentActive: true },   // suma
    ];
    expect(calculatePaymentAmountAdjustmentCreditInCaja(adjustments)).toBe(400);
  });

  test("lista vacía → 0", () => {
    expect(calculatePaymentAmountAdjustmentCreditInCaja([])).toBe(0);
  });
});
