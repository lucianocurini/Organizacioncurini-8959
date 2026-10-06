// Menú lateral colapsable (solo escritorio): <Sidebar> real montado con
// react-dom/client sobre jsdom, dentro de <AuthProvider> (fetch simulado
// para /api/auth/me) y con un store de preferencia propio (memoria).
//
// jsdom no evalúa media queries, así que el aislamiento de mobile se prueba
// por contrato de clases: todo lo que cambia al colapsar va con prefijo lg:
// (o en elementos que por debajo de lg están ocultos), y las clases base del
// drawer no cambian.
// Ejecutar con: bun test packages/web/src/web/components/layout/__tests__/sidebar-collapse.test.tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";

let dom: JSDOM;
const originalGlobals: Record<string, any> = {};

function installJsdomGlobals(url: string) {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url });
  const w = dom.window as any;
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const keys = ["window", "document", "navigator", "localStorage", "HTMLInputElement", "HTMLElement", "Event", "MouseEvent", "FocusEvent", "KeyboardEvent", "Node", "customElements", "ResizeObserver", "DOMRect", "location", "history", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "Element", "SVGElement", "ShadowRoot", "DocumentFragment"] as const;
  for (const key of keys) {
    originalGlobals[key] = (globalThis as any)[key];
    (globalThis as any)[key] = w[key];
  }
  // wouter escucha/dispara pushState/popstate con addEventListener/
  // dispatchEvent globales: tienen que ser los de la ventana de jsdom.
  for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"] as const) {
    originalGlobals[key] = (globalThis as any)[key];
    (globalThis as any)[key] = w[key].bind(w);
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

function setUser(user: { name: string; role: string } | null) {
  if (user) dom.window.localStorage.setItem("session_id", "test-session");
  else dom.window.localStorage.removeItem("session_id");
  (globalThis as any).fetch = async (url: string) => {
    if (String(url).endsWith("/api/auth/me")) {
      return new Response(JSON.stringify({ user: { id: 1, email: "qa@example.test", ...user } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unmocked fetch in test: ${url}`);
  };
}
function navigateTo(path: string) {
  dom.window.history.pushState(null, "", path);
}

const MODULE_LOAD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

async function renderSidebar(opts: { stored?: string | null; mobileOpen?: boolean } = {}) {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { Sidebar } = await import("../Sidebar");
  const { AuthProvider } = await import("../../../lib/auth");
  const { createSidebarPreferenceStore, SIDEBAR_COLLAPSED_STORAGE_KEY } = await import("../../../lib/sidebar-preference");

  const data: Record<string, string> = {};
  if (opts.stored != null) data[SIDEBAR_COLLAPSED_STORAGE_KEY] = opts.stored;
  const storage = { data, getItem: (k: string) => (k in data ? data[k]! : null), setItem: (k: string, v: string) => { data[k] = v; } };
  const storageListeners = new Set<(e: any) => void>();
  const win = {
    addEventListener: (_t: "storage", l: (e: any) => void) => { storageListeners.add(l); },
    removeEventListener: (_t: "storage", l: (e: any) => void) => { storageListeners.delete(l); },
  };
  const store = createSidebarPreferenceStore(() => storage, win);

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  const element = () => React.createElement(AuthProvider, null,
    React.createElement(Sidebar, { preferenceStore: store, mobileOpen: opts.mobileOpen ?? false, onClose: () => {} }));
  // Primer render sin esperar efectos: el estado inicial sale síncrono del store.
  act(() => { root.render(element()); });
  const firstCollapsedAttr = container.querySelector("aside")?.getAttribute("data-collapsed");
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });

  const aside = () => container.querySelector("aside") as HTMLElement;
  const toggle = () => container.querySelector('[data-testid="sidebar-collapse-toggle"]') as HTMLButtonElement;
  async function click(el: Element) {
    await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 })); });
  }
  async function storageEvent(key: string | null, newValue: string | null) {
    await act(async () => { for (const l of [...storageListeners]) l({ key, newValue }); });
  }
  async function unmount() { await act(async () => { root.unmount(); }); container.remove(); }
  return { container, aside, toggle, click, storageEvent, unmount, storage, act, firstCollapsedAttr };
}

const logoutButton = (container: Element) => container.querySelector('button[aria-label="Cerrar sesión"]') as HTMLButtonElement;
// Ancestros (hasta el <aside> inclusive) con una clase que lo oculte en algún breakpoint.
const hidingClasses = (el: Element) => {
  const found: string[] = [];
  for (let n: Element | null = el; n; n = n.tagName === "ASIDE" ? null : n.parentElement) {
    found.push(...Array.from(n.classList).filter((c) => /^(lg:)?(hidden|sr-only|invisible)$/.test(c)));
  }
  return found;
};

const navLink = (container: Element, label: string) =>
  Array.from(container.querySelectorAll("nav a[href]")).find((a) => a.textContent?.trim() === label) as HTMLAnchorElement | undefined;

describe("Sidebar — colapsar/expandir en escritorio", () => {
  beforeAll(async () => {
    installJsdomGlobals("http://localhost/envios");
    await import("react-dom/client");
    await import("../Sidebar");
  }, MODULE_LOAD_TIMEOUT_MS);
  afterAll(() => { restoreGlobals(); });

  test("estado inicial expandido: botón con aria-expanded=true, aria-controls válido y etiqueta 'Colapsar menú'", async () => {
    setUser({ name: "QA Usuario", role: "user" });
    const ui = await renderSidebar();
    try {
      expect(ui.aside().getAttribute("data-collapsed")).toBe("false");
      const t = ui.toggle();
      expect(t.getAttribute("aria-expanded")).toBe("true");
      expect(t.getAttribute("aria-label")).toBe("Colapsar menú");
      expect(t.getAttribute("type")).toBe("button");
      const controls = t.getAttribute("aria-controls")!;
      expect(dom.window.document.getElementById(controls)).toBe(ui.aside());
      expect(ui.aside().className).not.toContain("lg:w-16");
      // Sin tooltips en los enlaces ni en el usuario en modo expandido (el
      // botón sí lo tiene, en lugar de un `title` que duplicaría su nombre).
      expect(ui.aside().querySelector("nav [data-state]")).toBeNull();
      expect(logoutButton(ui.aside()).hasAttribute("data-state")).toBe(false);
      expect(t.hasAttribute("title")).toBe(false);
      expect(t.getAttribute("data-state")).toBe("closed");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("colapsar: aria-expanded=false, etiqueta 'Expandir menú', guarda la preferencia y deja solo íconos con nombre accesible", async () => {
    setUser({ name: "QA Usuario", role: "user" });
    const ui = await renderSidebar();
    try {
      await ui.click(ui.toggle());
      expect(ui.toggle().getAttribute("aria-expanded")).toBe("false");
      expect(ui.toggle().getAttribute("aria-label")).toBe("Expandir menú");
      expect(ui.storage.data["organizacion-curini:sidebar-collapsed"]).toBe("1");
      expect(ui.aside().getAttribute("data-collapsed")).toBe("true");
      expect(ui.aside().className).toContain("lg:w-16");
      // Texto oculto solo visualmente en escritorio; el nombre accesible queda.
      const link = navLink(ui.container, "Envíos y Entregas")!;
      expect(link).toBeDefined();
      expect(link.querySelector("span")!.className).toBe("lg:sr-only");
      // Logo, usuario y cerrar sesión siguen ahí y utilizables.
      expect(ui.aside().textContent).toContain("Organización");
      expect(ui.aside().textContent).toContain("QA Usuario");
      const logout = logoutButton(ui.aside());
      expect(logout).not.toBeNull();
      expect(logout.disabled).toBe(false);
      // Expandir de nuevo.
      await ui.click(ui.toggle());
      expect(ui.toggle().getAttribute("aria-expanded")).toBe("true");
      expect(ui.storage.data["organizacion-curini:sidebar-collapsed"]).toBe("0");
      // El enlace se re-renderiza (con/sin tooltip): se vuelve a buscar.
      expect(navLink(ui.container, "Envíos y Entregas")!.querySelector("span")!.className).toBe("");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("preferencia guardada colapsada: arranca colapsado desde el PRIMER render (sin parpadeo)", async () => {
    setUser(null);
    const ui = await renderSidebar({ stored: "1" });
    try {
      expect(ui.firstCollapsedAttr).toBe("true");
      expect(ui.toggle().getAttribute("aria-expanded")).toBe("false");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("valor guardado inválido → expandido", async () => {
    setUser(null);
    const ui = await renderSidebar({ stored: "colapsado" });
    try {
      expect(ui.firstCollapsedAttr).toBe("false");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("cambio en otra pestaña (evento storage) se refleja en esta", async () => {
    setUser(null);
    const ui = await renderSidebar();
    try {
      await ui.storageEvent("organizacion-curini:sidebar-collapsed", "1");
      expect(ui.aside().getAttribute("data-collapsed")).toBe("true");
      expect(ui.toggle().getAttribute("aria-expanded")).toBe("false");
      await ui.storageEvent("organizacion-curini:sidebar-collapsed", "0");
      expect(ui.aside().getAttribute("data-collapsed")).toBe("false");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("colapsado: tooltip con el nombre al enfocar con teclado, oculto por debajo de lg", async () => {
    setUser({ name: "QA Usuario", role: "user" });
    const ui = await renderSidebar({ stored: "1" });
    try {
      const link = navLink(ui.container, "Cobranzas y Rendiciones")!;
      await ui.act(async () => { link.focus(); });
      const tip = dom.window.document.querySelector('[data-testid="sidebar-tooltip"]') as HTMLElement | null;
      expect(tip).not.toBeNull();
      expect(tip!.textContent).toContain("Cobranzas y Rendiciones");
      expect(tip!.className).toContain("hidden");
      expect(tip!.className).toContain("lg:block");
      // El tooltip repite el nombre: no se enlaza como descripción accesible.
      expect(link.getAttribute("data-state")).not.toBe("closed");
      expect(link.hasAttribute("aria-describedby")).toBe(false);
      await ui.act(async () => { link.blur(); });
      // Ídem en el botón de colapsar (tooltip en lugar de `title`); el foco
      // se conserva al alternar porque el botón no se remonta.
      const t = ui.toggle();
      await ui.act(async () => { t.focus(); });
      expect(dom.window.document.querySelector('[data-testid="sidebar-tooltip"]')!.textContent).toContain("Expandir menú");
      expect(t.hasAttribute("aria-describedby")).toBe(false);
      await ui.click(t);
      expect(ui.toggle()).toBe(t);
      expect(dom.window.document.activeElement).toBe(t);
      expect(t.getAttribute("aria-label")).toBe("Colapsar menú");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("Cerrar sesión: un solo nombre accesible, sin `title` (un único tooltip) y tooltip nuevo al enfocar colapsado", async () => {
    setUser({ name: "QA Usuario", role: "user" });
    const ui = await renderSidebar({ stored: "1" });
    try {
      const matches = Array.from(ui.aside().querySelectorAll("button")).filter((b) => b.getAttribute("aria-label") === "Cerrar sesión" || b.getAttribute("title") === "Cerrar sesión");
      expect(matches.length).toBe(1);
      const logout = matches[0]!;
      // Nombre: solo aria-label (el ícono es SVG sin texto); sin title que
      // agregue un tooltip nativo ni aria-labelledby que compita.
      expect(logout.getAttribute("aria-label")).toBe("Cerrar sesión");
      expect(logout.hasAttribute("title")).toBe(false);
      expect(logout.hasAttribute("aria-labelledby")).toBe(false);
      expect(logout.textContent!.trim()).toBe("");
      await ui.act(async () => { logout.focus(); });
      const tips = Array.from(dom.window.document.querySelectorAll('[data-testid="sidebar-tooltip"]'));
      expect(tips.length).toBe(1);
      expect(tips[0]!.textContent).toContain("Cerrar sesión");
      expect(logout.hasAttribute("aria-describedby")).toBe(false);
      await ui.act(async () => { logout.blur(); });
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  for (const mode of ["escritorio expandido", "drawer mobile abierto"] as const) {
    test(`Cerrar sesión visible y utilizable en ${mode}: sin tooltip, sin clases que lo oculten, cierra la sesión`, async () => {
      setUser({ name: "QA Usuario", role: "user" });
      const ui = await renderSidebar(mode === "escritorio expandido" ? { stored: "0" } : { stored: "1", mobileOpen: true });
      try {
        const logout = logoutButton(ui.aside());
        expect(logout).not.toBeNull();
        expect(logout.disabled).toBe(false);
        expect(logout.hasAttribute("title")).toBe(false);
        // En mobile el drawer nunca aplica el colapsado (solo clases lg:); en
        // escritorio expandido no hay tooltip.
        expect(hidingClasses(logout)).toEqual([]);
        if (mode === "escritorio expandido") expect(logout.hasAttribute("data-state")).toBe(false);
        // El texto visible del usuario sigue al lado (no lg:sr-only en expandido).
        expect(ui.aside().textContent).toContain("QA Usuario");
        await ui.click(logout);
        await ui.act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); });
        expect(dom.window.localStorage.getItem("session_id")).toBeNull();
        expect(ui.aside().textContent).not.toContain("QA Usuario");
      } finally {
        await ui.unmount();
      }
    }, TEST_TIMEOUT_MS);
  }

  test("aria-current='page' solo en la ruta activa; rutas y enlaces históricos sin cambios", async () => {
    setUser({ name: "QA Usuario", role: "user" });
    navigateTo("/envios");
    const ui = await renderSidebar();
    try {
      const current = Array.from(ui.container.querySelectorAll('[aria-current="page"]'));
      expect(current.length).toBe(1);
      expect(current[0]!.getAttribute("href")).toBe("/envios");
      const hrefs = Array.from(ui.container.querySelectorAll("nav a[href]")).map((a) => a.getAttribute("href"));
      expect(hrefs).toEqual([
        "/", "/polizas", "/companias", "/asegurados", "/cobranzas", "/envios", "/siniestros", "/tareas", "/reporte-mes",
        "/polizas?type=automotor", "/polizas?type=motovehiculo", "/polizas?type=hogar", "/polizas?type=accidentes",
        "/polizas?type=art", "/polizas?type=ecomovilidad", "/polizas?type=comercial", "/polizas?type=responsabilidad_civil",
        "/polizas?type=cascos", "/polizas?type=incendio",
      ]);
      // Resaltado activo histórico: misma clase en la ruta activa.
      expect(navLink(ui.container, "Envíos y Entregas")!.querySelector("a")!.className).toContain("bg-blue-600/20");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("Admin: sección solo para rol admin, con aria-current en su ruta activa", async () => {
    setUser({ name: "QA Admin", role: "admin" });
    navigateTo("/caja");
    const ui = await renderSidebar();
    try {
      expect(ui.aside().textContent).toContain("Admin");
      const caja = navLink(ui.container, "Caja")!;
      expect(caja.getAttribute("aria-current")).toBe("page");
      expect(navLink(ui.container, "Importar pólizas")).toBeDefined();
      expect(navLink(ui.container, "Usuarios")).toBeDefined();
    } finally {
      await ui.unmount();
    }
    setUser({ name: "QA Usuario", role: "user" });
    const ui2 = await renderSidebar();
    try {
      expect(ui2.aside().textContent).not.toContain("Admin");
      expect(navLink(ui2.container, "Caja")).toBeUndefined();
    } finally {
      await ui2.unmount();
    }
    navigateTo("/envios");
  }, TEST_TIMEOUT_MS);

  test("aislamiento mobile: todo lo que cambia al colapsar es lg:, y el drawer conserva sus clases base", async () => {
    setUser({ name: "QA Admin", role: "admin" });
    const collect = (root: Element) =>
      Array.from(root.querySelectorAll("*"))
        // Separadores nuevos del modo colapsado y el botón de colapsar (con
        // su ícono): ocultos por debajo de lg (hidden lg:block / lg:flex).
        .filter((el) => !el.closest('[data-testid="sidebar-collapse-toggle"]'))
        .filter((el) => !(el.getAttribute("class") ?? "").split(/\s+/).includes("hidden") || !(el.getAttribute("class") ?? "").includes("lg:block"))
        .map((el) => ({ tag: el.tagName, cls: new Set((el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)) }));

    for (const mobileOpen of [false, true]) {
      const expanded = await renderSidebar({ mobileOpen });
      const exp = collect(expanded.aside());
      const expAside = new Set(expanded.aside().className.split(/\s+/));
      await expanded.unmount();
      const collapsed = await renderSidebar({ stored: "1", mobileOpen });
      const col = collect(collapsed.aside());
      const colAside = new Set(collapsed.aside().className.split(/\s+/));
      await collapsed.unmount();

      expect(col.map((e) => e.tag)).toEqual(exp.map((e) => e.tag));
      const nonLg: string[] = [];
      const diff = (a: Set<string>, b: Set<string>) => { for (const c of a) if (!b.has(c) && !c.startsWith("lg:")) nonLg.push(c); };
      diff(colAside, expAside); diff(expAside, colAside);
      col.forEach((e, i) => { diff(e.cls, exp[i]!.cls); diff(exp[i]!.cls, e.cls); });
      expect(nonLg.join(" ")).toBe("");

      // Clases base del drawer mobile, idénticas en ambos estados.
      for (const cls of ["w-[216px]", "fixed", "inset-y-0", "left-0", "z-50", "transition-transform", "duration-300", "ease-in-out"]) {
        expect(colAside.has(cls)).toBe(true);
        expect(expAside.has(cls)).toBe(true);
      }
      expect(colAside.has(mobileOpen ? "translate-x-0" : "-translate-x-full")).toBe(true);
    }
  }, TEST_TIMEOUT_MS);

  test("el botón de colapsar no existe para mobile (hidden lg:flex) y el de cerrar drawer sigue igual", async () => {
    setUser(null);
    const ui = await renderSidebar({ mobileOpen: true });
    try {
      const cls = ui.toggle().className.split(/\s+/);
      expect(cls).toContain("hidden");
      expect(cls).toContain("lg:flex");
      const close = ui.aside().querySelector('button[aria-label="Cerrar menú"]') as HTMLElement;
      expect(close.className).toBe("lg:hidden text-gray-400 hover:text-white p-1");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("escritorio: sticky, alto de pantalla y nav con scroll interno", async () => {
    setUser(null);
    const ui = await renderSidebar();
    try {
      const cls = ui.aside().className.split(/\s+/);
      for (const c of ["lg:sticky", "lg:top-0", "lg:h-screen"]) expect(cls).toContain(c);
      expect(cls).not.toContain("lg:min-h-screen");
      const nav = ui.aside().querySelector("nav")!.className.split(/\s+/);
      expect(nav).toContain("overflow-y-auto");
      expect(nav).toContain("lg:min-h-0");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
