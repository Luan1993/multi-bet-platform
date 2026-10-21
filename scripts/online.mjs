/**
 * Sobe a plataforma em produção (build único) + túnel público temporário.
 *
 * Uso:  online.cmd
 *
 * Requisitos: dependências instaladas (npm install) e PostgreSQL local ativo.
 * O endereço público muda a cada execução (túnel gratuito do Cloudflare).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 4000);
const isWin = process.platform === "win32";
const NODE = process.execPath;
const CLOUDFLARED =
  process.env.CLOUDFLARED || path.join(ROOT, ".runtime", isWin ? "cloudflared.exe" : "cloudflared");
const LOG_DIR = path.join(ROOT, ".runtime");
const TUNNEL_LOG = path.join(LOG_DIR, "cloudflared.log");
const URL_FILE = path.join(LOG_DIR, "public-url.txt");

function log(msg) {
  console.log(`[online] ${msg}`);
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} saiu com código ${code}`))));
    p.on("error", reject);
  });
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1200);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

function stop(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (isWin) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  if (!fs.existsSync(CLOUDFLARED)) {
    throw new Error(
      `cloudflared não encontrado em ${CLOUDFLARED}. Baixe em https://github.com/cloudflare/cloudflared/releases e salve como .runtime/cloudflared.exe`
    );
  }

  if (await portInUse(PORT)) {
    throw new Error(
      `A porta ${PORT} já está em uso. Encerre a instância atual antes de executar novamente (ou use PORT=4001).`
    );
  }

  log("gerando build de produção...");
  await run(NODE, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], path.join(ROOT, "server"));
  await run(NODE, ["scripts/copy-assets.cjs"], path.join(ROOT, "server"));
  await run(NODE, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build"], path.join(ROOT, "web"));

  // Garante o PostgreSQL local quando o .env aponta para ele (idempotente).
  const envFile = path.join(ROOT, ".env");
  const envText = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const dbUrl = (envText.match(/^DATABASE_URL=(.*)$/m) || [])[1]?.trim() ?? "";
  if (!dbUrl || dbUrl.includes("127.0.0.1:55432")) {
    log("verificando PostgreSQL local...");
    await run(NODE, ["dist/db/local.js"], path.join(ROOT, "server"));
  } else {
    log("usando DATABASE_URL externa; PostgreSQL local não será iniciado.");
  }

  fs.writeFileSync(TUNNEL_LOG, "");
  log("abrindo túnel público do Cloudflare...");
  const tunnel = spawn(
    CLOUDFLARED,
    ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate", "--logfile", TUNNEL_LOG, "--loglevel", "info"],
    { cwd: ROOT, stdio: "ignore" }
  );

  let publicUrl = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (tunnel.exitCode !== null) throw new Error("O cloudflared encerrou antes de fornecer a URL pública.");
    const text = fs.existsSync(TUNNEL_LOG) ? fs.readFileSync(TUNNEL_LOG, "utf8") : "";
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      publicUrl = match[0];
      break;
    }
    await sleep(500);
  }
  if (!publicUrl) {
    stop(tunnel);
    throw new Error("Não foi possível obter a URL pública do túnel em 60s.");
  }

  log(`URL pública: ${publicUrl}`);
  fs.writeFileSync(URL_FILE, publicUrl + "\n");

  log("iniciando servidor de produção...");
  const server = spawn(NODE, ["dist/index.js"], {
    cwd: path.join(ROOT, "server"),
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production", PUBLIC_BASE_URL: publicUrl, PORT: String(PORT) },
  });

  const ok = await (async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        if (res.ok) return true;
      } catch {
        /* subindo */
      }
      await sleep(500);
    }
    return false;
  })();

  if (!ok) {
    stop(server);
    stop(tunnel);
    throw new Error("A API não respondeu em 20s. Verifique o PostgreSQL e os logs.");
  }

  console.log("");
  console.log("==============================================================");
  console.log("  PLATAFORMA ONLINE");
  console.log("  Página pública : " + publicUrl + "/bet/vendedor01");
  console.log("  Admin          : " + publicUrl + "/admin");
  console.log("  Painel do dono : " + publicUrl + "/owner");
  console.log("  Credenciais    : .pgdata/credentials.txt");
  console.log("  Encerrar       : Ctrl+C nesta janela");
  console.log("==============================================================");
  console.log("");

  const shutdown = () => {
    log("encerrando...");
    stop(server);
    stop(tunnel);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.on("exit", (code) => {
    log(`servidor encerrou (código ${code}).`);
    stop(tunnel);
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(`[online] ERRO: ${err.message}`);
  process.exit(1);
});
