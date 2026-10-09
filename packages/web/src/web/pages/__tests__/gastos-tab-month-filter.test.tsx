// Cobranzas → Gastos con filtro mensual: <GastosTab> real montado con
// react-dom/client sobre un jsdom aislado y `fetch` mockeado con un
// "backend" en memoria que aplica el mismo filtro que GET /api/cash/expenses
// (helpers compartidos de src/lib/expenses-month.ts). La selección vive en
// un contenedor de prueba, igual que en Cobranzas vive en la URL.
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/gastos-tab-month-filter.test.tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { isDateInExpensesMonth, isValidExpensesMonth } from "../../../lib/expenses-month";

let dom: JSDOM;
const originalGlobals: Record<string, any> = {};

interface Row { id: number; date: string; description: string; amount: number; category: string | null; notes: string | null; status: string }

function mockBackend(initial: Omit<Row, "status" | "category" | "notes">[]) {
  let nextId = 1000;
  const rows: Row[] = initial.map((r) => ({ category: null, notes: null, status: "registrado", ...r }));
  const calls: Array<{ url: string; method: string; body: any }> = [];
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const json = (b: any, status = 200) => ({ ok: status < 400, status, json: async () => b }) as any;
    const u = new URL(url, "http://localhost");
    if (u.pathname === "/api/cash/expenses" && method === "GET") {
      const month = u.searchParams.get("month");
      if (month !== null && month !== "all" && !isValidExpensesMonth(month)) return json({ error: "month inválido" }, 400);
      return json(rows
        .filter((r) => r.status !== "anulado" && (month === null || month === "all" || isDateInExpensesMonth(r.date, month)))
        .sort((a, b) => b.date.localeCompare(a.date)));
    }
    if (u.pathname === "/api/cash/expenses" && method === "POST") {
      const row: Row = { id: nextId++, status: "registrado", ...body };
      rows.push(row);
      return json(row, 201);
    }
    const m = u.pathname.match(/^\/api\/cash\/expenses\/(\d+)$/);
    if (m && method === "PUT") {
      const row = rows.find((r) => r.id === Number(m[1]))!;
      Object.assign(row, body);
      return json(row);
    }
    if (m && method === "DELETE") {
      rows.find((r) => r.id === Number(m[1]))!.status = "anulado";
      return json({ ok: true, anulado: true });
    }
    throw new Error(`Unmocked fetch in test: ${method} ${url}`);
  };
  return { rows, calls, gets: () => calls.filter((c) => c.method === "GET").map((c) => c.url) };
}

async function flush(ticks = 8) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const MODULE_LOAD_TIMEOUT_MS = 120_000;

async function renderTab(initialSelection: string) {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { GastosTab } = await import("../cobranzas");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  const selections: string[] = [];
  function Harness() {
    const [selection, setSelection] = React.useState(initialSelection);
    return React.createElement(GastosTab, { selection, onSelectionChange: (s: string) => { selections.push(s); setSelection(s); } });
  }
  await act(async () => { root.render(React.createElement(Harness)); await flush(); });

  const inputSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  const text = () => (container.textContent ?? "").replace(/ /g, " ");
  const button = (label: string) => Array.from(container.querySelectorAll("button"))
    .find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "").startsWith(label)) as HTMLButtonElement | undefined;
  const click = async (label: string) => {
    const b = button(label);
    if (!b) throw new Error(`Botón no encontrado: ${label}`);
    await act(async () => { b.click(); await flush(); });
  };
  const fieldAfterLabel = (labelText: string) => {
    const label = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.trim() === labelText);
    if (!label) throw new Error(`Label no encontrado: ${labelText}`);
    return label.nextElementSibling as HTMLInputElement;
  };
  const type = async (el: HTMLInputElement, value: string) => {
    await act(async () => { inputSetter.call(el, value); el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); await flush(2); });
  };
  const rowsShown = () => Array.from(container.querySelectorAll(".space-y-2 > div")).map((d) => d.textContent ?? "");
  const totalText = () => (container.querySelector('[data-testid="gastos-total"]')?.textContent ?? "").replace(/ /g, " ");
  const monthLabel = () => container.querySelector('[data-testid="gastos-month-label"]')?.textContent;
  const notice = () => container.querySelector('[data-testid="gastos-saved-elsewhere"]')?.textContent?.replace(/ /g, " ") ?? null;
  async function createExpense(date: string, description: string, amount: string) {
    await click("Nuevo gasto");
    await type(fieldAfterLabel("Fecha *"), date);
    await type(fieldAfterLabel("Descripción *"), description);
    await type(fieldAfterLabel("Monto *"), amount);
    await click("Guardar");
  }
  return {
    act, text, click, type, fieldAfterLabel, rowsShown, totalText, monthLabel, notice, createExpense, selections, container,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

const SEED = [
  { id: 1, date: "2026-10-01", description: "Papelería oct (1.º)", amount: 1000 },
  { id: 2, date: "2026-10-31", description: "Luz oct (último)", amount: 2500.5 },
  { id: 3, date: "2026-09-30", description: "Gasto septiembre", amount: 700 },
  { id: 4, date: "2026-11-01", description: "Gasto noviembre", amount: 300 },
  { id: 5, date: "2025-12-31", description: "Gasto diciembre 2025", amount: 40 },
  { id: 6, date: "2026-01-01", description: "Gasto enero 2026", amount: 60 },
];

describe("Cobranzas → Gastos por mes", () => {
  beforeAll(async () => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
    const keys = ["window", "document", "navigator", "localStorage", "HTMLInputElement", "HTMLElement", "Event", "MouseEvent", "Node", "customElements"] as const;
    for (const key of keys) {
      originalGlobals[key] = (globalThis as any)[key];
      (globalThis as any)[key] = (dom.window as any)[key];
    }
    originalGlobals.fetch = (globalThis as any).fetch;
    originalGlobals.confirm = (globalThis as any).confirm;
    originalGlobals.IS_REACT_ACT_ENVIRONMENT = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).confirm = () => true;
    await import("../cobranzas");
  }, MODULE_LOAD_TIMEOUT_MS);

  afterAll(() => {
    for (const key of Object.keys(originalGlobals)) {
      if (originalGlobals[key] === undefined) delete (globalThis as any)[key];
      else (globalThis as any)[key] = originalGlobals[key];
    }
    dom.window.close();
  });

  test("lista solo el mes (primer y último día), total del mes y etiqueta", async () => {
    const be = mockBackend(SEED);
    const t = await renderTab("2026-10");
    try {
      expect(be.gets()).toEqual(["/api/cash/expenses?month=2026-10"]);
      expect(t.monthLabel()).toBe("Octubre 2026");
      const rows = t.rowsShown();
      expect(rows.length).toBe(2);
      expect(rows.join("|")).toContain("Papelería oct (1.º)");
      expect(rows.join("|")).toContain("Luz oct (último)");
      expect(t.text()).not.toContain("Gasto septiembre");
      expect(t.text()).not.toContain("Gasto noviembre");
      expect(t.totalText()).toContain("Total de gastos — Octubre 2026");
      expect(t.totalText()).toContain("3.501"); // 1000 + 2500,50 (formato sin decimales de la pantalla)
      expect(t.totalText()).toContain("2 registros");
    } finally { await t.unmount(); }
  });

  test("anterior / siguiente cruzando diciembre-enero", async () => {
    mockBackend(SEED);
    const t = await renderTab("2026-01");
    try {
      expect(t.rowsShown().join("|")).toContain("Gasto enero 2026");
      await t.click("Mes anterior");
      expect(t.selections[t.selections.length - 1]).toBe("2025-12");
      expect(t.monthLabel()).toBe("Diciembre 2025");
      expect(t.rowsShown().join("|")).toContain("Gasto diciembre 2025");
      expect(t.text()).not.toContain("Gasto enero 2026");
      await t.click("Mes siguiente");
      await t.click("Mes siguiente");
      expect(t.monthLabel()).toBe("Febrero 2026");
      expect(t.selections).toEqual(["2025-12", "2026-01", "2026-02"]);
    } finally { await t.unmount(); }
  });

  test("mes vacío: estado claro y total $0 con 0 registros", async () => {
    mockBackend(SEED);
    const t = await renderTab("2026-03");
    try {
      expect(t.rowsShown().length).toBe(0);
      expect(t.text()).toContain("Sin gastos en Marzo 2026");
      expect(t.totalText()).toContain("Total de gastos — Marzo 2026");
      expect(t.totalText()).toContain("$ 0");
      expect(t.totalText()).toContain("0 registros");
    } finally { await t.unmount(); }
  });

  test("Todos los meses: histórico completo, total histórico y vuelta al mes", async () => {
    const be = mockBackend(SEED);
    const t = await renderTab("2026-10");
    try {
      await t.click("Todos los meses");
      expect(be.gets()[be.gets().length - 1]).toBe("/api/cash/expenses?month=all");
      expect(t.rowsShown().length).toBe(SEED.length);
      expect(t.totalText()).toContain("Total histórico de gastos");
      expect(t.totalText()).toContain("4.601"); // suma de los 6
      expect((t.container.querySelector('button[aria-label="Mes anterior"]') as HTMLButtonElement).disabled).toBe(true);
      // Elegir un mes concreto desde el selector directo sale del histórico.
      const monthInput = t.container.querySelector('input[type="month"]') as HTMLInputElement;
      await t.type(monthInput, "2026-09");
      expect(t.monthLabel()).toBe("Septiembre 2026");
      expect(t.rowsShown().join("|")).toContain("Gasto septiembre");
      // Valor inválido del selector directo: se ignora.
      await t.type(monthInput, "2026-13");
      expect(t.monthLabel()).toBe("Septiembre 2026");
    } finally { await t.unmount(); }
  });

  test("alta en el mes visible: aparece y el total se actualiza al instante", async () => {
    mockBackend(SEED);
    const t = await renderTab("2026-10");
    try {
      await t.createExpense("2026-10-15", "Alta del mes", "499.5");
      expect(t.rowsShown().length).toBe(3);
      expect(t.rowsShown().join("|")).toContain("Alta del mes");
      expect(t.totalText()).toContain("4.000"); // 3500,50 + 499,50
      expect(t.notice()).toBeNull();
    } finally { await t.unmount(); }
  });

  test("alta con fecha de otro mes: aviso 'Guardado en …' y botón para ir", async () => {
    const be = mockBackend(SEED);
    const t = await renderTab("2026-10");
    try {
      await t.createExpense("2026-12-02", "Alta diciembre", "100");
      expect(be.calls.filter((c) => c.method === "POST")[0]!.body).toEqual({
        date: "2026-12-02", description: "Alta diciembre", amount: 100, category: null, notes: null,
      });
      expect(t.rowsShown().length).toBe(2);
      expect(t.notice()).toContain("Gasto registrado.");
      expect(t.notice()).toContain("Guardado en Diciembre 2026");
      await t.click("Ir a Diciembre 2026");
      expect(t.monthLabel()).toBe("Diciembre 2026");
      expect(t.rowsShown().join("|")).toContain("Alta diciembre");
      expect(t.totalText()).toContain("Total de gastos — Diciembre 2026");
      expect(t.notice()).toBeNull();
    } finally { await t.unmount(); }
  });

  test("edición hacia otro mes: deja de listarse con aviso; total recalculado", async () => {
    const be = mockBackend(SEED);
    const t = await renderTab("2026-10");
    try {
      const editButtons = t.container.querySelectorAll(".space-y-2 > div button");
      // Fila 1 (orden por fecha desc) = "Luz oct (último)" → botón editar.
      await t.act(async () => { (editButtons[0] as HTMLButtonElement).click(); await flush(); });
      await t.type(t.fieldAfterLabel("Fecha *"), "2026-09-05");
      await t.click("Guardar");
      expect(be.calls.find((c) => c.method === "PUT")!.url).toBe("/api/cash/expenses/2");
      expect(t.rowsShown().length).toBe(1);
      expect(t.totalText()).toContain("1.000");
      expect(t.notice()).toContain("Gasto actualizado.");
      expect(t.notice()).toContain("Guardado en Septiembre 2026");
      await t.click("Cerrar aviso");
      expect(t.notice()).toBeNull();
    } finally { await t.unmount(); }
  });

  test("anular: desaparece la fila y baja el total", async () => {
    const be = mockBackend(SEED);
    const t = await renderTab("2026-10");
    try {
      const buttons = t.container.querySelectorAll(".space-y-2 > div button");
      await t.act(async () => { (buttons[1] as HTMLButtonElement).click(); await flush(); });
      expect(be.calls.find((c) => c.method === "DELETE")!.url).toBe("/api/cash/expenses/2");
      expect(t.rowsShown().length).toBe(1);
      expect(t.totalText()).toContain("1.000");
      expect(t.totalText()).toContain("1 registro");
    } finally { await t.unmount(); }
  });

  test("validaciones del formulario sin cambios (sin descripción / monto inválido no envían)", async () => {
    const be = mockBackend(SEED);
    const t = await renderTab("2026-10");
    try {
      await t.click("Nuevo gasto");
      expect(t.fieldAfterLabel("Fecha *").value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await t.click("Guardar");
      await t.type(t.fieldAfterLabel("Descripción *"), "x");
      await t.type(t.fieldAfterLabel("Monto *"), "0");
      await t.click("Guardar");
      expect(be.calls.filter((c) => c.method === "POST").length).toBe(0);
    } finally { await t.unmount(); }
  });

  test("respuesta vieja de otro mes no pisa la del mes elegido", async () => {
    mockBackend(SEED);
    const realFetch = (globalThis as any).fetch;
    let releaseSlow: () => void = () => {};
    (globalThis as any).fetch = async (input: any, init?: any) => {
      if (String(input).endsWith("month=2026-09")) await new Promise<void>((r) => { releaseSlow = r; });
      return realFetch(input, init);
    };
    const t = await renderTab("2026-10");
    try {
      await t.click("Mes anterior"); // septiembre: queda colgado
      await t.click("Mes siguiente"); // octubre
      await t.click("Mes siguiente"); // noviembre: responde
      expect(t.monthLabel()).toBe("Noviembre 2026");
      await t.act(async () => { releaseSlow(); await flush(); });
      expect(t.rowsShown().join("|")).toContain("Gasto noviembre");
      expect(t.text()).not.toContain("Gasto septiembre");
    } finally { await t.unmount(); }
  });
});
