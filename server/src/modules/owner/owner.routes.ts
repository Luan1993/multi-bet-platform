import { Router } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import { config } from "../../config";
import { query, queryOne, withTransaction } from "../../db/pool";
import { badRequest, conflict, notFound, providerUnavailable, AppError } from "../../lib/errors";
import { parseBody, intParam, dateParam, clientIp, userAgent } from "../../lib/validate";
import { audit, riskEvent } from "../../lib/audit";
import { requireAuth, requireOwner } from "../../middleware/auth";
import { combineOdds, potentialPayoutCents } from "../../lib/money";
import { formatCode, normalizeCouponCode } from "../../lib/codes";
import { centsToNumber, toCsv } from "../../lib/csv";
import { revalidateSelections, findSelectionConflicts } from "../odds/service";
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

    const settings = await getEffectiveSettings(ownerId);
    const owner = await queryOne<{ slug: string; name: string }>(
      `SELECT slug, name FROM owners WHERE id = $1`,
      [ownerId]
    );

    res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
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
    const own = await queryOne<{ max_payout_cents: string | null; min_stake_cents: string | null; max_stake_cents: string | null }>(
      `SELECT max_payout_cents, min_stake_cents, max_stake_cents FROM owner_settings WHERE owner_id = $1`,
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
      `INSERT INTO owner_settings (owner_id, max_payout_cents, min_stake_cents, max_stake_cents)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (owner_id) DO UPDATE SET
         max_payout_cents = EXCLUDED.max_payout_cents,
         min_stake_cents = EXCLUDED.min_stake_cents,
         max_stake_cents = EXCLUDED.max_stake_cents,
         updated_at = now(), updated_by = $5`,
      [ownerId, body.maxPayoutCents ?? null, body.minStakeCents ?? null, body.maxStakeCents ?? null, req.user!.id]
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
ownerRoutes.use("/clients", clientsRoutes);
