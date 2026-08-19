// Agrupación pura (sin React, sin fetch) de policy_installments por
// rebillingId, para la vista de "Cuotas" de poliza-detail.tsx. Cada
// refacturación genera su propio grupo de cuotas numeradas 1..N — acá solo
// se agrupan y ordenan, la numeración ya viene así desde el backend
// (buildRebillingInstallmentPlan reinicia number en 1 por grupo, ver
// src/lib/installments/rebilling-plan.ts).
//
// Orden: emisión original primero (rebillingId IS NULL), luego
// refacturaciones por billingStart ascendente — nunca se oculta ni se
// reemplaza un grupo anterior.

export interface GroupableInstallment {
  id: number;
  number: number;
  dueDate: string;
  amount: number;
  status: string;
  notes: string | null;
  rebillingId: number | null;
  // Presente en los datos reales (GET /policies/:id) pero opcional acá:
  // grupos armados a mano en tests no siempre lo cargan. Usado por
  // isCashPeriodEligible (cash-period-payment-form.ts) para decidir si
  // mostrar "Pagar período de contado".
  rendered?: number;
  // Migración 0035 — presentes solo cuando status='duplicada'. Opcionales acá
  // por el mismo motivo que rendered arriba (tests/fixtures no siempre los cargan).
  duplicateOfInstallmentId?: number | null;
  invalidatedAt?: number | string | null;
  invalidatedBy?: number | null;
  invalidationReason?: string | null;
}

export interface GroupableRebilling {
  id: number;
  billingStart: string;
  billingEnd: string;
  deductible: number | null;
  // Migración 0035 — opcional por compatibilidad con fixtures de tests que no
  // lo cargan; ausente se trata como 'activa' (mismo default que la columna).
  status?: string;
}

export interface InstallmentGroup {
  key: string; // "original" | String(rebillingId)
  label: string;
  rebillingId: number | null;
  billingStart: string | null;
  billingEnd: string | null;
  deductible: number | null;
  installments: GroupableInstallment[];
}

// Migración 0035: una cuota 'duplicada' no es parte del plan real — se
// excluye acá de la agrupación normal, nunca se cuenta ni se muestra mezclada
// con las cuotas reales. Sigue disponible para auditoría vía
// extractDuplicateInstallments más abajo, que alimenta una sección aparte en
// poliza-detail.tsx.
function isRealInstallment(i: GroupableInstallment): boolean {
  return i.status !== "duplicada";
}

export function groupInstallmentsByRebilling(
  installments: ReadonlyArray<GroupableInstallment>,
  rebillings: ReadonlyArray<GroupableRebilling>,
): InstallmentGroup[] {
  const realInstallments = installments.filter(isRealInstallment);
  const rebillingById = new Map(rebillings.map((r) => [r.id, r]));

  const originalInstallments = realInstallments.filter((i) => i.rebillingId === null);
  const groups: InstallmentGroup[] = [];

  if (originalInstallments.length > 0) {
    groups.push({
      key: "original",
      label: "Emisión original",
      rebillingId: null,
      billingStart: null,
      billingEnd: null,
      deductible: null,
      installments: originalInstallments,
    });
  }

  // Migración 0035: una refacturación 'duplicada' no se muestra como período
  // activo — ni grupo, ni cuotas, ni proyección. Sigue en `rebillings` (el
  // caller no la filtra) exclusivamente para poder resolverla en
  // extractDuplicateRebillings/la sección de auditoría.
  const rebillingsSorted = [...rebillings]
    .filter((r) => (r.status ?? "activa") !== "duplicada")
    .sort((a, b) => (a.billingStart < b.billingStart ? -1 : a.billingStart > b.billingStart ? 1 : a.id - b.id));

  let n = 1;
  for (const r of rebillingsSorted) {
    const groupInstallments = realInstallments.filter((i) => i.rebillingId === r.id);
    // Una refacturación histórica sin cuotas generadas todavía (el bug que
    // este flujo corrige) igual aparece — con installments: [] — para que se
    // pueda ver y completar desde la UI, no queda oculta.
    groups.push({
      key: String(r.id),
      label: `Refacturación ${n} — ${r.billingStart} a ${r.billingEnd}`,
      rebillingId: r.id,
      billingStart: r.billingStart,
      billingEnd: r.billingEnd,
      deductible: r.deductible,
      installments: groupInstallments,
    });
    n++;
  }

  return groups;
}

/**
 * Cantidad real de cuotas vinculadas a UNA refacturación puntual, exclusivamente
 * por rebilling_id — nunca por installmentCount (metadata que puede ser null
 * aun con cuotas ya vinculadas, o viceversa en datos históricos). Es el mismo
 * criterio de "grupo real" que groupInstallmentsByRebilling, expuesto suelto
 * para usarse en lugares que no necesitan armar todos los grupos (p.ej. la
 * tarjeta de una sola refacturación en la lista de Refacturaciones, que debe
 * verse igual aunque la póliza no tenga NINGUNA cuota en otros grupos).
 */
export function countLinkedInstallments(
  installments: ReadonlyArray<{ rebillingId: number | null; status?: string }>,
  rebillingId: number,
): number {
  // Migración 0035: una cuota duplicada no cuenta como parte real del plan.
  return installments.filter((i) => i.rebillingId === rebillingId && i.status !== "duplicada").length;
}

export interface InstallmentTotals {
  total: number;
  pagadas: number;
  pendientes: number;
  vencidas: number;
  // Migración 0035: informativo — NUNCA sumado a `total` (una duplicada no es
  // parte de la cantidad real del plan).
  duplicadas: number;
}

/**
 * Totales sobre TODAS las cuotas REALES (todos los grupos combinados) — el
 * resumen superior de la página. Migración 0035: `total`/pagadas/pendientes/
 * vencidas excluyen 'duplicada' — `duplicadas` se informa aparte, nunca
 * mezclado en el resto de los conteos.
 */
export function summarizeInstallments(installments: ReadonlyArray<{ status: string }>): InstallmentTotals {
  const real = installments.filter((i) => i.status !== "duplicada");
  return {
    total: real.length,
    pagadas: real.filter((i) => i.status === "pagada").length,
    pendientes: real.filter((i) => i.status === "pendiente").length,
    vencidas: real.filter((i) => i.status === "vencida").length,
    duplicadas: installments.length - real.length,
  };
}

// ─── Auditoría de duplicadas (Migración 0035) ──────────────────────────────

export interface DuplicateInstallmentRecord {
  id: number;
  number: number;
  dueDate: string;
  amount: number;
  rebillingId: number | null;
  duplicateOfInstallmentId: number | null;
  invalidatedAt: number | string | null;
  invalidatedBy: number | null;
  invalidationReason: string | null;
  // Datos de la fila canónica, resueltos por el caller (no siempre está en
  // el mismo array — puede pertenecer a otro grupo/rebillingId).
  canonical: { id: number; number: number; dueDate: string; amount: number } | null;
}

/** Extrae las cuotas 'duplicada' de la póliza, con su canónica ya resuelta — para la sección de auditoría de poliza-detail.tsx. */
export function extractDuplicateInstallments(
  installments: ReadonlyArray<GroupableInstallment>,
): DuplicateInstallmentRecord[] {
  const byId = new Map(installments.map((i) => [i.id, i]));
  return installments
    .filter((i) => i.status === "duplicada")
    .map((i) => {
      const canonical = i.duplicateOfInstallmentId != null ? byId.get(i.duplicateOfInstallmentId) ?? null : null;
      return {
        id: i.id, number: i.number, dueDate: i.dueDate, amount: i.amount, rebillingId: i.rebillingId,
        duplicateOfInstallmentId: i.duplicateOfInstallmentId ?? null,
        invalidatedAt: i.invalidatedAt ?? null,
        invalidatedBy: i.invalidatedBy ?? null,
        invalidationReason: i.invalidationReason ?? null,
        canonical: canonical ? { id: canonical.id, number: canonical.number, dueDate: canonical.dueDate, amount: canonical.amount } : null,
      };
    });
}

export interface DuplicateRebillingRecord {
  id: number;
  billingStart: string;
  billingEnd: string;
  duplicateOfRebillingId: number | null;
  invalidatedAt: number | string | null;
  invalidatedBy: number | null;
  invalidationReason: string | null;
  canonical: { id: number; billingStart: string; billingEnd: string } | null;
}

/** Extrae las refacturaciones 'duplicada' de la póliza, con su canónica ya resuelta. */
export function extractDuplicateRebillings(
  rebillingsList: ReadonlyArray<{
    id: number; billingStart: string; billingEnd: string; status?: string;
    duplicateOfRebillingId?: number | null; invalidatedAt?: number | string | null;
    invalidatedBy?: number | null; invalidationReason?: string | null;
  }>,
): DuplicateRebillingRecord[] {
  const byId = new Map(rebillingsList.map((r) => [r.id, r]));
  return rebillingsList
    .filter((r) => r.status === "duplicada")
    .map((r) => {
      const canonical = r.duplicateOfRebillingId != null ? byId.get(r.duplicateOfRebillingId) ?? null : null;
      return {
        id: r.id, billingStart: r.billingStart, billingEnd: r.billingEnd,
        duplicateOfRebillingId: r.duplicateOfRebillingId ?? null,
        invalidatedAt: r.invalidatedAt ?? null,
        invalidatedBy: r.invalidatedBy ?? null,
        invalidationReason: r.invalidationReason ?? null,
        canonical: canonical ? { id: canonical.id, billingStart: canonical.billingStart, billingEnd: canonical.billingEnd } : null,
      };
    });
}
