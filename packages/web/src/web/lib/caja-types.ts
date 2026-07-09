// Tipo de la respuesta de GET /api/cash/summary — reemplaza `summary: any` en
// caja.tsx sin reestructurar la página. Los montos públicos de la API están
// en pesos (no centavos) — ver src/lib/payments/caja-summary.ts en el backend.

export interface CarteraPropia {
  efectivo: number;
  transferencia: number;
  cheque: number;
  recargosProntoPago: number;
  total: number;
}

export interface DirectoCompania {
  transferencia_compania: number;
  link_pago: number;
  total: number;
}

export interface RendidoPorMetodo {
  efectivo: number;
  transferencia: number;
  cheque: number;
  pronto_pago: number;
  otros: number;
  total: number;
}

export interface RendidoDirectoCompania {
  transferencia_compania: number;
  link_pago: number;
  total: number;
}

export interface RemittanceInconsistencyDTO {
  remittanceId: number;
  date: string;
  allocationSumCents: number;
  expectedCollectedCents: number;
  reason: string;
}

export interface AllocationsModel {
  remittancesLegacyCount: number;
  remittancesCompleteCount: number;
  remittancesZeroCollectedCount: number;
  inconsistencias: RemittanceInconsistencyDTO[];
  legacyUnknownMethods: Record<string, number>;
}

export interface CarteraInconsistencyDTO {
  sourceType: string;
  sourceId: number;
  reason: string;
}

export interface CashSummaryPeriodo {
  from: string;
  to: string;
  cobrado: number;
  rendido: number;
  gastos: number;
  flujoNeto: number;
}

export interface CajaPropiaHistorico {
  comisiones: number;
  aportes: number;
  reintegros: number;
  gastosOperativos: number;
  sueldos: number;
  resultadoOperativo: number;
  saldoPropio: number;
  aportesPendientes: number;
}

export interface CajaPropiaPeriodo {
  from: string;
  to: string;
  comisiones: number;
  aportes: number;
  reintegros: number;
  gastosOperativos: number;
  sueldos: number;
  resultadoOperativo: number;
  flujoPropio: number;
}

export interface CashSummary {
  cartera: CarteraPropia;
  directoCompania: DirectoCompania;
  cajaNeta: CarteraPropia;
  rendidoPorMetodo: RendidoPorMetodo;
  rendidoDirectoCompania: RendidoDirectoCompania;
  allocationsModel: AllocationsModel;
  carteraInconsistencias: CarteraInconsistencyDTO[];
  totalRendiciones: number;
  totalCobrado: number;
  totalRendido: number;
  totalAdeudado: number;
  totalAdeudadoRendiciones: number;
  totalAdeudadoLegacy: number;
  totalGastos: number;
  gastosMes: number;
  diferencia: number;
  comisiones: { totalMes: number; totalAnio: number };
  iva: { totalMes: number; totalAnio: number };
  gananciaNeta: number;
  counts: {
    manualInCartera: number;
    manualRendered: number;
    paymentsInCartera: number;
    paymentsRendered: number;
    debts: number;
    adeudadosRendiciones: number;
    gastos: number;
    comisiones: number;
    iva: number;
  };
  periodo: CashSummaryPeriodo | null;
  cajaPropia: {
    historico: CajaPropiaHistorico;
    periodo: CajaPropiaPeriodo | null;
  };
}

// true si hay movimientos que el backend no pudo verificar y excluyó de los
// totales para evitar duplicaciones — dispara el aviso visible en caja.tsx.
export function hasUnverifiedCashSummaryData(summary: Pick<CashSummary, "allocationsModel" | "carteraInconsistencias">): boolean {
  return summary.allocationsModel.inconsistencias.length > 0 || summary.carteraInconsistencias.length > 0;
}
