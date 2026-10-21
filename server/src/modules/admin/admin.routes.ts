import { Router, Request } from "express";
import { z } from "zod";
import { query, queryOne, withTransaction, closePool } from "../../db/pool";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { parseBody, intParam, dateParam } from "../../lib/validate";
import { audit } from "../../lib/audit";
import { requireAdmin } from "../../middleware/auth";
import { generateInitialPassword, hashPassword, validatePasswordPolicy } from "../../lib/password";
import { revokeAllUserSessions } from "../../lib/session";
import { getProviderMeta, invalidateProviderCache, resolveProvider, providerState } from "../odds/service";
import { config } from "../../config";

export const adminRoutes = Router();
adminRoutes.use(requireAdmin);

function auditCtx(req: Request) {
  return {
    actorUserId: req.user!.id,
    actorRole: req.user!.role,
    actorLabel: req.user!.email,
    ownerId: null as number | null,
    ip: req.ip,
    userAgent: (req.headers["user-agent"] || "").slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// Estatísticas gerais da plataforma
// ---------------------------------------------------------------------------
adminRoutes.get("/stats", async (_req, res, next) => {
  try {
    const owners = await queryOne<{
      total: number;
      active: number;
      suspended: number;
      blocked: number;
    }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='active')::int AS active,
              COUNT(*) FILTER (WHERE status='suspended')::int AS suspended,
              COUNT(*) FILTER (WHERE status='blocked')::int AS blocked
         FROM owners`
    );
    const coupons = await queryOne<{
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
      `SELECT COUNT(*)::int AS total,
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
         FROM coupons`
    );
    const clients = await queryOne<{ total: number }>(`SELECT COUNT(*)::int AS total FROM clients`);
    const series = await query<{ day: string; total: number; stake: string }>(
      `SELECT created_at::date AS day, COUNT(*)::int AS total, COALESCE(SUM(stake_cents),0)::bigint AS stake
         FROM coupons WHERE created_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 1`
    );
    const settings = await queryOne<{ demo_mode: boolean; max_payout_cents: string; min_stake_cents: string; max_stake_cents: string }>(
      `SELECT demo_mode, max_payout_cents, min_stake_cents, max_stake_cents FROM platform_settings WHERE id = 1`
    );
    const risk = await queryOne<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM risk_events WHERE created_at >= now() - interval '30 days'`
    );

    res.json({
      owners: {
        total: Number(owners?.total ?? 0),
        active: Number(owners?.active ?? 0),
        suspended: Number(owners?.suspended ?? 0),
        blocked: Number(owners?.blocked ?? 0),
      },
      clients: Number(clients?.total ?? 0),
      coupons: {
        total: Number(coupons?.total ?? 0),
        pending: Number(coupons?.pending ?? 0),
        accepted: Number(coupons?.accepted ?? 0),
        won: Number(coupons?.won ?? 0),
        lost: Number(coupons?.lost ?? 0),
        cancelled: Number(coupons?.cancelled ?? 0),
        expired: Number(coupons?.expired ?? 0),
        stakeTotalCents: Number(coupons?.stake ?? 0),
        potentialTotalCents: Number(coupons?.potential ?? 0),
        dueTotalCents: Number(coupons?.due ?? 0),
        paidTotalCents: Number(coupons?.paid ?? 0),
      },
      riskEvents30d: Number(risk?.total ?? 0),
      series: series.map((s) => ({
        day: typeof s.day === "string" ? s.day : new Date(s.day).toISOString().slice(0, 10),
        total: s.total,
        stakeCents: Number(s.stake),
      })),
      platformSettings: {
        demoMode: settings?.demo_mode ?? config.demoMode,
        maxPayoutCents: Number(settings?.max_payout_cents ?? 0),
        minStakeCents: Number(settings?.min_stake_cents ?? 0),
        maxStakeCents: Number(settings?.max_stake_cents ?? 0),
      },
      provider: await getProviderMeta(),
      providerState: providerState(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Gestão de proprietários (somente administrador — sem cadastro público)
// ---------------------------------------------------------------------------
adminRoutes.get("/owners", async (req, res, next) => {
  try {
    const page = intParam(req.query.page, 1, 1, 100000);
    const pageSize = intParam(req.query.pageSize, 20, 1, 100);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;

    const conds: string[] = ["1=1"];
    const params: unknown[] = [];
    if (q) {
      params.push(`%${q}%`);
      conds.push(`(o.slug ILIKE $${params.length} OR o.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      conds.push(`o.status = $${params.length}`);
    }
    const where = conds.join(" AND ");

    const rows = await query<{
      id: string;
      slug: string;
      name: string;
      status: string;
      contact_email: string | null;
      created_at: Date;
      login_email: string | null;
      display_name: string | null;
      logo_path: string | null;
      primary_color: string | null;
      coupons: string;
      clients: string;
      stake_30d: string;
    }>(
      `SELECT o.id, o.slug, o.name, o.status, o.contact_email, o.created_at,
              u.email AS login_email, b.display_name, b.logo_path, b.primary_color,
              (SELECT COUNT(*) FROM coupons c WHERE c.owner_id = o.id)::text AS coupons,
              (SELECT COUNT(*) FROM clients cl WHERE cl.owner_id = o.id)::text AS clients,
              (SELECT COALESCE(SUM(c2.stake_cents),0) FROM coupons c2
                WHERE c2.owner_id = o.id AND c2.created_at >= now() - interval '30 days'
                  AND c2.status IN ('accepted','won','lost'))::text AS stake_30d
         FROM owners o
         LEFT JOIN users u ON u.owner_id = o.id
         LEFT JOIN owner_branding b ON b.owner_id = o.id
        WHERE ${where}
        ORDER BY o.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const total = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM owners o LEFT JOIN users u ON u.owner_id = o.id WHERE ${where}`,
      params
    );

    res.json({
      items: rows.map((r) => ({
        id: Number(r.id),
        slug: r.slug,
        name: r.name,
        status: r.status,
        contactEmail: r.contact_email,
        loginEmail: r.login_email,
        createdAt: new Date(r.created_at).toISOString(),
        branding: {
          displayName: r.display_name,
          logoPath: r.logo_path,
          primaryColor: r.primary_color,
        },
        stats: {
          couponsTotal: Number(r.coupons),
          clientsTotal: Number(r.clients),
          stake30dCents: Number(r.stake_30d),
        },
      })),
      page,
      pageSize,
      total: Number(total?.count ?? 0),
    });
  } catch (err) {
    next(err);
  }
});

const createOwnerSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, "Link exclusivo inválido (use letras minúsculas, números e hífen)."),
  name: z.string().trim().min(2, "Informe o nome da bet.").max(100),
  document: z.string().trim().max(30).nullable().optional(),
  contactEmail: z.string().trim().email("E-mail inválido.").max(200).nullable().optional(),
  contactPhone: z.string().trim().max(30).nullable().optional(),
  loginEmail: z.string().trim().toLowerCase().email("E-mail de login inválido.").max(200),
  initialPassword: z.string().optional(),
  maxPayoutCents: z.number().int().positive().nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

adminRoutes.post("/owners", async (req, res, next) => {
  try {
    const body = parseBody(createOwnerSchema, req.body);

    const dupSlug = await queryOne(`SELECT id FROM owners WHERE slug = $1`, [body.slug]);
    if (dupSlug) throw conflict("slug_taken", "Já existe uma bet com este link exclusivo.");
    const dupEmail = await queryOne(`SELECT id FROM users WHERE lower(email) = $1`, [body.loginEmail]);
    if (dupEmail) throw conflict("email_taken", "Já existe um usuário com este e-mail de login.");

    let password = body.initialPassword || generateInitialPassword();
    const policyError = validatePasswordPolicy(password);
    if (policyError) throw badRequest("weak_password", policyError);

    const platform = await queryOne<{ max_payout_cents: string }>(
      `SELECT max_payout_cents FROM platform_settings WHERE id = 1`
    );
    if (body.maxPayoutCents != null && body.maxPayoutCents > Number(platform?.max_payout_cents ?? 0)) {
      throw badRequest("limit_above_platform", "O limite solicitado excede o teto da plataforma.");
    }

    const created = await withTransaction(async (client) => {
      const owner = await client.query<{ id: string }>(
        `INSERT INTO owners (slug, name, document, contact_email, contact_phone)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [body.slug, body.name, body.document ?? null, body.contactEmail ?? null, body.contactPhone ?? null]
      );
      const ownerId = owner.rows[0].id;
      await client.query(
        `INSERT INTO owner_branding (owner_id, display_name, primary_color, secondary_color, accent_color)
         VALUES ($1,$2,$3,$4,$5)`,
        [ownerId, body.name, body.primaryColor ?? "#7c3aed", body.secondaryColor ?? "#0f172a", body.accentColor ?? "#22d3ee"]
      );
      await client.query(`INSERT INTO owner_settings (owner_id, max_payout_cents) VALUES ($1,$2)`, [
        ownerId,
        body.maxPayoutCents ?? null,
      ]);
      await client.query(
        `INSERT INTO users (email, password_hash, display_name, role, owner_id, must_change_password)
         VALUES ($1,$2,$3,'owner',$4, FALSE)`,
        [body.loginEmail, await hashPassword(password), `Proprietário — ${body.name}`, ownerId]
      );
      await audit(
        {
          ...auditCtx(req),
          ownerId: Number(ownerId),
          action: "owner.create",
          entity: "owner",
          entityId: ownerId,
          after: { slug: body.slug, name: body.name, loginEmail: body.loginEmail },
        },
        client
      );
      return ownerId;
    });

    res.status(201).json({
      id: Number(created),
      slug: body.slug,
      loginEmail: body.loginEmail,
      // Senha inicial retornada uma única vez ao administrador
      initialPassword: password,
      link: `${config.publicBaseUrl}/bet/${body.slug}`,
    });
  } catch (err) {
    next(err);
  }
});

adminRoutes.get("/owners/:id", async (req, res, next) => {
  try {
    const owner = await queryOne<{
      id: string;
      slug: string;
      name: string;
      document: string | null;
      contact_email: string | null;
      contact_phone: string | null;
      status: string;
      notes: string | null;
      created_at: Date;
      login_email: string | null;
      user_status: string | null;
      display_name: string | null;
      tagline: string | null;
      logo_path: string | null;
      primary_color: string | null;
      secondary_color: string | null;
      accent_color: string | null;
      theme: string | null;
      max_payout_cents: string | null;
      min_stake_cents: string | null;
      max_stake_cents: string | null;
    }>(
      `SELECT o.id, o.slug, o.name, o.document, o.contact_email, o.contact_phone, o.status, o.notes, o.created_at,
              u.email AS login_email, u.status AS user_status,
              b.display_name, b.tagline, b.logo_path, b.primary_color, b.secondary_color, b.accent_color, b.theme,
              s.max_payout_cents, s.min_stake_cents, s.max_stake_cents
         FROM owners o
         LEFT JOIN users u ON u.owner_id = o.id
         LEFT JOIN owner_branding b ON b.owner_id = o.id
         LEFT JOIN owner_settings s ON s.owner_id = o.id
        WHERE o.id = $1`,
      [req.params.id]
    );
    if (!owner) throw notFound("Proprietário não encontrado.", "owner_not_found");

    const stats = await queryOne<{
      total: number;
      pending: number;
      accepted: number;
      stake: string;
      potential: string;
      due: string;
      paid: string;
      clients: number;
    }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='pending')::int AS pending,
              COUNT(*) FILTER (WHERE status='accepted')::int AS accepted,
              COALESCE(SUM(stake_cents) FILTER (WHERE status IN ('accepted','won','lost')),0)::bigint AS stake,
              COALESCE(SUM(potential_payout_cents) FILTER (WHERE status IN ('pending','accepted')),0)::bigint AS potential,
              COALESCE(SUM(due_payout_cents),0)::bigint AS due,
              COALESCE(SUM(paid_payout_cents),0)::bigint AS paid,
              (SELECT COUNT(*)::int FROM clients WHERE owner_id = $1) AS clients
         FROM coupons WHERE owner_id = $1`,
      [req.params.id]
    );
    const platform = await queryOne<{ max_payout_cents: string }>(
      `SELECT max_payout_cents FROM platform_settings WHERE id = 1`
    );

    res.json({
      owner: {
        id: Number(owner.id),
        slug: owner.slug,
        name: owner.name,
        document: owner.document,
        contactEmail: owner.contact_email,
        contactPhone: owner.contact_phone,
        status: owner.status,
        notes: owner.notes,
        createdAt: new Date(owner.created_at).toISOString(),
        loginEmail: owner.login_email,
        userStatus: owner.user_status,
        branding: {
          displayName: owner.display_name,
          tagline: owner.tagline,
          logoPath: owner.logo_path,
          primaryColor: owner.primary_color,
          secondaryColor: owner.secondary_color,
          accentColor: owner.accent_color,
          theme: owner.theme,
        },
        settings: {
          maxPayoutCents: owner.max_payout_cents ? Number(owner.max_payout_cents) : null,
          minStakeCents: owner.min_stake_cents ? Number(owner.min_stake_cents) : null,
          maxStakeCents: owner.max_stake_cents ? Number(owner.max_stake_cents) : null,
          platformCeilingCents: Number(platform?.max_payout_cents ?? 0),
        },
      },
      stats: {
        couponsTotal: Number(stats?.total ?? 0),
        pending: Number(stats?.pending ?? 0),
        accepted: Number(stats?.accepted ?? 0),
        stakeTotalCents: Number(stats?.stake ?? 0),
        potentialTotalCents: Number(stats?.potential ?? 0),
        dueTotalCents: Number(stats?.due ?? 0),
        paidTotalCents: Number(stats?.paid ?? 0),
        clientsTotal: Number(stats?.clients ?? 0),
      },
      link: `${config.publicBaseUrl}/bet/${owner.slug}`,
    });
  } catch (err) {
    next(err);
  }
});

const patchOwnerSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  document: z.string().trim().max(30).nullable().optional(),
  contactEmail: z.string().trim().email().max(200).nullable().optional(),
  contactPhone: z.string().trim().max(30).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(["active", "suspended", "blocked"]).optional(),
});

adminRoutes.patch("/owners/:id", async (req, res, next) => {
  try {
    const body = parseBody(patchOwnerSchema, req.body);
    const before = await queryOne(`SELECT * FROM owners WHERE id = $1`, [req.params.id]);
    if (!before) throw notFound("Proprietário não encontrado.", "owner_not_found");

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE owners SET
            name = COALESCE($2, name),
            document = CASE WHEN $3 THEN $4 ELSE document END,
            contact_email = CASE WHEN $5 THEN $6 ELSE contact_email END,
            contact_phone = CASE WHEN $7 THEN $8 ELSE contact_phone END,
            notes = CASE WHEN $9 THEN $10 ELSE notes END,
            status = COALESCE($11, status),
            updated_at = now()
          WHERE id = $1`,
        [
          req.params.id,
          body.name ?? null,
          body.document !== undefined,
          body.document ?? null,
          body.contactEmail !== undefined,
          body.contactEmail ?? null,
          body.contactPhone !== undefined,
          body.contactPhone ?? null,
          body.notes !== undefined,
          body.notes ?? null,
          body.status ?? null,
        ]
      );
      if (body.status) {
        // Suspensão/bloqueio também afetam o login e derruba sessões ativas
        await client.query(`UPDATE users SET status = $2, updated_at = now() WHERE owner_id = $1`, [
          req.params.id,
          body.status,
        ]);
        if (body.status !== "active") {
          await client.query(
            `UPDATE sessions SET revoked_at = now()
              WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE owner_id = $1)`,
            [req.params.id]
          );
        }
      }
      await audit(
        {
          ...auditCtx(req),
          ownerId: Number(req.params.id),
          action: body.status ? `owner.status_${body.status}` : "owner.update",
          entity: "owner",
          entityId: String(req.params.id),
          before,
          after: body,
        },
        client
      );
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const resetPasswordSchema = z.object({ newPassword: z.string().optional() });

adminRoutes.post("/owners/:id/reset-password", async (req, res, next) => {
  try {
    const body = parseBody(resetPasswordSchema, req.body);
    const owner = await queryOne<{ id: string; slug: string; name: string }>(
      `SELECT id, slug, name FROM owners WHERE id = $1`,
      [req.params.id]
    );
    if (!owner) throw notFound("Proprietário não encontrado.", "owner_not_found");

    let password = body.newPassword || generateInitialPassword();
    const policyError = validatePasswordPolicy(password);
    if (policyError) throw badRequest("weak_password", policyError);

    const updated = await queryOne<{ id: string }>(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE owner_id = $2 RETURNING id`,
      [await hashPassword(password), req.params.id]
    );
    if (!updated) throw notFound("Usuário de login do proprietário não encontrado.", "user_not_found");

    await revokeAllUserSessions(Number(updated.id));
    await audit({
      ...auditCtx(req),
      ownerId: Number(req.params.id),
      action: "owner.reset_password",
      entity: "user",
      entityId: String(updated.id),
    });

    res.json({ ok: true, newPassword: password });
  } catch (err) {
    next(err);
  }
});

adminRoutes.put("/owners/:id/branding", async (req, res, next) => {
  try {
    const schema = z.object({
      displayName: z.string().trim().min(2).max(80),
      tagline: z.string().trim().max(140).nullable().optional(),
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      theme: z.enum(["dark", "light"]),
    });
    const body = parseBody(schema, req.body);
    const owner = await queryOne(`SELECT id FROM owners WHERE id = $1`, [req.params.id]);
    if (!owner) throw notFound("Proprietário não encontrado.", "owner_not_found");

    await query(
      `INSERT INTO owner_branding (owner_id, display_name, tagline, primary_color, secondary_color, accent_color, theme)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (owner_id) DO UPDATE SET
         display_name = EXCLUDED.display_name, tagline = EXCLUDED.tagline,
         primary_color = EXCLUDED.primary_color, secondary_color = EXCLUDED.secondary_color,
         accent_color = EXCLUDED.accent_color, theme = EXCLUDED.theme, updated_at = now()`,
      [req.params.id, body.displayName, body.tagline ?? null, body.primaryColor, body.secondaryColor, body.accentColor, body.theme]
    );
    await audit({
      ...auditCtx(req),
      ownerId: Number(req.params.id),
      action: "owner.branding_update",
      entity: "owner_branding",
      entityId: String(req.params.id),
      after: body,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminRoutes.put("/owners/:id/settings", async (req, res, next) => {
  try {
    const schema = z.object({
      maxPayoutCents: z.number().int().positive().nullable().optional(),
      minStakeCents: z.number().int().positive().nullable().optional(),
      maxStakeCents: z.number().int().positive().nullable().optional(),
    });
    const body = parseBody(schema, req.body);
    const owner = await queryOne(`SELECT id FROM owners WHERE id = $1`, [req.params.id]);
    if (!owner) throw notFound("Proprietário não encontrado.", "owner_not_found");

    const platform = await queryOne<{ max_payout_cents: string; max_stake_cents: string }>(
      `SELECT max_payout_cents, max_stake_cents FROM platform_settings WHERE id = 1`
    );
    if (body.maxPayoutCents != null && body.maxPayoutCents > Number(platform!.max_payout_cents)) {
      throw badRequest("limit_above_platform", "O limite não pode exceder o teto da plataforma.");
    }
    if (body.maxStakeCents != null && body.maxStakeCents > Number(platform!.max_stake_cents)) {
      throw badRequest("stake_above_platform", "O stake máximo não pode exceder o teto da plataforma.");
    }

    const before = await queryOne(`SELECT * FROM owner_settings WHERE owner_id = $1`, [req.params.id]);
    await query(
      `INSERT INTO owner_settings (owner_id, max_payout_cents, min_stake_cents, max_stake_cents, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (owner_id) DO UPDATE SET
         max_payout_cents = EXCLUDED.max_payout_cents,
         min_stake_cents = EXCLUDED.min_stake_cents,
         max_stake_cents = EXCLUDED.max_stake_cents,
         updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [req.params.id, body.maxPayoutCents ?? null, body.minStakeCents ?? null, body.maxStakeCents ?? null, req.user!.id]
    );
    await audit({
      ...auditCtx(req),
      ownerId: Number(req.params.id),
      action: "owner.settings_update",
      entity: "owner_settings",
      entityId: String(req.params.id),
      before,
      after: body,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminRoutes.delete("/owners/:id", async (req, res, next) => {
  try {
    const owner = await queryOne<{ id: string; slug: string; name: string }>(
      `SELECT id, slug, name FROM owners WHERE id = $1`,
      [req.params.id]
    );
    if (!owner) throw notFound("Proprietário não encontrado.", "owner_not_found");

    const usage = await queryOne<{ coupons: string; clients: string }>(
      `SELECT (SELECT COUNT(*) FROM coupons WHERE owner_id = $1)::text AS coupons,
              (SELECT COUNT(*) FROM clients WHERE owner_id = $1)::text AS clients`,
      [req.params.id]
    );
    if (Number(usage?.coupons ?? 0) > 0 || Number(usage?.clients ?? 0) > 0) {
      throw conflict(
        "owner_in_use",
        "Esta bet possui cupons ou clientes registrados. Exclusão não permitida — use a suspensão ou bloqueio para encerrar a operação (preservando a auditoria)."
      );
    }

    await withTransaction(async (client) => {
      await client.query(`DELETE FROM owners WHERE id = $1`, [req.params.id]);
      await audit(
        {
          ...auditCtx(req),
          action: "owner.delete",
          entity: "owner",
          entityId: String(req.params.id),
          before: { slug: owner.slug, name: owner.name },
        },
        client
      );
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Configurações globais da plataforma
// ---------------------------------------------------------------------------
adminRoutes.get("/settings", async (_req, res, next) => {
  try {
    const s = await queryOne<{
      demo_mode: boolean;
      max_payout_cents: string;
      min_stake_cents: string;
      max_stake_cents: string;
      compliance: unknown;
      updated_at: Date;
    }>(`SELECT demo_mode, max_payout_cents, min_stake_cents, max_stake_cents, compliance, updated_at FROM platform_settings WHERE id = 1`);
    res.json({
      demoMode: s?.demo_mode ?? config.demoMode,
      maxPayoutCents: Number(s?.max_payout_cents ?? config.limits.globalMaxPayoutCents),
      minStakeCents: Number(s?.min_stake_cents ?? config.limits.globalMinStakeCents),
      maxStakeCents: Number(s?.max_stake_cents ?? config.limits.globalMaxStakeCents),
      compliance: s?.compliance ?? {},
      updatedAt: s?.updated_at ? new Date(s.updated_at).toISOString() : null,
    });
  } catch (err) {
    next(err);
  }
});

const putSettingsSchema = z.object({
  demoMode: z.boolean(),
  maxPayoutCents: z.number().int().min(100, "Limite mínimo de R$ 1,00.").max(100_000_000),
  minStakeCents: z.number().int().min(1),
  maxStakeCents: z.number().int().min(100),
  compliance: z.record(z.unknown()).optional(),
});

adminRoutes.put("/settings", async (req, res, next) => {
  try {
    const body = parseBody(putSettingsSchema, req.body);
    if (body.minStakeCents > body.maxStakeCents) {
      throw badRequest("invalid_stake_range", "O stake mínimo não pode ser maior que o máximo.");
    }

    const before = await queryOne(`SELECT * FROM platform_settings WHERE id = 1`);
    await query(
      `INSERT INTO platform_settings (id, demo_mode, max_payout_cents, min_stake_cents, max_stake_cents, compliance, updated_by)
       VALUES (1,$1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         demo_mode = EXCLUDED.demo_mode, max_payout_cents = EXCLUDED.max_payout_cents,
         min_stake_cents = EXCLUDED.min_stake_cents, max_stake_cents = EXCLUDED.max_stake_cents,
         compliance = EXCLUDED.compliance, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [
        body.demoMode,
        body.maxPayoutCents,
        body.minStakeCents,
        body.maxStakeCents,
        JSON.stringify(body.compliance ?? (before?.compliance as unknown) ?? {}),
        req.user!.id,
      ]
    );
    await audit({
      ...auditCtx(req),
      action: "platform_settings.update",
      entity: "platform_settings",
      entityId: "1",
      before,
      after: { ...body, compliance: undefined },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Integrações (provedor de odds + pagamentos)
// ---------------------------------------------------------------------------
adminRoutes.get("/providers", async (_req, res, next) => {
  try {
    const rows = await query<{
      id: string;
      provider: string;
      enabled: boolean;
      api_key: string | null;
      last_test_at: Date | null;
      last_test_ok: boolean | null;
      last_test_message: string | null;
    }>(
      `SELECT id, provider, enabled, api_key, last_test_at, last_test_ok, last_test_message
         FROM provider_configs ORDER BY provider`
    );
    const meta = await getProviderMeta();
    res.json({
      items: rows.map((r) => ({
        id: Number(r.id),
        provider: r.provider,
        enabled: r.enabled,
        // Chave sempre mascarada nas respostas
        apiKeyMasked: r.api_key ? `••••••••${r.api_key.slice(-4)}` : null,
        lastTestAt: r.last_test_at ? new Date(r.last_test_at).toISOString() : null,
        lastTestOk: r.last_test_ok,
        lastTestMessage: r.last_test_message,
      })),
      active: meta,
    });
  } catch (err) {
    next(err);
  }
});

const putProviderSchema = z.object({
  enabled: z.boolean(),
  apiKey: z.string().trim().min(8, "Chave muito curta.").max(200).optional(),
});

adminRoutes.put("/providers/:id", async (req, res, next) => {
  try {
    const body = parseBody(putProviderSchema, req.body);
    const row = await queryOne<{ id: string; provider: string; api_key: string | null }>(
      `SELECT id, provider, api_key FROM provider_configs WHERE id = $1`,
      [req.params.id]
    );
    if (!row) throw notFound("Provedor não encontrado.", "provider_not_found");

    await query(
      `UPDATE provider_configs SET enabled = $2, api_key = COALESCE($3, api_key), updated_at = now(), updated_by = $4
        WHERE id = $1`,
      [req.params.id, body.enabled, body.apiKey ?? null, req.user!.id]
    );
    invalidateProviderCache();
    await audit({
      ...auditCtx(req),
      action: "provider.update",
      entity: "provider_configs",
      entityId: String(req.params.id),
      after: { enabled: body.enabled, apiKeyChanged: Boolean(body.apiKey) },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminRoutes.post("/providers/:id/test", async (req, res, next) => {
  try {
    const row = await queryOne<{ id: string; provider: string; enabled: boolean; api_key: string | null }>(
      `SELECT id, provider, enabled, api_key FROM provider_configs WHERE id = $1`,
      [req.params.id]
    );
    if (!row) throw notFound("Provedor não encontrado.", "provider_not_found");

    invalidateProviderCache();
    const provider = await resolveProvider();
    if (!provider) {
      await query(
        `UPDATE provider_configs SET last_test_at = now(), last_test_ok = FALSE, last_test_message = $2 WHERE id = $1`,
        [req.params.id, "Provedor inativo ou sem chave configurada."]
      );
      return res.json({ ok: false, message: "Provedor inativo ou sem chave configurada." });
    }
    const result = await provider.testConnection();
    await query(
      `UPDATE provider_configs SET last_test_at = now(), last_test_ok = $2, last_test_message = $3 WHERE id = $1`,
      [req.params.id, result.ok, result.message]
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

adminRoutes.get("/payments", async (_req, res, next) => {
  try {
    const row = await queryOne<{ enabled: boolean }>(`SELECT enabled FROM payment_integrations WHERE provider = 'generic'`);
    res.json({
      available: Boolean(row?.enabled),
      reason: row?.enabled
        ? null
        : "Integração financeira (Pix/checkout) não configurada. Nenhum depósito, saque ou saldo é movimentado por esta plataforma até que um provedor autorizado seja habilitado e a operação esteja legalmente autorizada.",
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Auditoria e eventos de risco (visão consolidada, com filtro por bet)
// ---------------------------------------------------------------------------
adminRoutes.get("/audit", async (req, res, next) => {
  try {
    const page = intParam(req.query.page, 1, 1, 100000);
    const pageSize = intParam(req.query.pageSize, 30, 1, 100);
    const ownerId = intParam(req.query.ownerId, 0, 0, 10_000_000) || null;
    const action = typeof req.query.action === "string" ? req.query.action.trim() : "";

    const conds: string[] = ["1=1"];
    const params: unknown[] = [];
    if (ownerId) {
      params.push(ownerId);
      conds.push(`owner_id = $${params.length}`);
    }
    if (action) {
      params.push(`%${action}%`);
      conds.push(`action LIKE $${params.length}`);
    }
    const where = conds.join(" AND ");

    const rows = await query<{
      id: string;
      action: string;
      entity: string | null;
      entity_id: string | null;
      actor_label: string | null;
      actor_role: string | null;
      owner_id: string | null;
      owner_slug: string | null;
      created_at: Date;
      after: unknown;
      ip: string | null;
    }>(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.actor_label, a.actor_role, a.owner_id, a.created_at, a.after, a.ip,
              o.slug AS owner_slug
         FROM audit_logs a
         LEFT JOIN owners o ON o.id = a.owner_id
        WHERE ${where}
        ORDER BY a.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const total = await queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM audit_logs WHERE ${where}`, params);

    res.json({
      items: rows.map((r) => ({
        id: Number(r.id),
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        actor: r.actor_label,
        actorRole: r.actor_role,
        ownerId: r.owner_id ? Number(r.owner_id) : null,
        ownerSlug: r.owner_slug,
        ip: r.ip,
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

adminRoutes.get("/risk-events", async (req, res, next) => {
  try {
    const page = intParam(req.query.page, 1, 1, 100000);
    const pageSize = intParam(req.query.pageSize, 30, 1, 100);
    const rows = await query<{
      id: string;
      attempt_type: string;
      coupon_code: string | null;
      ip: string | null;
      details: unknown;
      created_at: Date;
      owner_slug: string | null;
    }>(
      `SELECT r.id, r.attempt_type, r.coupon_code, r.ip, r.details, r.created_at, o.slug AS owner_slug
         FROM risk_events r
         LEFT JOIN owners o ON o.id = r.owner_id
        ORDER BY r.created_at DESC
        LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize]
    );
    const total = await queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM risk_events`);
    res.json({
      items: rows.map((r) => ({
        id: Number(r.id),
        type: r.attempt_type,
        couponCode: r.coupon_code,
        ownerSlug: r.owner_slug,
        ip: r.ip,
        details: r.details,
        at: new Date(r.created_at).toISOString(),
      })),
      page,
      pageSize,
      total: Number(total?.count ?? 0),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Relatório consolidado (agregado por bet — sem misturar registros)
// ---------------------------------------------------------------------------
adminRoutes.get("/reports/consolidated", async (req, res, next) => {
  try {
    const from = dateParam(req.query.from) ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = dateParam(req.query.to) ?? new Date();
    const rows = await query<{
      id: string;
      slug: string;
      name: string;
      status: string;
      coupons: number;
      pending: number;
      accepted: number;
      won: number;
      lost: number;
      stake: string;
      potential: string;
      due: string;
      paid: string;
      clients: number;
      last_coupon_at: Date | null;
    }>(
      `SELECT o.id, o.slug, o.name, o.status,
              COUNT(c.id)::int AS coupons,
              COUNT(c.id) FILTER (WHERE c.status='pending')::int AS pending,
              COUNT(c.id) FILTER (WHERE c.status='accepted')::int AS accepted,
              COUNT(c.id) FILTER (WHERE c.status='won')::int AS won,
              COUNT(c.id) FILTER (WHERE c.status='lost')::int AS lost,
              COALESCE(SUM(c.stake_cents) FILTER (WHERE c.status IN ('accepted','won','lost')),0)::bigint AS stake,
              COALESCE(SUM(c.potential_payout_cents) FILTER (WHERE c.status IN ('pending','accepted')),0)::bigint AS potential,
              COALESCE(SUM(c.due_payout_cents),0)::bigint AS due,
              COALESCE(SUM(c.paid_payout_cents),0)::bigint AS paid,
              (SELECT COUNT(*) FROM clients cl WHERE cl.owner_id = o.id)::int AS clients,
              MAX(c.created_at) AS last_coupon_at
         FROM owners o
         LEFT JOIN coupons c ON c.owner_id = o.id AND c.created_at BETWEEN $1 AND $2
        GROUP BY o.id, o.slug, o.name, o.status
        ORDER BY SUM(c.stake_cents) DESC NULLS LAST`,
      [from, to]
    );
    res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      rows: rows.map((r) => ({
        ownerId: Number(r.id),
        slug: r.slug,
        name: r.name,
        status: r.status,
        couponsTotal: r.coupons,
        pending: r.pending,
        accepted: r.accepted,
        won: r.won,
        lost: r.lost,
        stakeTotalCents: Number(r.stake),
        potentialTotalCents: Number(r.potential),
        dueTotalCents: Number(r.due),
        paidTotalCents: Number(r.paid),
        clientsTotal: r.clients,
        lastCouponAt: r.last_coupon_at ? new Date(r.last_coupon_at).toISOString() : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});
