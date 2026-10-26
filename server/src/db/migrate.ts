/**
 * Executor de migrações: aplica arquivos SQL de src/db/migrations/ em ordem,
 * registrando cada um aplicado na tabela schema_migrations (checksum incluído).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getMigrationPool } from "./pool";

export async function migrate(verbose = true): Promise<void> {
  const pool = getMigrationPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const dir = path.join(__dirname, "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    const applied = await pool.query(
      `SELECT checksum FROM schema_migrations WHERE name = $1`,
      [file]
    );
    if (applied.rows.length > 0) {
      if (applied.rows[0].checksum !== checksum) {
        throw new Error(
          `Migração ${file} foi alterada após aplicada (checksum divergente). ` +
            `Crie uma nova migração em vez de editar uma já aplicada.`
        );
      }
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`, [
        file,
        checksum,
      ]);
      await client.query("COMMIT");
      if (verbose) console.log(`[migrate] aplicada: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Falha ao aplicar ${file}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  if (verbose) console.log("[migrate] banco em dia.");
}

// CLI
if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[migrate] ERRO: ${err.message}`);
      process.exit(1);
    });
}
