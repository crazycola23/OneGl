import assert from "node:assert/strict";
import test from "node:test";

import { createPool } from "../src/db/pool.js";
import { createProject } from "../src/db/dashboard.js";
import {
  bindProject,
  createApiClient,
  createTenant,
  ensureTenantAccount,
  getTenantProject,
  hashServiceKey,
  listTenantAccounts,
  listTenantProjects,
} from "../src/api/service-store.js";

const enabled = Boolean(process.env.DATABASE_URL);

test("service platform isolates tenant projects/accounts and stores API client keys hashed", { skip: !enabled }, async () => {
  const pool = createPool();
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  try {
    const tenantA = await createTenant(pool, { slug: `tenant_a_${suffix}`, name: "Tenant A" });
    const tenantB = await createTenant(pool, { slug: `tenant_b_${suffix}`, name: "Tenant B" });

    const client = await createApiClient(pool, {
      tenantId: tenantA.id,
      name: `client_${suffix}`,
      scopes: ["projects:read", "accounts:read"],
    });
    assert.match(client.api_key, /^ogl_live_/);
    const stored = await pool.query("SELECT key_hash FROM service_api_clients WHERE id=$1", [client.id]);
    assert.notEqual(stored.rows[0].key_hash, client.api_key);
    assert.equal(stored.rows[0].key_hash, hashServiceKey(client.api_key));

    const projectA = await createProject(pool, { name: `${tenantA.slug}::Project`, targetBrand: "A" });
    const projectB = await createProject(pool, { name: `${tenantB.slug}::Project`, targetBrand: "B" });
    await bindProject(pool, { tenantId: tenantA.id, projectId: projectA.id, displayName: "Project" });
    await bindProject(pool, { tenantId: tenantB.id, projectId: projectB.id, displayName: "Project" });

    assert.equal((await listTenantProjects(pool, tenantA.id)).length, 1);
    assert.equal((await listTenantProjects(pool, tenantB.id)).length, 1);
    assert.equal((await getTenantProject(pool, tenantA.id, projectA.id)).display_name, "Project");
    assert.equal(await getTenantProject(pool, tenantA.id, projectB.id), null);

    const accountA = await ensureTenantAccount(pool, {
      tenantId: tenantA.id,
      externalId: "primary",
      label: "A primary",
    });
    const accountB = await ensureTenantAccount(pool, {
      tenantId: tenantB.id,
      externalId: "primary",
      label: "B primary",
    });
    assert.notEqual(accountA.account_key, accountB.account_key);
    assert.deepEqual((await listTenantAccounts(pool, tenantA.id)).map((item) => item.account_id), ["primary"]);
    assert.deepEqual((await listTenantAccounts(pool, tenantB.id)).map((item) => item.account_id), ["primary"]);
  } finally {
    await pool.query("DELETE FROM service_tenants WHERE slug LIKE $1", [`%${suffix}`]).catch(() => undefined);
    await pool.end();
  }
});
