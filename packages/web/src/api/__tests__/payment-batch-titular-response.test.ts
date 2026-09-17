/**
 * Etapa 1B-3-E — tests de payment-batch-titular-response.ts: traducción de
 * errores/resultado de runAccountHolderFundingBatch a respuesta HTTP. 100%
 * puro (sin DB) — misma política de errores que POST /payment-batches usa
 * en su rama titular.
 */

import { test, expect, describe } from "bun:test";
import { formatAccountHolderFundingBatchSuccess, mapAccountHolderFundingBatchError } from "../payment-batch-titular-response";
import { PaymentBatchRaceConditionError } from "../payment-batch-shared-inserts";
import {
  AccountHolderFundingBatchError, FundingPlanRaceConditionError, FundingIdempotencyConflictError,
  type RunAccountHolderFundingBatchResult,
} from "../account-holder-funding-batch";
import { AccountHolderFundingPlanError } from "../../lib/payments/account-holder-funding-plan";
import { FundingValidationError } from "../../lib/payments/account-holder-funding";

describe("1. formatAccountHolderFundingBatchSuccess", () => {
  test("responseSnapshot JSON válido: devuelve status/body exactos, sin reinterpretar", () => {
    const result: RunAccountHolderFundingBatchResult = { paymentBatchId: 42, responseStatus: 201, responseSnapshot: JSON.stringify({ id: 42 }) };
    const formatted = formatAccountHolderFundingBatchSuccess(result);
    expect(formatted).toEqual({ status: 201, body: { id: 42 } });
  });

  test("responseSnapshot corrupto (no es JSON): 500 seguro, sin filtrar el contenido ni el error de parseo", () => {
    const result: RunAccountHolderFundingBatchResult = { paymentBatchId: 42, responseStatus: 201, responseSnapshot: "{esto no es json válido" };
    const formatted = formatAccountHolderFundingBatchSuccess(result);
    expect(formatted.status).toBe(500);
    expect(JSON.stringify(formatted.body)).not.toContain("esto no es json"); // el snapshot crudo nunca se filtra
    expect(JSON.stringify(formatted.body)).not.toMatch(/SyntaxError|Unexpected token/i); // ni el error de parseo
  });

  test("responseSnapshot que parsea a algo inesperado (no objeto) igual se devuelve tal cual — este módulo no reinterpreta la forma", () => {
    const result: RunAccountHolderFundingBatchResult = { paymentBatchId: 42, responseStatus: 201, responseSnapshot: "42" };
    const formatted = formatAccountHolderFundingBatchSuccess(result);
    expect(formatted).toEqual({ status: 201, body: 42 });
  });

  test("status devuelto es SIEMPRE el almacenado, no un 201 fijo (reconciliación de una fila ganadora con otro status)", () => {
    const result: RunAccountHolderFundingBatchResult = { paymentBatchId: 7, responseStatus: 201, responseSnapshot: JSON.stringify({ id: 7 }) };
    expect(formatAccountHolderFundingBatchSuccess(result).status).toBe(201);
  });
});

describe("2. mapAccountHolderFundingBatchError", () => {
  test("PaymentBatchRaceConditionError -> 409 con blockingInstallmentIds", () => {
    const e = new PaymentBatchRaceConditionError([10, 20]);
    const mapped = mapAccountHolderFundingBatchError(e);
    expect(mapped).toEqual({ status: 409, body: { error: e.message, blockingInstallmentIds: [10, 20] } });
  });

  test("FundingPlanRaceConditionError -> 409", () => {
    const e = new FundingPlanRaceConditionError("el plan cambió");
    expect(mapAccountHolderFundingBatchError(e)).toEqual({ status: 409, body: { error: "el plan cambió" } });
  });

  test("FundingIdempotencyConflictError -> 409", () => {
    const e = new FundingIdempotencyConflictError("fingerprint distinto");
    expect(mapAccountHolderFundingBatchError(e)).toEqual({ status: 409, body: { error: "fingerprint distinto" } });
  });

  test("AccountHolderFundingPlanError (crédito insuficiente, deuda no autorizada, etc.) -> 400", () => {
    const e = new AccountHolderFundingPlanError("el crédito aplicado supera el disponible");
    expect(mapAccountHolderFundingBatchError(e)).toEqual({ status: 400, body: { error: "el crédito aplicado supera el disponible" } });
  });

  test("FundingValidationError -> 400", () => {
    const e = new FundingValidationError("destino inválido");
    expect(mapAccountHolderFundingBatchError(e)).toEqual({ status: 400, body: { error: "destino inválido" } });
  });

  test("AccountHolderFundingBatchError -> 400", () => {
    const e = new AccountHolderFundingBatchError("idempotencyKey inválida");
    expect(mapAccountHolderFundingBatchError(e)).toEqual({ status: 400, body: { error: "idempotencyKey inválida" } });
  });

  test("SQLITE_BUSY / SQLITE_LOCKED (code directo) -> 409 genérico, sin filtrar el error crudo", () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const locked = Object.assign(new Error("database is locked"), { code: "SQLITE_LOCKED" });
    for (const e of [busy, locked]) {
      const mapped = mapAccountHolderFundingBatchError(e);
      expect(mapped?.status).toBe(409);
      expect(JSON.stringify(mapped?.body)).not.toContain("database is locked"); // nunca el mensaje crudo de SQLite
    }
  });

  test("SQLITE_BUSY vía e.cause.code (envuelto por drizzle) -> 409 igual", () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: { code: "SQLITE_BUSY" } });
    expect(mapAccountHolderFundingBatchError(wrapped)?.status).toBe(409);
  });

  test("error desconocido (UNIQUE crudo u otro): devuelve null — el caller debe re-lanzarlo, nunca ocultarlo", () => {
    const rawUnique = new Error("UNIQUE constraint failed: account_holder_funding_idempotency_keys.created_by");
    expect(mapAccountHolderFundingBatchError(rawUnique)).toBeNull();

    const genericBug = new TypeError("Cannot read properties of undefined");
    expect(mapAccountHolderFundingBatchError(genericBug)).toBeNull();

    expect(mapAccountHolderFundingBatchError(null)).toBeNull();
    expect(mapAccountHolderFundingBatchError(undefined)).toBeNull();
    expect(mapAccountHolderFundingBatchError("string plano")).toBeNull();
  });
});
