import crypto from "node:crypto";

import { ApiHttpError } from "../api/http.js";
import { runIdFor } from "../queue/batches.js";

const SUPPORTED_PLATFORMS = new Set(["doubao"]);
const METHODS = new Set(["stratified", "random"]);

/** Caller-owned mapping keys must survive a round-trip through URLs, JSON and logs. */
export const QUESTION_EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export const ASSIGNMENT_STATUSES = Object.freeze([
  "not_started",
  "running",
  "collected",
  "not_collected",
  "cancelled",
]);

export const TERMINAL_BATCH_STATUSES = Object.freeze(["completed", "partial", "failed", "aborted"]);

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

function optionalString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function optionalPositiveInt(value, field) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 10000) {
    throw new ApiHttpError(422, "invalid_request", `${field} must be an integer between 1 and 10000`);
  }
  return number;
}

/**
 * Accept either the legacy `["question text"]` form or per-observation objects.
 *
 * A batch that carries `external_id` values is a list of *observations*, so two rows with
 * the same text but different external ids are two questions: de-duplicating them would
 * silently drop R-1 of the R repetitions the caller asked to measure. Without any external
 * id the historical text de-duplication is preserved byte-for-byte.
 */
export function normalizeQuestionEntries(raw) {
  if (!Array.isArray(raw)) throw new ApiHttpError(400, "invalid_request", "questions must be an array");
  const entries = [];
  for (const item of raw) {
    if (item != null && typeof item === "object" && !Array.isArray(item)) {
      const text = optionalString(item.text ?? item.question);
      if (!text) continue;
      const externalId = optionalString(item.external_id);
      if (externalId != null && !QUESTION_EXTERNAL_ID_PATTERN.test(externalId)) {
        throw new ApiHttpError(422, "invalid_external_id", "questions[].external_id must be 1-200 characters of A-Z a-z 0-9 . _ : -", {
          external_id: externalId,
        });
      }
      const repetitionIndex = optionalPositiveInt(item.repetition_index, "questions[].repetition_index");
      const repetitionCount = optionalPositiveInt(item.repetition_count, "questions[].repetition_count");
      if (repetitionIndex && repetitionCount && repetitionIndex > repetitionCount) {
        throw new ApiHttpError(422, "invalid_request", "questions[].repetition_index must not exceed repetition_count", {
          repetition_index: repetitionIndex,
          repetition_count: repetitionCount,
        });
      }
      entries.push({
        text,
        externalId,
        repetitionIndex,
        repetitionCount,
        category: optionalString(item.category),
      });
      continue;
    }
    const text = String(item ?? "").trim();
    if (text) entries.push({ text, externalId: null, repetitionIndex: null, repetitionCount: null, category: null });
  }

  if (!entries.some((entry) => entry.externalId)) {
    const seen = new Set();
    const deduped = [];
    for (const entry of entries) {
      if (seen.has(entry.text)) continue;
      seen.add(entry.text);
      deduped.push(entry);
    }
    return deduped;
  }

  const seenExternal = new Set();
  for (const entry of entries) {
    if (!entry.externalId) continue;
    if (seenExternal.has(entry.externalId)) {
      throw new ApiHttpError(422, "duplicate_external_id", "questions[].external_id must be unique within a task", {
        external_id: entry.externalId,
      });
    }
    seenExternal.add(entry.externalId);
  }
  return entries;
}

function readQuestions(input, current) {
  if (input.questions !== undefined) return normalizeQuestionEntries(input.questions);
  if (Array.isArray(current?.question_entries) && current.question_entries.length) {
    return current.question_entries.map((entry) => ({
      text: entry.text ?? entry.question,
      externalId: entry.external_id ?? null,
      repetitionIndex: entry.repetition_index ?? null,
      repetitionCount: entry.repetition_count ?? null,
      category: entry.category ?? null,
    }));
  }
  if (Array.isArray(current?.questions)) {
    return current.questions.map((text) => ({ text, externalId: null, repetitionIndex: null, repetitionCount: null, category: null }));
  }
  return [];
}

export function normalizeTaskInput(input = {}, current = null) {
  const name = String(input.name ?? current?.name ?? "").trim();
  if (!name) throw new ApiHttpError(400, "invalid_request", "name is required");
  if (name.length > 200) throw new ApiHttpError(400, "invalid_request", "name must be 200 characters or fewer");

  const targetBrand = input.target_brand === undefined
    ? current?.target_brand ?? null
    : String(input.target_brand ?? "").trim() || null;
  const questionEntries = readQuestions(input, current);
  const questions = questionEntries.map((entry) => entry.text);
  if (questions.length > 5000) {
    throw new ApiHttpError(400, "invalid_request", "questions must contain between 1 and 5000 values");
  }
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
  if (repeats > 1 && questionEntries.some((entry) => entry.externalId)) {
    throw new ApiHttpError(422, "external_id_requires_single_repeat", "questions[].external_id maps one entry to one observation, so sampling.repeats must be 1; send one entry per observation instead", {
      repeats,
    });
  }
  const externalId = input.external_id === undefined
    ? current?.external_id ?? null
    : String(input.external_id ?? "").trim() || null;

  return { name, targetBrand, questions, questionEntries, platforms, accountIds, samplingMethod, repeats, externalId };
}

/**
 * Public question list of a Task. When the task was created from per-observation entries the
 * rows come back in the caller's own order with their mapping keys; the legacy
 * "questions: string[]" view is kept unchanged on top of it.
 */
async function taskQuestions(pool, projectId, internalTaskId) {
  const { rows } = await pool.query(
    `SELECT q.prompt,
            q.category,
            q.external_id,
            s.repetition_index,
            s.repetition_count,
            s.ordinal
       FROM prompts q
       LEFT JOIN service_task_questions s ON s.prompt_id = q.id AND s.task_id = $2
      WHERE q.project_id = $1 AND q.enabled = true AND q.deleted_at IS NULL
      ORDER BY (s.ordinal IS NULL), COALESCE(s.ordinal, 0), q.created_at, q.id`,
    [projectId, internalTaskId],
  );
  return rows.map((row) => ({
    text: row.prompt,
    question: row.prompt,
    external_id: row.external_id ?? null,
    category: row.category ?? null,
    repetition_index: row.repetition_index == null ? null : Number(row.repetition_index),
    repetition_count: row.repetition_count == null ? null : Number(row.repetition_count),
  }));
}

function taskRow(row, entries) {
  if (!row) return null;
  const list = Array.isArray(entries) ? entries : [];
  return {
    task_id: row.public_id,
    external_id: row.external_id,
    name: row.name,
    target_brand: row.target_brand,
    questions: list.map((entry) => entry.text),
    question_entries: list,
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
  for (const row of rows) out.push(taskRow(row, await taskQuestions(pool, row.project_id, row.id)));
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
  return row ? taskRow(row, await taskQuestions(pool, row.project_id, row.id)) : null;
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

/**
 * Persist the caller's per-observation question list for a Task.
 *
 * `prompts.external_id` is the carrier that survives into a sampling batch (every
 * `sampling_batch_prompts` row points at one prompt row), while this table keeps the
 * ordered entry list with its repetition coordinates so a result can echo all of them back.
 */
export async function replaceTaskQuestions(pool, { tenantId, internalTaskId, entries, keywords }) {
  await pool.query("DELETE FROM service_task_questions WHERE task_id = $1", [internalTaskId]);
  const promptIdByText = new Map();
  for (const keyword of Array.isArray(keywords) ? keywords : []) {
    const key = `${keyword.keyword ?? ""}\u0000${keyword.externalId ?? ""}`;
    if (!promptIdByText.has(key)) promptIdByText.set(key, Number(keyword.id));
  }
  let ordinal = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    ordinal += 1;
    const promptId = promptIdByText.get(`${entry.text}\u0000${entry.externalId ?? ""}`) ?? null;
    await pool.query(
      `INSERT INTO service_task_questions
         (tenant_id, task_id, ordinal, external_id, question, category, repetition_index, repetition_count, prompt_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (task_id, ordinal) DO UPDATE
         SET external_id = EXCLUDED.external_id,
             question = EXCLUDED.question,
             category = EXCLUDED.category,
             repetition_index = EXCLUDED.repetition_index,
             repetition_count = EXCLUDED.repetition_count,
             prompt_id = EXCLUDED.prompt_id`,
      [tenantId, internalTaskId, ordinal, entry.externalId, entry.text, entry.category,
        entry.repetitionIndex, entry.repetitionCount, promptId],
    );
  }
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
    `SELECT sbp.selection_index, sbp.prompt_id, COALESCE(sbp.prompt_text, p.prompt) AS question,
            b.provider AS batch_provider,
            p.external_id, s.repetition_index, s.repetition_count
       FROM sampling_batch_prompts sbp
       JOIN sampling_batches b ON b.id = sbp.batch_id
       LEFT JOIN prompts p ON p.id = sbp.prompt_id
       LEFT JOIN service_task_questions s ON s.task_id = $2 AND s.external_id = p.external_id
      WHERE sbp.batch_id = $1
      ORDER BY sbp.selection_index`,
    [batchId, internalTaskId],
  );
  const claimedExternalIds = new Set();
  for (const assignment of assignments) {
    // A repeated prompt cannot be mapped 1:1 twice; normalizeTaskInput rejects
    // `sampling.repeats > 1` combined with external ids, so this only keeps a malformed
    // or historic row set from violating service_task_results_execution_external_key.
    const externalId = assignment.external_id == null || claimedExternalIds.has(assignment.external_id)
      ? null
      : assignment.external_id;
    claimedExternalIds.add(assignment.external_id);
    await pool.query(
      `INSERT INTO service_task_results
         (public_id, tenant_id, execution_id, batch_id, selection_index, prompt_id, question, platform, run_id,
          external_id, repetition_index, repetition_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $12, $8, $9, $10, $11)
       ON CONFLICT (execution_id, selection_index) DO NOTHING`,
      [publicId("res"), tenantId, execution.id, batchId, assignment.selection_index, assignment.prompt_id,
        assignment.question, runIdFor(batchId, Number(assignment.selection_index)), externalId,
        assignment.repetition_index, assignment.repetition_count,
        // 结果行的平台跟着它自己的批次走，写死会让千问的执行结果显示成 doubao。
        assignment.batch_provider ?? "doubao"],
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
            b.status AS batch_status, b.provider AS batch_provider,
            b.requested_jobs, b.completed_jobs, b.failed_jobs, b.skipped_jobs,
            b.started_at, b.finished_at, b.queued_at, b.aborted_at,
            r.public_id AS report_public_id,
            (SELECT array_agg(DISTINCT ru.login_state ORDER BY ru.login_state)
               FROM runs ru WHERE ru.sampling_batch_id = e.batch_id) AS login_states
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
    // Read off the execution's own batch rather than the Task's platform list: a Task may
    // carry more than one platform, and a webhook consumer that has to GET the execution to
    // learn which one produced the numbers cannot route at all.
    platform: row.batch_provider ?? null,
    trigger: row.trigger_type,
    status: executionStatus(row.batch_status),
    progress: {
      total: requested,
      completed,
      failed,
      skipped,
      not_collected: await countNotCollected(pool, row.id, row.batch_status),
      remaining: Math.max(0, requested - done),
      percent: requested ? Math.round((done / requested) * 1000) / 10 : 0,
    },
    // Two entries mean this execution's rates blend signed-out and account observations.
    login_states: row.login_states ?? [],
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

/**
 * Assignments that will never produce data. Counting an assignment with no run row only makes
 * sense once the batch is terminal - while it is still running, an untouched question is just
 * work that has not started, and counting it here would report a shrinking `remaining` as
 * already lost. Failed runs count in both states because that assignment is closed either way.
 */
export async function countNotCollected(pool, internalExecutionId, batchStatus = null) {
  if (!internalExecutionId) return 0;
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (
              WHERE r.status = 'failed'
                 OR ($2::boolean AND r.status IS NULL)
             ) AS not_collected
       FROM service_task_results sr
       LEFT JOIN runs r ON r.local_run_id = sr.run_id
      WHERE sr.execution_id = $1`,
    [internalExecutionId, TERMINAL_BATCH_STATUSES.includes(batchStatus)],
  );
  return Number(rows[0]?.not_collected ?? 0);
}

/**
 * `status` mirrors the collector run row and stays `pending` while nothing has run — that
 * is what an in-flight assignment looks like. `assignment_status` answers the different
 * question a batch consumer actually polls with: will this row ever produce data?
 * Without it a skipped assignment (aborted batch, permanent account block, exhausted
 * cooldown) reports `pending` forever on a terminal execution.
 */
export function assignmentStatusFor({ runStatus = null, batchStatus = null } = {}) {
  const terminal = TERMINAL_BATCH_STATUSES.includes(batchStatus);
  if (runStatus === "success" || runStatus === "partial") return "collected";
  if (runStatus === "failed") return "not_collected";
  if (runStatus === "running") return "running";
  if (runStatus) return terminal ? (batchStatus === "aborted" ? "cancelled" : "not_collected") : "running";
  if (!terminal) return "not_started";
  return batchStatus === "aborted" ? "cancelled" : "not_collected";
}

export function terminalReasonFor({ runStatus = null, errorCode = null, errorMessage = null, batchStatus = null } = {}) {
  if (errorCode || errorMessage) {
    return { code: errorCode ?? "collection_failed", message: errorMessage ?? "collection failed" };
  }
  if (runStatus === "failed") return { code: "collection_failed", message: "collection failed without an error code" };
  if (runStatus) return null;
  if (batchStatus === "aborted") {
    return { code: "execution_cancelled", message: "execution was cancelled before this question was collected" };
  }
  if (TERMINAL_BATCH_STATUSES.includes(batchStatus)) {
    return {
      code: "assignment_skipped",
      message: `assignment was skipped while the batch was ${batchStatus}; no collection run was recorded for this question`,
    };
  }
  return null;
}

/**
 * Single source of truth for the public result projection. The execution list route, the
 * paginated results route and the single result route all build their payload from here so
 * the three copies cannot drift apart.
 */
export function publicResultFields(row) {
  const batchStatus = row.batch_status ?? null;
  const runStatus = row.run_status ?? null;
  return {
    question_external_id: row.external_id ?? null,
    repetition_index: row.repetition_index == null ? null : Number(row.repetition_index),
    repetition_count: row.repetition_count == null ? null : Number(row.repetition_count),
    task_id: row.task_public_id ?? null,
    execution_id: row.execution_public_id ?? null,
    // null while nothing has run for this assignment. A signed-out observation is a different
    // condition from an account observation, so a customer mixing the two into one rate would
    // be reporting a number that describes no real user.
    login_state: row.run_login_state ?? null,
    assignment_status: assignmentStatusFor({ runStatus, batchStatus }),
    terminal_reason: terminalReasonFor({
      runStatus,
      errorCode: row.run_error_code ?? null,
      errorMessage: row.run_error_message ?? null,
      batchStatus,
    }),
  };
}

export async function listExecutionResults(pool, tenantId, executionId) {
  const execution = await getExecutionInternal(pool, tenantId, executionId);
  if (!execution) return null;
  const { rows } = await pool.query(
    `SELECT sr.public_id AS result_id, sr.question, sr.platform, sr.run_id,
            sr.external_id, sr.repetition_index, sr.repetition_count,
            r.status AS run_status, r.brand_mentioned, r.mention_count, r.finished_at,
            r.login_state AS run_login_state,
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
    ...publicResultFields(row),
  }));
}

export async function getResult(pool, tenantId, resultId) {
  const { rows } = await pool.query(
    `SELECT sr.*, e.public_id AS execution_public_id, t.public_id AS task_public_id,
            r.id AS run_db_id, r.status AS run_status,
            r.login_state AS run_login_state,
            r.error_code AS run_error_code, r.error_message AS run_error_message,
            b.status AS batch_status
       FROM service_task_results sr
       JOIN service_task_executions e ON e.id = sr.execution_id
       JOIN service_tasks t ON t.id = e.task_id
       LEFT JOIN runs r ON r.local_run_id = sr.run_id
       LEFT JOIN sampling_batches b ON b.id = sr.batch_id
      WHERE sr.tenant_id = $1 AND sr.public_id = $2`,
    [tenantId, resultId],
  );
  return rows[0] ?? null;
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

/**
 * Result rows carry the caller's mapping keys; `runs` rows only know `local_run_id`.
 * The report contract needs the two joined so every collected observation can be echoed
 * back with the external id that produced it.
 */
export async function listBatchResultIdentities(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT sr.run_id, sr.public_id AS result_id, sr.external_id,
            sr.repetition_index, sr.repetition_count, sr.selection_index
       FROM service_task_results sr
      WHERE sr.batch_id = $1
      ORDER BY sr.selection_index`,
    [batchId],
  );
  return rows;
}

export async function getReport(pool, tenantId, reportId) {
  const { rows } = await pool.query(
    `SELECT rp.*, e.public_id AS execution_public_id, t.public_id AS task_public_id,
            t.name AS task_name, b.status AS batch_status, b.provider AS batch_provider,
            (SELECT array_agg(DISTINCT ru.login_state ORDER BY ru.login_state)
               FROM runs ru WHERE ru.sampling_batch_id = rp.batch_id) AS login_states
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

/**
 * Single projection for a report list item. The plain and cursor-paginated
 * `/v1/tasks/{id}/reports` routes answer with the same object, so the batch columns they read
 * are mapped here once instead of twice.
 */
export function publicReportListItemFields(row) {
  return {
    platform: row.provider ?? null,
    status: TERMINAL_BATCH_STATUSES.includes(row.status) ? "ready" : "generating",
    execution_status: executionStatus(row.status),
    created_at: row.created_at ?? null,
    finished_at: row.finished_at ?? null,
  };
}

export async function listTaskReports(pool, tenantId, taskId, limit = 100) {
  const task = await getTaskInternal(pool, tenantId, taskId);
  if (!task) return null;
  const { rows } = await pool.query(
    `SELECT rp.public_id AS report_id, e.public_id AS execution_id, b.status,
            b.provider, rp.created_at, b.finished_at
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
    report_url: `/v1/reports/${row.report_id}`,
    ...publicReportListItemFields(row),
  }));
}
