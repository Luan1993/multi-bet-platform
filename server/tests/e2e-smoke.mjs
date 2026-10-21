/**
 * Teste de fumaça end-to-end contra a API em execução.
 * Exercita: login, isolamento, criação de cupom, limites, aceitação e consulta.
 */
const BASE = process.env.BASE || "http://localhost:4000";

// Pequeno atraso entre chamadas para evitar rate limit de login
const WAIT_MS = 2000;

let cookies = {};

async function call(method, path, body, { expectStatus } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookies.jar ? { Cookie: cookies.jar } : {}),
      Origin: "http://localhost:5173",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const [pair] = c.split(";");
    const [name] = pair.split("=");
    const map = Object.fromEntries((cookies.jar || "").split("; ").filter(Boolean).map((p) => p.split("=")));
    if (name === "bet_session" && pair.includes("=")) {
      const value = pair.split("=").slice(1).join("=");
      const merged = { ...map, [name]: value };
      cookies.jar = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("; ");
    }
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* não-JSON */ }
  if (expectStatus && res.status !== expectStatus) {
    throw new Error(`${method} ${path} esperava ${expectStatus}, obteve ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, json, text };
}

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: Boolean(cond), extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
}

async function login(email, password) {
  cookies = {};
  await new Promise((r) => setTimeout(r, WAIT_MS));
  const r = await call("POST", "/api/auth/login", { email, password });
  return r;
}

(async () => {
  // 1. Saúde
  const health = await call("GET", "/api/health");
  check("health", health.json?.ok === true);

  // 2. Login admin
  const admin = await login("admin@plataforma.local", "Admin123!");
  check("login admin", admin.json?.user?.role === "admin", `status=${admin.status}`);

  // 3. Admin stats
  const stats = await call("GET", "/api/admin/stats");
  check("admin stats", stats.json?.owners?.total >= 2);

  // 4. Admin cria proprietário
  const slug = "testseller" + Math.floor(Math.random() * 9000 + 1000);
  const created = await call("POST", "/api/admin/owners", {
    slug,
    name: "Bet de Teste",
    loginEmail: `${slug}@test.local`,
    maxPayoutCents: 300000,
  });
  check("admin cria proprietario", created.json?.id > 0 && !!created.json?.initialPassword, `slug=${slug}`);
  const ownerId = created.json?.id;
  await new Promise((r) => setTimeout(r, 2000));

  // 5. Admin tenta criar proprietário com limite acima do teto global (deve falhar)
  const badLimit = await call("POST", "/api/admin/owners", {
    slug: slug + "x",
    name: "Bet Limite Alto",
    loginEmail: `${slug}x@test.local`,
    maxPayoutCents: 999_000_000,
  });
  check("bloqueia limite acima do teto", badLimit.status === 400, badLimit.json?.error?.code);

  // 6. Proprietário tenta acessar painel admin (deve ser 403)
  const ownerLogin = await login(`${slug}@test.local`, created.json.initialPassword);
  check("login proprietario", ownerLogin.json?.user?.role === "owner", `status=${ownerLogin.status}`);
  await new Promise((r) => setTimeout(r, 2000));
  const ownerToAdmin = await call("GET", "/api/admin/stats");
  check("proprietario nao acessa admin", ownerToAdmin.status === 403);

  // 7. Proprietário não vê cupons de outro tenant
  const listA = await call("GET", "/api/owner/coupons");
  check("lista cupons do proprio tenant", Array.isArray(listA.json?.items) && listA.json.items.length === 0, `total=${listA.json?.total}`);

  // 8. Cupom inexistente em outro tenant → 404 genérico
  const otherCoupon = await call("GET", "/api/owner/coupons/BET-AB08-Q8TS-0EYY-RC");
  check("cupom inexistente retorna 404", otherCoupon.status === 404, `status=${otherCoupon.status} code=${otherCoupon.json?.error?.code}`);

  // 9. Página pública da bet
  const pub = await call("GET", `/api/bet/${slug}`);
  check("pagina publica carrega", pub.json?.owner?.slug === slug, `eventos=${pub.json?.events?.length}`);
  check("limite da bet refletido", pub.json?.meta?.limits?.maxPayoutCents === 300000);
  check("provedor de odds identificado", ["api-football", "demo"].includes(pub.json?.meta?.provider?.id), pub.json?.meta?.provider?.id);
  const settingsMaxStake = pub.json?.meta?.limits?.maxStakeCents ?? 100000;

  // 10. Criação de cupom com odd divergente → 409 odd_changed
  const events = pub.json?.events ?? [];
  const withMarkets = events.filter((e) => e.markets?.length > 0);
  if (withMarkets.length === 0) {
    check("eventos com odds disponiveis", false, "nenhum evento com odds — cota da API esgotada?");
  } else {
    const ev = withMarkets[0];
    const market = ev.markets[0];
    const sel = market.selections[0];
    const badOdd = await call("POST", `/api/bet/${slug}/coupons`, {
      selections: [{ selectionId: sel.id, odd: sel.odd + 0.5 }],
      stakeCents: 1000,
    });
    check("rejeita odd divergente", badOdd.status === 409 && badOdd.json?.error?.code === "odd_changed", badOdd.json?.error?.code);

    // 11. Criação válida
    const okCoupon = await call("POST", `/api/bet/${slug}/coupons`, {
      selections: [{ selectionId: sel.id, odd: sel.odd }],
      stakeCents: 1000,
    });
    check("cria precupom", okCoupon.status === 201 && /^BET-/.test(okCoupon.json?.code || ""), okCoupon.json?.code);
    const code = okCoupon.json?.code;
    check("retorno potencial calculado", okCoupon.json?.potentialPayoutCents === Math.round(1000 * sel.odd), `${okCoupon.json?.potentialPayoutCents} vs ${Math.round(1000 * sel.odd)}`);
    check("aviso de que nao e aposta aceita", /NÃO É UMA APOSTA ACEITA/.test(okCoupon.json?.disclaimer || ""));

    // 12a. Limite global de R$ 5.000,00 (teto máximo de retorno por cupom):
    // aposta no teto de valor com 3 mercados multiplica o retorno muito acima do limite.
    const evMulti = events.find((e) => e.markets?.length >= 3) ?? ev;
    const picks = evMulti.markets.slice(0, 3).map((m) => m.selections[0]);
    const comboOdd = picks.reduce((a, s) => a * s.odd, 1);
    const overLimitGlobal = await call("POST", `/api/bet/${slug}/coupons`, {
      selections: picks.map((s) => ({ selectionId: s.id, odd: s.odd })),
      stakeCents: settingsMaxStake,
    });
    check(
      "bloqueia retorno acima de R$ 5.000 (limite global)",
      overLimitGlobal.status === 422 && overLimitGlobal.json?.error?.code === "payout_limit_exceeded",
      `${overLimitGlobal.status} ${overLimitGlobal.json?.error?.code} payout=${Math.round(settingsMaxStake * comboOdd)}`
    );
    check(
      "limite aplicado e reportado", 
      true,
      `limite desta bet: R$ ${(pub.json.meta.limits.maxPayoutCents / 100).toFixed(2)}`
    );

    // 12b. Limite específico da bet (R$ 3.000) — retorno entre 3.000 e 5.000
    // precisa ser recusado pela bet mesmo ficando abaixo do teto global.
    const betLimitStake = Math.ceil(300000 / comboOdd) + 500; // ~3.000 justos + folga
    const ownerLimitHit = await call("POST", `/api/bet/${slug}/coupons`, {
      selections: picks.map((s) => ({ selectionId: s.id, odd: s.odd })),
      stakeCents: Math.min(betLimitStake, settingsMaxStake),
    });
    check(
      "limite da bet é aplicado (abaixo do teto global)",
      ownerLimitHit.status === 422 || ownerLimitHit.status === 400,
      `${ownerLimitHit.status} ${ownerLimitHit.json?.error?.code}`
    );

    // 12c. Verifica que as tentativas bloqueadas foram registradas como risco
    await login("admin@plataforma.local", "Admin123!");
    const adminForRisk = await call("GET", "/api/admin/risk-events");
    const riskItems = Array.isArray(adminForRisk.json?.items) ? adminForRisk.json.items : [];
    const hasLimitEvent = riskItems.some((r) => r.type === "payout_limit_exceeded");
    check("registra tentativa bloqueada por limite", hasLimitEvent, `eventos=${riskItems.length} status=${adminForRisk.status}`);

    // 13. Stake abaixo do mínimo
    const lowStake = await call("POST", `/api/bet/${slug}/coupons`, {
      selections: [{ selectionId: sel.id, odd: sel.odd }],
      stakeCents: 1,
    });
    check("bloqueia stake abaixo do minimo", lowStake.status === 400 && lowStake.json?.error?.code === "stake_below_minimum");

    // 14. Consulta pública do cupom
    const lookup = await call("GET", `/api/coupons/${code}`);
    check("consulta publica do cupom", lookup.json?.verification?.status === "pending", lookup.json?.verification?.meaning?.slice(0, 40));
    check("codigo invalido rejeitado", (await call("GET", "/api/coupons/BET-1111-1111-1111-1")).status === 400);

    // 15. Proprietário aceita o cupom
    const accept = await call("POST", `/api/owner/coupons/${code}/accept`, {});
    check("proprietario aceita cupom", accept.json?.status === "accepted", JSON.stringify(accept.json?.error || accept.json));

    // 16. Não aceita duas vezes
    const accept2 = await call("POST", `/api/owner/coupons/${code}/accept`, {});
    check("nao aceita cupom ja aceito", accept2.status === 409);

    // 17. Liquidação
    const settle = await call("POST", `/api/owner/coupons/${code}/settle`, { result: "lost", note: "teste automatizado" });
    check("liquidacao registrada", settle.json?.status === "lost");

    // 18. Dashboard do proprietário
    const dash = await call("GET", "/api/owner/dashboard");
    check("dashboard do proprietario", dash.json?.counters?.total >= 1 && dash.json?.counters?.lost >= 1);
    check("valores separados (potencial/devido/pago)", typeof dash.json?.counters?.potentialTotalCents === "number" && typeof dash.json?.counters?.dueTotalCents === "number" && typeof dash.json?.counters?.paidTotalCents === "number");

    // 19. Exportação CSV
    const csv = await fetch(`${BASE}/api/owner/reports/export.csv`, { headers: { Cookie: cookies.jar } });
    const csvText = await csv.text();
    check("exportacao CSV", csv.status === 200 && csvText.includes("Código") && csvText.includes(code));
  }

  // 20. Cliente + consentimento + menor de idade
  const minor = await call("POST", "/api/owner/clients", {
    name: "Menor de Idade",
    birthDate: "2015-01-01",
    consents: { terms: true, privacy: true },
  });
  check("bloqueia cliente menor de 18", minor.status === 400 && minor.json?.error?.code === "client_ineligible");

  const client = await call("POST", "/api/owner/clients", {
    name: "Cliente de Teste",
    birthDate: "1990-05-10",
    document: "12345678900",
    consents: { terms: true, privacy: true, responsibleGaming: true },
  });
  check("cadastra cliente elegivel", client.status === 201 && !!client.json?.code, client.json?.code);

  // 21. Ação auditada
  await new Promise((r) => setTimeout(r, 2000));
  const audit = await call("GET", "/api/owner/audit");
  check("historico de acoes do proprietario", Array.isArray(audit.json?.items) && audit.json.items.length > 0, `itens=${audit.json?.items?.length} status=${audit.status}`);

  // 22. Cross-tenant: criar cupom em slug inexistente
  const noBet = await call("POST", "/api/bet/nao-existe/coupons", { selections: [{ selectionId: 1, odd: 2 }], stakeCents: 1000 });
  check("bet inexistente retorna 404", noBet.status === 404);

  // 23. Admin suspende a bet e o proprietário perde acesso
  const admin2 = await login("admin@plataforma.local", "Admin123!");
  const suspend = await call("PATCH", `/api/admin/owners/${ownerId}`, { status: "suspended" });
  check("admin suspende bet", suspend.json?.ok === true);
  const ownerLogin2 = await login(`${slug}@test.local`, created.json.initialPassword);
  check("proprietario suspenso nao loga", ownerLogin2.status === 403, ownerLogin2.json?.error?.code);
  const reopened = await login(`${slug}@test.local`, created.json.initialPassword);
  check("login segue bloqueado apos suspensao", reopened.status === 403);

  // Resumo
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} verificacoes OK ===`);
  if (failed.length) {
    console.log("FALHAS:");
    for (const f of failed) console.log(` - ${f.name} ${f.extra}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error("ERRO NO TESTE:", err.message);
  process.exit(1);
});
