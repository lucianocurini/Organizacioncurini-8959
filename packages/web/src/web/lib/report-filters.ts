// Serialización del estado de filtros de Reporte mensual en query string.
// Funciones puras — sin dependencia de React ni del router, para poder testearlas
// con bun:test sin DOM.
import { POLICY_TYPES } from "./utils";

export const REPORT_MOVEMENT_TYPES = [
  "rebilling",
  "renovation_confirmed",
  "renovation_imported",
  "new_policy",
] as const;

export const REPORT_REBILLING_TYPES = [
  "prorroga",
  "endoso",
  "extension_vigencia",
  "renovacion",
  "rehabilitacion",
  "otro",
] as const;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const COMPANY_ID_RE = /^\d+$/;

export interface ReportFilters {
  month: string;
  companyId: string;
  type: string;
  movementType: string;
  rebillingType: string;
  q: string;
}

export function isValidReportMonth(value: string): boolean {
  return MONTH_RE.test(value);
}

// Parsea y valida el query string. Cualquier valor ausente o inválido se
// ignora de forma segura (vuelve al default), nunca se propaga tal cual.
export function parseReportFilters(search: string, fallbackMonth: string): ReportFilters {
  const params = new URLSearchParams(search);

  const month = params.get("month");
  const companyId = params.get("companyId");
  const type = params.get("type");
  const movementType = params.get("movementType");
  const rebillingType = params.get("rebillingType");
  const q = params.get("q");

  return {
    month: month && isValidReportMonth(month) ? month : fallbackMonth,
    companyId: companyId && COMPANY_ID_RE.test(companyId) ? companyId : "",
    type: type && type in POLICY_TYPES ? type : "",
    movementType: movementType && (REPORT_MOVEMENT_TYPES as readonly string[]).includes(movementType)
      ? movementType : "",
    rebillingType: rebillingType && (REPORT_REBILLING_TYPES as readonly string[]).includes(rebillingType)
      ? rebillingType : "",
    q: q ? q.trim() : "",
  };
}

// El mes es siempre el parámetro principal (se incluye aunque sea el default).
// Los filtros vacíos no se agregan a la query string.
export function buildReportQuery(filters: ReportFilters): string {
  const params = new URLSearchParams();
  params.set("month", filters.month);
  if (filters.companyId) params.set("companyId", filters.companyId);
  if (filters.type) params.set("type", filters.type);
  if (filters.movementType) params.set("movementType", filters.movementType);
  if (filters.rebillingType) params.set("rebillingType", filters.rebillingType);
  const q = filters.q.trim();
  if (q) params.set("q", q);
  return params.toString();
}

export function buildReportPath(filters: ReportFilters): string {
  return `/reporte-mes?${buildReportQuery(filters)}`;
}
