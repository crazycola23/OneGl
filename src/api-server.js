import "dotenv/config";
import http from "node:http";

import { isApiRequestAuthorized } from "./api/auth.js";
import { parseBatchCreate, parseKeywordsCreate, parseLimit, parseProjectCreate } from "./api/contracts.js";
import { ApiHttpError, errorPayload, readJsonBody, sendJson } from "./api/http.js";
import { openApiDocument } from "./api/openapi.js";
import { createPool, isDatabaseConfigured } from "./db/pool.js";
import {
  batchDetail,
  createProject,
  databaseReady,
  getProject,
  getRun,
  getRunCitations,
  listAccounts,
  listBatches,
  listProjects,
  listRuns,
} from "./db/dashboard.js";
import { ensureAccounts } from "./db/persist.js";
import { addKeywords, countActiveKeywords, listProjectKeywords } from "./project/keywords.js";
import { batchProgress, enqueueBatch, stopBatch } from "./queue/batches.js";
import { isQueueConfigured } from "./queue/connection.js";
import { createSamplingBatch } from "./sampling/batch.js";

const API_HOST = process.env.ONEGL_API_HOST?.trim() || "127.0.0.1";
const API_PORT = parsePort(process.env.ONEGL_API_PORT, 3200);
const API_PREFIX = "/v1";
const pool = isDatabaseConfigured() ? createPool() : null;

function parsePort(raw, fallback) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("ONEGL_API_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function isAccountExecutable(row) {
  return ![
    "login_required",
    "session_expired",
    "verification_required",
    "access_restricted",
    "paused",
    "cooldown",
    "rate_limited",
    "disabled",
  ].includes(row.status);
}

async function requireDatabase() {
  if (!pool) {
    throw new ApiHttpError(503, "database_unavailable", "DATABASE_URL is not configured");
  }
  const state = await databaseReady(pool);
  if (!state.ready) {
    throw new ApiHttpError(503, "database_unavailable", "database is not ready", {
      message: state.message,
    });
  }
  return pool;
}

async function healthPayload() {
  const database = pool ? await databaseReady(pool) : { ready: false, message: "DATABASE_URL is not configured" };
  return {
    service: "onegl-api",
    status: database.ready ? "ok" : "degraded",
    database,
    queue: { configured: isQueueConfigured() },
    auth: { configured: Boolean(process.env.ONEGL_API_KEY) },
  };
}

async function createProjectResource(db, body) {
  const input = parseProjectCreate(body);
  const created = await createProject(db, input);
  if (input.keywords.length) {
    await addKeywords(db, {
      projectId: created.id,
      input: input.keywords.join("\n"),
      category: input.category,
    });
  }
  return {
    ...(await getProject(db, created.id)),
    created: created.created,
    keywords: input.keywords.length ? await listProjectKeywords(db, created.id) : [],
  };
}

async function createBatchResource(db, body) {
  const input = parseBatchCreate(body);
  const project = await getProject(db, input.projectId);
  if (!project) {
    throw new ApiHttpError(404, "project_not_found", `project ${input.projectId} was not found`);
  }

  const keywordStats = await countActiveKeywords(db, project.id);
  if (!keywordStats.enabled) {
    throw new ApiHttpError(409, "keyword_pool_empty", "project has no enabled keywords");
  }
  const size = input.size ?? keywordStats.enabled;
  if (size > keywordStats.enabled) {
    throw new ApiHttpError(
      422,
      "sample_size_exceeds_pool",
      `size ${size} exceeds enabled keyword count ${keywordStats.enabled}`,
      { enabled_keywords: keywordStats.enabled },
    );
  }

  const accountRows = await listAccounts(db);
  const byKey = new Map(accountRows.map((row) => [row.account_key, row]));
  const unknown = input.accounts.filter((key) => !byKey.has(key));
  if (unknown.length) {
    throw new ApiHttpError(422, "unknown_accounts", "one or more accounts are not registered", {
      accounts: unknown,
    });
  }
  const blocked = input.accounts.filter((key) => {
    const row = byKey.get(key);
    return !row?.enabled || !isAccountExecutable(row);
  });
  if (blocked.length) {
    throw new ApiHttpError(409, "accounts_unavailable", "one or more accounts cannot currently execute", {
      accounts: blocked.map((key) => ({
        account_key: key,
        status: byKey.get(key)?.status ?? "unknown",
        cooldown_until: byKey.get(key)?.cooldown_until ?? null,
      })),
    });
  }

  await ensureAccounts(db, { accountKeys: input.accounts });
  const result = await createSamplingBatch(db, {
    projectName: project.name,
    name: input.name ?? `${project.name} API batch ${new Date().toISOString()}`,
    size,
    method: input.method,
    seed: input.seed,
    accounts: input.accounts,
    repeats: input.repeats,
  }, { log: () => undefined });

  const response = {
    ...result,
    project_id: project.id,
    project_name: project.name,
    status: "pending",
  };
  if (input.start) {
    response.start = await enqueueBatch(db, result.batchId, { log: () => undefined });
    response.status = response.start.started ? "queued" : "pending";
  }
  return response;
}

async function routeApi(req, res, url) {
  if (!process.env.ONEGL_API_KEY) {
    throw new ApiHttpError(503, "auth_not_configured", "ONEGL_API_KEY is not configured");
  }
  if (!isApiRequestAuthorized(req)) {
    throw new ApiHttpError(401, "unauthorized", "valid API credentials are required");
  }

  const db = await requireDatabase();
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === `${API_PREFIX}/projects`) {
    return sendJson(res, 200, { data: await listProjects(db) });
  }
  if (req.method === "POST" && pathname === `${API_PREFIX}/projects`) {
    return sendJson(res, 201, { data: await createProjectResource(db, await readJsonBody(req)) });
  }

  const projectKeywords = pathname.match(/^\/v1\/projects\/(\d+)\/keywords$/);
  if (projectKeywords) {
    const projectId = Number(projectKeywords[1]);
    const project = await getProject(db, projectId);
    if (!project) throw new ApiHttpError(404, "project_not_found", `project ${projectId} was not found`);
    if (req.method === "GET") {
      return sendJson(res, 200, { data: await listProjectKeywords(db, projectId) });
    }
    if (req.method === "POST") {
      const input = parseKeywordsCreate(await readJsonBody(req));
      const saved = await addKeywords(db, {
        projectId,
        input: input.keywords.join("\n"),
        category: input.category,
      });
      return sendJson(res, 201, { data: saved });
    }
  }

  if (req.method === "GET" && pathname === `${API_PREFIX}/accounts`) {
    const accounts = await listAccounts(db);
    return sendJson(res, 200, {
      data: accounts.map((row) => ({ ...row, executable: Boolean(row.enabled && isAccountExecutable(row)) })),
    });
  }

  if (req.method === "GET" && pathname === `${API_PREFIX}/batches`) {
    const projectIdRaw = url.searchParams.get("project_id");
    const projectId = projectIdRaw == null ? null : Number(projectIdRaw);
    if (projectIdRaw != null && (!Number.isInteger(projectId) || projectId <= 0)) {
      throw new ApiHttpError(400, "invalid_request", "project_id must be a positive integer");
    }
    const limit = parseLimit(url.searchParams.get("limit"), 100, 500);
    return sendJson(res, 200, { data: await listBatches(db, { projectId, limit }) });
  }
  if (req.method === "POST" && pathname === `${API_PREFIX}/batches`) {
    return sendJson(res, 201, { data: await createBatchResource(db, await readJsonBody(req)) });
  }

  const batchRoute = pathname.match(/^\/v1\/batches\/(\d+)$/);
  if (req.method === "GET" && batchRoute) {
    const batchId = Number(batchRoute[1]);
    const progress = await batchProgress(db, batchId);
    if (!progress) throw new ApiHttpError(404, "batch_not_found", `batch ${batchId} was not found`);
    return sendJson(res, 200, { data: progress });
  }

  const batchStart = pathname.match(/^\/v1\/batches\/(\d+)\/start$/);
  if (req.method === "POST" && batchStart) {
    const batchId = Number(batchStart[1]);
    if (!(await batchProgress(db, batchId))) {
      throw new ApiHttpError(404, "batch_not_found", `batch ${batchId} was not found`);
    }
    const result = await enqueueBatch(db, batchId, { log: () => undefined });
    return sendJson(res, result.started ? 202 : 409, { data: result });
  }

  const batchStop = pathname.match(/^\/v1\/batches\/(\d+)\/stop$/);
  if (req.method === "POST" && batchStop) {
    const batchId = Number(batchStop[1]);
    if (!(await batchProgress(db, batchId))) {
      throw new ApiHttpError(404, "batch_not_found", `batch ${batchId} was not found`);
    }
    const result = await stopBatch(db, batchId, { log: () => undefined });
    return sendJson(res, result.stopped ? 200 : 409, { data: result });
  }

  const batchRuns = pathname.match(/^\/v1\/batches\/(\d+)\/runs$/);
  if (req.method === "GET" && batchRuns) {
    const batchId = Number(batchRuns[1]);
    if (!(await batchProgress(db, batchId))) {
      throw new ApiHttpError(404, "batch_not_found", `batch ${batchId} was not found`);
    }
    const limit = parseLimit(url.searchParams.get("limit"), 200, 500);
    return sendJson(res, 200, { data: await listRuns(db, { batchId, limit }) });
  }

  const batchReport = pathname.match(/^\/v1\/batches\/(\d+)\/report$/);
  if (req.method === "GET" && batchReport) {
    const batchId = Number(batchReport[1]);
    if (!(await batchProgress(db, batchId))) {
      throw new ApiHttpError(404, "batch_not_found", `batch ${batchId} was not found`);
    }
    const detail = await batchDetail(db, batchId);
    return sendJson(res, 200, {
      data: {
        report: detail.report,
        sources: detail.sources,
        intelligence: detail.intelligence,
      },
    });
  }

  const runRoute = pathname.match(/^\/v1\/runs\/(run_[A-Za-z0-9_-]+)$/);
  if (req.method === "GET" && runRoute) {
    const run = await getRun(db, runRoute[1]);
    if (!run) throw new ApiHttpError(404, "run_not_found", `run ${runRoute[1]} was not found`);
    const citations = await getRunCitations(db, run.id);
    return sendJson(res, 200, { data: { run, citations } });
  }

  throw new ApiHttpError(404, "not_found", "API route not found");
}

export function createApiServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, await healthPayload());
      }
      if (req.method === "GET" && url.pathname === "/openapi.json") {
        return sendJson(res, 200, openApiDocument);
      }
      if (url.pathname === "/") {
        return sendJson(res, 200, {
          service: "onegl-api",
          version: openApiDocument.info.version,
          health: "/healthz",
          openapi: "/openapi.json",
        });
      }
      if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) {
        throw new ApiHttpError(404, "not_found", "route not found");
      }
      return await routeApi(req, res, url);
    } catch (error) {
      const response = errorPayload(error);
      return sendJson(res, response.status, response.body);
    }
  });
}

const server = createApiServer();
server.listen(API_PORT, API_HOST, () => {
  console.log(`OneGl Service API: http://${API_HOST}:${API_PORT}`);
  console.log(`  OpenAPI: http://${API_HOST}:${API_PORT}/openapi.json`);
  console.log(`  API auth: ${process.env.ONEGL_API_KEY ? "configured" : "MISSING ONEGL_API_KEY"}`);
  console.log("  Use a TLS reverse proxy when exposing this service across hosts or networks.");
});

async function shutdown(signal) {
  console.log(`OneGl Service API received ${signal}; shutting down.`);
  await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end().catch(() => undefined);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => shutdown(signal));
}
