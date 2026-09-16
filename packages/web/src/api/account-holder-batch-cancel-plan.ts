// Fase 2D: seguridad de cuenta corriente al cancelar un lote — extraído de
// index.ts (POST /payment-batches/:id/cancel) SIN cambiar una sola línea de
// lógica, únicamente para poder testear resolveAccountMovementCancelPlan de
// forma aislada contra una base SQLite temporal (Etapa 1B-3-D, regresión de
// cancelación con movimientos del modo titular) sin importar index.ts
// completo (que abriría la conexión real de database/index.ts). El único
// caller sigue siendo loadBatchCancelContext en index.ts, sin cambio de
// comportamiento.
//
// ─── Por qué esta función YA generaliza correctamente al modo titular
// (Etapa 1B-3-C2/D) sin ningún cambio ────────────────────────────────────
//
// No conoce payment_batches.account_holder_insured_id ni ninguna otra noción
// de "titular" — decide únicamente por `type` (saldo_a_favor/saldo_deudor
// vs. el resto) y por el pool GLOBAL de insured_account_movements del mismo
// insuredId (mismo criterio para cualquier origen). Eso es exactamente lo
// que hace falta:
//   - aplicacion_saldo_favor (consumo de crédito, siempre negativo) cae en
//     la rama "se anula sin chequeo adicional" — matemáticamente siempre
//     seguro (anularlo solo AUMENTA el pool disponible, nunca lo reduce),
//     sea legacy o titular.
//   - saldo_deudor/saldo_a_favor (movimientos que AGREGAN al pool) sí
//     corren el chequeo isSafeToCancelAccountMovementOrigin contra el pool
//     global del asegurado — el mismo pool mezcla legacy y titular a
//     propósito (es un único ledger real por asegurado).
// Ver tests de regresión (account-holder-funding-cancellation.test.ts) para
// la confirmación empírica de ambos casos con filas de forma titular.

import { and, eq, ne } from "drizzle-orm";
import { insuredAccountMovements } from "./database/schema";
import { isSafeToCancelAccountMovementOrigin } from "../lib/payments/insured-account";

export interface AccountMovementCancelPlan {
  safe: boolean;
  blockReasons: string[];
  movementIdsToVoid: number[];
}

/**
 * Para cada insured_account_movement activo que este batch (o alguno de sus
 * hijos) originó, decide si anularlo es matemáticamente seguro — ver
 * isSafeToCancelAccountMovementOrigin (insured-account.ts). Un movimiento ya
 * anulado no vuelve a evaluarse (nada que anular de nuevo — idempotencia).
 * Nunca escribe nada: solo decide qué haría falta anular y qué lo bloquea.
 */
export async function resolveAccountMovementCancelPlan(
  dbOrTx: any,
  accountMovements: ReadonlyArray<any>
): Promise<AccountMovementCancelPlan> {
  const activeOwnMovements = accountMovements.filter((m: any) => m.status === "activo");
  if (activeOwnMovements.length === 0) return { safe: true, blockReasons: [], movementIdsToVoid: [] };

  const blockReasons: string[] = [];
  const movementIdsToVoid: number[] = [];

  for (const m of activeOwnMovements as any[]) {
    if (m.type !== "saldo_a_favor" && m.type !== "saldo_deudor") {
      // Otro tipo originado directo por un batch/pago (aplicacion_saldo_favor
      // del modo titular, entre otros) — no consume ni cierra nada del pool
      // por sí mismo, se anula sin chequeo adicional.
      movementIdsToVoid.push(m.id);
      continue;
    }

    // Pool GLOBAL del mismo asegurado, sin este movimiento — nunca se
    // escribe nada acá, solo lectura para decidir.
    const siblingRows = await dbOrTx.select().from(insuredAccountMovements)
      .where(and(eq(insuredAccountMovements.insuredId, m.insuredId), ne(insuredAccountMovements.id, m.id)))
      .all();
    const activeSiblings = (siblingRows as any[]).filter((s) => s.status === "activo");

    const thisOriginAmountCents = Math.abs(m.signedAmountCents);
    let totalActivePoolCents = thisOriginAmountCents;
    let totalActiveConsumptionCents = 0;

    if (m.type === "saldo_a_favor") {
      for (const s of activeSiblings) {
        if (s.type === "saldo_a_favor") totalActivePoolCents += s.signedAmountCents;
        else if (s.type === "aplicacion_saldo_favor" || s.type === "devolucion_saldo_favor") {
          totalActiveConsumptionCents += Math.abs(s.signedAmountCents);
        } else if (s.type === "ajuste_manual" && s.signedAmountCents < 0) {
          totalActiveConsumptionCents += Math.abs(s.signedAmountCents);
        }
      }
    } else {
      // saldo_deudor
      for (const s of activeSiblings) {
        if (s.type === "saldo_deudor") totalActivePoolCents += Math.abs(s.signedAmountCents);
        else if (s.type === "cobro_saldo_deudor") totalActiveConsumptionCents += Math.abs(s.signedAmountCents);
      }
    }

    const safe = isSafeToCancelAccountMovementOrigin({ thisOriginAmountCents, totalActivePoolCents, totalActiveConsumptionCents });
    if (safe) {
      movementIdsToVoid.push(m.id);
    } else {
      blockReasons.push(
        `El movimiento de cuenta corriente ${m.id} (${m.type}) del asegurado ${m.insuredId} ya fue parcial o totalmente ` +
        `consumido/cobrado por otra operación de su cuenta corriente — no se puede determinar de forma segura que ` +
        `anularlo no afecte esa otra operación. Requiere revisión manual antes de anular este cobro.`
      );
    }
  }

  return { safe: blockReasons.length === 0, blockReasons, movementIdsToVoid };
}
