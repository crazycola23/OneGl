import crypto from "node:crypto";

import { ApiHttpError } from "./http.js";

const DEFAULT_SCOPES = Object.freeze([
  "projects:read",
  "projects:write",
  "accounts:read",
  "accounts:write",
  "batches:read",
  "batches:write",
  "reports:read",
  "webhooks:read",
  "webhooks:write",
]);

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function hashServiceKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function readCredential(req) {
  const authorization = String(req.headers.authorization ?? "");
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  return bearer || req.headers["x-api-key"] || "";
}

export async function authenticateServiceRequest(pool, req) {
  const provided = String(readCredential(req));
  if (!provided) throw new ApiHttpError(401, "unauthorized", "valid API credentials are required");

  const master = process.env.ONEGL_API_KEY;
  if (master && safeEqual(provided, master)) {
    return { kind: "master", master: true, clientId: null, tenantId: null, scopes: ["*"] };
  }

  const keyHash = hashServiceKey(provided);
  const { rows } = await pool.query(
    `SELECT c.id, c.tenant_id, c.scopes, c.enabled, c.expires_at, c.revoked_at,
            t.slug AS tenant_slug, t.name AS tenant_name, t.enabled AS tenant_enabled
       FROM service_api_clients c
       JOIN service_tenants t ON t.id = c.tenant_id
      WHERE c.key_hash = $1`,
    [keyHash],
  );
  const row = rows[0];
  if (!row || !row.enabled || row.revoked_at || !row.tenant_enabled) {
    throw new ApiHttpError(401, "unauthorized", "valid API credentials are required");
  }
  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    throw new ApiHttpError(401, "api_key_expired", "API client key has expired");
  }
  await pool.query("UPDATE service_api_clients SET last_used_at = now() WHERE id = $1", [row.id]);
  return {
    kind: "client",
    master: false,
    clientId: Number(row.id),
    tenantId: Number(row.tenant_id),
    tenantSlug: row.tenant_slug,
    tenantName: row.tenant_name,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
  };
}

export function requireScope(auth, scope) {
  if (auth.master || auth.scopes?.includes("*") || auth.scopes?.includes(scope)) return;
  throw new ApiHttpError(403, "insufficient_scope", `scope ${scope} is required`);
}

export function requireMaster(auth) {
  if (auth.master) return;
  throw new ApiHttpError(403, "master_required", "master API credentials are required");
}

export async function resolveTenant(pool, auth, req) {
  if (auth.tenantId) {
    const { rows } = await pool.query(
      "SELECT id, slug, name, enabled FROM service_tenants WHERE id = $1",
      [auth.tenantId],
    );
    if (!rows[0]?.enabled) throw new ApiHttpError(403, "tenant_disabled", "tenant is disabled");
    return rows[0];
  }
  const slug = String(req.headers["x-onegl-tenant"] ?? "default").trim().toLowerCase();
  const { rows } = await pool.query(
    "SELECT id, slug, name, enabled FROM service_tenants WHERE slug = $1",
    [slug],
  );
  if (!rows[0]) throw new ApiHttpError(404, "tenant_not_found", `tenant ${slug} was not found`);
  if (!rows[0].enabled) throw new ApiHttpError(403, "tenant_disabled", "tenant is disabled");
  return rows[0];
}

export async function listTenants(pool) {
  return (await pool.query(
    `SELECT t.id, t.slug, t.name, t.enabled, t.created_at, t.updated_at,
            count(DISTINCT p.project_id) AS projects,
            count(DISTINCT a.id) AS accounts,
            count(DISTINCT c.id) AS api_clients
       FROM service_tenants t
       LEFT JOIN service_project_bindings p ON p.tenant_id = t.id
       LEFT JOIN service_account_bindings a ON a.tenant_id = t.id
       LEFT JOIN service_api_clients c ON c.tenant_id = t.id
      GROUP BY t.id
      ORDER BY t.id`,
  )).rows;
}

export async function createTenant(pool, { slug, name }) {
  const normalized = String(slug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) {
    throw new ApiHttpError(422, "invalid_tenant_slug", "tenant slug must match [a-z0-9][a-z0-9_-]{0,62}");
  }
  const displayName = String(name ?? normalized).trim();
  const { rows } = await pool.query(
    `INSERT INTO service_tenants (slug, name)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id, slug, name, enabled, created_at, updated_at`,
    [normalized, displayName],
  );
  return rows[0];
}

export async function createApiClient(pool, { tenantId, name, scopes = DEFAULT_SCOPES, expiresAt = null }) {
  const normalizedScopes = [...new Set((Array.isArray(scopes) ? scopes : DEFAULT_SCOPES).map(String))];
  const secret = `ogl_live_${crypto.randomBytes(24).toString("base64url")}`;
  const keyPrefix = secret.slice(0, 16);
  const keyHash = hashServiceKey(secret);
  const { rows } = await pool.query(
    `INSERT INTO service_api_clients (tenant_id, name, key_prefix, key_hash, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id, tenant_id, name, key_prefix, scopes, enabled, expires_at, created_at`,
    [tenantId, String(name).trim(), keyPrefix, keyHash, JSON.stringify(normalizedScopes), expiresAt],
  );
  return { ...rows[0], api_key: secret };
}

export async function revokeApiClient(pool, clientId) {
  const { rowCount } = await pool.query(
    "UPDATE service_api_clients SET enabled = false, revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    [clientId],
  );
  return rowCount > 0;
}

export async function bindProject(pool, { tenantId, projectId, displayName, externalId = null }) {
  const { rows } = await pool.query(
    `INSERT INTO service_project_bindings (project_id, tenant_id, display_name, external_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id) DO UPDATE
       SET tenant_id = EXCLUDED.tenant_id,
           display_name = EXCLUDED.display_name,
           external_id = EXCLUDED.external_id,
           updated_at = now()
     RETURNING project_id, tenant_id, display_name, external_id`,
    [projectId, tenantId, displayName, externalId],
  );
  return rows[0];
}

export function internalProjectName(tenant, displayName) {
  const trimmed = String(displayName).trim();
  return tenant.slug === "default" ? trimmed : `${tenant.slug}::${trimmed}`;
}

export async function listTenantProjects(pool, tenantId) {
  return (await pool.query(
    `SELECT p.id, b.display_name AS name, b.external_id, p.description, p.target_brand,
            p.brand_aliases, p.brand_product_aliases, p.brand_exclude_patterns,
            p.created_at, p.updated_at,
            (SELECT count(*) FROM prompts q WHERE q.project_id = p.id AND q.deleted_at IS NULL) AS pool_size,
            (SELECT count(*) FROM prompts q WHERE q.project_id = p.id AND q.enabled AND q.deleted_at IS NULL) AS pool_enabled,
            (SELECT count(*) FROM sampling_batches sb WHERE sb.project_id = p.id) AS batch_count
       FROM service_project_bindings b
       JOIN projects p ON p.id = b.project_id
      WHERE b.tenant_id = $1
      ORDER BY p.created_at DESC`,
    [tenantId],
  )).rows;
}

export async function getTenantProject(pool, tenantId, projectId) {
  const { rows } = await pool.query(
    `SELECT p.*, b.display_name, b.external_id
       FROM service_project_bindings b
       JOIN projects p ON p.id = b.project_id
      WHERE b.tenant_id = $1 AND p.id = $2`,
    [tenantId, projectId],
  );
  return rows[0] ?? null;
}

function internalAccountKey(tenantId, provider, externalId) {
  const digest = crypto.createHash("sha256").update(`${tenantId}:${provider}:${externalId}`).digest("hex").slice(0, 24);
  return `t${tenantId}_${digest}`;
}

export async function ensureTenantAccount(pool, { tenantId, provider = "doubao", externalId, label = null }) {
  const external = String(externalId ?? "").trim();
  if (!external) throw new ApiHttpError(422, "invalid_account_id", "account_id is required");

  const existing = await pool.query(
    `SELECT b.id, b.account_key, b.external_id, b.label
       FROM service_account_bindings b
      WHERE b.tenant_id = $1 AND b.provider = $2 AND b.external_id = $3`,
    [tenantId, provider, external],
  );
  if (existing.rows[0]) return existing.rows[0];

  const accountKey = internalAccountKey(tenantId, provider, external);
  await pool.query(
    `INSERT INTO accounts (account_key, provider, label)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider, account_key) DO UPDATE SET label = COALESCE(EXCLUDED.label, accounts.label), updated_at = now()`,
    [accountKey, provider, label],
  );
  const { rows } = await pool.query(
    `INSERT INTO service_account_bindings (tenant_id, provider, account_key, external_id, label)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, tenant_id, provider, account_key, external_id, label, created_at`,
    [tenantId, provider, accountKey, external, label],
  );
  return rows[0];
}

export async function listTenantAccounts(pool, tenantId) {
  return (await pool.query(
    `SELECT b.id AS binding_id, b.external_id AS account_id, b.label,
            a.provider, a.enabled, a.status, a.last_health_status, a.last_health_checked_at,
            a.last_run_at, a.runs_today, a.runs_today_date, a.consecutive_failures,
            a.cooldown_until, a.paused_at, a.pause_reason, a.last_error_code,
            a.storage_state_present, a.created_at, a.updated_at
       FROM service_account_bindings b
       JOIN accounts a ON a.provider = b.provider AND a.account_key = b.account_key
      WHERE b.tenant_id = $1
      ORDER BY b.created_at DESC`,
    [tenantId],
  )).rows;
}

export async function resolveTenantAccountKeys(pool, tenantId, externalIds, provider = "doubao") {
  const wanted = [...new Set(externalIds.map(String))];
  const { rows } = await pool.query(
    `SELECT external_id, account_key
       FROM service_account_bindings
      WHERE tenant_id = $1 AND provider = $2 AND external_id = ANY($3::text[])`,
    [tenantId, provider, wanted],
  );
  const map = new Map(rows.map((row) => [row.external_id, row.account_key]));
  const missing = wanted.filter((id) => !map.has(id));
  if (missing.length) {
    throw new ApiHttpError(422, "unknown_accounts", "one or more accounts are not registered", { accounts: missing });
  }
  return wanted.map((id) => ({ externalId: id, accountKey: map.get(id) }));
}

export async function accountExternalIdMap(pool, tenantId) {
  const { rows } = await pool.query(
    "SELECT account_key, external_id FROM service_account_bindings WHERE tenant_id = $1",
    [tenantId],
  );
  return new Map(rows.map((row) => [row.account_key, row.external_id]));
}

export async function tenantOwnsBatch(pool, tenantId, batchId) {
  const { rows } = await pool.query(
    `SELECT b.id
       FROM sampling_batches b
       JOIN service_project_bindings pb ON pb.project_id = b.project_id
      WHERE b.id = $1 AND pb.tenant_id = $2`,
    [batchId, tenantId],
  );
  return Boolean(rows[0]);
}

export async function listTenantBatches(pool, tenantId, { projectId = null, limit = 100 } = {}) {
  return (await pool.query(
    `SELECT b.id, b.name, b.provider, b.status, b.pool_size, b.sample_size,
            b.sampling_method, b.sampling_seed, b.repeats, b.started_at, b.finished_at,
            b.created_at, b.queued_at, b.aborted_at, b.requested_jobs, b.completed_jobs,
            b.failed_jobs, b.skipped_jobs, b.last_heartbeat_at,
            p.id AS project_id, pb.display_name AS project_name, p.target_brand
       FROM sampling_batches b
       JOIN projects p ON p.id = b.project_id
       JOIN service_project_bindings pb ON pb.project_id = p.id
      WHERE pb.tenant_id = $1 AND ($2::bigint IS NULL OR p.id = $2)
      ORDER BY b.created_at DESC
      LIMIT $3`,
    [tenantId, projectId, limit],
  )).rows;
}

export async function tenantOwnsRun(pool, tenantId, localRunId) {
  const { rows } = await pool.query(
    `SELECT r.id
       FROM runs r
       JOIN prompts p ON p.id = r.prompt_id
       JOIN service_project_bindings pb ON pb.project_id = p.project_id
      WHERE r.local_run_id = $1 AND pb.tenant_id = $2`,
    [localRunId, tenantId],
  );
  return rows[0] ?? null;
}

function validateWebhookUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new ApiHttpError(422, "invalid_webhook_url", "webhook URL is invalid"); }
  const allowHttp = /^(1|true|yes)$/i.test(process.env.ONEGL_WEBHOOK_ALLOW_HTTP ?? "");
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new ApiHttpError(422, "invalid_webhook_url", "webhook URL must use HTTPS");
  }
  if (url.username || url.password) throw new ApiHttpError(422, "invalid_webhook_url", "webhook URL must not contain credentials");
  return url.toString();
}

export function webhookSecretFor(tenantId, endpointId) {
  const root = process.env.ONEGL_WEBHOOK_SIGNING_KEY;
  if (!root) throw new ApiHttpError(503, "webhook_signing_not_configured", "ONEGL_WEBHOOK_SIGNING_KEY is not configured");
  return crypto.createHmac("sha256", root).update(`${tenantId}:${endpointId}`).digest("base64url");
}

export async function createWebhookEndpoint(pool, { tenantId, url, eventTypes = ["*"], description = null }) {
  const normalizedUrl = validateWebhookUrl(url);
  const types = [...new Set((Array.isArray(eventTypes) && eventTypes.length ? eventTypes : ["*"]).map(String))];
  const { rows } = await pool.query(
    `INSERT INTO service_webhook_endpoints (tenant_id, url, event_types, description)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING id, tenant_id, url, event_types, enabled, description, created_at, updated_at`,
    [tenantId, normalizedUrl, JSON.stringify(types), description],
  );
  const endpoint = rows[0];
  return { ...endpoint, signing_secret: webhookSecretFor(tenantId, endpoint.id) };
}

export async function listWebhookEndpoints(pool, tenantId) {
  return (await pool.query(
    `SELECT id, url, event_types, enabled, description, created_at, updated_at
       FROM service_webhook_endpoints WHERE tenant_id = $1 ORDER BY id`,
    [tenantId],
  )).rows;
}

export async function deleteWebhookEndpoint(pool, tenantId, endpointId) {
  const { rowCount } = await pool.query(
    "DELETE FROM service_webhook_endpoints WHERE id = $1 AND tenant_id = $2",
    [endpointId, tenantId],
  );
  return rowCount > 0;
}

export async function createAuthSessionRow(pool, { tenantId, accountBindingId, ttlMinutes = 10 }) {
  const id = crypto.randomUUID();
  const ttl = Math.min(30, Math.max(2, Number(ttlMinutes) || 10));
  const { rows } = await pool.query(
    `INSERT INTO service_auth_sessions (id, tenant_id, account_binding_id, status, expires_at)
     VALUES ($1, $2, $3, 'pending', now() + ($4 * interval '1 minute'))
     RETURNING id, tenant_id, account_binding_id, status, state_details, created_at, updated_at, expires_at`,
    [id, tenantId, accountBindingId, ttl],
  );
  return rows[0];
}

export async function updateAuthSessionRow(pool, { id, tenantId, status, details = {}, complete = false }) {
  const { rows } = await pool.query(
    `UPDATE service_auth_sessions
        SET status = $3, state_details = $4::jsonb, updated_at = now(),
            completed_at = CASE WHEN $5 THEN now() ELSE completed_at END
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, tenant_id, account_binding_id, status, state_details, created_at, updated_at, expires_at, completed_at`,
    [id, tenantId, status, JSON.stringify(details ?? {}), complete],
  );
  return rows[0] ?? null;
}

export async function getAuthSessionRow(pool, tenantId, id) {
  const { rows } = await pool.query(
    `SELECT s.id, s.tenant_id, s.account_binding_id, s.status, s.state_details,
            s.created_at, s.updated_at, s.expires_at, s.completed_at,
            b.external_id AS account_id, b.account_key, b.provider, b.label
       FROM service_auth_sessions s
       JOIN service_account_bindings b ON b.id = s.account_binding_id
      WHERE s.id = $1 AND s.tenant_id = $2`,
    [id, tenantId],
  );
  return rows[0] ?? null;
}

export { DEFAULT_SCOPES };
