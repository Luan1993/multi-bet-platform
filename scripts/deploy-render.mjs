/**
 * Deploy automatizado no Render (plano free) + PostgreSQL free do Render.
 *
 * Pré-requisitos:
 *   - .runtime/render.key com um API Key do Render (ou RENDER_API_KEY no ambiente)
 *   - .runtime/git-url.txt com a URL pública do repositório Git (ou REPO_URL)
 *
 * Uso:
 *   node scripts/deploy-render.mjs
 *
 * Opções por ambiente:
 *   SERVICE_NAME=multi-bet
 *   RENDER_REGION=oregon
 *   DATABASE_URL=postgresql://...   (usa banco externo em vez de criar no Render)
 *   RENDER_OWNER_ID=tea-...         (workspace específico)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.render.com/v1";
const SERVICE_NAME = process.env.SERVICE_NAME || "multi-bet";
const REGION = process.env.RENDER_REGION || "oregon";
const REPO_URL =
  process.env.REPO_URL ||
  read(".runtime/git-url.txt") ||
  "https://apartment-static-role-bugs.trycloudflare.com/deploy-repo.git";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function read(relative) {
  try {
    return fs.readFileSync(path.join(ROOT, relative), "utf8").trim();
  } catch {
    return "";
  }
}

function write(relative, content) {
  const file = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function password(prefix) {
  return `${prefix}-${crypto.randomBytes(9).toString("base64url")}!7`;
}

function loadCredentials() {
  const file = ".runtime/render-credentials.json";
  try {
    const parsed = JSON.parse(read(file));
    if (parsed.adminPassword && parsed.sessionSecret) return parsed;
  } catch {
    /* gera novas */
  }
  const credentials = {
    adminEmail: "admin@plataforma.local",
    adminPassword: password("Adm"),
    seller01Email: "vendedor01@demo.local",
    seller01Password: password("Sel"),
    seller02Email: "vendedor02@demo.local",
    seller02Password: password("Sel"),
    sessionSecret: crypto.randomBytes(48).toString("hex"),
  };
  write(file, JSON.stringify(credentials, null, 2));
  return credentials;
}

const apiKey = process.env.RENDER_API_KEY || read(".runtime/render.key");
if (!apiKey) {
  console.error(
    "ERRO: API Key do Render não encontrada.\n" +
      "Salve a chave em .runtime/render.key ou defina RENDER_API_KEY."
  );
  process.exit(1);
}

async function api(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = typeof data === "string" ? data : JSON.stringify(data);
    const err = new Error(`${method} ${endpoint} → HTTP ${res.status}: ${message}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function checkRepo() {
  console.log(`Repositório: ${REPO_URL}`);
  const git =
    process.env.GIT_BIN || path.join(ROOT, ".runtime", "git", "cmd", "git.exe");
  const result = spawnSync(git, ["ls-remote", REPO_URL, "HEAD"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    const detail =
      (result.stderr || "").trim() ||
      result.error?.message ||
      `código ${result.status}`;
    throw new Error(
      `Não foi possível acessar o repositório Git (${detail}). ` +
        "Verifique se ele é público e se a URL está correta."
    );
  }
  console.log("Repositório acessível.");
}

async function waitForPostgres(postgresId) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let detail = null;
  while (Date.now() < deadline) {
    detail = await api("GET", `/postgres/${postgresId}`);
    console.log(`  PostgreSQL: ${detail.status}`);
    if (detail.status === "available") return detail;
    if (detail.status === "unavailable") {
      throw new Error("O PostgreSQL do Render ficou indisponível.");
    }
    await sleep(5_000);
  }
  throw new Error("Tempo esgotado aguardando o PostgreSQL do Render.");
}

async function waitForDeploy(serviceId, deployId, dashboardUrl) {
  const deadline = Date.now() + 20 * 60 * 1000;
  let lastStatus = "";

  while (Date.now() < deadline) {
    let deploy = null;
    if (deployId) {
      deploy = await api("GET", `/services/${serviceId}/deploys/${deployId}`);
    } else {
      const list = await api("GET", `/services/${serviceId}/deploys?limit=1`);
      deploy = list?.[0]?.deploy ?? null;
      deployId = deploy?.id ?? deployId;
    }

    const status = deploy?.status ?? "desconhecido";
    if (status !== lastStatus) {
      console.log(`Deploy: ${status}`);
      lastStatus = status;
    }
    if (status === "live") return deploy;
    if (["build_failed", "update_failed", "canceled", "deactivated"].includes(status)) {
      throw new Error(
        `O deploy falhou (${status}). Veja os logs em ${dashboardUrl}`
      );
    }
    await sleep(10_000);
  }
  throw new Error(`Tempo esgotado aguardando o deploy. Veja ${dashboardUrl}`);
}

async function requestWithRetry(url, options = {}, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(5_000);
  }
  throw lastError ?? new Error("Tempo esgotado.");
}

let failures = 0;
function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

async function smokeTest(baseUrl, credentials) {
  console.log("\n=== Testes na URL pública ===");

  const healthRes = await requestWithRetry(`${baseUrl}/api/health`);
  const health = await healthRes.json().catch(() => null);
  check("health", healthRes.status === 200 && health?.ok === true, JSON.stringify(health));

  let events = [];
  const eventsDeadline = Date.now() + 90_000;
  while (Date.now() < eventsDeadline) {
    const pubRes = await requestWithRetry(`${baseUrl}/api/bet/vendedor01`);
    const pub = await pubRes.json().catch(() => null);
    events = pub?.events ?? [];
    if (events.some((event) => event.markets?.some((market) => market.selections?.length))) break;
    await sleep(5_000);
  }
  check("eventos públicos", events.length > 0, `${events.length} eventos`);

  const event = events.find((item) =>
    item.markets?.some((market) => market.selections?.length)
  );
  const market = event?.markets?.find((item) => item.selections?.length);
  const selection = market?.selections?.[0];
  check("odds disponíveis", Boolean(selection), selection ? `id=${selection.id} odd=${selection.odd}` : "");

  if (!selection) return;

  const couponRes = await fetch(`${baseUrl}/api/bet/vendedor01/coupons`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({
      selections: [{ selectionId: selection.id, odd: selection.odd }],
      stakeCents: 1000,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const coupon = await couponRes.json().catch(() => null);
  check("cupom criado", couponRes.status === 201, `status=${couponRes.status} code=${coupon?.code ?? "?"}`);
  check(
    "recibo com URL pública",
    typeof coupon?.receiptUrl === "string" && coupon.receiptUrl.startsWith(baseUrl),
    coupon?.receiptUrl ?? ""
  );

  if (coupon?.code) {
    const receiptRes = await fetch(`${baseUrl}/api/coupons/${coupon.code}`, {
      signal: AbortSignal.timeout(60_000),
    });
    const receipt = await receiptRes.json().catch(() => null);
    check(
      "recibo público",
      receiptRes.status === 200 && Boolean(receipt?.verification),
      receipt?.verification?.status ?? ""
    );

    const qrRes = await fetch(`${baseUrl}/api/coupons/${coupon.code}/qr`, {
      signal: AbortSignal.timeout(60_000),
    });
    check(
      "QR Code",
      qrRes.status === 200 && (qrRes.headers.get("content-type") ?? "").includes("image/png")
    );
  }

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ email: credentials.adminEmail, password: credentials.adminPassword }),
    signal: AbortSignal.timeout(60_000),
  });
  const login = await loginRes.json().catch(() => null);
  check("login admin", loginRes.status === 200 && login?.user?.role === "admin", `status=${loginRes.status}`);

  const ownerRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({
      email: credentials.seller01Email,
      password: credentials.seller01Password,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const owner = await ownerRes.json().catch(() => null);
  check("login proprietário", ownerRes.status === 200 && owner?.user?.role === "owner", `status=${ownerRes.status}`);
}

async function main() {
  const credentials = loadCredentials();
  await checkRepo();

  const owners = await api("GET", "/owners?limit=20");
  const ownerId = process.env.RENDER_OWNER_ID || owners?.[0]?.owner?.id;
  if (!ownerId) throw new Error("Nenhum workspace encontrado na conta Render.");
  const ownerName = owners.find((item) => item.owner?.id === ownerId)?.owner?.name ?? ownerId;
  console.log(`Workspace: ${ownerName} (${ownerId})`);

  const services = await api("GET", "/services?limit=100");
  let service = services.map((item) => item.service).find((item) => item.name === SERVICE_NAME);

  let postgresId = "";
  let postgresExpiresAt = "";
  let databaseUrl = process.env.DATABASE_URL || "";
  let deployId = "";

  if (service) {
    console.log(`Serviço já existe: ${service.id}`);
  } else {
    if (!databaseUrl) {
      const existingDatabases = await api("GET", "/postgres?limit=100");
      const existingPostgres = existingDatabases
        .map((item) => item.postgres ?? item)
        .find((item) => item.name === `${SERVICE_NAME}-db`);

      let postgres = existingPostgres;
      if (postgres) {
        postgresId = postgres.id;
        console.log(`Reutilizando PostgreSQL existente: ${postgresId}`);
      } else {
        console.log("Criando PostgreSQL free no Render...");
        postgres = await api("POST", "/postgres", {
          name: `${SERVICE_NAME}-db`,
          ownerId,
          plan: "free",
          region: REGION,
          version: "17",
          databaseName: "bet",
          databaseUser: "bet",
        });
        postgresId = postgres.id;
        console.log(`PostgreSQL criado: ${postgresId} (${postgres.status})`);
      }
      const detail = await waitForPostgres(postgresId);
      postgresExpiresAt = detail.expiresAt ?? "";
      if (postgresExpiresAt) {
        console.log(`Atenção: o PostgreSQL free do Render expira em ${postgresExpiresAt}.`);
      }
      const connection = await api("GET", `/postgres/${postgresId}/connection-info`);
      databaseUrl = connection.internalConnectionString;
      if (!databaseUrl) throw new Error("Não foi possível obter a conexão do PostgreSQL.");
    } else {
      console.log("Usando DATABASE_URL externa.");
    }

    console.log("Criando web service...");
    const created = await api("POST", "/services", {
      type: "web_service",
      name: SERVICE_NAME,
      ownerId,
      repo: REPO_URL,
      branch: "main",
      autoDeployTrigger: "off",
      envVars: [
        { key: "NODE_ENV", value: "production" },
        { key: "NODE_VERSION", value: "22.14.0" },
        { key: "DEMO_MODE", value: "true" },
        { key: "ODDS_PROVIDER", value: "demo" },
        { key: "SESSION_SECRET", value: credentials.sessionSecret },
        { key: "ADMIN_PASSWORD", value: credentials.adminPassword },
        { key: "SELLER01_PASSWORD", value: credentials.seller01Password },
        { key: "SELLER02_PASSWORD", value: credentials.seller02Password },
        { key: "DATABASE_URL", value: databaseUrl },
      ],
      serviceDetails: {
        runtime: "node",
        plan: "free",
        region: REGION,
        envSpecificDetails: {
          buildCommand: "npm ci --include=dev && npm run build",
          startCommand: "node scripts/deploy-start.cjs",
        },
        healthCheckPath: "/api/health",
        numInstances: 1,
      },
    });

    service = created.service;
    deployId = created.deployId;
    console.log(`Serviço criado: ${service.id}`);
  }

  let baseUrl = service.serviceDetails?.url ?? "";
  if (!baseUrl && service.slug) baseUrl = `https://${service.slug}.onrender.com`;
  const dashboardUrl = service.dashboardUrl ?? "https://dashboard.render.com";
  console.log(`Dashboard: ${dashboardUrl}`);
  if (baseUrl) console.log(`URL: ${baseUrl}`);

  if (service && !deployId) {
    const deploy = await api("POST", `/services/${service.id}/deploys`, {
      clearCache: "do_not_clear",
    });
    deployId = deploy.id;
    console.log(`Novo deploy: ${deployId}`);
  }

  await waitForDeploy(service.id, deployId, dashboardUrl);

  const fresh = await api("GET", `/services/${service.id}`);
  baseUrl = fresh.serviceDetails?.url ?? baseUrl;
  if (!baseUrl) throw new Error("O Render não retornou a URL pública do serviço.");

  write(
    ".runtime/render-service.json",
    JSON.stringify(
      {
        serviceId: service.id,
        url: baseUrl,
        dashboardUrl,
        deployId,
        postgresId,
        postgresExpiresAt,
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  write(
    ".runtime/render-credentials.txt",
    [
      "CREDENCIAIS DA PRODUÇÃO (Render)",
      "================================",
      `URL pública : ${baseUrl}`,
      `Admin       : ${credentials.adminEmail} / ${credentials.adminPassword}`,
      `Vendedor 01 : ${credentials.seller01Email} / ${credentials.seller01Password}`,
      `Vendedor 02 : ${credentials.seller02Email} / ${credentials.seller02Password}`,
      "",
      `Página pública : ${baseUrl}/bet/vendedor01`,
      `Painel admin   : ${baseUrl}/admin`,
      `Painel do dono : ${baseUrl}/owner`,
      "",
      postgresExpiresAt
        ? `ATENÇÃO: o PostgreSQL free do Render expira em ${postgresExpiresAt}.`
        : "Banco externo configurado via DATABASE_URL.",
      "",
    ].join("\r\n")
  );

  await smokeTest(baseUrl, credentials);

  console.log("\n=== Resultado ===");
  console.log(`URL: ${baseUrl}`);
  console.log(`Admin: ${credentials.adminEmail} / ${credentials.adminPassword}`);
  console.log(`Dono 01: ${credentials.seller01Email} / ${credentials.seller01Password}`);
  console.log(`Dono 02: ${credentials.seller02Email} / ${credentials.seller02Password}`);
  console.log("Credenciais salvas em .runtime/render-credentials.txt");
  if (postgresExpiresAt) {
    console.log(`PostgreSQL free expira em: ${postgresExpiresAt}`);
  }
  if (failures > 0) {
    console.error(`\n${failures} teste(s) falharam. Verifique os logs no dashboard.`);
    process.exitCode = 1;
  } else {
    console.log("\nDeploy concluído e validado.");
  }
}

main().catch((err) => {
  console.error(`\nERRO: ${err.message}`);
  if (err.status === 401) {
    console.error("Verifique se o API Key do Render é válido e tem permissão na conta.");
  }
  if (err.status === 409) {
    console.error("Já existe um recurso com esse nome. Defina SERVICE_NAME com outro nome.");
  }
  process.exit(1);
});
