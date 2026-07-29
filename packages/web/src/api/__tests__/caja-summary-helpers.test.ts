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
  calculateCajaNetaTotalCents,
  type CarteraInconsistency,
  type BatchForCartera,
  type RemittanceDebtRowForDetalle,
  type CashDebtLegacyRowForDetalle,
} from "../../lib/payments/caja-summary";
import { calculateExpectedCollectedCents } from "../../lib/payments/remittance-allocations";

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
    children: [{ paymentId: 1, status: "confirmado", rendered: 0, amountCents: 100000 }],
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
          { paymentId: 1, status: "confirmado", rendered: 0, amountCents: 60000 },
          { paymentId: 2, status: "confirmado", rendered: 0, amountCents: 40000 },
        ],
      }),
      cartera, directoCompania, inconsistencias
    );
    expect(cartera.efectivoCents).toBe(100000); // no 200000
    expect(inconsistencias.length).toBe(0);
  });

  // ─── Etapa "rendición por cuota" — batch con hijos rendered mixto ─────────
  // Cobrar por lote no obliga a rendir el lote completo: un batch puede
  // quedar con algunos hijos ya rendidos (a su compañía) y otros todavía
  // pendientes, sin que eso sea una inconsistencia (antes de esta etapa era
  // imposible llegar a este estado — assertCompletePaymentBatches lo
  // impedía). Cartera pendiente debe reflejar SOLO la porción todavía sin
  // rendir, prorrateada por método sin perder ni duplicar centavos.

  test("batch con un hijo rendido y otro no → NO es inconsistencia, se prorratea la porción pendiente", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    const inconsistencias: CarteraInconsistency[] = [];
    applyBatchToCartera(
      mkBatch({
        splits: [{ method: "efectivo", amountCents: 100000, checks: [] }],
        children: [
          { paymentId: 1, status: "confirmado", rendered: 0, amountCents: 60000 }, // sigue pendiente
          { paymentId: 2, status: "confirmado", rendered: 1, amountCents: 40000 }, // ya rendido
        ],
      }),
      cartera, directoCompania, inconsistencias
    );
    expect(inconsistencias.length).toBe(0);
    // 60% de la base del batch sigue pendiente → 60% del instrumento (100000) = 60000.
    expect(cartera.efectivoCents).toBe(60000);
    expect(cartera.totalCents).toBe(60000);
  });

  test("el hijo rendido sale de cartera pendiente y el no rendido queda — dos métodos, cierra exacto en centavos", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    const inconsistencias: CarteraInconsistency[] = [];
    applyBatchToCartera(
      mkBatch({
        splits: [
          { method: "efectivo", amountCents: 70000, checks: [] },
          { method: "transferencia", amountCents: 30000, checks: [] },
        ],
        children: [
          { paymentId: 1, status: "confirmado", rendered: 0, amountCents: 50000 }, // pendiente
          { paymentId: 2, status: "confirmado", rendered: 1, amountCents: 50000 }, // rendido
        ],
      }),
      cartera, directoCompania, inconsistencias
    );
    expect(inconsistencias.length).toBe(0);
    // 50% de la base sigue pendiente → 50% de cada split, sin drift.
    expect(cartera.efectivoCents).toBe(35000);
    expect(cartera.transferenciaCents).toBe(15000);
    expect(cartera.totalCents).toBe(50000); // cierra exacto: 35000 + 15000
  });

  test("tres hijos, dos rendidos y uno no → el total pendiente cierra exacto en centavos (sin drift de redondeo)", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    const inconsistencias: CarteraInconsistency[] = [];
    applyBatchToCartera(
      mkBatch({
        splits: [{ method: "cheque", amountCents: 100000, checks: [{ id: 1, amountCents: 100000 }] }],
        children: [
          { paymentId: 1, status: "confirmado", rendered: 1, amountCents: 33333 },
          { paymentId: 2, status: "confirmado", rendered: 1, amountCents: 33333 },
          { paymentId: 3, status: "confirmado", rendered: 0, amountCents: 33334 }, // pendiente, 1/3 no exacto
        ],
      }),
      cartera, directoCompania, inconsistencias
    );
    expect(inconsistencias.length).toBe(0);
    expect(cartera.chequeCents).toBe(cartera.totalCents);
    expect(cartera.totalCents).toBeGreaterThan(0);
    // El total pendiente es siempre round(100000 * 33334/100000) = 33334 —
    // nunca se pierde ni se duplica un centavo por el redondeo.
    expect(cartera.totalCents).toBe(33334);
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
      mkBatch({ children: [{ paymentId: 1, status: "confirmado", rendered: 1, amountCents: 100000 }] }),
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

  // ─── Fase 2C — sobrantes/faltantes: cartera nunca cuenta más que lo aplicado ───
  // Un batch con diferencia (Fase 2B) tiene SUM(splits) != appliedAmountCents.
  // El sobrante (real > aplicado) se excluye siempre de cartera-pendiente —
  // se contabiliza exclusivamente vía creditoActivoEnCajaCents (insured-
  // account.ts), nunca acá, sin importar el estado de rendido de la cuota.

  test("sobrante (cheque $1100 / aplicado $1000): cartera pendiente cuenta solo lo aplicado, nunca el sobrante", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyBatchToCartera(
      mkBatch({
        splits: [{ method: "cheque", amountCents: 110000, checks: [{ id: 1, amountCents: 110000 }] }],
        children: [{ paymentId: 1, status: "confirmado", rendered: 0, amountCents: 100000 }],
        appliedAmountCents: 100000,
      }),
      cartera, directoCompania, []
    );
    // No 110000 — el sobrante ($10000) nunca entra acá.
    expect(cartera.chequeCents).toBe(100000);
    expect(cartera.totalCents).toBe(100000);
  });

  test("faltante (cheque $900 / aplicado $1000): cartera pendiente usa el real, nunca infla con lo que no llegó", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyBatchToCartera(
      mkBatch({
        splits: [{ method: "cheque", amountCents: 90000, checks: [{ id: 1, amountCents: 90000 }] }],
        children: [{ paymentId: 1, status: "confirmado", rendered: 0, amountCents: 100000 }],
        appliedAmountCents: 100000,
      }),
      cartera, directoCompania, []
    );
    // No 100000 — nunca se cuenta plata que no llegó realmente.
    expect(cartera.chequeCents).toBe(90000);
    expect(cartera.totalCents).toBe(90000);
  });

  test("sin diferencia (appliedAmountCents === real): comportamiento idéntico a sin Fase 2C", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyBatchToCartera(
      mkBatch({
        splits: [{ method: "efectivo", amountCents: 100000, checks: [] }],
        appliedAmountCents: 100000,
      }),
      cartera, directoCompania, []
    );
    expect(cartera.efectivoCents).toBe(100000);
  });

  test("sobrante con batch totalmente rendido: cartera pendiente cae a 0 igual que antes (el sobrante lo carga creditoActivoEnCajaCents, no acá)", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyBatchToCartera(
      mkBatch({
        splits: [{ method: "cheque", amountCents: 110000, checks: [{ id: 1, amountCents: 110000 }] }],
        children: [{ paymentId: 1, status: "confirmado", rendered: 1, amountCents: 100000 }],
        appliedAmountCents: 100000,
      }),
      cartera, directoCompania, []
    );
    expect(cartera.totalCents).toBe(0);
  });

  test("sobrante con hijo mixto (parcial rendido) — se prorratea sobre la base capeada, sin drift", () => {
    const cartera = emptyMoneyBucket();
    const directoCompania = emptyDirectCompanyBucket();
    applyBatchToCartera(
      mkBatch({
        splits: [{ method: "cheque", amountCents: 220000, checks: [{ id: 1, amountCents: 220000 }] }],
        children: [
          { paymentId: 1, status: "confirmado", rendered: 0, amountCents: 100000 }, // pendiente
          { paymentId: 2, status: "confirmado", rendered: 1, amountCents: 100000 }, // rendido
        ],
        appliedAmountCents: 200000, // real 220000, aplicado 200000 → sobrante 20000 excluido
      }),
      cartera, directoCompania, []
    );
    // Base capeada 200000, 50% pendiente → 100000 (nunca 110000, la mitad del real).
    expect(cartera.chequeCents).toBe(100000);
  });
});

describe("calculateCajaNetaTotalCents", () => {
  test("suma cartera + crédito activo + crédito regularizado + cobros de saldo deudor", () => {
    const total = calculateCajaNetaTotalCents({
      carteraTotalCents: 100000,
      creditoActivoEnCajaCents: 10000,
      creditoRegularizadoCents: 0,
      cobrosSaldoDeudorCents: 0,
    });
    expect(total).toBe(110000);
  });

  test("un ajuste_manual (creditoActivo baja, creditoRegularizado sube en espejo) nunca mueve el total", () => {
    const antesDelAjuste = calculateCajaNetaTotalCents({
      carteraTotalCents: 0, creditoActivoEnCajaCents: 10000, creditoRegularizadoCents: 0, cobrosSaldoDeudorCents: 0,
    });
    const despuesDelAjuste = calculateCajaNetaTotalCents({
      carteraTotalCents: 0, creditoActivoEnCajaCents: 0, creditoRegularizadoCents: 10000, cobrosSaldoDeudorCents: 0,
    });
    expect(despuesDelAjuste).toBe(antesDelAjuste);
  });

  test("cobro de saldo deudor suma Caja como dinero real", () => {
    const total = calculateCajaNetaTotalCents({
      carteraTotalCents: 90000, creditoActivoEnCajaCents: 0, creditoRegularizadoCents: 0, cobrosSaldoDeudorCents: 10000,
    });
    expect(total).toBe(100000);
  });

  test("sin ningún movimiento de cuenta corriente, cajaNeta = cartera.total (sin regresión)", () => {
    const total = calculateCajaNetaTotalCents({
      carteraTotalCents: 50000, creditoActivoEnCajaCents: 0, creditoRegularizadoCents: 0, cobrosSaldoDeudorCents: 0,
    });
    expect(total).toBe(50000);
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

// ─── Hotfix — batch_child_payment (Migración 0029) nunca cuenta el batch
// completo en expectedCollectedCents (ver caja-summary.ts, comentario sobre
// collectDistinctExpectedSources) ─────────────────────────────────────────
describe("collectDistinctExpectedSources — batch_child_payment (hijo de batch rendido por separado)", () => {
  test("allocation solo con paymentId (sin paymentBatchId) → fuente individual", () => {
    const result = collectDistinctExpectedSources([
      { paymentId: 502, paymentBatchId: null, cashEntryId: null },
    ]);
    expect(result.standalonePaymentIds).toEqual([502]);
    expect(result.batchIds).toEqual([]);
  });

  test("allocation solo con paymentBatchId (sin paymentId) → lote completo", () => {
    const result = collectDistinctExpectedSources([
      { paymentId: null, paymentBatchId: 3, cashEntryId: null },
    ]);
    expect(result.batchIds).toEqual([3]);
    expect(result.standalonePaymentIds).toEqual([]);
  });

  test("allocation con paymentId Y paymentBatchId simultáneos → hijo individual, NUNCA el lote completo", () => {
    const result = collectDistinctExpectedSources([
      { paymentId: 493, paymentBatchId: 3, cashEntryId: null },
    ]);
    expect(result.standalonePaymentIds).toEqual([493]);
    expect(result.batchIds).toEqual([]); // el batch 3 NO debe aparecer acá
  });

  test("varias allocations del mismo hijo (paymentId+paymentBatchId repetido) no duplican la fuente", () => {
    const result = collectDistinctExpectedSources([
      { paymentId: 493, paymentBatchId: 3, cashEntryId: null },
      { paymentId: 493, paymentBatchId: 3, cashEntryId: null },
      { paymentId: 493, paymentBatchId: 3, cashEntryId: null },
    ]);
    expect(result.standalonePaymentIds).toEqual([493]);
    expect(result.batchIds).toEqual([]);
  });

  test("varias allocations del mismo lote completo (solo paymentBatchId) no duplican el lote", () => {
    const result = collectDistinctExpectedSources([
      { paymentId: null, paymentBatchId: 7, cashEntryId: null },
      { paymentId: null, paymentBatchId: 7, cashEntryId: null },
    ]);
    expect(result.batchIds).toEqual([7]);
    expect(result.standalonePaymentIds).toEqual([]);
  });

  test("combinación: hijo de batch + pago individual → ambos van a standalonePaymentIds, ningún batch completo", () => {
    const result = collectDistinctExpectedSources([
      { paymentId: 493, paymentBatchId: 3, cashEntryId: null }, // hijo de batch 3
      { paymentId: 502, paymentBatchId: null, cashEntryId: null }, // pago standalone
    ]);
    expect(result.standalonePaymentIds.sort((a, b) => a - b)).toEqual([493, 502]);
    expect(result.batchIds).toEqual([]);
  });

  test("combinación: lote completo + pago individual → el batch se cuenta aparte del pago", () => {
    const result = collectDistinctExpectedSources([
      { paymentId: null, paymentBatchId: 3, cashEntryId: null }, // instrumento del batch 3 completo
      { paymentId: 502, paymentBatchId: null, cashEntryId: null }, // pago standalone, sin relación al batch
    ]);
    expect(result.batchIds).toEqual([3]);
    expect(result.standalonePaymentIds).toEqual([502]);
  });

  test("rendición equivalente a #115: 3 hijos de batch 3 (rendidos por separado) + 1 pago standalone → expected $302.608, NO $760.122 (batch 3 completo)", () => {
    // Datos reales verificados por SELECT-only contra Turso producción (ver
    // diagnóstico de sesión anterior): batch 3 tiene 9 hijos, total_received_cents
    // = $652.282; la rendición #115 solo rindió 3 de esos 9 hijos (493/494/498)
    // + el pago standalone 502. El batch sigue con 6 hijos sin rendir (en cartera).
    const allocations = [
      { paymentId: 493, paymentBatchId: 3, cashEntryId: null }, // $42.270
      { paymentId: 494, paymentBatchId: 3, cashEntryId: null }, // $35.088
      { paymentId: 498, paymentBatchId: 3, cashEntryId: null }, // $117.410
      { paymentId: 502, paymentBatchId: null, cashEntryId: null }, // $107.840, standalone
    ];
    const distinct = collectDistinctExpectedSources(allocations);
    expect(distinct.batchIds).toEqual([]); // el batch 3 NUNCA debe aparecer como "completo" acá
    expect(distinct.standalonePaymentIds.sort((a, b) => a - b)).toEqual([493, 494, 498, 502]);

    const paymentAmountCentsById = new Map<number, number>([
      [493, 4227000], [494, 3508800], [498, 11741000], [502, 10784000],
    ]);
    // total_received_cents real del batch 3 (9 hijos) — no debe usarse en este cálculo.
    const batchTotalCentsById = new Map<number, number>([[3, 65228200]]);

    const sources = [
      ...distinct.standalonePaymentIds.map((id) => ({ kind: "standalone_payment" as const, amountCents: paymentAmountCentsById.get(id) ?? 0 })),
      ...distinct.batchIds.map((id) => ({ kind: "batch" as const, amountCents: batchTotalCentsById.get(id) ?? 0 })),
    ];
    const expectedCollectedCents = calculateExpectedCollectedCents(sources);

    expect(expectedCollectedCents).toBe(30260800); // $302.608 — la suma real de las 4 allocations
    expect(expectedCollectedCents).not.toBe(76012200); // $760.122 — lo que daba el bug (batch completo + standalone)
  });

  test("regresión: un batch rendido COMPLETO de una sola vez (sin ningún paymentId) sigue sumando su total_received_cents entero, sin cambios", () => {
    // Comportamiento previo a este fix, para un batch que SÍ se rinde entero
    // con su propio instrumento de cobranza (batch_split/batch_split_check) —
    // no debe verse afectado por distinguir el caso batch_child_payment.
    const allocations = [
      { paymentId: null, paymentBatchId: 9, cashEntryId: null },
      { paymentId: null, paymentBatchId: 9, cashEntryId: null }, // ej. 2 cheques del mismo split
    ];
    const distinct = collectDistinctExpectedSources(allocations);
    expect(distinct.batchIds).toEqual([9]);
    expect(distinct.standalonePaymentIds).toEqual([]);

    const batchTotalCentsById = new Map<number, number>([[9, 280000]]);
    const sources = distinct.batchIds.map((id) => ({ kind: "batch" as const, amountCents: batchTotalCentsById.get(id) ?? 0 }));
    expect(calculateExpectedCollectedCents(sources)).toBe(280000);
  });

  test("regresión: una rendición consistente con un batch completo real sigue clasificando 'complete', nunca pasa a 'inconsistent'", () => {
    // allocationSumCents de la rendición = exactamente el total del batch (caso
    // real: el batch se rindió entero, de una sola vez) — con el fix, este caso
    // sigue sin ningún paymentId, así que sigue tratándose como batch completo
    // y la comparación sigue cerrando exacto.
    const allocations = [
      { paymentId: null, paymentBatchId: 9, cashEntryId: null },
    ];
    const distinct = collectDistinctExpectedSources(allocations);
    const batchTotalCentsById = new Map<number, number>([[9, 280000]]);
    const sources = distinct.batchIds.map((id) => ({ kind: "batch" as const, amountCents: batchTotalCentsById.get(id) ?? 0 }));
    const expectedCollectedCents = calculateExpectedCollectedCents(sources);

    const c = classifyRemittanceForRendido({
      remittanceId: 999, date: "2027-01-01",
      allocations: [{ method: "transferencia_compania", amountCents: 280000, isProntoPagoSurcharge: false }],
      expectedCollectedCents, hasRealMoneyItems: true, legacyPaymentBreakdownRaw: "{}",
    });
    expect(c.state).toBe("complete");
    expect(c.inconsistency).toBeUndefined();
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
    // 10:00 UTC = 07:00 Argentina, mismo día en ambos husos.
    const [a] = buildAdeudadosDetalle([], [legacy({ createdAt: "2027-04-15T10:00:00.000Z" })]);
    expect(a!.fecha).toBe("2027-04-15");
    // 00:00 UTC = 21:00 del día anterior en Argentina — el día calendario
    // correcto es el 31/05, no el 01/06 (valor pre-fix, que asumía UTC).
    const [b] = buildAdeudadosDetalle([], [legacy({ createdAt: new Date("2027-06-01T00:00:00.000Z") })]);
    expect(b!.fecha).toBe("2027-05-31");
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
