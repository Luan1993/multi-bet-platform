/**
 * Catálogo e validação das odds manuais definidas pelo proprietário.
 *
 * As odds manuais ficam em mercados com `provider_market_id = 'manual'` e
 * têm prioridade sobre o provedor para a mesma chave de mercado. Elas não
 * expiram (valem até o jogo começar ou até serem alteradas/removidas).
 *
 * Nunca inventamos odds: aqui apenas validamos e normalizamos números
 * informados pelo operador.
 */

export interface ManualSelectionInput {
  key: string;
  odd: number;
}

export interface ManualMarketInput {
  marketKey: string;
  selections: ManualSelectionInput[];
}

export interface NormalizedManualSelection {
  key: string;
  name: string;
  odd: number;
}

export interface NormalizedManualMarket {
  marketKey: string;
  name: string;
  sortOrder: number;
  selections: NormalizedManualSelection[];
}

export class ManualMarketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualMarketError";
  }
}

interface MarketDef {
  name: string;
  sortOrder: number;
  kind: "1x2" | "over_under";
  /** Unidade usada nos nomes das seleções (ex.: "gols"). */
  unit?: string;
}

/** Ordem em que os mercados manuais aparecem na página pública. */
export const MANUAL_MARKET_DEFS: Record<string, MarketDef> = {
  match_winner: { name: "Resultado Final", sortOrder: -5, kind: "1x2" },
  goals_over_under: { name: "Total de Gols", sortOrder: -4, kind: "over_under", unit: "gols" },
  cards_over_under: { name: "Total de Cartões", sortOrder: -3, kind: "over_under", unit: "cartões" },
  corners_over_under: { name: "Total de Escanteios", sortOrder: -2, kind: "over_under", unit: "escanteios" },
  shots_on_goal_over_under: {
    name: "Chutes a Gol",
    sortOrder: -1,
    kind: "over_under",
    unit: "chutes a gol",
  },
};

export const MANUAL_MARKET_KEYS = Object.keys(MANUAL_MARKET_DEFS);

const OU_KEY_RE = /^(over|under)[._-]?(\d+(?:[.,]\d{1,2})?)$/i;
const WINNER_LABELS: Record<string, string> = {
  home: "Mandante",
  draw: "Empate",
  away: "Visitante",
};

function roundOdd(odd: number): number {
  return Math.round(odd * 10000) / 10000;
}

function assertOdd(odd: number): number {
  if (!Number.isFinite(odd) || odd < 1.01 || odd > 1000) {
    throw new ManualMarketError("Cada odd deve estar entre 1.01 e 1000.");
  }
  return roundOdd(odd);
}

function normalizeWinner(input: ManualMarketInput): NormalizedManualMarket {
  const found = new Map<string, number>();
  for (const s of input.selections) {
    const key = s.key.toLowerCase().trim();
    if (!(key in WINNER_LABELS)) {
      throw new ManualMarketError("Resultado Final aceita apenas Mandante, Empate e Visitante.");
    }
    if (found.has(key)) throw new ManualMarketError(`Seleção repetida: ${key}.`);
    found.set(key, assertOdd(s.odd));
  }
  const missing = ["home", "draw", "away"].filter((k) => !found.has(k));
  if (missing.length > 0) {
    throw new ManualMarketError("Informe as três odds do Resultado Final (Mandante, Empate e Visitante).");
  }
  return {
    marketKey: "match_winner",
    name: MANUAL_MARKET_DEFS.match_winner.name,
    sortOrder: MANUAL_MARKET_DEFS.match_winner.sortOrder,
    selections: ["home", "draw", "away"].map((key) => ({
      key,
      name: WINNER_LABELS[key],
      odd: found.get(key)!,
    })),
  };
}

function normalizeOverUnder(input: ManualMarketInput, def: MarketDef): NormalizedManualMarket {
  const byLine = new Map<string, { over?: number; under?: number }>();

  for (const s of input.selections) {
    const match = OU_KEY_RE.exec(s.key.trim());
    if (!match) {
      throw new ManualMarketError(
        `${def.name}: use seleções no formato "over_2.5" e "under_2.5".`
      );
    }
    const side = match[1].toLowerCase() as "over" | "under";
    const line = Number(match[2].replace(",", "."));
    if (!Number.isFinite(line) || line <= 0 || line > 20) {
      throw new ManualMarketError(`${def.name}: linha de valor inválida.`);
    }
    const lineKey = String(line);
    const entry = byLine.get(lineKey) ?? {};
    if (entry[side] !== undefined) {
      throw new ManualMarketError(`${def.name}: seleção repetida (${side} ${lineKey}).`);
    }
    entry[side] = assertOdd(s.odd);
    byLine.set(lineKey, entry);
  }

  if (byLine.size === 0) {
    throw new ManualMarketError(`${def.name}: informe ao menos uma linha de odds.`);
  }
  if (byLine.size > 3) {
    throw new ManualMarketError(`${def.name}: use no máximo 3 linhas.`);
  }

  const lines = [...byLine.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  const selections: NormalizedManualSelection[] = [];

  for (const [line, value] of lines) {
    if (value.over === undefined || value.under === undefined) {
      throw new ManualMarketError(
        `${def.name}: informe as odds de "Mais" e "Menos" para a linha ${line}.`
      );
    }
    selections.push(
      { key: `over_${line}`, name: `Mais de ${line} ${def.unit}`, odd: value.over },
      { key: `under_${line}`, name: `Menos de ${line} ${def.unit}`, odd: value.under }
    );
  }

  return {
    marketKey: input.marketKey,
    name: def.name,
    sortOrder: def.sortOrder,
    selections,
  };
}

/**
 * Valida a lista recebida do painel e devolve os mercados na ordem de exibição.
 * Lista vazia é válida e significa "remover todas as odds manuais".
 */
export function normalizeManualMarkets(input: ManualMarketInput[]): NormalizedManualMarket[] {
  const seen = new Set<string>();
  const result: NormalizedManualMarket[] = [];

  for (const market of input) {
    if (!MANUAL_MARKET_DEFS[market.marketKey]) {
      throw new ManualMarketError(`Mercado não suportado: ${market.marketKey}.`);
    }
    if (seen.has(market.marketKey)) {
      throw new ManualMarketError(`Mercado repetido: ${market.marketKey}.`);
    }
    seen.add(market.marketKey);
  }

  for (const [marketKey, def] of Object.entries(MANUAL_MARKET_DEFS)) {
    if (!seen.has(marketKey)) continue;
    const market = input.find((m) => m.marketKey === marketKey)!;
    result.push(
      def.kind === "1x2"
        ? normalizeWinner(market)
        : normalizeOverUnder({ ...market, marketKey }, def)
    );
  }

  return result;
}
