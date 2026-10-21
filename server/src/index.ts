import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";
import { closePool, getPool } from "./db/pool";
import { migrate } from "./db/migrate";
import { startScheduler, stopScheduler } from "./modules/odds/scheduler";

async function main(): Promise<void> {
  // Migrações no boot (fora de testes)
  if (!config.isTest) {
    try {
      await migrate(false);
      logger.info("migrations_ok");
    } catch (err) {
      logger.error("migrations_failed", { message: (err as Error).message });
      process.exit(1);
    }
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info("server_started", {
      port: config.port,
      env: config.nodeEnv,
      demoMode: config.demoMode,
      provider: config.odds.provider,
    });
  });

  if (!config.isTest) startScheduler();

  const shutdown = async (signal: string) => {
    logger.info("server_stopping", { signal });
    stopScheduler();
    server.close(async () => {
      await closePool().catch(() => undefined);
      process.exit(0);
    });
    // Fallback: encerra mesmo se houver conexões presas
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Garante acesso ao pool para testes/E2E sem executar listen
  getPool();
}

main().catch((err) => {
  logger.error("server_boot_error", { message: err.message, stack: err.stack });
  process.exit(1);
});
