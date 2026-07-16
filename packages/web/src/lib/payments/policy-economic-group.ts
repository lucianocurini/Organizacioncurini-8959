// Helper puro de agrupación económica de pólizas — sin DB, sin efectos
// secundarios, mismo estilo que splits.ts/batches.ts.
//
// Motivo: una póliza Rivadavia principal y su accesoria de Accidentes de
// Pasajeros (vinculada por policies.parentPolicyId) representan, para
// Rivadavia, UN solo movimiento económico — pero el sistema las modela como
// dos filas de `policies` con sus propias cuotas/payments (correcto para
// trazabilidad: cobertura, vencimientos y montos son reales y distintos).
// calculateApplicableRivadaviaSurcharges (batches.ts) contaba el recargo
// Pronto Pago POR ÍTEM Rivadavia sin ninguna noción de este vínculo,
// duplicando el recargo ($800 x 2) cuando ambas cuotas se cobran juntas en
// el mismo batch — este archivo resuelve esa agrupación, nunca fusiona
// importes ni oculta ninguna de las dos cuotas.
//
// IMPORTANTE — qué NO cambia: si un batch tiene 2+ cuotas de la MISMA
// póliza (ej. dos cuotas atrasadas de una sola póliza automotor Rivadavia
// cobradas juntas), cada una sigue generando su propio recargo — esa regla
// ("$800 por cada cuota Rivadavia elegible, nunca por recibo ni por
// póliza") es intencional y preexistente (ver batches.ts), no se toca acá.
// Esta agrupación es estrictamente para el caso accesoria+principal.

export const ACCESSORY_POLICY_TYPE = "accidentes_pasajeros";

export interface PolicyForEconomicGroup {
  id: number;
  type: string;
  parentPolicyId: number | null;
}

export type PolicyEconomicGroupKind = "single" | "accesoria_agrupada" | "ambiguo";

export interface PolicyEconomicGroup {
  policyId: number;
  kind: PolicyEconomicGroupKind;
  /**
   * Póliza "dueña" del grupo a efectos de recargo: igual a policyId para
   * "single"/"ambiguo" (cada una es su propio grupo); igual a
   * parentPolicyId para "accesoria_agrupada" (el grupo lo representa la
   * principal).
   */
  groupKey: number;
  /** parentPolicyId tal cual vino, sin importar el kind resultante — para que la UI pueda mostrar "Accesoria de póliza X" incluso en el caso "ambiguo" (el vínculo existe, solo que el padre no está en este batch/cart). */
  parentPolicyId: number | null;
}

/**
 * Reglas (ver policy-economic-group — Rivadavia/Accidentes de Pasajeros):
 *
 * - Si la póliza NO es accidentes_pasajeros (incluida la principal misma):
 *   "single" — es su propio grupo, sin importar si tiene o no otras
 *   pólizas relacionadas.
 * - Si es accidentes_pasajeros CON parentPolicyId Y esa póliza padre está
 *   presente en el mismo batch/cart (`policyIdsInScope`): "accesoria_agrupada"
 *   — su groupKey pasa a ser el de la principal.
 * - Si es accidentes_pasajeros con parentPolicyId pero el padre NO está en
 *   este batch/cart, o directamente no tiene parentPolicyId: "ambiguo" (o
 *   "single" si nunca tuvo parentPolicyId) — tratamiento conservador, NUNCA
 *   se inventa una relación: cuenta como su propio grupo.
 */
export function resolvePolicyEconomicGroup(
  policy: PolicyForEconomicGroup,
  policyIdsInScope: ReadonlySet<number>
): PolicyEconomicGroup {
  if (policy.type === ACCESSORY_POLICY_TYPE && policy.parentPolicyId != null) {
    if (policyIdsInScope.has(policy.parentPolicyId)) {
      return { policyId: policy.id, kind: "accesoria_agrupada", groupKey: policy.parentPolicyId, parentPolicyId: policy.parentPolicyId };
    }
    return { policyId: policy.id, kind: "ambiguo", groupKey: policy.id, parentPolicyId: policy.parentPolicyId };
  }
  return { policyId: policy.id, kind: "single", groupKey: policy.id, parentPolicyId: null };
}

/**
 * true si esta póliza NO debe generar su propio recargo Pronto Pago porque
 * es una accesoria agrupada bajo otra póliza (su principal) presente en el
 * mismo batch/cart — el recargo de ese grupo económico ya lo aporta la
 * principal. false en cualquier otro caso (incluido "ambiguo": conservador,
 * sigue generando su propio recargo como si fuera independiente).
 */
export function isSurchargeAbsorbedByGroup(
  policy: PolicyForEconomicGroup,
  policyIdsInScope: ReadonlySet<number>
): boolean {
  return resolvePolicyEconomicGroup(policy, policyIdsInScope).kind === "accesoria_agrupada";
}
