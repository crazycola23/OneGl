import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";
import {
  buildAlertNotification,
  markAlertNotificationSuccess,
  pendingAlertNotifications,
  reconcileAlertStates,
} from "../src/system/alerts.js";

const DATABASE_URL = process.env.DATABASE_URL;

test("ops alert state persists firing, resolved and re-firing transitions", async (t) => {
  if (!DATABASE_URL) return t.skip("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const key = `test_alert_${process.pid}_${Date.now()}`;
  try {
    const alert = {
      key,
      severity: "critical",
      summary: "Synthetic SLO alert",
      details: { count: 3 },
    };

    await reconcileAlertStates(pool, [alert]);
    let row = (await pool.query("SELECT * FROM service_ops_alert_states WHERE alert_key = $1", [key])).rows[0];
    assert.equal(row.state, "firing");
    assert.equal(row.notified_state, null);
    assert.equal(row.details.count, 3);

    let pending = await pendingAlertNotifications(pool, { repeatMinutes: 60 });
    assert.ok(pending.some((item) => item.alert_key === key && item.state === "firing"));
    const event = buildAlertNotification(pending.find((item) => item.alert_key === key), {
      eventId: "ops_testevent",
      occurredAt: "2026-09-16T00:00:00.000Z",
    });
    assert.equal(event.type, "ops.alert.firing");
    assert.equal(event.alert.details.count, 3);

    await markAlertNotificationSuccess(pool, key, "firing");
    pending = await pendingAlertNotifications(pool, { repeatMinutes: 60 });
    assert.equal(pending.some((item) => item.alert_key === key), false);

    await reconcileAlertStates(pool, []);
    row = (await pool.query("SELECT * FROM service_ops_alert_states WHERE alert_key = $1", [key])).rows[0];
    assert.equal(row.state, "resolved");
    assert.equal(row.notified_state, "firing");
    pending = await pendingAlertNotifications(pool, { repeatMinutes: 60 });
    assert.ok(pending.some((item) => item.alert_key === key && item.state === "resolved"));

    await markAlertNotificationSuccess(pool, key, "resolved");
    await reconcileAlertStates(pool, [{ ...alert, severity: "warning", details: { count: 1 } }]);
    row = (await pool.query("SELECT * FROM service_ops_alert_states WHERE alert_key = $1", [key])).rows[0];
    assert.equal(row.state, "firing");
    assert.equal(row.notified_state, "resolved");
    assert.equal(row.severity, "warning");
    assert.equal(row.details.count, 1);
  } finally {
    await pool.query("DELETE FROM service_ops_alert_states WHERE alert_key = $1", [key]).catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
});
