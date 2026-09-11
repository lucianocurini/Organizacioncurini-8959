// Helper puro compartido — reparto de centavos enteros sin drift (método del
// resto mayor / Hamilton). Extraído de caja-summary.ts (Etapa 0 del diseño de
// cuenta corriente con titular — ver diagnóstico de diseño cerrado en la
// conversación de sobrantes/faltantes con titular de cuenta, 2026-09).
// Comportamiento público idéntico al de la función privada original: mismo
// nombre, misma firma, mismo algoritmo — solo cambia de archivo para poder
// reutilizarse desde account-holder-funding.ts sin duplicar la lógica.

/**
 * Reparte totalCents en centavos ENTEROS entre weights, sin drift (método
 * del resto mayor / Hamilton — floor de cada porción proporcional, y el
 * remanente entero se asigna a quienes tienen el resto fraccionario más
 * grande). Garantiza sum(resultado) === totalCents exacto.
 */
export function apportionCents(totalCents: number, weights: ReadonlyArray<number>): number[] {
  const sumWeights = weights.reduce((s, w) => s + w, 0);
  if (sumWeights <= 0 || totalCents <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / sumWeights);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = totalCents - floors.reduce((s, f) => s + f, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i]! }))
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++) {
    result[order[k]!.i]! += 1;
    remainder--;
  }
  return result;
}
