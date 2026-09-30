// "Cobrar en lote" — revalidación del carrito con la fecha de pago elegida
// (regla única de cobrabilidad). Presentación real: <BatchPaymentModal>
// montado con react-dom/client sobre un jsdom aislado y `fetch` mockeado
// (mismo arnés que pages/__tests__/payment-modal-cash-period-wiring.test.tsx).
//
// Cubre: fail closed ante error de red o respuesta inválida (Confirmar
// bloqueado + aviso), rehabilitación tras un reintento exitoso, una respuesta
// vieja que no pisa la fecha actual, y que agregar o quitar ítems del carrito
// NO vuelve a descargar la lista (se evalúa contra el último resultado).
// Ejecutar con: bun test packages/web/src/web/components/payments/__tests__/batch-payment-modal-collectability.test.tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { toArgentinaCalendarDay } from "../../../../lib/dates/argentina-date";
import type { BatchCartItem } from "@/lib/payment-batch-form";

const ERROR_MESSAGE = "No se pudieron validar las cuotas para esta fecha. Reintentá antes de confirmar.";

function installment(id: number, overrides: Partial<Extract<BatchCartItem, { kind: "installment" }>> = {}): BatchCartItem {
  return {
    kind: "installment", installmentId: id, policyId: 10, policyNumber: `POL-${id}`,
    policyType: "automotor", parentPolicyId: null, parentPolicyNumber: null,
    insuredId: 100, insuredName: "Juan Pérez", companyId: 200, companyName: "Compañía A",
    installmentNumber: 1, dueDate: "2026-10-01", amount: 1000, status: "pendiente",
    ...overrides,
  };
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

type Reply = { kind: "ok"; ids: number[] } | { kind: "network_error" } | { kind: "invalid" } | { kind: "deferred" };

/**
 * fetch mockeado para GET /installments/pending-for-payment?paymentDate=:
 * cada llamada consume la próxima respuesta de `replies[fecha]` (la última se
 * repite). "deferred" queda pendiente hasta resolveDeferred(fecha, ids).
 */
function mockFetch(replies: Record<string, Reply[]>) {
  const calls: string[] = [];
  const deferred = new Map<string, (ids: number[]) => void>();
  (globalThis as any).fetch = async (input: any) => {
    const url = String(input);
    calls.push(url);
    const json = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;
    if (url.startsWith("/api/installments/pending-for-payment")) {
      const date = new URL(url, "http://localhost").searchParams.get("paymentDate") ?? "";
      const queue = replies[date] ?? [{ kind: "ok", ids: [] }];
      const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
      const rows = (ids: number[]) => ids.map((installmentId) => ({ installmentId }));
      if (reply.kind === "network_error") throw new TypeError("Failed to fetch");
      if (reply.kind === "invalid") return json({ unexpected: true });
      if (reply.kind === "deferred") return new Promise((resolve) => deferred.set(date, (ids) => resolve(json(rows(ids)))));
      return json(rows(reply.ids));
    }
    throw new Error(`Unmocked fetch in test: ${url}`);
  };
  return {
    pendingCalls: () => calls.filter((u) => u.startsWith("/api/installments/pending-for-payment")),
    resolveDeferred: (date: string, ids: number[]) => deferred.get(date)!(ids),
  };
}

async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

// Import en frío del componente (grafo grande): una sola vez en beforeAll con
// timeout amplio, no dentro del primer test (timeout 5 s).
const MODULE_LOAD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

async function renderModal(initialCart: BatchCartItem[]) {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { BatchPaymentModal } = await import("../PendingInstallmentsBatchTab");
  // Contenedor nuevo por test: un fallo nunca arrastra al siguiente.
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  const render = async (cart: BatchCartItem[]) => {
    await act(async () => {
      root.render(React.createElement(BatchPaymentModal, { cart, onClose: () => {}, onCreated: () => {} }));
      await flush();
    });
  };
  await render(initialCart);
  const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;

  const confirmButton = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Confirmar cobro") as HTMLButtonElement;
  return {
    container, act,
    rerender: render,
    confirmButton,
    text: () => container.textContent ?? "",
    async setPaymentDate(value: string) {
      await act(async () => {
        const input = container.querySelector('input[type="date"]') as HTMLInputElement;
        nativeSetter.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        await flush();
      });
    },
    async clickRetry() {
      await act(async () => {
        (Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Reintentar") as HTMLButtonElement).click();
        await flush();
      });
    },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

describe("BatchPaymentModal — revalidación del carrito por fecha de pago", () => {
  beforeAll(async () => {
    installJsdomGlobals();
    await import("react-dom/client");
    await import("../PendingInstallmentsBatchTab");
  }, MODULE_LOAD_TIMEOUT_MS);
  afterAll(() => { restoreGlobals(); });

  test("control: cuotas cobrables en la fecha → Confirmar habilitado, sin aviso", async () => {
    const today = toArgentinaCalendarDay();
    mockFetch({ [today]: [{ kind: "ok", ids: [1] }] });
    const ui = await renderModal([installment(1)]);
    try {
      expect(ui.confirmButton().disabled).toBe(false);
      expect(ui.text()).not.toContain(ERROR_MESSAGE);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("error de red bloquea Confirmar con aviso claro; un reintento exitoso lo vuelve a habilitar", async () => {
    const today = toArgentinaCalendarDay();
    const fetchMock = mockFetch({ [today]: [{ kind: "network_error" }, { kind: "ok", ids: [1] }] });
    const ui = await renderModal([installment(1)]);
    try {
      expect(ui.text()).toContain(ERROR_MESSAGE);
      expect(ui.confirmButton().disabled).toBe(true);
      // Nunca se interpreta el error como "todas disponibles".
      expect(ui.text()).not.toContain("no disponible");

      await ui.clickRetry();
      expect(fetchMock.pendingCalls().length).toBe(2);
      expect(ui.text()).not.toContain(ERROR_MESSAGE);
      expect(ui.confirmButton().disabled).toBe(false);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("respuesta inválida (no es la lista esperada) también bloquea; cambiar a una fecha que valida bien lo habilita", async () => {
    const today = toArgentinaCalendarDay();
    mockFetch({ [today]: [{ kind: "invalid" }], "2027-01-10": [{ kind: "ok", ids: [1] }] });
    const ui = await renderModal([installment(1)]);
    try {
      expect(ui.text()).toContain(ERROR_MESSAGE);
      expect(ui.confirmButton().disabled).toBe(true);
      await ui.setPaymentDate("2027-01-10");
      expect(ui.text()).not.toContain(ERROR_MESSAGE);
      expect(ui.confirmButton().disabled).toBe(false);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("una respuesta vieja (fecha anterior) no pisa el estado de la fecha actual", async () => {
    const today = toArgentinaCalendarDay();
    const fetchMock = mockFetch({
      [today]: [{ kind: "ok", ids: [1] }],
      "2027-01-10": [{ kind: "deferred" }],
      "2027-01-11": [{ kind: "deferred" }],
    });
    const ui = await renderModal([installment(1)]);
    try {
      await ui.setPaymentDate("2027-01-10");
      // Consulta de la fecha actual en curso → bloqueado.
      expect(ui.confirmButton().disabled).toBe(true);
      await ui.setPaymentDate("2027-01-11");
      // La fecha actual (11) valida: la cuota está disponible.
      await ui.act(async () => { fetchMock.resolveDeferred("2027-01-11", [1]); await flush(); });
      expect(ui.confirmButton().disabled).toBe(false);
      // Llega tarde la del 10, donde la cuota NO estaba disponible: se ignora.
      await ui.act(async () => { fetchMock.resolveDeferred("2027-01-10", []); await flush(); });
      expect(ui.confirmButton().disabled).toBe(false);
      expect(ui.text()).not.toContain("no disponible");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("agregar o quitar cuotas no dispara otra descarga: se evalúa contra el último resultado de la fecha", async () => {
    const today = toArgentinaCalendarDay();
    const fetchMock = mockFetch({ [today]: [{ kind: "ok", ids: [1] }] });
    const ui = await renderModal([installment(1)]);
    try {
      expect(fetchMock.pendingCalls().length).toBe(1);
      expect(ui.text()).not.toContain("no disponible");

      // Agregar una cuota que NO está en el último resultado → marcada.
      await ui.rerender([installment(1), installment(2, { policyNumber: "POL-2" })]);
      expect(fetchMock.pendingCalls().length).toBe(1);
      expect(ui.text()).toContain("no disponible");
      expect(ui.text()).toContain("1 cuota del carrito no está disponible");
      expect(ui.confirmButton().disabled).toBe(true);

      // Quitarla → vuelve a estar todo disponible, sin otra descarga.
      await ui.rerender([installment(1)]);
      expect(fetchMock.pendingCalls().length).toBe(1);
      expect(ui.text()).not.toContain("no disponible");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
