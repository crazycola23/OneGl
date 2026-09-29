import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import "dotenv/config";

import { readFileSync } from "node:fs";
import { createPool } from "../src/db/pool.js";

/**
 * 响应形状与契约一致性。
 *
 * ## 为什么需要
 *
 * 现有测试覆盖了三件事：契约本身完整（operationId 唯一、错误码齐全）、
 * 路由可达（不 404/405）、业务口径一致（检索命中数 == 报告提及数）。
 *
 * 但没有一件事覆盖「**实现返回的 JSON 与契约声明的 schema 是否吻合**」。
 * 契约里写了 required，实现漏返回某个字段 —— 没有任何测试会发现，
 * 而按契约生成的客户端会在运行时拿到 undefined。
 *
 * ## 检查什么
 *
 * 对每个能跑通的读端点，取真实响应与 openapi.json 里对应的 schema 比对：
 *   1. required 字段是否都在（缺了 → 客户端读到 undefined）
 *   2. additionalProperties:false 时有没有多余字段（多了 → 严格校验器直接拒绝）
 *
 * 按完整路径模板匹配，不能按前缀猜 —— 早先按前 3 段猜，把
 * /v1/task-groups/{id}/geo-reports 匹配成 TaskGroupResource，
 * 于是报出一堆「缺 name / task_count」根本不存在的字段。
 */

const API_KEY = "response-shape-test-key";
const enabled = Boolean(process.env.DATABASE_URL);
const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));

function startApi(port) {
  const child = spawn(process.execPath, ["src/api-server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ONEGL_API_HOST: "127.0.0.1",
      ONEGL_API_PORT: String(port),
      ONEGL_API_KEY: API_KEY,
      REDIS_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stderr.on("data", (c) => { stderr += String(c); });
  child.stdout.on("data", (c) => { stdout += String(c); });
  let stderr = "";
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
  throw new Error("API did not start");
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const t = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(t); resolve(); });
    child.kill("SIGTERM");
  });
}

/** 解析 $ref（带深度上限，防循环引用） */
function resolve(schema, depth = 0) {
  if (!schema || depth > 6) return schema;
  if (schema.$ref) return resolve(spec.components.schemas[schema.$ref.split("/").pop()], depth + 1);
  return schema;
}

function compare(label, schema, actual, problems) {
  const s = resolve(schema);
  if (!s || typeof actual !== "object" || actual === null) return;
  const props = s.properties ?? {};
  for (const key of s.required ?? []) {
    if (!(key in actual)) problems.push(`${label}: 缺 required 字段 ${key}`);
  }
  if (s.additionalProperties === false) {
    for (const key of Object.keys(actual)) {
      if (!(key in props)) problems.push(`${label}: 多出契约未声明的字段 ${key}`);
    }
  }
}

test("读端点的响应形状与 openapi.json 声明一致", { skip: !enabled, timeout: 120_000 }, async (t) => {
  const pool = createPool();
  const { rows } = await pool.query(`
    SELECT g.public_id AS group_id, t.public_id AS task_id
      FROM service_task_groups g
      JOIN service_task_group_members m ON m.group_id = g.id
      JOIN service_tasks t ON t.id = m.task_id
     WHERE g.tenant_id = 1 ORDER BY g.id LIMIT 1`);
  if (!rows.length) {
    await pool.end();
    // 显式跳过而不是静默返回 —— 静默 return 会报 PASS，
    // 让人以为「验证过」而实际一行没跑
    t.skip("库里没有带采集数据的任务组，无法验证响应形状");
    return;
  }
  const { group_id: groupId, task_id: taskId } = rows[0];

  const port = 38700 + (process.pid % 150);
  const proc = startApi(port);
  try {
    await waitReady(proc);
    const base = `http://127.0.0.1:${port}`;

    // 按完整路径模板匹配 —— 不能按前缀猜
    const checks = [
      [`/v1/task-groups/${groupId}`, "/v1/task-groups/{groupId}", "任务组详情"],
      [`/v1/task-groups/${groupId}/answers?limit=3`, "/v1/task-groups/{groupId}/answers", "回答抽样"],
      [`/v1/task-groups/${groupId}/answers/search?q=x&limit=3`, "/v1/task-groups/{groupId}/answers/search", "回答检索"],
      [`/v1/task-groups/${groupId}/geo-reports?limit=2`, "/v1/task-groups/{groupId}/geo-reports", "报告列表"],
      [`/v1/tasks/${taskId}/answers?limit=3`, "/v1/tasks/{taskId}/answers", "任务回答抽样"],
      ["/v1/providers", "/v1/providers", "平台列表"],
      ["/v1/capabilities", "/v1/capabilities", "能力声明"],
    ];

    const problems = [];
    const verified = [];

    for (const [path, tpl, label] of checks) {
      const response = await fetch(base + path, {
        headers: { authorization: `Bearer ${API_KEY}`, accept: "application/json" },
      });
      const raw = await response.text();
      if (response.status !== 200) {
        // 不静默跳过：早先 continue 前没有日志，让我误以为「已检查」
        problems.push(`${label}: HTTP ${response.status} — ${raw.slice(0, 120).replace(/\s+/g, " ")}`);
        continue;
      }
      const body = JSON.parse(raw);
      const schema = spec.paths[tpl]?.get?.responses?.["200"]
        ?.content?.["application/json"]?.schema;
      if (!schema) {
        problems.push(`${label}: 契约里没有 200 schema`);
        continue;
      }
      const data = body.data;
      if (data === undefined) {
        problems.push(`${label}: 响应里没有 data 字段`);
        continue;
      }
      const target = schema.properties?.data ? resolve(schema.properties.data) : resolve(schema);
      if (target.type === "array") {
        if (!Array.isArray(data)) {
          problems.push(`${label}: 契约说是数组，实际是 ${typeof data}`);
          continue;
        }
        // 逐个元素比对 —— 只看数组长度等于什么都没查
        data.forEach((element, index) => compare(`${label}[${index}]`, target.items, element, problems));
        verified.push(`${label}(${data.length} 项)`);
      } else {
        compare(label, target, data, problems);
        verified.push(label);
      }
    }

    assert.ok(verified.length >= 6, `应验证至少 6 个端点，实际 ${verified.length}: ${verified.join(", ")}`);
    assert.deepEqual(problems, [], problems.join("\n"));
    // 把验证清单打出来：绿灯本身不能证明「该验的都验了」，
    // 上一版脚本就是三项静默跳过而输出看着像全部通过。
    console.log(`[已验证 ${verified.length} 个端点] ${verified.join(", ")}`);
  } finally {
    await stop(proc.child);
    await pool.end().catch(() => undefined);
  }
});
