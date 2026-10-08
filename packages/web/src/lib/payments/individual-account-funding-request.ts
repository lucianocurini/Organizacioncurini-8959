// Pago individual con saldo de cuenta corriente — POST /payments/account-funded.
// Sin DB, sin HTTP: valida la FORMA del body y lo traduce al mismo contrato
// que ya procesa el modo titular de POST /payment-batches (un lote de UN solo
// ítem), para reutilizar runAccountHolderFundingBatch sin una segunda versión
// de ninguna regla económica (plan, idempotencia, Caja, rendición, anulación).
//
// ─── Titular ─────────────────────────────────────────────────────────────
// El titular de cuenta es SIEMPRE el asegurado de la póliza, resuelto por el
// servidor desde la base — este módulo rechaza accountHolderInsuredId (o
// cualquier otro campo de titular/lote) en el body en vez de ignorarlo, para
// que un cliente nunca pueda creer que eligió el titular.
//
// ─── Alcance (etapa 1) ───────────────────────────────────────────────────
// Solo una cuota real de una póliza (installmentId obligatorio). Fuera de
// alcance: pago sin cuota específica, imputación sin póliza, contado por
// período y aplicación retroactiva a pagos ya creados.
//
// ─── Campos que los endpoints tradicionales rechazan ───────────────────────
// POST/PUT /payments nunca procesan financiación con saldo: si reciben alguno
// de ACCOUNT_FUNDING_FIELD_NAMES, responden 400 en vez de ignorarlo en
// silencio (findAccountFundingFields).

import { AccountHolderFundingRequestError } from "./account-holder-funding-request";

export class IndividualAccountFundingRequestError extends Error {}

/** Campos exclusivos de financiación con saldo/titular — nunca válidos en POST/PUT /payments. */
export const ACCOUNT_FUNDING_FIELD_NAMES = [
  "accountHolderInsuredId",
  "creditAppliedCents",
  "roundingCoverageCents",
  "debtAuthorized",
  "debtReason",
  "idempotencyKey",
  "accountDifferenceResolution",
] as const;

/** Campos de financiación presentes (no undefined) en un body de POST/PUT /payments. */
export function findAccountFundingFields(body: unknown): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  return ACCOUNT_FUNDING_FIELD_NAMES.filter((k) => k in record && record[k] !== undefined);
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "policyId",
  "installmentId",
  "paymentDate",
  "splits",
  "notes",
  "applyProntoPagoSurcharge",
  "creditAppliedCents",
  "roundingCoverageCents",
  "debtAuthorized",
  "debtReason",
  "idempotencyKey",
  "confirmPossibleDuplicates",
]);

export interface IndividualAccountFundedRequest {
  policyId: number;
  installmentId: number;
  /** Resto del body, sin tocar — lo valida parseFundingRequest al traducirlo (buildIndividualAccountFundedBatchBody). */
  rest: {
    paymentDate: unknown;
    splits: unknown;
    notes: unknown;
    applyProntoPagoSurcharge: unknown;
    creditAppliedCents: unknown;
    roundingCoverageCents: unknown;
    debtAuthorized: unknown;
    debtReason: unknown;
    idempotencyKey: unknown;
    confirmPossibleDuplicates: unknown;
  };
}

function assertSafePositiveInt(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new IndividualAccountFundingRequestError(`${label} debe ser un entero positivo (recibido: ${value === null ? "null" : String(value)}).`);
  }
}

/**
 * Importes de medios y cheques: siempre number. normalizeBatchSplits (compartido
 * con "Cobrar en lote") convierte strings numéricos — este endpoint nuevo no
 * hereda esa tolerancia. El resto (positivo, dos decimales, cheques que suman
 * el medio) lo valida parseFundingRequest después.
 */
function assertNumericSplitAmounts(splits: unknown): void {
  if (!Array.isArray(splits)) return; // forma inválida: la rechaza parseFundingRequest con su mensaje
  splits.forEach((split, i) => {
    if (typeof split !== "object" || split === null) return;
    const s = split as Record<string, unknown>;
    if (typeof s.amount !== "number") {
      throw new IndividualAccountFundingRequestError(`El importe del medio ${i + 1} debe ser un número (recibido: ${typeof s.amount}).`);
    }
    if (!Array.isArray(s.checks)) return;
    s.checks.forEach((check, j) => {
      if (typeof check === "object" && check !== null && typeof (check as Record<string, unknown>).amount !== "number") {
        throw new IndividualAccountFundingRequestError(`El importe del cheque ${j + 1} del medio ${i + 1} debe ser un número.`);
      }
    });
  });
}

/**
 * Valida la forma del body: whitelist exacta de claves (cualquier otra se
 * rechaza con su nombre), policyId/installmentId enteros positivos. No
 * consulta la base: la existencia de la póliza/cuota y el titular real los
 * resuelve el endpoint.
 */
export function parseIndividualAccountFundedRequest(body: unknown): IndividualAccountFundedRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new IndividualAccountFundingRequestError("El body debe ser un objeto.");
  }
  const record = body as Record<string, unknown>;

  if ("accountHolderInsuredId" in record) {
    throw new IndividualAccountFundingRequestError(
      "accountHolderInsuredId no se acepta: el titular de cuenta se obtiene siempre de la póliza en el servidor."
    );
  }
  const unknownKeys = Object.keys(record).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new IndividualAccountFundingRequestError(`Campo(s) no permitido(s) en un pago individual con saldo: ${unknownKeys.join(", ")}.`);
  }

  assertSafePositiveInt("policyId", record.policyId);
  if (record.installmentId === undefined || record.installmentId === null) {
    throw new IndividualAccountFundingRequestError("installmentId es obligatorio: el pago individual con saldo siempre cancela una cuota específica.");
  }
  assertSafePositiveInt("installmentId", record.installmentId);
  assertNumericSplitAmounts(record.splits);

  return {
    policyId: record.policyId,
    installmentId: record.installmentId,
    rest: {
      paymentDate: record.paymentDate,
      splits: record.splits,
      notes: record.notes,
      applyProntoPagoSurcharge: record.applyProntoPagoSurcharge,
      creditAppliedCents: record.creditAppliedCents,
      roundingCoverageCents: record.roundingCoverageCents,
      debtAuthorized: record.debtAuthorized,
      debtReason: record.debtReason,
      idempotencyKey: record.idempotencyKey,
      confirmPossibleDuplicates: record.confirmPossibleDuplicates,
    },
  };
}

/**
 * Traduce el request individual al body del modo titular de POST
 * /payment-batches: un único ítem "installment" y el titular RESUELTO por el
 * servidor (accountHolderInsuredId, nunca tomado del body original). Las
 * claves ausentes del request no se agregan (parseFundingRequest aplica sus
 * propios defaults). idempotencyKey es obligatoria — la exige parseFundingRequest
 * en modo titular.
 */
export function buildIndividualAccountFundedBatchBody(
  request: IndividualAccountFundedRequest,
  accountHolderInsuredId: number
): Record<string, unknown> {
  if (!Number.isSafeInteger(accountHolderInsuredId) || accountHolderInsuredId <= 0) {
    throw new AccountHolderFundingRequestError(`accountHolderInsuredId resuelto inválido: ${accountHolderInsuredId}.`);
  }
  const body: Record<string, unknown> = {
    items: [{ source: "installment", installmentId: request.installmentId }],
    accountHolderInsuredId,
  };
  for (const [k, v] of Object.entries(request.rest)) {
    if (v !== undefined) body[k] = v;
  }
  return body;
}
