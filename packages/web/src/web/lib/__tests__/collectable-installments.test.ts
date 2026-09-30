import { describe, test, expect } from "bun:test";
import {
  buildPendingForPaymentQuery, toInstallmentOptions, isSelectedInstallmentStillCollectable,
  findUnavailableCartInstallmentIds, looksLikeIsoDate, parseCollectableInstallmentIds, resolveCartCollectability,
  detachUnavailableInstallment,
} from "../collectable-installments";
import { buildCashPeriodSearchQuery } from "../cash-period-payment-form";

describe("collectable-installments (frontend de la regla única)", () => {
  test("detachUnavailableInstallment: limpia cuota, vencimiento e importe y conserva el resto", () => {
    const form = { policyId: "7", installmentId: "12", dueDate: "2026-10-10", amount: "1500", paymentDate: "2026-10-20", notes: "x" };
    expect(detachUnavailableInstallment(form)).toEqual({
      policyId: "7", installmentId: "", dueDate: "", amount: "", paymentDate: "2026-10-20", notes: "x",
    });
    // No muta el original.
    expect(form.installmentId).toBe("12");
  });

  test("buildPendingForPaymentQuery: siempre manda paymentDate; policyId solo si viene", () => {
    expect(buildPendingForPaymentQuery({ paymentDate: "2026-09-25" })).toBe("/api/installments/pending-for-payment?paymentDate=2026-09-25");
    expect(buildPendingForPaymentQuery({ paymentDate: "2026-09-25", policyId: 7 })).toBe("/api/installments/pending-for-payment?policyId=7&paymentDate=2026-09-25");
    expect(buildPendingForPaymentQuery({ paymentDate: "2026-09-25", policyId: "" })).toBe("/api/installments/pending-for-payment?paymentDate=2026-09-25");
  });

  test("toInstallmentOptions adapta la respuesta al selector de 'Imputar pago', ordenada por vencimiento", () => {
    const rows = [
      { installmentId: 2, installmentNumber: 2, dueDate: "2026-11-01", amount: 10, status: "pendiente", policyId: 1 },
      { installmentId: 1, installmentNumber: 1, dueDate: "2026-10-01", amount: 10, status: "vencida", policyId: 1 },
    ];
    expect(toInstallmentOptions(rows)).toEqual([
      { id: 1, number: 1, dueDate: "2026-10-01", amount: 10, status: "vencida", rendered: 0 },
      { id: 2, number: 2, dueDate: "2026-11-01", amount: 10, status: "pendiente", rendered: 0 },
    ]);
  });

  test("isSelectedInstallmentStillCollectable: sin selección siempre válido; con selección, solo si sigue en la lista", () => {
    const options = [{ id: 1 }, { id: 2 }];
    expect(isSelectedInstallmentStillCollectable("", options)).toBe(true);
    expect(isSelectedInstallmentStillCollectable("2", options)).toBe(true);
    expect(isSelectedInstallmentStillCollectable("3", options)).toBe(false);
  });

  test("findUnavailableCartInstallmentIds: solo cuotas del carrito ausentes de la lista cobrable; ignora cobros manuales", () => {
    const cart = [
      { kind: "installment", installmentId: 1 },
      { kind: "installment", installmentId: 2 },
      { kind: "policy_manual_payment" },
      { kind: "manual_payment" },
    ];
    expect(findUnavailableCartInstallmentIds(cart, new Set([1]))).toEqual([2]);
    expect(findUnavailableCartInstallmentIds(cart, new Set([1, 2]))).toEqual([]);
  });

  test("looksLikeIsoDate", () => {
    expect(looksLikeIsoDate("2026-09-25")).toBe(true);
    expect(looksLikeIsoDate("")).toBe(false);
    expect(looksLikeIsoDate("25/09/2026")).toBe(false);
  });

  test("parseCollectableInstallmentIds: respuesta válida → ids; inválida → null (nunca 'todas disponibles')", () => {
    expect(parseCollectableInstallmentIds([{ installmentId: 1 }, { installmentId: 2 }])).toEqual(new Set([1, 2]));
    expect(parseCollectableInstallmentIds([])).toEqual(new Set());
    expect(parseCollectableInstallmentIds(null)).toBeNull();
    expect(parseCollectableInstallmentIds({ error: "x" })).toBeNull();
    expect(parseCollectableInstallmentIds([{ installmentId: "1" }])).toBeNull();
    expect(parseCollectableInstallmentIds([{ id: 1 }])).toBeNull();
    expect(parseCollectableInstallmentIds([null])).toBeNull();
  });

  describe("resolveCartCollectability (fail closed, atado a la fecha actual)", () => {
    const cart = [{ kind: "installment", installmentId: 1 }, { kind: "installment", installmentId: 2 }];
    const D = "2026-09-25";

    test("carrito sin cuotas: no aplica, se puede confirmar aunque la consulta haya fallado", () => {
      expect(resolveCartCollectability([{ kind: "manual_payment" }], { status: "error", paymentDate: D }, D))
        .toEqual({ kind: "not_needed", canConfirm: true, unavailableIds: [] });
    });

    test("cargando, error y fecha inválida bloquean", () => {
      expect(resolveCartCollectability(cart, { status: "loading", paymentDate: D }, D).kind).toBe("checking");
      expect(resolveCartCollectability(cart, { status: "error", paymentDate: D }, D)).toEqual({ kind: "error", canConfirm: false, unavailableIds: [] });
      expect(resolveCartCollectability(cart, { status: "invalid_date", paymentDate: "2026-09" }, "2026-09").canConfirm).toBe(false);
    });

    test("un resultado OK de OTRA fecha nunca habilita la fecha actual", () => {
      const r = resolveCartCollectability(cart, { status: "ok", paymentDate: "2026-09-24", collectableIds: new Set([1, 2]) }, D);
      expect(r).toEqual({ kind: "checking", canConfirm: false, unavailableIds: [] });
    });

    test("resultado de la fecha actual: agregar o quitar ítems se evalúa contra el mismo resultado", () => {
      const check = { status: "ok" as const, paymentDate: D, collectableIds: new Set([1]) };
      expect(resolveCartCollectability(cart, check, D)).toEqual({ kind: "unavailable", canConfirm: false, unavailableIds: [2] });
      expect(resolveCartCollectability([cart[0]!], check, D)).toEqual({ kind: "ok", canConfirm: true, unavailableIds: [] });
    });
  });

  test("buildCashPeriodSearchQuery: siempre manda policyId y la fecha de pago elegida", () => {
    expect(buildCashPeriodSearchQuery({ policyId: 7, paymentDate: "2026-10-02" }))
      .toBe("/api/policies/cash-period-search?policyId=7&paymentDate=2026-10-02");
  });
});
