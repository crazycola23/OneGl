import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildOpenApiDocument } from "../src/api/build-openapi.js";
import { ApiHttpError, errorPayload } from "../src/api/http.js";
import { reactivateTenantAccount, reclaimTenantAccount, requireScope } from "../src/api/service-store.js";
import { reclaimStaleAccountWorkers } from "../src/accounts/worker-reconcile.js";

const ACCOUNT_KEY = "t7_2f3a9c1b7d4e8a05c6b9d2f1";
const TENANT_ID = 7;
const EXTERNAL_ID = "acct-01";

function tempDataDir() {
  return mkdtemp(path.join(os.tmpdir(), "onegl-reactivate-"));
}

/**
 * 假 DB 只按语义解释账号这两组已知语句：本仓没有假池先例，真 SQL 由带 DATABASE_URL 的
 * *-db 测试兜底，这里覆盖的是「哪些行该翻、翻成什么值、不该动什么」。
 */
function fakeDb({ tenantId = TENANT_ID, bound = true, account } = {}) {
  const state = {
    binding: { tenant_id: tenantId, provider: "doubao", account_key: ACCOUNT_KEY, external_id: EXTERNAL_ID },
    account: {
      enabled: true,
      status: "healthy",
      storage_state_present: true,
      label: "keep-me",
      cooldown_until: new Date("2026-03-03T00:00:00Z"),
      runs_today: 3,
      updated_at: new Date("2026-01-01T00:00:00Z"),
      ...account,
    },
    bound,
    queries: [],
  };
  return {
    state,
    async query(sql, params) {
      state.queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (sql.includes("a.enabled") && sql.includes("FROM service_account_bindings b")) {
        const hit =
          state.bound &&
          state.binding.tenant_id === params[0] &&
          state.binding.provider === params[1] &&
          state.binding.external_id === params[2];
        return hit
          ? {
              rows: [{
                account_key: state.binding.account_key,
                enabled: state.account.enabled,
                status: state.account.status,
                storage_state_present: state.account.storage_state_present,
              }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT b.account_key") && sql.includes("FROM service_account_bindings b")) {
        const hit =
          state.bound &&
          state.binding.tenant_id === params[0] &&
          state.binding.provider === params[1] &&
          state.binding.external_id === params[2];
        return { rows: hit ? [{ account_key: state.binding.account_key }] : [], rowCount: hit ? 1 : 0 };
      }
      if (sql.includes("UPDATE accounts") && sql.includes("(NOT enabled OR status = 'disabled')")) {
        const account = state.account;
        const matched = !account.enabled || account.status === "disabled";
        if (matched) {
          account.enabled = true;
          account.status = "login_required";
          account.storage_state_present = false;
          account.updated_at = new Date("2026-04-04T00:00:00Z");
        }
        return {
          rows: matched
            ? [{ enabled: account.enabled, status: account.status, storage_state_present: account.storage_state_present }]
            : [],
          rowCount: matched ? 1 : 0,
        };
      }
      if (sql.includes("UPDATE accounts") && sql.includes("status = 'disabled'")) {
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
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test("reactivating a reclaimed account flips exactly the three state columns", async () => {
  const db = fakeDb({
    account: { enabled: false, status: "disabled", storage_state_present: false },
  });

  const result = await reactivateTenantAccount(db, { tenantId: TENANT_ID, externalId: EXTERNAL_ID });

  assert.deepEqual(result, {
    account_id: EXTERNAL_ID,
    provider: "doubao",
    enabled: true,
    status: "login_required",
    storage_state_present: false,
    reactivated: true,
  });
  // 恢复不等于恢复登录态：没有磁盘凭证可还，只能回到「需要重新扫码」，不能直接 healthy。
  assert.notEqual(result.status, "healthy");
  const update = db.state.queries.find((entry) => entry.sql.includes("SET enabled = true"));
  assert.match(update.sql, /SET enabled = true, status = 'login_required', storage_state_present = false/);
  assert.deepEqual(update.params, ["doubao", ACCOUNT_KEY]);
  // 只动这三列：label / cooldown_until / runs_today 保持原值，绑定关系不碰。
  assert.equal(db.state.account.label, "keep-me");
  assert.equal(db.state.account.runs_today, 3);
  assert.ok(db.state.account.cooldown_until instanceof Date);
  assert.equal(db.state.queries.some((entry) => /service_account_bindings.*(UPDATE|INSERT|DELETE)/is.test(entry.sql)), false);
});

test("reactivating an already enabled account is a no-op that keeps its status", async () => {
  const db = fakeDb({ account: { enabled: true, status: "healthy", storage_state_present: true } });

  const result = await reactivateTenantAccount(db, { tenantId: TENANT_ID, externalId: EXTERNAL_ID });

  assert.equal(result.reactivated, false);
  assert.equal(result.enabled, true);
  // 幂等路径不得把健康账号降级，否则每次重放都会把它改回 login_required。
  assert.equal(result.status, "healthy");
  assert.equal(result.storage_state_present, true);
  assert.equal(db.state.account.status, "healthy");
  const update = db.state.queries.find((entry) => entry.sql.includes("UPDATE accounts"));
  assert.match(update.sql, /AND \(NOT enabled OR status = 'disabled'\)/);
});

test("reactivating an unknown account id is a 404 account_not_found", async () => {
  const db = fakeDb({ bound: false });

  const error = await reactivateTenantAccount(db, { tenantId: TENANT_ID, externalId: "never-registered" }).then(
    () => null,
    (raised) => raised,
  );

  assert.ok(error instanceof ApiHttpError, "must reject with ApiHttpError");
  assert.equal(error.status, 404);
  assert.equal(error.code, "account_not_found");
  assert.equal(db.state.queries.length, 1, "must not reach the UPDATE when the binding is missing");
  // 上游按响应体形状区分「账号不存在」与「路由不存在」，所以断言到 body 而不只是状态码。
  const payload = errorPayload(error);
  assert.equal(payload.status, 404);
  assert.deepEqual(Object.keys(payload.body).sort(), ["error", "message"]);
  assert.equal(payload.body.error, "account_not_found");
  assert.ok(payload.body.message.includes("never-registered"));
  assert.equal(payload.body.details, undefined);
});

test("reactivation is tenant scoped and rejects an empty account id", async () => {
  const foreign = fakeDb({ tenantId: 8 });
  await assert.rejects(
    () => reactivateTenantAccount(foreign, { tenantId: TENANT_ID, externalId: EXTERNAL_ID }),
    (error) => error.status === 404 && error.code === "account_not_found",
  );

  const db = fakeDb();
  await assert.rejects(
    () => reactivateTenantAccount(db, { tenantId: TENANT_ID, externalId: "  " }),
    (error) => error.status === 422 && error.code === "invalid_account_id",
  );
  assert.equal(db.state.queries.length, 0, "an empty account id must not hit the database");
});

test("reclaim then reactivate round-trips the account into a re-login state", async () => {
  const db = fakeDb();
  const dataDir = await tempDataDir();

  const reclaimed = await reclaimTenantAccount(db, { tenantId: TENANT_ID, externalId: EXTERNAL_ID, dataDir });
  assert.equal(reclaimed.reclaimed, true);
  assert.equal(db.state.account.status, "disabled");

  const reactivated = await reactivateTenantAccount(db, { tenantId: TENANT_ID, externalId: EXTERNAL_ID });
  assert.equal(reactivated.reactivated, true);
  assert.equal(reactivated.enabled, true);
  assert.equal(reactivated.status, "login_required");
  assert.equal(reactivated.storage_state_present, false);

  // 反向幂等：再调一次不再翻状态，也不回退。
  const again = await reactivateTenantAccount(db, { tenantId: TENANT_ID, externalId: EXTERNAL_ID });
  assert.equal(again.reactivated, false);
  assert.equal(again.status, "login_required");
});

test("worker discovery picks a reactivated account back up on the next 60s sweep", async () => {
  // 真行为在 src/worker.js：discoverAccounts 按 enabled = true 取 key 并 startWorkerFor，
  // 这个 60s 扫描就是「恢复后自动接回、无需重启」的全部依据，所以把它钉住。
  const source = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
  assert.match(source, /SELECT account_key FROM accounts WHERE enabled = true/);
  assert.match(source, /\}, 60_000\)\.unref\(\)/);
  assert.match(source, /for \(const row of rows\) \{\s*await startWorkerFor\(row\.account_key\);/);

  // 对称的停线路径仍是按 key 移除被回收的账号，恢复后该 key 重新出现在 enabled 集合里。
  const workers = new Map();
  const stopped = [];
  const stopWorkerFor = async (accountKey) => {
    if (!workers.has(accountKey)) return;
    workers.delete(accountKey);
    stopped.push(accountKey);
  };
  workers.set(ACCOUNT_KEY, {});
  await reclaimStaleAccountWorkers(workers.keys(), [], stopWorkerFor);
  assert.deepEqual(stopped, [ACCOUNT_KEY]);
  assert.equal(workers.has(ACCOUNT_KEY), false, "reclaimed account must lose its resident worker");
  await reclaimStaleAccountWorkers(workers.keys(), [ACCOUNT_KEY], stopWorkerFor);
  assert.deepEqual(stopped, [ACCOUNT_KEY], "an enabled account is never stopped by the sweep");
});

test("requiring accounts:write rejects a credential without that scope", async () => {
  assert.throws(
    () => requireScope({ scopes: ["accounts:read"] }, "accounts:write"),
    (error) => error.status === 403 && error.code === "insufficient_scope",
  );
  assert.throws(() => requireScope({ scopes: [] }, "accounts:write"), (error) => error.status === 403);

  assert.doesNotThrow(() => requireScope({ scopes: ["accounts:write"] }, "accounts:write"));
  assert.doesNotThrow(() => requireScope({ scopes: ["*"] }, "accounts:write"));
  assert.doesNotThrow(() => requireScope({ master: true, scopes: [] }, "accounts:write"));
});

test("OpenAPI documents the reactivate operation with its typed envelope", () => {
  const document = buildOpenApiDocument();
  const pathItem = document.paths["/v1/accounts/{accountId}/reactivate"];
  assert.ok(pathItem, "POST /v1/accounts/{accountId}/reactivate must be documented");
  assert.equal(pathItem.parameters[0].name, "accountId");

  const operation = pathItem.post;
  assert.equal(operation.operationId, "createAccountsByAccountIdReactivate");
  assert.deepEqual(operation.tags, ["Accounts"]);
  for (const status of ["200", "403", "404"]) {
    assert.ok(operation.responses[status], `${status} must be documented`);
  }
  const schema = operation.responses["200"].content["application/json"].schema;
  assert.equal(schema.properties.data.$ref, "#/components/schemas/AccountReactivateResource");
  const resource = document.components.schemas.AccountReactivateResource;
  assert.deepEqual(
    Object.keys(resource.properties).sort(),
    ["account_id", "enabled", "provider", "reactivated", "status", "storage_state_present"],
  );
  assert.deepEqual(
    [...resource.required].sort(),
    ["account_id", "enabled", "provider", "reactivated", "status", "storage_state_present"],
  );
  // 语义防线写进契约：恢复落点是 login_required 而不是 healthy。
  assert.match(operation.description, /login_required/);
});
