// Validación y normalización pura de received_checks (Etapa 4B) — cheques
// físicos concretos que componen un payment_batch_splits con method='cheque'.
// Sin DB, sin efectos secundarios — mismo estilo que splits.ts/batches.ts.
//
// Un cheque NUNCA apunta a un payment hijo ni a una cuota directamente: la
// relación con la cuota que termina pagando es siempre indirecta, a través
// de batch_split -> batch -> payments hijos (ver migración 0023). Uno o
// varios cheques pueden componer un mismo split cheque.

import { isValidCalendarDate } from "../installments/plan";
import { isMultipleOfCent } from "./splits";

export class ReceivedCheckValidationError extends Error {}

export type ReceivedCheckStatus =
  | "en_cartera"
  | "entregado_compania"
  | "cobrado"
  | "rechazado"
  | "anulado";

// ─── Campos de un cheque ──────────────────────────────────────────────────────

export interface ReceivedCheckInput {
  checkNumber: string;
  bankName: string;
  bankCode?: string | null;
  drawerName?: string | null;
  drawerDocument?: string | null;
  issueDate?: string | null;
  dueDate: string;
  amount: number;
  notes?: string | null;
}

export interface NormalizedReceivedCheck {
  checkNumber: string;
  bankName: string;
  bankCode: string | null;
  drawerName: string | null;
  drawerDocument: string | null;
  issueDate: string | null;
  dueDate: string;
  amountCents: number;
  currency: "ARS";
  notes: string | null;
}

function trimmedOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Valida la forma de un cheque tal cual llega del body: campos obligatorios
 * presentes (checkNumber, bankName, dueDate, amount), importe > 0 con máximo
 * dos decimales reales. NO valida fechas en detalle — eso es
 * validateCheckDate, que se corre aparte porque también se usa sola en tests
 * de fecha sin tener que rearmar un cheque completo. No normaliza
 * silenciosamente: cualquier campo obligatorio faltante o inválido lanza.
 */
export function validateReceivedCheckFields(raw: ReceivedCheckInput, label = "cheque"): void {
  const checkNumber = typeof raw?.checkNumber === "string" ? raw.checkNumber.trim() : "";
  if (!checkNumber) {
    throw new ReceivedCheckValidationError(`El número de cheque del ${label} no puede estar vacío.`);
  }
  const bankName = typeof raw?.bankName === "string" ? raw.bankName.trim() : "";
  if (!bankName) {
    throw new ReceivedCheckValidationError(`El banco del ${label} no puede estar vacío.`);
  }
  if (typeof raw?.dueDate !== "string" || !raw.dueDate) {
    throw new ReceivedCheckValidationError(`La fecha de vencimiento del ${label} es obligatoria.`);
  }
  const amount = Number(raw?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ReceivedCheckValidationError(`El importe del ${label} (${bankName} ${checkNumber}) debe ser un número mayor a cero.`);
  }
  if (!isMultipleOfCent(amount)) {
    throw new ReceivedCheckValidationError(`El importe del ${label} (${bankName} ${checkNumber}) no puede tener más de dos decimales: ${raw.amount}.`);
  }
}

/**
 * dueDate siempre obligatoria y debe ser una fecha calendario real
 * (YYYY-MM-DD, mismo criterio que isValidCalendarDate de
 * installments/plan.ts). issueDate es opcional; si viene, también debe ser
 * real, y dueDate >= issueDate (un cheque no puede vencer antes de emitirse).
 */
export function validateCheckDate(issueDate: string | null | undefined, dueDate: string, label = "cheque"): void {
  if (!isValidCalendarDate(dueDate)) {
    throw new ReceivedCheckValidationError(`La fecha de vencimiento del ${label} no es una fecha calendario válida: ${dueDate}.`);
  }
  if (issueDate == null || issueDate === "") return;
  if (!isValidCalendarDate(issueDate)) {
    throw new ReceivedCheckValidationError(`La fecha de emisión del ${label} no es una fecha calendario válida: ${issueDate}.`);
  }
  if (dueDate < issueDate) {
    throw new ReceivedCheckValidationError(`La fecha de vencimiento del ${label} (${dueDate}) no puede ser anterior a la de emisión (${issueDate}).`);
  }
}

/**
 * Valida forma + fechas y devuelve el cheque normalizado (importe en
 * centavos, strings recortados, currency fija en 'ARS' por ahora). No muta
 * `raw`. Lanza ReceivedCheckValidationError ante cualquier problema — no hay
 * resultado parcial.
 */
export function normalizeReceivedCheck(raw: ReceivedCheckInput, label = "cheque"): NormalizedReceivedCheck {
  validateReceivedCheckFields(raw, label);
  validateCheckDate(raw.issueDate, raw.dueDate, label);

  return {
    checkNumber: raw.checkNumber.trim(),
    bankName: raw.bankName.trim(),
    bankCode: trimmedOrNull(raw.bankCode),
    drawerName: trimmedOrNull(raw.drawerName),
    drawerDocument: trimmedOrNull(raw.drawerDocument),
    issueDate: trimmedOrNull(raw.issueDate),
    dueDate: raw.dueDate,
    amountCents: Math.round(Number(raw.amount) * 100),
    currency: "ARS",
    notes: trimmedOrNull(raw.notes),
  };
}

// ─── Suma contra el split ──────────────────────────────────────────────────────

export function sumReceivedChecksCents(checks: ReadonlyArray<{ amountCents: number }>): number {
  return checks.reduce((sum, c) => sum + c.amountCents, 0);
}

export interface ReceivedCheckValidationResult {
  valid: boolean;
  errorMessage: string | null;
}

/**
 * La suma de los cheques de un split cheque debe coincidir exactamente con
 * el importe de ese split (mismo criterio no-throwing que validateBatchTotals
 * de batches.ts, porque el importe del split ya se conoce de antes — no hace
 * falta encadenar excepciones para un chequeo que el endpoint quiere poder
 * convertir directamente en un 400 con su propio mensaje).
 */
export function validateChecksMatchSplit(
  checks: ReadonlyArray<{ amountCents: number }>,
  splitAmountCents: number
): ReceivedCheckValidationResult {
  const totalCents = sumReceivedChecksCents(checks);
  if (totalCents !== splitAmountCents) {
    return {
      valid: false,
      errorMessage:
        `La suma de los cheques ($${(totalCents / 100).toFixed(2)}) no coincide con el importe del split cheque ` +
        `($${(splitAmountCents / 100).toFixed(2)}).`,
    };
  }
  return { valid: true, errorMessage: null };
}

// ─── Posibles duplicados ────────────────────────────────────────────────────────

/** Cheque ya existente en la base, contra el que se compara un cheque nuevo. */
export interface ExistingCheckForDuplicateCheck {
  id: number;
  checkNumber: string;
  bankName: string;
  amountCents: number;
  dueDate: string;
  drawerName: string | null;
}

export interface PossibleCheckDuplicate {
  existingCheckId: number;
  // "weak": coincide banco+número. "strong": además coinciden importe,
  // vencimiento y librador — mucho más probable que sea el mismo cheque
  // cargado dos veces.
  strength: "weak" | "strong";
}

// ─── Vigencia para detección de duplicados ─────────────────────────────────────

/** Estados de la operación (batch o payment) de la que cuelga un cheque existente. */
export interface CheckDuplicateOriginStatus {
  checkStatus: ReceivedCheckStatus;
  batchStatus?: string | null;
  paymentStatus?: string | null;
}

/**
 * Un cheque existente solo cuenta para bloquear/advertir un alta nueva como
 * duplicado si sigue vigente: ni el cheque en sí, ni el batch del que
 * proviene (si vino de un batch_split), ni el payment individual del que
 * proviene (si vino de un payment_split) están anulados. Se chequean las
 * tres fuentes por separado — nunca alcanza con una sola — porque hay
 * cheques legacy vinculados a operaciones anuladas cuyo status propio quedó
 * desactualizado (antes de la migración 0028, que empezó a transicionar
 * received_checks a "anulado" al anular el batch/payment que los originó).
 */
export function isCheckActiveForDuplicateCheck(origin: CheckDuplicateOriginStatus): boolean {
  if (origin.checkStatus === "anulado") return false;
  if (origin.batchStatus === "anulado") return false;
  if (origin.paymentStatus === "anulado") return false;
  return true;
}

/**
 * Detecta candidatos a duplicado por banco+número (coincidencia mínima) y
 * marca "strong" cuando además coinciden importe, vencimiento y librador.
 * Nunca bloquea nada por sí sola — solo devuelve información para que el
 * endpoint decida (409 con confirmación explícita, ver index.ts) o para que
 * una futura UI advierta. drawerName null en ambos lados NO cuenta como
 * coincidencia de librador (no hay dato para comparar, no es evidencia de
 * duplicado). El caller es responsable de que `existing` ya venga filtrado a
 * cheques vigentes (ver isCheckActiveForDuplicateCheck) — esta función no
 * conoce batches ni payments, solo compara los campos del cheque.
 */
export function findPossibleCheckDuplicates(
  candidate: Pick<NormalizedReceivedCheck, "checkNumber" | "bankName" | "amountCents" | "dueDate" | "drawerName">,
  existing: ReadonlyArray<ExistingCheckForDuplicateCheck>
): PossibleCheckDuplicate[] {
  const matches: PossibleCheckDuplicate[] = [];
  for (const e of existing) {
    if (e.bankName !== candidate.bankName || e.checkNumber !== candidate.checkNumber) continue;
    const amountMatches = e.amountCents === candidate.amountCents;
    const dueDateMatches = e.dueDate === candidate.dueDate;
    const drawerMatches = candidate.drawerName != null && e.drawerName != null && candidate.drawerName === e.drawerName;
    const strength = amountMatches && dueDateMatches && drawerMatches ? "strong" : "weak";
    matches.push({ existingCheckId: e.id, strength });
  }
  return matches;
}

// ─── Estados y transiciones ─────────────────────────────────────────────────────

/**
 * reason='remittance_reversal' es el único contexto que habilita
 * entregado_compania -> en_cartera (una rendición que se revierte). Ninguna
 * otra transición usa este contexto todavía — se deja explícito en vez de
 * un boolean suelto para que quede claro *por qué* se permite, cuando se
 * implemente la reversión de rendiciones (no en 4B).
 */
export interface CheckStatusTransitionContext {
  reason?: "remittance_reversal";
}

const VALID_CHECK_TRANSITIONS: Record<ReceivedCheckStatus, ReceivedCheckStatus[]> = {
  en_cartera: ["entregado_compania", "anulado"],
  entregado_compania: ["cobrado", "rechazado", "en_cartera"],
  cobrado: [], // terminal
  rechazado: [], // terminal
  anulado: [], // terminal
};

/**
 * Valida una transición de estado de un cheque. cobrado/rechazado/anulado
 * son terminales (sin ninguna transición posible). entregado_compania ->
 * en_cartera solo se permite con context.reason='remittance_reversal' — sin
 * ese contexto (o con cualquier otro), se rechaza aunque figure en la tabla
 * de adyacencia, porque no es un "avance" normal del ciclo de vida sino una
 * reversión excepcional.
 */
export function validateCheckStatusTransition(
  current: ReceivedCheckStatus,
  next: ReceivedCheckStatus,
  context?: CheckStatusTransitionContext
): void {
  const allowed = VALID_CHECK_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new ReceivedCheckValidationError(`No se puede pasar un cheque de "${current}" a "${next}".`);
  }
  if (current === "entregado_compania" && next === "en_cartera" && context?.reason !== "remittance_reversal") {
    throw new ReceivedCheckValidationError(
      `No se puede volver un cheque de "entregado_compania" a "en_cartera" salvo por reversión de una rendición.`
    );
  }
}

// ─── Disponibilidad para rendición ─────────────────────────────────────────────

/**
 * Un cheque solo puede entrar en una futura rendición (entregarse a la
 * compañía) mientras esté en_cartera — cualquier otro estado ya salió de
 * cartera o es terminal. No implementa todavía el endpoint que arma la
 * rendición (Etapa 4C/4D), solo la regla pura que ese endpoint deberá aplicar.
 */
export function isCheckAvailableForRemittance(check: { status: ReceivedCheckStatus }): boolean {
  return check.status === "en_cartera";
}
