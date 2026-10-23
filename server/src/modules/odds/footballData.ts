import {
  EventStatus,
  OddsProvider,
  ProviderError,
  ProviderEvent,
  ProviderMarket,
} from "./types";

/**
 * Adaptador do football-data.org (v4) — https://www.football-data.org/documentation/api
 *
 * Particularidades verificadas:
 * - Uma única requisição cobre um intervalo de datas (`dateFrom`/`dateTo`),
 *   o que mantém o uso dentro do limite do plano gratuito (10 req/min).
 * - O plano gratuito libera um conjunto de competições (Premier League,
 *   Champions League, Bundesliga, Ligue 1, etc.).
 * - Odds (1X2) só vêm preenchidas quando o pacote de odds está ativado no
 *   painel da conta; sem ele a API devolve `{ "msg": "Activate Odds-Package..." }`.
 *   Nesse caso NÃO inventamos odds: os eventos aparecem, mas sem mercados.
 */

const BASE = "https://api.football-data.org/v4";

const STATUS_MAP: Record<string, EventStatus> = {
  SCHEDULED: "scheduled",
  TIMED: "scheduled",
  IN_PLAY: "live",
  PAUSED: "live",
  LIVE: "live",
  FINISHED: "finished",
  AWARDED: "finished",
  POSTPONED: "postponed",
  SUSPENDED: "postponed",
  CANCELED: "cancelled",
  CANCELLED: "cancelled",
};

interface FdOdds {
  homeWin?: number;
  draw?: number;
  awayWin?: number;
  msg?: string;
}

interface FdMatch {
  id: number;
  utcDate: string;
  status: string;
  area?: { id: number; name: string };
  competition: { id: number; name: string; code: string; emblem?: string | null };
  season?: { id: number; startDate?: string };
  homeTeam: { id: number; name: string; shortName?: string; crest?: string | null };
  awayTeam: { id: number; name: string; shortName?: string; crest?: string | null };
  score?: { fullTime?: { home: number | null; away: number | null } };
  odds?: FdOdds;
}

export class FootballDataProvider implements OddsProvider {
  readonly id = "football-data";
  readonly label = "football-data.org";
  isDemo = false;

  /** Odds vindas da mesma resposta da listagem (economiza cota). */
  private readonly oddsByFixture = new Map<string, FdOdds>();
  /** Mensagem da API quando o pacote de odds não está ativado. */
  private oddsDisabledMessage: string | null = null;
  /** Controle do limite de 10 requisições por minuto do plano gratuito. */
  private nextAllowedAt = 0;

  constructor(private readonly apiKey: string) {}

  private async throttle(): Promise<void> {
    const wait = this.nextAllowedAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.nextAllowedAt = Date.now() + 6_500;
  }

  private async api<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        headers: { "X-Auth-Token": this.apiKey },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ProviderError(
        `Falha de rede ao consultar o football-data.org: ${(err as Error).message}`,
        "unavailable"
      );
    }
    if (res.status === 429) {
      throw new ProviderError(
        "Limite de requisições do football-data.org atingido (10/minuto no plano gratuito).",
        "quota"
      );
    }
    if (res.status === 403) {
      throw new ProviderError(
        "Token do football-data.org recusado ou competição não liberada no plano atual.",
        "invalid",
        false
      );
    }
    if (!res.ok) {
      throw new ProviderError(`football-data.org respondeu HTTP ${res.status}.`, "http");
    }
    return (await res.json()) as T;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const data = await this.api<{ competitions?: unknown[] }>("/competitions");
      const competitions = data.competitions?.length ?? 0;

      const from = new Date();
      const to = new Date(from.getTime() + 2 * 24 * 3600 * 1000);
      await this.throttle();
      const matches = await this.api<{ matches?: FdMatch[] }>(
        `/matches?dateFrom=${from.toISOString().slice(0, 10)}&dateTo=${to.toISOString().slice(0, 10)}`
      );
      const list = matches.matches ?? [];
      const hasOdds = list.some(
        (m) => m.odds && !m.odds.msg && Number.isFinite(m.odds.homeWin)
      );
      const oddsMsg = list.find((m) => m.odds?.msg)?.odds?.msg;

      if (hasOdds) {
        return {
          ok: true,
          message: `Conectado ao football-data.org (${competitions} competições, ${list.length} jogos, odds disponíveis).`,
        };
      }
      if (oddsMsg) {
        return {
          ok: true,
          message: `Conexão OK (${competitions} competições, ${list.length} jogos). Atenção: o pacote de odds NÃO está ativado na conta — os jogos aparecem, mas sem mercados. ${oddsMsg}`,
        };
      }
      return {
        ok: true,
        message: `Conectado ao football-data.org (${competitions} competições, ${list.length} jogos). Odds ainda não publicadas para os próximos jogos.`,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async fetchUpcomingEvents(days: number): Promise<ProviderEvent[]> {
    const window = Math.min(Math.max(days, 1), 7);
    const from = new Date();
    const to = new Date(from.getTime() + window * 24 * 3600 * 1000);
    const dateFrom = from.toISOString().slice(0, 10);
    const dateTo = to.toISOString().slice(0, 10);

    this.oddsByFixture.clear();
    await this.throttle();
    const data = await this.api<{ matches?: FdMatch[] }>(`/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`);

    const events: ProviderEvent[] = [];
    for (const m of data.matches ?? []) {
      if (m.odds?.msg) this.oddsDisabledMessage = m.odds.msg;
      else if (m.odds) this.oddsByFixture.set(String(m.id), m.odds);

      events.push({
        providerFixtureId: String(m.id),
        sport: { providerSportId: "soccer", name: "Futebol", slug: "futebol" },
        competition: {
          providerCompetitionId: String(m.competition.id),
          name: m.competition.name,
          country: m.area?.name ?? null,
          logoUrl: m.competition.emblem ?? null,
          season: m.season?.startDate ? m.season.startDate.slice(0, 4) : null,
        },
        home: { name: m.homeTeam.name, logoUrl: m.homeTeam.crest ?? null },
        away: { name: m.awayTeam.name, logoUrl: m.awayTeam.crest ?? null },
        kickoffAt: new Date(m.utcDate),
        status: STATUS_MAP[m.status] ?? "scheduled",
        homeScore: m.score?.fullTime?.home ?? null,
        awayScore: m.score?.fullTime?.away ?? null,
      });
    }
    return events;
  }

  async fetchOdds(providerFixtureId: string): Promise<ProviderMarket[]> {
    const cached = this.oddsByFixture.get(String(providerFixtureId));
    if (cached) return this.toMarkets(cached);

    if (this.oddsDisabledMessage) {
      // Sem pacote de odds não há o que buscar — evita gastar a cota da API.
      throw new ProviderError(this.oddsDisabledMessage, "invalid", false);
    }

    await this.throttle();
    const match = await this.api<FdMatch>(`/matches/${encodeURIComponent(providerFixtureId)}`);
    if (match.odds?.msg) {
      this.oddsDisabledMessage = match.odds.msg;
      throw new ProviderError(match.odds.msg, "invalid", false);
    }
    if (!match.odds) return [];
    this.oddsByFixture.set(String(providerFixtureId), match.odds);
    return this.toMarkets(match.odds);
  }

  /** Converte as odds 1X2 do provedor no mercado "Resultado Final". */
  private toMarkets(odds: FdOdds): ProviderMarket[] {
    const entries: Array<{ key: string; name: string; value: number | undefined }> = [
      { key: "home", name: "Mandante", value: odds.homeWin },
      { key: "draw", name: "Empate", value: odds.draw },
      { key: "away", name: "Visitante", value: odds.awayWin },
    ];
    const selections = entries
      .filter((e) => Number.isFinite(e.value) && (e.value as number) >= 1.01)
      .map((e) => ({
        providerSelectionKey: e.key,
        name: e.name,
        odd: Math.round((e.value as number) * 10000) / 10000,
      }));

    if (selections.length < 2) return [];
    return [
      {
        providerMarketId: "match_winner",
        marketKey: "match_winner",
        name: "Resultado Final",
        selections,
      },
    ];
  }
}
