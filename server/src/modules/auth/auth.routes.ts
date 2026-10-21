import { Router, Response } from "express";
import { z } from "zod";
import { queryOne } from "../../db/pool";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "../../lib/password";
import { createSession, revokeAllUserSessions, revokeSession, SESSION_COOKIE } from "../../lib/session";
import { parseBody, clientIp, userAgent } from "../../lib/validate";
import { badRequest, forbidden, notFound, tooMany, unauthorized } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { requireAuth } from "../../middleware/auth";
import { loginLimiter } from "../../middleware/rateLimit";
import { config } from "../../config";

export const authRoutes = Router();

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: "admin" | "owner";
  owner_id: string | null;
  status: string;
  must_change_password: boolean;
  owner_status: string | null;
  owner_slug: string | null;
  owner_name: string | null;
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("E-mail inválido.").max(200),
  password: z.string().min(1, "Informe a senha.").max(200),
});

function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProd,
    expires: expiresAt,
    path: "/",
  });
}

async function ownerBranding(ownerId: string) {
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
  return b
    ? {
        displayName: b.display_name,
        tagline: b.tagline,
        logoPath: b.logo_path,
        primaryColor: b.primary_color,
        secondaryColor: b.secondary_color,
        accentColor: b.accent_color,
        theme: b.theme,
      }
    : null;
}

authRoutes.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = parseBody(loginSchema, req.body);
    const ip = clientIp(req);

    // Lockout por tentativas repetidas
    const recent = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM login_attempts
        WHERE identifier = $1 AND success = FALSE AND created_at > now() - interval '15 minutes'`,
      [email]
    );
    if (Number(recent?.count ?? 0) >= 5) {
      throw tooMany("Muitas tentativas de login para esta conta. Aguarde 15 minutos.");
    }

    const user = await queryOne<UserRow>(
      `SELECT u.id, u.email, u.password_hash, u.display_name, u.role, u.owner_id, u.status,
              u.must_change_password, o.status AS owner_status, o.slug AS owner_slug, o.name AS owner_name
         FROM users u
         LEFT JOIN owners o ON o.id = u.owner_id
        WHERE lower(u.email) = $1`,
      [email]
    );

    const ok = user ? await verifyPassword(password, user.password_hash) : await dummyCompare(password);
    const attempt = async (success: boolean) => {
      await queryOne(`INSERT INTO login_attempts (identifier, ip, success) VALUES ($1,$2,$3) RETURNING id`, [
        email,
        ip,
        success,
      ]);
    };

    if (!user || !ok) {
      await attempt(false);
      throw unauthorized("E-mail ou senha inválidos.");
    }
    if (user.status !== "active") {
      await attempt(false);
      throw forbidden(
        user.status === "suspended"
          ? "Usuário suspenso. Contate o administrador."
          : "Usuário bloqueado. Contate o administrador.",
        "user_" + user.status
      );
    }
    if (user.role === "owner" && user.owner_status !== "active") {
      await attempt(false);
      throw forbidden(
        user.owner_status === "suspended"
          ? "Operação suspensa pelo administrador da plataforma."
          : "Operação bloqueada pelo administrador da plataforma.",
        "owner_" + user.owner_status
      );
    }

    await attempt(true);
    const { token, expiresAt } = await createSession(Number(user.id), ip, userAgent(req));
    setSessionCookie(res, token, expiresAt);

    await audit({
      actorUserId: Number(user.id),
      actorRole: user.role,
      actorLabel: user.email,
      ownerId: user.owner_id ? Number(user.owner_id) : null,
      action: "auth.login",
      ip,
      userAgent: userAgent(req),
    });

    res.json({
      user: {
        id: Number(user.id),
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        ownerId: user.owner_id ? Number(user.owner_id) : null,
        mustChangePassword: user.must_change_password,
      },
      owner:
        user.role === "owner" && user.owner_id
          ? {
              id: Number(user.owner_id),
              slug: user.owner_slug,
              name: user.owner_name,
              branding: await ownerBranding(user.owner_id),
            }
          : null,
      demoMode: config.demoMode,
    });
  } catch (err) {
    next(err);
  }
});

authRoutes.post("/logout", async (req, res, next) => {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await revokeSession(token);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRoutes.get("/me", requireAuth, async (req, res, next) => {
  try {
    const u = req.user!;
    const owner =
      u.role === "owner" && u.ownerId
        ? {
            id: u.ownerId,
            slug: (
              await queryOne<{ slug: string; name: string; status: string }>(
                `SELECT slug, name, status FROM owners WHERE id = $1`,
                [u.ownerId]
              )
            )?.slug,
            branding: await ownerBranding(String(u.ownerId)),
          }
        : null;
    res.json({
      user: {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        ownerId: u.ownerId,
        mustChangePassword: u.mustChangePassword,
        status: u.status,
      },
      owner,
      demoMode: config.demoMode,
    });
  } catch (err) {
    next(err);
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Informe a senha atual."),
  newPassword: z.string().min(8, "A nova senha deve ter no mínimo 8 caracteres."),
});

authRoutes.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = parseBody(changePasswordSchema, req.body);
    const row = await queryOne<{ id: string; password_hash: string }>(
      `SELECT id, password_hash FROM users WHERE id = $1`,
      [req.user!.id]
    );
    if (!row) throw notFound("Usuário não encontrado.");
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      throw badRequest("wrong_password", "Senha atual incorreta.");
    }
    const policyError = validatePasswordPolicy(newPassword);
    if (policyError) throw badRequest("weak_password", policyError);

    await queryOne(
      `UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = now() WHERE id = $2 RETURNING id`,
      [await hashPassword(newPassword), req.user!.id]
    );
    await revokeAllUserSessions(req.user!.id);
    const { token, expiresAt } = await createSession(req.user!.id, clientIp(req), userAgent(req));
    setSessionCookie(res, token, expiresAt);
    await audit({
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      actorLabel: req.user!.email,
      ownerId: req.user!.ownerId,
      action: "auth.change_password",
      ip: clientIp(req),
      userAgent: userAgent(req),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Compara com hash inexistente para equalizar tempo de resposta. */
async function dummyCompare(password: string): Promise<boolean> {
  const { query } = await import("../../db/pool");
  const row = await queryOne<{ hash: string }>(`SELECT '$2a$12$invalidinvalidinvalidinvalidinvalidinva' AS hash`);
  return verifyPassword(password, row?.hash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinva");
}
