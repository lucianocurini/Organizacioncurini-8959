/**
 * Tests puros de la clasificación de grupos duplicados para el saneamiento
 * histórico (Migración 0035). Sin DB — src/lib/installments/duplicate-remediation.ts.
 */
import { test, expect, describe } from "bun:test";
import {
  classifyInstallmentDuplicateGroup, classifyRebillingDuplicateGroup,
  type InstallmentDuplicateMember, type RebillingDuplicateMember,
} from "../../lib/installments/duplicate-remediation";

function inst(overrides: Partial<InstallmentDuplicateMember>): InstallmentDuplicateMember {
  return {
    id: 1, status: "pendiente", rendered: 0, number: 1, notes: null,
    hasAnyPayment: false, hasRemittanceItem: false, hasAccountMovement: false,
    ...overrides,
  };
}

describe("classifyInstallmentDuplicateGroup — grupo con una cuota pagada (16 grupos)", () => {
  test("pagada es siempre la canónica, la gemela pendiente se invalida", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 10, status: "pagada" }),
      inst({ id: 11, status: "pendiente" }),
    ]);
    expect(decision.kind).toBe("invalidate");
    if (decision.kind === "invalidate") {
      expect(decision.canonicalId).toBe(10);
      expect(decision.duplicateIds).toEqual([11]);
      expect(decision.reasonKind).toBe("paid_is_canonical");
    }
  });

  test("pagada es canónica sin importar que su id sea MAYOR que el de la gemela", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 20, status: "pendiente" }),
      inst({ id: 19, status: "pagada" }),
    ]);
    expect(decision.kind).toBe("invalidate");
    if (decision.kind === "invalidate") expect(decision.canonicalId).toBe(19);
  });

  test("gemela vencida también se invalida (no solo pendiente)", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 1, status: "pagada" }),
      inst({ id: 2, status: "vencida" }),
    ]);
    expect(decision.kind).toBe("invalidate");
    if (decision.kind === "invalidate") expect(decision.duplicateIds).toEqual([2]);
  });

  test("3 miembros, 1 pagada + 2 gemelas → invalida ambas gemelas", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 1, status: "pendiente" }),
      inst({ id: 2, status: "pagada" }),
      inst({ id: 3, status: "vencida" }),
    ]);
    expect(decision.kind).toBe("invalidate");
    if (decision.kind === "invalidate") {
      expect(decision.canonicalId).toBe(2);
      expect(decision.duplicateIds.sort()).toEqual([1, 3]);
    }
  });
});

describe("classifyInstallmentDuplicateGroup — grupo totalmente inactivo (587 grupos)", () => {
  test("todas pendientes/vencidas, sin actividad → conserva el id menor", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 5, status: "pendiente" }),
      inst({ id: 3, status: "vencida" }),
    ]);
    expect(decision.kind).toBe("invalidate");
    if (decision.kind === "invalidate") {
      expect(decision.canonicalId).toBe(3);
      expect(decision.duplicateIds).toEqual([5]);
      expect(decision.reasonKind).toBe("lowest_id_equivalent");
    }
  });

  test("number distinto entre miembros → skip (propiedades no equivalentes)", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 1, number: 1 }),
      inst({ id: 2, number: 2 }),
    ]);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/number/);
  });

  test("notes distinto (no vacío) entre miembros → skip", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 1, notes: "endoso especial" }),
      inst({ id: 2, notes: null }),
    ]);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/notes/);
  });

  test("notes ambos null o ambos '' → equivalente, no bloquea", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 2, notes: "" }),
      inst({ id: 1, notes: null }),
    ]);
    expect(decision.kind).toBe("invalidate");
  });
});

describe("classifyInstallmentDuplicateGroup — reglas de aborto (nunca invalidación parcial)", () => {
  test("ambas pagadas → skip, grupo completo", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 1, status: "pagada" }),
      inst({ id: 2, status: "pagada" }),
    ]);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/más de una cuota pagada/);
  });

  test("cualquier miembro rendido → skip", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 1, status: "pendiente" }),
      inst({ id: 2, status: "pendiente", rendered: 1 }),
    ]);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/rendida/);
  });

  test("pago anulado en una gemela no pagada → skip (un pago de cualquier estado es actividad real)", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 1, status: "pagada" }),
      inst({ id: 2, status: "pendiente", hasAnyPayment: true }),
    ]);
    expect(decision.kind).toBe("skip");
  });

  test("remittance_item en cualquier miembro → skip", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 1, status: "pendiente" }),
      inst({ id: 2, status: "pendiente", hasRemittanceItem: true }),
    ]);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/remittance_item/);
  });

  test("movimiento de cuenta en cualquier miembro → skip", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 1, status: "pendiente" }),
      inst({ id: 2, status: "pendiente", hasAccountMovement: true }),
    ]);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/movimiento de cuenta/);
  });

  test("gemela en estado 'no_exigible' junto a una pagada → skip (estado inesperado)", () => {
    const decision = classifyInstallmentDuplicateGroup([
      inst({ id: 1, status: "pagada" }),
      inst({ id: 2, status: "no_exigible" }),
    ]);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/estado inesperado/);
  });

  test("grupo de un solo miembro → skip (nada que invalidar)", () => {
    const decision = classifyInstallmentDuplicateGroup([inst({ id: 1 })]);
    expect(decision.kind).toBe("skip");
  });
});

// ─── Refacturaciones ────────────────────────────────────────────────────────

function reb(overrides: Partial<RebillingDuplicateMember>): RebillingDuplicateMember {
  return {
    id: 1, billingStart: "2027-01-01", billingEnd: "2027-04-01", premium: 1000,
    ownInstallmentsFullyAccountedFor: true, hasDeliveryReference: false, hasCashPeriodReference: false,
    ...overrides,
  };
}

describe("classifyRebillingDuplicateGroup — 114 grupos", () => {
  test("todas las condiciones limpias → conserva el id menor, invalida el resto", () => {
    const decision = classifyRebillingDuplicateGroup([reb({ id: 50 }), reb({ id: 12 }), reb({ id: 33 })]);
    expect(decision.kind).toBe("invalidate");
    if (decision.kind === "invalidate") {
      expect(decision.canonicalId).toBe(12);
      expect(decision.duplicateIds.sort((a, b) => a - b)).toEqual([33, 50]);
    }
  });

  test("una duplicada con cuotas propias no contabilizadas → skip el grupo completo", () => {
    const decision = classifyRebillingDuplicateGroup([
      reb({ id: 1 }),
      reb({ id: 2, ownInstallmentsFullyAccountedFor: false }),
    ]);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/cuotas propias/);
  });

  test("una duplicada con delivery vinculado → skip el grupo completo", () => {
    const decision = classifyRebillingDuplicateGroup([
      reb({ id: 1 }),
      reb({ id: 2, hasDeliveryReference: true }),
    ]);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/Envíos y Entregas/);
  });

  test("una duplicada con pago de contado por período vinculado → skip el grupo completo", () => {
    const decision = classifyRebillingDuplicateGroup([
      reb({ id: 1 }),
      reb({ id: 2, hasCashPeriodReference: true }),
    ]);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/contado por período/);
  });

  test("grupo de un solo miembro → skip", () => {
    expect(classifyRebillingDuplicateGroup([reb({ id: 1 })]).kind).toBe("skip");
  });

  test("la CANÓNICA (id menor) nunca se valida a sí misma — solo importa el estado de las demás", () => {
    // La canónica podría en teoría tener cualquier referencia (es la que se conserva activa) —
    // el chequeo solo aplica a los miembros que se van a invalidar.
    const decision = classifyRebillingDuplicateGroup([
      reb({ id: 1, hasDeliveryReference: true }), // canónica, con delivery real — no bloquea
      reb({ id: 2 }),
    ]);
    expect(decision.kind).toBe("invalidate");
  });
});
