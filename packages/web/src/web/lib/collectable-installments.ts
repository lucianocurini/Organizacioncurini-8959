// Cuotas cobrables en Cobranzas — lado frontend de la regla única de
// cobrabilidad (src/lib/payments/installment-collectability.ts). La lista
// SIEMPRE sale de GET /api/installments/pending-for-payment con la fecha de
// pago elegida (misma fuente para "Imputar pago" y "Cobrar en lote"); estas
// funciones solo adaptan la respuesta y detectan selecciones que dejaron de
// ser válidas al cambiar la fecha. El backend revalida igual al confirmar.

export interface PendingForPaymentRow {
  installmentId: number;
  installmentNumber: number;
  dueDate: string;
  amount: number;
  status: string;
  policyId: number;
}

/** Forma que ya usa el selector de cuota de "Imputar pago". */
export interface InstallmentOption {
  id: number;
  number: number;
  dueDate: string;
  amount: number;
  status: string;
  rendered: 0;
}

export function buildPendingForPaymentQuery(params: { paymentDate: string; policyId?: string | number | null }): string {
  const qs = new URLSearchParams();
  if (params.policyId != null && params.policyId !== "") qs.set("policyId", String(params.policyId));
  qs.set("paymentDate", params.paymentDate);
  return `/api/installments/pending-for-payment?${qs.toString()}`;
}

export function toInstallmentOptions(rows: ReadonlyArray<PendingForPaymentRow>): InstallmentOption[] {
  return rows
    .map((r) => ({ id: r.installmentId, number: r.installmentNumber, dueDate: r.dueDate, amount: r.amount, status: r.status, rendered: 0 as const }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number - b.number);
}

/** true si la cuota seleccionada ("" = ninguna) sigue en la lista de cobrables. */
export function isSelectedInstallmentStillCollectable(selectedInstallmentId: string, options: ReadonlyArray<{ id: number }>): boolean {
  if (!selectedInstallmentId) return true;
  return options.some((o) => String(o.id) === selectedInstallmentId);
}

/**
 * Desvincula una cuota que dejó de ser cobrable: limpia cuota, vencimiento e
 * importe (el importe venía de la cuota — no puede quedar cargado como si
 * fuera un cobro de póliza sin cuota). La póliza y el resto del formulario se
 * conservan. Restaurar la fecha no vuelve a seleccionar nada.
 */
export function detachUnavailableInstallment<F extends { installmentId: string; dueDate: string; amount: string }>(form: F): F {
  return { ...form, installmentId: "", dueDate: "", amount: "" };
}

export const INSTALLMENT_NO_LONGER_AVAILABLE_MESSAGE =
  "La cuota seleccionada ya no está disponible para esta fecha. Seleccioná otra cuota o ingresá nuevamente el importe si querés registrar un pago manual sin cuota.";

/** Ids de cuotas del carrito de "Cobrar en lote" que ya no son cobrables en la fecha elegida. */
export function findUnavailableCartInstallmentIds(
  cart: ReadonlyArray<{ kind: string; installmentId?: number }>,
  collectableInstallmentIds: ReadonlySet<number>
): number[] {
  return cart
    .filter((item) => item.kind === "installment" && item.installmentId != null && !collectableInstallmentIds.has(item.installmentId))
    .map((item) => item.installmentId as number);
}

/**
 * Ids cobrables de una respuesta de GET /installments/pending-for-payment, o
 * null si la respuesta no tiene la forma esperada (no es un array, o alguna
 * fila sin installmentId entero). null se trata igual que un error de red:
 * nunca como "todas disponibles".
 */
export function parseCollectableInstallmentIds(rows: unknown): Set<number> | null {
  if (!Array.isArray(rows)) return null;
  const ids = new Set<number>();
  for (const row of rows) {
    const id = (row as { installmentId?: unknown } | null)?.installmentId;
    if (typeof id !== "number" || !Number.isInteger(id)) return null;
    ids.add(id);
  }
  return ids;
}

/**
 * Resultado de la última consulta de cuotas cobrables de "Cobrar en lote",
 * siempre atado a la fecha de pago con la que se pidió: un resultado de otra
 * fecha nunca habilita la fecha actual.
 */
export type CollectableCheckState =
  | { status: "loading"; paymentDate: string }
  | { status: "invalid_date"; paymentDate: string }
  | { status: "error"; paymentDate: string }
  | { status: "ok"; paymentDate: string; collectableIds: ReadonlySet<number> };

/**
 * kind: "not_needed" = el carrito no tiene cuotas (la regla no aplica);
 * "error" = falla de red o respuesta inválida (fail closed). unavailableIds
 * solo tiene elementos con kind "unavailable".
 */
export interface CartCollectability {
  kind: "not_needed" | "checking" | "invalid_date" | "error" | "unavailable" | "ok";
  canConfirm: boolean;
  unavailableIds: number[];
}

/**
 * Disponibilidad del carrito para la fecha de pago ACTUAL, calculada con el
 * último resultado de esa misma fecha (agregar o quitar ítems no vuelve a
 * consultar). Fail closed: cargando, error, fecha inválida o un resultado de
 * otra fecha bloquean Confirmar. El backend revalida igual en la transacción.
 */
export function resolveCartCollectability(
  cart: ReadonlyArray<{ kind: string; installmentId?: number }>,
  check: CollectableCheckState,
  currentPaymentDate: string
): CartCollectability {
  if (!cart.some((item) => item.kind === "installment")) return { kind: "not_needed", canConfirm: true, unavailableIds: [] };
  if (check.paymentDate !== currentPaymentDate || check.status === "loading") return { kind: "checking", canConfirm: false, unavailableIds: [] };
  if (check.status === "invalid_date") return { kind: "invalid_date", canConfirm: false, unavailableIds: [] };
  if (check.status === "error") return { kind: "error", canConfirm: false, unavailableIds: [] };
  const unavailableIds = findUnavailableCartInstallmentIds(cart, check.collectableIds);
  return unavailableIds.length > 0
    ? { kind: "unavailable", canConfirm: false, unavailableIds }
    : { kind: "ok", canConfirm: true, unavailableIds: [] };
}

/** Fecha "YYYY-MM-DD" con forma válida (la validación calendario completa la hace el backend). */
export function looksLikeIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
