// Ficha de póliza: aviso de "próxima refacturación requiere revisión manual"
// después de alta / borrado de una refacturación, a partir de
// nextRebillingDateSync (ver src/web/lib/next-rebilling-notice.ts). Sin aviso
// cuando la sincronización fue segura.
// Monta el componente REAL (react-dom/client sobre jsdom, mismo patrón que
// poliza-detail-duplicate-audit-render.test.tsx), fetch mockeado. Datos sintéticos.
//
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/poliza-detail-next-rebilling-notice.test.tsx
import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { JSDOM } from "jsdom";
import { nextRebillingSyncNotice } from "../../lib/next-rebilling-notice";

const POLICY_ID = 77;
const TEST_TIMEOUT_MS = 120_000;

const POLICY_RESPONSE = {
  policy: {
    id: POLICY_ID, policyNumber: "SINT-0001", type: "automotor", status: "activa", companyId: 1, insuredId: 1, premium: 30000,
    sumInsured: null, coverageType: null, monthlyFee: 10000, deductible: null, billingCycle: "trimestral", installments: 3,
    vigencyPeriod: null, paymentMethod: "manual", startDate: "2026-01-01", endDate: "2027-12-31", nextRebillingDate: "2026-11-01",
    notes: null, vehicleBrand: null, vehicleModel: null, vehicleYear: null, vehiclePlate: null, isFleet: 0, propertyAddress: null,
    motoBrand: null, motoModel: null, motoYear: null, motoPlate: null, motoEngine: null, businessName: null, businessActivity: null,
    isRebilling: 0, renewedFromId: null, parentPolicyId: null, createdBy: 1, createdAt: "2026-01-01T12:00:00.000Z", updatedAt: null,
    cancelledAt: null, cancellationEffectiveDate: null, cancellationReason: null, cancellationNotes: null, cancelledBy: null,
    cancellationSource: null, cashPaymentAmountCents: null,
  },
  company: { id: 1, name: "Compañía QA", cuit: null, phone: null, email: null, createdAt: "2026-01-01T12:00:00.000Z" },
  insured: { id: 1, name: "Asegurado Sintético", dni: null, phone: null, email: null, address: null, createdBy: 1, createdAt: "2026-01-01T12:00:00.000Z" },
  rebillings: [
    { id: 5, policyId: POLICY_ID, billingStart: "2026-08-01", billingEnd: "2026-10-31", premium: 30000, monthlyFee: 10000, sumInsured: null,
      notes: null, installmentCount: 3, firstDueDate: "2026-08-01", deductible: null, createdBy: 1, createdAt: "2026-08-01T12:00:00.000Z",
      cashPaymentAmountCents: null, status: "activa", duplicateOfRebillingId: null, invalidatedAt: null, invalidatedBy: null, invalidationReason: null },
  ],
  installments: [],
  subPolicies: [],
  cancelledByName: null,
  invalidatedByNames: {},
};

const CLEARED = {
  status: "cleared", before: "2026-11-01", after: null, kind: "review", reason: "sin_refacturaciones",
  reasonLabel: "Tiene frecuencia de refacturación pero ninguna refacturación cargada",
};
const REVIEW = { status: "review", before: null, after: null, kind: "review", reason: "periodo_irregular",
  reasonLabel: "El último período no termina ni el día anterior ni el mismo día del inicio siguiente" };
const UPDATED = { status: "updated", before: "2026-08-01", after: "2026-11-01", kind: "safe", reason: null, reasonLabel: null };

let dom: JSDOM;
const originalGlobals: Record<string, any> = {};
let routes: Record<string, any> = {};
const calls: string[] = [];

function installFetch() {
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    if (!(key in routes)) throw new Error(`Unmocked fetch in test: ${key}`);
    return { ok: true, status: 200, json: async () => routes[key] } as any;
  };
}
async function flush(ticks = 10) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const actualWouter = await import("wouter");
mock.module("wouter", () => ({ ...actualWouter, useParams: () => ({ id: String(POLICY_ID) }) }));

async function renderPolizaDetail() {
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { default: PolizaDetail } = await import("../poliza-detail");
  const { AuthProvider } = await import("../../lib/auth");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container as any);
  await act(async () => { root.render(React.createElement(AuthProvider, null, React.createElement(PolizaDetail))); await flush(); });
  return {
    container, act,
    unmount: async () => { await act(async () => root.unmount()); },
  };
}
const notice = (c: Element) => c.querySelector('[data-testid="next-rebilling-notice"]');

async function deleteFlow(sync: any) {
  routes = {
    [`GET /api/policies/${POLICY_ID}`]: POLICY_RESPONSE,
    "DELETE /api/rebillings/5": { ok: true, deleted: { rebilling: 1, installments: 0 }, nextRebillingDateSync: sync },
  };
  installFetch();
  const ui = await renderPolizaDetail();
  expect(notice(ui.container)).toBeNull();
  const btn = ui.container.querySelector('button[title="Eliminar"]') as HTMLButtonElement;
  expect(btn).toBeTruthy();
  await ui.act(async () => { btn.click(); await flush(); });
  expect(calls).toContain("DELETE /api/rebillings/5");
  return ui;
}

describe("nextRebillingSyncNotice", () => {
  test("revisión y fecha limpiada → aviso; sincronización segura o sin datos → sin aviso", () => {
    expect(nextRebillingSyncNotice(CLEARED)).toBe(
      "La próxima refacturación guardada (01/11/2026) quedó sin respaldo y se borró. Requiere revisión manual. Motivo: Tiene frecuencia de refacturación pero ninguna refacturación cargada.",
    );
    expect(nextRebillingSyncNotice(REVIEW)).toBe(
      "La próxima refacturación requiere revisión manual: no hay una fecha segura. Motivo: El último período no termina ni el día anterior ni el mismo día del inicio siguiente.",
    );
    for (const status of ["updated", "unchanged", "kept_explicit", "renewal", "not_applicable"]) {
      expect(nextRebillingSyncNotice({ status })).toBeNull();
    }
    expect(nextRebillingSyncNotice(null)).toBeNull();
    expect(nextRebillingSyncNotice(undefined)).toBeNull();
  });
});

describe("Ficha — aviso de próxima refacturación", () => {
  beforeAll(() => {
    dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: `http://localhost/polizas/${POLICY_ID}` });
    const keys = ["window", "document", "navigator", "localStorage", "HTMLInputElement", "HTMLElement", "HTMLSelectElement", "HTMLFormElement", "Event", "MouseEvent", "Node", "customElements", "location", "history"] as const;
    for (const key of keys) {
      originalGlobals[key] = (globalThis as any)[key];
      (globalThis as any)[key] = (dom.window as any)[key];
    }
    originalGlobals.fetch = (globalThis as any).fetch;
    originalGlobals.confirm = (globalThis as any).confirm;
    (globalThis as any).confirm = () => true;
    (dom.window as any).confirm = () => true;
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

  test("borrado que deja la fecha sin respaldo → aviso de revisión manual", async () => {
    const ui = await deleteFlow(CLEARED);
    try {
      const n = notice(ui.container);
      expect(n).toBeTruthy();
      expect(n!.getAttribute("role")).toBe("alert");
      expect(n!.textContent).toContain("Requiere revisión manual");
      expect(n!.textContent).toContain("01/11/2026");
      // Se puede cerrar.
      const close = n!.querySelector('button[aria-label="Cerrar aviso"]') as HTMLButtonElement;
      await ui.act(async () => { close.click(); await flush(); });
      expect(notice(ui.container)).toBeNull();
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("borrado con sincronización segura → sin aviso", async () => {
    const ui = await deleteFlow(UPDATED);
    try {
      expect(notice(ui.container)).toBeNull();
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  async function createFlow(sync: any) {
    routes = {
      [`GET /api/policies/${POLICY_ID}`]: POLICY_RESPONSE,
      [`POST /api/policies/${POLICY_ID}/rebillings`]: { id: 6, installments: [], nextRebillingDateSync: sync },
    };
    installFetch();
    const ui = await renderPolizaDetail();
    const open = Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Nueva refacturación")) as HTMLButtonElement;
    await ui.act(async () => { open.click(); await flush(); });
    const submit = Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Registrar refacturación") as HTMLButtonElement;
    expect(submit).toBeTruthy();
    await ui.act(async () => { submit.click(); await flush(); });
    expect(calls).toContain(`POST /api/policies/${POLICY_ID}/rebillings`);
    return ui;
  }

  test("alta desde la ficha con revisión → aviso", async () => {
    calls.length = 0;
    const ui = await createFlow(REVIEW);
    try {
      expect(notice(ui.container)?.textContent).toContain("requiere revisión manual");
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);

  test("alta desde la ficha con sincronización segura → sin aviso", async () => {
    calls.length = 0;
    const ui = await createFlow(UPDATED);
    try {
      expect(notice(ui.container)).toBeNull();
    } finally {
      await ui.unmount();
    }
  }, TEST_TIMEOUT_MS);
});
