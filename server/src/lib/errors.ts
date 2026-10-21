/**
 * Erros de aplicação com código HTTP e código de erro estável
 * (usado pelo frontend para exibir mensagens claras em pt-BR).
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (message = "Não autenticado.") =>
  new AppError(401, "unauthorized", message);

export const forbidden = (message = "Acesso negado.", code = "forbidden") =>
  new AppError(403, code, message);

export const notFound = (message = "Recurso não encontrado.", code = "not_found") =>
  new AppError(404, code, message);

export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

export const tooMany = (message = "Muitas tentativas. Aguarde alguns minutos.") =>
  new AppError(429, "rate_limited", message);

export const serverError = (message = "Erro interno do servidor.") =>
  new AppError(500, "internal_error", message);

/** Erro usado quando o provedor de odds está indisponível — bloqueia apostas (item 5). */
export const providerUnavailable = (message = "Provedor de dados esportivos indisponível no momento. Confirmação de apostas bloqueada até a recuperação.") =>
  new AppError(503, "provider_unavailable", message);
