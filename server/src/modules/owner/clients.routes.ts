import { Router, Request } from "express";
import { z } from "zod";
import crypto from "crypto";
import { query, queryOne, withTransaction } from "../../db/pool";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { parseBody, intParam } from "../../lib/validate";
import { audit } from "../../lib/audit";
import { ageFromDate } from "../public/public.routes";

export const clientsRoutes = Router();

function auditCtx(req: Request) {
  return {
    actorUserId: req.user!.id,
    actorRole: req.user!.role,
    actorLabel: req.user!.email,
    ownerId: req.user!.ownerId,
    ip: req.ip,
    userAgent: (req.headers["user-agent"] || "").slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// Lista com busca (somente clientes do próprio tenant)
// ---------------------------------------------------------------------------
clientsRoutes.get("/", async (req, res, next) => {
  try {
    const ownerId = req.user!.ownerId!;
    const page = intParam(req.query.page, 1, 1, 100000);
    const pageSize = intParam(req.query.pageSize, 20, 1, 100);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;

    const conds = ["owner_id = $1"];
    const params: unknown[] = [ownerId];
    if (q) {
      params.push(`%${q.toUpperCase()}%`);
      conds.push(
        `(UPPER(code) LIKE $${params.length} OR UPPER(name) LIKE $${params.length} OR UPPER(COALESCE(document,'')) LIKE $${params.length} OR UPPER(COALESCE(email,'')) LIKE $${params.length})`
      );
    }
    if (status) {
      params.push(status);
      conds.push(`status = $${params.length}`);
    }
    const where = conds.join(" AND ");

    const rows = await query<{
      id: string;
      code: string;
      name: string;
      document: string | null;
      email: string | null;
      phone: string | null;
      status: string;
      age_verified: boolean;
      created_at: Date;
      coupons: string;
    }>(
      `SELECT c.id, c.code, c.name, c.document, c.email, c.phone, c.status, c.age_verified, c.created_at,
              (SELECT COUNT(*) FROM coupons co WHERE co.client_id = c.id)::text AS coupons
         FROM clients c
        WHERE ${where}
        ORDER BY c.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const total = await queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM clients WHERE ${where}`, params);

    res.json({
      items: rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        document: r.document,
        email: r.email,
        phone: r.phone,
        status: r.status,
        ageVerified: r.age_verified,
        createdAt: new Date(r.created_at).toISOString(),
        couponsCount: Number(r.coupons),
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
// Cadastro (com consentimentos e verificação de idade — item 10)
// ---------------------------------------------------------------------------
const consentsSchema = z.object({
  terms: z.literal(true, { errorMap: () => ({ message: "É necessário aceitar os termos de uso." }) }),
  privacy: z.literal(true, { errorMap: () => ({ message: "É necessário aceitar a política de privacidade." }) }),
  marketingEmail: z.boolean().optional(),
  marketingSms: z.boolean().optional(),
  marketingWhatsapp: z.boolean().optional(),
  responsibleGaming: z.boolean().optional(),
});

const createClientSchema = z.object({
  name: z.string().trim().min(2, "Informe o nome completo.").max(120),
  document: z.string().trim().max(30).optional().nullable(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data de nascimento inválida (AAAA-MM-DD)."),
  email: z.string().trim().email("E-mail inválido.").max(200).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  consents: consentsSchema,
});

clientsRoutes.post("/", async (req, res, next) => {
  try {
    const ownerId = req.user!.ownerId!;
    const body = parseBody(createClientSchema, req.body);

    const age = ageFromDate(body.birthDate);
    if (age < 18) {
      throw badRequest("client_ineligible", "Cadastro bloqueado: clientes devem ter 18 anos ou mais.");
    }
    if (age > 120) {
      throw badRequest("invalid_birthdate", "Data de nascimento inválida.");
    }

    if (body.document) {
      const dup = await queryOne(`SELECT id FROM clients WHERE owner_id = $1 AND document = $2`, [ownerId, body.document]);
      if (dup) throw conflict("duplicate_document", "Já existe um cliente com este documento nesta bet.");
    }

    let created: { id: string; code: string } | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const code = `CL-${crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 7)}`;
      try {
        created = await withTransaction(async (client) => {
          const row = await client.query<{ id: string; code: string }>(
            `INSERT INTO clients (owner_id, code, name, document, birth_date, email, phone, age_verified, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7, TRUE, $8, $9)
             RETURNING id, code`,
            [
              ownerId,
              code,
              body.name,
              body.document ?? null,
              body.birthDate,
              body.email ?? null,
              body.phone ?? null,
              body.notes ?? null,
              req.user!.id,
            ]
          );
          const clientId = row.rows[0].id;
          const consents: Array<[string, boolean]> = [
            ["terms", true],
            ["privacy", true],
            ["marketing_email", body.consents.marketingEmail ?? false],
            ["marketing_sms", body.consents.marketingSms ?? false],
            ["marketing_whatsapp", body.consents.marketingWhatsapp ?? false],
            ["responsible_gaming", body.consents.responsibleGaming ?? false],
          ];
          for (const [type, granted] of consents) {
            await client.query(
              `INSERT INTO consents (client_id, consent_type, granted, ip) VALUES ($1,$2,$3,$4)`,
              [clientId, type, granted, req.ip]
            );
          }
          await audit(
            {
              ...auditCtx(req),
              action: "client.create",
              entity: "client",
              entityId: clientId,
              after: { code, name: body.name, ageVerified: true },
            },
            client
          );
          return row.rows[0];
        });
      } catch (err) {
        if ((err as { code?: string }).code !== "23505") throw err;
      }
    }
    if (!created) throw conflict("client_code_conflict", "Não foi possível gerar o código do cliente.");

    res.status(201).json({ id: Number(created.id), code: created.code });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Detalhe + histórico
// ---------------------------------------------------------------------------
clientsRoutes.get("/:id", async (req, res, next) => {
  try {
    const ownerId = req.user!.ownerId!;
    const client = await queryOne<{
      id: string;
      code: string;
      name: string;
      document: string | null;
      birth_date: Date | null;
      email: string | null;
      phone: string | null;
      status: string;
      age_verified: boolean;
      notes: string | null;
      created_at: Date;
    }>(
      `SELECT id, code, name, document, birth_date, email, phone, status, age_verified, notes, created_at
         FROM clients WHERE id = $1 AND owner_id = $2`,
      [req.params.id, ownerId]
    );
    if (!client) throw notFound("Cliente não encontrado.", "client_not_found");

    const consents = await query<{ consent_type: string; granted: boolean; created_at: Date }>(
      `SELECT DISTINCT ON (consent_type) consent_type, granted, created_at
         FROM consents WHERE client_id = $1 ORDER BY consent_type, created_at DESC`,
      [client.id]
    );
    const limits = await query<{ id: string; limit_type: string; value_cents: string | null; expires_at: Date | null; created_at: Date }>(
      `SELECT id, limit_type, value_cents, expires_at, created_at FROM client_limits
        WHERE client_id = $1 ORDER BY created_at DESC`,
      [client.id]
    );
    const coupons = await query<{
      code: string;
      status: string;
      stake_cents: string;
      potential_payout_cents: string;
      created_at: Date;
    }>(
      `SELECT code, status, stake_cents, potential_payout_cents, created_at
         FROM coupons WHERE client_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [client.id]
    );

    res.json({
      client: {
        id: Number(client.id),
        code: client.code,
        name: client.name,
        document: client.document,
        birthDate: client.birth_date ? new Date(client.birth_date).toISOString().slice(0, 10) : null,
        age: client.birth_date ? ageFromDate(client.birth_date) : null,
        email: client.email,
        phone: client.phone,
        status: client.status,
        ageVerified: client.age_verified,
        notes: client.notes,
        createdAt: new Date(client.created_at).toISOString(),
      },
      consents: consents.map((c) => ({ type: c.consent_type, granted: c.granted, at: new Date(c.created_at).toISOString() })),
      limits: limits.map((l) => ({
        id: Number(l.id),
        type: l.limit_type,
        valueCents: l.value_cents ? Number(l.value_cents) : null,
        expiresAt: l.expires_at ? new Date(l.expires_at).toISOString() : null,
        createdAt: new Date(l.created_at).toISOString(),
      })),
      coupons: coupons.map((c) => ({
        code: c.code,
        status: c.status,
        stakeCents: Number(c.stake_cents),
        potentialPayoutCents: Number(c.potential_payout_cents),
        createdAt: new Date(c.created_at).toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Atualização (inclui bloqueio / autoexclusão)
// ---------------------------------------------------------------------------
const updateClientSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(["active", "blocked", "self_excluded"]).optional(),
  consents: z
    .object({
      marketingEmail: z.boolean().optional(),
      marketingSms: z.boolean().optional(),
      marketingWhatsapp: z.boolean().optional(),
    })
    .optional(),
});

clientsRoutes.put("/:id", async (req, res, next) => {
  try {
    const ownerId = req.user!.ownerId!;
    const body = parseBody(updateClientSchema, req.body);

    const before = await queryOne(`SELECT * FROM clients WHERE id = $1 AND owner_id = $2`, [req.params.id, ownerId]);
    if (!before) throw notFound("Cliente não encontrado.", "client_not_found");

    await query(
      `UPDATE clients
          SET name = COALESCE($3, name),
              email = CASE WHEN $4 THEN $5 ELSE email END,
              phone = CASE WHEN $6 THEN $7 ELSE phone END,
              notes = CASE WHEN $8 THEN $9 ELSE notes END,
              status = COALESCE($10, status),
              updated_at = now()
        WHERE id = $1 AND owner_id = $2`,
      [
        req.params.id,
        ownerId,
        body.name ?? null,
        body.email !== undefined,
        body.email ?? null,
        body.phone !== undefined,
        body.phone ?? null,
        body.notes !== undefined,
        body.notes ?? null,
        body.status ?? null,
      ]
    );

    if (body.consents) {
      const map: Array<[string, boolean | undefined]> = [
        ["marketing_email", body.consents.marketingEmail],
        ["marketing_sms", body.consents.marketingSms],
        ["marketing_whatsapp", body.consents.marketingWhatsapp],
      ];
      for (const [type, granted] of map) {
        if (granted === undefined) continue;
        await query(
          `INSERT INTO consents (client_id, consent_type, granted, ip) VALUES ($1,$2,$3,$4)`,
          [req.params.id, type, granted, req.ip]
        );
      }
    }

    await audit({
      ...auditCtx(req),
      action: body.status && body.status !== before.status ? `client.${body.status}` : "client.update",
      entity: "client",
      entityId: String(req.params.id),
      before,
      after: body,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Limites de jogo responsável
// ---------------------------------------------------------------------------
const limitSchema = z.object({
  limitType: z.enum(["daily_stake", "weekly_stake", "monthly_stake", "self_exclusion"]),
  valueCents: z.number().int().min(0).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

clientsRoutes.post("/:id/limits", async (req, res, next) => {
  try {
    const ownerId = req.user!.ownerId!;
    const body = parseBody(limitSchema, req.body);

    const client = await queryOne(`SELECT id FROM clients WHERE id = $1 AND owner_id = $2`, [req.params.id, ownerId]);
    if (!client) throw notFound("Cliente não encontrado.", "client_not_found");

    if (body.limitType !== "self_exclusion" && (body.valueCents === undefined || body.valueCents === null)) {
      throw badRequest("limit_value_required", "Informe o valor do limite em centavos.");
    }

    await query(
      `INSERT INTO client_limits (client_id, limit_type, value_cents, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, body.limitType, body.valueCents ?? null, body.expiresAt ?? null, req.user!.id]
    );

    if (body.limitType === "self_exclusion") {
      await query(`UPDATE clients SET status = 'self_excluded', updated_at = now() WHERE id = $1`, [req.params.id]);
    }

    await audit({
      ...auditCtx(req),
      action: "client.limit_add",
      entity: "client_limits",
      entityId: String(req.params.id),
      after: body,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
