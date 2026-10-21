import { PoolClient } from "pg";
import { getPool } from "../db/pool";

export interface AuditEntry {
  actorUserId?: number | null;
  actorRole?: string | null;
  actorLabel?: string | null;
  ownerId?: number | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Registro de auditoria de toda ação administrativa ou sensível.
 * Aceita um client de transação para que o log seja atômico com a ação.
 */
export async function audit(entry: AuditEntry, client?: PoolClient): Promise<void> {
  const sql = `
    INSERT INTO audit_logs (actor_user_id, actor_role, actor_label, owner_id, action, entity, entity_id, before, after, ip, user_agent)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
  const params = [
    entry.actorUserId ?? null,
    entry.actorRole ?? null,
    entry.actorLabel ?? null,
    entry.ownerId ?? null,
    entry.action,
    entry.entity ?? null,
    entry.entityId ?? null,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
    entry.ip ?? null,
    entry.userAgent ?? null,
  ];
  if (client) await client.query(sql, params);
  else await getPool().query(sql, params);
}

/** Registra um evento de risco/bloqueio (ex.: tentativa acima do limite). */
export async function riskEvent(
  ownerId: number | null,
  attemptType: string,
  details: Record<string, unknown>,
  opts: { couponCode?: string; ip?: string; client?: PoolClient } = {}
): Promise<void> {
  const sql = `
    INSERT INTO risk_events (owner_id, attempt_type, coupon_code, ip, details)
    VALUES ($1,$2,$3,$4,$5)`;
  const params = [
    ownerId,
    attemptType,
    opts.couponCode ?? null,
    opts.ip ?? null,
    JSON.stringify(details),
  ];
  if (opts.client) await opts.client.query(sql, params);
  else await getPool().query(sql, params);
}
