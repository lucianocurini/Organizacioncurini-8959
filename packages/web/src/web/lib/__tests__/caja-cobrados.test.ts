/**
 * Tests de los helpers puros de la lista de cobros pendientes de rendición
 * y de las etiquetas de origen de adeudados (src/web/lib/caja-cobrados.ts).
 * Sin DOM, sin fetch.
 */

import { test, expect, describe } from "bun:test";
import { filterPendingCashItems, formatAdeudadoOrigin } from "../caja-cobrados";

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
