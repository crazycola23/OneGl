import { ApiHttpError, readJsonBody, sendJson } from "./http.js";
import {
  bindProject,
  ensureTenantAccount,
  internalProjectName,
  requireScope,
  resolveTenantAccountKeys,
} from "./service-store.js";
import { batchDetail, createProject, getRun, getRunCitations } from "../db/dashboard.js";
import {
  createMonitorPlan,
  deleteMonitorPlan,
  getMonitorPlan,
  listMonitorExecutions,
  updateMonitorPlan,
} from "../monitoring/plans.js";
import { addQuestionEntries, countActiveKeywords } from "../project/keywords.js";
import { batchProgress, enqueueBatch, stopBatch } from "../queue/batches.js";
import { pauseBatch, resumeBatch } from "../queue/batch-control.js";
import { evaluateBatchDetail } from "../report/evaluation.js";
import { getProviderAdapter, supportedProviderIds } from "../providers/index.js";
import { buildOptimizationHtmlReport } from "../report/html-report-optimization.js";
import { buildReportContract, contractToRenderDetail } from "../reporting/report-contract.js";
import {
  buildLiveReportContract,
  createReportRevision,
  getReportRevision,
  listReportRevisions,
  revisionSummary,
} from "../reporting/revisions.js";
import { createSamplingBatch } from "../sampling/batch.js";
import {
  archiveTask,
  createTaskRow,
  ensureExecutionResourcesForBatch,
  getExecution,
  getExecutionInternal,
  getReport,
  getResult,
  getTask,
  getTaskInternal,
  listExecutionResults,
  listTaskExecutions,
  listTaskReports,
  listTasks,
  normalizeTaskInput,
  publicId,
  publicResultFields,
  replaceTaskQuestions,
  reportForExecution,
  syncTaskQuestions,
  taskHasExecutions,
  updateTaskRow,
} from "../tasks/service.js";

const MANUAL_ACCOUNT_STATES = new Set([
  "login_required",
  "session_expired",
  "verification_required",
  "access_restricted",
  "disabled",
  "paused",
]);

function positiveLimit(raw, fallback = 100, max = 500) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ApiHttpError(400, "invalid_request", `limit must be an integer between 1 and ${max}`);
  }
  return value;
}

/** Same opaque-cursor shape as the paginated history lists, scoped to this collection kind. */
function encodeRevisionCursor(id) {
  return Buffer.from(JSON.stringify({ v: 1, k: "revisions", i: Number(id) }), "utf8").toString("base64url");
}

function decodeRevisionCursor(raw) {
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    if (parsed?.v !== 1 || parsed?.k !== "revisions" || !Number.isInteger(parsed?.i) || parsed.i <= 0) {
      throw new Error("invalid cursor");
    }
    return parsed.i;
  } catch {
    throw new ApiHttpError(400, "invalid_cursor", "cursor is invalid for this collection");
  }
}

async function validateAccountIds(db, tenantId, accountIds) {
  if (!accountIds?.length) return [];
  return resolveTenantAccountKeys(db, tenantId, accountIds);
}

async function createTaskResource(db, tenant, raw) {
  const input = normalizeTaskInput(raw);
  await validateAccountIds(db, tenant.id, input.accountIds);
  const taskId = publicId("tsk");
  const internalName = internalProjectName(tenant, `task-${taskId}`);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const project = await createProject(client, {
      name: internalName,
      description: `SaaS task ${input.name}`,
      targetBrand: input.targetBrand,
    });
    const projectId = Number(project.id);
    await bindProject(client, {
      tenantId: tenant.id,
      projectId,
      displayName: input.name,
      externalId: `task:${taskId}`,
    });
    const saved = await addQuestionEntries(client, { projectId, entries: input.questionEntries });
    const created = await createTaskRow(client, { tenantId: tenant.id, projectId, publicTaskId: taskId, input });
    await replaceTaskQuestions(client, {
      tenantId: tenant.id,
      internalTaskId: Number(created.id),
      entries: input.questionEntries,
      keywords: saved.keywords,
    });
    const task = await getTask(client, tenant.id, taskId);
    await client.query("COMMIT");
    return task;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error?.code === "23505") {
      throw new ApiHttpError(409, "task_conflict", "external_id is already used by another task");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function updateTaskResource(db, tenant, taskId, raw) {
  const current = await getTask(db, tenant.id, taskId);
  const internal = await getTaskInternal(db, tenant.id, taskId);
  if (!current || !internal) throw new ApiHttpError(404, "task_not_found", "task was not found");
  const input = normalizeTaskInput(raw, current);
  await validateAccountIds(db, tenant.id, input.accountIds);

  const lockedFields = ["target_brand", "questions", "platforms", "account_ids", "sampling", "sampling_method", "repeats"];
  const changesExecutionShape = lockedFields.some((key) => Object.hasOwn(raw, key));
  if (changesExecutionShape && await taskHasExecutions(db, internal.id)) {
    throw new ApiHttpError(409, "task_locked", "questions/platforms/accounts cannot be changed after a task has execution history; clone the task instead", {
      clone_url: `/v1/tasks/${taskId}/clone`,
    });
  }

  if (Object.hasOwn(raw, "questions")) {
    await syncTaskQuestions(db, internal.project_id, input.questions);
    const saved = await addQuestionEntries(db, { projectId: internal.project_id, entries: input.questionEntries });
    await replaceTaskQuestions(db, {
      tenantId: tenant.id,
      internalTaskId: internal.id,
      entries: input.questionEntries,
      keywords: saved.keywords,
    });
  }
  await db.query("UPDATE projects SET target_brand = $2, updated_at = now() WHERE id = $1", [internal.project_id, input.targetBrand]);
  await db.query("UPDATE service_project_bindings SET display_name = $3 WHERE tenant_id = $1 AND project_id = $2", [tenant.id, internal.project_id, input.name]);
  await updateTaskRow(db, { tenantId: tenant.id, taskId, input });
  return getTask(db, tenant.id, taskId);
}

/**
 * Exported for testing rather than left inline: this gate is where a cross-platform mix-up
 * becomes silent, and it was silent until a provider filter was added to the query.
 */
export async function checkExecutionAccounts(db, tenantId, externalIds, platform) {
  if (!externalIds.length) {
    throw new ApiHttpError(422, "account_required", `at least one logged-in ${platform} account is required`);
  }
  // The platform must be carried all the way down. Resolving bindings with the default
  // provider and then matching accounts on account_key alone validated a Qianwen task
  // against whichever Doubao row shared the key - the availability gate silently evaluated
  // the wrong platform's cooldown and status.
  const resolved = await resolveTenantAccountKeys(db, tenantId, externalIds, platform);
  const keys = resolved.map((row) => row.accountKey);
  const { rows } = await db.query(
    `SELECT account_key, enabled, status, cooldown_until
       FROM accounts WHERE provider = $2 AND account_key = ANY($1::text[])`,
    [keys, platform],
  );
  const byKey = new Map(rows.map((row) => [row.account_key, row]));
  const blocked = resolved.flatMap((item) => {
    const row = byKey.get(item.accountKey);
    if (!row || !row.enabled || MANUAL_ACCOUNT_STATES.has(row.status)) {
      return [{ account_id: item.externalId, status: row?.status ?? "unknown", cooldown_until: row?.cooldown_until ?? null }];
    }
    return [];
  });
  if (blocked.length) {
    throw new ApiHttpError(409, "account_action_required", "one or more platform accounts require manual attention", { accounts: blocked });
  }
  return resolved;
}

async function createExecutionResource(db, tenant, taskId, raw = {}, triggerType = "manual", parentExecutionId = null) {
  const task = await getTask(db, tenant.id, taskId);
  const internal = await getTaskInternal(db, tenant.id, taskId);
  if (!task || !internal || task.state === "archived") throw new ApiHttpError(404, "task_not_found", "task was not found");

  const platforms = raw.platforms ?? task.platforms;
  // One platform per execution for now; anything with a registered adapter is executable, and
  // the message names what is actually available instead of asserting a single vendor.
  if (!Array.isArray(platforms) || platforms.length !== 1
    || !supportedProviderIds().includes(String(platforms[0]).toLowerCase())) {
    throw new ApiHttpError(
      422,
      "unsupported_platform",
      `platforms must be exactly one of: ${supportedProviderIds().join(", ")}`,
      { supported: supportedProviderIds() },
    );
  }
  const platform = String(platforms[0]).toLowerCase();
  const adapter = getProviderAdapter(platform);
  let accountIds = raw.account_ids ?? task.account_ids;
  // An anonymous surface has nobody logged in, but it still needs one row to carry the rate
  // limits, the queue lane and the cooldown - an unaccounted collection path is an ungoverned
  // one. So provision a per-tenant lane instead of dropping the account requirement.
  if (adapter.requiresStoredAuth === false && !accountIds?.length) {
    const lane = await ensureTenantAccount(db, {
      tenantId: tenant.id,
      provider: platform,
      externalId: `anon-${platform}`,
      label: `${platform} anonymous lane`,
    });
    accountIds = [lane.external_id];
  }
  const resolved = await checkExecutionAccounts(db, tenant.id, accountIds, platform);
  const keywordStats = await countActiveKeywords(db, internal.project_id);
  if (!keywordStats.enabled) throw new ApiHttpError(409, "question_pool_empty", "task has no active questions");

  const method = String(raw.sampling?.method ?? task.sampling.method).toLowerCase();
  const repeats = Number(raw.sampling?.repeats ?? task.sampling.repeats);
  const executionId = publicId("exe");
  const reportId = publicId("rpt");
  const created = await createSamplingBatch(db, {
    projectName: (await db.query("SELECT name FROM projects WHERE id = $1", [internal.project_id])).rows[0].name,
    name: `${task.name} · ${executionId}`,
    size: keywordStats.enabled,
    method,
    seed: raw.seed ?? null,
    accounts: resolved.map((row) => row.accountKey),
    repeats,
    provider: platform,
  }, { log: () => undefined });

  const parent = parentExecutionId
    ? await getExecutionInternal(db, tenant.id, parentExecutionId)
    : null;
  await ensureExecutionResourcesForBatch(db, {
    tenantId: tenant.id,
    internalTaskId: internal.id,
    batchId: created.batchId,
    triggerType,
    parentExecutionId: parent?.id ?? null,
    executionPublicId: executionId,
    reportPublicId: reportId,
  });

  const shouldStart = raw.start !== false;
  let start = null;
  if (shouldStart) start = await enqueueBatch(db, created.batchId, { log: () => undefined });
  const execution = await getExecution(db, tenant.id, executionId);
  return {
    ...execution,
    report_url: `/v1/reports/${reportId}`,
    results_url: `/v1/executions/${executionId}/results`,
    start,
  };
}

async function scheduleView(db, tenantId, row) {
  const plan = await getMonitorPlan(db, tenantId, Number(row.monitor_plan_id));
  if (!plan) return null;
  return {
    schedule_id: row.public_id,
    task_id: row.task_public_id,
    name: plan.name,
    enabled: plan.enabled,
    schedule: {
      cadence: plan.cadence,
      time_zone: plan.time_zone,
      local_time: plan.local_time,
      weekday: plan.weekday,
    },
    sampling: { size: plan.sample_size, method: plan.sampling_method, repeats: Number(plan.repeats) },
    account_ids: plan.accounts,
    next_run_at: plan.next_run_at,
    last_run_at: plan.last_executed_at,
    created_at: row.created_at,
  };
}

async function getScheduleMapping(db, tenantId, scheduleId) {
  const { rows } = await db.query(
    `SELECT s.*, t.public_id AS task_public_id
       FROM service_task_schedules s
       JOIN service_tasks t ON t.id = s.task_id
      WHERE s.tenant_id = $1 AND s.public_id = $2`,
    [tenantId, scheduleId],
  );
  return rows[0] ?? null;
}

async function createScheduleResource(db, tenant, taskId, raw) {
  const task = await getTask(db, tenant.id, taskId);
  const internal = await getTaskInternal(db, tenant.id, taskId);
  if (!task || !internal) throw new ApiHttpError(404, "task_not_found", "task was not found");
  const schedule = raw.schedule ?? raw;
  // Schedules are deliberately NOT opened to anonymous surfaces yet: monitor plans have no
  // platform column and monitor-worker resolves their accounts for 'doubao' only, so letting a
  // Qianwen schedule be created would produce a plan that ticks and collects nothing.
  // Opening this needs the plan's platform in the same change.
  const accounts = raw.account_ids ?? task.account_ids;
  await validateAccountIds(db, tenant.id, accounts);
  if (!accounts.length) throw new ApiHttpError(422, "account_required", "schedule requires at least one account_id");
  const plan = await createMonitorPlan(db, {
    tenantId: tenant.id,
    projectId: internal.project_id,
    input: {
      name: raw.name ?? `${task.name} 定时监测`,
      cadence: schedule.cadence,
      time_zone: schedule.time_zone,
      local_time: schedule.local_time,
      weekday: schedule.weekday,
      size: raw.sampling?.size ?? null,
      method: raw.sampling?.method ?? task.sampling.method,
      repeats: raw.sampling?.repeats ?? task.sampling.repeats,
      accounts,
      enabled: raw.enabled !== false,
    },
  });
  const scheduleId = publicId("sch");
  const { rows } = await db.query(
    `INSERT INTO service_task_schedules (public_id, tenant_id, task_id, monitor_plan_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *, $5::text AS task_public_id`,
    [scheduleId, tenant.id, internal.id, plan.id, taskId],
  );
  return scheduleView(db, tenant.id, rows[0]);
}

export async function handleTaskRoute({ req, res, url, db, auth, tenant }) {
  const pathname = url.pathname;

  if (pathname === "/v1/tasks") {
    if (req.method === "GET") {
      requireScope(auth, "projects:read");
      return sendJson(res, 200, { data: await listTasks(db, tenant.id, positiveLimit(url.searchParams.get("limit"))) });
    }
    if (req.method === "POST") {
      requireScope(auth, "projects:write");
      return sendJson(res, 201, { data: await createTaskResource(db, tenant, await readJsonBody(req)) });
    }
  }

  const taskRoute = pathname.match(/^\/v1\/tasks\/(tsk_[a-f0-9]+)$/);
  if (taskRoute) {
    const taskId = taskRoute[1];
    if (req.method === "GET") {
      requireScope(auth, "projects:read");
      const task = await getTask(db, tenant.id, taskId);
      if (!task) throw new ApiHttpError(404, "task_not_found", "task was not found");
      return sendJson(res, 200, { data: task });
    }
    if (req.method === "PATCH") {
      requireScope(auth, "projects:write");
      return sendJson(res, 200, { data: await updateTaskResource(db, tenant, taskId, await readJsonBody(req)) });
    }
    if (req.method === "DELETE") {
      requireScope(auth, "projects:write");
      if (!(await archiveTask(db, tenant.id, taskId))) throw new ApiHttpError(404, "task_not_found", "task was not found");
      return sendJson(res, 200, { data: { task_id: taskId, archived: true } });
    }
  }

  const cloneTask = pathname.match(/^\/v1\/tasks\/(tsk_[a-f0-9]+)\/clone$/);
  if (req.method === "POST" && cloneTask) {
    requireScope(auth, "projects:write");
    const source = await getTask(db, tenant.id, cloneTask[1]);
    if (!source) throw new ApiHttpError(404, "task_not_found", "task was not found");
    const overrides = await readJsonBody(req);
    return sendJson(res, 201, { data: await createTaskResource(db, tenant, {
      name: `${source.name} 副本`,
      target_brand: source.target_brand,
      questions: source.question_entries?.length ? source.question_entries : source.questions,
      platforms: source.platforms,
      account_ids: source.account_ids,
      sampling: source.sampling,
      ...overrides,
    }) });
  }

  const taskExecutions = pathname.match(/^\/v1\/tasks\/(tsk_[a-f0-9]+)\/executions$/);
  if (taskExecutions) {
    if (req.method === "GET") {
      requireScope(auth, "batches:read");
      const data = await listTaskExecutions(db, tenant.id, taskExecutions[1], positiveLimit(url.searchParams.get("limit")));
      if (!data) throw new ApiHttpError(404, "task_not_found", "task was not found");
      return sendJson(res, 200, { data });
    }
    if (req.method === "POST") {
      requireScope(auth, "batches:write");
      const existing = await listTaskExecutions(db, tenant.id, taskExecutions[1], 1);
      if (existing == null) throw new ApiHttpError(404, "task_not_found", "task was not found");
      const body = await readJsonBody(req);
      const trigger = existing.length ? "rerun" : "manual";
      return sendJson(res, 202, { data: await createExecutionResource(db, tenant, taskExecutions[1], body, trigger, existing[0]?.execution_id ?? null) });
    }
  }

  const executionRoute = pathname.match(/^\/v1\/executions\/(exe_[a-f0-9]+)$/);
  if (req.method === "GET" && executionRoute) {
    requireScope(auth, "batches:read");
    const execution = await getExecution(db, tenant.id, executionRoute[1]);
    if (!execution) throw new ApiHttpError(404, "execution_not_found", "execution was not found");
    if (execution.status === "running" || execution.status === "queued") {
      const internal = await getExecutionInternal(db, tenant.id, executionRoute[1]);
      if (internal?.batch_id) await batchProgress(db, Number(internal.batch_id));
    }
    return sendJson(res, 200, { data: await getExecution(db, tenant.id, executionRoute[1]) });
  }

  const executionAction = pathname.match(/^\/v1\/executions\/(exe_[a-f0-9]+)\/(pause|resume|cancel)$/);
  if (req.method === "POST" && executionAction) {
    requireScope(auth, "batches:write");
    const execution = await getExecutionInternal(db, tenant.id, executionAction[1]);
    if (!execution?.batch_id) throw new ApiHttpError(404, "execution_not_found", "execution was not found");
    const batchId = Number(execution.batch_id);
    let result;
    if (executionAction[2] === "pause") result = await pauseBatch(db, batchId);
    else if (executionAction[2] === "resume") result = await resumeBatch(db, batchId);
    else result = await stopBatch(db, batchId, { log: () => undefined });
    if (!(result.paused ?? result.resumed ?? result.stopped)) {
      throw new ApiHttpError(409, "invalid_execution_state", result.reason ?? "execution cannot perform this action");
    }
    return sendJson(res, 200, { data: { ...(await getExecution(db, tenant.id, executionAction[1])), control: result } });
  }

  const executionResults = pathname.match(/^\/v1\/executions\/(exe_[a-f0-9]+)\/results$/);
  if (req.method === "GET" && executionResults) {
    requireScope(auth, "reports:read");
    const data = await listExecutionResults(db, tenant.id, executionResults[1]);
    if (!data) throw new ApiHttpError(404, "execution_not_found", "execution was not found");
    return sendJson(res, 200, { data });
  }

  const resultRoute = pathname.match(/^\/v1\/results\/(res_[a-f0-9]+)$/);
  if (req.method === "GET" && resultRoute) {
    requireScope(auth, "reports:read");
    const result = await getResult(db, tenant.id, resultRoute[1]);
    if (!result) throw new ApiHttpError(404, "result_not_found", "result was not found");
    if (!result.run_db_id) {
      return sendJson(res, 200, { data: {
        result_id: result.public_id,
        task_id: result.task_public_id,
        execution_id: result.execution_public_id,
        platform: result.platform,
        question: result.question,
        status: "pending",
        citations: [],
        ...publicResultFields(result),
      } });
    }
    const run = await getRun(db, result.run_id);
    const citations = await getRunCitations(db, Number(result.run_db_id));
    return sendJson(res, 200, { data: {
      result_id: result.public_id,
      task_id: result.task_public_id,
      execution_id: result.execution_public_id,
      platform: result.platform,
      question: result.question,
      status: run.status,
      answer: {
        text: run.answer_text ?? run.answer ?? null,
        brand_mentioned: run.brand_mentioned,
        mention_count: run.mention_count == null ? null : Number(run.mention_count),
      },
      citations,
      started_at: run.started_at,
      finished_at: run.finished_at,
      ...publicResultFields(result),
    } });
  }

  const executionReport = pathname.match(/^\/v1\/executions\/(exe_[a-f0-9]+)\/report$/);
  if (req.method === "GET" && executionReport) {
    requireScope(auth, "reports:read");
    const reportId = await reportForExecution(db, tenant.id, executionReport[1]);
    if (!reportId) throw new ApiHttpError(404, "report_not_found", "report was not found");
    url.pathname = `/v1/reports/${reportId}`;
    return handleTaskRoute({ req, res, url, db, auth, tenant });
  }

  const executionReportContract = pathname.match(/^\/v1\/executions\/(exe_[a-f0-9]+)\/report\/contract$/);
  if (req.method === "GET" && executionReportContract) {
    requireScope(auth, "reports:read");
    const reportId = await reportForExecution(db, tenant.id, executionReportContract[1]);
    if (!reportId) throw new ApiHttpError(404, "report_not_found", "report was not found");
    url.pathname = `/v1/reports/${reportId}/contract`;
    return handleTaskRoute({ req, res, url, db, auth, tenant });
  }

  const reportContract = pathname.match(/^\/v1\/reports\/(rpt_[a-f0-9]+)\/contract$/);
  if (req.method === "GET" && reportContract) {
    requireScope(auth, "reports:read");
    const report = await getReport(db, tenant.id, reportContract[1]);
    if (!report) throw new ApiHttpError(404, "report_not_found", "report was not found");
    const { contract } = await buildLiveReportContract(db, { tenantId: tenant.id, report });
    return sendJson(res, 200, { data: contract });
  }

  const reportRevisions = pathname.match(/^\/v1\/reports\/(rpt_[a-f0-9]+)\/revisions$/);
  if (reportRevisions) {
    const report = await getReport(db, tenant.id, reportRevisions[1]);
    if (!report) throw new ApiHttpError(404, "report_not_found", "report was not found");
    if (req.method === "POST") {
      requireScope(auth, "reports:read");
      const { contract } = await buildLiveReportContract(db, { tenantId: tenant.id, report });
      const saved = await createReportRevision(db, { tenantId: tenant.id, report, contract });
      return sendJson(res, saved.created ? 201 : 200, { data: {
        ...revisionSummary(saved.row),
        created: saved.created,
        replayed: !saved.created,
        contract: saved.row.payload,
      } });
    }
    if (req.method === "GET") {
      requireScope(auth, "reports:read");
      const limit = positiveLimit(url.searchParams.get("limit"), 100, 500);
      const rawCursor = url.searchParams.get("cursor");
      let cursor = null;
      if (rawCursor) {
        const decoded = decodeRevisionCursor(rawCursor);
        cursor = decoded;
      }
      const rows = await listReportRevisions(db, { tenantId: tenant.id, reportId: report.id, limit, cursor });
      const visible = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return sendJson(res, 200, {
        data: visible.map(revisionSummary),
        meta: {
          has_more: hasMore,
          next_cursor: hasMore && visible.length ? encodeRevisionCursor(visible[visible.length - 1].id) : null,
        },
      });
    }
  }

  const reportRevisionArtifact = pathname.match(
    /^\/v1\/reports\/(rpt_[a-f0-9]+)\/revisions\/([1-9]\d{0,8})\/artifact$/,
  );
  const reportRevisionRoute = pathname.match(/^\/v1\/reports\/(rpt_[a-f0-9]+)\/revisions\/([1-9]\d{0,8})$/);
  if (req.method === "GET" && (reportRevisionRoute || reportRevisionArtifact)) {
    requireScope(auth, "reports:read");
    const match = (reportRevisionRoute ?? reportRevisionArtifact)[1];
    const revision = Number((reportRevisionRoute ?? reportRevisionArtifact)[2]);
    const report = await getReport(db, tenant.id, match);
    if (!report) throw new ApiHttpError(404, "report_not_found", "report was not found");
    const row = await getReportRevision(db, { tenantId: tenant.id, reportId: report.id, revision });
    if (!row) throw new ApiHttpError(404, "revision_not_found", "report revision was not found");
    if (!reportRevisionArtifact) {
      return sendJson(res, 200, { data: { ...revisionSummary(row), contract: row.payload } });
    }

    const format = (url.searchParams.get("format") ?? "json").toLowerCase();
    const baseHeaders = {
      etag: `"${row.content_hash}"`,
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
    };
    if (format === "json") {
      const body = JSON.stringify(row.payload, null, 2);
      res.writeHead(200, {
        ...baseHeaders,
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "content-disposition": `attachment; filename="report-${report.public_id}-r${revision}.json"`,
      });
      res.end(body);
      return true;
    }
    if (format !== "html") {
      throw new ApiHttpError(400, "invalid_request", "format must be json or html");
    }
    const detail = contractToRenderDetail(row.payload);
    const html = buildOptimizationHtmlReport(detail, evaluateBatchDetail(detail), {
      generatedAt: new Date(row.created_at).toISOString(),
      title: `${detail.report?.batch?.name ?? report.public_id} · revision ${revision}`,
      subtitle: `冻结快照 ${row.public_id}（content_hash ${row.content_hash.slice(0, 12)}…）`,
    });
    res.writeHead(200, {
      ...baseHeaders,
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "content-disposition": `attachment; filename="report-${report.public_id}-r${revision}.html"`,
    });
    res.end(html);
    return true;
  }

  const reportRoute = pathname.match(/^\/v1\/reports\/(rpt_[a-f0-9]+)$/);
  if (req.method === "GET" && reportRoute) {
    requireScope(auth, "reports:read");
    const report = await getReport(db, tenant.id, reportRoute[1]);
    if (!report) throw new ApiHttpError(404, "report_not_found", "report was not found");
    const terminal = ["completed", "partial", "failed", "aborted"].includes(report.batch_status);
    const detail = await batchDetail(db, Number(report.batch_id));
    const execution = await getExecution(db, tenant.id, report.execution_public_id);
    const contract = buildReportContract({ detail, execution, report, revision: 0 });
    return sendJson(res, 200, { data: {
      report_id: report.public_id,
      task_id: report.task_public_id,
      execution_id: report.execution_public_id,
      status: terminal ? "ready" : "generating",
      execution_status: report.batch_status === "aborted" ? "cancelled" : report.batch_status,
      report_url: `/v1/reports/${report.public_id}`,
      summary: detail.report ?? null,
      sources: detail.sources ?? null,
      intelligence: detail.intelligence ?? null,
      created_at: report.created_at,
      contract_url: `/v1/reports/${report.public_id}/contract`,
      versions: contract.versions,
      collection: contract.collection,
      analysis: contract.analysis,
      readiness: contract.readiness,
    } });
  }

  const taskReports = pathname.match(/^\/v1\/tasks\/(tsk_[a-f0-9]+)\/reports$/);
  if (req.method === "GET" && taskReports) {
    requireScope(auth, "reports:read");
    const data = await listTaskReports(db, tenant.id, taskReports[1], positiveLimit(url.searchParams.get("limit")));
    if (!data) throw new ApiHttpError(404, "task_not_found", "task was not found");
    return sendJson(res, 200, { data });
  }

  const taskSchedules = pathname.match(/^\/v1\/tasks\/(tsk_[a-f0-9]+)\/schedules$/);
  if (taskSchedules) {
    if (req.method === "POST") {
      requireScope(auth, "batches:write");
      return sendJson(res, 201, { data: await createScheduleResource(db, tenant, taskSchedules[1], await readJsonBody(req)) });
    }
    if (req.method === "GET") {
      requireScope(auth, "batches:read");
      const task = await getTaskInternal(db, tenant.id, taskSchedules[1]);
      if (!task) throw new ApiHttpError(404, "task_not_found", "task was not found");
      const { rows } = await db.query(
        `SELECT s.*, t.public_id AS task_public_id
           FROM service_task_schedules s
           JOIN service_tasks t ON t.id = s.task_id
          WHERE s.tenant_id = $1 AND s.task_id = $2
          ORDER BY s.id DESC`,
        [tenant.id, task.id],
      );
      const data = [];
      for (const row of rows) data.push(await scheduleView(db, tenant.id, row));
      return sendJson(res, 200, { data: data.filter(Boolean) });
    }
  }

  const scheduleRoute = pathname.match(/^\/v1\/schedules\/(sch_[a-f0-9]+)$/);
  if (scheduleRoute) {
    const mapping = await getScheduleMapping(db, tenant.id, scheduleRoute[1]);
    if (!mapping) throw new ApiHttpError(404, "schedule_not_found", "schedule was not found");
    if (req.method === "GET") {
      requireScope(auth, "batches:read");
      return sendJson(res, 200, { data: await scheduleView(db, tenant.id, mapping) });
    }
    if (req.method === "PATCH") {
      requireScope(auth, "batches:write");
      const body = await readJsonBody(req);
      const task = await getTask(db, tenant.id, mapping.task_public_id);
      const schedule = body.schedule ?? body;
      const accounts = body.account_ids ?? undefined;
      if (accounts !== undefined) await validateAccountIds(db, tenant.id, accounts);
      await updateMonitorPlan(db, {
        tenantId: tenant.id,
        planId: Number(mapping.monitor_plan_id),
        input: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(schedule.cadence !== undefined ? { cadence: schedule.cadence } : {}),
          ...(schedule.time_zone !== undefined ? { time_zone: schedule.time_zone } : {}),
          ...(schedule.local_time !== undefined ? { local_time: schedule.local_time } : {}),
          ...(schedule.weekday !== undefined ? { weekday: schedule.weekday } : {}),
          ...(body.sampling?.size !== undefined ? { size: body.sampling.size } : {}),
          ...(body.sampling?.method !== undefined ? { method: body.sampling.method } : {}),
          ...(body.sampling?.repeats !== undefined ? { repeats: body.sampling.repeats } : {}),
          ...(accounts !== undefined ? { accounts } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        },
      });
      await db.query("UPDATE service_task_schedules SET updated_at = now() WHERE id = $1", [mapping.id]);
      return sendJson(res, 200, { data: await scheduleView(db, tenant.id, mapping) });
    }
    if (req.method === "DELETE") {
      requireScope(auth, "batches:write");
      await deleteMonitorPlan(db, tenant.id, Number(mapping.monitor_plan_id));
      return sendJson(res, 200, { data: { schedule_id: mapping.public_id, deleted: true } });
    }
  }

  const scheduleExecutions = pathname.match(/^\/v1\/schedules\/(sch_[a-f0-9]+)\/executions$/);
  if (req.method === "GET" && scheduleExecutions) {
    requireScope(auth, "batches:read");
    const mapping = await getScheduleMapping(db, tenant.id, scheduleExecutions[1]);
    if (!mapping) throw new ApiHttpError(404, "schedule_not_found", "schedule was not found");
    const occurrences = await listMonitorExecutions(db, tenant.id, Number(mapping.monitor_plan_id), positiveLimit(url.searchParams.get("limit"), 50, 200));
    const data = [];
    for (const occurrence of occurrences) {
      let executionId = null;
      if (occurrence.batch_id) {
        const { rows } = await db.query("SELECT public_id FROM service_task_executions WHERE batch_id = $1", [occurrence.batch_id]);
        executionId = rows[0]?.public_id ?? null;
      }
      data.push({
        scheduled_for: occurrence.scheduled_for,
        status: occurrence.status === "skipped" ? "action_required" : occurrence.status,
        execution_id: executionId,
        batch_created: Boolean(occurrence.batch_id),
        details: occurrence.details,
        error: occurrence.last_error,
      });
    }
    return sendJson(res, 200, { data });
  }

  return false;
}
