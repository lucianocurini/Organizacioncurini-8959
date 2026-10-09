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
// Importes exactos del smoke test de producción.
const INST_PROD = { installmentId: 82003, installmentNumber: 3, dueDate: "2026-11-15", amount: 143014.24, status: "pendiente", policyId: POLICY_ID };
const SALDO_PROD_CENTS = 1384560;

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
      return json(policyId === POLICY_ID ? [INST, INST2, INST_PROD] : []);
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
      // Con un único medio, el saldo máximo se ofrece aunque el medio ya cubra la cuota.
      expect(buttonByText(ui.container, "Aplicar saldo máximo")!.disabled).toBe(false);
      const removeButton = ui.container.querySelector('button[aria-label^="Eliminar medio de pago 1"]') as HTMLButtonElement;
      expect(removeButton.disabled).toBe(false);
      await ui.click(removeButton);
      await ui.click(buttonByText(ui.container, "Aplicar saldo máximo")!);
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
      // El medio se redujo solo a 70.000; el usuario lo vuelve a subir a mano.
      expect(firstSplitAmount(ui.container).value).toBe("70000.00");
      await ui.setInput(firstSplitAmount(ui.container), "100000");
      expect(imputarButton(ui.container).disabled).toBe(true);
      expect(ui.container.textContent!.replace(/ /g, " ")).toContain("El medio de pago debe ser $ 70.000,00");
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

  // ─── Caso del smoke test: cuota $143.014,24, efectivo por el total, saldo $13.845,60 ───
  const INVALID_TEXT = /--|NaN|Infinity|-\s?\$|\$\s?-/;
  const text = (c: Element) => c.textContent!.replace(/ /g, " ");
  const splitAmounts = (c: Element) => Array.from(c.querySelectorAll('input[id^="split-amount-"]')).map((i) => (i as HTMLInputElement).value);

  test("caso producción, saldo escrito a mano: el único efectivo baja a 129.168,64 y el payload cierra exacto", async () => {
    const m = mockFetch({ balanceCents: SALDO_PROD_CENTS });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST_PROD.installmentId));
      await ui.click(fundingToggle(ui.container));
      // Activar la cuenta corriente no crea sobrepago por sí solo.
      expect(firstSplitAmount(ui.container).value).toBe("143014.24");
      expect(ui.container.querySelector('[role="alert"]')).toBeNull();
      await ui.setInput(creditInput(ui.container), "13845.60");
      expect(firstSplitAmount(ui.container).value).toBe("129168.64");
      expect(text(ui.container)).not.toContain("superan");
      expect(imputarButton(ui.container).disabled).toBe(false);
      const summary = text(ui.container.querySelector('[data-testid="funding-summary"]')!);
      expect(summary).toContain("Importe a cancelar$ 143.014,24");
      expect(summary).toContain("Saldo a favor utilizado$ 13.845,60");
      expect(summary).toContain("Dinero real ingresado$ 129.168,64");
      expect(summary).not.toContain("Nuevo saldo a favor");
      await ui.click(imputarButton(ui.container));
      const body = m.fundedPosts()[0]!.body;
      expect(body.creditAppliedCents).toBe(SALDO_PROD_CENTS);
      expect(body.splits).toEqual([{ method: "efectivo", amount: 129168.64 }]);
      expect(body.creditAppliedCents + Math.round(body.splits[0].amount * 100)).toBe(14301424);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("caso producción, 'Aplicar saldo máximo': aplica 13.845,60 y reduce el efectivo", async () => {
    const m = mockFetch({ balanceCents: SALDO_PROD_CENTS });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST_PROD.installmentId));
      await ui.click(fundingToggle(ui.container));
      const maxButton = buttonByText(ui.container, "Aplicar saldo máximo")!;
      expect(maxButton.disabled).toBe(false);
      expect(text(ui.container.querySelector('[data-testid="funding-credit-help"]')!)).toContain("Máximo aplicable: $ 13.845,60");
      await ui.click(maxButton);
      expect(Number(creditInput(ui.container).value)).toBe(13845.6);
      expect(firstSplitAmount(ui.container).value).toBe("129168.64");
      expect(imputarButton(ui.container).disabled).toBe(false);
      await ui.click(imputarButton(ui.container));
      expect(m.fundedPosts()[0]!.body.splits).toEqual([{ method: "efectivo", amount: 129168.64 }]);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("saldo que cubre todo: el medio queda en $0 y se envían cero splits", async () => {
    const m = mockFetch({ balanceCents: 20000000 });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST_PROD.installmentId));
      await ui.click(fundingToggle(ui.container));
      await ui.click(buttonByText(ui.container, "Aplicar saldo máximo")!);
      expect(creditInput(ui.container).value).toBe("143014.24");
      expect(firstSplitAmount(ui.container).value).toBe("0.00");
      expect(text(ui.container)).toContain("Sin medios reales");
      expect(imputarButton(ui.container).disabled).toBe(false);
      await ui.click(imputarButton(ui.container));
      const body = m.fundedPosts()[0]!.body;
      expect(body.splits).toEqual([]);
      expect(body.creditAppliedCents).toBe(14301424);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("desactivar la cuenta corriente quita el saldo y el efectivo vuelve a cubrir el total (pago tradicional válido)", async () => {
    const m = mockFetch({ balanceCents: SALDO_PROD_CENTS });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST_PROD.installmentId));
      await ui.click(fundingToggle(ui.container));
      await ui.setInput(creditInput(ui.container), "13845.60");
      expect(firstSplitAmount(ui.container).value).toBe("129168.64");
      await ui.click(fundingToggle(ui.container));
      expect(creditInput(ui.container)).toBeNull();
      expect(firstSplitAmount(ui.container).value).toBe("143014.24");
      expect(imputarButton(ui.container).disabled).toBe(false);
      // Reactivar arranca sin saldo aplicado.
      await ui.click(fundingToggle(ui.container));
      expect(creditInput(ui.container).value).toBe("");
      expect(firstSplitAmount(ui.container).value).toBe("143014.24");
      await ui.click(fundingToggle(ui.container));
      await ui.click(imputarButton(ui.container));
      expect(m.fundedPosts().length).toBe(0);
      const body = m.paymentPosts()[0]!.body;
      expect("creditAppliedCents" in body).toBe(false);
      expect(body.splits).toEqual([{ method: "efectivo", amount: 143014.24 }]);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("cheque único: ni el saldo ni activar/desactivar modifican su importe; editar el efectivo a mano no se pisa", async () => {
    mockFetch({ balanceCents: SALDO_PROD_CENTS });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST_PROD.installmentId));
      const methodSelect = ui.container.querySelector('select[id^="split-method-"]') as HTMLSelectElement;
      const selectSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!;
      await ui.act(async () => {
        selectSetter.call(methodSelect, "cheque");
        methodSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        await flush();
      });
      await ui.click(fundingToggle(ui.container));
      // Cheque por un importe propio (distinto de la cuota): nada lo reajusta.
      await ui.setInput(firstSplitAmount(ui.container), "150000");
      await ui.setInput(creditInput(ui.container), "13845.60");
      expect(firstSplitAmount(ui.container).value).toBe("150000");
      await ui.setInput(creditInput(ui.container), "");
      await ui.click(fundingToggle(ui.container));
      expect(firstSplitAmount(ui.container).value).toBe("150000");
      // Volver a efectivo, activar y editar el medio a mano: cambiar otra cosa (notas) no lo pisa.
      await ui.act(async () => {
        selectSetter.call(methodSelect, "efectivo");
        methodSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        await flush();
      });
      await ui.click(fundingToggle(ui.container));
      await ui.setInput(creditInput(ui.container), "13845.60");
      await ui.setInput(firstSplitAmount(ui.container), "130000");
      const notes = ui.container.querySelector('textarea[placeholder="Observaciones opcionales..."]') as HTMLTextAreaElement;
      const taSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
      await ui.act(async () => { taSetter.call(notes, "nota"); notes.dispatchEvent(new dom.window.Event("input", { bubbles: true })); await flush(); });
      expect(firstSplitAmount(ui.container).value).toBe("130000");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("varios medios: no se alteran, se indica cuánto redistribuir y se bloquea hasta que cierre", async () => {
    const m = mockFetch({ balanceCents: SALDO_PROD_CENTS });
    const ui = await renderModal();
    try {
      await ui.selectInstallment(String(INST_PROD.installmentId));
      await ui.click(fundingToggle(ui.container));
      await ui.click(buttonByText(ui.container, "+ Agregar medio")!);
      const inputs = () => Array.from(ui.container.querySelectorAll('input[id^="split-amount-"]')) as HTMLInputElement[];
      await ui.setInput(inputs()[0]!, "100000");
      await ui.setInput(inputs()[1]!, "43014.24");
      // Cubren todo: el máximo aplicable sin tocarlos es $0 (nunca negativo).
      expect(buttonByText(ui.container, "Aplicar saldo máximo")!.disabled).toBe(true);
      expect(text(ui.container.querySelector('[data-testid="funding-credit-help"]')!)).toContain("Con varios medios");
      await ui.setInput(creditInput(ui.container), "13845.60");
      expect(splitAmounts(ui.container)).toEqual(["100000", "43014.24"]);
      expect(imputarButton(ui.container).disabled).toBe(true);
      const alert = text(ui.container.querySelector('[data-testid="individual-account-funding"] [role="alert"]')!);
      expect(alert).toContain("Redistribuí los medios reales para que sumen $ 129.168,64");
      expect(alert).toContain("reducilos en $ 13.845,60");
      expect(text(ui.container.querySelector('[data-testid="individual-account-funding"]')!)).not.toMatch(INVALID_TEXT);
      // El usuario redistribuye a mano: ahora cierra.
      await ui.setInput(inputs()[0]!, "86154.40");
      expect(imputarButton(ui.container).disabled).toBe(false);
      await ui.click(imputarButton(ui.container));
      const body = m.fundedPosts()[0]!.body;
      const realCents = body.splits.reduce((s: number, x: any) => s + Math.round(x.amount * 100), 0);
      expect(body.creditAppliedCents + realCents).toBe(14301424);
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
