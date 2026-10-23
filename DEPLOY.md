# Deploy em produção

## URL

**https://multi-bet.onrender.com**

| Área | URL |
| --- | --- |
| Página pública (bet demo) | https://multi-bet.onrender.com/bet/vendedor01 |
| Painel administrativo | https://multi-bet.onrender.com/admin |
| Painel do proprietário | https://multi-bet.onrender.com/owner |
| Saúde da API | https://multi-bet.onrender.com/api/health |

As credenciais iniciais estão em `.runtime/render-credentials.txt` (arquivo local, **não versionado**). O seed usa as variáveis `ADMIN_PASSWORD`, `SELLER01_PASSWORD` e `SELLER02_PASSWORD`; elas não são impressas nos logs do Render.

## Infraestrutura

- **Web service:** Render, plano free, região Oregon (`srv-dbcfh66ktt5c73f9rs5g`)
- **PostgreSQL:** Render, plano free, região Oregon (`dpg-dbcfdrifngtc73adfcs0-a`)
- **Repositório:** https://github.com/Luan1993/multi-bet-platform
- **Build:** `npm ci --include=dev && npm run build`
- **Start:** `node scripts/deploy-start.cjs` (aguarda o banco, migra, roda o seed idempotente e sobe a API)
- **Health check:** `/api/health`

## Banco de dados

O PostgreSQL free do Render expira em **2026-11-20**. Para manter o banco gratuito por tempo indeterminado:

1. Crie um projeto gratuito no [Neon](https://neon.com) (sem cartão).
2. Copie a connection string (`postgresql://...?...sslmode=require`).
3. No Render, abra o serviço → **Environment** → edite `DATABASE_URL`.
4. Rode um novo deploy. As migrações e o seed são idempotentes.

Alternativa: use Supabase ou Aiven no plano free.

## Atualizações

O auto-deploy está **desligado** (`autoDeployTrigger: off`) para não depender do repositório temporário usado no primeiro deploy.

1. Faça commit e push para `main` no GitHub.
2. No Render: serviço → **Manual Deploy** → **Deploy latest commit**.

Ou, com um API Key do Render no arquivo `.runtime/render.key`:

```bash
node scripts/deploy-manual.mjs   # dispara o deploy e aguarda ficar ao vivo
```

(Alternativa completa, que também recria recursos: `node scripts/deploy-render.mjs`.)

## Estados inválidos no cupom (item 6/8)

O servidor só aceita cupons com seleções **compatíveis**:

- Mercados de resultado único (Resultado Final, Dupla Chance, Ambas Marcam, Empate Anula, Intervalo/Final) aceitam apenas **uma seleção por evento**.
- No Total de Gols, escolhas impossíveis juntas são bloqueadas no servidor (ex.: “Mais de 1.5” com “Menos de 1.5”); combinações compatíveis de linhas distintas continuam permitidas (ex.: “Mais de 1.5” com “Menos de 3.5”).
- Na página pública, escolher uma opção que conflita substitui automaticamente a anterior e exibe um aviso; tentativas diretas à API recebem HTTP 400 `conflicting_selections`.

## Caixa, pagamentos e lucro/prejuízo

- **Configurações → Caixa inicial (R$)**: valor que já existia no caixa antes da plataforma (`owner_settings.opening_cash_cents`). Entra no saldo, mas não no lucro.
- **Página Caixa** (`/owner/cash`): saldo acumulado, entradas (apostas aceitas), saídas (prêmios pagos), ajustes manuais, a pagar (cupons aceitos), lucro/prejuízo e a lista de movimentações por período.
- **Ajuste de caixa**: reforço (entrada) ou sangria (retirada) com motivo obrigatório; grava em `financial_movements` (tipo `adjustment`) junto das entradas (`stake_accepted`) e pagamentos (`prize_paid`).
- **Dashboard**: seção “Caixa e resultado”, “Últimos pagamentos” e cupons agrupados por situação.
- Fórmulas: `saldo = caixa inicial + entradas + ajustes − saídas` e `lucro/prejuízo = entradas − prêmios pagos`.

## WhatsApp do cliente (consulta dos jogos)

- Na criação do cupom, o campo “Código do cliente” virou **WhatsApp (opcional)**: o número é normalizado no servidor e salvo no cupom (`coupons.client_phone`), mesmo sem cliente cadastrado.
- Se existir cliente cadastrado com o mesmo número, o cupom é vinculado a ele (elegibilidade/limites aplicam).
- Na página pública, o bloco **“Meus jogos”** permite ao cliente consultar os próprios cupons pelo número: `GET /api/bet/:slug/coupons?phone=` (limitado a 50, mais recentes primeiro).
- O painel do dono exibe o WhatsApp do apostador na lista/detalhe do cupom.

## Limitações do plano free do Render

- O serviço hiberna após **15 minutos sem acesso**. A primeira requisição depois disso pode levar ~1 minuto.
- Filesystem efêmero: logotipos de branding são gravados no PostgreSQL (coluna `logo_path`), então sobrevivem a reinícios.
- 750 horas de instância por mês e 512 MB de RAM.
- Sem shell/one-off jobs no plano free; migrações e seed rodam no start.
- O PostgreSQL free expira em 30 dias (ver acima).

## Segurança e modo demonstração

- **Fonte única do modo demo:** a coluna `platform_settings.demo_mode` (painel Admin → Configurações) manda; `DEMO_MODE` no Render é apenas o valor inicial usado no primeiro seed. `/api/health`, `/api/auth/me`, painéis e página pública leem sempre o valor do banco.
- Em produção o modo demonstração está **desligado** (`demo_mode = false`): cupons e lançamentos novos são gravados com `is_demo = false`. Cupons antigos mantêm a marcação histórica.
- A plataforma **não** movimenta depósitos/saques: não há gateway de pagamento homologado; entradas e prêmios são registrados manualmente pelo painel (Caixa).
- Troque as senhas iniciais após o primeiro acesso.
- O token clássico do GitHub usado apenas para criar/enviar o repositório deve ser **revogado** em https://github.com/settings/tokens depois do deploy.
- O arquivo `.runtime/` (credenciais, tokens e banco local) é ignorado pelo Git.

## Provedor de odds e odds manuais

- `ODDS_PROVIDER=football-data` usa a API pública do football-data.org (`FOOTBALL_DATA_KEY`). O plano gratuito libera ~12 competições e **não inclui odds**: os jogos aparecem, mas sem mercados.
- Para odds automáticas (1X2) basta ativar o **Odds Add-On** (€15/mês, 40 competições) no painel do football-data.org — o provedor já lê `odds.homeWin/draw/awayWin` sem alteração de código.
- Alternativa sem custo: o proprietário define as odds em **Painel → Odds dos jogos** (`PUT /api/owner/events/:id/odds`). As odds manuais ficam no mercado `manual`, têm prioridade sobre o provedor e **não expiram** (o provedor ignora esses eventos para não sobrescrever).
- Também é possível usar `ODDS_PROVIDER=api-football` com `API_FOOTBALL_KEY` (mais mercados: over/under, ambas marcam etc.).
- Regra do produto: nunca inventar odds fora do modo demonstração. Sem provedor/pacote de odds e sem odds manuais, a página pública informa indisponibilidade e a confirmação de apostas fica bloqueada.
