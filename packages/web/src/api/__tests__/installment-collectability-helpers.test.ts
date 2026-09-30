/**
 * Regla única de cobrabilidad de cuotas en Cobranzas — helper puro
 * (src/lib/payments/installment-collectability.ts). Sin DB.
 */
import { describe, test, expect } from "bun:test";
import {
  COLLECTIONS_MIN_DUE_DATE,
  buildRenewalChainIndex,
  evaluateInstallmentCollectability,
  resolveChainCurrentPolicy,
  summarizeCollectability,
  type CollectabilityInstallment,
  type CollectabilityPolicy,
} from "../../lib/payments/installment-collectability";

const D = "2026-09-25";

function pol(id: number, startDate: string | null, endDate: string | null, o: Partial<CollectabilityPolicy> = {}): CollectabilityPolicy {
  return { id, status: "activa", startDate, endDate, renewedFromId: null, cancellationEffectiveDate: null, ...o };
}
let nextInst = 1000;
function inst(policyId: number, dueDate: string | null, o: Partial<CollectabilityInstallment> = {}): CollectabilityInstallment {
  return { id: nextInst++, policyId, status: "pendiente", dueDate, rendered: 0, hasConfirmedPayment: false, ...o };
}
function evaluate(policies: CollectabilityPolicy[], i: CollectabilityInstallment, date = D) {
  return evaluateInstallmentCollectability(buildRenewalChainIndex(policies), i, date);
}
function reasonOf(policies: CollectabilityPolicy[], i: CollectabilityInstallment, date = D): string {
  const r = evaluate(policies, i, date);
  return r.collectable ? `OK:${r.via}` : r.reason;
}

describe("póliza vigente y cuotas", () => {
  test("cuota de póliza vigente → cobrable como poliza_vigente", () => {
    const p = [pol(1, "2026-01-01", "2026-12-31")];
    expect(evaluate(p, inst(1, "2026-08-01"))).toEqual({ collectable: true, via: "poliza_vigente", currentPolicyId: 1 });
  });

  test("cuota FUTURA de póliza vigente → cobrable sin límite adicional", () => {
    const p = [pol(1, "2026-01-01", "2027-12-31")];
    expect(reasonOf(p, inst(1, "2027-11-30"))).toBe("OK:poliza_vigente");
  });

  test("límites de vigencia inclusivos: inicio y fin exactos", () => {
    const p = [pol(1, "2026-09-25", "2026-12-31")];
    expect(reasonOf(p, inst(1, "2026-10-01"), "2026-09-25")).toBe("OK:poliza_vigente");
    expect(reasonOf(p, inst(1, "2026-10-01"), "2026-12-31")).toBe("OK:poliza_vigente");
    expect(reasonOf(p, inst(1, "2026-10-01"), "2027-01-01")).toBe("SIN_POLIZA_VIGENTE_EN_CADENA");
  });

  test("póliza futura: no aparece antes de su inicio, sí desde ese día", () => {
    const p = [pol(1, "2026-10-01", "2027-09-30")];
    expect(reasonOf(p, inst(1, "2026-10-15"), "2026-09-30")).toBe("POLIZA_FUTURA");
    expect(reasonOf(p, inst(1, "2026-10-15"), "2026-10-01")).toBe("OK:poliza_vigente");
  });
});

describe("fecha operativa mínima 2026-07-01 (inclusiva)", () => {
  test("constante", () => expect(COLLECTIONS_MIN_DUE_DATE).toBe("2026-07-01"));
  test("vence 2026-06-30 → excluida; vence 2026-07-01 → cobrable", () => {
    const p = [pol(1, "2026-01-01", "2026-12-31")];
    expect(reasonOf(p, inst(1, "2026-06-30"))).toBe("ANTERIOR_FECHA_MINIMA");
    expect(reasonOf(p, inst(1, "2026-07-01"))).toBe("OK:poliza_vigente");
  });
});

describe("cadena de renovación", () => {
  const chain = [
    pol(10, "2024-07-01", "2025-07-01", { status: "renovada" }),
    pol(11, "2025-07-01", "2026-07-01", { status: "renovada", renewedFromId: 10 }),
    pol(12, "2026-07-01", "2027-07-01", { renewedFromId: 11 }),
  ];

  test("antecesora directa con cuotas cobrables → admitida como antecesora_directa", () => {
    expect(evaluate(chain, inst(11, "2026-07-01"))).toEqual({ collectable: true, via: "antecesora_directa", currentPolicyId: 12 });
  });

  test("antecesora más antigua → excluida", () => {
    expect(reasonOf(chain, inst(10, "2026-07-05"))).toBe("ANTECESORA_MAS_ANTIGUA");
  });

  test("cadena sin póliza vigente: se ocultan las cuotas de la vencida", () => {
    const p = [pol(20, "2025-07-01", "2026-07-31")];
    expect(reasonOf(p, inst(20, "2026-07-15"))).toBe("SIN_POLIZA_VIGENTE_EN_CADENA");
  });

  test("renovación cargada pero futura: la vencida queda oculta y la nueva es futura", () => {
    const p = [pol(30, "2025-07-01", "2026-08-31", { status: "renovada" }), pol(31, "2026-10-01", "2027-10-01", { renewedFromId: 30 })];
    expect(reasonOf(p, inst(30, "2026-08-01"))).toBe("SIN_POLIZA_VIGENTE_EN_CADENA");
    expect(reasonOf(p, inst(31, "2026-10-15"))).toBe("POLIZA_FUTURA");
  });

  test("superposición el día de renovación: la sucesora prevalece desde su inicio", () => {
    const p = [pol(40, "2025-09-25", "2026-09-25", { status: "renovada" }), pol(41, "2026-09-25", "2027-09-25", { renewedFromId: 40 })];
    const index = buildRenewalChainIndex(p);
    expect(resolveChainCurrentPolicy(index, 40, "2026-09-25")).toEqual({ kind: "current", policyId: 41 });
    expect(reasonOf(p, inst(41, "2026-10-25"), "2026-09-25")).toBe("OK:poliza_vigente");
    expect(reasonOf(p, inst(40, "2026-09-01"), "2026-09-25")).toBe("OK:antecesora_directa");
    // El día anterior la vigente es la anterior y la sucesora todavía es futura.
    expect(resolveChainCurrentPolicy(index, 41, "2026-09-24")).toEqual({ kind: "current", policyId: 40 });
    expect(reasonOf(p, inst(41, "2026-10-25"), "2026-09-24")).toBe("POLIZA_FUTURA");
    const s = summarizeCollectability(index, [], "2026-09-25");
    expect(s.policyAnomalies.chainsWithOverlappingVigentes).toBe(1);
    expect(s.policyAnomalies.ambiguousChains).toBe(0);
  });

  test("renewedFromId roto: la póliza es inicio de cadena, puede ser la vigente y se reporta la anomalía", () => {
    const p = [pol(50, "2026-01-01", "2026-12-31", { renewedFromId: 99999 })];
    const index = buildRenewalChainIndex(p);
    expect(index.anomalies.brokenLinkPolicyIds).toEqual([50]);
    expect(reasonOf(p, inst(50, "2026-08-01"))).toBe("OK:poliza_vigente");
    expect(summarizeCollectability(index, [], D).policyAnomalies.brokenRenewalLinks).toBe(1);
  });

  test("renovada sin sucesor: se ocultan sus cuotas aunque sea vigente por fechas, y se reporta", () => {
    const p = [pol(60, "2026-01-01", "2026-12-31", { status: "renovada" })];
    expect(reasonOf(p, inst(60, "2026-08-01"))).toBe("RENOVADA_SIN_SUCESOR");
    expect(summarizeCollectability(buildRenewalChainIndex(p), [], D).policyAnomalies.renewedWithoutSuccessor).toBe(1);
  });

  test("cadena bifurcada con dos vigentes → ambigua, se bloquea", () => {
    const p = [pol(70, "2025-01-01", "2025-12-31", { status: "renovada" }), pol(71, "2026-01-01", "2026-12-31", { renewedFromId: 70 }), pol(72, "2026-01-01", "2026-12-31", { renewedFromId: 70 })];
    expect(reasonOf(p, inst(71, "2026-08-01"))).toBe("CADENA_AMBIGUA");
    const index = buildRenewalChainIndex(p);
    expect(index.anomalies.multipleSuccessorPolicyIds).toEqual([70]);
    expect(summarizeCollectability(index, [], D).policyAnomalies.ambiguousChains).toBe(1);
  });

  test("ciclo de renewedFromId → ambigua, sin loop infinito", () => {
    const p = [pol(80, "2026-01-01", "2026-12-31", { renewedFromId: 81 }), pol(81, "2026-01-01", "2026-12-31", { renewedFromId: 80 })];
    expect(reasonOf(p, inst(80, "2026-08-01"))).toBe("CADENA_AMBIGUA");
    expect(buildRenewalChainIndex(p).anomalies.cyclePolicyIds).toEqual([80, 81]);
  });
});

describe("cancelaciones", () => {
  test("cancelada SIN fecha efectiva → bloqueada (todas sus cuotas) y reportada", () => {
    const p = [pol(1, "2026-01-01", "2026-12-31", { status: "cancelada" })];
    expect(reasonOf(p, inst(1, "2026-08-01"))).toBe("CANCELADA_SIN_FECHA_EFECTIVA");
    expect(summarizeCollectability(buildRenewalChainIndex(p), [], D).policyAnomalies.cancelledWithoutEffectiveDate).toBe(1);
  });

  test("cancelada con fecha efectiva inválida → bloqueada", () => {
    const p = [pol(1, "2026-01-01", "2026-12-31", { status: "cancelada", cancellationEffectiveDate: "2026-02-30" })];
    expect(reasonOf(p, inst(1, "2026-08-01"))).toBe("CANCELADA_SIN_FECHA_EFECTIVA");
  });

  test("día efectivo de cancelación: vigente ese día, fuera desde el siguiente (incluso cuotas anteriores)", () => {
    const p = [pol(1, "2026-01-01", "2026-12-31", { status: "cancelada", cancellationEffectiveDate: "2026-09-25" })];
    expect(reasonOf(p, inst(1, "2026-09-25"), "2026-09-25")).toBe("OK:poliza_vigente");
    expect(reasonOf(p, inst(1, "2026-08-01"), "2026-09-26")).toBe("SIN_POLIZA_VIGENTE_EN_CADENA");
  });

  test("cuota que vence después de la fecha efectiva → excluida", () => {
    const p = [pol(1, "2026-01-01", "2026-12-31", { status: "cancelada", cancellationEffectiveDate: "2026-09-25" })];
    expect(reasonOf(p, inst(1, "2026-09-26"), "2026-09-20")).toBe("VENCE_DESPUES_DE_CANCELACION");
  });

  test("antecesora directa cancelada con fecha válida: sus cuotas previas a la cancelación se admiten si la sucesora es vigente", () => {
    const p = [pol(1, "2025-09-01", "2026-09-01", { status: "cancelada", cancellationEffectiveDate: "2026-08-15" }), pol(2, "2026-08-16", "2027-08-16", { renewedFromId: 1 })];
    expect(reasonOf(p, inst(1, "2026-08-10"))).toBe("OK:antecesora_directa");
  });
});

describe("estado de la cuota y datos inválidos", () => {
  const p = [pol(1, "2026-01-01", "2026-12-31")];
  test("pagada / no_exigible / duplicada → no cobrable", () => {
    for (const status of ["pagada", "no_exigible", "duplicada"]) expect(reasonOf(p, inst(1, "2026-08-01", { status }))).toBe("ESTADO_NO_COBRABLE");
  });
  test("vencida sigue siendo cobrable", () => expect(reasonOf(p, inst(1, "2026-08-01", { status: "vencida" }))).toBe("OK:poliza_vigente"));
  test("rendida → no cobrable", () => expect(reasonOf(p, inst(1, "2026-08-01", { rendered: 1 }))).toBe("RENDIDA"));
  test("pago confirmado con estado desactualizado (pendiente) → no cobrable", () => {
    expect(reasonOf(p, inst(1, "2026-08-01", { status: "pendiente", hasConfirmedPayment: true }))).toBe("PAGO_CONFIRMADO");
  });
  test("vencimiento inválido o nulo → bloqueado", () => {
    expect(reasonOf(p, inst(1, null))).toBe("VENCIMIENTO_INVALIDO");
    expect(reasonOf(p, inst(1, "2026-13-01"))).toBe("VENCIMIENTO_INVALIDO");
  });
  test("fechas de póliza nulas, inválidas o invertidas → bloqueado", () => {
    expect(reasonOf([pol(1, null, "2026-12-31")], inst(1, "2026-08-01"))).toBe("POLIZA_FECHAS_INVALIDAS");
    expect(reasonOf([pol(1, "01/01/2026", "2026-12-31")], inst(1, "2026-08-01"))).toBe("POLIZA_FECHAS_INVALIDAS");
    expect(reasonOf([pol(1, "2026-12-31", "2026-01-01")], inst(1, "2026-08-01"))).toBe("POLIZA_FECHAS_INVALIDAS");
  });
  test("fecha de pago inválida → rechazada", () => expect(reasonOf(p, inst(1, "2026-08-01"), "2026-02-30")).toBe("FECHA_PAGO_INVALIDA"));
  test("póliza inexistente en el índice → rechazada", () => expect(reasonOf(p, inst(999, "2026-08-01"))).toBe("POLIZA_INEXISTENTE"));
  test("el status snapshot no decide la vigencia: 'activa' vencida por fechas queda oculta, 'por_vencer' vigente se admite", () => {
    expect(reasonOf([pol(1, "2025-01-01", "2026-08-31", { status: "activa" })], inst(1, "2026-08-01"))).toBe("SIN_POLIZA_VIGENTE_EN_CADENA");
    expect(reasonOf([pol(1, "2025-10-10", "2026-10-10", { status: "por_vencer" })], inst(1, "2026-08-01"))).toBe("OK:poliza_vigente");
  });
});

describe("existingCollection (cambio de fecha de un cobro ya confirmado)", () => {
  const p = [pol(1, "2026-01-01", "2026-09-30")];
  const idx = buildRenewalChainIndex(p);
  const ev = (i: CollectabilityInstallment, date: string) => {
    const r = evaluateInstallmentCollectability(idx, i, date, { existingCollection: true });
    return r.collectable ? `OK:${r.via}` : r.reason;
  };
  test("admite la cuota 'pagada' por el mismo cobro, pero el resto de la regla aplica con la fecha nueva", () => {
    expect(ev(inst(1, "2026-08-01", { status: "pagada" }), "2026-09-20")).toBe("OK:poliza_vigente");
    expect(ev(inst(1, "2026-08-01", { status: "pagada" }), "2026-10-01")).toBe("SIN_POLIZA_VIGENTE_EN_CADENA");
    expect(ev(inst(1, "2026-06-30", { status: "pagada" }), "2026-09-20")).toBe("ANTERIOR_FECHA_MINIMA");
  });
  test("sigue rechazando no_exigible / duplicada / rendida / otro pago confirmado", () => {
    expect(ev(inst(1, "2026-08-01", { status: "no_exigible" }), "2026-09-20")).toBe("ESTADO_NO_COBRABLE");
    expect(ev(inst(1, "2026-08-01", { status: "duplicada" }), "2026-09-20")).toBe("ESTADO_NO_COBRABLE");
    expect(ev(inst(1, "2026-08-01", { status: "pagada", rendered: 1 }), "2026-09-20")).toBe("RENDIDA");
    expect(ev(inst(1, "2026-08-01", { status: "pagada", hasConfirmedPayment: true }), "2026-09-20")).toBe("PAGO_CONFIRMADO");
  });
  test("sin el modo, 'pagada' sigue siendo no cobrable (cobro nuevo)", () => {
    expect(reasonOf(p, inst(1, "2026-08-01", { status: "pagada" }), "2026-09-20")).toBe("ESTADO_NO_COBRABLE");
  });
});

describe("summarizeCollectability", () => {
  test("cada cuota cae en exactamente una categoría", () => {
    const p = [pol(1, "2026-01-01", "2026-12-31"), pol(2, "2026-01-01", "2026-12-31", { status: "cancelada" })];
    const list = [inst(1, "2026-08-01"), inst(1, "2026-06-01"), inst(2, "2026-08-01"), inst(1, "2026-08-02", { rendered: 1 })];
    const s = summarizeCollectability(buildRenewalChainIndex(p), list, D);
    const total = s.collectableByVia.poliza_vigente + s.collectableByVia.antecesora_directa
      + Object.values(s.notCollectableByReason).reduce((a, b) => a + (b ?? 0), 0);
    expect(total).toBe(list.length);
    expect(s.notCollectableByReason).toEqual({ ANTERIOR_FECHA_MINIMA: 1, CANCELADA_SIN_FECHA_EFECTIVA: 1, RENDIDA: 1 });
  });
});
