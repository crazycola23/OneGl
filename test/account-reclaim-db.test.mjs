import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { accountStorageStatePaths } from "../src/accounts/registry.js";
import { createTenant, ensureTenantAccount, listTenantAccounts, reclaimTenantAccount } from "../src/api/service-store.js";
import { createPool } from "../src/db/pool.js";

const enabled = Boolean(process.env.DATABASE_URL);

test("reclaim soft-deletes a real account row, keeps the rows and clears login state", { skip: !enabled }, async () => {
  const pool = createPool();
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const slug = `reclaim_${suffix}`;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "onegl-reclaim-db-"));
  let accountKey = null;
  try {
    const tenant = await createTenant(pool, { slug, name: "Reclaim probe" });
    const account = await ensureTenantAccount(pool, {
      tenantId: tenant.id,
      externalId: "acct-01",
      label: "reclaim probe",
    });
    accountKey = account.account_key;

    const directory = path.join(dataDir, "auth", "accounts");
    await mkdir(directory, { recursive: true });
    const candidates = accountStorageStatePaths(dataDir, accountKey);
    for (const file of candidates) await writeFile(file, "{}", "utf8");

    const first = await reclaimTenantAccount(pool, { tenantId: tenant.id, externalId: "acct-01", dataDir });
    assert.equal(first.reclaimed, true);
    assert.equal(first.storage_state_removed, true);
    assert.equal(first.storage_state_files_removed, 2);
    assert.ok(first.reclaimed_at);
    for (const file of candidates) {
      await assert.rejects(() => stat(file), `login state must be gone: ${file}`);
    }

    const [row] = await listTenantAccounts(pool, tenant.id);
    assert.equal(row.account_id, "acct-01");
    assert.equal(row.enabled, false);
    assert.equal(row.status, "disabled");
    assert.equal(row.storage_state_present, false);

    // 重复调用必须幂等地回到 200 形态的结果，而不是 404/409。
    const second = await reclaimTenantAccount(pool, { tenantId: tenant.id, externalId: "acct-01", dataDir });
    assert.equal(second.reclaimed, false);
    assert.equal(second.storage_state_removed, false);
    assert.equal(second.storage_state_files_removed, 0);
    assert.equal(second.account_id, "acct-01");

    // 历史可追溯靠的是行还在：软删不允许带走 accounts / service_account_bindings。
    const kept = await pool.query(
      `SELECT count(*) AS bindings FROM service_account_bindings WHERE account_key = $1`,
      [accountKey],
    );
    assert.equal(Number(kept.rows[0].bindings), 1);

    await assert.rejects(
      () => reclaimTenantAccount(pool, { tenantId: tenant.id, externalId: "never-registered", dataDir }),
      (error) => error.status === 404 && error.code === "account_not_found",
    );
  } finally {
    // accounts 行是本测试新建的一次性数据，binding 由外键级联带走。
    if (accountKey) {
      await pool.query("DELETE FROM accounts WHERE provider = 'doubao' AND account_key = $1", [accountKey])
        .catch(() => undefined);
    }
    await pool.query("DELETE FROM service_tenants WHERE slug = $1", [slug]).catch(() => undefined);
    await pool.end();
  }
});
