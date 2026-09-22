import assert from "node:assert/strict";
import test from "node:test";

import { ApiHttpError, errorPayload } from "../src/api/http.js";
import {
  accountInflightState,
  countAccountQueueJobs,
  countAccountReferences,
} from "../src/accounts/inflight.js";

const ACCOUNT_KEY = "t7_2f3a9c1b7d4e8a05c6b9d2f1";
const TENANT_ID = 7;
const EXTERNAL_ID = "acct-01";

function withEnv(name, value, run) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
}

/**
 * 假 DB 只解释这两条已知语句；真 SQL（jsonb 包含、count 口径）由带 DATABASE_URL 的
 * *-db 测试兜底，这里覆盖的是「计数怎么合成 reclaim_safe」和「取不到时往哪个方向降级」。
 */
function fakeDb({ referencing = { enabled_schedules: "0", enabled_monitor_plans: "0" }, bound = true } = {}) {
  const state = { queries: [], referencing, bound };
  return {
    state,
    async query(sql, params) {
      state.queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (sql.includes("FROM service_account_bindings b")) {
        return state.bound
          ? { rows: [{ account_key: ACCOUNT_KEY }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM service_task_schedules s")) {
        return { rows: [state.referencing], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

const zeroQueue = () => ({ waiting: 0, active: 0, delayed: 0 });

function fakeQueueCounter(counts, calls = []) {
  return async (accountKey) => {
    calls.push(accountKey);
    return typeof counts === "function" ? counts() : counts;
  };
}

test("an account with nothing in flight and nothing referencing it is reclaim safe", async () => {
  const db = fakeDb();
  const data = await accountInflightState(db, {
    tenantId: TENANT_ID,
    externalId: EXTERNAL_ID,
    queueCounter: fakeQueueCounter(zeroQueue()),
  });

  assert.deepEqual(data, {
    account_id: EXTERNAL_ID,
    queue: { waiting: 0, active: 0, delayed: 0 },
    referencing: { enabled_schedules: 0, enabled_monitor_plans: 0 },
    reclaim_safe: true,
  });
  // pg 的 count 是字符串，必须已归一成 JSON 数字，否则调用方的 ===0 判定会翻车。
  assert.equal(typeof data.queue.waiting, "number");
  assert.equal(typeof data.referencing.enabled_schedules, "number");
});

test("every in-flight and referencing dimension alone is enough to block reclaim", async () => {
  const blocking = [
    { queue: { waiting: 1, active: 0, delayed: 0 } },
    { queue: { waiting: 0, active: 1, delayed: 0 } },
    { queue: { waiting: 0, active: 0, delayed: 3 } },
    { referencing: { enabled_schedules: "1", enabled_monitor_plans: "0" } },
    { referencing: { enabled_schedules: "0", enabled_monitor_plans: "2" } },
  ];

  for (const case_ of blocking) {
    const db = fakeDb({ referencing: case_.referencing ?? { enabled_schedules: "0", enabled_monitor_plans: "0" } });
    const data = await accountInflightState(db, {
      tenantId: TENANT_ID,
      externalId: EXTERNAL_ID,
      queueCounter: fakeQueueCounter(case_.queue ?? zeroQueue()),
    });
    assert.equal(data.reclaim_safe, false, `${JSON.stringify(case_)} must block reclaim`);
    assert.deepEqual(Object.keys(data), ["account_id", "queue", "referencing", "reclaim_safe"]);
  }
});

test("the in-flight read is read-only: no write statement is issued", async () => {
  const db = fakeDb();
  await accountInflightState(db, {
    tenantId: TENANT_ID,
    externalId: EXTERNAL_ID,
    queueCounter: fakeQueueCounter(zeroQueue()),
  });

  assert.equal(db.state.queries.length, 2, "one existence check plus one aggregated count query");
  for (const { sql } of db.state.queries) {
    assert.match(sql, /^SELECT /);
    assert.equal(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER)\b/i.test(sql), false, sql);
  }
});

test("an unknown account id is a 404 account_not_found before anything is read", async () => {
  const db = fakeDb({ bound: false });
  const calls = [];

  const failure = await accountInflightState(db, {
    tenantId: TENANT_ID,
    externalId: "never-registered",
    queueCounter: fakeQueueCounter(zeroQueue(), calls),
  }).then(() => null, (error) => error);

  // 上游按响应体里的 error 区分「账号不存在」与「路由不存在」，所以要断言真正发出去的 body。
  const wire = errorPayload(failure);
  assert.equal(wire.status, 404);
  assert.equal(wire.body.error, "account_not_found");
  assert.notEqual(wire.body.error, "not_found");
  assert.deepEqual(calls, [], "the queue must not be touched for an unknown account");
  assert.equal(db.state.queries.length, 1);
});

test("referencing counts are scoped to the tenant and matched against plan account_ids", async () => {
  const db = fakeDb();
  await countAccountReferences(db, { tenantId: TENANT_ID, externalId: EXTERNAL_ID });

  const { sql, params } = db.state.queries[0];
  assert.match(sql, /FROM service_task_schedules s JOIN service_monitor_plans sp/);
  assert.match(sql, /sp\.enabled AND sp\.account_ids @> \$2::jsonb/);
  assert.match(sql, /FROM service_monitor_plans p WHERE p\.tenant_id = \$1 AND p\.enabled/);
  assert.deepEqual(params, [TENANT_ID, JSON.stringify([EXTERNAL_ID])]);
});

test("a queue that cannot be reached answers 503 instead of a reclaimable zero", async () => {
  await withEnv("REDIS_URL", undefined, async () => {
    await assert.rejects(
      () => countAccountQueueJobs(ACCOUNT_KEY),
      (error) => error instanceof ApiHttpError && error.status === 503 && error.code === "queue_unavailable",
    );
  });
});

test("a Redis failure while counting is wrapped into 503 and closes the queue instance", async () => {
  let closed = 0;
  await withEnv("REDIS_URL", "redis://127.0.0.1:6379", async () => {
    await assert.rejects(
      () => countAccountQueueJobs(ACCOUNT_KEY, {
        queueFactory: (name) => ({
          name,
          getJobCounts: async () => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
          },
          close: async () => {
            closed += 1;
          },
        }),
      }),
      (error) =>
        error instanceof ApiHttpError
        && error.status === 503
        && error.code === "queue_unavailable"
        && /ECONNREFUSED/.test(JSON.stringify(error.details)),
    );
    assert.equal(closed, 1);
  });
});

test("an unreadable job count is an error, never a zero", async () => {
  for (const counts of [{}, undefined, { waiting: 0, active: 0 }, { waiting: -1, active: 0, delayed: 0 }]) {
    await withEnv("REDIS_URL", "redis://127.0.0.1:6379", async () => {
      await assert.rejects(
        () => countAccountQueueJobs(ACCOUNT_KEY, {
          queueFactory: () => ({ getJobCounts: async () => counts, close: async () => undefined }),
        }),
        (error) => error instanceof ApiHttpError && error.status === 503 && error.code === "queue_unavailable",
        `counts ${JSON.stringify(counts)} must not be reported as zero`,
      );
    });
  }
});

test("the real queue counter reads the per-account queue name and its three states", async () => {
  const seen = {};
  await withEnv("REDIS_URL", "redis://127.0.0.1:6379", async () => {
    const result = await countAccountQueueJobs(ACCOUNT_KEY, {
      queueFactory: (name) => ({
        getJobCounts: async (...states) => {
          seen.name = name;
          seen.states = states;
          return { waiting: "2", active: 1, delayed: 0 };
        },
        close: async () => undefined,
      }),
    });
    assert.equal(seen.name, `onegl-run-doubao-${ACCOUNT_KEY}`);
    assert.deepEqual(seen.states, ["waiting", "active", "delayed"]);
    // Redis 的 SCARD/ZCARD 回字符串，返回体里必须是数字。
    assert.deepEqual(result, { waiting: 2, active: 1, delayed: 0 });
  });
});

test("the in-flight count is scoped to the provider's own queue", async () => {
  const names = [];
  await withEnv("REDIS_URL", "redis://127.0.0.1:6379", async () => {
    const factory = (name) => ({
      getJobCounts: async () => {
        names.push(name);
        return { waiting: 0, active: 0, delayed: 0 };
      },
      close: async () => undefined,
    });
    // 同一个 account_key 在两个平台下是两条队列：只数豆包队列会漏掉另一边的在飞任务，
    // 于是 reclaim_safe 会在对方还在跑的时候报「可以回收」。
    await countAccountQueueJobs(ACCOUNT_KEY, { provider: "doubao", queueFactory: factory });
    await countAccountQueueJobs(ACCOUNT_KEY, { provider: "yuanbao", queueFactory: factory });
    assert.deepEqual(names, [
      `onegl-run-doubao-${ACCOUNT_KEY}`,
      `onegl-run-yuanbao-${ACCOUNT_KEY}`,
    ]);
  });
});

test("an unobservable queue keeps the whole judgment unavailable", async () => {
  const db = fakeDb();
  const counters = {
    "503 from the counter": async () => {
      throw new ApiHttpError(503, "queue_unavailable", "REDIS_URL is not configured");
    },
    // Redis 抛的不是 ApiHttpError：判据接口也不能把它变成 500/0，必须统一降级方向。
    "raw redis error": async () => {
      throw new Error("Connection is closed");
    },
  };

  for (const [label, queueCounter] of Object.entries(counters)) {
    await assert.rejects(
      () => accountInflightState(db, { tenantId: TENANT_ID, externalId: EXTERNAL_ID, queueCounter }),
      (error) => error instanceof ApiHttpError && error.status === 503 && error.code === "queue_unavailable",
      label,
    );
  }
});

test("OpenAPI documents the in-flight operation with its typed envelope", async () => {
  // 动态导入：build-openapi.js 在模块顶层就构建整份文档，静态导入会让本文件其余用例一起死在 import 阶段。
  const { buildOpenApiDocument } = await import("../src/api/build-openapi.js");
  const document = buildOpenApiDocument();
  const operation = document.paths["/v1/accounts/{accountId}/inflight"]?.get;
  assert.ok(operation, "GET /v1/accounts/{accountId}/inflight must be documented");
  assert.equal(operation.operationId, "getAccountsByAccountIdInflight");
  assert.deepEqual(operation.tags, ["Accounts"]);
  assert.equal(document.paths["/v1/accounts/{accountId}/inflight"].parameters[0].name, "accountId");
  for (const status of ["200", "403", "404", "503"]) {
    assert.ok(operation.responses[status], `${status} must be documented`);
  }
  const schema = operation.responses["200"].content["application/json"].schema;
  assert.equal(schema.properties.data.$ref, "#/components/schemas/AccountInflightResource");

  const resource = document.components.schemas.AccountInflightResource;
  assert.deepEqual(resource.required, ["account_id", "queue", "referencing", "reclaim_safe"]);
  assert.deepEqual(Object.keys(resource.properties.queue.properties).sort(), ["active", "delayed", "waiting"]);
  assert.deepEqual(
    Object.keys(resource.properties.referencing.properties).sort(),
    ["enabled_monitor_plans", "enabled_schedules"],
  );
  assert.equal(resource.properties.reclaim_safe.type, "boolean");
});
