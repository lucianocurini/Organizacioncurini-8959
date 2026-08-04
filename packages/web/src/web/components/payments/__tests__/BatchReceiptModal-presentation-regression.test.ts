// Test de regresión estático (sin renderizar componentes React, no hay
// infraestructura de testing-library en este paquete): barre el código
// fuente de PendingInstallmentsBatchTab.tsx para confirmar los dos ajustes
// visuales de fix/batch-payment-rounding-tolerance:
//
//   (a) el comprobante del lote (BatchReceiptModal) muestra los importes de
//       "Medios de pago" y "Cheques" con centavos exactos
//       (formatCurrencyCents, en centavos enteros) — NO con formatCurrency
//       (redondea a peso entero, ej. $134.998 en vez de $134.997,66).
//   (b) cuando la diferencia admite tolerancia de redondeo y todavía no se
//       eligió ninguna resolución, el modal de cobro (BatchPaymentModal)
//       sigue mostrando differenceValidation.errorMessage en la rama de
//       asegurado único — el texto exacto del mensaje está cubierto en
//       payment-batch-form.test.ts (validateBatchDifferenceResolutionWithRounding).
//
// Si este test falla porque alguien volvió a usar formatCurrency para un
// importe de medio de pago/cheque, es una señal real de regresión — hay que
// usar formatCurrencyCents, no ajustar este test.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const FILE = resolve(import.meta.dir, "..", "PendingInstallmentsBatchTab.tsx");

function readSrc(): string {
  return readFileSync(FILE, "utf-8");
}

describe("Comprobante del lote — centavos exactos en medios de pago y cheques", () => {
  test("'Medios de pago' usa formatCurrencyCents(s.amountCents)", () => {
    const content = readSrc();
    expect(content).toContain("{formatCurrencyCents(s.amountCents)}");
  });

  test("'Cheques' usa formatCurrencyCents(c.amountCents)", () => {
    const content = readSrc();
    expect(content).toContain("{formatCurrencyCents(c.amountCents)}");
  });

  test("no quedó el patrón viejo (formatCurrency con .../100) para esos dos campos", () => {
    const content = readSrc();
    expect(content).not.toMatch(/\{formatCurrency\(s\.amountCents\s*\/\s*100\)\}/);
    expect(content).not.toMatch(/\{formatCurrency\(c\.amountCents\s*\/\s*100\)\}/);
  });
});

describe("Modal de cobro — mensaje de redondeo sin resolución elegida sigue conectado", () => {
  test("la rama de asegurado único sigue renderizando differenceValidation.errorMessage", () => {
    const content = readSrc();
    expect(content).toContain("{differenceValidation.errorMessage}");
  });

  test("el checkbox de tolerancia de redondeo sigue presente (isRoundingAdjustmentEligible)", () => {
    const content = readSrc();
    expect(content).toContain("isRoundingAdjustmentEligible(difference.differenceCents)");
  });
});
