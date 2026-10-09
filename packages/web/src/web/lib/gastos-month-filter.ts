// Estado del filtro mensual de Cobranzas → Gastos en la URL
// (/cobranzas?tab=gastos&gastosMes=YYYY-MM | all) y textos derivados.
// Funciones puras — sin React ni router, testeables con bun:test sin DOM.
// El parámetro tiene nombre propio (`gastosMes`, no `month`) para no
// mezclarse con el estado de las otras pestañas de Cobranzas.
import {
  EXPENSES_ALL_MONTHS,
  expensesMonthOfDate,
  formatExpensesMonthLabel,
  isDateInExpensesMonth,
  isValidExpensesMonth,
  type ExpensesMonthKey,
  type ExpensesMonthSelection,
} from "../../lib/expenses-month";

export const GASTOS_TAB_VALUE = "gastos";
export const GASTOS_MONTH_PARAM = "gastosMes";

export function isGastosTabInSearch(search: string): boolean {
  return new URLSearchParams(search).get("tab") === GASTOS_TAB_VALUE;
}

/**
 * Mes seleccionado según la URL. Ausente o inválido → mes actual de
 * Argentina (`currentMonth`), con `isCanonical: false` para que la página
 * reescriba la URL (replace) a la forma válida.
 */
export function resolveGastosMonthFromSearch(
  search: string,
  currentMonth: ExpensesMonthKey,
): { selection: ExpensesMonthSelection; isCanonical: boolean } {
  const raw = new URLSearchParams(search).get(GASTOS_MONTH_PARAM);
  if (raw === EXPENSES_ALL_MONTHS || isValidExpensesMonth(raw)) return { selection: raw, isCanonical: true };
  return { selection: currentMonth, isCanonical: false };
}

export function buildGastosPath(selection: ExpensesMonthSelection): string {
  const params = new URLSearchParams();
  params.set("tab", GASTOS_TAB_VALUE);
  params.set(GASTOS_MONTH_PARAM, selection);
  return `/cobranzas?${params.toString()}`;
}

/** URL del listado: siempre explícita, también para el histórico. */
export function buildExpensesListUrl(selection: ExpensesMonthSelection): string {
  return `/api/cash/expenses?month=${encodeURIComponent(selection)}`;
}

/** Suma en centavos de TODAS las filas recibidas (las mismas que se listan). */
export function sumExpensesCents(rows: ReadonlyArray<{ amount: number }>): number {
  return rows.reduce((s, r) => s + Math.round((Number(r.amount) || 0) * 100), 0);
}

export function expensesTotalLabel(selection: ExpensesMonthSelection): string {
  return selection === EXPENSES_ALL_MONTHS
    ? "Total histórico de gastos"
    : `Total de gastos — ${formatExpensesMonthLabel(selection)}`;
}

export function expensesEmptyLabel(selection: ExpensesMonthSelection): string {
  return selection === EXPENSES_ALL_MONTHS
    ? "Sin gastos registrados"
    : `Sin gastos en ${formatExpensesMonthLabel(selection)}`;
}

/**
 * Si un gasto recién guardado con fecha `date` NO entra en la selección
 * visible, devuelve el mes donde quedó (para avisar "Guardado en …" y
 * ofrecer ir). null si se ve en el listado actual (o el histórico).
 */
export function describeSavedOutsideSelection(
  date: string,
  selection: ExpensesMonthSelection,
): { month: ExpensesMonthKey; label: string } | null {
  if (selection === EXPENSES_ALL_MONTHS) return null;
  if (isDateInExpensesMonth(date, selection)) return null;
  const month = expensesMonthOfDate(date);
  if (!month) return null;
  return { month, label: formatExpensesMonthLabel(month) };
}
