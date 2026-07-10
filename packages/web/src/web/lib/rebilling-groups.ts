// Agrupación pura (sin React, sin fetch) de policy_installments por
// rebillingId, para la vista de "Cuotas" de poliza-detail.tsx. Cada
// refacturación genera su propio grupo de cuotas numeradas 1..N — acá solo
// se agrupan y ordenan, la numeración ya viene así desde el backend
// (buildRebillingInstallmentPlan reinicia number en 1 por grupo, ver
// src/lib/installments/rebilling-plan.ts).
//
// Orden: emisión original primero (rebillingId IS NULL), luego
// refacturaciones por billingStart ascendente — nunca se oculta ni se
// reemplaza un grupo anterior.

export interface GroupableInstallment {
  id: number;
  number: number;
  dueDate: string;
  amount: number;
  status: string;
  notes: string | null;
  rebillingId: number | null;
}

export interface GroupableRebilling {
  id: number;
  billingStart: string;
  billingEnd: string;
  deductible: number | null;
}

export interface InstallmentGroup {
  key: string; // "original" | String(rebillingId)
  label: string;
  rebillingId: number | null;
  billingStart: string | null;
  billingEnd: string | null;
  deductible: number | null;
  installments: GroupableInstallment[];
}

export function groupInstallmentsByRebilling(
  installments: ReadonlyArray<GroupableInstallment>,
  rebillings: ReadonlyArray<GroupableRebilling>,
): InstallmentGroup[] {
  const rebillingById = new Map(rebillings.map((r) => [r.id, r]));

  const originalInstallments = installments.filter((i) => i.rebillingId === null);
  const groups: InstallmentGroup[] = [];

  if (originalInstallments.length > 0) {
    groups.push({
      key: "original",
      label: "Emisión original",
      rebillingId: null,
      billingStart: null,
      billingEnd: null,
      deductible: null,
      installments: originalInstallments,
    });
  }

  const rebillingsSorted = [...rebillings].sort((a, b) => (a.billingStart < b.billingStart ? -1 : a.billingStart > b.billingStart ? 1 : a.id - b.id));

  let n = 1;
  for (const r of rebillingsSorted) {
    const groupInstallments = installments.filter((i) => i.rebillingId === r.id);
    // Una refacturación histórica sin cuotas generadas todavía (el bug que
    // este flujo corrige) igual aparece — con installments: [] — para que se
    // pueda ver y completar desde la UI, no queda oculta.
    groups.push({
      key: String(r.id),
      label: `Refacturación ${n} — ${r.billingStart} a ${r.billingEnd}`,
      rebillingId: r.id,
      billingStart: r.billingStart,
      billingEnd: r.billingEnd,
      deductible: r.deductible,
      installments: groupInstallments,
    });
    n++;
  }

  return groups;
}

export interface InstallmentTotals {
  total: number;
  pagadas: number;
  pendientes: number;
  vencidas: number;
}

/** Totales sobre TODAS las cuotas (todos los grupos combinados) — el resumen superior de la página. */
export function summarizeInstallments(installments: ReadonlyArray<{ status: string }>): InstallmentTotals {
  return {
    total: installments.length,
    pagadas: installments.filter((i) => i.status === "pagada").length,
    pendientes: installments.filter((i) => i.status === "pendiente").length,
    vencidas: installments.filter((i) => i.status === "vencida").length,
  };
}
