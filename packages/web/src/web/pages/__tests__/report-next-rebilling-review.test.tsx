// Reporte de renovaciones/refacturaciones: cola global "A revisar" (pólizas
// vigentes sin fecha segura de próxima refacturación) y refacturación futura
// ya cargada.
//  - Mes actual: pantalla, Excel y CSV contienen los MISMOS casos de la cola,
//    separados de los movimientos del mes (sección propia, hoja propia y un
//    CSV aparte; nunca en Resumen, totales ni CSV mensual).
//  - Mes de la refacturación futura: una sola fila real (no proyectada); la
//    cola no se repite (solo un aviso) y Excel/CSV quedan con la forma de siempre.
// react-dom/client sobre jsdom, fetch mockeado; se capturan el libro que
// recibe XLSX.writeFile y los Blob de los CSV. Datos 100% sintéticos.
//
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/report-next-rebilling-review.test.tsx
import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { JSDOM } from "jsdom";

let dom: JSDOM;
const originalGlobals: Record<string, any> = {};
const TEST_TIMEOUT_MS = 120_000;

let routes: Record<string, any> = {};
function installFetch() {
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${new URL(url, "http://localhost").pathname}`;
    if (!(key in routes)) throw new Error(`Unmocked fetch in test: ${key}`);
    return { ok: true, status: 200, json: async () => routes[key] } as any;
  };
}
async function flush(ticks = 10) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const actualXLSX = await import("xlsx");
const writtenWorkbooks: { wb: any; name: string }[] = [];
mock.module("xlsx", () => ({ ...actualXLSX, writeFile: (wb: any, name: string) => { writtenWorkbooks.push({ wb, name }); } }));
const actualWouter = await import("wouter");
mock.module("wouter", () => ({ ...actualWouter }));

const downloads: { name: string; blob: Blob }[] = [];
let lastBlob: Blob | null = null;

async function mount(element: (React: any) => any) {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { AuthProvider } = await import("../../lib/auth");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  await act(async () => { root.render(React.createElement(AuthProvider, null, element(React))); await flush(); });
  return { container, act, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function clickButton(ui: Awaited<ReturnType<typeof mount>>, label: string) {
  const button = Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!button) throw new Error(`no hay botón "${label}"`);
  await ui.act(async () => { button.click(); await flush(); });
}
function parseCsv(text: string) {
  const [header, ...lines] = text.replace(/^﻿/, "").split("\r\n");
  const cols = header!.split(",");
  const rows = lines.map((l) => {
    const cells: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i]!;
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    expect(cells.length).toBe(cols.length);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
  return { cols, rows };
}

const BASE_CSV_COLS = ["Tipo de movimiento", "Subtipo", "N° Póliza", "Asegurado", "Bien asegurado", "Compañía", "Ramo", "Cobertura", "Suma asegurada", "Fecha inicio", "Fecha fin", "Premio", "Cuota mensual", "Inicio póliza original", "Duplicados detectados", "Póliza anterior", "Importador", "Clasificación alta", "Proyectada"];
const BASE_SHEETS = ["Resumen", "Refacturaciones", "Renovaciones", "Altas", "Cuotas pendientes"];

const realRebilling = {
  rebillingId: 10, policyId: 1, policyNumber: "SINT-REAL", insuredName: "Asegurado Uno", companyName: "Compañía QA", type: "automotor",
  billingStart: "2026-10-01", billingEnd: "2026-12-31", premium: 1000, monthlyFee: null, policyOriginalStart: "2026-01-01",
  billingCycle: "trimestral", rebillingType: "prorroga", duplicateCount: 1, extraDuplicateRows: 0, insuredAsset: null,
  coverageType: null, sumInsured: null, projected: false,
};
const LABEL = "Próxima refacturación guardada vencida (15/09/2026); tiene frecuencia de refacturación pero ninguna refacturación cargada";
const FUTURE_LABEL = "Ya hay una refacturación cargada que empieza el 01/11/2026; lo que falta definir es la siguiente, posterior a ese período";
const totals = (over: Record<string, number> = {}) => ({
  rebillingsCount: 1, rebillingsDuplicateGroups: 0, rebillingsExtraRows: 0, totalPremiumRebillings: 1000,
  renovationsConfirmedCount: 0, renovationsImportedCount: 0, totalPremiumRenovations: 0, newPoliciesCount: 0,
  totalMovements: 1, pendingInstallmentsCount: 0, pendingInstallmentsOverdueCount: 0, totalPendingInstallmentsAmount: 0, ...over,
});
const CURRENT_REPORT = {
  month: "2026-10", isFutureMonth: false,
  rebillings: [realRebilling], renovationsConfirmed: [], renovationsImported: [], newPolicies: [], pendingInstallments: [],
  rebillingReview: [
    { policyId: 3, policyNumber: "SINT-SIN-FECHA", insuredName: "Asegurado Tres", companyName: "Compañía QA", type: "automotor",
      billingCycle: "trimestral", endDate: "2027-05-01", nextRebillingDate: "2026-09-15", reviewReason: "sin_refacturaciones", reviewReasonLabel: LABEL },
    // Refacturación futura ya cargada (empieza 01/11): la revisión es del evento siguiente.
    { policyId: 4, policyNumber: "SINT-FUTURA", insuredName: "Asegurado Cuatro", companyName: "Compañía QA", type: "automotor",
      billingCycle: "trimestral", endDate: "2027-05-01", nextRebillingDate: null, reviewReason: "periodo_futuro_ya_cargado", reviewReasonLabel: FUTURE_LABEL },
  ],
  rebillingReviewQueueCount: 2,
  totals: totals(),
};
// Mes de la refacturación futura ya cargada: fila REAL una sola vez; la cola no se repite.
const futureRealRebilling = {
  ...realRebilling, rebillingId: 20, policyId: 4, policyNumber: "SINT-FUTURA", insuredName: "Asegurado Cuatro",
  billingStart: "2026-11-01", billingEnd: "2027-01-31", projected: false,
};
const FUTURE_REPORT = {
  ...CURRENT_REPORT, month: "2026-11", isFutureMonth: true,
  rebillings: [futureRealRebilling, { ...realRebilling, rebillingId: -1, billingStart: "2026-11-01", billingEnd: null, rebillingType: null, projected: true }],
  rebillingReview: [],
  rebillingReviewQueueCount: 2,
  totals: totals({ rebillingsCount: 2, totalPremiumRebillings: 2000, totalMovements: 2 }),
};
const QUEUE_CSV_COLS = ["N° Póliza", "Asegurado", "Compañía", "Ramo", "Frecuencia", "Fin vigencia", "Próx. refact. guardada", "Motivo revisión"];

describe("Cola global 'A revisar' y refacturación futura ya cargada en pantalla, Excel y CSV", () => {
  beforeAll(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/reporte-mes?month=2026-10" });
    const keys = ["window", "document", "navigator", "localStorage", "HTMLInputElement", "HTMLElement", "HTMLSelectElement", "Event", "MouseEvent", "Node", "customElements", "location", "history", "File"] as const;
    for (const key of keys) {
      originalGlobals[key] = (globalThis as any)[key];
      (globalThis as any)[key] = (dom.window as any)[key];
    }
    originalGlobals.fetch = (globalThis as any).fetch;
    originalGlobals.IS_REACT_ACT_ENVIRONMENT = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    originalGlobals.createObjectURL = URL.createObjectURL;
    originalGlobals.revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = ((blob: Blob) => { lastBlob = blob; return "blob:qa"; }) as any;
    URL.revokeObjectURL = (() => {}) as any;
    dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, blob: lastBlob! });
    };
  });
  afterAll(() => {
    URL.createObjectURL = originalGlobals.createObjectURL;
    URL.revokeObjectURL = originalGlobals.revokeObjectURL;
    delete originalGlobals.createObjectURL;
    delete originalGlobals.revokeObjectURL;
    for (const key of Object.keys(originalGlobals)) {
      if (originalGlobals[key] === undefined) delete (globalThis as any)[key];
      else (globalThis as any)[key] = originalGlobals[key];
    }
    dom.window.close();
  });

  test("mes actual: la cola global aparece en pantalla, Excel y CSV con los mismos casos, separada de los movimientos del mes", async () => {
    routes = { "GET /api/companies": [], "GET /api/reports/renewals-rebillings": CURRENT_REPORT };
    installFetch();
    const { default: ReporteMes } = await import("../reporte-mes");
    const ui = await mount((React) => React.createElement(ReporteMes));
    try {
      const QUEUE = ["SINT-FUTURA", "SINT-SIN-FECHA"];
      // ── Pantalla ──
      const section = (title: string) => Array.from(ui.container.querySelectorAll("h3")).find((h) => h.textContent === title)!.closest("div.print-section")!;
      const queue = section("Refacturaciones a revisar (cola global)");
      for (const n of QUEUE) expect(queue.textContent).toContain(n);
      expect(queue.textContent).toContain(LABEL);
      expect(queue.textContent).toContain(FUTURE_LABEL);
      expect(queue.textContent).not.toContain("SINT-REAL");
      const monthly = section("Refacturaciones");
      for (const n of QUEUE) expect(monthly.textContent).not.toContain(n);

      // ── Excel ──
      writtenWorkbooks.length = 0;
      await clickButton(ui, "Descargar Excel");
      const { wb } = writtenWorkbooks[0]!;
      expect(wb.SheetNames).toEqual(["Resumen", "Refacturaciones", "A revisar (cola global)", "Renovaciones", "Altas", "Cuotas pendientes"]);
      const rows = (sh: string) => actualXLSX.utils.sheet_to_json(wb.Sheets[sh], { defval: "" }) as Record<string, unknown>[];
      expect(rows("Resumen").some((r) => /revisar/i.test(String(r["Sección"])))).toBe(false);
      expect(rows("Refacturaciones").map((r) => r["N° Póliza"])).toEqual(["SINT-REAL"]);
      const rev = rows("A revisar (cola global)");
      expect(rev.map((r) => r["N° Póliza"]).sort()).toEqual(QUEUE);
      expect(rev.find((r) => r["N° Póliza"] === "SINT-FUTURA")!["Motivo revisión"]).toBe(FUTURE_LABEL);

      // ── CSV: mensual intacto + cola en archivo aparte ──
      downloads.length = 0;
      await clickButton(ui, "CSV");
      expect(downloads.map((d) => d.name)).toEqual([
        "renovaciones_refacturaciones_2026-10.csv", "refacturaciones_a_revisar_cola_global_2026-10.csv",
      ]);
      const monthlyCsv = parseCsv(await downloads[0]!.blob.text());
      expect(monthlyCsv.cols).toEqual(BASE_CSV_COLS);
      expect(monthlyCsv.rows.map((r) => r["N° Póliza"])).toEqual(["SINT-REAL"]);
      const queueCsv = parseCsv(await downloads[1]!.blob.text());
      expect(queueCsv.cols).toEqual(QUEUE_CSV_COLS);
      expect(queueCsv.rows.map((r) => r["N° Póliza"]).sort()).toEqual(QUEUE);
      expect(queueCsv.rows.find((r) => r["N° Póliza"] === "SINT-SIN-FECHA")).toMatchObject({ "Próx. refact. guardada": "2026-09-15", "Motivo revisión": LABEL });
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("mes de la refacturación futura ya cargada: una sola fila real, sin cola ni duplicados; Excel y CSV con la forma de siempre", async () => {
    routes = { "GET /api/companies": [], "GET /api/reports/renewals-rebillings": FUTURE_REPORT };
    installFetch();
    const { default: ReporteMes } = await import("../reporte-mes");
    const ui = await mount((React) => React.createElement(ReporteMes));
    try {
      const text = ui.container.textContent ?? "";
      expect(text).toContain("Hay 2 pólizas vigentes sin fecha segura de próxima refacturación");
      expect(text).not.toContain("SINT-SIN-FECHA");
      expect(Array.from(ui.container.querySelectorAll("h3")).map((h) => h.textContent)).not.toContain("Refacturaciones a revisar (cola global)");
      const futureRows = Array.from(ui.container.querySelectorAll("tr")).filter((tr) => tr.textContent?.includes("SINT-FUTURA"));
      expect(futureRows).toHaveLength(1);
      expect(futureRows[0]!.textContent).not.toContain("Proyectada");

      writtenWorkbooks.length = 0;
      await clickButton(ui, "Descargar Excel");
      const { wb } = writtenWorkbooks[0]!;
      expect(wb.SheetNames).toEqual(BASE_SHEETS);
      const reb = actualXLSX.utils.sheet_to_json(wb.Sheets["Refacturaciones"], { defval: "" }) as Record<string, unknown>[];
      expect(reb.filter((r) => r["N° Póliza"] === "SINT-FUTURA").map((r) => r["Proyectada"])).toEqual([""]);
      const resumen = actualXLSX.utils.sheet_to_json(wb.Sheets["Resumen"], { defval: "" }) as Record<string, unknown>[];
      expect(resumen.find((r) => r["Sección"] === "Refacturaciones")!["Valor"]).toBe(2);

      downloads.length = 0;
      await clickButton(ui, "CSV");
      expect(downloads.map((d) => d.name)).toEqual(["renovaciones_refacturaciones_2026-11.csv"]);
      const { cols, rows } = parseCsv(await downloads[0]!.blob.text());
      expect(cols).toEqual(BASE_CSV_COLS);
      expect(rows.filter((r) => r["N° Póliza"] === "SINT-FUTURA").map((r) => [r["Tipo de movimiento"], r["Fecha inicio"], r["Proyectada"]]))
        .toEqual([["Refacturación", "2026-11-01", ""]]);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
