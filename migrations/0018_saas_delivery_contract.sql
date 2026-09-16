-- OneGl v0.7 — production SaaS delivery contract.
-- Adds durable idempotency records and SaaS-facing webhook events keyed by stable public IDs.

CREATE TABLE service_idempotency_keys (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  operation        text        NOT NULL,
  idempotency_key  text        NOT NULL,
  request_hash     text        NOT NULL,
  resource_type    text,
  resource_id      text,
  response_status  integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT service_idempotency_keys_unique UNIQUE (tenant_id, operation, idempotency_key),
  CONSTRAINT service_idempotency_key_length CHECK (length(idempotency_key) BETWEEN 1 AND 200)
);
CREATE INDEX service_idempotency_keys_tenant_created_idx
  ON service_idempotency_keys (tenant_id, created_at DESC);

-- SaaS-facing terminal execution events. Existing batch.* events remain for lower-level integrations.
CREATE OR REPLACE FUNCTION onegl_saas_execution_event() RETURNS trigger AS $$
DECLARE
  v_tenant_id bigint;
  v_task_id text;
  v_execution_id text;
  v_report_id text;
  v_status text;
  v_type text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('completed', 'partial', 'failed', 'aborted') THEN
    RETURN NEW;
  END IF;

  SELECT e.tenant_id, t.public_id, e.public_id, rp.public_id
    INTO v_tenant_id, v_task_id, v_execution_id, v_report_id
    FROM service_task_executions e
    JOIN service_tasks t ON t.id = e.task_id
    LEFT JOIN service_reports rp ON rp.execution_id = e.id
   WHERE e.batch_id = NEW.id;

  IF v_tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_status := CASE WHEN NEW.status = 'aborted' THEN 'cancelled' ELSE NEW.status END;
  v_type := 'execution.' || v_status;

  INSERT INTO service_webhook_events (tenant_id, event_key, event_type, payload)
  VALUES (
    v_tenant_id,
    'execution:' || v_execution_id || ':' || v_status,
    v_type,
    jsonb_build_object(
      'task_id', v_task_id,
      'execution_id', v_execution_id,
      'report_id', v_report_id,
      'status', v_status,
      'progress', jsonb_build_object(
        'total', NEW.requested_jobs,
        'completed', NEW.completed_jobs,
        'failed', NEW.failed_jobs,
        'skipped', NEW.skipped_jobs
      ),
      'finished_at', NEW.finished_at
    )
  )
  ON CONFLICT (event_key) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_onegl_saas_execution_event ON sampling_batches;
CREATE TRIGGER trg_onegl_saas_execution_event
AFTER UPDATE OF status ON sampling_batches
FOR EACH ROW EXECUTE FUNCTION onegl_saas_execution_event();

-- Emit account.ready when a previously blocked account becomes executable again.
CREATE OR REPLACE FUNCTION onegl_saas_account_ready_event() RETURNS trigger AS $$
DECLARE
  v_tenant_id bigint;
  v_external_id text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'healthy' OR NEW.storage_state_present IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT sab.tenant_id, sab.external_id INTO v_tenant_id, v_external_id
    FROM service_account_bindings sab
   WHERE sab.provider = NEW.provider AND sab.account_key = NEW.account_key;
  IF v_tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO service_webhook_events (tenant_id, event_key, event_type, payload)
  VALUES (
    v_tenant_id,
    'account-ready:' || NEW.provider || ':' || NEW.account_key || ':' || NEW.updated_at::text,
    'account.ready',
    jsonb_build_object(
      'provider', NEW.provider,
      'account_id', v_external_id,
      'status', 'ready'
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_onegl_saas_account_ready_event ON accounts;
CREATE TRIGGER trg_onegl_saas_account_ready_event
AFTER UPDATE OF status ON accounts
FOR EACH ROW EXECUTE FUNCTION onegl_saas_account_ready_event();

DO $$
DECLARE target_role text := 'onegl';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON service_idempotency_keys TO %I', target_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', target_role);
  END IF;
END
$$;
