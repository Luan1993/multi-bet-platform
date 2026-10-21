/**
 * Utilitários de dinheiro e odds.
 * - Valores monetários sempre em centavos (inteiros), evitando erros de ponto flutuante.
 * - Odds em decimal (ex.: 1.85), com precisão de 4 casas no banco.
 */

export function parseCents(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  return null;
}

/** Converte "R$ 1.234,56" ou 1234.56 para centavos. */
export function toCents(value: number | string): number {
  const n = typeof value === "string" ? Number(value.replace(/\./g, "").replace(",", ".")) : value;
  if (!Number.isFinite(n) || n < 0) throw new Error("Valor monetário inválido");
  return Math.round(n * 100);
}

/** Formata centavos como BRL. */
export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Calcula o retorno potencial: stake_centavos × odd combinada.
 * Arredonda para o centavo (meio para cima), como em operações reais.
 */
export function potentialPayoutCents(stakeCents: number, combinedOdd: number): number {
  if (!Number.isFinite(combinedOdd) || combinedOdd <= 0) throw new Error("Odd inválida");
  return Math.round(stakeCents * combinedOdd);
}

/** Produto das odds com normalização de precisão (4 casas). */
export function combineOdds(odds: number[]): number {
  if (odds.length === 0) throw new Error("Nenhuma odd para combinar");
  let acc = 1;
  for (const o of odds) {
    if (!Number.isFinite(o) || o < 1.01) throw new Error(`Odd inválida: ${o}`);
    acc *= o;
  }
  return Math.round(acc * 10000) / 10000;
}

/** Diferença relativa entre odds (para detectar mudança relevante). */
export function oddChanged(a: number, b: number, tolerance = 0.0001): boolean {
  return Math.abs(a - b) > tolerance;
}
