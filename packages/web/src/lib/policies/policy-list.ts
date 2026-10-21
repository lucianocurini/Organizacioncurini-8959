// Filtros del listado GET /policies (puro, sin DB ni I/O). El estado
// efectivo (effective-status.ts) se calcula ANTES de filtrar: el filtro de
// estado, el conteo y la paginación del listado trabajan siempre sobre el
// mismo conjunto ya resuelto. policy.status queda intacto (dato guardado);
// el efectivo viaja aparte, en `effectiveStatus`.

import { effectivePolicyStatus } from "./effective-status";

export interface PolicyListSourceRow {
  policy: { policyNumber: string; type: string | null; status: string | null; endDate: string | null; companyId: number | null };
  company?: { name: string | null } | null;
  insured?: { name: string | null } | null;
}

export interface PolicyListFilters {
  q?: string | null;
  type?: string | null;
  status?: string | null;
  companyId?: string | number | null;
}

export function applyPolicyListFilters<T extends PolicyListSourceRow>(
  rows: T[],
  filters: PolicyListFilters,
  today: string,
): (T & { effectiveStatus: string | null })[] {
  let out = rows.map((r) => ({ ...r, effectiveStatus: effectivePolicyStatus(r.policy.status, r.policy.endDate, today) }));
  if (filters.q) {
    const lower = String(filters.q).toLowerCase();
    out = out.filter((r) =>
      (r.insured?.name ?? "").toLowerCase().includes(lower) ||
      (r.company?.name ?? "").toLowerCase().includes(lower) ||
      r.policy.policyNumber.toLowerCase().includes(lower));
  }
  if (filters.type) out = out.filter((r) => r.policy.type === filters.type);
  if (filters.status) out = out.filter((r) => r.effectiveStatus === filters.status);
  if (filters.companyId) out = out.filter((r) => r.policy.companyId === Number(filters.companyId));
  return out;
}
