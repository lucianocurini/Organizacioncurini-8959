// Único punto de verdad para el "día calendario operativo" del negocio
// (Argentina). Todo el negocio corre en Argentina, pero el proceso que
// ejecuta el código no necesariamente: el navegador del usuario, Windows, o
// el contenedor de Railway pueden estar en cualquier huso horario (o en
// UTC). new Date().toISOString().slice(0,10) usa SIEMPRE UTC, y entre las
// 21:00 y las 23:59 hora Argentina ya da la fecha del día siguiente — así
// nació el bug de la rendición #115 (creada 28/07 22:16 Arg, guardada como
// 2026-07-29).
//
// Por eso acá se fija `timeZone: "America/Argentina/Buenos_Aires"` de forma
// explícita en Intl.DateTimeFormat: esto NO depende de process.env.TZ, del
// reloj del SO ni del navegador — el resultado es el mismo sin importar
// dónde corra el proceso.
//
// formatToParts() se usa (en vez de .format() + parseo del string) porque
// el orden de salida de .format() depende del locale — acá se arman los
// componentes año/mes/día explícitamente, sin asumir nada sobre el orden.

const ARGENTINA_TIME_ZONE = "America/Argentina/Buenos_Aires";

const argentinaDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ARGENTINA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const CALENDAR_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Día calendario (YYYY-MM-DD) en Argentina para un instante real dado.
 * `value` puede ser un Date o un epoch en milisegundos. Default: ahora.
 * Lanza si el instante es inválido (nunca devuelve silenciosamente "").
 */
export function toArgentinaCalendarDay(value: Date | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error(`toArgentinaCalendarDay: instante inválido: ${String(value)}`);
  }
  const parts = argentinaDateFormatter.formatToParts(date);
  let year = "", month = "", day = "";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/**
 * Ordinal entero de días (días desde la época Unix) a partir de un día
 * calendario "YYYY-MM-DD", parseado por componentes de texto — NUNCA vía
 * `new Date(str)`, que lo interpretaría como medianoche UTC y puede
 * correrse un día al compararlo/truncarlo en hora local (ver daysUntil
 * viejo). Valida el formato estricto y que sea una fecha calendario real
 * (rechaza, por ejemplo, "2026-02-30").
 */
export function parseCalendarDayToUtcOrdinal(value: string): number {
  if (!CALENDAR_DAY_RE.test(value)) {
    throw new Error(`parseCalendarDayToUtcOrdinal: formato inválido, se esperaba YYYY-MM-DD: "${value}"`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const utcMs = Date.UTC(y, m - 1, d);
  const check = new Date(utcMs);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new Error(`parseCalendarDayToUtcOrdinal: fecha calendario inexistente: "${value}"`);
  }
  return Math.round(utcMs / 86400000);
}

/** Diferencia en días calendario completos (b - a), sin husos horarios de por medio. */
export function diffCalendarDays(a: string, b: string): number {
  return parseCalendarDayToUtcOrdinal(b) - parseCalendarDayToUtcOrdinal(a);
}

/**
 * Suma (o resta, con `days` negativo) días calendario completos a un día
 * "YYYY-MM-DD" — aritmética pura sobre el ordinal (mismo `parseCalendarDayToUtcOrdinal`
 * de arriba), nunca `Date.setDate()` sobre un `Date` local: eso mezclaría la
 * hora del proceso que ejecuta el cálculo con un día que ya es puro
 * calendario. El resultado se re-arma con los getters UTC del ordinal
 * resultante — sigue sin haber ningún huso horario real de por medio, el
 * ordinal en sí ya es calendario puro (ver comentario de
 * parseCalendarDayToUtcOrdinal).
 */
export function addCalendarDays(value: string, days: number): string {
  const ordinal = parseCalendarDayToUtcOrdinal(value) + days;
  const d = new Date(ordinal * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * Mes calendario Argentina (YYYY-MM) resultante de sumar `monthsOffset`
 * meses al mes de `value` (instante real, default ahora). Aritmética entera
 * pura sobre año/mes a partir del día ya resuelto en Argentina — nunca
 * `Date.setMonth()` sobre un Date crudo, que mezclaría la hora local del
 * proceso con el mes ya resuelto (ver monthlyData de Cobranzas: el
 * gráfico de 6 meses debe coincidir con las claves "YYYY-MM" que arma
 * GET /cash/stats, agrupadas por mes de Argentina).
 */
export function shiftArgentinaMonth(monthsOffset: number, value: Date | number = new Date()): string {
  const [y, m] = toArgentinaCalendarDay(value).split("-").map(Number);
  const zeroIndexed = (m! - 1) + monthsOffset;
  const year = y! + Math.floor(zeroIndexed / 12);
  const month0 = ((zeroIndexed % 12) + 12) % 12;
  return `${year}-${String(month0 + 1).padStart(2, "0")}`;
}

/**
 * Mes "YYYY-MM" para agrupaciones mensuales (ej. GET /cash/stats) a partir
 * de un valor que puede ser una fecha de negocio ya guardada como texto
 * "YYYY-MM-DD" (se recorta directo, sin pasar por Date — no hay instante
 * que convertir) o un timestamp real (Date o string parseable), que se
 * convierte al mes de Argentina, no al mes UTC/local del proceso que lo
 * calcula — mismo patrón que la rendición #115, aplicado a mes en vez de
 * día. Devuelve null si no hay valor o no es parseable.
 */
export function resolveArgentinaMonthKey(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string" && CALENDAR_DAY_RE.test(value)) return value.slice(0, 7);
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return null;
  return toArgentinaCalendarDay(date).slice(0, 7);
}
