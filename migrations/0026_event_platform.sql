-- OneGl — name the platform on the events that report collection results.
--
-- With more than one provider collectable, an execution event that only says "20 of 20 done"
-- cannot be routed: the receiver has to GET the execution to learn whether the numbers came
-- from Doubao or Qianwen, and the two are not comparable measurements. The account events
-- already carried provider because they fire from an accounts row; the execution and batch
-- events fire from sampling_batches, whose provider column is the batch's own truth.
--
-- login_states travels with it because the observation surface changes how a rate must be
-- read: a blended signed-out / signed-in execution is not one number about one user.

CREATE OR REPLACE FUNCTION onegl_saas_execution_event() RETURNS trigger AS $$
DECLARE
  v_tenant_id bigint;
  v_task_id text;
  v_execution_id text;
  v_report_id text;
  v_status text;
  v_type text;
  v_login_states text[];
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

  SELECT array_agg(DISTINCT r.login_state ORDER BY r.login_state)
    INTO v_login_states
    FROM runs r
   WHERE r.sampling_batch_id = NEW.id;

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
      'platform', NEW.provider,
      'status', v_status,
      'progress', jsonb_build_object(
        'total', NEW.requested_jobs,
        'completed', NEW.completed_jobs,
        'failed', NEW.failed_jobs,
        'skipped', NEW.skipped_jobs
      ),
      'login_states', COALESCE(v_login_states, '{}'::text[]),
      'finished_at', NEW.finished_at
    )
  )
  ON CONFLICT (event_key) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Same gap on the legacy lower-level channel: a batch event names a batch_id but never says
-- which platform was collected.
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
      'platform', NEW.provider,
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
