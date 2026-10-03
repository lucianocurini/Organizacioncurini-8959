/**
 * Tests de los helpers puros de la lista de cobros pendientes de rendición
 * y de las etiquetas de origen de adeudados (src/web/lib/caja-cobrados.ts).
 * Sin DOM, sin fetch.
 */

import { test, expect, describe } from "bun:test";
import {
  buildCajaPendingCobranzaRows, createLatestRequestTracker, filterPendingCashItems, formatAdeudadoOrigin,
  loadCajaRemittancePending, parseCajaRemittancePending,
} from "../caja-cobrados";

describe("buildCajaPendingCobranzaRows — pago de contado agrupado", () => {
  // Hijos del contado (batch 50): nominal por cuota, método "contado".
  const children = [
    { id: 11, amount: 60000, batchId: 50, paymentMethod: "contado" },
    { id: 12, amount: 60000, batchId: 50, paymentMethod: "contado" },
    { id: 13, amount: 60000, batchId: 50, paymentMethod: "contado" },
  ];
  const standalone = { id: 1, amount: 1000, batchId: null, paymentMethod: "efectivo" };
  const loteChild = { id: 2, amount: 2500.5, batchId: 77, paymentMethod: "lote" };
  const contado = { source: "payment_batch", paymentBatchId: 50, amount: 165000, blocked: false };

  test("contado con 3 cuotas aparece una sola vez, en el lugar de su primer hijo, y sin las hijas", () => {
    const { rows } = buildCajaPendingCobranzaRows([standalone, ...children, loteChild], [contado]);
    expect(rows.map((r) => (r.kind === "payment" ? `p${r.payment.id}` : `c${r.item.paymentBatchId}`))).toEqual(["p1", "c50", "p2"]);
  });

  test("suma visible usa el contado aplicado (165.000), no el nominal (180.000)", () => {
    const { totalCents } = buildCajaPendingCobranzaRows([standalone, ...children, loteChild], [contado]);
    expect(totalCents).toBe(100000 + 16500000 + 250050);
  });

  test("pagos individuales y lotes normales sin cambios cuando no hay contados", () => {
    const pending = [standalone, loteChild];
    const { rows, totalCents, blockedCount } = buildCajaPendingCobranzaRows(pending, [
      // Ítems no-contado de /remittances/pending se ignoran.
      { source: "payment", paymentBatchId: 77, amount: 2500.5 } as any,
    ]);
    expect(rows).toEqual([{ kind: "payment", payment: standalone }, { kind: "payment", payment: loteChild }]);
    expect(totalCents).toBe(100000 + 250050);
    expect(blockedCount).toBe(0);
  });

  test("contado bloqueado: visible como fila, fuera de la suma y contado aparte", () => {
    const blocked = { ...contado, blocked: true };
    const { rows, totalCents, blockedCount } = buildCajaPendingCobranzaRows([standalone, ...children], [blocked]);
    expect(rows).toEqual([{ kind: "payment", payment: standalone }, { kind: "cash_period", item: blocked }]);
    expect(totalCents).toBe(100000);
    expect(blockedCount).toBe(1);
  });

  test("contado sin hijos visibles (p. ej. bloqueado sin cuotas) va al final, no se oculta", () => {
    const orphan = { source: "payment_batch", paymentBatchId: 99, amount: 5000, blocked: true };
    const { rows } = buildCajaPendingCobranzaRows([standalone], [orphan]);
    expect(rows).toEqual([{ kind: "payment", payment: standalone }, { kind: "cash_period", item: orphan }]);
  });
});

describe("filterPendingCashItems", () => {
  test("payment con rendered=0 aparece", () => {
    const items = [{ id: 1, rendered: 0 }];
    expect(filterPendingCashItems(items)).toEqual([{ id: 1, rendered: 0 }]);
  });

  test("payment con rendered=1 NO aparece", () => {
    const items = [{ id: 1, rendered: 1 }];
    expect(filterPendingCashItems(items)).toEqual([]);
  });

  test("cash_entry con rendered=0 aparece", () => {
    const items = [{ id: 2, rendered: false }];
    expect(filterPendingCashItems(items)).toEqual([{ id: 2, rendered: false }]);
  });

  test("cash_entry con rendered=1 NO aparece", () => {
    const items = [{ id: 2, rendered: true }];
    expect(filterPendingCashItems(items)).toEqual([]);
  });

  test("mezcla de pendientes y rendidos — solo quedan los pendientes, en el mismo orden", () => {
    const items = [
      { id: 1, rendered: 0 }, { id: 2, rendered: 1 }, { id: 3, rendered: 0 }, { id: 4, rendered: 1 },
    ];
    expect(filterPendingCashItems(items).map((i) => i.id)).toEqual([1, 3]);
  });

  test("lista vacía devuelve lista vacía", () => {
    expect(filterPendingCashItems([])).toEqual([]);
  });
});

describe("formatAdeudadoOrigin", () => {
  test("installment -> 'Cuota no cobrada'", () => {
    expect(formatAdeudadoOrigin("installment")).toBe("Cuota no cobrada");
  });

  test("manual_debt -> 'Deuda manual'", () => {
    expect(formatAdeudadoOrigin("manual_debt")).toBe("Deuda manual");
  });

  test("cash_debt_legacy -> 'Deuda manual anterior'", () => {
    expect(formatAdeudadoOrigin("cash_debt_legacy")).toBe("Deuda manual anterior");
  });
});

describe("loadCajaRemittancePending — fail-closed", () => {
  const contado = { source: "payment_batch", paymentBatchId: 50, amount: 165000, blocked: false };

  test("respuesta válida → ok con los ítems tal cual", async () => {
    const items = [contado, { source: "payment", sourceId: 1, amount: 1000 }];
    const r = await loadCajaRemittancePending(async () => items);
    expect(r).toEqual({ ok: true, items: items as any });
  });

  test("pide exactamente /api/remittances/pending", async () => {
    const paths: string[] = [];
    await loadCajaRemittancePending(async (p) => { paths.push(p); return []; });
    expect(paths).toEqual(["/api/remittances/pending"]);
  });

  test("error de red/HTTP → ok:false, nunca rechaza", async () => {
    const r = await loadCajaRemittancePending(async () => { throw new Error("Error de red"); });
    expect(r).toEqual({ ok: false });
  });

  test("respuesta inválida → ok:false (no un [] que dejaría ver las cuotas hijas)", async () => {
    for (const raw of [null, undefined, { error: "x" }, "[]", [null], [contado, 3]]) {
      expect(await loadCajaRemittancePending(async () => raw)).toEqual({ ok: false });
    }
    expect(parseCajaRemittancePending([{ source: "payment_batch", paymentBatchId: "50", amount: 1 }])).toBeNull();
    expect(parseCajaRemittancePending([{ source: "payment_batch", paymentBatchId: 50 }])).toBeNull();
  });

  test("array vacío es válido (no hay pendientes)", () => {
    expect(parseCajaRemittancePending([])).toEqual([]);
  });

  test("respuesta inválida, en la lista: con ok:false Caja no llama a buildCajaPendingCobranzaRows; con [] lo haría mal", () => {
    // Documenta por qué no se degrada a []: las hijas aparecerían sueltas.
    const children = [{ id: 11, amount: 60000, batchId: 50 }, { id: 12, amount: 60000, batchId: 50 }];
    expect(buildCajaPendingCobranzaRows(children, []).rows.every((r) => r.kind === "payment")).toBe(true);
  });
});

describe("createLatestRequestTracker — respuestas desfasadas", () => {
  test("solo la última carga iniciada es vigente", () => {
    const tracker = createLatestRequestTracker();
    const first = tracker.begin();
    expect(first.isCurrent()).toBe(true);
    const second = tracker.begin();
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  test("una carga vieja que resuelve después de la nueva se descarta", async () => {
    const tracker = createLatestRequestTracker();
    const applied: string[] = [];
    let releaseOld!: () => void;
    const oldDone = new Promise<void>((r) => { releaseOld = r; });
    async function load(tag: string, wait: Promise<void>) {
      const req = tracker.begin();
      await wait;
      if (req.isCurrent()) applied.push(tag);
    }
    const oldLoad = load("vieja", oldDone);
    await load("nueva", Promise.resolve());
    releaseOld();
    await oldLoad;
    expect(applied).toEqual(["nueva"]);
  });
});
