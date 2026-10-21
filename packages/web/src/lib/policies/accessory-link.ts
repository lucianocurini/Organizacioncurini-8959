// Vínculo de una póliza accesoria (policies.parentPolicyId) con su principal
// (puro, sin DB ni I/O). Válido solo si la principal existe, no es a su vez
// accesoria, pertenece a la misma compañía y al mismo asegurado, está vigente
// (estado efectivo, ver effective-status.ts) y tiene la MISMA fecha final. La
// fecha inicial puede ser distinta.
//
// Con vínculo válido, la accesoria sigue el ciclo de la principal: en
// proyecciones y colas del reporte no forma fila propia. Con vínculo
// inválido va a "Vínculos a revisar". Los movimientos reales, cuotas, deudas,
// pagos y rendiciones de la accesoria no dependen de esto.

import { isEffectivelyVigente } from "./effective-status";

export interface AccessoryLinkPolicy {
  id: number;
  parentPolicyId: number | null;
  companyId: number | null;
  insuredId: number | null;
  status: string | null;
  endDate: string | null;
}

export type AccessoryLinkReason =
  | "vinculo_a_si_misma"
  | "principal_inexistente"
  | "principal_es_accesoria"
  | "otra_compania"
  | "otro_asegurado"
  | "principal_no_vigente"
  | "distinta_fecha_final";

export type AccessoryLinkResult =
  | { valid: true; reason: null }
  | { valid: false; reason: AccessoryLinkReason };

/** `parent` = la póliza cuyo id es accessory.parentPolicyId, o null si no existe. */
export function evaluateAccessoryLink(
  accessory: AccessoryLinkPolicy,
  parent: AccessoryLinkPolicy | null,
  today: string,
): AccessoryLinkResult {
  const bad = (reason: AccessoryLinkReason): AccessoryLinkResult => ({ valid: false, reason });
  if (accessory.parentPolicyId === accessory.id) return bad("vinculo_a_si_misma");
  if (!parent || parent.id !== accessory.parentPolicyId) return bad("principal_inexistente");
  if (parent.parentPolicyId != null) return bad("principal_es_accesoria");
  if (parent.companyId !== accessory.companyId) return bad("otra_compania");
  if (parent.insuredId !== accessory.insuredId) return bad("otro_asegurado");
  if (!isEffectivelyVigente(parent.status, parent.endDate, today)) return bad("principal_no_vigente");
  if (parent.endDate !== accessory.endDate) return bad("distinta_fecha_final");
  return { valid: true, reason: null };
}

const REASON_LABELS: Record<AccessoryLinkReason, string> = {
  vinculo_a_si_misma: "La póliza figura vinculada a sí misma",
  principal_inexistente: "La póliza principal vinculada no existe",
  principal_es_accesoria: "La póliza principal vinculada es a su vez accesoria de otra",
  otra_compania: "La póliza principal es de otra compañía",
  otro_asegurado: "La póliza principal es de otro asegurado",
  principal_no_vigente: "La póliza principal no está vigente",
  distinta_fecha_final: "La póliza principal tiene otra fecha final de vigencia",
};

export function accessoryLinkReasonLabel(reason: AccessoryLinkReason | null): string | null {
  return reason ? REASON_LABELS[reason] : null;
}
