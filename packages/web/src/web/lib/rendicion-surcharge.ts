// Helper puro: recargo Pronto Pago esperado en NuevaRendicionModal (Cobranzas).
//
// Mismo criterio que POST /remittances:
//   - solo canal "pronto_pago" (cualquier otro canal = $0);
//   - payments con recargo ya registrado: se suma el importe GUARDADO del
//     cash_entry (surchargeAmount de GET /remittances/pending), nunca
//     cantidad × constante — un recargo histórico conserva su monto aunque
//     SURCHARGE_AMOUNT haya cambiado después;
//   - deudas manuales Rivadavia (sin cash_entry previo): SURCHARGE_AMOUNT
//     vigente, igual que el backend (manualDebtRivadaviaCount × SURCHARGE_AMOUNT).
//
// Ejecutar tests con: bun test packages/web/src/web/lib/__tests__/rendicion-surcharge.test.ts

import { SURCHARGE_AMOUNT } from "../../lib/payments/batches";

export interface RendicionSurchargePaymentItem {
  source: string;
  hasSurcharge?: boolean;
  surchargeAmount?: number | null;
  companyName?: string | null;
}

export interface RendicionSurchargeManualItem {
  companyName?: string | null;
}

export interface RendicionSurchargeSummary<P, M> {
  autoItems: P[];
  manualItems: M[];
  /** Payments Rivadavia sin recargo registrado — solo informativo, no suman. */
  rivadaviaWithoutSurcharge: P[];
  count: number;
  total: number;
  /** Importe por recargo si todos coinciden; null si hay importes distintos (ej. históricos de $800 junto a nuevos). */
  uniformUnitAmount: number | null;
}

function isRivadavia(companyName: string | null | undefined): boolean {
  return String(companyName ?? "").trim().toLowerCase().includes("rivadavia");
}

export function computeRendicionSurcharge<P extends RendicionSurchargePaymentItem, M extends RendicionSurchargeManualItem>(params: {
  canal: string;
  selectedCobradas: ReadonlyArray<P>;
  manualItems: ReadonlyArray<M>;
}): RendicionSurchargeSummary<P, M> {
  if (params.canal !== "pronto_pago") {
    return { autoItems: [], manualItems: [], rivadaviaWithoutSurcharge: [], count: 0, total: 0, uniformUnitAmount: null };
  }
  const autoItems = params.selectedCobradas.filter((i) => i.source === "payment" && i.hasSurcharge);
  const manualItems = params.manualItems.filter((i) => isRivadavia(i.companyName));
  const rivadaviaWithoutSurcharge = params.selectedCobradas.filter(
    (i) => i.source === "payment" && !i.hasSurcharge && isRivadavia(i.companyName)
  );
  const amounts = [
    ...autoItems.map((i) => i.surchargeAmount ?? SURCHARGE_AMOUNT),
    ...manualItems.map(() => SURCHARGE_AMOUNT),
  ];
  const totalCents = amounts.reduce((s, a) => s + Math.round(a * 100), 0);
  const uniformUnitAmount = amounts.length > 0 && amounts.every((a) => a === amounts[0]) ? amounts[0]! : null;
  return {
    autoItems,
    manualItems,
    rivadaviaWithoutSurcharge,
    count: amounts.length,
    total: totalCents / 100,
    uniformUnitAmount,
  };
}
