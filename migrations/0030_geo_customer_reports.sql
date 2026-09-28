-- Persisted customer-facing GEO reports. These reports aggregate more than one execution,
-- so they intentionally live beside (not inside) service_reports, whose contract is one
-- execution and one sampling batch per report.

CREATE TABLE service_geo_reports (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       text        NOT NULL UNIQUE,
  tenant_id       bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  task_id         bigint      NOT NULL REFERENCES service_tasks (id) ON DELETE CASCADE,
  profile_version text        NOT NULL,
  request         jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_geo_reports_task_idx ON service_geo_reports (tenant_id, task_id, id DESC);
CREATE INDEX service_geo_reports_tenant_idx ON service_geo_reports (tenant_id, id DESC);

-- A report may contain multiple named periods. This is the stable stage identity used by
-- future longitudinal collection/inclusion comparisons.
CREATE TABLE service_geo_report_periods (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_id      bigint      NOT NULL REFERENCES service_geo_reports (id) ON DELETE CASCADE,
  period_key     text        NOT NULL,
  label          text        NOT NULL,
  date_from      date        NOT NULL,
  date_to        date        NOT NULL,
  time_zone      text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_geo_report_periods_key UNIQUE (report_id, period_key),
  CONSTRAINT service_geo_report_periods_dates_check CHECK (date_to >= date_from)
);
CREATE INDEX service_geo_report_periods_dates_idx ON service_geo_report_periods (date_from, date_to);

-- Internal provenance only. The public snapshot carries execution IDs and timestamps, never
-- batch, project, prompt, account, or run database identifiers.
CREATE TABLE service_geo_report_batches (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_id           bigint      NOT NULL REFERENCES service_geo_reports (id) ON DELETE CASCADE,
  period_key          text        NOT NULL,
  batch_id            bigint      REFERENCES sampling_batches (id) ON DELETE SET NULL,
  execution_public_id text        NOT NULL,
  platform            text        NOT NULL,
  status_snapshot     text        NOT NULL,
  started_at_snapshot timestamptz NOT NULL,
  finished_at_snapshot timestamptz,
  included            boolean     NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_geo_report_batches_period_fk
    FOREIGN KEY (report_id, period_key)
    REFERENCES service_geo_report_periods (report_id, period_key) ON DELETE CASCADE,
  CONSTRAINT service_geo_report_batches_report_batch_key UNIQUE (report_id, period_key, batch_id)
);
CREATE INDEX service_geo_report_batches_batch_idx ON service_geo_report_batches (batch_id);

-- JSONB is the immutable data contract behind both JSON and HTML. Every future correction or
-- profile change creates a new revision; an existing revision is never rewritten.
CREATE TABLE service_geo_report_revisions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id      text        NOT NULL UNIQUE,
  tenant_id      bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  report_id      bigint      NOT NULL REFERENCES service_geo_reports (id) ON DELETE CASCADE,
  revision       integer     NOT NULL,
  schema_version text        NOT NULL,
  profile_version text       NOT NULL,
  content_hash   text        NOT NULL,
  artifact_hash  text        NOT NULL,
  payload        jsonb       NOT NULL,
  artifact_html  text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_geo_report_revisions_revision_key UNIQUE (report_id, revision),
  CONSTRAINT service_geo_report_revisions_revision_check CHECK (revision >= 1),
  CONSTRAINT service_geo_report_revisions_content_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT service_geo_report_revisions_artifact_hash_check CHECK (artifact_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX service_geo_report_revisions_latest_idx ON service_geo_report_revisions (report_id, revision DESC);
CREATE INDEX service_geo_report_revisions_tenant_idx ON service_geo_report_revisions (tenant_id, created_at DESC);

DO $$
DECLARE target_role text := 'onegl';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON service_geo_reports, service_geo_report_periods, service_geo_report_batches, service_geo_report_revisions TO %I', target_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', target_role);
  END IF;
END
$$;
