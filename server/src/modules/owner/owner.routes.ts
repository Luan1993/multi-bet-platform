import { Router } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import { config } from "../../config";
import { query, queryOne, withTransaction } from "../../db/pool";
import { badRequest, conflict, notFound, providerUnavailable, AppError } from "../../lib/errors";
import {
  ManualMarketError,
  normalizeManualMarkets,
  type ManualMarketInput,
} from "../../lib/manualMarkets";
import { parseBody, intParam, dateParam, clientIp, userAgent } from "../../lib/validate";
import { audit, riskEvent } from "../../lib/audit";
import { requireAuth, requireOwner } from "../../middleware/auth";
import { combineOdds, potentialPayoutCents } from "../../lib/money";
import { evaluateCoupon, type EventResult, type CouponLeg } from "../../lib/settlement";
import { formatCode, normalizeCouponCode } from "../../lib/codes";
import { centsToNumber, toCsv } from "../../lib/csv";
import { revalidateSelections, findSelectionConflicts, getProviderMeta } from "../odds/service";
import { getEffectiveSettings } from "../public/public.routes";
import { clientsRoutes } from "./clients.routes";

export const ownerRoutes = Router();
ownerRoutes.use(requireAuth, requireOwner);

function ownerIdOf(req: Parameters<typeof clientIp>[0]): number {
  return req.user!.ownerId!;
}

function auditCtx(req: Parameters<typeof clientIp>[0]) {
  return {
    actorUserId: req.user!.id,
    actorRole: req.user!.role,
    actorLabel: req.user!.email,
    ownerId: req.user!.ownerId,
    ip: clientIp(req),
    userAgent: userAgent(req),
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
ownerRoutes.get("/dashboard", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const from = dateParam(req.query.from) ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = dateParam(req.query.to) ?? new Date();

    const stats = await queryOne<{
      total: number;
      pending: number;
      accepted: number;
      won: number;
      lost: number;
      cancelled: number;
      expired: number;
      stake_total: string;
      potential_total: string;
      due_total: string;
      paid_total: string;
      risk_events: number;
    }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='pending')::int AS pending,
              COUNT(*) FILTER (WHERE status='accepted')::int AS accepted,
              COUNT(*) FILTER (WHERE status='won')::int AS won,
              COUNT(*) FILTER (WHERE status='lost')::int AS lost,
              COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
              COUNT(*) FILTER (WHERE status='expired')::int AS expired,
              COALESCE(SUM(stake_cents) FILTER (WHERE status IN ('accepted','won','lost') AND created_at BETWEEN $2 AND $3), 0)::bigint AS stake_total,
              COALESCE(SUM(potential_payout_cents) FILTER (WHERE status IN ('pending','accepted')), 0)::bigint AS potential_total,
              COALESCE(SUM(due_payout_cents), 0)::bigint AS due_total,
              COALESCE(SUM(paid_payout_cents), 0)::bigint AS paid_total,
              (SELECT COUNT(*)::int FROM risk_events WHERE owner_id = $1 AND created_at BETWEEN $2 AND $3) AS risk_events
         FROM coupons
        WHERE owner_id = $1 AND created_at BETWEEN $2 AND $3`,
      [ownerId, from, to]
    );

    const series = await query<{ day: string; total: number; stake: string; pending: number }>(
      `SELECT created_at::date AS day, COUNT(*)::int AS total,
              COALESCE(SUM(stake_cents),0)::bigint AS stake,
              COUNT(*) FILTER (WHERE status='pending')::int AS pending
         FROM coupons
        WHERE owner_id = $1 AND created_at >= now() - interval '30 days'
        GROUP BY 1 ORDER BY 1`,
      [ownerId]
    );

    const clients = await queryOne<{ total: number; active: number }>(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='active')::int AS active
         FROM clients WHERE owner_id = $1`,
      [ownerId]
    );

    // Caixa (acumulado) e últimos pagamentos realizados
    const cash = await computeOwnerCash(ownerId);
    const recentPayments = await query<{ code: string; paid_payout_cents: string; settled_at: Date | null }>(
      `SELECT code, paid_payout_cents, settled_at FROM coupons
        WHERE owner_id = $1 AND paid_payout_cents > 0
        ORDER BY settled_at DESC NULLS LAST
        LIMIT 8`,
      [ownerId]
    );

    const settings = await getEffectiveSettings(ownerId);
    const owner = await queryOne<{ slug: string; name: string }>(
      `SELECT slug, name FROM owners WHERE id = $1`,
      [ownerId]
    );

    res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      cash,
      recentPayments: recentPayments.map((p) => ({
        code: p.code,
        paidCents: Number(p.paid_payout_cents),
        settledAt: p.settled_at ? new Date(p.settled_at).toISOString() : null,
      })),
      counters: {
        total: Number(stats?.total ?? 0),
        pending: Number(stats?.pending ?? 0),
        accepted: Number(stats?.accepted ?? 0),
        won: Number(stats?.won ?? 0),
        lost: Number(stats?.lost ?? 0),
        cancelled: Number(stats?.cancelled ?? 0),
        expired: Number(stats?.expired ?? 0),
        stakeTotalCents: Number(stats?.stake_total ?? 0),
        potentialTotalCents: Number(stats?.potential_total ?? 0),
        dueTotalCents: Number(stats?.due_total ?? 0),
        paidTotalCents: Number(stats?.paid_total ?? 0),
        riskEvents: Number(stats?.risk_events ?? 0),
        clientsTotal: Number(clients?.total ?? 0),
        clientsActive: Number(clients?.active ?? 0),
      },
      series: series.map((s) => ({
        day: typeof s.day === "string" ? s.day : new Date(s.day).toISOString().slice(0, 10),
        total: Number(s.total),
        stakeCents: Number(s.stake),
        pending: Number(s.pending),
      })),
      limits: {
        maxPayoutCents: settings.maxPayoutCents,
        minStakeCents: settings.minStakeCents,
        maxStakeCents: settings.maxStakeCents,
      },
      demoMode: settings.demoMode,
      link: `${config.publicBaseUrl}/bet/${owner?.slug}`,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Lista de cupons com filtros e paginação
// ---------------------------------------------------------------------------
ownerRoutes.get("/coupons", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const page = intParam(req.query.page, 1, 1, 100000);
    const pageSize = intParam(req.query.pageSize, 20, 1, 100);
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
    const from = dateParam(req.query.from);
    const to = dateParam(req.query.to);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const conds: string[] = ["c.owner_id = $1"];
    const params: unknown[] = [ownerId];
    if (status) {
      params.push(status);
      conds.push(`c.status = $${params.length}`);
    }
    if (from) {
      params.push(from);
      conds.push(`c.created_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conds.push(`c.created_at <= $${params.length}`);
    }
    if (q) {
      const normalizedCode = normalizeCouponCode(q);
      if (normalizedCode) {
        params.push(normalizedCode);
        conds.push(`c.code = $${params.length}`);
      } else {
        params.push(`%${q.toUpperCase()}%`);
        conds.push(
          `(UPPER(c.code) LIKE $${params.length} OR UPPER(COALESCE(cl.code,'')) LIKE $${params.length} OR UPPER(COALESCE(cl.name,'')) LIKE $${params.length})`
        );
      }
    }
    const where = conds.join(" AND ");

    const rows = await query<{
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
      client_code: string | null;
      client_name: string | null;
      client_phone: string | null;
      coupon_client_phone: string | null;
      sel_count: number;
      first_event: string | null;
    }>(
      `SELECT c.id, c.code, c.status, c.stake_cents, c.combined_odd, c.potential_payout_cents,
              c.due_payout_cents, c.paid_payout_cents, c.is_demo, c.created_at, c.expires_at, c.accepted_at,
              cl.code AS client_code, cl.name AS client_name, cl.phone AS client_phone,
              c.client_phone AS coupon_client_phone,
              jsonb_array_length(c.odds_snapshot->'selections')::int AS sel_count,
              (c.odds_snapshot#>>'{selections,0,eventHome}') || ' x ' || (c.odds_snapshot#>>'{selections,0,eventAway}') AS first_event
         FROM coupons c
         LEFT JOIN clients cl ON cl.id = c.client_id
        WHERE ${where}
        ORDER BY c.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    const totalRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM coupons c LEFT JOIN clients cl ON cl.id = c.client_id WHERE ${where}`,
      params
    );

    res.json({
      items: rows.map(mapCouponRow),
      page,
      pageSize,
      total: Number(totalRow?.count ?? 0),
    });
  } catch (err) {
    next(err);
  }
});

function mapCouponRow(r: {
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
  client_code?: string | null;
  client_name?: string | null;
  client_phone?: string | null;
  coupon_client_phone?: string | null;
  sel_count?: number;
  first_event?: string | null;
}) {
  return {
    id: Number(r.id),
    code: r.code,
    status: r.status,
    stakeCents: Number(r.stake_cents),
    combinedOdd: Number(r.combined_odd),
    potentialPayoutCents: Number(r.potential_payout_cents),
    duePayoutCents: r.due_payout_cents ? Number(r.due_payout_cents) : null,
    paidPayoutCents: r.paid_payout_cents ? Number(r.paid_payout_cents) : null,
    isDemo: r.is_demo,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    acceptedAt: r.accepted_at ? new Date(r.accepted_at).toISOString() : null,
    clientPhone: r.client_phone ?? r.coupon_client_phone ?? null,
    client: r.client_code ? { code: r.client_code, name: r.client_name, phone: r.client_phone ?? null } : null,
    selectionsCount: r.sel_count ?? 0,
    firstEvent: r.first_event ?? null,
  };
}

// ---------------------------------------------------------------------------
// Detalhe do cupom (validação pelo proprietário — item 8)
// ---------------------------------------------------------------------------
async function loadCoupon(ownerId: number, codeParam: string) {
  const code = normalizeCouponCode(codeParam);
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
    limit_applied_cents: string;
    created_at: Date;
    expires_at: Date;
    accepted_at: Date | null;
    cancelled_at: Date | null;
    cancel_reason: string | null;
    settled_at: Date | null;
    settlement_note: string | null;
    odds_snapshot: {
      provider: { id: string | null; label: string | null; isDemo: boolean };
      capturedAt: string;
      selections: Array<{
        selectionId: number;
        odd: number;
        providerSelectionKey?: string;
        selectionName: string;
        marketKey: string;
        marketName: string;
        eventHome: string;
        eventAway: string;
        kickoffAt: string;
        providerFixtureId: string;
      }>;
    };
    client_id: string | null;
    client_code: string | null;
    client_name: string | null;
    coupon_client_phone: string | null;
    client_phone: string | null;
  }>(
    `SELECT c.id, c.code, c.status, c.stake_cents, c.combined_odd, c.potential_payout_cents,
            c.due_payout_cents, c.paid_payout_cents, c.is_demo, c.limit_applied_cents, c.created_at,
            c.expires_at, c.accepted_at, c.cancelled_at, c.cancel_reason, c.settled_at, c.settlement_note,
            c.odds_snapshot, c.client_id, c.client_phone AS coupon_client_phone,
            cl.code AS client_code, cl.name AS client_name, cl.phone AS client_phone
       FROM coupons c
       LEFT JOIN clients cl ON cl.id = c.client_id
      WHERE c.code = $1 AND c.owner_id = $2`,
    [code, ownerId]
  );
  // Nunca vaza existência de cupom de outro tenant (404 genérico)
  if (!row) throw notFound("Cupom não encontrado.", "coupon_not_found");

  const history = await query<{ from_status: string | null; to_status: string; reason: string | null; created_at: Date; actor_role: string | null }>(
    `SELECT from_status, to_status, reason, created_at, actor_role
       FROM coupon_status_history WHERE coupon_id = $1 ORDER BY created_at`,
    [row.id]
  );

  const movements = await query<{ type: string; amount_cents: string; created_at: Date; note: string | null }>(
    `SELECT type, amount_cents, created_at, note FROM financial_movements
      WHERE coupon_id = $1 ORDER BY created_at`,
    [row.id]
  );

  const riskEvents = await query<{ attempt_type: string; details: unknown; created_at: Date }>(
    `SELECT attempt_type, details, created_at FROM risk_events
      WHERE coupon_code = $1 AND owner_id = $2 ORDER BY created_at DESC LIMIT 20`,
    [row.code, ownerId]
  );

  return { row, history, movements, riskEvents };
}

ownerRoutes.get("/coupons/:code", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const { row, history, movements, riskEvents } = await loadCoupon(ownerId, req.params.code);

    res.json({
      coupon: {
        id: Number(row.id),
        code: row.code,
        status: row.status,
        stakeCents: Number(row.stake_cents),
        combinedOdd: Number(row.combined_odd),
        potentialPayoutCents: Number(row.potential_payout_cents),
        duePayoutCents: row.due_payout_cents ? Number(row.due_payout_cents) : null,
        paidPayoutCents: row.paid_payout_cents ? Number(row.paid_payout_cents) : null,
        limitAppliedCents: Number(row.limit_applied_cents),
        isDemo: row.is_demo,
        createdAt: new Date(row.created_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
        acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
        cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
        cancelReason: row.cancel_reason,
        settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
        settlementNote: row.settlement_note,
        selections: row.odds_snapshot?.selections ?? [],
        provider: row.odds_snapshot?.provider ?? null,
        client: row.client_id ? { id: Number(row.client_id), code: row.client_code, name: row.client_name, phone: row.client_phone ?? null } : null,
        clientPhone: row.coupon_client_phone ?? row.client_phone ?? null,
      },
      history: history.map((h) => ({
        from: h.from_status,
        to: h.to_status,
        reason: h.reason,
        actorRole: h.actor_role,
        at: new Date(h.created_at).toISOString(),
      })),
      movements: movements.map((m) => ({
        type: m.type,
        amountCents: Number(m.amount_cents),
        note: m.note,
        at: new Date(m.created_at).toISOString(),
      })),
      riskEvents: riskEvents.map((r) => ({
        type: r.attempt_type,
        details: r.details,
        at: new Date(r.created_at).toISOString(),
      })),
      receiptUrl: `${config.publicBaseUrl}/recibo/${row.code}`,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Aceitação/confirmacao (revalida odds e limites no servidor — itens 5/8/9)
// ---------------------------------------------------------------------------
ownerRoutes.post("/coupons/:code/accept", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const { row } = await loadCoupon(ownerId, req.params.code);
    const ip = clientIp(req);

    if (row.status !== "pending") {
      throw conflict("invalid_status", `Somente cupons pendentes podem ser aceitos (status atual: ${row.status}).`);
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw conflict("coupon_expired", "Este pré-cupom expirou. Solicite ao cliente que monte um novo cupom.");
    }

    const settings = await getEffectiveSettings(ownerId);
    const snapshotSelections = (row.odds_snapshot?.selections ?? []).map((s) => ({
      selectionId: Number(s.selectionId),
      expectedOdd: Number(s.odd),
    }));
    if (snapshotSelections.length === 0) throw conflict("empty_coupon", "Cupom sem seleções.");

    const reval = await revalidateSelections(snapshotSelections);
    if (reval.providerDown) {
      await riskEvent(ownerId, "provider_unavailable", { reason: reval.reason, code: row.code }, { ip, couponCode: row.code });
      throw providerUnavailable(reval.reason ?? undefined);
    }
    const changed = reval.rows.filter((r) => r.changed);
    if (changed.length > 0) {
      await riskEvent(ownerId, "odd_changed_on_accept", { changed, code: row.code }, { ip, couponCode: row.code });
      throw conflict(
        "odd_changed",
        "As odds mudaram desde a criação do cupom. A aceitação exige nova confirmação com os valores atuais.",
        changed.map((c) => ({ selectionId: c.selectionId, previousOdd: c.expectedOdd, currentOdd: c.currentOdd }))
      );
    }
    const suspended = reval.rows.filter((r) => r.suspended);
    if (suspended.length > 0) {
      await riskEvent(ownerId, "market_suspended", { suspended, code: row.code }, { ip, couponCode: row.code });
      throw conflict("market_suspended", "Um ou mais mercados foram suspensos/eventos iniciaram. Aceitação bloqueada.");
    }

    // Defesa em profundidade: cupons criados antes da regra de exclusão mútua
    // (ou manipulados diretamente) são bloqueados na aceitação.
    const conflicts = await findSelectionConflicts(snapshotSelections.map((s) => s.selectionId));
    if (conflicts.length > 0) {
      await riskEvent(ownerId, "conflicting_selections", { code: row.code, conflicts }, { ip, couponCode: row.code });
      throw conflict(
        "conflicting_selections",
        `Este cupom contém seleções incompatíveis no mercado "${conflicts[0].marketName}". Aceitação bloqueada.`,
        { conflicts }
      );
    }

    const combinedOdd = combineOdds(reval.rows.map((r) => r.currentOdd!));
    const payout = potentialPayoutCents(Number(row.stake_cents), combinedOdd);
    if (payout > settings.maxPayoutCents) {
      await riskEvent(ownerId, "payout_limit_exceeded", {
        code: row.code,
        stakeCents: Number(row.stake_cents),
        combinedOdd,
        potentialPayoutCents: payout,
        limitAppliedCents: settings.maxPayoutCents,
      }, { ip, couponCode: row.code });
      throw new AppError(
        422,
        "payout_limit_exceeded",
        `Retorno potencial (${(payout / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}) ` +
          `ultrapassa o limite de ${(settings.maxPayoutCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}. Aceitação bloqueada.`,
        { maxPayoutCents: settings.maxPayoutCents, potentialPayoutCents: payout }
      );
    }

    await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE coupons
            SET status = 'accepted', accepted_at = now(), accepted_by = $2, combined_odd = $3,
                potential_payout_cents = $4, updated_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [row.id, req.user!.id, combinedOdd, payout]
      );
      if (!upd.rowCount) throw conflict("concurrency", "O cupom mudou de status. Recarregue e tente novamente.");

      await client.query(
        `INSERT INTO coupon_status_history (coupon_id, from_status, to_status, changed_by, actor_role, reason)
         VALUES ($1,'pending','accepted',$2,$3,'aceito pelo proprietário após revalidação')`,
        [row.id, req.user!.id, req.user!.role]
      );
      await client.query(
        `INSERT INTO financial_movements (owner_id, coupon_id, type, amount_cents, is_demo, note, created_by)
         VALUES ($2,$1,'stake_accepted',$3,$4,'stake registrada na aceitação',$5)`,
        [row.id, ownerId, Number(row.stake_cents), row.is_demo, req.user!.id]
      );
      await client.query(
        `INSERT INTO financial_movements (owner_id, coupon_id, type, amount_cents, is_demo, note, created_by)
         VALUES ($2,$1,'prize_potential',$3,$4,'prêmio potencial registrado na aceitação',$5)`,
        [row.id, ownerId, payout, row.is_demo, req.user!.id]
      );
      await audit({
        ...auditCtx(req),
        action: "coupon.accept",
        entity: "coupon",
        entityId: row.code,
        before: { status: "pending" },
        after: { status: "accepted", combinedOdd, payout },
      }, client);
    });

    res.json({ ok: true, status: "accepted", combinedOdd, potentialPayoutCents: payout });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Cancelamento
// ---------------------------------------------------------------------------
const cancelSchema = z.object({ reason: z.string().trim().min(3, "Informe o motivo do cancelamento.").max(300) });

ownerRoutes.post("/coupons/:code/cancel", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const { reason } = parseBody(cancelSchema, req.body);
    const { row } = await loadCoupon(ownerId, req.params.code);

    if (!["pending", "accepted"].includes(row.status)) {
      throw conflict("invalid_status", `Cupom não pode ser cancelado com status "${row.status}".`);
    }

    await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE coupons SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now()
          WHERE id = $1 AND status IN ('pending','accepted') RETURNING id`,
        [row.id, req.user!.id, reason]
      );
      if (!upd.rowCount) throw conflict("concurrency", "O cupom mudou de status. Recarregue e tente novamente.");
      await client.query(
        `INSERT INTO coupon_status_history (coupon_id, from_status, to_status, changed_by, actor_role, reason)
         VALUES ($1,$2,'cancelled',$3,$4,$5)`,
        [row.id, row.status, req.user!.id, req.user!.role, reason]
      );
      await audit({
        ...auditCtx(req),
        action: "coupon.cancel",
        entity: "coupon",
        entityId: row.code,
        before: { status: row.status },
        after: { status: "cancelled", reason },
      }, client);
    });

    res.json({ ok: true, status: "cancelled" });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Liquidação (won/lost) — ferramenta da operação; em modo demo é simulada
// ---------------------------------------------------------------------------
const settleSchema = z.object({
  result: z.enum(["won", "lost"], { errorMap: () => ({ message: "Resultado deve ser 'won' ou 'lost'." }) }),
  duePayoutCents: z.number().int().min(0).optional(),
  paidPayoutCents: z.number().int().min(0).optional(),
  note: z.string().trim().max(500).optional(),
});

ownerRoutes.post("/coupons/:code/settle", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const body = parseBody(settleSchema, req.body);
    const { row } = await loadCoupon(ownerId, req.params.code);

    if (row.status !== "accepted") {
      throw conflict("invalid_status", "Somente cupons aceitos podem ser liquidados.");
    }

    const potential = Number(row.potential_payout_cents);
    const due = body.result === "won" ? body.duePayoutCents ?? potential : 0;
    const paid = body.result === "won" ? body.paidPayoutCents ?? due : 0;
    if (due > Number(row.limit_applied_cents)) {
      throw new AppError(422, "payout_limit_exceeded", "O prêmio devido não pode exceder o limite aplicado ao cupom.");
    }

    await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE coupons SET status = $2, due_payout_cents = $3, paid_payout_cents = $4,
                            settled_at = now(), settlement_note = $5, updated_at = now()
          WHERE id = $1 AND status = 'accepted' RETURNING id`,
        [row.id, body.result, due, paid, body.note ?? null]
      );
      if (!upd.rowCount) throw conflict("concurrency", "O cupom mudou de status. Recarregue e tente novamente.");
      await client.query(
        `INSERT INTO coupon_status_history (coupon_id, from_status, to_status, changed_by, actor_role, reason)
         VALUES ($1,'accepted',$2,$3,$4,$5)`,
        [row.id, body.result, req.user!.id, req.user!.role, body.note ?? "liquidação pela operação"]
      );
      if (body.result === "won") {
        await client.query(
          `INSERT INTO financial_movements (owner_id, coupon_id, type, amount_cents, is_demo, note, created_by)
           VALUES ($2,$1,'prize_due',$3,$4,'prêmio efetivamente devido',$5)`,
          [row.id, ownerId, due, row.is_demo, req.user!.id]
        );
        if (paid > 0) {
          await client.query(
            `INSERT INTO financial_movements (owner_id, coupon_id, type, amount_cents, is_demo, note, created_by)
             VALUES ($2,$1,'prize_paid',$3,$4,'prêmio efetivamente pago (registrar somente após pagamento real autorizado)',$5)`,
            [row.id, ownerId, paid, row.is_demo, req.user!.id]
          );
        }
      }
      await audit({
        ...auditCtx(req),
        action: "coupon.settle",
        entity: "coupon",
        entityId: row.code,
        before: { status: "accepted" },
        after: { status: body.result, due, paid },
      }, client);
    });

    res.json({ ok: true, status: body.result, duePayoutCents: due, paidPayoutCents: paid });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Registro de pagamento de prêmio (cupom ganho, total ou parcial)
// ---------------------------------------------------------------------------
const paySchema = z.object({
  amountCents: z.number().int().positive().optional(),
  note: z.string().trim().max(500).optional(),
});

ownerRoutes.post("/coupons/:code/pay", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const body = parseBody(paySchema, req.body);
    const { row } = await loadCoupon(ownerId, req.params.code);

    if (row.status !== "won") {
      throw conflict("invalid_status", "Somente cupons ganhos podem receber pagamento.");
    }
    const due = Number(row.due_payout_cents ?? 0);
    const alreadyPaid = Number(row.paid_payout_cents ?? 0);
    const remaining = due - alreadyPaid;
    if (remaining <= 0) {
      throw conflict("already_paid", "Este cupom já foi pago integralmente.");
    }
    const amount = body.amountCents ?? remaining;
    if (amount > remaining) {
      throw new AppError(422, "amount_exceeds_due", "O valor informado excede o prêmio ainda não pago.");
    }

    await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE coupons SET paid_payout_cents = COALESCE(paid_payout_cents, 0) + $2, updated_at = now()
          WHERE id = $1 AND status = 'won' AND COALESCE(paid_payout_cents, 0) + $2 <= due_payout_cents
          RETURNING id`,
        [row.id, amount]
      );
      if (!upd.rowCount) throw conflict("concurrency", "O pagamento já foi registrado. Recarregue o cupom.");
      await client.query(
        `INSERT INTO financial_movements (owner_id, coupon_id, type, amount_cents, is_demo, note, created_by)
         VALUES ($2,$1,'prize_paid',$3,$4,$5,$6)`,
        [row.id, ownerId, amount, row.is_demo, body.note ?? "pagamento de prêmio registrado pela operação", req.user!.id]
      );
      await audit({
        ...auditCtx(req),
        action: "coupon.pay",
        entity: "coupon",
        entityId: row.code,
        before: { paidPayoutCents: alreadyPaid },
        after: { paidPayoutCents: alreadyPaid + amount },
      }, client);
    });

    res.json({ ok: true, paidPayoutCents: alreadyPaid + amount, duePayoutCents: due });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Recibo em PDF/QR do cupom (proprietário)
// ---------------------------------------------------------------------------
ownerRoutes.get("/coupons/:code/qr", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const { row } = await loadCoupon(ownerId, req.params.code);
    const url = `${config.publicBaseUrl}/recibo/${row.code}`;
    const png = await QRCode.toBuffer(url, { width: 240, margin: 1 });
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Caixa da operação (saldo, entradas, saídas, lucro/prejuízo)
// ---------------------------------------------------------------------------
async function computeOwnerCash(ownerId: number) {
  const ledger = await queryOne<{ stake_in: string; prize_paid: string; adjustments: string; accepted_coupons: number }>(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE type = 'stake_accepted'), 0)::bigint AS stake_in,
            COALESCE(SUM(amount_cents) FILTER (WHERE type = 'prize_paid'), 0)::bigint AS prize_paid,
            COALESCE(SUM(amount_cents) FILTER (WHERE type = 'adjustment'), 0)::bigint AS adjustments,
            COUNT(*) FILTER (WHERE type = 'stake_accepted')::int AS accepted_coupons
       FROM financial_movements
      WHERE owner_id = $1`,
    [ownerId]
  );
  const opening = await queryOne<{ opening_cash_cents: string }>(
    `SELECT opening_cash_cents FROM owner_settings WHERE owner_id = $1`,
    [ownerId]
  );
  const pending = await queryOne<{ due: string }>(
    `SELECT COALESCE(SUM(due_payout_cents), 0)::bigint AS due FROM coupons WHERE owner_id = $1 AND status = 'accepted'`,
    [ownerId]
  );

  const openingCash = Number(opening?.opening_cash_cents ?? 0);
  const entradas = Number(ledger?.stake_in ?? 0);
  const saidas = Number(ledger?.prize_paid ?? 0);
  const ajustes = Number(ledger?.adjustments ?? 0);

  return {
    openingCashCents: openingCash,
    entradasCents: entradas,
    saidasCents: saidas,
    ajustesCents: ajustes,
    pendentesCents: Number(pending?.due ?? 0),
    saldoCents: openingCash + entradas + ajustes - saidas,
    resultadoCents: entradas - saidas,
    acceptedCoupons: Number(ledger?.accepted_coupons ?? 0),
  };
}

const cashAdjustmentSchema = z.object({
  direction: z.enum(["in", "out"]),
  amountCents: z
    .number()
    .int()
    .positive("Informe um valor maior que zero.")
    .max(2_000_000_000, "Valor muito alto."),
  note: z.string().trim().min(3, "Descreva o motivo do ajuste (mín. 3 caracteres).").max(200),
});

ownerRoutes.post("/cash/adjustment", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const body = parseBody(cashAdjustmentSchema, req.body);
    const signed = body.direction === "out" ? -body.amountCents : body.amountCents;
    const settings = await getEffectiveSettings(ownerId);
    const label = body.direction === "in" ? "entrada" : "retirada";

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO financial_movements (owner_id, coupon_id, type, amount_cents, is_demo, note, created_by)
         VALUES ($1, NULL, 'adjustment', $2, $3, $4, $5)`,
        [ownerId, signed, settings.demoMode, `Ajuste de caixa (${label}): ${body.note}`, req.user!.id]
      );
      await audit({
        ...auditCtx(req),
        action: "cash.adjustment",
        entity: "financial_movements",
        entityId: String(ownerId),
        after: { direction: body.direction, amountCents: signed, note: body.note },
      }, client);
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

ownerRoutes.get("/cash", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const from = dateParam(req.query.from) ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = dateParam(req.query.to) ?? new Date();

    const summary = await computeOwnerCash(ownerId);

    const period = await queryOne<{ entradas: string; saidas: string; ajustes: string }>(
      `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE type = 'stake_accepted'), 0)::bigint AS entradas,
              COALESCE(SUM(amount_cents) FILTER (WHERE type = 'prize_paid'), 0)::bigint AS saidas,
              COALESCE(SUM(amount_cents) FILTER (WHERE type = 'adjustment'), 0)::bigint AS ajustes
         FROM financial_movements
        WHERE owner_id = $1 AND created_at BETWEEN $2 AND $3`,
      [ownerId, from, to]
    );

    const movementRows = await query<{
      id: string;
      type: string;
      amount_cents: string;
      note: string | null;
      created_at: Date;
      is_demo: boolean;
      coupon_code: string | null;
    }>(
      `SELECT f.id, f.type, f.amount_cents, f.note, f.created_at, f.is_demo, c.code AS coupon_code
         FROM financial_movements f
         LEFT JOIN coupons c ON c.id = f.coupon_id
        WHERE f.owner_id = $1 AND f.created_at BETWEEN $2 AND $3
        ORDER BY f.created_at DESC
        LIMIT 300`,
      [ownerId, from, to]
    );

    res.json({
      ...summary,
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        entradasCents: Number(period?.entradas ?? 0),
        saidasCents: Number(period?.saidas ?? 0),
        ajustesCents: Number(period?.ajustes ?? 0),
        resultadoCents: Number(period?.entradas ?? 0) - Number(period?.saidas ?? 0),
      },
      movements: movementRows.map((m) => ({
        id: Number(m.id),
        type: m.type,
        amountCents: Number(m.amount_cents),
        note: m.note ?? null,
        createdAt: new Date(m.created_at).toISOString(),
        isDemo: m.is_demo,
        couponCode: m.coupon_code,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Relatórios
// ---------------------------------------------------------------------------
ownerRoutes.get("/reports/daily", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const from = dateParam(req.query.from) ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = dateParam(req.query.to) ?? new Date();
    const rows = await query<{
      day: string;
      total: number;
      pending: number;
      accepted: number;
      won: number;
      lost: number;
      cancelled: number;
      expired: number;
      stake: string;
      potential: string;
      due: string;
      paid: string;
    }>(
      `SELECT created_at::date AS day,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='pending')::int AS pending,
              COUNT(*) FILTER (WHERE status='accepted')::int AS accepted,
              COUNT(*) FILTER (WHERE status='won')::int AS won,
              COUNT(*) FILTER (WHERE status='lost')::int AS lost,
              COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
              COUNT(*) FILTER (WHERE status='expired')::int AS expired,
              COALESCE(SUM(stake_cents) FILTER (WHERE status IN ('accepted','won','lost')),0)::bigint AS stake,
              COALESCE(SUM(potential_payout_cents) FILTER (WHERE status IN ('pending','accepted')),0)::bigint AS potential,
              COALESCE(SUM(due_payout_cents),0)::bigint AS due,
              COALESCE(SUM(paid_payout_cents),0)::bigint AS paid
         FROM coupons
        WHERE owner_id = $1 AND created_at BETWEEN $2 AND $3
        GROUP BY 1 ORDER BY 1`,
      [ownerId, from, to]
    );
    res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      rows: rows.map((r) => ({
        day: typeof r.day === "string" ? r.day : new Date(r.day).toISOString().slice(0, 10),
        total: r.total,
        pending: r.pending,
        accepted: r.accepted,
        won: r.won,
        lost: r.lost,
        cancelled: r.cancelled,
        expired: r.expired,
        stakeCents: Number(r.stake),
        potentialCents: Number(r.potential),
        dueCents: Number(r.due),
        paidCents: Number(r.paid),
      })),
    });
  } catch (err) {
    next(err);
  }
});

ownerRoutes.get("/reports/export.csv", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const type = req.query.type === "movements" ? "movements" : "coupons";
    const from = dateParam(req.query.from) ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = dateParam(req.query.to) ?? new Date();

    let csv: string;
    let filename: string;
    if (type === "coupons") {
      const rows = await query<Record<string, unknown>>(
        `SELECT c.code, c.status, c.created_at, c.stake_cents, c.combined_odd, c.potential_payout_cents,
                c.due_payout_cents, c.paid_payout_cents, c.is_demo, cl.code AS client_code, cl.name AS client_name,
                jsonb_array_length(c.odds_snapshot->'selections') AS sel_count
           FROM coupons c LEFT JOIN clients cl ON cl.id = c.client_id
          WHERE c.owner_id = $1 AND c.created_at BETWEEN $2 AND $3
          ORDER BY c.created_at DESC`,
        [ownerId, from, to]
      );
      csv = toCsv(
        ["Código", "Status", "Criado em", "Stake (R$)", "Odd combinada", "Retorno potencial (R$)", "Prêmio devido (R$)", "Prêmio pago (R$)", "Demo", "Código cliente", "Cliente", "Seleções"],
        rows.map((r) => [
          r.code,
          r.status,
          new Date(r.created_at as string).toLocaleString("pt-BR"),
          centsToNumber(Number(r.stake_cents)),
          Number(r.combined_odd).toFixed(4),
          centsToNumber(Number(r.potential_payout_cents)),
          centsToNumber(r.due_payout_cents ? Number(r.due_payout_cents) : null),
          centsToNumber(r.paid_payout_cents ? Number(r.paid_payout_cents) : null),
          r.is_demo ? "SIM" : "NÃO",
          r.client_code ?? "",
          r.client_name ?? "",
          String(r.sel_count ?? ""),
        ])
      );
      filename = `cupons-${new Date().toISOString().slice(0, 10)}.csv`;
    } else {
      const rows = await query<{ type: string; amount_cents: string; created_at: Date; note: string | null; code: string | null }>(
        `SELECT f.type, f.amount_cents, f.created_at, f.note, c.code
           FROM financial_movements f LEFT JOIN coupons c ON c.id = f.coupon_id
          WHERE f.owner_id = $1 AND f.created_at BETWEEN $2 AND $3
          ORDER BY f.created_at DESC`,
        [ownerId, from, to]
      );
      csv = toCsv(
        ["Data", "Tipo", "Valor (R$)", "Cupom", "Observação"],
        rows.map((r) => [
          new Date(r.created_at).toLocaleString("pt-BR"),
          r.type,
          centsToNumber(Number(r.amount_cents)),
          r.code ?? "",
          r.note ?? "",
        ])
      );
      filename = `movimentacoes-${new Date().toISOString().slice(0, 10)}.csv`;
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Identidade visual e link exclusivo
// ---------------------------------------------------------------------------
ownerRoutes.get("/branding", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const b = await queryOne<{
      display_name: string;
      tagline: string | null;
      logo_path: string | null;
      primary_color: string;
      secondary_color: string;
      accent_color: string;
      theme: string;
    }>(
      `SELECT display_name, tagline, logo_path, primary_color, secondary_color, accent_color, theme
         FROM owner_branding WHERE owner_id = $1`,
      [ownerId]
    );
    const owner = await queryOne<{ slug: string; name: string; status: string }>(
      `SELECT slug, name, status FROM owners WHERE id = $1`,
      [ownerId]
    );
    res.json({
      branding: b
        ? {
            displayName: b.display_name,
            tagline: b.tagline,
            logoPath: b.logo_path,
            primaryColor: b.primary_color,
            secondaryColor: b.secondary_color,
            accentColor: b.accent_color,
            theme: b.theme,
          }
        : null,
      link: `${config.publicBaseUrl}/bet/${owner?.slug}`,
      slug: owner?.slug,
      status: owner?.status,
    });
  } catch (err) {
    next(err);
  }
});

const brandingSchema = z.object({
  displayName: z.string().trim().min(2, "Informe o nome exibido.").max(80),
  tagline: z.string().trim().max(140).nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor primária inválida (use #rrggbb)."),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor secundária inválida (use #rrggbb)."),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor de destaque inválida (use #rrggbb)."),
  theme: z.enum(["dark", "light"]),
  logoDataUrl: z
    .string()
    .max(600_000, "Logotipo muito grande (máx. ~400KB em base64).")
    .regex(/^data:image\/(png|jpeg);base64,/, "Logotipo deve ser PNG ou JPEG em base64.")
    .nullable()
    .optional(),
});

ownerRoutes.put("/branding", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const body = parseBody(brandingSchema, req.body);

    let logoPath: string | null | undefined;
    if (body.logoDataUrl) {
      const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(body.logoDataUrl)!;
      const buffer = Buffer.from(match[2], "base64");
      if (buffer.length === 0 || buffer.length > 400_000) {
        throw badRequest("logo_too_large", "Logotipo excede o tamanho máximo de 400KB.");
      }
      // Guarda o data URL no próprio banco (coluna TEXT). Assim o logotipo
      // sobrevive a reinícios/redeploys, comuns em serviços gratuitos cujo
      // filesystem é efêmero. O frontend já usa <img src={logoPath}>.
      logoPath = body.logoDataUrl;
    }

    await query(
      `INSERT INTO owner_branding (owner_id, display_name, tagline, primary_color, secondary_color, accent_color, theme, logo_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, (SELECT logo_path FROM owner_branding WHERE owner_id = $1)))
       ON CONFLICT (owner_id) DO UPDATE SET
         display_name = EXCLUDED.display_name, tagline = EXCLUDED.tagline,
         primary_color = EXCLUDED.primary_color, secondary_color = EXCLUDED.secondary_color,
         accent_color = EXCLUDED.accent_color, theme = EXCLUDED.theme,
         logo_path = COALESCE(EXCLUDED.logo_path, owner_branding.logo_path),
         updated_at = now()`,
      [ownerId, body.displayName, body.tagline ?? null, body.primaryColor, body.secondaryColor, body.accentColor, body.theme, logoPath ?? null]
    );

    await audit({ ...auditCtx(req), action: "branding.update", entity: "owner_branding", entityId: String(ownerId), after: { ...body, logoDataUrl: undefined } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Limites operacionais da própria bet (nunca acima do global)
// ---------------------------------------------------------------------------
ownerRoutes.get("/settings", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const effective = await getEffectiveSettings(ownerId);
    const own = await queryOne<{ max_payout_cents: string | null; min_stake_cents: string | null; max_stake_cents: string | null; opening_cash_cents: string | null }>(
      `SELECT max_payout_cents, min_stake_cents, max_stake_cents, opening_cash_cents FROM owner_settings WHERE owner_id = $1`,
      [ownerId]
    );
    const platform = await queryOne<{ max_payout_cents: string; min_stake_cents: string; max_stake_cents: string; demo_mode: boolean }>(
      `SELECT max_payout_cents, min_stake_cents, max_stake_cents, demo_mode FROM platform_settings WHERE id = 1`
    );
    res.json({
      own: {
        maxPayoutCents: own?.max_payout_cents ? Number(own.max_payout_cents) : null,
        minStakeCents: own?.min_stake_cents ? Number(own.min_stake_cents) : null,
        maxStakeCents: own?.max_stake_cents ? Number(own.max_stake_cents) : null,
        openingCashCents: own?.opening_cash_cents != null ? Number(own.opening_cash_cents) : 0,
      },
      effective: {
        maxPayoutCents: effective.maxPayoutCents,
        minStakeCents: effective.minStakeCents,
        maxStakeCents: effective.maxStakeCents,
      },
      platformCeiling: {
        maxPayoutCents: Number(platform?.max_payout_cents ?? 0),
        minStakeCents: Number(platform?.min_stake_cents ?? 0),
        maxStakeCents: Number(platform?.max_stake_cents ?? 0),
      },
      demoMode: platform?.demo_mode ?? config.demoMode,
    });
  } catch (err) {
    next(err);
  }
});

const ownerSettingsSchema = z.object({
  maxPayoutCents: z.number().int().positive().nullable().optional(),
  minStakeCents: z.number().int().positive().nullable().optional(),
  maxStakeCents: z.number().int().positive().nullable().optional(),
  openingCashCents: z.number().int().min(0, "O caixa inicial não pode ser negativo.").optional(),
});

ownerRoutes.put("/settings", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const body = parseBody(ownerSettingsSchema, req.body);
    const platform = await queryOne<{ max_payout_cents: string; min_stake_cents: string; max_stake_cents: string }>(
      `SELECT max_payout_cents, min_stake_cents, max_stake_cents FROM platform_settings WHERE id = 1`
    );

    if (body.maxPayoutCents != null && body.maxPayoutCents > Number(platform!.max_payout_cents)) {
      throw badRequest(
        "limit_above_platform",
        `O limite de retorno não pode exceder o teto da plataforma (${(Number(platform!.max_payout_cents) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}).`
      );
    }
    if (
      body.minStakeCents != null &&
      body.maxStakeCents != null &&
      body.minStakeCents > body.maxStakeCents
    ) {
      throw badRequest("invalid_stake_range", "O stake mínimo não pode ser maior que o stake máximo.");
    }

    const before = await queryOne(`SELECT * FROM owner_settings WHERE owner_id = $1`, [ownerId]);
    await query(
      `INSERT INTO owner_settings (owner_id, max_payout_cents, min_stake_cents, max_stake_cents, opening_cash_cents)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (owner_id) DO UPDATE SET
         max_payout_cents = EXCLUDED.max_payout_cents,
         min_stake_cents = EXCLUDED.min_stake_cents,
         max_stake_cents = EXCLUDED.max_stake_cents,
         opening_cash_cents = EXCLUDED.opening_cash_cents,
         updated_at = now(), updated_by = $6`,
      [ownerId, body.maxPayoutCents ?? null, body.minStakeCents ?? null, body.maxStakeCents ?? null, body.openingCashCents ?? 0, req.user!.id]
    );
    await audit({ ...auditCtx(req), action: "owner_settings.update", entity: "owner_settings", entityId: String(ownerId), before, after: body });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Histórico de ações do próprio proprietário
// ---------------------------------------------------------------------------
ownerRoutes.get("/audit", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const page = intParam(req.query.page, 1, 1, 10000);
    const pageSize = intParam(req.query.pageSize, 25, 1, 100);
    const rows = await query<{
      action: string;
      entity: string | null;
      entity_id: string | null;
      actor_label: string | null;
      actor_role: string | null;
      created_at: Date;
      after: unknown;
    }>(
      `SELECT action, entity, entity_id, actor_label, actor_role, created_at, after
         FROM audit_logs
        WHERE owner_id = $1 AND (actor_user_id = $2 OR actor_role = 'public')
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [ownerId, req.user!.id, pageSize, (page - 1) * pageSize]
    );
    const total = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM audit_logs WHERE owner_id = $1 AND (actor_user_id = $2 OR actor_role = 'public')`,
      [ownerId, req.user!.id]
    );
    res.json({
      items: rows.map((r) => ({
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        actor: r.actor_label,
        actorRole: r.actor_role,
        at: new Date(r.created_at).toISOString(),
        details: r.after,
      })),
      page,
      pageSize,
      total: Number(total?.count ?? 0),
    });
  } catch (err) {
    next(err);
  }
});

// Clientes (base própria do tenant)
// ---------------------------------------------------------------------------
// Odds dos eventos (definição manual pelo proprietário)
// ---------------------------------------------------------------------------
// Permite operar com eventos reais mesmo sem um provedor de odds contratado.
// As odds manuais ficam em um mercado próprio ("manual") e têm prioridade
// sobre as odds do provedor para o mesmo evento.

interface EventMarketRow {
  marketId?: number;
  marketKey: string;
  name: string;
  suspended?: boolean;
  selections: Array<{ key: string; name: string; odd: number }>;
}

interface ManualOddRow {
  id: string;
  home_team_name: string;
  away_team_name: string;
  kickoff_at: Date;
  status: string;
  competition_name: string | null;
  manual_markets: EventMarketRow[] | null;
  provider_markets: EventMarketRow[] | null;
}

ownerRoutes.get("/events", async (req, res, next) => {
  try {
    const meta = await getProviderMeta();
    const hours = Math.min(Math.max(Number(req.query.hours) || 72, 1), 168);
    const rows = await query<ManualOddRow>(
      `SELECT e.id, e.home_team_name, e.away_team_name, e.kickoff_at, e.status,
              c.name AS competition_name,
              man.markets AS manual_markets,
              prov.markets AS provider_markets
         FROM events e
         LEFT JOIN competitions c ON c.id = e.competition_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
                    'marketId', m.id,
                    'marketKey', m.market_key,
                    'name', m.name,
                    'suspended', m.suspended,
                    'selections', (
                      SELECT json_agg(json_build_object('key', s.provider_selection_key, 'name', s.name, 'odd', s.odd::float8) ORDER BY s.id)
                        FROM selections s WHERE s.market_id = m.id
                    )
                  ) ORDER BY m.sort_order, m.id) AS markets
             FROM markets m
            WHERE m.event_id = e.id AND m.provider_market_id = 'manual'
         ) man ON TRUE
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
                    'marketKey', m.market_key,
                    'name', m.name,
                    'selections', (
                      SELECT json_agg(json_build_object('key', s.provider_selection_key, 'name', s.name, 'odd', s.odd::float8) ORDER BY s.id)
                        FROM selections s WHERE s.market_id = m.id
                    )
                  ) ORDER BY m.sort_order, m.id) AS markets
             FROM markets m
            WHERE m.event_id = e.id AND m.provider_market_id <> 'manual'
         ) prov ON TRUE
        WHERE e.status IN ('scheduled','live')
          AND e.kickoff_at BETWEEN now() - interval '2 hours' AND now() + make_interval(hours => $2)
          AND ($1::text IS NULL OR e.provider = $1)
        ORDER BY e.kickoff_at
        LIMIT 200`,
      [meta.id, hours]
    );

    res.json({
      provider: meta,
      items: rows.map((r) => {
        const manualMarkets = r.manual_markets ?? [];
        const manualKeys = new Set(manualMarkets.map((m) => m.marketKey));
        const providerMarkets = (r.provider_markets ?? []).filter(
          (m) => !manualKeys.has(m.marketKey)
        );
        const manualWinner = manualMarkets.find((m) => m.marketKey === "match_winner");
        return {
          id: Number(r.id),
          home: r.home_team_name,
          away: r.away_team_name,
          competition: r.competition_name,
          kickoffAt: new Date(r.kickoff_at).toISOString(),
          status: r.status,
          manualMarkets,
          providerMarkets,
          // Campos mantidos por compatibilidade com versões anteriores do painel.
          manual: manualWinner
            ? {
                marketId: Number(manualWinner.marketId),
                suspended: Boolean(manualWinner.suspended),
                selections: manualWinner.selections,
              }
            : null,
          providerOdds:
            providerMarkets.find((m) => m.marketKey === "match_winner")?.selections ?? [],
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

const manualSelectionSchema = z.object({
  key: z.string().trim().min(1, "Seleção inválida.").max(40),
  odd: z.number().min(1.01, "Odd mínima é 1.01.").max(1000, "Odd máxima é 1000."),
});

const manualMarketSchema = z.object({
  marketKey: z.string().trim().min(1).max(60),
  selections: z.array(manualSelectionSchema).min(1).max(12),
});

const manualOddsSchema = z.union([
  // Formato antigo (apenas Resultado Final) — mantido por compatibilidade.
  z.object({
    home: z.number().min(1.01, "Odd mínima é 1.01.").max(1000),
    draw: z.number().min(1.01, "Odd mínima é 1.01.").max(1000),
    away: z.number().min(1.01, "Odd mínima é 1.01.").max(1000),
  }),
  z.object({
    markets: z.array(manualMarketSchema).max(5),
  }),
]);

ownerRoutes.put("/events/:id/odds", async (req, res, next) => {
  try {
    const body = parseBody(manualOddsSchema, req.body);
    const ev = await queryOne<{ id: string; status: string }>(`SELECT id, status FROM events WHERE id = $1`, [
      req.params.id,
    ]);
    if (!ev) throw notFound("Evento não encontrado.", "event_not_found");
    if (ev.status !== "scheduled") {
      throw badRequest("Só é possível definir odds de eventos agendados.", "event_not_scheduled");
    }

    const input: ManualMarketInput[] =
      "markets" in body
        ? body.markets
        : [
            {
              marketKey: "match_winner",
              selections: [
                { key: "home", odd: body.home },
                { key: "draw", odd: body.draw },
                { key: "away", odd: body.away },
              ],
            },
          ];

    let markets;
    try {
      markets = normalizeManualMarkets(input);
    } catch (err) {
      if (err instanceof ManualMarketError) throw badRequest("invalid_odds", err.message);
      throw err;
    }

    const marketKeys = markets.map((m) => m.marketKey);

    await withTransaction(async (client) => {
      // O PUT substitui o conjunto de odds manuais do evento.
      if (marketKeys.length === 0) {
        await client.query(
          `DELETE FROM markets WHERE event_id = $1 AND provider_market_id = 'manual'`,
          [ev.id]
        );
      } else {
        await client.query(
          `DELETE FROM markets
            WHERE event_id = $1 AND provider_market_id = 'manual'
              AND market_key <> ALL($2::text[])`,
          [ev.id, marketKeys]
        );
        // Manual tem prioridade: remove a versão do provedor para não duplicar
        // o mesmo mercado na página pública.
        await client.query(
          `DELETE FROM markets
            WHERE event_id = $1 AND provider_market_id <> 'manual'
              AND market_key = ANY($2::text[])`,
          [ev.id, marketKeys]
        );
      }

      for (const market of markets) {
        const marketRow = await client.query<{ id: string }>(
          `INSERT INTO markets (event_id, provider_market_id, market_key, name, suspended, sort_order, last_updated_at)
           VALUES ($1, 'manual', $2, $3, FALSE, $4, now())
           ON CONFLICT (event_id, provider_market_id, market_key)
           DO UPDATE SET name = EXCLUDED.name, suspended = FALSE,
             sort_order = EXCLUDED.sort_order, last_updated_at = now()
           RETURNING id`,
          [ev.id, market.marketKey, market.name, market.sortOrder]
        );
        const marketId = marketRow.rows[0].id;
        const selectionKeys = market.selections.map((s) => s.key);

        await client.query(
          `DELETE FROM selections
            WHERE market_id = $1 AND provider_selection_key <> ALL($2::text[])`,
          [marketId, selectionKeys]
        );

        for (const sel of market.selections) {
          await client.query(
            `INSERT INTO selections (market_id, provider_selection_key, name, odd, last_updated_at)
             VALUES ($1,$2,$3,$4,now())
             ON CONFLICT (market_id, provider_selection_key)
             DO UPDATE SET name = EXCLUDED.name, odd = EXCLUDED.odd, last_updated_at = now()`,
            [marketId, sel.key, sel.name, sel.odd]
          );
        }
      }
    });

    await audit({
      ...auditCtx(req),
      action: "odds.manual_set",
      entity: "events",
      entityId: String(ev.id),
      after: {
        markets: markets.map((m) => ({ marketKey: m.marketKey, selections: m.selections })),
      },
    });

    res.json({
      ok: true,
      markets: markets.map((m) => ({
        marketKey: m.marketKey,
        name: m.name,
        selections: m.selections,
      })),
    });
  } catch (err) {
    next(err);
  }
});

ownerRoutes.delete("/events/:id/odds", async (req, res, next) => {
  try {
    const ev = await queryOne<{ id: string }>(`SELECT id FROM events WHERE id = $1`, [req.params.id]);
    if (!ev) throw notFound("Evento não encontrado.", "event_not_found");
    await query(`DELETE FROM markets WHERE event_id = $1 AND provider_market_id = 'manual'`, [ev.id]);
    await audit({
      ...auditCtx(req),
      action: "odds.manual_remove",
      entity: "events",
      entityId: String(ev.id),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Resultado do evento e liquidação automática dos cupons
// ---------------------------------------------------------------------------
interface SettlementSummary {
  won: number;
  lost: number;
  voided: number;
  pending: number;
  coupons: Array<{ code: string; status: string; duePayoutCents: number }>;
}

async function settleCouponsForFixture(
  client: { query: import("pg").PoolClient["query"] },
  ownerId: number,
  fixtureId: string,
  actor: { id: number; role: string },
  note: string
): Promise<SettlementSummary> {
  const coupons = await client.query<{
    id: string;
    code: string;
    stake_cents: string;
    limit_applied_cents: string;
    odds_snapshot: {
      selections?: Array<{
        odd?: number;
        marketKey?: string;
        providerSelectionKey?: string;
        providerFixtureId?: string;
      }>;
    };
  }>(
    `SELECT id, code, stake_cents, limit_applied_cents, odds_snapshot
       FROM coupons
      WHERE owner_id = $1 AND status = 'accepted'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(odds_snapshot->'selections') s
           WHERE s->>'providerFixtureId' = $2
        )
      FOR UPDATE`,
    [ownerId, fixtureId]
  );

  const summary: SettlementSummary = { won: 0, lost: 0, voided: 0, pending: 0, coupons: [] };

  for (const coupon of coupons.rows) {
    const legs: CouponLeg[] = (coupon.odds_snapshot?.selections ?? [])
      .filter((s) => s.providerFixtureId && s.marketKey && s.providerSelectionKey && Number(s.odd) > 1)
      .map((s) => ({
        providerFixtureId: String(s.providerFixtureId),
        marketKey: String(s.marketKey),
        providerSelectionKey: String(s.providerSelectionKey),
        odd: Number(s.odd),
      }));
    if (legs.length === 0) {
      summary.pending++;
      continue;
    }

    const fixtureIds = [...new Set(legs.map((l) => l.providerFixtureId))];
    const events = await client.query<{
      provider_fixture_id: string;
      home_score: number | null;
      away_score: number | null;
      cards_total: number | null;
      corners_total: number | null;
      shots_on_goal_total: number | null;
      status: string;
      result_final: boolean;
    }>(
      `SELECT provider_fixture_id, home_score, away_score, cards_total, corners_total,
              shots_on_goal_total, status, result_final
         FROM events
        WHERE provider_fixture_id = ANY($1::text[]) AND result_final = TRUE`,
      [fixtureIds]
    );
    const results = new Map<string, EventResult>();
    for (const e of events.rows) {
      results.set(e.provider_fixture_id, {
        fixtureId: e.provider_fixture_id,
        homeScore: e.home_score === null ? null : Number(e.home_score),
        awayScore: e.away_score === null ? null : Number(e.away_score),
        cardsTotal: e.cards_total === null ? null : Number(e.cards_total),
        cornersTotal: e.corners_total === null ? null : Number(e.corners_total),
        shotsOnGoalTotal:
          e.shots_on_goal_total === null ? null : Number(e.shots_on_goal_total),
        final: true,
        void: e.status === "cancelled",
      });
    }

    const evaluation = evaluateCoupon(
      legs,
      results,
      Number(coupon.stake_cents),
      Number(coupon.limit_applied_cents)
    );
    if (evaluation.status === "pending") {
      summary.pending++;
      continue;
    }

    const finalStatus = evaluation.status === "void" ? "cancelled" : evaluation.status;
    const due = evaluation.status === "won" ? evaluation.duePayoutCents ?? 0 : 0;
    const settlementNote =
      evaluation.status === "void"
        ? "liquidação automática: todas as seleções foram anuladas"
        : `liquidação automática pelo resultado do evento (${note})`;

    const upd = await client.query(
      `UPDATE coupons
          SET status = $2, due_payout_cents = $3, paid_payout_cents = 0,
              settled_at = now(), settlement_note = $4,
              cancel_reason = CASE WHEN $2 = 'cancelled' THEN $4 ELSE cancel_reason END,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
              updated_at = now()
        WHERE id = $1 AND status = 'accepted'`,
      [coupon.id, finalStatus, due, settlementNote]
    );
    if (!upd.rowCount) continue;

    await client.query(
      `INSERT INTO coupon_status_history (coupon_id, from_status, to_status, changed_by, actor_role, reason)
       VALUES ($1,'accepted',$2,$3,$4,$5)`,
      [coupon.id, finalStatus, actor.id, actor.role, settlementNote]
    );

    if (evaluation.status === "won" && due > 0) {
      await client.query(
        `INSERT INTO financial_movements (owner_id, coupon_id, type, amount_cents, is_demo, note, created_by)
         VALUES ($2,$1,'prize_due',$3,$4,$5,$6)`,
        [coupon.id, ownerId, due, coupon.odds_snapshot ? true : true, "prêmio devido apurado automaticamente", actor.id]
      );
      summary.won++;
    } else if (evaluation.status === "lost") {
      summary.lost++;
    } else {
      // Estorno da stake: ajuste negativo no caixa.
      await client.query(
        `INSERT INTO financial_movements (owner_id, coupon_id, type, amount_cents, is_demo, note, created_by)
         SELECT $2, $1, 'adjustment', -stake_cents, is_demo, 'estorno de stake (seleções anuladas)', $3
           FROM coupons WHERE id = $1`,
        [coupon.id, ownerId, actor.id]
      );
      summary.voided++;
    }
    summary.coupons.push({ code: coupon.code, status: finalStatus, duePayoutCents: due });
  }

  return summary;
}

const eventResultSchema = z
  .object({
    homeScore: z.number().int().min(0).max(99).optional(),
    awayScore: z.number().int().min(0).max(99).optional(),
    cardsTotal: z.number().int().min(0).max(99).nullable().optional(),
    cornersTotal: z.number().int().min(0).max(99).nullable().optional(),
    shotsOnGoalTotal: z.number().int().min(0).max(99).nullable().optional(),
    void: z.boolean().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.void || (v.homeScore !== undefined && v.awayScore !== undefined), {
    message: "Informe o placar final (ou marque o evento como anulado).",
  });

ownerRoutes.put("/events/:id/result", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const body = parseBody(eventResultSchema, req.body);
    const ev = await queryOne<{
      id: string;
      provider_fixture_id: string;
      result_final: boolean;
    }>(`SELECT id, provider_fixture_id, result_final FROM events WHERE id = $1`, [req.params.id]);
    if (!ev) throw notFound("Evento não encontrado.", "event_not_found");
    if (ev.result_final) {
      throw conflict("result_already_final", "Este evento já foi encerrado. O resultado não pode ser alterado.");
    }

    const isVoid = Boolean(body.void);
    let summary: SettlementSummary = { won: 0, lost: 0, voided: 0, pending: 0, coupons: [] };

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE events
            SET status = $2, home_score = $3, away_score = $4, cards_total = $5,
                corners_total = $6, shots_on_goal_total = $7,
                result_final = TRUE, resulted_at = now(), resulted_by = $8, result_note = $9,
                updated_at = now()
          WHERE id = $1`,
        [
          ev.id,
          isVoid ? "cancelled" : "finished",
          isVoid ? null : body.homeScore ?? null,
          isVoid ? null : body.awayScore ?? null,
          isVoid ? null : body.cardsTotal ?? null,
          isVoid ? null : body.cornersTotal ?? null,
          isVoid ? null : body.shotsOnGoalTotal ?? null,
          req.user!.id,
          body.note ?? (isVoid ? "evento anulado pela operação" : null),
        ]
      );

      summary = await settleCouponsForFixture(
        client,
        ownerId,
        ev.provider_fixture_id,
        { id: req.user!.id, role: req.user!.role },
        body.note ??
          (isVoid
            ? "evento anulado"
            : `placar ${body.homeScore}x${body.awayScore}`)
      );

      await audit({
        ...auditCtx(req),
        action: "event.result_set",
        entity: "events",
        entityId: String(ev.id),
        after: {
          homeScore: isVoid ? null : body.homeScore,
          awayScore: isVoid ? null : body.awayScore,
          cardsTotal: body.cardsTotal ?? null,
          cornersTotal: body.cornersTotal ?? null,
          shotsOnGoalTotal: body.shotsOnGoalTotal ?? null,
          void: isVoid,
          settled: summary,
        },
      }, client);
    });

    res.json({
      ok: true,
      final: true,
      void: isVoid,
      settlement: summary,
    });
  } catch (err) {
    next(err);
  }
});

ownerRoutes.get("/events/results", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const hours = Math.min(Math.max(Number(req.query.hours) || 72, 1), 168);
    const rows = await query<{
      id: string;
      provider: string;
      home_team_name: string;
      away_team_name: string;
      kickoff_at: Date;
      status: string;
      home_score: number | null;
      away_score: number | null;
      cards_total: number | null;
      corners_total: number | null;
      shots_on_goal_total: number | null;
      result_final: boolean;
      resulted_at: Date | null;
      result_note: string | null;
      competition_name: string | null;
      open_coupons: number;
    }>(
      `SELECT e.id, e.provider, e.home_team_name, e.away_team_name, e.kickoff_at, e.status,
              e.home_score, e.away_score, e.cards_total, e.corners_total, e.shots_on_goal_total,
              e.result_final, e.resulted_at, e.result_note,
              c.name AS competition_name,
              (SELECT COUNT(*)::int FROM coupons cp
                WHERE cp.owner_id = $1 AND cp.status = 'accepted'
                  AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(cp.odds_snapshot->'selections') s
                     WHERE s->>'providerFixtureId' = e.provider_fixture_id
                  )) AS open_coupons
         FROM events e
         LEFT JOIN competitions c ON c.id = e.competition_id
        WHERE e.kickoff_at BETWEEN now() - make_interval(hours => $2) AND now() + interval '15 minutes'
        ORDER BY e.result_final ASC, e.kickoff_at DESC
        LIMIT 200`,
      [ownerId, hours]
    );

    res.json({
      hours,
      items: rows.map((r) => ({
        id: Number(r.id),
        home: r.home_team_name,
        away: r.away_team_name,
        competition: r.competition_name,
        provider: r.provider,
        kickoffAt: new Date(r.kickoff_at).toISOString(),
        status: r.status,
        homeScore: r.home_score === null ? null : Number(r.home_score),
        awayScore: r.away_score === null ? null : Number(r.away_score),
        cardsTotal: r.cards_total === null ? null : Number(r.cards_total),
        cornersTotal: r.corners_total === null ? null : Number(r.corners_total),
        shotsOnGoalTotal:
          r.shots_on_goal_total === null ? null : Number(r.shots_on_goal_total),
        resultFinal: r.result_final,
        resultedAt: r.resulted_at ? new Date(r.resulted_at).toISOString() : null,
        resultNote: r.result_note,
        openCoupons: Number(r.open_coupons),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Exposição / risco: cupons abertos por evento e mercado
// ---------------------------------------------------------------------------
ownerRoutes.get("/risk", async (req, res, next) => {
  try {
    const ownerId = ownerIdOf(req);
    const rows = await query<{
      code: string;
      stake_cents: string;
      potential_payout_cents: string;
      odds_snapshot: {
        selections?: Array<{
          marketKey?: string;
          marketName?: string;
          eventHome?: string;
          eventAway?: string;
          kickoffAt?: string;
          providerFixtureId?: string;
        }>;
      };
    }>(
      `SELECT code, stake_cents, potential_payout_cents, odds_snapshot
         FROM coupons WHERE owner_id = $1 AND status = 'accepted'
        ORDER BY potential_payout_cents DESC LIMIT 5000`,
      [ownerId]
    );

    const unpaid = await queryOne<{ due: string; count: number }>(
      `SELECT COALESCE(SUM(due_payout_cents - COALESCE(paid_payout_cents,0)),0)::bigint AS due,
              COUNT(*)::int AS count
         FROM coupons
        WHERE owner_id = $1 AND status = 'won'
          AND due_payout_cents > COALESCE(paid_payout_cents,0)`,
      [ownerId]
    );

    const byEvent = new Map<string, {
      fixtureId: string;
      event: string;
      kickoffAt: string | null;
      coupons: number;
      stakeCents: number;
      potentialCents: number;
    }>();
    const byMarket = new Map<string, { marketKey: string; marketName: string; selections: number; potentialCents: number }>();

    let stakeCents = 0;
    let potentialCents = 0;
    for (const coupon of rows) {
      const stake = Number(coupon.stake_cents);
      const potential = Number(coupon.potential_payout_cents);
      stakeCents += stake;
      potentialCents += potential;

      const seenEvents = new Set<string>();
      for (const s of coupon.odds_snapshot?.selections ?? []) {
        const fixtureId = s.providerFixtureId ? String(s.providerFixtureId) : "";
        const marketKey = s.marketKey ? String(s.marketKey) : "unknown";
        const marketName = s.marketName ? String(s.marketName) : marketKey;
        if (fixtureId && !seenEvents.has(fixtureId)) {
          seenEvents.add(fixtureId);
          const key = fixtureId;
          const current = byEvent.get(key) ?? {
            fixtureId,
            event: `${s.eventHome ?? "?"} x ${s.eventAway ?? "?"}`,
            kickoffAt: s.kickoffAt ?? null,
            coupons: 0,
            stakeCents: 0,
            potentialCents: 0,
          };
          current.coupons += 1;
          current.stakeCents += stake;
          current.potentialCents += potential;
          byEvent.set(key, current);
        }

        const mKey = marketKey;
        const market = byMarket.get(mKey) ?? {
          marketKey,
          marketName,
          selections: 0,
          potentialCents: 0,
        };
        market.selections += 1;
        market.potentialCents += potential;
        byMarket.set(mKey, market);
      }
    }

    res.json({
      totals: {
        openCoupons: rows.length,
        stakeCents,
        potentialCents,
        unpaidPrizesCents: Number(unpaid?.due ?? 0),
        unpaidPrizesCount: Number(unpaid?.count ?? 0),
      },
      events: [...byEvent.values()].sort((a, b) => b.potentialCents - a.potentialCents),
      markets: [...byMarket.values()].sort((a, b) => b.potentialCents - a.potentialCents),
    });
  } catch (err) {
    next(err);
  }
});

ownerRoutes.use("/clients", clientsRoutes);
