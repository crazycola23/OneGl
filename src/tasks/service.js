import crypto from "node:crypto";

import { ApiHttpError } from "../api/http.js";
import { runIdFor } from "../queue/batches.js";

const SUPPORTED_PLATFORMS = new Set(["doubao"]);
const METHODS = new Set(["stratified", "random"]);

export function publicId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function cleanStrings(values, name, { required = false, max = 5000 } = {}) {
  if (values == null && !required) return undefined;
  if (!Array.isArray(values)) throw new ApiHttpError(400, "invalid_request", `${name} must be an array`);
  const out = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if ((required && out.length === 0) || out.length > max) {
    throw new ApiHttpError(400, "invalid_request", `${name} must contain between ${required ? 1 : 0} and ${max} values`);
  }
  return out;
}

export function normalizeTaskInput(input = {}, current = null) {
  const name = String(input.name ?? current?.name ?? "").trim();
  if (!name) throw new ApiHttpError(400, "invalid_request", "name is required");
  if (name.length > 200) throw new ApiHttpError(400, "invalid_request", "name must be 200 characters or fewer");

  const targetBrand = input.target_brand === undefined
    ? current?.target_brand ?? null
    : String(input.target_brand ?? "").trim() || null;
  const questions = input.questions === undefined
    ? current?.questions
    : cleanStrings(input.questions, "questions", { required: true, max: 5000 });
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ApiHttpError(400, "invalid_request", "questions must contain at least one question");
  }

  const platforms = input.platforms === undefined
    ? current?.platforms ?? ["doubao"]
    : cleanStrings(input.platforms, "platforms", { required: true, max: 20 }).map((value) => value.toLowerCase());
  const unsupported = platforms.filter((value) => !SUPPORTED_PLATFORMS.has(value));
  if (unsupported.length) {
    throw new ApiHttpError(422, "unsupported_platform", `unsupported platform(s): ${unsupported.join(", ")}`, {
      supported_platforms: [...SUPPORTED_PLATFORMS],
    });
  }

  const accountIds = input.account_ids === undefined
    ? current?.account_ids ?? []
    : cleanStrings(input.account_ids, "account_ids", { required: false, max: 100 });
  const samplingMethod = String(input.sampling?.method ?? input.sampling_method ?? current?.sampling_method ?? "stratified").trim().toLowerCase();
  if (!METHODS.has(samplingMethod)) throw new ApiHttpError(400, "invalid_request", "sampling.method must be stratified or random");
  const repeatsRaw = input.sampling?.repeats ?? input.repeats ?? current?.repeats ?? 1;
  const repeats = Number(repeatsRaw);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) {
    throw new ApiHttpError(400, "invalid_request", "sampling.repeats must be an integer between 1 and 100");
  }
  const externalId = input.external_id === undefined
    ? current?.external_id ?? null
    : String(input.external_id ?? "").trim() || null;

  return { name, targetBrand, questions, platforms, accountIds, samplingMethod, repeats, externalId };
}

async function taskQuestions(pool, projectId) {
  const { rows } = await pool.query(
    `SELECT prompt
       FROM prompts
      WHERE project_id = $1 AND enabled = true AND deleted_at IS NULL
      ORDER BY created_at, id`,
    [projectId],
  );
  return rows.map((row) => row.prompt);
}

function taskRow(row, questions) {
  if (!row) return null;
  return {
    task_id: row.public_id,
    external_id: row.external_id,
    name: row.name,
    target_brand: row.target_brand,
    questions,
    platforms: Array.isArray(row.platforms) ? row.platforms : [],
    account_ids: Array.isArray(row.account_ids) ? row.account_ids : [],
    sampling: { method: row.sampling_method, repeats: Number(row.repeats) },
    revision: Number(row.revision),
    state: row.state,
    execution_count: Number(row.execution_count ?? 0),
    latest_execution_id: row.latest_execution_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listTasks(pool, tenantId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT t.*,
            (SELECT count(*) FROM service_task_executions e WHERE e.task_id = t.id) AS execution_count,
            (SELECT e.public_id FROM service_task_executions e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS latest_execution_id
       FROM service_tasks t
      WHERE t.tenant_id = $1 AND t.state <> 'archived'
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  const out = [];
  for (const row of rows) out.push(taskRow(row, await taskQuestions(pool, row.project_id)));
  return out;
}

export async function getTask(pool, tenantId, publicTaskId) {
  const { rows } = await pool.query(
    `SELECT t.*,
            (SELECT count(*) FROM service_task_executions e WHERE e.task_id = t.id) AS execution_count,
            (SELECT e.public_id FROM service_task_executions e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS latest_execution_id
       FROM service_tasks t
      WHERE t.tenant_id = $1 AND t.public_id = $2`,
    [tenantId, publicTaskId],
  );
  const row = rows[0];
  return row ? taskRow(row, await taskQuestions(pool, row.project_id)) : null;
}

export async function getTaskInternal(pool, tenantId, publicTaskId) {
  const { rows } = await pool.query(
    "SELECT * FROM service_tasks WHERE tenant_id = $1 AND public_id = $2",
    [tenantId, publicTaskId],
  );
  return rows[0] ?? null;
}

export async function createTaskRow(pool, { tenantId, projectId, publicTaskId, input }) {
  const { rows } = await pool.query(
    `INSERT INTO service_tasks
       (public_id, tenant_id, project_id, external_id, name, target_brand, platforms, account_ids, sampling_method, repeats)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
     RETURNING *`,
    [publicTaskId, tenantId, projectId, input.externalId, input.name, input.targetBrand,
      JSON.stringify(input.platforms), JSON.stringify(input.accountIds), input.samplingMethod, input.repeats],
  );
  return rows[0];
}

export async function updateTaskRow(pool, { tenantId, taskId, input }) {
  const { rows } = await pool.query(
    `UPDATE service_tasks
        SET external_id = $3, name = $4, target_brand = $5, platforms = $6::jsonb,
            account_ids = $7::jsonb, sampling_method = $8, repeats = $9,
            revision = revision + 1, updated_at = now()
      WHERE tenant_id = $1 AND public_id = $2
      RETURNING *`,
    [tenantId, taskId, input.externalId, input.name, input.targetBrand, JSON.stringify(input.platforms),
      JSON.stringify(input.accountIds), input.samplingMethod, input.repeats],
  );
  return rows[0] ?? null;
}

export async function archiveTask(pool, tenantId, taskId) {
  const { rowCount } = await pool.query(
    "UPDATE service_tasks SET state = 'archived', updated_at = now() WHERE tenant_id = $1 AND public_id = $2 AND state <> 'archived'",
    [tenantId, taskId],
  );
  return rowCount > 0;
}

export async function taskHasExecutions(pool, internalTaskId) {
  const { rows } = await pool.query("SELECT EXISTS (SELECT 1 FROM service_task_executions WHERE task_id = $1) AS yes", [internalTaskId]);
  return Boolean(rows[0]?.yes);
}

export async function syncTaskQuestions(pool, projectId, questions) {
  await pool.query(
    `UPDATE prompts
        SET enabled = false, deleted_at = COALESCE(deleted_at, now()), updated_at = now()
      WHERE project_id = $1 AND deleted_at IS NULL`,
    [projectId],
  );
}

function executionStatus(batchStatus) {
  if (batchStatus === "aborted") return "cancelled";
  return batchStatus ?? "pending";
}

export async function ensureExecutionResourcesForBatch(pool, {
  tenantId,
  internalTaskId,
  batchId,
  triggerType = "manual",
  parentExecutionId = null,
  executionPublicId = null,
  reportPublicId = null,
}) {
  let { rows } = await pool.query(
    "SELECT * FROM service_task_executions WHERE tenant_id = $1 AND batch_id = $2",
    [tenantId, batchId],
  );
  let execution = rows[0];
  if (!execution) {
    const id = executionPublicId ?? publicId("exe");
    ({ rows } = await pool.query(
      `INSERT INTO service_task_executions
         (public_id, tenant_id, task_id, batch_id, trigger_type, parent_execution_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (batch_id) DO NOTHING
       RETURNING *`,
      [id, tenantId, internalTaskId, batchId, triggerType, parentExecutionId],
    ));
    execution = rows[0] ?? (await pool.query("SELECT * FROM service_task_executions WHERE batch_id = $1", [batchId])).rows[0];
  }

  await pool.query(
    `INSERT INTO service_reports (public_id, tenant_id, execution_id, batch_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (execution_id) DO NOTHING`,
    [reportPublicId ?? publicId("rpt"), tenantId, execution.id, batchId],
  );

  const { rows: assignments } = await pool.query(
    `SELECT sbp.selection_index, sbp.prompt_id, COALESCE(sbp.prompt_text, p.prompt) AS question
       FROM sampling_batch_prompts sbp
       LEFT JOIN prompts p ON p.id = sbp.prompt_id
      WHERE sbp.batch_id = $1
      ORDER BY sbp.selection_index`,
    [batchId],
  );
  for (const assignment of assignments) {
    await pool.query(
      `INSERT INTO service_task_results
         (public_id, tenant_id, execution_id, batch_id, selection_index, prompt_id, question, platform, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'doubao', $8)
       ON CONFLICT (execution_id, selection_index) DO NOTHING`,
      [publicId("res"), tenantId, execution.id, batchId, assignment.selection_index, assignment.prompt_id,
        assignment.question, runIdFor(batchId, Number(assignment.selection_index))],
    );
  }
  return execution;
}

export async function ensureScheduledTaskExecutionForBatch(pool, { monitorPlanId, batchId }) {
  const { rows } = await pool.query(
    `SELECT s.tenant_id, s.task_id
       FROM service_task_schedules s
      WHERE s.monitor_plan_id = $1`,
    [monitorPlanId],
  );
  if (!rows[0]) return null;
  return ensureExecutionResourcesForBatch(pool, {
    tenantId: Number(rows[0].tenant_id),
    internalTaskId: Number(rows[0].task_id),
    batchId,
    triggerType: "schedule",
  });
}

export async function getExecution(pool, tenantId, executionId) {
  const { rows } = await pool.query(
    `SELECT e.*, t.public_id AS task_public_id, t.name AS task_name,
            b.status AS batch_status, b.requested_jobs, b.completed_jobs, b.failed_jobs, b.skipped_jobs,
            b.started_at, b.finished_at, b.queued_at, b.aborted_at,
            r.public_id AS report_public_id
       FROM service_task_executions e
       JOIN service_tasks t ON t.id = e.task_id
       LEFT JOIN sampling_batches b ON b.id = e.batch_id
       LEFT JOIN service_reports r ON r.execution_id = e.id
      WHERE e.tenant_id = $1 AND e.public_id = $2`,
    [tenantId, executionId],
  );
  const row = rows[0];
  if (!row) return null;
  const requested = Number(row.requested_jobs ?? 0);
  const completed = Number(row.completed_jobs ?? 0);
  const failed = Number(row.failed_jobs ?? 0);
  const skipped = Number(row.skipped_jobs ?? 0);
  const done = Math.min(requested, completed + failed + skipped);
  return {
    execution_id: row.public_id,
    task_id: row.task_public_id,
    task_name: row.task_name,
    report_id: row.report_public_id ?? null,
    trigger: row.trigger_type,
    status: executionStatus(row.batch_status),
    progress: {
      total: requested,
      completed,
      failed,
      skipped,
      remaining: Math.max(0, requested - done),
      percent: requested ? Math.round((done / requested) * 1000) / 10 : 0,
    },
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

export async function listTaskExecutions(pool, tenantId, taskId, limit = 100) {
  const task = await getTaskInternal(pool, tenantId, taskId);
  if (!task) return null;
  const { rows } = await pool.query(
    "SELECT public_id FROM service_task_executions WHERE tenant_id = $1 AND task_id = $2 ORDER BY id DESC LIMIT $3",
    [tenantId, task.id, limit],
  );
  const out = [];
  for (const row of rows) out.push(await getExecution(pool, tenantId, row.public_id));
  return out;
}

export async function getExecutionInternal(pool, tenantId, executionId) {
  const { rows } = await pool.query(
    `SELECT e.*, t.public_id AS task_public_id
       FROM service_task_executions e
       JOIN service_tasks t ON t.id = e.task_id
      WHERE e.tenant_id = $1 AND e.public_id = $2`,
    [tenantId, executionId],
  );
  return rows[0] ?? null;
}

export async function listExecutionResults(pool, tenantId, executionId) {
  const execution = await getExecutionInternal(pool, tenantId, executionId);
  if (!execution) return null;
  const { rows } = await pool.query(
    `SELECT sr.public_id AS result_id, sr.question, sr.platform, sr.run_id,
            r.status AS run_status, r.brand_mentioned, r.mention_count, r.finished_at
       FROM service_task_results sr
       LEFT JOIN runs r ON r.local_run_id = sr.run_id
      WHERE sr.tenant_id = $1 AND sr.execution_id = $2
      ORDER BY sr.selection_index`,
    [tenantId, execution.id],
  );
  return rows.map((row) => ({
    result_id: row.result_id,
    question: row.question,
    platform: row.platform,
    status: row.run_status ?? "pending",
    brand_mentioned: row.brand_mentioned,
    mention_count: row.mention_count == null ? null : Number(row.mention_count),
    finished_at: row.finished_at,
    result_url: `/v1/results/${row.result_id}`,
  }));
}

export async function getResult(pool, tenantId, resultId) {
  const { rows } = await pool.query(
    `SELECT sr.*, e.public_id AS execution_public_id, t.public_id AS task_public_id,
            r.id AS run_db_id, r.status AS run_status
       FROM service_task_results sr
       JOIN service_task_executions e ON e.id = sr.execution_id
       JOIN service_tasks t ON t.id = e.task_id
       LEFT JOIN runs r ON r.local_run_id = sr.run_id
      WHERE sr.tenant_id = $1 AND sr.public_id = $2`,
    [tenantId, resultId],
  );
  return rows[0] ?? null;
}

export async function getReport(pool, tenantId, reportId) {
  const { rows } = await pool.query(
    `SELECT rp.*, e.public_id AS execution_public_id, t.public_id AS task_public_id,
            t.name AS task_name, b.status AS batch_status
       FROM service_reports rp
       JOIN service_task_executions e ON e.id = rp.execution_id
       JOIN service_tasks t ON t.id = e.task_id
       JOIN sampling_batches b ON b.id = rp.batch_id
      WHERE rp.tenant_id = $1 AND rp.public_id = $2`,
    [tenantId, reportId],
  );
  return rows[0] ?? null;
}

export async function reportForExecution(pool, tenantId, executionId) {
  const { rows } = await pool.query(
    `SELECT rp.public_id
       FROM service_reports rp
       JOIN service_task_executions e ON e.id = rp.execution_id
      WHERE rp.tenant_id = $1 AND e.public_id = $2`,
    [tenantId, executionId],
  );
  return rows[0]?.public_id ?? null;
}

export async function listTaskReports(pool, tenantId, taskId, limit = 100) {
  const task = await getTaskInternal(pool, tenantId, taskId);
  if (!task) return null;
  const { rows } = await pool.query(
    `SELECT rp.public_id AS report_id, e.public_id AS execution_id, b.status,
            rp.created_at, b.finished_at
       FROM service_reports rp
       JOIN service_task_executions e ON e.id = rp.execution_id
       JOIN sampling_batches b ON b.id = rp.batch_id
      WHERE rp.tenant_id = $1 AND e.task_id = $2
      ORDER BY rp.id DESC LIMIT $3`,
    [tenantId, task.id, limit],
  );
  return rows.map((row) => ({
    report_id: row.report_id,
    execution_id: row.execution_id,
    status: ["completed", "partial", "failed", "aborted"].includes(row.status) ? "ready" : "generating",
    execution_status: executionStatus(row.status),
    report_url: `/v1/reports/${row.report_id}`,
    created_at: row.created_at,
    finished_at: row.finished_at,
  }));
}
