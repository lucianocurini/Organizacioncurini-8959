/**
 * Tests puros de src/lib/payments/caja-summary.ts (adaptación de Caja a
 * remittance_allocations). Sin DB — mismo estilo que
 * remittance-allocations-helpers.test.ts/batches.test.ts.
 */

import { test, expect, describe } from "bun:test";
import {
  isContableMethod,
  NON_INSTRUMENT_LABELS,
  emptyMoneyBucket,
  emptyDirectCompanyBucket,
  applyStandalonePaymentToCartera,
  applyBatchToCartera,
  applyStandaloneSurchargeToCartera,
  applyManualCashEntryToCartera,
  collectDistinctExpectedSources,
  classifyRemittanceForRendido,
  accumulateRemittanceContribution,
  emptyRendidoAccumulator,
  centsToPesos,
  buildAdeudadosDetalle,
  assertAdeudadosDetalleMatchesTotal,
  AdeudadosSumMismatchError,
  type CarteraInconsistency,
  type BatchForCartera,
  type RemittanceDebtRowForDetalle,
  type CashDebtLegacyRowForDetalle,
} from "../../lib/payments/caja-summary";

// ─── Métodos contables ──────────────────────────────────────────────────────

describe("métodos contables", () => {
  test("efectivo/transferencia/cheque/link_pago/transferencia_compania son contables", () => {
    expect(isContableMethod("efectivo")).toBe(true);
    expect(isContableMethod("transferencia")).toBe(true);
    expect(isContableMethod("cheque")).toBe(true);
    expect(isContableMethod("link_pago")).toBe(true);
    expect(isContableMethod("transferencia_compania")).toBe(true);
  });

  test("combinado no aparece como método contable", () => {
    expect(isContableMethod("combinado")).toBe(false);
    expect(NON_INSTRUMENT_LABELS.has("combinado")).toBe(true);
  });

  test("lote y pronto_pago tampoco son métodos contables", () => {
    expect(isContableMethod("lote")).toBe(false);
    expect(isContableMethod("pronto_pago")).toBe(false);
    expect(NON_INSTRUMENT_LABELS.has("lote")).toBe(true);
    expect(NON_INSTRUMENT_LABELS.has("pronto_pago")).toBe(true);
  });
});

// ─── Cartera pendiente — pago standalone ───────────────────────────────────

describe("applyStandalonePaymentToCartera", () => {
  test("pago standalone simple", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    const inconsistencias: CarteraInconsistency[] = [];
    applyStandalonePaymentToCartera(
      { paymentId: 1, amountCents: 100000, splits: [{ method: "efectivo", amountCents: 100000 }] },
      cartera, directoCompania, inconsistencias
    );
    expect(cartera.efectivoCents).toBe(100000);
    expect(cartera.totalCents).toBe(100000);
    expect(inconsistencias.length).toBe(0);
  });

  test("pago combinado — se reparte por método real, nunca como 'combinado'", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    const inconsistencias: CarteraInconsistency[] = [];
    applyStandalonePaymentToCartera(
      {
        paymentId: 2, amountCents: 150000,
        splits: [{ method: "efectivo", amountCents: 100000 }, { method: "transferencia", amountCents: 50000 }],
      },
      cartera, directoCompania, inconsistencias
    );
    expect(cartera.efectivoCents).toBe(100000);
    expect(cartera.transferenciaCents).toBe(50000);
    expect(cartera.totalCents).toBe(150000);
    expect(inconsistencias.length).toBe(0);
  });

  test("pago standalone cuya suma de splits no coincide con el importe → inconsistencia, no se suma", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    const inconsistencias: CarteraInconsistency[] = [];
    applyStandalonePaymentToCartera(
      { paymentId: 3, amountCents: 100000, splits: [{ method: "efectivo", amountCents: 90000 }] },
      cartera, directoCompania, inconsistencias
    );
    expect(cartera.totalCents).toBe(0);
    expect(inconsistencias.length).toBe(1);
    expect(inconsistencias[0]!.sourceType).toBe("standalone_payment");
    expect(inconsistencias[0]!.sourceId).toBe(3);
  });

  test("pago standalone directo a compañía (transferencia_compania/link_pago) va a directoCompania, no a cartera", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    const inconsistencias: CarteraInconsistency[] = [];
    applyStandalonePaymentToCartera(
      { paymentId: 4, amountCents: 200000, splits: [{ method: "link_pago", amountCents: 200000 }] },
      cartera, directoCompania, inconsistencias
    );
    expect(cartera.totalCents).toBe(0);
    expect(directoCompania.linkPagoCents).toBe(200000);
    expect(directoCompania.totalCents).toBe(200000);
  });
});

// ─── Cartera pendiente — batch ──────────────────────────────────────────────

function mkBatch(overrides: Partial<BatchForCartera> = {}): BatchForCartera {
  return {
    batchId: 100,
    status: "confirmado",
    splits: [{ method: "efectivo", amountCents: 100000, checks: [] }],
    children: [{ paymentId: 1, status: "confirmado", rendered: 0 }],
    ...overrides,
  };
}

describe("applyBatchToCartera", () => {
  test("batch contado una vez", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    const inconsistencias: CarteraInconsistency[] = [];
    applyBatchToCartera(mkBatch(), cartera, directoCompania, inconsistencias);
    expect(cartera.efectivoCents).toBe(100000);
    expect(cartera.totalCents).toBe(100000);
  });

  test("dos hijos del mismo batch no duplican el total", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    const inconsistencias: CarteraInconsistency[] = [];
    applyBatchToCartera(
      mkBatch({
        children: [
          { paymentId: 1, status: "confirmado", rendered: 0 },
          { paymentId: 2, status: "confirmado", rendered: 0 },
        ],
      }),
      cartera, directoCompania, inconsistencias
    );
    expect(cartera.efectivoCents).toBe(100000); // no 200000
    expect(inconsistencias.length).toBe(0);
  });

  test("batch parcialmente rendered → inconsistencia, excluido de totales", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    const inconsistencias: CarteraInconsistency[] = [];
    applyBatchToCartera(
      mkBatch({
        children: [
          { paymentId: 1, status: "confirmado", rendered: 0 },
          { paymentId: 2, status: "confirmado", rendered: 1 },
        ],
      }),
      cartera, directoCompania, inconsistencias
    );
    expect(cartera.totalCents).toBe(0);
    expect(inconsistencias.length).toBe(1);
    expect(inconsistencias[0]!.sourceType).toBe("batch");
    expect(inconsistencias[0]!.sourceId).toBe(100);
  });

  test("batch anulado no aporta cartera", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyBatchToCartera(mkBatch({ status: "anulado" }), cartera, directoCompania, []);
    expect(cartera.totalCents).toBe(0);
  });

  test("batch completamente rendido no aporta cartera pendiente", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyBatchToCartera(
      mkBatch({ children: [{ paymentId: 1, status: "confirmado", rendered: 1 }] }),
      cartera, directoCompania, []
    );
    expect(cartera.totalCents).toBe(0);
  });

  test("cheque con un solo received_check", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyBatchToCartera(
      mkBatch({ splits: [{ method: "cheque", amountCents: 100000, checks: [{ id: 1, amountCents: 100000 }] }] }),
      cartera, directoCompania, []
    );
    expect(cartera.chequeCents).toBe(100000);
  });

  test("cheque con varios received_checks — se suma una sola vez al bucket cheque", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyBatchToCartera(
      mkBatch({
        splits: [{ method: "cheque", amountCents: 100000, checks: [{ id: 1, amountCents: 60000 }, { id: 2, amountCents: 40000 }] }],
      }),
      cartera, directoCompania, []
    );
    expect(cartera.chequeCents).toBe(100000);
  });

  test("cheque cuya suma no coincide con el split → inconsistencia, split no se suma", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    const inconsistencias: CarteraInconsistency[] = [];
    applyBatchToCartera(
      mkBatch({
        splits: [{ method: "cheque", amountCents: 100000, checks: [{ id: 1, amountCents: 50000 }] }],
      }),
      cartera, directoCompania, inconsistencias
    );
    expect(cartera.chequeCents).toBe(0);
    expect(inconsistencias.length).toBe(1);
    expect(inconsistencias[0]!.sourceType).toBe("batch_split_check");
  });

  test("pronto pago dentro de batch — ya incluido en el split, sin bucket propio, sin duplicación", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    // El split de $1000 ya incluye $800 de recargo Pronto Pago mezclado con la base.
    applyBatchToCartera(mkBatch({ splits: [{ method: "efectivo", amountCents: 100000, checks: [] }] }), cartera, directoCompania, []);
    expect(cartera.efectivoCents).toBe(100000);
    expect(cartera.recargosProntoPagoCents).toBe(0); // nunca se separa dentro de un batch
  });

  test("batch con split directo a compañía", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyBatchToCartera(
      mkBatch({ splits: [{ method: "transferencia_compania", amountCents: 100000, checks: [] }] }),
      cartera, directoCompania, []
    );
    expect(cartera.totalCents).toBe(0);
    expect(directoCompania.transferenciaCompaniaCents).toBe(100000);
  });
});

// ─── Cartera pendiente — recargo Pronto Pago standalone / manuales ─────────

describe("applyStandaloneSurchargeToCartera", () => {
  test("pronto pago standalone", () => {
    const cartera = emptyMoneyBucket();
    applyStandaloneSurchargeToCartera(80000, cartera);
    expect(cartera.recargosProntoPagoCents).toBe(80000);
    expect(cartera.totalCents).toBe(80000);
  });
});

describe("applyManualCashEntryToCartera", () => {
  test("ingreso manual normal — método propio", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyManualCashEntryToCartera("efectivo", 50000, cartera, directoCompania);
    expect(cartera.efectivoCents).toBe(50000);
  });

  test("ingreso manual — método directo a compañía", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyManualCashEntryToCartera("transferencia_compania", 50000, cartera, directoCompania);
    expect(directoCompania.transferenciaCompaniaCents).toBe(50000);
    expect(cartera.totalCents).toBe(0);
  });
});

// ─── Agrupar instrumentos para expectedCollectedCents ──────────────────────

describe("collectDistinctExpectedSources", () => {
  test("un batch con varios splits/cheques se agrupa una sola vez", () => {
    const result = collectDistinctExpectedSources([
      { paymentId: null, paymentBatchId: 5, cashEntryId: null },
      { paymentId: null, paymentBatchId: 5, cashEntryId: null },
      { paymentId: null, paymentBatchId: 5, cashEntryId: null },
    ]);
    expect(result.batchIds).toEqual([5]);
    expect(result.standalonePaymentIds).toEqual([]);
  });

  test("pagos standalone y cash_entries se agrupan por id distinto", () => {
    const result = collectDistinctExpectedSources([
      { paymentId: 1, paymentBatchId: null, cashEntryId: null },
      { paymentId: 1, paymentBatchId: null, cashEntryId: null },
      { paymentId: 2, paymentBatchId: null, cashEntryId: null },
      { paymentId: null, paymentBatchId: null, cashEntryId: 9 },
    ]);
    expect(result.standalonePaymentIds.sort()).toEqual([1, 2]);
    expect(result.cashEntryIds).toEqual([9]);
  });
});

// ─── Rendido por método — clasificación por rendición ──────────────────────

describe("classifyRemittanceForRendido", () => {
  test("rendición nueva solo con deuda/no cobrada — expected=0, allocations=0, válida", () => {
    const c = classifyRemittanceForRendido({
      remittanceId: 1, date: "2027-01-01", allocations: [], expectedCollectedCents: 0,
      hasRealMoneyItems: false, legacyPaymentBreakdownRaw: "{}",
    });
    expect(c.state).toBe("zero");
    expect(c.contributionOwnCents).toBe(0);
    expect(c.contributionDirectCompaniaCents).toBe(0);
    expect(c.inconsistency).toBeUndefined();
  });

  test("manual_debt sin efecto monetario (sin allocations, sin dinero real)", () => {
    const c = classifyRemittanceForRendido({
      remittanceId: 2, date: "2027-01-01", allocations: [], expectedCollectedCents: 0,
      hasRealMoneyItems: false, legacyPaymentBreakdownRaw: "{}",
    });
    expect(c.state).toBe("zero");
  });

  test("installment no cobrada sin efecto (sin allocations, sin dinero real)", () => {
    const c = classifyRemittanceForRendido({
      remittanceId: 3, date: "2027-01-01", allocations: [], expectedCollectedCents: 0,
      hasRealMoneyItems: false, legacyPaymentBreakdownRaw: "{}",
    });
    expect(c.state).toBe("zero");
    expect(c.contributionOwnCents + c.contributionDirectCompaniaCents).toBe(0);
  });

  test("rendición histórica manual_debt con paymentBreakdown nominal (no vacío) pero sin dinero real — sigue siendo zero, no suma el breakdown", () => {
    // hasRealMoneyItems=false manda sobre el contenido de legacyPaymentBreakdownRaw:
    // aunque el breakdown legacy traiga valores (dato histórico nominal de una
    // rendición manual_debt), la clasificación no debe leerlo ni sumarlo.
    const c = classifyRemittanceForRendido({
      remittanceId: 11, date: "2027-01-01", allocations: [], expectedCollectedCents: 0,
      hasRealMoneyItems: false,
      legacyPaymentBreakdownRaw: JSON.stringify({ efectivo: 500, transferencia: 300 }),
    });
    expect(c.state).toBe("zero");
    expect(c.contributionOwnCents).toBe(0);
    expect(c.contributionDirectCompaniaCents).toBe(0);
    expect(c.breakdown.ownByMethodCents.efectivo).toBeUndefined();
    expect(c.breakdown.ownByMethodCents.transferencia).toBeUndefined();
  });

  test("legacy efectivo/transferencia/cheque", () => {
    const c = classifyRemittanceForRendido({
      remittanceId: 4, date: "2027-01-01", allocations: [], expectedCollectedCents: 0,
      hasRealMoneyItems: true,
      legacyPaymentBreakdownRaw: JSON.stringify({ efectivo: 100, transferencia: 50, cheque: 25 }),
    });
    expect(c.state).toBe("legacy");
    expect(c.breakdown.ownByMethodCents.efectivo).toBe(10000);
    expect(c.breakdown.ownByMethodCents.transferencia).toBe(5000);
    expect(c.breakdown.ownByMethodCents.cheque).toBe(2500);
    expect(c.contributionOwnCents).toBe(17500);
  });

  test("legacy pronto_pago conservado, separado de los métodos reales", () => {
    const c = classifyRemittanceForRendido({
      remittanceId: 5, date: "2027-01-01", allocations: [], expectedCollectedCents: 0,
      hasRealMoneyItems: true,
      legacyPaymentBreakdownRaw: JSON.stringify({ efectivo: 100, pronto_pago: 8 }),
    });
    expect(c.state).toBe("legacy");
    expect(c.breakdown.recargosProntoPagoCents).toBe(800);
    expect(c.breakdown.ownByMethodCents.efectivo).toBe(10000);
    expect(c.contributionOwnCents).toBe(10800);
  });

  test("método legacy desconocido conservado — no se convierte a efectivo/transferencia", () => {
    const c = classifyRemittanceForRendido({
      remittanceId: 6, date: "2027-01-01", allocations: [], expectedCollectedCents: 0,
      hasRealMoneyItems: true,
      legacyPaymentBreakdownRaw: JSON.stringify({ efectivo: 100, cheque_diferido: 50 }),
    });
    expect(c.state).toBe("legacy");
    expect(c.breakdown.legacyUnknown.cheque_diferido).toBe(50);
    expect(c.breakdown.ownByMethodCents.cheque_diferido).toBeUndefined();
    // Se incluye en el total histórico igual, sin atribuirlo a un método real.
    expect(c.contributionOwnCents).toBe(15000);
  });

  test("allocation transferencia_compania", () => {
    const c = classifyRemittanceForRendido({
      remittanceId: 7, date: "2027-01-01",
      allocations: [{ method: "transferencia_compania", amountCents: 100000, isProntoPagoSurcharge: false }],
      expectedCollectedCents: 100000, hasRealMoneyItems: true, legacyPaymentBreakdownRaw: "{}",
    });
    expect(c.state).toBe("complete");
    expect(c.breakdown.directCompaniaByMethodCents.transferencia_compania).toBe(100000);
    expect(c.contributionDirectCompaniaCents).toBe(100000);
    expect(c.contributionOwnCents).toBe(0);
  });

  test("allocation link_pago", () => {
    const c = classifyRemittanceForRendido({
      remittanceId: 8, date: "2027-01-01",
      allocations: [{ method: "link_pago", amountCents: 50000, isProntoPagoSurcharge: false }],
      expectedCollectedCents: 50000, hasRealMoneyItems: true, legacyPaymentBreakdownRaw: "{}",
    });
    expect(c.state).toBe("complete");
    expect(c.breakdown.directCompaniaByMethodCents.link_pago).toBe(50000);
    expect(c.contributionDirectCompaniaCents).toBe(50000);
  });

  test("allocation de recargo Pronto Pago va a recargosProntoPago, no al método real del cash_entry", () => {
    const c = classifyRemittanceForRendido({
      remittanceId: 9, date: "2027-01-01",
      allocations: [{ method: "efectivo", amountCents: 80000, isProntoPagoSurcharge: true }],
      expectedCollectedCents: 80000, hasRealMoneyItems: true, legacyPaymentBreakdownRaw: "{}",
    });
    expect(c.state).toBe("complete");
    expect(c.breakdown.recargosProntoPagoCents).toBe(80000);
    expect(c.breakdown.ownByMethodCents.efectivo).toBeUndefined();
  });

  test("rendición con allocations inconsistentes — excluida de los totales", () => {
    const c = classifyRemittanceForRendido({
      remittanceId: 10, date: "2027-01-01",
      allocations: [{ method: "efectivo", amountCents: 90000, isProntoPagoSurcharge: false }],
      expectedCollectedCents: 100000, hasRealMoneyItems: true, legacyPaymentBreakdownRaw: "{}",
    });
    expect(c.state).toBe("inconsistent");
    expect(c.contributionOwnCents).toBe(0);
    expect(c.inconsistency).toBeDefined();
    expect(c.inconsistency!.remittanceId).toBe(10);
    expect(c.inconsistency!.allocationSumCents).toBe(90000);
    expect(c.inconsistency!.expectedCollectedCents).toBe(100000);
  });
});

// ─── Acumulador ─────────────────────────────────────────────────────────────

describe("accumulateRemittanceContribution", () => {
  test("acumula complete/legacy/zero/inconsistent en los contadores correctos", () => {
    const acc = emptyRendidoAccumulator();
    accumulateRemittanceContribution(
      classifyRemittanceForRendido({
        remittanceId: 1, date: "2027-01-01",
        allocations: [{ method: "efectivo", amountCents: 100000, isProntoPagoSurcharge: false }],
        expectedCollectedCents: 100000, hasRealMoneyItems: true, legacyPaymentBreakdownRaw: "{}",
      }),
      acc
    );
    accumulateRemittanceContribution(
      classifyRemittanceForRendido({
        remittanceId: 2, date: "2027-01-01", allocations: [], expectedCollectedCents: 0,
        hasRealMoneyItems: true, legacyPaymentBreakdownRaw: JSON.stringify({ transferencia: 200 }),
      }),
      acc
    );
    accumulateRemittanceContribution(
      classifyRemittanceForRendido({
        remittanceId: 3, date: "2027-01-01", allocations: [], expectedCollectedCents: 0,
        hasRealMoneyItems: false, legacyPaymentBreakdownRaw: "{}",
      }),
      acc
    );
    accumulateRemittanceContribution(
      classifyRemittanceForRendido({
        remittanceId: 4, date: "2027-01-01",
        allocations: [{ method: "cheque", amountCents: 50000, isProntoPagoSurcharge: false }],
        expectedCollectedCents: 999999, hasRealMoneyItems: true, legacyPaymentBreakdownRaw: "{}",
      }),
      acc
    );

    expect(acc.remittancesCompleteCount).toBe(1);
    expect(acc.remittancesLegacyCount).toBe(1);
    expect(acc.remittancesZeroCollectedCount).toBe(1);
    expect(acc.inconsistencias.length).toBe(1);
    expect(acc.cartera.efectivoCents).toBe(100000);
    expect(acc.cartera.transferenciaCents).toBe(20000);
    expect(acc.cartera.chequeCents).toBe(0); // el inconsistente no se suma
  });
});

// ─── centsToPesos ───────────────────────────────────────────────────────────

// ─── buildAdeudadosDetalle / assertAdeudadosDetalleMatchesTotal ────────────

function reb(overrides: Partial<RemittanceDebtRowForDetalle> = {}): RemittanceDebtRowForDetalle {
  return {
    id: 1, source: "installment", policyNumber: "POL-1", debtorName: "Juan Pérez",
    companyName: "Compañía A", amount: 1000, remittanceDate: "2027-05-01",
    ...overrides,
  };
}
function legacy(overrides: Partial<CashDebtLegacyRowForDetalle> = {}): CashDebtLegacyRowForDetalle {
  return {
    id: 1, clientName: "Ana López", policyNumber: "POL-2", companyName: "Compañía B",
    amount: 500, createdAt: "2027-04-15",
    ...overrides,
  };
}

describe("buildAdeudadosDetalle", () => {
  test("origen 'manual_debt' cuando source='manual_debt'", () => {
    const [item] = buildAdeudadosDetalle([reb({ id: 10, source: "manual_debt" })], []);
    expect(item!.origen).toBe("manual_debt");
    expect(item!.id).toBe(10);
    expect(item!.estado).toBe("pendiente");
  });

  test("origen 'installment' cuando source='installment'", () => {
    const [item] = buildAdeudadosDetalle([reb({ id: 11, source: "installment" })], []);
    expect(item!.origen).toBe("installment");
  });

  test("cash_debt legacy queda como origen 'cash_debt_legacy'", () => {
    const [item] = buildAdeudadosDetalle([], [legacy({ id: 20 })]);
    expect(item!.origen).toBe("cash_debt_legacy");
    expect(item!.id).toBe(20);
    expect(item!.deudor).toBe("Ana López");
  });

  test("combina ambas fuentes sin perder filas ni duplicar", () => {
    const detalle = buildAdeudadosDetalle(
      [reb({ id: 1, source: "installment" }), reb({ id: 2, source: "manual_debt" })],
      [legacy({ id: 1 })] // mismo id numérico que un remittance item — no debe colisionar ni deduplicarse
    );
    expect(detalle.length).toBe(3);
    expect(detalle.filter((d) => d.origen === "cash_debt_legacy").length).toBe(1);
    expect(detalle.filter((d) => d.origen !== "cash_debt_legacy").length).toBe(2);
  });

  test("detalle vacío cuando no hay ninguna fuente", () => {
    expect(buildAdeudadosDetalle([], [])).toEqual([]);
  });

  test("deudor cae a '—' si debtorName es null", () => {
    const [item] = buildAdeudadosDetalle([reb({ debtorName: null })], []);
    expect(item!.deudor).toBe("—");
  });

  test("fecha de cash_debt legacy se formatea a YYYY-MM-DD desde distintos tipos de createdAt", () => {
    const [a] = buildAdeudadosDetalle([], [legacy({ createdAt: "2027-04-15T10:00:00.000Z" })]);
    expect(a!.fecha).toBe("2027-04-15");
    const [b] = buildAdeudadosDetalle([], [legacy({ createdAt: new Date("2027-06-01T00:00:00.000Z") })]);
    expect(b!.fecha).toBe("2027-06-01");
  });
});

describe("assertAdeudadosDetalleMatchesTotal", () => {
  test("no lanza cuando la suma del detalle coincide con totalAdeudado", () => {
    const detalle = buildAdeudadosDetalle([reb({ amount: 1000.5 })], [legacy({ amount: 500.25 })]);
    expect(() => assertAdeudadosDetalleMatchesTotal(detalle, 1500.75)).not.toThrow();
  });

  test("lanza AdeudadosSumMismatchError controlado cuando NO coincide (nunca ajusta el número)", () => {
    const detalle = buildAdeudadosDetalle([reb({ amount: 1000 })], []);
    let caught: unknown;
    try {
      assertAdeudadosDetalleMatchesTotal(detalle, 999);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AdeudadosSumMismatchError);
    const err = caught as AdeudadosSumMismatchError;
    expect(err.detalleSumCents).toBe(100000);
    expect(err.totalAdeudadoCents).toBe(99900);
  });

  test("compara en centavos — evita falsos positivos de punto flotante", () => {
    const detalle = buildAdeudadosDetalle(
      [reb({ amount: 0.1 }), reb({ id: 2, amount: 0.2 })],
      []
    );
    // 0.1 + 0.2 !== 0.3 en punto flotante — la comparación en centavos debe
    // seguir considerándolos iguales.
    expect(() => assertAdeudadosDetalleMatchesTotal(detalle, 0.3)).not.toThrow();
  });

  test("detalle vacío con total 0 no lanza", () => {
    expect(() => assertAdeudadosDetalleMatchesTotal([], 0)).not.toThrow();
  });
});

// ─── centsToPesos ───────────────────────────────────────────────────────────

test("centsToPesos convierte centavos a pesos", () => {
  expect(centsToPesos(123456)).toBeCloseTo(1234.56, 2);
});
