import assert from "node:assert/strict";
import test from "node:test";

import { createPool } from "../src/db/pool.js";
import { cancelRemoteAuthSession, persistedRemoteAuthRuntime, persistedRemoteAuthScreenshot } from "../src/api/remote-auth.js";
import { createAuthSessionRow, createTenant, ensureTenantAccount } from "../src/api/service-store.js";

const enabled = Boolean(process.env.DATABASE_URL);

test("remote auth state is durable across API nodes", { skip: !enabled }, async () => {
  const pool = createPool();
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  let tenant;
  let account;
  try {
    tenant = await createTenant(pool, { slug: `auth_runtime_${suffix}`, name: "Auth runtime test" });
    account = await ensureTenantAccount(pool, { tenantId: tenant.id, externalId: `doubao-${suffix}` });
    const auth = await createAuthSessionRow(pool, { tenantId: tenant.id, accountBindingId: account.id, ttlMinutes: 10 });
    const imageBytes = Buffer.from([137, 80, 78, 71]);

    await pool.query(
      `UPDATE service_auth_sessions
          SET status = 'waiting_for_login', runtime_owner = 'api-node-a', runtime_heartbeat_at = now(),
              screenshot = $3, screenshot_at = now(), state_details = '{"screenshot_available":true}'::jsonb
        WHERE id = $1 AND tenant_id = $2`,
      [auth.id, tenant.id, imageBytes],
    );

    assert.deepEqual(await persistedRemoteAuthScreenshot(pool, tenant.id, auth.id), imageBytes);
    const { rows } = await pool.query(
      `SELECT status, updated_at, completed_at, runtime_owner, runtime_heartbeat_at,
              (screenshot IS NOT NULL) AS screenshot_available
         FROM service_auth_sessions WHERE id = $1 AND tenant_id = $2`,
      [auth.id, tenant.id],
    );
    const runtime = persistedRemoteAuthRuntime(rows[0]);
    assert.equal(runtime.state, "waiting_for_login");
    assert.equal(runtime.screenshot_available, true);
    assert.equal(runtime.browser_active, true);

    assert.equal(await cancelRemoteAuthSession({ pool, tenantId: tenant.id, id: auth.id }), true);
    const after = await pool.query(
      `SELECT status, cancel_requested_at, completed_at, screenshot, screenshot_at
         FROM service_auth_sessions WHERE id = $1`,
      [auth.id],
    );
    assert.equal(after.rows[0].status, "cancelled");
    assert.ok(after.rows[0].cancel_requested_at);
    assert.ok(after.rows[0].completed_at);
    assert.equal(after.rows[0].screenshot, null);
    assert.equal(after.rows[0].screenshot_at, null);
  } finally {
    if (tenant?.id) await pool.query("DELETE FROM service_tenants WHERE id = $1", [tenant.id]).catch(() => undefined);
    if (account?.account_key) await pool.query("DELETE FROM accounts WHERE provider = 'doubao' AND account_key = $1", [account.account_key]).catch(() => undefined);
    await pool.end();
  }
});
