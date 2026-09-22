import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  accountStorageStatePaths,
  removeAccountStorageStates,
} from "../src/accounts/registry.js";
import { reclaimStaleAccountWorkers } from "../src/accounts/worker-reconcile.js";
import { buildOpenApiDocument } from "../src/api/build-openapi.js";
import { ApiHttpError } from "../src/api/http.js";
import { listTenantAccounts, reclaimTenantAccount } from "../src/api/service-store.js";

const ACCOUNT_KEY = "t7_2f3a9c1b7d4e8a05c6b9d2f1";

function tempDataDir() {
  return mkdtemp(path.join(os.tmpdir(), "onegl-reclaim-"));
}

/**
 * 假 DB 只按语义解释这三条已知语句：本仓没有假池先例，真正的 SQL 由 *-db 测试在
 * 有 DATABASE_URL 时兜底，这里覆盖的是软删落地与幂等判定。
 */
function fakeDb(tenantId = 7) {
  const state = {
    binding: { tenant_id: tenantId, provider: "doubao", account_key: ACCOUNT_KEY, external_id: "acct-01" },
    account: {
      enabled: true,
      status: "healthy",
      storage_state_present: true,
      updated_at: new Date("2026-01-01T00:00:00Z"),
    },
    queries: [],
  };
  return {
    state,
    async query(sql, params) {
      state.queries.push({ sql, params });
      if (sql.trim().startsWith("SELECT b.account_key")) {
        const hit =
          state.binding.tenant_id === params[0] &&
          state.binding.provider === params[1] &&
          state.binding.external_id === params[2];
        return { rows: hit ? [{ account_key: state.binding.account_key }] : [], rowCount: hit ? 1 : 0 };
      }
      if (sql.includes("UPDATE accounts")) {
        const account = state.account;
        const matched = account.enabled || account.status !== "disabled";
        if (matched) {
          account.enabled = false;
          account.status = "disabled";
          account.storage_state_present = false;
          account.updated_at = new Date("2026-02-02T00:00:00Z");
        }
        return { rows: matched ? [{ updated_at: account.updated_at }] : [], rowCount: matched ? 1 : 0 };
      }
      if (sql.includes("AS binding_id")) {
        return {
          rows: [{
            binding_id: 11,
            account_id: state.binding.external_id,
            label: null,
            provider: state.binding.provider,
            enabled: state.account.enabled,
            status: state.account.status,
            storage_state_present: state.account.storage_state_present,
            updated_at: state.account.updated_at,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

async function seedStorageState(dataDir, accountKey, contents = "{}", provider = "doubao") {
  const directory = path.join(dataDir, "auth", "accounts");
  await mkdir(directory, { recursive: true });
  for (const file of accountStorageStatePaths(dataDir, accountKey, provider)) {
    await writeFile(file, contents, "utf8");
  }
  return directory;
}

test("reclaim soft-deletes the account row and the tenant list reflects it", async () => {
  const db = fakeDb();
  const dataDir = await tempDataDir();

  const result = await reclaimTenantAccount(db, {
    tenantId: 7,
    externalId: "acct-01",
    dataDir,
  });

  assert.equal(result.reclaimed, true);
  assert.equal(result.account_id, "acct-01");
  assert.equal(new Date(result.reclaimed_at).toISOString(), "2026-02-02T00:00:00.000Z");
  assert.deepEqual(
    await listTenantAccounts(db, 7).then((rows) => rows.map(({ enabled, status }) => ({ enabled, status }))),
    [{ enabled: false, status: "disabled" }],
  );
  assert.equal(db.state.account.storage_state_present, false);
  // 软删不物理删行：历史 runs 按 account_key 归属。
  assert.equal(db.state.queries.some((entry) => /DELETE FROM/i.test(entry.sql)), false);
  const update = db.state.queries.find((entry) => entry.sql.includes("UPDATE accounts"));
  assert.match(update.sql.replace(/\s+/g, " "), /SET enabled = false, status = 'disabled'/);
  assert.deepEqual(update.params, ["doubao", ACCOUNT_KEY]);
});

test("reclaim is idempotent and reports that nothing was removed the second time", async () => {
  const db = fakeDb();
  const dataDir = await tempDataDir();
  await seedStorageState(dataDir, ACCOUNT_KEY);

  const first = await reclaimTenantAccount(db, { tenantId: 7, externalId: "acct-01", dataDir });
  const second = await reclaimTenantAccount(db, { tenantId: 7, externalId: "acct-01", dataDir });

  assert.equal(first.reclaimed, true);
  assert.equal(first.storage_state_removed, true);
  // Doubao state exists under both the provider-scoped and the pre-scoping name, so a
  // reclaim has to clear all four candidates rather than leave a live credential behind.
  assert.equal(first.storage_state_files_removed, 4);
  assert.equal(second.reclaimed, false);
  assert.equal(second.storage_state_removed, false);
  assert.equal(second.storage_state_files_removed, 0);
  assert.equal(second.reclaimed_at, null);
  assert.equal(second.account_id, "acct-01");
});

test("reclaim of an unknown account id is a 404 account_not_found", async () => {
  const db = fakeDb();
  const dataDir = await tempDataDir();

  await assert.rejects(
    () => reclaimTenantAccount(db, { tenantId: 7, externalId: "never-registered", dataDir }),
    (error) =>
      error instanceof ApiHttpError && error.status === 404 && error.code === "account_not_found",
  );
  assert.equal(db.state.queries.length, 1, "must not reach the UPDATE when the binding is missing");
});

test("reclaim clears provider-scoped and legacy Doubao state for that account only", async () => {
  const dataDir = await tempDataDir();
  const directory = await seedStorageState(dataDir, ACCOUNT_KEY, "mine");
  const neighbour = path.join(directory, "t8_otherkey.storage.json");
  await writeFile(neighbour, "not mine", "utf8");

  const removed = await removeAccountStorageStates(dataDir, ACCOUNT_KEY);
  assert.deepEqual(removed.map((file) => path.basename(file)).sort(), [
    `doubao__${ACCOUNT_KEY}.storage.json`,
    `doubao__${ACCOUNT_KEY}.storage.json.enc`,
    `${ACCOUNT_KEY}.storage.json`,
    `${ACCOUNT_KEY}.storage.json.enc`,
  ]);
  assert.deepEqual(await removeAccountStorageStates(dataDir, ACCOUNT_KEY), [], "missing files are not an error");
  await assert.rejects(() => removeAccountStorageStates(dataDir, "../t8"));
  assert.equal(await readFile(neighbour, "utf8"), "not mine");
});

test("reclaiming one provider leaves the same account key on another provider intact", async () => {
  const dataDir = await tempDataDir();
  await seedStorageState(dataDir, ACCOUNT_KEY, "doubao-state", "doubao");
  await seedStorageState(dataDir, ACCOUNT_KEY, "kimi-state", "kimi");

  await removeAccountStorageStates(dataDir, ACCOUNT_KEY, "doubao");

  for (const file of accountStorageStatePaths(dataDir, ACCOUNT_KEY, "kimi")) {
    assert.equal(await readFile(file, "utf8"), "kimi-state", `${path.basename(file)} must survive`);
  }
});

test("worker reconcile retires only accounts that left the enabled set", async () => {
  const workers = new Map();
  const closedKeys = [];
  const stoppedKeys = [];
  const track = (accountKey) => {
    workers.set(accountKey, { close: async () => { closedKeys.push(accountKey); } });
  };
  // 复刻 src/worker.js 的 stopWorkerFor：先摘 map 再 close，两者都必须发生。
  const stopWorkerFor = async (accountKey) => {
    const worker = workers.get(accountKey);
    if (!worker) return;
    workers.delete(accountKey);
    stoppedKeys.push(accountKey);
    await worker.close();
  };
  track("kept-account");
  track("reclaimed-account");

  const stopped = await reclaimStaleAccountWorkers(workers.keys(), ["kept-account"], stopWorkerFor);

  assert.deepEqual(stopped, ["reclaimed-account"]);
  assert.deepEqual(stoppedKeys, ["reclaimed-account"]);
  assert.deepEqual(closedKeys, ["reclaimed-account"], "an enabled account is never closed");
  assert.deepEqual([...workers.keys()], ["kept-account"], "the reclaimed key must leave the tracked set");
  assert.deepEqual(await reclaimStaleAccountWorkers(workers.keys(), ["kept-account"], stopWorkerFor), []);
  assert.deepEqual(stoppedKeys, ["reclaimed-account"], "a second sweep must not stop anything again");
});

test("OpenAPI documents the reclaim operation with its typed envelope", () => {
  const document = buildOpenApiDocument();
  const operation = document.paths["/v1/accounts/{accountId}"]?.delete;
  assert.ok(operation, "DELETE /v1/accounts/{accountId} must be documented");
  assert.equal(operation.operationId, "deleteAccountsByAccountId");
  assert.deepEqual(operation.tags, ["Accounts"]);
  assert.equal(document.paths["/v1/accounts/{accountId}"].parameters[0].name, "accountId");
  for (const status of ["200", "403", "404"]) {
    assert.ok(operation.responses[status], `${status} must be documented`);
  }
  const schema = operation.responses["200"].content["application/json"].schema;
  assert.equal(schema.properties.data.$ref, "#/components/schemas/AccountReclaimResource");
  assert.ok(document.components.schemas.AccountReclaimResource.properties.reclaimed);
  assert.deepEqual(
    Object.keys(document.components.schemas.AccountReclaimResource.properties).sort(),
    [
      "account_id",
      "enabled",
      "provider",
      "reclaim_marked_by",
      "reclaimed",
      "reclaimed_at",
      "status",
      "storage_state_files_removed",
      "storage_state_removed",
    ],
  );
});
