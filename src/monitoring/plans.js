const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_LOCAL_TIME = "09:00";
const CADENCES = new Set(["daily", "weekly"]);
const METHODS = new Set(["stratified", "random"]);

export class MonitorPlanValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MonitorPlanValidationError";
  }
}

function int(value, name, { min, max, nullable = false } = {}) {
  if (nullable && (value == null || value === "")) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || (min != null && parsed < min) || (max != null && parsed > max)) {
    const range = min != null || max != null ? ` between ${min ?? "-∞"} and ${max ?? "∞"}` : "";
    throw new MonitorPlanValidationError(`${name} must be an integer${range}`);
  }
  return parsed;
}

export function validateMonitorTimeZone(value) {
  const timeZone = String(value ?? DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new MonitorPlanValidationError("time_zone must be a valid IANA time zone such as Asia/Shanghai");
  }
  return timeZone;
}

export function parseMonitorLocalTime(value) {
  const raw = String(value ?? DEFAULT_LOCAL_TIME).trim();
  const match = /^(\d{2}):(\d{2})$/.exec(raw);
  if (!match) throw new MonitorPlanValidationError("local_time must use HH:MM in 24-hour time");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new MonitorPlanValidationError("local_time must use HH:MM in 24-hour time");
  return { hour, minute, text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function zonedParts(date, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function localDateTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = new Date(wallClockUtc);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const next = new Date(wallClockUtc - timeZoneOffsetMs(candidate, timeZone));
    if (Math.abs(next.getTime() - candidate.getTime()) < 1000) return next;
    candidate = next;
  }
  return candidate;
}

function addLocalDays(dateParts, days) {
  const shifted = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function isoWeekday(dateParts) {
  const value = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)).getUTCDay();
  return value === 0 ? 7 : value;
}

/** Return the first configured wall-clock occurrence after `now`. */
export function nextScheduledAt(schedule, now = new Date()) {
  const timeZone = validateMonitorTimeZone(schedule.timeZone ?? schedule.time_zone);
  const cadence = String(schedule.cadence ?? "daily").trim().toLowerCase();
  if (!CADENCES.has(cadence)) throw new MonitorPlanValidationError("cadence must be daily or weekly");
  const hour = int(schedule.localHour ?? schedule.local_hour ?? 9, "local_hour", { min: 0, max: 23 });
  const minute = int(schedule.localMinute ?? schedule.local_minute ?? 0, "local_minute", { min: 0, max: 59 });
  const parts = zonedParts(now, timeZone);
  const localDate = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };

  if (cadence === "daily") {
    let candidate = localDateTimeToUtc({ ...localDate, hour, minute }, timeZone);
    if (candidate <= now) {
      candidate = localDateTimeToUtc({ ...addLocalDays(localDate, 1), hour, minute }, timeZone);
    }
    return candidate;
  }

  const weekday = int(schedule.weekday, "weekday", { min: 1, max: 7 });
  const currentWeekday = isoWeekday(localDate);
  let daysAhead = (weekday - currentWeekday + 7) % 7;
  let candidate = localDateTimeToUtc({ ...addLocalDays(localDate, daysAhead), hour, minute }, timeZone);
  if (candidate <= now) {
    daysAhead += 7;
    candidate = localDateTimeToUtc({ ...addLocalDays(localDate, daysAhead), hour, minute }, timeZone);
  }
  return candidate;
}

export function normalizeMonitorPlanInput(input = {}, current = null) {
  const name = String(input.name ?? current?.name ?? "").trim();
  if (!name) throw new MonitorPlanValidationError("name is required");

  const cadence = String(input.cadence ?? current?.cadence ?? "daily").trim().toLowerCase();
  if (!CADENCES.has(cadence)) throw new MonitorPlanValidationError("cadence must be daily or weekly");
  const timeZone = validateMonitorTimeZone(input.time_zone ?? current?.time_zone ?? DEFAULT_TIME_ZONE);
  const local = input.local_time != null
    ? parseMonitorLocalTime(input.local_time)
    : {
        hour: Number(current?.local_hour ?? 9),
        minute: Number(current?.local_minute ?? 0),
        text: `${String(current?.local_hour ?? 9).padStart(2, "0")}:${String(current?.local_minute ?? 0).padStart(2, "0")}`,
      };
  const weekdayRaw = input.weekday !== undefined ? input.weekday : current?.weekday;
  const weekday = cadence === "weekly" ? int(weekdayRaw ?? 1, "weekday", { min: 1, max: 7 }) : null;
  const sampleSize = input.size !== undefined
    ? int(input.size, "size", { min: 1, max: 10000, nullable: true })
    : current?.sample_size == null ? null : Number(current.sample_size);
  const method = String(input.method ?? current?.sampling_method ?? "stratified").trim().toLowerCase();
  if (!METHODS.has(method)) throw new MonitorPlanValidationError("method must be stratified or random");
  const repeats = int(input.repeats ?? current?.repeats ?? 1, "repeats", { min: 1, max: 100 });
  const sourceAccounts = input.accounts ?? current?.account_ids;
  if (!Array.isArray(sourceAccounts)) throw new MonitorPlanValidationError("accounts must be an array");
  const accounts = [...new Set(sourceAccounts.map((value) => String(value).trim()).filter(Boolean))];
  if (!accounts.length || accounts.length > 100) {
    throw new MonitorPlanValidationError("accounts must contain between 1 and 100 account IDs");
  }
  const enabled = input.enabled === undefined ? current?.enabled !== false : input.enabled === true;

  return {
    name,
    cadence,
    timeZone,
    localHour: local.hour,
    localMinute: local.minute,
    localTime: local.text,
    weekday,
    sampleSize,
    method,
    repeats,
    accounts,
    enabled,
  };
}

function planRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    tenant_id: Number(row.tenant_id),
    project_id: Number(row.project_id),
    last_batch_id: row.last_batch_id == null ? null : Number(row.last_batch_id),
    local_time: `${String(row.local_hour).padStart(2, "0")}:${String(row.local_minute).padStart(2, "0")}`,
    accounts: Array.isArray(row.account_ids) ? row.account_ids : [],
    account_ids: undefined,
  };
}

export async function listMonitorPlans(pool, tenantId, projectId = null) {
  const { rows } = await pool.query(
    `SELECT * FROM service_monitor_plans
      WHERE tenant_id = $1 AND ($2::bigint IS NULL OR project_id = $2)
      ORDER BY project_id, id`,
    [tenantId, projectId],
  );
  return rows.map(planRow);
}

export async function getMonitorPlan(pool, tenantId, planId) {
  const { rows } = await pool.query(
    "SELECT * FROM service_monitor_plans WHERE tenant_id = $1 AND id = $2",
    [tenantId, planId],
  );
  return planRow(rows[0]);
}

export async function createMonitorPlan(pool, { tenantId, projectId, input, now = new Date() }) {
  const normalized = normalizeMonitorPlanInput(input);
  const nextRunAt = nextScheduledAt(normalized, now);
  const { rows } = await pool.query(
    `INSERT INTO service_monitor_plans
       (tenant_id, project_id, name, cadence, time_zone, local_hour, local_minute, weekday,
        sample_size, sampling_method, repeats, account_ids, enabled, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
     RETURNING *`,
    [tenantId, projectId, normalized.name, normalized.cadence, normalized.timeZone,
      normalized.localHour, normalized.localMinute, normalized.weekday, normalized.sampleSize,
      normalized.method, normalized.repeats, JSON.stringify(normalized.accounts), normalized.enabled,
      nextRunAt.toISOString()],
  );
  return planRow(rows[0]);
}

export async function updateMonitorPlan(pool, { tenantId, planId, input, now = new Date() }) {
  const current = await getMonitorPlan(pool, tenantId, planId);
  if (!current) return null;
  const normalized = normalizeMonitorPlanInput(input, {
    ...current,
    account_ids: current.accounts,
  });
  const scheduleTouched = ["cadence", "time_zone", "local_time", "weekday", "enabled"].some((key) => Object.hasOwn(input, key));
  const nextRunAt = scheduleTouched ? nextScheduledAt(normalized, now) : new Date(current.next_run_at);
  const { rows } = await pool.query(
    `UPDATE service_monitor_plans
        SET name = $3, cadence = $4, time_zone = $5, local_hour = $6, local_minute = $7,
            weekday = $8, sample_size = $9, sampling_method = $10, repeats = $11,
            account_ids = $12::jsonb, enabled = $13, next_run_at = $14, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *`,
    [tenantId, planId, normalized.name, normalized.cadence, normalized.timeZone,
      normalized.localHour, normalized.localMinute, normalized.weekday, normalized.sampleSize,
      normalized.method, normalized.repeats, JSON.stringify(normalized.accounts), normalized.enabled,
      nextRunAt.toISOString()],
  );
  return planRow(rows[0]);
}

export async function deleteMonitorPlan(pool, tenantId, planId) {
  const result = await pool.query("DELETE FROM service_monitor_plans WHERE tenant_id = $1 AND id = $2", [tenantId, planId]);
  return result.rowCount > 0;
}

export async function listMonitorExecutions(pool, tenantId, planId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT e.id, e.plan_id, e.project_id, e.scheduled_for, e.status, e.attempts, e.batch_id,
            e.details, e.last_error, e.started_at, e.finished_at, e.created_at, e.updated_at
       FROM service_monitor_executions e
       JOIN service_monitor_plans p ON p.id = e.plan_id
      WHERE e.tenant_id = $1 AND e.plan_id = $2 AND p.tenant_id = $1
      ORDER BY e.scheduled_for DESC, e.id DESC
      LIMIT $3`,
    [tenantId, planId, limit],
  );
  return rows.map((row) => ({
    ...row,
    id: Number(row.id), plan_id: Number(row.plan_id), project_id: Number(row.project_id),
    batch_id: row.batch_id == null ? null : Number(row.batch_id),
  }));
}

/**
 * Atomically turns due schedules into durable execution rows and advances each schedule.
 *
 * Downtime is intentionally not backfilled. If a daily plan was offline for five days,
 * OneGl creates one overdue occurrence when it comes back and moves `next_run_at` to the
 * next future wall-clock slot. Running five historical batches today would not reconstruct
 * historical Doubao answers; it would only create a burst and corrupt the trend semantics.
 */
export async function materializeDueMonitorExecutions(pool, { now = new Date(), limit = 20 } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM service_monitor_plans
        WHERE enabled = true AND next_run_at <= $1
        ORDER BY next_run_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), limit],
    );
    const created = [];
    for (const plan of rows) {
      const scheduledFor = new Date(plan.next_run_at);
      const nextRunAt = nextScheduledAt(plan, now);
      const inserted = await client.query(
        `INSERT INTO service_monitor_executions (plan_id, tenant_id, project_id, scheduled_for)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (plan_id, scheduled_for) DO NOTHING
         RETURNING *`,
        [plan.id, plan.tenant_id, plan.project_id, scheduledFor.toISOString()],
      );
      await client.query(
        `UPDATE service_monitor_plans
            SET next_run_at = $2, last_scheduled_for = $3, updated_at = now()
          WHERE id = $1`,
        [plan.id, nextRunAt.toISOString(), scheduledFor.toISOString()],
      );
      if (inserted.rows[0]) created.push(inserted.rows[0]);
    }
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Claims one pending execution. A stale processing claim is recoverable after five minutes. */
export async function claimMonitorExecution(pool) {
  const { rows } = await pool.query(
    `WITH candidate AS (
       SELECT id
         FROM service_monitor_executions
        WHERE status = 'pending'
           OR (status = 'processing' AND updated_at < now() - interval '5 minutes')
        ORDER BY scheduled_for, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE service_monitor_executions e
        SET status = 'processing', attempts = attempts + 1,
            started_at = COALESCE(started_at, now()), updated_at = now()
       FROM candidate c
      WHERE e.id = c.id
      RETURNING e.*`,
  );
  return rows[0] ?? null;
}

export async function loadMonitorExecutionContext(pool, executionId) {
  const { rows } = await pool.query(
    `SELECT e.*, p.name AS plan_name, p.cadence, p.time_zone, p.local_hour, p.local_minute,
            p.weekday, p.sample_size, p.sampling_method, p.repeats, p.account_ids,
            pr.name AS project_name, pr.target_brand
       FROM service_monitor_executions e
       JOIN service_monitor_plans p ON p.id = e.plan_id
       JOIN projects pr ON pr.id = e.project_id
      WHERE e.id = $1`,
    [executionId],
  );
  return rows[0] ?? null;
}

export async function finishMonitorExecution(pool, execution, { status, batchId = null, details = {}, error = null }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE service_monitor_executions
          SET status = $2, batch_id = $3, details = $4::jsonb, last_error = $5,
              finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [execution.id, status, batchId, JSON.stringify(details ?? {}), error == null ? null : String(error).slice(0, 2000)],
    );
    await client.query(
      `UPDATE service_monitor_plans
          SET last_executed_at = now(), last_batch_id = COALESCE($2, last_batch_id),
              consecutive_failures = CASE WHEN $3 = 'completed' THEN 0 ELSE consecutive_failures + 1 END,
              last_error = CASE WHEN $3 = 'completed' THEN NULL ELSE $4 END,
              updated_at = now()
        WHERE id = $1`,
      [execution.plan_id, batchId, status, error == null ? null : String(error).slice(0, 2000)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
