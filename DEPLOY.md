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
node scripts/deploy-render.mjs
```

## Limitações do plano free do Render

- O serviço hiberna após **15 minutos sem acesso**. A primeira requisição depois disso pode levar ~1 minuto.
- Filesystem efêmero: logotipos de branding são gravados no PostgreSQL (coluna `logo_path`), então sobrevivem a reinícios.
- 750 horas de instância por mês e 512 MB de RAM.
- Sem shell/one-off jobs no plano free; migrações e seed rodam no start.
- O PostgreSQL free expira em 30 dias (ver acima).

## Segurança e modo demonstração

- `DEMO_MODE=true`: a plataforma não simula depósitos, saques, saldos ou prêmios.
- Mantenha o modo demonstração até obter autorização legal e homologar um provedor de pagamentos.
- Troque as senhas iniciais após o primeiro acesso.
- O token clássico do GitHub usado apenas para criar/enviar o repositório deve ser **revogado** em https://github.com/settings/tokens depois do deploy.
- O arquivo `.runtime/` (credenciais, tokens e banco local) é ignorado pelo Git.
