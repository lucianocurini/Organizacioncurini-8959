/**
 * Tests del helper puro de anulación manual de pólizas. Sin DB, sin HTTP —
 * src/lib/policies/cancellation.ts. Complementa policy-cancellation.test.ts
 * (que ejercita estos mismos helpers a través de los endpoints reales).
 */

import { test, expect, describe } from "bun:test";
import {
  validateCancellationEffectiveDate, validatePolicyCancellationState,
  classifyInstallmentsForCancellation, isInstallmentNonCollectible,
  appendCancellationNote, PolicyCancellationValidationError,
  type InstallmentForCancellation,
} from "../../lib/policies/cancellation";

function inst(overrides: Partial<InstallmentForCancellation>): InstallmentForCancellation {
  return { id: 1, dueDate: "2027-06-01", status: "pendiente", rendered: 0, ...overrides };
}

// ─── 5/6. fecha válida / formato inválido ──────────────────────────────────────

describe("validateCancellationEffectiveDate", () => {
  test("5. fecha válida dentro del rango → no lanza", () => {
    expect(() => validateCancellationEffectiveDate("2027-06-01", { startDate: "2027-01-01", endDate: "2027-12-31" })).not.toThrow();
  });

  test("6. formato inválido → lanza", () => {
    expect(() => validateCancellationEffectiveDate("2027-13-01", { startDate: "2027-01-01", endDate: "2027-12-31" }))
      .toThrow(PolicyCancellationValidationError);
    expect(() => validateCancellationEffectiveDate("fecha-invalida", { startDate: "2027-01-01", endDate: "2027-12-31" }))
      .toThrow(PolicyCancellationValidationError);
    expect(() => validateCancellationEffectiveDate("", { startDate: "2027-01-01", endDate: "2027-12-31" }))
      .toThrow(PolicyCancellationValidationError);
  });

  // 7. fecha anterior al inicio
  test("7. fecha anterior al inicio de la póliza → lanza", () => {
    expect(() => validateCancellationEffectiveDate("2026-12-31", { startDate: "2027-01-01", endDate: "2027-12-31" }))
      .toThrow(/anterior al inicio/);
  });

  // 8. fecha posterior al fin
  test("8. fecha posterior al fin de la póliza → lanza", () => {
    expect(() => validateCancellationEffectiveDate("2028-01-01", { startDate: "2027-01-01", endDate: "2027-12-31" }))
      .toThrow(/posterior al fin/);
  });

  test("fecha igual a startDate o endDate → válida (límites inclusive)", () => {
    expect(() => validateCancellationEffectiveDate("2027-01-01", { startDate: "2027-01-01", endDate: "2027-12-31" })).not.toThrow();
    expect(() => validateCancellationEffectiveDate("2027-12-31", { startDate: "2027-01-01", endDate: "2027-12-31" })).not.toThrow();
  });

  test("endDate null → no valida límite superior", () => {
    expect(() => validateCancellationEffectiveDate("2099-01-01", { startDate: "2027-01-01", endDate: null })).not.toThrow();
  });
});

// ─── Estado de la póliza ────────────────────────────────────────────────────────

describe("validatePolicyCancellationState", () => {
  test("póliza activa/vencida/por_vencer/renovada → válida para anular", () => {
    for (const status of ["activa", "vencida", "por_vencer", "renovada"]) {
      expect(validatePolicyCancellationState(status).valid).toBe(true);
    }
  });
  test("póliza ya cancelada → inválida, con mensaje", () => {
    const result = validatePolicyCancellationState("cancelada");
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("ya está cancelada");
  });
});

// ─── 9-13. Clasificación de cuotas ──────────────────────────────────────────────

describe("classifyInstallmentsForCancellation", () => {
  // 9. dueDate anterior → deuda previa
  test("9. dueDate < effectiveDate, pendiente/no rendida → priorDebtUnchanged", () => {
    const result = classifyInstallmentsForCancellation([inst({ id: 1, dueDate: "2027-05-01" })], "2027-06-01");
    expect(result.priorDebtUnchanged.map((i) => i.id)).toEqual([1]);
    expect(result.futureNonCollectible).toEqual([]);
  });

  // 10. dueDate igual → no_exigible
  test("10. dueDate === effectiveDate → futureNonCollectible", () => {
    const result = classifyInstallmentsForCancellation([inst({ id: 1, dueDate: "2027-06-01" })], "2027-06-01");
    expect(result.futureNonCollectible.map((i) => i.id)).toEqual([1]);
  });

  // 11. dueDate posterior → no_exigible
  test("11. dueDate > effectiveDate, pendiente/no rendida → futureNonCollectible", () => {
    const result = classifyInstallmentsForCancellation([inst({ id: 1, dueDate: "2027-07-01" })], "2027-06-01");
    expect(result.futureNonCollectible.map((i) => i.id)).toEqual([1]);
  });

  // 12. paid intacta
  test("12. status='pagada', sin importar la fecha → paidUnchanged, nunca futureNonCollectible", () => {
    const result = classifyInstallmentsForCancellation(
      [inst({ id: 1, status: "pagada", dueDate: "2027-12-01" })], "2027-06-01"
    );
    expect(result.paidUnchanged.map((i) => i.id)).toEqual([1]);
    expect(result.futureNonCollectible).toEqual([]);
  });

  // 13. rendered intacta
  test("13. rendered=1 aunque no esté 'pagada', sin importar la fecha → renderedUnchanged", () => {
    const result = classifyInstallmentsForCancellation(
      [inst({ id: 1, status: "pendiente", rendered: 1, dueDate: "2027-12-01" })], "2027-06-01"
    );
    expect(result.renderedUnchanged.map((i) => i.id)).toEqual([1]);
    expect(result.futureNonCollectible).toEqual([]);
  });

  test("clasifica un conjunto mixto de cuotas en los 4 buckets correctos", () => {
    const installments = [
      inst({ id: 1, status: "pagada", dueDate: "2027-08-01" }),        // paid (aunque sea futura)
      inst({ id: 2, rendered: 1, dueDate: "2027-08-01" }),              // rendered (aunque no pagada)
      inst({ id: 3, dueDate: "2027-05-01" }),                           // deuda anterior
      inst({ id: 4, dueDate: "2027-07-01" }),                           // futura no exigible
    ];
    const result = classifyInstallmentsForCancellation(installments, "2027-06-01");
    expect(result.paidUnchanged.map((i) => i.id)).toEqual([1]);
    expect(result.renderedUnchanged.map((i) => i.id)).toEqual([2]);
    expect(result.priorDebtUnchanged.map((i) => i.id)).toEqual([3]);
    expect(result.futureNonCollectible.map((i) => i.id)).toEqual([4]);
  });

  test("no muta el array de entrada", () => {
    const installments = [inst({ id: 1, dueDate: "2027-07-01" })];
    const copy = JSON.parse(JSON.stringify(installments));
    classifyInstallmentsForCancellation(installments, "2027-06-01");
    expect(installments).toEqual(copy);
  });
});

describe("isInstallmentNonCollectible", () => {
  test("solo 'no_exigible' es no cobrable", () => {
    expect(isInstallmentNonCollectible("no_exigible")).toBe(true);
    expect(isInstallmentNonCollectible("pendiente")).toBe(false);
    expect(isInstallmentNonCollectible("pagada")).toBe(false);
    expect(isInstallmentNonCollectible("vencida")).toBe(false);
  });
});

// ─── Nota de auditoría ───────────────────────────────────────────────────────────

describe("appendCancellationNote", () => {
  test("sin notas previas ni observaciones", () => {
    expect(appendCancellationNote(null, "venta del vehículo")).toBe("Anulada manualmente. Motivo: venta del vehículo");
  });
  test("con notas previas, se concatena con ' | ' (mismo formato que los importadores)", () => {
    const result = appendCancellationNote("Nota vieja", "venta del vehículo");
    expect(result).toBe("Nota vieja | Anulada manualmente. Motivo: venta del vehículo");
  });
  test("con observaciones adicionales, se agregan con ' — '", () => {
    const result = appendCancellationNote(null, "venta del vehículo", "cliente avisó por whatsapp");
    expect(result).toBe("Anulada manualmente. Motivo: venta del vehículo — cliente avisó por whatsapp");
  });
  test("observaciones vacías/blancas se ignoran", () => {
    expect(appendCancellationNote(null, "motivo", "   ")).toBe("Anulada manualmente. Motivo: motivo");
  });
});
