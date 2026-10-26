#!/usr/bin/env node
/**
 * Verifica a integridade de um backup SQL restaurando-o em um banco local.
 *
 * Uso:
 *   npm run build -w server
 *   node scripts/verify-backup.mjs [backups/arquivo.sql] [nome-do-banco]
 *
 * O banco de destino é recriado do zero, recebe as migrações e depois o backup.
 * As contagens de linhas são comparadas com o cabeçalho do arquivo.
 * NUNCA aponte E2E_PG_ADMIN_URL para produção.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PG_ADMIN_URL =
  process.env.E2E_PG_ADMIN_URL || "postgresql://postgres@127.0.0.1:55432/postgres";
const backupFile = path.resolve(
  process.argv[2] ||
    (() => {
      const dir = path.join(ROOT, "backups");
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      return path.join(dir, files[files.length - 1]);
    })()
);
if (!fs.existsSync(backupFile)) {
  console.error(`Backup não encontrado: ${backupFile}`);
  process.exit(1);
}

const adminHost = new URL(PG_ADMIN_URL).hostname;
if (!["127.0.0.1", "localhost", "::1"].includes(adminHost)) {
  throw new Error(`E2E_PG_ADMIN_URL não é local (${adminHost}). Abortando por segurança.`);
}

const dbName = process.argv[3] || "bet_restore_check";
if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error(`Nome de banco inválido: ${dbName}`);
const targetUrl = (() => {
  const u = new URL(PG_ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

const sql = fs.readFileSync(backupFile, "utf8");
const expected = new Map(
  [...sql.matchAll(/-- Tabela (\S+): (\d+) registro/g)].map((m) => [m[1], Number(m[2])])
);

const admin = new pg.Client({ connectionString: PG_ADMIN_URL });
await admin.connect();
console.log(`[restore] recriando database ${dbName}...`);
await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
await admin.query(`CREATE DATABASE "${dbName}"`);
await admin.end();

const env = { ...process.env, DATABASE_URL: targetUrl, NODE_ENV: "development" };
const migrated = spawnSync(process.execPath, [path.join(ROOT, "server", "dist", "db", "migrate.js")], {
  cwd: ROOT,
  env,
  encoding: "utf8",
});
if (migrated.status !== 0) {
  console.error(migrated.stdout, migrated.stderr);
  throw new Error("Falha ao aplicar migrações no banco de restore.");
}

const client = new pg.Client({ connectionString: targetUrl });
await client.connect();
console.log(`[restore] aplicando ${path.basename(backupFile)} (${(sql.length / 1024).toFixed(1)} KB)...`);
try {
  await client.query(sql);
} catch (err) {
  console.error("[restore] FALHOU:", err.message);
  process.exitCode = 1;
  await client.end();
  process.exit(1);
}

const actualRows = await client.query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
);
let failures = 0;
for (const { table_name: table } of actualRows.rows) {
  const expectedRows = expected.get(table);
  if (expectedRows === undefined) {
    console.log(`  ignore ${table}: não estava no backup`);
    continue;
  }
  const count = await client.query(`SELECT COUNT(*)::int AS n FROM "${table.replace(/"/g, '""')}"`);
  const actual = count.rows[0].n;
  if (actual !== expectedRows) {
    failures++;
    console.error(`  FAIL ${table}: esperado ${expectedRows}, restaurado ${actual}`);
  } else {
    console.log(`  ok   ${table}: ${actual}`);
  }
}
for (const [table, count] of expected) {
  if (!actualRows.rows.some((r) => r.table_name === table)) {
    failures++;
    console.error(`  FAIL ${table}: tabela ausente no restore (${count} linhas no backup)`);
  }
}

// Confere se as sequences ficaram à frente dos IDs restaurados.
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
  const seq = row.seq
    .split(".")
    .map((p) => `"${p.replace(/"/g, '""')}"`)
    .join(".");
  const r = await client.query(`SELECT last_value FROM ${seq}`);
  const max = await client.query(
    `SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM "${row.table_name.replace(/"/g, '""')}"`
  );
  const lastValue = Number(r.rows[0]?.last_value ?? 0);
  const maxId = Number(max.rows[0]?.max_id ?? 0);
  // setval(max+1, false): o próximo nextval devolve max+1.
  if (!(lastValue > maxId)) {
    failures++;
    console.error(
      `  FAIL sequence ${row.table_name}: last_value=${lastValue}, max(id)=${maxId}`
    );
  }
}

await client.end();
if (failures > 0) {
  console.error(`\n[restore] ${failures} divergência(s). Banco ${dbName} mantido para inspeção.`);
  process.exit(1);
}
console.log(`\n[restore] OK — banco ${dbName} restaurado e conferido.`);
