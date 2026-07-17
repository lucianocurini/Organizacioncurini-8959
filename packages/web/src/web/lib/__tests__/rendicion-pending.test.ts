// Tests del helper de clasificación de ítems pendientes de rendición
// (Etapa 3B-2, ajuste de NuevaRendicionModal). Sin JSX, sin React — ver
// rendicion-pending.ts.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/rendicion-pending.test.ts
import { describe, test, expect } from "bun:test";
import {
  getPendingItemPaymentGroup, isBatchChildPendingPayment,
  computeDefaultRendicionMethod, attachRendicionMethod,
  getRendicionItemMethodLabel, RENDICION_METHOD_LABELS,
} from "../rendicion-pending";

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
