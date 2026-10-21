import rateLimit from "express-rate-limit";

const message = (mins: number) =>
  `Muitas tentativas. Aguarde ${mins} minuto(s) e tente novamente.`;

/** Limite global da API. */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: message(15) } },
});

/** Login: brute-force protection por IP. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Muitas tentativas de login. Aguarde 15 minutos." } },
});

/** Consulta pública de cupom por código (anti-enumeração). */
export const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Muitas consultas de código. Aguarde alguns minutos." } },
});

/** Criação de pré-cupons pela página pública. */
export const couponCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Muitas tentativas de criação de cupom. Aguarde alguns minutos." } },
});
