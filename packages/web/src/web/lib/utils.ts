import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

/**
 * Variante de formatCurrency que SIEMPRE muestra los dos decimales reales, a
 * partir de un importe en CENTAVOS enteros (no pesos) — evita el redondeo a
 * peso entero de formatCurrency, que en el editor de medios de pago (splits)
 * ocultaba diferencias reales de centavos (ej. "-$0" en vez de "-$0,06").
 * Usar solo donde el usuario necesita ver/comparar el importe exacto
 * (Cobrar en lote, Imputar pago individual) — en el resto de la app
 * (dashboards, reportes) formatCurrency sigue siendo el helper correcto.
 */
export function formatCurrencyCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

// Rutas internas a las que un botón "volver" puede redirigir. Cualquier otro
// valor (URL externa, protocol-relative, esquema no-http) se considera inseguro.
const SAFE_RETURN_PREFIXES = ["/reporte-mes", "/polizas"] as const;

export function isSafeReturnTo(path: string | null | undefined): path is string {
  if (!path) return false;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return false;
  return SAFE_RETURN_PREFIXES.some(
    (prefix) => path === prefix
      || path.startsWith(`${prefix}/`)
      || path.startsWith(`${prefix}?`)
      || path.startsWith(`${prefix}#`)
  );
}

export function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(dateStr);
  end.setHours(0, 0, 0, 0);
  return Math.ceil((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export const POLICY_TYPES: Record<string, { label: string; color: string }> = {
  automotor: { label: "Automotor", color: "bg-blue-500/15 text-blue-400 border-blue-500/20" },
  motovehiculo: { label: "Motovehículo", color: "bg-cyan-500/15 text-cyan-400 border-cyan-500/20" },
  ecomovilidad: { label: "Ecomovilidad", color: "bg-teal-500/15 text-teal-400 border-teal-500/20" },
  hogar: { label: "Hogar", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" },
  accidentes: { label: "Acc. Personales", color: "bg-orange-500/15 text-orange-400 border-orange-500/20" },
  art: { label: "ART", color: "bg-rose-500/15 text-rose-400 border-rose-500/20" },
  comercial: { label: "Integrales", color: "bg-purple-500/15 text-purple-400 border-purple-500/20" },
  responsabilidad_civil: { label: "Resp. Civil", color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20" },
  cascos: { label: "Cascos", color: "bg-indigo-500/15 text-indigo-400 border-indigo-500/20" },
  incendio: { label: "Incendio", color: "bg-red-500/15 text-red-400 border-red-500/20" },
};

export const STATUS_TYPES: Record<string, { label: string; color: string }> = {
  activa: { label: "Activa", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" },
  vencida: { label: "Vencida", color: "bg-red-500/15 text-red-400 border-red-500/20" },
  por_vencer: { label: "Por vencer", color: "bg-amber-500/15 text-amber-400 border-amber-500/20" },
  cancelada: { label: "Cancelada", color: "bg-gray-500/15 text-gray-400 border-gray-500/20" },
  // Se asigna server-side a la póliza anterior al crear una renovación
  // (ver POST /policies en index.ts) — ya existía como valor real de
  // policies.status pero no tenía badge de color asignado acá.
  renovada: { label: "Renovada", color: "bg-violet-500/15 text-violet-400 border-violet-500/20" },
};

export const COVERAGE_LABELS: Record<string, string> = {
  responsabilidad_civil: "Resp. Civil",
  terceros_completo: "Terceros Completo",
  terceros_con_incendio_robo: "Terceros + Incendio/Robo",
  todo_riesgo: "Todo Riesgo",
  todo_riesgo_con_franquicia: "Todo Riesgo c/Franquicia",
  incendio: "Incendio",
  integral_hogar: "Integral Hogar",
  integral_hogar_ampliado: "Integral Hogar Ampliado",
  accidentes_personales: "Acc. Personales",
  accidentes_24hs: "Acc. 24hs",
  accidentes_laborales: "Acc. Laborales",
  art_personal_domestico: "Personal Doméstico",
  art_sistema_general: "Sistema General",
  eco_bicicleta: "Bicicleta",
  eco_monopatin: "Monopatín",
  rc_general: "RC General",
  rc_productos: "RC Productos",
  rc_locativa: "RC Locativa",
  rc_patronal: "RC Patronal",
  cascos_flotante: "Casco Flotante",
  cascos_especifico: "Casco Específico",
  incendio_edificio: "Incendio Edificio",
  incendio_contenido: "Incendio Contenido",
  incendio_integral: "Incendio Integral",
  integral_comercio: "Integral de Comercio",
  integral_consorcio: "Integral de Consorcio",
  integral_hotelero: "Integral Hotelero",
  basica: "Básica",
  completa: "Completa",
};
