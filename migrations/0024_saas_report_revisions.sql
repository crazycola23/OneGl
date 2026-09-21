-- OneGl v0.8 — immutable report revisions.
--
-- GET /v1/reports/{id} recomputes its payload on every call, so a citation that arrives
-- after an execution goes terminal silently rewrites a report a SaaS has already stored.
-- A revision freezes one report-contract payload: the row is never UPDATEd, the payload is
-- the exact bytes served by the artifact endpoints, and content_hash lets a caller detect
-- that nothing actually changed.

CREATE TABLE service_report_revisions (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id             text        NOT NULL UNIQUE,
  tenant_id             bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  report_id             bigint      NOT NULL REFERENCES service_reports (id) ON DELETE CASCADE,
  execution_id          bigint      NOT NULL REFERENCES service_task_executions (id) ON DELETE CASCADE,
  revision              integer     NOT NULL,
  schema_version        text        NOT NULL,
  payload               jsonb       NOT NULL,
  content_hash          text        NOT NULL,
  input_scope           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  collected_until       timestamptz,
  analysis_completed_at timestamptz,
  analysis_generation   integer,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_report_revisions_revision_key UNIQUE (report_id, revision),
  CONSTRAINT service_report_revisions_revision_check CHECK (revision >= 1),
  CONSTRAINT service_report_revisions_content_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX service_report_revisions_report_idx ON service_report_revisions (report_id, revision DESC);
CREATE INDEX service_report_revisions_tenant_idx ON service_report_revisions (tenant_id, created_at DESC);
CREATE INDEX service_report_revisions_hash_idx ON service_report_revisions (report_id, content_hash);

DO $$
DECLARE target_role text := 'onegl';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON service_report_revisions TO %I', target_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', target_role);
  END IF;
END
$$;
