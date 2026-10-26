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
3. **Antes de trocar**, baixe um backup: entre como admin e acesse `/api/admin/backup?confirm=1` (ou use **Configurações → Backup do banco**). Guarde o arquivo `.sql` fora do repositório.
4. Restaure o backup no Neon (o banco precisa existir e estar vazio). Use a URL **direta** do Neon, sem `-pooler`, em `DATABASE_URL_UNPOOLED`:

   ```bash
   npm run build -w server
   node -r dotenv/config scripts/migrate-db.mjs backups/multi-bet-backup-....sql --confirm
   ```

   O script aplica as migrações, restaura o `.sql`, compara as contagens e confere as sequences. Se qualquer contagem divergir, ele para e **não** altera produção.
5. No Render, abra o serviço → **Environment** → edite `DATABASE_URL` com a URL **pooled** do Neon e adicione `DATABASE_URL_UNPOOLED` com a URL **direta**. Rode um novo deploy.
6. Confira login admin, dashboard, cupons, resultados e o endpoint de backup. Só depois apague o PostgreSQL antigo do Render.
7. **Atenção:** o backup começa com `TRUNCATE ... RESTART IDENTITY CASCADE`; ele **substitui** os dados do banco de destino. Restaure primeiro em um banco de teste (`node scripts/verify-backup.mjs`) e confira as contagens.

> O PostgreSQL free do Render **não expõe conexão externa**: o backup precisa ser gerado pelo próprio serviço (rota acima) ou por um script rodando dentro do Render. O endpoint inclui dados pessoais e hashes de senha — trate o arquivo como confidencial.

Alternativa: use Supabase ou Aiven no plano free.

**Backup automático:** agende `GET /api/admin/backup?confirm=1` (com cookie de admin) em um serviço externo, ou rode `npm run backup` em uma máquina com acesso ao banco. O Render free não tem disco persistente; baixe e armazene fora dele.

**Gerar e baixar de produção:**

```bash
node scripts/download-backup.mjs   # usa .runtime/prod.env e grava em backups/
```

**Conferir se o backup restaura** (PostgreSQL local já iniciado com `npm run db:local -w server`):

```bash
npm run build -w server
node scripts/verify-backup.mjs backups/multi-bet-backup-....sql bet_restore_check
```

O verificador recria um banco local, aplica as migrações, restaura o `.sql`, compara as contagens de todas as tabelas e confere as sequences. O backup é ordenado pelas foreign keys (pais antes dos filhos) e inclui as sequences.

**Backup externo:** para guardar fora do Render, use um agendador (GitHub Actions, cron em outra máquina ou serviço de cron) que faça login admin e chame `GET /api/admin/backup?confirm=1`, mantendo pelo menos 14 cópias. O arquivo contém dados pessoais: armazene criptografado e com acesso restrito. O `scripts/download-backup.mjs` já remove automaticamente as cópias mais antigas (padrão: 14; ajuste com `BACKUP_KEEP`).

**Agendamento no Windows (esta máquina):** a tarefa `MultiBet-Backup-Diario` roda todo dia às 03:00 e grava o log em `.runtime/backup-task.log`. Para recriar em outra máquina:

```powershell
# crie .runtime/backup-daily.cmd apontando para o node e para o repositório
schtasks /Create /F /SC DAILY /ST 03:00 /TN "MultiBet-Backup-Diario" `
  /TR "C:\caminho\para\o\repo\.runtime\backup-daily.cmd"
```

A tarefa é “interativo apenas”: só roda com o usuário logado. Se precisar que rode sem sessão aberta, configure a tarefa com credenciais no Agendador de Tarefas do Windows ou use um cron em servidor/VPS. Teste com `schtasks /Run /TN "MultiBet-Backup-Diario"` e confira o log.

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
- **Resultado de evento é uma operação global:** qualquer proprietário autenticado pode encerrar um evento compartilhado, e isso liquida cupons de todos. Em operação com sócios/terceiros, dê login de proprietário apenas a quem pode informar resultados ou evolua para um perfil separado de “operador de resultados”.
- O token clássico do GitHub usado apenas para criar/enviar o repositório deve ser **revogado** em https://github.com/settings/tokens depois do deploy.
- O arquivo `.runtime/` (credenciais, tokens e banco local) é ignorado pelo Git.

## Resultados e liquidação automática

- No painel do proprietário, **Resultados** lista os jogos das últimas 72h. Informe placar, cartões, escanteios e chutes a gol (estatísticas opcionais) e clique em **Salvar e liquidar cupons**.
- O servidor apura `match_winner`, `goals_over_under`, `cards_over_under`, `corners_over_under` e `shots_on_goal_over_under` usando o snapshot do cupom (não depende das seleções atuais).
- Linha inteira empatada (ex.: 10 escanteios na linha 10) anula a seleção (push). Evento anulado anula todas as seleções.
- Qualquer seleção perdida derruba o cupom. Todas anuladas → cupom cancelado e stake estornada via ajuste negativo no caixa. Vencedor → prêmio devido calculado pela odd combinada restante, limitado ao teto do cupom.
- Mercados não suportados (ex.: dupla chance) ficam pendentes e impedem a liquidação automática; o cupom pode ser liquidado manualmente.
- O prêmio devido **não é marcado como pago** automaticamente. Use **Cupons → Registrar pagamento** para lançar o `prize_paid` no caixa (total ou parcial).
- **Eventos e resultados são globais:** ao salvar o resultado, o servidor liquida os cupons aceitos de **todos** os proprietários que usaram aquele evento (as movimentações financeiras ficam no caixa de cada um). A resposta mostra apenas os cupons do proprietário que informou; o log de auditoria guarda o resumo completo.
- O resultado é **irreversível** (`result_final`): confira placar e estatísticas antes de salvar. Um evento sem estatísticas de cartões/escanteios/chutes deixa esses mercados pendentes; liquide manualmente se necessário.
- Em operação multi-tenant, o resultado afeta todos os proprietários. Informe resultados apenas por pessoas de confiança (ver “Segurança”).

## Teste de ponta a ponta da liquidação

Com o PostgreSQL local iniciado (`npm run db:local -w server`):

```bash
npm run e2e:settlement
```

O teste recria o banco `bet_e2e`, sobe a API em uma porta separada e valida cupom ganho, perdido, push (anulado), mercado não suportado (pendente), liquidação de cupom de outro proprietário, prêmio devido/pago, saldo, resultado e exposição. Ele **nunca** aponta para produção (aborta se o host não for local).

## Exposição / risco

- **Painel → Exposição / Risco** mostra cupons aceitos em aberto, stake, responsabilidade potencial (se todos ganharem), prêmios ganhos ainda não pagos e a exposição por evento/mercado.
- A exposição por evento soma o retorno potencial dos cupons que incluem aquele evento; serve para dimensionar o pior cenário por jogo, não como rateio contábil.

## CI e qualidade

- `npm run ci` executa typecheck do servidor, testes e build completo.
- O workflow de exemplo está em `docs/ci-workflow.yml`. O token atual do GitHub não tem permissão `workflow` para enviar `.github/workflows/`, então copie o arquivo para lá com um token que tenha o escopo `workflow` (ou use a interface do GitHub) para ativar o pipeline.
- `npm run e2e:settlement` e `node scripts/verify-backup.mjs` exigem o PostgreSQL local e não rodam no CI por padrão.

## Provedor de odds e odds manuais

- **Produção atual:** `ODDS_PROVIDER=the-odds-api` com `THE_ODDS_API_KEY`. Puxa odds automáticas de futebol (Resultado Final + Total de Gols) direto da The Odds API (the-odds-api.com).
  - O plano gratuito dá **500 créditos/mês**. Cada sincronização custa `mercados × regiões` por liga consultada; por isso o padrão é 3 ligas (Brasileirão, Libertadores e Premier League), 2 mercados e cache de 9h (`THE_ODDS_API_CACHE_MINUTES=540`). Isso consome ~480 créditos/mês.
  - Ajuste as ligas com `THE_ODDS_API_SPORTS` (chaves como `soccer_brazil_campeonato`), os mercados com `THE_ODDS_API_MARKETS` (`h2h,totals`) e a região com `THE_ODDS_API_REGIONS` (`eu`).
  - A The Odds API **não oferece** cartões, escanteios ou chutes a gol (só `h2h`, `spreads`, `totals` e `outrights`). Esses mercados ficam disponíveis como **odds manuais** no painel; para automatizá-los é necessário um feed pago que os cubra.
  - O cache é compartilhado e também controlado pelo banco (`events.last_synced_at`), então reinícios/cold starts do Render não consomem cota extra.
  - Como as odds podem ter até 9h, defina `ODDS_STALE_MINUTES=600`: abaixo disso a confirmação de cupons é bloqueada por segurança.
  - Para atualizações de hora em hora, o plano pago da The Odds API (20.000 créditos) é suficiente com a mesma configuração.
- `ODDS_PROVIDER=football-data` usa a API pública do football-data.org (`FOOTBALL_DATA_KEY`). O plano gratuito libera ~12 competições e **não inclui odds**: os jogos aparecem, mas sem mercados. O Odds Add-On (€15/mês) libera **apenas 1X2**.
- `ODDS_PROVIDER=api-football` com `API_FOOTBALL_KEY` (api-sports.io, plano pago) libera mais mercados: dupla chance, over/under, ambas marcam, empate anula, intervalo/final e, quando a casa de apostas publica, totais de cartões, escanteios e chutes a gol.
- Alternativa manual: o proprietário define as odds em **Painel → Odds dos jogos** (`PUT /api/owner/events/:id/odds`). Mercados manuais disponíveis: **Resultado Final, Total de Gols, Total de Cartões, Total de Escanteios e Chutes a Gol** (linha de Mais/Menos editável). As odds manuais ficam no mercado `manual`, têm prioridade sobre o provedor e **não expiram**. O provedor continua sincronizando os demais mercados do mesmo evento; apenas o mercado sobrescrito manualmente é ignorado.
- Regra do produto: nunca inventar odds fora do modo demonstração. Sem provedor/pacote de odds e sem odds manuais, a página pública informa indisponibilidade e a confirmação de apostas fica bloqueada.
