// Desglose de financiación de un batch con titular de cuenta, para el
// comprobante (Etapa 1B-4). Se arma EXCLUSIVAMENTE desde datos persistidos
// que devuelve GET /payment-batches/:id: payment_batch_funding_allocations
// (fuente -> destino, en centavos) y los movimientos de cuenta corriente del
// batch (para distinguir crédito aplicado de deuda nueva y validar que
// sigan vigentes). Nunca desde el formulario ni desde texto.
//
// Por qué existe: en un batch titular el dinero real (SUM(splits)) es menor
// al aplicado a las cuotas a propósito — la diferencia la cubren crédito,
// redondeo o deuda. Calcular "Faltante = aplicado - medios reales" (lo que
// hace el comprobante legacy) es incorrecto en ese caso.
//
// Fuentes (una por allocation): split -> medio real; movimiento
// aplicacion_saldo_favor -> crédito aplicado; movimiento saldo_deudor ->
// deuda nueva; ajuste -> redondeo cubierto por oficina.
// Destinos (uno por allocation): payment/cash_entry -> aplicado a cuotas y
// recargos; movimiento saldo_a_favor -> saldo a favor nuevo.

import type { BatchDetailAccountMovement, BatchDetailFundingAllocation, PaymentBatchDetail } from "./payment-batch-form";

export interface TitularBatchFundingActive {
  kind: "active";
  accountHolder: { id: number; name: string } | null;
  realCents: number;
  creditAppliedCents: number;
  roundingCoverageCents: number;
  newDebtCents: number;
  newSaldoAFavorCents: number;
  appliedTotalCents: number;
  /** aplicado + saldo a favor nuevo - (real + crédito + redondeo + deuda nueva). 0 = cierra exacto. */
  differenceCents: number;
}

export interface TitularBatchFundingInactive {
  kind: "inactive";
  accountHolder: { id: number; name: string } | null;
}

export type TitularBatchFundingDisplay = TitularBatchFundingActive | TitularBatchFundingInactive;

/**
 * null si el batch no tiene titular de cuenta (legacy) — el comprobante
 * conserva entonces exactamente su display anterior. Un batch anulado
 * devuelve kind="inactive" sin ningún importe: su financiación ya no está
 * vigente y no debe mostrarse como activa. Las allocations que apuntan a un
 * movimiento anulado o inexistente se ignoran.
 */
export function summarizeTitularBatchFunding(
  detail: Pick<PaymentBatchDetail, "batch" | "accountMovements" | "accountHolder" | "fundingAllocations">,
): TitularBatchFundingDisplay | null {
  if (detail.batch.accountHolderInsuredId == null) return null;
  const accountHolder = detail.accountHolder ?? null;
  if (detail.batch.status !== "confirmado") return { kind: "inactive", accountHolder };

  const activeMovements = new Map<number, BatchDetailAccountMovement>();
  for (const m of detail.accountMovements) if (m.status === "activo") activeMovements.set(m.id, m);

  let realCents = 0, creditAppliedCents = 0, roundingCoverageCents = 0, newDebtCents = 0;
  let newSaldoAFavorCents = 0, appliedTotalCents = 0;

  const allocations: ReadonlyArray<BatchDetailFundingAllocation> = detail.fundingAllocations ?? [];
  for (const a of allocations) {
    if (a.paymentBatchSplitId != null) {
      realCents += a.amountCents;
    } else if (a.paymentAmountAdjustmentId != null) {
      roundingCoverageCents += a.amountCents;
    } else if (a.sourceAccountMovementId != null) {
      const source = activeMovements.get(a.sourceAccountMovementId);
      if (source?.type === "aplicacion_saldo_favor") creditAppliedCents += a.amountCents;
      else if (source?.type === "saldo_deudor") newDebtCents += a.amountCents;
      // Fuente anulada/inexistente: no suma como fuente, pero su destino igual
      // se cuenta abajo — así la diferencia final deja la inconsistencia a la vista.
    }

    if (a.paymentId != null || a.cashEntryId != null) {
      appliedTotalCents += a.amountCents;
    } else if (a.destinationAccountMovementId != null) {
      const destination = activeMovements.get(a.destinationAccountMovementId);
      if (destination?.type === "saldo_a_favor") newSaldoAFavorCents += a.amountCents;
    }
  }

  const differenceCents = appliedTotalCents + newSaldoAFavorCents
    - (realCents + creditAppliedCents + roundingCoverageCents + newDebtCents);

  return {
    kind: "active", accountHolder, realCents, creditAppliedCents, roundingCoverageCents,
    newDebtCents, newSaldoAFavorCents, appliedTotalCents, differenceCents,
  };
}

export interface TitularBatchFundingLine {
  label: string;
  amountCents: number;
  kind: "neutral" | "debt" | "credit" | "total" | "difference";
}

/** Mismo orden siempre; deuda nueva y saldo a favor nuevo solo si existen. */
export function buildTitularBatchFundingLines(display: TitularBatchFundingActive): TitularBatchFundingLine[] {
  const lines: TitularBatchFundingLine[] = [
    { label: "Medios reales recibidos", amountCents: display.realCents, kind: "neutral" },
    { label: "Crédito aplicado", amountCents: display.creditAppliedCents, kind: "credit" },
    { label: "Redondeo cubierto por oficina", amountCents: display.roundingCoverageCents, kind: "neutral" },
  ];
  if (display.newDebtCents > 0) lines.push({ label: "Deuda nueva del titular", amountCents: display.newDebtCents, kind: "debt" });
  // Neutral a propósito: el detalle no conoce el saldo previo del titular — si
  // ya debía, este sobrante canceló deuda anterior antes de quedar a favor.
  if (display.newSaldoAFavorCents > 0) lines.push({ label: "Sobrante a cuenta corriente", amountCents: display.newSaldoAFavorCents, kind: "credit" });
  lines.push({ label: "Total aplicado a cuotas", amountCents: display.appliedTotalCents, kind: "total" });
  lines.push({ label: "Diferencia final", amountCents: display.differenceCents, kind: "difference" });
  return lines;
}
