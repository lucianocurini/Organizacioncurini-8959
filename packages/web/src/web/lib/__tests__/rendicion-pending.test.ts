// Tests del helper de clasificación de ítems pendientes de rendición
// (Etapa 3B-2, ajuste de NuevaRendicionModal). Sin JSX, sin React — ver
// rendicion-pending.ts.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/rendicion-pending.test.ts
import { describe, test, expect } from "bun:test";
import {
  getPendingItemPaymentGroup, isBatchChildPendingPayment,
  computeDefaultRendicionMethod, attachRendicionMethod,
  getRendicionItemMethodLabel, RENDICION_METHOD_LABELS,
  isCashPeriodPendingItem, isPendingItemSelectable, canMarkPendingItemAsDebtor, resolveRendicionItemDebtorStatus,
  formatCuotasCount, countRendicionCuotas, describeCashPeriodPendingItem,
} from "../rendicion-pending";

// ─── Contado: pluralización y presentación de importes ───────────────────────

describe("formatCuotasCount / countRendicionCuotas", () => {
  test("1 cuota en singular; 0, 2 y más en plural", () => {
    expect(formatCuotasCount(1)).toBe("1 cuota");
    expect(formatCuotasCount(2)).toBe("2 cuotas");
    expect(formatCuotasCount(4)).toBe("4 cuotas");
    expect(formatCuotasCount(0)).toBe("0 cuotas");
  });

  test("un contado cuenta todas sus cuotas; cualquier otro ítem cuenta 1", () => {
    const contado = { source: "payment_batch", cashPeriodPayment: { installmentCount: 4 } };
    expect(countRendicionCuotas([contado])).toBe(4);
    expect(countRendicionCuotas([{ source: "payment" }])).toBe(1);
    expect(countRendicionCuotas([contado, { source: "payment" }, { source: "cash_entry" }])).toBe(6);
    expect(countRendicionCuotas([])).toBe(0);
  });
});

describe("describeCashPeriodPendingItem", () => {
  const base = {
    amount: 165000,
    splits: [{ method: "efectivo", amountCents: 16500300 }],
    cashPeriodPayment: { installmentCount: 3, nominalAmountCents: 18000000, discountAmountCents: 1500000, receivedAmountCents: 16500300 },
  };

  test("nominal 180.000, contado 165.000, recibido 165.003 → redondeo +3; el importe principal es el aplicado", () => {
    const d = describeCashPeriodPendingItem(base);
    expect(d).toMatchObject({
      installmentCount: 3, nominalCents: 18000000, discountCents: 1500000,
      appliedCents: 16500000, receivedCents: 16500300, roundingCents: 300,
    });
  });

  test("sin redondeo cuando recibido = aplicado, y recibido null cae en el aplicado", () => {
    expect(describeCashPeriodPendingItem({ ...base, cashPeriodPayment: { ...base.cashPeriodPayment, receivedAmountCents: 16500000 } }).roundingCents).toBe(0);
    const d = describeCashPeriodPendingItem({ ...base, cashPeriodPayment: { ...base.cashPeriodPayment, receivedAmountCents: null } });
    expect(d.receivedCents).toBe(16500000);
    expect(d.roundingCents).toBe(0);
  });

  test("redondeo negativo se informa con signo", () => {
    expect(describeCashPeriodPendingItem({ ...base, cashPeriodPayment: { ...base.cashPeriodPayment, receivedAmountCents: 16499800 } }).roundingCents).toBe(-200);
  });

  test("separa medios propios y directo a compañía", () => {
    const d = describeCashPeriodPendingItem({
      ...base,
      splits: [
        { method: "efectivo", amountCents: 6500300 },
        { method: "transferencia_compania", amountCents: 8000000 },
        { method: "link_pago", amountCents: 2000000 },
      ],
    });
    expect(d.ownSplits).toEqual([{ method: "efectivo", amountCents: 6500300 }]);
    expect(d.directCompanySplits).toEqual([
      { method: "transferencia_compania", amountCents: 8000000 },
      { method: "link_pago", amountCents: 2000000 },
    ]);
  });
});

// ─── 1/2. paymentGroup del backend tiene prioridad ───────────────────────────

describe("Caso 1 — paymentGroup='own' tiene prioridad", () => {
  test("se usa item.paymentGroup aunque paymentMethod/splits sugieran otra cosa", () => {
    const group = getPendingItemPaymentGroup({
      paymentGroup: "own",
      paymentMethod: "transferencia_compania", // se ignora: paymentGroup manda
      splits: null,
    });
    expect(group).toBe("own");
  });
});

describe("Caso 2 — paymentGroup='direct_company' tiene prioridad", () => {
  test("se usa item.paymentGroup aunque paymentMethod sugiera 'own'", () => {
    const group = getPendingItemPaymentGroup({
      paymentGroup: "direct_company",
      paymentMethod: "efectivo", // se ignora: paymentGroup manda
      splits: null,
    });
    expect(group).toBe("direct_company");
  });
});

// ─── 3/4. Derivar desde splits cuando no viene paymentGroup ──────────────────

describe("Caso 3 — combinado directo con splits se clasifica direct_company", () => {
  test("transferencia_compania + link_pago, sin paymentGroup del backend", () => {
    const group = getPendingItemPaymentGroup({
      paymentMethod: "combinado",
      splits: [{ method: "transferencia_compania", amountCents: 70000 }, { method: "link_pago", amountCents: 30000 }],
    });
    expect(group).toBe("direct_company");
  });
});

describe("Caso 4 — combinado propio con splits se clasifica own", () => {
  test("efectivo + transferencia, sin paymentGroup del backend", () => {
    const group = getPendingItemPaymentGroup({
      paymentMethod: "combinado",
      splits: [{ method: "efectivo", amountCents: 60000 }, { method: "transferencia", amountCents: 40000 }],
    });
    expect(group).toBe("own");
  });
});

// ─── 5/6/7. Fallback legacy por paymentMethod (sin paymentGroup ni splits) ───

describe("Caso 5 — fallback legacy: transferencia_compania → direct_company", () => {
  test("sin paymentGroup ni splits", () => {
    expect(getPendingItemPaymentGroup({ paymentMethod: "transferencia_compania" })).toBe("direct_company");
  });
});

describe("Caso 6 — fallback legacy: link_pago → direct_company", () => {
  test("sin paymentGroup ni splits", () => {
    expect(getPendingItemPaymentGroup({ paymentMethod: "link_pago" })).toBe("direct_company");
  });
});

describe("Caso 7 — fallback legacy: efectivo/transferencia/cheque → own", () => {
  test("efectivo", () => {
    expect(getPendingItemPaymentGroup({ paymentMethod: "efectivo" })).toBe("own");
  });
  test("transferencia", () => {
    expect(getPendingItemPaymentGroup({ paymentMethod: "transferencia" })).toBe("own");
  });
  test("cheque", () => {
    expect(getPendingItemPaymentGroup({ paymentMethod: "cheque" })).toBe("own");
  });
  test("paymentMethod null/ausente (ej. manual_debt) también cae a own", () => {
    expect(getPendingItemPaymentGroup({ paymentMethod: null })).toBe("own");
    expect(getPendingItemPaymentGroup({})).toBe("own");
  });
});

// ─── 8. Mixed defensivo ───────────────────────────────────────────────────────

describe("Caso 8 — mixed defensivo no se acepta silenciosamente", () => {
  test("splits mixed (sin paymentGroup del backend) se reporta 'mixed', no own ni direct_company", () => {
    const group = getPendingItemPaymentGroup({
      paymentMethod: "combinado",
      splits: [{ method: "efectivo", amountCents: 50000 }, { method: "transferencia_compania", amountCents: 50000 }],
    });
    expect(group).toBe("mixed");
    expect(group).not.toBe("own");
    expect(group).not.toBe("direct_company");
  });

  test("paymentGroup='mixed' explícito del backend también se respeta tal cual", () => {
    expect(getPendingItemPaymentGroup({ paymentGroup: "mixed" })).toBe("mixed");
  });
});

// ─── 9. Los totales no duplican el payment por cantidad de splits ───────────

describe("Caso 9 — el total seleccionado no se duplica por cantidad de splits", () => {
  test("un ítem combinado de 2 splits aporta su amount una sola vez a la suma (mismo reduce que NuevaRendicionModal.totalSeleccionado)", () => {
    const items = [
      { amount: 1000, splits: [{ method: "efectivo", amountCents: 60000 }, { method: "transferencia", amountCents: 40000 }] },
      { amount: 500, splits: [{ method: "cheque", amountCents: 50000 }] },
    ];
    const total = items.reduce((s, i) => s + i.amount, 0);
    expect(total).toBe(1500); // no 2500 (1000*2 si se sumara por split) ni ningún otro valor inflado
  });
});

// ─── 10. Un combinado directo sigue representando un único ítem de rendición ─

describe("Caso 10 — un combinado directo sigue siendo un único remittanceItem", () => {
  test("mapear un ítem seleccionado combinado a la forma que se envía a POST /remittances produce exactamente 1 entrada", () => {
    const selectedItems = [{
      source: "payment", sourceId: 533, amount: 1000,
      clientName: "X", policyNumber: "Y", companyName: "Z",
      paymentMethod: "combinado",
      splits: [{ method: "transferencia_compania", amountCents: 70000 }, { method: "link_pago", amountCents: 30000 }],
    }];
    // Mismo mapeo que save() en NuevaRendicionModal: un objeto por ítem
    // seleccionado, sin fragmentar por splits.
    const payloadItems = selectedItems.map(i => ({
      source: i.source, sourceId: i.sourceId, amount: i.amount,
      clientName: i.clientName, policyNumber: i.policyNumber, companyName: i.companyName,
      paymentMethod: i.paymentMethod || null,
    }));
    expect(payloadItems.length).toBe(1);
    expect(payloadItems[0]!.amount).toBe(1000);
    expect(getPendingItemPaymentGroup(selectedItems[0]!)).toBe("direct_company");
  });
});

// ─── 11. isBatchChildPendingPayment ────────────────────────────────────────────

describe("Caso 11 — isBatchChildPendingPayment distingue hijo de lote de standalone", () => {
  test("source='payment' con batchId → true", () => {
    expect(isBatchChildPendingPayment({ source: "payment", batchId: 7 })).toBe(true);
  });
  test("source='payment' sin batchId (standalone) → false", () => {
    expect(isBatchChildPendingPayment({ source: "payment", batchId: null })).toBe(false);
    expect(isBatchChildPendingPayment({ source: "payment" })).toBe(false);
  });
  test("source='cash_entry' nunca es hijo de lote, aunque traiga batchId por error", () => {
    expect(isBatchChildPendingPayment({ source: "cash_entry", batchId: 7 })).toBe(false);
  });
});

// ─── 12. computeDefaultRendicionMethod ─────────────────────────────────────────

describe("Caso 12 — default del selector 'Medio de rendición'", () => {
  test("un único medio de cobro real compartido por todos los ítems → se usa ese", () => {
    expect(computeDefaultRendicionMethod([{ paymentMethod: "efectivo" }, { paymentMethod: "efectivo" }])).toBe("efectivo");
    expect(computeDefaultRendicionMethod([{ paymentMethod: "cheque" }])).toBe("cheque");
  });
  test("medios de cobro mezclados → default neutro 'efectivo', no adivina cuál usar", () => {
    expect(computeDefaultRendicionMethod([{ paymentMethod: "efectivo" }, { paymentMethod: "transferencia" }])).toBe("efectivo");
  });
  test("solo 'lote' (hijos de batch, paymentMethod no es un medio real) → default neutro", () => {
    expect(computeDefaultRendicionMethod([{ paymentMethod: "lote" }, { paymentMethod: "lote" }])).toBe("efectivo");
  });
  test("solo 'combinado' o sin paymentMethod (manual_debt) → default neutro", () => {
    expect(computeDefaultRendicionMethod([{ paymentMethod: "combinado" }])).toBe("efectivo");
    expect(computeDefaultRendicionMethod([{ paymentMethod: null }, {}])).toBe("efectivo");
  });
  test("sin ítems seleccionados → default neutro", () => {
    expect(computeDefaultRendicionMethod([])).toBe("efectivo");
  });
});

// ─── 13. attachRendicionMethod ─────────────────────────────────────────────────

describe("Caso 13 — attachRendicionMethod nunca deja colar el medio de cobro original", () => {
  test("todos los ítems salen con el medio de rendición elegido, sin importar su paymentMethod original", () => {
    const items = [
      { source: "payment", sourceId: 1, paymentMethod: "efectivo" }, // standalone cobrado en efectivo
      { source: "payment", sourceId: 2, paymentMethod: "lote" },      // hijo de batch cobrado con cheque (paymentMethod="lote")
      { source: "manual_debt", sourceId: null, paymentMethod: null },
    ];
    const result = attachRendicionMethod(items, "transferencia");
    expect(result.every((i) => i.paymentMethod === "transferencia")).toBe(true);
    expect(result.length).toBe(3);
  });

  test("no muta el array original", () => {
    const items = [{ source: "payment", sourceId: 1, paymentMethod: "efectivo" }];
    const result = attachRendicionMethod(items, "cheque");
    expect(items[0]!.paymentMethod).toBe("efectivo");
    expect(result[0]!.paymentMethod).toBe("cheque");
  });
});

// ─── 14. getRendicionItemMethodLabel — bug de QA visual (2026-07) ─────────────
//
// El listado/detalle de Rendiciones mostraba "Transf. cuenta propia" para un
// ítem rendido por transferencia — reusaba por error el mapa de labels del
// contexto de COBRO (METHOD_LABELS en cobranzas.tsx), donde esa distinción
// tiene sentido (separar de transferencia_compania/link_pago). En contexto
// de RENDICIÓN, "transferencia" nunca debe sugerir "cuenta propia". El dato
// (remittance_items.paymentMethod / remittance_allocations.method) siempre
// fue correcto — era pura etiqueta.

describe("Caso 14 — getRendicionItemMethodLabel nunca dice 'cuenta propia'", () => {
  test("transferencia → 'Transferencia', no 'Transf. cuenta propia'", () => {
    expect(getRendicionItemMethodLabel("transferencia")).toBe("Transferencia");
    expect(getRendicionItemMethodLabel("transferencia")).not.toMatch(/cuenta propia/i);
  });
  test("efectivo → 'Efectivo'", () => {
    expect(getRendicionItemMethodLabel("efectivo")).toBe("Efectivo");
  });
  test("cheque → 'Cheque'", () => {
    expect(getRendicionItemMethodLabel("cheque")).toBe("Cheque");
  });
  test("transferencia_compania → menciona 'Compañía', no 'cuenta propia'", () => {
    const label = getRendicionItemMethodLabel("transferencia_compania");
    expect(label).toMatch(/Compañía/);
    expect(label).not.toMatch(/cuenta propia/i);
  });
  test("link_pago → 'Link de Pago'", () => {
    expect(getRendicionItemMethodLabel("link_pago")).toBe("Link de Pago");
  });
  test("valor no reconocido (legacy) cae al valor crudo, no revienta", () => {
    expect(getRendicionItemMethodLabel("lote")).toBe("lote");
    expect(getRendicionItemMethodLabel("combinado")).toBe("combinado");
  });
  test("null/undefined → '—'", () => {
    expect(getRendicionItemMethodLabel(null)).toBe("—");
    expect(getRendicionItemMethodLabel(undefined)).toBe("—");
  });
  test("ninguna etiqueta de RENDICION_METHOD_LABELS contiene 'cuenta propia'", () => {
    for (const label of Object.values(RENDICION_METHOD_LABELS)) {
      expect(label).not.toMatch(/cuenta propia/i);
    }
  });
});

// ─── 15. Pago de contado agrupado (source="payment_batch") ────────────────────

describe("Caso 15 — pago de contado agrupado en Nueva Rendición", () => {
  test("isCashPeriodPendingItem: solo source='payment_batch'", () => {
    expect(isCashPeriodPendingItem({ source: "payment_batch" })).toBe(true);
    expect(isCashPeriodPendingItem({ source: "payment" })).toBe(false);
    expect(isCashPeriodPendingItem({ source: "cash_entry" })).toBe(false);
  });

  test("isPendingItemSelectable: un ítem bloqueado nunca se elige; sin el campo, sí", () => {
    expect(isPendingItemSelectable({ source: "payment_batch", blocked: true })).toBe(false);
    expect(isPendingItemSelectable({ source: "payment_batch", blocked: false })).toBe(true);
    expect(isPendingItemSelectable({ source: "payment" })).toBe(true); // pagos normales: sin cambios
  });

  test("canMarkPendingItemAsDebtor: nunca para payment ni payment_batch; sí para cash_entry", () => {
    expect(canMarkPendingItemAsDebtor({ source: "payment_batch" })).toBe(false);
    expect(canMarkPendingItemAsDebtor({ source: "payment" })).toBe(false);
    expect(canMarkPendingItemAsDebtor({ source: "cash_entry" })).toBe(true);
  });

  test("resolveRendicionItemDebtorStatus: contado y pago siempre pagado, aunque esté marcado", () => {
    expect(resolveRendicionItemDebtorStatus({ source: "payment_batch" }, true)).toBe("pagado");
    expect(resolveRendicionItemDebtorStatus({ source: "payment" }, true)).toBe("pagado");
    expect(resolveRendicionItemDebtorStatus({ source: "manual_debt" }, false)).toBe("adeudado");
    expect(resolveRendicionItemDebtorStatus({ source: "installment" }, false)).toBe("adeudado");
    expect(resolveRendicionItemDebtorStatus({ source: "cash_entry" }, true)).toBe("adeudado");
    expect(resolveRendicionItemDebtorStatus({ source: "cash_entry" }, false)).toBe("pagado");
  });

  test("attachRendicionMethod: el contado conserva su medio real; el resto recibe el elegido; el dato auxiliar no viaja", () => {
    const result = attachRendicionMethod([
      { source: "payment_batch", sourceId: 70, cashPeriodRealMethod: "transferencia_compania" },
      { source: "payment", sourceId: 1, cashPeriodRealMethod: null },
      { source: "cash_entry", sourceId: 2 },
    ], "efectivo");
    expect(result.map((i) => i.paymentMethod)).toEqual(["transferencia_compania", "efectivo", "efectivo"]);
    expect(result.every((i) => !("cashPeriodRealMethod" in i))).toBe(true);
  });

  test("attachRendicionMethod: un contado sin medio real conocido cae al elegido (nunca undefined)", () => {
    const [item] = attachRendicionMethod([{ source: "payment_batch", sourceId: 70 }], "cheque");
    expect(item!.paymentMethod).toBe("cheque");
  });
});
