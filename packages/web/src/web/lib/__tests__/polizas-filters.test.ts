// Tests de la serialización de filtros/orden/página del listado de Pólizas.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/polizas-filters.test.ts
import { describe, test, expect } from "bun:test";
import {
  parsePoliziasFilters, buildPoliziasQuery, buildPoliziasPath,
  isValidSortKey, isValidSortOrder, DEFAULT_SORT_KEY, DEFAULT_SORT_ORDER, DEFAULT_PAGE,
} from "../polizas-filters";

describe("Caso A — entrar a /polizas sin query", () => {
  test("usa startDate desc como orden por defecto (pólizas con inicio más reciente primero)", () => {
    const filters = parsePoliziasFilters("");
    expect(filters.sortBy).toBe("startDate");
    expect(filters.sortOrder).toBe("desc");
    expect(filters.sortBy).toBe(DEFAULT_SORT_KEY);
    expect(filters.sortOrder).toBe(DEFAULT_SORT_ORDER);
    expect(filters.page).toBe(DEFAULT_PAGE);
    expect(filters.q).toBe("");
    expect(filters.type).toBe("");
    expect(filters.status).toBe("");
  });
});

describe("Caso A2 — compatibilidad con URLs existentes que usaban endDate", () => {
  test("sortBy=endDate en la URL sigue siendo válido y se respeta (no cae al default)", () => {
    const filters = parsePoliziasFilters("sortBy=endDate&sortOrder=desc");
    expect(filters.sortBy).toBe("endDate");
    expect(filters.sortOrder).toBe("desc");
  });
});

describe("Caso B — orden ascendente elegido por el usuario sobrevive a volver", () => {
  test("round-trip: parsear sortOrder=asc y reconstruir conserva asc", () => {
    const filters = parsePoliziasFilters("sortBy=endDate&sortOrder=asc&page=1");
    expect(filters.sortOrder).toBe("asc");
    const query = buildPoliziasQuery(filters);
    expect(new URLSearchParams(query).get("sortOrder")).toBe("asc");
  });
});

describe("Caso C — filtros + página 2 sobreviven al volver", () => {
  test("hidrata q, type, status y page desde la URL", () => {
    const search = "q=perez&type=automotor&status=activa&sortBy=insured&sortOrder=asc&page=2";
    const filters = parsePoliziasFilters(search);
    expect(filters).toEqual({
      q: "perez", type: "automotor", status: "activa", sortBy: "insured", sortOrder: "asc", page: 2,
    });
  });

  test("round-trip completo reproduce la misma query", () => {
    const search = "q=perez&type=automotor&status=activa&sortBy=insured&sortOrder=asc&page=2";
    const filters = parsePoliziasFilters(search);
    const rebuilt = buildPoliziasQuery(filters);
    const qs = new URLSearchParams(rebuilt);
    expect(qs.get("q")).toBe("perez");
    expect(qs.get("type")).toBe("automotor");
    expect(qs.get("status")).toBe("activa");
    expect(qs.get("sortBy")).toBe("insured");
    expect(qs.get("sortOrder")).toBe("asc");
    expect(qs.get("page")).toBe("2");
  });

  test("buildPoliziasPath arma la ruta completa de /polizas", () => {
    const path = buildPoliziasPath(parsePoliziasFilters("q=perez&page=2"));
    expect(path.startsWith("/polizas?")).toBe(true);
    expect(new URLSearchParams(path.split("?")[1]).get("q")).toBe("perez");
    expect(new URLSearchParams(path.split("?")[1]).get("page")).toBe("2");
  });
});

describe("Caso D — sortBy/sortOrder/page inválidos caen a defaults seguros", () => {
  test("sortBy desconocido cae al default", () => {
    expect(parsePoliziasFilters("sortBy=inventado").sortBy).toBe(DEFAULT_SORT_KEY);
  });
  test("sortOrder desconocido cae al default", () => {
    expect(parsePoliziasFilters("sortOrder=arriba").sortOrder).toBe(DEFAULT_SORT_ORDER);
  });
  test("page no numérica, cero o negativa cae a 1", () => {
    expect(parsePoliziasFilters("page=abc").page).toBe(1);
    expect(parsePoliziasFilters("page=0").page).toBe(1);
    expect(parsePoliziasFilters("page=-3").page).toBe(1);
    expect(parsePoliziasFilters("page=3.5").page).toBe(1);
  });
  test("type/status desconocidos se descartan", () => {
    expect(parsePoliziasFilters("type=no_existe").type).toBe("");
    expect(parsePoliziasFilters("status=no_existe").status).toBe("");
  });
  test("query vacía o basura no rompe el parseo", () => {
    const filters = parsePoliziasFilters("garbage=1&otro=xyz");
    expect(filters.sortBy).toBe(DEFAULT_SORT_KEY);
    expect(filters.sortOrder).toBe(DEFAULT_SORT_ORDER);
    expect(filters.page).toBe(DEFAULT_PAGE);
  });
});

describe("isValidSortKey / isValidSortOrder", () => {
  test("aceptan los valores conocidos", () => {
    expect(isValidSortKey("endDate")).toBe(true);
    expect(isValidSortKey("startDate")).toBe(true);
    expect(isValidSortKey("premium")).toBe(true);
    expect(isValidSortOrder("asc")).toBe(true);
    expect(isValidSortOrder("desc")).toBe(true);
  });
  test("rechazan valores desconocidos", () => {
    expect(isValidSortKey("otraCosa")).toBe(false);
    expect(isValidSortOrder("ascendente")).toBe(false);
  });
});

describe("buildPoliziasQuery — filtros vacíos no se agregan", () => {
  test("con q/type/status vacíos, la query solo tiene sortBy/sortOrder/page", () => {
    const query = buildPoliziasQuery({ q: "", type: "", status: "", sortBy: "endDate", sortOrder: "desc", page: 1 });
    expect(query).toBe("sortBy=endDate&sortOrder=desc&page=1");
  });
  test("recorta espacios de q y lo omite si queda vacío", () => {
    const query = buildPoliziasQuery({ q: "   ", type: "", status: "", sortBy: "endDate", sortOrder: "desc", page: 1 });
    expect(new URLSearchParams(query).has("q")).toBe(false);
  });
});
