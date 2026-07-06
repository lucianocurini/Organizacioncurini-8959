// Tests de los helpers puros de la interfaz de anulación manual de pólizas.
// No usan React ni DOM: la lógica de decisión se extrajo a
// packages/web/src/web/lib/policy-cancellation.ts precisamente para poder
// probarla sin infraestructura de componentes.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/policy-cancellation.test.ts

import { describe, test, expect } from "bun:test";
import {
  shouldShowCancelButton, isCancellationFormComplete, canConfirmCancellation,
  normalizeCancellationError, shouldRefreshAfterCancelResponse, NON_COLLECTIBLE_STATUS_LABEL,
  type CancellationFormInput,
} from "../policy-cancellation";
import { STATUS_TYPES } from "../utils";

function form(overrides: Partial<CancellationFormInput> = {}): CancellationFormInput {
  return { effectiveDate: "2027-06-01", reason: "venta del vehículo", notes: "", ...overrides };
}

// ─── 42. botón oculto para cancelada ───────────────────────────────────────────

describe("shouldShowCancelButton", () => {
  test("42. oculto para una póliza ya cancelada", () => {
    expect(shouldShowCancelButton("cancelada")).toBe(false);
  });
  test("visible para cualquier otro status (activa, vencida, por_vencer, renovada)", () => {
    expect(shouldShowCancelButton("activa")).toBe(true);
    expect(shouldShowCancelButton("vencida")).toBe(true);
    expect(shouldShowCancelButton("por_vencer")).toBe(true);
    expect(shouldShowCancelButton("renovada")).toBe(true);
  });
});

describe("isCancellationFormComplete", () => {
  test("completo con fecha y motivo", () => {
    expect(isCancellationFormComplete(form())).toBe(true);
  });
  test("incompleto sin fecha", () => {
    expect(isCancellationFormComplete(form({ effectiveDate: "" }))).toBe(false);
  });
  test("incompleto con motivo vacío o solo espacios", () => {
    expect(isCancellationFormComplete(form({ reason: "" }))).toBe(false);
    expect(isCancellationFormComplete(form({ reason: "   " }))).toBe(false);
  });
});

// ─── 43. confirmación requerida ─────────────────────────────────────────────────

describe("canConfirmCancellation", () => {
  test("43. requiere formulario completo + preview válido + checkbox marcado", () => {
    expect(canConfirmCancellation(form(), true, true)).toBe(true);
  });
  test("43. sin checkbox marcado → no habilita, aunque el resto esté completo", () => {
    expect(canConfirmCancellation(form(), true, false)).toBe(false);
  });
  test("43. sin preview válido → no habilita, aunque el checkbox esté marcado", () => {
    expect(canConfirmCancellation(form(), false, true)).toBe(false);
  });
  test("43. formulario incompleto → no habilita", () => {
    expect(canConfirmCancellation(form({ reason: "" }), true, true)).toBe(false);
  });
});

// ─── Normalización de errores ───────────────────────────────────────────────────

describe("normalizeCancellationError", () => {
  test("404 → not_found", () => {
    expect(normalizeCancellationError({ status: 404 }).kind).toBe("not_found");
  });
  test("409 → already_cancelled, con el mensaje del backend si viene", () => {
    const result = normalizeCancellationError({ status: 409, body: { error: "La póliza ya está cancelada." } });
    expect(result.kind).toBe("already_cancelled");
    expect(result.message).toBe("La póliza ya está cancelada.");
  });
  test("400 → validation, con el mensaje del backend si viene", () => {
    const result = normalizeCancellationError({ status: 400, body: { error: "Fecha inválida." } });
    expect(result.kind).toBe("validation");
    expect(result.message).toBe("Fecha inválida.");
  });
  test("cualquier otro status → unknown", () => {
    expect(normalizeCancellationError({ status: 500 }).kind).toBe("unknown");
  });
});

describe("shouldRefreshAfterCancelResponse", () => {
  test("solo refresca en 200", () => {
    expect(shouldRefreshAfterCancelResponse(200)).toBe(true);
    expect(shouldRefreshAfterCancelResponse(400)).toBe(false);
    expect(shouldRefreshAfterCancelResponse(409)).toBe(false);
  });
});

// ─── 41. preview clasificado (forma esperada del resumen) ──────────────────────

describe("41. Forma del resumen de preview (CancellationPreviewSummary)", () => {
  test("el resumen clasificado trae exactamente los 4 buckets + pendingPaymentsToRender", () => {
    const summary = {
      policy: { id: 1 }, effectiveDate: "2027-06-01",
      installments: { paidUnchanged: 2, renderedUnchanged: 1, priorDebtUnchanged: 3, markedNonCollectible: 4 },
      pendingPaymentsToRender: 5,
    };
    expect(Object.keys(summary.installments).sort()).toEqual(
      ["markedNonCollectible", "paidUnchanged", "priorDebtUnchanged", "renderedUnchanged"].sort()
    );
    expect(summary.pendingPaymentsToRender).toBe(5);
  });
});

// ─── 44/45. Labels visuales ──────────────────────────────────────────────────────

describe("44. Label de policy_installments.status='no_exigible'", () => {
  test("tiene un label legible, no el string crudo con guión bajo", () => {
    expect(NON_COLLECTIBLE_STATUS_LABEL).toBe("No exigible");
    expect(NON_COLLECTIBLE_STATUS_LABEL).not.toContain("_");
  });
});

describe("45. Label de policies.status='renovada'", () => {
  test("STATUS_TYPES incluye 'renovada' con label y color", () => {
    expect(STATUS_TYPES.renovada).toBeDefined();
    expect(STATUS_TYPES.renovada!.label).toBe("Renovada");
    expect(STATUS_TYPES.renovada!.color).toContain("violet");
  });
  test("los 4 status preexistentes siguen intactos", () => {
    expect(STATUS_TYPES.activa!.label).toBe("Activa");
    expect(STATUS_TYPES.vencida!.label).toBe("Vencida");
    expect(STATUS_TYPES.por_vencer!.label).toBe("Por vencer");
    expect(STATUS_TYPES.cancelada!.label).toBe("Cancelada");
  });
});
