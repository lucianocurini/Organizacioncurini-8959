// Serialización del estado del listado de Pólizas (filtros, orden, página) en
// query string. Funciones puras — sin dependencia de React ni del router, para
// poder testearlas con bun:test sin DOM.
import { POLICY_TYPES, STATUS_TYPES } from "./utils";

export const POLIZAS_SORT_KEYS = [
  "policyNumber", "insured", "company", "type", "status", "endDate", "startDate", "premium",
] as const;
export type PoliziasSortKey = typeof POLIZAS_SORT_KEYS[number];

export const POLIZAS_SORT_ORDERS = ["asc", "desc"] as const;
export type PoliziasSortOrder = typeof POLIZAS_SORT_ORDERS[number];

// Fecha de inicio (startDate) descendente: las pólizas más recientes aparecen
// primero. "endDate" se conserva como sortKey válido únicamente por
// compatibilidad con URLs/bookmarks existentes que ya lo usaban como default
// anterior — el encabezado "Vigencia" de la tabla ahora ordena por startDate.
export const DEFAULT_SORT_KEY: PoliziasSortKey = "startDate";
export const DEFAULT_SORT_ORDER: PoliziasSortOrder = "desc";
export const DEFAULT_PAGE = 1;

const PAGE_RE = /^[1-9]\d*$/;

export interface PoliziasFilters {
  q: string;
  type: string;
  status: string;
  sortBy: PoliziasSortKey;
  sortOrder: PoliziasSortOrder;
  page: number;
}

export function isValidSortKey(value: string): value is PoliziasSortKey {
  return (POLIZAS_SORT_KEYS as readonly string[]).includes(value);
}

export function isValidSortOrder(value: string): value is PoliziasSortOrder {
  return (POLIZAS_SORT_ORDERS as readonly string[]).includes(value);
}

// Parsea y valida el query string. Cualquier valor ausente o inválido
// (sortBy/sortOrder desconocidos, página no numérica, etc.) cae al default
// seguro correspondiente — nunca se propaga tal cual.
export function parsePoliziasFilters(search: string): PoliziasFilters {
  const params = new URLSearchParams(search);

  const q = params.get("q");
  const type = params.get("type");
  const status = params.get("status");
  const sortBy = params.get("sortBy");
  const sortOrder = params.get("sortOrder");
  const page = params.get("page");

  return {
    q: q ? q.trim() : "",
    type: type && type in POLICY_TYPES ? type : "",
    status: status && status in STATUS_TYPES ? status : "",
    sortBy: sortBy && isValidSortKey(sortBy) ? sortBy : DEFAULT_SORT_KEY,
    sortOrder: sortOrder && isValidSortOrder(sortOrder) ? sortOrder : DEFAULT_SORT_ORDER,
    page: page && PAGE_RE.test(page) ? Number(page) : DEFAULT_PAGE,
  };
}

// sortBy/sortOrder/page siempre se incluyen (son el estado completo del orden
// y la posición); los filtros vacíos (q/type/status) no se agregan.
export function buildPoliziasQuery(filters: PoliziasFilters): string {
  const params = new URLSearchParams();
  const q = filters.q.trim();
  if (q) params.set("q", q);
  if (filters.type) params.set("type", filters.type);
  if (filters.status) params.set("status", filters.status);
  params.set("sortBy", filters.sortBy);
  params.set("sortOrder", filters.sortOrder);
  params.set("page", String(filters.page));
  return params.toString();
}

export function buildPoliziasPath(filters: PoliziasFilters): string {
  return `/polizas?${buildPoliziasQuery(filters)}`;
}
