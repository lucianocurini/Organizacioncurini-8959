// "Imputar pago": la cuota elegida deja de ser cobrable al cambiar la fecha de
// pago (regla única de cobrabilidad). Se desvincula, se limpian cuota,
// vencimiento e importe, se conserva la póliza, se muestra el aviso y
// "Imputar pago" queda bloqueado hasta elegir otra cuota o volver a escribir
// un importe (pago consciente sin cuota). Restaurar la fecha recupera las
// opciones pero no vuelve a seleccionar nada.
//
// Mismo arnés que payment-modal-cash-period-date.test.tsx: <PaymentModal>
// real montado con react-dom/client sobre un jsdom aislado y `fetch` mockeado.
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/payment-modal-installment-unavailable.test.tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";

const POLICY_ID = 57611;
const POLICY_NUMBER = "QA-CUOTA-FECHA";
const MESSAGE =
  "La cuota seleccionada ya no está disponible para esta fecha. Seleccioná otra cuota o ingresá nuevamente el importe si querés registrar un pago manual sin cuota.";

const DATE_BOTH = "2026-10-01";
const DATE_ONLY_SECOND = "2026-10-20";

const POLICIES_RESPONSE = [
  { policy: { id: POLICY_ID, policyNumber: POLICY_NUMBER, companyId: 4 }, insured: { id: 3600, name: "QA Cuota Fecha" }, company: { id: 4, name: "Cooperación" } },
];

const INST_1 = { installmentId: 81001, installmentNumber: 1, dueDate: "2026-09-15", amount: 12345, status: "pendiente", policyId: POLICY_ID };
const INST_2 = { installmentId: 81002, installmentNumber: 2, dueDate: "2026-10-15", amount: 23456, status: "pendiente", policyId: POLICY_ID };

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

/** pending-for-payment según la fecha: DATE_ONLY_SECOND excluye la cuota 1; cualquier otra fecha trae ambas. */
function mockFetch() {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
    const json = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;
    if (url.startsWith("/api/installments/pending-for-payment")) {
      const date = new URL(url, "http://localhost").searchParams.get("paymentDate");
      return json(date === DATE_ONLY_SECOND ? [INST_2] : [INST_1, INST_2]);
    }
    if (url.startsWith("/api/policies/cash-period-search")) return json([]);
    if (url === "/api/policies?includeAccessories=1") return json(POLICIES_RESPONSE);
    if (url === "/api/payments" && method === "POST") return json({ id: 5001 });
    throw new Error(`Unmocked fetch in test: ${method} ${url}`);
  };
  return {
    calls,
    pendingCalls: () => calls.filter((c) => c.url.startsWith("/api/installments/pending-for-payment")),
    paymentPost: () => calls.find((c) => c.url === "/api/payments" && c.method === "POST"),
  };
}

async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonByText(container: Element, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement | undefined;
}

function elementAfterLabel(container: Element, labelText: string): Element {
  const label = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.trim() === labelText);
  if (!label) throw new Error(`Label no encontrado: ${labelText}`);
  return label.nextElementSibling!;
}

const installmentSelect = (c: Element) => elementAfterLabel(c, "Cuota (opcional)") as HTMLSelectElement;
const amountInput = (c: Element) => elementAfterLabel(c, "Importe *").querySelector("input") as HTMLInputElement;
const dueDateInput = (c: Element) => elementAfterLabel(c, "Vencimiento de cuota") as HTMLInputElement;
const paymentDateInput = (c: Element) => elementAfterLabel(c, "Fecha de pago *") as HTMLInputElement;
const imputarButton = (c: Element) => buttonByText(c, "Imputar pago")!;

const MODULE_LOAD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

/** Monta el modal, elige la póliza, fija DATE_BOTH y selecciona la cuota 1. */
async function renderWithInstallmentOneSelected() {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { PaymentModal } = await import("../cobranzas");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  const inputSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  const selectSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!;

  await act(async () => {
    root.render(React.createElement(PaymentModal, { open: true, onClose: () => {}, onSaved: () => {}, editing: null }));
    await flush();
  });
  await act(async () => {
    buttonByText(container, "Seleccionar póliza...")!.click();
    await flush(1);
    const input = container.querySelector('input[placeholder="Buscar..."]') as HTMLInputElement;
    inputSetter.call(input, POLICY_NUMBER);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await flush(1);
    buttonByText(container, POLICY_NUMBER)!.click();
    await flush();
  });

  async function setInput(input: HTMLInputElement, value: string) {
    await act(async () => {
      inputSetter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();
    });
  }
  async function selectInstallment(value: string) {
    await act(async () => {
      const select = installmentSelect(container);
      selectSetter.call(select, value);
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await flush();
    });
  }
  const setPaymentDate = (value: string) => setInput(paymentDateInput(container), value);
  async function click(el: HTMLElement) { await act(async () => { el.click(); await flush(); }); }
  async function unmount() { await act(async () => { root.unmount(); }); container.remove(); }

  await setPaymentDate(DATE_BOTH);
  await selectInstallment(String(INST_1.installmentId));
  return { container, setInput, selectInstallment, setPaymentDate, click, unmount };
}

describe("PaymentModal — cuota que deja de estar disponible al cambiar la fecha de pago", () => {
  beforeAll(async () => {
    installJsdomGlobals();
    await import("react-dom/client");
    await import("../cobranzas");
  }, MODULE_LOAD_TIMEOUT_MS);
  afterAll(() => { restoreGlobals(); });

  test("precondición: con la cuota 1 elegida, importe y vencimiento se autocompletan e Imputar está habilitado", async () => {
    mockFetch();
    const ui = await renderWithInstallmentOneSelected();
    try {
      expect(installmentSelect(ui.container).value).toBe(String(INST_1.installmentId));
      expect(amountInput(ui.container).value).toBe(String(INST_1.amount));
      expect(dueDateInput(ui.container).value).toBe(INST_1.dueDate);
      expect(imputarButton(ui.container).disabled).toBe(false);
      expect(ui.container.textContent).not.toContain(MESSAGE);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("1. al cambiar la fecha, la cuota que dejó de ser cobrable se desvincula", async () => {
    mockFetch();
    const ui = await renderWithInstallmentOneSelected();
    try {
      await ui.setPaymentDate(DATE_ONLY_SECOND);
      const select = installmentSelect(ui.container);
      expect(select.value).toBe("");
      const optionValues = Array.from(select.options).map((o) => o.value);
      expect(optionValues).toEqual(["", String(INST_2.installmentId)]);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("2. se limpian installmentId, vencimiento e importe", async () => {
    mockFetch();
    const ui = await renderWithInstallmentOneSelected();
    try {
      await ui.setPaymentDate(DATE_ONLY_SECOND);
      expect(installmentSelect(ui.container).value).toBe("");
      expect(dueDateInput(ui.container).value).toBe("");
      expect(dueDateInput(ui.container).disabled).toBe(false);
      expect(amountInput(ui.container).value).toBe("");
      expect(ui.container.textContent).not.toContain("Importe auto-completado desde la cuota seleccionada.");
      expect(ui.container.textContent).not.toContain("Tomado de la cuota vinculada");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("3. se conserva la póliza (y las cuotas se piden para esa póliza con la fecha nueva)", async () => {
    const fetchMock = mockFetch();
    const ui = await renderWithInstallmentOneSelected();
    try {
      await ui.setPaymentDate(DATE_ONLY_SECOND);
      expect(buttonByText(ui.container, POLICY_NUMBER)).toBeTruthy();
      expect(buttonByText(ui.container, "Seleccionar póliza...")).toBeUndefined();
      const pending = fetchMock.pendingCalls();
      const last = pending[pending.length - 1]!;
      const params = new URL(last.url, "http://localhost").searchParams;
      expect(params.get("policyId")).toBe(String(POLICY_ID));
      expect(params.get("paymentDate")).toBe(DATE_ONLY_SECOND);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("4. se muestra el aviso exacto", async () => {
    mockFetch();
    const ui = await renderWithInstallmentOneSelected();
    try {
      await ui.setPaymentDate(DATE_ONLY_SECOND);
      expect(ui.container.textContent).toContain(MESSAGE);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("5. Imputar pago queda deshabilitado hasta elegir otra cuota válida (y no envía nada)", async () => {
    const fetchMock = mockFetch();
    const ui = await renderWithInstallmentOneSelected();
    try {
      await ui.setPaymentDate(DATE_ONLY_SECOND);
      const button = imputarButton(ui.container);
      expect(button.disabled).toBe(true);
      await ui.click(button);
      expect(fetchMock.paymentPost()).toBeUndefined();

      // Elegir la opción "Sin vincular" no desbloquea: el importe sigue vacío.
      await ui.selectInstallment("");
      expect(imputarButton(ui.container).disabled).toBe(true);

      // Elegir otra cuota válida sí: autocompleta y habilita.
      await ui.selectInstallment(String(INST_2.installmentId));
      expect(amountInput(ui.container).value).toBe(String(INST_2.amount));
      expect(dueDateInput(ui.container).value).toBe(INST_2.dueDate);
      expect(imputarButton(ui.container).disabled).toBe(false);
      expect(ui.container.textContent).not.toContain(MESSAGE);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("6. restaurar la fecha anterior recupera las opciones sin reseleccionar la cuota ni restaurar el importe", async () => {
    mockFetch();
    const ui = await renderWithInstallmentOneSelected();
    try {
      await ui.setPaymentDate(DATE_ONLY_SECOND);
      await ui.setPaymentDate(DATE_BOTH);
      const select = installmentSelect(ui.container);
      const optionValues = Array.from(select.options).map((o) => o.value);
      expect(optionValues).toEqual(["", String(INST_1.installmentId), String(INST_2.installmentId)]);
      expect(select.value).toBe("");
      expect(amountInput(ui.container).value).toBe("");
      expect(dueDateInput(ui.container).value).toBe("");
      expect(imputarButton(ui.container).disabled).toBe(true);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("7. se puede iniciar conscientemente un pago sin cuota volviendo a escribir el importe", async () => {
    const fetchMock = mockFetch();
    const ui = await renderWithInstallmentOneSelected();
    try {
      await ui.setPaymentDate(DATE_ONLY_SECOND);
      await ui.setInput(amountInput(ui.container), "5000");
      expect(ui.container.textContent).not.toContain(MESSAGE);
      const button = imputarButton(ui.container);
      expect(button.disabled).toBe(false);
      await ui.click(button);
      const post = fetchMock.paymentPost();
      expect(post).toBeTruthy();
      expect(post!.body.policyId).toBe(POLICY_ID);
      expect(post!.body.installmentId).toBeNull();
      expect(post!.body.dueDate).toBeNull();
      expect(post!.body.amount).toBe(5000);
      expect(post!.body.paymentDate).toBe(DATE_ONLY_SECOND);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
