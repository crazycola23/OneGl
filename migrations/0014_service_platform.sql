-- OneGl service platform: tenant isolation, API clients, webhooks and remote auth sessions.
--
-- The collector's core project/account tables remain unchanged so the local Admin Console and
-- CLI continue to work. Service-facing tenancy is expressed through binding tables instead of
-- adding tenant filters to every collector query.

CREATE TABLE service_tenants (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text        NOT NULL,
  name        text        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_tenants_slug_key UNIQUE (slug),
  CONSTRAINT service_tenants_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,62}$')
);

INSERT INTO service_tenants (slug, name)
VALUES ('default', 'Default tenant')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE service_project_bindings (
  project_id    bigint      PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  tenant_id     bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  display_name  text        NOT NULL,
  external_id   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_project_binding_name_key UNIQUE (tenant_id, display_name)
);
CREATE UNIQUE INDEX service_project_binding_external_key
  ON service_project_bindings (tenant_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX service_project_binding_tenant_idx ON service_project_bindings (tenant_id);

INSERT INTO service_project_bindings (project_id, tenant_id, display_name)
SELECT p.id, t.id, p.name
  FROM projects p
 CROSS JOIN service_tenants t
 WHERE t.slug = 'default'
ON CONFLICT (project_id) DO NOTHING;

CREATE TABLE service_account_bindings (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  provider     text        NOT NULL DEFAULT 'doubao',
  account_key  text        NOT NULL,
  external_id  text        NOT NULL,
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_account_binding_internal_key UNIQUE (provider, account_key),
  CONSTRAINT service_account_binding_external_key UNIQUE (tenant_id, provider, external_id),
  CONSTRAINT service_account_binding_account_fk
    FOREIGN KEY (provider, account_key) REFERENCES accounts (provider, account_key) ON DELETE CASCADE
);
CREATE INDEX service_account_binding_tenant_idx ON service_account_bindings (tenant_id);

INSERT INTO service_account_bindings (tenant_id, provider, account_key, external_id, label)
SELECT t.id, a.provider, a.account_key, a.account_key, a.label
  FROM accounts a
 CROSS JOIN service_tenants t
 WHERE t.slug = 'default'
ON CONFLICT (provider, account_key) DO NOTHING;

CREATE TABLE service_api_clients (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  name           text        NOT NULL,
  key_prefix     text        NOT NULL,
  key_hash       text        NOT NULL,
  scopes         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  enabled        boolean     NOT NULL DEFAULT true,
  last_used_at   timestamptz,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  CONSTRAINT service_api_clients_key_hash_key UNIQUE (key_hash),
  CONSTRAINT service_api_clients_tenant_name_key UNIQUE (tenant_id, name)
);
CREATE INDEX service_api_clients_prefix_idx ON service_api_clients (key_prefix);

CREATE TABLE service_webhook_endpoints (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  url          text        NOT NULL,
  event_types  jsonb       NOT NULL DEFAULT '["*"]'::jsonb,
  enabled      boolean     NOT NULL DEFAULT true,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_webhook_endpoint_url_key UNIQUE (tenant_id, url)
);
CREATE INDEX service_webhook_endpoint_tenant_idx ON service_webhook_endpoints (tenant_id);

CREATE TABLE service_webhook_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  event_key        text        NOT NULL,
  event_type       text        NOT NULL,
  payload          jsonb       NOT NULL,
  status           text        NOT NULL DEFAULT 'queued',
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  last_error       text,
  CONSTRAINT service_webhook_events_key UNIQUE (event_key),
  CONSTRAINT service_webhook_events_status_check CHECK (status IN ('queued', 'delivering', 'delivered', 'failed'))
);
CREATE INDEX service_webhook_events_due_idx
  ON service_webhook_events (status, next_attempt_at, id);

CREATE TABLE service_webhook_deliveries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id       bigint      NOT NULL REFERENCES service_webhook_events (id) ON DELETE CASCADE,
  endpoint_id    bigint      NOT NULL REFERENCES service_webhook_endpoints (id) ON DELETE CASCADE,
  attempt        integer     NOT NULL,
  status         text        NOT NULL,
  response_code  integer,
  response_body  text,
  error          text,
  attempted_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_webhook_delivery_status_check CHECK (status IN ('success', 'failed'))
);
CREATE INDEX service_webhook_deliveries_event_idx ON service_webhook_deliveries (event_id);

CREATE TABLE service_auth_sessions (
  id                  uuid        PRIMARY KEY,
  tenant_id           bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  account_binding_id  bigint      NOT NULL REFERENCES service_account_bindings (id) ON DELETE CASCADE,
  status              text        NOT NULL DEFAULT 'pending',
  state_details       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  completed_at        timestamptz,
  CONSTRAINT service_auth_sessions_status_check CHECK (status IN (
    'pending', 'starting', 'waiting_for_login', 'connected', 'verification_required',
    'access_restricted', 'expired', 'failed', 'cancelled'
  ))
);
CREATE INDEX service_auth_sessions_tenant_idx ON service_auth_sessions (tenant_id, created_at DESC);

-- Terminal batch transitions enqueue a durable event. Delivery is performed by webhook:worker.
CREATE OR REPLACE FUNCTION onegl_service_batch_event() RETURNS trigger AS $$
DECLARE
  v_tenant_id bigint;
  v_type text;
  v_key text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('completed', 'partial', 'failed', 'aborted') THEN
    RETURN NEW;
  END IF;

  SELECT spb.tenant_id INTO v_tenant_id
    FROM service_project_bindings spb
   WHERE spb.project_id = NEW.project_id;
  IF v_tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_type := 'batch.' || NEW.status;
  v_key := 'batch:' || NEW.id::text || ':' || NEW.status || ':' || COALESCE(NEW.queued_at::text, NEW.created_at::text);
  INSERT INTO service_webhook_events (tenant_id, event_key, event_type, payload)
  VALUES (
    v_tenant_id,
    v_key,
    v_type,
    jsonb_build_object(
      'event', v_type,
      'batch_id', NEW.id,
      'project_id', NEW.project_id,
      'status', NEW.status,
      'requested_jobs', NEW.requested_jobs,
      'completed_jobs', NEW.completed_jobs,
      'failed_jobs', NEW.failed_jobs,
      'skipped_jobs', NEW.skipped_jobs,
      'finished_at', NEW.finished_at
    )
  )
  ON CONFLICT (event_key) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_onegl_service_batch_event ON sampling_batches;
CREATE TRIGGER trg_onegl_service_batch_event
AFTER UPDATE OF status ON sampling_batches
FOR EACH ROW EXECUTE FUNCTION onegl_service_batch_event();

-- Manual-attention account states also become webhook events for the owning tenant.
CREATE OR REPLACE FUNCTION onegl_service_account_event() RETURNS trigger AS $$
DECLARE
  v_tenant_id bigint;
  v_external_id text;
  v_type text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('login_required', 'session_expired', 'verification_required', 'access_restricted', 'rate_limited') THEN
    RETURN NEW;
  END IF;

  SELECT sab.tenant_id, sab.external_id INTO v_tenant_id, v_external_id
    FROM service_account_bindings sab
   WHERE sab.provider = NEW.provider AND sab.account_key = NEW.account_key;
  IF v_tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_type := 'account.' || NEW.status;
  INSERT INTO service_webhook_events (tenant_id, event_key, event_type, payload)
  VALUES (
    v_tenant_id,
    'account:' || NEW.provider || ':' || NEW.account_key || ':' || NEW.status || ':' || clock_timestamp()::text,
    v_type,
    jsonb_build_object(
      'event', v_type,
      'provider', NEW.provider,
      'account_id', v_external_id,
      'status', NEW.status,
      'cooldown_until', NEW.cooldown_until,
      'last_error_code', NEW.last_error_code
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_onegl_service_account_event ON accounts;
CREATE TRIGGER trg_onegl_service_account_event
AFTER UPDATE OF status ON accounts
FOR EACH ROW EXECUTE FUNCTION onegl_service_account_event();
