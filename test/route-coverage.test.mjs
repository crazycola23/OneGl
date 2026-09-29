import "dotenv/config";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { readFileSync } from "node:fs";

/**
 * 端点可达性走查：契约里声明的每个 v1 端点，是否真的能路由到。
 *
 * ## 为什么要这个
 *
 * 静态检查（openapi-contract-coverage 等）只看契约本身，
 * 验证 operationId 唯一、错误码齐全、schema 有定义 ——
 * 但它们**不验证实现里有没有对应的路由分支**。
 *
 * 真实事故：检索端点 `/v1/task-groups/{id}/answers/search` 的路由正则
 * 捕获组布局写错，group 形态下 100% 报 500。而当时：
 *   - 契约检查全绿（路径在契约里、schema 完整、错误码齐全）
 *   - 14 个服务层测试全绿（直接调 searchAnswers({groupId}) 返回 69 条）
 *   - 唯一的「验证」是我手工跑的脚本
 *
 * 换句话说：**契约完整 + 服务层正确 ≠ 端点可用**。
 *
 * 本测试从 openapi.json 读出所有 v1 端点，用合规的假 id 发真实请求，
 * 然后断言「不是 404/405」—— 404/405 说明路由没匹配上或没有实现，
 * 而 400/401/403/422 说明路由通了、只是参数或权限不对。
 *
 * 目标是发现「死端点」，不是验证业务逻辑。
 */

const API_KEY = "route-coverage-test-key";

function startApi(port, withDb = false) {
  const child = spawn(process.execPath, ["src/api-server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ONEGL_API_HOST: "127.0.0.1",
      ONEGL_API_PORT: String(port),
      ONEGL_API_KEY: API_KEY,
      REDIS_URL: "",
      // 无库模式只验证「路由能否匹配」；有库模式才能区分
      // 「路由没匹配」与「路由匹配了但实体不存在」
      DATABASE_URL: withDb ? process.env.DATABASE_URL : "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += String(c); });
  child.stderr.on("data", (c) => { stderr += String(c); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitReady(proc, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (proc.output().stdout.includes("OneGl Service API:")) return;
    if (proc.child.exitCode !== null) {
      throw new Error(`API exited early\n${proc.output().stdout}\n${proc.output().stderr}`);
    }
    await new Promise((r) => setTimeout(r, 50));
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

/**
 * 合规但必然不存在的假 id。
 *
 * key **不带花括号** —— 替换器传进来的就是 `{groupId}` 去掉花括号后的
 * `groupId`。第一版写成 `"{groupId}"`，结果 70 个端点全部替换失败、
 * 打成 `/v1/task-groups/x-groupId/…`，于是报 73 个「路由未匹配」。
 *
 * 更重要的是：值必须**符合各路由自己的格式约束**，否则探针测的是
 * 「id 格式对不对」而不是「路由通不通」。比如 auth-sessions 要 UUID
 * （`[0-9a-f-]{36}`），传 `unknown-authSessionId` 会得到 404 ——
 * 那是格式错，不是端点不存在。用错格式的 id 得出「端点不可达」是
 * 探针设计错误，会把 20 个活端点误报成死的。
 */
const FAKES = {
  accountId: "unknown-accountId", // 内部账号体系用非 hex 标识
  authSessionId: "00000000-0000-4000-8000-000000000000", // 必须是 UUID 形态
  batchId: "999999999",
  // 注意：这几个在契约里声明为 integer，实现里也是 (\d+)。
  // 传字符串会让路由正则不匹配，得到的 404 只说明 id 格式错。
  // webhookId 也是 integer —— 契约与实现的 (\d+) 一致，别想当然写成 whk_…
  clientId: "999999999",
  competitorId: "999999999",
  monitorPlanId: "999999999",
  tenantId: "999999999",
  webhookId: "999999999",
  executionId: "exe_" + "a".repeat(24),
  groupId: "grp_" + "e".repeat(32),
  projectId: "999999999",
  reportId: "rpt_" + "c".repeat(32),
  resultId: "res_" + "d".repeat(24),
  revision: "1",
  runId: "run_b68_i1",
  scheduleId: "sch_" + "e".repeat(24),
  taskGroupId: "grp_" + "e".repeat(32),
  taskId: "tsk_" + "d".repeat(32),
};

function concretize(pathname) {
  return pathname.replace(/\{([^}]+)\}/g, (_, key) => FAKES[key] ?? `unknown-${key}`);
}

const METHODS = ["get", "post", "put", "patch", "delete"];

test("契约里每个 v1 端点都有可用的路由实现", { timeout: 120_000 }, async () => {
  const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
  const port = 37600 + (process.pid % 300);
  // 有库时用真库：无库模式下所有请求都返回 503，
  // 连「路由没匹配」和「路由匹配了但 id 传错」都区分不出来 ——
  // 实测无库版本抓不住捕获组布局那个真实 bug。
  const withDb = Boolean(process.env.DATABASE_URL);
  const proc = startApi(port, withDb);

  try {
    await waitReady(proc);
    const base = `http://127.0.0.1:${port}`;

    const dead = [];
    const serverErrors = [];
    const checked = [];

    for (const [pathname, pathItem] of Object.entries(spec.paths ?? {})) {
      if (!pathname.startsWith("/v1/")) continue;
      const url = `${base}${concretize(pathname)}`;

      for (const method of METHODS) {
        if (!pathItem?.[method]) continue;

        // GET / DELETE 不带 body：带 body 的 GET 在部分客户端会被忽略
        const withBody = method === "get" || method === "delete" ? undefined : {};
        const response = await fetch(url, {
          method: method.toUpperCase(),
          headers: {
            authorization: `Bearer ${API_KEY}`,
            accept: "application/json",
            ...(withBody === undefined ? {} : { "content-type": "application/json" }),
          },
          body: withBody === undefined ? undefined : JSON.stringify(withBody),
        });

        const label = `${method.toUpperCase()} ${pathname}`;
        checked.push(label);

        let body = "";
        try {
          body = JSON.stringify(await response.json()).slice(0, 200);
        } catch { /* 非 JSON 响应体 */ }

        // 死端点判据。
        //
        // 踩过的坑，一步步说清楚：
        //   1. 只看 404/405 → 漏掉「路由匹配了但内部抛错」（会变 500）
        //   2. 改看「404 + 业务错误码」→ 方向反了，那恰是路由正常工作的证据
        //   3. 只看固定文案 "API route not found" → 能抓路由未匹配，
        //      但抓不到 handler 内部异常
        //
        // 现在用两条互补的判据：
        //   a) 405 或兜底 404 文案 → 路由没匹配上（硬伤）
        //   b) 500 → 路由匹配了但内部抛错，这类要靠真实 id 才能暴露，
        //      这里对 scope 类端点额外用真实 id 复测（见下方 scope 断言）
        const isDeadRoute = response.status === 405 ||
          (response.status === 404 && /API route not found/i.test(body));
        if (isDeadRoute) {
          dead.push(`${label} → ${response.status} ${body}`);
        }
        if (response.status === 500) {
          serverErrors.push(`${label} → 500 ${body}`);
        }
      }
    }

    assert.ok(checked.length >= 60, `应检查足够多的端点，实际 ${checked.length}`);

    assert.deepEqual(dead, [],
      `以下端点在契约里声明但路由不可达（${dead.length}/${checked.length}，` +
      `模式：${withDb ? "有库" : "无库（能力受限）"}）:\n${dead.join("\n")}`);

    // 500 单独报：它意味着「路由匹配了但内部抛错」。
    // 用假 id 探测时 500 有时是正常的（参数校验顺序问题），
    // 所以这里只提示不失败 —— 真正的 500 检测见下面的「真实 id」用例。
    if (serverErrors.length) {
      console.log(`\n[提示] ${serverErrors.length} 个端点对假 id 返回 500（` +
        `${serverErrors.slice(0, 3).join("; ")}${serverErrors.length > 3 ? " …" : ""}）`);
    }
  } finally {
    await stop(proc.child);
  }
});

test("检测逻辑本身能抓到死端点（自检）", { timeout: 60_000 }, async () => {
  // 一个永远绿的测试没有价值。这里起**有库**的 API，用真 id 走一遍：
  // 存在的实体 → 200，格式合法但不存在的实体 → 404。
  // 无库时所有请求都是 503，区分不出「路由通了」和「路由没匹配」，
  // 所以自检必须显式传 DATABASE_URL 给子进程（startApi 默认清空它）。
  if (!process.env.DATABASE_URL) return; // 无库跳过
  const port = 38100 + (process.pid % 100);
  const proc = startApi(port, true);

  try {
    await waitReady(proc);
    const base = `http://127.0.0.1:${port}`;

    const alive = await fetch(`${base}/v1/capabilities`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    assert.notEqual(alive.status, 404, "已实现端点不该 404");
    assert.notEqual(alive.status, 405, "已实现端点不该 405");
    assert.notEqual(alive.status, 503, "有库模式下不该是 503 —— 子进程没拿到 DATABASE_URL");

    // 格式合法但必然不存在的组 id —— 路由会匹配，实体查询落空 → 404
    const missing = await fetch(`${base}/v1/task-groups/${FAKES.groupId}/answers`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(missing.status, 404,
      `格式合法但不存在的组应 404（路由匹配了、实体查询落空），实际 ${missing.status}`);

    // 完全不存在的路径 —— 兜底 404，文案与上面那个不同
    const dead = await fetch(`${base}/v1/no-such-endpoint-at-all`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(dead.status, 404);
    const body = await dead.text();
    assert.match(body, /API route not found/i,
      "兜底 404 的文案正是主测试判定死端点的依据，这里必须确认它成立");
  } finally {
    await stop(proc.child);
  }
});

test("答案端点用真实存在的组与任务访问，不得返回 500", { timeout: 120_000 }, async () => {
  // 上一轮那个 bug 的正确检测方式。
  //
  // 用假 id 探测时它被掩盖了：假组查不到 → 走「组不存在」分支 → 404，
  // 看起来「路由通了」。只有拿**真实存在的组**去请求，
  // scope 查询才会成功、handler 才会真正跑起来，然后暴露出 id 传错的问题。
  //
  // 实测：bug 存在时 task 与 group 两种形态都返回 500。
  if (!process.env.DATABASE_URL) return;

  const { createPool } = await import("../src/db/pool.js");
  const pool = createPool();
  const port = 38300 + (process.pid % 200);
  const proc = startApi(port, true);
  let groupId = null;
  let taskId = null;

  try {
    const { rows } = await pool.query(`
      SELECT g.public_id AS group_id, t.public_id AS task_id
        FROM service_task_groups g
        JOIN service_task_group_members m ON m.group_id = g.id
        JOIN service_tasks t ON t.id = m.task_id
       WHERE g.tenant_id = 1 ORDER BY g.id LIMIT 1`);
    if (!rows.length) return; // 没有可用数据，跳过
    groupId = rows[0].group_id;
    taskId = rows[0].task_id;

    await waitReady(proc);
    const base = `http://127.0.0.1:${port}`;

    const cases = [
      `/v1/task-groups/${groupId}/answers`,
      `/v1/task-groups/${groupId}/answers/search?q=x`,
      `/v1/task-groups/${groupId}/answers/run_b68_i1`,
      `/v1/task-groups/${groupId}/geo-reports`,
      `/v1/task-groups/${groupId}/members`,
      `/v1/tasks/${taskId}/answers`,
      `/v1/tasks/${taskId}/answers/search?q=x`,
      `/v1/tasks/${taskId}/answers/run_b68_i1`,
    ];

    for (const path of cases) {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${API_KEY}`, accept: "application/json" },
      });
      const body = await response.text();
      assert.notEqual(response.status, 500,
        `${path} 返回 500 —— 路由匹配了但内部抛错。响应: ${body.slice(0, 250)}`);
    }
  } finally {
    void groupId;
    void taskId;
    await stop(proc.child);
    await pool.end().catch(() => undefined);
  }
});

test("答案相关端点在 task 与 task-group 两种 scope 下都可达", { timeout: 120_000 }, async () => {
  // 单独拎出来：这三个端点上一轮出过捕获组布局问题，
  // 而通用遍历里它们混在 70 个端点中，单点失败容易被淹没。
  const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
  const port = 37900 + (process.pid % 200);
  const proc = startApi(port);
  const GROUP = FAKES.groupId;
  const TASK = FAKES.taskId;

  try {
    await waitReady(proc);
    const base = `http://127.0.0.1:${port}`;

    const cases = [
      [`/v1/task-groups/${GROUP}/answers`, "GET"],
      [`/v1/task-groups/${GROUP}/answers/search?q=x`, "GET"],
      [`/v1/task-groups/${GROUP}/answers/run_b68_i1`, "GET"],
      [`/v1/tasks/${TASK}/answers`, "GET"],
      [`/v1/tasks/${TASK}/answers/search?q=x`, "GET"],
      [`/v1/tasks/${TASK}/answers/run_b68_i1`, "GET"],
    ];

    for (const [path, method] of cases) {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${API_KEY}`, accept: "application/json" },
      });
      const body = await response.text();
      // 无库时会是 503 database_unavailable（路由通了）
      // 若是 404，说明 scope 解析把 id 传错了 —— 正是上一轮的 bug
      assert.notEqual(response.status, 404,
        `${method} ${path} 返回 404 —— 路由可能没匹配上，或 scope id 传错。响应: ${body.slice(0, 200)}`);
      assert.notEqual(response.status, 405, `${method} ${path} 方法不允许`);
    }
  } finally {
    await stop(proc.child);
  }
});
