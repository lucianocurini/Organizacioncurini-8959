// Tests puros del adaptador de "Vencimiento de la primera cuota" en el alta
// manual de póliza (PolicyModal.tsx). Sin React, sin fetch, sin DOM — mismo
// patrón que installments-rebuild.test.ts/rebilling-modal.test.ts.
//
// buildInstallmentPlan en sí (aritmética de fin de mes, bisiestos, centavos,
// firstDueDate fuera de rango) ya está exhaustivamente testeada en
// api/__tests__/installment-plan.test.ts — acá solo se prueba la plomería
// nueva: que planMonthlyInstallments la invoque bien y traduzca el resultado
// (o el error) al shape que usa PolicyModal, y que el sync de
// firstDueDate↔startDate se comporte como se pidió.
//
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/policy-installments-form.test.ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { planMonthlyInstallments, nextFirstDueDateOnStartDateChange, computeCashPaymentPreview } from "../policy-installments-form";

describe("planMonthlyInstallments — firstDueDate igual a startDate", () => {
  test("sin firstDueDate explícito, la primera cuota vence en startDate (comportamiento de siempre)", () => {
    const result = planMonthlyInstallments("2026-01-01", "2026-03-31", 3, 100000);
    expect(result.error).toBeNull();
    expect(result.installments[0]!.dueDate).toBe("2026-01-01");
  });

  test("firstDueDate === startDate explícito da el mismo resultado", () => {
    const result = planMonthlyInstallments("2026-01-01", "2026-03-31", 3, 100000, "2026-01-01");
    expect(result.error).toBeNull();
    expect(result.installments[0]!.dueDate).toBe("2026-01-01");
  });
});

describe("planMonthlyInstallments — firstDueDate posterior dentro del período", () => {
  test("se respeta y las siguientes cuotas propagan mensualmente desde ahí", () => {
    const result = planMonthlyInstallments("2026-01-01", "2026-03-31", 3, 100000, "2026-01-15");
    expect(result.error).toBeNull();
    expect(result.installments.map(i => i.dueDate)).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
  });
});

describe("planMonthlyInstallments — campo vacío conserva el comportamiento anterior", () => {
  test("firstDueDate=''  se comporta igual que no pasarlo (usa periodStart)", () => {
    const conVacio = planMonthlyInstallments("2026-01-01", "2026-06-30", 6, 60000, "");
    const sinParametro = planMonthlyInstallments("2026-01-01", "2026-06-30", 6, 60000);
    expect(conVacio).toEqual(sinParametro);
    expect(conVacio.installments[0]!.dueDate).toBe("2026-01-01");
  });

  test("firstDueDate=undefined explícito también usa periodStart", () => {
    const result = planMonthlyInstallments("2026-01-01", "2026-06-30", 6, 60000, undefined);
    expect(result.installments[0]!.dueDate).toBe("2026-01-01");
  });
});

describe("planMonthlyInstallments — firstDueDate fuera del período: rechazado con mensaje", () => {
  test("anterior al inicio del período → error, sin cuotas", () => {
    const result = planMonthlyInstallments("2026-01-01", "2026-12-31", 12, 120000, "2025-12-31");
    expect(result.installments).toEqual([]);
    expect(result.error).not.toBeNull();
    expect(result.error).toContain("no puede ser anterior");
  });

  test("posterior al fin del período → error, sin cuotas", () => {
    const result = planMonthlyInstallments("2026-01-01", "2026-03-31", 3, 300000, "2026-04-01");
    expect(result.installments).toEqual([]);
    expect(result.error).not.toBeNull();
    expect(result.error).toContain("no puede ser posterior");
  });

  test("fechas inconsistentes (fin < inicio) también vuelven como error, no crashean", () => {
    const result = planMonthlyInstallments("2026-06-01", "2026-01-01", 3, 300000);
    expect(result.installments).toEqual([]);
    expect(result.error).not.toBeNull();
  });
});

describe("planMonthlyInstallments — días 29/30/31 y años bisiestos (smoke test de la plomería nueva)", () => {
  test("firstDueDate 31 de enero → 28 de febrero en año no bisiesto (marzo vuelve a tener 31 días)", () => {
    // addCalendarMonths calcula cada vencimiento desde firstDueDate + i meses
    // (no encadenado desde la cuota anterior) — el recorte a 28 en febrero
    // no "contamina" a marzo, que sí tiene 31 días. Mismo criterio ya
    // probado en installment-plan.test.ts para addCalendarMonths.
    const result = planMonthlyInstallments("2026-01-31", "2026-03-31", 3, 300000, "2026-01-31");
    expect(result.error).toBeNull();
    expect(result.installments.map(i => i.dueDate)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  test("firstDueDate 31 de enero → 29 de febrero en año bisiesto (2028)", () => {
    const result = planMonthlyInstallments("2028-01-31", "2028-03-31", 2, 200000, "2028-01-31");
    expect(result.error).toBeNull();
    expect(result.installments.map(i => i.dueDate)).toEqual(["2028-01-31", "2028-02-29"]);
  });

  test("firstDueDate 31 de marzo → 30 de abril (abril tiene 30 días)", () => {
    const result = planMonthlyInstallments("2026-03-31", "2026-05-31", 2, 200000, "2026-03-31");
    expect(result.error).toBeNull();
    expect(result.installments.map(i => i.dueDate)).toEqual(["2026-03-31", "2026-04-30"]);
  });
});

describe("planMonthlyInstallments — una sola cuota", () => {
  test("installmentCount=1 con firstDueDate explícito vence exactamente ahí", () => {
    const result = planMonthlyInstallments("2026-01-01", "2026-01-31", 1, 50000, "2026-01-20");
    expect(result.error).toBeNull();
    expect(result.installments.length).toBe(1);
    expect(result.installments[0]).toEqual({ number: 1, dueDate: "2026-01-20", amount: 50000, notes: "" });
  });
});

describe("planMonthlyInstallments — importe con centavos", () => {
  test("100.000 / 3 distribuye el resto en la última cuota, suma exacta", () => {
    const result = planMonthlyInstallments("2026-01-01", "2026-03-31", 3, 100000 / 3, "2026-01-01");
    expect(result.error).toBeNull();
    const amounts = result.installments.map(i => i.amount);
    expect(amounts[0]).toBe(33333.33);
    expect(amounts[1]).toBe(33333.33);
    expect(amounts[2]).toBe(33333.34);
    const totalCents = Math.round(amounts.reduce((s, a) => s + a, 0) * 100);
    expect(totalCents).toBe(10000000); // $100.000,00 en centavos, sin perder ni agregar nada
  });
});

describe("planMonthlyInstallments — se generan exactamente N cuotas", () => {
  test("installmentCount=5 da exactamente 5 filas numeradas 1..5", () => {
    const result = planMonthlyInstallments("2026-01-01", "2026-05-31", 5, 50000, "2026-01-10");
    expect(result.installments.length).toBe(5);
    expect(result.installments.map(i => i.number)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("nextFirstDueDateOnStartDateChange — sync con startDate", () => {
  test("mientras no fue editado manualmente (touched=false), sigue a startDate", () => {
    expect(nextFirstDueDateOnStartDateChange("2026-01-01", false, "2026-02-01")).toBe("2026-02-01");
  });

  test("una vez editado manualmente (touched=true), un cambio de startDate NO lo pisa", () => {
    expect(nextFirstDueDateOnStartDateChange("2026-01-15", true, "2026-02-01")).toBe("2026-01-15");
  });

  test("touched=false y startDate no cambia: devuelve el mismo valor (idempotente)", () => {
    expect(nextFirstDueDateOnStartDateChange("2026-01-01", false, "2026-01-01")).toBe("2026-01-01");
  });
});

// ─── Invariantes estáticas sobre PolicyModal.tsx ───────────────────────────
// Verificaciones de código fuente (sin renderizar el componente — el repo no
// tiene infraestructura de testing-library) para dos reglas que no son
// propiedades del adaptador puro, sino de cómo lo usa el componente.
describe("PolicyModal.tsx — invariantes del campo firstDueDate", () => {
  const SRC = readFileSync(
    resolve(import.meta.dir, "../../components/policies/PolicyModal.tsx"),
    "utf-8",
  );

  test("firstDueDate nunca se envía como parte del payload de POST/PUT /policies", () => {
    // form (el objeto que sí viaja en el payload vía `...form`) no declara
    // firstDueDate como clave — es un useState aparte. Si algún día alguien
    // lo agrega a `form`, este assert lo detecta.
    const formDeclMatch = SRC.match(/const \[form, setForm\] = useState\(\{([\s\S]*?)\n {2}\}\);/);
    expect(formDeclMatch).not.toBeNull();
    expect(formDeclMatch![1]).not.toMatch(/\bfirstDueDate\b/);
    // Tampoco se agrega sueltamente al payload (ej. `firstDueDate: ...,`
    // dentro del objeto `payload`).
    const payloadMatch = SRC.match(/const payload: any = \{([\s\S]*?)\n {6}\};/);
    expect(payloadMatch).not.toBeNull();
    expect(payloadMatch![1]).not.toMatch(/\bfirstDueDate\b/);
  });

  test("el input de \"Vencimiento de la primera cuota\" está condicionado a !isEdit", () => {
    // El texto aparece también en comentarios más arriba en el archivo —
    // se busca puntualmente la etiqueta JSX real del campo.
    const idx = SRC.indexOf(">Vencimiento de la primera cuota</label>");
    expect(idx).toBeGreaterThan(-1);
    // El gate JSX más cercano hacia atrás debe ser "{!isEdit && (" — la
    // condición que efectivamente envuelve este campo.
    const gateIdx = SRC.lastIndexOf("{!isEdit && (", idx);
    expect(gateIdx).toBeGreaterThan(-1);
    const between = SRC.slice(gateIdx, idx);
    // No debe haber otro cierre de bloque `)}`/`{isEdit`/otro campo conocido
    // entre el gate y el campo — o sea, siguen dentro del mismo condicional.
    expect(between).not.toContain("{isEdit &&");
    expect(between).not.toContain("Cantidad de cuotas esperada");
  });

  test("la edición (isEdit) nunca llama a /installments/generate", () => {
    // El único call-site de /installments/generate debe estar en la rama
    // `else` (alta), nunca en la rama `if (isEdit)` del submit.
    const editBranch = SRC.match(/if \(isEdit\) \{([\s\S]*?)\n {6}\} else \{/);
    expect(editBranch).not.toBeNull();
    expect(editBranch![1]).not.toContain("installments/generate");
  });
});

describe("computeCashPaymentPreview", () => {
  test("sin cuotas, nominal 0 y sin previsualización de contado", () => {
    const preview = computeCashPaymentPreview([], "");
    expect(preview).toEqual({ nominalAmountCents: 0, cashAmountCents: null, discountAmountCents: null });
  });

  test("con cuotas pero sin importe contado cargado: solo el nominal", () => {
    const preview = computeCashPaymentPreview([{ amount: 100000 }, { amount: 100000 }], "");
    expect(preview.nominalAmountCents).toBe(20000000);
    expect(preview.cashAmountCents).toBeNull();
  });

  test("contado menor al nominal: descuento positivo", () => {
    const preview = computeCashPaymentPreview(
      [{ amount: 100000 }, { amount: 100000 }, { amount: 100000 }, { amount: 100000 }],
      "380000",
    );
    expect(preview.nominalAmountCents).toBe(40000000);
    expect(preview.cashAmountCents).toBe(38000000);
    expect(preview.discountAmountCents).toBe(2000000);
  });

  test("contado igual al nominal: descuento $0", () => {
    const preview = computeCashPaymentPreview([{ amount: 100000 }, { amount: 100000 }], "200000");
    expect(preview.discountAmountCents).toBe(0);
  });

  test("contado mayor al nominal: descuento negativo (la UI lo muestra como error, no lo oculta)", () => {
    const preview = computeCashPaymentPreview([{ amount: 100000 }], "150000");
    expect(preview.discountAmountCents).toBe(-5000000);
  });

  test("contado inválido (no numérico) se trata como vacío", () => {
    const preview = computeCashPaymentPreview([{ amount: 100000 }], "abc");
    expect(preview.cashAmountCents).toBeNull();
  });

  test("contado cero o negativo se trata como vacío", () => {
    expect(computeCashPaymentPreview([{ amount: 100000 }], "0").cashAmountCents).toBeNull();
    expect(computeCashPaymentPreview([{ amount: 100000 }], "-50").cashAmountCents).toBeNull();
  });
});
