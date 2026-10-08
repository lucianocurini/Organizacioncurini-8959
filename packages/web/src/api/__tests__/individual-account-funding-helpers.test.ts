// Helpers puros del pago individual con saldo (POST /payments/account-funded)
// y de las reglas nuevas compartidas con "Cobrar en lote" con titular: plan
// (crédito antes que redondeo/deuda, sobre-fondeo), fingerprint por endpoint,
// cero medios bajo opción explícita, request individual (titular nunca desde
// el body) y serialización en proceso de las transacciones de financiación.
// Sin DB, sin HTTP.
import { describe, test, expect } from "bun:test";
import { planAccountHolderBatchFunding, AccountHolderFundingPlanError } from "../../lib/payments/account-holder-funding-plan";
import {
  canonicalizeFundingRequest, FundingRequestFingerprintInputError,
  PAYMENT_BATCHES_ENDPOINT, ACCOUNT_FUNDED_PAYMENT_ENDPOINT,
  type FundingRequestFingerprintInput,
} from "../../lib/payments/account-holder-funding-fingerprint";
import { parseFundingRequest, AccountHolderFundingRequestError } from "../../lib/payments/account-holder-funding-request";
import { PaymentBatchValidationError } from "../../lib/payments/batches";
import {
  parseIndividualAccountFundedRequest, buildIndividualAccountFundedBatchBody, findAccountFundingFields,
  IndividualAccountFundingRequestError, ACCOUNT_FUNDING_FIELD_NAMES,
} from "../../lib/payments/individual-account-funding-request";
import { runSerializedFundingTransaction } from "../account-holder-funding-batch";

const CUOTA = 10000000; // $100.000 en centavos

function plan(p: { real?: number[]; credit?: number; rounding?: number; available?: number; debt?: boolean; destinations?: Array<{ id: string; kind: "payment" | "pronto_pago"; nominalCents: number }> }) {
  return planAccountHolderBatchFunding({
    destinations: p.destinations ?? [{ id: "payment-0", kind: "payment", nominalCents: CUOTA }],
    realSplits: (p.real ?? []).map((amountCents, i) => ({ id: `split-${i}`, amountCents })),
    creditAppliedCents: p.credit ?? 0,
    roundingCoverageCents: p.rounding ?? 0,
    availableCreditCents: p.available ?? 0,
    debtAuthorized: p.debt ?? false,
  });
}

describe("plan — los cuatro ejemplos económicos", () => {
  test("30.000 saldo + 70.000 transferencia → cierra exacto, sin deuda ni saldo nuevo", () => {
    const r = plan({ real: [7000000], credit: 3000000, available: 3000000 });
    expect([r.newSaldoDeudorCents, r.newSaldoAFavorCents, r.realSplitsTotalCents]).toEqual([0, 0, 7000000]);
  });
  test("70.000 efectivo + 30.000 deuda autorizada → saldo deudor 30.000", () => {
    const r = plan({ real: [7000000], debt: true });
    expect(r.newSaldoDeudorCents).toBe(3000000);
    expect(r.realSplitsTotalCents).toBe(7000000);
  });
  test("100.000 de saldo sin medio real → cierra exacto con cero splits", () => {
    const r = plan({ real: [], credit: CUOTA, available: CUOTA });
    expect([r.newSaldoDeudorCents, r.newSaldoAFavorCents, r.realSplitsTotalCents]).toEqual([0, 0, 0]);
    expect(r.allocations).toEqual([{ sourceKind: "credit_movement", sourceKey: "credit_movement", destinationKind: "payment", destinationKey: "payment-0", amountCents: CUOTA }]);
  });
  test("110.000 reales → nuevo saldo a favor 10.000", () => {
    expect(plan({ real: [11000000] }).newSaldoAFavorCents).toBe(1000000);
  });
});

describe("plan — crédito antes que redondeo/deuda (rige para individual y lote con titular)", () => {
  test("saldo disponible sin aplicar + deuda → error", () => {
    expect(() => plan({ real: [5000000], credit: 1000000, available: 2000000, debt: true })).toThrow(/saldo a favor disponible sin aplicar \(\$10000\.00\)/);
  });
  test("saldo agotado + deuda por el resto → ok", () => {
    expect(plan({ real: [5000000], credit: 2000000, available: 2000000, debt: true }).newSaldoDeudorCents).toBe(3000000);
  });
  test("saldo disponible mayor al faltante: debe aplicarse el faltante entero (no alcanza con aplicar parte)", () => {
    expect(() => plan({ real: [9000000], credit: 500000, available: 5000000, debt: true })).toThrow(AccountHolderFundingPlanError);
    expect(plan({ real: [9000000], credit: 1000000, available: 5000000 }).newSaldoDeudorCents).toBe(0);
  });
  test("redondeo con saldo disponible sin aplicar → error; con saldo agotado → ok", () => {
    expect(() => plan({ real: [9999700], rounding: 300, available: 1000 })).toThrow(/sin aplicar/);
    expect(plan({ real: [9999700], rounding: 300, available: 0 }).roundingCoverageCents).toBe(300);
  });
  test("deuda negativa del titular (available=0) no bloquea deuda nueva", () => {
    expect(plan({ real: [7000000], available: 0, debt: true }).newSaldoDeudorCents).toBe(3000000);
  });
  test("sobrante real con saldo aplicado → error claro con el máximo de saldo", () => {
    expect(() => plan({ real: [10000000], credit: 1000000, available: 1000000 })).toThrow(/reducí el saldo aplicado a \$0\.00/);
    expect(() => plan({ real: [9500000], credit: 1000000, available: 1000000 })).toThrow(/a \$5000\.00 como máximo/);
  });
});

describe("plan — Pronto Pago dentro del total", () => {
  const dests = [{ id: "payment-0", kind: "payment" as const, nominalCents: CUOTA }, { id: "pronto_pago-0", kind: "pronto_pago" as const, nominalCents: 80000 }];
  test("saldo total cubre cuota + recargo", () => {
    const r = plan({ destinations: dests, credit: CUOTA + 80000, available: CUOTA + 80000 });
    expect(r.nominalTotalCents).toBe(CUOTA + 80000);
    expect(r.allocations.find((a) => a.destinationKind === "pronto_pago")?.amountCents).toBe(80000);
  });
  test("saldo parcial: primero la cuota, el recargo con dinero real", () => {
    const r = plan({ destinations: dests, real: [5080000], credit: 5000000, available: 5000000 });
    const toPP = r.allocations.filter((a) => a.destinationKind === "pronto_pago");
    expect(toPP.every((a) => a.sourceKind === "split")).toBe(true);
  });
  test("saldo insuficiente para el recargo: sin deuda → error; con deuda → deuda 800", () => {
    expect(() => plan({ destinations: dests, credit: CUOTA, available: CUOTA })).toThrow(/sin autorización de deuda/);
    expect(plan({ destinations: dests, credit: CUOTA, available: CUOTA, debt: true }).newSaldoDeudorCents).toBe(80000);
  });
});

function fingerprintDto(): FundingRequestFingerprintInput {
  return {
    paymentDate: "2028-02-01", accountHolderInsuredId: 7, items: [{ source: "installment", installmentId: 1 }],
    splits: [], notes: null, applyProntoPagoSurcharge: true, accountDifferenceResolution: null,
    creditAppliedCents: CUOTA, roundingCoverageCents: 0, debtAuthorized: false, debtReason: null,
  };
}

describe("fingerprint por endpoint", () => {
  test("default = POST /payment-batches (formato de lotes sin cambios)", () => {
    const fp = JSON.parse(canonicalizeFundingRequest(fingerprintDto()));
    expect(fp.endpoint).toBe(PAYMENT_BATCHES_ENDPOINT);
    expect(canonicalizeFundingRequest(fingerprintDto())).toBe(canonicalizeFundingRequest(fingerprintDto(), { endpoint: PAYMENT_BATCHES_ENDPOINT }));
  });
  test("el endpoint individual produce otro fingerprint", () => {
    const a = canonicalizeFundingRequest(fingerprintDto());
    const b = canonicalizeFundingRequest(fingerprintDto(), { endpoint: ACCOUNT_FUNDED_PAYMENT_ENDPOINT });
    expect(a).not.toBe(b);
    expect(JSON.parse(b).endpoint).toBe(ACCOUNT_FUNDED_PAYMENT_ENDPOINT);
  });
  test("endpoint desconocido → error", () => {
    expect(() => canonicalizeFundingRequest(fingerprintDto(), { endpoint: "POST /otra" as any })).toThrow(FundingRequestFingerprintInputError);
  });
});

function titularBody(extra: Record<string, unknown> = {}) {
  return {
    paymentDate: "2028-02-01", accountHolderInsuredId: 7, idempotencyKey: "k-1",
    items: [{ source: "installment", installmentId: 1 }], splits: [], creditAppliedCents: CUOTA, ...extra,
  };
}

describe("parseFundingRequest — cero medios solo bajo opción explícita", () => {
  test("sin la opción, cero medios se rechaza (lote legacy y lote con titular)", () => {
    expect(() => parseFundingRequest(titularBody())).toThrow(PaymentBatchValidationError);
    expect(() => parseFundingRequest({ paymentDate: "2028-02-01", items: [{ source: "installment", installmentId: 1 }], splits: [] })).toThrow(PaymentBatchValidationError);
  });
  test("con la opción y saldo aplicado → ok, splits vacíos, fingerprint del endpoint individual", () => {
    const r = parseFundingRequest(titularBody(), { endpoint: ACCOUNT_FUNDED_PAYMENT_ENDPOINT, allowZeroRealSplits: true });
    expect(r.splitsWithChecks).toEqual([]);
    expect(JSON.parse(r.fingerprint).endpoint).toBe(ACCOUNT_FUNDED_PAYMENT_ENDPOINT);
  });
  test("con la opción pero sin saldo aplicado → error", () => {
    expect(() => parseFundingRequest(titularBody({ creditAppliedCents: 0, debtAuthorized: true, debtReason: "x" }), { allowZeroRealSplits: true }))
      .toThrow(/debe aplicar saldo a favor/);
  });
  test("con la opción pero sin titular → error", () => {
    expect(() => parseFundingRequest({ paymentDate: "2028-02-01", items: [{ source: "installment", installmentId: 1 }], splits: [] }, { allowZeroRealSplits: true }))
      .toThrow(AccountHolderFundingRequestError);
  });
  test("la opción no cambia nada cuando hay medios reales", () => {
    const body = titularBody({ splits: [{ method: "efectivo", amount: 1 }] });
    expect(parseFundingRequest(body, { allowZeroRealSplits: true }).dto).toEqual(parseFundingRequest(body).dto);
  });
});

describe("request individual — titular nunca desde el body", () => {
  const valid = { policyId: 3, installmentId: 9, paymentDate: "2028-02-01", splits: [], creditAppliedCents: 100, idempotencyKey: "k" };
  test("accountHolderInsuredId en el body → error explícito", () => {
    expect(() => parseIndividualAccountFundedRequest({ ...valid, accountHolderInsuredId: 1 })).toThrow(/se obtiene siempre de la póliza/);
  });
  test("campos de lote o desconocidos → error con el nombre", () => {
    expect(() => parseIndividualAccountFundedRequest({ ...valid, items: [] })).toThrow(/items/);
    expect(() => parseIndividualAccountFundedRequest({ ...valid, accountDifferenceResolution: {} })).toThrow(/accountDifferenceResolution/);
    expect(() => parseIndividualAccountFundedRequest({ ...valid, amount: 1 })).toThrow(/amount/);
  });
  test("installmentId obligatorio (pago sin cuota fuera de alcance) e ids enteros positivos", () => {
    const { installmentId: _omit, ...noInstallment } = valid;
    expect(() => parseIndividualAccountFundedRequest(noInstallment)).toThrow(/installmentId es obligatorio/);
    expect(() => parseIndividualAccountFundedRequest({ ...valid, policyId: "3" })).toThrow(IndividualAccountFundingRequestError);
    expect(() => parseIndividualAccountFundedRequest({ ...valid, installmentId: 0 })).toThrow(IndividualAccountFundingRequestError);
    expect(() => parseIndividualAccountFundedRequest(null)).toThrow(IndividualAccountFundingRequestError);
  });
  test("el body traducido usa un único ítem y el titular resuelto por el servidor", () => {
    const body = buildIndividualAccountFundedBatchBody(parseIndividualAccountFundedRequest(valid), 77);
    expect(body.items).toEqual([{ source: "installment", installmentId: 9 }]);
    expect(body.accountHolderInsuredId).toBe(77);
    expect("policyId" in body).toBe(false);
    expect("debtAuthorized" in body).toBe(false); // ausentes no se agregan
  });
});

describe("request individual — validación estricta de importes, motivo y clave (camino real: parse + traducción + parseFundingRequest)", () => {
  const base = { policyId: 3, installmentId: 9, paymentDate: "2028-02-01", splits: [{ method: "efectivo", amount: 70000 }], idempotencyKey: "k-strict" };
  const parseAll = (body: Record<string, unknown>) => parseFundingRequest(
    buildIndividualAccountFundedBatchBody(parseIndividualAccountFundedRequest(body), 77),
    { endpoint: ACCOUNT_FUNDED_PAYMENT_ENDPOINT, allowZeroRealSplits: true },
  );
  const rejects = (body: Record<string, unknown>) => expect(() => parseAll(body)).toThrow();

  test("control: request válido parsea en modo titular con el titular resuelto", () => {
    const r = parseAll({ ...base, creditAppliedCents: 3000000 });
    expect(r.mode).toBe("titular");
    expect(r.dto.accountHolderInsuredId).toBe(77);
    expect(r.dto.creditAppliedCents).toBe(3000000);
  });
  test("saldo aplicado: negativo, decimal, string, NaN o Infinity → rechazo", () => {
    for (const v of [-1, 1.5, "3000000", Number.NaN, Number.POSITIVE_INFINITY]) rejects({ ...base, creditAppliedCents: v });
  });
  test("redondeo: negativo, decimal o string → rechazo", () => {
    for (const v of [-1, 0.5, "300"]) rejects({ ...base, roundingCoverageCents: v });
  });
  test("motivo: deuda autorizada sin motivo o con motivo en blanco → rechazo; motivo sin autorización → rechazo", () => {
    rejects({ ...base, debtAuthorized: true });
    rejects({ ...base, debtAuthorized: true, debtReason: "   " });
    rejects({ ...base, debtAuthorized: false, debtReason: "x" });
    expect(parseAll({ ...base, debtAuthorized: true, debtReason: "  paga el lunes  " }).dto.debtReason).toBe("paga el lunes");
  });
  test("debtAuthorized no booleano → rechazo", () => {
    for (const v of ["true", 1]) rejects({ ...base, debtAuthorized: v, debtReason: "x" });
  });
  test("clave de idempotencia ausente, vacía o no string → rechazo", () => {
    const { idempotencyKey: _k, ...noKey } = base;
    rejects(noKey);
    rejects({ ...base, idempotencyKey: "   " });
    rejects({ ...base, idempotencyKey: 5 });
  });
  test("importes de medios inválidos → rechazo (incluido string numérico, que el lote sí tolera)", () => {
    for (const amount of [0, -1, "70000", 1.234, null]) rejects({ ...base, splits: [{ method: "efectivo", amount }] });
    expect(() => parseIndividualAccountFundedRequest({ ...base, splits: [{ method: "efectivo", amount: "70000" }] })).toThrow(/debe ser un número/);
    expect(() => parseIndividualAccountFundedRequest({
      ...base, splits: [{ method: "cheque", amount: 500, checks: [{ checkNumber: "1", bankName: "B", dueDate: "2028-06-01", amount: "500" }] }],
    })).toThrow(/cheque 1 del medio 1/);
    expect(parseAll({ ...base, splits: [{ method: "efectivo", amount: 700.5 }] }).splitsWithChecks[0]!.split.amountCents).toBe(70050);
  });
  test("titular: ni en el body ni como campo de lote", () => {
    expect(() => parseIndividualAccountFundedRequest({ ...base, accountHolderInsuredId: 77 })).toThrow(IndividualAccountFundingRequestError);
    expect(() => parseIndividualAccountFundedRequest({ ...base, insuredId: 77 })).toThrow(/insuredId/);
    expect(() => buildIndividualAccountFundedBatchBody(parseIndividualAccountFundedRequest(base), 0)).toThrow(AccountHolderFundingRequestError);
  });
});

describe("POST/PUT /payments — detección de campos de financiación", () => {
  test("detecta cada campo presente (no undefined)", () => {
    for (const k of ACCOUNT_FUNDING_FIELD_NAMES) expect(findAccountFundingFields({ amount: 1, [k]: null })).toEqual([k]);
    expect(findAccountFundingFields({ amount: 1, creditAppliedCents: undefined })).toEqual([]);
    expect(findAccountFundingFields({ amount: 1, notes: "x", splits: [] })).toEqual([]);
    expect(findAccountFundingFields(null)).toEqual([]);
  });
});

describe("serialización en proceso de transacciones de financiación", () => {
  test("nunca se solapan y conservan el orden de llegada", async () => {
    const log: string[] = [];
    let active = 0;
    const job = (name: string, ms: number) => runSerializedFundingTransaction(async () => {
      active++;
      if (active > 1) log.push("overlap");
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      active--;
      return name;
    });
    const results = await Promise.all([job("a", 20), job("b", 1), job("c", 5)]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });
  test("un error no bloquea la cola ni contamina al siguiente", async () => {
    const failing = runSerializedFundingTransaction(async () => { throw new Error("boom"); });
    const next = runSerializedFundingTransaction(async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("ok");
  });
  test("un throw sincrónico (función no async) también libera la cola", async () => {
    const failing = runSerializedFundingTransaction((() => { throw new Error("sync"); }) as () => Promise<never>);
    const next = runSerializedFundingTransaction(async () => "ok");
    await expect(failing).rejects.toThrow("sync");
    expect(await next).toBe("ok");
  });
  test("con la cola vacía, una transacción nueva arranca sin esperar a nada (no queda retenida)", async () => {
    await runSerializedFundingTransaction(async () => "previa");
    let started = false;
    const run = runSerializedFundingTransaction(async () => { started = true; return "x"; });
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(true);
    expect(await run).toBe("x");
  });
  test("cada llamada recibe su propio resultado o error, aun intercaladas", async () => {
    const r = await Promise.allSettled([
      runSerializedFundingTransaction(async () => 1),
      runSerializedFundingTransaction(async () => { throw new Error("dos"); }),
      runSerializedFundingTransaction(async () => 3),
    ]);
    expect(r.map((x) => (x.status === "fulfilled" ? x.value : (x.reason as Error).message))).toEqual([1, "dos", 3]);
  });
});
