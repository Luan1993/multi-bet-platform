/**
 * Inicialização de produção (Render/Docker/VPS).
 *
 * 1. Aguarda o PostgreSQL aceitar conexões (cold start de bancos gerenciados).
 * 2. Aplica migrações e o seed idempotente (cria admin/bets na primeira vez).
 * 3. Sobe a API Express, que também serve o frontend compilado.
 *
 * Uso: node scripts/deploy-start.cjs
 */
const path = require("path");
const { spawnSync } = require("child_process");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "..");
// Neon: conexão direta para o bootstrap/migrações; a API usa DATABASE_URL
// (pooled) depois que o schema está pronto.
const DB_URL = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDatabase() {
  if (!DB_URL) {
    throw new Error("DATABASE_URL_UNPOOLED ou DATABASE_URL não configurada.");
  }

  const deadline = Date.now() + 90_000;
  let lastError;

  while (Date.now() < deadline) {
    const client = new Client({
      connectionString: DB_URL,
      connectionTimeoutMillis: 10_000,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      console.log("[deploy] PostgreSQL pronto.");
      return;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => {});
      console.log(`[deploy] aguardando PostgreSQL... (${err.message})`);
      await sleep(2_000);
    }
  }

  throw lastError || new Error("Tempo esgotado aguardando o PostgreSQL.");
}

async function main() {
  await waitForDatabase();

  console.log("[deploy] aplicando migrações e seed...");
  const seed = spawnSync(
    process.execPath,
    [path.join(ROOT, "server", "dist", "db", "seed.js")],
    { cwd: ROOT, env: process.env, stdio: "inherit" }
  );
  if (seed.error) throw seed.error;
  if (seed.status !== 0) {
    throw new Error(`Seed/migração falhou (código ${seed.status}).`);
  }

  console.log("[deploy] iniciando a API...");
  require(path.join(ROOT, "server", "dist", "index.js"));
}

main().catch((err) => {
  console.error(`[deploy] ERRO: ${err.message}`);
  process.exit(1);
});
