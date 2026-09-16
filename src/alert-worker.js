import "dotenv/config";
import crypto from "node:crypto";

import { createPool, isDatabaseConfigured } from "./db/pool.js";
import { closeRedis } from "./queue/connection.js";
import { safeOutboundRequest } from "./security/outbound-url.js";
import {
  buildAlertNotification,
  markAlertNotificationFailure,
  markAlertNotificationSuccess,
  pendingAlertNotifications,
  reconcileAlertStates,
} from "./system/alerts.js";
import { collectSloSnapshot, evaluateSloSnapshot, sloConfig } from "./system/slo.js";

if (!isDatabaseConfigured()) {
  console.error("DATABASE_URL is not configured; Alert Worker cannot start.");
  process.exit(1);
}

const pool = createPool();
const pollMs = intEnv("ONEGL_ALERT_POLL_MS", 60_000, 5_000);
const repeatMinutes = intEnv("ONEGL_ALERT_REPEAT_MINUTES", 60, 5);
const timeoutMs = intEnv("ONEGL_ALERT_TIMEOUT_MS", 10_000, 1_000);
const webhookUrl = String(process.env.ONEGL_ALERT_WEBHOOK_URL ?? "").trim();
const signingKey = String(process.env.ONEGL_ALERT_SIGNING_KEY ?? "").trim();
let shuttingDown = false;

function intEnv(name, fallback, min) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= min ? value : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function signedHeaders(rawBody, event) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(rawBody)),
    "user-agent": "OneGl-Alert/1.0",
    "x-onegl-alert-event": event.type,
    "x-onegl-alert-event-id": event.id,
    "x-onegl-timestamp": timestamp,
  };
  if (signingKey) {
    const signature = crypto
      .createHmac("sha256", signingKey)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    headers["x-onegl-signature"] = `v1=${signature}`;
  }
  return headers;
}

async function deliverAlert(row) {
  if (!webhookUrl) throw new Error("ONEGL_ALERT_WEBHOOK_URL is not configured");
  const event = buildAlertNotification(row);
  const rawBody = JSON.stringify(event);
  const response = await safeOutboundRequest(webhookUrl, {
    method: "POST",
    headers: signedHeaders(rawBody, event),
    body: rawBody,
    timeoutMs,
    maxResponseBytes: 2_000,
    allowHttp: false,
  });
  if (!response.ok) throw new Error(`alert webhook returned HTTP ${response.status}`);
  return event;
}

async function tick() {
  const config = sloConfig();
  const snapshot = await collectSloSnapshot(pool, config);
  const firing = evaluateSloSnapshot(snapshot, config);
  await reconcileAlertStates(pool, firing);

  const pending = await pendingAlertNotifications(pool, { repeatMinutes });
  for (const row of pending) {
    try {
      const event = await deliverAlert(row);
      await markAlertNotificationSuccess(pool, row.alert_key, row.state);
      console.log(`[alert] delivered id=${event.id} state=${row.state} severity=${row.severity} key=${row.alert_key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markAlertNotificationFailure(pool, row.alert_key, message);
      console.error(`[alert] delivery failed state=${row.state} severity=${row.severity} key=${row.alert_key}: ${message}`);
    }
  }

  const critical = firing.filter((item) => item.severity === "critical").length;
  const warning = firing.length - critical;
  console.log(`[alert] evaluated window=${config.windowMinutes}m firing=${firing.length} critical=${critical} warning=${warning}`);
}

async function loop() {
  console.log("OneGl Alert Worker started.");
  while (!shuttingDown) {
    try {
      await tick();
    } catch (error) {
      console.error(`[alert] ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!shuttingDown) await sleep(pollMs);
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`OneGl Alert Worker received ${signal}; shutting down.`);
  await pool.end().catch(() => undefined);
  await closeRedis().catch(() => undefined);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => shutdown(signal));
await loop();
