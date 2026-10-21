import crypto from "crypto";
import { query, queryOne } from "../db/pool";
import { config } from "../config";

/**
 * Sessões por token opaco: o token é enviado no cookie httpOnly,
 * mas somente o SHA-256 é persistido — se o banco vazar, os tokens
 * continuam inúteis.
 */
export interface SessionUser {
  id: number;
  email: string;
  displayName: string;
  role: "admin" | "owner";
  ownerId: number | null;
  status: string;
  mustChangePassword: boolean;
}

export const SESSION_COOKIE = "bet_session";

export async function createSession(
  userId: number,
  ip?: string,
  userAgent?: string
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + config.session.ttlHours * 3600 * 1000);
  await query(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, tokenHash, ip ?? null, userAgent ?? null, expiresAt]
  );
  return { token, expiresAt };
}

export async function revokeSession(token: string): Promise<void> {
  await query(
    `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256(token)]
  );
}

export async function revokeAllUserSessions(userId: number): Promise<void> {
  await query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

/** Valida o token e devolve o usuário da sessão (ou null). */
export async function resolveSession(token: string): Promise<SessionUser | null> {
  const row = await queryOne<{
    id: string;
    email: string;
    display_name: string;
    role: "admin" | "owner";
    owner_id: string | null;
    status: string;
    must_change_password: boolean;
  }>(
    `SELECT u.id, u.email, u.display_name, u.role, u.owner_id, u.status, u.must_change_password
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [sha256(token)]
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    ownerId: row.owner_id ? Number(row.owner_id) : null,
    status: row.status,
    mustChangePassword: row.must_change_password,
  };
}

function sha256(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}
