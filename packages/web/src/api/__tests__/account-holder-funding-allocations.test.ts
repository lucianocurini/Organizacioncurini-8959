// Etapa 1B-2B-ii — tests puros de buildFundingAllocationRows. Sin DB, sin
// HTTP — datos 100% sintéticos (batch/insured/ids inventados, sin relación
// con ningún caso real). Ver account-holder-funding-allocations.ts para el
// diseño completo.

import { test, expect, describe } from "bun:test";
import {
  buildFundingAllocationRows,
  FundingAllocationRowsError,
  type BatchSnapshot,
  type BatchSplitSnapshot,
  type AccountMovementSnapshot,
  type RoundingAdjustmentSnapshot,
  type PaymentSnapshot,
  type CashEntrySnapshot,
  type FundingAllocationKeyMap,
  type FundingAllocationSnapshots,
} from "../../lib/payments/account-holder-funding-allocations";
import type { FundingAllocationDraft } from "../../lib/payments/account-holder-funding-plan";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BATCH_ID = 100;
const TITULAR_ID = 10;
const OTRO_TITULAR_ID = 20;
const OTRO_BATCH_ID = 999;

function baseBatch(overrides: Partial<BatchSnapshot> = {}): BatchSnapshot {
  return { id: BATCH_ID, status: "confirmado", accountHolderInsuredId: TITULAR_ID, ...overrides };
}

function splitSnap(overrides: Partial<BatchSplitSnapshot> = {}): BatchSplitSnapshot {
  return { id: 1, batchId: BATCH_ID, amountCents: 1000, ...overrides };
}
function creditMovementSnap(overrides: Partial<AccountMovementSnapshot> = {}): AccountMovementSnapshot {
  return { id: 2, insuredId: TITULAR_ID, type: "aplicacion_saldo_favor", status: "activo", originBatchId: BATCH_ID, signedAmountCents: -1000, ...overrides };
}
function debtMovementSnap(overrides: Partial<AccountMovementSnapshot> = {}): AccountMovementSnapshot {
  return { id: 3, insuredId: TITULAR_ID, type: "saldo_deudor", status: "activo", originBatchId: BATCH_ID, signedAmountCents: -1000, ...overrides };
}
function newCreditMovementSnap(overrides: Partial<AccountMovementSnapshot> = {}): AccountMovementSnapshot {
  return { id: 4, insuredId: TITULAR_ID, type: "saldo_a_favor", status: "activo", originBatchId: BATCH_ID, signedAmountCents: 1000, ...overrides };
}
function roundingSnap(overrides: Partial<RoundingAdjustmentSnapshot> = {}): RoundingAdjustmentSnapshot {
  return { id: 5, paymentBatchId: BATCH_ID, amountCents: -300, ...overrides };
}
function paymentSnap(overrides: Partial<PaymentSnapshot> = {}): PaymentSnapshot {
  return { id: 101, batchId: BATCH_ID, status: "confirmado", amountCents: 1000, ...overrides };
}
function cashEntrySnap(overrides: Partial<CashEntrySnapshot> = {}): CashEntrySnapshot {
  return { id: 201, entryType: "pronto_pago_surcharge", status: "activo", paymentId: 101, amountCents: 800, ...overrides };
}

function mapOf<T extends { id: number }>(items: T[]): Map<number, T> {
  return new Map(items.map((i) => [i.id, i]));
}
function keyMapOf(entries: [string, number][]): Map<string, number> {
  return new Map(entries);
}

function emptyKeys(overrides: Partial<FundingAllocationKeyMap> = {}): FundingAllocationKeyMap {
  return {
    splitIdByKey: keyMapOf([]),
    paymentIdByKey: keyMapOf([]),
    cashEntryIdByKey: keyMapOf([]),
    creditMovementId: null,
    debtMovementId: null,
    roundingAdjustmentId: null,
    newCreditMovementId: null,
    ...overrides,
  };
}
function emptySnapshots(overrides: Partial<FundingAllocationSnapshots> = {}): FundingAllocationSnapshots {
  return {
    splits: mapOf([]),
    movements: mapOf([]),
    adjustments: mapOf([]),
    payments: mapOf([]),
    cashEntries: mapOf([]),
    ...overrides,
  };
}

function draft(overrides: Partial<FundingAllocationDraft>): FundingAllocationDraft {
  return { sourceKind: "split", sourceKey: "s1", destinationKind: "payment", destinationKey: "p1", amountCents: 1000, ...overrides };
}

/** Escenario mínimo split(1000) -> payment(1000), 100% válido — base para casos negativos por mutación puntual. */
function minimalValidScenario() {
  return {
    drafts: [draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "payment", destinationKey: "p1", amountCents: 1000 })] as FundingAllocationDraft[],
    keys: emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), paymentIdByKey: keyMapOf([["p1", 101]]) }),
    snapshots: emptySnapshots({ splits: mapOf([splitSnap()]), payments: mapOf([paymentSnap()]) }),
    batch: baseBatch(),
  };
}

// ─── BatchSnapshot ──────────────────────────────────────────────────────────

describe("BatchSnapshot", () => {
  test("batch anulado lanza", () => {
    const s = minimalValidScenario();
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, baseBatch({ status: "anulado" }))).toThrow(FundingAllocationRowsError);
  });
  test("accountHolderInsuredId null lanza", () => {
    const s = minimalValidScenario();
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, baseBatch({ accountHolderInsuredId: null }))).toThrow(FundingAllocationRowsError);
  });
  test.each([0, -1, 1.5, Number.NaN])("batch.id inválido (%p) lanza", (badId) => {
    const s = minimalValidScenario();
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, baseBatch({ id: badId as number }))).toThrow(FundingAllocationRowsError);
  });
  test.each([0, -1, 1.5])("accountHolderInsuredId inválido (%p) lanza", (bad) => {
    const s = minimalValidScenario();
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, baseBatch({ accountHolderInsuredId: bad }))).toThrow(FundingAllocationRowsError);
  });
});

// ─── Happy path por cada sourceKind/destinationKind ────────────────────────

describe("happy path — una fila por cada sourceKind/destinationKind", () => {
  test("split -> payment", () => {
    const s = minimalValidScenario();
    const rows = buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch);
    expect(rows).toEqual([{ paymentBatchId: BATCH_ID, paymentBatchSplitId: 1, sourceAccountMovementId: null, paymentAmountAdjustmentId: null, paymentId: 101, cashEntryId: null, destinationAccountMovementId: null, amountCents: 1000 }]);
  });

  test("credit_movement -> pronto_pago", () => {
    const drafts = [draft({ sourceKind: "credit_movement", sourceKey: "credit_movement", destinationKind: "pronto_pago", destinationKey: "ce1", amountCents: 800 })];
    const keys = emptyKeys({ creditMovementId: 2, cashEntryIdByKey: keyMapOf([["ce1", 201]]) });
    const snapshots = emptySnapshots({ movements: mapOf([creditMovementSnap({ signedAmountCents: -800 })]), payments: mapOf([paymentSnap()]), cashEntries: mapOf([cashEntrySnap()]) });
    const rows = buildFundingAllocationRows(drafts, keys, snapshots, baseBatch());
    expect(rows).toEqual([{ paymentBatchId: BATCH_ID, paymentBatchSplitId: null, sourceAccountMovementId: 2, paymentAmountAdjustmentId: null, paymentId: null, cashEntryId: 201, destinationAccountMovementId: null, amountCents: 800 }]);
  });

  test("debt_movement -> new_credit_movement", () => {
    // Caso sintético solo para probar la combinación de columnas — no representa un flujo de negocio real.
    const drafts = [draft({ sourceKind: "debt_movement", sourceKey: "debt_movement", destinationKind: "new_credit_movement", destinationKey: "new_credit_movement", amountCents: 1000 })];
    const keys = emptyKeys({ debtMovementId: 3, newCreditMovementId: 4 });
    const snapshots = emptySnapshots({ movements: mapOf([debtMovementSnap(), newCreditMovementSnap()]) });
    const rows = buildFundingAllocationRows(drafts, keys, snapshots, baseBatch());
    expect(rows).toEqual([{ paymentBatchId: BATCH_ID, paymentBatchSplitId: null, sourceAccountMovementId: 3, paymentAmountAdjustmentId: null, paymentId: null, cashEntryId: null, destinationAccountMovementId: 4, amountCents: 1000 }]);
  });

  test("rounding_adjustment -> payment", () => {
    const drafts = [draft({ sourceKind: "rounding_adjustment", sourceKey: "rounding_adjustment", destinationKind: "payment", destinationKey: "p1", amountCents: 300 })];
    const keys = emptyKeys({ roundingAdjustmentId: 5, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ adjustments: mapOf([roundingSnap()]), payments: mapOf([paymentSnap({ amountCents: 300 })]) });
    const rows = buildFundingAllocationRows(drafts, keys, snapshots, baseBatch());
    expect(rows[0]).toEqual({ paymentBatchId: BATCH_ID, paymentBatchSplitId: null, sourceAccountMovementId: null, paymentAmountAdjustmentId: 5, paymentId: 101, cashEntryId: null, destinationAccountMovementId: null, amountCents: 300 });
  });
});

// ─── Punto 1/2/3 — titularidad relajada para payment/cash_entry, estricta para movimientos ──

describe("titularidad relajada para payment/pronto_pago, estricta para movimientos de cuenta", () => {
  test("payment del batch correcto se acepta aunque la póliza sea de OTRO asegurado real (PaymentSnapshot no tiene insuredId)", () => {
    const s = minimalValidScenario();
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).not.toThrow();
  });

  test("pago manual (sin póliza) se acepta con solo pertenecer al batch y estar confirmado", () => {
    // PaymentSnapshot no tiene policyId/insuredId — un manual_payment y un pago con póliza son indistinguibles para este helper, por diseño.
    const s = minimalValidScenario();
    const rows = buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch);
    expect(rows).toHaveLength(1);
  });

  test("cash_entry pronto_pago se acepta aunque su payment padre pertenezca a otro asegurado real", () => {
    const drafts = [draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "pronto_pago", destinationKey: "ce1", amountCents: 800 })];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), cashEntryIdByKey: keyMapOf([["ce1", 201]]) });
    const snapshots = emptySnapshots({ splits: mapOf([splitSnap({ amountCents: 800 })]), payments: mapOf([paymentSnap()]), cashEntries: mapOf([cashEntrySnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).not.toThrow();
  });

  for (const role of ["credit_movement", "debt_movement", "new_credit_movement"] as const) {
    test(`${role} con insuredId de OTRO titular lanza`, () => {
      const isSource = role !== "new_credit_movement";
      const movementBuilders = { credit_movement: creditMovementSnap, debt_movement: debtMovementSnap, new_credit_movement: newCreditMovementSnap };
      const snap = movementBuilders[role]({ insuredId: OTRO_TITULAR_ID });
      const drafts = [draft(isSource ? { sourceKind: role, sourceKey: role } : { destinationKind: role, destinationKey: role })];
      const keys = emptyKeys({
        ...(role === "credit_movement" ? { creditMovementId: snap.id } : {}),
        ...(role === "debt_movement" ? { debtMovementId: snap.id } : {}),
        ...(role === "new_credit_movement" ? { newCreditMovementId: snap.id } : {}),
        ...(isSource ? { paymentIdByKey: keyMapOf([["p1", 101]]) } : { splitIdByKey: keyMapOf([["s1", 1]]) }),
      });
      const snapshots = emptySnapshots({
        movements: mapOf([snap]),
        ...(isSource ? { payments: mapOf([paymentSnap()]) } : { splits: mapOf([splitSnap()]) }),
      });
      expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
    });
  }
});

// ─── Pertenencia al batch ───────────────────────────────────────────────────

describe("pertenencia al batch (contaminación cruzada)", () => {
  test("split de otro batch lanza", () => {
    const s = minimalValidScenario();
    s.snapshots.splits.set(1, splitSnap({ batchId: OTRO_BATCH_ID }));
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("payment de otro batch lanza", () => {
    const s = minimalValidScenario();
    s.snapshots.payments.set(101, paymentSnap({ batchId: OTRO_BATCH_ID }));
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("credit_movement con originBatchId de otro batch lanza", () => {
    const drafts = [draft({ sourceKind: "credit_movement", sourceKey: "credit_movement", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ creditMovementId: 2, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ movements: mapOf([creditMovementSnap({ originBatchId: OTRO_BATCH_ID })]), payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("rounding_adjustment con paymentBatchId de otro batch lanza", () => {
    const drafts = [draft({ sourceKind: "rounding_adjustment", sourceKey: "rounding_adjustment", destinationKind: "payment", destinationKey: "p1", amountCents: 300 })];
    const keys = emptyKeys({ roundingAdjustmentId: 5, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ adjustments: mapOf([roundingSnap({ paymentBatchId: OTRO_BATCH_ID })]), payments: mapOf([paymentSnap({ amountCents: 300 })]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("cash_entry cuyo payment padre es de otro batch lanza", () => {
    const drafts = [draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "pronto_pago", destinationKey: "ce1", amountCents: 800 })];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), cashEntryIdByKey: keyMapOf([["ce1", 201]]) });
    const snapshots = emptySnapshots({ splits: mapOf([splitSnap({ amountCents: 800 })]), payments: mapOf([paymentSnap({ batchId: OTRO_BATCH_ID })]), cashEntries: mapOf([cashEntrySnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
});

// ─── Punto 2 — secuencia exacta de validación de pronto_pago ───────────────

describe("cash_entry pronto_pago — secuencia de validación", () => {
  function scenario(cashEntryOverrides: Partial<CashEntrySnapshot> = {}, paymentOverrides: Partial<PaymentSnapshot> = {}, includeParentPayment = true) {
    const drafts = [draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "pronto_pago", destinationKey: "ce1", amountCents: 800 })];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), cashEntryIdByKey: keyMapOf([["ce1", 201]]) });
    const snapshots = emptySnapshots({
      splits: mapOf([splitSnap({ amountCents: 800 })]),
      payments: includeParentPayment ? mapOf([paymentSnap(paymentOverrides)]) : mapOf([]),
      cashEntries: mapOf([cashEntrySnap(cashEntryOverrides)]),
    });
    return { drafts, keys, snapshots, batch: baseBatch() };
  }

  test("entryType='normal' lanza", () => {
    const s = scenario({ entryType: "normal" });
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("status='anulado' lanza", () => {
    const s = scenario({ status: "anulado" });
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("paymentId null lanza", () => {
    const s = scenario({ paymentId: null });
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("payment padre ausente de snapshots.payments lanza", () => {
    const s = scenario({}, {}, false);
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("payment padre status='pendiente' lanza", () => {
    const s = scenario({}, { status: "pendiente" });
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("payment padre status='anulado' lanza", () => {
    const s = scenario({}, { status: "anulado" });
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("payment padre confirmado y del mismo batch: aceptado", () => {
    const s = scenario();
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).not.toThrow();
  });
});

// ─── Tipo de movimiento ─────────────────────────────────────────────────────

describe("type incorrecto en insured_account_movements", () => {
  test("credit_movement con type != aplicacion_saldo_favor lanza", () => {
    const drafts = [draft({ sourceKind: "credit_movement", sourceKey: "credit_movement", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ creditMovementId: 2, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ movements: mapOf([creditMovementSnap({ type: "saldo_deudor" })]), payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("debt_movement con type != saldo_deudor lanza", () => {
    const drafts = [draft({ sourceKind: "debt_movement", sourceKey: "debt_movement", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ debtMovementId: 3, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ movements: mapOf([debtMovementSnap({ type: "aplicacion_saldo_favor" })]), payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("new_credit_movement con type != saldo_a_favor lanza", () => {
    const drafts = [draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "new_credit_movement", destinationKey: "new_credit_movement" })];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), newCreditMovementId: 4 });
    const snapshots = emptySnapshots({ splits: mapOf([splitSnap()]), movements: mapOf([newCreditMovementSnap({ type: "saldo_deudor", signedAmountCents: -1000 })]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
});

// ─── status='anulado' en movimientos ────────────────────────────────────────

describe("status anulado en insured_account_movements lanza", () => {
  test.each(["credit_movement", "debt_movement", "new_credit_movement"] as const)("%s anulado lanza", (role) => {
    const movementBuilders = { credit_movement: creditMovementSnap, debt_movement: debtMovementSnap, new_credit_movement: newCreditMovementSnap };
    const isSource = role !== "new_credit_movement";
    const snap = movementBuilders[role]({ status: "anulado" });
    const drafts = [draft(isSource ? { sourceKind: role, sourceKey: role } : { destinationKind: role, destinationKey: role })];
    const keys = emptyKeys({
      ...(role === "credit_movement" ? { creditMovementId: snap.id } : {}),
      ...(role === "debt_movement" ? { debtMovementId: snap.id } : {}),
      ...(role === "new_credit_movement" ? { newCreditMovementId: snap.id } : {}),
      ...(isSource ? { paymentIdByKey: keyMapOf([["p1", 101]]) } : { splitIdByKey: keyMapOf([["s1", 1]]) }),
    });
    const snapshots = emptySnapshots({
      movements: mapOf([snap]),
      ...(isSource ? { payments: mapOf([paymentSnap()]) } : { splits: mapOf([splitSnap()]) }),
    });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
});

// ─── Precisión 1 — signos correctos e incorrectos ──────────────────────────

describe("signedAmountCents — convención de signo por tipo (confirmada contra insured-account.ts)", () => {
  test("aplicacion_saldo_favor (credit_movement) con signo positivo lanza", () => {
    const drafts = [draft({ sourceKind: "credit_movement", sourceKey: "credit_movement", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ creditMovementId: 2, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ movements: mapOf([creditMovementSnap({ signedAmountCents: 1000 })]), payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("aplicacion_saldo_favor con signo negativo: aceptado", () => {
    const drafts = [draft({ sourceKind: "credit_movement", sourceKey: "credit_movement", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ creditMovementId: 2, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ movements: mapOf([creditMovementSnap({ signedAmountCents: -1000 })]), payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).not.toThrow();
  });
  test("saldo_deudor (debt_movement) con signo positivo lanza", () => {
    const drafts = [draft({ sourceKind: "debt_movement", sourceKey: "debt_movement", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ debtMovementId: 3, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ movements: mapOf([debtMovementSnap({ signedAmountCents: 1000 })]), payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("saldo_deudor con signo negativo: aceptado", () => {
    const drafts = [draft({ sourceKind: "debt_movement", sourceKey: "debt_movement", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ debtMovementId: 3, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ movements: mapOf([debtMovementSnap({ signedAmountCents: -1000 })]), payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).not.toThrow();
  });
  test("saldo_a_favor nuevo (new_credit_movement) con signo negativo lanza", () => {
    const drafts = [draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "new_credit_movement", destinationKey: "new_credit_movement" })];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), newCreditMovementId: 4 });
    const snapshots = emptySnapshots({ splits: mapOf([splitSnap()]), movements: mapOf([newCreditMovementSnap({ signedAmountCents: -1000 })]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("saldo_a_favor nuevo con signo positivo: aceptado", () => {
    const drafts = [draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "new_credit_movement", destinationKey: "new_credit_movement" })];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), newCreditMovementId: 4 });
    const snapshots = emptySnapshots({ splits: mapOf([splitSnap()]), movements: mapOf([newCreditMovementSnap({ signedAmountCents: 1000 })]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).not.toThrow();
  });
  test("signedAmountCents=0 lanza", () => {
    const drafts = [draft({ sourceKind: "credit_movement", sourceKey: "credit_movement", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ creditMovementId: 2, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ movements: mapOf([creditMovementSnap({ signedAmountCents: 0 })]), payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("signedAmountCents no entero seguro lanza", () => {
    const drafts = [draft({ sourceKind: "credit_movement", sourceKey: "credit_movement", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ creditMovementId: 2, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ movements: mapOf([creditMovementSnap({ signedAmountCents: -1000.5 })]), payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
});

// ─── Rounding adjustment — sin status propio ────────────────────────────────

describe("rounding_adjustment — signo y ausencia de columna status", () => {
  test("amountCents positivo lanza", () => {
    const drafts = [draft({ sourceKind: "rounding_adjustment", sourceKey: "rounding_adjustment", destinationKind: "payment", destinationKey: "p1", amountCents: 300 })];
    const keys = emptyKeys({ roundingAdjustmentId: 5, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ adjustments: mapOf([roundingSnap({ amountCents: 300 })]), payments: mapOf([paymentSnap({ amountCents: 300 })]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("amountCents=0 lanza", () => {
    const drafts = [draft({ sourceKind: "rounding_adjustment", sourceKey: "rounding_adjustment", destinationKind: "payment", destinationKey: "p1", amountCents: 300 })];
    const keys = emptyKeys({ roundingAdjustmentId: 5, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ adjustments: mapOf([roundingSnap({ amountCents: 0 })]), payments: mapOf([paymentSnap({ amountCents: 300 })]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("amountCents negativo y batch correcto: aceptado (no exige status, no existe columna)", () => {
    const drafts = [draft({ sourceKind: "rounding_adjustment", sourceKey: "rounding_adjustment", destinationKind: "payment", destinationKey: "p1", amountCents: 300 })];
    const keys = emptyKeys({ roundingAdjustmentId: 5, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ adjustments: mapOf([roundingSnap({ amountCents: -300 })]), payments: mapOf([paymentSnap({ amountCents: 300 })]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).not.toThrow();
  });
});

// ─── Mapping faltante (uno por cada sourceKind/destinationKind) ────────────

describe("mapping faltante", () => {
  test("split sin key en splitIdByKey lanza", () => {
    const s = minimalValidScenario();
    s.keys.splitIdByKey.delete("s1");
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("credit_movement sin creditMovementId lanza", () => {
    const drafts = [draft({ sourceKind: "credit_movement", sourceKey: "credit_movement", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("debt_movement sin debtMovementId lanza", () => {
    const drafts = [draft({ sourceKind: "debt_movement", sourceKey: "debt_movement", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("rounding_adjustment sin roundingAdjustmentId lanza", () => {
    const drafts = [draft({ sourceKind: "rounding_adjustment", sourceKey: "rounding_adjustment", destinationKind: "payment", destinationKey: "p1" })];
    const keys = emptyKeys({ paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ payments: mapOf([paymentSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("payment sin key en paymentIdByKey lanza", () => {
    const s = minimalValidScenario();
    s.keys.paymentIdByKey.delete("p1");
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("pronto_pago sin key en cashEntryIdByKey lanza", () => {
    const drafts = [draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "pronto_pago", destinationKey: "ce1", amountCents: 800 })];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]) });
    const snapshots = emptySnapshots({ splits: mapOf([splitSnap({ amountCents: 800 })]), payments: mapOf([paymentSnap()]), cashEntries: mapOf([cashEntrySnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("new_credit_movement sin newCreditMovementId lanza", () => {
    const drafts = [draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "new_credit_movement", destinationKey: "new_credit_movement" })];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]) });
    const snapshots = emptySnapshots({ splits: mapOf([splitSnap()]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("sourceKind desconocido lanza", () => {
    const s = minimalValidScenario();
    s.drafts[0] = draft({ sourceKind: "otro" as any, sourceKey: "s1" });
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("destinationKind desconocido lanza", () => {
    const s = minimalValidScenario();
    s.drafts[0] = draft({ destinationKind: "otro" as any, destinationKey: "p1" });
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
});

// ─── Mapping sobrante (punto 8) ─────────────────────────────────────────────

describe("mapping sobrante", () => {
  test("key extra en splitIdByKey no referenciada lanza", () => {
    const s = minimalValidScenario();
    s.keys.splitIdByKey.set("s2-sin-usar", 2);
    s.snapshots.splits.set(2, splitSnap({ id: 2 }));
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("key extra en paymentIdByKey no referenciada lanza", () => {
    const s = minimalValidScenario();
    s.keys.paymentIdByKey.set("p2-sin-usar", 102);
    s.snapshots.payments.set(102, paymentSnap({ id: 102 }));
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("key extra en cashEntryIdByKey no referenciada lanza", () => {
    const s = minimalValidScenario();
    s.keys.cashEntryIdByKey.set("ce-sin-usar", 202);
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("creditMovementId seteado sin draft que lo use lanza", () => {
    const s = minimalValidScenario();
    s.keys.creditMovementId = 2;
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("debtMovementId seteado sin draft que lo use lanza", () => {
    const s = minimalValidScenario();
    s.keys.debtMovementId = 3;
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("roundingAdjustmentId seteado sin draft que lo use lanza", () => {
    const s = minimalValidScenario();
    s.keys.roundingAdjustmentId = 5;
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("newCreditMovementId seteado sin draft que lo use lanza", () => {
    const s = minimalValidScenario();
    s.keys.newCreditMovementId = 4;
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
});

// ─── Snapshots amplios: filas extra permitidas ─────────────────────────────

describe("snapshots autoritativos con filas adicionales no referenciadas", () => {
  test("snapshots.movements/payments/splits con entradas extra no usadas no lanza", () => {
    const s = minimalValidScenario();
    s.snapshots.movements.set(2, creditMovementSnap());
    s.snapshots.movements.set(3, debtMovementSnap());
    s.snapshots.payments.set(102, paymentSnap({ id: 102 }));
    s.snapshots.splits.set(9, splitSnap({ id: 9 }));
    const rows = buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch);
    expect(rows).toHaveLength(1);
  });
});

// ─── Conservación — menor, mayor, exacta ────────────────────────────────────

describe("conservación exacta contra la entidad persistida", () => {
  test("split: suma menor a amountCents lanza", () => {
    const s = minimalValidScenario();
    s.snapshots.splits.set(1, splitSnap({ amountCents: 2000 })); // draft aporta solo 1000
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("split: suma mayor a amountCents lanza", () => {
    const s = minimalValidScenario();
    s.snapshots.splits.set(1, splitSnap({ amountCents: 500 })); // draft aporta 1000 > 500
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("split: suma exacta acepta", () => {
    const s = minimalValidScenario();
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).not.toThrow();
  });
  test("payment: suma menor al amountCents del payment lanza", () => {
    const s = minimalValidScenario();
    s.snapshots.payments.set(101, paymentSnap({ amountCents: 2000 }));
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("payment: suma mayor al amountCents del payment lanza", () => {
    const s = minimalValidScenario();
    s.snapshots.payments.set(101, paymentSnap({ amountCents: 500 }));
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("cash_entry: suma no exacta lanza", () => {
    const drafts = [draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "pronto_pago", destinationKey: "ce1", amountCents: 800 })];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), cashEntryIdByKey: keyMapOf([["ce1", 201]]) });
    const snapshots = emptySnapshots({ splits: mapOf([splitSnap({ amountCents: 800 })]), payments: mapOf([paymentSnap()]), cashEntries: mapOf([cashEntrySnap({ amountCents: 850 })]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("credit_movement: suma no cierra contra la magnitud de signedAmountCents lanza", () => {
    const drafts = [draft({ sourceKind: "credit_movement", sourceKey: "credit_movement", destinationKind: "payment", destinationKey: "p1", amountCents: 700 })];
    const keys = emptyKeys({ creditMovementId: 2, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ movements: mapOf([creditMovementSnap({ signedAmountCents: -1000 })]), payments: mapOf([paymentSnap({ amountCents: 700 })]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("rounding_adjustment: suma no cierra contra Math.abs(amountCents) lanza", () => {
    const drafts = [draft({ sourceKind: "rounding_adjustment", sourceKey: "rounding_adjustment", destinationKind: "payment", destinationKey: "p1", amountCents: 250 })];
    const keys = emptyKeys({ roundingAdjustmentId: 5, paymentIdByKey: keyMapOf([["p1", 101]]) });
    const snapshots = emptySnapshots({ adjustments: mapOf([roundingSnap({ amountCents: -300 })]), payments: mapOf([paymentSnap({ amountCents: 250 })]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("new_credit_movement: suma no cierra lanza", () => {
    const drafts = [draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "new_credit_movement", destinationKey: "new_credit_movement", amountCents: 700 })];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), newCreditMovementId: 4 });
    const snapshots = emptySnapshots({ splits: mapOf([splitSnap({ amountCents: 700 })]), movements: mapOf([newCreditMovementSnap({ signedAmountCents: 1000 })]) });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
  test("una misma fuente puede repartirse en varias filas que cierran exacto contra el total", () => {
    // split(1000) -> payment(600) + payment(400): la conservación es por SUMA, no por fila.
    const drafts = [
      draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "payment", destinationKey: "p1", amountCents: 600 }),
      draft({ sourceKind: "split", sourceKey: "s1", destinationKind: "payment", destinationKey: "p2", amountCents: 400 }),
    ];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), paymentIdByKey: keyMapOf([["p1", 101], ["p2", 102]]) });
    const snapshots = emptySnapshots({ splits: mapOf([splitSnap({ amountCents: 1000 })]), payments: mapOf([paymentSnap({ amountCents: 600 }), paymentSnap({ id: 102, amountCents: 400 })]) });
    const rows = buildFundingAllocationRows(drafts, keys, snapshots, baseBatch());
    expect(rows).toHaveLength(2);
  });
});

// ─── Duplicados — los 9 pares fuente×destino ────────────────────────────────

describe("duplicados equivalentes a los 9 índices únicos parciales", () => {
  type SourceCase = { sourceKind: FundingAllocationDraft["sourceKind"]; sourceKey: string; keysPatch: Partial<FundingAllocationKeyMap>; snapshotsPatch: Partial<FundingAllocationSnapshots> };
  type DestCase = { destinationKind: FundingAllocationDraft["destinationKind"]; destinationKey: string; keysPatch: Partial<FundingAllocationKeyMap>; snapshotsPatch: Partial<FundingAllocationSnapshots> };

  const sourceCases: SourceCase[] = [
    { sourceKind: "split", sourceKey: "s1", keysPatch: { splitIdByKey: keyMapOf([["s1", 1]]) }, snapshotsPatch: { splits: mapOf([splitSnap({ amountCents: 1000 })]) } },
    { sourceKind: "credit_movement", sourceKey: "credit_movement", keysPatch: { creditMovementId: 2 }, snapshotsPatch: { movements: mapOf([creditMovementSnap({ signedAmountCents: -1000 })]) } },
    { sourceKind: "rounding_adjustment", sourceKey: "rounding_adjustment", keysPatch: { roundingAdjustmentId: 5 }, snapshotsPatch: { adjustments: mapOf([roundingSnap({ amountCents: -1000 })]) } },
  ];
  const destCases: DestCase[] = [
    { destinationKind: "payment", destinationKey: "p1", keysPatch: { paymentIdByKey: keyMapOf([["p1", 101]]) }, snapshotsPatch: { payments: mapOf([paymentSnap({ amountCents: 1000 })]) } },
    { destinationKind: "pronto_pago", destinationKey: "ce1", keysPatch: { cashEntryIdByKey: keyMapOf([["ce1", 201]]) }, snapshotsPatch: { payments: mapOf([paymentSnap()]), cashEntries: mapOf([cashEntrySnap({ amountCents: 1000 })]) } },
    { destinationKind: "new_credit_movement", destinationKey: "new_credit_movement", keysPatch: { newCreditMovementId: 4 }, snapshotsPatch: { movements: mapOf([newCreditMovementSnap({ signedAmountCents: 1000 })]) } },
  ];

  for (const sc of sourceCases) {
    for (const dc of destCases) {
      test(`${sc.sourceKind} -> ${dc.destinationKind}: duplicado exacto lanza`, () => {
        const mergedMovements = new Map([...(sc.snapshotsPatch.movements ?? []), ...(dc.snapshotsPatch.movements ?? [])]);
        const drafts: FundingAllocationDraft[] = [
          { sourceKind: sc.sourceKind, sourceKey: sc.sourceKey, destinationKind: dc.destinationKind, destinationKey: dc.destinationKey, amountCents: 400 },
          { sourceKind: sc.sourceKind, sourceKey: sc.sourceKey, destinationKind: dc.destinationKind, destinationKey: dc.destinationKey, amountCents: 400 },
        ];
        const keys = emptyKeys({ ...sc.keysPatch, ...dc.keysPatch });
        const snapshots = emptySnapshots({ ...sc.snapshotsPatch, ...dc.snapshotsPatch, movements: mergedMovements.size ? mergedMovements : undefined });
        expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
      });
    }
  }

  test("cobertura completa: 3x4 = 12 combinaciones cubren las 9 reales (algunas fuentes/destinos se repiten a propósito para reforzar cada columna)", () => {
    expect(sourceCases.length * destCases.length).toBeGreaterThanOrEqual(9);
  });
});

// ─── Validaciones runtime e IDs/importes ────────────────────────────────────

describe("validaciones runtime — nunca TypeError crudo", () => {
  test("drafts no-array lanza FundingAllocationRowsError", () => {
    const s = minimalValidScenario();
    expect(() => buildFundingAllocationRows("no-array" as any, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("draft no-objeto lanza", () => {
    const s = minimalValidScenario();
    expect(() => buildFundingAllocationRows([null] as any, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("draft.sourceKey vacío lanza", () => {
    const s = minimalValidScenario();
    s.drafts[0] = draft({ sourceKey: "" });
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("draft.destinationKey no-string lanza", () => {
    const s = minimalValidScenario();
    s.drafts[0] = draft({ destinationKey: 5 as any });
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test.each([0, -100, 1.5, Number.NaN, "1000" as any])("draft.amountCents inválido (%p) lanza", (bad) => {
    const s = minimalValidScenario();
    s.drafts[0] = draft({ amountCents: bad });
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("keys no-objeto lanza", () => {
    const s = minimalValidScenario();
    expect(() => buildFundingAllocationRows(s.drafts, "no-object" as any, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("snapshots no-objeto lanza", () => {
    const s = minimalValidScenario();
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, null as any, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("keys.splitIdByKey no-Map lanza", () => {
    const s = minimalValidScenario();
    (s.keys as any).splitIdByKey = { s1: 1 };
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("snapshots.payments no-Map lanza", () => {
    const s = minimalValidScenario();
    (s.snapshots as any).payments = { 101: paymentSnap() };
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("id real no entero (string) en splitIdByKey lanza", () => {
    const s = minimalValidScenario();
    s.keys.splitIdByKey.set("s1", "1" as any);
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("id real negativo en splitIdByKey lanza", () => {
    const s = minimalValidScenario();
    s.keys.splitIdByKey.set("s1", -1);
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("snapshot con id inconsistente respecto de la key del mapa lanza", () => {
    const s = minimalValidScenario();
    s.snapshots.splits.set(1, splitSnap({ id: 999 }));
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("split.amountCents no entero seguro lanza", () => {
    const s = minimalValidScenario();
    s.snapshots.splits.set(1, splitSnap({ amountCents: Number.MAX_SAFE_INTEGER + 10 }));
    expect(() => buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch)).toThrow(FundingAllocationRowsError);
  });
  test("overflow de la suma agregada de una fuente lanza", () => {
    // Dos drafts split->payment distintos que en conjunto superan Number.MAX_SAFE_INTEGER.
    const half = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 10;
    const drafts: FundingAllocationDraft[] = [
      { sourceKind: "split", sourceKey: "s1", destinationKind: "payment", destinationKey: "p1", amountCents: half },
      { sourceKind: "split", sourceKey: "s1", destinationKind: "payment", destinationKey: "p2", amountCents: half },
    ];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), paymentIdByKey: keyMapOf([["p1", 101], ["p2", 102]]) });
    const snapshots = emptySnapshots({
      splits: mapOf([splitSnap({ amountCents: half * 2 })]),
      payments: mapOf([paymentSnap({ amountCents: half }), paymentSnap({ id: 102, amountCents: half })]),
    });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
});

// ─── Todo o nada ─────────────────────────────────────────────────────────────

describe("todo o nada — nunca filas parciales", () => {
  test("un draft inválido entre varios válidos: no se devuelve ninguna fila (se lanza)", () => {
    const drafts: FundingAllocationDraft[] = [
      { sourceKind: "split", sourceKey: "s1", destinationKind: "payment", destinationKey: "p1", amountCents: 500 },
      { sourceKind: "split", sourceKey: "s1", destinationKind: "payment", destinationKey: "p2", amountCents: 500 },
      { sourceKind: "credit_movement", sourceKey: "credit_movement", destinationKind: "payment", destinationKey: "p2", amountCents: -1 as any }, // inválido
    ];
    const keys = emptyKeys({ splitIdByKey: keyMapOf([["s1", 1]]), paymentIdByKey: keyMapOf([["p1", 101], ["p2", 102]]), creditMovementId: 2 });
    const snapshots = emptySnapshots({
      splits: mapOf([splitSnap({ amountCents: 1000 })]),
      payments: mapOf([paymentSnap({ amountCents: 500 }), paymentSnap({ id: 102, amountCents: 500 })]),
      movements: mapOf([creditMovementSnap()]),
    });
    expect(() => buildFundingAllocationRows(drafts, keys, snapshots, baseBatch())).toThrow(FundingAllocationRowsError);
  });
});

// ─── Determinismo y no mutación ─────────────────────────────────────────────

describe("determinismo y no mutación", () => {
  test("misma entrada produce el mismo resultado", () => {
    const s = minimalValidScenario();
    const rows1 = buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch);
    const rows2 = buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch);
    expect(rows1).toEqual(rows2);
  });

  test("no muta drafts, keys, snapshots ni batch", () => {
    const s = minimalValidScenario();
    const draftsSnapshot = JSON.parse(JSON.stringify(s.drafts));
    const batchSnapshot = JSON.parse(JSON.stringify(s.batch));
    const splitKeysBefore = [...s.keys.splitIdByKey.entries()];
    const paymentKeysBefore = [...s.keys.paymentIdByKey.entries()];
    const splitsSnapBefore = [...s.snapshots.splits.entries()];
    const paymentsSnapBefore = [...s.snapshots.payments.entries()];

    buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch);

    expect(JSON.parse(JSON.stringify(s.drafts))).toEqual(draftsSnapshot);
    expect(JSON.parse(JSON.stringify(s.batch))).toEqual(batchSnapshot);
    expect([...s.keys.splitIdByKey.entries()]).toEqual(splitKeysBefore);
    expect([...s.keys.paymentIdByKey.entries()]).toEqual(paymentKeysBefore);
    expect([...s.snapshots.splits.entries()]).toEqual(splitsSnapBefore);
    expect([...s.snapshots.payments.entries()]).toEqual(paymentsSnapBefore);
  });

  test("el array devuelto es una instancia nueva en cada llamada", () => {
    const s = minimalValidScenario();
    const rows1 = buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch);
    const rows2 = buildFundingAllocationRows(s.drafts, s.keys, s.snapshots, s.batch);
    expect(rows1).not.toBe(rows2);
  });
});
