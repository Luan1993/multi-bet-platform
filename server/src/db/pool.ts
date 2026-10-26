import { Pool, PoolClient, QueryResultRow } from "pg";
import { config } from "../config";

let pool: Pool | null = null;
let migrationPool: Pool | null = null;

function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Sessões curtas de API: statements parametrizados sempre.
  });
}

export function getPool(): Pool {
  if (!pool) {
    if (!config.db.url) {
      throw new Error(
        "DATABASE_URL não configurada. Rode `npm run db:local -w server` para iniciar um PostgreSQL local portátil " +
          "ou configure DATABASE_URL no .env apontando para um servidor PostgreSQL (ex.: Neon/Supabase free tier)."
      );
    }
    pool = createPool(config.db.url);
  }
  return pool;
}

/**
 * Pool direto (sem pooling do provedor), usado apenas para DDL/migrações.
 * No Neon a URL pooled não deve ser usada para operações de schema.
 */
export function getMigrationPool(): Pool {
  if (!migrationPool) {
    if (!config.db.directUrl) {
      throw new Error(
        "DATABASE_URL_UNPOOLED (ou DATABASE_URL) não configurada para migrações."
      );
    }
    migrationPool = createPool(config.db.directUrl);
  }
  return migrationPool;
}

/** Executa uma query parametrizada no pool. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as never[]);
  return res.rows;
}

/** Executa uma query e devolve a primeira linha (ou null). */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Executa trabalho em transação. Toda escrita sensível passa por aqui
 * para garantir atomicidade (ex.: cupom + histórico + limite).
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignora */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  const pools = [pool, migrationPool].filter((p): p is Pool => p !== null);
  pool = null;
  migrationPool = null;
  await Promise.all(pools.map((p) => p.end()));
}
