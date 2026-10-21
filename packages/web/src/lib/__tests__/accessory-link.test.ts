// Vínculo accesoria → principal (lib/policies/accessory-link.ts) y agrupación
// en proyecciones (lib/policies/accessory-grouping.ts). Fixtures sintéticos.
import { describe, test, expect } from "bun:test";
import { evaluateAccessoryLink, accessoryLinkReasonLabel, type AccessoryLinkPolicy } from "../policies/accessory-link";
import { classifyAccessoryLinks, groupAccessoriesUnderPrincipals } from "../policies/accessory-grouping";

const TODAY = "2026-10-19";
const END = "2027-03-01";

const principal = (over: Partial<AccessoryLinkPolicy> = {}): AccessoryLinkPolicy =>
  ({ id: 1, parentPolicyId: null, companyId: 10, insuredId: 100, status: "activa", endDate: END, ...over });
const accessory = (over: Partial<AccessoryLinkPolicy> = {}): AccessoryLinkPolicy =>
  ({ id: 2, parentPolicyId: 1, companyId: 10, insuredId: 100, status: "activa", endDate: END, ...over });

describe("evaluateAccessoryLink", () => {
  test("válido: misma compañía, asegurado y fecha final, principal vigente (inicio puede diferir)", () => {
    expect(evaluateAccessoryLink(accessory(), principal(), TODAY)).toEqual({ valid: true, reason: null });
    // Principal por vencer por estado efectivo también es vigente.
    expect(evaluateAccessoryLink(accessory({ endDate: "2026-11-01" }), principal({ endDate: "2026-11-01" }), TODAY).valid).toBe(true);
  });

  const cases: [string, AccessoryLinkPolicy, AccessoryLinkPolicy | null][] = [
    ["vinculo_a_si_misma", accessory({ parentPolicyId: 2 }), accessory({ parentPolicyId: 2 })],
    ["principal_inexistente", accessory(), null],
    ["principal_es_accesoria", accessory(), principal({ parentPolicyId: 99 })],
    ["otra_compania", accessory(), principal({ companyId: 11 })],
    ["otro_asegurado", accessory(), principal({ insuredId: 101 })],
    ["principal_no_vigente", accessory(), principal({ status: "cancelada" })],
    ["principal_no_vigente", accessory(), principal({ status: "renovada" })],
    // Guardada "activa" pero vencida por fecha → no vigente por estado efectivo.
    ["principal_no_vigente", accessory({ endDate: "2026-10-18" }), principal({ status: "activa", endDate: "2026-10-18" })],
    ["distinta_fecha_final", accessory({ endDate: "2027-02-28" }), principal()],
  ];
  for (const [reason, acc, par] of cases) {
    test(`inválido: ${reason}`, () => {
      const r = evaluateAccessoryLink(acc, par, TODAY);
      expect(r).toEqual({ valid: false, reason: reason as any });
      expect(accessoryLinkReasonLabel(r.reason)).toBeTruthy();
    });
  }
  test("principal con id distinto al vínculo cuenta como inexistente", () => {
    expect(evaluateAccessoryLink(accessory(), principal({ id: 7 }), TODAY).reason).toBe("principal_inexistente");
  });
  test("sin motivo → sin etiqueta", () => {
    expect(accessoryLinkReasonLabel(null)).toBeNull();
  });
});

describe("groupAccessoriesUnderPrincipals", () => {
  const rows = [
    { ...principal(), premium: 1000 },
    { ...accessory(), premium: 150.25 },
    { ...accessory({ id: 3 }), premium: 49.75 },
    // Accesoria inválida (otra fecha final): fila propia.
    { ...accessory({ id: 4, endDate: "2027-02-28" }), premium: 80 },
    // Otra principal sin accesorias.
    { ...principal({ id: 5, insuredId: 200 }), premium: 500 },
  ];
  const parents = new Map<number, AccessoryLinkPolicy>(rows.map((r) => [r.id, r]));
  const links = classifyAccessoryLinks(rows, parents, TODAY);

  test("un movimiento por grupo; prima principal + accesorias exactamente una vez", () => {
    const grouped = groupAccessoriesUnderPrincipals(rows, links);
    expect(grouped.map((g) => g.id)).toEqual([1, 4, 5]);
    const g1 = grouped.find((g) => g.id === 1)!;
    expect(g1).toMatchObject({ groupPremium: 1200, accessoryCount: 2, accessoryIds: [2, 3], premium: 1000 });
    expect(grouped.find((g) => g.id === 4)).toMatchObject({ groupPremium: 80, accessoryCount: 0 });
    // Total = suma de las primas originales: nadie se cuenta dos veces ni se pierde.
    const total = grouped.reduce((s, g) => s + (g.groupPremium ?? 0), 0);
    expect(total).toBe(rows.reduce((s, r) => s + r.premium, 0));
  });

  test("accesoria válida cuya principal no está en el conjunto conserva su fila", () => {
    const onlyAcc = rows.filter((r) => r.id === 2);
    const grouped = groupAccessoriesUnderPrincipals(onlyAcc, links);
    expect(grouped.map((g) => [g.id, g.groupPremium, g.accessoryCount])).toEqual([[2, 150.25, 0]]);
  });

  test("primas nulas: el grupo suma las presentes; todas nulas → null", () => {
    const r2 = [{ ...principal(), premium: null }, { ...accessory(), premium: 70 }];
    expect(groupAccessoriesUnderPrincipals(r2, classifyAccessoryLinks(r2, new Map(r2.map((r) => [r.id, r])), TODAY))[0])
      .toMatchObject({ groupPremium: 70, accessoryCount: 1 });
    const r3 = [{ ...principal(), premium: null }, { ...accessory(), premium: null }];
    expect(groupAccessoriesUnderPrincipals(r3, classifyAccessoryLinks(r3, new Map(r3.map((r) => [r.id, r])), TODAY))[0].groupPremium).toBeNull();
  });

  test("sin vínculos: identidad (cada fila, su prima)", () => {
    const plain = [{ ...principal(), premium: 10 }, { ...principal({ id: 9 }), premium: 20 }];
    expect(groupAccessoriesUnderPrincipals(plain, new Map()).map((g) => [g.id, g.groupPremium, g.accessoryCount])).toEqual([[1, 10, 0], [9, 20, 0]]);
  });
});
