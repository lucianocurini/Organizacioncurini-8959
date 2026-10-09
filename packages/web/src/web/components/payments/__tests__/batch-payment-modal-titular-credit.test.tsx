// "Cobrar en lote" con titular de cuenta: el crédito aplicado reemplaza parte
// del único medio real (mismo caso del smoke test de "Imputar pago": cuota
// $143.014,24, efectivo por el total, saldo $13.845,60). Mismo arnés que
// batch-payment-modal-collectability.test.tsx.
// Ejecutar con: bun test packages/web/src/web/components/payments/__tests__/batch-payment-modal-titular-credit.test.tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import type { BatchCartItem } from "@/lib/payment-batch-form";

const HOLDER_ID = 4700;
const SALDO_CENTS = 1384560;
const TOTAL_CENTS = 14301424;
const INVALID_TEXT = /--|NaN|Infinity|-\s?\$|\$\s?-/;

const CART: BatchCartItem[] = [{
  kind: "installment", installmentId: 1, policyId: 10, policyNumber: "POL-1",
  policyType: "automotor", parentPolicyId: null, parentPolicyNumber: null,
  insuredId: HOLDER_ID, insuredName: "QA Titular", companyId: 200, companyName: "Compañía A",
  installmentNumber: 1, dueDate: "2026-10-01", amount: 143014.24, status: "pendiente",
}];

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

function mockFetch(balanceCents = SALDO_CENTS) {
  const posts: any[] = [];
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body }) as any;
    if (url.startsWith("/api/installments/pending-for-payment")) return json([{ installmentId: 1 }]);
    if (url.startsWith("/api/insureds?q=")) return json([{ id: HOLDER_ID, name: "QA Titular" }]);
    if (url.startsWith(`/api/insureds/${HOLDER_ID}/account-holder-balance`)) {
      return json({ insuredId: HOLDER_ID, balanceCents, availableCreditCents: Math.max(0, balanceCents) });
    }
    if (url === "/api/payment-batches" && method === "POST") {
      posts.push(JSON.parse(init.body));
      return json({ id: 77 }, 201);
    }
    throw new Error(`Unmocked fetch in test: ${method} ${url}`);
  };
  return { posts };
}

async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const MODULE_LOAD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

async function renderModal() {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { BatchPaymentModal } = await import("../PendingInstallmentsBatchTab");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  await act(async () => {
    root.render(React.createElement(BatchPaymentModal, { cart: CART, onClose: () => {}, onCreated: () => {} }));
    await flush();
  });
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  const setInput = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();
    });
  };
  const click = async (el: HTMLElement) => { await act(async () => { el.click(); await flush(); }); };
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
  const splitInputs = () => Array.from(container.querySelectorAll("select.payment-method-select + input")) as HTMLInputElement[];
  const creditInput = () => {
    const label = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.trim() === "Crédito aplicado")!;
    return label.nextElementSibling as HTMLInputElement;
  };
  const text = () => (container.textContent ?? "").replace(/ /g, " ");

  async function selectHolder() {
    const search = container.querySelector('input[placeholder^="Buscar asegurado para usar como titular"]') as HTMLInputElement;
    await setInput(search, "QA");
    await click(button("QA Titular"));
  }
  return {
    container, setInput, click, button, splitInputs, creditInput, text, selectHolder,
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

describe("BatchPaymentModal — crédito del titular con un único medio real", () => {
  beforeAll(async () => {
    installJsdomGlobals();
    await import("react-dom/client");
    await import("../PendingInstallmentsBatchTab");
  }, MODULE_LOAD_TIMEOUT_MS);
  afterAll(() => { restoreGlobals(); });

  test("caso producción: escribir 13.845,60 de crédito baja el efectivo a 129.168,64 y el payload cierra exacto", async () => {
    const m = mockFetch();
    const ui = await renderModal();
    try {
      expect(ui.splitInputs().map((i) => i.value)).toEqual(["143014.24"]);
      await ui.selectHolder();
      expect(ui.text()).toContain("Saldo: $ 13.845,60");
      await ui.setInput(ui.creditInput(), "13845.60");
      expect(ui.splitInputs().map((i) => i.value)).toEqual(["129168.64"]);
      expect(ui.text()).not.toContain("superan");
      expect(ui.text()).toContain("Resumen del cierre");
      const confirm = Array.from(ui.container.querySelectorAll('input[type="checkbox"]')).find((c) => c.parentElement?.textContent?.startsWith("Confirmo el cobro")) as HTMLInputElement;
      await ui.click(confirm);
      expect(ui.button("Confirmar cobro").disabled).toBe(false);
      await ui.click(ui.button("Confirmar cobro"));
      expect(m.posts.length).toBe(1);
      const body = m.posts[0];
      expect(body.creditAppliedCents).toBe(SALDO_CENTS);
      expect(body.splits).toEqual([{ method: "efectivo", amount: 129168.64 }]);
      expect(body.creditAppliedCents + Math.round(body.splits[0].amount * 100)).toBe(TOTAL_CENTS);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("quitar el titular vuelve a cubrir el total con el único medio", async () => {
    mockFetch();
    const ui = await renderModal();
    try {
      await ui.selectHolder();
      await ui.setInput(ui.creditInput(), "13845.60");
      expect(ui.splitInputs().map((i) => i.value)).toEqual(["129168.64"]);
      await ui.click(ui.container.querySelector('button[title^="Quitar titular"]') as HTMLButtonElement);
      expect(ui.splitInputs().map((i) => i.value)).toEqual(["143014.24"]);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("saldo que cubre el 100%: el lote sigue exigiendo un medio real, no envía el medio en $0 y lo explica sin texto inválido", async () => {
    const m = mockFetch(20000000);
    const ui = await renderModal();
    try {
      await ui.selectHolder();
      await ui.setInput(ui.creditInput(), "143014.24");
      expect(ui.splitInputs().map((i) => i.value)).toEqual(["0.00"]);
      const confirmCheckbox = Array.from(ui.container.querySelectorAll('input[type="checkbox"]')).find((c) => c.parentElement?.textContent?.startsWith("Confirmo el cobro")) as HTMLInputElement | undefined;
      if (confirmCheckbox) await ui.click(confirmCheckbox);
      expect(ui.button("Confirmar cobro").disabled).toBe(true);
      await ui.click(ui.button("Confirmar cobro"));
      expect(m.posts.length).toBe(0);
      const t = ui.text();
      expect(t).toContain("El cobro en lote necesita al menos un medio real");
      expect(t.slice(t.indexOf("Medios de pago"))).not.toMatch(INVALID_TEXT);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("varios medios: no se alteran y el aviso indica cuánto redistribuir, sin texto inválido", async () => {
    mockFetch();
    const ui = await renderModal();
    try {
      await ui.selectHolder();
      await ui.click(ui.button("Agregar medio"));
      await ui.setInput(ui.splitInputs()[0]!, "100000");
      await ui.setInput(ui.splitInputs()[1]!, "43014.24");
      await ui.setInput(ui.creditInput(), "13845.60");
      expect(ui.splitInputs().map((i) => i.value)).toEqual(["100000", "43014.24"]);
      expect(ui.text()).toContain("Redistribuí los medios reales para que sumen $ 129.168,64");
      expect(ui.button("Confirmar cobro").disabled).toBe(true);
      const titularBox = ui.container.querySelector("p.text-amber-300")!;
      expect(titularBox.textContent!.replace(/ /g, " ")).not.toMatch(INVALID_TEXT);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
