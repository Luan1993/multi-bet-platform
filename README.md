# Plataforma Multi-Bet

Plataforma de apostas esportivas **multi-tenant** com três ambientes:

1. **Admin da plataforma** (`/admin`) — gestão de bets, provedores de odds, limites globais e auditoria.
2. **Painel do proprietário** (`/owner`) — dados, clientes, cupons, relatórios e branding isolados por bet.
3. **Página pública da bet** (`/bet/:slug`) — eventos com escudos, filtro por liga, montagem de cupom e recibo digital.

> **Aviso:** o sistema opera em **modo demonstração** por padrão. Ele não movimenta depósitos, saques, saldos ou prêmios reais. A operação real exige autorização legal e integrações homologadas.

**Deploy atual:** https://multi-bet.onrender.com — instruções e limitações em [DEPLOY.md](DEPLOY.md).

## Stack

- **Backend:** Node.js + TypeScript + Express (`server/`)
- **Banco:** PostgreSQL (`server/src/db/migrations`)
- **Frontend:** React + Vite + TypeScript (`web/`)
- **Odds:** adapter com provedores `demo` e `api-football` (API-Football v3)

## Requisitos

- Node.js 20+
- PostgreSQL 17 (o projeto inclui suporte a PostgreSQL portátil local via `embedded-postgres`)

## Instalação

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
```

Edite o `.env`:

| Variável | Descrição |
| --- | --- |
| `DATABASE_URL` | URL do PostgreSQL. Vazio usa o banco portátil local. No Neon, use a URL **pooled**. |
| `DATABASE_URL_UNPOOLED` | URL **direta** do Neon para migrações/seed/backup (opcional em outros bancos). |
| `PG_LOCAL_DIR` | Pasta do PostgreSQL portátil (padrão `.pgdata`). |
| `ODDS_PROVIDER` | `demo`, `api-football` ou `none`. |
| `API_FOOTBALL_KEY` | Chave da API-Football (somente para o provedor real). |
| `DEMO_MODE` | `true` mantém avisos e bloqueia valores reais. |
| `SESSION_SECRET` | Segredo para tokens de sessão. **Obrigatório em produção.** |
| `PUBLIC_BASE_URL` | URL pública usada em links de recibo e QR. |
| `GLOBAL_MAX_PAYOUT_CENTS` | Teto global de retorno por cupom (`500000` = R$ 5.000,00). |

## Banco de dados

```bash
npm run db:migrate
npm run db:seed
```

O seed cria o administrador e duas bets de demonstração. Em uma instalação nova, as senhas iniciais são:

| Perfil | E-mail | Senha inicial |
| --- | --- | --- |
| Admin | `admin@plataforma.local` | `Admin123!` |
| Proprietário | `vendedor01@demo.local` | `Vend123!` |
| Proprietário | `vendedor02@demo.local` | `Vend123!` |

> **Nesta instância publicada, as senhas foram rotacionadas** antes da exposição pública. As credenciais atuais estão em `.pgdata/credentials.txt` e não são mais as senhas padrão acima.

## Executar em desenvolvimento

Em dois terminais:

```bash
npm run dev        # API em http://localhost:4000
npm run dev:web    # Vite em http://127.0.0.1:5173
```

Acesse `http://127.0.0.1:5173`.

## Regras principais

- **Isolamento multi-tenant:** toda consulta de proprietário é filtrada por `owner_id`; rotas administrativas retornam `403` para owners e vice-versa.
- **Página pública:** escudos das equipes e da liga, filtro por liga, seleção de mercados e limite de retorno aplicado no navegador antes do envio.
- **Cupom em dois passos:** a página pública gera um **pré-cupom** (`BET-XXXX-XXXX-XXXX-CC`). O proprietário valida o código, as odds são revalidadas no servidor e só então o cupom é aceito.
- **Snapshot de odds:** seleções, mercados, odds e horário de captura são gravados na criação; mercados suspensos são bloqueados.
- **Teto de retorno:** R$ 5.000 por cupom, validado no frontend e no backend. O dono pode configurar um teto menor, nunca maior que o global. Tentativas acima do limite geram evento de risco.
- **Configurações por bet:** cada proprietário define seus próprios limites de aposta e de retorno (ou usa o padrão da plataforma); o admin também pode ajustar esses limites no detalhe da bet.
- **Recibo digital:** consulta pública por código, com QR de autenticidade em `/api/coupons/:code/qr`.
- **Segurança:** sessão por token opaco em cookie `httpOnly`, verificação de `Origin`, RBAC, rate limiting, auditoria e eventos de risco.
- **Jogo responsável:** cadastro de cliente com verificação de idade, consentimentos, bloqueio e autoexclusão.

## Estrutura

```
server/
  src/
    modules/auth, admin, owner, public, odds
    middleware/        # auth, RBAC, rate limit, erros
    db/                # pool, migrações, seed
web/
  src/
    pages/admin/       # dashboard, proprietários, provedores, configurações, auditoria
    pages/owner/       # dashboard, cupons, clientes, relatórios, branding
    pages/PublicBet.tsx
    pages/PublicReceipt.tsx
    components/ui.tsx
```

## Publicação online (túnel temporário)

Execute na raiz (o script sobe o PostgreSQL local automaticamente, se necessário):

```bat
online.cmd
```

O script:

1. gera o build de produção do servidor e do frontend;
2. abre um túnel gratuito do Cloudflare (`*.trycloudflare.com`);
3. sobe a API em `NODE_ENV=production` servindo o frontend no mesmo endereço;
4. grava a URL pública em `.runtime/public-url.txt`.

Saída esperada:

```
Página pública : https://<aleatorio>.trycloudflare.com/bet/vendedor01
Admin          : https://<aleatorio>.trycloudflare.com/admin
Painel do dono : https://<aleatorio>.trycloudflare.com/owner
```

**Limitações do túnel gratuito:** o endereço muda a cada reinício, não tem garantia de disponibilidade e só funciona enquanto este computador e o processo estiverem ligados. Para um domínio fixo, use um túnel nomeado do Cloudflare (com conta) ou hospedagem dedicada.

Para subir a produção sem túnel (acesso local/rede): `server\start-prod.cmd` ou `server\start-prod.cmd http://SEU_IP:4000`.

## Deploy em nuvem (grátis)

### Opção recomendada: Render + Neon

O repositório já inclui `render.yaml` (Blueprint) e `scripts/deploy-start.cjs`. O start de produção aguarda o banco, aplica migrações, roda o seed **idempotente** e sobe a API.

1. Crie uma conta gratuita no [Render](https://dashboard.render.com/register) (plano Hobby, sem cartão).
2. Suba este projeto em um repositório GitHub/GitLab.
3. No Render: **New → Blueprint**, selecione o repositório e confirme o `render.yaml`.
4. Crie um PostgreSQL gratuito no [Neon](https://neon.com) (1 GB, sem cartão, plano permanente) e cole a URL no campo `DATABASE_URL` do Blueprint:
   ```text
   postgresql://usuario:senha@host/banco?sslmode=require
   ```
5. Clique em **Deploy**. O Render gera automaticamente `SESSION_SECRET`, `ADMIN_PASSWORD`, `SELLER01_PASSWORD` e `SELLER02_PASSWORD` (veja em **Environment** no painel do serviço).
6. A URL pública é detectada por `RENDER_EXTERNAL_URL`. Para domínio próprio, defina `PUBLIC_BASE_URL=https://seudominio.com`.

Variáveis usadas em produção:

| Variável | Obrigatória | Observação |
| --- | --- | --- |
| `DATABASE_URL` | sim | PostgreSQL gerenciado (Neon/Supabase/Aiven) |
| `SESSION_SECRET` | sim | 48 bytes hex; o Render gera |
| `NODE_ENV` | sim | `production` |
| `ADMIN_PASSWORD` | sim (1º boot) | senha inicial do admin; o Render gera |
| `SELLER01_PASSWORD` / `SELLER02_PASSWORD` | sim (1º boot) | senhas iniciais das bets demo |
| `PUBLIC_BASE_URL` | não | links de recibo/QR; fallback `RENDER_EXTERNAL_URL` |
| `DEMO_MODE` | não | mantenha `true` até autorização legal |
| `ODDS_PROVIDER` | não | `demo` (sem chave) ou `api-football` |

**Limitações do Render Free:** o serviço hiberna após 15 minutos sem acesso (a primeira requisição leva ~1 min); o filesystem é efêmero (logotipos agora ficam no banco); são 750 horas de instância/mês; o Postgres gratuito do próprio Render expira em 30 dias — por isso use Neon para um banco gratuito permanente.

### Opção VPS/Docker (Oracle Cloud Always Free etc.)

O `Dockerfile` e o `docker-compose.yml` sobem a aplicação + PostgreSQL:

```bash
cp .env.production.example .env.production
# edite .env.production com senhas fortes e PUBLIC_BASE_URL
docker compose --env-file .env.production up -d --build
```

Em uma VM gratuita (por exemplo, Oracle Cloud Always Free), coloque um proxy HTTPS (Caddy/Nginx) na frente da porta `4000`. O `docker compose` aplica migrações e seed no primeiro start.

## Produção definitiva

1. Use um PostgreSQL gerenciado com backup (Neon/Supabase/Aiven) e `DATABASE_URL` com SSL.
2. Defina `NODE_ENV=production`, `SESSION_SECRET` forte e `PUBLIC_BASE_URL` com HTTPS.
3. Execute `npm run build`; o build do servidor copia as migrações para `dist/`.
4. Sirva `server/dist/index.js` (ou `node scripts/deploy-start.cjs`) atrás de um proxy com HTTPS.
5. Mantenha `DEMO_MODE=true` até obter autorização legal e homologar um provedor de pagamentos.
6. Troque as senhas iniciais, proteja os segredos e restrinja o acesso ao banco.
