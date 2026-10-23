import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TheOddsApiProvider,
  __resetTheOddsApiCache,
} from "../src/modules/odds/theOddsApi";
import { ProviderError } from "../src/modules/odds/types";

function response(body: unknown, status = 200, remaining = 500): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-requests-remaining": String(remaining),
    },
  });
}

function kickoffIn(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

const h2h = (home: number, draw: number, away: number, lastUpdate = kickoffIn(-1)) => ({
  key: "h2h",
  last_update: lastUpdate,
  outcomes: [
    { name: "Cruzeiro", price: home },
    { name: "Draw", price: draw },
    { name: "Remo", price: away },
  ],
});

const totals = (
  lines: Array<{ point: number; over: number; under: number }>
) => ({
  key: "totals",
  last_update: kickoffIn(-1),
  outcomes: lines.flatMap((line) => [
    { name: "Over", price: line.over, point: line.point },
    { name: "Under", price: line.under, point: line.point },
  ]),
});

const event = (overrides: Record<string, unknown> = {}) => ({
  id: "evt-1",
  sport_key: "soccer_test",
  sport_title: "Liga Teste",
  commence_time: kickoffIn(6),
  home_team: "Cruzeiro",
  away_team: "Remo",
  bookmakers: [
    {
      key: "bet365",
      title: "Bet 365",
      last_update: kickoffIn(-1),
      markets: [h2h(1.5, 4.0, 6.0)],
    },
    {
      key: "pinnacle",
      title: "Pinnacle",
      last_update: kickoffIn(-1),
      markets: [
        h2h(1.37, 5.33, 8.15),
        totals([
          { point: 2.5, over: 1.9, under: 1.9 },
          { point: 3.5, over: 2.31, under: 1.64 },
        ]),
      ],
    },
  ],
  ...overrides,
});

function provider(overrides: { sports?: string[]; cacheMinutes?: number } = {}) {
  return new TheOddsApiProvider("test-key", {
    sports: overrides.sports ?? ["soccer_test"],
    markets: ["h2h", "totals"],
    regions: "eu",
    cacheMinutes: overrides.cacheMinutes ?? 60,
  });
}

describe("TheOddsApiProvider", () => {
  beforeEach(() => {
    __resetTheOddsApiCache();
    vi.restoreAllMocks();
  });

  it("mapeia Resultado Final e Total de Gols usando a casa preferida", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([event()]));
    vi.stubGlobal("fetch", fetchMock);

    const p = provider();
    const events = await p.fetchUpcomingEvents(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerFixtureId: "evt-1",
      competition: { providerCompetitionId: "soccer_test", name: "Liga Teste" },
      home: { name: "Cruzeiro" },
      away: { name: "Remo" },
      status: "scheduled",
    });

    const markets = await p.fetchOdds("evt-1");
    const winner = markets.find((m) => m.marketKey === "match_winner");
    expect(winner?.selections.map((s) => s.providerSelectionKey)).toEqual([
      "home",
      "draw",
      "away",
    ]);
    // Odds da Pinnacle (preferida), não da Bet 365.
    expect(winner?.selections.find((s) => s.providerSelectionKey === "home")?.odd).toBe(1.37);

    const goals = markets.find((m) => m.marketKey === "goals_over_under");
    expect(goals?.selections.map((s) => s.providerSelectionKey)).toEqual([
      "over_2.5",
      "under_2.5",
      "over_3.5",
      "under_3.5",
    ]);
    expect(goals?.selections[0].name).toBe("Mais de 2.5 gols");
    expect(goals?.selections[1].name).toBe("Menos de 2.5 gols");
    expect(markets[0].updatedAt).toBeInstanceOf(Date);
  });

  it("reaproveita o cache e não consome cota a cada sincronização", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([event()]));
    vi.stubGlobal("fetch", fetchMock);

    const p = provider();
    await p.fetchUpcomingEvents(2);
    await p.fetchUpcomingEvents(2);
    await p.fetchOdds("evt-1");
    await p.fetchOdds("evt-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mantém o evento sem mercados quando a casa não publica odds", async () => {
    const noOdds = event({ id: "evt-2", bookmakers: [] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([noOdds])));

    const p = provider();
    const events = await p.fetchUpcomingEvents(2);
    expect(events).toHaveLength(1);
    expect(await p.fetchOdds("evt-2")).toEqual([]);
  });

  it("ignora jogos já iniciados", async () => {
    const started = event({ id: "evt-old", commence_time: kickoffIn(-2) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([started])));

    const p = provider();
    expect(await p.fetchUpcomingEvents(2)).toHaveLength(0);
  });

  it("traduz cota esgotada (429) em ProviderError de quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ message: "quota exceeded" }, 429, 0))
    );

    const p = provider();
    await expect(p.fetchUpcomingEvents(2)).rejects.toMatchObject({
      name: "ProviderError",
      code: "quota",
    });
  });

  it("traduz chave inválida (401) em erro não repetível", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ message: "API key is not valid" }, 401, 500))
    );

    const p = provider();
    await expect(p.fetchUpcomingEvents(2)).rejects.toBeInstanceOf(ProviderError);
    await expect(p.fetchUpcomingEvents(2)).rejects.toMatchObject({
      code: "invalid",
      retryable: false,
    });
  });
});
