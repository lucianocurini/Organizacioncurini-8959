// Estado efectivo de una póliza (lib/policies/effective-status.ts).
// Fixtures 100% sintéticos. "Hoy" siempre explícito.
import { describe, test, expect } from "bun:test";
import { effectivePolicyStatus, isEffectivelyVigente } from "../policies/effective-status";
import { addCalendarDays } from "../dates/argentina-date";

const TODAY = "2026-10-19";
const end = (days: number) => addCalendarDays(TODAY, days);

describe("límites de fecha final y de 30 días", () => {
  test("fin = hoy todavía NO es vencida (por vencer)", () => {
    expect(effectivePolicyStatus("activa", TODAY, TODAY)).toBe("por_vencer");
    expect(isEffectivelyVigente("activa", TODAY, TODAY)).toBe(true);
  });
  test("fin = ayer → vencida", () => {
    expect(effectivePolicyStatus("activa", end(-1), TODAY)).toBe("vencida");
    expect(effectivePolicyStatus("por_vencer", end(-1), TODAY)).toBe("vencida");
    expect(isEffectivelyVigente("por_vencer", end(-1), TODAY)).toBe(false);
  });
  test("faltan 30 días → por vencer; 31 → activa", () => {
    expect(effectivePolicyStatus("activa", end(30), TODAY)).toBe("por_vencer");
    expect(effectivePolicyStatus("activa", end(31), TODAY)).toBe("activa");
    expect(effectivePolicyStatus("por_vencer", end(31), TODAY)).toBe("activa");
  });
  test("cruce de mes y de año, aritmética de calendario pura", () => {
    expect(effectivePolicyStatus("activa", "2026-12-31", "2027-01-01")).toBe("vencida");
    expect(effectivePolicyStatus("activa", "2027-01-31", "2027-01-01")).toBe("por_vencer");
    expect(effectivePolicyStatus("activa", "2027-02-01", "2027-01-01")).toBe("activa");
  });
  test("vencida guardada con fin futuro se recalcula (misma regla que la edición)", () => {
    expect(effectivePolicyStatus("vencida", end(60), TODAY)).toBe("activa");
    expect(effectivePolicyStatus("vencida", end(10), TODAY)).toBe("por_vencer");
    expect(effectivePolicyStatus("vencida", end(-5), TODAY)).toBe("vencida");
  });
});

describe("estados terminales y datos no recalculables", () => {
  test("cancelada y renovada se preservan siempre, con cualquier fecha final", () => {
    for (const d of [end(-400), end(-1), TODAY, end(10), end(400)]) {
      expect(effectivePolicyStatus("cancelada", d, TODAY)).toBe("cancelada");
      expect(effectivePolicyStatus("renovada", d, TODAY)).toBe("renovada");
      expect(isEffectivelyVigente("cancelada", d, TODAY)).toBe(false);
      expect(isEffectivelyVigente("renovada", d, TODAY)).toBe(false);
    }
  });
  test("fecha final inválida o ausente → estado guardado", () => {
    expect(effectivePolicyStatus("activa", null, TODAY)).toBe("activa");
    expect(effectivePolicyStatus("activa", "2026-02-30", TODAY)).toBe("activa");
    expect(effectivePolicyStatus("por_vencer", "0206-07-08", TODAY)).toBe("por_vencer");
  });
  test("estado desconocido o nulo → tal cual", () => {
    expect(effectivePolicyStatus("otro", end(-10), TODAY)).toBe("otro");
    expect(effectivePolicyStatus(null, end(-10), TODAY)).toBeNull();
  });
  test("depende solo de `today` explícito, no del reloj", () => {
    expect(effectivePolicyStatus("activa", "2026-10-19", "2026-10-19")).toBe("por_vencer");
    expect(effectivePolicyStatus("activa", "2026-10-19", "2026-10-20")).toBe("vencida");
  });
});
