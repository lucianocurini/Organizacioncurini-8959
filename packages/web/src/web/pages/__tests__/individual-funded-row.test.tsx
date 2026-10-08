// Fila de "Pago individual" con saldo en el listado de Cobranzas — badge,
// detalle (saldo aplicado / saldo deudor / medios reales / total cancelado) y
// acciones (solo notas o "Anular cobro"; rendido → sin anular). Render
// estático sobre un jsdom aislado (mismo criterio de globals que el resto de
// los tests de cobranzas.tsx).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";

let dom: JSDOM;
const originalGlobals: Record<string, any> = {};

const FUNDING = {
  kind: "individual_account_funded" as const, batchId: 41, batchStatus: "confirmado",
  totalCancelledCents: 10000000, realReceivedCents: 7000000, creditAppliedCents: 3000000, newDebtCents: 0, newCreditCents: 0, roundingCoveredCents: 0,
};

describe("fila de pago individual con saldo", () => {
  beforeAll(async () => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
    for (const key of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node"] as const) {
      originalGlobals[key] = (globalThis as any)[key];
      (globalThis as any)[key] = (dom.window as any)[key];
    }
    await import("../cobranzas");
  }, 120_000);
  afterAll(() => {
    for (const key of Object.keys(originalGlobals)) {
      if (originalGlobals[key] === undefined) delete (globalThis as any)[key];
      else (globalThis as any)[key] = originalGlobals[key];
    }
    dom.window.close();
  });

  async function render(el: any): Promise<string> {
    const { renderToStaticMarkup } = await import("react-dom/server");
    return renderToStaticMarkup(el);
  }

  test("badge 'Pago individual' y detalle con saldo aplicado, medios reales y total cancelado", async () => {
    const React = await import("react");
    const { IndividualFundedBadge, IndividualFundedRowDetails } = await import("../cobranzas");
    const html = await render(React.createElement("div", null,
      React.createElement(IndividualFundedBadge), React.createElement(IndividualFundedRowDetails, { funding: FUNDING })));
    expect(html).toContain("Pago individual");
    expect(html).toContain("Saldo aplicado");
    expect(html).toContain("Medios reales");
    expect(html).toContain("Total cancelado");
    expect(html).not.toContain("Saldo deudor");
    expect(html).not.toContain("lote");
  });

  test("con saldo deudor lo muestra", async () => {
    const React = await import("react");
    const { IndividualFundedRowDetails } = await import("../cobranzas");
    const html = await render(React.createElement(IndividualFundedRowDetails, { funding: { ...FUNDING, creditAppliedCents: 0, newDebtCents: 3000000 } }));
    expect(html).toContain("Saldo deudor");
  });

  test("acciones: notas + Anular cobro; rendido → sin anular; anulado → sin acciones; nunca Eliminar/Editar pago", async () => {
    const React = await import("react");
    const { IndividualFundedRowActions } = await import("../cobranzas");
    const noop = () => {};
    const live = await render(React.createElement(IndividualFundedRowActions, { status: "confirmado", rendered: false, onCancel: noop, onEditNotes: noop, compact: true }));
    expect(live).toContain("Anular cobro");
    expect(live).toContain("Notas");
    expect(live).not.toContain("Eliminar");
    const rendered = await render(React.createElement(IndividualFundedRowActions, { status: "confirmado", rendered: true, onCancel: noop, onEditNotes: noop, compact: true }));
    expect(rendered).not.toContain("Anular cobro");
    expect(rendered).toContain("Rendido");
    const cancelled = await render(React.createElement(IndividualFundedRowActions, { status: "anulado", rendered: false, onCancel: noop, onEditNotes: noop }));
    expect(cancelled).toBe("");
  });
});
