/**
 * Seed inicial: administrador principal, proprietários de demonstração,
 * configurações da plataforma e provedores de odds.
 * NÃO cria cupons ou clientes fictícios — os eventos de demonstração são
 * gerados pelo provedor simulado e rotulados como tais.
 *
 * Uso: npm run db:seed -w server
 */
import fs from "fs";
import path from "path";
import { config } from "../config";
import { query, queryOne } from "./pool";
import { migrate } from "./migrate";
import { hashPassword } from "../lib/password";

async function main(): Promise<void> {
  // Em produção as senhas iniciais vêm de variáveis de ambiente — nunca
  // de valores padrão conhecidos. O seed é idempotente: em bancos já
  // inicializados ele não altera senhas existentes.
  if (config.isProd) {
    const required = ["ADMIN_PASSWORD", "SELLER01_PASSWORD", "SELLER02_PASSWORD"];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Em produção, defina as variáveis: ${missing.join(", ")}`);
    }
  }

  await migrate(false);

  // Configurações globais
  await query(
    `INSERT INTO platform_settings (id, demo_mode, max_payout_cents, min_stake_cents, max_stake_cents)
     VALUES (1, $1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [config.demoMode, config.limits.globalMaxPayoutCents, config.limits.globalMinStakeCents, config.limits.globalMaxStakeCents]
  );

  // Provedores de odds
  await query(
    `INSERT INTO provider_configs (provider, enabled, api_key) VALUES ('api-football', $1, $2)
     ON CONFLICT (provider) DO UPDATE SET api_key = COALESCE(EXCLUDED.api_key, provider_configs.api_key)`,
    [Boolean(config.odds.apiKey), config.odds.apiKey || null]
  );
  await query(
    `INSERT INTO provider_configs (provider, enabled) VALUES ('demo', $1)
     ON CONFLICT (provider) DO NOTHING`,
    [config.odds.provider === "demo"]
  );
  await query(
    `INSERT INTO provider_configs (provider, enabled, api_key) VALUES ('football-data', $1, $2)
     ON CONFLICT (provider) DO UPDATE SET api_key = COALESCE(EXCLUDED.api_key, provider_configs.api_key)`,
    [config.odds.provider === "football-data", config.odds.footballDataKey || null]
  );

  const credentials: string[] = [];

  // Administrador principal (não há cadastro público — criado aqui ou pelo seed)
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@plataforma.local").toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || "Admin123!";
  const existingAdmin = await queryOne(`SELECT id FROM users WHERE lower(email) = $1`, [adminEmail]);
  if (!existingAdmin) {
    await query(
      `INSERT INTO users (email, password_hash, display_name, role, owner_id)
       VALUES ($1, $2, $3, 'admin', NULL)`,
      [adminEmail, await hashPassword(adminPassword), "Administrador Principal"]
    );
    credentials.push(`ADMIN     : ${adminEmail} / ${adminPassword}`);
  }

  // Proprietários de demonstração (painéis individuais)
  const demoOwners = [
    {
      slug: "vendedor01",
      name: "Bet Demonstração 01",
      email: "vendedor01@demo.local",
      password: process.env.SELLER01_PASSWORD || "Vend123!",
      colors: { primary: "#7c3aed", secondary: "#0f172a", accent: "#22d3ee" },
    },
    {
      slug: "vendedor02",
      name: "Bet Demonstração 02",
      email: "vendedor02@demo.local",
      password: process.env.SELLER02_PASSWORD || "Vend123!",
      colors: { primary: "#059669", secondary: "#064e3b", accent: "#f59e0b" },
    },
  ];

  for (const o of demoOwners) {
    const existing = await queryOne<{ id: string }>(`SELECT id FROM owners WHERE slug = $1`, [o.slug]);
    let ownerId: string;
    if (existing) {
      ownerId = existing.id;
    } else {
      const owner = await queryOne<{ id: string }>(
        `INSERT INTO owners (slug, name, contact_email) VALUES ($1,$2,$3) RETURNING id`,
        [o.slug, o.name, o.email]
      );
      ownerId = owner!.id;
      await query(
        `INSERT INTO owner_branding (owner_id, display_name, tagline, primary_color, secondary_color, accent_color)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ownerId, o.name, "Apostas com responsabilidade — modo demonstração", o.colors.primary, o.colors.secondary, o.colors.accent]
      );
      await query(`INSERT INTO owner_settings (owner_id) VALUES ($1)`, [ownerId]);
    }
    const existingUser = await queryOne(`SELECT id FROM users WHERE lower(email) = $1`, [o.email]);
    if (!existingUser) {
      await query(
        `INSERT INTO users (email, password_hash, display_name, role, owner_id)
         VALUES ($1,$2,$3,'owner',$4)`,
        [o.email, await hashPassword(o.password), `Proprietário — ${o.name}`, ownerId]
      );
      credentials.push(`PROPRIET. : ${o.email} / ${o.password}  (slug: ${o.slug})`);
    }
  }

  if (credentials.length > 0) {
    if (config.isProd) {
      // Não imprime senhas nos logs do provedor de nuvem.
      console.log(
        "[seed] Usuários iniciais criados. As senhas são as variáveis ADMIN_PASSWORD, SELLER01_PASSWORD e SELLER02_PASSWORD."
      );
    } else {
      const file = path.join(config.repoRoot, ".pgdata", "credentials.txt");
      const content = [
        "CREDENCIAIS INICIAIS (altere em produção e apague este arquivo)",
        "===============================================================",
        ...credentials,
        "",
        `Gerado em ${new Date().toISOString()}`,
        "",
      ].join("\r\n");
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
      } catch {
        /* sem permissão de escrita: segue apenas no console */
      }
      console.log("\n[seed] Credenciais criadas:");
      for (const c of credentials) console.log(`       ${c}`);
      console.log(`[seed] (também salvo em .pgdata/credentials.txt)\n`);
    }
  } else {
    console.log("[seed] Nada a fazer — usuários já existem.");
  }
  console.log("[seed] Concluído.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[seed] ERRO: ${err.message}`);
    process.exit(1);
  });
