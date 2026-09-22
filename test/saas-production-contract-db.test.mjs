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
      ONEGL_API_KEY: "saas-production-test-key",
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

async function api(base, path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: "Bearer saas-production-test-key",
      "x-onegl-tenant": "default",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

async function createTask(base, suffix, accountId, index, idempotencyKey = null) {
  return api(base, "/v1/tasks", {
    method: "POST",
    headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    body: {
      external_id: `production-project-${suffix}-${index}`,
      name: `Production GEO ${suffix} ${index}`,
      target_brand: "测试品牌",
      questions: ["测试品牌值得买吗", "同类产品怎么选"],
      platforms: ["doubao"],
      account_ids: [accountId],
    },
  });
}

test("SaaS production contract provides idempotency, cursor pagination and public webhook events", { skip: !enabled }, async () => {
  const pool = createPool();
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const accountId = `production-doubao-${suffix}`;
  const port = 35000 + (process.pid % 500);
  const proc = startApi(port);
  const taskIds = [];

  try {
    await waitReady(proc);
    const base = `http://127.0.0.1:${port}`;

    const account = await api(base, "/v1/accounts", {
      method: "POST",
      body: { account_id: accountId, provider: "doubao", label: "Production contract test" },
    });
    assert.equal(account.response.status, 201);
    assert.equal(account.response.headers.get("x-onegl-api-version"), "0.7.0");

    const { rows: bindings } = await pool.query(
      `SELECT b.account_key
         FROM service_account_bindings b
         JOIN service_tenants t ON t.id = b.tenant_id
        WHERE t.slug = 'default' AND b.external_id = $1`,
      [accountId],
    );
    const accountKey = bindings[0]?.account_key;
    assert.ok(accountKey);
    await pool.query(
      "UPDATE accounts SET storage_state_present = true, status = 'healthy', enabled = true, updated_at = now() WHERE account_key = $1",
      [accountKey],
    );

    const taskKey = `task-${suffix}`;
    const first = await createTask(base, suffix, accountId, 1, taskKey);
    assert.equal(first.response.status, 201);
    const taskId = first.payload.data.task_id;
    taskIds.push(taskId);
    assert.match(taskId, /^tsk_[a-f0-9]{32}$/);
    assert.equal(first.response.headers.get("idempotency-replayed"), null);

    const replay = await createTask(base, suffix, accountId, 1, taskKey);
    assert.equal(replay.response.status, 201);
    assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
    assert.equal(replay.payload.data.task_id, taskId);

    const taskCount = await pool.query(
      "SELECT count(*)::int AS count FROM service_tasks WHERE external_id = $1",
      [`production-project-${suffix}-1`],
    );
    assert.equal(taskCount.rows[0].count, 1);

    const conflict = await api(base, "/v1/tasks", {
      method: "POST",
      headers: { "idempotency-key": taskKey },
      body: {
        external_id: `production-project-${suffix}-DIFFERENT`,
        name: "Different request",
        questions: ["不同的问题"],
        platforms: ["doubao"],
        account_ids: [accountId],
      },
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.payload.error, "idempotency_conflict");

    for (const index of [2, 3]) {
      const extra = await createTask(base, suffix, accountId, index);
      assert.equal(extra.response.status, 201);
      taskIds.push(extra.payload.data.task_id);
    }

    const page1 = await api(base, "/v1/tasks?limit=1");
    assert.equal(page1.response.status, 200);
    assert.equal(page1.payload.data.length, 1);
    assert.equal(page1.payload.meta.has_more, true);
    assert.ok(page1.payload.meta.next_cursor);

    const page2 = await api(base, `/v1/tasks?limit=1&cursor=${encodeURIComponent(page1.payload.meta.next_cursor)}`);
    assert.equal(page2.response.status, 200);
    assert.equal(page2.payload.data.length, 1);
    assert.notEqual(page2.payload.data[0].task_id, page1.payload.data[0].task_id);

    const badCursor = await api(base, "/v1/tasks?cursor=not-a-real-cursor");
    assert.equal(badCursor.response.status, 400);
    assert.equal(badCursor.payload.error, "invalid_cursor");

    const executionKey = `execution-${suffix}`;
    const executionBody = { start: false };
    const execution1 = await api(base, `/v1/tasks/${taskId}/executions`, {
      method: "POST",
      headers: { "idempotency-key": executionKey },
      body: executionBody,
    });
    assert.equal(execution1.response.status, 202);
    const executionId = execution1.payload.data.execution_id;
    const reportId = execution1.payload.data.report_id;
    assert.match(executionId, /^exe_[a-f0-9]{32}$/);
    assert.match(reportId, /^rpt_[a-f0-9]{32}$/);

    const execution2 = await api(base, `/v1/tasks/${taskId}/executions`, {
      method: "POST",
      headers: { "idempotency-key": executionKey },
      body: executionBody,
    });
    assert.equal(execution2.response.status, 202);
    assert.equal(execution2.response.headers.get("idempotency-replayed"), "true");
    assert.equal(execution2.payload.data.execution_id, executionId);
    assert.equal(execution2.payload.data.report_id, reportId);

    const executionCount = await pool.query(
      "SELECT count(*)::int AS count FROM service_task_executions WHERE public_id = $1",
      [executionId],
    );
    assert.equal(executionCount.rows[0].count, 1);

    const { rows: executionRows } = await pool.query(
      "SELECT batch_id FROM service_task_executions WHERE public_id = $1",
      [executionId],
    );
    const batchId = Number(executionRows[0]?.batch_id);
    assert.ok(batchId > 0);
    await pool.query(
      `UPDATE sampling_batches
          SET status = 'completed', completed_jobs = requested_jobs, finished_at = now()
        WHERE id = $1`,
      [batchId],
    );

    const executionEvent = await pool.query(
      `SELECT event_type, payload
         FROM service_webhook_events
        WHERE event_type = 'execution.completed'
          AND payload->>'execution_id' = $1
        ORDER BY id DESC LIMIT 1`,
      [executionId],
    );
    assert.equal(executionEvent.rows[0]?.event_type, "execution.completed");
    assert.equal(executionEvent.rows[0]?.payload?.task_id, taskId);
    assert.equal(executionEvent.rows[0]?.payload?.execution_id, executionId);
    assert.equal(executionEvent.rows[0]?.payload?.report_id, reportId);
    // A subscriber routes on these two without fetching the execution back.
    assert.equal(executionEvent.rows[0]?.payload?.platform, "doubao");
    assert.deepEqual(executionEvent.rows[0]?.payload?.login_states, []);

    await pool.query(
      "UPDATE accounts SET status = 'session_expired', updated_at = now() WHERE account_key = $1",
      [accountKey],
    );
    const actionEvent = await pool.query(
      `SELECT payload FROM service_webhook_events
        WHERE event_type = 'account.action_required' AND payload->>'account_id' = $1
        ORDER BY id DESC LIMIT 1`,
      [accountId],
    );
    assert.equal(actionEvent.rows[0]?.payload?.status, "session_expired");

    await pool.query(
      "UPDATE accounts SET storage_state_present = true, status = 'healthy', updated_at = now() WHERE account_key = $1",
      [accountKey],
    );
    const readyEvent = await pool.query(
      `SELECT payload FROM service_webhook_events
        WHERE event_type = 'account.ready' AND payload->>'account_id' = $1
        ORDER BY id DESC LIMIT 1`,
      [accountId],
    );
    assert.equal(readyEvent.rows[0]?.payload?.status, "ready");
  } finally {
    await stop(proc.child);
    for (const id of taskIds) {
      const { rows } = await pool.query("SELECT project_id FROM service_tasks WHERE public_id = $1", [id]).catch(() => ({ rows: [] }));
      if (rows[0]?.project_id) await pool.query("DELETE FROM projects WHERE id = $1", [rows[0].project_id]).catch(() => undefined);
    }
    await pool.query(
      "DELETE FROM service_idempotency_keys WHERE idempotency_key LIKE $1",
      [`%${suffix}%`],
    ).catch(() => undefined);
    await pool.query(
      `DELETE FROM accounts a USING service_account_bindings b, service_tenants t
        WHERE b.account_key = a.account_key AND b.tenant_id = t.id AND t.slug = 'default' AND b.external_id = $1`,
      [accountId],
    ).catch(() => undefined);
    await pool.end();
  }
});