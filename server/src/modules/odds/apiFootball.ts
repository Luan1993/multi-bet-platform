import {
  EventStatus,
  OddsProvider,
  ProviderError,
  ProviderEvent,
  ProviderMarket,
} from "./types";

/**
 * Adaptador da API-Football v3 (https://www.api-sports.io/football/docs/)
 *
 * Plano Free (verificado em produção desta integração):
 * - /fixtures aceita o parâmetro `date` (o parâmetro `next` não é liberado);
 * - /odds aceita o parâmetro `fixture`;
 * - limite diário de requisições (100/dia no plano Free) — o serviço de
 *   sincronização usa cache local e intervalos configuráveis para respeitar a cota.
 */

const BASE = "https://v3.football.api-sports.io";

// Ordem de preferção de casas de apostas para leitura das odds
const BOOKMAKER_PREFERENCE = ["bet365", "1xbet", "betano", "williamhill", "unibet", "pinnacle"];

/** Mapeia códigos de status da API para o modelo interno. */
const STATUS_MAP: Record<string, EventStatus> = {
  FT: "finished",
  AET: "finished",
  PEN: "finished",
  LIVE: "live",
  "1H": "live",
  HT: "live",
  "2H": "live",
  ET: "live",
  P: "live",
  INT: "live",
  BT: "live",
  NS: "scheduled",
  TST: "scheduled",
  CST: "scheduled",
  TBD: "postponed",
  PST: "postponed",
  SUSP: "postponed",
  CANC: "cancelled",
  ABD: "cancelled",
  AWO: "cancelled",
};

/** Mapeamento nome do mercado → chave interna + normalização das seleções. */
function mapMarket(betName: string): { marketKey: string; name: string } | null {
  const n = betName.toLowerCase();
  if (n === "match winner" || n === "home/away") return { marketKey: "match_winner", name: "Resultado Final" };
  if (n === "double chance") return { marketKey: "double_chance", name: "Dupla Chance" };
  if (n === "goals over/under") return { marketKey: "goals_over_under", name: "Total de Gols" };
  if (n === "both teams score") return { marketKey: "both_teams_score", name: "Ambas Marcam" };
  if (n === "draw no bet") return { marketKey: "draw_no_bet", name: "Empate Anula" };
  if (n === "ht/ft double") return { marketKey: "ht_ft", name: "Intervalo/Final" };
  return null;
}

const SELECTION_MAP: Record<string, Record<string, { key: string; name: string }>> = {
  match_winner: {
    home: { key: "home", name: "Mandante" },
    draw: { key: "draw", name: "Empate" },
    away: { key: "away", name: "Visitante" },
  },
  double_chance: {
    "home/draw": { key: "home_draw", name: "Mandante ou Empate" },
    "home/away": { key: "home_away", name: "Mandante ou Visitante" },
    "draw/away": { key: "draw_away", name: "Empate ou Visitante" },
  },
  both_teams_score: {
    yes: { key: "yes", name: "Sim" },
    no: { key: "no", name: "Não" },
  },
  draw_no_bet: {
    home: { key: "home", name: "Mandante" },
    away: { key: "away", name: "Visitante" },
  },
  ht_ft: {
    "home/home": { key: "home_home", name: "Mandante / Mandante" },
    "home/draw": { key: "home_draw", name: "Mandante / Empate" },
    "home/away": { key: "home_away", name: "Mandante / Visitante" },
    "draw/home": { key: "draw_home", name: "Empate / Mandante" },
    "draw/draw": { key: "draw_draw", name: "Empate / Empate" },
    "draw/away": { key: "draw_away", name: "Empate / Visitante" },
    "away/home": { key: "away_home", name: "Visitante / Mandante" },
    "away/draw": { key: "away_draw", name: "Visitante / Empate" },
    "away/away": { key: "away_away", name: "Visitante / Visitante" },
  },
};

function mapSelection(marketKey: string, apiValue: string): { key: string; name: string } | null {
  const v = apiValue.toLowerCase().trim();
  if (marketKey === "goals_over_under") {
    // Valores como "Over 2.5" / "Under 2.5"
    const m = /^(over|under)\s*([0-9]+(?:\.[05])?)$/.exec(v);
    if (m) {
      const side = m[1] === "over" ? "over" : "under";
      const line = Number(m[2]);
      return { key: `${side}_${line}`, name: `${side === "over" ? "Mais" : "Menos"} de ${m[2]} gols` };
    }
    return null;
  }
  const map = SELECTION_MAP[marketKey];
  return map?.[v] ?? null;
}

interface ApiFixture {
  fixture: { id: number; date: string; timestamp: number; status: { short: string } };
  league: { id: number; name: string; country: string; logo: string; season: number };
  teams: {
    home: { id: number; name: string; logo: string };
    away: { id: number; name: string; logo: string };
  };
  goals: { home: number | null; away: number | null };
}

interface ApiOdds {
  response: Array<{
    league: { id: number };
    fixture: { id: number };
    update: string;
    bookmakers: Array<{
      id: number;
      name: string;
      bets: Array<{ id: number; name: string; values: Array<{ value: string; odd: string }> }>;
    }>;
  }>;
  errors: Array<{ message: string }> | Record<string, never>;
}

export class ApiFootballProvider implements OddsProvider {
  readonly id = "api-football";
  readonly label = "API-Football (api-sports.io)";
  isDemo = false;

  constructor(private readonly apiKey: string) {}

  private async api<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        headers: { "x-apisports-key": this.apiKey },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ProviderError(
        `Falha de rede ao consultar a API-Football: ${(err as Error).message}`,
        "unavailable"
      );
    }
    if (res.status === 429 || res.status === 403) {
      const body = await res.text().catch(() => "");
      if (/limit/i.test(body) || res.status === 429) {
        throw new ProviderError(
          "Cota diária da API-Football atingida. Sincronização pausada até a renovação.",
          "quota"
        );
      }
      throw new ProviderError("Chave da API-Football recusada (403). Verifique a configuração.", "unavailable", false);
    }
    if (!res.ok) {
      throw new ProviderError(`API-Football respondeu HTTP ${res.status}.`, "http");
    }
    return (await res.json()) as T;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const data = await this.api<{ response: unknown[]; errors: unknown }>("/status");
      const errors = Array.isArray(data.errors) ? data.errors : [];
      if (errors.length > 0) {
        return { ok: false, message: `API-Football: ${JSON.stringify(errors)}` };
      }
      const acct = (data.response as Array<{ account?: { email?: string } }>)[0]?.account;
      return {
        ok: true,
        message: `Conectado à API-Football${acct?.email ? ` (${acct.email})` : ""}.`,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async fetchUpcomingEvents(days: number): Promise<ProviderEvent[]> {
    const clamped = Math.min(Math.max(days, 1), 3); // plano Free: 1 requisição por dia consultado
    const events: ProviderEvent[] = [];
    const today = new Date();
    for (let i = 0; i < clamped; i++) {
      const d = new Date(today.getTime() + i * 24 * 3600 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const data = await this.api<{ response: ApiFixture[]; errors: Array<{ message: string }> }>(
        `/fixtures?date=${dateStr}`
      );
      const errs = Array.isArray(data.errors) ? data.errors : [];
      if (errs.length > 0 && (!data.response || data.response.length === 0)) {
        throw new ProviderError(`API-Football: ${errs[0].message}`, "http");
      }
      for (const f of data.response ?? []) {
        const status = STATUS_MAP[f.fixture.status.short] ?? "scheduled";
        events.push({
          providerFixtureId: String(f.fixture.id),
          sport: { providerSportId: "soccer", name: "Futebol", slug: "futebol" },
          competition: {
            providerCompetitionId: String(f.league.id),
            name: f.league.name,
            country: f.league.country,
            logoUrl: f.league.logo,
            season: String(f.league.season),
          },
          home: { name: f.teams.home.name, logoUrl: f.teams.home.logo },
          away: { name: f.teams.away.name, logoUrl: f.teams.away.logo },
          kickoffAt: new Date(f.fixture.timestamp * 1000),
          status,
          homeScore: f.goals.home,
          awayScore: f.goals.away,
        });
      }
    }
    return events;
  }

  async fetchOdds(providerFixtureId: string): Promise<ProviderMarket[]> {
    const data = await this.api<ApiOdds>(`/odds?fixture=${encodeURIComponent(providerFixtureId)}`);
    const entry = data.response?.[0];
    if (!entry || !Array.isArray(entry.bookmakers) || entry.bookmakers.length === 0) {
      return []; // odds ainda não publicadas para este evento
    }
    // Ordena casas pela preferência
    const books = [...entry.bookmakers].sort((a, b) => {
      const ia = BOOKMAKER_PREFERENCE.indexOf(a.name.toLowerCase().replace(/\s/g, ""));
      const ib = BOOKMAKER_PREFERENCE.indexOf(b.name.toLowerCase().replace(/\s/g, ""));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    const markets = new Map<string, ProviderMarket>();
    for (const book of books) {
      for (const bet of book.bets ?? []) {
        const mapped = mapMarket(bet.name);
        if (!mapped) continue;
        if (markets.has(mapped.marketKey)) continue; // primeira casa da preferência vence
        const sels: ProviderMarket["selections"] = [];
        for (const v of bet.values ?? []) {
          const sel = mapSelection(mapped.marketKey, v.value);
          const odd = Number(v.odd);
          if (!sel || !Number.isFinite(odd) || odd < 1.01) continue;
          if (!sels.some((s) => s.providerSelectionKey === sel.key)) {
            sels.push({ providerSelectionKey: sel.key, name: sel.name, odd: Math.round(odd * 10000) / 10000 });
          }
        }
        if (sels.length >= 2) {
          markets.set(mapped.marketKey, {
            providerMarketId: `${mapped.marketKey}`,
            marketKey: mapped.marketKey,
            name: mapped.name,
            selections: sels,
          });
        }
      }
    }
    return [...markets.values()];
  }
}
