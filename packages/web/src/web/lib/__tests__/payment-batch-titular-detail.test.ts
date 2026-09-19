import { describe, test, expect } from "bun:test";
import { summarizeTitularBatchFunding, buildTitularBatchFundingLines, type TitularBatchFundingActive } from "../payment-batch-titular-detail";
import type { BatchDetailAccountMovement, BatchDetailFundingAllocation, PaymentBatchDetail } from "../payment-batch-form";

type DetailInput = Pick<PaymentBatchDetail, "batch" | "accountMovements" | "accountHolder" | "fundingAllocations">;

const holder = { id: 7, name: "QA Titular Sintético" };

function batch(overrides: Partial<PaymentBatchDetail["batch"]> = {}): PaymentBatchDetail["batch"] {
  return {
    id: 1, insuredId: 2, baseAmountCents: 100000, surchargeAmountCents: 0, totalReceivedCents: 100000,
    receivedAmountCents: 69700, paymentDate: "2027-01-10", status: "confirmado", notes: null, createdAt: "2027-01-10",
    cancelledAt: null, cancellationReason: null, accountHolderInsuredId: 7, ...overrides,
  };
}
function mov(id: number, type: string, cents: number, status = "activo"): BatchDetailAccountMovement {
  return { id, insuredId: 7, type, signedAmountCents: cents, status, reason: null };
}
function alloc(id: number, amountCents: number, o: Partial<BatchDetailFundingAllocation>): BatchDetailFundingAllocation {
  return {
    id, paymentBatchSplitId: null, sourceAccountMovementId: null, paymentAmountAdjustmentId: null,
    paymentId: null, cashEntryId: null, destinationAccountMovementId: null, amountCents, ...o,
  };
}

// crédito 30000 + redondeo 300 + cheque 69700 -> cuota 100000
const creditRoundingDetail = (): DetailInput => ({
  batch: batch(), accountHolder: holder,
  accountMovements: [mov(2, "aplicacion_saldo_favor", -30000)],
  fundingAllocations: [
    alloc(1, 30000, { sourceAccountMovementId: 2, paymentId: 10 }),
    alloc(2, 300, { paymentAmountAdjustmentId: 1, paymentId: 10 }),
    alloc(3, 69700, { paymentBatchSplitId: 1, paymentId: 10 }),
  ],
});

function active(d: DetailInput): TitularBatchFundingActive {
  const s = summarizeTitularBatchFunding(d);
  if (!s || s.kind !== "active") throw new Error("expected active");
  return s;
}

describe("summarizeTitularBatchFunding", () => {
  test("crédito + redondeo + medio real: cierra en cero (69700 + 30000 + 300 = 100000)", () => {
    const s = active(creditRoundingDetail());
    expect(s.realCents).toBe(69700);
    expect(s.creditAppliedCents).toBe(30000);
    expect(s.roundingCoverageCents).toBe(300);
    expect(s.newDebtCents).toBe(0);
    expect(s.newSaldoAFavorCents).toBe(0);
    expect(s.appliedTotalCents).toBe(100000);
    expect(s.differenceCents).toBe(0);
    expect(s.accountHolder).toEqual(holder);
    const lines = buildTitularBatchFundingLines(s);
    expect(lines.map((l) => l.label)).toEqual([
      "Medios reales recibidos", "Crédito aplicado", "Redondeo cubierto por oficina", "Total aplicado a cuotas", "Diferencia final",
    ]);
    expect(lines[lines.length - 1]!.amountCents).toBe(0);
  });

  test("titular con deuda nueva: la deuda aparece como fuente y cierra en cero", () => {
    const s = active({
      batch: batch({ receivedAmountCents: 60000 }), accountHolder: holder,
      accountMovements: [mov(3, "saldo_deudor", -40000)],
      fundingAllocations: [
        alloc(1, 40000, { sourceAccountMovementId: 3, paymentId: 10 }),
        alloc(2, 60000, { paymentBatchSplitId: 1, paymentId: 10 }),
      ],
    });
    expect(s.newDebtCents).toBe(40000);
    expect(s.creditAppliedCents).toBe(0);
    expect(s.differenceCents).toBe(0);
    expect(buildTitularBatchFundingLines(s).map((l) => l.label)).toContain("Deuda nueva del titular");
  });

  test("titular con saldo a favor nuevo: sobrante real va a saldo nuevo y cierra en cero", () => {
    const s = active({
      batch: batch({ receivedAmountCents: 120000 }), accountHolder: holder,
      accountMovements: [mov(4, "saldo_a_favor", 20000)],
      fundingAllocations: [
        alloc(1, 100000, { paymentBatchSplitId: 1, paymentId: 10 }),
        alloc(2, 20000, { paymentBatchSplitId: 1, destinationAccountMovementId: 4 }),
      ],
    });
    expect(s.realCents).toBe(120000);
    expect(s.newSaldoAFavorCents).toBe(20000);
    expect(s.appliedTotalCents).toBe(100000);
    expect(s.differenceCents).toBe(0);
    const labels = buildTitularBatchFundingLines(s).map((l) => l.label);
    expect(labels).toContain("Saldo a favor nuevo");
    expect(labels).not.toContain("Deuda nueva del titular");
  });

  test("sin deuda ni saldo nuevo, esas líneas no se muestran", () => {
    const labels = buildTitularBatchFundingLines(active(creditRoundingDetail())).map((l) => l.label);
    expect(labels).not.toContain("Deuda nueva del titular");
    expect(labels).not.toContain("Saldo a favor nuevo");
  });

  test("legacy (sin accountHolderInsuredId): null — el comprobante conserva su display anterior", () => {
    expect(summarizeTitularBatchFunding({ ...creditRoundingDetail(), batch: batch({ accountHolderInsuredId: null }) })).toBeNull();
    expect(summarizeTitularBatchFunding({ ...creditRoundingDetail(), batch: batch({ accountHolderInsuredId: undefined }) })).toBeNull();
  });

  test("batch anulado: kind inactive, sin importes de financiación como vigentes", () => {
    const s = summarizeTitularBatchFunding({ ...creditRoundingDetail(), batch: batch({ status: "anulado" }) });
    expect(s).toEqual({ kind: "inactive", accountHolder: holder });
  });

  test("movimiento anulado dentro de un batch vigente: su allocation se ignora y la diferencia lo deja visible", () => {
    const d = creditRoundingDetail();
    d.accountMovements = [mov(2, "aplicacion_saldo_favor", -30000, "anulado")];
    const s = active(d);
    expect(s.creditAppliedCents).toBe(0);
    expect(s.differenceCents).not.toBe(0);
  });
});
