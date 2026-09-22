import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenApiDocument } from "../src/api/build-openapi.js";
import {
  countNotCollected,
  getExecution,
  getReport,
  listExecutionResults,
  listTaskReports,
  publicReportListItemFields,
} from "../src/tasks/service.js";

const EXECUTION_ID = "exe_0123456789abcdef0123456789abcdef";
const REPORT_ID = "rpt_0123456789abcdef0123456789abcdef";
const TASK_ID = "tsk_0123456789abcdef0123456789abcdef";
const RESULT_ID = "res_0123456789abcdef0123456789abcdef";

/**
 * Names each statement the service layer issues so a test can hand back rows per statement and
 * still see the SQL text. The point of reading the SQL is the field under test: a projection
 * that reports a platform nobody selected from is worse than no platform at all.
 */
function statementOf(sql) {
  const s = sql.replace(/\s+/g, " ").trim();
  if (s.includes("count(*) FILTER")) return "not_collected";
  if (s.includes("FROM service_reports rp")) return s.includes("rp.public_id = $2") ? "report" : "report_list";
  if (s.includes("FROM service_task_results sr")) return "results";
  if (s.includes("FROM service_tasks WHERE tenant_id")) return "task_internal";
  if (s.includes("service_task_executions e")) return s.includes("t.name AS task_name") ? "execution" : "execution_internal";
  throw new Error(`unexpected SQL: ${s}`);
}

function fakePool(rows) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      const statement = statementOf(sql);
      seen.push({ statement, sql: sql.replace(/\s+/g, " ").trim(), params });
      const row = rows[statement];
      if (!row) throw new Error(`no fixture for ${statement}`);
      return { rows: Array.isArray(row) ? row : [row] };
    },
  };
}

test("an execution reports the platform its own batch collected", async () => {
  const pool = fakePool({
    execution: {
      id: 12,
      public_id: EXECUTION_ID,
      task_public_id: TASK_ID,
      task_name: "千问监测",
      report_public_id: REPORT_ID,
      batch_provider: "qianwen",
      batch_status: "completed",
      trigger_type: "manual",
      requested_jobs: 2,
      completed_jobs: 2,
      failed_jobs: 0,
      skipped_jobs: 0,
      login_states: ["anonymous"],
      created_at: "2026-09-22T00:00:00.000Z",
    },
    not_collected: { not_collected: 0 },
  });

  const execution = await getExecution(pool, 1, EXECUTION_ID);
  assert.equal(execution.platform, "qianwen");
  assert.deepEqual(execution.login_states, ["anonymous"]);
  // A Task may name several platforms; the batch it ran on is the only honest answer.
  assert.match(pool.seen[0].sql, /b\.provider AS batch_provider/);
  assert.match(pool.seen[0].sql, /array_agg\(DISTINCT ru\.login_state ORDER BY ru\.login_state\)/);
});

test("an execution with no runs yet reports no surfaces rather than inventing one", async () => {
  const pool = fakePool({
    execution: { public_id: EXECUTION_ID, batch_provider: "doubao", batch_status: null, login_states: null },
    not_collected: { not_collected: 0 },
  });

  const execution = await getExecution(pool, 1, EXECUTION_ID);
  assert.deepEqual(execution.login_states, []);
  assert.equal(execution.status, "pending");
});

test("a result row carries the observation surface of its run", async () => {
  const pool = fakePool({
    execution_internal: { id: 4, batch_id: 9 },
    results: {
      result_id: RESULT_ID,
      question: "二十万级 SUV 推荐",
      platform: "qianwen",
      run_status: "success",
      run_login_state: "anonymous",
      batch_status: "completed",
    },
  });

  const rows = await listExecutionResults(pool, 1, EXECUTION_ID);
  assert.match(pool.seen[1].sql, /r\.login_state AS run_login_state/);
  assert.equal(rows[0].login_state, "anonymous");
  assert.equal(rows[0].platform, "qianwen");
});

test("a report list item names its platform through one shared projection", () => {
  assert.deepEqual(
    publicReportListItemFields({ provider: "qianwen", status: "aborted", created_at: "x", finished_at: null }),
    { platform: "qianwen", status: "ready", execution_status: "cancelled", created_at: "x", finished_at: null },
  );
  // A row that cannot say which platform it came on must not default to the first one either.
  assert.equal(publicReportListItemFields({ status: "running" }).platform, null);
});

test("report reads carry their batch platform and surfaces", async () => {
  const pool = fakePool({
    report: { public_id: REPORT_ID, batch_provider: "qianwen", login_states: ["account", "anonymous"] },
    task_internal: { id: 7, public_id: TASK_ID },
    report_list: { report_id: REPORT_ID, execution_id: EXECUTION_ID, provider: "qianwen", status: "completed" },
  });

  const report = await getReport(pool, 1, REPORT_ID);
  assert.match(pool.seen[0].sql, /b\.provider AS batch_provider/);
  assert.deepEqual(report.login_states, ["account", "anonymous"]);

  const [item] = await listTaskReports(pool, 1, TASK_ID);
  assert.equal(item.platform, "qianwen");
  assert.equal(item.execution_status, "completed");
});

/**
 * not_collected is a required, published field. While a batch still runs, an assignment with no
 * run row is work that has not started, and counting it here would present `remaining` as loss.
 */
test("unstarted assignments only count as not_collected once the batch is terminal", async () => {
  const pool = fakePool({ not_collected: { not_collected: 3 } });

  assert.equal(await countNotCollected(pool, 4, "running"), 3);
  assert.deepEqual(pool.seen[0].params, [4, false]);
  assert.match(pool.seen[0].sql, /r\.status = 'failed'/);

  await countNotCollected(pool, 4, "completed");
  assert.deepEqual(pool.seen[1].params, [4, true]);
});

/**
 * The direction that actually hurts: a field the runtime writes that the contract never
 * declared is invisible to openapi-typescript consumers, so an integration cannot route on it
 * even though it is there. The reverse (a declared field a given endpoint omits) is allowed.
 */
test("projections emit no field the public contract has not declared", async () => {
  const { schemas } = buildOpenApiDocument().components;
  const pool = fakePool({
    execution: { public_id: EXECUTION_ID, batch_provider: "qianwen", batch_status: "completed", login_states: ["anonymous"] },
    not_collected: { not_collected: 0 },
    execution_internal: { id: 4, batch_id: 9 },
    results: { result_id: RESULT_ID, platform: "qianwen", run_status: "success", run_login_state: "anonymous", batch_status: "completed" },
  });

  const emitted = {
    ExecutionResource: Object.keys(await getExecution(pool, 1, EXECUTION_ID)),
    ResultListItem: Object.keys((await listExecutionResults(pool, 1, EXECUTION_ID))[0]),
  };
  for (const [schema, keys] of Object.entries(emitted)) {
    const declared = Object.keys(schemas[schema].properties);
    assert.deepEqual(keys.filter((key) => !declared.includes(key)), [], `${schema} emits undeclared fields`);
  }
});
