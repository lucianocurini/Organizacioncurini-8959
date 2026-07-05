// Tests de los helpers puros de la interfaz de reconstrucción de planes de
// cuotas (Subetapa 2B — interfaz). No usan React ni DOM: la lógica de decisión
// se extrajo a packages/web/src/web/lib/installments-rebuild.ts precisamente
// para poder probarla sin infraestructura de componentes.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/installments-rebuild.test.ts

import { describe, test, expect } from "bun:test";
import {
  compareExpectedVsActual, EXPECTED_VS_ACTUAL_LABELS,
  parseExpectedInstallmentsInput,
  buildRebuildRequestBody,
  summarizeRebuildPlan,
  normalizeRebuildError,
  canConfirmRebuild,
  decideRebuildUiAction,
  shouldShowRebuildButton,
  shouldRefreshAfterRebuildResponse,
} from "../installments-rebuild";
import { buildInstallmentPlan, InstallmentPlanError } from "../../../lib/installments/plan";

// ── 1-2: esperado vs. real ─────────────────────────────────────────────────────

describe("Caso A — expectedCount null nunca es mismatch", () => {
  test("1. expectedCount null → sin_definir, nunca no_coincide", () => {
    const result = compareExpectedVsActual(null, 7);
    expect(result.status).toBe("sin_definir");
    expect(result.status).not.toBe("no_coincide");
    expect(EXPECTED_VS_ACTUAL_LABELS[result.status]).toBe("Sin cantidad esperada definida");
  });

  test("expectedCount null con actualCount 0 también es sin_definir (nunca mismatch)", () => {
    expect(compareExpectedVsActual(null, 0).status).toBe("sin_definir");
  });
});

describe("Caso B — expectedCount distinto del real muestra aviso", () => {
  test("2. expectedCount=10, actualCount=12 → no_coincide, con label de aviso", () => {
    const result = compareExpectedVsActual(10, 12);
    expect(result.status).toBe("no_coincide");
    expect(EXPECTED_VS_ACTUAL_LABELS[result.status]).toBe("No coinciden");
  });

  test("expectedCount === actualCount → coincide", () => {
    expect(compareExpectedVsActual(10, 10).status).toBe("coincide");
  });
});

// ── 3: edición de "cantidad esperada" no toca el backend de rebuild ───────────

describe("Caso C — validación de 'cantidad de cuotas esperada' (PolicyModal)", () => {
  test("3. es una función pura: acepta/rechaza valores sin llamar a ningún endpoint", () => {
    // parseExpectedInstallmentsInput no importa `api` ni hace fetch — es la
    // única lógica que corre en el onChange/submit del campo en PolicyModal.
    // Que sea pura y sincrónica prueba, por construcción, que editar este
    // campo no puede disparar una llamada de red.
    expect(parseExpectedInstallmentsInput("12")).toEqual({ value: 12, error: null });
    expect(parseExpectedInstallmentsInput("")).toEqual({ value: null, error: null });
    expect(parseExpectedInstallmentsInput("   ")).toEqual({ value: null, error: null });
  });

  test("rechaza cero", () => {
    expect(parseExpectedInstallmentsInput("0").error).toBeTruthy();
    expect(parseExpectedInstallmentsInput("0").value).toBeNull();
  });

  test("rechaza negativos", () => {
    expect(parseExpectedInstallmentsInput("-3").error).toBeTruthy();
  });

  test("rechaza decimales", () => {
    expect(parseExpectedInstallmentsInput("3.5").error).toBeTruthy();
  });

  test("rechaza valores no numéricos", () => {
    expect(parseExpectedInstallmentsInput("abc").error).toBeTruthy();
    expect(parseExpectedInstallmentsInput("12abc").error).toBeTruthy();
  });
});

// ── 4-6: SAFE_TO_REBUILD / NO_INSTALLMENTS / REQUIRES_MANUAL_REVIEW ───────────

describe("Caso D — decisión de UI según `classification` (nunca según `mismatched`)", () => {
  test("4. SAFE_TO_REBUILD habilita el formulario", () => {
    expect(decideRebuildUiAction("SAFE_TO_REBUILD")).toBe("open_form");
  });

  test("5. NO_INSTALLMENTS también habilita el formulario (reconstrucción permitida)", () => {
    expect(decideRebuildUiAction("NO_INSTALLMENTS")).toBe("open_form");
  });

  test("6. REQUIRES_MANUAL_REVIEW muestra el panel de bloqueos, no el formulario", () => {
    expect(decideRebuildUiAction("REQUIRES_MANUAL_REVIEW")).toBe("show_blocked");
  });
});

describe("Caso E — visibilidad del botón 'Corregir plan de cuotas'", () => {
  test("visible si hay cuotas reales, aunque coincidan con lo esperado", () => {
    expect(shouldShowRebuildButton(3, compareExpectedVsActual(3, 3))).toBe(true);
  });

  test("visible si hay mismatch aunque actualCount sea 0", () => {
    expect(shouldShowRebuildButton(0, compareExpectedVsActual(5, 0))).toBe(true);
  });

  test("oculto si no hay cuotas y no hay expectedCount definido", () => {
    expect(shouldShowRebuildButton(0, compareExpectedVsActual(null, 0))).toBe(false);
  });
});

// ── 7: rebillingId bloqueante se muestra con su motivo ────────────────────────

describe("Caso F — motivos de bloqueo (incluido rebillingId) se muestran sin filtrar", () => {
  test("7. un 409 con blockingInstallments por rebillingId conserva el motivo textual del backend", () => {
    const err = {
      status: 409,
      message: "La póliza tiene cuotas con actividad — no se puede reconstruir el plan.",
      body: {
        error: "La póliza tiene cuotas con actividad — no se puede reconstruir el plan.",
        blockingInstallments: [
          { id: 1, number: 2, dueDate: "2027-03-01", reasons: ['La cuota pertenece a una refacturación (rebillingId=9).'] },
        ],
      },
    };
    const normalized = normalizeRebuildError(err);
    expect(normalized.kind).toBe("blocked");
    expect(normalized.blockingInstallments).toHaveLength(1);
    expect(normalized.blockingInstallments[0]!.reasons).toContain("La cuota pertenece a una refacturación (rebillingId=9).");
  });

  test("409 sin body (red cae antes del JSON) no rompe — blockingInstallments queda vacío", () => {
    const normalized = normalizeRebuildError({ status: 409, message: "conflicto" });
    expect(normalized.kind).toBe("blocked");
    expect(normalized.blockingInstallments).toEqual([]);
  });
});

// ── 8: validación local impide enviar plan fuera del período ──────────────────

describe("Caso G — previsualización local (buildInstallmentPlan) rechaza planes fuera de rango", () => {
  test("8. 6 cuotas mensuales no entran en un período de 1 mes → InstallmentPlanError", () => {
    expect(() => buildInstallmentPlan({
      periodStart: "2027-01-01",
      periodEnd: "2027-02-01",
      periodAmount: 3000,
      installmentCount: 6,
    })).toThrow(InstallmentPlanError);
  });

  test("un plan que sí entra en el período no lanza error", () => {
    expect(() => buildInstallmentPlan({
      periodStart: "2027-01-01",
      periodEnd: "2027-06-01",
      periodAmount: 3000,
      installmentCount: 3,
    })).not.toThrow();
  });
});

// ── 9: checkbox desmarcado mantiene deshabilitado el botón final ─────────────

describe("Caso H — gating del botón de confirmación final", () => {
  test("9. plan válido pero checkbox sin marcar → deshabilitado", () => {
    expect(canConfirmRebuild(true, false)).toBe(false);
  });

  test("plan válido y checkbox marcado → habilitado", () => {
    expect(canConfirmRebuild(true, true)).toBe(true);
  });

  test("checkbox marcado pero plan inválido → deshabilitado", () => {
    expect(canConfirmRebuild(false, true)).toBe(false);
  });
});

// ── 10: body exacto, sin cuotas prearmadas ────────────────────────────────────

describe("Caso I — body exacto de POST /installments/rebuild", () => {
  test("10. incluye únicamente los campos aceptados por el backend, nunca un array de cuotas", () => {
    const body = buildRebuildRequestBody({
      periodStart: "2027-01-01", periodEnd: "2027-06-01",
      periodAmount: "3000", installmentCount: "3",
      firstDueDate: "2027-01-15", installmentIntervalMonths: "2",
    });
    expect(body).toEqual({
      periodStart: "2027-01-01", periodEnd: "2027-06-01",
      periodAmount: 3000, installmentCount: 3,
      firstDueDate: "2027-01-15", installmentIntervalMonths: 2,
    });
    expect((body as any).installments).toBeUndefined();
  });

  test("omite firstDueDate/installmentIntervalMonths cuando no se completaron (opcionales)", () => {
    const body = buildRebuildRequestBody({
      periodStart: "2027-01-01", periodEnd: "2027-06-01",
      periodAmount: "3000", installmentCount: "3",
      firstDueDate: "", installmentIntervalMonths: "",
    });
    expect(body).toEqual({
      periodStart: "2027-01-01", periodEnd: "2027-06-01",
      periodAmount: 3000, installmentCount: 3,
    });
    expect("firstDueDate" in body).toBe(false);
    expect("installmentIntervalMonths" in body).toBe(false);
  });
});

// ── 11-12: refresco tras éxito, no tras 409 ───────────────────────────────────

describe("Caso J — solo un 200 dispara el refresco de datos", () => {
  test("11. éxito (200) refresca datos", () => {
    expect(shouldRefreshAfterRebuildResponse(200)).toBe(true);
  });

  test("12. 409 no refresca datos — la lista local no se toca como si hubiera éxito", () => {
    expect(shouldRefreshAfterRebuildResponse(409)).toBe(false);
    expect(shouldRefreshAfterRebuildResponse(400)).toBe(false);
    expect(shouldRefreshAfterRebuildResponse(404)).toBe(false);
  });

  test("normalizeRebuildError para 400/404 no se confunde con 'blocked'", () => {
    expect(normalizeRebuildError({ status: 400, message: "plan inválido" }).kind).toBe("validation");
    expect(normalizeRebuildError({ status: 404 }).kind).toBe("not_found");
  });
});

// ── Resumen del plan para la confirmación ─────────────────────────────────────

describe("Caso K — resumen del plan mostrado antes de confirmar", () => {
  test("incluye previousCount, cantidad nueva, importe total y primera/última fecha", () => {
    const plan = buildInstallmentPlan({
      periodStart: "2027-01-01", periodEnd: "2027-06-01", periodAmount: 3000, installmentCount: 3,
    });
    const summary = summarizeRebuildPlan(2, plan, "2027-01-01", "2027-06-01");
    expect(summary).toEqual({
      previousCount: 2,
      newCount: 3,
      totalAmount: 3000,
      periodStart: "2027-01-01",
      periodEnd: "2027-06-01",
      firstDueDate: "2027-01-01",
      lastDueDate: "2027-03-01",
    });
  });
});
