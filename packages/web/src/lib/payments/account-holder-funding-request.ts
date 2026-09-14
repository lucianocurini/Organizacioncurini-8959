// Parsing, normalización y detección segura del modo de financiación de
// POST /payment-batches — Etapa 1B-3-A (ver diseño cerrado en la
// conversación de "cuenta corriente con titular de cuenta", 2026-09). Sin
// DB, sin HTTP — recibe el body crudo del request y devuelve todo lo que
// una etapa futura (1B-3-B en adelante) necesita para procesar el request,
// sin escribir nada. index.ts NO importa este módulo todavía (Etapa
// 1B-3-A es exclusivamente el helper; el guard explícito en el endpoint es
// una etapa posterior).
//
// ─── Reutilización — nunca reimplementa reglas existentes ─────────────────
//
// normalizeBatchItems/normalizeBatchSplits (batches.ts) y
// normalizeReceivedCheck/validateChecksMatchSplit (received-checks.ts) son
// exactamente los mismos que ya usa POST /payment-batches hoy — este módulo
// los invoca en el mismo orden y con la misma lógica de "cheque necesita
// >=1 cheque, split cheque nunca sin cheques, split no-cheque nunca con
// cheques" que index.ts (líneas 2896-2918), sin una segunda copia de esas
// reglas. ROUNDING_ADJUSTMENT_REASON (insured-account.ts) es la misma
// constante que ya usa el flujo legacy de accountDifferenceResolution
// (index.ts, rama ajuste_redondeo) — se reutiliza tal cual, nunca se
// retipea el string. canonicalizeFundingRequest (1B-2B-iii) es la única
// autoridad final sobre la validez del DTO — este módulo NORMALIZA y arma
// el DTO, pero delega en canonicalizeFundingRequest cualquier chequeo que
// ese módulo ya hace (p.ej. accountDifferenceResolution.action inválida
// para una action desconocida, formato de fecha) — nunca lo duplica.
//
// ─── Detección de modo — nunca degrada en silencio a legacy ────────────────
//
// El modo se decide EXCLUSIVAMENTE por la PRESENCIA de accountHolderInsuredId
// (no undefined, no null) — nunca por su validez. Un accountHolderInsuredId
// presente pero malformado (0, negativo, string, float) sigue siendo modo
// "titular" y se rechaza explícitamente ahí — nunca cae a legacy por no
// poder usarse. Simétricamente, en modo legacy cualquier campo "solo
// titular" (creditAppliedCents/roundingCoverageCents/debtAuthorized/
// debtReason/idempotencyKey) con un valor que no sea exactamente su neutro
// (0 / false / null, según el campo) se rechaza como request ambiguo — nunca
// se ignora en silencio ni se interpreta como si el titular estuviera
// implícito.
//
// accountHolderInsuredId acepta {ausente, null} como neutro (mismo criterio
// que su tipo number|null); creditAppliedCents/roundingCoverageCents/
// debtAuthorized aceptan {ausente, su propio neutro} — NUNCA null, porque
// sus tipos en el DTO final (FundingRequestFingerprintInput) son number/
// boolean, no nullable — un `null` explícito en esos campos en modo legacy
// se rechaza igual que cualquier otro valor no neutro.

import {
  normalizeBatchItems, normalizeBatchSplits, PaymentBatchValidationError,
  type NormalizedPaymentBatchItem, type NormalizedPaymentBatchSplit,
  type PaymentBatchItemInput, type PaymentBatchSplitInput,
} from "./batches";
import { normalizeReceivedCheck, validateChecksMatchSplit, type NormalizedReceivedCheck, type ReceivedCheckInput } from "./received-checks";
import { ROUNDING_ADJUSTMENT_REASON } from "./insured-account";
import {
  canonicalizeFundingRequest,
  type FundingRequestFingerprintInput,
  type FingerprintSplitInput,
  type FingerprintCheckInput,
  type FingerprintAccountDifferenceResolution,
} from "./account-holder-funding-fingerprint";

export class AccountHolderFundingRequestError extends Error {}

// ─── Validación de forma — mismo criterio que el resto de
// src/lib/payments/*.ts: nunca debe escapar un TypeError crudo. Duplicado
// acá porque este módulo es dueño de su propia clase de error de dominio.

function assertPlainObject(label: string, value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AccountHolderFundingRequestError(
      `${label} debe ser un objeto (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`
    );
  }
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function assertSafePositiveInt(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new AccountHolderFundingRequestError(`${label} debe ser un entero seguro y positivo (recibido: ${value}).`);
  }
}

/** Ausente -> 0. Presente -> entero seguro no negativo, o lanza. */
function normalizeOptionalNonNegativeInt(label: string, value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AccountHolderFundingRequestError(`${label} debe ser un entero seguro no negativo en centavos (recibido: ${value}).`);
  }
  return value;
}

/** Ausente -> defaultValue. Presente -> debe ser boolean estricto (nunca coerción truthy/falsy), o lanza. */
function normalizeOptionalStrictBoolean(label: string, value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new AccountHolderFundingRequestError(
      `${label} debe ser exactamente true o false (recibido: ${value === null ? "null" : typeof value}).`
    );
  }
  return value;
}

/** Ausente o null -> null. String -> recortado, "" pasa a null. Cualquier otro tipo -> lanza. */
function normalizeOptionalTrimmedString(label: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new AccountHolderFundingRequestError(`${label} debe ser un string (recibido: ${typeof value}).`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Cuenta caracteres Unicode (code points), no unidades UTF-16 ni bytes —
 * mismo criterio que SQLite length() sobre una columna TEXT (cuenta
 * caracteres, no bytes UTF-8), que es lo que realmente exige el CHECK de la
 * migración 0036. `String.prototype.length` cuenta unidades UTF-16 y
 * duplicaría el conteo de cualquier carácter fuera del BMP (p.ej. la
 * mayoría de los emoji) — el spread de string sí itera por code point.
 */
function countUnicodeCodePoints(value: string): number {
  return [...value].length;
}

/**
 * idempotencyKey: obligatoria, string, recortada, y con entre 1 y 200
 * caracteres Unicode DESPUÉS del recorte — mismo CHECK exacto que
 * account_holder_funding_idempotency_keys.idempotency_key (migración 0036:
 * length(idempotency_key) BETWEEN 1 AND 200), validado acá para nunca
 * depender de que el INSERT falle con el CHECK crudo de SQLite en una etapa
 * futura. El límite se aplica sobre el string YA recortado — " x " (3
 * caracteres) cuenta como 1, no como 3.
 */
function requireIdempotencyKey(label: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new AccountHolderFundingRequestError(`${label} debe ser un string (recibido: ${value === null ? "null" : typeof value}).`);
  }
  const trimmed = value.trim();
  const length = countUnicodeCodePoints(trimmed);
  if (length < 1) {
    throw new AccountHolderFundingRequestError(`${label} es obligatorio (string no vacío después de recortar espacios).`);
  }
  if (length > 200) {
    throw new AccountHolderFundingRequestError(`${label} no puede superar los 200 caracteres después de recortar espacios (recibido: ${length}).`);
  }
  return trimmed;
}

/** Modo legacy: el campo debe estar ausente o ser EXACTAMENTE su valor neutro (0 o false) — null u otro valor cualquiera se rechaza como ambiguo. */
function assertLegacyNeutral(label: string, value: unknown, neutral: number | boolean): void {
  if (value === undefined || value === neutral) return;
  throw new AccountHolderFundingRequestError(
    `${label} no puede tener un valor distinto de ${String(neutral)} sin accountHolderInsuredId (request ambiguo entre legacy y titular).`
  );
}

/** Modo legacy: el campo debe estar ausente o ser null — cualquier otro valor (incluida una string vacía) se rechaza como ambiguo. */
function assertLegacyNeutralNull(label: string, value: unknown): void {
  if (value === undefined || value === null) return;
  throw new AccountHolderFundingRequestError(
    `${label} no puede tener un valor sin accountHolderInsuredId (request ambiguo entre legacy y titular).`
  );
}

// ─── accountDifferenceResolution — mismo criterio de normalización que ya
// usa index.ts (líneas 3177-3179 y 3199) para los 3 actions, sin duplicar la
// validación de "action válida"/"reason obligatoria según el tipo": esa
// responsabilidad queda en canonicalizeFundingRequest, que ya la tiene.

function normalizeAccountDifferenceResolution(raw: unknown): FingerprintAccountDifferenceResolution | null {
  if (raw === undefined || raw === null) return null;
  assertPlainObject("body.accountDifferenceResolution", raw);
  const action = raw.action;

  if (action === "ajuste_redondeo") {
    const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : ROUNDING_ADJUSTMENT_REASON;
    return { action: "ajuste_redondeo", reason };
  }
  // saldo_a_favor / saldo_deudor / cualquier action desconocida: mismo
  // recorte compartido que index.ts aplica ANTES de derivar a
  // validateInsuredAccountMovement — si action no es una de las 3 válidas,
  // o si reason queda en null para saldo_deudor, canonicalizeFundingRequest
  // lo rechaza más abajo; acá solo se normaliza la forma.
  const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : null;
  return { action, reason } as unknown as FingerprintAccountDifferenceResolution;
}

// ─── Mapeo a la forma exacta que exige canonicalizeFundingRequest ─────────

function toFingerprintCheck(chk: NormalizedReceivedCheck): FingerprintCheckInput {
  // currency se excluye a propósito — hoy es siempre "ARS", sin varianza
  // real (ver account-holder-funding-fingerprint.ts, cabecera).
  return {
    checkNumber: chk.checkNumber,
    bankName: chk.bankName,
    bankCode: chk.bankCode,
    drawerName: chk.drawerName,
    drawerDocument: chk.drawerDocument,
    issueDate: chk.issueDate,
    dueDate: chk.dueDate,
    amountCents: chk.amountCents,
    notes: chk.notes,
  };
}

function toFingerprintSplit(swc: NormalizedSplitWithChecks): FingerprintSplitInput {
  return {
    method: swc.split.method,
    amountCents: swc.split.amountCents,
    notes: swc.split.notes,
    checks: swc.checks.map(toFingerprintCheck),
  };
}

// ─── Contrato de salida ─────────────────────────────────────────────────

export interface NormalizedSplitWithChecks {
  split: NormalizedPaymentBatchSplit;
  checks: NormalizedReceivedCheck[];
}

export interface FundingRequestParseResult {
  mode: "legacy" | "titular";
  normalizedItems: NormalizedPaymentBatchItem[];
  /** Cada split normalizado junto con sus cheques normalizados (vacío si el método no es "cheque") — misma agrupación que ya arma index.ts internamente. */
  splitsWithChecks: NormalizedSplitWithChecks[];
  /** DTO exacto para canonicalizeFundingRequest — ya validado por esa función al construir este resultado. */
  dto: FundingRequestFingerprintInput;
  /** String JSON canónico — ya calculado, listo para lookup/inserción de idempotencia en una etapa futura. */
  fingerprint: string;
  /** null en modo legacy. String no vacío (ya recortado) en modo titular. Nunca forma parte de dto ni de fingerprint. */
  idempotencyKey: string | null;
  /** Normalizado a boolean estricto (=== true). Nunca forma parte de dto ni de fingerprint. */
  confirmPossibleDuplicates: boolean;
}

/**
 * Parsea, normaliza y detecta el modo de un request de POST /payment-batches
 * — o lanza sin devolver nada parcial. No escribe nada, no conoce DB. No
 * muta `body` ni ninguna de sus propiedades anidadas.
 */
export function parseFundingRequest(body: unknown): FundingRequestParseResult {
  assertPlainObject("body", body);

  // ─── 1. Normalización reutilizada — items, splits, cheques ─────────────
  const normalizedItems = normalizeBatchItems(body.items as PaymentBatchItemInput[]);
  const normalizedSplits = normalizeBatchSplits(body.splits as PaymentBatchSplitInput[]);
  const rawSplits: unknown[] = Array.isArray(body.splits) ? body.splits : [];

  const splitsWithChecks: NormalizedSplitWithChecks[] = normalizedSplits.map((split, i) => {
    const rawSplitEntry = rawSplits[i] as Record<string, unknown> | undefined;
    const rawChecks = rawSplitEntry?.checks;
    if (split.method === "cheque") {
      if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
        throw new PaymentBatchValidationError(`El split cheque (medio ${i + 1}) debe incluir al menos un cheque.`);
      }
      const checks = rawChecks.map((raw: ReceivedCheckInput, j: number) => normalizeReceivedCheck(raw, `cheque ${j + 1} del medio ${i + 1}`));
      const totalsCheck = validateChecksMatchSplit(checks, split.amountCents);
      if (!totalsCheck.valid) throw new PaymentBatchValidationError(totalsCheck.errorMessage!);
      return { split, checks };
    }
    if (Array.isArray(rawChecks) && rawChecks.length > 0) {
      throw new PaymentBatchValidationError(`El medio ${i + 1} (${split.method}) no puede incluir cheques.`);
    }
    return { split, checks: [] };
  });

  // ─── 2. notes / applyProntoPagoSurcharge / confirmPossibleDuplicates ───
  // applyProntoPagoSurcharge y confirmPossibleDuplicates: misma regla exacta
  // que index.ts hoy (líneas 3113 y 3236) — solo `false`/`true` literales
  // cambian el comportamiento default. notes: se unifica con el criterio de
  // recorte que ya usa normalizeBatchSplits para notes de split (trim,
  // "" -> null) — es el único compatible con el contrato de
  // canonicalizeFundingRequest (exige strings ya recortados); el insert
  // legacy de payment_batches.notes (`body.notes || null`, sin recortar) no
  // se toca acá — esta normalización es específica del DTO de fingerprint.
  const notes = normalizeOptionalTrimmedString("body.notes", body.notes);
  const applyProntoPagoSurcharge = body.applyProntoPagoSurcharge !== false;
  const confirmPossibleDuplicates = body.confirmPossibleDuplicates === true;

  // ─── 3. Detección de modo — por presencia, nunca por validez ───────────
  const rawAccountHolderInsuredId = body.accountHolderInsuredId;
  const mode: "legacy" | "titular" = isPresent(rawAccountHolderInsuredId) ? "titular" : "legacy";

  let accountHolderInsuredId: number | null = null;
  let accountDifferenceResolution: FingerprintAccountDifferenceResolution | null = null;
  let creditAppliedCents = 0;
  let roundingCoverageCents = 0;
  let debtAuthorized = false;
  let debtReason: string | null = null;
  let idempotencyKey: string | null = null;

  if (mode === "titular") {
    assertSafePositiveInt("body.accountHolderInsuredId", rawAccountHolderInsuredId);
    accountHolderInsuredId = rawAccountHolderInsuredId as number;

    if (isPresent(body.accountDifferenceResolution)) {
      throw new AccountHolderFundingRequestError(
        "accountDifferenceResolution no puede venir junto con accountHolderInsuredId — son flujos de resolución mutuamente excluyentes."
      );
    }

    idempotencyKey = requireIdempotencyKey("body.idempotencyKey", body.idempotencyKey);

    creditAppliedCents = normalizeOptionalNonNegativeInt("body.creditAppliedCents", body.creditAppliedCents);
    roundingCoverageCents = normalizeOptionalNonNegativeInt("body.roundingCoverageCents", body.roundingCoverageCents);

    debtAuthorized = normalizeOptionalStrictBoolean("body.debtAuthorized", body.debtAuthorized, false);
    debtReason = normalizeOptionalTrimmedString("body.debtReason", body.debtReason);

    if (debtAuthorized && debtReason === null) {
      throw new AccountHolderFundingRequestError("body.debtReason es obligatorio (string no vacío) cuando body.debtAuthorized=true.");
    }
    if (!debtAuthorized && debtReason !== null) {
      throw new AccountHolderFundingRequestError("body.debtReason debe ser null cuando body.debtAuthorized=false (o está ausente).");
    }
  } else {
    // Legacy — cualquier campo "solo titular" con un valor no neutro es un
    // request ambiguo: nunca se ignora en silencio ni se interpreta como si
    // accountHolderInsuredId estuviera implícito.
    assertLegacyNeutral("body.creditAppliedCents", body.creditAppliedCents, 0);
    assertLegacyNeutral("body.roundingCoverageCents", body.roundingCoverageCents, 0);
    assertLegacyNeutral("body.debtAuthorized", body.debtAuthorized, false);
    assertLegacyNeutralNull("body.debtReason", body.debtReason);
    assertLegacyNeutralNull("body.idempotencyKey", body.idempotencyKey);

    // accountDifferenceResolution conserva el flujo legacy actual, sin cambios.
    accountDifferenceResolution = normalizeAccountDifferenceResolution(body.accountDifferenceResolution);
  }

  // ─── 4. DTO + fingerprint — canonicalizeFundingRequest es la autoridad
  // final: cualquier chequeo que ya hace (paymentDate, exclusión mutua,
  // signos, XOR) no se duplica acá.
  const dto: FundingRequestFingerprintInput = {
    paymentDate: body.paymentDate as string,
    accountHolderInsuredId,
    items: normalizedItems,
    splits: splitsWithChecks.map(toFingerprintSplit),
    notes,
    applyProntoPagoSurcharge,
    accountDifferenceResolution,
    creditAppliedCents,
    roundingCoverageCents,
    debtAuthorized,
    debtReason,
  };

  const fingerprint = canonicalizeFundingRequest(dto);

  return { mode, normalizedItems, splitsWithChecks, dto, fingerprint, idempotencyKey, confirmPossibleDuplicates };
}
