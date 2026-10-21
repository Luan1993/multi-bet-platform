import { Router } from "express";
import { z } from "zod";
import { PoolClient } from "pg";
import { config } from "../../config";
import { query, queryOne, withTransaction } from "../../db/pool";
import { badRequest, conflict, notFound, providerUnavailable, AppError } from "../../lib/errors";
import { formatCode, generateCouponCode, normalizeCouponCode } from "../../lib/codes";
import { combineOdds, potentialPayoutCents } from "../../lib/money";
import { parseBody, clientIp, userAgent } from "../../lib/validate";
import { audit, riskEvent } from "../../lib/audit";
import { couponCreateLimiter, lookupLimiter } from "../../middleware/rateLimit";
import { getPublicEvents, getProviderMeta, revalidateSelections } from "../odds/service";
import { logger } from "../../lib/logger";
import QRCode from "qrcode";

export const publicRoutes = Router();

// ---------------------------------------------------------------------------
// Configurações efetivas de risco de um tenant
// ---------------------------------------------------------------------------

export interface EffectiveSettings {
  maxPayoutCents: number;
  minStakeCents: number;
  maxStakeCents: number;
  demoMode: boolean;
  pendingExpiryHours: number;
}

export async function getEffectiveSettings(ownerId: number): Promise<EffectiveSettings> {
  const ps = await queryOne<{
    demo_mode: boolean;
    max_payout_cents: string;
    min_stake_cents: string;
    max_stake_cents: string;
  }>(`SELECT demo_mode, max_payout_cents, min_stake_cents, max_stake_cents FROM platform_settings WHERE id = 1`);
  const os = await queryOne<{
    max_payout_cents: string | null;
    min_stake_cents: string | null;
    max_stake_cents: string | null;
  }>(`SELECT max_payout_cents, min_stake_cents, max_stake_cents FROM owner_settings WHERE owner_id = $1`, [ownerId]);

  const globalMaxPayout = Number(ps?.max_payout_cents ?? config.limits.globalMaxPayoutCents);
  const globalMinStake = Number(ps?.min_stake_cents ?? config.limits.globalMinStakeCents);
  const globalMaxStake = Number(ps?.max_stake_cents ?? config.limits.globalMaxStakeCents);

  const ownerMaxPayout = os?.max_payout_cents ? Number(os.max_payout_cents) : Infinity;
  const ownerMinStake = os?.min_stake_cents ? Number(os.min_stake_cents) : 0;
  const ownerMaxStake = os?.max_stake_cents ? Number(os.max_stake_cents) : Infinity;

  return {
    maxPayoutCents: Math.min(globalMaxPayout, ownerMaxPayout),
    minStakeCents: Math.max(globalMinStake, ownerMinStake),
    maxStakeCents: Math.min(globalMaxStake, ownerMaxStake),
    demoMode: ps?.demo_mode ?? config.demoMode,
    pendingExpiryHours: config.limits.pendingCouponExpiryHours,
  };
}

async function getActiveOwnerBySlug(slug: string) {
  return queryOne<{
    id: string;
    slug: string;
    name: string;
    status: string;
    display_name: string | null;
    tagline: string | null;
    logo_path: string | null;
    primary_color: string | null;
    secondary_color: string | null;
    accent_color: string | null;
    theme: string | null;
  }>(
    `SELECT o.id, o.slug, o.name, o.status,
            b.display_name, b.tagline, b.logo_path, b.primary_color, b.secondary_color, b.accent_color, b.theme
       FROM owners o
       LEFT JOIN owner_branding b ON b.owner_id = o.id
      WHERE o.slug = $1 AND o.status = 'active'`,
    [slug]
  );
}

const DISCLAIMER_PENDING =
  "PRÉ-CUPOM — NÃO É UMA APOSTA ACEITA. Este código atesta apenas a simulação das seleções e do valor. " +
  "Não confere direito a prêmio. A aposta só passa a valer após confirmação/aceitação registrada pela operação.";

// ---------------------------------------------------------------------------
// GET /api/bet/:slug — página pública personalizada da bet
// ---------------------------------------------------------------------------
publicRoutes.get("/bet/:slug", async (req, res, next) => {
  try {
    const owner = await getActiveOwnerBySlug(req.params.slug);
    if (!owner) throw notFound("Bet não encontrada ou indisponível.", "bet_not_found");

    const settings = await getEffectiveSettings(Number(owner.id));
    const { meta, events } = await getPublicEvents();

    res.json({
      owner: {
        slug: owner.slug,
        name: owner.name,
        branding: {
          displayName: owner.display_name ?? owner.name,
          tagline: owner.tagline,
          logoPath: owner.logo_path,
          primaryColor: owner.primary_color ?? "#7c3aed",
          secondaryColor: owner.secondary_color ?? "#0f172a",
          accentColor: owner.accent_color ?? "#22d3ee",
          theme: owner.theme ?? "dark",
        },
      },
      meta: {
        demoMode: settings.demoMode,
        provider: meta,
        limits: {
          minStakeCents: settings.minStakeCents,
          maxStakeCents: settings.maxStakeCents,
          maxPayoutCents: settings.maxPayoutCents,
        },
      },
      events,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/bet/:slug/coupons — criação de pré-cupom (item 6/7)
// ---------------------------------------------------------------------------
const createCouponSchema = z.object({
  selections: z
    .array(
      z.object({
        selectionId: z.number().int().positive("Seleção inválida."),
        odd: z.number().min(1.01, "Odd inválida.").max(1000, "Odd inválida."),
      })
    )
    .min(1, "Selecione ao menos uma opção.")
    .max(10, "Máximo de 10 seleções por cupom."),
  stakeCents: z.number().int().positive("Informe o valor da aposta."),
  clientCode: z.string().trim().max(40).optional(),
});

publicRoutes.post("/bet/:slug/coupons", couponCreateLimiter, async (req, res, next) => {
  try {
    const owner = await getActiveOwnerBySlug(req.params.slug);
    if (!owner) throw notFound("Bet não encontrada ou indisponível.", "bet_not_found");
    const ownerId = Number(owner.id);

    const body = parseBody(createCouponSchema, req.body);
    const settings = await getEffectiveSettings(ownerId);
    const ip = clientIp(req);

    // Limite de stake (backend — item 9: validar também aqui, não só no front)
    if (body.stakeCents < settings.minStakeCents) {
      await riskEvent(ownerId, "stake_limit_exceeded", {
        stakeCents: body.stakeCents,
        minStakeCents: settings.minStakeCents,
      }, { ip });
      throw badRequest(
        "stake_below_minimum",
        `O valor mínimo da aposta é ${fmt(settings.minStakeCents)}.`
      );
    }
    if (body.stakeCents > settings.maxStakeCents) {
      await riskEvent(ownerId, "stake_limit_exceeded", {
        stakeCents: body.stakeCents,
        maxStakeCents: settings.maxStakeCents,
      }, { ip });
      // Se o retorno potencial seria válido, a recusa é do stake; se ambos
      // estouram, informa o limite de retorno (regra central do item 9).
      const projected = Number(body.stakeCents);
      if (projected > settings.maxPayoutCents) {
        throw badRequest(
          "stake_above_maximum",
          `O valor máximo da aposta é ${fmt(settings.maxStakeCents)} e o retorno potencial máximo por cupom é ${fmt(settings.maxPayoutCents)}.`
        );
      }
      throw badRequest(
        "stake_above_maximum",
        `O valor máximo da aposta é ${fmt(settings.maxStakeCents)}.`
      );
    }

    const selectionIds = body.selections.map((s) => s.selectionId);
    if (new Set(selectionIds).size !== selectionIds.length) {
      throw badRequest("duplicate_selections", "Existem seleções duplicadas no cupom.");
    }

    // Revalidação de odds/mercados/eventos no servidor (item 5/8)
    const reval = await revalidateSelections(
      body.selections.map((s) => ({ selectionId: s.selectionId, expectedOdd: s.odd }))
    );

    const missing = reval.rows.filter((r) => r.eventStatus === "missing");
    if (missing.length > 0) {
      await riskEvent(ownerId, "invalid_selection", { missing }, { ip });
      throw badRequest("invalid_selection", "Uma ou mais seleções não existem mais. Atualize a página.");
    }

    const suspended = reval.rows.filter((r) => r.suspended);
    if (suspended.length > 0) {
      await riskEvent(ownerId, "market_suspended", { suspended }, { ip });
      throw conflict("market_suspended", "Um ou mais mercados foram suspensos. Remova as seleções suspensas.");
    }

    const changed = reval.rows.filter((r) => r.changed);
    if (changed.length > 0) {
      await riskEvent(ownerId, "odd_changed", { changed }, { ip });
      throw conflict(
        "odd_changed",
        "As odds foram atualizadas desde a montagem do cupom. Revise o retorno antes de confirmar.",
        changed.map((c) => ({ selectionId: c.selectionId, currentOdd: c.currentOdd, previousOdd: c.expectedOdd }))
      );
    }

    // Provedor indisponível/dados não confiáveis → bloqueia (item 5)
    if (reval.providerDown) {
      await riskEvent(ownerId, "provider_unavailable", { reason: reval.reason }, { ip });
      throw providerUnavailable(reval.reason ?? undefined);
    }

    const combinedOdd = combineOdds(reval.rows.map((r) => r.currentOdd!));
    const payout = potentialPayoutCents(body.stakeCents, combinedOdd);

    // Limite máximo de retorno (item 9)
    if (payout > settings.maxPayoutCents) {
      await riskEvent(ownerId, "payout_limit_exceeded", {
        stakeCents: body.stakeCents,
        combinedOdd,
        potentialPayoutCents: payout,
        limitAppliedCents: settings.maxPayoutCents,
      }, { ip });
      throw new AppError(
        422,
        "payout_limit_exceeded",
        `O retorno potencial máximo permitido por cupom é ${fmt(settings.maxPayoutCents)}. ` +
          `Reduza o valor da aposta ou o número de seleções.`,
        { maxPayoutCents: settings.maxPayoutCents, potentialPayoutCents: payout }
      );
    }

    // Cliente (opcional): elegibilidade e limites de jogo responsável
    let clientId: number | null = null;
    if (body.clientCode) {
      const client = await queryOne<{ id: string; status: string }>(
        `SELECT id, status FROM clients WHERE owner_id = $1 AND code = $2`,
        [ownerId, body.clientCode.toUpperCase()]
      );
      if (!client) {
        throw badRequest("client_not_found", `Código de cliente não encontrado nesta bet: ${body.clientCode}`);
      }
      const eligibility = await checkClientEligibility(ownerId, Number(client.id), body.stakeCents);
      if (!eligibility.ok) {
        await riskEvent(ownerId, "client_ineligible", { clientId: client.id, reason: eligibility.reason }, { ip });
        throw new AppError(422, "client_ineligible", eligibility.message ?? "Cliente não elegível para esta aposta.");
      }
      clientId = Number(client.id);
    }

    // Snapshot das odds no momento da criação (origem + horário)
    const snapRows = await query<{
      sel_id: string;
      odd: string;
      provider_selection_key: string;
      sel_name: string;
      market_key: string;
      market_name: string;
      market_updated: Date;
      home_team_name: string;
      away_team_name: string;
      kickoff_at: Date;
      provider_fixture_id: string;
    }>(
      `SELECT sel.id AS sel_id, sel.odd, sel.provider_selection_key, sel.name AS sel_name,
              m.market_key, m.name AS market_name, m.last_updated_at AS market_updated,
              e.home_team_name, e.away_team_name, e.kickoff_at, e.provider_fixture_id
         FROM selections sel
         JOIN markets m ON m.id = sel.market_id
         JOIN events e ON e.id = m.event_id
        WHERE sel.id = ANY($1::bigint[])`,
      [selectionIds]
    );
    const snapById = new Map(snapRows.map((r) => [Number(r.sel_id), r]));
    const providerMeta = await getProviderMeta();

    const snapshot = {
      provider: { id: providerMeta.id, label: providerMeta.label, isDemo: providerMeta.isDemo },
      capturedAt: new Date().toISOString(),
      selections: reval.rows.map((r) => {
        const s = snapById.get(r.selectionId)!;
        return {
          selectionId: r.selectionId,
          odd: r.currentOdd,
          providerSelectionKey: s.provider_selection_key,
          selectionName: s.sel_name,
          marketKey: s.market_key,
          marketName: s.market_name,
          eventHome: s.home_team_name,
          eventAway: s.away_team_name,
          kickoffAt: new Date(s.kickoff_at).toISOString(),
          providerFixtureId: s.provider_fixture_id,
          oddsUpdatedAt: s.market_updated ? new Date(s.market_updated).toISOString() : null,
        };
      }),
    };

    // Cria o cupom (com novo código em caso de colisão)
    let created: { code: string } | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      const code = generateCouponCode();
      try {
        created = await withTransaction(async (client) => {
          const row = await client.query<{ code: string }>(
            `INSERT INTO coupons (code, owner_id, client_id, status, stake_cents, combined_odd,
                                  potential_payout_cents, is_demo, limit_applied_cents, odds_snapshot,
                                  expires_at, client_ip, user_agent)
             VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9, now() + make_interval(hours => $10), $11, $12)
             RETURNING code`,
            [
              code,
              ownerId,
              clientId,
              body.stakeCents,
              combinedOdd,
              payout,
              settings.demoMode,
              settings.maxPayoutCents,
              JSON.stringify(snapshot),
              settings.pendingExpiryHours,
              ip,
              userAgent(req).slice(0, 500),
            ]
          );
          await client.query(
            `INSERT INTO coupon_status_history (coupon_id, to_status, actor_role, reason)
             SELECT id, 'pending', 'public', 'pré-cupom criado pela página pública' FROM coupons WHERE code = $1`,
            [code]
          );
          await audit(
            {
              actorRole: "public",
              actorLabel: "cliente (página pública)",
              ownerId,
              action: "coupon.create_pending",
              entity: "coupon",
              entityId: code,
              after: { stakeCents: body.stakeCents, combinedOdd, payout, selections: selectionIds },
              ip,
              userAgent: userAgent(req),
            },
            client
          );
          return row.rows[0];
        });
      } catch (err) {
        lastErr = err;
        if (!(err as { code?: string }).code || (err as { code?: string }).code !== "23505") throw err;
      }
    }
    if (!created) throw lastErr ?? conflict("coupon_code_conflict", "Não foi possível gerar o código do cupom.");

    logger.info("coupon_created", { code: created.code, slug: owner.slug, payout });

    res.status(201).json({
      code: created.code,
      status: "pending",
      statusLabel: "Aguardando confirmação",
      stakeCents: body.stakeCents,
      combinedOdd,
      potentialPayoutCents: payout,
      limitAppliedCents: settings.maxPayoutCents,
      isDemo: settings.demoMode,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + settings.pendingExpiryHours * 3600 * 1000).toISOString(),
      selections: snapshot.selections,
      disclaimer: DISCLAIMER_PENDING,
      receiptUrl: `${config.publicBaseUrl}/recibo/${created.code}`,
      verificationUrl: `${config.publicBaseUrl}/recibo/${created.code}`,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/coupons/:code — consulta pública de autenticidade + recibo (item 7/8)
// ---------------------------------------------------------------------------
publicRoutes.get("/coupons/:code", lookupLimiter, async (req, res, next) => {
  try {
    const code = normalizeCouponCode(req.params.code);
    if (!code) throw badRequest("invalid_code", "Código de cupom inválido.");
    const row = await queryOne<{
      id: string;
      code: string;
      status: string;
      stake_cents: string;
      combined_odd: string;
      potential_payout_cents: string;
      due_payout_cents: string | null;
      paid_payout_cents: string | null;
      is_demo: boolean;
      created_at: Date;
      expires_at: Date;
      accepted_at: Date | null;
      cancelled_at: Date | null;
      cancel_reason: string | null;
      odds_snapshot: {
        provider: { id: string | null; label: string | null; isDemo: boolean };
        capturedAt: string;
        selections: Array<Record<string, unknown>>;
      };
      owner_slug: string;
      owner_name: string;
      display_name: string | null;
      logo_path: string | null;
      primary_color: string | null;
      secondary_color: string | null;
      accent_color: string | null;
      client_code: string | null;
      client_name: string | null;
    }>(
      `SELECT c.id, c.code, c.status, c.stake_cents, c.combined_odd, c.potential_payout_cents, c.due_payout_cents, c.paid_payout_cents,
              c.is_demo, c.created_at, c.expires_at, c.accepted_at, c.cancelled_at, c.cancel_reason, c.odds_snapshot,
              o.slug AS owner_slug, o.name AS owner_name,
              b.display_name, b.logo_path, b.primary_color, b.secondary_color, b.accent_color,
              cl.code AS client_code, cl.name AS client_name
         FROM coupons c
         JOIN owners o ON o.id = c.owner_id
         LEFT JOIN owner_branding b ON b.owner_id = c.owner_id
         LEFT JOIN clients cl ON cl.id = c.client_id
        WHERE c.code = $1`,
      [code]
    );
    if (!row) throw notFound("Cupom não encontrado. Verifique o código informado.", "coupon_not_found");

    // Expiração preguiçosa: pendentes vencidos viram 'expired'
    let status = row.status;
    if (status === "pending" && new Date(row.expires_at).getTime() < Date.now()) {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE coupons SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'pending'`,
          [row.id]
        );
        await client.query(
          `INSERT INTO coupon_status_history (coupon_id, from_status, to_status, reason) VALUES ($1,'pending','expired','expirado sem confirmação')`,
          [row.id]
        );
      });
      status = "expired";
    }

    const meanings: Record<string, string> = {
      pending: "PRÉ-CUPOM — ainda NÃO é uma aposta aceita. Aguarda confirmação pela operação.",
      accepted: "Cupom CONFIRMADO (aceito) pela operação.",
      cancelled: "Cupom cancelado pela operação.",
      expired: "Pré-cupom expirado sem confirmação — não vale como aposta.",
      won: "Cupom liquidado como VENCEDOR. Pagamento sujeito às regras da operação.",
      lost: "Cupom liquidado como PERDEDOR.",
    };

    res.json({
      verification: {
        code: row.code,
        valid: ["pending", "accepted", "won", "lost"].includes(status),
        status,
        meaning: meanings[status] ?? "Status desconhecido.",
        integrity: "ok",
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
      },
      coupon: {
        code: row.code,
        status,
        stakeCents: Number(row.stake_cents),
        combinedOdd: Number(row.combined_odd),
        potentialPayoutCents: Number(row.potential_payout_cents),
        duePayoutCents: row.due_payout_cents ? Number(row.due_payout_cents) : null,
        paidPayoutCents: row.paid_payout_cents ? Number(row.paid_payout_cents) : null,
        isDemo: row.is_demo,
        createdAt: new Date(row.created_at).toISOString(),
        acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
        cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
        cancelReason: row.cancel_reason,
        selections: row.odds_snapshot?.selections ?? [],
        provider: row.odds_snapshot?.provider ?? null,
        client: row.client_code ? { code: row.client_code, name: row.client_name } : null,
      },
      owner: {
        slug: row.owner_slug,
        name: row.owner_name,
        branding: {
          displayName: row.display_name ?? row.owner_name,
          logoPath: row.logo_path,
          primaryColor: row.primary_color ?? "#7c3aed",
          secondaryColor: row.secondary_color ?? "#0f172a",
          accentColor: row.accent_color ?? "#22d3ee",
        },
      },
      disclaimer: status === "pending" || status === "expired" ? DISCLAIMER_PENDING : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// QR de autenticidade do recibo (público, somente o código)
// ---------------------------------------------------------------------------
publicRoutes.get("/coupons/:code/qr", lookupLimiter, async (req, res, next) => {
  try {
    const code = normalizeCouponCode(req.params.code);
    if (!code) throw badRequest("invalid_code", "Código de cupom inválido.");
    const row = await queryOne<{ code: string }>(`SELECT code FROM coupons WHERE code = $1`, [code]);
    if (!row) throw notFound("Cupom não encontrado. Verifique o código informado.", "coupon_not_found");

    const png = await QRCode.toBuffer(`${config.publicBaseUrl}/recibo/${row.code}`, { width: 240, margin: 1 });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(png);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

function fmt(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function checkClientEligibility(
  ownerId: number,
  clientId: number,
  stakeCents: number
): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const client = await queryOne<{
    status: string;
    birth_date: Date | null;
  }>(`SELECT status, birth_date FROM clients WHERE id = $1 AND owner_id = $2`, [clientId, ownerId]);
  if (!client) return { ok: false, reason: "not_found", message: "Cliente não encontrado." };

  if (client.status === "blocked") {
    return { ok: false, reason: "blocked", message: "Conta de cliente bloqueada pela operação." };
  }
  if (client.status === "self_excluded") {
    return { ok: false, reason: "self_excluded", message: "Cliente em autoexclusão — apostas não permitidas." };
  }
  if (client.birth_date) {
    const age = ageFromDate(client.birth_date);
    if (age < 18) {
      return { ok: false, reason: "minor", message: "Clientes menores de 18 anos não podem apostar." };
    }
  }

  // Limites ativos de jogo responsável
  const limits = await queryOne<{ daily: string | null; monthly: string | null; excl: string | null }>(
    `SELECT
       MAX(value_cents) FILTER (WHERE limit_type = 'daily_stake' AND (expires_at IS NULL OR expires_at > now())) AS daily,
       MAX(value_cents) FILTER (WHERE limit_type = 'monthly_stake' AND (expires_at IS NULL OR expires_at > now())) AS monthly,
       MAX(1) FILTER (WHERE limit_type = 'self_exclusion' AND (expires_at IS NULL OR expires_at > now())) AS excl
     FROM client_limits WHERE client_id = $1`,
    [clientId]
  );
  if (limits?.excl) {
    return { ok: false, reason: "self_exclusion_limit", message: "Cliente com limite de autoexclusão ativo." };
  }
  if (limits?.daily) {
    const used = await queryOne<{ total: string }>(
      `SELECT COALESCE(SUM(stake_cents),0) AS total FROM coupons
        WHERE client_id = $1 AND status <> 'cancelled'
          AND created_at::date = CURRENT_DATE`,
      [clientId]
    );
    if (Number(used?.total ?? 0) + stakeCents > Number(limits.daily)) {
      return {
        ok: false,
        reason: "daily_limit",
        message: `Limite diário do cliente (${fmt(Number(limits.daily))}) seria excedido com esta aposta.`,
      };
    }
  }
  if (limits?.monthly) {
    const used = await queryOne<{ total: string }>(
      `SELECT COALESCE(SUM(stake_cents),0) AS total FROM coupons
        WHERE client_id = $1 AND status <> 'cancelled'
          AND date_trunc('month', created_at) = date_trunc('month', now())`,
      [clientId]
    );
    if (Number(used?.total ?? 0) + stakeCents > Number(limits.monthly)) {
      return {
        ok: false,
        reason: "monthly_limit",
        message: `Limite mensal do cliente (${fmt(Number(limits.monthly))}) seria excedido com esta aposta.`,
      };
    }
  }
  return { ok: true };
}

export function ageFromDate(d: Date | string): number {
  const birth = new Date(d);
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

/** Expiração preguiçosa usada também pelos painéis. */
export async function expirePendingCoupon(client: PoolClient, couponId: string): Promise<boolean> {
  const r = await client.query(
    `UPDATE coupons SET status = 'expired', updated_at = now()
      WHERE id = $1 AND status = 'pending' AND expires_at < now() RETURNING id`,
    [couponId]
  );
  if (r.rowCount && r.rowCount > 0) {
    await client.query(
      `INSERT INTO coupon_status_history (coupon_id, from_status, to_status, reason) VALUES ($1,'pending','expired','expirado sem confirmação')`,
      [couponId]
    );
    return true;
  }
  return false;
}
