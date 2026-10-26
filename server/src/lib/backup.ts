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

/**
 * Ordena as tabelas para que as referenciadas sejam inseridas antes das que
 * dependem delas. Sem isso o restore falha nas foreign keys (a ordem
 * alfabética, por exemplo, colocaria `audit_logs` antes de `users`).
 */
async function orderTablesByForeignKeys(tables: string[]): Promise<string[]> {
  const deps = await query<{ tbl: string; ref: string }>(
    `SELECT src.relname AS tbl, ref.relname AS ref
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_class ref ON ref.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'`
  );
  const known = new Set(tables);
  const byTable = new Map<string, Set<string>>();
  for (const table of tables) byTable.set(table, new Set());
  for (const d of deps) {
    if (d.tbl !== d.ref && known.has(d.tbl) && known.has(d.ref)) {
      byTable.get(d.tbl)!.add(d.ref);
    }
  }

  const ordered: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (table: string) => {
    if (done.has(table)) return;
    if (visiting.has(table)) {
      throw new Error(
        `Ciclo de foreign keys envolvendo "${table}". O backup precisa de ordem manual.`
      );
    }
    visiting.add(table);
    for (const ref of byTable.get(table) ?? []) visit(ref);
    visiting.delete(table);
    done.add(table);
    ordered.push(table);
  };
  for (const table of [...tables].sort()) visit(table);
  return ordered;
}

export async function buildSqlBackup(): Promise<BackupResult> {
  const rawTables = await query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  const tables = await orderTablesByForeignKeys(rawTables.map((t) => t.table_name));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out: string[] = [];
  out.push("-- Backup lógico multi-bet");
  out.push(`-- Gerado em ${new Date().toISOString()}`);
  out.push("-- Restaure em um banco vazio com as migrações já aplicadas.");
  out.push("SET client_encoding = 'UTF8';");
  out.push("BEGIN;");
  out.push("");
  // O restore substitui os dados atuais, incluindo linhas criadas pelas
  // migrações (ex.: payment_integrations), antes de inserir o backup.
  out.push(
    `TRUNCATE TABLE ${tables
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(", ")} RESTART IDENTITY CASCADE;`
  );
  out.push("");

  const summary: Array<{ table: string; rows: number }> = [];

  for (const table of tables) {
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
      // Restaurar sobre um banco já migrado não deve duplicar o controle de
      // migrações; as demais tabelas são restauradas integralmente.
      const conflict =
        table === "schema_migrations" ? " ON CONFLICT (name) DO NOTHING" : "";
      out.push(`INSERT INTO ${escapedTable} (${insertCols}) VALUES (${values})${conflict};`);
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
