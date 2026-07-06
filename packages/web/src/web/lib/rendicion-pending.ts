// Helper puro para clasificar ítems pendientes de rendición (own/direct_company)
// en NuevaRendicionModal (Cobranzas). No depende únicamente de paymentMethod,
// que puede valer "combinado" para un payment con 2+ splits (Etapa 3B) — un
// combinado direct_company (ej. transferencia_compania + link_pago) nunca
// matchea comparando strings contra ["transferencia_compania","link_pago"].
//
// Reutiliza classifySplitGroup/isDirectCompanyPaymentMethod de
// src/lib/payments/splits.ts (backend, sin dependencias externas, seguro de
// importar en el bundle del frontend) — mismo criterio en un solo lugar.
//
// Ejecutar tests con: bun test packages/web/src/web/lib/__tests__/rendicion-pending.test.ts

import { classifySplitGroup, isDirectCompanyPaymentMethod, type SplitGroup } from "../../lib/payments/splits";

export interface PendingItemSplit {
  id?: number;
  method: string;
  amount?: number;
  amountCents?: number;
}

export interface PendingItemForGrouping {
  paymentGroup?: SplitGroup | null;
  paymentMethod?: string | null;
  splits?: PendingItemSplit[] | null;
}

/**
 * Clasifica un ítem pendiente de rendición como "own", "direct_company" o
 * "mixed". "mixed" es defensivo — las reglas de Etapa 3B-1 ya rechazan mixed
 * en POST/PUT /payments, así que no debería llegar nunca desde el backend,
 * pero si llegara (dato inconsistente) se reporta tal cual en vez de
 * adivinar "own" o "direct_company" por defecto.
 *
 * Orden de prioridad:
 *   1. item.paymentGroup, si el backend ya lo mandó — GET /remittances/pending
 *      ya lo incluye tanto para payments (derivado de splits) como para
 *      cash_entries (derivado de paymentMethod único);
 *   2. si no viene paymentGroup pero sí splits, se clasifica con el mismo
 *      criterio que usa el backend (classifySplitGroup);
 *   3. fallback legacy por paymentMethod (transferencia_compania/link_pago
 *      → direct_company, cualquier otro valor → own) — solo si no hay ni
 *      paymentGroup ni splits.
 */
export function getPendingItemPaymentGroup(item: PendingItemForGrouping): SplitGroup {
  if (item.paymentGroup) return item.paymentGroup;
  if (item.splits && item.splits.length > 0) {
    return classifySplitGroup(item.splits);
  }
  return isDirectCompanyPaymentMethod(item.paymentMethod ?? "") ? "direct_company" : "own";
}
