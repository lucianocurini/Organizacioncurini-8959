// "Imputar pago" con cuenta corriente del asegurado (pago individual con
// saldo a favor / deuda autorizada / sobrante). Mismo arnés que
// payment-modal-installment-unavailable.test.tsx: <PaymentModal> real montado
// con react-dom/client sobre un jsdom aislado y `fetch` mockeado.
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/payment-modal-account-funding.test.tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";

const POLICY_ID = 57700;
const POLICY_NUMBER = "QA-SALDO-IND";
const OTHER_POLICY_ID = 57701;
const OTHER_POLICY_NUMBER = "QA-SALDO-OTRA";
const INSURED_ID = 3700;
const PAYMENT_DATE = "2026-10-01";

const POLICIES_RESPONSE = [
  { policy: { id: POLICY_ID, policyNumber: POLICY_NUMBER, companyId: 4 }, insured: { id: INSURED_ID, name: "QA Saldo" }, company: { id: 4, name: "Cooperación" } },
  { policy: { id: OTHER_POLICY_ID, policyNumber: OTHER_POLICY_NUMBER, companyId: 4 }, insured: { id: 3701, name: "QA Otro" }, company: { id: 4, name: "Cooperación" } },
];
const INST = { installmentId: 82001, installmentNumber: 1, dueDate: "2026-09-15", amount: 100000, status: "pendiente", policyId: POLICY_ID };
const INST2 = { installmentId: 82002, installmentNumber: 2, dueDate: "2026-10-15", amount: 100000, status: "pendiente", policyId: POLICY_ID };

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

function mockFetch(opts: { balanceCents?: number; fundedResponses?: Array<"ok" | "network" | { status: number; body: any }> } = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const fundedQueue = [...(opts.fundedResponses ?? [])];
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
    const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body }) as any;
    if (url.startsWith("/api/installments/pending-for-payment")) {
      const policyId = Number(new URL(url, "http://localhost").searchParams.get("policyId"));
      return json(policyId === POLICY_ID ? [INST, INST2] : []);
    }
    if (url.startsWith("/api/policies/cash-period-search")) return json([]);
    if (url === "/api/policies?includeAccessories=1") return json(POLICIES_RESPONSE);
    if (url.startsWith(`/api/insureds/${INSURED_ID}/account-holder-balance`)) {
      const b = opts.balanceCents ?? 3000000;
      return json({ insuredId: INSURED_ID, balanceCents: b, availableCreditCents: Math.max(0, b) });
    }
    if (url === "/api/payments" && method === "POST") return json({ id: 5001 });
    if (url === "/api/payments/account-funded" && method === "POST") {
      const next = fundedQueue.shift() ?? "ok";
      if (next === "network") throw new TypeError("Failed to fetch");
      if (next === "ok") return json({ id: 9001 }, 201);
      return json(next.body, next.status);
    }
    throw new Error(`Unmocked fetch in test: ${method} ${url}`);
  };
  return {
    calls,
    fundedPosts: () => calls.filter((c) => c.url === "/api/payments/account-funded" && c.method === "POST"),
    paymentPosts: () => calls.filter((c) => c.url === "/api/payments" && c.method === "POST"),
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
const paymentDateInput = (c: Element) => elementAfterLabel(c, "Fecha de pago *") as HTMLInputElement;
const fundingSection = (c: Element) => c.querySelector('[data-testid="individual-account-funding"]');
const fundingToggle = (c: Element) => fundingSection(c)!.querySelector('input[type="checkbox"]') as HTMLInputElement;
const creditInput = (c: Element) => c.querySelector("#funding-credit") as HTMLInputElement;
const firstSplitAmount = (c: Element) => c.querySelector('input[id^="split-amount-"]') as HTMLInputElement;
const imputarButton = (c: Element) => Array.from(c.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Imputar pago").pop() as HTMLButtonElement;

const MODULE_LOAD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

async function renderModal() {
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
  async function choosePolicy(policyNumber: string) {
    await act(async () => {
      const opener = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Seleccionar póliza...") || b.textContent?.includes(" — QA "))!;
      opener.click();
      await flush(1);
      const input = container.querySelector('input[placeholder="Buscar..."]') as HTMLInputElement;
      inputSetter.call(input, policyNumber);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush(1);
      buttonByText(container, policyNumber)!.click();
      await flush();
    });
  }
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
  async function click(el: HTMLElement) { await act(async () => { el.click(); await flush(); }); }
  async function unmount() { await act(async () => { root.unmount(); }); container.remove(); }

  await choosePolicy(POLICY_NUMBER);
  await setInput(paymentDateInput(container), PAYMENT_DATE);
  return { container, act, choosePolicy, setInput, selectInstallment, click, unmount };
}

describe("PaymentModal — cuenta corriente del asegurado (pago individual con saldo)", () => {
  beforeAll(async () => {
    installJsdomGlobals();
    await import("react-dom/client");
    await import("../cobranzas");
  }, MODULE_LOAD_TIMEOUT_MS);
  afterAll(() => { restoreGlobals(); });

  test("sin cuota no se ofrece; sin activarla, el pago tradicional sigue yendo a POST /api/payments sin campos de financiación", async () => {
    const m = mockFetch();
    const ui = await renderModal();
    try {
      expect(fundingSection(ui.container)).toBeNull();
      await ui.selectInstallment(String(INST.installmentId));
      expect(fundingSection(ui.container)).not.toBeNull();
      expect(fundingToggle(ui.container).checked).toBe(false);
      await ui.click(imputarButton(ui.container));
      expect(m.paymentPosts().length).toBe(1);
      expect(m.fundedPosts().length).toBe(0);
      const body = m.paymentPosts()[0]!.body;
      for (const k of ["creditAppliedCents", "debtAuthorized", "idempotencyKey", "accountHolderInsuredId"]) expect(k in body).toBe(false);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("30.000 de saldo + 70.000 real: resumen correcto y POST /api/payments/account-funded sin titular en el body", async () => {
    const m = mockFetch({ balanceCents: 3000000 });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST.installmentId));
      await ui.click(fundingToggle(ui.container));
      expect(ui.container.querySelector('[data-testid="funding-balance"]')?.textContent).toContain("30.000");
      await ui.setInput(creditInput(ui.container), "30000");
      await ui.setInput(firstSplitAmount(ui.container), "70000");
      const summary = ui.container.querySelector('[data-testid="funding-summary"]')!.textContent!;
      expect(summary).toContain("Importe a cancelar");
      expect(summary).toContain("Saldo a favor utilizado");
      expect(summary).toContain("Dinero real ingresado");
      expect(summary).not.toContain("Nueva deuda");
      expect(imputarButton(ui.container).disabled).toBe(false);
      await ui.click(imputarButton(ui.container));
      expect(m.fundedPosts().length).toBe(1);
      expect(m.paymentPosts().length).toBe(0);
      const body = m.fundedPosts()[0]!.body;
      expect(body.policyId).toBe(POLICY_ID);
      expect(body.installmentId).toBe(INST.installmentId);
      expect(body.creditAppliedCents).toBe(3000000);
      expect(body.splits).toEqual([{ method: "efectivo", amount: 70000 }]);
      expect(typeof body.idempotencyKey).toBe("string");
      expect("accountHolderInsuredId" in body).toBe(false);
      expect("amount" in body).toBe(false);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("reintento tras error de red reutiliza la misma clave; un cambio económico genera otra", async () => {
    const m = mockFetch({ balanceCents: 3000000, fundedResponses: ["network", "network", "ok"] });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST.installmentId));
      await ui.click(fundingToggle(ui.container));
      await ui.setInput(creditInput(ui.container), "30000");
      await ui.setInput(firstSplitAmount(ui.container), "70000");
      await ui.click(imputarButton(ui.container));
      await ui.click(imputarButton(ui.container));
      const [k1, k2] = m.fundedPosts().map((c) => c.body.idempotencyKey);
      expect(k1).toBe(k2);
      await ui.setInput(creditInput(ui.container), "20000");
      await ui.setInput(firstSplitAmount(ui.container), "80000");
      await ui.click(imputarButton(ui.container));
      const k3 = m.fundedPosts()[2]!.body.idempotencyKey;
      expect(k3).not.toBe(k1);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("doble clic sincrónico: un solo POST", async () => {
    const m = mockFetch({ balanceCents: 3000000 });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST.installmentId));
      await ui.click(fundingToggle(ui.container));
      await ui.setInput(creditInput(ui.container), "30000");
      await ui.setInput(firstSplitAmount(ui.container), "70000");
      await ui.act(async () => {
        const b = imputarButton(ui.container);
        b.click();
        b.click();
        await flush();
      });
      expect(m.fundedPosts().length).toBe(1);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("100% con saldo: se puede quitar el último medio real y se envían cero splits", async () => {
    const m = mockFetch({ balanceCents: 10000000 });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST.installmentId));
      await ui.click(fundingToggle(ui.container));
      // El medio único ya cubre la cuota: no hay saldo que aplicar todavía.
      expect(buttonByText(ui.container, "Usar máximo")!.disabled).toBe(true);
      const removeButton = ui.container.querySelector('button[aria-label^="Eliminar medio de pago 1"]') as HTMLButtonElement;
      expect(removeButton.disabled).toBe(false);
      await ui.click(removeButton);
      await ui.click(buttonByText(ui.container, "Usar máximo")!);
      expect(creditInput(ui.container).value).toBe("100000");
      expect(ui.container.textContent).toContain("Sin medios reales");
      await ui.click(imputarButton(ui.container));
      const body = m.fundedPosts()[0]!.body;
      expect(body.splits).toEqual([]);
      expect(body.creditAppliedCents).toBe(10000000);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("la deuda solo se ofrece con el saldo agotado y exige motivo", async () => {
    const m = mockFetch({ balanceCents: 2000000 });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST.installmentId));
      await ui.click(fundingToggle(ui.container));
      await ui.setInput(firstSplitAmount(ui.container), "50000");
      // Faltan 50.000: 20.000 se pueden cubrir con saldo — la deuda se ofrece solo por los 30.000 restantes.
      const debtLabel = () => Array.from(ui.container.querySelectorAll("span")).find((s) => s.textContent?.startsWith("Autorizar saldo deudor"));
      expect(debtLabel()?.textContent).toContain("30.000");
      const debtCheckbox = debtLabel()!.parentElement!.querySelector("input") as HTMLInputElement;
      await ui.click(debtCheckbox);
      expect(imputarButton(ui.container).disabled).toBe(true);
      expect(ui.container.textContent).toContain("El motivo es obligatorio");
      await ui.setInput(ui.container.querySelector('input[aria-label="Motivo del saldo deudor"]') as HTMLInputElement, "paga la semana próxima");
      // Saldo sin aplicar + deuda: el plan lo rechaza y el botón queda bloqueado.
      expect(imputarButton(ui.container).disabled).toBe(true);
      expect(ui.container.textContent).toContain("saldo a favor disponible sin aplicar");
      await ui.setInput(creditInput(ui.container), "20000");
      expect(imputarButton(ui.container).disabled).toBe(false);
      expect(ui.container.querySelector('[data-testid="funding-summary"]')!.textContent).toContain("Nueva deuda del asegurado");
      await ui.click(imputarButton(ui.container));
      const body = m.fundedPosts()[0]!.body;
      expect(body.debtAuthorized).toBe(true);
      expect(body.debtReason).toBe("paga la semana próxima");
      expect(body.creditAppliedCents).toBe(2000000);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("sobrante con saldo aplicado: bloqueado con mensaje claro", async () => {
    mockFetch({ balanceCents: 3000000 });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST.installmentId));
      await ui.click(fundingToggle(ui.container));
      await ui.setInput(creditInput(ui.container), "30000");
      await ui.setInput(firstSplitAmount(ui.container), "100000");
      expect(imputarButton(ui.container).disabled).toBe(true);
      expect(ui.container.textContent).toContain("reducí el saldo aplicado");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("asegurado con deuda previa entrega un sobrante: el resumen muestra cuánto cancela y el saldo final, no 'nuevo saldo a favor'", async () => {
    mockFetch({ balanceCents: -3000000 });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST.installmentId));
      await ui.click(fundingToggle(ui.container));
      expect(ui.container.querySelector('[data-testid="funding-balance"]')?.textContent).toContain("Saldo deudor actual");
      await ui.setInput(firstSplitAmount(ui.container), "110000");
      const summary = ui.container.querySelector('[data-testid="funding-summary"]')!.textContent!.replace(/ /g, " ");
      expect(summary).toContain("Cancela deuda anterior$ 10.000,00");
      expect(summary).toContain("Saldo final de la cuenta (deudor)$ 20.000,00");
      expect(summary).not.toContain("Nuevo saldo a favor");
      expect(imputarButton(ui.container).disabled).toBe(false);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("cambiar de cuota reinicia el saldo aplicado; quitar la cuota o cambiar de póliza apaga la cuenta corriente", async () => {
    mockFetch({ balanceCents: 3000000 });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST.installmentId));
      await ui.click(fundingToggle(ui.container));
      await ui.setInput(creditInput(ui.container), "30000");
      await ui.selectInstallment(String(INST2.installmentId));
      expect(fundingToggle(ui.container).checked).toBe(true);
      expect(creditInput(ui.container).value).toBe("");
      await ui.setInput(creditInput(ui.container), "30000");
      await ui.selectInstallment("");
      expect(fundingSection(ui.container)).toBeNull();
      await ui.selectInstallment(String(INST.installmentId));
      expect(fundingToggle(ui.container).checked).toBe(false);
      await ui.click(fundingToggle(ui.container));
      await ui.choosePolicy(OTHER_POLICY_NUMBER);
      await ui.choosePolicy(POLICY_NUMBER);
      await ui.setInput(paymentDateInput(ui.container), PAYMENT_DATE);
      await ui.selectInstallment(String(INST.installmentId));
      expect(fundingToggle(ui.container).checked).toBe(false);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
