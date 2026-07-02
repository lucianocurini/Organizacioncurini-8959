// Preview (solo lectura) de backfill: clasifica cuotas históricas sin rebilling_id
// en safe / ambiguous / no_candidate. No escribe nada en la base — ver Etapa
// "limpieza segura de duplicados históricos de El Norte".
//
// Regla dura: nunca asignar por simple dueDate BETWEEN billingStart AND billingEnd
// si hay más de un candidato (rebillings superpuestos, duplicados, etc.).

export interface BackfillInstallment {
  id: number;
  policyId: number;
  dueDate: string;
  amount: number;
  status: string;
  rendered: number;
}

export interface BackfillRebilling {
  id: number;
  policyId: number;
  billingStart: string;
  billingEnd: string;
  premium: number | null;
}

export type BackfillCategory = "safe" | "ambiguous" | "no_candidate";

export interface BackfillClassification {
  installmentId: number;
  policyId: number;
  category: BackfillCategory;
  reason: string;
  candidateRebillingId: number | null;
}

function normalizePremiumCents(premium: number | null | undefined): number {
  return Math.round((premium ?? 0) * 100);
}

function rebillingGroupKey(r: BackfillRebilling): string {
  return [r.policyId, r.billingStart, r.billingEnd, normalizePremiumCents(r.premium)].join("|");
}

/**
 * Clasifica cuotas (ya filtradas a rebillingId === null) contra las refacturaciones
 * de sus pólizas. Pura función en memoria — no toca la base.
 */
export function classifyInstallmentsForBackfill(
  installments: BackfillInstallment[],
  rebillings: BackfillRebilling[],
): BackfillClassification[] {
  const rebillingsByPolicy = new Map<number, BackfillRebilling[]>();
  for (const r of rebillings) {
    const arr = rebillingsByPolicy.get(r.policyId) ?? [];
    arr.push(r);
    rebillingsByPolicy.set(r.policyId, arr);
  }

  // Grupos de duplicados: mismo policyId + billingStart + billingEnd + premium(cents)
  const dupGroupCounts = new Map<string, number>();
  for (const r of rebillings) {
    const key = rebillingGroupKey(r);
    dupGroupCounts.set(key, (dupGroupCounts.get(key) ?? 0) + 1);
  }

  const results: BackfillClassification[] = [];

  // Detectar "misma fecha e importe repetidos" dentro de las cuotas de una misma póliza
  const instDupCounts = new Map<string, number>();
  for (const inst of installments) {
    const key = `${inst.policyId}|${inst.dueDate}|${inst.amount}`;
    instDupCounts.set(key, (instDupCounts.get(key) ?? 0) + 1);
  }

  for (const inst of installments) {
    const policyRebillings = rebillingsByPolicy.get(inst.policyId) ?? [];

    if (policyRebillings.length === 0) {
      results.push({
        installmentId: inst.id, policyId: inst.policyId, category: "no_candidate",
        reason: "Póliza sin refacturaciones — cuota base.", candidateRebillingId: null,
      });
      continue;
    }

    const instDupKey = `${inst.policyId}|${inst.dueDate}|${inst.amount}`;
    if ((instDupCounts.get(instDupKey) ?? 0) > 1) {
      results.push({
        installmentId: inst.id, policyId: inst.policyId, category: "ambiguous",
        reason: "Misma fecha e importe repetidos entre varias cuotas de la póliza.", candidateRebillingId: null,
      });
      continue;
    }

    const candidates = policyRebillings.filter(
      (r) => inst.dueDate >= r.billingStart && inst.dueDate <= r.billingEnd,
    );

    if (candidates.length === 0) {
      results.push({
        installmentId: inst.id, policyId: inst.policyId, category: "no_candidate",
        reason: "Fecha de vencimiento fuera de cualquier período de refacturación.", candidateRebillingId: null,
      });
      continue;
    }

    if (candidates.length > 1) {
      results.push({
        installmentId: inst.id, policyId: inst.policyId, category: "ambiguous",
        reason: "Más de un rebilling candidato (períodos superpuestos o refacturaciones duplicadas).",
        candidateRebillingId: null,
      });
      continue;
    }

    const candidate = candidates[0]!;
    const isDuplicateRebilling = (dupGroupCounts.get(rebillingGroupKey(candidate)) ?? 0) > 1;
    if (isDuplicateRebilling) {
      results.push({
        installmentId: inst.id, policyId: inst.policyId, category: "ambiguous",
        reason: "El único candidato es una refacturación duplicada (mismo período y premio repetido).",
        candidateRebillingId: null,
      });
      continue;
    }

    results.push({
      installmentId: inst.id, policyId: inst.policyId, category: "safe",
      reason: "Un único rebilling candidato, sin solapamientos ni duplicados.",
      candidateRebillingId: candidate.id,
    });
  }

  return results;
}

export interface BackfillPreviewSummary {
  total: number;
  safe: number;
  ambiguous: number;
  noCandidate: number;
}

export function summarizeBackfillPreview(rows: BackfillClassification[]): BackfillPreviewSummary {
  return {
    total: rows.length,
    safe: rows.filter((r) => r.category === "safe").length,
    ambiguous: rows.filter((r) => r.category === "ambiguous").length,
    noCandidate: rows.filter((r) => r.category === "no_candidate").length,
  };
}
