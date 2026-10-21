-- ============================================================
-- 001_init.sql — Esquema inicial da plataforma multi-bet
-- Multi-tenant: toda entidade operacional possui owner_id
-- com FK e índices para garantir o isolamento por tenant.
-- Valores monetários em centavos (BIGINT). Odds em NUMERIC.
-- ============================================================

-- ---------- Tenants (bets / proprietários) ----------
CREATE TABLE owners (
  id            BIGSERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  document      TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','blocked')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT owners_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$')
);

-- ---------- Autenticação ----------
CREATE TABLE users (
  id                   BIGSERIAL PRIMARY KEY,
  email                TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('admin','owner')),
  owner_id             BIGINT NULL REFERENCES owners(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','blocked')),
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_owner_role CHECK ((role = 'owner') = (owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX users_one_login_per_owner ON users(owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE sessions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  ip         TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_attempts (
  id         BIGSERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,
  ip         TEXT,
  success    BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_lookup ON login_attempts(identifier, created_at);

-- ---------- Identidade visual e limites por bet ----------
CREATE TABLE owner_branding (
  owner_id       BIGINT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  display_name   TEXT NOT NULL,
  tagline        TEXT,
  logo_path      TEXT,
  primary_color  TEXT NOT NULL DEFAULT '#7c3aed',
  secondary_color TEXT NOT NULL DEFAULT '#0f172a',
  accent_color   TEXT NOT NULL DEFAULT '#22d3ee',
  theme          TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','light')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE owner_settings (
  owner_id          BIGINT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  max_payout_cents  BIGINT CHECK (max_payout_cents IS NULL OR max_payout_cents > 0),
  min_stake_cents   BIGINT CHECK (min_stake_cents IS NULL OR min_stake_cents > 0),
  max_stake_cents   BIGINT CHECK (max_stake_cents IS NULL OR max_stake_cents > 0),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        BIGINT REFERENCES users(id)
);

-- ---------- Clientes por bet ----------
CREATE TABLE clients (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      BIGINT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  document      TEXT,
  birth_date    DATE,
  email         TEXT,
  phone         TEXT,
  age_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','self_excluded')),
  notes         TEXT,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, code)
);
CREATE INDEX clients_owner ON clients(owner_id);
CREATE UNIQUE INDEX clients_document_per_owner ON clients(owner_id, document) WHERE document IS NOT NULL;

CREATE TABLE consents (
  id            BIGSERIAL PRIMARY KEY,
  client_id     BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  consent_type  TEXT NOT NULL CHECK (consent_type IN ('terms','privacy','marketing_email','marketing_sms','marketing_whatsapp','responsible_gaming')),
  granted       BOOLEAN NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX consents_client ON consents(client_id);

CREATE TABLE client_limits (
  id          BIGSERIAL PRIMARY KEY,
  client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  limit_type  TEXT NOT NULL CHECK (limit_type IN ('daily_stake','weekly_stake','monthly_stake','self_exclusion')),
  value_cents BIGINT CHECK (value_cents IS NULL OR value_cents >= 0),
  expires_at  TIMESTAMPTZ,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX client_limits_client ON client_limits(client_id);

-- ---------- Dados esportivos (catálogo compartilhado, sem tenant) ----------
CREATE TABLE sports (
  id                   BIGSERIAL PRIMARY KEY,
  provider             TEXT NOT NULL,
  provider_sport_id    TEXT NOT NULL,
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL,
  UNIQUE (provider, provider_sport_id)
);

CREATE TABLE competitions (
  id                       BIGSERIAL PRIMARY KEY,
  provider                 TEXT NOT NULL,
  provider_competition_id  TEXT NOT NULL,
  sport_id                 BIGINT NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  country                  TEXT,
  logo_url                 TEXT,
  season                   TEXT,
  UNIQUE (provider, provider_competition_id, season)
);

CREATE TABLE events (
  id                  BIGSERIAL PRIMARY KEY,
  provider            TEXT NOT NULL,
  provider_fixture_id TEXT NOT NULL,
  sport_id            BIGINT NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  competition_id      BIGINT REFERENCES competitions(id) ON DELETE SET NULL,
  home_team_name      TEXT NOT NULL,
  home_team_logo      TEXT,
  away_team_name      TEXT NOT NULL,
  away_team_logo      TEXT,
  kickoff_at          TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','finished','postponed','cancelled')),
  home_score          INT,
  away_score          INT,
  is_demo             BOOLEAN NOT NULL DEFAULT FALSE,
  source              TEXT NOT NULL,
  last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_fixture_id)
);
CREATE INDEX events_kickoff ON events(kickoff_at);
CREATE INDEX events_status ON events(status);

CREATE TABLE markets (
  id                  BIGSERIAL PRIMARY KEY,
  event_id            BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  provider_market_id  TEXT NOT NULL,
  market_key          TEXT NOT NULL,
  name                TEXT NOT NULL,
  suspended           BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order          INT NOT NULL DEFAULT 0,
  last_updated_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, provider_market_id, market_key)
);
CREATE INDEX markets_event ON markets(event_id);

CREATE TABLE selections (
  id                     BIGSERIAL PRIMARY KEY,
  market_id              BIGINT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  provider_selection_key TEXT NOT NULL,
  name                   TEXT NOT NULL,
  odd                    NUMERIC(12,4) NOT NULL CHECK (odd >= 1.01),
  last_updated_at        TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, provider_selection_key)
);
CREATE INDEX selections_market ON selections(market_id);

CREATE TABLE odds_history (
  id           BIGSERIAL PRIMARY KEY,
  selection_id BIGINT NOT NULL REFERENCES selections(id) ON DELETE CASCADE,
  odd          NUMERIC(12,4) NOT NULL,
  source       TEXT NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX odds_history_selection ON odds_history(selection_id, fetched_at DESC);

-- ---------- Cupons ----------
CREATE TABLE coupons (
  id                      BIGSERIAL PRIMARY KEY,
  code                    TEXT NOT NULL UNIQUE,
  owner_id                BIGINT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  client_id               BIGINT REFERENCES clients(id) ON DELETE SET NULL,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','accepted','cancelled','won','lost','expired')),
  stake_cents             BIGINT NOT NULL CHECK (stake_cents > 0),
  combined_odd            NUMERIC(14,4) NOT NULL,
  potential_payout_cents  BIGINT NOT NULL,
  due_payout_cents        BIGINT,           -- prêmio efetivamente devido (após liquidação)
  paid_payout_cents       BIGINT,           -- valor efetivamente pago
  currency                TEXT NOT NULL DEFAULT 'BRL',
  is_demo                 BOOLEAN NOT NULL DEFAULT TRUE,
  limit_applied_cents     BIGINT NOT NULL,
  odds_snapshot           JSONB NOT NULL,
  accepted_at             TIMESTAMPTZ,
  accepted_by             BIGINT REFERENCES users(id),
  cancelled_at            TIMESTAMPTZ,
  cancelled_by            BIGINT REFERENCES users(id),
  cancel_reason           TEXT,
  settled_at              TIMESTAMPTZ,
  settlement_note         TEXT,
  expires_at              TIMESTAMPTZ NOT NULL,
  client_ip               TEXT,
  user_agent              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX coupons_owner_created ON coupons(owner_id, created_at DESC);
CREATE INDEX coupons_owner_status ON coupons(owner_id, status);
CREATE INDEX coupons_client ON coupons(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX coupons_expires ON coupons(status, expires_at) WHERE status = 'pending';

CREATE TABLE coupon_status_history (
  id          BIGSERIAL PRIMARY KEY,
  coupon_id   BIGINT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  changed_by  BIGINT REFERENCES users(id),
  actor_role  TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX coupon_status_history_coupon ON coupon_status_history(coupon_id);

-- ---------- Financeiro ----------
CREATE TABLE financial_movements (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     BIGINT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  coupon_id    BIGINT REFERENCES coupons(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('stake_accepted','prize_potential','prize_due','prize_paid','adjustment')),
  amount_cents BIGINT NOT NULL,
  is_demo      BOOLEAN NOT NULL DEFAULT TRUE,
  note         TEXT,
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX financial_owner_date ON financial_movements(owner_id, created_at DESC);

-- ---------- Risco / limites ----------
CREATE TABLE risk_events (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      BIGINT REFERENCES owners(id) ON DELETE CASCADE,
  attempt_type  TEXT NOT NULL,
  coupon_code   TEXT,
  ip            TEXT,
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX risk_events_owner ON risk_events(owner_id, created_at DESC);

-- ---------- Auditoria ----------
CREATE TABLE audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(id),
  actor_role    TEXT,
  actor_label   TEXT,
  owner_id      BIGINT REFERENCES owners(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,
  entity        TEXT,
  entity_id     TEXT,
  before        JSONB,
  after         JSONB,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_owner_date ON audit_logs(owner_id, created_at DESC);
CREATE INDEX audit_date ON audit_logs(created_at DESC);

-- ---------- Configurações da plataforma ----------
CREATE TABLE platform_settings (
  id                 INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  demo_mode          BOOLEAN NOT NULL DEFAULT TRUE,
  max_payout_cents   BIGINT NOT NULL DEFAULT 500000,
  min_stake_cents    BIGINT NOT NULL DEFAULT 100,
  max_stake_cents    BIGINT NOT NULL DEFAULT 100000,
  compliance         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         BIGINT REFERENCES users(id)
);

CREATE TABLE provider_configs (
  id              BIGSERIAL PRIMARY KEY,
  provider        TEXT NOT NULL UNIQUE,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  api_key         TEXT,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_test_at    TIMESTAMPTZ,
  last_test_ok    BOOLEAN,
  last_test_message TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      BIGINT REFERENCES users(id)
);

-- ---------- Integrações financeiras (ex.: Pix) — registra indisponibilidade ----------
CREATE TABLE payment_integrations (
  id         BIGSERIAL PRIMARY KEY,
  provider   TEXT NOT NULL UNIQUE,
  enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO payment_integrations (provider, enabled) VALUES ('generic', FALSE);
