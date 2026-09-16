import crypto from "node:crypto";

const ALL_SCOPES = Object.freeze([
  "projects:read",
  "projects:write",
  "accounts:read",
  "accounts:connect",
  "batches:read",
  "batches:write",
  "reports:read",
  "webhooks:manage",
  "clients:manage",
]);

export function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function generateApiKey() {
  return `ogl_${crypto.randomBytes(32).toString("base64url")}`;
}

export function generatePublicToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function clientKeyPrefix(key) {
  return String(key).slice(0, 12);
}

function requestKey(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] || String(req.headers["x-api-key"] || "");
}

export async function authenticateServiceRequest(pool, req) {
  const provided = requestKey(req);
  if (!provided) return null;

  const root = process.env.ONEGL_API_KEY;
  if (root && crypto.timingSafeEqual(Buffer.from(hashSecret(provided)), Buffer.from(hashSecret(root)))) {
    const { rows } = await pool.query("SELECT * FROM api_tenants WHERE slug = 'default' AND enabled = true");
    const tenant = rows[0];
    if (!tenant) return null;
    return { kind: "root", tenant, client: null, scopes: new Set(ALL_SCOPES) };
  }

  const digest = hashSecret(provided);
  const { rows } = await pool.query(
    `SELECT c.*, t.slug AS tenant_slug, t.name AS tenant_name, t.enabled AS tenant_enabled
       FROM api_clients c
       JOIN api_tenants t ON t.id = c.tenant_id
      WHERE c.key_hash = $1 AND c.enabled = true AND c.revoked_at IS NULL`,
    [digest],
  );
  const client = rows[0];
  if (!client || !client.tenant_enabled) return null;
  await pool.query("UPDATE api_clients SET last_used_at = now() WHERE id = $1", [client.id]).catch(() => undefined);
  return {
    kind: "client",
    tenant: { id: client.tenant_id, slug: client.tenant_slug, name: client.tenant_name, enabled: true },
    client,
    scopes: new Set(Array.isArray(client.scopes) ? client.scopes : []),
  };
}

export function requireScope(auth, scope) {
  if (!auth?.scopes?.has(scope)) {
    const error = new Error(`missing required scope: ${scope}`);
    error.status = 403;
    error.code = "insufficient_scope";
    throw error;
  }
}

export async function createTenant(pool, { slug, name }) {
  const normalized = String(slug || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.test(normalized)) {
    throw new Error("tenant slug must match [a-z0-9][a-z0-9_-]{1,62}[a-z0-9]");
  }
  const { rows } = await pool.query(
    `INSERT INTO api_tenants(slug, name) VALUES($1,$2)
     ON CONFLICT(slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING *`,
    [normalized, String(name || normalized).trim()],
  );
  return rows[0];
}

export async function createApiClient(pool, { tenantId, name, scopes = ALL_SCOPES }) {
  const requested = [...new Set(scopes.map(String))];
  const invalid = requested.filter((scope) => !ALL_SCOPES.includes(scope));
  if (invalid.length) throw new Error(`unknown scopes: ${invalid.join(", ")}`);
  const apiKey = generateApiKey();
  const { rows } = await pool.query(
    `INSERT INTO api_clients(tenant_id, name, key_prefix, key_hash, scopes)
     VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id, tenant_id, name, key_prefix, scopes, enabled, created_at`,
    [tenantId, String(name || "client").trim(), clientKeyPrefix(apiKey), hashSecret(apiKey), JSON.stringify(requested)],
  );
  return { ...rows[0], api_key: apiKey };
}

export async function listApiClients(pool, tenantId) {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, name, key_prefix, scopes, enabled, last_used_at, created_at, revoked_at
       FROM api_clients WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows;
}

export async function revokeApiClient(pool, tenantId, clientId) {
  const { rowCount } = await pool.query(
    `UPDATE api_clients SET enabled = false, revoked_at = now()
      WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [clientId, tenantId],
  );
  return rowCount > 0;
}

export const SERVICE_SCOPES = ALL_SCOPES;
