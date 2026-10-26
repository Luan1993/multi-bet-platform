/**
 * Baixa um backup SQL do ambiente de produção via API (login admin).
 * Requer .runtime/prod.env com ADMIN_PASSWORD. Grava em backups/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(ROOT, ".runtime", "prod.env");
if (!fs.existsSync(envFile)) {
  console.error("Arquivo .runtime/prod.env não encontrado. Rode scripts/fetch-prod-env.mjs.");
  process.exit(1);
}
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    })
);

const base = process.env.APP_URL || "https://multi-bet.onrender.com";
const email = process.env.ADMIN_EMAIL || "admin@plataforma.local";
const password = env.ADMIN_PASSWORD;
if (!password) {
  console.error("ADMIN_PASSWORD ausente em .runtime/prod.env.");
  process.exit(1);
}

const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) {
  console.error("Falha no login:", login.status, (await login.text()).slice(0, 300));
  process.exit(1);
}
const cookies = login.headers.getSetCookie?.() ?? [];
const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
if (!cookie) {
  console.error("Login sem cookie de sessão.");
  process.exit(1);
}

const res = await fetch(`${base}/api/admin/backup?confirm=1`, {
  headers: { cookie },
});
if (!res.ok) {
  console.error("Falha no backup:", res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const outDir = path.join(ROOT, "backups");
fs.mkdirSync(outDir, { recursive: true });
const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1]
  ?? `multi-bet-backup-${Date.now()}.sql`;
const file = path.join(outDir, filename);
fs.writeFileSync(file, buf);
const text = buf.toString("utf8");
const tables = [...text.matchAll(/-- Tabela (\S+): (\d+) registro/g)].map((m) => `${m[1]}: ${m[2]}`);
console.log("Backup salvo:", file);
console.log("Tamanho:", (buf.length / 1024).toFixed(1), "KB");
console.log(tables.join("\n"));

// Retenção: mantém as N cópias mais recentes para não encher o disco.
const keep = Number(process.env.BACKUP_KEEP || 14);
if (Number.isFinite(keep) && keep > 0) {
  const old = fs
    .readdirSync(outDir)
    .filter((f) => /^multi-bet-backup-.*\.sql$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(keep);
  for (const { f } of old) {
    fs.unlinkSync(path.join(outDir, f));
    console.log("Backup antigo removido:", f);
  }
}
