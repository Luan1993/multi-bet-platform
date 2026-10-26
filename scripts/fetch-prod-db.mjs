import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = fs.readFileSync(path.join(ROOT, ".runtime", "render.key"), "utf8").trim();
const info = JSON.parse(fs.readFileSync(path.join(ROOT, ".runtime", "render-service.json"), "utf8"));

const res = await fetch(`https://api.render.com/v1/postgres/${info.postgresId}`, {
  headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
});
if (!res.ok) {
  console.error("HTTP", res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}
const db = await res.json();
const ci = db.connectionInfo ?? db;
const out = {
  name: db.name,
  expiresAt: db.expiresAt ?? info.postgresExpiresAt,
  status: db.status,
  plan: db.plan,
  version: db.version,
  external: ci.externalConnectionString ?? null,
  internal: ci.internalConnectionString ?? null,
  psql: ci.psqlCommand ?? null,
};
fs.writeFileSync(
  path.join(ROOT, ".runtime", "prod-db.json"),
  JSON.stringify(out, null, 2),
  "utf8"
);
console.log("name:", out.name, "| status:", out.status, "| plan:", out.plan);
console.log("expira:", out.expiresAt);
console.log("external disponível:", Boolean(out.external));
console.log("psql command:", out.psql ? "sim" : "não");
if (out.external) {
  const u = new URL(out.external);
  console.log("host externo:", u.hostname);
}
