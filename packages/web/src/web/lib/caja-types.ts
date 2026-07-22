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

// Fase 2C — sobrantes/faltantes de cuenta corriente de asegurados (ver
// insured-account.ts en el backend). Informativo, nunca se mezcla con
// adeudadosDetalle/totalAdeudado (Regla 6 del pedido de sobrantes/faltantes).
export interface CuentaCorrienteInsuredBalance {
  insuredId: number;
  /** positivo = a favor del asegurado, negativo = deudor. */
  balance: number;
}

export interface CuentaCorriente {
  saldosAFavorPendientes: number;
  saldosDeudoresPendientes: number;
  creditoActivoEnCaja: number;
  creditoRegularizado: number;
  cobrosSaldoDeudor: number;
  byInsured: CuentaCorrienteInsuredBalance[];
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

// Espejo de AdeudadoOrigin/AdeudadoDetalleItem en
// src/lib/payments/caja-summary.ts (backend) — misma forma, sin `any`.
export type AdeudadoOrigin = "installment" | "manual_debt" | "cash_debt_legacy";

export interface AdeudadoDetalleItem {
  id: number;
  origen: AdeudadoOrigin;
  deudor: string;
  polizaODescripcion: string | null;
  compania: string | null;
  importe: number;
  fecha: string;
  estado: "pendiente";
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
  adeudadosDetalle: AdeudadoDetalleItem[];
  totalGastos: number;
  gastosMes: number;
  diferencia: number;
  // Opcional: un backend/caché más viejo puede no incluirlo todavía — la UI
  // debe tolerar su ausencia sin romper (ver hasCuentaCorriente en caja.tsx).
  cuentaCorriente?: CuentaCorriente;
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
