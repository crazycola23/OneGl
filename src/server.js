import "dotenv/config";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "./config.js";
import { RunStore } from "./store.js";
import { createPool, isDatabaseConfigured } from "./db/pool.js";
import {
  batchDetail,
  countOverview,
  createProject,
  databaseReady,
  getProject,
  getRun,
  getRunCitations,
  listAccounts,
  listActiveBatches,
  listBatches,
  listProjects,
  listRuns,
  poolByCategory,
  runFilterOptions,
  sourceAggregates,
  trackedArticles,
} from "./db/dashboard.js";
import { ensureAccounts } from "./db/persist.js";
import { resumeAccount, setAccountEnabled } from "./accounts/safety.js";
import { batchProgress, enqueueBatch, stopBatch } from "./queue/batches.js";
import { isQueueConfigured } from "./queue/connection.js";
import {
  addKeywords,
  countActiveKeywords,
  deleteKeyword,
  listProjectKeywords,
  restoreKeyword,
  setKeywordEnabled,
} from "./project/keywords.js";
import { createSamplingBatch } from "./sampling/batch.js";
import {
  ACCOUNT_STATUS_LABELS,
  CONNECTION_STATES,
  WORKER_STATES,
  buildSystemStatus,
  cachedSystemStatus,
  setCachedSystemStatus,
} from "./system/status.js";
import {
  accountsPage,
  batchPage,
  batchesPage,
  errorPage,
  homePage,
  notFoundPage,
  projectKeywordsPage,
  projectOverviewPage,
  projectRunsPage,
  projectSamplingPage,
  projectSourcesPage,
  projectsPage,
  runPage,
  runsPage,
  sourcesPage,
  systemPage,
} from "./ui/pages.js";
import { statusLabel } from "./ui/format.js";

/**
 * OneGl 操作台。
 *
 * 读取：系统就绪状态、项目、关键词池、批次、运行、引用来源、账号。
 * 写入：项目创建、关键词增删启停、抽样批次创建、批次开始/停止、账号恢复/启停。
 *
 * 网页端可以直接启动批次（BullMQ → Worker）；命令行保留为高级与故障排查方式。
 * 只监听 127.0.0.1，没有登录鉴权，因此不能暴露到公网。
 */
const config = loadConfig();
const store = new RunStore(config);
const pool = isDatabaseConfigured() ? createPool() : null;

let dbState = {
  ready: false,
  message: pool ? "数据库连接中" : "DATABASE_URL 未配置",
};

async function refreshDatabaseState() {
  if (!pool) {
    dbState = { ready: false, message: "DATABASE_URL 未配置" };
    return;
  }
  const result = await databaseReady(pool);
  dbState = result.ready
    ? { ready: true, message: "" }
    : { ready: false, message: `数据库连接失败：${result.message}` };
}

/* ------------------------------------------------------------ 系统状态 */

const SYSTEM_CACHE_MS = 2_000;

async function collectSystemStatus() {
  let accounts = [];
  let activeBatches = [];
  if (dbState.ready) {
    [accounts, activeBatches] = await Promise.all([
      listAccounts(pool).catch(() => []),
      listActiveBatches(pool).catch(() => []),
    ]);
  }
  const status = await buildSystemStatus({
    pool: dbState.ready ? pool : null,
    accounts,
    activeBatches,
  });
  setCachedSystemStatus(status);
  return status;
}

/** 每个请求都保证拿到足够新的系统状态，同时避免高频重复探测。 */
async function ensureSystemStatus() {
  const cached = cachedSystemStatus();
  if (cached && Date.now() - Date.parse(cached.at) < SYSTEM_CACHE_MS) return cached;
  return collectSystemStatus();
}

/** 总览页的「待处理」：只放真正需要人介入或需要看一眼的事。 */
function buildAttention(system, { partialBatches = [], recentFailures = [] } = {}) {
  const items = [];

  for (const account of system.accounts?.manual_attention ?? []) {
    items.push({
      tag: "账号",
      tone: "bad",
      label: `${account.account_key} 需要人工处理`,
      detail: ACCOUNT_STATUS_LABELS[account.status] ?? account.status ?? "",
      fix: "在浏览器中重新登录或完成人机验证，然后到「账号」页点「恢复」",
    });
  }

  for (const batch of partialBatches) {
    items.push({
      tag: "批次",
      tone: "warn",
      label: `批次 #${batch.id} 结果是「部分成功」`,
      detail: `${batch.project_name} · 有效 ${batch.valid_runs} / 失败 ${batch.failed_runs}`,
      fix: "打开批次页查看失败原因与样本口径",
    });
  }

  if (recentFailures.length) {
    items.push({
      tag: "运行",
      tone: batchToneForFailures(recentFailures),
      label: `最近有 ${recentFailures.length} 条运行失败`,
      detail: recentFailures
        .slice(0, 3)
        .map((run) => `${run.local_run_id}（${run.error_code}）`)
        .join("、"),
      fix: "在「运行记录」按错误码筛选，或直接打开运行详情看 error_details",
    });
  }

  return items;
}

function batchToneForFailures(failures) {
  return failures.length >= 3 ? "bad" : "warn";
}

/* -------------------------------------------------------------- 本地产物 */

async function readLocalRuns() {
  try {
    return await store.listRuns();
  } catch {
    return [];
  }
}

async function readLocalRun(runId) {
  try {
    return await store.readRun(runId);
  } catch {
    return null;
  }
}

/** 本地产物里的引用字段名与数据库列名不同，统一成页面使用的形状。 */
function normalizeLocalCitations(citations) {
  return (citations ?? []).map((citation, index) => ({
    source_position: citation.sourcePosition ?? index + 1,
    title: citation.title ?? null,
    original_url: citation.url ?? null,
    canonical_url: citation.canonicalUrl ?? null,
    domain: citation.domain ?? null,
    normalized_domain: citation.domain ?? null,
    relation_status: citation.relationStatus ?? "unresolved",
    captured_from: citation.capturedFrom ?? "FALLBACK",
    source_type: citation.sourceType ?? "visible",
    visible_to_user: citation.visibleToUser !== false,
    tracked_article_id: null,
  }));
}

/* ---------------------------------------------------------------- 传输 */

function send(res, status, content, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(content);
}

function redirectWithNotice(res, pathname, message, tone = "ok") {
  const target = new URLSearchParams();
  target.set("notice", message);
  if (tone !== "ok") target.set("tone", tone);
  res.writeHead(303, { location: `${pathname}?${target.toString()}` });
  res.end();
}

function readNotice(searchParams) {
  const message = searchParams.get("notice");
  if (!message) return null;
  return { message, tone: searchParams.get("tone") === "warn" ? "warn" : "ok" };
}

const MAX_BODY_BYTES = 512 * 1024;

/**
 * 表单解析。重复出现的字段（例如账号复选框）会变成数组，
 * 其余保持字符串，调用方用 asList() 统一取值。
 */
async function readFormBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("提交内容过大");
    chunks.push(chunk);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const fields = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    fields[key] = values.length > 1 ? values : values[0];
  }
  return fields;
}

function asList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => String(entry).trim()).filter(Boolean);
}

/**
 * 跨站表单防护。服务没有登录态，所以真正的边界是「只监听回环地址」；
 * 这里再拒绝一次来源不匹配的 POST，避免浏览器里的其他页面代发请求。
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 读取 */

/**
 * 总览页展示执行中批次时需要计数，而 listActiveBatches 返回的是数据库行。
 * 这里统一成页面使用的形状；active/waiting 需要 Redis 才能精确知道，
 * 因此不猜，只按「还没有结论的数量」反推剩余。
 */
function activeBatchView(row) {
  const requested = Number(row.requested_jobs ?? 0);
  const completed = Number(row.completed_jobs ?? 0);
  const failed = Number(row.failed_jobs ?? 0);
  const skipped = Number(row.skipped_jobs ?? 0);
  const done = completed + failed + skipped;
  return {
    batch: row,
    counts: {
      requested,
      completed,
      failed,
      skipped,
      active: 0,
      waiting: Math.max(0, requested - done),
      done,
      percent: requested ? Math.round((done / requested) * 100) : 0,
    },
  };
}

async function handleHome(system) {
  const localRuns = await readLocalRuns();
  const overview = dbState.ready
    ? await countOverview(pool)
    : {
        projects: 0,
        prompts: 0,
        batches: 0,
        runs: localRuns.length,
        articles: 0,
        citations: 0,
        accounts: 0,
      };

  let batches = [];
  const activeBatches = (system.activeBatches ?? []).map(activeBatchView);
  let recentFailures = [];
  let partialBatches = [];

  if (dbState.ready) {
    const [batchRows, failures] = await Promise.all([
      listBatches(pool, { limit: 8 }),
      listRuns(pool, { status: "failed", limit: 5 }),
    ]);
    batches = batchRows;
    recentFailures = failures;
    partialBatches = batchRows.filter((row) => row.status === "partial").slice(0, 3);
  }

  return homePage({
    db: dbState,
    system,
    overview,
    batches,
    activeBatches,
    attention: buildAttention(system, { partialBatches, recentFailures }),
    recentFailures,
    localRuns: localRuns.slice(0, 20),
    localRunCount: localRuns.length,
  });
}

async function handleBatches(searchParams, system) {
  const projectId = searchParams.get("project");
  const batches = dbState.ready
    ? await listBatches(pool, { projectId: projectId ?? null, limit: 100 })
    : [];
  const projects = dbState.ready ? await listProjects(pool) : [];
  return batchesPage({ db: dbState, batches, projects, projectId, system });
}

async function handleBatch(batchId, system) {
  if (!dbState.ready) throw new Error("未连接数据库，无法读取批次详情");
  const detail = await batchDetail(pool, batchId);
  const progress = await batchProgress(pool, batchId).catch(() => null);
  return batchPage({
    ...detail,
    progress,
    queueReady: isQueueConfigured(),
    system,
  });
}

async function handleAccounts(searchParams, system) {
  if (!dbState.ready) {
    return accountsPage({
      accounts: [],
      notice: "未连接数据库，无法读取账号状态。",
      system,
    });
  }
  return accountsPage({
    accounts: await listAccounts(pool),
    notice: readNotice(searchParams)?.message ?? null,
    system,
    dailyLimit: Number(process.env.ONEGL_ACCOUNT_DAILY_LIMIT ?? 60),
  });
}

async function handleSystem(system) {
  return systemPage({
    system,
    db: dbState,
    config: {
      port: config.port,
      dataDir: config.dataDir,
      browser: config.browser,
      doubaoUrl: config.doubaoUrl,
      accountTimeZone: process.env.ONEGL_ACCOUNT_TIMEZONE ?? "Asia/Shanghai",
      dailyLimit: Number(process.env.ONEGL_ACCOUNT_DAILY_LIMIT ?? 60),
      cooldownMinutes: Number(process.env.ONEGL_ACCOUNT_COOLDOWN_MINUTES ?? 30),
      parallelism: Number(process.env.ONEGL_ACCOUNT_PARALLELISM ?? 1),
      heartbeatIntervalSeconds: 10,
      heartbeatOnlineSeconds: 30,
      heartbeatDegradedSeconds: 90,
    },
  });
}

async function handleBatchProgress(batchId) {
  if (!dbState.ready) return null;
  const progress = await batchProgress(pool, batchId);
  if (!progress) return null;
  return {
    batchId: progress.batch.id,
    status: progress.batch.status,
    statusLabel: statusLabel(progress.batch.status),
    active: progress.active,
    counts: progress.counts,
  };
}

async function handleRuns(searchParams, system) {
  const filters = {
    status: searchParams.get("status"),
    projectId: searchParams.get("project"),
    batchId: searchParams.get("batch"),
    account: searchParams.get("account"),
    errorCode: searchParams.get("error"),
  };

  if (!dbState.ready) {
    return runsPage({
      db: dbState,
      system,
      runs: [],
      projects: [],
      localRuns: await readLocalRuns(),
      filters,
    });
  }

  const [runs, projects, accounts, batches, options] = await Promise.all([
    listRuns(pool, {
      status: filters.status ?? null,
      projectId: filters.projectId ?? null,
      batchId: filters.batchId ?? null,
      accountKey: filters.account ?? null,
      errorCode: filters.errorCode ?? null,
      limit: 150,
    }),
    listProjects(pool),
    listAccounts(pool),
    listBatches(pool, { limit: 60 }),
    runFilterOptions(pool),
  ]);

  return runsPage({
    db: dbState,
    system,
    runs,
    projects,
    accounts: options.accounts.length ? options.accounts : accounts.map((row) => row.account_key),
    batches,
    errorCodes: options.errorCodes,
    filters,
    localRuns: [],
  });
}

async function handleRun(runId, system) {
  const localRun = await readLocalRun(runId);
  let run = null;
  let citations = null;

  if (dbState.ready) {
    run = await getRun(pool, runId);
    if (run) citations = await getRunCitations(pool, run.id);
  }
  if (!run && localRun) citations = normalizeLocalCitations(localRun.citations);

  // 磁盘上真实存在的 attempt 目录，界面据此给出调试产物链接。
  // 旧布局（产物直接放在运行根目录）没有 attempts/ 子目录，单独兜一层，
  // 否则历史 Run 在调试页面上会看不到任何产物。
  const attempts = await store.listAttemptArtifacts(runId).catch(() => []);
  const rootArtifacts = attempts.length
    ? []
    : await store.listRootArtifacts(runId).catch(() => []);

  return runPage({ db: dbState, system, run, citations, localRun, attempts, rootArtifacts, runId });
}

async function handleSources(searchParams, system) {
  if (!dbState.ready) {
    return sourcesPage({
      db: dbState,
      system,
      sources: { domains: [], articles: [], totals: { citations: 0, articles: 0, domains: 0 } },
      projects: [],
      projectId: null,
    });
  }
  const projectId = searchParams.get("project");
  const sources = await sourceAggregates(pool, { projectId: projectId ?? null, limit: 30 });
  return sourcesPage({
    db: dbState,
    system,
    sources,
    projects: await listProjects(pool),
    projectId,
  });
}

async function handleProjects(searchParams, system) {
  const projects = dbState.ready ? await listProjects(pool) : [];
  return projectsPage({ db: dbState, projects, notice: readNotice(searchParams), system });
}

/** 项目下的标签页。projectId 无效时返回 null，由调用方给出 404。 */
async function handleProjectTab(projectId, tab, searchParams, system) {
  if (!dbState.ready) throw new Error("未连接数据库，无法读取项目详情");
  const project = await getProject(pool, projectId);
  if (!project) return null;

  const dailyLimit = Number(process.env.ONEGL_ACCOUNT_DAILY_LIMIT ?? 60);

  if (tab === "keywords") {
    const [keywords, stats] = await Promise.all([
      listProjectKeywords(pool, projectId),
      countActiveKeywords(pool, projectId),
    ]);
    return projectKeywordsPage({
      project,
      keywords,
      stats,
      system,
      notice: readNotice(searchParams)?.message ?? null,
    });
  }

  if (tab === "sampling") {
    const [batches, accounts, stats] = await Promise.all([
      listBatches(pool, { projectId, limit: 100 }),
      listAccounts(pool),
      countActiveKeywords(pool, projectId),
    ]);
    return projectSamplingPage({
      project,
      batches,
      accounts,
      stats,
      system,
      dailyLimit,
      notice: readNotice(searchParams)?.message ?? null,
    });
  }

  if (tab === "runs") {
    const runs = await listRuns(pool, { projectId, limit: 200 });
    return projectRunsPage({ project, runs, system });
  }

  if (tab === "sources") {
    const sources = await sourceAggregates(pool, { projectId, limit: 30 });
    return projectSourcesPage({ project, sources, system });
  }

  const [pool_, tracked, accounts, batches, keywordStats] = await Promise.all([
    poolByCategory(pool, projectId),
    trackedArticles(pool, projectId),
    listAccounts(pool),
    listBatches(pool, { projectId, limit: 20 }),
    countActiveKeywords(pool, projectId),
  ]);
  return projectOverviewPage({
    project,
    pool: pool_,
    tracked,
    accounts,
    batches,
    keywordStats,
    system,
    dailyLimit,
  });
}

/* ------------------------------------------------------------------ 写入 */

async function handleCreateProject(res, form) {
  const { id, created } = await createProject(pool, {
    name: form.name,
    description: form.description?.trim() || null,
    targetBrand: form.targetBrand?.trim() || null,
  });
  if (!created) {
    return redirectWithNotice(res, "/projects", "该项目名称已存在，已跳转到现有项目。", "warn");
  }
  return redirectWithNotice(
    res,
    `/projects/${id}/keywords`,
    "项目已创建，请在下方录入关键词。",
  );
}

async function handleAddKeywords(res, projectId, form) {
  const result = await addKeywords(pool, {
    projectId,
    input: form.input,
    category: form.category?.trim() || null,
  });

  const parts = [];
  if (result.added) parts.push(`新增 ${result.added} 条`);
  if (result.revived) parts.push(`已存在并启用 ${result.revived} 条`);
  if (result.duplicates) parts.push(`输入内重复忽略 ${result.duplicates} 条`);
  if (!parts.length) parts.push("没有可保存的关键词（输入为空）");

  const tone = result.added || result.revived ? "ok" : "warn";
  return redirectWithNotice(res, `/projects/${projectId}/keywords`, parts.join("，"), tone);
}

async function handleKeywordAction(res, projectId, promptId, action, form) {
  const back = `/projects/${projectId}/keywords`;
  if (action === "toggle") {
    const enabled = form.enabled !== "false";
    const ok = await setKeywordEnabled(pool, { projectId, promptId, enabled });
    return redirectWithNotice(
      res,
      back,
      ok ? (enabled ? "已启用该关键词。" : "已禁用该关键词。") : "未找到该关键词。",
      ok ? "ok" : "warn",
    );
  }
  if (action === "delete") {
    const ok = await deleteKeyword(pool, { projectId, promptId });
    return redirectWithNotice(
      res,
      back,
      ok ? "已删除该关键词（历史运行记录与批次保留）。" : "未找到该关键词。",
      ok ? "ok" : "warn",
    );
  }
  if (action === "restore") {
    const ok = await restoreKeyword(pool, { projectId, promptId });
    return redirectWithNotice(res, back, ok ? "已恢复该关键词。" : "该关键词无需恢复。", ok ? "ok" : "warn");
  }
  throw new Error(`未知的关键词操作：${action}`);
}

async function handleCreateBatch(res, projectId, form) {
  const back = `/projects/${projectId}/sampling`;
  const project = await getProject(pool, projectId);
  if (!project) throw new Error(`未找到项目（id=${projectId}）`);

  const stats = await countActiveKeywords(pool, projectId);
  if (!stats.enabled) {
    return redirectWithNotice(res, back, "该项目没有启用中的关键词，无法抽样。", "warn");
  }

  const size = Number(form.size ?? 0);
  if (!Number.isInteger(size) || size <= 0) {
    return redirectWithNotice(res, back, "抽样数量必须是正整数。", "warn");
  }

  const accounts = asList(form.accounts);
  if (!accounts.length) {
    return redirectWithNotice(res, back, "至少选择一个账号。", "warn");
  }

  // 只允许选用当前真正可用的账号，避免把明显跑不了的账号排进批次。
  const accountRows = await listAccounts(pool);
  const usable = new Set(
    accountRows.filter((row) => row.enabled && isAccountExecutable(row)).map((row) => row.account_key),
  );
  const blocked = accounts.filter((key) => !usable.has(key));
  if (blocked.length) {
    return redirectWithNotice(
      res,
      back,
      `账号 ${blocked.join("、")} 当前不可执行（冷却中或需要人工处理），请先在「账号」页处理。`,
      "warn",
    );
  }

  await ensureAccounts(pool, { accountKeys: accounts });

  const repeats = Math.max(1, Number(form.repeats ?? 1) || 1);
  const method = form.method === "random" ? "random" : "stratified";
  const seed = form.seed?.trim() || null;
  const effectiveSize = Math.min(size, stats.enabled);

  const result = await createSamplingBatch(pool, {
    projectName: project.name,
    name: `${project.name} 抽样 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    size: effectiveSize,
    method,
    seed,
    accounts,
    repeats,
  });

  const warning = size > stats.enabled ? `（关键词池只有 ${stats.enabled} 条，已按上限抽样）` : "";
  return redirectWithNotice(
    res,
    `/batches/${result.batchId}`,
    `批次 #${result.batchId} 已创建，共 ${result.assignments} 个任务${warning}。到批次页点「开始监测」执行。`,
  );
}

function isAccountExecutable(row) {
  return !["login_required", "session_expired", "verification_required", "access_restricted", "paused", "cooldown", "rate_limited"].includes(
    row.status,
  );
}

async function handleStartBatch(res, batchId) {
  const back = `/batches/${batchId}`;
  const system = await ensureSystemStatus();
  if (system.redis?.state !== CONNECTION_STATES.CONNECTED) {
    return redirectWithNotice(res, back, "Redis 不可用，无法入队。", "warn");
  }
  if (system.worker?.state !== WORKER_STATES.ONLINE) {
    return redirectWithNotice(
      res,
      back,
      "Worker 未在线，任务会被排入队列但不会被执行。请先启动 npm run worker。",
      "warn",
    );
  }

  const result = await enqueueBatch(pool, batchId);
  if (!result.started) {
    return redirectWithNotice(res, back, `未启动：${result.reason}`, "warn");
  }
  return redirectWithNotice(
    res,
    back,
    `已入队 ${result.enqueued} 个任务，覆盖账号 ${result.accounts.join("、")}。Worker 会立即开始执行。`,
  );
}

async function handleStopBatch(res, batchId) {
  const result = await stopBatch(pool, batchId);
  return redirectWithNotice(
    res,
    `/batches/${batchId}`,
    result.stopped
      ? `已停止监测：取消排队任务 ${result.removed} 个。已在执行的浏览器任务会安全结束，已完成的运行全部保留。`
      : `未停止：${result.reason}`,
    result.stopped ? "ok" : "warn",
  );
}

async function handleAccountAction(res, accountKey, action, form) {
  const back = "/accounts";

  if (action === "resume") {
    const ok = await resumeAccount(pool, accountKey);
    return redirectWithNotice(
      res,
      back,
      ok ? `账号 ${accountKey} 已恢复，可以继续派发任务。` : `未找到账号 ${accountKey}。`,
      ok ? "ok" : "warn",
    );
  }

  if (action === "toggle") {
    const enabled = form.enabled !== "false";
    const ok = await setAccountEnabled(pool, accountKey, enabled);
    return redirectWithNotice(
      res,
      back,
      ok ? `账号 ${accountKey} 已${enabled ? "启用" : "禁用"}。` : `未找到账号 ${accountKey}。`,
      ok ? "ok" : "warn",
    );
  }

  throw new Error(`未知的账号操作：${action}`);
}

async function handlePost(req, res, pathname) {
  if (!dbState.ready) throw new Error("未连接数据库，无法执行写入操作");
  if (!sameOrigin(req)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    return res.end("请求来源不被允许。");
  }

  const form = await readFormBody(req);

  if (pathname === "/projects") return handleCreateProject(res, form);

  const batchAction = pathname.match(/^\/batches\/(\d+)\/(start|stop)$/);
  if (batchAction) {
    const batchId = Number(batchAction[1]);
    return batchAction[2] === "start"
      ? handleStartBatch(res, batchId)
      : handleStopBatch(res, batchId);
  }

  const accountAction = pathname.match(/^\/accounts\/([A-Za-z0-9._-]+)\/(resume|toggle)$/);
  if (accountAction) {
    return handleAccountAction(res, accountAction[1], accountAction[2], form);
  }

  const keywordMatch = pathname.match(/^\/projects\/(\d+)\/keywords$/);
  if (keywordMatch) return handleAddKeywords(res, Number(keywordMatch[1]), form);

  const actionMatch = pathname.match(
    /^\/projects\/(\d+)\/keywords\/(\d+)\/(toggle|delete|restore)$/,
  );
  if (actionMatch) {
    return handleKeywordAction(
      res,
      Number(actionMatch[1]),
      Number(actionMatch[2]),
      actionMatch[3],
      form,
    );
  }

  const samplingMatch = pathname.match(/^\/projects\/(\d+)\/sampling$/);
  if (samplingMatch) return handleCreateBatch(res, Number(samplingMatch[1]), form);

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  return res.end("未知的提交地址。");
}

/* ---------------------------------------------------------- 本地产物路由 */

/**
 * 只允许读取 `.onegl/runs/<run_id>/` 之下的文件，支持 attempts/<n>/ 子目录。
 * 路径校验全部交给 RunStore.resolveArtifact（可离线测试）。
 */
async function serveArtifact(res, runId, rawRest) {
  const segments = String(rawRest)
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => decodeURIComponent(segment));

  const target = store.resolveArtifact(runId, segments);
  if (!target) return send(res, 404, notFoundPage(`/artifacts/${runId}`));

  try {
    await stat(target);
  } catch {
    return send(res, 404, notFoundPage(`/artifacts/${runId}`));
  }

  const fileName = segments.at(-1);
  const data = await readFile(target);
  const type = fileName.endsWith(".png")
    ? "image/png"
    : fileName.endsWith(".json")
      ? "application/json; charset=utf-8"
      : "text/plain; charset=utf-8";
  return send(res, 200, data, type);
}

/* ------------------------------------------------------------------ 服务器 */

const server = http.createServer(async (req, res) => {
  try {
    await refreshDatabaseState();
    const system = await ensureSystemStatus();

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const searchParams = url.searchParams;

    if (req.method === "POST") return handlePost(req, res, pathname);

    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      return res.end("只支持 GET 与 POST。");
    }

    if (pathname === "/") return send(res, 200, await handleHome(system));
    if (pathname === "/system") return send(res, 200, await handleSystem(system));

    if (pathname === "/batches") return send(res, 200, await handleBatches(searchParams, system));
    const batchMatch = pathname.match(/^\/batches\/(\d+)$/);
    if (batchMatch) return send(res, 200, await handleBatch(Number(batchMatch[1]), system));

    if (pathname === "/runs") return send(res, 200, await handleRuns(searchParams, system));
    const runMatch = pathname.match(/^\/runs\/(run_[A-Za-z0-9_-]+)$/);
    if (runMatch) return send(res, 200, await handleRun(runMatch[1], system));

    if (pathname === "/sources") return send(res, 200, await handleSources(searchParams, system));

    if (pathname === "/accounts") return send(res, 200, await handleAccounts(searchParams, system));

    if (pathname === "/projects") return send(res, 200, await handleProjects(searchParams, system));
    const projectTab = pathname.match(/^\/projects\/(\d+)(?:\/(keywords|sampling|runs|sources))?$/);
    if (projectTab) {
      const page = await handleProjectTab(
        Number(projectTab[1]),
        projectTab[2] ?? "overview",
        searchParams,
        system,
      );
      if (!page) return send(res, 404, notFoundPage(pathname));
      return send(res, 200, page);
    }

    const artifactMatch = pathname.match(/^\/artifacts\/(run_[A-Za-z0-9_-]+)\/(.+)$/);
    if (artifactMatch) {
      return serveArtifact(res, artifactMatch[1], artifactMatch[2]);
    }

    // 供脚本使用的只读 JSON 接口
    if (pathname === "/api/system") {
      return send(res, 200, JSON.stringify(system, null, 2), "application/json; charset=utf-8");
    }
    if (pathname === "/api/batches") {
      const batches = dbState.ready ? await listBatches(pool, { limit: 200 }) : [];
      return send(res, 200, JSON.stringify(batches, null, 2), "application/json; charset=utf-8");
    }
    const apiProgress = pathname.match(/^\/api\/batches\/(\d+)\/progress$/);
    if (apiProgress) {
      const progress = await handleBatchProgress(Number(apiProgress[1]));
      if (!progress) {
        return send(
          res,
          404,
          JSON.stringify({ error: "批次不存在或数据库未连接" }),
          "application/json; charset=utf-8",
        );
      }
      return send(res, 200, JSON.stringify(progress), "application/json; charset=utf-8");
    }

    const apiBatch = pathname.match(/^\/api\/batches\/(\d+)$/);
    if (apiBatch) {
      if (!dbState.ready) {
        return send(res, 503, JSON.stringify({ error: "数据库未连接" }), "application/json; charset=utf-8");
      }
      return send(
        res,
        200,
        JSON.stringify(await batchDetail(pool, Number(apiBatch[1])), null, 2),
        "application/json; charset=utf-8",
      );
    }
    if (pathname === "/api/runs") {
      if (!dbState.ready) {
        return send(res, 200, JSON.stringify(await readLocalRuns(), null, 2), "application/json; charset=utf-8");
      }
      return send(
        res,
        200,
        JSON.stringify(await listRuns(pool, { limit: 500 }), null, 2),
        "application/json; charset=utf-8",
      );
    }

    send(res, 404, notFoundPage(pathname));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(res, 500, errorPage(message));
  }
});

server.listen(config.port, "127.0.0.1", async () => {
  await refreshDatabaseState();
  await collectSystemStatus().catch(() => undefined);
  const status = cachedSystemStatus();
  console.log(`OneGl 操作台: http://127.0.0.1:${config.port}`);
  console.log(dbState.ready ? "  数据源：PostgreSQL" : `  数据源：本地运行产物（${dbState.message}）`);
  console.log(
    `  系统状态：DB=${status?.database?.state ?? "unknown"} Redis=${status?.redis?.state ?? "unknown"} Worker=${status?.worker?.state ?? "unknown"}`,
  );
  console.log(`  就绪：${status?.readiness?.ready ? "可以开始" : "未就绪（详见 /system）"}`);
  console.log("  仅监听回环地址，未做登录鉴权，请勿对外暴露。");
});
