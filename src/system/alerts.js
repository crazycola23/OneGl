import crypto from "node:crypto";

export function alertEventId() {
  return `ops_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function reconcileAlertStates(pool, firingAlerts) {
  const now = new Date().toISOString();
  const current = new Map((firingAlerts ?? []).map((item) => [item.key, item]));
  const { rows: existing } = await pool.query("SELECT * FROM service_ops_alert_states ORDER BY alert_key");
  const byKey = new Map(existing.map((row) => [row.alert_key, row]));

  for (const item of current.values()) {
    const row = byKey.get(item.key);
    if (!row) {
      await pool.query(
        `INSERT INTO service_ops_alert_states
           (alert_key, severity, state, summary, details, first_fired_at, last_observed_at)
         VALUES ($1, $2, 'firing', $3, $4::jsonb, $5, $5)`,
        [item.key, item.severity, item.summary, JSON.stringify(item.details ?? {}), now],
      );
      continue;
    }

    if (row.state === "firing") {
      await pool.query(
        `UPDATE service_ops_alert_states
            SET severity = $2, summary = $3, details = $4::jsonb,
                last_observed_at = $5, updated_at = now()
          WHERE alert_key = $1`,
        [item.key, item.severity, item.summary, JSON.stringify(item.details ?? {}), now],
      );
      continue;
    }

    await pool.query(
      `UPDATE service_ops_alert_states
          SET severity = $2, state = 'firing', summary = $3, details = $4::jsonb,
              first_fired_at = $5, last_observed_at = $5, resolved_at = NULL,
              last_notification_error = NULL, updated_at = now()
        WHERE alert_key = $1`,
      [item.key, item.severity, item.summary, JSON.stringify(item.details ?? {}), now],
    );
  }

  for (const row of existing) {
    if (row.state !== "firing" || current.has(row.alert_key)) continue;
    await pool.query(
      `UPDATE service_ops_alert_states
          SET state = 'resolved', last_observed_at = $2, resolved_at = $2,
              details = details || jsonb_build_object('resolved_at', $2::text),
              last_notification_error = NULL, updated_at = now()
        WHERE alert_key = $1`,
      [row.alert_key, now],
    );
  }
}

export async function pendingAlertNotifications(pool, { repeatMinutes = 60 } = {}) {
  const { rows } = await pool.query(
    `SELECT *
       FROM service_ops_alert_states
      WHERE notified_state IS DISTINCT FROM state
         OR (
              state = 'firing'
          AND notified_state = 'firing'
          AND (last_notified_at IS NULL OR last_notified_at <= now() - ($1 * interval '1 minute'))
         )
      ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, alert_key`,
    [repeatMinutes],
  );
  return rows;
}

export function buildAlertNotification(row, { eventId = alertEventId(), occurredAt = new Date().toISOString() } = {}) {
  return {
    id: eventId,
    type: `ops.alert.${row.state}`,
    occurred_at: occurredAt,
    alert: {
      key: row.alert_key,
      severity: row.severity,
      state: row.state,
      summary: row.summary,
      details: row.details ?? {},
      first_fired_at: row.first_fired_at,
      resolved_at: row.resolved_at,
    },
  };
}

export async function markAlertNotificationSuccess(pool, alertKey, state) {
  await pool.query(
    `UPDATE service_ops_alert_states
        SET notified_state = $2, last_notified_at = now(), last_notification_error = NULL, updated_at = now()
      WHERE alert_key = $1 AND state = $2`,
    [alertKey, state],
  );
}

export async function markAlertNotificationFailure(pool, alertKey, message) {
  await pool.query(
    `UPDATE service_ops_alert_states
        SET last_notification_error = $2, updated_at = now()
      WHERE alert_key = $1`,
    [alertKey, String(message || "notification failed").slice(0, 4000)],
  );
}
