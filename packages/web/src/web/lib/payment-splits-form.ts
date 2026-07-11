// Helpers puros para la sección "Medios de pago" (splits) de PaymentModal en
// Cobranzas (Etapa 3B-2). Sin JSX, sin estado de React — solo funciones que
// el componente llama. Reutiliza isMultipleOfCent/classifySplitGroup del
// backend (src/lib/payments/splits.ts, sin dependencias externas, seguro de
// importar en el bundle del frontend) en vez de reimplementar el mismo
// criterio dos veces.
//
// Ejecutar tests con: bun test packages/web/src/web/lib/__tests__/payment-splits-form.test.ts

import { isMultipleOfCent, classifySplitGroup, type SplitGroup } from "../../lib/payments/splits";

export type { SplitGroup };

export interface PaymentSplitFormRow {
  /** Solo para key de React — nunca se envía al backend. */
  uid: string;
  method: string;
  amount: string;
}

let uidCounter = 0;
export function nextSplitUid(): string {
  uidCounter += 1;
  return `split-${uidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSplitRow(method: string = "efectivo", amount: string = ""): PaymentSplitFormRow {
  return { uid: nextSplitUid(), method, amount };
}

/**
 * Precarga las filas del formulario a partir de un payment ya existente.
 * Si tiene splits reales (>=1), se usan tal cual (nunca "combinado" como
 * método de una fila — cada split guarda su método real). Si no vienen
 * splits (dato legacy/defensivo), arma una única fila desde
 * paymentMethod/amount, salvo que ese paymentMethod sea "combinado" (no es
 * un método real seleccionable) — en ese caso cae a "efectivo" antes que
 * mostrar un valor inválido.
 */
export function splitsFromPayment(payment: {
  paymentMethod: string;
  amount: number;
  splits?: ReadonlyArray<{ method: string; amountCents: number }> | null;
}): PaymentSplitFormRow[] {
  if (payment.splits && payment.splits.length > 0) {
    return payment.splits.map((s) => createSplitRow(s.method, String(s.amountCents / 100)));
  }
  const fallbackMethod = payment.paymentMethod === "combinado" ? "efectivo" : payment.paymentMethod;
  return [createSplitRow(fallbackMethod, String(payment.amount))];
}

export function addSplitRow(splits: PaymentSplitFormRow[], method: string = "efectivo"): PaymentSplitFormRow[] {
  return [...splits, createSplitRow(method)];
}

/**
 * Con exactamente un medio de pago, su importe SIEMPRE debe ser el mismo
 * que el importe total del cobro — no tiene sentido pedirle al usuario que
 * lo tipee dos veces. Se usa cada vez que cambia el total (cuota
 * seleccionada, importe tipeado a mano, inicialización de edición) para que
 * ese único split quede sincronizado sin intervención manual. Con 2+ splits
 * (reparto combinado real) no hace nada — ahí el reparto es siempre manual.
 */
export function syncSingleSplitAmount(splits: PaymentSplitFormRow[], amount: string): PaymentSplitFormRow[] {
  if (splits.length !== 1) return splits;
  return [{ ...splits[0]!, amount }];
}

export const SINGLE_SPLIT_MISMATCH_MESSAGE =
  "El importe del medio de pago debe coincidir con el total del cobro.";

/** No permite eliminar la última fila — devuelve el array sin cambios si solo queda 1. */
export function removeSplitRow(splits: PaymentSplitFormRow[], uid: string): PaymentSplitFormRow[] {
  if (splits.length <= 1) return splits;
  return splits.filter((s) => s.uid !== uid);
}

export function updateSplitRow(
  splits: PaymentSplitFormRow[],
  uid: string,
  patch: Partial<Pick<PaymentSplitFormRow, "method" | "amount">>
): PaymentSplitFormRow[] {
  return splits.map((s) => (s.uid === uid ? { ...s, ...patch } : s));
}

/**
 * Convierte un string de importe a centavos enteros, o null si es inválido:
 * vacío, no numérico, <= 0, o con más de dos decimales reales. Nunca
 * redondea/normaliza silenciosamente un valor inválido — mismo criterio que
 * el backend (isMultipleOfCent).
 */
export function amountStringToCentsStrict(raw: string): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!isMultipleOfCent(n)) return null;
  return Math.round(n * 100);
}

export interface SplitTotals {
  /** null si form.amount (el total del cobro) no es un importe válido. */
  totalCents: number | null;
  /** Suma de las filas con importe válido — las inválidas cuentan como 0 acá (igual bloquean el guardado por otro lado). */
  distributedCents: number;
  /** totalCents - distributedCents, o null si totalCents es null. */
  diferenciaCents: number | null;
  /** Centavos por fila, en el mismo orden que splits — null si esa fila es inválida. */
  rowCents: (number | null)[];
}

export function computeSplitTotals(totalAmountRaw: string, splits: PaymentSplitFormRow[]): SplitTotals {
  const totalCents = amountStringToCentsStrict(totalAmountRaw);
  const rowCents = splits.map((s) => amountStringToCentsStrict(s.amount));
  const distributedCents = rowCents.reduce((sum: number, c) => sum + (c ?? 0), 0);
  const diferenciaCents = totalCents == null ? null : totalCents - distributedCents;
  return { totalCents, distributedCents, diferenciaCents, rowCents };
}

export interface SplitsValidationResult {
  valid: boolean;
  /** Grupo resultante, o null si todavía no se puede clasificar (ej. falta un método). */
  group: SplitGroup | null;
  /** Mensaje a mostrar inline — null si valid. */
  errorMessage: string | null;
}

export const MIXED_GROUP_ERROR =
  "No se pueden combinar medios propios con pagos directos a la compañía en un mismo cobro.";

/**
 * Validación completa de la sección de splits: se llama tanto para decidir
 * el disabled del botón Guardar como DENTRO de handleSave (no depender solo
 * del disabled — un evento perdido o un estado stale no debe dejar pasar un
 * guardado inválido).
 */
export function validateSplitsForm(totalAmountRaw: string, splits: PaymentSplitFormRow[]): SplitsValidationResult {
  if (splits.length === 0) {
    return { valid: false, group: null, errorMessage: "Agregá al menos un medio de pago." };
  }
  for (const s of splits) {
    if (!s.method) {
      return { valid: false, group: null, errorMessage: "Todas las filas necesitan un método de pago." };
    }
  }
  const group = classifySplitGroup(splits.map((s) => ({ method: s.method })));
  if (group === "mixed") {
    return { valid: false, group, errorMessage: MIXED_GROUP_ERROR };
  }

  const totals = computeSplitTotals(totalAmountRaw, splits);
  if (totals.rowCents.some((c) => c == null)) {
    return {
      valid: false, group,
      errorMessage: "Cada importe debe ser mayor a cero y tener como máximo dos decimales.",
    };
  }
  if (totals.totalCents == null) {
    return { valid: false, group, errorMessage: "Ingresá un importe total válido." };
  }
  if (totals.diferenciaCents !== 0) {
    const abs = Math.abs(totals.diferenciaCents!) / 100;
    const msg = totals.diferenciaCents! > 0
      ? `Faltan distribuir $${abs.toFixed(2)}.`
      : `Se excede por $${abs.toFixed(2)}.`;
    return { valid: false, group, errorMessage: msg };
  }
  return { valid: true, group, errorMessage: null };
}

/** Misma condición que usa el botón "Imputar pago"/"Guardar cambios" — evita doble submit mientras guarda. */
export function isImputarButtonDisabled(saving: boolean, splitsValid: boolean): boolean {
  return saving || !splitsValid;
}

/** Payload para POST/PUT — nunca incluye el uid local ni paymentMethod="combinado". */
export function splitsToPayload(splits: PaymentSplitFormRow[]): { method: string; amount: number }[] {
  return splits.map((s) => ({ method: s.method, amount: Number(s.amount) }));
}

export interface GroupedSplitSummaryItem {
  method: string;
  amountCents: number;
}

/**
 * Agrupa splits repitiendo método (ej. dos transferencias) sumando sus
 * amountCents, preservando el orden de primera aparición — para el resumen
 * compacto de la tabla. No altera los splits originales ni el payload.
 */
export function groupSplitsByMethod(
  splits: ReadonlyArray<{ method: string; amountCents: number }>
): GroupedSplitSummaryItem[] {
  const order: string[] = [];
  const totals = new Map<string, number>();
  for (const s of splits) {
    if (!totals.has(s.method)) order.push(s.method);
    totals.set(s.method, (totals.get(s.method) ?? 0) + s.amountCents);
  }
  return order.map((method) => ({ method, amountCents: totals.get(method)! }));
}
