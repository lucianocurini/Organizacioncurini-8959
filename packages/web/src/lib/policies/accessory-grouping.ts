// Agrupación de accesorias bajo su principal para PROYECCIONES y COLAS del
// reporte (puro, sin DB ni I/O). Nunca se usa para movimientos reales,
// cuotas, deudas, pagos ni rendiciones: esos siguen siendo de cada póliza.
//
// Una accesoria con vínculo válido (accessory-link.ts) se suma a la fila de
// su principal: un solo movimiento, prima = principal + accesorias, cada una
// exactamente una vez. Si la principal no está en el mismo conjunto (p. ej.
// ya tiene sucesora real y no se proyecta), la accesoria conserva su propia
// fila: nunca se oculta en silencio.

import { evaluateAccessoryLink, type AccessoryLinkPolicy, type AccessoryLinkResult } from "./accessory-link";

/** Resultado del vínculo de cada accesoria (parentPolicyId != null) de `rows`, por id de accesoria. */
export function classifyAccessoryLinks(
  rows: AccessoryLinkPolicy[],
  parentsById: Map<number, AccessoryLinkPolicy>,
  today: string,
): Map<number, AccessoryLinkResult> {
  const out = new Map<number, AccessoryLinkResult>();
  for (const r of rows) {
    if (r.parentPolicyId == null) continue;
    out.set(r.id, evaluateAccessoryLink(r, parentsById.get(r.parentPolicyId) ?? null, today));
  }
  return out;
}

export interface GroupableRow {
  id: number;
  parentPolicyId: number | null;
  premium: number | null;
}

export type GroupedRow<T> = T & {
  /** Prima del movimiento agrupado: principal + accesorias, cada una una vez (null si ninguna tiene). */
  groupPremium: number | null;
  accessoryCount: number;
  accessoryIds: number[];
};

export function groupAccessoriesUnderPrincipals<T extends GroupableRow>(
  rows: T[],
  links: Map<number, AccessoryLinkResult>,
): GroupedRow<T>[] {
  const present = new Set(rows.map((r) => r.id));
  const attached = new Map<number, T[]>();
  const own: T[] = [];
  for (const r of rows) {
    const link = links.get(r.id);
    if (r.parentPolicyId != null && link?.valid && present.has(r.parentPolicyId) && r.parentPolicyId !== r.id) {
      const list = attached.get(r.parentPolicyId) ?? [];
      list.push(r);
      attached.set(r.parentPolicyId, list);
    } else {
      own.push(r);
    }
  }
  return own.map((r) => {
    const acc = attached.get(r.id) ?? [];
    const premiums = [r, ...acc].map((x) => x.premium).filter((x): x is number => x != null);
    return {
      ...r,
      groupPremium: premiums.length > 0 ? Math.round(premiums.reduce((s, x) => s + x, 0) * 100) / 100 : null,
      accessoryCount: acc.length,
      accessoryIds: acc.map((x) => x.id),
    };
  });
}
