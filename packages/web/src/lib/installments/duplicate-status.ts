// Constantes y predicados compartidos para la invalidación trazable de
// cuotas/refacturaciones duplicadas (Migración 0035). Un solo lugar para el
// valor "duplicada" — cualquier consumidor que necesite excluirlo o
// reconocerlo importa de acá, en vez de repetir el string literal en cada
// archivo (motivo explícito del pedido: evitar que "duplicada" se cuele por
// una consulta que solo excluye ALGUNOS estados a mano).
//
// Una fila 'duplicada' NUNCA es: exigible, vencida, cobrable, rendible, ni
// parte de la cantidad real del plan — pero SIEMPRE debe seguir existiendo
// (nunca se borra) para auditoría, con duplicateOf*/invalidatedAt/By/reason
// completos. Ver src/api/migrations/0035_traceable_duplicate_invalidation.sql.

import { ne } from "drizzle-orm";
import { policyInstallments, rebillings } from "../../api/database/schema";

export const INSTALLMENT_DUPLICATE_STATUS = "duplicada" as const;
export const REBILLING_DUPLICATE_STATUS = "duplicada" as const;

export function isInstallmentDuplicate(status: string): boolean {
  return status === INSTALLMENT_DUPLICATE_STATUS;
}

export function isRebillingDuplicate(status: string): boolean {
  return status === REBILLING_DUPLICATE_STATUS;
}

/** Condición Drizzle lista para agregar a un `.where(and(...))` existente. */
export function excludeDuplicateInstallments() {
  return ne(policyInstallments.status, INSTALLMENT_DUPLICATE_STATUS);
}

export function excludeDuplicateRebillings() {
  return ne(rebillings.status, REBILLING_DUPLICATE_STATUS);
}
