// Estado efectivo de una póliza, calculado al LEER (puro, sin DB ni I/O).
//
// policies.status es una foto que solo se recalcula al dar de alta o editar
// la póliza (POST/PUT /policies): una póliza cuya vigencia ya terminó puede
// seguir guardada como "activa"/"por_vencer" indefinidamente. Esta función
// aplica la MISMA regla que el alta/edición sobre el día calendario de
// Argentina que recibe (`today`, explícito para que sea testeable):
//   fin − hoy < 0   → vencida   (fin = hoy todavía NO es vencida)
//   0 ≤ fin − hoy ≤ 30 → por_vencer
//   fin − hoy > 30  → activa
// Solo se recalculan activa/por_vencer/vencida. Cancelada y renovada son
// terminales y se devuelven siempre tal cual, igual que cualquier otro valor
// desconocido o una fecha final inválida (no hay de dónde recalcular).
// Nunca escribe: el dato guardado no cambia.

import { diffCalendarDays } from "../dates/argentina-date";
import { isPlausibleCalendarDate } from "./next-rebilling";

export const RECALCULABLE_POLICY_STATUSES = ["activa", "por_vencer", "vencida"] as const;
export const EFFECTIVE_VIGENTE_STATUSES = ["activa", "por_vencer"] as const;
export const POR_VENCER_DAYS = 30;

export function effectivePolicyStatus(status: string | null, endDate: string | null, today: string): string | null {
  if (!status || !(RECALCULABLE_POLICY_STATUSES as readonly string[]).includes(status)) return status;
  if (!isPlausibleCalendarDate(endDate) || !isPlausibleCalendarDate(today)) return status;
  const daysToEnd = diffCalendarDays(today, endDate);
  if (daysToEnd < 0) return "vencida";
  if (daysToEnd <= POR_VENCER_DAYS) return "por_vencer";
  return "activa";
}

export function isEffectivelyVigente(status: string | null, endDate: string | null, today: string): boolean {
  const eff = effectivePolicyStatus(status, endDate, today);
  return eff != null && (EFFECTIVE_VIGENTE_STATUSES as readonly string[]).includes(eff);
}
