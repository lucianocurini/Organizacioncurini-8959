// Aviso al usuario después de alta, edición, rebuild o borrado de una
// refacturación desde la ficha, a partir de `nextRebillingDateSync` (ver
// src/lib/policies/next-rebilling-sync.ts). Solo hay aviso cuando la próxima
// refacturación quedó sin un valor seguro; si la sincronización fue segura
// (actualizada, sin cambios, explícita respetada) no se muestra nada.
import { formatDate } from "./utils";

export interface NextRebillingSyncLike {
  status?: string | null;
  before?: string | null;
  reasonLabel?: string | null;
}

export function nextRebillingSyncNotice(sync: NextRebillingSyncLike | null | undefined): string | null {
  if (!sync) return null;
  const reason = sync.reasonLabel ? ` Motivo: ${sync.reasonLabel}.` : "";
  if (sync.status === "cleared") {
    return `La próxima refacturación guardada (${formatDate(sync.before)}) quedó sin respaldo y se borró. Requiere revisión manual.${reason}`;
  }
  if (sync.status === "review") {
    return `La próxima refacturación requiere revisión manual: no hay una fecha segura.${reason}`;
  }
  return null;
}
