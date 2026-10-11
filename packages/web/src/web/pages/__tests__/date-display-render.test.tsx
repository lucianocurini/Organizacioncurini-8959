// Etapa 1 de fechas DD/MM/YYYY: render REAL (react-dom/client sobre jsdom,
// fetch mockeado) de pantallas representativas — Caja, Cobranzas → Gastos,
// Tareas, Siniestros, Pólizas y el importador de pólizas. Verifica que:
//  - lo visible sale DD/MM/YYYY (con ceros), "Octubre 2026" y fecha+hora en
//    Argentina, sin "Invalid Date" ni texto ISO crudo;
//  - lo que viaja a la API (query params y payloads) sigue en YYYY-MM-DD.
//
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/date-display-render.test.tsx
import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { JSDOM } from "jsdom";

let dom: JSDOM;
const originalGlobals: Record<string, any> = {};
const TEST_TIMEOUT_MS = 120_000;
const ISO_DAY_RE = /\b\d{4}-\d{2}-\d{2}\b/;

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let routes: Record<string, any> = {};

function installFetch() {
  calls = [];
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const path = new URL(url, "http://localhost").pathname;
    const key = `${method} ${path}`;
    if (!(key in routes)) throw new Error(`Unmocked fetch in test: ${key}`);
    const value = typeof routes[key] === "function" ? routes[key](url, body) : routes[key];
    return { ok: true, status: 200, json: async () => value } as any;
  };
}

async function flush(ticks = 10) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const text = (el: Element) => (el.textContent ?? "").replace(/ /g, " ");

function expectNoRawDates(el: Element) {
  const t = text(el);
  expect(t).not.toMatch(ISO_DAY_RE);
  expect(t).not.toContain("Invalid Date");
  expect(t).not.toContain("NaN");
}

// wouter: useSearch/useLocation funcionan sin Router; useParams no (PolizaDetail no se monta acá).
const actualWouter = await import("wouter");
mock.module("wouter", () => ({ ...actualWouter }));

async function mount(element: (React: any) => any) {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { AuthProvider } = await import("../../lib/auth");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  await act(async () => { root.render(React.createElement(AuthProvider, null, element(React))); await flush(); });
  return {
    container,
    act,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

describe("Fechas visibles DD/MM/YYYY — render real", () => {
  beforeAll(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
    const keys = ["window", "document", "navigator", "localStorage", "HTMLInputElement", "HTMLElement", "HTMLSelectElement", "Event", "MouseEvent", "Node", "customElements", "location", "history", "File"] as const;
    for (const key of keys) {
      originalGlobals[key] = (globalThis as any)[key];
      (globalThis as any)[key] = (dom.window as any)[key];
    }
    originalGlobals.fetch = (globalThis as any).fetch;
    originalGlobals.IS_REACT_ACT_ENVIRONMENT = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    for (const key of Object.keys(originalGlobals)) {
      if (originalGlobals[key] === undefined) delete (globalThis as any)[key];
      else (globalThis as any)[key] = originalGlobals[key];
    }
    dom.window.close();
  });

  test("Caja — cobros pendientes: cobro, vencimiento y período del contado en DD/MM/YYYY", async () => {
    routes = {};
    installFetch();
    const { CajaPendingCobranzasList } = await import("../caja");
    const payments = [{
      id: 1, insuredName: "QA Normal", policyNumber: "POL-1", companyName: "Cía", amount: 1000,
      paymentMethod: "efectivo", paymentDate: "2026-10-09", dueDate: "2026-10-01", status: "confirmado", rendered: 0,
    }];
    const ui = await mount((React) => React.createElement(CajaPendingCobranzasList, { payments, remittancePending: [] }));
    try {
      const t = text(ui.container);
      expect(t).toContain("09/10/2026");
      expect(t).toContain("Venc: 01/10/2026");
      expectNoRawDates(ui.container);
    } finally { await ui.unmount(); }
  }, TEST_TIMEOUT_MS);

  test("Cobranzas → Gastos: filas en DD/MM/YYYY, query param ?month=YYYY-MM y payload date YYYY-MM-DD", async () => {
    routes = {
      "GET /api/cash/expenses": [
        { id: 1, date: "2026-10-09", description: "QA Café", amount: 2500, category: null, notes: null, status: "registrado" },
        { id: 2, date: "2026-10-01", description: "QA Limpieza", amount: 9000, category: null, notes: null, status: "registrado" },
      ],
      "POST /api/cash/expenses": (_u: string, body: any) => ({ id: 3, status: "registrado", ...body }),
    };
    installFetch();
    const { GastosTab } = await import("../cobranzas");
    const ui = await mount((React) => React.createElement(GastosTab, { selection: "2026-10", onSelectionChange: () => {} }));
    try {
      const t = text(ui.container);
      expect(t).toContain("09/10/2026");
      expect(t).toContain("01/10/2026");
      expect(t).toContain("Octubre 2026");
      expectNoRawDates(ui.container);
      const get = calls.find((c) => c.method === "GET" && c.url.startsWith("/api/cash/expenses"))!;
      expect(new URL(get.url, "http://x").searchParams.get("month")).toBe("2026-10");

      // Alta: el <input type="date"> y el payload siguen en ISO.
      const button = Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Nuevo gasto"))!;
      await ui.act(async () => { button.click(); await flush(); });
      const label = (l: string) => Array.from(ui.container.querySelectorAll("label")).find((x) => x.textContent?.trim() === l)!.nextElementSibling as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      const type = async (el: HTMLInputElement, v: string) => {
        await ui.act(async () => { setter.call(el, v); el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); await flush(2); });
      };
      const dateInput = label("Fecha *");
      expect(dateInput.getAttribute("type")).toBe("date");
      await type(dateInput, "2026-10-05");
      expect(dateInput.value).toBe("2026-10-05");
      await type(label("Descripción *"), "QA Nuevo");
      await type(label("Monto *"), "100");
      const save = Array.from(ui.container.querySelectorAll("button")).find((b) => /Guardar|Registrar/.test(b.textContent ?? ""))!;
      await ui.act(async () => { save.click(); await flush(); });
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/cash/expenses")!;
      expect(post.body.date).toBe("2026-10-05");
    } finally { await ui.unmount(); }
  }, TEST_TIMEOUT_MS);

  test("Cobranzas → PaymentModal: opción de cuota 'vence DD/MM/YYYY — $' y vencimiento interno en ISO", async () => {
    routes = {
      "GET /api/policies": [],
      "GET /api/policies/1/installments": [{ id: 11, number: 1, dueDate: "2026-10-01", amount: 40000, status: "pendiente", rendered: 0 }],
    };
    installFetch();
    const { PaymentModal } = await import("../cobranzas");
    const editing: any = {
      payment: {
        id: 7, policyId: 1, installmentId: null, manualPayer: null, manualPolicyNumber: null, manualCompany: null,
        amount: 40000, paymentMethod: "efectivo", splits: null, paymentDate: "2026-10-09", dueDate: null,
        periodMonth: "2026-10", notes: null, status: "confirmado", hasSurcharge: false, rendered: 0,
      },
      policy: { id: 1, policyNumber: "POL-QA" }, insured: { id: 1, name: "QA Asegurado" }, company: { id: 1, name: "QA Cía" },
    };
    const ui = await mount((React) => React.createElement(PaymentModal, { open: true, onClose: () => {}, onSaved: () => {}, editing }));
    try {
      const select = Array.from(ui.container.querySelectorAll("select"))
        .find((s) => Array.from(s.options).some((o) => o.textContent === "Sin vincular cuota específica"))!;
      const option = Array.from(select.options).find((o) => o.value === "11")!;
      expect(text(option).trim()).toBe("Cuota #1 — vence 01/10/2026 — $40.000");
      expect(text(option)).not.toContain("—$");
      expect(text(option)).not.toMatch(ISO_DAY_RE);

      // Al elegir la cuota, el vencimiento que va al formulario (y al payload) sigue en ISO.
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!;
      await ui.act(async () => { setter.call(select, "11"); select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); await flush(); });
      const dueInput = Array.from(ui.container.querySelectorAll("label"))
        .find((l) => l.textContent?.trim() === "Vencimiento de cuota")!.nextElementSibling as HTMLInputElement;
      expect(dueInput.getAttribute("type")).toBe("date");
      expect(dueInput.value).toBe("2026-10-01");
    } finally { await ui.unmount(); }
  }, TEST_TIMEOUT_MS);

  test("Tareas: mes 'Octubre 2026', vencimiento 09/10/2026, query ?month=YYYY-MM", async () => {
    // El mes inicial de Tareas sale del reloj; se fija a 2026-10-10 12:00 Argentina.
    const RealDate = Date;
    const fixed = RealDate.UTC(2026, 9, 10, 15, 0, 0);
    class FixedDate extends RealDate {
      constructor(...args: any[]) { if (args.length === 0) super(fixed); else super(...(args as [any])); }
      static now() { return fixed; }
    }
    (globalThis as any).Date = FixedDate;
    routes = {
      "GET /api/tasks": [
        { id: 1, templateId: null, monthYear: "2026-10", title: "QA Tarea", description: null, dueDate: "2026-10-09", status: "pendiente", isRecurring: 0, isAdminOnly: 0 },
      ],
      "GET /api/task-templates": [],
    };
    installFetch();
    try {
      const { default: Tareas } = await import("../tareas");
      const ui = await mount((React) => React.createElement(Tareas));
      try {
        const t = text(ui.container);
        expect(t).toContain("Octubre 2026");
        expect(t).toContain("09/10/2026");
        expectNoRawDates(ui.container);
        const get = calls.find((c) => c.url.startsWith("/api/tasks?"))!;
        expect(new URL(get.url, "http://x").searchParams.get("month")).toBe("2026-10");
      } finally { await ui.unmount(); }
    } finally {
      (globalThis as any).Date = RealDate;
    }
  }, TEST_TIMEOUT_MS);

  test("Siniestros: fecha del hecho DD/MM/YYYY y 'Cargado' con fecha y hora Argentina (timestamp)", async () => {
    const claim = (id: number, status: string, incidentDate: string | null, createdAt: string) => ({
      claim: { id, status, incidentDate, incidentTime: null, incidentLocation: null, createdAt, manualInsured: `QA ${id}`, manualCompany: null, manualPolicyNumber: null, manualPolicyType: null, manualNotes: null },
      policy: null, insured: null, company: null,
    });
    routes = {
      // createdAt 2026-10-09T02:30Z = 08/10/2026 23:30 en Argentina (antes de medianoche).
      "GET /api/claims": [claim(1, "pendiente", null, "2026-10-09T02:30:00.000Z"), claim(2, "nuevo", "2026-10-09", "2026-10-09T15:00:00.000Z")],
      "GET /api/claims/stats": { total: 2 },
    };
    installFetch();
    const { default: Siniestros } = await import("../siniestros");
    const ui = await mount((React) => React.createElement(Siniestros));
    try {
      const t = text(ui.container);
      expect(t).toContain("Cargado 08/10/2026 23:30");
      expect(t).toContain("09/10/2026");
      expectNoRawDates(ui.container);
    } finally { await ui.unmount(); }
  }, TEST_TIMEOUT_MS);

  test("Pólizas: vigencia en DD/MM/YYYY", async () => {
    routes = {
      "GET /api/policies": [{
        policy: { id: 1, policyNumber: "POL-QA", type: "automotor", status: "activa", startDate: "2026-01-01", endDate: "2026-12-31", premium: 1000, companyId: 1, insuredId: 1 },
        insured: { id: 1, name: "QA Asegurado" }, company: { id: 1, name: "QA Cía" },
      }],
    };
    installFetch();
    const { default: Polizas } = await import("../polizas");
    const ui = await mount((React) => React.createElement(Polizas));
    try {
      const t = text(ui.container);
      expect(t).toContain("31/12/2026");
      expect(t).toContain("01/01/2026");
      expectNoRawDates(ui.container);
    } finally { await ui.unmount(); }
  }, TEST_TIMEOUT_MS);

  test("Importación de pólizas: vista previa en DD/MM/YYYY, payload en YYYY-MM-DD", async () => {
    routes = { "POST /api/policies/import": { imported: 1, skipped: 0, errors: [] } };
    installFetch();
    const { ImportModal } = await import("../../components/policies/ImportModal");
    const ui = await mount((React) => React.createElement(ImportModal, { onClose: () => {}, onImported: () => {} }));
    try {
      const csv = "N° Póliza;Compañía;Asegurado;Vigencia Desde;Vigencia Hasta\nPOL-IMP;QA Cía;QA Imp;09/10/2026;9/10/2027\n";
      const file = { name: "polizas.csv", text: async () => csv } as any;
      const input = ui.container.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      await ui.act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); await flush(); });
      const next = Array.from(ui.container.querySelectorAll("button")).filter((b) => !b.disabled).pop()!;
      await ui.act(async () => { next.click(); await flush(); });
      const t = text(ui.container);
      expect(t).toContain("09/10/2026");
      expect(t).toContain("09/10/2027"); // "9/10/2027" del archivo, normalizado y con cero
      expectNoRawDates(ui.container);
      const importBtn = Array.from(ui.container.querySelectorAll("button")).find((b) => /Importar \d/.test(b.textContent ?? ""))!;
      await ui.act(async () => { importBtn.click(); await flush(); });
      const post = calls.find((c) => c.url === "/api/policies/import")!;
      expect(post.body.rows[0].startDate).toBe("2026-10-09");
      expect(post.body.rows[0].endDate).toBe("2027-10-09");
    } finally { await ui.unmount(); }
  }, TEST_TIMEOUT_MS);
});
