-- OneGl v0.6 — stable SaaS-facing task resources.
--
-- These tables are an API facade over the existing project/batch/run/monitor execution engine.
-- Public IDs are generated in the application and are intentionally decoupled from PostgreSQL
-- identity values so the SaaS can persist them without depending on OneGl's internal schema.

CREATE TABLE service_tasks (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id        text        NOT NULL UNIQUE,
  tenant_id        bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  project_id       bigint      NOT NULL UNIQUE REFERENCES projects (id) ON DELETE CASCADE,
  external_id      text,
  name             text        NOT NULL,
  target_brand     text,
  platforms        jsonb       NOT NULL DEFAULT '["doubao"]'::jsonb,
  account_ids      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  sampling_method  text        NOT NULL DEFAULT 'stratified',
  repeats          integer     NOT NULL DEFAULT 1,
  revision         integer     NOT NULL DEFAULT 1,
  state            text        NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_tasks_state_check CHECK (state IN ('active', 'archived')),
  CONSTRAINT service_tasks_method_check CHECK (sampling_method IN ('stratified', 'random')),
  CONSTRAINT service_tasks_repeats_check CHECK (repeats BETWEEN 1 AND 100),
  CONSTRAINT service_tasks_platforms_check CHECK (jsonb_typeof(platforms) = 'array' AND jsonb_array_length(platforms) > 0),
  CONSTRAINT service_tasks_accounts_check CHECK (jsonb_typeof(account_ids) = 'array')
);
CREATE UNIQUE INDEX service_tasks_tenant_external_key
  ON service_tasks (tenant_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX service_tasks_tenant_created_idx ON service_tasks (tenant_id, created_at DESC);

CREATE TABLE service_task_executions (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id            text        NOT NULL UNIQUE,
  tenant_id            bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  task_id              bigint      NOT NULL REFERENCES service_tasks (id) ON DELETE CASCADE,
  batch_id             bigint      UNIQUE REFERENCES sampling_batches (id) ON DELETE SET NULL,
  trigger_type         text        NOT NULL DEFAULT 'manual',
  parent_execution_id  bigint      REFERENCES service_task_executions (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_task_executions_trigger_check CHECK (trigger_type IN ('manual', 'rerun', 'schedule'))
);
CREATE INDEX service_task_executions_task_idx ON service_task_executions (task_id, created_at DESC);
CREATE INDEX service_task_executions_tenant_idx ON service_task_executions (tenant_id, created_at DESC);

CREATE TABLE service_task_results (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id        text        NOT NULL UNIQUE,
  tenant_id        bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  execution_id     bigint      NOT NULL REFERENCES service_task_executions (id) ON DELETE CASCADE,
  batch_id         bigint      NOT NULL REFERENCES sampling_batches (id) ON DELETE CASCADE,
  selection_index  integer     NOT NULL,
  prompt_id        bigint      REFERENCES prompts (id) ON DELETE SET NULL,
  question         text        NOT NULL,
  platform         text        NOT NULL DEFAULT 'doubao',
  run_id           text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_task_results_execution_selection_key UNIQUE (execution_id, selection_index)
);
CREATE INDEX service_task_results_execution_idx ON service_task_results (execution_id, selection_index);
CREATE INDEX service_task_results_tenant_idx ON service_task_results (tenant_id, created_at DESC);

CREATE TABLE service_reports (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id     text        NOT NULL UNIQUE,
  tenant_id     bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  execution_id  bigint      NOT NULL UNIQUE REFERENCES service_task_executions (id) ON DELETE CASCADE,
  batch_id      bigint      NOT NULL UNIQUE REFERENCES sampling_batches (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_reports_tenant_idx ON service_reports (tenant_id, created_at DESC);

CREATE TABLE service_task_schedules (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id        text        NOT NULL UNIQUE,
  tenant_id        bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  task_id          bigint      NOT NULL REFERENCES service_tasks (id) ON DELETE CASCADE,
  monitor_plan_id  bigint      NOT NULL UNIQUE REFERENCES service_monitor_plans (id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_task_schedules_task_idx ON service_task_schedules (task_id, created_at DESC);

ALTER TABLE sampling_batches DROP CONSTRAINT IF EXISTS sampling_batches_status_check;
ALTER TABLE sampling_batches ADD CONSTRAINT sampling_batches_status_check
  CHECK (status IN ('pending', 'queued', 'running', 'paused', 'completed', 'partial', 'failed', 'aborted'));

-- Platform connections are login-bound. Registering an account should never make it executable
-- before a real login/storage state has been saved by the auth flow.
ALTER TABLE accounts ALTER COLUMN status SET DEFAULT 'login_required';
UPDATE accounts
   SET status = 'login_required', updated_at = now()
 WHERE provider = 'doubao'
   AND storage_state_present = false
   AND status = 'unknown';

DO $$
DECLARE target_role text := 'onegl';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON service_tasks, service_task_executions, service_task_results, service_reports, service_task_schedules TO %I', target_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', target_role);
  END IF;
END
$$;
