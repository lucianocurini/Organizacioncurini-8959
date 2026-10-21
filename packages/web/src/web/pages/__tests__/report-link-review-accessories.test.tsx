// Reporte de renovaciones/refacturaciones: cola global "Vínculos a revisar" y
// accesorias agrupadas bajo su principal.
//  - Mes actual: "Vínculos a revisar" en pantalla, hoja propia de Excel y CSV
//    aparte (nunca en Resumen ni en el CSV mensual); la principal de "A
//    revisar" muestra "+N accesorias".
//  - Mes futuro: la renovación agrupada es UNA fila con la prima sumada una
//    sola vez (pantalla, Excel y CSV); la cola solo se avisa.
// react-dom/client sobre jsdom, fetch mockeado; se capturan el libro que
// recibe XLSX.writeFile y los Blob de los CSV. Datos 100% sintéticos.
//
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/report-link-review-accessories.test.tsx
import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { JSDOM } from "jsdom";

let dom: JSDOM;
const originalGlobals: Record<string, any> = {};
const TEST_TIMEOUT_MS = 120_000;

let routes: Record<string, any> = {};
function installFetch() {
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(input), "http://localhost").pathname}`;
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

async function mount() {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { AuthProvider } = await import("../../lib/auth");
  const { default: ReporteMes } = await import("../reporte-mes");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as any);
  await act(async () => { root.render(React.createElement(AuthProvider, null, React.createElement(ReporteMes))); await flush(); });
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
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
  return { cols, rows };
}

const BASE_CSV_COLS = ["Tipo de movimiento", "Subtipo", "N° Póliza", "Asegurado", "Bien asegurado", "Compañía", "Ramo", "Cobertura", "Suma asegurada", "Fecha inicio", "Fecha fin", "Premio", "Cuota mensual", "Inicio póliza original", "Duplicados detectados", "Póliza anterior", "Importador", "Clasificación alta", "Proyectada"];
const LINK_CSV_COLS = ["N° Póliza", "Asegurado", "Compañía", "Ramo", "Inicio vigencia", "Fin vigencia", "Póliza principal", "Motivo"];
const totals = (over: Record<string, number> = {}) => ({
  rebillingsCount: 1, rebillingsDuplicateGroups: 0, rebillingsExtraRows: 0, totalPremiumRebillings: 75,
  renovationsConfirmedCount: 0, renovationsImportedCount: 0, totalPremiumRenovations: 0, newPoliciesCount: 0,
  totalMovements: 1, pendingInstallmentsCount: 1, pendingInstallmentsOverdueCount: 0, totalPendingInstallmentsAmount: 40, ...over,
});

// Refacturación REAL y cuota de una accesoria válida: siguen como movimientos propios.
const accessoryRealRebilling = {
  rebillingId: 10, policyId: 2, policyNumber: "SINT-ACC", insuredName: "Asegurado Uno", companyName: "Compañía QA", type: "accidentes_pasajeros",
  billingStart: "2026-10-05", billingEnd: "2027-01-05", premium: 75, monthlyFee: null, policyOriginalStart: "2026-07-01",
  billingCycle: null, rebillingType: "otro", duplicateCount: 1, extraDuplicateRows: 0, insuredAsset: null,
  coverageType: null, sumInsured: null, projected: false,
};
const accessoryPending = {
  installmentId: 30, installmentNumber: 1, policyId: 2, policyNumber: "SINT-ACC", insuredName: "Asegurado Uno", companyName: "Compañía QA",
  type: "accidentes_pasajeros", dueDate: "2026-10-10", amount: 40, status: "pendiente", insuredAsset: null, coverageType: null, sumInsured: null,
};
const LINKS = [
  { policyId: 5, policyNumber: "SINT-INV-ASEG", insuredName: "Asegurado Dos", companyName: "Compañía QA", type: "accidentes_pasajeros",
    startDate: "2026-07-01", endDate: "2027-01-15", parentPolicyNumber: "SINT-PRINC", linkReason: "otro_asegurado", linkReasonLabel: "La póliza principal es de otro asegurado" },
  { policyId: 6, policyNumber: "SINT-INV-INEX", insuredName: "Asegurado Uno", companyName: "Compañía QA", type: "accidentes_pasajeros",
    startDate: "2026-07-01", endDate: "2027-01-15", parentPolicyNumber: null, linkReason: "principal_inexistente", linkReasonLabel: "La póliza principal vinculada no existe" },
];
const CURRENT_REPORT = {
  month: "2026-10", isFutureMonth: false,
  rebillings: [accessoryRealRebilling], renovationsConfirmed: [], renovationsImported: [], newPolicies: [], pendingInstallments: [accessoryPending],
  rebillingReview: [
    { policyId: 1, policyNumber: "SINT-PRINC", insuredName: "Asegurado Uno", companyName: "Compañía QA", type: "automotor",
      billingCycle: "trimestral", endDate: "2027-01-15", nextRebillingDate: null, reviewReason: "sin_refacturaciones",
      reviewReasonLabel: "Tiene frecuencia de refacturación pero ninguna refacturación cargada", accessoryCount: 1 },
  ],
  rebillingReviewQueueCount: 1,
  linkReview: LINKS,
  linkReviewQueueCount: 2,
  totals: totals(),
};
// Mes de la renovación: principal (1000) + accesoria (150.25) = UNA fila de 1150.25.
const FUTURE_REPORT = {
  month: "2027-01", isFutureMonth: true,
  rebillings: [], renovationsImported: [], newPolicies: [], pendingInstallments: [],
  renovationsConfirmed: [
    { policyId: 1, policyNumber: "SINT-PRINC", insuredName: "Asegurado Uno", companyName: "Compañía QA", type: "automotor",
      startDate: null, endDate: "2027-01-15", premium: 1150.25, monthlyFee: null, renewedFromPolicyNumber: null, renewedFromEndDate: null,
      insuredAsset: null, coverageType: null, sumInsured: null, projected: true, accessoryCount: 1 },
  ],
  rebillingReview: [], rebillingReviewQueueCount: 1,
  linkReview: [], linkReviewQueueCount: 2,
  totals: totals({ rebillingsCount: 0, totalPremiumRebillings: 0, renovationsConfirmedCount: 1, totalPremiumRenovations: 1150.25, totalMovements: 1, pendingInstallmentsCount: 0, totalPendingInstallmentsAmount: 0 }),
};

describe("'Vínculos a revisar' y accesorias agrupadas en pantalla, Excel y CSV", () => {
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

  test("mes actual: sección, hoja y CSV propios; movimientos reales de la accesoria intactos", async () => {
    routes = { "GET /api/companies": [], "GET /api/reports/renewals-rebillings": CURRENT_REPORT };
    installFetch();
    const ui = await mount();
    try {
      const section = (title: string) => Array.from(ui.container.querySelectorAll("h3")).find((h) => h.textContent === title)?.closest("div.print-section") ?? null;
      const links = section("Vínculos a revisar")!;
      expect(links).toBeTruthy();
      for (const r of LINKS) {
        expect(links.textContent).toContain(r.policyNumber);
        expect(links.textContent).toContain(r.linkReasonLabel);
      }
      expect(links.textContent).toContain("SINT-PRINC"); // principal informada
      const review = section("Refacturaciones a revisar (cola global)")!;
      expect(review.textContent).toContain("+1 accesoria");
      for (const r of LINKS) expect(review.textContent).not.toContain(r.policyNumber);
      // Real y cuota de la accesoria, en sus secciones de siempre.
      expect(section("Refacturaciones")!.textContent).toContain("SINT-ACC");
      expect(section("Cuotas pendientes del mes")!.textContent).toContain("SINT-ACC");

      writtenWorkbooks.length = 0;
      await clickButton(ui, "Descargar Excel");
      const { wb } = writtenWorkbooks[0]!;
      expect(wb.SheetNames).toEqual(["Resumen", "Refacturaciones", "A revisar (cola global)", "Vínculos a revisar", "Renovaciones", "Altas", "Cuotas pendientes"]);
      const rows = (sh: string) => actualXLSX.utils.sheet_to_json(wb.Sheets[sh], { defval: "" }) as Record<string, unknown>[];
      expect(rows("Resumen").some((r) => /v[ií]nculo/i.test(String(r["Sección"])))).toBe(false);
      expect(rows("Vínculos a revisar").map((r) => [r["N° Póliza"], r["Póliza principal"], r["Motivo"]])).toEqual(
        LINKS.map((r) => [r.policyNumber, r.parentPolicyNumber ?? "", r.linkReasonLabel]),
      );
      expect(rows("A revisar (cola global)")[0]!["Accesorias agrupadas"]).toBe(1);
      expect(rows("Refacturaciones").map((r) => r["N° Póliza"])).toEqual(["SINT-ACC"]);
      expect(rows("Cuotas pendientes").map((r) => r["N° Póliza"])).toEqual(["SINT-ACC"]);

      downloads.length = 0;
      await clickButton(ui, "CSV");
      expect(downloads.map((x) => x.name)).toEqual([
        "renovaciones_refacturaciones_2026-10.csv", "refacturaciones_a_revisar_cola_global_2026-10.csv", "vinculos_a_revisar_2026-10.csv",
      ]);
      const monthly = parseCsv(await downloads[0]!.blob.text());
      expect(monthly.cols).toEqual(BASE_CSV_COLS);
      expect(monthly.rows.map((r) => [r["Tipo de movimiento"], r["N° Póliza"]])).toEqual([["Refacturación", "SINT-ACC"], ["Cuota pendiente", "SINT-ACC"]]);
      const linkCsv = parseCsv(await downloads[2]!.blob.text());
      expect(linkCsv.cols).toEqual(LINK_CSV_COLS);
      expect(linkCsv.rows.map((r) => [r["N° Póliza"], r["Motivo"]])).toEqual(LINKS.map((r) => [r.policyNumber, r.linkReasonLabel]));
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("mes futuro: renovación agrupada = una fila con prima sumada una vez; la cola solo se avisa", async () => {
    routes = { "GET /api/companies": [], "GET /api/reports/renewals-rebillings": FUTURE_REPORT };
    installFetch();
    const ui = await mount();
    try {
      const text = ui.container.textContent ?? "";
      expect(text).toContain("Hay 2 pólizas accesorias vigentes con el vínculo a su principal inválido");
      expect(Array.from(ui.container.querySelectorAll("h3")).map((h) => h.textContent)).not.toContain("Vínculos a revisar");
      const princRows = Array.from(ui.container.querySelectorAll("tr")).filter((tr) => tr.textContent?.includes("SINT-PRINC"));
      expect(princRows).toHaveLength(1);
      expect(princRows[0]!.textContent).toContain("+1 accesoria");

      writtenWorkbooks.length = 0;
      await clickButton(ui, "Descargar Excel");
      const { wb } = writtenWorkbooks[0]!;
      expect(wb.SheetNames).toEqual(["Resumen", "Refacturaciones", "Renovaciones", "Altas", "Cuotas pendientes"]);
      const ren = actualXLSX.utils.sheet_to_json(wb.Sheets["Renovaciones"], { defval: "" }) as Record<string, unknown>[];
      expect(ren.map((r) => [r["N° Póliza"], r["Premio"], r["Accesorias agrupadas"], r["Proyectada"]])).toEqual([["SINT-PRINC", 1150.25, 1, "Sí"]]);
      const resumen = actualXLSX.utils.sheet_to_json(wb.Sheets["Resumen"], { defval: "" }) as Record<string, unknown>[];
      expect(resumen.find((r) => r["Sección"] === "Premio total renovaciones")!["Valor"]).toBe(1150.25);
      expect(resumen.find((r) => r["Sección"] === "Renovaciones confirmadas")!["Valor"]).toBe(1);

      downloads.length = 0;
      await clickButton(ui, "CSV");
      expect(downloads.map((x) => x.name)).toEqual(["renovaciones_refacturaciones_2027-01.csv"]);
      const { cols, rows } = parseCsv(await downloads[0]!.blob.text());
      expect(cols).toEqual(BASE_CSV_COLS);
      expect(rows.map((r) => [r["Tipo de movimiento"], r["N° Póliza"], r["Premio"]])).toEqual([["Renovación confirmada", "SINT-PRINC", "1150.25"]]);
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
