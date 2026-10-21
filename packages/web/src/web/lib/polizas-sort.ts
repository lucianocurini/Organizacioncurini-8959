// Comparador puro del listado de Pólizas — sin dependencia de React, testeable
// con bun:test. Ordena el conjunto completo recibido (no una página ya
// recortada); la paginación se aplica después, sobre el resultado de esta función.
import type { PoliziasSortKey, PoliziasSortOrder } from "./polizas-filters";

export interface PolicySortRow {
  policy: {
    id: number;
    policyNumber: string;
    type: string;
    status: string;
    startDate: string | null | undefined;
    endDate: string | null | undefined;
    premium: number | null | undefined;
  };
  company?: { name: string } | null;
  insured?: { name: string } | null;
  // Estado efectivo que calcula GET /policies (por fecha final); el orden por
  // estado usa este, no el guardado.
  effectiveStatus?: string | null;
}

/** Estado a mostrar/ordenar/exportar: el efectivo si llegó, si no el guardado. */
export function displayPolicyStatus(row: { policy: { status: string }; effectiveStatus?: string | null }): string {
  return row.effectiveStatus ?? row.policy.status;
}

export const POLIZAS_PAGE_SIZE = 50;

/**
 * Página del listado sobre el conjunto COMPLETO ya filtrado (por estado
 * efectivo, server-side) y ordenado: total y cantidad de páginas salen del
 * mismo conjunto que se recorta.
 */
export function paginatePolicyRows<T>(rows: T[], page: number, pageSize = POLIZAS_PAGE_SIZE): { pageRows: T[]; total: number; totalPages: number } {
  return {
    pageRows: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
  };
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Valida formato YYYY-MM-DD y que sea una fecha de calendario real (rechaza
// "2023-02-30"), usando solo aritmética entera — sin construir un Date, para
// no depender de conversiones de zona horaria.
export function isValidDateStr(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= maxDay;
}

// Fechas inválidas/vacías siempre quedan al final, sea cual sea sortDir —
// solo entre dos fechas válidas se invierte el sentido de la comparación.
function compareStartDate(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: PoliziasSortOrder
): number {
  const va = isValidDateStr(a) ? a : null;
  const vb = isValidDateStr(b) ? b : null;
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  if (va < vb) return dir === "asc" ? -1 : 1;
  if (va > vb) return dir === "asc" ? 1 : -1;
  return 0;
}

export function sortPolicyRows<T extends PolicySortRow>(
  rows: T[],
  sortKey: PoliziasSortKey,
  sortDir: PoliziasSortOrder
): T[] {
  return [...rows].sort((a, b) => {
    if (sortKey === "startDate") {
      const cmp = compareStartDate(a.policy.startDate, b.policy.startDate, sortDir);
      if (cmp !== 0) return cmp;
      return b.policy.id - a.policy.id;
    }

    let va: any, vb: any;
    switch (sortKey) {
      case "policyNumber": va = a.policy.policyNumber; vb = b.policy.policyNumber; break;
      case "insured": va = a.insured?.name || ""; vb = b.insured?.name || ""; break;
      case "company": va = a.company?.name || ""; vb = b.company?.name || ""; break;
      case "type": va = a.policy.type; vb = b.policy.type; break;
      case "status": va = displayPolicyStatus(a); vb = displayPolicyStatus(b); break;
      case "endDate": va = a.policy.endDate; vb = b.policy.endDate; break;
      case "premium": va = a.policy.premium || 0; vb = b.policy.premium || 0; break;
      default: va = ""; vb = "";
    }
    if (va < vb) return sortDir === "asc" ? -1 : 1;
    if (va > vb) return sortDir === "asc" ? 1 : -1;
    // Desempate estable: id descendente.
    return b.policy.id - a.policy.id;
  });
}
