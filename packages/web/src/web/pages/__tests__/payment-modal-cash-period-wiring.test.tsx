// Regresión de PRESENTACIÓN (no solo funciones puras) para el bug QA de
// 2026-08-13: "al elegir una póliza con contado elegible en Imputar pago ->
// Vincular a póliza, no aparece 'Modalidad de pago'". El diagnóstico en
// runtime real (CDP contra un `bun run dev` recién levantado) mostró que el
// wiring YA es correcto (resolveCashPeriodModalityAvailability +
// GET /policies/cash-period-search + JSX de cobranzas.tsx) — lo que faltaba
// era una prueba que monte el componente REAL con jsdom y verifique el DOM
// resultante, en vez de solo las funciones puras de cash-period-payment-form.ts
// (que ya estaban cubiertas y nunca hubieran detectado un bug de wiring).
//
// Monta <PaymentModal> con react-dom/client sobre un DOM jsdom aislado
// (creado en este archivo, no global) y un `fetch` mockeado que responde a
// los 3 endpoints reales que dispara el flujo: GET /policies,
// GET /policies/:id/installments, GET /policies/cash-period-search.
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/payment-modal-cash-period-wiring.test.tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";

const POLICY_ID = 57508;
const POLICY_NUMBER = "QA-CONTADO-A-VIGENTE";

const POLICIES_RESPONSE = [
  {
    policy: { id: POLICY_ID, policyNumber: POLICY_NUMBER, companyId: 4 },
    insured: { id: 3585, name: "QA Contado Visual" },
  },
];

const INSTALLMENTS_RESPONSE = [1, 2, 3, 4].map((n) => ({
  id: 75428 + n,
  policyId: POLICY_ID,
  number: n,
  dueDate: `2026-0${8 + n - 1}-13`,
  amount: 100000,
  status: "pendiente",
  rendered: 0,
}));

const ELIGIBLE_CASH_PERIOD_SEARCH_RESPONSE = [
  {
    policyId: POLICY_ID, policyNumber: POLICY_NUMBER,
    insuredId: 3585, insuredName: "QA Contado Visual",
    companyId: 4, companyName: "Cooperación",
    rebillingId: null,
    cashPaymentAmountCents: 38000000,
    nominalAmountCents: 40000000,
    discountAmountCents: 2000000,
    installmentCount: 4,
    periodStartDate: "2026-08-13",
    deadline: "2026-09-12",
    deadlineStatus: "vigente",
    eligible: true,
    ineligibleReasons: [],
  },
];

let dom: JSDOM;
let originalGlobals: Record<string, any> = {};

function installJsdomGlobals() {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
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

function mockFetch(cashPeriodSearchResponse: any[]) {
  (globalThis as any).fetch = async (input: any, _init?: any) => {
    const url = String(input);
    const jsonResponse = (body: any) => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
    if (url.startsWith("/api/policies/cash-period-search")) {
      return jsonResponse(cashPeriodSearchResponse) as any;
    }
    if (/\/api\/policies\/\d+\/installments/.test(url)) {
      return jsonResponse(INSTALLMENTS_RESPONSE) as any;
    }
    if (url === "/api/policies") {
      return jsonResponse(POLICIES_RESPONSE) as any;
    }
    throw new Error(`Unmocked fetch in test: ${url}`);
  };
}

async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function renderAndSelectPolicy() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const React = await import("react");
  const { PaymentModal } = await import("../cobranzas");

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container as any);

  await act(async () => {
    root.render(
      React.createElement(PaymentModal, {
        open: true,
        onClose: () => {},
        onSaved: () => {},
        editing: null,
      })
    );
    await flush();
  });

  // Abrir el selector de póliza y elegir QA-CONTADO-A-VIGENTE — mismos pasos
  // que un usuario real en "Vincular a póliza" (Regla: probar el flujo real,
  // no invocar setState directamente).
  const openPolicyBtn = Array.from(container.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Seleccionar póliza...") as HTMLButtonElement;
  expect(openPolicyBtn).toBeTruthy();

  const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;

  await act(async () => {
    openPolicyBtn.click();
    await flush(1);
    const input = container.querySelector('input[placeholder="Buscar..."]') as HTMLInputElement;
    nativeSetter.call(input, POLICY_NUMBER);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await flush(1);
    const policyOptionBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes(POLICY_NUMBER)) as HTMLButtonElement;
    policyOptionBtn.click();
    await flush();
  });

  return { container, root };
}

describe("PaymentModal — wiring visible de Modalidad de pago (Imputar pago -> Vincular a póliza)", () => {
  beforeAll(() => {
    installJsdomGlobals();
  });

  afterAll(() => {
    restoreGlobals();
  });

  test("con un período de contado elegible, 'Modalidad de pago' se renderiza ANTES de 'Cuota (opcional)'", async () => {
    mockFetch(ELIGIBLE_CASH_PERIOD_SEARCH_RESPONSE);
    const { container, root } = await renderAndSelectPolicy();
    try {
      const text = container.textContent || "";
      const modalidadIdx = text.indexOf("Modalidad de pago");
      const cuotaIdx = text.indexOf("Cuota (opcional)");

      expect(modalidadIdx).toBeGreaterThan(-1);
      expect(cuotaIdx).toBeGreaterThan(-1);
      expect(modalidadIdx).toBeLessThan(cuotaIdx);

      expect(text).toContain("Pago de cuota");
      expect(text).toContain("Pago de contado del período");
      expect(text).toContain("380.000");
    } finally {
      const { act } = await import("react");
      await act(async () => { root.unmount(); });
    }
  });

  test("sin períodos elegibles (cash-period-search vacío), 'Modalidad de pago' NO se renderiza pero 'Cuota (opcional)' sí", async () => {
    mockFetch([]);
    const { container, root } = await renderAndSelectPolicy();
    try {
      const text = container.textContent || "";
      expect(text).not.toContain("Modalidad de pago");
      expect(text).toContain("Cuota (opcional)");
    } finally {
      const { act } = await import("react");
      await act(async () => { root.unmount(); });
    }
  });
});
