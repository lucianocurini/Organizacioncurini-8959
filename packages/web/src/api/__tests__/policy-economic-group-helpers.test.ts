/**
 * Tests del helper puro de agrupación económica Rivadavia + Accidentes de
 * Pasajeros — src/lib/payments/policy-economic-group.ts. Sin DB, sin HTTP.
 */

import { test, expect, describe } from "bun:test";
import {
  resolvePolicyEconomicGroup, isSurchargeAbsorbedByGroup, ACCESSORY_POLICY_TYPE,
  type PolicyForEconomicGroup,
} from "../../lib/payments/policy-economic-group";

function policy(overrides: Partial<PolicyForEconomicGroup>): PolicyForEconomicGroup {
  return { id: 1, type: "automotor", parentPolicyId: null, ...overrides };
}

describe("resolvePolicyEconomicGroup", () => {
  test("A. Rivadavia principal sola (sin parentPolicyId) → single, groupKey propio", () => {
    const principal = policy({ id: 100, type: "automotor" });
    const result = resolvePolicyEconomicGroup(principal, new Set([100]));
    expect(result).toEqual({ policyId: 100, kind: "single", groupKey: 100, parentPolicyId: null });
  });

  test("B. accesoria accidentes_pasajeros con principal presente en scope → accesoria_agrupada, groupKey = principal", () => {
    const accesoria = policy({ id: 200, type: ACCESSORY_POLICY_TYPE, parentPolicyId: 100 });
    const result = resolvePolicyEconomicGroup(accesoria, new Set([100, 200]));
    expect(result).toEqual({ policyId: 200, kind: "accesoria_agrupada", groupKey: 100, parentPolicyId: 100 });
  });

  test("B. la principal del grupo sigue siendo 'single' (su groupKey es ella misma)", () => {
    const principal = policy({ id: 100, type: "automotor" });
    const result = resolvePolicyEconomicGroup(principal, new Set([100, 200]));
    expect(result.kind).toBe("single");
    expect(result.groupKey).toBe(100);
  });

  test("C. dos pólizas Rivadavia independientes (ninguna accesoria de la otra) → cada una single, groupKeys distintos", () => {
    const p1 = policy({ id: 100, type: "automotor" });
    const p2 = policy({ id: 300, type: "automotor" });
    const r1 = resolvePolicyEconomicGroup(p1, new Set([100, 300]));
    const r2 = resolvePolicyEconomicGroup(p2, new Set([100, 300]));
    expect(r1.groupKey).not.toBe(r2.groupKey);
    expect(r1.kind).toBe("single");
    expect(r2.kind).toBe("single");
  });

  test("D. accesoria SIN parentPolicyId → single, nunca inventa un vínculo", () => {
    const accesoria = policy({ id: 200, type: ACCESSORY_POLICY_TYPE, parentPolicyId: null });
    const result = resolvePolicyEconomicGroup(accesoria, new Set([200]));
    expect(result).toEqual({ policyId: 200, kind: "single", groupKey: 200, parentPolicyId: null });
  });

  test("D. accesoria con parentPolicyId cuyo padre NO está en el batch/cart → ambiguo, groupKey propio", () => {
    const accesoria = policy({ id: 200, type: ACCESSORY_POLICY_TYPE, parentPolicyId: 999 });
    const result = resolvePolicyEconomicGroup(accesoria, new Set([200])); // 999 no está en scope
    expect(result).toEqual({ policyId: 200, kind: "ambiguo", groupKey: 200, parentPolicyId: 999 });
  });
});

describe("isSurchargeAbsorbedByGroup", () => {
  test("principal sola → no absorbida (genera su propio recargo)", () => {
    expect(isSurchargeAbsorbedByGroup(policy({ id: 100, type: "automotor" }), new Set([100]))).toBe(false);
  });

  test("accesoria con principal presente → absorbida (no genera recargo propio)", () => {
    const accesoria = policy({ id: 200, type: ACCESSORY_POLICY_TYPE, parentPolicyId: 100 });
    expect(isSurchargeAbsorbedByGroup(accesoria, new Set([100, 200]))).toBe(true);
  });

  test("accesoria sin parentPolicyId → no absorbida", () => {
    const accesoria = policy({ id: 200, type: ACCESSORY_POLICY_TYPE, parentPolicyId: null });
    expect(isSurchargeAbsorbedByGroup(accesoria, new Set([200]))).toBe(false);
  });

  test("accesoria cuyo padre no está en el batch/cart → no absorbida (conservador)", () => {
    const accesoria = policy({ id: 200, type: ACCESSORY_POLICY_TYPE, parentPolicyId: 999 });
    expect(isSurchargeAbsorbedByGroup(accesoria, new Set([200]))).toBe(false);
  });

  test("dos cuotas de la MISMA póliza (no accesoria) → ninguna absorbida, cada una cuenta su propio recargo", () => {
    const p = policy({ id: 100, type: "automotor" });
    // Simula 2 ítems (cuotas) de la misma póliza en el mismo batch — el
    // scope solo tiene ids únicos de póliza, pero el chequeo se hace una
    // vez por ítem/cuota, no una vez por póliza — ver calculateApplicableRivadaviaSurcharges.
    expect(isSurchargeAbsorbedByGroup(p, new Set([100]))).toBe(false);
    expect(isSurchargeAbsorbedByGroup(p, new Set([100]))).toBe(false);
  });
});
