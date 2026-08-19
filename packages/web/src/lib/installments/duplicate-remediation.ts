// Lógica pura de clasificación para el saneamiento histórico de cuotas y
// refacturaciones duplicadas (Migración 0035). Sin DB, sin efectos
// secundarios — recibe filas ya leídas (el script en scripts/, gitignorado,
// hace las queries reales contra Turso) y devuelve una decisión explícita
// por grupo. Mismo estilo que rebuild.ts/cancellation.ts: fail-closed,
// nunca borra nada, cualquier ambigüedad o actividad real aborta el grupo
// completo (nunca invalidación parcial "lo que se pueda").
//
// Reglas de selección (confirmadas por el usuario, ver informe de
// diagnóstico previo):
//   - en un grupo con exactamente una cuota pagada y el resto pendiente/
//     vencida sin ninguna otra actividad, la pagada es SIEMPRE la canónica;
//   - en un grupo totalmente inactivo (nada pagado/rendido/con pago/con
//     movimiento), se conserva el id menor SOLO si todas las propiedades
//     relevantes (number, notes) son equivalentes entre los miembros;
//   - cualquier pago (de cualquier estado, incluido anulado), cuota
//     rendida, remittance_item, o movimiento de cuenta en CUALQUIER
//     miembro del grupo aborta el grupo completo;
//   - más de una cuota "pagada" en el mismo grupo aborta el grupo completo
//     (dato inesperado, nunca se asume cuál es la real);
//   - nunca DELETE — la decisión es siempre "cuáles id marcar duplicada",
//     el caller aplica vía UPDATE.

export interface InstallmentDuplicateMember {
  id: number;
  status: string;
  rendered: number;
  number: number;
  notes: string | null;
  // true si existe CUALQUIER fila en payments con installmentId=este id,
  // sin importar su status (confirmado/pendiente/anulado) — un pago anulado
  // igual es actividad real que aborta el grupo.
  hasAnyPayment: boolean;
  hasRemittanceItem: boolean;
  hasAccountMovement: boolean;
}

export type InstallmentGroupDecision =
  | { kind: "invalidate"; canonicalId: number; duplicateIds: number[]; reasonKind: "paid_is_canonical" | "lowest_id_equivalent" }
  | { kind: "skip"; reason: string; memberIds: number[] };

/**
 * Clasifica UN grupo de cuotas exactamente duplicadas (mismo policy_id +
 * rebilling_id + due_date + amount — el agrupamiento en sí lo hace el
 * caller). Requiere >= 2 miembros (un grupo de 1 no es un duplicado).
 */
export function classifyInstallmentDuplicateGroup(
  members: ReadonlyArray<InstallmentDuplicateMember>
): InstallmentGroupDecision {
  const memberIds = members.map((m) => m.id);
  if (members.length < 2) {
    return { kind: "skip", reason: "grupo con menos de 2 miembros (nada que invalidar)", memberIds };
  }

  const rendered = members.filter((m) => m.rendered === 1);
  if (rendered.length > 0) {
    return { kind: "skip", reason: `cuota(s) rendida(s): ${rendered.map((m) => m.id).join(", ")}`, memberIds };
  }
  const withPayment = members.filter((m) => m.hasAnyPayment);
  const withRemittance = members.filter((m) => m.hasRemittanceItem);
  const withMovement = members.filter((m) => m.hasAccountMovement);
  if (withRemittance.length > 0) {
    return { kind: "skip", reason: `cuota(s) con remittance_item: ${withRemittance.map((m) => m.id).join(", ")}`, memberIds };
  }
  if (withMovement.length > 0) {
    return { kind: "skip", reason: `cuota(s) con movimiento de cuenta: ${withMovement.map((m) => m.id).join(", ")}`, memberIds };
  }

  const paid = members.filter((m) => m.status === "pagada");
  if (paid.length > 1) {
    return { kind: "skip", reason: `más de una cuota pagada en el grupo: ${paid.map((m) => m.id).join(", ")}`, memberIds };
  }

  if (paid.length === 1) {
    // Caso "16 grupos con pago": la pagada es siempre la canónica. El resto
    // debe ser pendiente/vencida, sin ningún pago vinculado (ni siquiera
    // anulado) — withPayment ya se validó arriba a nivel de grupo, pero acá
    // además excluimos el caso de que la PROPIA pagada no tenga su pago real
    // contado (sería raro, pero no es motivo de abortar: sigue siendo la
    // canónica igual).
    const others = members.filter((m) => m.id !== paid[0]!.id);
    const invalidOthers = others.filter((m) => m.status !== "pendiente" && m.status !== "vencida");
    if (invalidOthers.length > 0) {
      return { kind: "skip", reason: `gemela(s) en estado inesperado (ni pendiente ni vencida): ${invalidOthers.map((m) => m.id).join(", ")}`, memberIds };
    }
    // Las gemelas no pagadas no pueden tener pago vinculado (withPayment ya
    // se comprobó a nivel grupo; acá se excluye específicamente que sea LA
    // PAGADA la única con pago — si alguna gemela también tiene pago propio
    // vinculado, es una anomalía real, no un duplicado limpio).
    const othersWithPayment = others.filter((m) => m.hasAnyPayment);
    if (othersWithPayment.length > 0) {
      return { kind: "skip", reason: `gemela(s) no pagada(s) con pago vinculado igual: ${othersWithPayment.map((m) => m.id).join(", ")}`, memberIds };
    }
    return { kind: "invalidate", canonicalId: paid[0]!.id, duplicateIds: others.map((m) => m.id), reasonKind: "paid_is_canonical" };
  }

  // Ningún pagado: withPayment ya comprobó que NADIE tiene pago — grupo
  // totalmente inactivo. Se conserva el id menor SOLO si todas las
  // propiedades relevantes (number, notes) son equivalentes.
  const sorted = [...members].sort((a, b) => a.id - b.id);
  const canonical = sorted[0]!;
  const rest = sorted.slice(1);
  const numbersDiffer = members.some((m) => m.number !== canonical.number);
  const normalizedNotes = (n: string | null) => (n ?? "").trim();
  const notesDiffer = members.some((m) => normalizedNotes(m.notes) !== normalizedNotes(canonical.notes));
  if (numbersDiffer || notesDiffer) {
    return {
      kind: "skip",
      reason: `propiedades relevantes difieren entre miembros (${numbersDiffer ? "number" : ""}${numbersDiffer && notesDiffer ? " y " : ""}${notesDiffer ? "notes" : ""})`,
      memberIds,
    };
  }
  return { kind: "invalidate", canonicalId: canonical.id, duplicateIds: rest.map((m) => m.id), reasonKind: "lowest_id_equivalent" };
}

// ─── Refacturaciones duplicadas ─────────────────────────────────────────────

export interface RebillingDuplicateMember {
  id: number;
  billingStart: string;
  billingEnd: string;
  premium: number | null;
  // true si CADA cuota propia (policy_installments.rebillingId = este id) ya
  // está 'duplicada' (de una corrida anterior) o va a marcarse 'duplicada'
  // en ESTA misma corrida (resuelto por classifyInstallmentDuplicateGroup) —
  // o si no tiene ninguna cuota propia. false si tiene AL MENOS una cuota
  // propia que sigue siendo "real" (no fue invalidada).
  ownInstallmentsFullyAccountedFor: boolean;
  hasDeliveryReference: boolean;
  hasCashPeriodReference: boolean;
}

export type RebillingGroupDecision =
  | { kind: "invalidate"; canonicalId: number; duplicateIds: number[] }
  | { kind: "skip"; reason: string; memberIds: number[] };

/**
 * Clasifica UN grupo de refacturaciones exactamente duplicadas (mismo
 * policy_id + billing_start + billing_end + premium en centavos). Reconfirma
 * cero referencias ANTES de invalidar cualquiera — aborta el grupo COMPLETO
 * si algún miembro no pagado/no canónico tiene cuotas propias sin
 * contabilizar, o cualquier referencia externa (delivery, cash_period_payment).
 */
export function classifyRebillingDuplicateGroup(
  members: ReadonlyArray<RebillingDuplicateMember>
): RebillingGroupDecision {
  const memberIds = members.map((m) => m.id);
  if (members.length < 2) {
    return { kind: "skip", reason: "grupo con menos de 2 miembros (nada que invalidar)", memberIds };
  }
  const sorted = [...members].sort((a, b) => a.id - b.id);
  const canonical = sorted[0]!;
  const rest = sorted.slice(1);

  for (const m of rest) {
    if (!m.ownInstallmentsFullyAccountedFor) {
      return { kind: "skip", reason: `refacturación ${m.id} tiene cuotas propias que no son duplicados invalidados (requiere revisión manual)`, memberIds };
    }
    if (m.hasDeliveryReference) {
      return { kind: "skip", reason: `refacturación ${m.id} tiene un seguimiento de Envíos y Entregas vinculado`, memberIds };
    }
    if (m.hasCashPeriodReference) {
      return { kind: "skip", reason: `refacturación ${m.id} tiene un pago de contado por período vinculado`, memberIds };
    }
  }

  return { kind: "invalidate", canonicalId: canonical.id, duplicateIds: rest.map((m) => m.id) };
}
