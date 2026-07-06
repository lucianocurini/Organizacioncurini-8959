// Tests de los helpers puros de la sección "Medios de pago" de PaymentModal
// (Etapa 3B-2). Sin JSX, sin React — ver payment-splits-form.ts.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/payment-splits-form.test.ts
import { describe, test, expect } from "bun:test";
import {
  createSplitRow, splitsFromPayment, addSplitRow, removeSplitRow, updateSplitRow,
  computeSplitTotals, validateSplitsForm, splitsToPayload, groupSplitsByMethod,
  MIXED_GROUP_ERROR,
} from "../payment-splits-form";

// ─── 1. Inicialización con un split ──────────────────────────────────────────

describe("Caso 1 — fila inicial", () => {
  test("createSplitRow arma una fila con método por defecto 'efectivo' y amount vacío", () => {
    const row = createSplitRow();
    expect(row.method).toBe("efectivo");
    expect(row.amount).toBe("");
    expect(typeof row.uid).toBe("string");
    expect(row.uid.length).toBeGreaterThan(0);
  });

  test("dos filas nuevas tienen uid distinto", () => {
    const a = createSplitRow();
    const b = createSplitRow();
    expect(a.uid).not.toBe(b.uid);
  });
});

// ─── 2/3/4. Precarga ──────────────────────────────────────────────────────────

describe("Caso 2 — precarga de un pago histórico de un solo split", () => {
  test("sin splits[] (payload legacy): arma 1 fila desde paymentMethod/amount", () => {
    const rows = splitsFromPayment({ paymentMethod: "transferencia", amount: 1500, splits: null });
    expect(rows.length).toBe(1);
    expect(rows[0]!.method).toBe("transferencia");
    expect(rows[0]!.amount).toBe("1500");
  });

  test("con splits[] de un solo elemento: usa ese split, no el paymentMethod del padre", () => {
    const rows = splitsFromPayment({
      paymentMethod: "transferencia", amount: 1500,
      splits: [{ method: "transferencia", amountCents: 150000 }],
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.method).toBe("transferencia");
    expect(rows[0]!.amount).toBe("1500");
  });
});

describe("Caso 3 — precarga de un combinado desde payment.splits", () => {
  test("payment.splits con 2 elementos precarga exactamente esas 2 filas (no colapsa a 1)", () => {
    const rows = splitsFromPayment({
      paymentMethod: "combinado", amount: 1000,
      splits: [
        { method: "efectivo", amountCents: 60000 },
        { method: "transferencia", amountCents: 40000 },
      ],
    });
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.method)).toEqual(["efectivo", "transferencia"]);
    expect(rows.map(r => r.amount)).toEqual(["600", "400"]);
  });
});

describe("Caso 4 — 'combinado' nunca es el método de una fila", () => {
  test("ninguna fila precargada desde un combinado tiene method='combinado'", () => {
    const rows = splitsFromPayment({
      paymentMethod: "combinado", amount: 1000,
      splits: [{ method: "efectivo", amountCents: 60000 }, { method: "cheque", amountCents: 40000 }],
    });
    expect(rows.every(r => r.method !== "combinado")).toBe(true);
  });

  test("fallback legacy con paymentMethod='combinado' y sin splits cae a 'efectivo', no a 'combinado'", () => {
    const rows = splitsFromPayment({ paymentMethod: "combinado", amount: 1000, splits: [] });
    expect(rows.length).toBe(1);
    expect(rows[0]!.method).toBe("efectivo");
  });
});

// ─── 5/6/7. Agregar / eliminar filas ──────────────────────────────────────────

describe("Caso 5 — agregar fila", () => {
  test("addSplitRow agrega una fila nueva conservando las anteriores", () => {
    const initial = [createSplitRow("efectivo", "500")];
    const result = addSplitRow(initial, "transferencia");
    expect(result.length).toBe(2);
    expect(result[0]).toBe(initial[0]); // no muta la fila existente
    expect(result[1]!.method).toBe("transferencia");
  });
});

describe("Caso 6 — eliminar fila", () => {
  test("removeSplitRow elimina la fila indicada por uid", () => {
    const a = createSplitRow("efectivo", "500");
    const b = createSplitRow("transferencia", "500");
    const result = removeSplitRow([a, b], b.uid);
    expect(result.length).toBe(1);
    expect(result[0]!.uid).toBe(a.uid);
  });
});

describe("Caso 7 — no elimina la última fila", () => {
  test("removeSplitRow con una sola fila devuelve el array sin cambios", () => {
    const a = createSplitRow("efectivo", "500");
    const result = removeSplitRow([a], a.uid);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(a);
  });
});

describe("updateSplitRow", () => {
  test("actualiza método e importe de la fila indicada, sin tocar las demás", () => {
    const a = createSplitRow("efectivo", "500");
    const b = createSplitRow("transferencia", "300");
    const result = updateSplitRow([a, b], a.uid, { amount: "700" });
    expect(result[0]!.amount).toBe("700");
    expect(result[0]!.method).toBe("efectivo");
    expect(result[1]).toBe(b);
  });
});

// ─── 8. Métodos repetidos ─────────────────────────────────────────────────────

describe("Caso 8 — métodos repetidos permitidos", () => {
  test("dos filas 'transferencia' pasan la validación de grupo (no son mixed)", () => {
    const splits = [createSplitRow("transferencia", "400"), createSplitRow("transferencia", "600")];
    const result = validateSplitsForm("1000", splits);
    expect(result.valid).toBe(true);
    expect(result.group).toBe("own");
  });
});

// ─── 9/10/11/12. Suma exacta / menor / mayor / centavos ──────────────────────

describe("Caso 9 — suma exacta habilita guardar", () => {
  test("600 + 400 = 1000 → válido", () => {
    const splits = [createSplitRow("efectivo", "600"), createSplitRow("transferencia", "400")];
    const result = validateSplitsForm("1000", splits);
    expect(result.valid).toBe(true);
    expect(result.errorMessage).toBeNull();
  });
});

describe("Caso 10 — suma menor bloquea", () => {
  test("600 + 300 < 1000 → inválido, mensaje 'Faltan distribuir'", () => {
    const splits = [createSplitRow("efectivo", "600"), createSplitRow("transferencia", "300")];
    const result = validateSplitsForm("1000", splits);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("Faltan distribuir");
  });
});

describe("Caso 11 — suma mayor bloquea", () => {
  test("700 + 400 > 1000 → inválido, mensaje 'Se excede'", () => {
    const splits = [createSplitRow("efectivo", "700"), createSplitRow("transferencia", "400")];
    const result = validateSplitsForm("1000", splits);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("Se excede");
  });
});

describe("Caso 12 — centavos exactos", () => {
  test("33.33 + 33.33 + 33.34 = 100.00 → válido", () => {
    const splits = [
      createSplitRow("efectivo", "33.33"), createSplitRow("transferencia", "33.33"), createSplitRow("cheque", "33.34"),
    ];
    const totals = computeSplitTotals("100", splits);
    expect(totals.totalCents).toBe(10000);
    expect(totals.distributedCents).toBe(10000);
    expect(totals.diferenciaCents).toBe(0);
    expect(validateSplitsForm("100", splits).valid).toBe(true);
  });

  test("un importe con 3 decimales reales invalida la fila (no se redondea silenciosamente)", () => {
    const splits = [createSplitRow("efectivo", "33.335")];
    const result = validateSplitsForm("33.335", splits);
    expect(result.valid).toBe(false);
  });
});

// ─── 13. Mixed bloquea ────────────────────────────────────────────────────────

describe("Caso 13 — mixed bloquea", () => {
  test("efectivo + transferencia_compania → inválido, mensaje de mixed exacto", () => {
    const splits = [createSplitRow("efectivo", "500"), createSplitRow("transferencia_compania", "500")];
    const result = validateSplitsForm("1000", splits);
    expect(result.valid).toBe(false);
    expect(result.group).toBe("mixed");
    expect(result.errorMessage).toBe(MIXED_GROUP_ERROR);
  });
});

// ─── 14/15. Grupo own/direct_company (para Pronto Pago) ──────────────────────

describe("Caso 14 — todos propios habilita el grupo 'own'", () => {
  test("efectivo + transferencia + cheque → group 'own'", () => {
    const splits = [createSplitRow("efectivo", "400"), createSplitRow("transferencia", "350"), createSplitRow("cheque", "250")];
    const result = validateSplitsForm("1000", splits);
    expect(result.group).toBe("own");
  });
});

describe("Caso 15 — direct_company no es 'own'", () => {
  test("transferencia_compania + link_pago → group 'direct_company' (no 'own')", () => {
    const splits = [createSplitRow("transferencia_compania", "600"), createSplitRow("link_pago", "400")];
    const result = validateSplitsForm("1000", splits);
    expect(result.group).toBe("direct_company");
    expect(result.group === "own").toBe(false);
  });
});

// ─── 16/17/18. Payload ───────────────────────────────────────────────────────

describe("Caso 16/17 — payload para POST/PUT", () => {
  test("splitsToPayload convierte a { method, amount } numérico, mismo orden", () => {
    const splits = [createSplitRow("efectivo", "600"), createSplitRow("transferencia", "400")];
    const payload = splitsToPayload(splits);
    expect(payload).toEqual([{ method: "efectivo", amount: 600 }, { method: "transferencia", amount: 400 }]);
  });
});

describe("Caso 18 — no envía ids locales", () => {
  test("el payload nunca incluye la clave 'uid'", () => {
    const splits = [createSplitRow("efectivo", "600")];
    const payload = splitsToPayload(splits);
    expect(Object.keys(payload[0]!)).toEqual(["method", "amount"]);
  });
});

// ─── 20. Resumen agrupado para la tabla ──────────────────────────────────────

describe("Caso 20 — combinado agrupa métodos repetidos sin alterar el desglose original", () => {
  test("dos splits del mismo método se suman en el resumen, preservando orden de primera aparición", () => {
    const splits = [
      { method: "transferencia", amountCents: 40000 },
      { method: "efectivo", amountCents: 10000 },
      { method: "transferencia", amountCents: 20000 },
    ];
    const grouped = groupSplitsByMethod(splits);
    expect(grouped).toEqual([
      { method: "transferencia", amountCents: 60000 },
      { method: "efectivo", amountCents: 10000 },
    ]);
    // el array original no se modifica
    expect(splits.length).toBe(3);
  });

  test("splits sin repetidos se listan tal cual, uno por método", () => {
    const splits = [
      { method: "efectivo", amountCents: 40000 },
      { method: "transferencia", amountCents: 35000 },
      { method: "cheque", amountCents: 25000 },
    ];
    expect(groupSplitsByMethod(splits)).toEqual(splits);
  });
});
