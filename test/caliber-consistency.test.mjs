import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import "dotenv/config";

import { createPool } from "../src/db/pool.js";

/**
 * 竞品分析链路的**数据自洽**验证。
 *
 * ## 为什么要单独一个文件
 *
 * competitor-flow-e2e.test.mjs 里的口径一致性断言被包在
 * `if (answer_count > 0)` 里 —— 因为它依赖真实采集数据。
 * 而采集数据是本地状态，CI 上没有。结果就是：
 * **最核心的「检索命中数 == 报告提及数」这条验证在 CI 上静默跳过，
 * 而且没有 t.skip() 标记，看报告的人会以为它测过了。**
 *
 * 本文件自己造数据：直接在库里写入一段 runs + citations + prompts，
 * 让整条链路在干净环境上也能跑。造的数据是确定性的，
 * 因此「检索命中数」与「报告提及数」都有可预期的确切值。
 *
 * ## 这类断言的价值
 *
 * 单元测试只能证明 computeBrandMentions 对给定输入返回给定输出；
 * 本文件证明的是**跨模块口径一致** —— 报告层与检索层各自独立实现，
 * 却在同一个业务概念上给出相同的数字。这正是调用方最担心的：
 * 「这两个数字对不上，我还能信什么？」
 */

const API_KEY = "caliber-consistency-test-key";
const enabled = Boolean(process.env.DATABASE_URL);

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

async function call(base, path, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      accept: "application/json",
      "x-onegl-tenant": "default",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* html */ }
  return { status: response.status, payload, text };
}

/**
 * 造一组确定性的采集数据。
 *
 * 6 条回答，其中 3 条提到「思邈棠」、1 条提到「思邈棠」但被标记为截断、
 * 1 条过短（平台中间态）、1 条完全不提及。
 * 按报告口径算，有效回答是 6 - 1(过短) - 1(截断) = 4 条，
 * 其中提到思邈棠的是 2 条 —— 这些数字会在断言里被硬编码校验。
 */
async function seedFixture(pool, suffix) {
  const project = await pool.query(
    `INSERT INTO projects (name, target_brand) VALUES ($1, '自有品牌') RETURNING id`,
    [`口径一致测试 ${suffix}`],
  );
  const projectId = project.rows[0].id;
  await pool.query(
    `INSERT INTO service_project_bindings (tenant_id, project_id, display_name)
     VALUES (1, $1, $2)`,
    [projectId, `口径一致测试 ${suffix}`],
  );

  const prompt = await pool.query(
    `INSERT INTO prompts (project_id, prompt, category) VALUES ($1, $2, 'test') RETURNING id`,
    [projectId, "肩颈按摩哪家好"],
  );
  const promptId = prompt.rows[0].id;

  const task = await pool.query(
    `INSERT INTO service_tasks (tenant_id, public_id, name, project_id, platforms, state)
     VALUES (1, $1, $2, $3, '["qianwen"]'::jsonb, 'active') RETURNING id, public_id`,
    [`tsk_${suffix.padEnd(32, "0").slice(0, 32)}`, `口径任务 ${suffix}`, projectId],
  );
  const taskId = task.rows[0].id;

  const batch = await pool.query(
    `INSERT INTO sampling_batches
       (project_id, name, provider, pool_size, sample_size, sampling_method, sampling_seed,
        status, started_at, finished_at)
     VALUES ($1, $2, 'qianwen', 10, 6, 'stratified', $3, 'completed',
             now() - interval '2 days', now() - interval '2 days')
     RETURNING id`,
    [projectId, `口径批次 ${suffix}`, `seed-${suffix}`],
  );
  const batchId = batch.rows[0].id;

  await pool.query(
    `INSERT INTO service_task_executions (tenant_id, public_id, task_id, batch_id, trigger_type)
     VALUES (1, $1, $2, $3, 'manual')`,
    [`exe_${suffix.padStart(24, "0").slice(0, 24)}`, taskId, batchId],
  );

  await pool.query(
    `INSERT INTO sampling_batch_prompts (batch_id, prompt_id, selection_index, prompt_text)
     VALUES ($1, $2, 1, $3)`,
    [batchId, promptId, "肩颈按摩哪家好"],
  );

  // 回答内容：确定性，刻意包含「提及 / 不提及 / 截断 / 过短」四种情况
  const long = (core) => core + "。".repeat(120);
  const answers = [
    { run: "r1", text: long("推荐思邈棠中式养生调理，辨证后定制方案，技师手法稳定"), truncated: false, completion: null },
    { run: "r2", text: long("思邈棠值得一试，银泰店环境不错，价格透明"), truncated: false, completion: null },
    { run: "r3", text: long("沈园堂手法老道，开了很多年"), truncated: false, completion: null },
    { run: "r4", text: long("思邈棠很好，但是这段没写完"), truncated: true, completion: null },
    { run: "r5", text: "找到 1 篇资料", truncated: true, completion: null },
    { run: "r6", text: long("绍兴市中医院是公立三甲，技术可靠，值得信赖"), truncated: false, completion: null },
  ];

  const runIds = [];
  for (const a of answers) {
    // runs 表没有 selection_index 列；引用来源靠 run_token / job_id，这里不需要
    const row = await pool.query(
      `INSERT INTO runs
         (sampling_batch_id, prompt_id, local_run_id, provider, status,
          conversation_reset_confirmed, answer, answer_truncated, answer_completion,
          captured_citation_count, citation_state, search_text, started_at, finished_at)
       VALUES ($1, $2, $3, 'qianwen', 'success', TRUE, $4, $5, $6, 0, 'none_visible', $4,
               now() - interval '2 days', now() - interval '2 days')
       RETURNING id`,
      [batchId, promptId, a.run, a.text, a.truncated, a.completion],
    );
    runIds.push(row.rows[0].id);
  }

  return { projectId, taskId, taskPublicId: task.rows[0].public_id, batchId, runIds };
}

/**
 * 按名字前缀清理，不依赖 fixture 对象。
 *
 * 早期版本用 `fixture?.projectId`，而 seedFixture 中途抛错时 fixture 还是 null ——
 * 于是那些半成品数据永远留在库里。跑 5 次就积了 4 个残留项目，
 * 而且测试报告里看不出任何异常。
 *
 * 按前缀清理的好处：即使 seed 失败，也能删掉它已经插入的那部分。
 */
async function cleanupFixture(pool, suffix) {
  if (!suffix) return;
  const nameLike = `%${suffix}%`;
  // 顺序按外键依赖：先叶子后根
  await pool.query(
    `DELETE FROM service_geo_reports
      WHERE task_id IN (SELECT t.id FROM service_tasks t
                         JOIN projects p ON p.id = t.project_id
                        WHERE p.name LIKE $1)`,
    [nameLike],
  ).catch(() => undefined);
  await pool.query(
    `DELETE FROM sampling_batch_prompts
      WHERE batch_id IN (SELECT b.id FROM sampling_batches b
                          JOIN projects p ON p.id = b.project_id
                         WHERE p.name LIKE $1)`,
    [nameLike],
  ).catch(() => undefined);
  await pool.query(
    `DELETE FROM service_task_executions
      WHERE task_id IN (SELECT t.id FROM service_tasks t
                         JOIN projects p ON p.id = t.project_id
                        WHERE p.name LIKE $1)`,
    [nameLike],
  ).catch(() => undefined);
  await pool.query(
    `DELETE FROM runs
      WHERE sampling_batch_id IN (SELECT b.id FROM sampling_batches b
                                   JOIN projects p ON p.id = b.project_id
                                  WHERE p.name LIKE $1)`,
    [nameLike],
  ).catch(() => undefined);
  await pool.query(
    `DELETE FROM service_tasks
      WHERE project_id IN (SELECT id FROM projects WHERE name LIKE $1)`,
    [nameLike],
  ).catch(() => undefined);
  await pool.query("DELETE FROM sampling_batches WHERE name LIKE $1", [nameLike]).catch(() => undefined);
  await pool.query(
    `DELETE FROM service_project_bindings
      WHERE project_id IN (SELECT id FROM projects WHERE name LIKE $1)`,
    [nameLike],
  ).catch(() => undefined);
  await pool.query(
    `DELETE FROM prompts
      WHERE project_id IN (SELECT id FROM projects WHERE name LIKE $1)`,
    [nameLike],
  ).catch(() => undefined);
  await pool.query("DELETE FROM projects WHERE name LIKE $1", [nameLike]).catch(() => undefined);
}

test("报告与检索的品牌提及口径在干净数据上也完全一致", { skip: !enabled, timeout: 120_000 }, async () => {
  const pool = createPool();
  const suffix = Math.random().toString(16).slice(2, 8);
  const port = 38500 + (process.pid % 200);
  const proc = startApi(port);

  try {
    const fixture = await seedFixture(pool, suffix);
    await waitReady(proc);
    const base = `http://127.0.0.1:${port}`;

    // 4 条有效回答（6 条 - 1 过短 - 1 截断），其中 2 条提到思邈棠
    const EXPECTED_DENOMINATOR = 4;
    const EXPECTED_SMT_MENTIONS = 2;

    const report = await call(base, `/v1/tasks/${fixture.taskPublicId}/geo-reports`, {
      method: "POST",
      body: {
        periods: [{
          key: "caliber", label: "口径验证",
          from: new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10),
          to: new Date().toISOString().slice(0, 10),
          time_zone: "Asia/Shanghai",
        }],
        brands: [{ name: "思邈棠", role: "competitor" }, { name: "沈园堂", role: "competitor" }],
      },
    });
    assert.equal(report.status, 201, `生成报告失败: ${report.text.slice(0, 300)}`);
    const reportId = report.payload.data.report_id;

    const smt = report.payload.data.brand_mentions.find((b) => b.platform === "qianwen");
    assert.ok(smt, "摘要应含千问的平台条目");

    // 确定性断言：分母与命中数都必须是算出来的确切值
    assert.equal(smt.answer_count, EXPECTED_DENOMINATOR,
      `分母应为 ${EXPECTED_DENOMINATOR}（6 条 - 1 过短 - 1 截断），实际 ${smt.answer_count}`);
    assert.equal(smt.excluded_answers, 2,
      `应排除 2 条（过短 + 截断），实际 ${smt.excluded_answers}`);

    const smtBrand = smt.brands.find((b) => b.name === "思邈棠");
    assert.equal(smtBrand.mentioned_answers, EXPECTED_SMT_MENTIONS,
      `思邈棠应被提到 ${EXPECTED_SMT_MENTIONS} 次，实际 ${smtBrand.mentioned_answers}`);
    assert.equal(smtBrand.mention_rate, EXPECTED_SMT_MENTIONS / EXPECTED_DENOMINATOR,
      "提及率应等于命中数除以分母");

    // 关键：检索层的口径必须与报告层一致
    const search = await call(
      base,
      `/v1/tasks/${fixture.taskPublicId}/answers/search?brand=${encodeURIComponent("思邈棠")}&limit=20`,
    );
    assert.equal(search.status, 200, `检索失败: ${search.text.slice(0, 200)}`);
    assert.equal(search.payload.data.total, smtBrand.mentioned_answers,
      `检索命中数必须等于报告提及数：${search.payload.data.total} vs ${smtBrand.mentioned_answers}`);
    assert.equal(search.payload.data.answers.length, EXPECTED_SMT_MENTIONS,
      "返回的条数应与命中数一致");
    assert.ok(search.payload.data.answers.every((a) => a.brand_matches.length > 0),
      "每条都应带 brand_matches");

    // 另一个品牌也要对上
    const sytSearch = await call(
      base,
      `/v1/tasks/${fixture.taskPublicId}/answers/search?brand=${encodeURIComponent("沈园堂")}&limit=20`,
    );
    const sytBrand = smt.brands.find((b) => b.name === "沈园堂");
    assert.equal(sytSearch.payload.data.total, sytBrand.mentioned_answers,
      "第二个品牌的口径也要一致");

    // 关键词检索应能找到被排除的短文本吗？—— 不该找到（口径过滤在先）
    const shortSearch = await call(
      base,
      `/v1/tasks/${fixture.taskPublicId}/answers/search?q=${encodeURIComponent("找到 1 篇资料")}`,
    );
    assert.equal(shortSearch.status, 200);
    assert.equal(shortSearch.payload.data.total, 0,
      "被口径排除的过短回答不应出现在检索结果里");

    // 对比端点读同一份快照，数字也必须一致
    const compare = await call(
      base,
      `/v1/geo-reports/compare?base_report_id=${reportId}&target_report_id=${reportId}`,
    );
    assert.equal(compare.status, 422, "自比应是 422");

    await pool.query("DELETE FROM service_geo_reports WHERE public_id = $1", [reportId]);
  } finally {
    // 按 suffix 清理，即使 seed 中途失败也能删掉已插入的部分
    await cleanupFixture(pool, suffix);
    await stop(proc.child);
    await pool.end().catch(() => undefined);
  }
});
