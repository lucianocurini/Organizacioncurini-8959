import { test, expect, describe } from "bun:test";
import {
  CashPeriodPaymentValidationError,
  validateCashPaymentAmountInput,
  validateCashPaymentAmountAgainstNominal,
  assertAllInstallmentsEligibleForCashPeriod,
  checkCashPeriodEligibility,
  buildCashPeriodPaymentSnapshot,
  getCommissionBaseAmountCents,
  calculateCashPeriodDeadline,
  getCashPeriodDeadlineStatus,
  type CashPeriodInstallmentForEligibility,
} from "../../lib/payments/cash-period-payments";

describe("validateCashPaymentAmountInput", () => {
  test("null/undefined es válido (opcional)", () => {
    expect(validateCashPaymentAmountInput(null)).toBeNull();
    expect(validateCashPaymentAmountInput(undefined)).toBeNull();
  });
  test("entero positivo se acepta tal cual", () => {
    expect(validateCashPaymentAmountInput(38000000)).toBe(38000000);
  });
  test("rechaza cero", () => {
    expect(() => validateCashPaymentAmountInput(0)).toThrow(CashPeriodPaymentValidationError);
  });
  test("rechaza negativo", () => {
    expect(() => validateCashPaymentAmountInput(-100)).toThrow(CashPeriodPaymentValidationError);
  });
  test("rechaza no entero (centavos fraccionados)", () => {
    expect(() => validateCashPaymentAmountInput(100.5)).toThrow(CashPeriodPaymentValidationError);
  });
  test("rechaza no numérico", () => {
    expect(() => validateCashPaymentAmountInput("abc")).toThrow(CashPeriodPaymentValidationError);
  });
});

describe("validateCashPaymentAmountAgainstNominal", () => {
  test("permite contado menor al nominal", () => {
    expect(() => validateCashPaymentAmountAgainstNominal(38000000, 40000000)).not.toThrow();
  });
  test("permite contado igual al nominal (descuento $0)", () => {
    expect(() => validateCashPaymentAmountAgainstNominal(40000000, 40000000)).not.toThrow();
  });
  test("rechaza contado mayor al nominal", () => {
    expect(() => validateCashPaymentAmountAgainstNominal(40000001, 40000000)).toThrow(CashPeriodPaymentValidationError);
  });
});

function mkInstallment(overrides: Partial<CashPeriodInstallmentForEligibility> = {}): CashPeriodInstallmentForEligibility {
  return { id: 1, status: "pendiente", rendered: 0, hasConfirmedPayment: false, ...overrides };
}

describe("assertAllInstallmentsEligibleForCashPeriod", () => {
  test("rechaza período sin cuotas", () => {
    expect(() => assertAllInstallmentsEligibleForCashPeriod([])).toThrow(CashPeriodPaymentValidationError);
  });
  test("acepta todas pendientes/vencidas sin actividad", () => {
    expect(() =>
      assertAllInstallmentsEligibleForCashPeriod([
        mkInstallment({ id: 1, status: "pendiente" }),
        mkInstallment({ id: 2, status: "vencida" }),
      ])
    ).not.toThrow();
  });
  test("bloquea si una cuota ya está pagada", () => {
    expect(() =>
      assertAllInstallmentsEligibleForCashPeriod([mkInstallment({ id: 1, status: "pagada" })])
    ).toThrow(/ya está pagada/);
  });
  test("bloquea si una cuota ya fue rendida", () => {
    expect(() =>
      assertAllInstallmentsEligibleForCashPeriod([mkInstallment({ id: 1, rendered: 1 })])
    ).toThrow(/ya fue rendida/);
  });
  test("bloquea si una cuota ya tiene pago confirmado vinculado", () => {
    expect(() =>
      assertAllInstallmentsEligibleForCashPeriod([mkInstallment({ id: 1, hasConfirmedPayment: true })])
    ).toThrow(/ya tiene un pago confirmado/);
  });
  test("bloquea si una cuota es no_exigible", () => {
    expect(() =>
      assertAllInstallmentsEligibleForCashPeriod([mkInstallment({ id: 1, status: "no_exigible" })])
    ).toThrow(/no es exigible/);
  });
  test("bloquea el período entero aunque solo UNA de varias cuotas tenga actividad (todo o nada)", () => {
    expect(() =>
      assertAllInstallmentsEligibleForCashPeriod([
        mkInstallment({ id: 1, status: "pendiente" }),
        mkInstallment({ id: 2, status: "pendiente" }),
        mkInstallment({ id: 3, status: "pagada" }),
        mkInstallment({ id: 4, status: "pendiente" }),
      ])
    ).toThrow(/La cuota 3 ya está pagada/);
  });
  test("acumula todos los motivos de bloqueo, no solo el primero", () => {
    try {
      assertAllInstallmentsEligibleForCashPeriod([
        mkInstallment({ id: 1, status: "pagada" }),
        mkInstallment({ id: 2, rendered: 1 }),
      ]);
      throw new Error("no debería llegar acá");
    } catch (e: any) {
      expect(e).toBeInstanceOf(CashPeriodPaymentValidationError);
      expect(e.message).toMatch(/cuota 1 ya está pagada/);
      expect(e.message).toMatch(/cuota 2 ya fue rendida/);
    }
  });
});

describe("checkCashPeriodEligibility — variante sin throw de assertAllInstallmentsEligibleForCashPeriod", () => {
  test("período sin cuotas → no elegible, con motivo", () => {
    const result = checkCashPeriodEligibility([]);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["El período no tiene ninguna cuota — no se puede pagar de contado."]);
  });
  test("todas pendientes/vencidas sin actividad → elegible, sin motivos", () => {
    expect(
      checkCashPeriodEligibility([
        mkInstallment({ id: 1, status: "pendiente" }),
        mkInstallment({ id: 2, status: "vencida" }),
      ])
    ).toEqual({ eligible: true, reasons: [] });
  });
  test("una cuota con actividad → no elegible, junta el mismo motivo que la versión que lanza", () => {
    const result = checkCashPeriodEligibility([mkInstallment({ id: 1, status: "pagada" })]);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["La cuota 1 ya está pagada."]);
  });
  test("acumula todos los motivos igual que assertAllInstallmentsEligibleForCashPeriod", () => {
    const result = checkCashPeriodEligibility([
      mkInstallment({ id: 1, status: "pagada" }),
      mkInstallment({ id: 2, rendered: 1 }),
    ]);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["La cuota 1 ya está pagada.", "La cuota 2 ya fue rendida."]);
  });
  test("nunca lanza, a diferencia de assertAllInstallmentsEligibleForCashPeriod con la misma entrada", () => {
    const installments = [mkInstallment({ id: 1, status: "pagada" })];
    expect(() => checkCashPeriodEligibility(installments)).not.toThrow();
    expect(() => assertAllInstallmentsEligibleForCashPeriod(installments)).toThrow(CashPeriodPaymentValidationError);
  });
});

describe("calculateCashPeriodDeadline", () => {
  test("suma 30 días corridos al inicio del período (emisión/renovación: policy.startDate)", () => {
    expect(calculateCashPeriodDeadline("2026-07-01")).toBe("2026-07-31");
  });
  test("suma 30 días corridos cruzando de mes (refacturación: rebilling.billingStart)", () => {
    expect(calculateCashPeriodDeadline("2026-07-15")).toBe("2026-08-14");
  });
});

describe("getCashPeriodDeadlineStatus", () => {
  test("día límite inclusive → vigente", () => {
    const deadline = calculateCashPeriodDeadline("2026-07-01"); // 2026-07-31
    expect(getCashPeriodDeadlineStatus(deadline, "2026-07-31")).toBe("vigente");
  });
  test("día siguiente al límite → vencido (pero el pago sigue permitido — ver más abajo)", () => {
    const deadline = calculateCashPeriodDeadline("2026-07-01"); // 2026-07-31
    expect(getCashPeriodDeadlineStatus(deadline, "2026-08-01")).toBe("vencido");
  });
  test("cualquier día antes del límite → vigente", () => {
    const deadline = calculateCashPeriodDeadline("2026-07-01"); // 2026-07-31
    expect(getCashPeriodDeadlineStatus(deadline, "2026-07-02")).toBe("vigente");
  });
  test("mucho después del límite → vencido", () => {
    const deadline = calculateCashPeriodDeadline("2026-07-01"); // 2026-07-31
    expect(getCashPeriodDeadlineStatus(deadline, "2027-01-01")).toBe("vencido");
  });

  test("fecha nocturna Argentina: 'hoy' calculado con toArgentinaCalendarDay al filo de la medianoche UTC no corre el estado un día", () => {
    // Mismo patrón de regresión que rendición #115 (ver argentina-date.test.ts):
    // 31/07 23:00 hora Argentina es 2026-08-01T02:00:00Z en UTC. Si "hoy" se
    // calculara mal (día UTC en vez de día calendario Argentina) el 31/07
    // se leería como 01/08. Acá se simula pasando ya el día Argentina correcto
    // (lo que toArgentinaCalendarDay(new Date("2026-08-01T02:00:00.000Z"))
    // devolvería: "2026-07-31") y se verifica que con el límite del mismo día
    // el estado siga siendo vigente, no vencido.
    const deadline = "2026-07-31";
    const todayArgentina = "2026-07-31"; // ya resuelto en Argentina, no en UTC
    expect(getCashPeriodDeadlineStatus(deadline, todayArgentina)).toBe("vigente");
  });

  test("bloqueo por actividad en cuotas es un eje independiente: vencido pero sin actividad sigue siendo cobrable", () => {
    const deadline = calculateCashPeriodDeadline("2026-01-01"); // 2026-01-31, muy vencido
    expect(getCashPeriodDeadlineStatus(deadline, "2026-07-29")).toBe("vencido");
    // La única función que puede bloquear el cobro es la de actividad —
    // el estado de vencimiento nunca lanza ni participa en esa decisión.
    expect(() =>
      assertAllInstallmentsEligibleForCashPeriod([
        mkInstallment({ id: 1, status: "pendiente" }),
        mkInstallment({ id: 2, status: "vencida" }),
      ])
    ).not.toThrow();
  });

  test("bloqueo por actividad en cuotas es un eje independiente: vigente pero con actividad sigue bloqueado", () => {
    const deadline = calculateCashPeriodDeadline("2026-07-01"); // 2026-07-31, todavía vigente
    expect(getCashPeriodDeadlineStatus(deadline, "2026-07-15")).toBe("vigente");
    expect(() =>
      assertAllInstallmentsEligibleForCashPeriod([mkInstallment({ id: 1, status: "pagada" })])
    ).toThrow(/ya está pagada/);
  });
});

describe("buildCashPeriodPaymentSnapshot", () => {
  test("contado menor al nominal: descuento positivo", () => {
    const snap = buildCashPeriodPaymentSnapshot(40000000, 38000000);
    expect(snap).toEqual({ nominalAmountCents: 40000000, cashAmountCents: 38000000, discountAmountCents: 2000000 });
  });
  test("contado igual al nominal: descuento $0", () => {
    const snap = buildCashPeriodPaymentSnapshot(40000000, 40000000);
    expect(snap.discountAmountCents).toBe(0);
  });
  test("rechaza contado mayor al nominal", () => {
    expect(() => buildCashPeriodPaymentSnapshot(40000000, 40000001)).toThrow(CashPeriodPaymentValidationError);
  });
  test("rechaza nominal cero o negativo", () => {
    expect(() => buildCashPeriodPaymentSnapshot(0, 0)).toThrow(CashPeriodPaymentValidationError);
    expect(() => buildCashPeriodPaymentSnapshot(-100, -50)).toThrow(CashPeriodPaymentValidationError);
  });
  test("rechaza contado cero", () => {
    expect(() => buildCashPeriodPaymentSnapshot(40000000, 0)).toThrow(CashPeriodPaymentValidationError);
  });
  test("centavos: cierra exacto sin arrastrar resto", () => {
    const snap = buildCashPeriodPaymentSnapshot(333, 111);
    expect(snap.discountAmountCents).toBe(222);
  });
});

// La validación de "medios vs. contado" (con tolerancia de redondeo, ronda 2
// del pedido) ya no vive en un helper propio de este módulo — reutiliza
// directo calculateBatchReceivedAppliedDifference/validateRoundingAdjustment
// de insured-account.ts (ya cubiertas por sus propios tests) — ver POST
// /payment-batches/cash-period-payment en index.ts, y los tests HTTP en
// cash-period-payments-endpoints.test.ts para el comportamiento end-to-end.

describe("getCommissionBaseAmountCents — Regla 9: comisión sobre el importe contado real", () => {
  test("contado menor al nominal: la base de comisión es el contado, nunca el nominal", () => {
    const cashPeriodPayment = { nominalAmountCents: 40000000, cashAmountCents: 38000000, discountAmountCents: 2000000 };
    expect(getCommissionBaseAmountCents(cashPeriodPayment)).toBe(38000000);
    expect(getCommissionBaseAmountCents(cashPeriodPayment)).not.toBe(cashPeriodPayment.nominalAmountCents);
  });
  test("contado igual al nominal: la base de comisión coincide (sin descuento)", () => {
    const cashPeriodPayment = { nominalAmountCents: 40000000, cashAmountCents: 40000000, discountAmountCents: 0 };
    expect(getCommissionBaseAmountCents(cashPeriodPayment)).toBe(40000000);
  });
});
