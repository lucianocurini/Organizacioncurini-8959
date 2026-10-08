import { test, expect, describe } from "bun:test";
import {
  type TitularFormState, type AccountHolderOption,
  emptyTitularFormState, selectAccountHolder, clearAccountHolder, setDebtAuthorized,
  parseNonNegativeCentsInput, validateTitularEconomicFields,
  computeTitularPreview, buildTitularPayloadInput, computeTitularEconomicFingerprint,
  generateIdempotencyKey, buildTitularSummaryLines, MAX_ROUNDING_ADJUSTMENT_CENTS,
} from "../payment-batch-titular-form";
import { type BatchCartItem, type BatchSplitFormRow, createBatchSplitRow, buildPaymentBatchPayload } from "../payment-batch-form";

function installmentCartItem(overrides: Partial<Extract<BatchCartItem, { kind: "installment" }>> = {}): BatchCartItem {
  return {
    kind: "installment", installmentId: 1, policyId: 10, policyNumber: "POL-1",
    policyType: "automotor", parentPolicyId: null, parentPolicyNumber: null,
    insuredId: 100, insuredName: "Juan Pérez", companyId: 200, companyName: "Compañía A",
    installmentNumber: 1, dueDate: "2027-06-01", amount: 1000, status: "pendiente",
    ...overrides,
  };
}

function freeManualCartItem(overrides: Partial<Extract<BatchCartItem, { kind: "manual_payment" }>> = {}): BatchCartItem {
  return {
    kind: "manual_payment", localId: "manual-test-1", insuredId: null, insuredName: null,
    manualPayer: "Pagador libre", manualPolicyNumber: null, manualCompany: null,
    amount: 300, description: "",
    ...overrides,
  };
}

const holder: AccountHolderOption = { insuredId: 55, name: "María Gómez" };

describe("selectAccountHolder / clearAccountHolder", () => {
  test("seleccionar un titular activa el modo — arranca todos los campos económicos en blanco", () => {
    const state = selectAccountHolder(holder);
    expect(state.accountHolder).toEqual(holder);
    expect(state.creditAppliedInput).toBe("");
    expect(state.roundingCoverageInput).toBe("");
    expect(state.debtAuthorized).toBe(false);
    expect(state.debtReason).toBe("");
    expect(state.idempotencyKey).toBeNull();
  });

  test("seleccionar un titular con campos previos ya cargados los descarta igual (cambiar de titular resetea)", () => {
    const dirty: TitularFormState = {
      accountHolder: { insuredId: 1, name: "Otro" },
      creditAppliedInput: "500", roundingCoverageInput: "2",
      debtAuthorized: true, debtReason: "algo", idempotencyKey: "key-1",
    };
    const next = selectAccountHolder(holder);
    expect(next).not.toEqual(dirty);
    expect(next.accountHolder).toEqual(holder);
    expect(next.creditAppliedInput).toBe("");
    expect(next.idempotencyKey).toBeNull();
  });

  test("quitar el titular vuelve al estado vacío (modo legacy) — limpia TODOS los campos", () => {
    const dirty: TitularFormState = {
      accountHolder: holder, creditAppliedInput: "1200.50", roundingCoverageInput: "3",
      debtAuthorized: true, debtReason: "cliente pidió financiar", idempotencyKey: "key-abc",
    };
    const cleared = clearAccountHolder();
    expect(cleared).toEqual(emptyTitularFormState());
    expect(cleared.accountHolder).toBeNull();
    // Verifica explícitamente que ninguno de los campos de `dirty` sobrevive.
    expect(cleared).not.toEqual(dirty);
  });
});

describe("setDebtAuthorized", () => {
  test("desactivar debtAuthorized limpia debtReason", () => {
    const state = { ...emptyTitularFormState(), accountHolder: holder, debtAuthorized: true, debtReason: "motivo cargado" };
    const next = setDebtAuthorized(state, false);
    expect(next.debtAuthorized).toBe(false);
    expect(next.debtReason).toBe("");
  });

  test("activar debtAuthorized conserva un motivo ya tipeado", () => {
    const state = { ...emptyTitularFormState(), accountHolder: holder, debtAuthorized: false, debtReason: "borrador previo" };
    const next = setDebtAuthorized(state, true);
    expect(next.debtAuthorized).toBe(true);
    expect(next.debtReason).toBe("borrador previo");
  });
});

describe("parseNonNegativeCentsInput", () => {
  test("vacío -> 0", () => expect(parseNonNegativeCentsInput("")).toBe(0));
  test("solo espacios -> 0", () => expect(parseNonNegativeCentsInput("   ")).toBe(0));
  test("0 -> 0", () => expect(parseNonNegativeCentsInput("0")).toBe(0));
  test("importe positivo con centavos exactos -> centavos", () => expect(parseNonNegativeCentsInput("125.50")).toBe(12550));
  test("negativo -> null", () => expect(parseNonNegativeCentsInput("-5")).toBeNull());
  test("no numérico -> null", () => expect(parseNonNegativeCentsInput("abc")).toBeNull());
  test("más de dos decimales -> null", () => expect(parseNonNegativeCentsInput("1.005")).toBeNull());
});

describe("validateTitularEconomicFields", () => {
  function state(overrides: Partial<TitularFormState> = {}): TitularFormState {
    return { ...emptyTitularFormState(), accountHolder: holder, ...overrides };
  }

  test("crédito mayor al disponible -> rechazado", () => {
    const result = validateTitularEconomicFields(state({ creditAppliedInput: "600" }), 50000); // disponible $500
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("no puede superar el saldo disponible");
  });

  test("crédito igual al disponible -> aceptado", () => {
    const result = validateTitularEconomicFields(state({ creditAppliedInput: "500" }), 50000);
    expect(result.valid).toBe(true);
  });

  test("crédito con saldo negativo (titular deudor) -> tope efectivo es 0", () => {
    const result = validateTitularEconomicFields(state({ creditAppliedInput: "1" }), -20000);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("$0.00");
  });

  test("redondeo > $5,00 (500 centavos) -> rechazado", () => {
    const result = validateTitularEconomicFields(state({ roundingCoverageInput: "5.01" }), 1000000);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain(`$${(MAX_ROUNDING_ADJUSTMENT_CENTS / 100).toFixed(2)}`);
  });

  test("redondeo == $5,00 exacto -> aceptado", () => {
    const result = validateTitularEconomicFields(state({ roundingCoverageInput: "5.00" }), 1000000);
    expect(result.valid).toBe(true);
  });

  test("deuda autorizada sin motivo -> rechazado", () => {
    const result = validateTitularEconomicFields(state({ debtAuthorized: true, debtReason: "   " }), 1000000);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("motivo es obligatorio");
  });

  test("deuda autorizada con motivo -> aceptado", () => {
    const result = validateTitularEconomicFields(state({ debtAuthorized: true, debtReason: "cliente pidió financiar" }), 1000000);
    expect(result.valid).toBe(true);
  });

  test("crédito inválido (negativo) -> rechazado con mensaje propio", () => {
    const result = validateTitularEconomicFields(state({ creditAppliedInput: "-1" }), 1000000);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("crédito aplicado debe ser un importe válido");
  });
});

describe("computeTitularPreview — reutiliza planAccountHolderBatchFunding", () => {
  test("carrito vacío (targetCents<=0) -> error explícito, nunca llama al plan con un destino inválido", () => {
    const result = computeTitularPreview({
      targetCents: 0, splits: [], creditAppliedCents: 0, roundingCoverageCents: 0,
      availableCreditCents: 100000, debtAuthorized: false,
    });
    expect(result.ok).toBe(false);
  });

  test("cierre exacto: medios reales cubren el 100% del total, sin crédito", () => {
    const result = computeTitularPreview({
      targetCents: 100000, splits: [createBatchSplitRow("efectivo", "1000")],
      creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.nominalTotalCents).toBe(100000);
      expect(result.plan.realSplitsTotalCents).toBe(100000);
      expect(result.plan.newSaldoAFavorCents).toBe(0);
      expect(result.plan.newSaldoDeudorCents).toBe(0);
    }
  });

  test("crédito + medios + redondeo cierran exacto -> plan ok, sin deuda ni sobrante", () => {
    // total $1000, medios $747.50, crédito $250, redondeo $2.50 -> 747.50+250+2.50=1000
    const result = computeTitularPreview({
      targetCents: 100000, splits: [createBatchSplitRow("efectivo", "747.50")],
      creditAppliedCents: 25000, roundingCoverageCents: 250, availableCreditCents: 25000, debtAuthorized: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.creditAppliedCents).toBe(25000);
      expect(result.plan.roundingCoverageCents).toBe(250);
      expect(result.plan.newSaldoDeudorCents).toBe(0);
      expect(result.plan.newSaldoAFavorCents).toBe(0);
    }
  });

  test("crédito aplicado mayor al disponible -> el plan lo rechaza (defensa en profundidad, aunque la UI ya lo valida antes)", () => {
    const result = computeTitularPreview({
      targetCents: 100000, splits: [], creditAppliedCents: 60000,
      roundingCoverageCents: 0, availableCreditCents: 50000, debtAuthorized: false,
    });
    expect(result.ok).toBe(false);
  });

  test("faltante real sin deuda autorizada -> rechazado", () => {
    const result = computeTitularPreview({
      targetCents: 100000, splits: [createBatchSplitRow("efectivo", "500")],
      creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorMessage).toContain("faltante");
  });

  test("faltante real con deuda autorizada -> ok, con newSaldoDeudorCents", () => {
    const result = computeTitularPreview({
      targetCents: 100000, splits: [createBatchSplitRow("efectivo", "500")],
      creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.newSaldoDeudorCents).toBe(50000);
  });

  test("sobrante real sin crédito -> ok, con newSaldoAFavorCents", () => {
    const result = computeTitularPreview({
      targetCents: 100000, splits: [createBatchSplitRow("efectivo", "1200")],
      creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.newSaldoAFavorCents).toBe(20000);
  });

  test("splits con importe inválido/vacío se ignoran (no cuentan como medio real)", () => {
    const splits: BatchSplitFormRow[] = [createBatchSplitRow("efectivo", ""), createBatchSplitRow("transferencia", "0")];
    // Sin medios reales ni crédito, el total completo queda como faltante —
    // se autoriza deuda solo para poder inspeccionar realSplitsTotalCents del
    // plan resultante (el punto del test es la exclusión de importes
    // inválidos/0, no el cierre económico en sí). Sin saldo disponible: con
    // saldo sin aplicar, la regla "crédito antes que deuda" lo rechazaría.
    const result = computeTitularPreview({
      targetCents: 100000, splits, creditAppliedCents: 0, roundingCoverageCents: 0,
      availableCreditCents: 0, debtAuthorized: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.realSplitsTotalCents).toBe(0);
      expect(result.plan.newSaldoDeudorCents).toBe(100000);
    }
  });

  test("multiasegurado/manual permitido — el preview no distingue de dónde viene el total", () => {
    // El módulo solo recibe targetCents ya calculado por el caller — cualquier
    // composición de carrito (varios asegurados, 100% manual) llega igual acá.
    const result = computeTitularPreview({
      targetCents: 80000, splits: [createBatchSplitRow("efectivo", "800")],
      creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: false,
    });
    expect(result.ok).toBe(true);
  });
});

describe("buildTitularPayloadInput", () => {
  test("sin deuda autorizada -> debtReason siempre null, incluso si el usuario había tipeado algo antes", () => {
    const payload = buildTitularPayloadInput({
      accountHolderInsuredId: 55, creditAppliedCents: 10000, roundingCoverageCents: 0,
      debtAuthorized: false, debtReason: "texto que no debería viajar", idempotencyKey: "key-1",
    });
    expect(payload.debtReason).toBeNull();
  });

  test("con deuda autorizada -> debtReason recortado", () => {
    const payload = buildTitularPayloadInput({
      accountHolderInsuredId: 55, creditAppliedCents: 0, roundingCoverageCents: 0,
      debtAuthorized: true, debtReason: "  cliente pidió financiar  ", idempotencyKey: "key-2",
    });
    expect(payload.debtReason).toBe("cliente pidió financiar");
  });
});

describe("generateIdempotencyKey", () => {
  test("genera un string no vacío", () => {
    const key = generateIdempotencyKey();
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });

  test("dos llamadas producen keys distintas", () => {
    expect(generateIdempotencyKey()).not.toBe(generateIdempotencyKey());
  });
});

describe("computeTitularEconomicFingerprint — invalidación de idempotencyKey", () => {
  const base = {
    paymentDate: "2027-06-01",
    cart: [installmentCartItem({ amount: 1000 })] as BatchCartItem[],
    splits: [createBatchSplitRow("efectivo", "700")] as BatchSplitFormRow[],
    accountHolderInsuredId: 55,
    creditAppliedCents: 30000,
    roundingCoverageCents: 0,
    debtAuthorized: false,
    debtReason: "",
  };

  test("misma entrada -> misma huella (reintento de red/confirmación de duplicado reutilizan la key)", () => {
    expect(computeTitularEconomicFingerprint(base)).toBe(computeTitularEconomicFingerprint({ ...base }));
  });

  test("agregar un ítem al carrito cambia la huella", () => {
    const changed = { ...base, cart: [...base.cart, installmentCartItem({ installmentId: 2, amount: 500 })] };
    expect(computeTitularEconomicFingerprint(changed)).not.toBe(computeTitularEconomicFingerprint(base));
  });

  test("editar el importe de un split cambia la huella", () => {
    const changed = { ...base, splits: [createBatchSplitRow("efectivo", "650")] };
    expect(computeTitularEconomicFingerprint(changed)).not.toBe(computeTitularEconomicFingerprint(base));
  });

  test("cambiar el crédito aplicado cambia la huella", () => {
    const changed = { ...base, creditAppliedCents: 10000 };
    expect(computeTitularEconomicFingerprint(changed)).not.toBe(computeTitularEconomicFingerprint(base));
  });

  test("cambiar el titular (accountHolderInsuredId) cambia la huella", () => {
    const changed = { ...base, accountHolderInsuredId: 99 };
    expect(computeTitularEconomicFingerprint(changed)).not.toBe(computeTitularEconomicFingerprint(base));
  });

  test("cambiar las notas generales cambia la huella (integran el fingerprint del backend)", () => {
    expect(computeTitularEconomicFingerprint({ ...base, notes: "otra nota" })).not.toBe(computeTitularEconomicFingerprint({ ...base, notes: null }));
    expect(computeTitularEconomicFingerprint({ ...base, notes: null })).toBe(computeTitularEconomicFingerprint({ ...base }));
  });

  test("debtReason solo influye si debtAuthorized=true (coherente con buildTitularPayloadInput)", () => {
    const withReason = { ...base, debtAuthorized: false, debtReason: "texto ignorado" };
    expect(computeTitularEconomicFingerprint(withReason)).toBe(computeTitularEconomicFingerprint(base));
  });

  test("la huella coincide con el mapeo real de items/splits de buildPaymentBatchPayload (nunca una segunda serialización)", () => {
    const fp = JSON.parse(computeTitularEconomicFingerprint(base));
    const legacy = buildPaymentBatchPayload({ paymentDate: base.paymentDate, cart: base.cart, splits: base.splits });
    expect(fp.items).toEqual(legacy.items);
    expect(fp.splits).toEqual(legacy.splits);
  });
});

describe("buildTitularSummaryLines", () => {
  test("crédito + medios + redondeo: resumen incluye las 4 líneas relevantes, en orden, sin deuda ni sobrante", () => {
    const result = computeTitularPreview({
      targetCents: 100000, splits: [createBatchSplitRow("efectivo", "747.50")],
      creditAppliedCents: 25000, roundingCoverageCents: 250, availableCreditCents: 25000, debtAuthorized: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok plan");
    const lines = buildTitularSummaryLines(result.plan);
    expect(lines.map((l) => l.label)).toEqual([
      "Total a cancelar", "Medios reales ingresados", "Crédito aplicado", "Redondeo cubierto por oficina",
    ]);
    expect(lines.find((l) => l.label === "Total a cancelar")!.amountCents).toBe(100000);
    expect(lines.find((l) => l.label === "Crédito aplicado")!.amountCents).toBe(25000);
    expect(lines.find((l) => l.label === "Redondeo cubierto por oficina")!.amountCents).toBe(250);
  });

  test("con deuda nueva: incluye la línea de deuda, marcada kind='debt'", () => {
    const result = computeTitularPreview({
      targetCents: 100000, splits: [createBatchSplitRow("efectivo", "500")],
      creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: true,
    });
    if (!result.ok) throw new Error("expected ok plan");
    const lines = buildTitularSummaryLines(result.plan);
    const debtLine = lines.find((l) => l.label === "Deuda nueva del titular");
    expect(debtLine).toBeDefined();
    expect(debtLine!.kind).toBe("debt");
    expect(debtLine!.amountCents).toBe(50000);
  });

  test("con saldo a favor nuevo (titular sin deuda previa): incluye la línea de sobrante, marcada kind='credit'", () => {
    const result = computeTitularPreview({
      targetCents: 100000, splits: [createBatchSplitRow("efectivo", "1200")],
      creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: false,
    });
    if (!result.ok) throw new Error("expected ok plan");
    const lines = buildTitularSummaryLines(result.plan, 0);
    const favorLine = lines.find((l) => l.label === "Saldo a favor nuevo");
    expect(favorLine).toBeDefined();
    expect(favorLine!.amountCents).toBe(20000);
  });

  test("sin crédito/redondeo/deuda/sobrante: solo las 2 líneas base", () => {
    const result = computeTitularPreview({
      targetCents: 100000, splits: [createBatchSplitRow("efectivo", "1000")],
      creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: false,
    });
    if (!result.ok) throw new Error("expected ok plan");
    expect(buildTitularSummaryLines(result.plan).length).toBe(2);
  });
});

describe("modo titular no restringe el carrito (multiasegurado / manual)", () => {
  test("el fingerprint y el preview funcionan igual con un carrito manual sin asegurado real", () => {
    const cart: BatchCartItem[] = [freeManualCartItem({ amount: 1000 })];
    const splits: BatchSplitFormRow[] = [createBatchSplitRow("efectivo", "1000")];
    const fp = computeTitularEconomicFingerprint({
      paymentDate: "2027-06-01", cart, splits, accountHolderInsuredId: 55,
      creditAppliedCents: 0, roundingCoverageCents: 0, debtAuthorized: false, debtReason: "",
    });
    expect(typeof fp).toBe("string");
    const preview = computeTitularPreview({
      targetCents: 100000, splits, creditAppliedCents: 0, roundingCoverageCents: 0,
      availableCreditCents: 0, debtAuthorized: false,
    });
    expect(preview.ok).toBe(true);
  });
});

// Resumen del lote con titular que ya debía — misma interpretación que
// "Imputar pago" (computeAccountOutcome compartido): el sobrante primero
// cancela la deuda anterior; solo el excedente es saldo a favor nuevo.
describe("buildTitularSummaryLines — saldo previo del titular", () => {
  const CART = 10000000; // $100.000
  function surplusPlan(realPesos: string) {
    const r = computeTitularPreview({
      targetCents: CART, splits: [createBatchSplitRow("efectivo", realPesos)],
      creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: false,
    });
    if (!r.ok) throw new Error("expected ok plan");
    return r.plan;
  }
  const accountLines = (lines: ReturnType<typeof buildTitularSummaryLines>) =>
    lines.filter((l) => !["Total a cancelar", "Medios reales ingresados"].includes(l.label)).map((l) => [l.label, l.amountCents, l.kind]);

  test("1. deuda previa $30.000 + sobrante $10.000 → cancela $10.000, saldo final deudor $20.000, sin saldo a favor nuevo", () => {
    expect(accountLines(buildTitularSummaryLines(surplusPlan("110000"), -3000000))).toEqual([
      ["Cancela deuda anterior", 1000000, "credit"],
      ["Saldo final de la cuenta (deudor)", 2000000, "debt"],
    ]);
  });

  test("2. deuda previa $30.000 + sobrante $30.000 → cancela toda la deuda, saldo final cero", () => {
    expect(accountLines(buildTitularSummaryLines(surplusPlan("130000"), -3000000))).toEqual([
      ["Cancela deuda anterior", 3000000, "credit"],
      ["Saldo final de la cuenta", 0, "neutral"],
    ]);
  });

  test("3. deuda previa $20.000 + sobrante $30.000 → cancela $20.000 y saldo a favor nuevo $10.000", () => {
    expect(accountLines(buildTitularSummaryLines(surplusPlan("130000"), -2000000))).toEqual([
      ["Cancela deuda anterior", 2000000, "credit"],
      ["Saldo a favor nuevo", 1000000, "credit"],
      ["Saldo final de la cuenta (a favor)", 1000000, "credit"],
    ]);
  });

  test("4a. saldo previo cero: el sobrante entero es saldo a favor nuevo (presentación existente) + saldo final", () => {
    expect(accountLines(buildTitularSummaryLines(surplusPlan("110000"), 0))).toEqual([
      ["Saldo a favor nuevo", 1000000, "credit"],
      ["Saldo final de la cuenta (a favor)", 1000000, "credit"],
    ]);
  });

  test("4b. saldo previo positivo: crédito aplicado y sobrante se reflejan en el saldo final, sin 'Cancela deuda anterior'", () => {
    const r = computeTitularPreview({
      targetCents: CART, splits: [createBatchSplitRow("efectivo", "90000")],
      creditAppliedCents: 1000000, roundingCoverageCents: 0, availableCreditCents: 5000000, debtAuthorized: false,
    });
    if (!r.ok) throw new Error("expected ok plan");
    expect(accountLines(buildTitularSummaryLines(r.plan, 5000000))).toEqual([
      ["Crédito aplicado", 1000000, "credit"],
      ["Saldo final de la cuenta (a favor)", 4000000, "credit"],
    ]);
    expect(accountLines(buildTitularSummaryLines(surplusPlan("110000"), 500000))).toEqual([
      ["Saldo a favor nuevo", 1000000, "credit"],
      ["Saldo final de la cuenta (a favor)", 1500000, "credit"],
    ]);
  });

  test("4c. cobro que no mueve la cuenta: sin saldo final ni líneas de cuenta, aun con deuda previa", () => {
    expect(accountLines(buildTitularSummaryLines(surplusPlan("100000"), -3000000))).toEqual([]);
  });

  test("4d. deuda previa + deuda nueva autorizada: no hay 'Cancela deuda anterior' y el saldo final las suma", () => {
    const r = computeTitularPreview({
      targetCents: CART, splits: [createBatchSplitRow("efectivo", "70000")],
      creditAppliedCents: 0, roundingCoverageCents: 0, availableCreditCents: 0, debtAuthorized: true,
    });
    if (!r.ok) throw new Error("expected ok plan");
    expect(accountLines(buildTitularSummaryLines(r.plan, -1000000))).toEqual([
      ["Deuda nueva del titular", 3000000, "debt"],
      ["Saldo final de la cuenta (deudor)", 4000000, "debt"],
    ]);
  });

  test("saldo previo desconocido (cargando/error): sobrante neutral, nunca 'Saldo a favor nuevo' ni saldo final", () => {
    expect(accountLines(buildTitularSummaryLines(surplusPlan("110000")))).toEqual([
      ["Sobrante a cuenta corriente", 1000000, "credit"],
    ]);
  });

  test("5. solo presentación: no muta el plan, y payload/huella no dependen del saldo previo", () => {
    const plan = surplusPlan("110000");
    const snapshot = structuredClone(plan);
    buildTitularSummaryLines(plan, -3000000);
    buildTitularSummaryLines(plan, 0);
    buildTitularSummaryLines(plan);
    expect(plan).toEqual(snapshot);
    // El sobrante sigue entero en el plan (un único destino new_credit_movement de $10.000):
    // "Cancela deuda anterior" es solo una lectura del resumen, nunca otra allocation.
    expect(plan.newSaldoAFavorCents).toBe(1000000);
    expect(plan.allocations.filter((a) => a.destinationKind === "new_credit_movement").map((a) => a.amountCents)).toEqual([1000000]);

    expect(buildTitularPayloadInput({
      accountHolderInsuredId: 55, creditAppliedCents: 0, roundingCoverageCents: 0,
      debtAuthorized: false, debtReason: "", idempotencyKey: "k-1",
    })).toEqual({
      accountHolderInsuredId: 55, creditAppliedCents: 0, roundingCoverageCents: 0,
      debtAuthorized: false, debtReason: null, idempotencyKey: "k-1",
    });
    const fp = JSON.parse(computeTitularEconomicFingerprint({
      paymentDate: "2027-06-01", cart: [installmentCartItem({ amount: 100000 })], splits: [createBatchSplitRow("efectivo", "110000")],
      accountHolderInsuredId: 55, creditAppliedCents: 0, roundingCoverageCents: 0, debtAuthorized: false, debtReason: "",
    }));
    expect(Object.keys(fp).sort()).toEqual([
      "accountHolderInsuredId", "creditAppliedCents", "debtAuthorized", "debtReason", "items", "notes",
      "paymentDate", "roundingCoverageCents", "splits",
    ]);
  });
});
