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

const ADEUDADO_ORIGIN_LABELS: Record<AdeudadoOrigin, string> = {
  installment: "Cuota no cobrada",
  manual_debt: "Deuda manual",
  cash_debt_legacy: "Deuda manual anterior",
};

export function formatAdeudadoOrigin(origen: AdeudadoOrigin): string {
  return ADEUDADO_ORIGIN_LABELS[origen];
}
