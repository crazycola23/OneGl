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
  listBatches,
  listProjects,
  listRuns,
  poolByCategory,
  sourceAggregates,
  trackedArticles,
} from "./db/dashboard.js";
import { ensureAccounts } from "./db/persist.js";
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
} from "./ui/pages.js";

/**
 * 分析界面。
 *
 * 读取：项目、关键词池、批次、运行、引用来源。
 * 写入：仅限项目创建、关键词池人工录入与启停删除、抽样批次创建。
 * 真正向豆包提问（batch:run）仍在命令行执行，避免长任务挂在 Web 进程里。
 *
 * 监听 127.0.0.1，没有登录鉴权，因此不能暴露到公网。
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
    tracked_article_id: null,
  }));
}

function send(res, status, content, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(content);
}

/** 写入成功后回到列表页，用查询参数带一条中文提示（POST-Redirect-GET）。 */
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

async function readFormBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("提交内容过大");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return Object.fromEntries(new URLSearchParams(raw));
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

async function handleHome() {
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
  const batches = dbState.ready ? await listBatches(pool, { limit: 8 }) : [];
  const projects = dbState.ready ? await listProjects(pool) : [];

  return homePage({
    db: dbState,
    overview,
    batches,
    projects,
    localRuns: localRuns.slice(0, 20),
    localRunCount: localRuns.length,
  });
}

async function handleBatches(searchParams) {
  const projectId = searchParams.get("project");
  const batches = dbState.ready
    ? await listBatches(pool, { projectId: projectId ?? null, limit: 100 })
    : [];
  const projects = dbState.ready ? await listProjects(pool) : [];
  return batchesPage({ db: dbState, batches, projects, projectId });
}

async function handleBatch(batchId) {
  if (!dbState.ready) throw new Error("未连接数据库，无法读取批次详情");
  return batchPage(await batchDetail(pool, batchId));
}

async function handleRuns(searchParams) {
  const status = searchParams.get("status");
  const projectId = searchParams.get("project");
  const batchId = searchParams.get("batch");

  if (!dbState.ready) {
    return runsPage({
      db: dbState,
      runs: [],
      projects: [],
      localRuns: await readLocalRuns(),
      filters: { status, projectId, batchId },
    });
  }

  const runs = await listRuns(pool, {
    status: status ?? null,
    projectId: projectId ?? null,
    batchId: batchId ?? null,
    limit: 150,
  });
  const projects = await listProjects(pool);
  return runsPage({
    db: dbState,
    runs,
    projects,
    localRuns: [],
    filters: { status, projectId, batchId },
  });
}

async function handleRun(runId) {
  const localRun = await readLocalRun(runId);
  let run = null;
  let citations = null;

  if (dbState.ready) {
    run = await getRun(pool, runId);
    if (run) citations = await getRunCitations(pool, run.id);
  }
  if (!run && localRun) citations = normalizeLocalCitations(localRun.citations);

  return runPage({ db: dbState, run, citations, localRun, runId });
}

async function handleSources(searchParams) {
  if (!dbState.ready) {
    return sourcesPage({
      db: dbState,
      sources: { domains: [], articles: [], totals: { citations: 0, articles: 0, domains: 0 } },
      projects: [],
      projectId: null,
    });
  }
  const projectId = searchParams.get("project");
  const sources = await sourceAggregates(pool, { projectId: projectId ?? null, limit: 30 });
  return sourcesPage({ db: dbState, sources, projects: await listProjects(pool), projectId });
}

async function handleProjects(searchParams) {
  const projects = dbState.ready ? await listProjects(pool) : [];
  return projectsPage({ db: dbState, projects, notice: readNotice(searchParams) });
}

/** 项目下的标签页。projectId 无效时返回 null，由调用方给出 404。 */
async function handleProjectTab(projectId, tab, searchParams) {
  if (!dbState.ready) throw new Error("未连接数据库，无法读取项目详情");
  const project = await getProject(pool, projectId);
  if (!project) return null;

  if (tab === "keywords") {
    const [keywords, stats] = await Promise.all([
      listProjectKeywords(pool, projectId),
      countActiveKeywords(pool, projectId),
    ]);
    return projectKeywordsPage({
      project,
      keywords,
      stats,
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
      notice: readNotice(searchParams)?.message ?? null,
    });
  }

  if (tab === "runs") {
    const runs = await listRuns(pool, { projectId, limit: 200 });
    return projectRunsPage({ project, runs });
  }

  if (tab === "sources") {
    const sources = await sourceAggregates(pool, { projectId, limit: 30 });
    return projectSourcesPage({ project, sources });
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
  const project = await getProject(pool, projectId);
  if (!project) throw new Error(`未找到项目（id=${projectId}）`);

  const stats = await countActiveKeywords(pool, projectId);
  if (!stats.enabled) {
    return redirectWithNotice(res, `/projects/${projectId}/sampling`, "该项目没有启用中的关键词，无法抽样。", "warn");
  }

  const size = Number(form.size ?? 0);
  if (!Number.isInteger(size) || size <= 0) {
    return redirectWithNotice(res, `/projects/${projectId}/sampling`, "抽样数量必须是正整数。", "warn");
  }

  const accounts = String(form.accounts ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!accounts.length) {
    return redirectWithNotice(res, `/projects/${projectId}/sampling`, "至少填写一个账号。", "warn");
  }

  await ensureAccounts(pool, { accountKeys: accounts });

  const repeats = Number(form.repeats ?? 1) || 1;
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
    `批次 #${result.batchId} 已创建，共 ${result.assignments} 条分配${warning}。执行命令：npm run batch:run -- --batch ${result.batchId}`,
  );
}

async function handlePost(req, res, pathname) {
  if (!dbState.ready) throw new Error("未连接数据库，无法执行写入操作");
  if (!sameOrigin(req)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    return res.end("请求来源不被允许。");
  }

  const form = await readFormBody(req);

  if (pathname === "/projects") return handleCreateProject(res, form);

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

/* ------------------------------------------------------------------ 服务器 */

const server = http.createServer(async (req, res) => {
  try {
    await refreshDatabaseState();

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const searchParams = url.searchParams;

    if (req.method === "POST") return handlePost(req, res, pathname);

    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      return res.end("只支持 GET 与 POST。");
    }

    if (pathname === "/") return send(res, 200, await handleHome());

    if (pathname === "/batches") return send(res, 200, await handleBatches(searchParams));
    const batchMatch = pathname.match(/^\/batches\/(\d+)$/);
    if (batchMatch) return send(res, 200, await handleBatch(Number(batchMatch[1])));

    if (pathname === "/runs") return send(res, 200, await handleRuns(searchParams));
    const runMatch = pathname.match(/^\/runs\/(run_[A-Za-z0-9_-]+)$/);
    if (runMatch) return send(res, 200, await handleRun(runMatch[1]));

    if (pathname === "/sources") return send(res, 200, await handleSources(searchParams));

    if (pathname === "/projects") return send(res, 200, await handleProjects(searchParams));
    const projectTab = pathname.match(/^\/projects\/(\d+)(?:\/(keywords|sampling|runs|sources))?$/);
    if (projectTab) {
      const page = await handleProjectTab(Number(projectTab[1]), projectTab[2] ?? "overview", searchParams);
      if (!page) return send(res, 404, notFoundPage(pathname));
      return send(res, 200, page);
    }

    const artifactMatch = pathname.match(/^\/artifacts\/(run_[A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/);
    if (artifactMatch) {
      const runId = artifactMatch[1];
      const fileName = artifactMatch[2];
      if (!/^[A-Za-z0-9._-]+$/.test(fileName)) return send(res, 404, notFoundPage(pathname));
      const file = path.join(store.runDir(runId), fileName);
      try {
        await stat(file);
      } catch {
        return send(res, 404, notFoundPage(pathname));
      }
      const data = await readFile(file);
      const type = fileName.endsWith(".png")
        ? "image/png"
        : fileName.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/plain; charset=utf-8";
      return send(res, 200, data, type);
    }

    // 供脚本使用的只读 JSON 接口
    if (pathname === "/api/batches") {
      const batches = dbState.ready ? await listBatches(pool, { limit: 200 }) : [];
      return send(res, 200, JSON.stringify(batches, null, 2), "application/json; charset=utf-8");
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
  console.log(`OneGl 分析界面: http://127.0.0.1:${config.port}`);
  console.log(dbState.ready ? "  数据源：PostgreSQL" : `  数据源：本地运行产物（${dbState.message}）`);
  console.log("  仅监听回环地址，未做登录鉴权，请勿对外暴露。");
});
