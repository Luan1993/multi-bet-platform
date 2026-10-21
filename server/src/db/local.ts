/**
 * PostgreSQL local portátil (desenvolvimento/testes).
 *
 * Inicializa e gerencia um servidor PostgreSQL real usando os binários do
 * pacote @embedded-postgres — sem precisar de instalação nem privilégios de
 * administrador. Em produção, basta configurar DATABASE_URL apontando para um
 * servidor PostgreSQL gerenciado (Neon, Supabase, Railway, etc.).
 *
 * Uso:
 *   npm run db:local -w server            inicia (idempotente) e cria os databases
 *   npm run db:local -w server -- --stop  para o servidor
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { config } from "../config";

const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";

function binDir(): string {
  // Procura o pacote de binários instalado (@embedded-postgres/<plataforma>)
  let dir = __dirname;
  for (;;) {
    const nm = path.join(dir, "node_modules", "@embedded-postgres");
    if (fs.existsSync(nm)) {
      for (const pkg of fs.readdirSync(nm)) {
        const b = path.join(nm, pkg, "native", "bin");
        if (fs.existsSync(path.join(b, `postgres${EXE_SUFFIX}`))) return b;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Binários do PostgreSQL local não encontrados. Rode `npm install` na raiz do projeto."
  );
}

function exe(name: string): string {
  const p = path.join(binDir(), `${name}${EXE_SUFFIX}`);
  if (!fs.existsSync(p)) throw new Error(`Binário não encontrado: ${p}`);
  return p;
}

// O cluster vive em uma subpasta própria (o .pgdata também guarda o segredo de sessão)
const dataDir = path.resolve(config.repoRoot, config.db.localDir, "cluster");
const port = config.db.localPort;
const logFile = path.join(dataDir, "pg.log");
const user = "postgres";
const adminUrl = `postgresql://${user}@127.0.0.1:${port}/postgres`;

function run(cmd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
  if (r.error) throw new Error(`Falha ao executar ${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(
      `Comando falhou (${cmd} ${args.join(" ")}):\n${r.stderr || r.stdout || ""}`
    );
  }
  return (r.stdout || "") + (r.stderr || "");
}

function serverRunning(): boolean {
  const r = spawnSync(exe("pg_ctl"), ["-D", dataDir, "status"], { windowsHide: true });
  return r.status === 0;
}

async function adminQuery(sql: string): Promise<string> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    const res = await pool.query(sql);
    return (res.rows as Array<Record<string, unknown>>)
      .map((r) => Object.values(r).join("|"))
      .join("\n");
  } finally {
    await pool.end();
  }
}

async function ensureDatabase(name: string): Promise<void> {
  const res = await adminQuery(`SELECT 1 FROM pg_database WHERE datname = '${name}'`);
  if (!res.includes("1")) {
    await adminQuery(`CREATE DATABASE "${name}"`);
    console.log(`[pg] database criado: ${name}`);
  }
}

function updateEnvDatabaseUrl(): void {
  const envPath = path.join(config.repoRoot, ".env");
  const url = `postgresql://${user}@127.0.0.1:${port}/bet`;
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    if (/^DATABASE_URL=.*$/m.test(content)) {
      fs.writeFileSync(envPath, content.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${url}`));
    } else {
      fs.appendFileSync(envPath, `\nDATABASE_URL=${url}\n`);
    }
    console.log(`[pg] .env atualizado: DATABASE_URL=${url}`);
  } else {
    console.log(`[pg] Configure no seu .env: DATABASE_URL=${url}`);
  }
}

async function main(): Promise<void> {
  const stop = process.argv.includes("--stop");

  if (stop) {
    if (!fs.existsSync(dataDir)) {
      console.log("[pg] nada a parar (sem diretório de dados).");
      return;
    }
    run(exe("pg_ctl"), ["-D", dataDir, "stop", "-m", "fast", "-w"], { allowFail: true });
    console.log("[pg] servidor parado.");
    return;
  }

  fs.mkdirSync(dataDir, { recursive: true });

  const initialized = fs.existsSync(path.join(dataDir, "PG_VERSION"));
  if (!initialized) {
    console.log(`[pg] inicializando cluster em ${dataDir} ...`);
    run(exe("initdb"), ["-D", dataDir, "-U", user, "-E", "UTF8", "-A", "trust"]);
    console.log("[pg] cluster inicializado.");
  }

  if (!serverRunning()) {
    console.log(`[pg] iniciando servidor na porta ${port} ...`);
    run(exe("pg_ctl"), [
      "-D", dataDir,
      "-o", `-p ${port} -h 127.0.0.1 -k "${dataDir}"`,
      "-l", logFile,
      "start", "-w",
    ]);
    console.log("[pg] servidor iniciado.");
  } else {
    console.log("[pg] servidor já em execução.");
  }

  await ensureDatabase("bet");
  await ensureDatabase("bet_test");
  updateEnvDatabaseUrl();
  console.log("[pg] pronto. Rode `npm run db:migrate -w server` para aplicar as migrações.");
}

main().catch((err) => {
  console.error(`[pg] ERRO: ${err.message}`);
  process.exit(1);
});
