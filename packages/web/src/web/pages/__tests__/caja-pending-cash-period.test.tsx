// Caja → "Cobros pendientes de rendición" (Desde Cobranzas) con pagos de
// contado: una sola fila por contado (ítem canónico de GET
// /remittances/pending), sin sus cuotas hijas, por el importe aplicado, con
// nominal/descuento/medios reales/redondeo; contado bloqueado visible pero no
// como normal; pagos individuales y lotes normales sin cambios.
//
// Mismo arnés que nueva-rendicion-modal-cash-period.test.tsx:
// <CajaPendingCobranzasList> real montado con react-dom/client sobre jsdom.
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/caja-pending-cash-period.test.tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";

function cashItem(overrides: Record<string, any>) {
  return {
    source: "payment_batch", sourceId: 0, paymentBatchId: 0, amount: 165000, paymentMethod: "efectivo",
    paymentDate: "2027-06-15", dueDate: null, clientName: "", policyNumber: "", companyName: "Compañía QA",
    notes: null, hasSurcharge: false, splits: [{ method: "efectivo", amountCents: 16500300, notes: null }],
    paymentGroup: "own", isCashPeriodPayment: true, concept: "Pago de contado",
    cashPeriodPayment: {
      id: 1, policyId: 1, rebillingId: null, periodStart: "2027-01-01", periodEnd: "2027-12-31",
      installmentCount: 3, nominalAmountCents: 18000000, discountAmountCents: 1500000,
      cashAmountCents: 16500000, receivedAmountCents: 16500300, hasChecks: false,
    },
    blocked: false, blockedCode: null, blockedReason: null,
    ...overrides,
  };
}

function payment(id: number, overrides: Record<string, any>) {
  return {
    id, policyId: 1, batchId: null, manualPayer: null, manualPolicyNumber: null, manualCompany: null,
    amount: 1000, paymentMethod: "efectivo", paymentDate: "2027-06-10", status: "confirmado", rendered: 0,
    insuredName: `Asegurado ${id}`, policyNumber: `POL-${id}`, companyName: "Compañía QA",
    ...overrides,
  };
}

// Contado B: 3 cuotas × 60.000 nominal, contado 165.000, recibido 165.003 en efectivo.
const CASH_B = cashItem({ sourceId: 50, paymentBatchId: 50, clientName: "QA Contado B", policyNumber: "POL-B" });
const B_CHILDREN = [1, 2, 3].map((n) => payment(100 + n, {
  batchId: 50, amount: 60000, paymentMethod: "contado", insuredName: "QA Contado B", policyNumber: "POL-B",
}));
// Contado directo a compañía, sin redondeo.
const CASH_DIRECT = cashItem({
  sourceId: 51, paymentBatchId: 51, clientName: "QA Contado Directo", policyNumber: "POL-D", amount: 90000,
  paymentMethod: "transferencia_compania", paymentGroup: "direct_company",
  splits: [{ method: "transferencia_compania", amountCents: 9000000, notes: null }],
  cashPeriodPayment: { ...cashItem({}).cashPeriodPayment, id: 2, installmentCount: 2, nominalAmountCents: 10000000, discountAmountCents: 1000000, cashAmountCents: 9000000, receivedAmountCents: 9000000 },
});
const D_CHILDREN = [1, 2].map((n) => payment(200 + n, {
  batchId: 51, amount: 50000, paymentMethod: "contado", insuredName: "QA Contado Directo", policyNumber: "POL-D",
}));
// Contado con medios combinados (propio + directo).
const CASH_MIXED = cashItem({
  sourceId: 52, paymentBatchId: 52, clientName: "QA Contado Combinado", policyNumber: "POL-M", amount: 120000,
  paymentMethod: "combinado", paymentGroup: "mixed",
  splits: [
    { method: "efectivo", amountCents: 2000000, notes: null },
    { method: "transferencia_compania", amountCents: 10000000, notes: null },
  ],
  cashPeriodPayment: { ...cashItem({}).cashPeriodPayment, id: 3, installmentCount: 1, nominalAmountCents: 13000000, discountAmountCents: 1000000, cashAmountCents: 12000000, receivedAmountCents: 12000000 },
});
const M_CHILDREN = [payment(301, { batchId: 52, amount: 130000, paymentMethod: "contado", insuredName: "QA Contado Combinado" })];
const BLOCKED_MESSAGE = "Algunas cuotas del pago de contado ya figuran rendidas y otras no. Revisalo antes de rendir.";
const CASH_BLOCKED = cashItem({
  sourceId: 53, paymentBatchId: 53, clientName: "QA Contado Bloqueado", policyNumber: "POL-X", amount: 40000,
  splits: [{ method: "efectivo", amountCents: 4000000, notes: null }],
  cashPeriodPayment: { ...cashItem({}).cashPeriodPayment, id: 4, installmentCount: 2, nominalAmountCents: 4400000, discountAmountCents: 400000, cashAmountCents: 4000000, receivedAmountCents: 4000000 },
  blocked: true, blockedCode: "CASH_PERIOD_CHILDREN_PARTIALLY_RENDERED", blockedReason: BLOCKED_MESSAGE,
});
const X_CHILDREN = [payment(401, { batchId: 53, amount: 22000, paymentMethod: "contado", insuredName: "QA Contado Bloqueado" })];
const STANDALONE = payment(1, { insuredName: "QA Pago Normal", amount: 1000, paymentMethod: "efectivo" });
const LOTE_CHILD = payment(2, { insuredName: "QA Hijo Lote", amount: 2000, batchId: 77, paymentMethod: "lote" });

const PAYMENTS = [STANDALONE, ...B_CHILDREN, ...D_CHILDREN, ...M_CHILDREN, ...X_CHILDREN, LOTE_CHILD];
// /remittances/pending también trae pagos sueltos y cash_entries: Caja solo usa los contados.
const REMITTANCE_PENDING = [
  CASH_B, CASH_DIRECT, CASH_MIXED, CASH_BLOCKED,
  { source: "payment", sourceId: 1, amount: 1000, batchId: null },
  { source: "cash_entry", sourceId: 9, amount: 500 },
];

let dom: JSDOM;
const originalGlobals: Record<string, any> = {};

function installJsdomGlobals() {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/" });
  const keys = ["window", "document", "navigator", "localStorage", "HTMLInputElement", "HTMLElement", "Event", "MouseEvent", "Node", "customElements"] as const;
  for (const key of keys) {
    originalGlobals[key] = (globalThis as any)[key];
    (globalThis as any)[key] = (dom.window as any)[key];
  }
  originalGlobals.IS_REACT_ACT_ENVIRONMENT = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

function restoreGlobals() {
  for (const key of Object.keys(originalGlobals)) {
    if (originalGlobals[key] === undefined) delete (globalThis as any)[key];
    else (globalThis as any)[key] = originalGlobals[key];
  }
  dom.window.close();
}

const MODULE_LOAD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

async function renderList(payments: any[], remittancePending: any[] | null, extra: Record<string, any> = {}) {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { CajaPendingCobranzasList } = await import("../caja");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  async function rerender(nextPayments: any[], nextPending: any[] | null, nextExtra: Record<string, any> = {}) {
    await act(async () => {
      root.render(React.createElement(CajaPendingCobranzasList, { payments: nextPayments, remittancePending: nextPending, ...nextExtra }));
    });
  }
  await rerender(payments, remittancePending, extra);
  async function unmount() { await act(async () => { root.unmount(); }); container.remove(); }
  return { container, unmount, rerender, act };
}

const cashRow = (container: Element, name: string) =>
  Array.from(container.querySelectorAll('[data-testid="caja-cash-period-row"]')).find((r) => r.textContent?.includes(name)) as HTMLElement | undefined;
const totalText = (container: Element) => container.querySelector('[data-testid="caja-pending-total"]')?.textContent ?? "";
const norm = (s: string) => s.replace(/\s+/g, " ");

describe("Caja — Cobros pendientes de rendición con pagos de contado", () => {
  beforeAll(async () => {
    installJsdomGlobals();
    await import("react-dom/client");
    await import("../caja");
  }, MODULE_LOAD_TIMEOUT_MS);
  afterAll(() => { restoreGlobals(); });

  test("contado de 3 cuotas: una sola fila, sin hijas, con etiqueta, período, cuotas, nominal, descuento, total, medios y redondeo +$3", async () => {
    const ui = await renderList(PAYMENTS, REMITTANCE_PENDING);
    try {
      const rows = ui.container.querySelectorAll('[data-testid="caja-cash-period-row"]');
      expect(rows.length).toBe(4); // B, directo, combinado, bloqueado — uno por operación
      // Ninguna hija aparece suelta (método "contado" / nominal 60.000).
      const text = norm(ui.container.textContent ?? "");
      expect(text).not.toContain("POL-B#");
      expect(Array.from(ui.container.querySelectorAll("span")).filter((s) => s.textContent === "QA Contado B")).toHaveLength(1);
      expect(text).not.toMatch(/\$\s*60\.000,00/);

      const b = norm(cashRow(ui.container, "QA Contado B")!.textContent ?? "");
      expect(b).toContain("Pago de contado");
      expect(b).toContain("Período 01/01/2027 al 31/12/2027");
      expect(b).toContain("3 cuotas");
      expect(b).toMatch(/Nominal \$ 180\.000,00/);
      expect(b).toMatch(/Descuento \$ 15\.000,00/);
      expect(b).toMatch(/Total del contado \$ 165\.000,00/);
      expect(b).toMatch(/Medios propios: Efectivo \$ 165\.003,00/);
      expect(b).toMatch(/Recibido \$ 165\.003,00 · Redondeo \+\$ 3,00/);
      // Importe principal = aplicado.
      expect(b.trim().endsWith("$ 165.000,00")).toBe(true);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("suma visible: contado por lo aplicado, no por el nominal; bloqueados fuera de la suma", async () => {
    const ui = await renderList(PAYMENTS, REMITTANCE_PENDING);
    try {
      // 1.000 + 165.000 + 90.000 + 120.000 + 2.000 (sin el bloqueado 40.000).
      const t = norm(totalText(ui.container));
      expect(t).toContain("$ 378.000,00");
      expect(t).toContain("sin 1 contado bloqueado");
      // Antes (hijas sueltas a nominal) habría sumado 1.000 + 180.000 + 100.000 + 130.000 + 22.000 + 2.000.
      expect(t).not.toContain("435.000");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("transferencia directa a compañía conserva su clasificación; medios combinados separados", async () => {
    const ui = await renderList(PAYMENTS, REMITTANCE_PENDING);
    try {
      const d = norm(cashRow(ui.container, "QA Contado Directo")!.textContent ?? "");
      expect(d).toMatch(/Directo a compañía: Transf\. directa a Compañía \$ 90\.000,00/);
      expect(d).not.toContain("Medios propios");
      expect(d).not.toContain("Redondeo");
      expect(d).toContain("2 cuotas");

      const m = norm(cashRow(ui.container, "QA Contado Combinado")!.textContent ?? "");
      expect(m).toMatch(/Medios propios: Efectivo \$ 20\.000,00/);
      expect(m).toMatch(/Directo a compañía: Transf\. directa a Compañía \$ 100\.000,00/);
      expect(m).toContain("1 cuota");
      expect(m).not.toContain("1 cuotas");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("contado bloqueado: visible con aviso y código, marcado bloqueado, no como fila normal", async () => {
    const ui = await renderList(PAYMENTS, REMITTANCE_PENDING);
    try {
      const x = cashRow(ui.container, "QA Contado Bloqueado")!;
      expect(x).toBeDefined();
      expect(x.getAttribute("data-blocked-code")).toBe("CASH_PERIOD_CHILDREN_PARTIALLY_RENDERED");
      expect(x.textContent).toContain("Bloqueado");
      expect(x.textContent).toContain(BLOCKED_MESSAGE);
      expect(x.className).toContain("border-red-500/30");
      expect(cashRow(ui.container, "QA Contado B")!.textContent).not.toContain("Bloqueado");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("pagos individuales y lotes normales: mismas filas que antes", async () => {
    const ui = await renderList([STANDALONE, LOTE_CHILD], []);
    try {
      expect(ui.container.querySelectorAll('[data-testid="caja-cash-period-row"]').length).toBe(0);
      const text = norm(ui.container.textContent ?? "");
      expect(text).toContain("QA Pago Normal#POL-1· Compañía QA2027-06-10Efectivo$ 1.000,00");
      expect(text).toContain("QA Hijo Lote#POL-2· Compañía QA2027-06-10lote$ 2.000,00");
      expect(norm(totalText(ui.container))).toContain("$ 3.000,00");
      expect(totalText(ui.container)).not.toContain("bloqueado");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("lista vacía: mismo mensaje de antes", async () => {
    const ui = await renderList([], []);
    try {
      expect(ui.container.textContent).toBe("No hay cobros desde Cobranzas pendientes de rendición.");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  // Fail-closed: /remittances/pending sin cargar, con error de red o con
  // respuesta inválida llega como remittancePending=null (ver
  // loadCajaRemittancePending en caja-cobrados.ts). Nunca se listan las
  // cuotas crudas de /cash/payments en su lugar.
  test("/remittances/pending con error: sin filas ni total, aviso y Reintentar; nunca las cuotas hijas", async () => {
    let retries = 0;
    const ui = await renderList(PAYMENTS, null, { loadError: true, onRetry: () => { retries++; } });
    try {
      const text = norm(ui.container.textContent ?? "");
      expect(ui.container.querySelector('[data-testid="caja-pending-load-error"]')).not.toBeNull();
      expect(text).toContain("No se pudieron cargar los cobros pendientes de rendición.");
      expect(text).not.toContain("QA Contado B");
      expect(text).not.toContain("QA Pago Normal");
      expect(text).not.toMatch(/\$\s*60\.000,00/);
      expect(ui.container.querySelector('[data-testid="caja-pending-total"]')).toBeNull();

      const button = Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent === "Reintentar")!;
      expect(button).toBeDefined();
      await ui.act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
      expect(retries).toBe(1);

      // Reintento exitoso: ambos orígenes llegan juntos y el contado vuelve agrupado.
      await ui.rerender(PAYMENTS, REMITTANCE_PENDING, { loadError: false });
      expect(ui.container.querySelector('[data-testid="caja-pending-load-error"]')).toBeNull();
      expect(ui.container.querySelectorAll('[data-testid="caja-cash-period-row"]').length).toBe(4);
      expect(norm(totalText(ui.container))).toContain("$ 378.000,00");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("/remittances/pending todavía sin cargar: 'Cargando', sin filas ni total", async () => {
    const ui = await renderList(PAYMENTS, null);
    try {
      expect(ui.container.textContent).toBe("Cargando cobros pendientes…");
      expect(ui.container.querySelector('[data-testid="caja-pending-total"]')).toBeNull();
      expect(ui.container.querySelector('[data-testid="caja-pending-load-error"]')).toBeNull();
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
