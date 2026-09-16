-- OneGl v0.5 — recurring Doubao monitoring plans.
--
-- Monitoring stays above the existing batch/worker safety layer. A plan only materializes
-- ordinary sampling batches; account pacing, rolling limits, cooldowns, verification
-- fail-closed behavior and retry rules remain enforced by the existing worker.

CREATE TABLE service_monitor_plans (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id             bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  project_id            bigint      NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name                  text        NOT NULL,
  cadence               text        NOT NULL,
  time_zone             text        NOT NULL DEFAULT 'Asia/Shanghai',
  local_hour            smallint    NOT NULL DEFAULT 9,
  local_minute          smallint    NOT NULL DEFAULT 0,
  weekday               smallint,
  sample_size           integer,
  sampling_method       text        NOT NULL DEFAULT 'stratified',
  repeats               integer     NOT NULL DEFAULT 1,
  account_ids           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  enabled               boolean     NOT NULL DEFAULT true,
  next_run_at           timestamptz NOT NULL,
  last_scheduled_for    timestamptz,
  last_executed_at      timestamptz,
  last_batch_id         bigint      REFERENCES sampling_batches (id) ON DELETE SET NULL,
  consecutive_failures  integer     NOT NULL DEFAULT 0,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_monitor_plans_name_key UNIQUE (tenant_id, project_id, name),
  CONSTRAINT service_monitor_plans_cadence_check CHECK (cadence IN ('daily', 'weekly')),
  CONSTRAINT service_monitor_plans_hour_check CHECK (local_hour BETWEEN 0 AND 23),
  CONSTRAINT service_monitor_plans_minute_check CHECK (local_minute BETWEEN 0 AND 59),
  CONSTRAINT service_monitor_plans_weekday_check CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),
  CONSTRAINT service_monitor_plans_weekly_requires_weekday CHECK (cadence <> 'weekly' OR weekday IS NOT NULL),
  CONSTRAINT service_monitor_plans_sample_size_check CHECK (sample_size IS NULL OR sample_size > 0),
  CONSTRAINT service_monitor_plans_method_check CHECK (sampling_method IN ('stratified', 'random')),
  CONSTRAINT service_monitor_plans_repeats_check CHECK (repeats BETWEEN 1 AND 100),
  CONSTRAINT service_monitor_plans_accounts_check CHECK (jsonb_typeof(account_ids) = 'array' AND jsonb_array_length(account_ids) > 0)
);
CREATE INDEX service_monitor_plans_due_idx
  ON service_monitor_plans (enabled, next_run_at, id)
  WHERE enabled = true;
CREATE INDEX service_monitor_plans_tenant_project_idx
  ON service_monitor_plans (tenant_id, project_id, id);

CREATE TABLE service_monitor_executions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id        bigint      NOT NULL REFERENCES service_monitor_plans (id) ON DELETE CASCADE,
  tenant_id      bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  project_id     bigint      NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  scheduled_for  timestamptz NOT NULL,
  status         text        NOT NULL DEFAULT 'pending',
  attempts       integer     NOT NULL DEFAULT 0,
  batch_id       bigint      REFERENCES sampling_batches (id) ON DELETE SET NULL,
  details        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  last_error     text,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_monitor_executions_occurrence_key UNIQUE (plan_id, scheduled_for),
  CONSTRAINT service_monitor_executions_status_check CHECK (status IN ('pending', 'processing', 'completed', 'skipped', 'failed'))
);
CREATE INDEX service_monitor_executions_pending_idx
  ON service_monitor_executions (status, created_at, id)
  WHERE status IN ('pending', 'processing');
CREATE INDEX service_monitor_executions_plan_idx
  ON service_monitor_executions (plan_id, scheduled_for DESC);

ALTER TABLE sampling_batches
  ADD COLUMN IF NOT EXISTS monitor_execution_id bigint REFERENCES service_monitor_executions (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sampling_batches_monitor_execution_key
  ON sampling_batches (monitor_execution_id)
  WHERE monitor_execution_id IS NOT NULL;

DO $$
DECLARE target_role text := 'onegl';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON service_monitor_plans, service_monitor_executions TO %I', target_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', target_role);
  END IF;
END
$$;
