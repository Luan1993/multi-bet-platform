import { describe, expect, it } from "vitest";
import {
  areSelectionsIncompatible,
  conflictsBySelection,
  findConflictPairs,
  isSinglePickMarket,
} from "../src/lib/markets";

function sel(id: number, marketId: number, marketKey: string, selectionKey: string) {
  return { id, marketId, marketKey, selectionKey };
}

describe("compatibilidade de seleções do mesmo mercado", () => {
  it("bloqueia Mais de 1.5 com Menos de 1.5 (mesma linha, lados opostos)", () => {
    expect(
      areSelectionsIncompatible(sel(1, 10, "goals_over_under", "over_1.5"), sel(2, 10, "goals_over_under", "under_1.5"))
    ).toBe(true);
  });

  it("bloqueia Mais de 2.5 com Menos de 1.5 (contraditórios)", () => {
    expect(
      areSelectionsIncompatible(sel(1, 10, "goals_over_under", "over_2.5"), sel(2, 10, "goals_over_under", "under_1.5"))
    ).toBe(true);
  });

  it("permite Mais de 1.5 com Menos de 3.5 (2 ou 3 gols satisfazem ambos)", () => {
    expect(
      areSelectionsIncompatible(sel(1, 10, "goals_over_under", "over_1.5"), sel(2, 10, "goals_over_under", "under_3.5"))
    ).toBe(false);
  });

  it("permite duas opções na mesma direção (dois Over de linhas distintas)", () => {
    expect(
      areSelectionsIncompatible(sel(1, 10, "goals_over_under", "over_1.5"), sel(2, 10, "goals_over_under", "over_2.5"))
    ).toBe(false);
    expect(
      areSelectionsIncompatible(sel(1, 10, "goals_over_under", "under_1.5"), sel(2, 10, "goals_over_under", "under_2.5"))
    ).toBe(false);
  });

  it("permite seleções equivalentes de mercados distintos", () => {
    expect(
      areSelectionsIncompatible(
        sel(1, 10, "goals_over_under", "over_1.5"),
        sel(2, 20, "goals_over_under_prematch", "under_1.5")
      )
    ).toBe(false);
    expect(
      areSelectionsIncompatible(sel(1, 10, "match_winner", "home"), sel(2, 20, "double_chance", "home_draw"))
    ).toBe(false);
  });

  it("bloqueia duas seleções do mesmo mercado de resultado único", () => {
    const marketId = 30;
    const keys = ["home", "draw", "away"];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        expect(
          areSelectionsIncompatible(sel(i + 1, marketId, "match_winner", keys[i]), sel(j + 1, marketId, "match_winner", keys[j]))
        ).toBe(true);
      }
    }
    expect(
      areSelectionsIncompatible(sel(1, 31, "both_teams_score", "yes"), sel(2, 31, "both_teams_score", "no"))
    ).toBe(true);
    expect(
      areSelectionsIncompatible(sel(1, 32, "double_chance", "home_draw"), sel(2, 32, "double_chance", "draw_away"))
    ).toBe(true);
  });

  it(" chave com número em formato alternativo segue a mesma regra", () => {
    expect(
      areSelectionsIncompatible(sel(1, 10, "goals_over_under", "over-1.5"), sel(2, 10, "goals_over_under", "under_1.5"))
    ).toBe(true);
  });

  it("findConflictPairs encontra apenas pares relevantes", () => {
    const pairs = findConflictPairs([
      sel(1, 10, "goals_over_under", "over_1.5"),
      sel(2, 10, "goals_over_under", "under_1.5"),
      sel(3, 10, "goals_over_under", "under_3.5"),
      sel(4, 20, "match_winner", "home"),
      sel(5, 21, "match_winner", "away"),
    ]);
    // dentro do mercado 10: 1x2 (incompatíveis), 1x3 ok, 2x3 ok; mercados 20/21 não confliam
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.id).toBe(1);
    expect(pairs[0].b.id).toBe(2);
  });

  it("conflictsBySelection e isSinglePickMarket refletem o tipo de mercado", () => {
    const overUnderMap = conflictsBySelection(10, "goals_over_under", [
      { id: 1, key: "over_1.5" },
      { id: 2, key: "under_1.5" },
      { id: 3, key: "under_3.5" },
    ]);
    expect(overUnderMap.get(1)).toEqual([2]);
    expect(overUnderMap.get(2)).toEqual([1]);
    expect(overUnderMap.get(3)).toEqual([]);
    expect(isSinglePickMarket(overUnderMap)).toBe(false);

    const singleMap = conflictsBySelection(20, "match_winner", [
      { id: 4, key: "home" },
      { id: 5, key: "draw" },
      { id: 6, key: "away" },
    ]);
    expect(singleMap.get(4)).toEqual([5, 6]);
    expect(singleMap.get(5)).toEqual([4, 6]);
    expect(isSinglePickMarket(singleMap)).toBe(true);
  });
});
