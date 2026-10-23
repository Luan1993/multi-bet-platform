import { config } from "../config";
import { queryOne } from "../db/pool";

/**
 * Modo demonstração efetivo da plataforma.
 *
 * O banco (`platform_settings.demo_mode`, editável no painel Admin) é a fonte
 * única de verdade; a variável de ambiente DEMO_MODE serve apenas como valor
 * inicial. Assim a interface, a página pública e o registro de cupons/lançamentos
 * nunca ficam divergentes.
 */
export async function getPlatformDemoMode(): Promise<boolean> {
  const row = await queryOne<{ demo_mode: boolean }>(
    `SELECT demo_mode FROM platform_settings WHERE id = 1`
  ).catch(() => null);
  return row?.demo_mode ?? config.demoMode;
}
