// Selector de pólizas de Cobranzas ("Imputar pago" y "Vincular a una póliza
// existente" del cobro manual en lote) — lógica pura, sin React ni red.
//
// Fuente: GET /api/policies/collectable-for-payment?paymentDate=… — devuelve
// SOLO pólizas en posición cobrable para esa fecha (vigente, anterior
// directa, próxima inmediata, o la última terminada de un hueco), con la
// misma regla de posición que decide las cuotas y que revalida el backend.
// Fail closed: una falla de red o una respuesta inválida NUNCA vuelve a
// mostrar todas las pólizas (no existe ningún fallback a GET /api/policies).

export type CollectablePolicyVia = "poliza_vigente" | "antecesora_directa" | "proxima_inmediata" | "ultima_terminada";

export interface CollectablePolicyOption {
  policy: {
    id: number; policyNumber: string; status: string; type: string;
    insuredId: number | null; companyId: number | null; parentPolicyId: number | null;
    startDate: string | null; endDate: string | null;
  };
  insured: { id: number; name: string } | null;
  company: { id: number; name: string } | null;
  /** false solo para la póliza incluida a pedido (edición de un pago existente). */
  collectable: boolean;
  via: CollectablePolicyVia | null;
  reason: string | null;
  hasCollectableInstallments: boolean;
  accessory: { parentPolicyId: number; parentPolicyNumber: string | null; linkValid: boolean } | null;
}

export function buildCollectablePoliciesQuery(params: { paymentDate: string; includePolicyId?: string | number | null }): string {
  const qs = new URLSearchParams();
  qs.set("paymentDate", params.paymentDate);
  if (params.includePolicyId != null && params.includePolicyId !== "") qs.set("includePolicyId", String(params.includePolicyId));
  return `/api/policies/collectable-for-payment?${qs.toString()}`;
}

/** Opciones válidas de la respuesta, o null si la forma no es la esperada (se trata igual que un error de red). */
export function parseCollectablePoliciesResponse(data: unknown): CollectablePolicyOption[] | null {
  if (!Array.isArray(data)) return null;
  for (const row of data) {
    const r = row as Partial<CollectablePolicyOption> | null;
    if (!r || typeof r !== "object" || !r.policy || typeof r.policy.id !== "number" || !Number.isInteger(r.policy.id)) return null;
    if (typeof r.policy.policyNumber !== "string" || typeof r.collectable !== "boolean") return null;
  }
  return data as CollectablePolicyOption[];
}

/** Estado de la última consulta, atado a la clave (fecha + póliza incluida) con que se pidió. */
export type PolicySelectorState =
  | { status: "loading"; key: string; options: CollectablePolicyOption[] }
  | { status: "invalid_date"; key: string; options: CollectablePolicyOption[] }
  | { status: "error"; key: string; options: CollectablePolicyOption[] }
  | { status: "ok"; key: string; options: CollectablePolicyOption[] };

export function policySelectorKey(paymentDate: string, includePolicyId?: string | number | null): string {
  return `${paymentDate}|${includePolicyId ?? ""}`;
}

/** true si la lista cargada corresponde a la clave actual y llegó bien (lo único que habilita elegir y confirmar). */
export function isPolicySelectorReady(state: PolicySelectorState | null, currentKey: string): boolean {
  return state != null && state.status === "ok" && state.key === currentKey;
}

export const POLICY_SELECTOR_VIA_LABELS: Record<CollectablePolicyVia, string> = {
  poliza_vigente: "Vigente",
  antecesora_directa: "Anterior inmediata",
  proxima_inmediata: "Próxima",
  ultima_terminada: "Última terminada",
};

export const NO_PENDING_INSTALLMENTS_LABEL = "sin cuotas pendientes";
export const ACCESSORY_LINK_TO_REVIEW_LABEL = "Accesoria — vínculo a revisar";
export const OUT_OF_POSITION_LABEL = "fuera de vigencia cobrable";

export function accessoryOfLabel(parentPolicyNumber: string | null): string {
  return `Accesoria de ${parentPolicyNumber ?? "póliza principal"}`;
}

export type PolicySelectorEntryKind = "principal" | "accessory" | "accessory_to_review";

export interface PolicySelectorEntry {
  option: CollectablePolicyOption;
  kind: PolicySelectorEntryKind;
  /** Etiqueta de accesoria ("Accesoria de …" o "Accesoria — vínculo a revisar"); null para principales. */
  accessoryLabel: string | null;
  badges: string[];
}

function badgesOf(o: CollectablePolicyOption): string[] {
  const b: string[] = [];
  if (!o.collectable) b.push(OUT_OF_POSITION_LABEL);
  else if (o.via) b.push(POLICY_SELECTOR_VIA_LABELS[o.via]);
  if (o.collectable && !o.hasCollectableInstallments) b.push(NO_PENDING_INSTALLMENTS_LABEL);
  return b;
}

function matches(o: CollectablePolicyOption, needle: string): boolean {
  if (!needle) return true;
  return o.policy.policyNumber.toLowerCase().includes(needle) || (o.insured?.name ?? "").toLowerCase().includes(needle);
}

/**
 * Lista ordenada para mostrar: cada principal seguida de sus accesorias con
 * vínculo válido ("Accesoria de …"). Una accesoria cuya principal no está en
 * la lista (no está en posición cobrable) o con vínculo inválido se conserva
 * suelta como "Accesoria — vínculo a revisar" — solo aparece si su PROPIA
 * posición es cobrable (el endpoint nunca devuelve otra cosa). Búsqueda: una
 * principal se muestra si coincide ella o alguna de sus accesorias; una
 * accesoria agrupada, si coincide ella o su principal.
 */
export function groupPolicySelectorOptions(options: ReadonlyArray<CollectablePolicyOption>, search = ""): PolicySelectorEntry[] {
  const needle = search.trim().toLowerCase();
  const principalIds = new Set(options.filter((o) => o.policy.parentPolicyId == null).map((o) => o.policy.id));
  const childrenOf = new Map<number, CollectablePolicyOption[]>();
  const toReview: CollectablePolicyOption[] = [];
  for (const o of options) {
    const parentId = o.policy.parentPolicyId;
    if (parentId == null) continue;
    if (principalIds.has(parentId) && o.accessory?.linkValid === true) {
      const arr = childrenOf.get(parentId) ?? [];
      arr.push(o);
      childrenOf.set(parentId, arr);
    } else {
      toReview.push(o);
    }
  }
  const out: PolicySelectorEntry[] = [];
  for (const o of options) {
    if (o.policy.parentPolicyId != null) continue;
    const children = childrenOf.get(o.policy.id) ?? [];
    const principalMatches = matches(o, needle);
    const visibleChildren = children.filter((ch) => principalMatches || matches(ch, needle));
    if (!principalMatches && visibleChildren.length === 0) continue;
    out.push({ option: o, kind: "principal", accessoryLabel: null, badges: badgesOf(o) });
    for (const ch of visibleChildren) {
      out.push({ option: ch, kind: "accessory", accessoryLabel: accessoryOfLabel(o.policy.policyNumber), badges: badgesOf(ch) });
    }
  }
  for (const o of toReview) {
    if (!matches(o, needle)) continue;
    out.push({ option: o, kind: "accessory_to_review", accessoryLabel: ACCESSORY_LINK_TO_REVIEW_LABEL, badges: badgesOf(o) });
  }
  return out;
}

/** La póliza elegida sigue disponible en la lista cargada (en posición cobrable). */
export function isSelectedPolicyStillSelectable(policyId: string, options: ReadonlyArray<CollectablePolicyOption>): boolean {
  if (!policyId) return true;
  return options.some((o) => String(o.policy.id) === policyId && o.collectable);
}

/** Desvinculación: se limpian póliza, cuota, vencimiento e importe (el resto del formulario se conserva). */
export function detachUnavailablePolicy<F extends { policyId: string; installmentId: string; dueDate: string; amount: string }>(form: F): F {
  return { ...form, policyId: "", installmentId: "", dueDate: "", amount: "" };
}

export const POLICY_NO_LONGER_AVAILABLE_MESSAGE =
  "La póliza seleccionada no está disponible para cobrar con esta fecha de pago (no es la vigente, la anterior inmediata ni la próxima). Elegí otra póliza.";

export const POLICY_SELECTOR_ERROR_MESSAGE =
  "No se pudieron cargar las pólizas disponibles para esta fecha. Reintentá antes de continuar.";

// ─── Carrito de "Cobrar en lote": cobros manuales con póliza ───────────────

/** Ids de pólizas en posición cobrable de una respuesta del selector (null = forma inválida, fail closed). */
export function parseCollectablePolicyIds(data: unknown): Set<number> | null {
  const options = parseCollectablePoliciesResponse(data);
  if (!options) return null;
  return new Set(options.filter((o) => o.collectable).map((o) => o.policy.id));
}

export type CartPolicyCheckState =
  | { status: "loading"; paymentDate: string }
  | { status: "invalid_date"; paymentDate: string }
  | { status: "error"; paymentDate: string }
  | { status: "ok"; paymentDate: string; collectablePolicyIds: ReadonlySet<number> };

export interface CartPolicyCollectability {
  kind: "not_needed" | "checking" | "invalid_date" | "error" | "unavailable" | "ok";
  canConfirm: boolean;
  /** localIds de los cobros manuales con póliza que no están disponibles. */
  unavailableLocalIds: string[];
}

/**
 * Mismo criterio que resolveCartCollectability (cuotas), para los cobros
 * manuales con póliza del carrito: se evalúan con el último resultado de la
 * fecha ACTUAL. Cargando, error, fecha inválida o resultado de otra fecha
 * bloquean Confirmar.
 */
export function resolveCartPolicyCollectability(
  cart: ReadonlyArray<{ kind: string; policyId?: number; localId?: string }>,
  check: CartPolicyCheckState,
  currentPaymentDate: string
): CartPolicyCollectability {
  const items = cart.filter((i) => i.kind === "policy_manual_payment");
  if (items.length === 0) return { kind: "not_needed", canConfirm: true, unavailableLocalIds: [] };
  if (check.paymentDate !== currentPaymentDate || check.status === "loading") return { kind: "checking", canConfirm: false, unavailableLocalIds: [] };
  if (check.status === "invalid_date") return { kind: "invalid_date", canConfirm: false, unavailableLocalIds: [] };
  if (check.status === "error") return { kind: "error", canConfirm: false, unavailableLocalIds: [] };
  const unavailableLocalIds = items
    .filter((i) => i.policyId == null || !check.collectablePolicyIds.has(i.policyId))
    .map((i) => i.localId ?? "");
  return unavailableLocalIds.length > 0
    ? { kind: "unavailable", canConfirm: false, unavailableLocalIds }
    : { kind: "ok", canConfirm: true, unavailableLocalIds: [] };
}
