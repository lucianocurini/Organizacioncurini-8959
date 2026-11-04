import { describe, test, expect } from "bun:test";
import {
  type CollectablePolicyOption,
  buildCollectablePoliciesQuery, parseCollectablePoliciesResponse, parseCollectablePolicyIds,
  policySelectorKey, isPolicySelectorReady, groupPolicySelectorOptions,
  isSelectedPolicyStillSelectable, detachUnavailablePolicy, resolveCartPolicyCollectability,
  NO_PENDING_INSTALLMENTS_LABEL, ACCESSORY_LINK_TO_REVIEW_LABEL, OUT_OF_POSITION_LABEL,
} from "../payment-policy-selector";

function opt(id: number, o: Partial<CollectablePolicyOption> & { parentPolicyId?: number | null; number?: string; insuredName?: string } = {}): CollectablePolicyOption {
  return {
    policy: {
      id, policyNumber: o.number ?? `POL-${id}`, status: "activa", type: "automotor", insuredId: 1, companyId: 1,
      parentPolicyId: o.parentPolicyId ?? null, startDate: "2026-01-01", endDate: "2026-12-31",
    },
    insured: { id: 1, name: o.insuredName ?? "Asegurado" },
    company: { id: 1, name: "Compañía" },
    collectable: o.collectable ?? true,
    via: o.via === undefined ? "poliza_vigente" : o.via,
    reason: o.reason ?? null,
    hasCollectableInstallments: o.hasCollectableInstallments ?? true,
    accessory: o.accessory ?? null,
  };
}

describe("consulta y parseo (fail closed)", () => {
  test("la consulta siempre lleva la fecha; includePolicyId solo si se pasa", () => {
    expect(buildCollectablePoliciesQuery({ paymentDate: "2026-11-03" })).toBe("/api/policies/collectable-for-payment?paymentDate=2026-11-03");
    expect(buildCollectablePoliciesQuery({ paymentDate: "2026-11-03", includePolicyId: 7 })).toBe("/api/policies/collectable-for-payment?paymentDate=2026-11-03&includePolicyId=7");
  });
  test("respuesta inválida → null (nunca 'todas')", () => {
    expect(parseCollectablePoliciesResponse(null)).toBeNull();
    expect(parseCollectablePoliciesResponse({})).toBeNull();
    expect(parseCollectablePoliciesResponse([{ policy: { id: 1, policyNumber: "X" } }])).toBeNull();
    expect(parseCollectablePoliciesResponse([{ policy: { id: "1", policyNumber: "X" }, collectable: true }])).toBeNull();
    expect(parseCollectablePoliciesResponse([])).toEqual([]);
    expect(parseCollectablePoliciesResponse([opt(1)])).toHaveLength(1);
    expect(parseCollectablePolicyIds([opt(1), opt(2, { collectable: false, via: null })])).toEqual(new Set([1]));
    expect(parseCollectablePolicyIds("x")).toBeNull();
  });
  test("lista lista solo con estado ok y la clave actual (fecha + póliza incluida)", () => {
    const key = policySelectorKey("2026-11-03");
    expect(isPolicySelectorReady({ status: "ok", key, options: [] }, key)).toBe(true);
    expect(isPolicySelectorReady({ status: "ok", key, options: [] }, policySelectorKey("2026-11-04"))).toBe(false);
    expect(isPolicySelectorReady({ status: "loading", key, options: [] }, key)).toBe(false);
    expect(isPolicySelectorReady({ status: "error", key, options: [] }, key)).toBe(false);
    expect(isPolicySelectorReady(null, key)).toBe(false);
    expect(policySelectorKey("2026-11-03", 5)).not.toBe(policySelectorKey("2026-11-03"));
  });
});

describe("agrupación de accesorias y etiquetas", () => {
  const principal = opt(10, { number: "PRIN-10" });
  const acc = opt(11, { parentPolicyId: 10, accessory: { parentPolicyId: 10, parentPolicyNumber: "PRIN-10", linkValid: true } });
  const accInvalida = opt(12, { parentPolicyId: 10, accessory: { parentPolicyId: 10, parentPolicyNumber: "PRIN-10", linkValid: false } });
  const accHuerfana = opt(13, { parentPolicyId: 99, accessory: { parentPolicyId: 99, parentPolicyNumber: "VIEJA-99", linkValid: true } });
  const otra = opt(20, { number: "OTRA-20", hasCollectableInstallments: false, via: "ultima_terminada" });

  test("cada accesoria con vínculo válido va debajo de su principal como 'Accesoria de …'", () => {
    const entries = groupPolicySelectorOptions([acc, principal, otra]);
    expect(entries.map((e) => [e.option.policy.id, e.kind])).toEqual([[10, "principal"], [11, "accessory"], [20, "principal"]]);
    expect(entries[1]!.accessoryLabel).toBe("Accesoria de PRIN-10");
  });

  test("principal ausente o vínculo inválido → se conserva suelta como 'Accesoria — vínculo a revisar'", () => {
    const entries = groupPolicySelectorOptions([principal, accInvalida, accHuerfana]);
    expect(entries.map((e) => [e.option.policy.id, e.kind])).toEqual([[10, "principal"], [12, "accessory_to_review"], [13, "accessory_to_review"]]);
    expect(entries[1]!.accessoryLabel).toBe(ACCESSORY_LINK_TO_REVIEW_LABEL);
  });

  test("badges: vía y 'sin cuotas pendientes'; la incluida fuera de posición se marca", () => {
    const [e] = groupPolicySelectorOptions([otra]);
    expect(e!.badges).toEqual(["Última terminada", NO_PENDING_INSTALLMENTS_LABEL]);
    const [f] = groupPolicySelectorOptions([opt(30, { collectable: false, via: null, reason: "SIN_POLIZA_VIGENTE_EN_CADENA" })]);
    expect(f!.badges).toEqual([OUT_OF_POSITION_LABEL]);
  });

  test("búsqueda: la principal aparece si coincide una accesoria; la accesoria aparece si coincide la principal", () => {
    const accBuscada = opt(11, { number: "ACC-ZZ", parentPolicyId: 10, accessory: { parentPolicyId: 10, parentPolicyNumber: "PRIN-10", linkValid: true } });
    expect(groupPolicySelectorOptions([principal, accBuscada, otra], "zz").map((e) => e.option.policy.id)).toEqual([10, 11]);
    expect(groupPolicySelectorOptions([principal, accBuscada, otra], "prin").map((e) => e.option.policy.id)).toEqual([10, 11]);
    expect(groupPolicySelectorOptions([principal, accBuscada, otra], "otra").map((e) => e.option.policy.id)).toEqual([20]);
  });
});

describe("desvinculación", () => {
  test("la póliza elegida sigue disponible solo si está en la lista y en posición cobrable", () => {
    expect(isSelectedPolicyStillSelectable("", [])).toBe(true);
    expect(isSelectedPolicyStillSelectable("1", [opt(1)])).toBe(true);
    expect(isSelectedPolicyStillSelectable("1", [opt(2)])).toBe(false);
    expect(isSelectedPolicyStillSelectable("1", [opt(1, { collectable: false, via: null })])).toBe(false);
  });
  test("se limpian póliza, cuota, vencimiento e importe; el resto se conserva", () => {
    const f = { policyId: "1", installmentId: "5", dueDate: "2026-11-01", amount: "1000", notes: "n", paymentDate: "2026-11-03" };
    expect(detachUnavailablePolicy(f)).toEqual({ policyId: "", installmentId: "", dueDate: "", amount: "", notes: "n", paymentDate: "2026-11-03" });
  });
});

describe("carrito de lote: cobros manuales con póliza", () => {
  const cart = [
    { kind: "installment", installmentId: 1 },
    { kind: "policy_manual_payment", policyId: 10, localId: "m1" },
    { kind: "policy_manual_payment", policyId: 20, localId: "m2" },
  ];
  const D = "2026-11-03";
  test("sin cobros manuales con póliza no aplica", () => {
    expect(resolveCartPolicyCollectability([{ kind: "installment", installmentId: 1 }], { status: "loading", paymentDate: D }, D).kind).toBe("not_needed");
  });
  test("fail closed: cargando, error, fecha inválida o resultado de otra fecha bloquean", () => {
    expect(resolveCartPolicyCollectability(cart, { status: "loading", paymentDate: D }, D)).toMatchObject({ kind: "checking", canConfirm: false });
    expect(resolveCartPolicyCollectability(cart, { status: "error", paymentDate: D }, D)).toMatchObject({ kind: "error", canConfirm: false });
    expect(resolveCartPolicyCollectability(cart, { status: "invalid_date", paymentDate: D }, D)).toMatchObject({ kind: "invalid_date", canConfirm: false });
    expect(resolveCartPolicyCollectability(cart, { status: "ok", paymentDate: "2026-11-04", collectablePolicyIds: new Set([10, 20]) }, D)).toMatchObject({ kind: "checking", canConfirm: false });
  });
  test("cambio de fecha: los cobros cuya póliza salió de posición quedan marcados y bloquean", () => {
    expect(resolveCartPolicyCollectability(cart, { status: "ok", paymentDate: D, collectablePolicyIds: new Set([10, 20]) }, D)).toEqual({ kind: "ok", canConfirm: true, unavailableLocalIds: [] });
    expect(resolveCartPolicyCollectability(cart, { status: "ok", paymentDate: D, collectablePolicyIds: new Set([10]) }, D)).toEqual({ kind: "unavailable", canConfirm: false, unavailableLocalIds: ["m2"] });
  });
});
