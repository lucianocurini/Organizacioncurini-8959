// Tests de la serialización de filtros del Reporte mensual en query string.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/report-filters.test.ts
import { describe, test, expect } from "bun:test";
import { parseReportFilters, buildReportQuery, buildReportPath, isValidReportMonth } from "../report-filters";

const FALLBACK_MONTH = "2026-07";

describe("isValidReportMonth", () => {
  test("acepta YYYY-MM válido", () => {
    expect(isValidReportMonth("2026-07")).toBe(true);
    expect(isValidReportMonth("2026-01")).toBe(true);
    expect(isValidReportMonth("2026-12")).toBe(true);
  });
  test("rechaza mes fuera de rango o mal formado", () => {
    expect(isValidReportMonth("2026-13")).toBe(false);
    expect(isValidReportMonth("2026-00")).toBe(false);
    expect(isValidReportMonth("2026-7")).toBe(false);
    expect(isValidReportMonth("26-07")).toBe(false);
    expect(isValidReportMonth("")).toBe(false);
  });
});

describe("parseReportFilters — Caso A (URL con filtros válidos)", () => {
  test("hidrata el estado completo desde la query string del enunciado", () => {
    const search = "month=2026-07&companyId=3&movementType=rebilling&rebillingType=prorroga&q=123";
    const filters = parseReportFilters(search, FALLBACK_MONTH);
    expect(filters).toEqual({
      month: "2026-07",
      companyId: "3",
      type: "",
      movementType: "rebilling",
      rebillingType: "prorroga",
      q: "123",
    });
  });

  test("round-trip: parsear y volver a construir reproduce la misma query", () => {
    const search = "month=2026-07&companyId=3&movementType=rebilling&rebillingType=prorroga&type=automotor&q=123";
    const filters = parseReportFilters(search, FALLBACK_MONTH);
    const rebuilt = buildReportQuery(filters);
    expect(new URLSearchParams(rebuilt).get("month")).toBe("2026-07");
    expect(new URLSearchParams(rebuilt).get("companyId")).toBe("3");
    expect(new URLSearchParams(rebuilt).get("movementType")).toBe("rebilling");
    expect(new URLSearchParams(rebuilt).get("rebillingType")).toBe("prorroga");
    expect(new URLSearchParams(rebuilt).get("type")).toBe("automotor");
    expect(new URLSearchParams(rebuilt).get("q")).toBe("123");
  });
});

describe("parseReportFilters — Caso C (valores inválidos se ignoran de forma segura)", () => {
  test("mes inválido cae al mes por defecto, no rompe ni se propaga", () => {
    const filters = parseReportFilters("month=2026-99", FALLBACK_MONTH);
    expect(filters.month).toBe(FALLBACK_MONTH);
  });
  test("companyId no numérico se descarta", () => {
    const filters = parseReportFilters("companyId=<script>", FALLBACK_MONTH);
    expect(filters.companyId).toBe("");
  });
  test("movementType desconocido se descarta", () => {
    const filters = parseReportFilters("movementType=inventado", FALLBACK_MONTH);
    expect(filters.movementType).toBe("");
  });
  test("rebillingType desconocido se descarta", () => {
    const filters = parseReportFilters("rebillingType=cualquiera", FALLBACK_MONTH);
    expect(filters.rebillingType).toBe("");
  });
  test("type desconocido (no existe en POLICY_TYPES) se descarta", () => {
    const filters = parseReportFilters("type=no_existe", FALLBACK_MONTH);
    expect(filters.type).toBe("");
  });
  test("parámetros basura / desconocidos no rompen el parseo", () => {
    const filters = parseReportFilters("garbage=1&otroMas=xyz", FALLBACK_MONTH);
    expect(filters.month).toBe(FALLBACK_MONTH);
    expect(filters.companyId).toBe("");
  });
  test("query string vacía usa todos los defaults", () => {
    const filters = parseReportFilters("", FALLBACK_MONTH);
    expect(filters).toEqual({
      month: FALLBACK_MONTH, companyId: "", type: "", movementType: "", rebillingType: "", q: "",
    });
  });
});

describe("buildReportQuery — filtros vacíos no se agregan, mes siempre presente", () => {
  test("con todos los filtros vacíos, la query solo tiene month", () => {
    const query = buildReportQuery({ month: "2026-07", companyId: "", type: "", movementType: "", rebillingType: "", q: "" });
    expect(query).toBe("month=2026-07");
  });
  test("recorta espacios de q y lo omite si queda vacío", () => {
    const query = buildReportQuery({ month: "2026-07", companyId: "", type: "", movementType: "", rebillingType: "", q: "   " });
    expect(query).toBe("month=2026-07");
  });
  test("incluye q recortado cuando tiene contenido", () => {
    const query = buildReportQuery({ month: "2026-07", companyId: "", type: "", movementType: "", rebillingType: "", q: "  123  " });
    expect(new URLSearchParams(query).get("q")).toBe("123");
  });
});

describe("buildReportPath", () => {
  test("arma la ruta completa de reporte-mes con la query", () => {
    const path = buildReportPath({ month: "2026-07", companyId: "3", type: "", movementType: "rebilling", rebillingType: "prorroga", q: "" });
    expect(path.startsWith("/reporte-mes?")).toBe(true);
    const qs = new URLSearchParams(path.split("?")[1]);
    expect(qs.get("month")).toBe("2026-07");
    expect(qs.get("companyId")).toBe("3");
    expect(qs.get("movementType")).toBe("rebilling");
    expect(qs.get("rebillingType")).toBe("prorroga");
  });
});

describe("Caso D (importador Cooperación) — tipo automotor/motovehiculo no colisiona con validación", () => {
  test("acepta tipos reales de POLICY_TYPES", () => {
    expect(parseReportFilters("type=motovehiculo", FALLBACK_MONTH).type).toBe("motovehiculo");
    expect(parseReportFilters("type=comercial", FALLBACK_MONTH).type).toBe("comercial");
  });
});

describe("Caso H (cruce de mes se refleja y sobrevive a recarga)", () => {
  test("cambiar de mes y reconstruir la query preserva el resto de filtros", () => {
    const base = parseReportFilters("month=2026-07&companyId=3&q=123", FALLBACK_MONTH);
    const nextMonth = { ...base, month: "2026-08" };
    const query = buildReportQuery(nextMonth);
    const reparsed = parseReportFilters(query, FALLBACK_MONTH);
    expect(reparsed.month).toBe("2026-08");
    expect(reparsed.companyId).toBe("3");
    expect(reparsed.q).toBe("123");
  });
});
