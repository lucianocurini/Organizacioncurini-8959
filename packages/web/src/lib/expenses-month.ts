// Mes calendario del listado de Gastos de Cobranzas (GET /api/cash/expenses
// ?month=YYYY-MM). Funciones puras compartidas por backend y frontend — sin
// Date ni husos horarios: `cash_expenses.date` ya es un día calendario
// "YYYY-MM-DD" de Argentina, así que el mes se resuelve con aritmética entera
// y comparación de texto, nunca con `new Date(str)` (medianoche UTC → un día
// corrido en Argentina).
//
// Este filtro es SOLO del listado de Cobranzas → Gastos. Caja sigue leyendo
// el histórico completo (GET /api/cash/expenses sin parámetro) y calcula sus
// propios totales en GET /api/cash/summary: nada de acá participa de esos
// cálculos.

/** Valor explícito de "Todos los meses" (histórico). */
export const EXPENSES_ALL_MONTHS = "all";

export type ExpensesMonthKey = string; // "YYYY-MM"
export type ExpensesMonthSelection = ExpensesMonthKey | typeof EXPENSES_ALL_MONTHS;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
] as const;

/** "YYYY-MM" estricto (mes 01–12). */
export function isValidExpensesMonth(value: unknown): value is ExpensesMonthKey {
  return typeof value === "string" && MONTH_RE.test(value);
}

/** Suma `delta` meses a "YYYY-MM" (diciembre + 1 → enero del año siguiente, enero − 1 → diciembre del anterior). */
export function shiftExpensesMonth(month: ExpensesMonthKey, delta: number): ExpensesMonthKey {
  if (!isValidExpensesMonth(month)) throw new Error(`shiftExpensesMonth: mes inválido "${month}"`);
  const [y, m] = month.split("-").map(Number);
  const zeroIndexed = (m! - 1) + delta;
  const year = y! + Math.floor(zeroIndexed / 12);
  const month0 = ((zeroIndexed % 12) + 12) % 12;
  return `${year}-${String(month0 + 1).padStart(2, "0")}`;
}

/** Intervalo semiabierto [primer día del mes, primer día del mes siguiente). */
export function expensesMonthRange(month: ExpensesMonthKey): { from: string; toExclusive: string } {
  if (!isValidExpensesMonth(month)) throw new Error(`expensesMonthRange: mes inválido "${month}"`);
  return { from: `${month}-01`, toExclusive: `${shiftExpensesMonth(month, 1)}-01` };
}

/** ¿El día "YYYY-MM-DD" cae en el mes? Misma regla que el filtro del backend. */
export function isDateInExpensesMonth(date: string | null | undefined, month: ExpensesMonthKey): boolean {
  if (!date) return false;
  const { from, toExclusive } = expensesMonthRange(month);
  return date >= from && date < toExclusive;
}

/** Mes "YYYY-MM" de un día "YYYY-MM-DD" (null si no tiene ese formato). */
export function expensesMonthOfDate(date: string | null | undefined): ExpensesMonthKey | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const month = date.slice(0, 7);
  return isValidExpensesMonth(month) ? month : null;
}

/** "Octubre 2026"; "Todos los meses" para el histórico. */
export function formatExpensesMonthLabel(selection: ExpensesMonthSelection): string {
  if (selection === EXPENSES_ALL_MONTHS) return "Todos los meses";
  if (!isValidExpensesMonth(selection)) return selection;
  const [y, m] = selection.split("-").map(Number);
  return `${MONTH_NAMES[m! - 1]} ${y}`;
}

/**
 * Parámetro `month` de GET /api/cash/expenses:
 * - ausente o "all" → histórico (range null; lo que consume Caja);
 * - "YYYY-MM" válido → ese mes;
 * - cualquier otro valor → error (400), nunca se ignora en silencio.
 */
export function parseExpensesMonthQuery(
  value: string | null | undefined,
): { ok: true; month: ExpensesMonthKey | null } | { ok: false } {
  if (value === undefined || value === null || value === EXPENSES_ALL_MONTHS) return { ok: true, month: null };
  if (isValidExpensesMonth(value)) return { ok: true, month: value };
  return { ok: false };
}
