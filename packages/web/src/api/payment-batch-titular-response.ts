// Traducción de errores/resultado de runAccountHolderFundingBatch a
// respuesta HTTP — Etapa 1B-3-E. Extraído de POST /payment-batches (index.ts)
// para poder testear la política de errores/formato de respuesta de forma
// aislada (sin DB) — nunca reimplementa reglas de negocio, solo mapea tipos
// de error ya lanzados por otros módulos a {status, body}.

import { PaymentBatchRaceConditionError } from "./payment-batch-shared-inserts";
import { InstallmentNotCollectableError, installmentNotCollectableResponse } from "./installment-collectability-loader";
import {
  AccountHolderFundingBatchError, FundingPlanRaceConditionError, FundingIdempotencyConflictError,
  type RunAccountHolderFundingBatchResult,
} from "./account-holder-funding-batch";
import { AccountHolderFundingPlanError } from "../lib/payments/account-holder-funding-plan";
import { FundingValidationError } from "../lib/payments/account-holder-funding";

export interface HttpJsonResponse {
  status: number;
  body: unknown;
}

/**
 * Traduce el resultado EXITOSO de runAccountHolderFundingBatch (creación
 * fresca, reintento con misma key/fingerprint, o reconciliación tras perder
 * una carrera UNIQUE) a {status, body} — status/body son exactamente los
 * almacenados/devueltos por ese módulo, nunca reinterpretados.
 * responseSnapshot es un string opaco (ver account-holder-funding-batch.ts,
 * "responseSnapshot es un string opaco") — si no es JSON válido (dato
 * corrupto, o una fila ganadora ajena con forma inesperada), nunca se filtra
 * el contenido crudo ni el mensaje de parseo: 500 seguro y genérico.
 */
export function formatAccountHolderFundingBatchSuccess(result: RunAccountHolderFundingBatchResult): HttpJsonResponse {
  let parsedSnapshot: unknown;
  try {
    parsedSnapshot = JSON.parse(result.responseSnapshot);
  } catch {
    return { status: 500, body: { error: "No se pudo interpretar la respuesta almacenada del cobro con titular — contactá soporte." } };
  }
  return { status: result.responseStatus, body: parsedSnapshot };
}

/**
 * Mapea un error lanzado por runAccountHolderFundingBatch (o por los
 * callbacks que le inyecta el endpoint) a una respuesta HTTP segura — nunca
 * expone un error crudo de DB (p.ej. el texto real de un UNIQUE constraint,
 * que runAccountHolderFundingBatch ya reconcilia internamente y nunca debería
 * llegar acá; si igual llegara, cae al catch-all SQLITE_BUSY/LOCKED o se
 * re-lanza). Devuelve null cuando el error no es reconocido — el caller debe
 * re-lanzarlo tal cual (nunca ocultarlo ni convertirlo en un 500 genérico
 * sin más contexto).
 *
 *   InstallmentNotCollectableError    -> 400 (la cuota ya no está disponible para cobrar)
 *   PaymentBatchRaceConditionError    -> 409 (cuota cobrada por otra request)
 *   FundingPlanRaceConditionError     -> 409 (el saldo/plan cambió dentro de la tx)
 *   FundingIdempotencyConflictError   -> 409 (misma key, fingerprint distinto)
 *   AccountHolderFundingPlanError     -> 400 (crédito insuficiente, deuda sin
 *                                        autorizar, redondeo inválido, etc.)
 *   FundingValidationError            -> 400 (destinos/distribución inválidos)
 *   AccountHolderFundingBatchError    -> 400 (input inválido de dominio)
 *   SQLITE_BUSY / SQLITE_LOCKED       -> 409 (contención real de escritura)
 */
export function mapAccountHolderFundingBatchError(e: unknown): HttpJsonResponse | null {
  // Cuota que dejó de ser cobrable entre la validación previa y la
  // transacción (regla única de cobrabilidad, ver installment-collectability-loader.ts).
  if (e instanceof InstallmentNotCollectableError) return installmentNotCollectableResponse(e);
  if (e instanceof PaymentBatchRaceConditionError) {
    return { status: 409, body: { error: e.message, blockingInstallmentIds: e.installmentIds } };
  }
  if (e instanceof FundingPlanRaceConditionError) return { status: 409, body: { error: e.message } };
  if (e instanceof FundingIdempotencyConflictError) return { status: 409, body: { error: e.message } };
  if (e instanceof AccountHolderFundingPlanError) return { status: 400, body: { error: e.message } };
  if (e instanceof FundingValidationError) return { status: 400, body: { error: e.message } };
  if (e instanceof AccountHolderFundingBatchError) return { status: 400, body: { error: e.message } };

  const code = (e as any)?.code ?? (e as any)?.cause?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return { status: 409, body: { error: "Otra operación está en curso sobre estas cuotas — reintentá en unos segundos." } };
  }
  return null;
}
