#!/usr/bin/env node
/**
 * Migra os dados de um backup SQL para um PostgreSQL novo (Neon, Supabase,
 * Aiven ou outro). O banco de destino deve existir e estar vazio.
 *
 * Uso:
 *   npm run build -w server
 *   TARGET_DATABASE_URL="postgresql://...?sslmode=require" \
 *     node scripts/migrate-db.mjs backups/multi-bet-backup-....sql --confirm
 *
 * Etapas:
 *   1. aplica as migrações no destino;
 *   2. restaura o backup (o arquivo começa com TRUNCATE, então substitui dados);
 *   3. compara a contagem de todas as tabelas com o cabeçalho do backup;
 *   4. confere as sequences.
 *
 * Depois de validar, troque DATABASE_URL no Render e faça um novo deploy.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backupFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : null;
const targetArg = process.argv.slice(3).find((arg) => !arg.startsWith("--"));
const targetUrl =
  targetArg ||
  process.env.TARGET_DATABASE_URL ||
  process.env.DATABASE_URL_UNPOOLED;
const confirmed = process.argv.includes("--confirm");

if (!backupFile || !fs.existsSync(backupFile)) {
  console.error("Uso: node scripts/migrate-db.mjs <backup.sql> <DATABASE_URL_DESTINO> --confirm");
  process.exit(1);
}
if (!targetUrl) {
  console.error("Informe a URL do banco de destino (argumento ou TARGET_DATABASE_URL).");
  process.exit(1);
}
if (!confirmed) {
  console.error(
    "Operação destrutiva: o restore substitui os dados do destino. Repita com --confirm."
  );
  process.exit(1);
}

function masked(url) {
  const u = new URL(url);
  if (u.password) u.password = "***";
  return u.toString();
}

const sql = fs.readFileSync(backupFile, "utf8");
const expected = new Map(
  [...sql.matchAll(/-- Tabela (\S+): (\d+) registro/g)].map((m) => [m[1], Number(m[2])])
);
if (expected.size === 0) {
  console.error("O arquivo não parece ser um backup desta plataforma (sem cabeçalho de tabelas).");
  process.exit(1);
}

console.log(`[migrate-db] origem:  ${path.basename(backupFile)} (${(sql.length / 1024).toFixed(1)} KB)`);
console.log(`[migrate-db] destino: ${masked(targetUrl)}`);

const env = {
  ...process.env,
  DATABASE_URL: targetUrl,
  DATABASE_URL_UNPOOLED: targetUrl,
  NODE_ENV: "development",
};
const migrated = spawnSync(process.execPath, [path.join(ROOT, "server", "dist", "db", "migrate.js")], {
  cwd: ROOT,
  env,
  encoding: "utf8",
});
if (migrated.status !== 0) {
  console.error(migrated.stdout, migrated.stderr);
  console.error("[migrate-db] falha ao aplicar migrações no destino.");
  process.exit(1);
}
console.log("[migrate-db] migrações aplicadas.");

const client = new pg.Client({ connectionString: targetUrl, connectionTimeoutMillis: 20_000 });
await client.connect();
let failures = 0;
try {
  const info = await client.query("SELECT current_database() AS db, version() AS version");
  console.log(`[migrate-db] conectado em ${info.rows[0].db} (${info.rows[0].version.split(",")[0]})`);

  console.log("[migrate-db] restaurando backup...");
  await client.query(sql);

  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  );
  const restored = new Set(tables.rows.map((r) => r.table_name));
  for (const [table, count] of expected) {
    if (!restored.has(table)) {
      failures++;
      console.error(`  FAIL ${table}: tabela ausente no destino`);
      continue;
    }
    const actual = await client.query(
      `SELECT COUNT(*)::int AS n FROM "${table.replace(/"/g, '""')}"`
    );
    const n = actual.rows[0].n;
    if (n !== count) {
      failures++;
      console.error(`  FAIL ${table}: esperado ${count}, restaurado ${n}`);
    } else {
      console.log(`  ok   ${table}: ${n}`);
    }
  }

  const seqs = await client.query(
    `SELECT c.relname AS table_name,
            pg_get_serial_sequence('public.' || quote_ident(c.relname), 'id') AS seq
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
           WHERE col.table_schema = 'public' AND col.table_name = c.relname
             AND col.column_name = 'id'
        )`
  );
  for (const row of seqs.rows) {
    if (!row.seq) continue;
    const seq = row.seq.split(".").map((p) => `"${p.replace(/"/g, '""')}"`).join(".");
    const r = await client.query(`SELECT last_value FROM ${seq}`);
    const max = await client.query(
      `SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM "${row.table_name.replace(/"/g, '""')}"`
    );
    const lastValue = Number(r.rows[0]?.last_value ?? 0);
    const maxId = Number(max.rows[0]?.max_id ?? 0);
    if (!(lastValue > maxId)) {
      failures++;
      console.error(`  FAIL sequence ${row.table_name}: last_value=${lastValue}, max(id)=${maxId}`);
    }
  }
} catch (err) {
  console.error("[migrate-db] FALHOU:", err.message);
  failures++;
} finally {
  await client.end().catch(() => {});
}

if (failures > 0) {
  console.error(`\n[migrate-db] ${failures} falha(s). NÃO troque DATABASE_URL em produção.`);
  process.exit(1);
}
console.log("\n[migrate-db] restauração conferida. Agora troque DATABASE_URL no Render e faça deploy.");
