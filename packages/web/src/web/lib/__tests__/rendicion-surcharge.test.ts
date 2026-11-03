import { describe, test, expect } from "bun:test";
import { computeRendicionSurcharge } from "../rendicion-surcharge";
import { SURCHARGE_AMOUNT } from "../../../lib/payments/batches";

const pay = (o: Record<string, unknown>) => ({ source: "payment", companyName: "Rivadavia", hasSurcharge: true, surchargeAmount: SURCHARGE_AMOUNT, ...o });

describe("computeRendicionSurcharge", () => {
  test("una cuota Rivadavia con recargo nuevo → $900", () => {
    const r = computeRendicionSurcharge({ canal: "pronto_pago", selectedCobradas: [pay({})], manualItems: [] });
    expect(r.count).toBe(1);
    expect(r.total).toBe(900);
    expect(r.uniformUnitAmount).toBe(900);
  });

  test("varias cuotas Rivadavia → cantidad × $900", () => {
    const r = computeRendicionSurcharge({ canal: "pronto_pago", selectedCobradas: [pay({}), pay({}), pay({})], manualItems: [] });
    expect(r.total).toBe(3 * 900);
  });

  test("histórico $800 guardado se suma tal cual; mezclado con nuevos no hay importe unitario único", () => {
    const r = computeRendicionSurcharge({
      canal: "pronto_pago", selectedCobradas: [pay({ surchargeAmount: 800 }), pay({})], manualItems: [],
    });
    expect(r.total).toBe(800 + 900);
    expect(r.uniformUnitAmount).toBeNull();
  });

  test("deuda manual Rivadavia → $900 vigente; otra compañía → $0", () => {
    const r = computeRendicionSurcharge({
      canal: "pronto_pago", selectedCobradas: [],
      manualItems: [{ companyName: " Rivadavia Seguros " }, { companyName: "Otra" }],
    });
    expect(r.count).toBe(1);
    expect(r.total).toBe(900);
  });

  test("otras compañías y pagos sin recargo registrado → $0 (este último solo informativo)", () => {
    const r = computeRendicionSurcharge({
      canal: "pronto_pago",
      selectedCobradas: [pay({ companyName: "Otra", hasSurcharge: false, surchargeAmount: null }), pay({ hasSurcharge: false, surchargeAmount: null })],
      manualItems: [],
    });
    expect(r.total).toBe(0);
    expect(r.rivadaviaWithoutSurcharge.length).toBe(1);
  });

  test("canal distinto de Pronto Pago → $0 aunque haya recargos", () => {
    for (const canal of ["directo", "informativo"]) {
      const r = computeRendicionSurcharge({ canal, selectedCobradas: [pay({})], manualItems: [{ companyName: "Rivadavia" }] });
      expect(r.total).toBe(0);
      expect(r.count).toBe(0);
      expect(r.rivadaviaWithoutSurcharge).toEqual([]);
    }
  });

  test("ítems que no son payment (cash_entry, contado) no generan recargo", () => {
    const r = computeRendicionSurcharge({
      canal: "pronto_pago", selectedCobradas: [pay({ source: "cash_entry" }), pay({ source: "payment_batch" })], manualItems: [],
    });
    expect(r.total).toBe(0);
  });
});
