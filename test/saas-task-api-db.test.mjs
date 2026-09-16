import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { createPool } from "../src/db/pool.js";

const enabled = Boolean(process.env.DATABASE_URL);

function startApi(port) {
  const child = spawn(process.execPath, ["src/api-server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ONEGL_API_HOST: "127.0.0.1",
      ONEGL_API_PORT: String(port),
      ONEGL_API_KEY: "saas-task-test-key",
      REDIS_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitReady(proc, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (proc.output().stdout.includes("OneGl Service API:")) return;
    if (proc.child.exitCode !== null) throw new Error(`API exited early\n${proc.output().stdout}\n${proc.output().stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`API did not start\n${proc.output().stdout}\n${proc.output().stderr}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function api(base, path, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: "Bearer saas-task-test-key",
      "x-onegl-tenant": "default",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

test("SaaS task facade returns stable task/execution/result/report/schedule IDs", { skip: !enabled }, async () => {
  const pool = createPool();
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const accountId = `doubao-${suffix}`;
  const port = 34500 + (process.pid % 500);
  const proc = startApi(port);
  let taskId = null;

  try {
    await waitReady(proc);
    const base = `http://127.0.0.1:${port}`;

    const account = await api(base, "/v1/accounts", {
      method: "POST",
      body: { account_id: accountId, provider: "doubao", label: "SaaS test" },
    });
    assert.equal(account.response.status, 201);

    const task = await api(base, "/v1/tasks", {
      method: "POST",
      body: {
        external_id: `saas-project-${suffix}`,
        name: `SaaS GEO ${suffix}`,
        target_brand: "测试品牌",
        questions: ["测试品牌值得买吗", "同类产品怎么选"],
        platforms: ["doubao"],
        account_ids: [accountId],
      },
    });
    assert.equal(task.response.status, 201);
    taskId = task.payload.data.task_id;
    assert.match(taskId, /^tsk_[a-f0-9]{32}$/);
    assert.deepEqual(task.payload.data.questions, ["测试品牌值得买吗", "同类产品怎么选"]);

    const blocked = await api(base, `/v1/tasks/${taskId}/executions`, { method: "POST", body: { start: false } });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.payload.error, "account_action_required");

    const { rows: bindings } = await pool.query(
      `SELECT b.account_key
         FROM service_account_bindings b
         JOIN service_tenants t ON t.id = b.tenant_id
        WHERE t.slug = 'default' AND b.external_id = $1`,
      [accountId],
    );
    assert.ok(bindings[0]?.account_key);
    await pool.query(
      "UPDATE accounts SET storage_state_present = true, status = 'healthy', enabled = true WHERE account_key = $1",
      [bindings[0].account_key],
    );

    const execution = await api(base, `/v1/tasks/${taskId}/executions`, { method: "POST", body: { start: false } });
    assert.equal(execution.response.status, 202);
    const executionId = execution.payload.data.execution_id;
    const reportId = execution.payload.data.report_id;
    assert.match(executionId, /^exe_[a-f0-9]{32}$/);
    assert.match(reportId, /^rpt_[a-f0-9]{32}$/);
    assert.equal(execution.payload.data.status, "pending");

    const polled = await api(base, `/v1/executions/${executionId}`);
    assert.equal(polled.response.status, 200);
    assert.equal(polled.payload.data.execution_id, executionId);
    assert.equal(polled.payload.data.progress.total, 2);
    assert.equal(polled.payload.data.progress.remaining, 2);
    assert.equal(polled.payload.data.progress.percent, 0);

    const results = await api(base, `/v1/executions/${executionId}/results`);
    assert.equal(results.response.status, 200);
    assert.equal(results.payload.data.length, 2);
    assert.ok(results.payload.data.every((row) => /^res_[a-f0-9]{32}$/.test(row.result_id)));
    assert.ok(results.payload.data.every((row) => row.status === "pending"));

    const oneResult = await api(base, `/v1/results/${results.payload.data[0].result_id}`);
    assert.equal(oneResult.response.status, 200);
    assert.equal(oneResult.payload.data.question, results.payload.data[0].question);
    assert.equal(oneResult.payload.data.status, "pending");

    const report = await api(base, `/v1/reports/${reportId}`);
    assert.equal(report.response.status, 200);
    assert.equal(report.payload.data.report_id, reportId);
    assert.equal(report.payload.data.execution_id, executionId);
    assert.equal(report.payload.data.status, "generating");

    const historicalReports = await api(base, `/v1/tasks/${taskId}/reports`);
    assert.equal(historicalReports.response.status, 200);
    assert.equal(historicalReports.payload.data[0].report_id, reportId);

    const schedule = await api(base, `/v1/tasks/${taskId}/schedules`, {
      method: "POST",
      body: {
        name: "每日监测",
        schedule: { cadence: "daily", time_zone: "Asia/Shanghai", local_time: "09:00" },
        account_ids: [accountId],
        enabled: true,
      },
    });
    assert.equal(schedule.response.status, 201);
    assert.match(schedule.payload.data.schedule_id, /^sch_[a-f0-9]{32}$/);
    assert.equal(schedule.payload.data.task_id, taskId);
  } finally {
    await stop(proc.child);
    if (taskId) {
      const { rows } = await pool.query("SELECT project_id FROM service_tasks WHERE public_id = $1", [taskId]);
      if (rows[0]?.project_id) await pool.query("DELETE FROM projects WHERE id = $1", [rows[0].project_id]).catch(() => undefined);
    }
    await pool.query(
      `DELETE FROM accounts a USING service_account_bindings b, service_tenants t
        WHERE b.account_key = a.account_key AND b.tenant_id = t.id AND t.slug = 'default' AND b.external_id = $1`,
      [accountId],
    ).catch(() => undefined);
    await pool.end();
  }
});
