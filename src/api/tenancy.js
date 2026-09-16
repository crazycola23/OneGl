export function internalProjectName(tenantSlug, externalName) {
  const name = String(externalName || "").trim();
  if (!name) throw new Error("project name is required");
  return tenantSlug === "default" ? name : `${tenantSlug}::${name}`;
}

export function internalAccountKey(tenantSlug, externalKey) {
  const key = String(externalKey || "").trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(key)) {
    throw new Error("account key must match [A-Za-z0-9._-]{1,40}");
  }
  if (tenantSlug === "default") return key;
  const candidate = `${tenantSlug}--${key}`;
  if (candidate.length > 64) throw new Error("tenant/account key combination is too long");
  return candidate;
}

export async function attachProject(pool, tenantId, projectId, externalName) {
  await pool.query(
    `INSERT INTO api_tenant_projects(tenant_id, project_id, external_name)
     VALUES($1,$2,$3)
     ON CONFLICT(tenant_id, project_id) DO UPDATE SET external_name = EXCLUDED.external_name`,
    [tenantId, projectId, externalName],
  );
}

export async function tenantProject(pool, tenantId, projectId) {
  const { rows } = await pool.query(
    `SELECT p.*, tp.external_name
       FROM api_tenant_projects tp
       JOIN projects p ON p.id = tp.project_id
      WHERE tp.tenant_id = $1 AND tp.project_id = $2`,
    [tenantId, projectId],
  );
  return rows[0] ?? null;
}

export async function listTenantProjects(pool, tenantId) {
  const { rows } = await pool.query(
    `SELECT p.id, tp.external_name AS name, p.description, p.target_brand,
            p.brand_aliases, p.brand_product_aliases, p.brand_exclude_patterns,
            p.created_at, p.updated_at,
            (SELECT count(*) FROM prompts q WHERE q.project_id=p.id AND q.deleted_at IS NULL) AS pool_size,
            (SELECT count(*) FROM prompts q WHERE q.project_id=p.id AND q.enabled AND q.deleted_at IS NULL) AS pool_enabled,
            (SELECT count(*) FROM sampling_batches b WHERE b.project_id=p.id) AS batch_count
       FROM api_tenant_projects tp
       JOIN projects p ON p.id = tp.project_id
      WHERE tp.tenant_id = $1
      ORDER BY p.created_at DESC`,
    [tenantId],
  );
  return rows;
}

export async function attachAccount(pool, tenantId, accountKey, { provider = "doubao", label = null } = {}) {
  await pool.query(
    `INSERT INTO api_tenant_accounts(tenant_id, account_key, provider, label)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(tenant_id, provider, account_key) DO UPDATE SET label = COALESCE(EXCLUDED.label, api_tenant_accounts.label)`,
    [tenantId, accountKey, provider, label],
  );
}

export async function tenantAccount(pool, tenantId, accountKey, provider = "doubao") {
  const { rows } = await pool.query(
    `SELECT a.*, ta.label AS tenant_label
       FROM api_tenant_accounts ta
       JOIN accounts a ON a.provider=ta.provider AND a.account_key=ta.account_key
      WHERE ta.tenant_id=$1 AND ta.provider=$2 AND ta.account_key=$3`,
    [tenantId, provider, accountKey],
  );
  return rows[0] ?? null;
}

export async function listTenantAccounts(pool, tenantId) {
  const { rows } = await pool.query(
    `SELECT a.*, ta.label AS tenant_label,
            (SELECT count(*) FROM runs r WHERE r.account_key=a.account_key) AS run_count,
            (SELECT count(*) FROM runs r WHERE r.account_key=a.account_key AND r.started_at::date=CURRENT_DATE) AS run_count_today
       FROM api_tenant_accounts ta
       JOIN accounts a ON a.provider=ta.provider AND a.account_key=ta.account_key
      WHERE ta.tenant_id=$1
      ORDER BY a.account_key`,
    [tenantId],
  );
  return rows;
}

export async function tenantOwnsBatch(pool, tenantId, batchId) {
  const { rows } = await pool.query(
    `SELECT b.id FROM sampling_batches b
     JOIN api_tenant_projects tp ON tp.project_id=b.project_id
     WHERE tp.tenant_id=$1 AND b.id=$2`,
    [tenantId, batchId],
  );
  return Boolean(rows[0]);
}

export async function tenantOwnsRun(pool, tenantId, localRunId) {
  const { rows } = await pool.query(
    `SELECT r.id FROM runs r
       JOIN prompts p ON p.id=r.prompt_id
       JOIN api_tenant_projects tp ON tp.project_id=p.project_id
      WHERE tp.tenant_id=$1 AND r.local_run_id=$2`,
    [tenantId, localRunId],
  );
  return Boolean(rows[0]);
}
