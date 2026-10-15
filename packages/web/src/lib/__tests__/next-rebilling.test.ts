// Regla central de la próxima refacturación (lib/policies/next-rebilling.ts).
// Fixtures 100% sintéticos (sin datos de producción). "Hoy" fijo: 2026-10-14.
import { describe, test, expect } from "bun:test";
import {
  resolveNextRebilling,
  periodShape,
  isPlausibleCalendarDate,
  nextRebillingReviewLabel,
  type NextRebillingPolicyInput,
  type NextRebillingRebillingInput,
  type NextRebillingKind,
} from "../policies/next-rebilling";

const TODAY = "2026-10-14";

let nextId = 1;
function reb(billingStart: string, billingEnd: string, status: string | null = "activa"): NextRebillingRebillingInput {
  return { id: nextId++, billingStart, billingEnd, status };
}
function pol(over: Partial<NextRebillingPolicyInput> = {}): NextRebillingPolicyInput {
  return { status: "activa", endDate: "2027-12-31", billingCycle: "trimestral", nextRebillingDate: null, ...over };
}

interface Fixture {
  name: string;
  policy: NextRebillingPolicyInput;
  rebillings: NextRebillingRebillingInput[];
  kind: NextRebillingKind;
  state: string;
  reason?: string | null;
  date?: string | null;
}

// Set sintético por categoría (los tests de endpoint y de backfill arman
// casos equivalentes con fechas relativas a hoy).
const FIXTURES: Fixture[] = [
  // ── safe (8) ───────────────────────────────────────────────────────────────
  {
    name: "El Norte, caso sintético B: guardada 01/07, período 01/07–01/11, cuatrimestral",
    policy: pol({ billingCycle: "cuatrimestral", nextRebillingDate: "2026-07-01", endDate: "2027-03-01" }),
    rebillings: [reb("2026-07-01", "2026-11-01")],
    kind: "safe", state: "atrasado_derivable", date: "2026-11-01",
  },
  {
    name: "Rivadavia, caso sintético A: guardada 01/08, período 01/08–01/11, trimestral",
    policy: pol({ nextRebillingDate: "2026-08-01", endDate: "2027-02-01" }),
    rebillings: [reb("2026-08-01", "2026-11-01")],
    kind: "safe", state: "atrasado_derivable", date: "2026-11-01",
  },
  {
    name: "nula + fin inclusivo (inicio + 3 meses − 1 día) → fin + 1",
    policy: pol({ endDate: "2027-08-15" }),
    rebillings: [reb("2026-08-15", "2026-11-14")],
    kind: "safe", state: "nulo_derivable", date: "2026-11-15",
  },
  {
    name: "nula + fin inclusivo a mitad de mes",
    policy: pol(),
    rebillings: [reb("2026-09-10", "2026-12-09")],
    kind: "safe", state: "nulo_derivable", date: "2026-12-10",
  },
  {
    name: "guardada coincide con la derivada",
    policy: pol({ nextRebillingDate: "2026-12-01" }),
    rebillings: [reb("2026-09-01", "2026-11-30")],
    kind: "safe", state: "coincide", date: "2026-12-01",
  },
  {
    name: "guardada posterior válida → se respeta",
    policy: pol({ nextRebillingDate: "2027-01-10" }),
    rebillings: [reb("2026-09-01", "2026-11-30")],
    kind: "safe", state: "posterior", date: "2027-01-10",
  },
  {
    name: "guardada futura sin historial para contrastar",
    policy: pol({ nextRebillingDate: "2026-12-01" }),
    rebillings: [],
    kind: "safe", state: "explicita_sin_contraste", reason: null, date: "2026-12-01",
  },
  {
    name: "refacturación 'duplicada' (invalidada) no cuenta como duplicado activo",
    policy: pol(),
    rebillings: [reb("2026-09-01", "2026-11-30"), reb("2026-09-01", "2026-11-30", "duplicada")],
    kind: "safe", state: "nulo_derivable", date: "2026-12-01",
  },
  // ── review (14) ────────────────────────────────────────────────────────────
  {
    name: "período irregular (ni fin inclusivo ni fin = inicio siguiente)",
    policy: pol(),
    rebillings: [reb("2026-08-05", "2026-10-20")],
    kind: "review", state: "nulo_sin_derivacion_segura", reason: "periodo_irregular",
  },
  {
    name: "último período cargado por adelantado (todavía no empezó)",
    policy: pol({ billingCycle: "trimestral", endDate: "2027-11-01" }),
    rebillings: [reb("2026-08-01", "2026-11-01"), reb("2026-11-01", "2027-02-01")],
    kind: "review", state: "nulo_sin_derivacion_segura", reason: "periodo_futuro_ya_cargado",
  },
  {
    name: "superposición",
    policy: pol(),
    rebillings: [reb("2026-06-01", "2026-09-30"), reb("2026-09-01", "2026-11-30")],
    kind: "review", state: "nulo_sin_derivacion_segura", reason: "superposicion",
  },
  {
    name: "período duplicado activo",
    policy: pol(),
    rebillings: [reb("2026-09-01", "2026-11-30"), reb("2026-09-01", "2026-11-30")],
    kind: "review", state: "nulo_sin_derivacion_segura", reason: "periodo_duplicado_activo",
  },
  {
    name: "último período vencido",
    policy: pol(),
    rebillings: [reb("2026-05-01", "2026-07-31")],
    kind: "review", state: "nulo_sin_derivacion_segura", reason: "ultimo_periodo_vencido",
  },
  {
    name: "períodos discontinuos",
    policy: pol(),
    rebillings: [reb("2026-05-01", "2026-07-31"), reb("2026-09-01", "2026-11-30")],
    kind: "review", state: "nulo_sin_derivacion_segura", reason: "periodos_discontinuos",
  },
  {
    name: "ciclo no coincide",
    policy: pol({ billingCycle: "semestral" }),
    rebillings: [reb("2026-09-01", "2026-11-30")],
    kind: "review", state: "nulo_sin_derivacion_segura", reason: "ciclo_no_coincide",
  },
  {
    name: "sin ciclo ni período anterior que corrobore",
    policy: pol({ billingCycle: null }),
    rebillings: [reb("2026-09-01", "2026-11-30")],
    kind: "review", state: "nulo_sin_derivacion_segura", reason: "sin_corroboracion",
  },
  {
    name: "ciclo informado pero sin refacturaciones",
    policy: pol(),
    rebillings: [],
    kind: "review", state: "nulo_sin_derivacion_segura", reason: "sin_refacturaciones",
  },
  {
    name: "guardada vencida sin derivación",
    policy: pol({ nextRebillingDate: "2026-09-01" }),
    rebillings: [],
    kind: "review", state: "explicita_vencida_sin_derivacion", reason: "sin_refacturaciones",
  },
  {
    name: "guardada dentro del período vigente",
    policy: pol({ nextRebillingDate: "2026-10-20" }),
    rebillings: [reb("2026-09-01", "2026-11-30")],
    kind: "review", state: "contradictorio_en_periodo", reason: "explicita_dentro_del_periodo_vigente",
  },
  {
    name: "refacturación con año 0206",
    policy: pol(),
    rebillings: [reb("0206-07-08", "2026-11-30")],
    kind: "review", state: "nulo_sin_derivacion_segura", reason: "fecha_invalida",
  },
  {
    name: "guardada con año 0206",
    policy: pol({ nextRebillingDate: "0206-07-08" }),
    rebillings: [reb("2026-09-01", "2026-11-30")],
    kind: "review", state: "explicita_invalida", reason: "explicita_invalida",
  },
  {
    name: "ciclo desconocido",
    policy: pol({ billingCycle: "quincenal" }),
    rebillings: [reb("2026-09-01", "2026-11-30")],
    kind: "review", state: "nulo_sin_derivacion_segura", reason: "ciclo_desconocido",
  },
  // ── renewal (2) ────────────────────────────────────────────────────────────
  {
    name: "fin de período = fin de vigencia",
    policy: pol({ billingCycle: "cuatrimestral", endDate: "2026-11-01", nextRebillingDate: "2026-07-01" }),
    rebillings: [reb("2026-07-01", "2026-11-01")],
    kind: "renewal", state: "coincide_con_renovacion",
  },
  {
    name: "guardada en el mismo mes de la renovación",
    policy: pol({ nextRebillingDate: "2026-12-05", endDate: "2026-12-20" }),
    rebillings: [],
    kind: "renewal", state: "coincide_con_renovacion",
  },
  // ── not_applicable (2) ─────────────────────────────────────────────────────
  {
    name: "póliza no vigente",
    policy: pol({ status: "vencida", nextRebillingDate: "2026-12-01" }),
    rebillings: [],
    kind: "not_applicable", state: "no_vigente",
  },
  {
    name: "sin ciclo ni refacturaciones ni fecha guardada",
    policy: pol({ billingCycle: null }),
    rebillings: [],
    kind: "not_applicable", state: "nulo_no_aplica",
  },
];

describe("resolveNextRebilling — set sintético por categoría", () => {
  for (const f of FIXTURES) {
    test(`${f.kind}: ${f.name}`, () => {
      const r = resolveNextRebilling(f.policy, f.rebillings, TODAY);
      expect(r.kind).toBe(f.kind);
      expect(r.state).toBe(f.state as any);
      if (f.reason !== undefined) expect(r.reason).toBe(f.reason as any);
      if (f.date !== undefined) expect(r.date).toBe(f.date);
      if (r.kind !== "safe") expect(r.date).toBeNull();
    });
  }

  test("conteo por categoría del set sintético", () => {
    const counts: Record<string, number> = {};
    for (const f of FIXTURES) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    expect(counts).toEqual({ safe: 8, review: 14, renewal: 2, not_applicable: 2 });
  });
});

describe("regresiones obligatorias", () => {
  test("El Norte, caso sintético B → 01/11/2026, fecha segura", () => {
    const r = resolveNextRebilling(FIXTURES[0]!.policy, FIXTURES[0]!.rebillings, TODAY);
    expect(r).toMatchObject({ kind: "safe", date: "2026-11-01", source: "derivada" });
    expect(nextRebillingReviewLabel(r)).toBeNull();
  });

  test("Rivadavia, caso sintético A → 01/11/2026, fecha segura (no día ambiguo)", () => {
    const r = resolveNextRebilling(FIXTURES[1]!.policy, FIXTURES[1]!.rebillings, TODAY);
    expect(r).toMatchObject({ kind: "safe", date: "2026-11-01", source: "derivada" });
    expect(nextRebillingReviewLabel(r)).toBeNull();
  });

  test("hoy pasado el período: la misma póliza pasa a revisión (último período vencido)", () => {
    const r = resolveNextRebilling(FIXTURES[0]!.policy, FIXTURES[0]!.rebillings, "2026-11-02");
    expect(r.kind).toBe("review");
    expect(r.reason).toBe("ultimo_periodo_vencido");
  });

  test("'hoy' igual a la fecha derivada sigue siendo seguro", () => {
    const r = resolveNextRebilling(FIXTURES[0]!.policy, FIXTURES[0]!.rebillings, "2026-11-01");
    expect(r).toMatchObject({ kind: "safe", date: "2026-11-01" });
  });
});

describe("forma matemática del período", () => {
  test("(a) fin = inicio + ciclo − 1 día → próxima = fin + 1", () => {
    expect(periodShape("2026-08-01", "2026-10-31")).toEqual({ months: 3, nextStart: "2026-11-01" });
    expect(periodShape("2026-07-01", "2026-10-31")).toEqual({ months: 4, nextStart: "2026-11-01" });
  });
  test("(b) fin = inicio + ciclo → próxima = fin", () => {
    expect(periodShape("2026-08-01", "2026-11-01")).toEqual({ months: 3, nextStart: "2026-11-01" });
    expect(periodShape("2026-07-01", "2026-11-01")).toEqual({ months: 4, nextStart: "2026-11-01" });
  });
  test("(c) cualquier otra forma → null (revisión)", () => {
    expect(periodShape("2026-08-05", "2026-10-20")).toBeNull();
    expect(periodShape("2026-08-31", "2026-11-30")).toBeNull(); // fin de mes desparejo
    expect(periodShape("2026-08-01", "2026-08-01")).toBeNull();
  });

  test("las notas / el importador nunca deciden la fecha", () => {
    const base = { id: 1, billingStart: "2026-08-01", billingEnd: "2026-11-01", status: "activa" };
    const results = [null, "Prórroga", "Importado de Rivadavia", "Importado de El Norte v2. Endoso 4", "SSN-GDE 2026-09. Orden 2"]
      .map((notes) => resolveNextRebilling(pol(), [{ ...base, notes } as any], TODAY));
    for (const r of results) expect(r).toEqual(results[0]!);
    expect(results[0]!.date).toBe("2026-11-01");
  });

  test("continuidad entre formas distintas: (b) seguida de (a)", () => {
    const r = resolveNextRebilling(pol({ billingCycle: "trimestral" }), [reb("2026-06-01", "2026-09-01"), reb("2026-09-01", "2026-11-30")], TODAY);
    expect(r).toMatchObject({ kind: "safe", date: "2026-12-01" });
  });

  test("sin ciclo: el período anterior con la misma duración corrobora", () => {
    const r = resolveNextRebilling(pol({ billingCycle: null }), [reb("2026-06-01", "2026-08-31"), reb("2026-09-01", "2026-11-30")], TODAY);
    expect(r).toMatchObject({ kind: "safe", date: "2026-12-01" });
  });
});

describe("detalles de la regla", () => {
  test("fechas plausibles", () => {
    expect(isPlausibleCalendarDate("2026-11-01")).toBe(true);
    expect(isPlausibleCalendarDate("0206-07-08")).toBe(false);
    expect(isPlausibleCalendarDate("2026-02-30")).toBe(false);
    expect(isPlausibleCalendarDate("2026-1-01")).toBe(false);
    expect(isPlausibleCalendarDate(null)).toBe(false);
  });

  test("guardada consumida + derivada que cae en la renovación → renovación (no se duplica)", () => {
    const r = resolveNextRebilling(pol({ nextRebillingDate: "2026-09-01", endDate: "2026-12-01" }), [reb("2026-09-01", "2026-11-30")], TODAY);
    expect(r.kind).toBe("renewal");
  });

  test("motivo de período futuro: nombra la refacturación ya cargada y aclara que falta la siguiente", () => {
    const r = resolveNextRebilling(pol({ endDate: "2027-11-01" }), [reb("2026-08-01", "2026-11-01"), reb("2026-11-01", "2027-02-01")], TODAY);
    expect(r).toMatchObject({ kind: "review", reason: "periodo_futuro_ya_cargado", loadedFutureStart: "2026-11-01" });
    expect(nextRebillingReviewLabel(r)).toBe(
      "Ya hay una refacturación cargada que empieza el 01/11/2026; lo que falta definir es la siguiente, posterior a ese período",
    );
  });

  test("motivo legible de una guardada vencida", () => {
    const r = resolveNextRebilling(pol({ nextRebillingDate: "2026-09-01" }), [], TODAY);
    expect(nextRebillingReviewLabel(r)).toBe(
      "Próxima refacturación guardada vencida (01/09/2026); tiene frecuencia de refacturación pero ninguna refacturación cargada",
    );
  });
});
