import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = fs.readFileSync(path.join(ROOT, ".runtime", "render.key"), "utf8").trim();
const info = JSON.parse(fs.readFileSync(path.join(ROOT, ".runtime", "render-service.json"), "utf8"));
const SERVICE = info.serviceId;

const res = await fetch(`https://api.render.com/v1/services/${SERVICE}/env-vars?limit=100`, {
  headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
});
if (!res.ok) {
  console.error("HTTP", res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}
const rows = await res.json();
const env = {};
for (const row of rows) {
  const v = row.envVar ?? row;
  env[v.key] = v.value;
}
const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
fs.writeFileSync(path.join(ROOT, ".runtime", "prod.env"), lines + "\n", "utf8");
console.log("variáveis:", Object.keys(env).sort().join(", "));
console.log("DATABASE_URL presente:", Boolean(env.DATABASE_URL));
