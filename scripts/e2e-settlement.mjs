#!/usr/bin/env node
/**
 * Teste de ponta a ponta da liquidação automática em um banco local isolado.
 *
 * Pré-requisitos:
 *   npm run db:local -w server
 *   npm run build -w server
 *
 * O script recria o database `bet_e2e`, aplica migrações + seed, sobe a API em
 * uma porta separada e valida:
 *   - cupom ganho, perdido, anulado (push) e pendente;
 *   - liquidação de cupons de OUTRO proprietário ao informar o resultado;
 *   - prêmio devido x prêmio pago e o caixa resultante;
 *   - pagamento (total) do prêmio e exposição restante.
 *
 * NUNCA aponte E2E_PG_ADMIN_URL para produção: o banco de teste é apagado.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PG_ADMIN_URL =
  process.env.E2E_PG_ADMIN_URL || "postgresql://postgres@127.0.0.1:55432/postgres";
const DB_NAME = process.env.E2E_DB_NAME || "bet_e2e";
const DB_URL = (() => {
  const u = new URL(PG_ADMIN_URL);
  u.pathname = `/${DB_NAME}`;
  return u.toString();
})();
const PORT = Number(process.env.E2E_PORT || 4199);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORDS = {
  admin: process.env.ADMIN_PASSWORD || "Admin123!",
  seller01: process.env.SELLER01_PASSWORD || "Vend123!",
  seller02: process.env.SELLER02_PASSWORD || "Vend123!",
};

for (const [name, url] of [["E2E_PG_ADMIN_URL", PG_ADMIN_URL], ["DATABASE_URL de teste", DB_URL]]) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`${name} aponta para host não local (${host}). Abortando por segurança.`);
  }
}

const childEnv = {
  ...process.env,
  DATABASE_URL: DB_URL,
  NODE_ENV: "development",
  PORT: String(PORT),
  PUBLIC_BASE_URL: BASE,
  DEMO_MODE: "false",
  ODDS_PROVIDER: "demo",
  SESSION_SECRET: "e2e-session-secret-nao-usar-em-producao",
  ADMIN_PASSWORD: PASSWORDS.admin,
  SELLER01_PASSWORD: PASSWORDS.seller01,
  SELLER02_PASSWORD: PASSWORDS.seller02,
};

const failures = [];
function check(condition, label, detail) {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
  }
}
function eq(actual, expected, label) {
  check(Object.is(actual, expected), label, { actual, expected });
}

function runNode(script) {
  const r = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env: childEnv,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`${script} falhou:\n${r.stdout}\n${r.stderr}`);
  }
}

async function waitForServer(proc, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`API encerrou com código ${proc.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("API não respondeu em /api/health a tempo.");
}

function cookieFrom(res) {
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

async function request(method, pathname, { cookie, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* resposta não-JSON */
  }
  return { status: res.status, json, text };
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error(`login ${email} sem cookie`);
  return cookie;
}

function money(amountCents, odd) {
  return Math.min(Math.round(amountCents * odd), 500_000);
}

// ---------------------------------------------------------------------------

const db = new pg.Client({ connectionString: PG_ADMIN_URL });
await db.connect();
await db.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
await db.query(`CREATE DATABASE "${DB_NAME}"`);
await db.end();

console.log("[e2e] aplicando migrações e seed...");
runNode(path.join(ROOT, "server", "dist", "db", "seed.js"));

const client = new pg.Client({ connectionString: DB_URL });
await client.connect();

const sport = await client.query(
  `INSERT INTO sports (provider, provider_sport_id, name, slug)
   VALUES ('e2e', 'futebol', 'Futebol', 'futebol') RETURNING id`
);
const fixtureId = `e2e-${Date.now()}`;
const event = await client.query(
  `INSERT INTO events (provider, provider_fixture_id, sport_id, home_team_name, away_team_name,
                       kickoff_at, status, is_demo, source, last_synced_at)
   VALUES ('demo', $1, $2, 'Casa E2E', 'Fora E2E', now() - interval '5 minutes', 'scheduled', false, 'e2e', now())
   RETURNING id`,
  [fixtureId, sport.rows[0].id]
);
const eventId = Number(event.rows[0].id);

async function addMarket(providerMarketId, marketKey, name, sortOrder, selections) {
  const m = await client.query(
    `INSERT INTO markets (event_id, provider_market_id, market_key, name, suspended, sort_order, last_updated_at)
     VALUES ($1, 'manual', $2, $3, false, $4, now()) RETURNING id`,
    [eventId, marketKey, name, sortOrder]
  );
  const ids = {};
  for (const [key, selName, odd] of selections) {
    const s = await client.query(
      `INSERT INTO selections (market_id, provider_selection_key, name, odd, last_updated_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING id`,
      [m.rows[0].id, key, selName, odd]
    );
    ids[key] = Number(s.rows[0].id);
  }
  return ids;
}

const winner = await addMarket("manual", "match_winner", "Resultado final", 1, [
  ["home", "Mandante", 2.0],
  ["draw", "Empate", 3.2],
  ["away", "Visitante", 3.5],
]);
const goals = await addMarket("manual", "goals_over_under", "Total de gols", 2, [
  ["over_2.5", "Mais de 2.5 gols", 1.8],
  ["under_2.5", "Menos de 2.5 gols", 1.9],
]);
const cards = await addMarket("manual", "cards_over_under", "Total de cartões", 3, [
  ["over_5", "Mais de 5 cartões", 2.0],
  ["under_5", "Menos de 5 cartões", 1.8],
]);
const doubleChance = await addMarket("manual", "double_chance", "Dupla chance", 4, [
  ["home_or_draw", "Mandante ou empate", 1.3],
]);

console.log("[e2e] subindo API...");
const server = spawn(process.execPath, [path.join(ROOT, "server", "dist", "index.js")], {
  cwd: ROOT,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

let exitCode = 0;
try {
  await waitForServer(server);

  const seller1 = await login("vendedor01@demo.local", PASSWORDS.seller01);
  const seller2 = await login("vendedor02@demo.local", PASSWORDS.seller02);

  async function createCoupon(slug, selections, stakeCents) {
    const res = await request("POST", `/api/bet/${slug}/coupons`, {
      body: {
        selections: selections.map((s) => ({ selectionId: s.id, odd: s.odd })),
        stakeCents,
        clientPhone: "11999990000",
      },
    });
    if (res.status !== 201) {
      throw new Error(`criação de cupom falhou: ${res.status} ${res.text}`);
    }
    return res.json;
  }

  async function accept(cookie, code) {
    const res = await request("POST", `/api/owner/coupons/${code}/accept`, { cookie, body: {} });
    if (res.status !== 200) throw new Error(`aceite ${code} falhou: ${res.status} ${res.text}`);
    return res.json;
  }

  console.log("[e2e] criando e aceitando cupons...");
  // A: ganho (mandante + over 2.5)
  const couponA = await createCoupon(
    "vendedor01",
    [
      { id: winner.home, odd: 2.0 },
      { id: goals["over_2.5"], odd: 1.8 },
    ],
    1000
  );
  await accept(seller1, couponA.code);

  // B: perdido (visitante), de outro proprietário
  const couponB = await createCoupon("vendedor02", [{ id: winner.away, odd: 3.5 }], 1000);
  await accept(seller2, couponB.code);

  // C: push (linha 5 = 5 cartões) → seleção anulada e stake estornada
  const couponC = await createCoupon("vendedor01", [{ id: cards.over_5, odd: 2.0 }], 1000);
  await accept(seller1, couponC.code);

  // D: ganho com uma perna anulada (odd combinada deve ignorar o push)
  const couponD = await createCoupon(
    "vendedor01",
    [
      { id: winner.home, odd: 2.0 },
      { id: cards.over_5, odd: 2.0 },
    ],
    1000
  );
  await accept(seller1, couponD.code);

  // E: mercado não suportado pela apuração automática → permanece pendente
  const couponE = await createCoupon(
    "vendedor01",
    [
      { id: winner.home, odd: 2.0 },
      { id: doubleChance.home_or_draw, odd: 1.3 },
    ],
    1000
  );
  await accept(seller1, couponE.code);

  console.log("[e2e] informando resultado do evento como vendedor01...");
  const settled = await request("PUT", `/api/owner/events/${eventId}/result`, {
    cookie: seller1,
    body: {
      homeScore: 2,
      awayScore: 1,
      cardsTotal: 5,
      cornersTotal: 10,
      shotsOnGoalTotal: 6,
    },
  });
  if (settled.status !== 200) throw new Error(`resultado falhou: ${settled.status} ${settled.text}`);
  const s = settled.json.settlement;
  eq(s.won, 2, "resultado: 2 cupons ganhos do vendedor01");
  eq(s.lost, 0, "resultado: nenhum perdido do vendedor01");
  eq(s.voided, 1, "resultado: 1 cupom anulado (push)");
  eq(s.pending, 1, "resultado: 1 cupom pendente (mercado não suportado)");
  eq(settled.json.otherOwnersCouponsSettled, 1, "resultado: cupom de outro proprietário liquidado");

  const rows = await client.query(
    `SELECT code, owner_id, status, combined_odd, potential_payout_cents, due_payout_cents,
            paid_payout_cents, settlement_note
       FROM coupons WHERE code = ANY($1::text[]) ORDER BY code`,
    [[couponA.code, couponB.code, couponC.code, couponD.code, couponE.code]]
  );
  const byCode = new Map(rows.rows.map((r) => [r.code, r]));
  const A = byCode.get(couponA.code);
  const B = byCode.get(couponB.code);
  const C = byCode.get(couponC.code);
  const D = byCode.get(couponD.code);
  const E = byCode.get(couponE.code);

  eq(A.status, "won", "A: ganho");
  eq(Number(A.due_payout_cents), money(1000, 3.6), "A: prêmio devido = 3,60 × stake");
  eq(Number(A.paid_payout_cents), 0, "A: ainda não pago");
  eq(B.status, "lost", "B: perdido");
  eq(B.owner_id, "2", "B: pertence ao vendedor02");
  eq(C.status, "cancelled", "C: push anula o cupom");
  eq(Number(C.due_payout_cents), 0, "C: sem prêmio devido");
  eq(D.status, "won", "D: ganho com perna anulada");
  eq(Number(D.due_payout_cents), money(1000, 2.0), "D: odd combinada ignora a perna anulada");
  eq(E.status, "accepted", "E: permanece aceito (mercado não suportado)");

  const movements = await client.query(
    `SELECT c.code, fm.owner_id, fm.type, fm.amount_cents
       FROM financial_movements fm JOIN coupons c ON c.id = fm.coupon_id
      WHERE c.code = ANY($1::text[])
      ORDER BY c.code, fm.id`,
    [[couponA.code, couponB.code, couponC.code, couponD.code, couponE.code]]
  );
  const sumBy = (code, type) =>
    movements.rows
      .filter((m) => m.code === code && m.type === type)
      .reduce((acc, m) => acc + Number(m.amount_cents), 0);
  eq(sumBy(couponA.code, "stake_accepted"), 1000, "A: entrada de stake");
  eq(sumBy(couponA.code, "prize_due"), 3600, "A: prêmio devido lançado");
  eq(sumBy(couponC.code, "adjustment"), -1000, "C: estorno da stake");
  eq(sumBy(couponD.code, "prize_due"), 2000, "D: prêmio devido lançado");
  eq(sumBy(couponE.code, "prize_due"), 0, "E: sem prêmio enquanto pendente");
  const bMovements = movements.rows.filter((m) => m.code === couponB.code);
  check(
    bMovements.every((m) => m.owner_id === "2"),
    "B: movimentos lançados no proprietário correto"
  );
  eq(sumBy(couponB.code, "stake_accepted"), 1000, "B: entrada de stake no vendedor02");
  eq(sumBy(couponB.code, "prize_due"), 0, "B: perdido não gera prêmio devido");

  const cash1Before = (await request("GET", "/api/owner/dashboard", { cookie: seller1 })).json.cash;
  eq(cash1Before.entradasCents, 4000, "caixa vendedor01: entradas = 4 stakes");
  eq(cash1Before.ajustesCents, -1000, "caixa vendedor01: estorno do push");
  eq(cash1Before.saidasCents, 0, "caixa vendedor01: nada pago ainda");
  eq(cash1Before.saldoCents, 3000, "caixa vendedor01: saldo antes do pagamento");
  eq(cash1Before.pendentesCents, 2600, "caixa vendedor01: responsabilidade do cupom E");

  const pay = await request("POST", `/api/owner/coupons/${couponA.code}/pay`, {
    cookie: seller1,
    body: { amountCents: 3600 },
  });
  eq(pay.status, 200, "pagamento do prêmio de A");
  const AAfter = (
    await client.query(
      `SELECT paid_payout_cents FROM coupons WHERE code = $1`,
      [couponA.code]
    )
  ).rows[0];
  eq(Number(AAfter.paid_payout_cents), 3600, "A: prêmio pago registrado");

  const cash1 = (await request("GET", "/api/owner/dashboard", { cookie: seller1 })).json.cash;
  eq(cash1.saidasCents, 3600, "caixa vendedor01: saída de prêmio pago");
  eq(cash1.saldoCents, -600, "caixa vendedor01: saldo após pagar A");
  eq(cash1.resultadoCents, 400, "caixa vendedor01: resultado = entradas - prêmios pagos");

  const cash2 = (await request("GET", "/api/owner/dashboard", { cookie: seller2 })).json.cash;
  eq(cash2.entradasCents, 1000, "caixa vendedor02: entrada da stake de B");
  eq(cash2.saidasCents, 0, "caixa vendedor02: perdido não gera prêmio");
  eq(cash2.saldoCents, 1000, "caixa vendedor02: saldo com a stake perdida");

  const risk = (await request("GET", "/api/owner/risk", { cookie: seller1 })).json;
  eq(risk.totals.openCoupons, 1, "risco: apenas E em aberto");
  eq(risk.totals.potentialCents, 2600, "risco: exposição potencial de E");
  eq(risk.totals.unpaidPrizesCents, 2000, "risco: prêmio de D ainda não pago");

  const results = (await request("GET", "/api/owner/events/results?hours=24", { cookie: seller1 })).json;
  const resultItem = results.items.find((i) => i.id === eventId);
  check(Boolean(resultItem), "resultados: evento listado");
  eq(resultItem?.resultFinal, true, "resultados: evento marcado como final");
  eq(resultItem?.openCoupons, 1, "resultados: 1 cupom do vendedor01 ainda aberto");

  const again = await request("PUT", `/api/owner/events/${eventId}/result`, {
    cookie: seller1,
    body: { homeScore: 0, awayScore: 0 },
  });
  eq(again.status, 409, "resultado: evento final não pode ser alterado");

  const publicA = await request("GET", `/api/coupons/${couponA.code}`);
  eq(publicA.status, 200, "consulta pública do cupom A");
  eq(publicA.json.coupon?.status ?? publicA.json.status, "won", "consulta pública: A consta como ganho");

  console.log("\n[e2e] RESUMO");
  console.log(`  A ${couponA.code}: ganho, devido 3600, pago 3600`);
  console.log(`  B ${couponB.code}: perdido (vendedor02)`);
  console.log(`  C ${couponC.code}: anulado (push), estorno 1000`);
  console.log(`  D ${couponD.code}: ganho, devido 2000`);
  console.log(`  E ${couponE.code}: pendente (dupla chance)`);
} catch (err) {
  exitCode = 1;
  console.error("\n[e2e] ERRO:", err.message);
  if (serverLog) console.error("\n--- log da API ---\n" + serverLog.slice(-6000));
  failures.push(err.message);
} finally {
  server.kill();
  await client.end().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
}

if (failures.length > 0) {
  console.error(`\n[e2e] ${failures.length} falha(s).`);
  process.exit(1);
}
console.log("\n[e2e] TUDO OK");
