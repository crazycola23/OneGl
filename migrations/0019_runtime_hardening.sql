-- OneGl v0.8 runtime hardening.
-- Persist remote-auth screenshots/runtime ownership so API nodes can serve the same auth session
-- across horizontal routing, and allow cancellation to be observed by the browser-owning node.

ALTER TABLE service_auth_sessions
  ADD COLUMN runtime_owner text,
  ADD COLUMN runtime_heartbeat_at timestamptz,
  ADD COLUMN screenshot bytea,
  ADD COLUMN screenshot_at timestamptz,
  ADD COLUMN cancel_requested_at timestamptz;

CREATE INDEX service_auth_sessions_runtime_idx
  ON service_auth_sessions (status, runtime_heartbeat_at)
  WHERE completed_at IS NULL;

DO $$
DECLARE target_role text := 'onegl';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON service_auth_sessions TO %I', target_role);
  END IF;
END
$$;
