/**
 * Exportação lógica do banco em SQL (sem depender do binário pg_dump).
 * Usada pelo painel administrativo para baixar um backup completo antes de
 * migrações de infraestrutura (ex.: troca de PostgreSQL no Render).
 */
import { query } from "../db/pool";

function quote(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

export interface BackupResult {
  filename: string;
  content: string;
  tables: Array<{ table: string; rows: number }>;
}

export async function buildSqlBackup(): Promise<BackupResult> {
  const tables = await query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out: string[] = [];
  out.push("-- Backup lógico multi-bet");
  out.push(`-- Gerado em ${new Date().toISOString()}`);
  out.push("-- Restaure em um banco vazio com as migrações já aplicadas.");
  out.push("SET client_encoding = 'UTF8';");
  out.push("BEGIN;");
  out.push("");

  const summary: Array<{ table: string; rows: number }> = [];

  for (const row of tables) {
    const table = row.table_name;
    const cols = await query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [table]
    );
    const columnNames = cols.map((c) => c.column_name);
    if (columnNames.length === 0) continue;

    const escapedTable = `"${table.replace(/"/g, '""')}"`;
    const selectList = columnNames.map((c) => `"${c.replace(/"/g, '""')}"::text`).join(", ");
    const data = await query<Record<string, string | null>>(`SELECT ${selectList} FROM ${escapedTable}`);

    out.push(`-- Tabela ${table}: ${data.length} registro(s)`);
    const insertCols = columnNames.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
    for (const dataRow of data) {
      const values = columnNames.map((c) => quote(dataRow[c])).join(", ");
      out.push(`INSERT INTO ${escapedTable} (${insertCols}) VALUES (${values});`);
    }

    if (columnNames.includes("id")) {
      const seq = await query<{ seq: string | null }>(
        `SELECT pg_get_serial_sequence($1, 'id') AS seq`,
        [`public."${table}"`]
      );
      const seqName = seq[0]?.seq;
      if (seqName) {
        out.push(
          `SELECT setval('${String(seqName).replace(/'/g, "''")}', ` +
            `COALESCE((SELECT MAX(id) FROM ${escapedTable}), 0) + 1, false);`
        );
      }
    }
    out.push("");
    summary.push({ table, rows: data.length });
  }

  out.push("COMMIT;");

  return {
    filename: `multi-bet-backup-${stamp}.sql`,
    content: out.join("\n"),
    tables: summary,
  };
}
