// Función pura y única para construir un plan de cuotas.
//
// Reemplaza los dos algoritmos que existían por separado (alta/edición de
// póliza en PolicyModal.tsx, y el botón "Generar cuotas" en poliza-detail.tsx),
// que calculaban cantidades y fechas de forma distinta y ambos ignoraban el
// período real facturado.
//
// Regla principal: las cuotas corresponden al importe y al período REAL que
// se está facturando (periodStart/periodEnd/periodAmount), nunca a la vigencia
// completa de la póliza. La cantidad de cuotas es siempre una entrada explícita
// — esta función nunca la infiere de la vigencia ni del ciclo de refacturación.
//
// No depende de React ni de la base de datos: recibe datos explícitos y
// devuelve datos explícitos. Sin efectos secundarios.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class InstallmentPlanError extends Error {}

export interface InstallmentPlanInput {
  /** Inicio del período que se está facturando (YYYY-MM-DD). No es necesariamente startDate de la póliza. */
  periodStart: string;
  /** Fin del período que se está facturando (YYYY-MM-DD). No es necesariamente endDate de la póliza. */
  periodEnd: string;
  /** Importe total real del período (prima o equivalente) — se distribuye entre las cuotas. */
  periodAmount: number;
  /** Cantidad de cuotas. Entrada explícita: nunca se infiere de la vigencia ni del billingCycle. */
  installmentCount: number;
  /** Fecha de la primera cuota, si difiere del inicio del período. Default: periodStart. */
  firstDueDate?: string;
  /** Meses entre cuotas consecutivas. Default: 1 (mensual). No confundir con la duración del ciclo de refacturación. */
  installmentIntervalMonths?: number;
}

export interface InstallmentPlanRow {
  number: number;
  dueDate: string;
  amount: number;
}

export interface InstallmentPlanResult {
  installments: InstallmentPlanRow[];
  /** Igual a periodAmount de entrada — nunca se pierden ni se agregan centavos. */
  totalAmount: number;
  /**
   * Reservado para observaciones no bloqueantes. Actualmente SIEMPRE vacío:
   * la única advertencia que existía (última cuota posterior a periodEnd)
   * pasó a ser InstallmentPlanError — ver validación de rango más abajo.
   * Se mantiene el campo por compatibilidad con los callers existentes
   * (PolicyModal.tsx, poliza-detail.tsx) hasta que se decida retirarlo.
   */
  warnings: string[];
}

// ─── Fechas calendario, sin pasar por Date+zona horaria ───────────────────────
// Todo el cálculo se hace con aritmética entera sobre año/mes/día. new Date.UTC
// se usa únicamente como forma de aprovechar el calendario gregoriano ya
// implementado por el motor JS (días por mes, bisiestos) sin que la zona
// horaria local participe en ningún momento.

function daysInMonth(year: number, month1to12: number): number {
  // Date.UTC(year, month1to12, 0) = día 0 del mes siguiente (0-indexado) =
  // último día de `month1to12`. Pura aritmética UTC, sin desplazamiento local.
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

// value ya viene validado por DATE_RE (\d{4}-\d{2}-\d{2}) en isValidCalendarDate,
// que siempre produce exactamente 3 componentes numéricos — el "!" no oculta
// un caso real, sólo evita que TS exija un chequeo redundante tras el regex.
function splitDate(value: string): [number, number, number] {
  const [y, m, d] = value.split("-").map(Number);
  return [y!, m!, d!];
}

export function isValidCalendarDate(value: string): boolean {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [y, m, d] = splitDate(value);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > daysInMonth(y, m)) return false;
  return true;
}

// Suma N meses calendario a una fecha, preservando el día cuando es posible
// y recortando al último día del mes destino cuando no (31 ene + 1 mes → 28/29 feb).
// Asume dateStr ya validada (YYYY-MM-DD real) — ver isValidCalendarDate.
export function addCalendarMonths(dateStr: string, months: number): string {
  const [y, m, d] = splitDate(dateStr);
  const totalMonths = y * 12 + (m - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1; // 1..12
  const targetDay = Math.min(d, daysInMonth(targetYear, targetMonth));
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

// Suma (o resta, con N negativo) días calendario a una fecha. Pura aritmética
// UTC (Date.UTC/getUTCX), sin que la zona horaria local participe.
// Asume dateStr ya validada (YYYY-MM-DD real) — ver isValidCalendarDate.
export function addCalendarDays(dateStr: string, days: number): string {
  const [y, m, d] = splitDate(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// ─── Validación ────────────────────────────────────────────────────────────────

function assertValidDate(value: string, label: string): void {
  if (!isValidCalendarDate(value)) {
    throw new InstallmentPlanError(`${label} inválida: "${value}". Formato esperado YYYY-MM-DD con fecha real.`);
  }
}

// ─── Función principal ─────────────────────────────────────────────────────────

export function buildInstallmentPlan(input: InstallmentPlanInput): InstallmentPlanResult {
  const {
    periodStart, periodEnd, periodAmount, installmentCount,
    firstDueDate, installmentIntervalMonths,
  } = input;

  assertValidDate(periodStart, "Fecha de inicio del período");
  assertValidDate(periodEnd, "Fecha de fin del período");
  if (periodEnd < periodStart) {
    throw new InstallmentPlanError(
      `El fin del período (${periodEnd}) no puede ser anterior al inicio (${periodStart}).`
    );
  }

  if (!Number.isInteger(installmentCount) || installmentCount <= 0) {
    throw new InstallmentPlanError(
      `La cantidad de cuotas debe ser un entero mayor a cero (recibido: ${installmentCount}).`
    );
  }

  if (!Number.isFinite(periodAmount) || periodAmount < 0) {
    throw new InstallmentPlanError(
      `El importe del período no puede ser negativo ni inválido (recibido: ${periodAmount}).`
    );
  }

  const interval = installmentIntervalMonths ?? 1;
  if (!Number.isInteger(interval) || interval <= 0) {
    throw new InstallmentPlanError(
      `La frecuencia de vencimiento debe ser un entero mayor a cero (recibido: ${interval}).`
    );
  }

  const firstDue = firstDueDate ?? periodStart;
  assertValidDate(firstDue, "Fecha de la primera cuota");

  // La primera cuota tiene que caer dentro del período que se está facturando.
  // Antes esto no se validaba: una firstDueDate fuera de rango generaba
  // igual el plan completo, sin error ni advertencia.
  if (firstDue < periodStart) {
    throw new InstallmentPlanError(
      `La fecha de la primera cuota (${firstDue}) no puede ser anterior al inicio del período facturado (${periodStart}).`
    );
  }
  if (firstDue > periodEnd) {
    throw new InstallmentPlanError(
      `La fecha de la primera cuota (${firstDue}) no puede ser posterior al fin del período facturado (${periodEnd}).`
    );
  }

  // ── Validar el rango completo ANTES de construir ningún importe ────────────
  // Las fechas de vencimiento no dependen del importe ni del reparto en
  // centavos, así que se calculan primero para poder rechazar la combinación
  // cantidad/frecuencia sin llegar a construir (ni devolver) un plan parcial.
  const dueDates = Array.from({ length: installmentCount }, (_, i) => addCalendarMonths(firstDue, i * interval));
  const lastDueDate = dueDates[dueDates.length - 1]!;
  if (lastDueDate > periodEnd) {
    throw new InstallmentPlanError(
      `${installmentCount} cuotas cada ${interval} mes(es) no entran en el período facturado: ` +
      `la última vencería el ${lastDueDate}, después del fin del período (${periodEnd}). ` +
      `Reducí la cantidad de cuotas, acortá la frecuencia o ampliá el período.`
    );
  }

  // Distribución exacta en centavos: nunca se pierde ni se agrega un centavo.
  // La diferencia de redondeo (si existe) se acumula en la última cuota.
  const totalCents = Math.round(periodAmount * 100);
  const baseCents = Math.trunc(totalCents / installmentCount);
  const remainderCents = totalCents - baseCents * installmentCount;

  const installments: InstallmentPlanRow[] = dueDates.map((dueDate, i) => ({
    number: i + 1,
    dueDate,
    amount: (baseCents + (i === installmentCount - 1 ? remainderCents : 0)) / 100,
  }));

  const totalAmount = installments.reduce((sum, row) => sum + row.amount, 0);

  return { installments, totalAmount, warnings: [] };
}
