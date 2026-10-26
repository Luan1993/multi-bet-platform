#!/usr/bin/env node
/**
 * Backup lógico do PostgreSQL sem depender do binário pg_dump.
 *
 * Gera um arquivo .sql com INSERTs de todas as tabelas do schema public.
 * Restauração: crie o banco, rode as migrações (`npm run db:migrate`) e
 * execute o arquivo com `psql "$DATABASE_URL" -f backups/backup-....sql`.
 *
 * Uso:
 *   DATABASE_URL=postgres://... node scripts/backup-db.mjs [pasta-de-saida]
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const outDir = path.resolve(process.argv[2] || "backups");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(outDir, `backup-${stamp}.sql`);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não definida.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

try {
  await client.connect();
  const tables = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );

  const out = [];
  out.push("-- Backup lógico multi-bet");
  out.push(`-- Gerado em ${new Date().toISOString()}`);
  out.push("-- Restaure em um banco vazio com as migrações já aplicadas.");
  out.push("SET client_encoding = 'UTF8';");
  out.push("BEGIN;");
  out.push("");

  const summary = [];
  for (const row of tables.rows) {
    const table = row.table_name;
    const cols = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [table]
    );
    const columnNames = cols.rows.map((c) => c.column_name);
    if (columnNames.length === 0) continue;

    const selectList = columnNames.map((c) => `"${c.replace(/"/g, '""')}"::text`).join(", ");
    const data = await client.query(
      `SELECT ${selectList} FROM "${table.replace(/"/g, '""')}"`
    );

    out.push(`-- Tabela ${table}: ${data.rows.length} registro(s)`);
    const insertCols = columnNames.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
    for (const dataRow of data.rows) {
      const values = columnNames
        .map((c) => quote(dataRow[c]))
        .join(", ");
      out.push(`INSERT INTO "${table.replace(/"/g, '""')}" (${insertCols}) VALUES (${values});`);
    }
    // Sincroniza sequences para evitar colisão de IDs após o restore.
    if (columnNames.includes("id")) {
      const seq = await client.query(
        `SELECT pg_get_serial_sequence($1, 'id') AS seq`,
        [`public."${table}"`]
      );
      const seqName = seq.rows[0]?.seq;
      if (seqName) {
        out.push(
          `SELECT setval('${String(seqName).replace(/'/g, "''")}', ` +
            `COALESCE((SELECT MAX(id) FROM "${table.replace(/"/g, '""')}"), 0) + 1, false);`
        );
      }
    }
    out.push("");
    summary.push(`${table}: ${data.rows.length}`);
  }

  out.push("COMMIT;");
  fs.writeFileSync(file, out.join("\n"), "utf8");
  const size = fs.statSync(file).size;
  console.log(`Backup gerado: ${file}`);
  console.log(`Tamanho: ${(size / 1024).toFixed(1)} KB`);
  console.log(summary.join("\n"));
} catch (err) {
  console.error("Falha no backup:", err.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
