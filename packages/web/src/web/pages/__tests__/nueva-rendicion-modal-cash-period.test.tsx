// "Nueva Rendición" con cobros de contado agrupados (source="payment_batch"):
// una sola fila por operación con su detalle, en la sección que corresponde a
// sus medios reales; sin opción de "adeudado"; ítem bloqueado visible pero no
// seleccionable; el payload de POST /api/remittances lleva el contado tal
// como lo devolvió el listado, siempre pagado y con su medio real. Pagos
// normales y cobros manuales sin cambios.
//
// Mismo arnés que payment-modal-installment-unavailable.test.tsx:
// <NuevaRendicionModal> real montado con react-dom/client sobre un jsdom
// aislado y `fetch` mockeado.
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/nueva-rendicion-modal-cash-period.test.tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";

function cashItem(overrides: Record<string, any>) {
  return {
    source: "payment_batch", sourceId: 0, paymentBatchId: 0, amount: 380000, paymentMethod: "efectivo",
    paymentDate: "2027-06-15", dueDate: null, clientName: "", policyNumber: "", companyName: "Compañía QA",
    notes: null, hasSurcharge: false, splits: [{ method: "efectivo", amountCents: 38000000, notes: null }],
    paymentGroup: "own", isCashPeriodPayment: true, concept: "Pago de contado",
    cashPeriodPayment: {
      id: 1, policyId: 1, rebillingId: null, periodStart: "2027-01-01", periodEnd: "2027-12-31",
      installmentCount: 4, nominalAmountCents: 40000000, discountAmountCents: 2000000,
      cashAmountCents: 38000000, receivedAmountCents: 38000000, hasChecks: false,
    },
    blocked: false, blockedCode: null, blockedReason: null,
    ...overrides,
  };
}

const CASH_OWN = cashItem({ sourceId: 701, paymentBatchId: 701, clientName: "QA Contado Propio", policyNumber: "POL-CONTADO-1" });
const CASH_DIRECT = cashItem({
  sourceId: 702, paymentBatchId: 702, clientName: "QA Contado Compania", policyNumber: "POL-CONTADO-2",
  amount: 2070198, paymentMethod: "transferencia_compania", paymentGroup: "direct_company",
  splits: [{ method: "transferencia_compania", amountCents: 207019800, notes: null }],
  cashPeriodPayment: { ...cashItem({}).cashPeriodPayment, id: 2, installmentCount: 6, nominalAmountCents: 217000000, discountAmountCents: 9980200, cashAmountCents: 207019800, receivedAmountCents: 207019800 },
});
const BLOCKED_MESSAGE = "Algunas cuotas del pago de contado ya figuran rendidas y otras no. Revisalo antes de rendir.";
const CASH_BLOCKED = cashItem({
  sourceId: 703, paymentBatchId: 703, clientName: "QA Contado Bloqueado", policyNumber: "POL-CONTADO-3",
  blocked: true, blockedCode: "CASH_PERIOD_CHILDREN_PARTIALLY_RENDERED", blockedReason: BLOCKED_MESSAGE,
});
const STANDALONE = {
  source: "payment", sourceId: 901, amount: 1000, paymentMethod: "efectivo", batchId: null, paymentDate: "2027-06-14",
  dueDate: null, clientName: "QA Pago Normal", policyNumber: "POL-NORMAL", companyName: "Compañía QA", notes: null,
  hasSurcharge: false, splits: [{ method: "efectivo", amountCents: 100000, notes: null }], paymentGroup: "own",
};
const BATCH_CHILD = {
  source: "payment", sourceId: 902, amount: 2000, paymentMethod: "lote", batchId: 55, paymentDate: "2027-06-13",
  dueDate: null, clientName: "QA Hijo Lote", policyNumber: "POL-LOTE", companyName: "Compañía QA", notes: null,
  hasSurcharge: false, splits: [], paymentGroup: null,
};
const CASH_ENTRY = {
  source: "cash_entry", sourceId: 903, amount: 500, paymentMethod: "efectivo", paymentDate: "2027-06-12", dueDate: null,
  clientName: "QA Cobro Manual", policyNumber: "—", companyName: "Compañía QA", notes: null, entryType: "cobro",
  splits: null, paymentGroup: "own",
};
const PENDING = [CASH_OWN, CASH_DIRECT, CASH_BLOCKED, STANDALONE, BATCH_CHILD, CASH_ENTRY];

let dom: JSDOM;
const originalGlobals: Record<string, any> = {};

function installJsdomGlobals() {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/" });
  const keys = ["window", "document", "navigator", "localStorage", "HTMLInputElement", "HTMLElement", "Event", "MouseEvent", "Node", "customElements"] as const;
  for (const key of keys) {
    originalGlobals[key] = (globalThis as any)[key];
    (globalThis as any)[key] = (dom.window as any)[key];
  }
  originalGlobals.fetch = (globalThis as any).fetch;
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

function mockFetch(pending: any[] = PENDING) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
    const json = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;
    if (url === "/api/remittances/pending") return json(pending);
    if (url === "/api/remittances" && method === "POST") return json({ ok: true, id: 4242 });
    throw new Error(`Unmocked fetch in test: ${method} ${url}`);
  };
  return { remittancePost: () => calls.find((c) => c.url === "/api/remittances" && c.method === "POST") };
}

async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonByText(container: Element, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement | undefined;
}

/** Fila seleccionable (cursor-pointer) de un ítem pendiente, por nombre de cliente. */
function selectableRow(container: Element, clientName: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll("div.cursor-pointer"))
    .find((d) => d.querySelector("p")?.textContent === clientName) as HTMLElement | undefined;
}

/** Texto completo de la sección cuyo encabezado es `title` (encabezado + lista). */
function sectionText(container: Element, title: string): string {
  const header = Array.from(container.querySelectorAll("p")).find((p) => p.textContent?.trim().startsWith(title));
  return header?.parentElement?.textContent ?? "";
}

const footerText = (container: Element) => Array.from(container.querySelectorAll("span"))
  .find((s) => /seleccionadas —/.test(s.textContent ?? ""))?.textContent ?? "";

const MODULE_LOAD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

async function renderModal() {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { NuevaRendicionModal } = await import("../cobranzas");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  const inputSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  let saved = 0;
  await act(async () => {
    root.render(React.createElement(NuevaRendicionModal, { onClose: () => {}, onSaved: () => { saved++; } }));
    await flush();
  });
  async function click(el: HTMLElement) { await act(async () => { el.click(); await flush(); }); }
  async function setInput(input: HTMLInputElement, value: string) {
    await act(async () => {
      inputSetter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();
    });
  }
  async function unmount() { await act(async () => { root.unmount(); }); container.remove(); }
  return { container, click, setInput, unmount, savedCount: () => saved };
}

describe("NuevaRendicionModal — pago de contado agrupado", () => {
  beforeAll(async () => {
    installJsdomGlobals();
    await import("react-dom/client");
    await import("../cobranzas");
  }, MODULE_LOAD_TIMEOUT_MS);
  afterAll(() => { restoreGlobals(); });

  test("una sola fila por contado, con etiqueta, período, cuotas, nominal, descuento, total y medios reales", async () => {
    mockFetch();
    const ui = await renderModal();
    try {
      const details = ui.container.querySelectorAll('[data-testid="cash-period-pending-detail"]');
      expect(details.length).toBe(3); // 2 seleccionables + 1 bloqueado, uno por operación

      const row = selectableRow(ui.container, "QA Contado Propio")!;
      expect(row).toBeDefined();
      const text = row.textContent ?? "";
      expect(text).toContain("Pago de contado");
      expect(text).toContain("Período 01/01/2027 al 31/12/2027");
      expect(text).toContain("4 cuotas");
      expect(text).toMatch(/Nominal\s*\$\s*400\.000/);
      expect(text).toMatch(/Descuento\s*\$\s*20\.000/);
      expect(text).toMatch(/Total a rendir\s*\$\s*380\.000/);
      expect(text).toMatch(/Medios: Efectivo\s*\$\s*380\.000/);
      // El contado aparece una sola vez como fila seleccionable.
      expect(Array.from(ui.container.querySelectorAll("div.cursor-pointer")).filter((d) => d.textContent?.includes("QA Contado Propio"))).toHaveLength(1);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("medio/grupo: el contado por transferencia a compañía va en 'Directo a Compañía'; el de efectivo en 'Cuentas propias'", async () => {
    mockFetch();
    const ui = await renderModal();
    try {
      const propios = sectionText(ui.container, "Cuentas propias");
      const directos = sectionText(ui.container, "Directo a Compañía");
      expect(propios).toContain("QA Contado Propio");
      expect(propios).not.toContain("QA Contado Compania");
      expect(directos).toContain("QA Contado Compania");
      expect(directos).toContain("Transf. a Compañía");
      expect(directos).toContain("6 cuotas");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("sin opción de adeudado para el contado; el cobro manual la conserva", async () => {
    mockFetch();
    const ui = await renderModal();
    try {
      await ui.click(selectableRow(ui.container, "QA Contado Propio")!);
      const cashRow = selectableRow(ui.container, "QA Contado Propio")!;
      expect(Array.from(cashRow.querySelectorAll("button")).some((b) => /Pagado|Adeudado/.test(b.textContent ?? ""))).toBe(false);

      await ui.click(selectableRow(ui.container, "QA Cobro Manual")!);
      const manualRow = selectableRow(ui.container, "QA Cobro Manual")!;
      expect(Array.from(manualRow.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Pagado")).toBe(true);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("ítem bloqueado: visible con su aviso y código, pero no seleccionable", async () => {
    mockFetch();
    const ui = await renderModal();
    try {
      const section = ui.container.querySelector('[data-testid="blocked-pending-section"]')!;
      expect(section).not.toBeNull();
      expect(section.textContent).toContain("QA Contado Bloqueado");
      expect(section.textContent).toContain(BLOCKED_MESSAGE);
      const blockedRow = section.querySelector('[data-blocked-code="CASH_PERIOD_CHILDREN_PARTIALLY_RENDERED"]') as HTMLElement;
      expect(blockedRow).not.toBeNull();
      expect(blockedRow.getAttribute("aria-disabled")).toBe("true");

      // Ni fila seleccionable ni en propios/directos.
      expect(selectableRow(ui.container, "QA Contado Bloqueado")).toBeUndefined();
      expect(sectionText(ui.container, "Cuentas propias")).not.toContain("QA Contado Bloqueado");
      await ui.click(blockedRow);
      expect(footerText(ui.container)).toContain("0 seleccionadas");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("redondeo explícito cuando recibido difiere del aplicado; el payload sigue llevando lo aplicado", async () => {
    const rounded = cashItem({
      sourceId: 704, paymentBatchId: 704, clientName: "QA Contado Redondeo", policyNumber: "POL-CONTADO-4", amount: 165000,
      splits: [{ method: "efectivo", amountCents: 16500300, notes: null }],
      cashPeriodPayment: { ...cashItem({}).cashPeriodPayment, id: 4, installmentCount: 3, nominalAmountCents: 18000000, discountAmountCents: 1500000, cashAmountCents: 16500000, receivedAmountCents: 16500300 },
    });
    const fetchMock = mockFetch([rounded, CASH_OWN]);
    const ui = await renderModal();
    try {
      const row = selectableRow(ui.container, "QA Contado Redondeo")!;
      const text = row.textContent ?? "";
      expect(text).toMatch(/Total a rendir\s*\$\s*165\.000/);
      expect(text).toMatch(/Medios: Efectivo\s*\$\s*165\.003/);
      expect(text).toMatch(/Recibido\s*\$\s*165\.003\s*·\s*Redondeo \+\$\s*3/);
      // Sin redondeo, sin etiqueta.
      expect(selectableRow(ui.container, "QA Contado Propio")!.querySelector('[data-testid="cash-period-rounding"]')).toBeNull();

      await ui.click(row);
      await ui.click(buttonByText(ui.container, "Siguiente")!);
      const efectivoInput = Array.from(ui.container.querySelectorAll("label"))
        .find((l) => l.textContent?.trim() === "Efectivo")!.nextElementSibling!.querySelector("input") as HTMLInputElement;
      await ui.setInput(efectivoInput, "165000");
      await ui.click(buttonByText(ui.container, "Confirmar Rendición")!);
      const post = fetchMock.remittancePost()!;
      expect(post.body.items).toEqual([{
        source: "payment_batch", sourceId: 704, amount: 165000, debtorStatus: "pagado",
        clientName: "QA Contado Redondeo", policyNumber: "POL-CONTADO-4", companyName: "Compañía QA", paymentMethod: "efectivo",
      }]);
      expect(post.body.paymentBreakdown).toEqual({ efectivo: 165000 });
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("encabezado del paso 2: cuenta las cuotas del contado y pluraliza (4 cuotas / 1 cuota)", async () => {
    mockFetch();
    let ui = await renderModal();
    try {
      await ui.click(selectableRow(ui.container, "QA Contado Propio")!);
      await ui.click(buttonByText(ui.container, "Siguiente")!);
      const header = ui.container.querySelector("h3")!.parentElement!.textContent ?? "";
      expect(header).toMatch(/4 cuotas —/);
      expect(header).not.toContain("1 cuotas");
    } finally {
      await ui.unmount();
    }

    mockFetch();
    ui = await renderModal();
    try {
      await ui.click(selectableRow(ui.container, "QA Pago Normal")!);
      await ui.click(buttonByText(ui.container, "Siguiente")!);
      const header = ui.container.querySelector("h3")!.parentElement!.textContent ?? "";
      expect(header).toMatch(/1 cuota —/);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("payload: contado como payment_batch/pagado/medio real; pagos normales con el medio de rendición elegido", async () => {
    const fetchMock = mockFetch();
    const ui = await renderModal();
    try {
      await ui.click(selectableRow(ui.container, "QA Contado Propio")!);
      await ui.click(selectableRow(ui.container, "QA Contado Compania")!);
      await ui.click(selectableRow(ui.container, "QA Pago Normal")!);
      await ui.click(selectableRow(ui.container, "QA Hijo Lote")!);
      expect(footerText(ui.container)).toContain("4 seleccionadas");

      await ui.click(buttonByText(ui.container, "Siguiente")!);
      expect(ui.container.textContent).toContain("2 pagos de contado");
      const efectivoInput = Array.from(ui.container.querySelectorAll("label"))
        .find((l) => l.textContent?.trim() === "Efectivo")!.nextElementSibling!.querySelector("input") as HTMLInputElement;
      await ui.setInput(efectivoInput, String(380000 + 2070198 + 1000 + 2000));
      await ui.click(buttonByText(ui.container, "Confirmar Rendición")!);

      const post = fetchMock.remittancePost();
      expect(post).toBeDefined();
      const items = post!.body.items as any[];
      expect(items).toHaveLength(4);

      const own = items.find((i) => i.sourceId === 701);
      expect(own).toEqual({
        source: "payment_batch", sourceId: 701, amount: 380000, debtorStatus: "pagado",
        clientName: "QA Contado Propio", policyNumber: "POL-CONTADO-1", companyName: "Compañía QA",
        paymentMethod: "efectivo",
      });
      const direct = items.find((i) => i.sourceId === 702);
      expect(direct).toMatchObject({ source: "payment_batch", amount: 2070198, debtorStatus: "pagado", paymentMethod: "transferencia_compania" });
      expect(items.every((i) => !("cashPeriodRealMethod" in i))).toBe(true);

      // Pagos normales: sin cambios (source=payment, pagado, medio de rendición elegido).
      const normal = items.find((i) => i.sourceId === 901);
      expect(normal).toMatchObject({ source: "payment", amount: 1000, debtorStatus: "pagado", paymentMethod: "efectivo" });
      const child = items.find((i) => i.sourceId === 902);
      expect(child).toMatchObject({ source: "payment", amount: 2000, debtorStatus: "pagado", paymentMethod: "efectivo" });

      expect(post!.body.paymentBreakdown).toEqual({ efectivo: 380000 + 2070198 + 1000 + 2000 });
      expect(ui.savedCount()).toBe(1);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
