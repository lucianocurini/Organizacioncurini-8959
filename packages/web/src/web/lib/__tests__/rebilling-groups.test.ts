/**
 * Tests de la agrupación pura de cuotas por refacturación
 * (src/web/lib/rebilling-groups.ts). Sin DOM, sin fetch.
 */

import { test, expect, describe } from "bun:test";
import { groupInstallmentsByRebilling, summarizeInstallments, countLinkedInstallments } from "../rebilling-groups";

const original = [
  { id: 1, number: 1, dueDate: "2027-01-01", amount: 1000, status: "pagada", notes: null, rebillingId: null },
  { id: 2, number: 2, dueDate: "2027-02-01", amount: 1000, status: "pendiente", notes: null, rebillingId: null },
];

const rebA = { id: 10, billingStart: "2027-06-01", billingEnd: "2027-08-31", deductible: 50000 };
const rebB = { id: 11, billingStart: "2027-03-01", billingEnd: "2027-05-31", deductible: null };

const instA = [
  { id: 3, number: 1, dueDate: "2027-06-01", amount: 500, status: "pendiente", notes: null, rebillingId: 10 },
  { id: 4, number: 2, dueDate: "2027-07-01", amount: 500, status: "pendiente", notes: null, rebillingId: 10 },
];
const instB = [
  { id: 5, number: 1, dueDate: "2027-03-01", amount: 700, status: "vencida", notes: null, rebillingId: 11 },
];

describe("groupInstallmentsByRebilling", () => {
  test("agrupa emisión original + refacturaciones, orden: original primero, luego por billingStart ascendente", () => {
    const groups = groupInstallmentsByRebilling([...original, ...instA, ...instB], [rebA, rebB]);
    expect(groups.map((g) => g.key)).toEqual(["original", "11", "10"]); // rebB (marzo) antes que rebA (junio)
    expect(groups[0]!.label).toBe("Emisión original");
    expect(groups[0]!.installments.length).toBe(2);
    expect(groups[1]!.rebillingId).toBe(11);
    expect(groups[1]!.installments.length).toBe(1);
    expect(groups[2]!.rebillingId).toBe(10);
    expect(groups[2]!.installments.length).toBe(2);
  });

  test("numeración de cada grupo se preserva tal cual viene (reinicia en 1 por grupo, ya generada por el backend)", () => {
    const groups = groupInstallmentsByRebilling([...original, ...instA], [rebA]);
    const originalGroup = groups.find((g) => g.key === "original")!;
    const rebGroup = groups.find((g) => g.key === "10")!;
    expect(originalGroup.installments.map((i) => i.number)).toEqual([1, 2]);
    expect(rebGroup.installments.map((i) => i.number)).toEqual([1, 2]);
  });

  test("franquicia del grupo viene de rebillings.deductible, null si no se informó", () => {
    const groups = groupInstallmentsByRebilling([...instA, ...instB], [rebA, rebB]);
    expect(groups.find((g) => g.key === "10")!.deductible).toBe(50000);
    expect(groups.find((g) => g.key === "11")!.deductible).toBeNull();
  });

  test("sin cuotas de emisión original, no aparece el grupo 'original'", () => {
    const groups = groupInstallmentsByRebilling([...instA], [rebA]);
    expect(groups.find((g) => g.key === "original")).toBeUndefined();
  });

  test("refacturación histórica sin cuotas generadas igual aparece, con installments: []", () => {
    const rebHistorica = { id: 20, billingStart: "2027-09-01", billingEnd: "2027-11-30", deductible: null };
    const groups = groupInstallmentsByRebilling([...original], [rebHistorica]);
    const histGroup = groups.find((g) => g.key === "20");
    expect(histGroup).toBeDefined();
    expect(histGroup!.installments).toEqual([]);
  });

  test("no reemplaza ni oculta grupos anteriores al agregar uno nuevo", () => {
    const groups = groupInstallmentsByRebilling([...original, ...instA, ...instB], [rebA, rebB]);
    expect(groups.length).toBe(3);
    expect(groups.every((g) => g.installments.length > 0 || g.key !== "original")).toBe(true);
  });
});

describe("countLinkedInstallments — cantidad real por rebilling_id (nunca installmentCount)", () => {
  test("refacturación sin cuotas vinculadas → 0 (dispara el banner 'sin plan vinculado')", () => {
    expect(countLinkedInstallments([...original, ...instA], 999)).toBe(0);
  });

  test("refacturación con cuotas vinculadas → cuenta exacta (no dispara el banner)", () => {
    expect(countLinkedInstallments([...original, ...instA, ...instB], 10)).toBe(2);
    expect(countLinkedInstallments([...original, ...instA, ...instB], 11)).toBe(1);
  });

  test("no cuenta cuotas de la emisión original (rebillingId null) ni de otra refacturación", () => {
    const count = countLinkedInstallments([...original, ...instA, ...instB], 10);
    expect(count).toBe(instA.length); // no suma original.length ni instB.length
  });

  test("lista vacía de cuotas → 0", () => {
    expect(countLinkedInstallments([], 10)).toBe(0);
  });
});

describe("summarizeInstallments", () => {
  test("totales globales sobre TODAS las cuotas, todos los grupos combinados", () => {
    const totals = summarizeInstallments([...original, ...instA, ...instB]);
    expect(totals.total).toBe(5);
    expect(totals.pagadas).toBe(1);
    expect(totals.pendientes).toBe(3);
    expect(totals.vencidas).toBe(1);
  });

  test("lista vacía → todos los totales en cero", () => {
    expect(summarizeInstallments([])).toEqual({ total: 0, pagadas: 0, pendientes: 0, vencidas: 0 });
  });
});
