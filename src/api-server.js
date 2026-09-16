import "dotenv/config";
import crypto from "node:crypto";
import http from "node:http";

import { parseBatchCreate, parseKeywordsCreate, parseLimit, parseProjectCreate } from "./api/contracts.js";
import { handleGeoIntelligenceRoute } from "./api/geo-intelligence-routes.js";
import { ApiHttpError, errorPayload, readJsonBody, sendBuffer, sendJson } from "./api/http.js";
import { beginSaasIdempotency, completeSaasIdempotency } from "./api/idempotency.js";
import { handleMonitoringRoute } from "./api/monitoring-routes.js";
import { openApiDocument } from "./api/openapi.js";
import { handleSaasPaginationRoute } from "./api/saas-pagination.js";
import { applySaasOpenApi } from "./api/saas-openapi.js";
import { handleTaskRoute } from "./api/task-routes.js";
import {
  DEFAULT_SCOPES,
  accountExternalIdMap,
  authenticateServiceRequest,
  bindProject,
  createApiClient,
  createAuthSessionRow,
  createTenant,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  ensureTenantAccount,
  getAuthSessionRow,
  getTenantProject,
  internalProjectName,
  listTenantAccounts,
  listTenantBatches,
  listTenantProjects,
  listTenants,
  listWebhookEndpoints,
  requireMaster,
  requireScope,
  resolveTenant,
  resolveTenantAccountKeys,
  revokeApiClient,
  tenantOwnsBatch,
  tenantOwnsRun,
} from "./api/service-store.js";
import {
  cancelRemoteAuthSession,
  persistedRemoteAuthRuntime,
  persistedRemoteAuthScreenshot,
  remoteAuthRuntime,
  remoteAuthScreenshot,
  shutdownRemoteAuthSessions,
  startRemoteAuthSession,
} from "./api/remote-auth.js";
import { createPool, isDatabaseConfigured } from "./db/pool.js";
import {
  batchDetail,
  createProject,
  databaseReady,
  getRun,
  getRunCitations,
  listRuns,
} from "./db/dashboard.js";
import { addKeywords, countActiveKeywords, listProjectKeywords } from "./project/keywords.js";
import { batchProgress, enqueueBatch, stopBatch } from "./queue/batches.js";
import { isQueueConfigured } from "./queue/connection.js";
import { createSamplingBatch } from "./sampling/batch.js";
import { readinessReport } from "./system/readiness.js";

applySaasOpenApi(openApiDocument);

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

function positiveId(raw, name = "id") {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiHttpError(400, "invalid_request", `${name} must be a positive integer`);
  }
  return value;
}

function isAccountExecutable(row) {
  return Boolean(row.enabled) && ![
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
  if (!pool) throw new ApiHttpError(503, "database_unavailable", "DATABASE_URL is not configured");
  const state = await databaseReady(pool);
  if (!state.ready) {
    throw new ApiHttpError(503, "database_unavailable", "database is not ready", { message: state.message });
  }
  return pool;
}

async function healthPayload() {
  const database = pool
    ? await databaseReady(pool)
    : { ready: false, message: "DATABASE_URL is not configured" };
  return {
    service: "onegl-api",
    status: database.ready ? "ok" : "degraded",
    database,
    queue: { configured: isQueueConfigured() },
    auth: { master_configured: Boolean(process.env.ONEGL_API_KEY), client_keys_supported: true },
    webhooks: { signing_configured: Boolean(process.env.ONEGL_WEBHOOK_SIGNING_KEY), ssrf_guard: true },
    remote_auth: { enabled: true, durable_runtime_state: true },
  };
}

async function tenantBatchDisplayName(db, tenantId, batchId) {
  const { rows } = await db.query(
    `SELECT pb.display_name
       FROM sampling_batches b
       JOIN service_project_bindings pb ON pb.project_id = b.project_id
      WHERE b.id = $1 AND pb.tenant_id = $2`,
    [batchId, tenantId],
  );
  return rows[0]?.display_name ?? null;
}

async function createProjectResource(db, tenant, body) {
  const input = parseProjectCreate(body);
  const internalName = internalProjectName(tenant, input.name);
  const created = await createProject(db, {
    name: internalName,
    description: input.description,
    targetBrand: input.targetBrand,
  });
  await bindProject(db, {
    tenantId: tenant.id,
    projectId: created.id,
    displayName: input.name,
    externalId: body.external_id == null ? null : String(body.external_id).trim() || null,
  });
  if (input.keywords.length) {
    await addKeywords(db, {
      projectId: created.id,
      input: input.keywords.join("\n"),
      category: input.category,
    });
  }
  const project = await getTenantProject(db, tenant.id, created.id);
  return {
    id: Number(project.id),
    name: project.display_name,
    external_id: project.external_id,
    description: project.description,
    target_brand: project.target_brand,
    created: created.created,
    keywords: input.keywords.length ? await listProjectKeywords(db, created.id) : [],
  };
}

async function createBatchResource(db, tenant, body) {
  const input = parseBatchCreate(body);
  const project = await getTenantProject(db, tenant.id, input.projectId);
  if (!project) throw new ApiHttpError(404, "project_not_found", `project ${input.projectId} was not found`);

  const keywordStats = await countActiveKeywords(db, project.id);
  if (!keywordStats.enabled) throw new ApiHttpError(409, "keyword_pool_empty", "project has no enabled keywords");
  const size = input.size ?? keywordStats.enabled;
  if (size > keywordStats.enabled) {
    throw new ApiHttpError(422, "sample_size_exceeds_pool", `size ${size} exceeds enabled keyword count ${keywordStats.enabled}`, {
      enabled_keywords: keywordStats.enabled,
    });
  }

  const resolved = await resolveTenantAccountKeys(db, tenant.id, input.accounts);
  const internalKeys = resolved.map((item) => item.accountKey);
  const { rows: accountRows } = await db.query(
    `SELECT account_key, enabled, status, cooldown_until
       FROM accounts WHERE provider = 'doubao' AND account_key = ANY($1::text[])`,
    [internalKeys],
  );
  const byKey = new Map(accountRows.map((row) => [row.account_key, row]));
  const blocked = resolved.filter((item) => !isAccountExecutable(byKey.get(item.accountKey) ?? {}));
  if (blocked.length) {
    throw new ApiHttpError(409, "accounts_unavailable", "one or more accounts cannot currently execute", {
      accounts: blocked.map((item) => ({
        account_id: item.externalId,
        status: byKey.get(item.accountKey)?.status ?? "unknown",
        cooldown_until: byKey.get(item.accountKey)?.cooldown_until ?? null,
      })),
    });
  }

  const result = await createSamplingBatch(db, {
    projectName: project.name,
    name: input.name ?? `${project.display_name} API batch ${new Date().toISOString()}`,
    size,
    method: input.method,
    seed: input.seed,
    accounts: internalKeys,
    repeats: input.repeats,
  }, { log: () => undefined });

  const response = {
    ...result,
    project_id: Number(project.id),
    project_name: project.display_name,
    accounts: input.accounts,
    status: "pending",
  };
  if (input.start) {
    const started = await enqueueBatch(db, result.batchId, { log: () => undefined });
    response.start = {
      ...started,
      accounts: started.accounts?.map((key) => resolved.find((item) => item.accountKey === key)?.externalId ?? key),
    };
    response.status = started.started ? "queued" : "pending";
  }
  return response;
}

async function externalizeRuns(db, tenantId, runs) {
  const map = await accountExternalIdMap(db, tenantId);
  return runs.map((run) => ({
    ...run,
    account_id: run.account_key == null ? null : map.get(run.account_key) ?? null,
    account_key: undefined,
  }));
}

async function getAccountBinding(db, tenantId, externalId, provider = "doubao") {
  const { rows } = await db.query(
    `SELECT id, tenant_id, provider, account_key, external_id, label
       FROM service_account_bindings
      WHERE tenant_id = $1 AND provider = $2 AND external_id = $3`,
    [tenantId, provider, externalId],
  );
  return rows[0] ?? null;
}

async function handleAdmin(req, res, db, auth, url) {
  requireMaster(auth);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === `${API_PREFIX}/admin/tenants`) {
    return sendJson(res, 200, { data: await listTenants(db) });
  }
  if (req.method === "POST" && pathname === `${API_PREFIX}/admin/tenants`) {
    const body = await readJsonBody(req);
    return sendJson(res, 201, { data: await createTenant(db, body) });
  }

  const clients = pathname.match(/^\/v1\/admin\/tenants\/(\d+)\/clients$/);
  if (clients) {
    const tenantId = positiveId(clients[1], "tenant_id");
    if (req.method === "GET") {
      const { rows } = await db.query(
        `SELECT id, tenant_id, name, key_prefix, scopes, enabled, last_used_at, expires_at, created_at, revoked_at
           FROM service_api_clients WHERE tenant_id = $1 ORDER BY id`,
        [tenantId],
      );
      return sendJson(res, 200, { data: rows });
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const name = String(body.name ?? "").trim();
      if (!name) throw new ApiHttpError(400, "invalid_request", "name is required");
      const scopes = body.scopes == null ? DEFAULT_SCOPES : body.scopes;
      if (!Array.isArray(scopes) || !scopes.length) {
        throw new ApiHttpError(400, "invalid_request", "scopes must be a non-empty array");
      }
      const expiresAt = body.expires_at == null ? null : new Date(body.expires_at);
      if (expiresAt && Number.isNaN(expiresAt.getTime())) {
        throw new ApiHttpError(400, "invalid_request", "expires_at must be an ISO date-time");
      }
      return sendJson(res, 201, {
        data: await createApiClient(db, {
          tenantId,
          name,
          scopes,
          expiresAt: expiresAt?.toISOString() ?? null,
        }),
      });
    }
  }

  const revoke = pathname.match(/^\/v1\/admin\/clients\/(\d+)$/);
  if (req.method === "DELETE" && revoke) {
    const ok = await revokeApiClient(db, positiveId(revoke[1], "client_id"));
    if (!ok) throw new ApiHttpError(404, "client_not_found", "API client was not found or is already revoked");
    return sendJson(res, 200, { data: { revoked: true } });
  }

  throw new ApiHttpError(404, "not_found", "admin API route not found");
}

async function routeApi(req, res, url) {
  const db = await requireDatabase();
  const auth = await authenticateServiceRequest(db, req);
  if (url.pathname.startsWith(`${API_PREFIX}/admin/`)) return handleAdmin(req, res, db, auth, url);

  const tenant = await resolveTenant(db, auth, req);
  const pathname = url.pathname;
  const idempotency = await beginSaasIdempotency(db, { tenantId: Number(tenant.id), req, pathname });
  if (idempotency?.replay) {
    res.setHeader("idempotency-replayed", "true");
    return sendJson(res, idempotency.responseStatus, idempotency.responseBody);
  }
  if (idempotency) {
    res.__oneglIdempotencyContext = idempotency;
    res.__oneglBeforeJsonSend = async (status, payload) => {
      try {
        await completeSaasIdempotency(db, idempotency, status, payload);
        idempotency.completed = true;
      } catch (error) {
        console.error(`[idempotency] failed to persist response: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        res.__oneglBeforeJsonSend = null;
      }
    };
  }

  if (await handleSaasPaginationRoute({ req, res, url, db, auth, tenant })) return;
  if (await handleTaskRoute({ req, res, url, db, auth, tenant })) return;
  if (await handleMonitoringRoute({ req, res, url, db, auth, tenant })) return;
  if (await handleGeoIntelligenceRoute({ req, res, url, db, auth, tenant })) return;

  if (req.method === "GET" && pathname === `${API_PREFIX}/projects`) {
    requireScope(auth, "projects:read");
    return sendJson(res, 200, { data: await listTenantProjects(db, tenant.id) });
  }
  if (req.method === "POST" && pathname === `${API_PREFIX}/projects`) {
    requireScope(auth, "projects:write");
    return sendJson(res, 201, { data: await createProjectResource(db, tenant, await readJsonBody(req)) });
  }

  const projectRoute = pathname.match(/^\/v1\/projects\/(\d+)$/);
  if (req.method === "GET" && projectRoute) {
    requireScope(auth, "projects:read");
    const project = await getTenantProject(db, tenant.id, Number(projectRoute[1]));
    if (!project) throw new ApiHttpError(404, "project_not_found", "project was not found");
    return sendJson(res, 200, {
      data: { ...project, name: project.display_name, internal_name: undefined, display_name: undefined },
    });
  }

  const projectKeywords = pathname.match(/^\/v1\/projects\/(\d+)\/keywords$/);
  if (projectKeywords) {
    const projectId = Number(projectKeywords[1]);
    const project = await getTenantProject(db, tenant.id, projectId);
    if (!project) throw new ApiHttpError(404, "project_not_found", `project ${projectId} was not found`);
    if (req.method === "GET") {
      requireScope(auth, "projects:read");
      return sendJson(res, 200, { data: await listProjectKeywords(db, projectId) });
    }
    if (req.method === "POST") {
      requireScope(auth, "projects:write");
      const input = parseKeywordsCreate(await readJsonBody(req));
      const saved = await addKeywords(db, { projectId, input: input.keywords.join("\n"), category: input.category });
      return sendJson(res, 201, { data: saved });
    }
  }

  if (req.method === "GET" && pathname === `${API_PREFIX}/accounts`) {
    requireScope(auth, "accounts:read");
    const accounts = await listTenantAccounts(db, tenant.id);
    return sendJson(res, 200, {
      data: accounts.map((row) => ({ ...row, executable: isAccountExecutable(row) })),
    });
  }
  if (req.method === "POST" && pathname === `${API_PREFIX}/accounts`) {
    requireScope(auth, "accounts:write");
    const body = await readJsonBody(req);
    const provider = String(body.provider ?? "doubao").trim().toLowerCase();
    if (provider !== "doubao") throw new ApiHttpError(422, "unsupported_provider", "only doubao is currently supported");
    const account = await ensureTenantAccount(db, {
      tenantId: tenant.id,
      provider,
      externalId: body.account_id,
      label: body.label == null ? null : String(body.label).trim() || null,
    });
    return sendJson(res, 201, {
      data: { account_id: account.external_id, provider: account.provider ?? provider, label: account.label ?? null },
    });
  }

  const createAuth = pathname.match(/^\/v1\/accounts\/([^/]+)\/auth-sessions$/);
  if (req.method === "POST" && createAuth) {
    requireScope(auth, "accounts:write");
    const externalId = decodeURIComponent(createAuth[1]);
    const account = await getAccountBinding(db, tenant.id, externalId);
    if (!account) throw new ApiHttpError(404, "account_not_found", `account ${externalId} was not found`);
    const body = await readJsonBody(req);
    const authRow = await createAuthSessionRow(db, {
      tenantId: tenant.id,
      accountBindingId: account.id,
      ttlMinutes: body.ttl_minutes,
    });
    const runtime = await startRemoteAuthSession({ pool: db, tenantId: tenant.id, authRow, account });
    return sendJson(res, 202, {
      data: {
        ...authRow,
        ...runtime,
        account_id: externalId,
        screenshot_url: `${API_PREFIX}/auth-sessions/${authRow.id}/screenshot`,
      },
    });
  }

  const authSession = pathname.match(/^\/v1\/auth-sessions\/([0-9a-f-]{36})$/i);
  if (req.method === "GET" && authSession) {
    requireScope(auth, "accounts:read");
    const row = await getAuthSessionRow(db, tenant.id, authSession[1]);
    if (!row) throw new ApiHttpError(404, "auth_session_not_found", "auth session was not found");
    let runtime = remoteAuthRuntime(row.id);
    if (!runtime) {
      const { rows } = await db.query(
        `SELECT status, updated_at, completed_at, runtime_owner, runtime_heartbeat_at,
                (screenshot IS NOT NULL) AS screenshot_available
           FROM service_auth_sessions
          WHERE id = $1 AND tenant_id = $2`,
        [row.id, tenant.id],
      );
      runtime = persistedRemoteAuthRuntime(rows[0]);
    }
    return sendJson(res, 200, { data: { ...row, runtime } });
  }
  const authScreenshot = pathname.match(/^\/v1\/auth-sessions\/([0-9a-f-]{36})\/screenshot$/i);
  if (req.method === "GET" && authScreenshot) {
    requireScope(auth, "accounts:read");
    const row = await getAuthSessionRow(db, tenant.id, authScreenshot[1]);
    if (!row) throw new ApiHttpError(404, "auth_session_not_found", "auth session was not found");
    const screenshot = remoteAuthScreenshot(row.id) ?? await persistedRemoteAuthScreenshot(db, tenant.id, row.id);
    if (!screenshot) throw new ApiHttpError(409, "screenshot_not_ready", "auth session screenshot is not available yet");
    return sendBuffer(res, 200, screenshot, "image/png");
  }
  const authCancel = pathname.match(/^\/v1\/auth-sessions\/([0-9a-f-]{36})\/cancel$/i);
  if (req.method === "POST" && authCancel) {
    requireScope(auth, "accounts:write");
    const row = await getAuthSessionRow(db, tenant.id, authCancel[1]);
    if (!row) throw new ApiHttpError(404, "auth_session_not_found", "auth session was not found");
    await cancelRemoteAuthSession({ pool: db, tenantId: tenant.id, id: row.id });
    return sendJson(res, 200, { data: { cancelled: true, id: row.id } });
  }

  if (req.method === "GET" && pathname === `${API_PREFIX}/batches`) {
    requireScope(auth, "batches:read");
    const projectIdRaw = url.searchParams.get("project_id");
    const projectId = projectIdRaw == null ? null : positiveId(projectIdRaw, "project_id");
    if (projectId && !(await getTenantProject(db, tenant.id, projectId))) {
      throw new ApiHttpError(404, "project_not_found", `project ${projectId} was not found`);
    }
    const limit = parseLimit(url.searchParams.get("limit"), 100, 500);
    return sendJson(res, 200, { data: await listTenantBatches(db, tenant.id, { projectId, limit }) });
  }
  if (req.method === "POST" && pathname === `${API_PREFIX}/batches`) {
    requireScope(auth, "batches:write");
    return sendJson(res, 201, { data: await createBatchResource(db, tenant, await readJsonBody(req)) });
  }

  const batchRoute = pathname.match(/^\/v1\/batches\/(\d+)$/);
  if (req.method === "GET" && batchRoute) {
    requireScope(auth, "batches:read");
    const batchId = Number(batchRoute[1]);
    if (!(await tenantOwnsBatch(db, tenant.id, batchId))) {
      throw new ApiHttpError(404, "batch_not_found", `batch ${batchId} was not found`);
    }
    const progress = await batchProgress(db, batchId);
    progress.batch.project_name = await tenantBatchDisplayName(db, tenant.id, batchId);
    return sendJson(res, 200, { data: progress });
  }

  const batchStart = pathname.match(/^\/v1\/batches\/(\d+)\/start$/);
  if (req.method === "POST" && batchStart) {
    requireScope(auth, "batches:write");
    const batchId = Number(batchStart[1]);
    if (!(await tenantOwnsBatch(db, tenant.id, batchId))) throw new ApiHttpError(404, "batch_not_found", "batch was not found");
    const result = await enqueueBatch(db, batchId, { log: () => undefined });
    const accountMap = await accountExternalIdMap(db, tenant.id);
    return sendJson(res, result.started ? 202 : 409, {
      data: { ...result, accounts: result.accounts?.map((key) => accountMap.get(key) ?? null).filter(Boolean) },
    });
  }

  const batchStop = pathname.match(/^\/v1\/batches\/(\d+)\/stop$/);
  if (req.method === "POST" && batchStop) {
    requireScope(auth, "batches:write");
    const batchId = Number(batchStop[1]);
    if (!(await tenantOwnsBatch(db, tenant.id, batchId))) throw new ApiHttpError(404, "batch_not_found", "batch was not found");
    const result = await stopBatch(db, batchId, { log: () => undefined });
    return sendJson(res, result.stopped ? 200 : 409, { data: result });
  }

  const batchRuns = pathname.match(/^\/v1\/batches\/(\d+)\/runs$/);
  if (req.method === "GET" && batchRuns) {
    requireScope(auth, "batches:read");
    const batchId = Number(batchRuns[1]);
    if (!(await tenantOwnsBatch(db, tenant.id, batchId))) throw new ApiHttpError(404, "batch_not_found", "batch was not found");
    const limit = parseLimit(url.searchParams.get("limit"), 200, 500);
    return sendJson(res, 200, { data: await externalizeRuns(db, tenant.id, await listRuns(db, { batchId, limit })) });
  }

  const batchReport = pathname.match(/^\/v1\/batches\/(\d+)\/report$/);
  if (req.method === "GET" && batchReport) {
    requireScope(auth, "reports:read");
    const batchId = Number(batchReport[1]);
    if (!(await tenantOwnsBatch(db, tenant.id, batchId))) throw new ApiHttpError(404, "batch_not_found", "batch was not found");
    const detail = await batchDetail(db, batchId);
    return sendJson(res, 200, {
      data: {
        project_name: await tenantBatchDisplayName(db, tenant.id, batchId),
        report: detail.report,
        sources: detail.sources,
        intelligence: detail.intelligence,
      },
    });
  }

  const runRoute = pathname.match(/^\/v1\/runs\/(run_[A-Za-z0-9_-]+)$/);
  if (req.method === "GET" && runRoute) {
    requireScope(auth, "reports:read");
    if (!(await tenantOwnsRun(db, tenant.id, runRoute[1]))) {
      throw new ApiHttpError(404, "run_not_found", `run ${runRoute[1]} was not found`);
    }
    const run = await getRun(db, runRoute[1]);
    const citations = await getRunCitations(db, run.id);
    const accountMap = await accountExternalIdMap(db, tenant.id);
    const project = await getTenantProject(db, tenant.id, run.project_id);
    return sendJson(res, 200, {
      data: {
        run: {
          ...run,
          project_name: project?.display_name ?? run.project_name,
          account_id: run.account_key == null ? null : accountMap.get(run.account_key) ?? null,
          account_key: undefined,
        },
        citations,
      },
    });
  }

  if (req.method === "GET" && pathname === `${API_PREFIX}/webhooks`) {
    requireScope(auth, "webhooks:read");
    return sendJson(res, 200, { data: await listWebhookEndpoints(db, tenant.id) });
  }
  if (req.method === "POST" && pathname === `${API_PREFIX}/webhooks`) {
    requireScope(auth, "webhooks:write");
    const body = await readJsonBody(req);
    return sendJson(res, 201, {
      data: await createWebhookEndpoint(db, {
        tenantId: tenant.id,
        url: body.url,
        eventTypes: body.event_types,
        description: body.description == null ? null : String(body.description).trim() || null,
      }),
    });
  }
  const webhookDelete = pathname.match(/^\/v1\/webhooks\/(\d+)$/);
  if (req.method === "DELETE" && webhookDelete) {
    requireScope(auth, "webhooks:write");
    const ok = await deleteWebhookEndpoint(db, tenant.id, Number(webhookDelete[1]));
    if (!ok) throw new ApiHttpError(404, "webhook_not_found", "webhook endpoint was not found");
    return sendJson(res, 200, { data: { deleted: true } });
  }
  if (req.method === "POST" && pathname === `${API_PREFIX}/webhooks/test`) {
    requireScope(auth, "webhooks:write");
    const eventKey = `test:${tenant.id}:${crypto.randomUUID()}`;
    const { rows } = await db.query(
      `INSERT INTO service_webhook_events (tenant_id, event_key, event_type, payload)
       VALUES ($1, $2, 'webhook.test', $3::jsonb)
       RETURNING id, event_type, status, created_at`,
      [tenant.id, eventKey, JSON.stringify({ event: "webhook.test", tenant: tenant.slug })],
    );
    return sendJson(res, 202, { data: rows[0] });
  }
  if (req.method === "GET" && pathname === `${API_PREFIX}/webhook-events`) {
    requireScope(auth, "webhooks:read");
    const limit = parseLimit(url.searchParams.get("limit"), 50, 200);
    const { rows } = await db.query(
      `SELECT id, event_type, status, attempts, next_attempt_at, created_at, delivered_at, last_error
         FROM service_webhook_events
        WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2`,
      [tenant.id, limit],
    );
    return sendJson(res, 200, { data: rows });
  }

  throw new ApiHttpError(404, "not_found", "API route not found");
}

export function createApiServer() {
  return http.createServer(async (req, res) => {
    res.setHeader("x-onegl-api-version", openApiDocument.info.version);
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, await healthPayload());
      if (req.method === "GET" && url.pathname === "/readyz") {
        const readiness = await readinessReport({ pool, role: "api" });
        return sendJson(res, readiness.ready ? 200 : 503, readiness);
      }
      if (req.method === "GET" && url.pathname === "/openapi.json") return sendJson(res, 200, openApiDocument);
      if (url.pathname === "/") {
        return sendJson(res, 200, {
          service: "onegl-api",
          version: openApiDocument.info.version,
          health: "/healthz",
          readiness: "/readyz",
          openapi: "/openapi.json",
        });
      }
      if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) {
        throw new ApiHttpError(404, "not_found", "route not found");
      }
      return await routeApi(req, res, url);
    } catch (error) {
      const response = errorPayload(error);
      const context = res.__oneglIdempotencyContext;
      res.__oneglBeforeJsonSend = null;
      if (context && !context.completed && pool) {
        try {
          await completeSaasIdempotency(pool, context, response.status, response.body);
          context.completed = true;
        } catch (idempotencyError) {
          console.error(`[idempotency] failed to persist error response: ${idempotencyError instanceof Error ? idempotencyError.message : String(idempotencyError)}`);
        }
      }
      return sendJson(res, response.status, response.body);
    }
  });
}

const server = createApiServer();
server.listen(API_PORT, API_HOST, () => {
  console.log(`OneGl Service API: http://${API_HOST}:${API_PORT}`);
  console.log(`  OpenAPI: http://${API_HOST}:${API_PORT}/openapi.json`);
  console.log(`  Readiness: http://${API_HOST}:${API_PORT}/readyz`);
  console.log(`  Master API key: ${process.env.ONEGL_API_KEY ? "configured" : "MISSING ONEGL_API_KEY"}`);
  console.log(`  Webhook signing: ${process.env.ONEGL_WEBHOOK_SIGNING_KEY ? "configured" : "MISSING ONEGL_WEBHOOK_SIGNING_KEY"}`);
  console.log("  Use a TLS reverse proxy or private network when exposing this service across hosts.");
});

async function shutdown(signal) {
  console.log(`OneGl Service API received ${signal}; shutting down.`);
  await shutdownRemoteAuthSessions().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end().catch(() => undefined);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => shutdown(signal));
