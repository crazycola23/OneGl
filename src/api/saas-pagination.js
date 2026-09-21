import { ApiHttpError, sendJson } from "./http.js";
import { requireScope } from "./service-store.js";
import { getExecution, getExecutionInternal, getTask, getTaskInternal, publicResultFields } from "../tasks/service.js";

function encodeCursor(kind, id) {
  return Buffer.from(JSON.stringify({ v: 1, k: kind, i: Number(id) }), "utf8").toString("base64url");
}

function decodeCursor(raw, kind) {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    if (parsed?.v !== 1 || parsed?.k !== kind || !Number.isInteger(parsed?.i) || parsed.i <= 0) throw new Error("invalid cursor");
    return parsed.i;
  } catch {
    throw new ApiHttpError(400, "invalid_cursor", "cursor is invalid for this collection");
  }
}

function parseLimit(url, fallback = 100, max = 500) {
  const raw = url.searchParams.get("limit");
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ApiHttpError(400, "invalid_request", `limit must be an integer between 1 and ${max}`);
  }
  return value;
}

function pageEnvelope(items, rows, limit, kind) {
  const hasMore = rows.length > limit;
  const visibleRows = rows.slice(0, limit);
  return {
    data: items.slice(0, limit),
    meta: {
      has_more: hasMore,
      next_cursor: hasMore && visibleRows.length ? encodeCursor(kind, visibleRows[visibleRows.length - 1].id) : null,
    },
  };
}

function executionStatus(status) {
  return status === "aborted" ? "cancelled" : status;
}

function localTime(hour, minute) {
  return `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`;
}

export async function handleSaasPaginationRoute({ req, res, url, db, auth, tenant }) {
  if (req.method !== "GET") return false;
  const pathname = url.pathname;

  if (pathname === "/v1/tasks") {
    const limit = parseLimit(url);
    requireScope(auth, "projects:read");
    const cursor = decodeCursor(url.searchParams.get("cursor"), "tasks");
    const { rows } = await db.query(
      `SELECT id, public_id
         FROM service_tasks
        WHERE tenant_id = $1 AND state <> 'archived'
          AND ($2::bigint IS NULL OR id < $2)
        ORDER BY id DESC
        LIMIT $3`,
      [tenant.id, cursor, limit + 1],
    );
    const items = [];
    for (const row of rows.slice(0, limit)) items.push(await getTask(db, tenant.id, row.public_id));
    return sendJson(res, 200, pageEnvelope(items, rows, limit, "tasks"));
  }

  const taskExecutions = pathname.match(/^\/v1\/tasks\/(tsk_[a-f0-9]+)\/executions$/);
  if (taskExecutions) {
    const limit = parseLimit(url);
    requireScope(auth, "batches:read");
    const task = await getTaskInternal(db, tenant.id, taskExecutions[1]);
    if (!task) throw new ApiHttpError(404, "task_not_found", "task was not found");
    const cursor = decodeCursor(url.searchParams.get("cursor"), "executions");
    const { rows } = await db.query(
      `SELECT id, public_id
         FROM service_task_executions
        WHERE tenant_id = $1 AND task_id = $2
          AND ($3::bigint IS NULL OR id < $3)
        ORDER BY id DESC
        LIMIT $4`,
      [tenant.id, task.id, cursor, limit + 1],
    );
    const items = [];
    for (const row of rows.slice(0, limit)) items.push(await getExecution(db, tenant.id, row.public_id));
    return sendJson(res, 200, pageEnvelope(items, rows, limit, "executions"));
  }

  const executionResults = pathname.match(/^\/v1\/executions\/(exe_[a-f0-9]+)\/results$/);
  if (executionResults) {
    const limit = parseLimit(url);
    requireScope(auth, "reports:read");
    const execution = await getExecutionInternal(db, tenant.id, executionResults[1]);
    if (!execution) throw new ApiHttpError(404, "execution_not_found", "execution was not found");
    const cursor = decodeCursor(url.searchParams.get("cursor"), "results");
    const { rows } = await db.query(
      `SELECT sr.id, sr.public_id AS result_id, sr.question, sr.platform,
              sr.external_id, sr.repetition_index, sr.repetition_count,
              r.status AS run_status, r.brand_mentioned, r.mention_count, r.finished_at,
              r.error_code AS run_error_code, r.error_message AS run_error_message,
              b.status AS batch_status,
              t.public_id AS task_public_id,
              e.public_id AS execution_public_id
         FROM service_task_results sr
         LEFT JOIN runs r ON r.local_run_id = sr.run_id
         LEFT JOIN sampling_batches b ON b.id = sr.batch_id
         JOIN service_task_executions e ON e.id = sr.execution_id
         JOIN service_tasks t ON t.id = e.task_id
        WHERE sr.tenant_id = $1 AND sr.execution_id = $2
          AND ($3::bigint IS NULL OR sr.id > $3)
        ORDER BY sr.id ASC
        LIMIT $4`,
      [tenant.id, execution.id, cursor, limit + 1],
    );
    const items = rows.slice(0, limit).map((row) => ({
      result_id: row.result_id,
      question: row.question,
      platform: row.platform,
      status: row.run_status ?? "pending",
      brand_mentioned: row.brand_mentioned,
      mention_count: row.mention_count == null ? null : Number(row.mention_count),
      finished_at: row.finished_at,
      result_url: `/v1/results/${row.result_id}`,
      ...publicResultFields(row),
    }));
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    return sendJson(res, 200, {
      data: items,
      meta: {
        has_more: hasMore,
        next_cursor: hasMore && visible.length ? encodeCursor("results", visible[visible.length - 1].id) : null,
      },
    });
  }

  const taskReports = pathname.match(/^\/v1\/tasks\/(tsk_[a-f0-9]+)\/reports$/);
  if (taskReports) {
    const limit = parseLimit(url);
    requireScope(auth, "reports:read");
    const task = await getTaskInternal(db, tenant.id, taskReports[1]);
    if (!task) throw new ApiHttpError(404, "task_not_found", "task was not found");
    const cursor = decodeCursor(url.searchParams.get("cursor"), "reports");
    const { rows } = await db.query(
      `SELECT rp.id, rp.public_id AS report_id, e.public_id AS execution_id,
              b.status, rp.created_at, b.finished_at
         FROM service_reports rp
         JOIN service_task_executions e ON e.id = rp.execution_id
         JOIN sampling_batches b ON b.id = rp.batch_id
        WHERE rp.tenant_id = $1 AND e.task_id = $2
          AND ($3::bigint IS NULL OR rp.id < $3)
        ORDER BY rp.id DESC
        LIMIT $4`,
      [tenant.id, task.id, cursor, limit + 1],
    );
    const items = rows.slice(0, limit).map((row) => ({
      report_id: row.report_id,
      execution_id: row.execution_id,
      status: ["completed", "partial", "failed", "aborted"].includes(row.status) ? "ready" : "generating",
      execution_status: executionStatus(row.status),
      report_url: `/v1/reports/${row.report_id}`,
      created_at: row.created_at,
      finished_at: row.finished_at,
    }));
    return sendJson(res, 200, pageEnvelope(items, rows, limit, "reports"));
  }

  const taskSchedules = pathname.match(/^\/v1\/tasks\/(tsk_[a-f0-9]+)\/schedules$/);
  if (taskSchedules) {
    const limit = parseLimit(url);
    requireScope(auth, "batches:read");
    const task = await getTaskInternal(db, tenant.id, taskSchedules[1]);
    if (!task) throw new ApiHttpError(404, "task_not_found", "task was not found");
    const cursor = decodeCursor(url.searchParams.get("cursor"), "schedules");
    const { rows } = await db.query(
      `SELECT s.id, s.public_id AS schedule_id, t.public_id AS task_id, s.created_at,
              p.name, p.enabled, p.cadence, p.time_zone, p.local_hour, p.local_minute,
              p.weekday, p.sample_size, p.sampling_method, p.repeats, p.account_ids,
              p.next_run_at, p.last_executed_at
         FROM service_task_schedules s
         JOIN service_tasks t ON t.id = s.task_id
         JOIN service_monitor_plans p ON p.id = s.monitor_plan_id
        WHERE s.tenant_id = $1 AND s.task_id = $2
          AND ($3::bigint IS NULL OR s.id < $3)
        ORDER BY s.id DESC
        LIMIT $4`,
      [tenant.id, task.id, cursor, limit + 1],
    );
    const items = rows.slice(0, limit).map((row) => ({
      schedule_id: row.schedule_id,
      task_id: row.task_id,
      name: row.name,
      enabled: row.enabled,
      schedule: {
        cadence: row.cadence,
        time_zone: row.time_zone,
        local_time: localTime(row.local_hour, row.local_minute),
        weekday: row.weekday,
      },
      sampling: {
        size: row.sample_size == null ? null : Number(row.sample_size),
        method: row.sampling_method,
        repeats: Number(row.repeats),
      },
      account_ids: Array.isArray(row.account_ids) ? row.account_ids : [],
      next_run_at: row.next_run_at,
      last_run_at: row.last_executed_at,
      created_at: row.created_at,
    }));
    return sendJson(res, 200, pageEnvelope(items, rows, limit, "schedules"));
  }

  const scheduleExecutions = pathname.match(/^\/v1\/schedules\/(sch_[a-f0-9]+)\/executions$/);
  if (scheduleExecutions) {
    const limit = parseLimit(url);
    requireScope(auth, "batches:read");
    const { rows: schedules } = await db.query(
      `SELECT monitor_plan_id
         FROM service_task_schedules
        WHERE tenant_id = $1 AND public_id = $2`,
      [tenant.id, scheduleExecutions[1]],
    );
    if (!schedules[0]) throw new ApiHttpError(404, "schedule_not_found", "schedule was not found");
    const cursor = decodeCursor(url.searchParams.get("cursor"), "schedule-executions");
    const { rows } = await db.query(
      `SELECT me.id, me.scheduled_for, me.status, me.batch_id, me.details, me.last_error,
              e.public_id AS execution_id
         FROM service_monitor_executions me
         LEFT JOIN service_task_executions e ON e.batch_id = me.batch_id
        WHERE me.tenant_id = $1 AND me.plan_id = $2
          AND ($3::bigint IS NULL OR me.id < $3)
        ORDER BY me.id DESC
        LIMIT $4`,
      [tenant.id, schedules[0].monitor_plan_id, cursor, limit + 1],
    );
    const items = rows.slice(0, limit).map((row) => ({
      scheduled_for: row.scheduled_for,
      status: row.status === "skipped" ? "action_required" : row.status,
      execution_id: row.execution_id ?? null,
      batch_created: Boolean(row.batch_id),
      details: row.details,
      error: row.last_error,
    }));
    return sendJson(res, 200, pageEnvelope(items, rows, limit, "schedule-executions"));
  }

  return false;
}
