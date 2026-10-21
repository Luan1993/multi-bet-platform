import "dotenv/config";
import path from "path";
import fs from "fs";
import crypto from "crypto";

// Raiz do repositório (funciona tanto em src/ quanto em dist/)
const repoRoot = path.resolve(__dirname, "..", "..");

// Carrega o .env da raiz se ainda não carregado (dotenv ignora vars já definidas)
const envFile = path.join(repoRoot, ".env");
if (fs.existsSync(envFile)) {
  require("dotenv").config({ path: envFile });
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return v === "true" || v === "1" || v === "yes";
}

function int(v: string | undefined, def: number): number {
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const isTest = process.env.NODE_ENV === "test";

// URL pública: prioriza PUBLIC_BASE_URL; em Render, usa RENDER_EXTERNAL_URL.
// Remove barras finais para não gerar links com "//".
const publicBaseUrl = (
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "http://localhost:5173"
).replace(/\/+$/, "");

export const config = {
  repoRoot,
  nodeEnv: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  isTest,
  port: int(process.env.PORT, 4000),

  db: {
    // Em testes usa-se um banco dedicado, apontado por TEST_DATABASE_URL.
    url: isTest
      ? process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ""
      : process.env.DATABASE_URL || "",
    localDir: process.env.PG_LOCAL_DIR || ".pgdata",
    localPort: int(process.env.PG_LOCAL_PORT, 55432),
  },

  odds: {
    provider: (process.env.ODDS_PROVIDER || "api-football") as "api-football" | "demo" | "none",
    apiKey: process.env.API_FOOTBALL_KEY || "",
    refreshMs: int(process.env.ODDS_REFRESH_MS, 10 * 60 * 1000),
    syncMaxFixtures: int(process.env.ODDS_SYNC_MAX_FIXTURES, 15),
    staleMinutes: int(process.env.ODDS_STALE_MINUTES, 30),
  },

  demoMode: bool(process.env.DEMO_MODE, true),

  session: {
    secret: process.env.SESSION_SECRET || "",
    ttlHours: int(process.env.SESSION_TTL_HOURS, 12),
  },

  publicBaseUrl,

  limits: {
    globalMaxPayoutCents: int(process.env.GLOBAL_MAX_PAYOUT_CENTS, 500_000),
    globalMinStakeCents: int(process.env.GLOBAL_MIN_STAKE_CENTS, 100),
    globalMaxStakeCents: int(process.env.GLOBAL_MAX_STAKE_CENTS, 100_000),
    pendingCouponExpiryHours: int(process.env.PENDING_COUPON_EXPIRY_HOURS, 24),
  },
};

// Segredo de sessão: em produção é obrigatório configurar SESSION_SECRET.
if (!config.session.secret) {
  if (config.isProd) {
    throw new Error("SESSION_SECRET é obrigatório em produção. Gere um com: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"");
  }
  // Em desenvolvimento, deriva um segredo persistente na pasta .pgdata (ou temp)
  const dir = path.join(config.repoRoot, ".pgdata");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, ".session-secret");
    if (fs.existsSync(f)) {
      config.session.secret = fs.readFileSync(f, "utf8").trim();
    } else {
      config.session.secret = crypto.randomBytes(48).toString("hex");
      fs.writeFileSync(f, config.session.secret);
    }
  } catch {
    config.session.secret = crypto.randomBytes(48).toString("hex");
  }
}
