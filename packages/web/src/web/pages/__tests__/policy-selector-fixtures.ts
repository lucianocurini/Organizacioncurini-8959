// Fixtures compartidas por los tests jsdom de "Imputar pago": convierte filas
// mínimas {policy, insured, company} en filas de
// GET /api/policies/collectable-for-payment (todas en posición cobrable).
export function asCollectableSelectorRows(rows: ReadonlyArray<any>): any[] {
  return rows.map((r) => ({
    collectable: true, via: "poliza_vigente", reason: null, hasCollectableInstallments: true, accessory: null,
    ...r,
    policy: {
      status: "activa", type: "automotor", parentPolicyId: null, startDate: null, endDate: null,
      insuredId: r.insured?.id ?? null, companyId: r.company?.id ?? null,
      ...r.policy,
    },
  }));
}

export const COLLECTABLE_POLICIES_PATH = "/api/policies/collectable-for-payment";
