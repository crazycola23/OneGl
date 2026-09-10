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
import {
  batchPage,
  batchesPage,
  errorPage,
  homePage,
  notFoundPage,
  projectPage,
  projectsPage,
  runPage,
  runsPage,
  sourcesPage,
} from "./ui/pages.js";

/**
 * 只读分析界面。
 *
 * 数据优先来自 PostgreSQL；未配置 DATABASE_URL 时退化为只读本地运行产物，
 * 页面会明确提示当前处于哪一种状态。
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
    captured_from: citation.capturedFrom ?? "DOM",
    tracked_article_id: null,
  }));
}

function send(res, status, content, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(content);
}

/* ------------------------------------------------------------------ 路由处理 */

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
  const detail = await batchDetail(pool, batchId);
  return batchPage(detail);
}

async function handleRuns(searchParams) {
  const status = searchParams.get("status");
  const projectId = searchParams.get("project");
  const batchId = searchParams.get("batch");

  if (!dbState.ready) {
    const localRuns = await readLocalRuns();
    return runsPage({
      db: dbState,
      runs: [],
      projects: [],
      localRuns,
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
  const projects = await listProjects(pool);
  return sourcesPage({ db: dbState, sources, projects, projectId });
}

async function handleProjects() {
  const projects = dbState.ready ? await listProjects(pool) : [];
  return projectsPage({ db: dbState, projects });
}

async function handleProject(projectId) {
  if (!dbState.ready) throw new Error("未连接数据库，无法读取项目详情");
  const project = await getProject(pool, projectId);
  if (!project) return null;
  const pool_ = await poolByCategory(pool, projectId);
  const tracked = await trackedArticles(pool, projectId);
  const accounts = await listAccounts(pool);
  return projectPage({ project, pool: pool_, tracked, accounts });
}

async function handleArtifact(runId, fileName) {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) return null;
  const file = path.join(store.runDir(runId), fileName);
  try {
    await stat(file);
  } catch {
    return null;
  }
  const data = await readFile(file);
  const type = fileName.endsWith(".png")
    ? "image/png"
    : fileName.endsWith(".json")
      ? "application/json; charset=utf-8"
      : "text/plain; charset=utf-8";
  return { data, type };
}

/* ------------------------------------------------------------------ 服务器 */

const server = http.createServer(async (req, res) => {
  try {
    await refreshDatabaseState();

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const searchParams = url.searchParams;

    if (pathname === "/") return send(res, 200, await handleHome());

    if (pathname === "/batches") return send(res, 200, await handleBatches(searchParams));
    const batchMatch = pathname.match(/^\/batches\/(\d+)$/);
    if (batchMatch) return send(res, 200, await handleBatch(Number(batchMatch[1])));

    if (pathname === "/runs") return send(res, 200, await handleRuns(searchParams));
    const runMatch = pathname.match(/^\/runs\/(run_[A-Za-z0-9_-]+)$/);
    if (runMatch) return send(res, 200, await handleRun(runMatch[1]));

    if (pathname === "/sources") return send(res, 200, await handleSources(searchParams));

    if (pathname === "/projects") return send(res, 200, await handleProjects());
    const projectMatch = pathname.match(/^\/projects\/(\d+)$/);
    if (projectMatch) {
      const page = await handleProject(Number(projectMatch[1]));
      if (!page) return send(res, 404, notFoundPage(pathname));
      return send(res, 200, page);
    }

    const artifactMatch = pathname.match(/^\/artifacts\/(run_[A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/);
    if (artifactMatch) {
      const artifact = await handleArtifact(artifactMatch[1], artifactMatch[2]);
      if (!artifact) return send(res, 404, notFoundPage(pathname));
      return send(res, 200, artifact.data, artifact.type);
    }

    // 供脚本使用的只读 JSON 接口
    if (pathname === "/api/batches") {
      const batches = dbState.ready ? await listBatches(pool, { limit: 200 }) : [];
      return send(res, 200, JSON.stringify(batches, null, 2), "application/json; charset=utf-8");
    }
    const apiBatch = pathname.match(/^\/api\/batches\/(\d+)$/);
    if (apiBatch) {
      if (!dbState.ready) return send(res, 503, JSON.stringify({ error: "数据库未连接" }), "application/json; charset=utf-8");
      return send(
        res,
        200,
        JSON.stringify(await batchDetail(pool, Number(apiBatch[1])), null, 2),
        "application/json; charset=utf-8",
      );
    }
    if (pathname === "/api/runs") {
      if (!dbState.ready) {
        return send(
          res,
          200,
          JSON.stringify(await readLocalRuns(), null, 2),
          "application/json; charset=utf-8",
        );
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
  console.log(
    dbState.ready
      ? "  数据源：PostgreSQL"
      : `  数据源：本地运行产物（${dbState.message}）`,
  );
});
