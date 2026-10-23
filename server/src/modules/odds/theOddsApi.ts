import { config } from "../../config";
import {
  OddsProvider,
  ProviderError,
  ProviderEvent,
  ProviderMarket,
} from "./types";

/**
 * Adaptador da The Odds API v4 — https://the-odds-api.com/liveapi/guides/v4/
 *
 * Particularidades:
 * - A cota é cobrada por `mercado × região × requisição`. Para economizar,
 *   buscamos TODOS os eventos e odds de uma liga em uma única requisição e
 *   guardamos em cache (compartilhado entre instâncias do provedor).
 * - `fetchOdds` NÃO faz chamada à API: devolve o que veio na última
 *   sincronização. Assim a aceitação de cupons nunca consome cota extra.
 * - O plano gratuito tem 500 créditos/mês. A quantidade de ligas, mercados e
 *   o intervalo de atualização são configuráveis por variáveis de ambiente.
 * - Nunca inventamos odds: se a liga/evento não tiver odds, o evento aparece
 *   sem mercados.
 */

const BASE = "https://api.the-odds-api.com/v4";

const DEFAULT_SPORTS = [
  "soccer_brazil_campeonato",
  "soccer_conmebol_copa_libertadores",
  "soccer_epl",
];

const DEFAULT_MARKETS = ["h2h", "totals"];
const DEFAULT_REGIONS = "eu";

/** Casas de apostas preferidas para compor as odds exibidas. */
const BOOKMAKER_PREFERENCE = [
  "pinnacle",
  "onexbet",
  "betfair_ex_eu",
  "williamhill",
  "betsson",
  "coolbet",
  "marathonbet",
  "unibet_nl",
  "unibet_se",
];

const MAX_TOTAL_LINES = 2;
const PREFERRED_TOTAL_LINE = 2.5;

interface ApiOutcome {
  name: string;
  price: number;
  point?: number;
}

interface ApiMarket {
  key: string;
  last_update?: string;
  outcomes?: ApiOutcome[];
}

interface ApiBookmaker {
  key: string;
  title: string;
  last_update?: string;
  markets?: ApiMarket[];
}

interface ApiEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: ApiBookmaker[];
}

export interface TheOddsApiOptions {
  sports?: string[];
  markets?: string[];
  regions?: string;
  cacheMinutes?: number;
}

interface CachedOdds {
  markets: ProviderMarket[];
  updatedAt: Date;
}

interface Cache {
  apiKey: string;
  at: number;
  events: ProviderEvent[];
  odds: Map<string, CachedOdds>;
  quotaRemaining: number | null;
}

/**
 * Cache compartilhado por todas as instâncias: `resolveProvider` cria um novo
 * provedor a cada minuto, e o agendador roda com frequência. Sem cache global
 * cada sincronização consumiria a cota da API.
 */
let cache: Cache | null = null;

/** Usado apenas em testes para isolar cenários. */
export function __resetTheOddsApiCache(): void {
  cache = null;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function formatPoint(point: number): string {
  return Number.isInteger(point) ? String(point) : String(point).replace(",", ".");
}

export class TheOddsApiProvider implements OddsProvider {
  readonly id = "the-odds-api";
  readonly label = "The Odds API";
  isDemo = false;

  private readonly sports: string[];
  private readonly markets: string[];
  private readonly regions: string;
  private readonly cacheMinutes: number;
  private quotaRemaining: number | null = null;

  constructor(
    private readonly apiKey: string,
    options: TheOddsApiOptions = {}
  ) {
    this.sports = options.sports?.length ? options.sports : DEFAULT_SPORTS;
    this.markets = options.markets?.length ? options.markets : DEFAULT_MARKETS;
    this.regions = options.regions || DEFAULT_REGIONS;
    this.cacheMinutes = options.cacheMinutes ?? 540;
  }

  private async api<T>(path: string): Promise<T> {
    const separator = path.includes("?") ? "&" : "?";
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}${separator}apiKey=${encodeURIComponent(this.apiKey)}`, {
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ProviderError(
        `Falha de rede ao consultar a The Odds API: ${(err as Error).message}`,
        "unavailable"
      );
    }

    const remaining = res.headers.get("x-requests-remaining");
    if (remaining !== null && Number.isFinite(Number(remaining))) {
      this.quotaRemaining = Number(remaining);
    }

    if (res.ok) return (await res.json()) as T;

    const body = await res.text().catch(() => "");
    let message = "";
    try {
      message = (JSON.parse(body) as { message?: string }).message ?? "";
    } catch {
      message = body.slice(0, 200);
    }

    if (res.status === 429) {
      throw new ProviderError(
        `Cota da The Odds API esgotada (${message || "limite de requisições atingido"}).`,
        "quota"
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(
        `Chave da The Odds API recusada. Confira a variável THE_ODDS_API_KEY.${message ? ` (${message})` : ""}`,
        "invalid",
        false
      );
    }
    if (res.status === 422) {
      throw new ProviderError(
        `The Odds API recusou os parâmetros da consulta (liga/mercado inválido).${message ? ` (${message})` : ""}`,
        "invalid",
        false
      );
    }
    throw new ProviderError(
      `The Odds API respondeu HTTP ${res.status}.${message ? ` (${message})` : ""}`,
      "http"
    );
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      // /sports não consome créditos.
      const sports = await this.api<Array<{ key: string; title: string; active: boolean }>>("/sports/");
      const soccer = sports.filter((s) => s.key.startsWith("soccer_") && s.active);
      const missing = this.sports.filter((key) => !soccer.some((s) => s.key === key));

      const parts = [
        `Conectado à The Odds API (${soccer.length} ligas de futebol ativas).`,
        `Ligas monitoradas: ${this.sports.length === 1 ? this.sports[0] : `${this.sports.length}`}.`,
      ];
      if (this.quotaRemaining !== null) {
        parts.push(`Créditos restantes: ${this.quotaRemaining}.`);
      }
      if (missing.length > 0) {
        parts.push(`Atenção: liga(s) indisponível(is) no momento: ${missing.join(", ")}.`);
      }
      return { ok: true, message: parts.join(" ") };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async fetchUpcomingEvents(days: number): Promise<ProviderEvent[]> {
    const ttlMs = Math.max(this.cacheMinutes, 1) * 60_000;
    const fresh =
      cache && cache.apiKey === this.apiKey && Date.now() - cache.at < ttlMs;

    if (!fresh) {
      await this.refresh(days);
    }

    const windowMs = Math.max(days, 1) * 24 * 3600_000;
    const now = Date.now();
    return (cache?.events ?? []).filter((ev) => {
      const t = ev.kickoffAt.getTime();
      return t >= now - 5 * 60_000 && t <= now + windowMs;
    });
  }

  async fetchOdds(providerFixtureId: string): Promise<ProviderMarket[]> {
    // Sem chamada de API: devolve o cache da última sincronização.
    // Se o cache expirou, o agendador repopula antes de chegarmos aqui.
    if (!cache || cache.apiKey !== this.apiKey) return [];
    return cache.odds.get(String(providerFixtureId))?.markets ?? [];
  }

  private async refresh(days: number): Promise<void> {
    const events = new Map<string, ProviderEvent>();
    const odds = new Map<string, CachedOdds>();
    const failures: Error[] = [];
    const now = Date.now();
    const limit = now + Math.max(days, 1) * 24 * 3600_000;

    for (const sport of this.sports) {
      try {
        const data = await this.api<ApiEvent[]>(
          `/sports/${encodeURIComponent(sport)}/odds/?regions=${encodeURIComponent(
            this.regions
          )}&markets=${encodeURIComponent(this.markets.join(","))}&oddsFormat=decimal&dateFormat=iso`
        );

        for (const ev of Array.isArray(data) ? data : []) {
          const kickoff = new Date(ev.commence_time);
          const kickoffMs = kickoff.getTime();
          if (!Number.isFinite(kickoffMs)) continue;
          // Somente jogos ainda não iniciados (odds pré-jogo).
          if (kickoffMs < now - 5 * 60_000 || kickoffMs > limit) continue;

          events.set(ev.id, {
            providerFixtureId: ev.id,
            sport: { providerSportId: "soccer", name: "Futebol", slug: "futebol" },
            competition: {
              providerCompetitionId: ev.sport_key,
              name: ev.sport_title,
              country: null,
              logoUrl: null,
              season: null,
            },
            home: { name: ev.home_team, logoUrl: null },
            away: { name: ev.away_team, logoUrl: null },
            kickoffAt: kickoff,
            status: "scheduled",
            homeScore: null,
            awayScore: null,
          });

          const mapped = this.toMarkets(ev);
          if (mapped) odds.set(ev.id, mapped);
        }
      } catch (err) {
        // Chave inválida ou parâmetros recusados: não adianta tentar as
        // outras ligas. Cota esgotada: interrompe para não piorar.
        if (
          err instanceof ProviderError &&
          (err.code === "quota" || (err.code === "invalid" && !err.retryable))
        ) {
          throw err;
        }
        failures.push(err as Error);
      }
    }

    if (events.size === 0 && failures.length === this.sports.length) {
      throw failures[0];
    }

    cache = {
      apiKey: this.apiKey,
      at: Date.now(),
      events: [...events.values()],
      odds,
      quotaRemaining: this.quotaRemaining,
    };
  }

  private toMarkets(ev: ApiEvent): CachedOdds | null {
    const books = (ev.bookmakers ?? []).filter(
      (b) => Array.isArray(b.markets) && b.markets.length > 0
    );
    const book = this.pickBook(books);
    if (!book) return null;

    const markets: ProviderMarket[] = [];
    let updatedAt: Date | null = null;

    const h2h = book.markets?.find((m) => m.key === "h2h");
    if (h2h) {
      const winner = this.mapMatchWinner(ev, h2h);
      if (winner) {
        winner.updatedAt = this.parseDate(h2h.last_update) ?? undefined;
        markets.push(winner);
        updatedAt = winner.updatedAt ?? updatedAt;
      }
    }

    const totals = book.markets?.find((m) => m.key === "totals");
    if (totals) {
      const goalMarket = this.mapTotals(totals);
      if (goalMarket) {
        goalMarket.updatedAt = this.parseDate(totals.last_update) ?? undefined;
        markets.push(goalMarket);
        updatedAt = goalMarket.updatedAt ?? updatedAt;
      }
    }

    if (markets.length === 0) return null;

    const fallback = updatedAt ?? this.parseDate(book.last_update) ?? new Date();
    // Garante que todo mercado tenha o horário da cotação (nunca o horário
    // da gravação) para o cálculo honesto de validade.
    for (const market of markets) market.updatedAt ??= fallback;

    return { markets, updatedAt: fallback };
  }

  private pickBook(books: ApiBookmaker[]): ApiBookmaker | null {
    if (books.length === 0) return null;
    const withWinner = books.filter((b) =>
      b.markets?.some((m) => m.key === "h2h" && (m.outcomes?.length ?? 0) >= 2)
    );
    const pool = withWinner.length > 0 ? withWinner : books;
    return [...pool].sort((a, b) => this.bookRank(a.key) - this.bookRank(b.key))[0] ?? null;
  }

  private bookRank(key: string): number {
    const i = BOOKMAKER_PREFERENCE.indexOf(String(key).toLowerCase());
    return i < 0 ? 99 : i;
  }

  private mapMatchWinner(ev: ApiEvent, market: ApiMarket): ProviderMarket | null {
    const home = normalizeName(ev.home_team);
    const away = normalizeName(ev.away_team);
    const found = new Map<string, { name: string; odd: number }>();

    for (const outcome of market.outcomes ?? []) {
      const odd = Number(outcome.price);
      if (!Number.isFinite(odd) || odd < 1.01) continue;
      const name = normalizeName(outcome.name);
      let key: string | null = null;
      if (name === "draw" || name === "tie") key = "draw";
      else if (name === home) key = "home";
      else if (name === away) key = "away";
      if (!key || found.has(key)) continue;
      found.set(key, { name: outcome.name, odd: Math.round(odd * 10000) / 10000 });
    }

    const labels: Array<{ key: string; name: string }> = [
      { key: "home", name: "Mandante" },
      { key: "draw", name: "Empate" },
      { key: "away", name: "Visitante" },
    ];
    const selections = labels
      .filter((l) => found.has(l.key))
      .map((l) => ({
        providerSelectionKey: l.key,
        name: l.name,
        odd: found.get(l.key)!.odd,
      }));

    if (selections.length < 2) return null;
    return {
      providerMarketId: "match_winner",
      marketKey: "match_winner",
      name: "Resultado Final",
      selections,
    };
  }

  private mapTotals(market: ApiMarket): ProviderMarket | null {
    const byPoint = new Map<number, { over?: number; under?: number }>();

    for (const outcome of market.outcomes ?? []) {
      const point = Number(outcome.point);
      const odd = Number(outcome.price);
      if (!Number.isFinite(point) || !Number.isFinite(odd) || odd < 1.01) continue;
      const side = outcome.name.toLowerCase().trim();
      if (side !== "over" && side !== "under") continue;
      const entry = byPoint.get(point) ?? {};
      entry[side] = Math.round(odd * 10000) / 10000;
      byPoint.set(point, entry);
    }

    const lines = [...byPoint.entries()]
      .filter(([, v]) => v.over !== undefined && v.under !== undefined)
      .sort(
        (a, b) =>
          Math.abs(a[0] - PREFERRED_TOTAL_LINE) - Math.abs(b[0] - PREFERRED_TOTAL_LINE)
      )
      .slice(0, MAX_TOTAL_LINES)
      .sort((a, b) => a[0] - b[0]);

    if (lines.length === 0) return null;

    const selections: ProviderMarket["selections"] = [];
    for (const [point, value] of lines) {
      const formatted = formatPoint(point);
      selections.push({
        providerSelectionKey: `over_${formatted}`,
        name: `Mais de ${formatted} gols`,
        odd: value.over!,
      });
      selections.push({
        providerSelectionKey: `under_${formatted}`,
        name: `Menos de ${formatted} gols`,
        odd: value.under!,
      });
    }

    return {
      providerMarketId: "goals_over_under",
      marketKey: "goals_over_under",
      name: "Total de Gols",
      selections,
    };
  }

  private parseDate(value?: string): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
}

/** Opções a partir do ambiente (usadas por `resolveProvider`). */
export function theOddsApiOptionsFromConfig(): TheOddsApiOptions {
  return {
    sports: config.odds.theOddsApiSports,
    markets: config.odds.theOddsApiMarkets,
    regions: config.odds.theOddsApiRegions,
    cacheMinutes: config.odds.theOddsApiCacheMinutes,
  };
}
