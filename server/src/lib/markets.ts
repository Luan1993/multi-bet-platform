/**
 * Regras de incompatibilidade entre seleções do mesmo mercado.
 * (item 6/8: o cupom não pode conter escolhas que não podem ocorrer juntas)
 *
 * Exemplos:
 *  - "Mais de 1.5" e "Menos de 1.5" no Total de Gols → IMPOSSÍVEL (nunca ocorrem juntos);
 *  - "Mandante" e "Empate" no Resultado Final → IMPOSSÍVEL;
 *  - "Mais de 1.5" e "Menos de 3.5" no Total de Gols → POSSÍVEL (2 ou 3 gols satisfazem ambos);
 *  - "Mandante" (Resultado Final) + "Mandante ou Empate" (Dupla Chance) → POSSÍVEL (mercados distintos).
 *
 * A regra vale apenas dentro do MESMO mercado do MESMO evento (identificado por market_id).
 */

export interface SelectionConflictInput {
  id: number;
  marketId: number;
  marketKey: string;
  selectionKey: string;
}

export interface ConflictPair {
  marketId: number;
  marketKey: string;
  a: SelectionConflictInput;
  b: SelectionConflictInput;
}

/** Intervalo de placares (gols) possíveis representado por uma seleção over/under. */
interface GoalInterval {
  min: number; // inclusivo (-Infinity para seleções "under")
  max: number; // inclusivo (+Infinity para seleções "over")
}

const GOAL_KEY_RE = /^(over|under)[._-]?(\d+(?:[.,]\d+)?)$/i;

function parseGoalInterval(selectionKey: string): GoalInterval | null {
  const m = GOAL_KEY_RE.exec(selectionKey.trim());
  if (!m) return null;
  const side = m[1].toLowerCase();
  const line = Number(m[2].replace(",", "."));
  if (!Number.isFinite(line)) return null;
  // "Over 1.5" = mais de 1.5 gols → no mínimo 2; "Under 1.5" = menos de 1.5 → no máximo 1.
  return side === "over"
    ? { min: Math.floor(line) + 1, max: Number.POSITIVE_INFINITY }
    : { min: Number.NEGATIVE_INFINITY, max: Math.ceil(line) - 1 };
}

/**
 * Mesmo mercado + same-market keys que representam intervalos de placar
 * impossíveis de ocorrer juntos → incompatíveis.
 */
export function areSelectionsIncompatible(a: SelectionConflictInput, b: SelectionConflictInput): boolean {
  if (a.marketId !== b.marketId) return false; // mercados diferentes (ou eventos diferentes) podem ser combinados

  const ia = parseGoalInterval(a.selectionKey);
  const ib = parseGoalInterval(b.selectionKey);
  if (ia && ib) return ia.min > ib.max || ib.min > ia.max;

  // Demais mercados: apenas UMA seleção por mercado (ex. Resultado Final,
  // Dupla Chance, Ambas Marcam, Empate Anula, Intervalo/Final).
  return true;
}

/** Verifica se uma seleção confere com uma lista de conflitos por id. */
export function hasConflict(selection: { conflictsWith?: number[] }, candidateId: number): boolean {
  return Array.isArray(selection.conflictsWith) && selection.conflictsWith.includes(candidateId);
}

/**
 * Pares de seleções incompatíveis dentro de um conjunto.
 */
export function findConflictPairs(all: SelectionConflictInput[]): ConflictPair[] {
  const pairs: ConflictPair[] = [];
  const byMarket = new Map<number, SelectionConflictInput[]>();
  for (const s of all) {
    const list = byMarket.get(s.marketId) ?? [];
    list.push(s);
    byMarket.set(s.marketId, list);
  }
  for (const list of byMarket.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (areSelectionsIncompatible(list[i], list[j])) {
          pairs.push({ marketId: list[i].marketId, marketKey: list[i].marketKey, a: list[i], b: list[j] });
        }
      }
    }
  }
  return pairs;
}

/** Mapa id de seleção → ids de seleções incompatíveis (mesmo mercado). */
export function conflictsBySelection(
  marketId: number,
  marketKey: string,
  selections: Array<{ id: number; key: string }>
): Map<number, number[]> {
  const input = selections.map((s) => ({ id: s.id, marketId, marketKey, selectionKey: s.key }));
  const map = new Map<number, number[]>();
  for (const s of selections) map.set(s.id, []);
  for (const pair of findConflictPairs(input)) {
    map.get(pair.a.id)?.push(pair.b.id);
    map.get(pair.b.id)?.push(pair.a.id);
  }
  return map;
}

/** Verdadeiro quando o mercado só permite uma única seleção por evento. */
export function isSinglePickMarket(conflictMap: Map<number, number[]>): boolean {
  const total = conflictMap.size;
  if (total <= 1) return true;
  for (const conflicts of conflictMap.values()) {
    if (conflicts.length !== total - 1) return false;
  }
  return true;
}
