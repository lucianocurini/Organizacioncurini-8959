// Regresión de PRESENTACIÓN para el crash reportado en QA visual local
// (2026-08-17): /polizas/1 quedaba en pantalla completamente en blanco.
// Causa real: `poliza-detail.tsx:1114` hacía
// `new Date(Number(d.invalidatedAt) * 1000).toISOString()` asumiendo que
// `invalidatedAt` llega como epoch en SEGUNDOS (number) — pero Drizzle
// (`mode: "timestamp"`) + `c.json()` lo serializan como Date → string ISO.
// `Number("2026-08-17T22:40:12.000Z")` es NaN, `new Date(NaN)` es inválida,
// y `.toISOString()` sobre una fecha inválida LANZA `RangeError: Invalid
// time value` — sin error boundary, eso tira abajo TODO el árbol de React.
//
// Este test monta el componente REAL (react-dom/client sobre jsdom, mismo
// patrón que payment-modal-cash-period-wiring.test.tsx) con el payload EXACTO
// devuelto por GET /api/policies/1 contra la base QA local (capturado el
// 17/08/2026 vía curl con sesión real) — reproduce el bug tal cual lo vio
// Luciano en el navegador, no una versión simplificada.
//
// Ejecutar con: bun test packages/web/src/web/pages/__tests__/poliza-detail-duplicate-audit-render.test.tsx
import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { JSDOM } from "jsdom";

const POLICY_ID = 1;

// Payload EXACTO de GET /api/policies/1 contra dev.db reconstruido por
// packages/web/scripts/local-qa-build-db.ts (login real, sesión real,
// capturado 2026-08-17T22:52 vía curl). Nunca editado a mano para "esconder"
// el problema — invalidatedAt llega como string ISO en las 4 filas
// afectadas, tal cual lo sirve la API real.
const QA_POLICY_1_RESPONSE = {
  policy: { id: 1, policyNumber: "POL-DUP-0001", type: "automotor", status: "activa", companyId: 1, insuredId: 1, premium: 50000, sumInsured: 8000000, coverageType: null, monthlyFee: null, deductible: null, billingCycle: null, installments: 12, vigencyPeriod: null, paymentMethod: "manual", startDate: "2026-01-01", endDate: "2026-12-31", nextRebillingDate: null, notes: null, vehicleBrand: "Volkswagen", vehicleModel: "Gol Trend", vehicleYear: 2020, vehiclePlate: "AB123CD", isFleet: 0, propertyAddress: null, motoBrand: null, motoModel: null, motoYear: null, motoPlate: null, motoEngine: null, businessName: null, businessActivity: null, isRebilling: 0, renewedFromId: null, parentPolicyId: null, createdBy: 1, createdAt: "2026-08-17T22:40:12.000Z", updatedAt: null, cancelledAt: null, cancellationEffectiveDate: null, cancellationReason: null, cancellationNotes: null, cancelledBy: null, cancellationSource: null, cashPaymentAmountCents: null },
  company: { id: 1, name: "El Norte Seguros", cuit: "30-12345678-9", phone: null, email: null, createdAt: "2026-08-17T22:40:12.000Z" },
  insured: { id: 1, name: "Juan Pérez", dni: "30111222", phone: null, email: null, address: null, createdBy: 1, createdAt: "2026-08-17T22:40:12.000Z" },
  rebillings: [
    { id: 1, policyId: 1, billingStart: "2026-05-01", billingEnd: "2026-08-01", premium: 15000, monthlyFee: null, sumInsured: null, notes: null, installmentCount: 3, firstDueDate: null, deductible: null, createdBy: 1, createdAt: "2026-08-17T22:40:12.000Z", cashPaymentAmountCents: null, status: "activa", duplicateOfRebillingId: null, invalidatedAt: null, invalidatedBy: null, invalidationReason: null },
    { id: 2, policyId: 1, billingStart: "2026-05-01", billingEnd: "2026-08-01", premium: 15000, monthlyFee: null, sumInsured: null, notes: null, installmentCount: 3, firstDueDate: null, deductible: null, createdBy: 1, createdAt: "2026-08-17T22:40:12.000Z", cashPaymentAmountCents: null, status: "duplicada", duplicateOfRebillingId: 1, invalidatedAt: "2026-08-17T22:40:12.000Z", invalidatedBy: 1, invalidationReason: "Duplicado de importación — El Norte v2 (refacturación idéntica al período ya facturado)" },
  ],
  installments: [
    { id: 1, policyId: 1, number: 1, dueDate: "2026-01-10", amount: 4166.67, status: "pagada", notes: null, rendered: 0, renderedAt: null, rebillingId: null, createdAt: "2026-08-17T22:40:12.000Z", duplicateOfInstallmentId: null, invalidatedAt: null, invalidatedBy: null, invalidationReason: null },
    { id: 4, policyId: 1, number: 1, dueDate: "2026-05-01", amount: 5000, status: "vencida", notes: null, rendered: 0, renderedAt: null, rebillingId: 1, createdAt: "2026-08-17T22:40:12.000Z", duplicateOfInstallmentId: null, invalidatedAt: null, invalidatedBy: null, invalidationReason: null },
    { id: 7, policyId: 1, number: 1, dueDate: "2026-05-01", amount: 5000, status: "duplicada", notes: null, rendered: 0, renderedAt: null, rebillingId: 2, createdAt: "2026-08-17T22:40:12.000Z", duplicateOfInstallmentId: 4, invalidatedAt: "2026-08-17T22:40:12.000Z", invalidatedBy: 1, invalidationReason: "Duplicado de importación — El Norte v2 (refacturación idéntica al período ya facturado)" },
    { id: 2, policyId: 1, number: 2, dueDate: "2026-02-10", amount: 4166.67, status: "pagada", notes: null, rendered: 0, renderedAt: null, rebillingId: null, createdAt: "2026-08-17T22:40:12.000Z", duplicateOfInstallmentId: null, invalidatedAt: null, invalidatedBy: null, invalidationReason: null },
    { id: 5, policyId: 1, number: 2, dueDate: "2026-06-01", amount: 5000, status: "vencida", notes: null, rendered: 0, renderedAt: null, rebillingId: 1, createdAt: "2026-08-17T22:40:12.000Z", duplicateOfInstallmentId: null, invalidatedAt: null, invalidatedBy: null, invalidationReason: null },
    { id: 8, policyId: 1, number: 2, dueDate: "2026-06-01", amount: 5000, status: "duplicada", notes: null, rendered: 0, renderedAt: null, rebillingId: 2, createdAt: "2026-08-17T22:40:12.000Z", duplicateOfInstallmentId: 5, invalidatedAt: "2026-08-17T22:40:12.000Z", invalidatedBy: 1, invalidationReason: "Duplicado de importación — El Norte v2 (refacturación idéntica al período ya facturado)" },
    { id: 3, policyId: 1, number: 3, dueDate: "2026-03-10", amount: 4166.66, status: "vencida", notes: null, rendered: 0, renderedAt: null, rebillingId: null, createdAt: "2026-08-17T22:40:12.000Z", duplicateOfInstallmentId: null, invalidatedAt: null, invalidatedBy: null, invalidationReason: null },
    { id: 6, policyId: 1, number: 3, dueDate: "2026-07-01", amount: 5000, status: "vencida", notes: null, rendered: 0, renderedAt: null, rebillingId: 1, createdAt: "2026-08-17T22:40:12.000Z", duplicateOfInstallmentId: null, invalidatedAt: null, invalidatedBy: null, invalidationReason: null },
  ],
  subPolicies: [],
  cancelledByName: null,
  invalidatedByNames: { "1": "QA Duplicados" },
};

let dom: JSDOM;
let originalGlobals: Record<string, any> = {};

function installJsdomGlobals(url: string) {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url });
  const keys = ["window", "document", "navigator", "localStorage", "HTMLInputElement", "HTMLElement", "Event", "MouseEvent", "Node", "customElements", "location", "history"] as const;
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

function mockFetch(policyResponse: any) {
  (globalThis as any).fetch = async (input: any, _init?: any) => {
    const url = String(input);
    const jsonResponse = (body: any) => ({ ok: true, status: 200, json: async () => body });
    if (url === `/api/policies/${POLICY_ID}`) return jsonResponse(policyResponse) as any;
    throw new Error(`Unmocked fetch in test: ${url}`);
  };
}

// wouter's useParams necesita contexto de <Route> para resolver :id — se
// mockea SOLO ese hook (Link real se deja intacto, no necesita Router para
// renderizar un <a> simple) para poder montar <PolizaDetail/> standalone,
// mismo criterio de seam mínimo que mockear `fetch` para el límite de red.
const actualWouter = await import("wouter");
mock.module("wouter", () => ({ ...actualWouter, useParams: () => ({ id: String(POLICY_ID) }) }));

async function renderPolizaDetail() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const React = await import("react");
  const { default: PolizaDetail } = await import("../poliza-detail");
  // Sidebar (dentro de AppLayout, que PolizaDetail siempre renderiza) usa
  // useAuth() — no hay sesión en localStorage acá, así que AuthProvider no
  // dispara ningún fetch (ver auth.tsx: sin session_id, sólo setLoading(false))
  // y expone user=null, que Sidebar ya maneja con optional chaining.
  const { AuthProvider } = await import("../../lib/auth");

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container as any);

  await act(async () => {
    root.render(React.createElement(AuthProvider, null, React.createElement(PolizaDetail)));
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return { container, root };
}

describe("PolizaDetail — auditoría de duplicados (Migración 0035) no rompe el render", () => {
  beforeAll(() => installJsdomGlobals("http://localhost/polizas/1"));
  afterAll(() => restoreGlobals());

  test("con el payload EXACTO de GET /api/policies/1 (invalidatedAt como string ISO), el componente renderiza sin lanzar", async () => {
    mockFetch(QA_POLICY_1_RESPONSE);
    const { container, root } = await renderPolizaDetail();
    try {
      const text = container.textContent || "";

      // Antes del fix, este render nunca llegaba acá — `RangeError: Invalid
      // time value` durante el primer renderizado tiraba abajo el árbol
      // entero y `container.textContent` quedaba vacío ("" — la pantalla en
      // blanco que vio Luciano).
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("Invalid time value");

      // Ambos paneles de auditoría presentes con sus 2/1 filas respectivas.
      expect(text).toContain("Cuotas duplicadas (auditoría) — 2");
      expect(text).toContain("Refacturaciones duplicadas (auditoría) — 1");

      // invalidatedByNames resuelto — nombre real, no "Usuario #1".
      expect(text).toContain("QA Duplicados");
      expect(text).not.toContain("Usuario #1");

      // Fecha de invalidación (2026-08-17T22:40:12.000Z → 17/08 en Argentina,
      // UTC-3, sin cruce de medianoche) formateada, no "Fecha no disponible"
      // (el dato de este payload real ES válido).
      expect(text).toContain("17/08/2026");
      expect(text).not.toContain("Fecha no disponible");

      // Motivo de invalidación visible en ambos paneles.
      expect(text).toContain("Duplicado de importación — El Norte v2");
    } finally {
      const { act } = await import("react");
      await act(async () => { root.unmount(); });
    }
  });

  test("invalidatedAt corrupto (ni ISO ni epoch) muestra 'Fecha no disponible' en vez de romper la pantalla", async () => {
    const corrupted = {
      ...QA_POLICY_1_RESPONSE,
      installments: QA_POLICY_1_RESPONSE.installments.map((i) =>
        i.id === 7 ? { ...i, invalidatedAt: "no-es-una-fecha" } : i
      ),
    };
    mockFetch(corrupted);
    const { container, root } = await renderPolizaDetail();
    try {
      const text = container.textContent || "";
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("Invalid time value");
      expect(text).toContain("Fecha no disponible");
    } finally {
      const { act } = await import("react");
      await act(async () => { root.unmount(); });
    }
  });

  // Regresión encontrada en el vistazo visual real (2026-08-18), DESPUÉS de
  // corregido el crash de arriba: la sección operativa "Refacturaciones"
  // (contador + tarjetas con Editar/Corregir plan/Enviar/Eliminar) seguía
  // iterando `row.rebillings` SIN filtrar — la refacturación 'duplicada'
  // aparecía como una segunda tarjeta real, con sus propias acciones
  // operativas, mientras el panel de auditoría (abajo) ya mostraba
  // correctamente 1 sola duplicada. Causa: `rebillingsList` (poliza-detail.tsx)
  // era `row.rebillings ?? []` sin excluir status='duplicada' — a diferencia
  // de `realInstallmentsList`, que sí las excluye para cuotas.
  test("la sección operativa 'Refacturaciones' excluye la duplicada — 1 sola tarjeta, contador 1, canónica visible, duplicada solo en auditoría", async () => {
    mockFetch(QA_POLICY_1_RESPONSE);
    const { container, root } = await renderPolizaDetail();
    try {
      const refacturacionesHeading = Array.from(container.querySelectorAll("h2"))
        .find((h) => h.textContent?.trim() === "Refacturaciones") as HTMLElement;
      expect(refacturacionesHeading).toBeTruthy();

      // Sección operativa completa (contador + tarjetas) — ancestro directo
      // del <h2>Refacturaciones</h2>, ver poliza-detail.tsx ({hasRebilling && (<div className="mt-5">...
      const opSection = refacturacionesHeading.closest("div.mt-5") as HTMLElement;
      expect(opSection).toBeTruthy();

      // Contador junto al título — <span>{rebillingsList.length}</span>, próximo hermano del <h2>.
      const counterBadge = refacturacionesHeading.nextElementSibling as HTMLElement | null;
      expect(counterBadge?.textContent?.trim()).toBe("1");

      // 1 sola tarjeta real: "Editar datos"/"Eliminar" son títulos ÚNICOS de
      // la tarjeta de refacturación (grep confirmado, sin colisión en el
      // resto de la página) — 2 tarjetas hubieran dado 2 de cada uno.
      expect(opSection.querySelectorAll('button[title="Editar datos"]').length).toBe(1);
      expect(opSection.querySelectorAll('button[title="Corregir plan de cuotas"]').length).toBe(1);
      expect(opSection.querySelectorAll('button[title="Eliminar"]').length).toBe(1);
      // "Agregar a Envíos" SÍ colisiona con el botón general de la póliza
      // (fuera de esta sección) — se cuenta de nuevo, pero acotado a
      // opSection, así que solo ve la copia de la tarjeta.
      expect(opSection.querySelectorAll('button[title="Agregar a Envíos"]').length).toBe(1);

      // La canónica (activa) sigue visible operativamente: su período aparece dentro de opSection.
      expect(opSection.textContent).toContain("01/05/2026");
      expect(opSection.textContent).toContain("01/08/2026");

      // La duplicada aparece EXACTAMENTE una vez en todo el documento, y
      // exclusivamente dentro del panel de auditoría — nunca en opSection.
      const auditoriaHeading = Array.from(container.querySelectorAll("h3"))
        .find((h) => h.textContent?.includes("Refacturaciones duplicadas (auditoría)")) as HTMLElement;
      expect(auditoriaHeading?.textContent).toContain("— 1");
      const auditSection = auditoriaHeading.closest("div.mt-4") as HTMLElement;
      expect(auditSection.querySelectorAll("tbody tr").length).toBe(1);

      // Ninguna acción operativa (editar/reconstruir/enviar/eliminar) dentro
      // del panel de auditoría — es exclusivamente de lectura.
      expect(auditSection.querySelector('button[title="Editar datos"]')).toBeNull();
      expect(auditSection.querySelector('button[title="Corregir plan de cuotas"]')).toBeNull();
      expect(auditSection.querySelector('button[title="Eliminar"]')).toBeNull();
    } finally {
      const { act } = await import("react");
      await act(async () => { root.unmount(); });
    }
  });
});
