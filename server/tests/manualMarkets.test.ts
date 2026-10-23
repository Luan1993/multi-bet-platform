import { describe, expect, it } from "vitest";
import {
  ManualMarketError,
  normalizeManualMarkets,
} from "../src/lib/manualMarkets";

describe("normalizeManualMarkets", () => {
  it("normaliza o Resultado Final com nomes fixos", () => {
    const [market] = normalizeManualMarkets([
      {
        marketKey: "match_winner",
        selections: [
          { key: "home", odd: 1.85 },
          { key: "draw", odd: 3.4 },
          { key: "away", odd: 4.2 },
        ],
      },
    ]);
    expect(market.marketKey).toBe("match_winner");
    expect(market.name).toBe("Resultado Final");
    expect(market.selections.map((s) => s.name)).toEqual([
      "Mandante",
      "Empate",
      "Visitante",
    ]);
  });

  it("aceita várias linhas de Mais/Menos e ordena por linha", () => {
    const [market] = normalizeManualMarkets([
      {
        marketKey: "corners_over_under",
        selections: [
          { key: "under_10.5", odd: 1.95 },
          { key: "over_9.5", odd: 1.9 },
          { key: "over_10.5", odd: 2.4 },
          { key: "under_9.5", odd: 1.85 },
        ],
      },
    ]);
    expect(market.selections.map((s) => s.key)).toEqual([
      "over_9.5",
      "under_9.5",
      "over_10.5",
      "under_10.5",
    ]);
    expect(market.selections[0].name).toBe("Mais de 9.5 escanteios");
  });

  it("normaliza linha com vírgula", () => {
    const [market] = normalizeManualMarkets([
      {
        marketKey: "cards_over_under",
        selections: [
          { key: "over_4,5", odd: 1.9 },
          { key: "under_4,5", odd: 1.9 },
        ],
      },
    ]);
    expect(market.selections.map((s) => s.key)).toEqual(["over_4.5", "under_4.5"]);
  });

  it("rejeita linha sem um dos lados", () => {
    expect(() =>
      normalizeManualMarkets([
        {
          marketKey: "shots_on_goal_over_under",
          selections: [{ key: "over_9.5", odd: 1.9 }],
        },
      ])
    ).toThrow(ManualMarketError);
  });

  it("rejeita mercado desconhecido", () => {
    expect(() =>
      normalizeManualMarkets([
        { marketKey: "fouls_over_under", selections: [{ key: "over_9.5", odd: 1.9 }] },
      ])
    ).toThrow(/não suportado/i);
  });

  it("rejeita odds fora do intervalo", () => {
    expect(() =>
      normalizeManualMarkets([
        {
          marketKey: "goals_over_under",
          selections: [
            { key: "over_2.5", odd: 0.9 },
            { key: "under_2.5", odd: 1.9 },
          ],
        },
      ])
    ).toThrow(/1.01 e 1000/i);
  });

  it("aceita lista vazia (remover todas as odds manuais)", () => {
    expect(normalizeManualMarkets([])).toEqual([]);
  });
});
