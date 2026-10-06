// Envíos y Entregas — control "Desplazar tabla" flotante, montado de verdad
// (useDeliveriesTableScrollControl + <DeliveriesTableScrollControl>) con
// react-dom/client sobre jsdom. jsdom no tiene layout: la geometría
// (getBoundingClientRect, clientWidth/scrollWidth), ResizeObserver y
// requestAnimationFrame se simulan y se controlan desde el test.
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/deliveries-floating-scroll-control.test.tsx
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";

let dom: JSDOM;
const originalGlobals: Record<string, any> = {};
const restorers: Array<() => void> = [];

// Geometría mutable que leen los getters simulados.
const geo = {
  slotTop: 400,
  barHeight: 34,
  scroll: { left: 260, width: 900, bottom: 2000 },
  clientWidth: 900,
  scrollWidth: 1400,
};
const roCallbacks = new Set<() => void>();
let frames: Array<() => void> = [];

function installJsdomGlobals() {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/envios" });
  const w = dom.window as any;
  w.requestAnimationFrame = (cb: () => void) => { frames.push(cb); return frames.length; };
  w.cancelAnimationFrame = () => {};
  w.ResizeObserver = class {
    cb: () => void;
    constructor(cb: () => void) { this.cb = cb; }
    observe() { roCallbacks.add(this.cb); }
    disconnect() { roCallbacks.delete(this.cb); }
  };
  const keys = ["window", "document", "navigator", "localStorage", "HTMLInputElement", "HTMLElement", "Event", "MouseEvent", "Node", "customElements", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame"] as const;
  for (const key of keys) {
    originalGlobals[key] = (globalThis as any)[key];
    (globalThis as any)[key] = w[key];
  }
  originalGlobals.IS_REACT_ACT_ENVIRONMENT = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  const proto = w.HTMLElement.prototype;
  const define = (name: string, desc: PropertyDescriptor) => {
    const prev = Object.getOwnPropertyDescriptor(proto, name) ?? Object.getOwnPropertyDescriptor(w.Element.prototype, name);
    Object.defineProperty(proto, name, { configurable: true, ...desc });
    restorers.push(() => { if (prev) Object.defineProperty(proto, name, prev); else delete proto[name]; });
  };
  define("getBoundingClientRect", {
    value(this: HTMLElement) {
      const id = this.getAttribute("data-testid");
      if (id === "deliveries-table-scroll-slot") return rect(geo.slotTop, 0, 0, geo.barHeight);
      if (id === "deliveries-table-scroll-control") return rect(0, 0, 0, geo.barHeight);
      if (id === "fake-table-scroll") return { top: geo.scroll.bottom - 600, left: geo.scroll.left, width: geo.scroll.width, height: 600, bottom: geo.scroll.bottom, right: geo.scroll.left + geo.scroll.width, x: geo.scroll.left, y: 0 };
      return rect(0, 0, 0, 0);
    },
  });
  define("clientWidth", { get(this: HTMLElement) { return this.getAttribute("data-testid") === "fake-table-scroll" ? geo.clientWidth : 0; } });
  define("scrollWidth", { get(this: HTMLElement) { return this.tagName === "TABLE" ? geo.scrollWidth : 0; } });
}
function rect(top: number, left: number, width: number, height: number) {
  return { top, left, width, height, bottom: top + height, right: left + width, x: left, y: top };
}
function restoreGlobals() {
  for (const r of restorers.splice(0)) r();
  for (const key of Object.keys(originalGlobals)) {
    if (originalGlobals[key] === undefined) delete (globalThis as any)[key];
    else (globalThis as any)[key] = originalGlobals[key];
  }
  dom.window.close();
}

const MODULE_LOAD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

async function renderHarness() {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { useDeliveriesTableScrollControl, DeliveriesTableScrollControl } = await import("../envios");
  function Harness() {
    const control = useDeliveriesTableScrollControl();
    return React.createElement("div", null,
      React.createElement(DeliveriesTableScrollControl, { control }),
      React.createElement("div", { ref: control.tableScrollRef, "data-testid": "fake-table-scroll" },
        React.createElement("table", { ref: control.tableRef })),
    );
  }
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  await act(async () => { root.render(React.createElement(Harness)); });
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  async function scrollPage() {
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("scroll"));
      const cbs = frames; frames = [];
      for (const cb of cbs) cb();
    });
  }
  async function resizeObserved() {
    await act(async () => {
      for (const cb of [...roCallbacks]) cb();
      const cbs = frames; frames = [];
      for (const cb of cbs) cb();
    });
  }
  async function unmount() { await act(async () => { root.unmount(); }); container.remove(); }
  return {
    container, scrollPage, resizeObserved, unmount, act,
    bar: () => q("deliveries-table-scroll-control"),
    slot: () => q("deliveries-table-scroll-slot"),
    range: () => q("deliveries-table-scroll-range") as HTMLInputElement,
  };
}

describe("Envíos — control 'Desplazar tabla' flotante", () => {
  beforeAll(async () => {
    installJsdomGlobals();
    await import("react-dom/client");
    await import("../envios");
  }, MODULE_LOAD_TIMEOUT_MS);
  afterAll(() => { restoreGlobals(); });
  beforeEach(() => {
    Object.assign(geo, { slotTop: 400, barHeight: 34, clientWidth: 900, scrollWidth: 1400 });
    geo.scroll = { left: 260, width: 900, bottom: 2000 };
    frames = [];
    dom.window.document.documentElement.style.scrollPaddingTop = "";
  });

  test("en línea → flotante → fuera de vista, con el MISMO <input> y sin perder el foco", async () => {
    const ui = await renderHarness();
    try {
      expect(ui.bar().getAttribute("data-mode")).toBe("inline");
      expect(ui.bar().className).not.toMatch(/\bfixed\b/);
      expect(ui.slot().style.height).toBe("");
      const input = ui.range();
      input.focus();
      expect(dom.window.document.activeElement).toBe(input);

      geo.slotTop = -120; geo.scroll.bottom = 1500;
      await ui.scrollPage();
      expect(ui.bar().getAttribute("data-mode")).toBe("floating");
      expect(ui.bar().className).toMatch(/\bfixed\b/);
      expect(ui.bar().style.top).toBe("0px");
      expect(ui.bar().style.left).toBe("260px");
      expect(ui.bar().style.width).toBe("900px");
      // El slot conserva el alto: el contenido no salta.
      expect(ui.slot().style.height).toBe("34px");
      expect(ui.range()).toBe(input);
      expect(dom.window.document.activeElement).toBe(input);
      expect(ui.container.querySelectorAll('input[type="range"]').length).toBe(1);

      geo.slotTop = -2200; geo.scroll.bottom = 20;
      await ui.scrollPage();
      expect(ui.bar().getAttribute("data-mode")).toBe("out_of_view");
      expect(ui.bar().className).not.toMatch(/\bfixed\b/);
      expect(ui.bar().style.cssText).toBe("");
      expect(ui.slot().style.height).toBe("");
      expect(ui.range()).toBe(input);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("sin desborde horizontal no se muestra, ni siquiera habiendo bajado", async () => {
    geo.scrollWidth = 900; // = clientWidth
    const ui = await renderHarness();
    try {
      expect(ui.bar().className).toContain("hidden");
      geo.slotTop = -120;
      await ui.scrollPage();
      expect(ui.bar().getAttribute("data-mode")).toBe("hidden");
      expect(ui.bar().className).toContain("hidden");
      expect(ui.bar().className).not.toMatch(/\bfixed\b/);
      expect(ui.slot().style.height).toBe("");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("si el desborde desaparece mientras flota (filtros, ventana más ancha), deja de flotar", async () => {
    const ui = await renderHarness();
    try {
      geo.slotTop = -120;
      await ui.scrollPage();
      expect(ui.bar().getAttribute("data-mode")).toBe("floating");
      geo.scrollWidth = 800;
      await ui.resizeObserved();
      expect(ui.bar().getAttribute("data-mode")).toBe("hidden");
      expect(ui.bar().className).toContain("hidden");
      expect(ui.bar().className).not.toMatch(/\bfixed\b/);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("se realinea al contenedor real cuando cambia su posición/ancho (menú colapsado, zoom)", async () => {
    const ui = await renderHarness();
    try {
      geo.slotTop = -120;
      await ui.scrollPage();
      geo.scroll = { left: 96, width: 1064, bottom: 1500 };
      geo.clientWidth = 1064;
      await ui.resizeObserved();
      expect(ui.bar().style.left).toBe("96px");
      expect(ui.bar().style.width).toBe("1064px");
      // Zoom: medidas fraccionarias, redondeadas.
      geo.scroll = { left: 207.6, width: 851.2, bottom: 1500 };
      await ui.resizeObserved();
      expect(ui.bar().style.left).toBe("208px");
      expect(ui.bar().style.width).toBe("851px");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("mientras flota reserva scroll-padding-top (el foco por teclado no queda debajo); lo restaura al dejar de flotar y al desmontar", async () => {
    const root = dom.window.document.documentElement;
    const ui = await renderHarness();
    try {
      expect(root.style.scrollPaddingTop).toBe("");
      geo.slotTop = -120;
      await ui.scrollPage();
      expect(root.style.scrollPaddingTop).toBe("34px");
      geo.slotTop = 100;
      await ui.scrollPage();
      expect(root.style.scrollPaddingTop).toBe("");
      geo.slotTop = -120;
      await ui.scrollPage();
      expect(root.style.scrollPaddingTop).toBe("34px");
    } finally {
      await ui.unmount();
    }
    expect(root.style.scrollPaddingTop).toBe("");
  }, TEST_TIMEOUT_MS);

  test("al desmontar no quedan observers ni listeners de scroll activos", async () => {
    const ui = await renderHarness();
    expect(roCallbacks.size).toBeGreaterThan(0);
    await ui.unmount();
    expect(roCallbacks.size).toBe(0);
    // Un scroll posterior no programa frames (listener removido).
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    expect(frames.length).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("la barra sigue sincronizada con la tabla en ambos sentidos mientras flota", async () => {
    const ui = await renderHarness();
    try {
      geo.slotTop = -120;
      await ui.scrollPage();
      const scrollEl = ui.container.querySelector('[data-testid="fake-table-scroll"]') as HTMLElement;
      const input = ui.range();
      input.value = "300";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      expect(scrollEl.scrollLeft).toBe(300);
      scrollEl.scrollLeft = 120;
      scrollEl.dispatchEvent(new dom.window.Event("scroll"));
      expect(input.value).toBe("120");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
