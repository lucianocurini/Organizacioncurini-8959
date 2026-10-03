// Helpers puros para la lista de "cobros pendientes de rendición" y las
// etiquetas de origen de adeudados en Caja. Sin DOM, sin fetch — mismo
// estilo que rebilling-groups.ts/polizas-filters.ts.

import type { AdeudadoOrigin } from "./caja-types";

export interface RenderableCashItem {
  rendered: number | boolean;
}

// La lista de cobrados de Caja queda fija en rendered=0 (pendientes de
// rendir) — sin toggle "Todos"/"Rendidos" en la UI (ver caja.tsx).
export function filterPendingCashItems<T extends RenderableCashItem>(items: readonly T[]): T[] {
  return items.filter((item) => !item.rendered);
}

// ─── "Desde Cobranzas": pagos de contado agrupados ───────────────────────────
//
// GET /api/cash/payments devuelve los payments tal cual; los hijos de un
// contado (Migración 0034) guardan el nominal de su cuota y paymentMethod
// "contado", así que listarlos sueltos mostraba N filas por el nominal. Caja
// usa el mismo ítem canónico que Nueva Rendición (GET /remittances/pending,
// source="payment_batch", ver remittance-pending-cash-period.ts): una fila
// por contado, por el importe aplicado, y oculta sus hijos. Pagos
// individuales y lotes normales no cambian.

export interface CajaPendingPayment {
  amount: number;
  batchId?: number | null;
}

export interface CajaCashPeriodItem {
  source: string;
  paymentBatchId: number;
  amount: number;
  blocked?: boolean | null;
}

export type CajaPendingCobranzaRow<P, C> =
  | { kind: "payment"; payment: P }
  | { kind: "cash_period"; item: C };

export interface CajaPendingCobranzaRows<P, C> {
  rows: Array<CajaPendingCobranzaRow<P, C>>;
  /** Suma visible: pagos + contados por su importe aplicado; sin bloqueados. */
  totalCents: number;
  blockedCount: number;
}

/**
 * Valida la respuesta de /api/remittances/pending para Caja. null si no se
 * puede usar (no es un array, o un contado sin paymentBatchId/amount
 * numéricos): sin ella Caja no sabe qué cuotas son hijas de un contado, así
 * que "Desde Cobranzas" no se lista (fail-closed) — nunca las cuotas sueltas.
 */
export function parseCajaRemittancePending(raw: unknown): CajaCashPeriodItem[] | null {
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (item == null || typeof item !== "object") return null;
    if ((item as any).source === "payment_batch" && (
      !Number.isFinite((item as any).paymentBatchId) || !Number.isFinite((item as any).amount)
    )) return null;
  }
  return raw as CajaCashPeriodItem[];
}

export type CajaRemittancePendingLoad =
  | { ok: true; items: CajaCashPeriodItem[] }
  | { ok: false };

/** Pide /api/remittances/pending sin rechazar nunca: error de red/HTTP o respuesta inválida → ok:false. */
export async function loadCajaRemittancePending(
  get: (path: string) => Promise<unknown>
): Promise<CajaRemittancePendingLoad> {
  try {
    const items = parseCajaRemittancePending(await get("/api/remittances/pending"));
    return items ? { ok: true, items } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Descarta respuestas desfasadas: cada carga llama a begin() y, al terminar,
 * solo aplica su resultado si isCurrent() — una carga vieja que resuelve
 * después de una más nueva no pisa sus datos.
 */
export function createLatestRequestTracker() {
  let seq = 0;
  return {
    begin(): { isCurrent: () => boolean } {
      const mine = ++seq;
      return { isCurrent: () => mine === seq };
    },
  };
}

/**
 * `pendingPayments`: payments de /api/cash/payments ya filtrados con
 * filterPendingCashItems. `remittancePending`: respuesta de
 * /api/remittances/pending (solo se usan sus ítems de contado). Cada contado
 * ocupa el lugar de su primer hijo en la lista; si no tiene hijos visibles
 * (p. ej. bloqueado sin cuotas), va al final.
 */
export function buildCajaPendingCobranzaRows<P extends CajaPendingPayment, C extends CajaCashPeriodItem>(
  pendingPayments: readonly P[],
  remittancePending: readonly C[]
): CajaPendingCobranzaRows<P, C> {
  const cashByBatchId = new Map<number, C>();
  for (const item of remittancePending) {
    if (item.source === "payment_batch") cashByBatchId.set(item.paymentBatchId, item);
  }

  const rows: Array<CajaPendingCobranzaRow<P, C>> = [];
  const placed = new Set<number>();
  for (const payment of pendingPayments) {
    const cash = payment.batchId != null ? cashByBatchId.get(payment.batchId) : undefined;
    if (!cash) {
      rows.push({ kind: "payment", payment });
      continue;
    }
    if (placed.has(cash.paymentBatchId)) continue;
    placed.add(cash.paymentBatchId);
    rows.push({ kind: "cash_period", item: cash });
  }
  for (const cash of cashByBatchId.values()) {
    if (!placed.has(cash.paymentBatchId)) rows.push({ kind: "cash_period", item: cash });
  }

  let totalCents = 0;
  let blockedCount = 0;
  for (const row of rows) {
    if (row.kind === "payment") {
      totalCents += Math.round(row.payment.amount * 100);
    } else if (row.item.blocked === true) {
      blockedCount++;
    } else {
      totalCents += Math.round(row.item.amount * 100);
    }
  }
  return { rows, totalCents, blockedCount };
}

const ADEUDADO_ORIGIN_LABELS: Record<AdeudadoOrigin, string> = {
  installment: "Cuota no cobrada",
  manual_debt: "Deuda manual",
  cash_debt_legacy: "Deuda manual anterior",
};

export function formatAdeudadoOrigin(origen: AdeudadoOrigin): string {
  return ADEUDADO_ORIGIN_LABELS[origen];
}
