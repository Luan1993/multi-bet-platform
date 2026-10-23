/**
 * Contrato dos provedores de dados esportivos.
 *
 * Regras (item 5 do escopo):
 * - Nunca inventar odds nem eventos fora do modo demonstração.
 * - Registrar origem e horário de atualização de cada dado.
 * - Se o provedor estiver indisponível, a API sinaliza e a confirmação
 *   de apostas dependentes dos dados é bloqueada.
 */

export type EventStatus = "scheduled" | "live" | "finished" | "postponed" | "cancelled";

export interface ProviderEvent {
  providerFixtureId: string;
  sport: { providerSportId: string; name: string; slug: string };
  competition: {
    providerCompetitionId: string;
    name: string;
    country?: string | null;
    logoUrl?: string | null;
    season?: string | null;
  };
  home: { name: string; logoUrl?: string | null };
  away: { name: string; logoUrl?: string | null };
  kickoffAt: Date;
  status: EventStatus;
  homeScore?: number | null;
  awayScore?: number | null;
}

export interface ProviderMarket {
  providerMarketId: string;
  marketKey: string;
  name: string;
  /**
   * Horário em que a odd foi cotada na origem (não o horário da gravação).
   * Quando informado, é preservado no banco para que a validade da odd seja
   * calculada com honestidade — mesmo que a sincronização use cache.
   */
  updatedAt?: Date;
  selections: Array<{ providerSelectionKey: string; name: string; odd: number }>;
}

export type ProviderErrorCode = "unavailable" | "quota" | "http" | "invalid";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: ProviderErrorCode,
    public readonly retryable = true
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface OddsProvider {
  id: string;
  label: string;
  isDemo: boolean;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  /** Eventos nos próximos N dias (a partir de hoje, UTC). */
  fetchUpcomingEvents(days: number): Promise<ProviderEvent[]>;
  /** Mercados/odds de um evento específico. */
  fetchOdds(providerFixtureId: string): Promise<ProviderMarket[]>;
}
