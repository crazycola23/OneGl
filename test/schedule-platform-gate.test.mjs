import assert from "node:assert/strict";
import test from "node:test";

import { createScheduleResource } from "../src/api/task-routes.js";
import { ApiHttpError } from "../src/api/http.js";

const TENANT = { id: 7, slug: "default" };

/**
 * Serves only the reads a schedule creation performs before it would insert a monitor plan:
 * the task row, its question list and the account bindings. Anything past that is the
 * plan writer's business, and this file is about the gate in front of it.
 */
function fakeDb({ platforms, bindings }) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      const text = sql.replace(/\s+/g, " ").trim();
      seen.push(text);
      if (text.includes("FROM service_tasks t")) {
        return {
          rows: [{
            id: 12,
            public_id: "tsk_0123456789abcdef0123456789abcdef",
            tenant_id: TENANT.id,
            project_id: 3,
            external_id: "saas-1",
            name: "监测任务",
            target_brand: "品牌A",
            platforms,
            account_ids: bindings.map((row) => row.external_id),
            sampling_method: "stratified",
            repeats: 1,
            revision: 1,
            state: "active",
            execution_count: 0,
            latest_execution_id: null,
            created_at: "2026-09-20T00:00:00.000Z",
            updated_at: "2026-09-20T00:00:00.000Z",
          }],
        };
      }
      if (text.includes("SELECT * FROM service_tasks WHERE tenant_id")) {
        return { rows: [{ id: 12, public_id: "tsk_0123456789abcdef0123456789abcdef", project_id: 3 }] };
      }
      if (text.includes("FROM prompts q")) return { rows: [] };
      if (text.includes("FROM service_account_bindings")) {
        const [, provider, ids] = params;
        return {
          rows: bindings
            .filter((row) => row.provider === provider && ids.includes(row.external_id))
            .map(({ external_id, account_key }) => ({ external_id, account_key })),
        };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

function rejection(call) {
  return call.then(() => null, (error) => error);
}

test("a Qianwen schedule is refused rather than run through the Doubao collector", async () => {
  const db = fakeDb({
    platforms: ["qianwen"],
    bindings: [{ provider: "qianwen", external_id: "acct-qw", account_key: "lane_01" }],
  });

  const error = await rejection(createScheduleResource(db, TENANT, "tsk_0123456789abcdef0123456789abcdef", {
    schedule: { cadence: "daily", local_time: "09:00" },
    account_ids: ["acct-qw"],
  }));

  assert.ok(error instanceof ApiHttpError, `expected an ApiHttpError, got ${error}`);
  assert.equal(error.code, "unsupported_schedule_platform");
  assert.equal(error.status, 422);
  assert.deepEqual(error.details.platforms, ["qianwen"]);
});

test("a Doubao schedule passes the platform gate", async () => {
  const db = fakeDb({
    platforms: ["doubao"],
    bindings: [{ provider: "doubao", external_id: "acct-main", account_key: "lane_01" }],
  });

  // The plan writer needs a real database, so this only asserts the request got that far:
  // failing anywhere other than the platform gate is the pass condition here.
  const error = await rejection(createScheduleResource(db, TENANT, "tsk_0123456789abcdef0123456789abcdef", {
    schedule: { cadence: "daily", local_time: "09:00" },
    account_ids: ["acct-main"],
  }));

  assert.notEqual(error?.code, "unsupported_schedule_platform");
});
