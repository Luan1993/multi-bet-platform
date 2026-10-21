import { PoolClient } from "pg";
import { config } from "../../config";
import { query, queryOne, withTransaction } from "../../db/pool";
import { logger } from "../../lib/logger";
import { ApiFootballProvider } from "./apiFootball";
import { DemoProvider } from "./demo";
import { OddsProvider, ProviderError } from "./types";

export * from "./types";

// ---------------------------------------------------------------------------
// Resolução do provedor ativo
// ---------------------------------------------------------------------------

interface ProviderState {
  lastSyncAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  syncing: boolean;
  lastOddsFetchAt: number; // throttle de fetch on-demand
}

const state: ProviderState = {
  lastSyncAt: null,
  lastError: null,
  lastErrorAt: null,
  syncing: false,
  lastOddsFetchAt: 0,
};

let cached: { provider: OddsProvider | null; at: number } | null = null;
const PROVIDER_CACHE_MS = 60_000;

/**
 * Resolve o provedor ativo: configuração do banco (painel admin) tem
 * prioridade sobre o .env. Se o admin desabilitou no painel, o provedor
 * fica inativo mesmo com chave no .env. Sem provedor → a página pública
 * informa indisponibilidade e a confirmação de apostas é bloqueada.
 */
export async function resolveProvider(): Promise<OddsProvider | null> {
  if (cached && Date.now() - cached.at < PROVIDER_CACHE_MS) return cached.provider;

  let provider: OddsProvider | null = null;
  const preferred = config.odds.provider; // 'api-football' | 'demo' | 'none'
  const dbName = preferred === "demo" ? "demo" : "api-football";

  let apiKey = config.odds.apiKey;
  const row = await queryOne<{ provider: string; enabled: boolean; api_key: string | null }>(
    `SELECT provider, enabled, api_key FROM provider_configs WHERE provider = $1`,
    [dbName]
  ).catch(() => null);

  if (row) {
    if (!row.enabled) {
      cached = { provider: null, at: Date.now() };
      return null; // desabilitado pelo administrador
    }
    apiKey = row.api_key || apiKey;
  }

  if (preferred === "api-football") {
    if (apiKey) provider = new ApiFootballProvider(apiKey);
  } else if (preferred === "demo") {
    provider = new DemoProvider();
  }

  cached = { provider, at: Date.now() };
  return provider;
}

/** Invalida o cache (usado quando o admin altera a configuração). */
export function invalidateProviderCache(): void {
  cached = null;
}

export function providerState(): Omit<ProviderState, "syncing" | "lastOddsFetchAt"> {
  return { lastSyncAt: state.lastSyncAt, lastError: state.lastError, lastErrorAt: state.lastErrorAt };
}

export interface ProviderMeta {
  id: string | null;
  label: string | null;
  isDemo: boolean;
  available: boolean;
  reason: string | null;
  lastSyncAt: string | null;
  staleAfterMinutes: number;
}

/** Metadados do provedor para exibição pública/painéis. */
export async function getProviderMeta(): Promise<ProviderMeta> {
  const p = await resolveProvider();
  if (!p) {
    return {
      id: null,
      label: null,
      isDemo: false,
      available: false,
      reason: "Nenhum provedor de dados esportivos configurado. Exibição de eventos e confirmação de apostas indisponíveis.",
      lastSyncAt: state.lastSyncAt?.toISOString() ?? null,
      staleAfterMinutes: config.odds.staleMinutes,
    };
  }
  const unavailable = Boolean(state.lastError) && Date.now() - new Date(state.lastErrorAt ?? 0).getTime() < 15 * 60 * 1000;
  return {
    id: p.id,
    label: p.label,
    isDemo: p.isDemo,
    available: !unavailable,
    reason: unavailable ? state.lastError : null,
    lastSyncAt: state.lastSyncAt?.toISOString() ?? null,
    staleAfterMinutes: config.odds.staleMinutes,
  };
}

// ---------------------------------------------------------------------------
// Sincronização
// ---------------------------------------------------------------------------

export interface SyncResult {
  synced: boolean;
  events: number;
  oddsFixtures: number;
  error?: string;
}

/** Sincroniza eventos + odds com o provedor (respeitando a cota diária). */
export async function syncAll(): Promise<SyncResult> {
  const provider = await resolveProvider();
  if (!provider) return { synced: false, events: 0, oddsFixtures: 0 };
  if (state.syncing) return { synced: false, events: 0, oddsFixtures: 0 };

  state.syncing = true;
  try {
    const events = await provider.fetchUpcomingEvents(2);
    let count = 0;
    for (const ev of events) {
      await upsertEvent(provider.id, ev);
      count++;
    }

    // Odds: apenas eventos agendados nas próximas 36h e sem odds frescas
    const candidates = await query<{ id: string; provider_fixture_id: string }>(
      `SELECT e.id, e.provider_fixture_id
         FROM events e
        WHERE e.provider = $1
          AND e.status = 'scheduled'
          AND e.kickoff_at BETWEEN now() AND now() + interval '36 hours'
          AND (
            NOT EXISTS (SELECT 1 FROM markets m WHERE m.event_id = e.id)
            OR (
              SELECT COALESCE(MAX(m2.last_updated_at), TIMESTAMPTZ 'epoch')
                FROM markets m2 WHERE m2.event_id = e.id
            ) < now() - make_interval(secs => $2)
          )
        ORDER BY e.kickoff_at
        LIMIT $3`,
      [provider.id, config.odds.refreshMs / 1000, config.odds.syncMaxFixtures]
    );

    let oddsFixtures = 0;
    for (const c of candidates) {
      try {
        const markets = await provider.fetchOdds(c.provider_fixture_id);
        if (markets.length > 0) {
          await upsertOdds(provider.id, Number(c.id), markets);
          oddsFixtures++;
        }
        // Respeita a cota do plano Free
        await sleep(200);
      } catch (err) {
        if (err instanceof ProviderError && err.code === "quota") {
          logger.warn("odds_sync_quota", { message: err.message });
          break;
        }
        logger.warn("odds_sync_fixture_error", {
          fixture: c.provider_fixture_id,
          message: (err as Error).message,
        });
      }
    }

    state.lastSyncAt = new Date();
    state.lastError = null;
    logger.info("odds_sync_ok", { provider: provider.id, events: count, oddsFixtures });
    return { synced: true, events: count, oddsFixtures };
  } catch (err) {
    state.lastError = (err as Error).message;
    state.lastErrorAt = new Date();
    logger.error("odds_sync_error", { message: (err as Error).message });
    return { synced: false, events: 0, oddsFixtures: 0, error: state.lastError };
  } finally {
    state.syncing = false;
  }
}

/** Sincroniza odds de um evento específico (usado na revalidação de aceitação). */
export async function syncOddsForFixtures(providerFixtureIds: string[]): Promise<{ ok: boolean; error?: string }> {
  const provider = await resolveProvider();
  if (!provider) return { ok: false, error: "Sem provedor configurado." };
  try {
    for (const fixtureId of providerFixtureIds) {
      const ev = await queryOne<{ id: string }>(
        `SELECT id FROM events WHERE provider = $1 AND provider_fixture_id = $2`,
        [provider.id, fixtureId]
      );
      if (!ev) continue;
      const markets = await provider.fetchOdds(fixtureId);
      if (markets.length > 0) await upsertOdds(provider.id, Number(ev.id), markets);
      await sleep(200);
    }
    state.lastError = null;
    return { ok: true };
  } catch (err) {
    state.lastError = (err as Error).message;
    state.lastErrorAt = new Date();
    return { ok: false, error: state.lastError };
  }
}

/** Garante dados frescos do modo demonstração (sem cota de API). */
export async function ensureFreshDemoData(): Promise<void> {
  const provider = await resolveProvider();
  if (!provider?.isDemo) return;
  const fresh = await queryOne<{ ok: string }>(
    `SELECT 'ok' AS ok FROM markets m
       JOIN events e ON e.id = m.event_id
      WHERE e.provider = $1
      ORDER BY m.last_updated_at DESC LIMIT 1`,
    [provider.id]
  );
  const staleMs = 5 * 60 * 1000;
  if (!fresh || !state.lastSyncAt || Date.now() - state.lastSyncAt.getTime() > staleMs) {
    await syncAll();
  }
}

async function upsertEvent(providerId: string, ev: import("./types").ProviderEvent): Promise<void> {
  const sport = await queryOne<{ id: string }>(
    `INSERT INTO sports (provider, provider_sport_id, name, slug)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (provider, provider_sport_id)
     DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug
     RETURNING id`,
    [providerId, ev.sport.providerSportId, ev.sport.name, ev.sport.slug]
  );
  const comp = await queryOne<{ id: string }>(
    `INSERT INTO competitions (provider, provider_competition_id, sport_id, name, country, logo_url, season)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (provider, provider_competition_id, season)
     DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country, logo_url = EXCLUDED.logo_url
     RETURNING id`,
    [
      providerId,
      ev.competition.providerCompetitionId,
      sport!.id,
      ev.competition.name,
      ev.competition.country ?? null,
      ev.competition.logoUrl ?? null,
      ev.competition.season ?? "unknown",
    ]
  );
  await query(
    `INSERT INTO events (provider, provider_fixture_id, sport_id, competition_id, home_team_name, home_team_logo,
                         away_team_name, away_team_logo, kickoff_at, status, home_score, away_score, is_demo, source, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     ON CONFLICT (provider, provider_fixture_id)
     DO UPDATE SET
       sport_id = EXCLUDED.sport_id, competition_id = EXCLUDED.competition_id,
       home_team_name = EXCLUDED.home_team_name, home_team_logo = EXCLUDED.home_team_logo,
       away_team_name = EXCLUDED.away_team_name, away_team_logo = EXCLUDED.away_team_logo,
       kickoff_at = EXCLUDED.kickoff_at, status = EXCLUDED.status,
       home_score = EXCLUDED.home_score, away_score = EXCLUDED.away_score,
       is_demo = EXCLUDED.is_demo, source = EXCLUDED.source, last_synced_at = now(), updated_at = now()`,
    [
      providerId,
      ev.providerFixtureId,
      sport!.id,
      comp?.id ?? null,
      ev.home.name,
      ev.home.logoUrl ?? null,
      ev.away.name,
      ev.away.logoUrl ?? null,
      ev.kickoffAt,
      ev.status,
      ev.homeScore ?? null,
      ev.awayScore ?? null,
      providerId === "demo",
      providerId,
    ]
  );
}

async function upsertOdds(
  providerId: string,
  eventId: number,
  markets: import("./types").ProviderMarket[]
): Promise<void> {
  await withTransaction(async (client) => {
    for (let i = 0; i < markets.length; i++) {
      const m = markets[i];
      const marketRow = await client.query<{ id: string }>(
        `INSERT INTO markets (event_id, provider_market_id, market_key, name, suspended, sort_order, last_updated_at)
         VALUES ($1,$2,$3,$4, FALSE, $5, now())
         ON CONFLICT (event_id, provider_market_id, market_key)
         DO UPDATE SET name = EXCLUDED.name, suspended = FALSE, last_updated_at = now()
         RETURNING id`,
        [eventId, m.providerMarketId, m.marketKey, m.name, i]
      );
      const marketId = marketRow.rows[0].id;

      // Odds anteriores para registrar histórico apenas quando muda
      const prev = await client.query<{ provider_selection_key: string; odd: string }>(
        `SELECT provider_selection_key, odd FROM selections WHERE market_id = $1`,
        [marketId]
      );
      const prevMap = new Map(prev.rows.map((r) => [r.provider_selection_key, Number(r.odd)]));

      for (const s of m.selections) {
        const selRow = await client.query<{ id: string; odd: string; prev_odd: string | null }>(
          `INSERT INTO selections (market_id, provider_selection_key, name, odd, last_updated_at)
           VALUES ($1,$2,$3,$4, now())
           ON CONFLICT (market_id, provider_selection_key)
           DO UPDATE SET name = EXCLUDED.name, odd = EXCLUDED.odd, last_updated_at = now()
           RETURNING id, odd, (SELECT odd FROM selections s2 WHERE s2.market_id = $1 AND s2.provider_selection_key = $2) AS prev_odd`,
          [marketId, s.providerSelectionKey, s.name, s.odd]
        );
        const sel = selRow.rows[0];
        const before = prevMap.get(s.providerSelectionKey);
        if (before !== undefined && Math.abs(before - s.odd) > 0.0001) {
          await client.query(
            `INSERT INTO odds_history (selection_id, odd, source) VALUES ($1, $2, $3)`,
            [sel.id, before, providerId]
          );
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Leitura para a página pública
// ---------------------------------------------------------------------------

export interface PublicSelection {
  id: number;
  key: string;
  name: string;
  odd: number;
  updatedAt: string;
  stale: boolean;
}
export interface PublicMarket {
  id: number;
  key: string;
  name: string;
  suspended: boolean;
  stale: boolean;
  selections: PublicSelection[];
}
export interface PublicEvent {
  id: number;
  fixtureId: string;
  competition: { name: string; country: string | null; logoUrl: string | null; season: string | null };
  home: { name: string; logoUrl: string | null };
  away: { name: string; logoUrl: string | null };
  kickoffAt: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  markets: PublicMarket[];
}

/** Eventos + mercados para a página pública (janela padrão: 48h). */
export async function getPublicEvents(windowHours = 48): Promise<{
  meta: ProviderMeta;
  events: PublicEvent[];
}> {
  await ensureFreshDemoData();
  const meta = await getProviderMeta();

  const eventRows = await query<{
    id: string;
    provider_fixture_id: string;
    home_team_name: string;
    home_team_logo: string | null;
    away_team_name: string;
    away_team_logo: string | null;
    kickoff_at: Date;
    status: string;
    home_score: number | null;
    away_score: number | null;
    comp_name: string | null;
    comp_country: string | null;
    comp_logo: string | null;
    comp_season: string | null;
    sport_slug: string;
  }>(
    `SELECT e.id, e.provider_fixture_id, e.home_team_name, e.home_team_logo, e.away_team_name, e.away_team_logo,
            e.kickoff_at, e.status, e.home_score, e.away_score,
            c.name AS comp_name, c.country AS comp_country, c.logo_url AS comp_logo, c.season AS comp_season,
            s.slug AS sport_slug
       FROM events e
       JOIN sports s ON s.id = e.sport_id
       LEFT JOIN competitions c ON c.id = e.competition_id
      WHERE e.kickoff_at >= now() - interval '1 hour'
        AND e.kickoff_at <= now() + make_interval(hours => $1)
        AND e.status IN ('scheduled','live')
        AND s.slug = 'futebol'
      ORDER BY c.name, e.kickoff_at
      LIMIT 200`,
    [windowHours]
  );

  if (eventRows.length === 0) return { meta, events: [] };

  const ids = eventRows.map((r) => r.id);
  const marketRows = await query<{
    id: string;
    event_id: string;
    market_key: string;
    name: string;
    suspended: boolean;
    last_updated_at: Date | null;
    sel_id: string;
    sel_key: string;
    sel_name: string;
    odd: string;
    sel_updated: Date | null;
  }>(
    `SELECT m.id, m.event_id, m.market_key, m.name, m.suspended, m.last_updated_at,
            sel.id AS sel_id, sel.provider_selection_key AS sel_key, sel.name AS sel_name,
            sel.odd, sel.last_updated_at AS sel_updated
       FROM markets m
       JOIN selections sel ON sel.market_id = m.id
      WHERE m.event_id = ANY($1::bigint[])
      ORDER BY m.sort_order, sel.id`,
    [ids]
  );

  const staleMs = config.odds.staleMinutes * 60 * 1000;
  const now = Date.now();
  const byEvent = new Map<string, PublicEvent>();

  for (const row of eventRows) {
    byEvent.set(row.id, {
      id: Number(row.id),
      fixtureId: row.provider_fixture_id,
      competition: {
        name: row.comp_name ?? "Competição",
        country: row.comp_country,
        logoUrl: row.comp_logo,
        season: row.comp_season,
      },
      home: { name: row.home_team_name, logoUrl: row.home_team_logo },
      away: { name: row.away_team_name, logoUrl: row.away_team_logo },
      kickoffAt: new Date(row.kickoff_at).toISOString(),
      status: row.status,
      homeScore: row.home_score,
      awayScore: row.away_score,
      markets: [],
    });
  }

  for (const row of marketRows) {
    const ev = byEvent.get(row.event_id);
    if (!ev) continue;
    let market = ev.markets.find((m) => m.id === Number(row.id));
    if (!market) {
      const marketStale = row.last_updated_at ? now - new Date(row.last_updated_at).getTime() > staleMs : true;
      market = {
        id: Number(row.id),
        key: row.market_key,
        name: row.name,
        suspended: row.suspended,
        stale: marketStale,
        selections: [],
      };
      ev.markets.push(market);
    }
    const selStale = row.sel_updated ? now - new Date(row.sel_updated).getTime() > staleMs : true;
    market.selections.push({
      id: Number(row.sel_id),
      key: row.sel_key,
      name: row.sel_name,
      odd: Number(row.odd),
      updatedAt: row.sel_updated ? new Date(row.sel_updated).toISOString() : "",
      stale: selStale,
    });
  }

  return { meta, events: [...byEvent.values()] };
}

// ---------------------------------------------------------------------------
// Revalidação de odds (item 5/8): usada na criação e na aceitação de cupons
// ---------------------------------------------------------------------------

export interface RevalidateSelection {
  selectionId: number;
  expectedOdd: number;
  eventId: string;
  currentOdd: number | null;
  changed: boolean;
  suspended: boolean;
  eventStatus: string;
  marketStale: boolean;
  providerFixtureId: string;
}

/**
 * Relê as odds atuais do banco (com trava de linha) e compara com o esperado.
 * Para o provedor real, tenta atualizar os eventos envolvidos se os dados
 * estiverem velhos (respeitando a cota). Se os dados não são confiáveis,
 * `providerDown = true` e a confirmação deve ser bloqueada.
 */
export async function revalidateSelections(
  expected: Array<{ selectionId: number; expectedOdd: number }>
): Promise<{ rows: RevalidateSelection[]; providerDown: boolean; reason: string | null }> {
  const provider = await resolveProvider();

  const ids = expected.map((e) => e.selectionId);
  const rows = await query<{
    selection_id: string;
    odd: string;
    sel_updated: Date | null;
    market_id: string;
    market_suspended: boolean;
    market_updated: Date | null;
    event_id: string;
    event_status: string;
    provider_fixture_id: string;
  }>(
    `SELECT sel.id AS selection_id, sel.odd, sel.last_updated_at AS sel_updated,
            m.id AS market_id, m.suspended AS market_suspended, m.last_updated_at AS market_updated,
            e.id AS event_id, e.status AS event_status, e.provider_fixture_id
       FROM selections sel
       JOIN markets m ON m.id = sel.market_id
       JOIN events e ON e.id = m.event_id
      WHERE sel.id = ANY($1::bigint[])
      FOR UPDATE OF sel, m, e`,
    [ids]
  );

  const byId = new Map(rows.map((r) => [Number(r.selection_id), r]));
  const staleMs = config.odds.staleMinutes * 60 * 1000;
  const now = Date.now();

  // Dados velhos + provedor real → tenta atualizar sob demanda (throttled)
  const staleFixtures = [
    ...new Set(
      rows
        .filter(
          (r) =>
            r.sel_updated && now - new Date(r.sel_updated).getTime() > staleMs
        )
        .map((r) => r.provider_fixture_id)
    ),
  ];
  let refreshNote: string | null = null;
  if (provider && !provider.isDemo && staleFixtures.length > 0) {
    const sinceLast = Date.now() - state.lastOddsFetchAt;
    if (sinceLast > 60_000) {
      state.lastOddsFetchAt = Date.now();
      const res = await syncOddsForFixtures(staleFixtures.slice(0, 5));
      refreshNote = res.ok ? null : res.error ?? "Falha ao atualizar odds.";
      if (res.ok) {
        // relê
        const fresh = await query<{ selection_id: string; odd: string }>(
          `SELECT sel.id AS selection_id, sel.odd FROM selections sel WHERE sel.id = ANY($1::bigint[])`,
          [ids]
        );
        for (const f of fresh) {
          const target = byId.get(Number(f.selection_id));
          if (target) {
            target.odd = f.odd;
            target.sel_updated = new Date();
          }
        }
      }
    } else {
      refreshNote = "Atualização de odds em andamento (limite de requisições).";
    }
  }

  const result: RevalidateSelection[] = expected.map((e) => {
    const r = byId.get(e.selectionId);
    if (!r) {
      return {
        selectionId: e.selectionId,
        expectedOdd: e.expectedOdd,
        eventId: "",
        currentOdd: null,
        changed: true,
        suspended: true,
        eventStatus: "missing",
        marketStale: true,
        providerFixtureId: "",
      };
    }
    const currentOdd = Number(r.odd);
    const isStale = r.sel_updated ? now - new Date(r.sel_updated).getTime() > staleMs : true;
    return {
      selectionId: e.selectionId,
      expectedOdd: e.expectedOdd,
      eventId: r.event_id,
      currentOdd,
      changed: Math.abs(currentOdd - e.expectedOdd) > 0.001,
      suspended: r.market_suspended || r.event_status !== "scheduled",
      eventStatus: r.event_status,
      marketStale: isStale,
      providerFixtureId: r.provider_fixture_id,
    };
  });

  const providerDown =
    !provider ||
    (!provider.isDemo && result.some((r) => r.marketStale)) ||
    Boolean(refreshNote && result.some((r) => r.marketStale));

  return {
    rows: result,
    providerDown,
    reason: providerDown
      ? refreshNote ??
        (!provider
          ? "Nenhum provedor de dados esportivos configurado."
          : "Dados de odds desatualizados; confirmação bloqueada até a atualização.")
      : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
