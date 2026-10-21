import { OddsProvider, ProviderEvent, ProviderMarket } from "./types";

/**
 * Provedor de DEMONSTRAÇÃO — DADOS COMPLETAMENTE SIMULADOS.
 *
 * Todos os eventos, times e odds gerados por esta classe são fictícios e
 * existem exclusivamente para desenvolvimento/testes da plataforma.
 * Eles NÃO representam dados esportivos reais e NÃO devem ser usados em
 * nenhuma operação com dinheiro real.
 */

// PRNG determinístico (mulberry32) — mesmo "evento" sempre gera as mesmas odds.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Escudos locais (SVG em data URL) para o modo demonstração.
// Mantêm a página visualmente completa sem depender de imagens externas.
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function initialsOf(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function teamCrest(name: string): string {
  const hue = seedFrom(name) % 360;
  const hue2 = (hue + 45) % 360;
  const initials = initialsOf(name) || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},72%,48%)"/><stop offset="1" stop-color="hsl(${hue2},72%,30%)"/></linearGradient></defs><path d="M32 3 57 12v19c0 15-11 25-25 30C18 56 7 46 7 31V12Z" fill="url(#g)" stroke="#ffffff" stroke-opacity=".85" stroke-width="2"/><circle cx="32" cy="30" r="16" fill="#0b1220" fill-opacity=".22"/><text x="32" y="37" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="700" fill="#ffffff" text-anchor="middle">${initials}</text></svg>`;
  return svgDataUrl(svg);
}

function leagueCrest(name: string): string {
  const hue = (seedFrom(name) + 190) % 360;
  const hue2 = (hue + 50) % 360;
  const initials = initialsOf(name) || "L";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},65%,50%)"/><stop offset="1" stop-color="hsl(${hue2},65%,32%)"/></linearGradient></defs><circle cx="32" cy="32" r="28" fill="url(#g)" stroke="#fbbf24" stroke-width="2.5"/><text x="32" y="39" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" fill="#ffffff" text-anchor="middle">${initials}</text></svg>`;
  return svgDataUrl(svg);
}

interface DemoLeague {
  id: string;
  name: string;
  country: string;
  sport: { providerSportId: string; name: string; slug: string };
  teams: string[];
}

const DEMO_LEAGUES: DemoLeague[] = [
  {
    id: "demo-soccer-1",
    name: "Liga Demonstração — Futebol A",
    country: "Simulação",
    sport: { providerSportId: "soccer", name: "Futebol", slug: "futebol" },
    teams: ["Atlético Exemplo", "União de Teste", "FC Amostra", "Real Simulado", "Sport fictício", "Vila Demonstração"],
  },
  {
    id: "demo-soccer-2",
    name: "Copa Simulada de Desenvolvimento",
    country: "Simulação",
    sport: { providerSportId: "soccer", name: "Futebol", slug: "futebol" },
    teams: ["Grêmio Protótipo", "Nacional Ensaio", "Botafogo fictício", "Coritiba Exemplo"],
  },
  {
    id: "demo-basket-1",
    name: "Liga Demonstração — Basquete",
    country: "Simulação",
    sport: { providerSportId: "basket", name: "Basquete", slug: "basquete" },
    teams: ["Hoops Exemplo", "Cestas de Teste", "Alley-Oops Simulado", "Fastbreak Fictício"],
  },
];

export class DemoProvider implements OddsProvider {
  readonly id = "demo";
  readonly label = "Modo Demonstração (DADOS SIMULADOS)";
  readonly isDemo = true;

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "Modo demonstração ativo — todos os dados são simulados." };
  }

  async fetchUpcomingEvents(days: number): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    for (let d = 0; d < Math.min(days, 3); d++) {
      for (const league of DEMO_LEAGUES) {
        const count = league.sport.providerSportId === "basket" ? 3 : 5;
        for (let i = 0; i < count; i++) {
          const fixtureId = `demo-${league.id}-${d}-${i}`;
          const rnd = mulberry32(seedFrom(fixtureId));
          const [h, a] = pickTeams(league.teams, rnd);
          const hour = 13 + i * 2;
          const kickoff = new Date(dayStart.getTime() + d * 24 * 3600 * 1000 + hour * 3600 * 1000);
          events.push({
            providerFixtureId: fixtureId,
            sport: league.sport,
            competition: {
              providerCompetitionId: league.id,
              name: league.name,
              country: league.country,
              logoUrl: leagueCrest(league.name),
              season: "2026",
            },
            home: { name: h, logoUrl: teamCrest(h) },
            away: { name: a, logoUrl: teamCrest(a) },
            kickoffAt: kickoff,
            status: "scheduled",
            homeScore: null,
            awayScore: null,
          });
        }
      }
    }
    return events;
  }

  async fetchOdds(providerFixtureId: string): Promise<ProviderMarket[]> {
    const rnd = mulberry32(seedFrom(providerFixtureId));
    const isBasket = providerFixtureId.includes("demo-basket");
    const markets: ProviderMarket[] = [];

    // 1x2
    const pHome = round2(1.4 + rnd() * 2.4);
    const pDraw = isBasket ? null : round2(2.6 + rnd() * 1.6);
    const pAway = round2(1.5 + rnd() * 2.6);
    const sels1x2: ProviderMarket["selections"] = [
      { providerSelectionKey: "home", name: "Mandante", odd: pHome },
    ];
    if (pDraw) sels1x2.push({ providerSelectionKey: "draw", name: "Empate", odd: pDraw });
    sels1x2.push({ providerSelectionKey: "away", name: "Visitante", odd: pAway });
    markets.push({
      providerMarketId: "match_winner",
      marketKey: "match_winner",
      name: "Resultado Final",
      selections: sels1x2,
    });

    // Total de pontos/gols (over/under)
    const baseLine = isBasket ? 160.5 : 2.5;
    const line = isBasket ? baseLine : [1.5, 2.5, 3.5][Math.floor(rnd() * 3)];
    markets.push({
      providerMarketId: "goals_over_under",
      marketKey: "goals_over_under",
      name: isBasket ? "Total de Pontos" : "Total de Gols",
      selections: [
        { providerSelectionKey: `over_${line}`, name: `Mais de ${line}`, odd: round2(1.6 + rnd() * 0.6) },
        { providerSelectionKey: `under_${line}`, name: `Menos de ${line}`, odd: round2(1.6 + rnd() * 0.6) },
      ],
    });

    if (!isBasket) {
      markets.push({
        providerMarketId: "double_chance",
        marketKey: "double_chance",
        name: "Dupla Chance",
        selections: [
          { providerSelectionKey: "home_draw", name: "Mandante ou Empate", odd: round2(1.15 + rnd() * 0.4) },
          { providerSelectionKey: "home_away", name: "Mandante ou Visitante", odd: round2(1.2 + rnd() * 0.4) },
          { providerSelectionKey: "draw_away", name: "Empate ou Visitante", odd: round2(1.25 + rnd() * 0.5) },
        ],
      });
      markets.push({
        providerMarketId: "both_teams_score",
        marketKey: "both_teams_score",
        name: "Ambas Marcam",
        selections: [
          { providerSelectionKey: "yes", name: "Sim", odd: round2(1.6 + rnd() * 0.6) },
          { providerSelectionKey: "no", name: "Não", odd: round2(1.35 + rnd() * 0.5) },
        ],
      });
    }
    return markets;
  }
}

function pickTeams(teams: string[], rnd: () => number): [string, string] {
  const i = Math.floor(rnd() * teams.length);
  let j = Math.floor(rnd() * teams.length);
  if (j === i) j = (i + 1) % teams.length;
  return [teams[i], teams[j]];
}
