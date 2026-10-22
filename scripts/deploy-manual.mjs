/**
 * Dispara deploy manual no Render e aguarda ficar "live".
 * Requer .runtime/render.key e .runtime/render-service.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.render.com/v1";
const KEY = fs.readFileSync(path.join(ROOT, ".runtime", "render.key"), "utf8").trim();
const info = JSON.parse(fs.readFileSync(path.join(ROOT, ".runtime", "render-service.json"), "utf8"));
const SERVICE = process.env.SERVICE_ID || info.serviceId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const deployedInfo = {
  dashboardUrl: "https://dashboard.render.com",
  postgresId: "",
  postgresExpiresAt: "",
  ...info,
};

async function api(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
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
  if (!res.ok) throw new Error(`${method} ${endpoint} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

console.log(`Serviço: ${SERVICE}`);
const svc = await api("GET", `/services/${SERVICE}`);
const baseUrl = svc.serviceDetails?.url ?? `https://${svc.slug}.onrender.com`;
deployedInfo.dashboardUrl = svc.dashboardUrl ?? deployedInfo.dashboardUrl;
console.log(`URL: ${baseUrl}`);

const deploy = await api("POST", `/services/${SERVICE}/deploys`, { clearCache: "do_not_clear" });
console.log(`Deploy criado: ${deploy.id} (status: ${deploy.status})`);

const deadline = Date.now() + 25 * 60 * 1000;
let last = "";
while (Date.now() < deadline) {
  const d = await api("GET", `/services/${SERVICE}/deploys/${deploy.id}`);
  const status = d.status ?? "desconhecido";
  if (status !== last) {
    console.log("Deploy:", status);
    last = status;
  }
  if (status === "live") {
    fs.writeFileSync(
      path.join(ROOT, ".runtime", "render-service.json"),
      JSON.stringify({ ...deployedInfo, deployId: deploy.id, deployedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
    console.log("DEPLOY_LIVE");
    process.exit(0);
  }
  if (["build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"].includes(status)) {
    console.error(`Deploy falhou (${status}). Verifique o dashboard.`);
    process.exit(1);
  }
  await sleep(15_000);
}
console.error("Tempo esgotado aguardando o deploy.");
process.exit(1);
