-- OneGl API observability: durable request audit metadata.
--
-- The table intentionally stores request metadata only. It must not contain request/response
-- bodies, authorization credentials, cookies, storageState, prompts or answers.

CREATE TABLE service_api_audit_logs (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id            text        NOT NULL,
  tenant_id             bigint      REFERENCES service_tenants (id) ON DELETE SET NULL,
  client_id             bigint      REFERENCES service_api_clients (id) ON DELETE SET NULL,
  auth_kind             text        NOT NULL DEFAULT 'anonymous',
  method                text        NOT NULL,
  path                   text        NOT NULL,
  route_key              text        NOT NULL,
  status                 integer     NOT NULL,
  duration_ms            integer     NOT NULL,
  error_code             text,
  idempotency_replayed   boolean     NOT NULL DEFAULT false,
  rate_limited           boolean     NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_api_audit_request_key UNIQUE (request_id),
  CONSTRAINT service_api_audit_auth_kind_check CHECK (auth_kind IN ('anonymous', 'client', 'master')),
  CONSTRAINT service_api_audit_status_check CHECK (status BETWEEN 100 AND 599),
  CONSTRAINT service_api_audit_duration_check CHECK (duration_ms >= 0)
);

CREATE INDEX service_api_audit_tenant_created_idx
  ON service_api_audit_logs (tenant_id, id DESC);
CREATE INDEX service_api_audit_client_created_idx
  ON service_api_audit_logs (client_id, id DESC)
  WHERE client_id IS NOT NULL;
CREATE INDEX service_api_audit_status_created_idx
  ON service_api_audit_logs (status, id DESC);
CREATE INDEX service_api_audit_error_created_idx
  ON service_api_audit_logs (error_code, id DESC)
  WHERE error_code IS NOT NULL;
CREATE INDEX service_api_audit_route_created_idx
  ON service_api_audit_logs (route_key, id DESC);

DO $$
DECLARE target_role text := 'onegl';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON service_api_audit_logs TO %I', target_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', target_role);
  END IF;
END
$$;
