// "Imputar pago": el selector de pólizas muestra SOLO pólizas en posición
// cobrable para la fecha de pago (GET /api/policies/collectable-for-payment).
// Se vuelve a pedir al cambiar la fecha; si la póliza elegida sale de
// posición se desvincula con aviso; una falla de red o una respuesta inválida
// no muestran ninguna póliza (nunca la lista completa) y bloquean Imputar;
// en edición se incluye la póliza del pago y editar notas no se bloquea.
//
// Mismo arnés que payment-modal-installment-unavailable.test.tsx.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { asCollectableSelectorRows, COLLECTABLE_POLICIES_PATH } from "./policy-selector-fixtures";

const DATE_A = "2026-11-03";
const DATE_B = "2026-12-01";

const P_VIGENTE = { policy: { id: 9101, policyNumber: "SEL-VIGENTE" }, insured: { id: 1, name: "Ana" }, company: { id: 4, name: "Cooperación" } };
const P_PROXIMA = { policy: { id: 9102, policyNumber: "SEL-PROXIMA" }, insured: { id: 1, name: "Ana" }, company: { id: 4, name: "Cooperación" }, via: "proxima_inmediata", hasCollectableInstallments: false };
const P_ACC = {
  policy: { id: 9103, policyNumber: "SEL-ACC", parentPolicyId: 9101, type: "accidentes_pasajeros" }, insured: { id: 1, name: "Ana" }, company: { id: 4, name: "Cooperación" },
  accessory: { parentPolicyId: 9101, parentPolicyNumber: "SEL-VIGENTE", linkValid: true },
};
const P_ACC_REVISAR = {
  policy: { id: 9104, policyNumber: "SEL-ACC-REV", parentPolicyId: 9999, type: "accidentes_pasajeros" }, insured: { id: 1, name: "Ana" }, company: { id: 4, name: "Cooperación" },
  accessory: { parentPolicyId: 9999, parentPolicyNumber: "SEL-VIEJA", linkValid: true },
};
const P_FUERA = { policy: { id: 9105, policyNumber: "SEL-FUERA" }, insured: { id: 1, name: "Ana" }, company: { id: 4, name: "Cooperación" } };

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

type SelectorMode = "ok" | "network_error" | "invalid";
/** DATE_A: vigente + accesoria + accesoria a revisar + próxima. DATE_B: solo la próxima (la vigente sale de posición). */
function mockFetch(opts: { selector?: SelectorMode; fuera?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  let selectorMode: SelectorMode = opts.selector ?? "ok";
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
    const json = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;
    if (url.startsWith(COLLECTABLE_POLICIES_PATH)) {
      if (selectorMode === "network_error") throw new TypeError("Failed to fetch");
      if (selectorMode === "invalid") return json({ unexpected: true });
      const params = new URL(url, "http://localhost").searchParams;
      const rows = params.get("paymentDate") === DATE_B ? [P_PROXIMA] : [P_ACC, P_VIGENTE, P_ACC_REVISAR, P_PROXIMA];
      const out = asCollectableSelectorRows(rows);
      if (params.get("includePolicyId") === String(P_FUERA.policy.id)) {
        out.push(...asCollectableSelectorRows([{ ...P_FUERA, collectable: false, via: null, reason: "SIN_POLIZA_VIGENTE_EN_CADENA" }]));
      }
      return json(out);
    }
    if (url.startsWith("/api/installments/pending-for-payment")) return json([]);
    if (url.startsWith("/api/policies/cash-period-search")) return json([]);
    if (/^\/api\/policies\/\d+\/installments$/.test(url)) return json([]);
    if (url === "/api/payments" && method === "POST") return json({ id: 5001 });
    if (/^\/api\/payments\/\d+$/.test(url) && method === "PUT") return json({ id: 7001 });
    throw new Error(`Unmocked fetch in test: ${method} ${url}`);
  };
  return {
    calls,
    setSelectorMode: (m: SelectorMode) => { selectorMode = m; },
    selectorCalls: () => calls.filter((c) => c.url.startsWith(COLLECTABLE_POLICIES_PATH)),
    legacyPoliciesCalls: () => calls.filter((c) => c.url === "/api/policies" || c.url.startsWith("/api/policies?")),
    paymentPost: () => calls.find((c) => c.url === "/api/payments" && c.method === "POST"),
    paymentPut: () => calls.find((c) => /^\/api\/payments\/\d+$/.test(c.url) && c.method === "PUT"),
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
const paymentDateInput = (c: Element) => elementAfterLabel(c, "Fecha de pago *") as HTMLInputElement;
const amountInput = (c: Element) => elementAfterLabel(c, "Importe *").querySelector("input") as HTMLInputElement;
const optionButtons = (c: Element) => Array.from(c.querySelectorAll('button[data-testid^="policy-option-"]')) as HTMLButtonElement[];
const optionIds = (c: Element) => optionButtons(c).map((b) => Number(b.dataset.testid!.replace("policy-option-", "")));

const MODULE_LOAD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

async function render(editing: any = null) {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { PaymentModal } = await import("../cobranzas");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  const inputSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  const textareaSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    root.render(React.createElement(PaymentModal, { open: true, onClose: () => {}, onSaved: () => {}, editing }));
    await flush();
  });
  async function setInput(input: HTMLInputElement, value: string) {
    await act(async () => {
      inputSetter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();
    });
  }
  async function setTextarea(el: HTMLTextAreaElement, value: string) {
    await act(async () => {
      textareaSetter.call(el, value);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();
    });
  }
  async function click(el: HTMLElement) { await act(async () => { el.click(); await flush(); }); }
  async function openSelector() {
    const trigger = buttonByText(container, "Seleccionar póliza...") ?? Array.from(container.querySelectorAll("button")).find((b) => b.querySelector("svg") && b.textContent?.includes("—"));
    await click(trigger as HTMLButtonElement);
  }
  async function unmount() { await act(async () => { root.unmount(); }); container.remove(); }
  return { container, setInput, setTextarea, click, openSelector, setPaymentDate: (v: string) => setInput(paymentDateInput(container), v), unmount };
}

describe("PaymentModal — selector de pólizas por posición cobrable", () => {
  beforeAll(async () => {
    installJsdomGlobals();
    await import("react-dom/client");
    await import("../cobranzas");
  }, MODULE_LOAD_TIMEOUT_MS);
  afterAll(() => { restoreGlobals(); });

  test("pide el selector con la fecha de pago (nunca /api/policies) y lista solo lo que devuelve, con accesorias agrupadas y etiquetas", async () => {
    const f = mockFetch();
    const ui = await render();
    try {
      await ui.setPaymentDate(DATE_A);
      const last = f.selectorCalls().at(-1)!;
      expect(new URL(last.url, "http://localhost").searchParams.get("paymentDate")).toBe(DATE_A);
      expect(f.legacyPoliciesCalls()).toEqual([]);
      await ui.openSelector();
      // Principal, su accesoria debajo, luego la próxima y la accesoria a revisar.
      expect(optionIds(ui.container)).toEqual([P_VIGENTE.policy.id, P_ACC.policy.id, P_PROXIMA.policy.id, P_ACC_REVISAR.policy.id]);
      const text = (id: number) => ui.container.querySelector(`[data-testid="policy-option-${id}"]`)!.textContent!;
      expect(text(P_ACC.policy.id)).toContain("Accesoria de SEL-VIGENTE");
      expect(text(P_ACC_REVISAR.policy.id)).toContain("Accesoria — vínculo a revisar");
      expect(text(P_PROXIMA.policy.id)).toContain("Próxima");
      expect(text(P_PROXIMA.policy.id)).toContain("sin cuotas pendientes");
      expect(text(P_VIGENTE.policy.id)).not.toContain("sin cuotas pendientes");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("cambio de fecha: se vuelve a pedir; la póliza elegida que sale de posición se desvincula con aviso e Imputar queda bloqueado", async () => {
    const f = mockFetch();
    const ui = await render();
    try {
      await ui.setPaymentDate(DATE_A);
      await ui.openSelector();
      await ui.click(ui.container.querySelector(`[data-testid="policy-option-${P_VIGENTE.policy.id}"]`) as HTMLButtonElement);
      await ui.setInput(amountInput(ui.container), "5000");
      expect(buttonByText(ui.container, "Imputar pago")!.disabled).toBe(false);

      await ui.setPaymentDate(DATE_B);
      expect(new URL(f.selectorCalls().at(-1)!.url, "http://localhost").searchParams.get("paymentDate")).toBe(DATE_B);
      expect(ui.container.querySelector('[data-testid="policy-no-longer-available"]')).toBeTruthy();
      expect(buttonByText(ui.container, "Seleccionar póliza...")).toBeTruthy();
      expect(amountInput(ui.container).value).toBe("");
      const imputar = buttonByText(ui.container, "Imputar pago")!;
      expect(imputar.disabled).toBe(true);
      await ui.click(imputar);
      expect(f.paymentPost()).toBeUndefined();

      // Elegir otra póliza disponible quita el aviso.
      await ui.openSelector();
      expect(optionIds(ui.container)).toEqual([P_PROXIMA.policy.id]);
      await ui.click(ui.container.querySelector(`[data-testid="policy-option-${P_PROXIMA.policy.id}"]`) as HTMLButtonElement);
      expect(ui.container.querySelector('[data-testid="policy-no-longer-available"]')).toBeNull();
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("la póliza que sigue en posición tras cambiar la fecha no se desvincula", async () => {
    mockFetch();
    const ui = await render();
    try {
      await ui.setPaymentDate(DATE_A);
      await ui.openSelector();
      await ui.click(ui.container.querySelector(`[data-testid="policy-option-${P_PROXIMA.policy.id}"]`) as HTMLButtonElement);
      await ui.setPaymentDate(DATE_B);
      expect(ui.container.querySelector('[data-testid="policy-no-longer-available"]')).toBeNull();
      expect(buttonByText(ui.container, "SEL-PROXIMA")).toBeTruthy();
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  for (const mode of ["network_error", "invalid"] as const) {
    test(`falla cerrada (${mode}): no se muestra ninguna póliza ni se pide la lista completa; Imputar bloqueado; Reintentar recupera`, async () => {
      const f = mockFetch({ selector: mode });
      const ui = await render();
      try {
        await ui.setPaymentDate(DATE_A);
        expect(ui.container.querySelector('[data-testid="policy-selector-error"]')).toBeTruthy();
        await ui.openSelector();
        expect(optionButtons(ui.container)).toEqual([]);
        expect(f.legacyPoliciesCalls()).toEqual([]);
        expect(buttonByText(ui.container, "Imputar pago")!.disabled).toBe(true);

        f.setSelectorMode("ok");
        const retry = Array.from(ui.container.querySelectorAll('[data-testid="policy-selector-error"] button'))[0] as HTMLButtonElement;
        await ui.click(retry);
        expect(ui.container.querySelector('[data-testid="policy-selector-error"]')).toBeNull();
        if (!optionButtons(ui.container).length) await ui.openSelector();
        expect(optionIds(ui.container)).toContain(P_VIGENTE.policy.id);
      } finally {
        await ui.unmount();
      }
    }, TEST_TIMEOUT_MS);
  }

  test("edición histórica: incluye la póliza del pago aunque esté fuera de posición, no la desvincula y guardar notas envía el PUT", async () => {
    const f = mockFetch();
    const editing = {
      payment: {
        id: 7001, batchId: null, policyId: P_FUERA.policy.id, installmentId: null, manualPayer: null, manualPolicyNumber: null, manualCompany: null,
        amount: 500, paymentMethod: "efectivo", splits: [{ method: "efectivo", amountCents: 50000 }], paymentDate: "2025-06-01",
        periodMonth: null, notes: "", status: "confirmado", rendered: 0, hasSurcharge: false, dueDate: null,
      },
      policy: null, insured: null, company: null,
    };
    const ui = await render(editing);
    try {
      const params = new URL(f.selectorCalls().at(-1)!.url, "http://localhost").searchParams;
      expect(params.get("includePolicyId")).toBe(String(P_FUERA.policy.id));
      expect(params.get("paymentDate")).toBe("2025-06-01");
      expect(buttonByText(ui.container, "SEL-FUERA")).toBeTruthy();
      expect(ui.container.querySelector('[data-testid="policy-no-longer-available"]')).toBeNull();

      const notes = elementAfterLabel(ui.container, "Notas") as HTMLTextAreaElement;
      await ui.setTextarea(notes, "nota nueva");
      const save = buttonByText(ui.container, "Guardar cambios")!;
      expect(save.disabled).toBe(false);
      await ui.click(save);
      const put = f.paymentPut();
      expect(put).toBeTruthy();
      expect(put!.body.policyId).toBe(P_FUERA.policy.id);
      expect(put!.body.notes).toBe("nota nueva");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
