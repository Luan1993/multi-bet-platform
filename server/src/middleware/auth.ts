import { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors";
import { resolveSession, SessionUser } from "../lib/session";
import { SESSION_COOKIE } from "../lib/session";
import { ZodError } from "zod";
import { zodDetails } from "../lib/validate";
import { logger } from "../lib/logger";
import { config } from "../config";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

/**
 * Carrega a sessão (se houver cookie) em toda requisição.
 * A autorização é sempre validada no servidor — nunca apenas no navegador.
 */
export function loadSession(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  resolveSession(token)
    .then((user) => {
      if (user) req.user = user;
      next();
    })
    .catch(next);
}

/** Exige usuário autenticado. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new AppError(401, "unauthorized", "Sessão inválida ou expirada. Faça login."));
  next();
}

/** Exige papel de administrador principal. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new AppError(401, "unauthorized", "Sessão inválida ou expirada."));
  if (req.user.role !== "admin") {
    return next(new AppError(403, "forbidden", "Acesso restrito ao administrador da plataforma."));
  }
  next();
}

/**
 * Exige proprietário de bet ativo.
 * Sessões de proprietários suspensos/bloqueados são recusadas mesmo
 * que ainda existam no banco.
 */
export function requireOwner(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new AppError(401, "unauthorized", "Sessão inválida ou expirada."));
  if (req.user.role !== "owner" || !req.user.ownerId) {
    return next(new AppError(403, "forbidden", "Acesso restrito aos painéis de proprietário."));
  }
  if (req.user.status !== "active") {
    const msg =
      req.user.status === "suspended"
        ? "Operação suspensa. Entre em contato com o administrador da plataforma."
        : "Operação bloqueada. Entre em contato com o administrador da plataforma.";
    return next(new AppError(403, "owner_" + req.user.status, msg));
  }
  next();
}

/**
 * Proteção CSRF (complementar ao sameSite=lax do cookie):
 * requisições que alteram dados com sessão de cookie precisam vir do mesmo host.
 */
export function originCheck(req: Request, _res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return next();
  if (!req.cookies?.[SESSION_COOKIE]) return next(); // sem cookie, sem risco de CSRF
  const origin = req.headers.origin;
  if (!origin) return next(); // requisições programáticas sem Origin (mesmo host via fetch/curl)
  try {
    const originHost = new URL(origin).host;
    const reqHost = (req.headers.host || "").replace("::ffff:", "");
    if (originHost === reqHost) return next();
    // Dev: aceita qualquer porta do dev server do Vite (localhost/127.0.0.1)
    if (!config.isProd && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHost)) return next();
  } catch {
    /* origem inválida */
  }
  next(new AppError(403, "invalid_origin", "Origem da requisição não autorizada."));
}

/** Handler central de erros: respostas consistentes + log sem vazamento interno. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res
      .status(400)
      .json({ error: { code: "invalid_input", message: "Dados inválidos.", details: zodDetails(err) } });
    return;
  }
  logger.error("unhandled_error", {
    msg: (err as Error)?.message,
    stack: (err as Error)?.stack,
    path: req.path,
    method: req.method,
  });
  res.status(500).json({
    error: { code: "internal_error", message: "Erro interno do servidor. Tente novamente." },
  });
}

/** 404 para rotas de API inexistentes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: `Rota não encontrada: ${req.method} ${req.path}` } });
}
