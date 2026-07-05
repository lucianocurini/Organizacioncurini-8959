// Validación y normalización pura de payment_splits (Etapa 3A). Sin DB, sin
// efectos secundarios — recibe datos explícitos y devuelve datos explícitos,
// mismo estilo que src/lib/installments/plan.ts.
//
// Esta función NO decide cuántos splits acepta un endpoint (esta etapa acepta
// solo 1 — ver POST /payments en index.ts) — eso es una regla de negocio de
// la ruta, no de esta validación genérica, que ya soporta N>=1 splits para
// cuando la Etapa 3B habilite medios combinados.

export class SplitValidationError extends Error {}

// "combinado" queda deliberadamente fuera de esta lista — Etapa 3A no lo
// introduce como valor de payments.paymentMethod ni como método de un split
// individual (un split siempre es un medio real, nunca la etiqueta resumen).
// Exportado para que la migración 0019 valide con el MISMO criterio los
// splits ya existentes (no solo los que ella misma backfillea) — una sola
// fuente de verdad, no dos listas que puedan desalinearse.
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "efectivo", "transferencia", "cheque", "link_pago", "transferencia_compania",
]);

export function isAllowedPaymentMethod(method: string): boolean {
  return ALLOWED_METHODS.has(method);
}

export interface SplitInput {
  method: string;
  amount: number;
  notes?: string | null;
}

export interface ValidatedSplit {
  method: string;
  amountCents: number;
  notes: string | null;
}

export interface ValidateSplitsInput {
  paymentAmount: number;
  splits: SplitInput[];
}

export interface ValidateSplitsResult {
  totalCents: number;
  splits: ValidatedSplit[];
}

// Tolerancia para el error de representación binaria de JS (ej. 19.99*100 =
// 1998.9999999999998), sin llegar a aceptar una tercera cifra decimal real
// (ej. 100.005 -> dista 0.5 de su entero más cercano, muy por fuera de esto).
// Exportada para que la migración 0019 use exactamente el mismo criterio al
// decidir si un payment histórico puede representarse en centavos.
export function isMultipleOfCent(amount: number): boolean {
  const rounded = Math.round(amount * 100) / 100;
  return Math.abs(rounded - amount) < 1e-9;
}

/**
 * Valida y normaliza un desglose de medios de pago contra el importe total
 * del pago. No muta `input` ni ninguno de sus elementos — siempre construye
 * un array nuevo. Lanza SplitValidationError (con un mensaje listo para
 * mostrar) ante cualquier problema; no devuelve resultados parciales.
 */
export function validateAndNormalizeSplits(input: ValidateSplitsInput): ValidateSplitsResult {
  // Number(...) acá adentro (no confiar en que el caller ya coirció): un
  // string numérico como "1000" es un caso real posible si el body llega sin
  // pasar por JSON.parse con tipos nativos (o desde un test). Number(x) sobre
  // un valor ya numérico es un no-op — no cambia el comportamiento existente.
  const paymentAmount = Number(input.paymentAmount);
  const { splits } = input;

  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
    throw new SplitValidationError(`El importe del pago es inválido: ${input.paymentAmount}.`);
  }

  if (!Array.isArray(splits) || splits.length === 0) {
    throw new SplitValidationError("Debe indicarse al menos un medio de pago.");
  }

  const normalized: ValidatedSplit[] = splits.map((s, i) => {
    const label = `ítem ${i + 1}`;
    const method = typeof s.method === "string" ? s.method.trim() : "";
    const amount = Number(s.amount);

    if (!method) {
      throw new SplitValidationError(`El medio de pago del ${label} no puede estar vacío.`);
    }
    if (!ALLOWED_METHODS.has(method)) {
      throw new SplitValidationError(`Medio de pago no permitido en el ${label}: "${method}".`);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new SplitValidationError(`El importe del ${label} (${method}) debe ser un número mayor a cero.`);
    }
    if (!isMultipleOfCent(amount)) {
      throw new SplitValidationError(`El importe del ${label} (${method}) no puede tener más de dos decimales: ${s.amount}.`);
    }

    return {
      method,
      amountCents: Math.round(amount * 100),
      notes: typeof s.notes === "string" && s.notes.trim() ? s.notes.trim() : null,
    };
  });

  const totalCents = normalized.reduce((sum, s) => sum + s.amountCents, 0);
  const expectedCents = Math.round(paymentAmount * 100);

  if (totalCents !== expectedCents) {
    throw new SplitValidationError(
      `La suma de los medios ($${(totalCents / 100).toFixed(2)}) no coincide con el importe del pago ($${(expectedCents / 100).toFixed(2)}).`
    );
  }

  return { totalCents, splits: normalized };
}
