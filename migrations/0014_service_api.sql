-- OneGl Service API: tenant isolation, API clients, webhooks and remote auth sessions.
-- Additive only: core collector tables remain unchanged so CLI/dashboard/worker keep working.

CREATE TABLE api_tenants (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text        NOT NULL,
  name        text        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_tenants_slug_key UNIQUE (slug),
  CONSTRAINT api_tenants_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$')
);

CREATE TABLE api_clients (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    bigint      NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  key_prefix   text        NOT NULL,
  key_hash     text        NOT NULL,
  scopes       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  enabled      boolean     NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CONSTRAINT api_clients_key_hash_key UNIQUE (key_hash)
);
CREATE INDEX api_clients_tenant_idx ON api_clients(tenant_id);
CREATE INDEX api_clients_prefix_idx ON api_clients(key_prefix);

CREATE TABLE api_tenant_projects (
  tenant_id    bigint      NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  project_id   bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_name text       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id),
  CONSTRAINT api_tenant_projects_name_key UNIQUE (tenant_id, external_name)
);

CREATE TABLE api_tenant_accounts (
  tenant_id   bigint      NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  account_key text        NOT NULL,
  provider    text        NOT NULL DEFAULT 'doubao',
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, account_key),
  CONSTRAINT api_tenant_accounts_account_fk
    FOREIGN KEY (provider, account_key) REFERENCES accounts(provider, account_key) ON DELETE CASCADE
);

CREATE TABLE api_webhook_endpoints (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   bigint      NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  url         text        NOT NULL,
  secret      text        NOT NULL,
  events      jsonb       NOT NULL DEFAULT '["batch.completed","batch.failed","batch.partial","batch.aborted"]'::jsonb,
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_webhooks_tenant_idx ON api_webhook_endpoints(tenant_id);

CREATE TABLE api_webhook_deliveries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id   bigint      NOT NULL REFERENCES api_webhook_endpoints(id) ON DELETE CASCADE,
  event_id      text        NOT NULL,
  event_type    text        NOT NULL,
  payload       jsonb       NOT NULL,
  status        text        NOT NULL DEFAULT 'pending',
  attempts      integer     NOT NULL DEFAULT 0,
  last_status   integer,
  last_error    text,
  next_attempt_at timestamptz,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_webhook_delivery_event_key UNIQUE(endpoint_id, event_id),
  CONSTRAINT api_webhook_delivery_status_check CHECK (status IN ('pending','delivering','delivered','failed'))
);
CREATE INDEX api_webhook_delivery_pending_idx ON api_webhook_deliveries(status, next_attempt_at);

CREATE TABLE api_auth_sessions (
  id            text PRIMARY KEY,
  tenant_id     bigint      NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  account_key   text        NOT NULL,
  provider      text        NOT NULL DEFAULT 'doubao',
  status        text        NOT NULL DEFAULT 'pending',
  public_token_hash text    NOT NULL,
  expires_at    timestamptz NOT NULL,
  started_at    timestamptz,
  completed_at  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_auth_sessions_status_check CHECK (status IN ('pending','starting','waiting_for_login','healthy','failed','expired','cancelled'))
);
CREATE INDEX api_auth_sessions_tenant_idx ON api_auth_sessions(tenant_id, created_at DESC);

-- Seed a compatibility tenant. Existing API root-key calls can operate against this tenant.
INSERT INTO api_tenants(slug, name) VALUES ('default', 'Default') ON CONFLICT (slug) DO NOTHING;
