// Lectura de saldo activo de un titular de cuenta para la UI de "Cobrar en
// lote" (Etapa 1B-4) — GET /insureds/:id/account-holder-balance. Sin
// escrituras. Wrapea loadActiveAccountHolderBalanceCents
// (account-holder-funding-batch.ts, ya testeado con movimientos activos/
// anulados) con el mismo chequeo de existencia real que ya usa POST
// /payment-batches en modo titular (index.ts) — nunca confía en que el id de
// la URL exista: sin este chequeo, un id inexistente devolvería
// silenciosamente saldo=0 (ninguna fila en insured_account_movements), en vez
// de un 404 explícito.
//
// Separado de index.ts para poder testearse con SQLite temporal sin la
// infraestructura de aislamiento de proceso que exige tocar los singletons
// `app`/`database` globales (ver cabecera de
// payment-batch-titular-endpoint.test.ts) — mismo criterio de testabilidad
// que el resto de src/api/*.ts de esta etapa.

import { eq } from "drizzle-orm";
import { insureds } from "./database/schema";
import { loadActiveAccountHolderBalanceCents, type AccountHolderFundingDbClient } from "./account-holder-funding-batch";

export interface AccountHolderBalanceSummary {
  insuredId: number;
  /** Saldo real activo, con signo (puede ser negativo si el titular ya debe plata) — ver loadActiveAccountHolderBalanceCents. */
  balanceCents: number;
  /** max(0, balanceCents) — el único tope que puede aplicarse como crédito nuevo (mismo clamp que planFundingWithFreshBalance). */
  availableCreditCents: number;
}

/**
 * null si el asegurado no existe — el caller (endpoint) lo traduce a 404.
 * Nunca lanza por "no encontrado".
 */
export async function loadAccountHolderBalanceSummary(
  dbClient: AccountHolderFundingDbClient,
  insuredId: number
): Promise<AccountHolderBalanceSummary | null> {
  const insuredRow = await dbClient.select({ id: insureds.id }).from(insureds).where(eq(insureds.id, insuredId)).get();
  if (!insuredRow) return null;

  const balanceCents = await loadActiveAccountHolderBalanceCents(dbClient, insuredId);
  return { insuredId, balanceCents, availableCreditCents: Math.max(0, balanceCents) };
}
