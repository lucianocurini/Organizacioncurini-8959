// Tests del helper de clasificación de ítems pendientes de rendición
// (Etapa 3B-2, ajuste de NuevaRendicionModal). Sin JSX, sin React — ver
// rendicion-pending.ts.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/rendicion-pending.test.ts
import { describe, test, expect } from "bun:test";
import { getPendingItemPaymentGroup } from "../rendicion-pending";

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
