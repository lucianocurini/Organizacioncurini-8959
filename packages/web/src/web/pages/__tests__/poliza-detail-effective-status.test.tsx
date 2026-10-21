// Ficha de póliza: estado efectivo (GET /policies/:id → effectiveStatus) en el
// encabezado y en la lista de accesorias, y bloque "Accesoria de ..." con el
// vínculo válido o el motivo del vínculo inválido.
// Monta el componente REAL (react-dom/client sobre jsdom, mismo patrón que
// poliza-detail-next-rebilling-notice.test.tsx), fetch mockeado. Datos sintéticos.
//
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/poliza-detail-effective-status.test.tsx
import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { JSDOM } from "jsdom";

const POLICY_ID = 77;
const TEST_TIMEOUT_MS = 120_000;

const basePolicy = {
  id: POLICY_ID, policyNumber: "SINT-0001", type: "automotor", status: "activa", companyId: 1, insuredId: 1, premium: 30000,
  sumInsured: null, coverageType: null, monthlyFee: 10000, deductible: null, billingCycle: null, installments: 3,
  vigencyPeriod: null, paymentMethod: "manual", startDate: "2025-01-01", endDate: "2026-01-01", nextRebillingDate: null,
  notes: null, vehicleBrand: null, vehicleModel: null, vehicleYear: null, vehiclePlate: null, isFleet: 0, propertyAddress: null,
  motoBrand: null, motoModel: null, motoYear: null, motoPlate: null, motoEngine: null, businessName: null, businessActivity: null,
  isRebilling: 0, renewedFromId: null, parentPolicyId: null, createdBy: 1, createdAt: "2025-01-01T12:00:00.000Z", updatedAt: null,
  cancelledAt: null, cancellationEffectiveDate: null, cancellationReason: null, cancellationNotes: null, cancelledBy: null,
  cancellationSource: null, cashPaymentAmountCents: null,
};
const response = (over: Record<string, any>) => ({
  policy: basePolicy,
  company: { id: 1, name: "Compañía QA", cuit: null, phone: null, email: null, createdAt: "2025-01-01T12:00:00.000Z" },
  insured: { id: 1, name: "Asegurado Sintético", dni: null, phone: null, email: null, address: null, createdBy: 1, createdAt: "2025-01-01T12:00:00.000Z" },
  rebillings: [], installments: [], subPolicies: [], cancelledByName: null, invalidatedByNames: {},
  effectiveStatus: "activa", parentPolicy: null, accessoryLink: null,
  ...over,
});

let dom: JSDOM;
const originalGlobals: Record<string, any> = {};
let routes: Record<string, any> = {};

function installFetch() {
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    if (!(key in routes)) throw new Error(`Unmocked fetch in test: ${key}`);
    return { ok: true, status: 200, json: async () => routes[key] } as any;
  };
}
async function flush(ticks = 10) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const actualWouter = await import("wouter");
mock.module("wouter", () => ({ ...actualWouter, useParams: () => ({ id: String(POLICY_ID) }) }));

async function render(body: any) {
  routes = { [`GET /api/policies/${POLICY_ID}`]: body };
  installFetch();
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { default: PolizaDetail } = await import("../poliza-detail");
  const { AuthProvider } = await import("../../lib/auth");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container as any);
  await act(async () => { root.render(React.createElement(AuthProvider, null, React.createElement(PolizaDetail))); await flush(); });
  return { container, unmount: async () => { await act(async () => root.unmount()); } };
}
const headerBadges = (c: Element) =>
  Array.from(c.querySelector("h1")!.parentElement!.querySelectorAll("span")).map((s) => s.textContent?.trim());

describe("Ficha — estado efectivo y vínculo de accesoria", () => {
  beforeAll(() => {
    dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: `http://localhost/polizas/${POLICY_ID}` });
    const keys = ["window", "document", "navigator", "localStorage", "HTMLInputElement", "HTMLElement", "HTMLSelectElement", "HTMLFormElement", "Event", "MouseEvent", "Node", "customElements", "location", "history"] as const;
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

  test("guardada activa con fin pasado → encabezado 'Vencida'; accesorias con su estado efectivo", async () => {
    const ui = await render(response({
      effectiveStatus: "vencida",
      subPolicies: [{ policy: { ...basePolicy, id: 78, policyNumber: "SINT-0001-AP", type: "accidentes_pasajeros", parentPolicyId: POLICY_ID }, company: null, insured: null, effectiveStatus: "vencida" }],
    }));
    try {
      const badges = headerBadges(ui.container);
      expect(badges).toContain("Vencida");
      expect(badges).not.toContain("Activa");
      const accList = Array.from(ui.container.querySelectorAll("p")).find((p) => p.textContent?.startsWith("Pólizas accesorias"))!.closest("div.mt-6")!;
      expect(accList.textContent).toContain("SINT-0001-AP");
      expect(accList.textContent).toContain("Vencida");
      expect(ui.container.textContent).not.toContain("Accesoria de");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("cancelada se muestra cancelada aunque llegue sin estado efectivo", async () => {
    const ui = await render(response({ policy: { ...basePolicy, status: "cancelada" }, effectiveStatus: undefined }));
    try {
      expect(headerBadges(ui.container)).toContain("Cancelada");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("accesoria con vínculo válido → 'Accesoria de' con enlace a la principal, sin alerta", async () => {
    const ui = await render(response({
      policy: { ...basePolicy, type: "accidentes_pasajeros", parentPolicyId: 88, endDate: "2099-01-01" },
      parentPolicy: { id: 88, policyNumber: "SINT-PRINC", type: "automotor", status: "activa", effectiveStatus: "activa", startDate: "2098-01-01", endDate: "2099-01-01" },
      accessoryLink: { valid: true, reason: null, reasonLabel: null },
    }));
    try {
      expect(ui.container.textContent).toContain("Accesoria de");
      const link = Array.from(ui.container.querySelectorAll("a")).find((a) => a.textContent === "SINT-PRINC")!;
      expect(link.getAttribute("href")).toBe("/polizas/88");
      expect(ui.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("vínculo inválido → alerta con el motivo; principal inexistente → sin enlace", async () => {
    const ui = await render(response({
      policy: { ...basePolicy, type: "accidentes_pasajeros", parentPolicyId: 999, endDate: "2099-01-01" },
      parentPolicy: null,
      accessoryLink: { valid: false, reason: "principal_inexistente", reasonLabel: "La póliza principal vinculada no existe" },
    }));
    try {
      expect(ui.container.textContent).toContain("póliza principal inexistente");
      const alert = ui.container.querySelector('[role="alert"]')!;
      expect(alert.textContent).toContain("La póliza principal vinculada no existe");
      expect(alert.textContent).toContain("Vínculos a revisar");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
