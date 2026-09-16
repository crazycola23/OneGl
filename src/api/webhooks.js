import crypto from "node:crypto";

function eventMatches(events, eventType) {
  return Array.isArray(events) && (events.includes("*") || events.includes(eventType));
}

export function signWebhook(secret, timestamp, body) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export async function listWebhooks(pool, tenantId) {
  const { rows } = await pool.query(
    `SELECT id, url, events, enabled, created_at, updated_at
       FROM api_webhook_endpoints WHERE tenant_id=$1 ORDER BY id`,
    [tenantId],
  );
  return rows;
}

export async function createWebhook(pool, tenantId, { url, events = ["batch.completed","batch.failed","batch.partial","batch.aborted"] }) {
  const parsed = new URL(String(url));
  if (!new Set(["https:", "http:"]).has(parsed.protocol)) throw new Error("webhook URL must use http or https");
  const secret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
  const { rows } = await pool.query(
    `INSERT INTO api_webhook_endpoints(tenant_id,url,secret,events)
     VALUES($1,$2,$3,$4::jsonb)
     RETURNING id,url,events,enabled,created_at`,
    [tenantId, parsed.toString(), secret, JSON.stringify([...new Set(events.map(String))])],
  );
  return { ...rows[0], secret };
}

export async function deleteWebhook(pool, tenantId, id) {
  const { rowCount } = await pool.query("DELETE FROM api_webhook_endpoints WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  return rowCount > 0;
}

export async function queueWebhookEvent(pool, tenantId, eventType, payload, eventId) {
  const { rows: endpoints } = await pool.query(
    `SELECT * FROM api_webhook_endpoints WHERE tenant_id=$1 AND enabled=true`,
    [tenantId],
  );
  let queued = 0;
  for (const endpoint of endpoints) {
    if (!eventMatches(endpoint.events, eventType)) continue;
    const result = await pool.query(
      `INSERT INTO api_webhook_deliveries(endpoint_id,event_id,event_type,payload,next_attempt_at)
       VALUES($1,$2,$3,$4::jsonb,now()) ON CONFLICT(endpoint_id,event_id) DO NOTHING`,
      [endpoint.id, eventId, eventType, JSON.stringify(payload)],
    );
    queued += result.rowCount;
  }
  return queued;
}

export async function deliverPendingWebhooks(pool, { limit = 20, fetchImpl = fetch } = {}) {
  const { rows } = await pool.query(
    `SELECT d.*, e.url, e.secret
       FROM api_webhook_deliveries d JOIN api_webhook_endpoints e ON e.id=d.endpoint_id
      WHERE e.enabled=true AND d.status IN ('pending','failed')
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= now())
      ORDER BY d.created_at LIMIT $1`,
    [limit],
  );
  const results = [];
  for (const row of rows) {
    await pool.query("UPDATE api_webhook_deliveries SET status='delivering', attempts=attempts+1 WHERE id=$1", [row.id]);
    const body = JSON.stringify({ id: row.event_id, type: row.event_type, created_at: new Date().toISOString(), data: row.payload });
    const timestamp = Math.floor(Date.now()/1000).toString();
    try {
      const response = await fetchImpl(row.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "OneGl-Webhook/1.0",
          "x-onegl-event": row.event_type,
          "x-onegl-delivery": row.event_id,
          "x-onegl-timestamp": timestamp,
          "x-onegl-signature": `v1=${signWebhook(row.secret, timestamp, body)}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await pool.query("UPDATE api_webhook_deliveries SET status='delivered', last_status=$2, delivered_at=now(), last_error=NULL WHERE id=$1", [row.id, response.status]);
      results.push({ id: row.id, delivered: true, status: response.status });
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const delayMinutes = Math.min(60, 2 ** Math.min(attempts, 5));
      await pool.query(
        `UPDATE api_webhook_deliveries SET status='failed', last_error=$2, next_attempt_at=now()+($3 || ' minutes')::interval WHERE id=$1`,
        [row.id, error instanceof Error ? error.message : String(error), String(delayMinutes)],
      );
      results.push({ id: row.id, delivered: false });
    }
  }
  return results;
}
