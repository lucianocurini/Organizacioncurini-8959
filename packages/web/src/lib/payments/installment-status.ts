// Recalcula policy_installments.status a partir de los payments confirmados
// vinculados, después de crear/editar/borrar un payment (Etapa 3A).
//
// Regla: la cuota queda "pagada" solo si existe al menos un payment que sea
// TODAS estas cosas a la vez:
//   - vinculado a esa cuota (installmentId = X);
//   - status = "confirmado" (nunca "anulado" ni "pendiente");
//   - su importe coincide EXACTAMENTE en centavos con el importe de la cuota.
// No alcanza con "cualquier confirmado" — un payment confirmado pero con un
// importe distinto (dato corrupto, o un histórico de antes de que existiera
// esta validación) NO puede justificar "pagada": no hay pago parcial, así
// que un importe que no coincide no es una cuota saldada.
//
// Si no existe ningún payment que cumpla las tres condiciones, la cuota
// vuelve a "pendiente" o "vencida" según la fecha — misma comparación que ya
// usa GET /policies/:id/installments (index.ts) para el update perezoso de
// "vencida": row.dueDate < today (string YYYY-MM-DD, comparación léxica).
//
// No implementa pago parcial: la cuota es binaria (pagada / no pagada), tal
// como funciona hoy el resto del sistema. No modifica datos históricos por
// su cuenta — si un payment viejo no cumple la condición de importe, esta
// función simplemente no lo cuenta como válido; no lo corrige ni lo toca.

import { eq, and } from "drizzle-orm";
import { payments, policyInstallments } from "../../api/database/schema";

export async function recalculateInstallmentPaymentStatus(tx: any, installmentId: number): Promise<void> {
  const installment = await tx
    .select({ dueDate: policyInstallments.dueDate, amount: policyInstallments.amount })
    .from(policyInstallments)
    .where(eq(policyInstallments.id, installmentId))
    .get();
  if (!installment) return; // la cuota ya no existe (p.ej. borrada en la misma operación) — nada que recalcular

  const confirmedPayments = await tx
    .select({ id: payments.id, amount: payments.amount })
    .from(payments)
    .where(and(eq(payments.installmentId, installmentId), eq(payments.status, "confirmado")))
    .all();

  const expectedCents = Math.round(installment.amount * 100);
  const hasValidPayment = confirmedPayments.some((p: any) => Math.round(p.amount * 100) === expectedCents);

  if (hasValidPayment) {
    await tx.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, installmentId));
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const newStatus = installment.dueDate < today ? "vencida" : "pendiente";
  await tx.update(policyInstallments).set({ status: newStatus }).where(eq(policyInstallments.id, installmentId));
}
