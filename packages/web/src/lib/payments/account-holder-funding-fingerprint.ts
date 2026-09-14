// Canonicalización pura del request de financiación de payment batches —
// Etapa 1B-2B-iii (ver diseño cerrado en la conversación de "cuenta
// corriente con titular de cuenta", 2026-09). Sin DB, sin HTTP, sin hash: el
// SHA-256 real y la integración con account_holder_funding_idempotency_keys
// (migración 0036) quedan para 1B-3 — este módulo solo produce el string
// JSON canónico que esa etapa futura va a hashear.
//
// ─── Contrato de entrada ────────────────────────────────────────────────
//
// Recibe un DTO YA VALIDADO Y NORMALIZADO (mismo criterio que el resto de
// src/lib/payments/*.ts) — nunca el body crudo del request. En particular:
//   - amountCents siempre entero (nunca un float en pesos).
//   - Strings opcionales ya resueltos a `null` cuando están vacíos/ausentes
//     (mismo criterio que normalizeBatchItems/normalizeBatchSplits/
//     normalizeReceivedCheck) — este módulo NO hace trim ni defaults, solo
//     valida que lo que llegó ya esté en forma canónica (trimeado).
//   - applyProntoPagoSurcharge ya resuelto a boolean estricto (la regla
//     `!== false` del endpoint ya se aplicó antes de llegar acá).
//   - El DTO no admite propiedades omitidas: todo campo del contrato debe
//     estar presente, con valor `null` explícito cuando no aplica — nunca
//     `undefined`.
//
// ─── Campos deliberadamente excluidos (no forman parte de este contrato) ──
//   idempotencyKey, confirmPossibleDuplicates, cualquier timestamp de
//   creación, cualquier id real asignado por DB, y cualquier total derivado
//   server-side (baseAmountCents/surchargeAmountCents/totalReceivedCents/
//   receivedCents) — se recalculan siempre desde items/splits, incluirlos
//   sería redundante y solo aumentaría el riesgo de que un fingerprint
//   quede desalineado si la fórmula de cálculo cambia.
//
// ─── Exclusión mutua legacy / flujo con titular ────────────────────────────
//
// accountDifferenceResolution (flujo legacy, sin titular explícito) y
// creditAppliedCents/roundingCoverageCents/debtAuthorized/debtReason (flujo
// nuevo, Etapa 1B-2A/1B-2B) son modelos de resolución de sobrante/faltante
// mutuamente excluyentes — no se complementan ni se reemplazan entre sí (ver
// diagnóstico cerrado): accountDifferenceResolution depende del insuredId
// LEGACY derivado de los ítems y nunca aplica crédito preexistente;
// creditAppliedCents sí, y depende del insuredId EXPLÍCITO elegido por quien
// cobra. Gateado por accountHolderInsuredId:
//   - accountHolderInsuredId != null (flujo nuevo): accountDifferenceResolution
//     debe ser null.
//   - accountHolderInsuredId == null (flujo legacy): creditAppliedCents=0,
//     roundingCoverageCents=0, debtAuthorized=false, debtReason=null.
//
// debtReason conserva la misma trazabilidad que ya exige el flujo legacy
// para saldo_deudor (REASON_REQUIRED_TYPES en insured-account.ts): con
// titular y debtAuthorized=true, debtReason es obligatorio (string no
// vacío); con debtAuthorized=false, debtReason debe ser null.
//
// ─── Orden ──────────────────────────────────────────────────────────────
//
// items y splits: el orden de entrada se preserva TAL CUAL — nunca se
// ordenan. Evidencia real: buildFundingAllocationDrafts (Etapa 1B-2A) reparte
// el cash agregado de cada destino entre los splits reales "en el ORDEN
// EXACTO recibido — cambiar ese orden cambia qué fila de la matriz cubre
// qué destino, aunque los totales por fuente/destino sigan siendo los
// mismos" — dos requests con igual contenido pero distinto orden pueden
// producir una matriz de allocations distinta a nivel de fila, así que deben
// tratarse como requests distintas a efectos de idempotencia.
//
// checks dentro de un split: se COPIAN (nunca se muta el array de entrada)
// y se ordenan canónicamente por la tupla completa de sus campos —
// comparación determinista, sin locale (comparación simple de strings por
// unidad de código UTF-16, nunca localeCompare). Ningún consumidor real
// referencia un cheque por posición dentro de su split (la matriz de
// financiación solo referencia el split como un todo, por su id real) —
// ordenarlos hace que dos requests con los mismos cheques en distinto orden
// de carga produzcan el mismo fingerprint. Un comparador total (por todos
// los campos) nunca "pierde" duplicados idénticos: dos cheques iguales en
// todos los campos comparan igual y ambos quedan en la salida.

import { isValidCalendarDate } from "../installments/plan";
import { ALLOWED_METHODS } from "./splits";

export class FundingRequestFingerprintInputError extends Error {}

// Constantes internas — NUNCA son parte del input ni se leen desde afuera;
// se embeben directamente en la salida canónica. Versionar acá (no en el
// input) es lo que evita que un cambio futuro de formato colisione en
// silencio con fingerprints ya calculados bajo una versión anterior.
const FUNDING_REQUEST_FINGERPRINT_VERSION = "account-holder-funding-request.v1";
const FUNDING_REQUEST_FINGERPRINT_ENDPOINT = "POST /payment-batches";

// ─── Validación de forma — mismo criterio que el resto de
// src/lib/payments/*.ts: nunca debe escapar un TypeError crudo por acceder
// a una propiedad de undefined/null/malformado. Duplicado acá (en vez de
// reusar los asserts de otros módulos) porque este módulo es dueño de su
// propia clase de error de dominio y de su propio contrato de entrada.

function assertPlainObject(label: string, value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FundingRequestFingerprintInputError(
      `${label} debe ser un objeto (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`
    );
  }
}

function assertArray(label: string, value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new FundingRequestFingerprintInputError(`${label} debe ser un array (recibido: ${value === null ? "null" : typeof value}).`);
  }
}

function assertStrictBoolean(label: string, value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new FundingRequestFingerprintInputError(
      `${label} debe ser exactamente true o false (recibido: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}).`
    );
  }
}

/** IDs/importes en centavos — enteros seguros, con mínimo explícito (1 para IDs/importes positivos, 0 para importes que legítimamente pueden ser cero). */
function assertSafeInt(label: string, value: unknown, options: { min: number }): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new FundingRequestFingerprintInputError(`${label} debe ser un entero seguro (recibido: ${value}).`);
  }
  if (value < options.min) {
    throw new FundingRequestFingerprintInputError(`${label} no puede ser menor a ${options.min} (recibido: ${value}).`);
  }
}

/** String obligatorio ya normalizado: no vacío, sin espacios al inicio/fin — se rechaza en vez de recortar (mismo criterio que assertCanonicalId en account-holder-funding-plan.ts). */
function assertCanonicalString(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new FundingRequestFingerprintInputError(`${label} debe ser un string (recibido: ${value === null ? "null" : typeof value}).`);
  }
  if (value.length === 0) {
    throw new FundingRequestFingerprintInputError(`${label} no puede estar vacío.`);
  }
  if (value !== value.trim()) {
    throw new FundingRequestFingerprintInputError(`${label} no puede tener espacios al inicio o al final (recibido: "${value}").`);
  }
}

/** null, o string canónico no vacío/no recortable — el DTO normalizado nunca usa "" en vez de null. */
function assertNullableCanonicalString(label: string, value: unknown): asserts value is string | null {
  if (value === null) return;
  assertCanonicalString(label, value);
}

function assertCalendarDateString(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !isValidCalendarDate(value)) {
    throw new FundingRequestFingerprintInputError(`${label} debe ser una fecha calendario válida en formato YYYY-MM-DD (recibido: ${value}).`);
  }
}

function assertNullableCalendarDateString(label: string, value: unknown): asserts value is string | null {
  if (value === null) return;
  assertCalendarDateString(label, value);
}

/**
 * Rechaza cualquier propiedad no reconocida, cualquier propiedad faltante, y
 * cualquier valor `undefined` explícito — el DTO normalizado no admite
 * ninguna de las tres cosas (ver cabecera del archivo).
 */
function assertExactKeys(label: string, value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): void {
  const actualKeys = new Set(Object.keys(value));
  for (const k of actualKeys) {
    if (!allowedKeys.has(k)) {
      throw new FundingRequestFingerprintInputError(`${label} tiene una propiedad inesperada: "${k}".`);
    }
  }
  for (const k of allowedKeys) {
    if (!actualKeys.has(k)) {
      throw new FundingRequestFingerprintInputError(`${label} le falta la propiedad "${k}".`);
    }
    if (value[k] === undefined) {
      throw new FundingRequestFingerprintInputError(`${label}.${k} no puede ser undefined.`);
    }
  }
}

// ─── Contrato de entrada ────────────────────────────────────────────────

export interface FingerprintCheckInput {
  checkNumber: string;
  bankName: string;
  bankCode: string | null;
  drawerName: string | null;
  drawerDocument: string | null;
  issueDate: string | null;
  dueDate: string;
  amountCents: number;
  notes: string | null;
}

export interface FingerprintSplitInput {
  method: string;
  amountCents: number;
  notes: string | null;
  /** Orden de entrada irrelevante — canonicalizeFundingRequest los copia y ordena canónicamente (ver cabecera). */
  checks: ReadonlyArray<FingerprintCheckInput>;
}

export type FingerprintItemInput =
  | { source: "installment"; installmentId: number }
  | { source: "policy_manual_payment"; policyId: number; amountCents: number; description: string | null }
  | {
      source: "manual_payment";
      manualPayer: string | null;
      manualPolicyNumber: string | null;
      manualCompany: string | null;
      amountCents: number;
      description: string | null;
    };

export type FingerprintAccountDifferenceResolution =
  | { action: "saldo_a_favor"; reason: string | null }
  | { action: "saldo_deudor"; reason: string }
  | { action: "ajuste_redondeo"; reason: string };

export interface FundingRequestFingerprintInput {
  paymentDate: string;
  /** null = flujo legacy (sin titular explícito). Positivo = flujo nuevo — ver exclusión mutua en la cabecera. */
  accountHolderInsuredId: number | null;
  /** Orden de entrada preservado tal cual — ver cabecera. */
  items: ReadonlyArray<FingerprintItemInput>;
  /** Orden de entrada preservado tal cual — ver cabecera. */
  splits: ReadonlyArray<FingerprintSplitInput>;
  notes: string | null;
  applyProntoPagoSurcharge: boolean;
  /** Solo flujo legacy — debe ser null cuando accountHolderInsuredId != null. */
  accountDifferenceResolution: FingerprintAccountDifferenceResolution | null;
  /** Solo flujo nuevo — debe ser 0 en el flujo legacy. */
  creditAppliedCents: number;
  /** Solo flujo nuevo — debe ser 0 en el flujo legacy. */
  roundingCoverageCents: number;
  /** Solo flujo nuevo — debe ser false en el flujo legacy. */
  debtAuthorized: boolean;
  /** Obligatorio (string no vacío) si accountHolderInsuredId != null y debtAuthorized=true; null en cualquier otro caso. */
  debtReason: string | null;
}

// ─── Claves permitidas por forma (whitelist exacta, ver assertExactKeys) ──

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "paymentDate", "accountHolderInsuredId", "items", "splits", "notes",
  "applyProntoPagoSurcharge", "accountDifferenceResolution",
  "creditAppliedCents", "roundingCoverageCents", "debtAuthorized", "debtReason",
]);
const ITEM_KEYS_INSTALLMENT: ReadonlySet<string> = new Set(["source", "installmentId"]);
const ITEM_KEYS_POLICY_MANUAL: ReadonlySet<string> = new Set(["source", "policyId", "amountCents", "description"]);
const ITEM_KEYS_MANUAL: ReadonlySet<string> = new Set([
  "source", "manualPayer", "manualPolicyNumber", "manualCompany", "amountCents", "description",
]);
const SPLIT_KEYS: ReadonlySet<string> = new Set(["method", "amountCents", "notes", "checks"]);
const CHECK_KEYS: ReadonlySet<string> = new Set([
  "checkNumber", "bankName", "bankCode", "drawerName", "drawerDocument", "issueDate", "dueDate", "amountCents", "notes",
]);
const RESOLUTION_KEYS: ReadonlySet<string> = new Set(["action", "reason"]);
const RESOLUTION_ACTIONS: ReadonlySet<string> = new Set(["saldo_a_favor", "saldo_deudor", "ajuste_redondeo"]);

// ─── Validación por entidad — cada validador devuelve un objeto NUEVO con
// las claves ya insertadas en el orden fijo que define la forma canónica
// (JSON.stringify respeta el orden de inserción de claves string no
// numéricas) — validación y construcción canónica ocurren en un solo paso,
// nunca se reordena aparte. ────────────────────────────────────────────────

function validateItem(raw: unknown, index: number): FingerprintItemInput {
  assertPlainObject(`El ítem en la posición ${index}`, raw);
  const source = raw.source;

  if (source === "installment") {
    assertExactKeys(`El ítem en la posición ${index} (installment)`, raw, ITEM_KEYS_INSTALLMENT);
    assertSafeInt(`El installmentId del ítem ${index}`, raw.installmentId, { min: 1 });
    return { source: "installment", installmentId: raw.installmentId as number };
  }
  if (source === "policy_manual_payment") {
    assertExactKeys(`El ítem en la posición ${index} (policy_manual_payment)`, raw, ITEM_KEYS_POLICY_MANUAL);
    assertSafeInt(`El policyId del ítem ${index}`, raw.policyId, { min: 1 });
    assertSafeInt(`El amountCents del ítem ${index}`, raw.amountCents, { min: 1 });
    assertNullableCanonicalString(`La description del ítem ${index}`, raw.description);
    return {
      source: "policy_manual_payment",
      policyId: raw.policyId as number,
      amountCents: raw.amountCents as number,
      description: raw.description as string | null,
    };
  }
  if (source === "manual_payment") {
    assertExactKeys(`El ítem en la posición ${index} (manual_payment)`, raw, ITEM_KEYS_MANUAL);
    assertNullableCanonicalString(`El manualPayer del ítem ${index}`, raw.manualPayer);
    assertNullableCanonicalString(`El manualPolicyNumber del ítem ${index}`, raw.manualPolicyNumber);
    assertNullableCanonicalString(`El manualCompany del ítem ${index}`, raw.manualCompany);
    assertSafeInt(`El amountCents del ítem ${index}`, raw.amountCents, { min: 1 });
    assertNullableCanonicalString(`La description del ítem ${index}`, raw.description);
    return {
      source: "manual_payment",
      manualPayer: raw.manualPayer as string | null,
      manualPolicyNumber: raw.manualPolicyNumber as string | null,
      manualCompany: raw.manualCompany as string | null,
      amountCents: raw.amountCents as number,
      description: raw.description as string | null,
    };
  }
  throw new FundingRequestFingerprintInputError(`El ítem en la posición ${index} tiene un source inválido: ${String(source)}.`);
}

function validateCheck(raw: unknown, splitIndex: number, checkIndex: number): FingerprintCheckInput {
  const label = `El cheque en la posición ${checkIndex} del split ${splitIndex}`;
  assertPlainObject(label, raw);
  assertExactKeys(label, raw, CHECK_KEYS);
  assertCanonicalString(`${label} (checkNumber)`, raw.checkNumber);
  assertCanonicalString(`${label} (bankName)`, raw.bankName);
  assertNullableCanonicalString(`${label} (bankCode)`, raw.bankCode);
  assertNullableCanonicalString(`${label} (drawerName)`, raw.drawerName);
  assertNullableCanonicalString(`${label} (drawerDocument)`, raw.drawerDocument);
  assertNullableCalendarDateString(`${label} (issueDate)`, raw.issueDate);
  assertCalendarDateString(`${label} (dueDate)`, raw.dueDate);
  assertSafeInt(`${label} (amountCents)`, raw.amountCents, { min: 1 });
  assertNullableCanonicalString(`${label} (notes)`, raw.notes);
  return {
    checkNumber: raw.checkNumber as string,
    bankName: raw.bankName as string,
    bankCode: raw.bankCode as string | null,
    drawerName: raw.drawerName as string | null,
    drawerDocument: raw.drawerDocument as string | null,
    issueDate: raw.issueDate as string | null,
    dueDate: raw.dueDate as string,
    amountCents: raw.amountCents as number,
    notes: raw.notes as string | null,
  };
}

// Comparación determinista e independiente de locale: `<`/`>` sobre strings
// compara por unidad de código UTF-16, nunca por reglas de colación de un
// idioma — el mismo par de strings compara siempre igual sin importar el
// entorno de ejecución (a diferencia de String.prototype.localeCompare).
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareStrings(a, b);
}
/** Tupla completa de todos los campos del cheque — orden total determinista; dos cheques iguales en todos los campos comparan 0 y ambos se preservan en la salida (nunca se deduplican). */
function compareChecks(a: FingerprintCheckInput, b: FingerprintCheckInput): number {
  return (
    compareStrings(a.bankName, b.bankName) ||
    compareStrings(a.checkNumber, b.checkNumber) ||
    compareStrings(a.dueDate, b.dueDate) ||
    compareNullableStrings(a.issueDate, b.issueDate) ||
    compareNullableStrings(a.bankCode, b.bankCode) ||
    compareNullableStrings(a.drawerName, b.drawerName) ||
    compareNullableStrings(a.drawerDocument, b.drawerDocument) ||
    (a.amountCents - b.amountCents) ||
    compareNullableStrings(a.notes, b.notes)
  );
}

function validateSplit(raw: unknown, index: number): FingerprintSplitInput {
  const label = `El split en la posición ${index}`;
  assertPlainObject(label, raw);
  assertExactKeys(label, raw, SPLIT_KEYS);
  assertCanonicalString(`${label} (method)`, raw.method);
  if (!ALLOWED_METHODS.has(raw.method as string)) {
    throw new FundingRequestFingerprintInputError(`${label} tiene un method no permitido: "${raw.method}".`);
  }
  assertSafeInt(`${label} (amountCents)`, raw.amountCents, { min: 1 });
  assertNullableCanonicalString(`${label} (notes)`, raw.notes);
  assertArray(`${label} (checks)`, raw.checks);

  const checks = (raw.checks as unknown[]).map((c, i) => validateCheck(c, index, i));
  // Copia + orden canónico — nunca se muta el array de entrada (raw.checks).
  const sortedChecks = [...checks].sort(compareChecks);

  return {
    method: raw.method as string,
    amountCents: raw.amountCents as number,
    notes: raw.notes as string | null,
    checks: sortedChecks,
  };
}

function validateResolution(raw: unknown): FingerprintAccountDifferenceResolution | null {
  if (raw === null) return null;
  assertPlainObject("input.accountDifferenceResolution", raw);
  assertExactKeys("input.accountDifferenceResolution", raw, RESOLUTION_KEYS);
  const action = raw.action;
  if (!RESOLUTION_ACTIONS.has(action as string)) {
    throw new FundingRequestFingerprintInputError(`input.accountDifferenceResolution.action inválida: ${String(action)}.`);
  }
  if (action === "saldo_a_favor") {
    assertNullableCanonicalString("input.accountDifferenceResolution.reason", raw.reason);
    return { action: "saldo_a_favor", reason: raw.reason as string | null };
  }
  if (action === "saldo_deudor") {
    assertCanonicalString("input.accountDifferenceResolution.reason", raw.reason);
    return { action: "saldo_deudor", reason: raw.reason as string };
  }
  // ajuste_redondeo: la razón final YA resuelta (con el default aplicado
  // aguas arriba si el caller no mandó una propia) — nunca null, nunca
  // undefined (ver cabecera del archivo, "no aplica... defaults").
  assertCanonicalString("input.accountDifferenceResolution.reason", raw.reason);
  return { action: "ajuste_redondeo", reason: raw.reason as string };
}

/**
 * Canonicaliza un request de financiación de payment batches a un string
 * JSON determinista y estable — mismo contenido semántico siempre produce
 * el mismo string, sin importar el orden de las claves del objeto de
 * entrada. No hashea (eso es 1B-3): esta es solo la forma canónica que se
 * va a hashear. No muta `input` ni ninguno de sus arrays anidados.
 */
export function canonicalizeFundingRequest(input: FundingRequestFingerprintInput): string {
  assertPlainObject("input", input);
  assertExactKeys("input", input, TOP_LEVEL_KEYS);

  assertCalendarDateString("input.paymentDate", input.paymentDate);
  const paymentDate = input.paymentDate as string;

  let accountHolderInsuredId: number | null = null;
  if (input.accountHolderInsuredId !== null) {
    assertSafeInt("input.accountHolderInsuredId", input.accountHolderInsuredId, { min: 1 });
    accountHolderInsuredId = input.accountHolderInsuredId as number;
  }

  assertArray("input.items", input.items);
  const items = (input.items as unknown[]).map((it, i) => validateItem(it, i));

  assertArray("input.splits", input.splits);
  const splits = (input.splits as unknown[]).map((s, i) => validateSplit(s, i));

  assertNullableCanonicalString("input.notes", input.notes);
  const notes = input.notes as string | null;

  assertStrictBoolean("input.applyProntoPagoSurcharge", input.applyProntoPagoSurcharge);
  const applyProntoPagoSurcharge = input.applyProntoPagoSurcharge as boolean;

  const accountDifferenceResolution = validateResolution(input.accountDifferenceResolution);

  assertSafeInt("input.creditAppliedCents", input.creditAppliedCents, { min: 0 });
  const creditAppliedCents = input.creditAppliedCents as number;

  assertSafeInt("input.roundingCoverageCents", input.roundingCoverageCents, { min: 0 });
  const roundingCoverageCents = input.roundingCoverageCents as number;

  assertStrictBoolean("input.debtAuthorized", input.debtAuthorized);
  const debtAuthorized = input.debtAuthorized as boolean;

  assertNullableCanonicalString("input.debtReason", input.debtReason);
  const debtReason = input.debtReason as string | null;

  // ─── Exclusión mutua legacy / flujo con titular (ver cabecera) ──────────
  if (accountHolderInsuredId !== null) {
    if (accountDifferenceResolution !== null) {
      throw new FundingRequestFingerprintInputError(
        "input.accountDifferenceResolution debe ser null cuando input.accountHolderInsuredId está presente (flujo nuevo con titular)."
      );
    }
    if (debtAuthorized && debtReason === null) {
      throw new FundingRequestFingerprintInputError("input.debtReason es obligatorio (string no vacío) cuando input.debtAuthorized=true.");
    }
    if (!debtAuthorized && debtReason !== null) {
      throw new FundingRequestFingerprintInputError("input.debtReason debe ser null cuando input.debtAuthorized=false.");
    }
  } else {
    if (creditAppliedCents !== 0) {
      throw new FundingRequestFingerprintInputError("input.creditAppliedCents debe ser 0 en el flujo legacy (sin accountHolderInsuredId).");
    }
    if (roundingCoverageCents !== 0) {
      throw new FundingRequestFingerprintInputError("input.roundingCoverageCents debe ser 0 en el flujo legacy (sin accountHolderInsuredId).");
    }
    if (debtAuthorized) {
      throw new FundingRequestFingerprintInputError("input.debtAuthorized debe ser false en el flujo legacy (sin accountHolderInsuredId).");
    }
    if (debtReason !== null) {
      throw new FundingRequestFingerprintInputError("input.debtReason debe ser null en el flujo legacy (sin accountHolderInsuredId).");
    }
  }

  const canonical = {
    version: FUNDING_REQUEST_FINGERPRINT_VERSION,
    endpoint: FUNDING_REQUEST_FINGERPRINT_ENDPOINT,
    paymentDate,
    accountHolderInsuredId,
    items,
    splits,
    notes,
    applyProntoPagoSurcharge,
    accountDifferenceResolution,
    creditAppliedCents,
    roundingCoverageCents,
    debtAuthorized,
    debtReason,
  };

  return JSON.stringify(canonical);
}
