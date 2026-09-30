// Contado por período con la fecha de pago elegida (regla única de
// cobrabilidad): GET /policies/cash-period-search recibe la fecha de pago del
// formulario, se vuelve a consultar al cambiarla, una respuesta vieja nunca
// pisa la de la fecha actual, y el POST /payment-batches/cash-period-payment
// sale con exactamente la misma fecha con la que se evaluó el período.
//
// Mismo arnés que payment-modal-cash-period-wiring.test.tsx: <PaymentModal>
// real montado con react-dom/client sobre un jsdom aislado y `fetch` mockeado.
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/payment-modal-cash-period-date.test.tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { toArgentinaCalendarDay } from "../../../lib/dates/argentina-date";

const POLICY_ID = 57508;
const POLICY_NUMBER = "QA-CONTADO-FECHA";

const POLICIES_RESPONSE = [
  { policy: { id: POLICY_ID, policyNumber: POLICY_NUMBER, companyId: 4 }, insured: { id: 3585, name: "QA Contado Fecha" } },
];

const PENDING_RESPONSE = [1, 2].map((n) => ({
  installmentId: 75428 + n, installmentNumber: n, dueDate: `2026-1${n - 1}-13`, amount: 100000, status: "pendiente", policyId: POLICY_ID,
}));

const ELIGIBLE = [{
  policyId: POLICY_ID, policyNumber: POLICY_NUMBER, insuredId: 3585, insuredName: "QA Contado Fecha",
  companyId: 4, companyName: "Cooperación", rebillingId: null,
  cashPaymentAmountCents: 38000000, nominalAmountCents: 40000000, discountAmountCents: 2000000,
  installmentCount: 4, periodStartDate: "2026-08-13", deadline: "2026-09-12", deadlineStatus: "vigente",
  eligible: true, ineligibleReasons: [],
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

interface Deferred { resolve: (body: any) => void }

/**
 * fetch mockeado. cash-period-search responde según la paymentDate de la
 * query: `searchByDate[fecha]` (inmediato) o, si la fecha está en
 * `deferredDates`, queda pendiente hasta que el test la resuelva a mano.
 */
function mockFetch(opts: { searchByDate: Record<string, any[]>; deferredDates?: string[] }) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const deferred = new Map<string, Deferred>();
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
    const json = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;
    if (url.startsWith("/api/policies/cash-period-search")) {
      const date = new URL(url, "http://localhost").searchParams.get("paymentDate") ?? "";
      if (opts.deferredDates?.includes(date)) {
        return new Promise((resolve) => deferred.set(date, { resolve: (body) => resolve(json(body)) }));
      }
      return json(opts.searchByDate[date] ?? []);
    }
    if (url.startsWith("/api/installments/pending-for-payment")) return json(PENDING_RESPONSE);
    if (url === "/api/policies?includeAccessories=1") return json(POLICIES_RESPONSE);
    if (url === "/api/payment-batches/cash-period-payment" && method === "POST") {
      return json({ id: 901, nominalAmountCents: 40000000, discountAmountCents: 2000000, cashAmountCents: 38000000 });
    }
    throw new Error(`Unmocked fetch in test: ${method} ${url}`);
  };
  return {
    calls,
    searchCalls: () => calls.filter((c) => c.url.startsWith("/api/policies/cash-period-search")),
    resolveDeferred: (date: string, body: any[]) => deferred.get(date)!.resolve(body),
  };
}

async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonByText(container: Element, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement | undefined;
}

/** Input que sigue al label "Fecha de pago *" (cuota o contado: nunca los dos a la vez). */
function paymentDateInput(container: Element): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.trim() === "Fecha de pago *")!;
  return label.nextElementSibling as HTMLInputElement;
}

// Import en frío de cobranzas.tsx (grafo grande): se hace una sola vez en
// beforeAll con timeout amplio, no dentro del primer test (timeout 5 s).
const MODULE_LOAD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

async function renderAndSelectPolicy() {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { PaymentModal } = await import("../cobranzas");
  // Contenedor nuevo por test: un fallo nunca arrastra al siguiente.
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  await act(async () => {
    root.render(React.createElement(PaymentModal, { open: true, onClose: () => {}, onSaved: () => {}, editing: null }));
    await flush();
  });
  const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    buttonByText(container, "Seleccionar póliza...")!.click();
    await flush(1);
    const input = container.querySelector('input[placeholder="Buscar..."]') as HTMLInputElement;
    nativeSetter.call(input, POLICY_NUMBER);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await flush(1);
    buttonByText(container, POLICY_NUMBER)!.click();
    await flush();
  });

  async function setPaymentDate(value: string) {
    await act(async () => {
      const input = paymentDateInput(container);
      nativeSetter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();
    });
  }
  async function click(text: string) {
    await act(async () => { buttonByText(container, text)!.click(); await flush(); });
  }
  async function unmount() { await act(async () => { root.unmount(); }); container.remove(); }
  return { container, act, setPaymentDate, click, unmount };
}

describe("PaymentModal — contado evaluado con la fecha de pago elegida", () => {
  beforeAll(async () => {
    installJsdomGlobals();
    await import("react-dom/client");
    await import("../cobranzas");
  }, MODULE_LOAD_TIMEOUT_MS);
  afterAll(() => { restoreGlobals(); });

  test("cash-period-search recibe la fecha de pago seleccionada (por defecto, hoy en Argentina)", async () => {
    const today = toArgentinaCalendarDay();
    const fetchMock = mockFetch({ searchByDate: { [today]: ELIGIBLE } });
    const ui = await renderAndSelectPolicy();
    try {
      const searches = fetchMock.searchCalls();
      expect(searches.length).toBe(1);
      const params = new URL(searches[0]!.url, "http://localhost").searchParams;
      expect(params.get("policyId")).toBe(String(POLICY_ID));
      expect(params.get("paymentDate")).toBe(today);
      expect(ui.container.textContent).toContain("Modalidad de pago");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("al cambiar la fecha se vuelve a evaluar el contado con la fecha nueva", async () => {
    const today = toArgentinaCalendarDay();
    const fetchMock = mockFetch({ searchByDate: { [today]: ELIGIBLE, "2027-03-01": [] } });
    const ui = await renderAndSelectPolicy();
    try {
      expect(ui.container.textContent).toContain("Modalidad de pago");
      await ui.setPaymentDate("2027-03-01");
      const dates = fetchMock.searchCalls().map((c) => new URL(c.url, "http://localhost").searchParams.get("paymentDate"));
      expect(dates).toEqual([today, "2027-03-01"]);
      // Con la fecha nueva el período ya no es elegible → no se ofrece contado.
      expect(ui.container.textContent).not.toContain("Modalidad de pago");
      expect(ui.container.textContent).toContain("Cuota (opcional)");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("con modalidad contado elegida, si la fecha nueva deja el período sin elegibilidad vuelve a 'cuota'", async () => {
    const today = toArgentinaCalendarDay();
    mockFetch({ searchByDate: { [today]: ELIGIBLE, "2027-03-01": [] } });
    const ui = await renderAndSelectPolicy();
    try {
      await ui.click("Pago de contado del período");
      expect(ui.container.textContent).toContain("Continuar con pago de contado");
      // El campo de fecha sigue visible en contado (es el del bloque de contado).
      await ui.setPaymentDate("2027-03-01");
      expect(ui.container.textContent).not.toContain("Continuar con pago de contado");
      expect(ui.container.textContent).toContain("Cuota (opcional)");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("una respuesta vieja no pisa la de la fecha actual; mientras la actual está en curso, Continuar queda bloqueado", async () => {
    const today = toArgentinaCalendarDay();
    const fetchMock = mockFetch({
      searchByDate: { [today]: ELIGIBLE, "2027-03-02": [] },
      deferredDates: ["2027-03-01", "2027-03-03"],
    });
    const ui = await renderAndSelectPolicy();
    try {
      await ui.click("Pago de contado del período");
      // Fecha A (lenta) y enseguida fecha B (rápida, sin contado elegible).
      await ui.setPaymentDate("2027-03-01");
      expect(buttonByText(ui.container, "Continuar con pago de contado")!.disabled).toBe(true);
      await ui.setPaymentDate("2027-03-02");
      expect(ui.container.textContent).not.toContain("Modalidad de pago");
      // Llega tarde la respuesta de A (elegible): no debe revivir el contado.
      await ui.act(async () => { fetchMock.resolveDeferred("2027-03-01", ELIGIBLE); await flush(); });
      expect(ui.container.textContent).not.toContain("Modalidad de pago");
      expect(ui.container.textContent).toContain("Cuota (opcional)");

      // Fecha C (lenta, elegible): mientras está en curso no hay contado
      // ofrecido con datos viejos; al llegar, vuelve a ofrecerse.
      await ui.setPaymentDate("2027-03-03");
      expect(ui.container.textContent).not.toContain("Modalidad de pago");
      await ui.act(async () => { fetchMock.resolveDeferred("2027-03-03", ELIGIBLE); await flush(); });
      expect(ui.container.textContent).toContain("Modalidad de pago");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("el POST de contado sale con exactamente la misma fecha con la que se evaluó el período", async () => {
    const today = toArgentinaCalendarDay();
    const fetchMock = mockFetch({ searchByDate: { [today]: ELIGIBLE, "2027-03-05": ELIGIBLE } });
    const ui = await renderAndSelectPolicy();
    try {
      await ui.setPaymentDate("2027-03-05");
      await ui.click("Pago de contado del período");
      const continuar = buttonByText(ui.container, "Continuar con pago de contado")!;
      expect(continuar.disabled).toBe(false);
      await ui.click("Continuar con pago de contado");
      // El sub-modal muestra la fecha fija (no editable).
      expect(ui.container.textContent).toContain("05/03/2027");
      expect(ui.container.querySelector('input[type="date"]')).toBeNull();
      await ui.click("Continuar");
      await ui.click("Confirmar cobro");

      const searches = fetchMock.searchCalls();
      const lastSearch = searches[searches.length - 1]!;
      const searchedDate = new URL(lastSearch.url, "http://localhost").searchParams.get("paymentDate");
      const post = fetchMock.calls.find((c) => c.url === "/api/payment-batches/cash-period-payment" && c.method === "POST");
      expect(post).toBeTruthy();
      expect(searchedDate).toBe("2027-03-05");
      expect(post!.body.paymentDate).toBe(searchedDate);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
