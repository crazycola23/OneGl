import "dotenv/config";

import { accountAvailability, AVAILABILITY } from "./accounts/safety.js";
import { createPool, isDatabaseConfigured } from "./db/pool.js";
import {
  claimMonitorExecution,
  finishMonitorExecution,
  loadMonitorExecutionContext,
  materializeDueMonitorExecutions,
} from "./monitoring/plans.js";
import { countActiveKeywords } from "./project/keywords.js";
import { enqueueBatch } from "./queue/batches.js";
import { createSamplingBatch } from "./sampling/batch.js";
import { ensureScheduledTaskExecutionForBatch } from "./tasks/service.js";

if (!isDatabaseConfigured()) throw new Error("DATABASE_URL is required for monitor:worker");

const pool = createPool();
const tickMs = Math.max(5_000, Number(process.env.ONEGL_MONITOR_TICK_MS) || 30_000);
const MANUAL_ACCOUNT_STATES = new Set([
  "login_required",
  "session_expired",
  "verification_required",
  "access_restricted",
  "disabled",
  "paused",
  "unknown",
]);
let stopping = false;
let ticking = false;

function occurrenceLabel(context) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: context.time_zone || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(context.scheduled_for));
}

async function emitEvent(context, eventType, payload) {
  const eventKey = `monitor:${context.id}:${eventType}`;
  await pool.query(
    `INSERT INTO service_webhook_events (tenant_id, event_key, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (event_key) DO NOTHING`,
    [context.tenant_id, eventKey, eventType, JSON.stringify({ event: eventType, monitor_plan_id: Number(context.plan_id), ...payload })],
  ).catch(() => undefined);
}

async function resolvedAccounts(context) {
  const externalIds = Array.isArray(context.account_ids) ? context.account_ids.map(String) : [];
  // 巡检计划目前没有平台维度（doubao_monitor_plans 也没有这一列），所以它解析到的账号
  // 只可能是豆包的。让某个计划跑别的平台需要一次带 platform 列的 migration，
  // 不是把这里的字面量改掉就行 —— 保持显式，别让它看起来像漏改。
  const { rows } = await pool.query(
    `SELECT external_id, account_key
       FROM service_account_bindings
      WHERE tenant_id = $1 AND provider = 'doubao' AND external_id = ANY($2::text[])`,
    [context.tenant_id, externalIds],
  );
  const byExternal = new Map(rows.map((row) => [row.external_id, row.account_key]));
  const missing = externalIds.filter((id) => !byExternal.has(id));
  if (missing.length) throw new Error(`monitor accounts are no longer registered: ${missing.join(", ")}`);

  const configured = [];
  const blocked = [];
  const delayed = [];
  for (const externalId of externalIds) {
    const accountKey = byExternal.get(externalId);
    const availability = await accountAvailability(pool, accountKey);
    const state = availability.state;
    configured.push({ externalId, accountKey });

    // A schedule must require an actual saved provider login, not merely a registered account row.
    // This also protects legacy/manual state mutations where accountAvailability alone could treat an
    // account with no cooldown as temporarily executable even though its provider status says login.
    if (!state?.storage_state_present || MANUAL_ACCOUNT_STATES.has(state?.status)) {
      blocked.push({
        account_id: externalId,
        reason: state?.storage_state_present ? `account status is ${state?.status ?? "unknown"}` : "provider login is required",
      });
    } else if (availability.kind === AVAILABILITY.PERMANENT) {
      blocked.push({ account_id: externalId, reason: availability.reason });
    } else if (availability.kind === AVAILABILITY.TEMPORARY) {
      delayed.push({ account_id: externalId, reason: availability.reason, retry_at: availability.retryAt });
    }
  }
  return { configured, blocked, delayed };
}

async function existingBatch(executionId) {
  const { rows } = await pool.query(
    "SELECT id, status FROM sampling_batches WHERE monitor_execution_id = $1",
    [executionId],
  );
  return rows[0] ? { id: Number(rows[0].id), status: rows[0].status } : null;
}

async function executeOccurrence(execution) {
  const context = await loadMonitorExecutionContext(pool, execution.id);
  if (!context) return;

  try {
    const accounts = await resolvedAccounts(context);

    // Fail closed on manual/account-level blocks. A monitoring schedule must never silently
    // route around verification, expired-login or access-restriction states by switching to
    // another configured account. Temporary cooldown/hour/day limits are different: the
    // ordinary batch worker will delay those accounts under the existing safety policy.
    if (accounts.blocked.length) {
      const reason = "one or more configured Doubao accounts require manual attention";
      await finishMonitorExecution(pool, execution, {
        status: "skipped",
        details: { blocked_accounts: accounts.blocked },
        error: reason,
      });
      await emitEvent(context, "monitor.action_required", { reason, blocked_accounts: accounts.blocked });
      return;
    }

    const keywordStats = await countActiveKeywords(pool, context.project_id);
    if (!keywordStats.enabled) throw new Error("project has no enabled keywords");
    const sampleSize = Math.min(Number(context.sample_size) || keywordStats.enabled, keywordStats.enabled);

    let batch = await existingBatch(context.id);
    if (!batch) {
      const created = await createSamplingBatch(pool, {
        projectName: context.project_name,
        name: `${context.plan_name} · ${occurrenceLabel(context)}`,
        size: sampleSize,
        method: context.sampling_method,
        seed: `monitor:${context.plan_id}:${new Date(context.scheduled_for).toISOString()}`,
        accounts: accounts.configured.map((row) => row.accountKey),
        repeats: Number(context.repeats) || 1,
        monitorExecutionId: Number(context.id),
      }, { log: () => undefined });
      batch = { id: created.batchId, status: "pending" };
    }

    const serviceExecution = await ensureScheduledTaskExecutionForBatch(pool, {
      monitorPlanId: Number(context.plan_id),
      batchId: batch.id,
    });
    let reportId = null;
    if (serviceExecution) {
      const { rows } = await pool.query("SELECT public_id FROM service_reports WHERE execution_id = $1", [serviceExecution.id]);
      reportId = rows[0]?.public_id ?? null;
    }

    const started = await enqueueBatch(pool, batch.id, { log: () => undefined });
    const details = {
      batch_id: batch.id,
      execution_id: serviceExecution?.public_id ?? null,
      report_id: reportId,
      started: started.started,
      start_reason: started.reason ?? null,
      sample_size: sampleSize,
      accounts: accounts.configured.map((row) => row.externalId),
      temporarily_delayed_accounts: accounts.delayed,
    };

    if (!started.started && !started.alreadyActive) {
      const reason = started.reason ?? "batch could not be enqueued";
      await finishMonitorExecution(pool, execution, { status: "failed", batchId: batch.id, details, error: reason });
      await emitEvent(context, "monitor.failed", { ...details, error: reason });
      return;
    }

    await finishMonitorExecution(pool, execution, { status: "completed", batchId: batch.id, details });
    await emitEvent(context, "monitor.batch_created", details);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishMonitorExecution(pool, execution, { status: "failed", error: message, details: { error: message } });
    await emitEvent(context, "monitor.failed", { error: message });
    console.error(`monitor execution #${execution.id} failed: ${message}`);
  }
}

async function tick() {
  if (ticking || stopping) return;
  ticking = true;
  try {
    const materialized = await materializeDueMonitorExecutions(pool, { limit: 20 });
    if (materialized.length) console.log(`monitor: materialized ${materialized.length} due occurrence(s)`);
    for (let index = 0; index < 20 && !stopping; index += 1) {
      const execution = await claimMonitorExecution(pool);
      if (!execution) break;
      await executeOccurrence(execution);
    }
  } catch (error) {
    console.error("monitor worker tick failed:", error);
  } finally {
    ticking = false;
  }
}

console.log(`OneGl Doubao monitor worker started; scheduler tick=${tickMs}ms`);
await tick();
const timer = setInterval(() => void tick(), tickMs);

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  console.log(`monitor worker received ${signal}; shutting down`);
  while (ticking) await new Promise((resolve) => setTimeout(resolve, 50));
  await pool.end().catch(() => undefined);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void shutdown(signal));
