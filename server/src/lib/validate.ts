import { ZodError, ZodSchema } from "zod";
import { Request } from "express";
import { badRequest } from "./errors";

/** Valida o corpo da requisição com um schema Zod; erro 400 padronizado. */
export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      throw badRequest("invalid_input", "Dados inválidos.", zodDetails(err));
    }
    throw err;
  }
}

export function zodDetails(err: ZodError): Array<{ field: string; message: string }> {
  return err.issues.map((i) => ({
    field: i.path.join(".") || "(corpo)",
    message: i.message,
  }));
}

/** IP real considerando proxy reverso configurado (express 'trust proxy' em produção). */
export function clientIp(req: Request): string {
  return (req.ip || req.socket?.remoteAddress || "").replace("::ffff:", "");
}

export function userAgent(req: Request): string {
  return (req.headers["user-agent"] || "").slice(0, 500);
}

/** Parse seguro de query params comuns. */
export function intParam(v: unknown, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof v === "string" ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

export function dateParam(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}
