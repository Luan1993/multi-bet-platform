import { config } from "../../config";
import { logger } from "../../lib/logger";
import { syncAll } from "./service";

let timer: NodeJS.Timeout | null = null;

/**
 * Agendador de sincronização de odds.
 * - Roda uma sincronização inicial (async) e depois em intervalos fixos.
 * - O serviço de sync já respeita a cota diária do provedor (fetch seletivo).
 */
export function startScheduler(): void {
  if (timer) return;
  const interval = Math.max(config.odds.refreshMs, 5 * 60 * 1000);

  // Sincronização inicial, sem bloquear o boot
  setTimeout(() => {
    syncAll().catch((err) => logger.error("scheduler_initial_sync_error", { message: err.message }));
  }, 2_000);

  timer = setInterval(() => {
    syncAll().catch((err) => logger.error("scheduler_sync_error", { message: err.message }));
  }, interval);
  timer.unref?.();
  logger.info("scheduler_started", { intervalMs: interval, provider: config.odds.provider });
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
