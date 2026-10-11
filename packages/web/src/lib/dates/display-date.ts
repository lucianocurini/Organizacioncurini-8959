// Presentación humana de fechas (solo UI). Funciones puras y estrictas:
// nunca lanzan, y ante un valor vacío o inválido devuelven "—".
//
// Dos tipos de dato distintos, cada uno con su helper — nunca mezclarlos:
//
// - Fecha pura de negocio "YYYY-MM-DD" (vencimientos, vigencias, fechas de
//   pago...). Es un día calendario, no un instante: se reordena por texto y
//   NUNCA pasa por `new Date("YYYY-MM-DD")`, que la interpreta como
//   medianoche UTC y en Argentina la muestra un día antes.
// - Timestamp (createdAt, cancelledAt...): un instante real. Se valida y se
//   convierte explícitamente a America/Argentina/Buenos_Aires, sin depender
//   del huso del navegador ni del proceso.
//
// Inputs, API, base, payloads y query params siguen en YYYY-MM-DD: esto es
// exclusivamente para lo que se muestra en pantalla.

import { normalizeToDate } from "./argentina-date";

export const EMPTY_DATE_LABEL = "—";

const ARGENTINA_TIME_ZONE = "America/Argentina/Buenos_Aires";

const CALENDAR_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
// Timestamp ISO con hora y zona explícita (lo que sirve c.json() para Date).
// Sin zona sería ambiguo (¿UTC? ¿hora local del navegador?) y se rechaza.
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
] as const;

const argentinaDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ARGENTINA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * ¿Es un día calendario "YYYY-MM-DD" real (rechaza 2026-02-30)? Aritmética
 * entera pura, sin construir ningún Date.
 */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !CALENDAR_DAY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  return d <= daysInMonth;
}

/** "2026-10-09" → "09/10/2026". Cualquier otra cosa (incluido un timestamp) → "—". */
export function formatDisplayDate(value: string | null | undefined): string {
  if (!isCalendarDay(value)) return EMPTY_DATE_LABEL;
  const [y, m, d] = value.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Vista previa de importación: una fecha ya normalizada a "YYYY-MM-DD" se
 * muestra "DD/MM/YYYY"; un valor que el parser no pudo normalizar se muestra
 * tal cual (para que el usuario vea qué vino en el archivo); vacío → "—".
 */
export function formatPreviewDate(value: string | null | undefined): string {
  if (isCalendarDay(value)) return formatDisplayDate(value);
  return value ? value : EMPTY_DATE_LABEL;
}

/** "2026-10-01" + "2026-10-31" → "01/10/2026 al 31/10/2026"; un extremo inválido se muestra "—". */
export function formatDisplayDateRange(from: string | null | undefined, to: string | null | undefined): string {
  if (!isCalendarDay(from) && !isCalendarDay(to)) return EMPTY_DATE_LABEL;
  return `${formatDisplayDate(from)} al ${formatDisplayDate(to)}`;
}

/** "2026-10" → "Octubre 2026". Cualquier otra cosa → "—". */
export function formatDisplayMonth(value: string | null | undefined): string {
  if (typeof value !== "string") return EMPTY_DATE_LABEL;
  const match = MONTH_RE.exec(value);
  if (!match) return EMPTY_DATE_LABEL;
  return `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}`;
}

/**
 * Instante válido a partir de un timestamp, o null. Acepta Date, epoch
 * (segundos o milisegundos, ver normalizeToDate) o string ISO con hora y
 * zona explícita. Una fecha pura "YYYY-MM-DD" NO es un timestamp: se rechaza
 * (pasarla por acá la correría un día).
 */
function toInstant(value: number | string | Date | null | undefined): Date | null {
  if (value == null) return null;
  if (typeof value === "string" && !ISO_TIMESTAMP_RE.test(value)) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return normalizeToDate(value);
}

function argentinaParts(date: Date) {
  const out = { year: "", month: "", day: "", hour: "", minute: "" };
  for (const part of argentinaDateTimeFormatter.formatToParts(date)) {
    if (part.type in out) out[part.type as keyof typeof out] = part.value;
  }
  return out;
}

/** Timestamp → "DD/MM/YYYY HH:mm" en hora Argentina. Inválido, vacío o fecha pura → "—". */
export function formatDisplayDateTime(value: number | string | Date | null | undefined): string {
  const date = toInstant(value);
  if (!date) return EMPTY_DATE_LABEL;
  const p = argentinaParts(date);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** Timestamp → solo el día "DD/MM/YYYY" en Argentina. Inválido, vacío o fecha pura → "—". */
export function formatDisplayTimestampDate(value: number | string | Date | null | undefined): string {
  const date = toInstant(value);
  if (!date) return EMPTY_DATE_LABEL;
  const p = argentinaParts(date);
  return `${p.day}/${p.month}/${p.year}`;
}
