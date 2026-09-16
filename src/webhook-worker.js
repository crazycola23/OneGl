import "dotenv/config";
import crypto from "node:crypto";

import { createPool, isDatabaseConfigured } from "./db/pool.js";
import { webhookSecretFor } from "./api/service-store.js";

if (!isDatabaseConfigured()) {
  console.error("DATABASE_URL 未配置，Webhook Worker 无法启动。");
  process.exit(1);
}

const pool = createPool();
const pollMs = intEnv("ONEGL_WEBHOOK_POLL_MS", 2000, 250);
const timeoutMs = intEnv("ONEGL_WEBHOOK_TIMEOUT_MS", 10000, 1000);
const maxAttempts = intEnv("ONEGL_WEBHOOK_MAX_ATTEMPTS", 5, 1);
let shuttingDown = false;

function intEnv(name, fallback, min) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= min ? value : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function publicEventId(event) {
  const digest = crypto.createHash("sha256").update(String(event.event_key)).digest("hex").slice(0, 32);
  return `evt_${digest}`;
}

async function claimEvent() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `WITH candidate AS (
         SELECT id
           FROM service_webhook_events
          WHERE status IN ('queued', 'delivering')
            AND next_attempt_at <= now()
            AND attempts < $1
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE service_webhook_events e
          SET status = 'delivering', attempts = attempts + 1
         FROM candidate c
        WHERE e.id = c.id
       RETURNING e.*`,
      [maxAttempts],
    );
    await client.query("COMMIT");
    return rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function matchingEndpoints(event) {
  return (await pool.query(
    `SELECT id, tenant_id, url, event_types
       FROM service_webhook_endpoints
      WHERE tenant_id = $1 AND enabled
        AND (event_types ? '*' OR event_types ? $2)
      ORDER BY id`,
    [event.tenant_id, event.event_type],
  )).rows;
}

async function alreadyDelivered(eventId, endpointId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM service_webhook_deliveries
      WHERE event_id = $1 AND endpoint_id = $2 AND status = 'success'
      LIMIT 1`,
    [eventId, endpointId],
  );
  return Boolean(rows[0]);
}

function signedHeaders(event, endpoint, rawBody, eventId) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const secret = webhookSecretFor(endpoint.tenant_id, endpoint.id);
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "user-agent": "OneGl-Webhook/1.0",
    "x-onegl-event": event.event_type,
    "x-onegl-event-id": eventId,
    "x-onegl-webhook-version": "1",
    "x-onegl-timestamp": timestamp,
    "x-onegl-signature": `v1=${signature}`,
  };
}

async function deliver(event, endpoint) {
  if (await alreadyDelivered(event.id, endpoint.id)) return { ok: true, skipped: true };

  const eventId = publicEventId(event);
  const body = JSON.stringify({
    id: eventId,
    type: event.event_type,
    occurred_at: event.created_at,
    // Kept for compatibility with the original webhook envelope.
    created_at: event.created_at,
    data: event.payload,
  });
  let responseCode = null;
  let responseBody = null;
  let errorMessage = null;
  let ok = false;
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: signedHeaders(event, endpoint, body, eventId),
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    responseCode = response.status;
    responseBody = (await response.text()).slice(0, 2000);
    ok = response.ok;
    if (!ok) errorMessage = `HTTP ${response.status}`;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  await pool.query(
    `INSERT INTO service_webhook_deliveries
       (event_id, endpoint_id, attempt, status, response_code, response_body, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [event.id, endpoint.id, event.attempts, ok ? "success" : "failed", responseCode, responseBody, errorMessage],
  );
  return { ok, error: errorMessage };
}

function backoffSeconds(attempt) {
  return [60, 300, 1800, 7200, 21600][Math.max(0, Math.min(4, attempt - 1))];
}

async function processEvent(event) {
  const endpoints = await matchingEndpoints(event);
  const results = [];
  for (const endpoint of endpoints) results.push(await deliver(event, endpoint));

  const failures = results.filter((item) => !item.ok);
  if (!failures.length) {
    await pool.query(
      `UPDATE service_webhook_events
          SET status = 'delivered', delivered_at = now(), last_error = NULL
        WHERE id = $1`,
      [event.id],
    );
    console.log(`[webhook] delivered event=${publicEventId(event)} type=${event.event_type} endpoints=${endpoints.length}`);
    return;
  }

  const message = failures.map((item) => item.error).filter(Boolean).join("; ").slice(0, 4000);
  if (event.attempts >= maxAttempts) {
    await pool.query(
      `UPDATE service_webhook_events SET status = 'failed', last_error = $2 WHERE id = $1`,
      [event.id, message || "delivery failed"],
    );
    console.error(`[webhook] failed event=${publicEventId(event)} type=${event.event_type} attempts=${event.attempts}`);
    return;
  }

  const seconds = backoffSeconds(event.attempts);
  await pool.query(
    `UPDATE service_webhook_events
        SET status = 'queued', next_attempt_at = now() + ($2 * interval '1 second'), last_error = $3
      WHERE id = $1`,
    [event.id, seconds, message || "delivery failed"],
  );
  console.warn(`[webhook] retry event=${publicEventId(event)} in=${seconds}s`);
}

async function loop() {
  console.log("OneGl Webhook Worker started.");
  while (!shuttingDown) {
    try {
      const event = await claimEvent();
      if (!event) {
        await sleep(pollMs);
        continue;
      }
      await processEvent(event);
    } catch (error) {
      console.error(`[webhook] ${error instanceof Error ? error.message : String(error)}`);
      await sleep(pollMs);
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`OneGl Webhook Worker received ${signal}; shutting down.`);
  await pool.end().catch(() => undefined);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => shutdown(signal));
await loop();