-- OneGl production SLO alerts.
--
-- This table contains operational aggregates only. Alert details must never contain prompts,
-- answers, credentials, cookies, storageState or request/response bodies.

CREATE TABLE service_ops_alert_states (
  alert_key                 text        PRIMARY KEY,
  severity                  text        NOT NULL,
  state                     text        NOT NULL,
  notified_state            text,
  summary                   text        NOT NULL,
  details                   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  first_fired_at            timestamptz,
  last_observed_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at               timestamptz,
  last_notified_at          timestamptz,
  last_notification_error   text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_ops_alert_severity_check CHECK (severity IN ('warning', 'critical')),
  CONSTRAINT service_ops_alert_state_check CHECK (state IN ('firing', 'resolved')),
  CONSTRAINT service_ops_alert_notified_state_check CHECK (notified_state IS NULL OR notified_state IN ('firing', 'resolved'))
);

CREATE INDEX service_ops_alert_state_idx ON service_ops_alert_states (state, severity, updated_at DESC);
CREATE INDEX service_ops_alert_notification_idx
  ON service_ops_alert_states (state, notified_state, last_notified_at);

DO $$
DECLARE target_role text := 'onegl';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON service_ops_alert_states TO %I', target_role);
  END IF;
END
$$;
