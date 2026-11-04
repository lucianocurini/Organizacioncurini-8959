// "Cobrar en lote" — cobro manual con póliza ("Vincular a una póliza
// existente"): el selector ofrece SOLO pólizas en posición cobrable
// (GET /api/policies/collectable-for-payment) y el modal de confirmación
// revalida cada cobro manual con póliza con la fecha elegida (desvinculación
// = queda marcado "no disponible" y Confirmar bloqueado). Fail closed ante
// error de red o respuesta inválida, en el selector y en la confirmación.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { toArgentinaCalendarDay } from "../../../../lib/dates/argentina-date";
import type { BatchCartItem } from "@/lib/payment-batch-form";

const SELECTOR = "/api/policies/collectable-for-payment";
const OTHER_DATE = "2027-01-10";

function policyRow(id: number, number: string, o: Record<string, any> = {}) {
  return {
    policy: { id, policyNumber: number, status: "activa", type: "automotor", insuredId: 100, companyId: 200, parentPolicyId: null, startDate: null, endDate: null, ...o.policy },
    insured: { id: 100, name: "Juan Pérez" }, company: { id: 200, name: "Compañía A" },
    collectable: true, via: "poliza_vigente", reason: null, hasCollectableInstallments: true, accessory: null, ...o.row,
  };
}
const ROW_VIGENTE = policyRow(10, "POL-VIG");
const ROW_SIN_CUOTAS = policyRow(11, "POL-SIN", { row: { hasCollectableInstallments: false, via: "ultima_terminada" } });
const ROW_ACC = policyRow(12, "POL-ACC", { policy: { parentPolicyId: 10, type: "accidentes_pasajeros" }, row: { accessory: { parentPolicyId: 10, parentPolicyNumber: "POL-VIG", linkValid: true } } });

function manualItem(policyId: number, localId: string): BatchCartItem {
  return {
    kind: "policy_manual_payment", localId, policyId, policyNumber: `POL-${policyId}`, policyType: "", parentPolicyId: null, parentPolicyNumber: null,
    insuredId: 100, insuredName: "Juan Pérez", companyId: 200, companyName: "Compañía A", amount: 500, description: "",
  } as BatchCartItem;
}

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

type Reply = { kind: "ok"; rows: any[] } | { kind: "network_error" } | { kind: "invalid" };
/** Selector por fecha: cada llamada consume la próxima respuesta (la última se repite). */
function mockFetch(replies: Record<string, Reply[]>) {
  const calls: string[] = [];
  (globalThis as any).fetch = async (input: any) => {
    const url = String(input);
    calls.push(url);
    const json = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;
    if (url.startsWith(SELECTOR)) {
      const date = new URL(url, "http://localhost").searchParams.get("paymentDate") ?? "";
      const queue = replies[date] ?? [{ kind: "ok", rows: [] }];
      const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (reply.kind === "network_error") throw new TypeError("Failed to fetch");
      if (reply.kind === "invalid") return json({ unexpected: true });
      return json(reply.rows);
    }
    if (url.startsWith("/api/installments/pending-for-payment")) return json([]);
    if (url.startsWith("/api/payment-batches?limit=")) return json([]);
    throw new Error(`Unmocked fetch in test: ${url}`);
  };
  return {
    selectorCalls: () => calls.filter((u) => u.startsWith(SELECTOR)),
    legacyPoliciesCalls: () => calls.filter((u) => u === "/api/policies" || u.startsWith("/api/policies?")),
  };
}

async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
const MODULE_LOAD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

async function mount(element: (React: any, mod: any) => any) {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const mod = await import("../PendingInstallmentsBatchTab");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  await act(async () => { root.render(element(React, mod)); await flush(); });
  const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  const byText = (t: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(t)) as HTMLButtonElement | undefined;
  return {
    container, act, byText,
    text: () => container.textContent ?? "",
    async click(el: HTMLElement) { await act(async () => { el.click(); await flush(); }); },
    async setPaymentDate(value: string) {
      await act(async () => {
        const input = container.querySelector('input[type="date"]') as HTMLInputElement;
        nativeSetter.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        await flush();
      });
    },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

describe("Cobrar en lote — cobro manual con póliza por posición cobrable", () => {
  beforeAll(async () => {
    installJsdomGlobals();
    await import("react-dom/client");
    await import("../PendingInstallmentsBatchTab");
  }, MODULE_LOAD_TIMEOUT_MS);
  afterAll(() => { restoreGlobals(); });

  describe("selector 'Vincular a una póliza existente'", () => {
    async function openManualPolicySelector(ui: Awaited<ReturnType<typeof mount>>) {
      await ui.click(ui.byText("Agregar cobro manual")!);
      const checkbox = Array.from(ui.container.querySelectorAll('input[type="checkbox"]'))
        .find((c) => c.parentElement?.textContent?.includes("Vincular a una póliza existente")) as HTMLInputElement;
      await ui.click(checkbox);
      await ui.click(ui.byText("Seleccionar póliza...")!);
    }
    const optionIds = (c: Element) => Array.from(c.querySelectorAll('[data-testid^="manual-policy-option-"]')).map((b) => Number((b as HTMLElement).dataset.testid!.replace("manual-policy-option-", "")));

    test("pide el selector con la fecha de hoy (nunca /api/policies) y lista solo lo devuelto, con accesorias y 'sin cuotas pendientes'", async () => {
      const today = toArgentinaCalendarDay();
      const f = mockFetch({ [today]: [{ kind: "ok", rows: [ROW_ACC, ROW_VIGENTE, ROW_SIN_CUOTAS] }] });
      const ui = await mount((React, mod) => React.createElement(mod.PendingInstallmentsBatchTab));
      try {
        expect(new URL(f.selectorCalls()[0]!, "http://localhost").searchParams.get("paymentDate")).toBe(today);
        expect(f.legacyPoliciesCalls()).toEqual([]);
        await openManualPolicySelector(ui);
        expect(optionIds(ui.container)).toEqual([10, 12, 11]);
        const text = (id: number) => ui.container.querySelector(`[data-testid="manual-policy-option-${id}"]`)!.textContent!;
        expect(text(12)).toContain("Accesoria de POL-VIG");
        expect(text(11)).toContain("sin cuotas pendientes");
        expect(text(11)).toContain("Última terminada");
      } finally {
        await ui.unmount();
      }
    }, TEST_TIMEOUT_MS);

    test("falla de red: ninguna póliza, aviso con Reintentar (sin volver a la lista completa); el reintento recupera", async () => {
      const today = toArgentinaCalendarDay();
      const f = mockFetch({ [today]: [{ kind: "network_error" }, { kind: "ok", rows: [ROW_VIGENTE] }] });
      const ui = await mount((React, mod) => React.createElement(mod.PendingInstallmentsBatchTab));
      try {
        await openManualPolicySelector(ui);
        expect(optionIds(ui.container)).toEqual([]);
        expect(ui.container.querySelector('[data-testid="manual-policy-selector-error"]')).toBeTruthy();
        expect(f.legacyPoliciesCalls()).toEqual([]);
        await ui.click(ui.container.querySelector('[data-testid="manual-policy-selector-error"] button') as HTMLButtonElement);
        expect(ui.container.querySelector('[data-testid="manual-policy-selector-error"]')).toBeNull();
        expect(optionIds(ui.container)).toEqual([10]);
      } finally {
        await ui.unmount();
      }
    }, TEST_TIMEOUT_MS);
  });

  describe("modal de confirmación", () => {
    const confirmButton = (c: Element) => Array.from(c.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Confirmar cobro") as HTMLButtonElement;

    test("cambio de fecha: el cobro cuya póliza sale de posición queda 'no disponible' y bloquea; volver a una fecha válida desbloquea", async () => {
      const today = toArgentinaCalendarDay();
      mockFetch({ [today]: [{ kind: "ok", rows: [ROW_VIGENTE, ROW_SIN_CUOTAS] }], [OTHER_DATE]: [{ kind: "ok", rows: [ROW_SIN_CUOTAS] }] });
      const cart = [manualItem(10, "m1"), manualItem(11, "m2")];
      const ui = await mount((React, mod) => React.createElement(mod.BatchPaymentModal, { cart, onClose: () => {}, onCreated: () => {} }));
      try {
        expect(confirmButton(ui.container).disabled).toBe(false);
        expect(ui.text()).not.toContain("no disponible");
        await ui.setPaymentDate(OTHER_DATE);
        expect(ui.container.querySelector('[data-testid="cart-policy-unavailable"]')!.textContent).toContain("1 cobro manual con póliza no está disponible");
        expect(ui.text()).toContain("no disponible");
        expect(confirmButton(ui.container).disabled).toBe(true);
        await ui.setPaymentDate(today);
        expect(ui.container.querySelector('[data-testid="cart-policy-unavailable"]')).toBeNull();
        expect(confirmButton(ui.container).disabled).toBe(false);
      } finally {
        await ui.unmount();
      }
    }, TEST_TIMEOUT_MS);

    for (const kind of ["network_error", "invalid"] as const) {
      test(`falla cerrada (${kind}): Confirmar bloqueado con aviso; Reintentar recupera`, async () => {
        const today = toArgentinaCalendarDay();
        mockFetch({ [today]: [{ kind }, { kind: "ok", rows: [ROW_VIGENTE] }] });
        const ui = await mount((React, mod) => React.createElement(mod.BatchPaymentModal, { cart: [manualItem(10, "m1")], onClose: () => {}, onCreated: () => {} }));
        try {
          expect(ui.container.querySelector('[data-testid="cart-policy-error"]')).toBeTruthy();
          expect(confirmButton(ui.container).disabled).toBe(true);
          expect(ui.text()).not.toContain("no disponible");
          await ui.click(ui.container.querySelector('[data-testid="cart-policy-error"] button') as HTMLButtonElement);
          expect(ui.container.querySelector('[data-testid="cart-policy-error"]')).toBeNull();
          expect(confirmButton(ui.container).disabled).toBe(false);
        } finally {
          await ui.unmount();
        }
      }, TEST_TIMEOUT_MS);
    }
  });
});
