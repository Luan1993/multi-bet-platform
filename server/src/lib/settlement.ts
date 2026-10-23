/**
 * Apuração de cupons a partir do resultado informado pelo proprietário.
 *
 * Regras:
 * - `match_winner` e mercados de total (gols, cartões, escanteios, chutes a gol)
 *   são apurados pelo placar/estatísticas do evento.
 * - Linha inteira empatada no total (ex.: 10 escanteios na linha 10) é "push":
 *   a seleção é anulada (odd 1.00).
 * - Evento anulado (adiado/cancelado) anula todas as seleções dele.
 * - Mercado que não sabemos apurar fica pendente e impede a liquidação
 *   automática do cupom; o proprietário ainda pode liquidar manualmente.
 * - O prêmio devido usa a odd combinada das seleções restantes (anuladas saem),
 *   limitado ao teto aplicado no cupom.
 */

export type LegResult = "won" | "lost" | "void" | "pending";

export interface EventResult {
  fixtureId: string;
  homeScore: number | null;
  awayScore: number | null;
  cardsTotal: number | null;
  cornersTotal: number | null;
  shotsOnGoalTotal: number | null;
  /** Evento finalizado (placar válido) ou anulado. */
  final: boolean;
  void: boolean;
}

export interface CouponLeg {
  marketKey: string;
  providerSelectionKey: string;
  providerFixtureId: string;
  odd: number;
}

export interface GradedLeg extends CouponLeg {
  result: LegResult;
}

export interface CouponEvaluation {
  status: "pending" | "won" | "lost" | "void";
  legs: GradedLeg[];
  /** Odd combinada das seleções vencedoras (ignora anuladas). */
  combinedOdd: number | null;
  /** Prêmio devido em centavos (null quando ainda pendente/perdido/anulado). */
  duePayoutCents: number | null;
}

const OU_KEY_RE = /^(over|under)[._-]?(\d+(?:[.,]\d{1,2})?)$/i;

export function parseOuKey(key: string): { side: "over" | "under"; line: number } | null {
  const m = OU_KEY_RE.exec(key.trim());
  if (!m) return null;
  const line = Number(m[2].replace(",", "."));
  if (!Number.isFinite(line)) return null;
  return { side: m[1].toLowerCase() as "over" | "under", line };
}

function ouResult(total: number | null, key: string): LegResult {
  if (total === null || !Number.isFinite(total)) return "pending";
  const parsed = parseOuKey(key);
  if (!parsed) return "pending";
  if (total === parsed.line) return "void"; // push: linha inteira exata
  const over = total > parsed.line;
  const won = parsed.side === "over" ? over : !over;
  return won ? "won" : "lost";
}

/**
 * Apura uma seleção isolada. `marketKey` e `providerSelectionKey` vêm do
 * snapshot do cupom (não dependem da tabela de seleções, que pode mudar).
 */
export function gradeSelection(
  marketKey: string,
  selectionKey: string,
  ev: EventResult
): LegResult {
  if (ev.void) return "void";
  if (!ev.final) return "pending";

  const key = selectionKey.trim().toLowerCase();

  if (marketKey === "match_winner") {
    if (ev.homeScore === null || ev.awayScore === null) return "pending";
    const outcome =
      ev.homeScore > ev.awayScore ? "home" : ev.homeScore < ev.awayScore ? "away" : "draw";
    if (key === outcome) return "won";
    if (key === "home" || key === "draw" || key === "away") return "lost";
    return "pending";
  }

  if (marketKey === "goals_over_under") {
    if (ev.homeScore === null || ev.awayScore === null) return "pending";
    return ouResult(ev.homeScore + ev.awayScore, key);
  }
  if (marketKey === "cards_over_under") return ouResult(ev.cardsTotal, key);
  if (marketKey === "corners_over_under") return ouResult(ev.cornersTotal, key);
  if (marketKey === "shots_on_goal_over_under") return ouResult(ev.shotsOnGoalTotal, key);

  return "pending";
}

/** Avalia o cupom inteiro. Qualquer seleção perdida derruba o cupom. */
export function evaluateCoupon(
  legs: CouponLeg[],
  results: Map<string, EventResult>,
  stakeCents: number,
  limitCents: number
): CouponEvaluation {
  const graded: GradedLeg[] = legs.map((leg) => {
    const ev = results.get(leg.providerFixtureId);
    return {
      ...leg,
      result: ev ? gradeSelection(leg.marketKey, leg.providerSelectionKey, ev) : "pending",
    };
  });

  if (graded.some((l) => l.result === "lost")) {
    return { status: "lost", legs: graded, combinedOdd: null, duePayoutCents: 0 };
  }
  if (graded.some((l) => l.result === "pending")) {
    return { status: "pending", legs: graded, combinedOdd: null, duePayoutCents: null };
  }

  const winners = graded.filter((l) => l.result === "won");
  if (winners.length === 0) {
    return { status: "void", legs: graded, combinedOdd: null, duePayoutCents: 0 };
  }

  const combined = Math.round(winners.reduce((acc, l) => acc * l.odd, 1) * 10000) / 10000;
  const due = Math.min(Math.round(stakeCents * combined), limitCents);
  return { status: "won", legs: graded, combinedOdd: combined, duePayoutCents: due };
}
