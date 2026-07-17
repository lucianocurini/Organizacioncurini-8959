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
import { CONTABLE_METHODS, isContableMethod, type ContableMethod } from "../../lib/payments/caja-summary";

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

// ─── Medio de rendición (independiente del medio de cobro) ────────────────────
//
// Regla de negocio: el medio de cobro explica cómo entró la plata del
// cliente; el medio de rendición explica cómo Curini le paga/rinde a la
// compañía — no tienen por qué coincidir. Un hijo de un cobro por lote
// (payments.batchId != null) ya soporta esta desconexión a nivel contable
// (Migración 0029, resolveBatchChildPaymentInstrument) — el paymentMethod
// elegido en el modal reemplaza de verdad el instrumento de la allocation.
// Un pago standalone (o un cash_entry manual) NO: resolveStandalonePaymentInstruments
// sigue derivando remittance_allocations.method de los payment_splits reales,
// así que para esos casos el campo es hoy solo informativo (se guarda en
// remittance_items.paymentMethod, no cambia el asiento contable) — pendiente
// de una migración análoga a 0029 para standalone, fuera del alcance de esta
// etapa (decisión explícita: destrabar hijos de lote sin agrandar el cambio).

export interface PendingItemForBatchChildCheck {
  source?: string | null;
  batchId?: number | null;
}

/** true si el ítem es un payment hijo de un cobro por lote (payments.batchId != null). */
export function isBatchChildPendingPayment(item: PendingItemForBatchChildCheck): boolean {
  return item.source === "payment" && item.batchId != null;
}

/**
 * Default del selector "Medio de rendición": si todos los ítems seleccionados
 * comparten un único medio de cobro real (efectivo/transferencia/cheque/
 * link_pago/transferencia_compania), se usa ese como punto de partida —
 * conserva compatibilidad con el comportamiento anterior (sin selector, se
 * mandaba el medio de cobro tal cual). Si no hay un único medio real (mezcla
 * de medios, o solo "lote"/"combinado"/manual sin paymentMethod), se usa un
 * default neutro ("efectivo") en vez de fingir que se está reusando
 * automáticamente el medio de cobro de alguno de ellos en particular — el
 * selector queda siempre visible y editable de todas formas.
 */
export function computeDefaultRendicionMethod(
  items: ReadonlyArray<{ paymentMethod?: string | null }>
): ContableMethod {
  const realMethods = new Set<ContableMethod>();
  for (const i of items) {
    if (i.paymentMethod && isContableMethod(i.paymentMethod)) realMethods.add(i.paymentMethod);
  }
  return realMethods.size === 1 ? [...realMethods][0]! : "efectivo";
}

export { CONTABLE_METHODS };

/**
 * Arma los ítems del payload de POST /remittances con el medio de rendición
 * elegido por el usuario — SIEMPRE ese valor, nunca el paymentMethod original
 * del ítem (que podría colarse si algún día alguien vuelve a leer i.paymentMethod
 * por error). Así un pago cobrado en efectivo pero rendido por transferencia
 * nunca "recae" silenciosamente en efectivo en el payload.
 */
export function attachRendicionMethod<T extends { source: string }>(
  items: ReadonlyArray<T>,
  rendicionMethod: string
): Array<T & { paymentMethod: string }> {
  return items.map((i) => ({ ...i, paymentMethod: rendicionMethod }));
}

// ─── Labels de medio de rendición (contexto Rendición, NO Cobro) ──────────────
//
// Bug detectado en QA visual (2026-07): el listado/detalle de Rendiciones
// reusaba METHOD_LABELS de cobranzas.tsx — el mapa de labels del contexto de
// COBRO, donde "transferencia" se etiqueta "Transf. cuenta propia" para
// distinguirla de transferencia_compania/link_pago (plata que entra directo
// a la cuenta de la compañía en vez de a la cuenta propia de Curini). Esa
// distinción no aplica al medio de RENDICIÓN: acá "transferencia" significa
// "Curini le transfiere esto a la compañía", sin ninguna lectura de "cuenta
// propia" — mostrar esa etiqueta ahí sugiere (incorrectamente) que se trata
// del medio de cobro original o de una transferencia recibida en cuenta
// propia. El dato en sí (remittance_items.paymentMethod / remittance_
// allocations.method) siempre fue correcto — esto es un bug de label, no de
// dato (confirmado en QA: la allocation del hijo de batch queda method=
// "transferencia" tal cual se eligió).
export const RENDICION_METHOD_LABELS: Record<ContableMethod, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  cheque: "Cheque",
  link_pago: "Link de Pago",
  transferencia_compania: "Transferencia a Compañía",
};

/**
 * Label de un remittance_items.paymentMethod para mostrar en el listado/
 * detalle de Rendiciones. Nunca usar METHOD_LABELS (contexto Cobro) acá.
 * Fallback al valor crudo para casos legacy que no sean un ContableMethod
 * (ej. rendiciones viejas con paymentMethod=null o un valor no reconocido).
 */
export function getRendicionItemMethodLabel(paymentMethod: string | null | undefined): string {
  if (paymentMethod && isContableMethod(paymentMethod)) return RENDICION_METHOD_LABELS[paymentMethod];
  return paymentMethod ?? "—";
}
