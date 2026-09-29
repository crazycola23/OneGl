import "dotenv/config";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { createPool } from "../src/db/pool.js";

/**
 * 竞品分析链路端到端走查。
 *
 * ## 为什么需要这个文件
 *
 * 上一轮加的 `/v1/{tasks|task-groups}/{id}/answers/search` 在任务组形态下
 * 100% 报 500 —— 路由正则的捕获组布局把 `"task-groups/grp_…"` 整段当 task id
 * 传了下去。而当时 14 个测试全部直接调服务层（`searchAnswers({groupId})`
 * 正常返回 69 条），**路由层一行都没覆盖**。
 *
 * 服务层测试和端点测试是两件事。只有真的起进程、真的发 HTTP 请求、
 * 真的过一遍鉴权与路由，才能发现这类问题。
 *
 * ## 这个测试验证什么
 *
 * GEO 侧的完整用法：拿组 → 抽样 → 发现竞品 → 生成报告 → 再生成一份 →
 * 横向对比 → 从提及率追问到具体回答 → 取全文 → 取 HTML → 清理。
 * 重点不只是「每个端点返回 200」，而是**链路上的数字彼此自洽**：
 * 检索命中数必须等于报告里的提及数，只在一侧出现的品牌必须是 null 而非 0。
 * 单点全绿但数字对不上，报告依然不可用。
 *
 * 没有 DATABASE_URL 时跳过（与同目录其它 db 测试一致）。
 */

const enabled = Boolean(process.env.DATABASE_URL);
const API_KEY = "competitor-flow-test-key";

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
      // 必须带租户头：master key 的 tenantId 为 null，会回落到这个头。
      // 少了它，写操作落到 default 租户而读操作可能落到别处，
      // 表现为「刚建的组却说找不到」这种极难定位的现象。
      "x-onegl-tenant": "default",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* html body, e.g. report artifact */ }
  return { status: response.status, payload, text };
}

const PERIOD = (key) => ({
  key, label: key, from: "2026-01-01", to: "2026-12-31", time_zone: "Asia/Shanghai",
});

test("竞品分析链路端到端可用且数字自洽", { skip: !enabled, timeout: 120_000 }, async () => {
  const pool = createPool();
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  // 端口段必须独占：node --test 并行跑文件，process.pid 在同一 worker 内相同，
  // 所以 35000/35600 这类基于 pid%N 的区间极易互相撞车。
  // 本文件用 37200-37599，与其它 db 测试（33000-36999）不重叠。
  const port = 37200 + (process.pid % 400);
  const proc = startApi(port);
  const created = { reports: [], groups: [], taskIds: [], projectId: null };

  try {
    await waitReady(proc);
    const base = `http://127.0.0.1:${port}`;

    // ---- 环节 1：造一个任务组（一个用户任务横跨两个平台）------------
    const project = await call(base, "/v1/projects", {
      method: "POST",
      body: {
        external_id: `comp-flow-${suffix}`,
        name: `竞品链路 ${suffix}`,
        target_brand: "自有品牌",
        questions: ["肩颈按摩哪家好", "推拿手法怎么选"],
        platforms: ["qianwen", "doubao"],
        account_ids: [],
      },
    });
    assert.equal(project.status, 201, `建项目失败: ${project.text.slice(0, 200)}`);
    const projectId = project.payload.data.project_id;
    created.projectId = projectId;

    const tasks = [];
    for (const platform of ["qianwen", "doubao"]) {
      const created1 = await call(base, "/v1/tasks", {
        method: "POST",
        body: {
          external_id: `comp-flow-${suffix}-${platform}`,
          // 名称也要带后缀：同一租户内 display_name 唯一，
          // 上一次失败运行留下的同名任务会让重跑撞 409 display_name_taken
          name: `竞品链路 ${platform} ${suffix}`,
          project_id: projectId,
          questions: ["肩颈按摩哪家好", "推拿手法怎么选"],
          platforms: [platform],
          account_ids: [],
        },
      });
      assert.equal(created1.status, 201, `建任务失败: ${created1.text.slice(0, 200)}`);
      tasks.push(created1.payload.data.task_id);
      created.taskIds.push(created1.payload.data.task_id);
    }

    const group = await call(base, "/v1/task-groups", {
      method: "POST",
      body: { name: `竞品组 ${suffix}`, external_id: `grp-flow-${suffix}`, task_ids: tasks },
    });
    assert.equal(group.status, 201,
      `建组失败: ${group.text.slice(0, 400)}`);
    // 响应字段名不能猜：早期版本这里取 data.group_id，若实际是 data.id
    // 就会得到 undefined，后面所有请求都打到 /v1/task-groups/undefined/…
    const groupId = group.payload?.data?.group_id ?? group.payload?.data?.id;
    assert.match(groupId, /^grp_[a-f0-9]{32}$/,
      `建组响应里没有可用的组 id: ${group.text.slice(0, 300)}`);
    created.groups.push(groupId);

    // 组列表本身也要能用。注意响应是裸数组 data: [...]，
    // 不是 { groups: [...] } —— 与其它列表端点一致（契约里 data.items 描述元素类型）。
    const listGroups = await call(base, "/v1/task-groups?limit=50");
    assert.equal(listGroups.status, 200, "任务组列表可读");
    assert.ok(Array.isArray(listGroups.payload.data), "data 是数组");
    const listed = listGroups.payload.data.find((g) => g.group_id === groupId);
    assert.ok(listed, "新建的组应出现在列表里");
    assert.equal(listed.platforms.length, 2, "跨两个平台");
    assert.equal(listed.task_count, 2, "含两个 task");

    // ---- 环节 2：三个回答相关端点在 group 形态下都要通 ----------------
    // 这一组断言就是上一轮 500 缺陷的直接回归。
    const sample = await call(base, `/v1/task-groups/${groupId}/answers?limit=5`);
    assert.equal(sample.status, 200, `抽样端点: ${sample.text.slice(0, 200)}`);
    assert.equal(sample.payload.data.schema, "answer-sample.v1");

    const searchEmpty = await call(base, `/v1/task-groups/${groupId}/answers/search?q=按摩`);
    assert.equal(searchEmpty.status, 200,
      `检索端点在 group 形态下必须 200（上一轮这里是 500）: ${searchEmpty.text.slice(0, 200)}`);
    assert.equal(searchEmpty.payload.data.schema, "answer-search.v1");
    assert.ok("total" in searchEmpty.payload.data, "含 total");

    const searchByKeyword = await call(base, `/v1/task-groups/${groupId}/answers/search?q=%E6%8C%89%E6%91%A9`);
    assert.equal(searchByKeyword.status, 200, "关键词检索");
    assert.ok(searchByKeyword.payload.data.total >= 0, "total 是数字");

    // 无命中时也必须是 200 + total 0，而不是 404/500
    const searchNoHit = await call(base, `/v1/task-groups/${groupId}/answers/search?brand=${encodeURIComponent("不存在的品牌XYZ")}`);
    assert.equal(searchNoHit.status, 200, "无命中应 200");
    assert.equal(searchNoHit.payload.data.total, 0, "无命中 total 为 0");

    // task 形态也要通（两个 scope 形态都被覆盖）
    const taskSearch = await call(base, `/v1/tasks/${tasks[0]}/answers/search?q=%E6%8C%89%E6%91%A9`);
    assert.equal(taskSearch.status, 200, "task 形态检索");
    const taskSample = await call(base, `/v1/tasks/${tasks[0]}/answers?limit=5`);
    assert.equal(taskSample.status, 200, "task 形态抽样");

    // ---- 环节 3：生成报告（有 brands 与无 brands 两种）--------------
    const period = PERIOD("flow");
    const withBrands = await call(base, `/v1/task-groups/${groupId}/geo-reports`, {
      method: "POST",
      body: {
        periods: [period],
        brands: [{ name: "思邈棠", role: "competitor" }, { name: "沈园堂", role: "competitor" }],
        theme: { colors: { accent: "#0f766e" }, footer_text: "端到端测试报告" },
      },
    });
    assert.equal(withBrands.status, 201, `生成报告: ${withBrands.text.slice(0, 300)}`);
    const reportA = withBrands.payload.data.report_id;
    created.reports.push(reportA);

    const summary = withBrands.payload.data.brand_mentions ?? [];
    assert.equal(summary.length, 2, "两个平台各一条");
    for (const item of summary) {
      assert.ok("excluded_answers" in item, "含 excluded_answers（分母可审计）");
      assert.ok(Array.isArray(item.brands), "含 brands");
    }

    // 空采集下提及率应当是 null（分母为 0）而不是 0 —— 这两件事不同
    for (const item of summary) {
      for (const b of item.brands) {
        if (item.answer_count === 0) {
          assert.equal(b.mention_rate, null,
            `${item.platform}/${b.name}: 分母为 0 时提及率必须是 null 而非 0`);
        }
      }
    }

    // 主题进快照
    assert.equal(withBrands.payload.data.theme?.colors?.accent, "#0f766e", "主题已保存");

    // ---- 环节 4：第二份报告，品牌集合不同 ----------------------------
    const withMore = await call(base, `/v1/task-groups/${groupId}/geo-reports`, {
      method: "POST",
      body: {
        periods: [PERIOD("flow2")],
        brands: [
          { name: "思邈棠", role: "competitor" },
          { name: "沈园堂", role: "competitor" },
          { name: "禅悦汇", role: "competitor" },
        ],
      },
    });
    assert.equal(withMore.status, 201, "第二份报告");
    const reportB = withMore.payload.data.report_id;
    created.reports.push(reportB);

    // ---- 环节 5：横向对比，数字必须自洽 ------------------------------
    const compare = await call(
      base,
      `/v1/geo-reports/compare?base_report_id=${reportA}&target_report_id=${reportB}`,
    );
    assert.equal(compare.status, 200, `对比: ${compare.text.slice(0, 200)}`);
    const platforms = compare.payload.data.platforms;
    assert.equal(platforms.length, 2, "两个平台都有对比条目");

    for (const p of platforms) {
      // 形状必须同构：客户端常写 p.runs.valid_runs 遍历全部条目
      for (const key of ["runs", "citations", "tracked_content", "brand_mentions", "top_domains"]) {
        assert.ok(key in p, `${p.platform} 缺字段 ${key}（removed 分支也必须有）`);
      }
      const bm = p.brand_mentions;
      assert.ok(bm, "含 brand_mentions");
      // 新建的组没有任何采集批次，此时 available=false 是正确的：
      // 「没做品牌分析」与「分析完发现都没提到」必须是两回事。
      // 所以这里只在真的采到数据时检查品牌明细。
      if (bm.available && bm.current_answer_count > 0) {
        const names = bm.brands.map((b) => b.name);
        assert.ok(names.includes("思邈棠"), "有数据时应含思邈棠");
        // 只在 target 侧出现的品牌：base 必须是 null，不能是 0
        const extra = bm.brands.find((b) => b.name === "禅悦汇");
        if (extra) {
          assert.equal(extra.base, null, "禅悦汇在 base 侧必须是 null");
          assert.equal(extra.comparable, false, "不可比");
          assert.equal(extra.mention_rate_delta_percentage_points, null, "不可比时差值为 null");
        }
      } else if (bm.available) {
        // available=true 但分母为 0：分析做了，只是没有可用回答
        assert.equal(bm.brands.length, 0, "无回答时品牌列表应为空");
        assert.equal(bm.reason, null, "available=true 时不该有 reason");
      } else {
        assert.equal(bm.brands.length, 0, "无数据时品牌列表应为空");
        assert.ok(bm.reason, "并说明原因");
      }
    }

    // ---- 环节 6：按 group_id 自动定位最近报告 ------------------------
    const byGroup = await call(
      base,
      `/v1/geo-reports/compare?base_group_id=${groupId}&target_group_id=${groupId}`,
    );
    // 同一份报告自比应当是 422 same_report
    assert.equal(byGroup.status, 422, "同组自比应是 422");
    assert.equal(byGroup.payload.error, "same_report", "错误码是 same_report");

    // 不存在的组必须是 404 而不是 500
    const ghost = await call(
      base,
      "/v1/geo-reports/compare?base_group_id=grp_0000000000000000000000000000dead&target_group_id=" + groupId,
    );
    assert.equal(ghost.status, 404, "不存在的组应 404");
    assert.equal(ghost.payload.error, "no_report_for_scope");

    // ---- 环节 7：检索与报告口径一致（有真实采集数据时才成立）--------
    const qianwenSummary = summary.find((x) => x.platform === "qianwen");
    if (qianwenSummary && qianwenSummary.answer_count > 0) {
      const top = [...qianwenSummary.brands]
        .sort((a, b) => (b.mention_rate ?? 0) - (a.mention_rate ?? 0))[0];
      if (top && top.mention_rate > 0) {
        const detail = await call(
          base,
          `/v1/task-groups/${groupId}/answers/search?brand=${encodeURIComponent(top.name)}&platform=qianwen&limit=5`,
        );
        assert.equal(detail.status, 200, "品牌检索");
        assert.equal(detail.payload.data.total, top.mentioned_answers,
          "检索命中数必须等于报告里的提及数（口径一致）");
        const first = detail.payload.data.answers[0];
        assert.ok(first.brand_matches.length > 0, "带 brand_matches");
        assert.ok(first.brand_matches[0].context.includes(top.name),
          "上下文含品牌名，够 agent 判断推荐强度");

        // 单条全文
        const one = await call(base, `/v1/task-groups/${groupId}/answers/${first.run_id}`);
        assert.equal(one.status, 200, "单条全文");
        assert.equal(one.payload.data.run_id, first.run_id);
        assert.ok(one.payload.data.answer.length > 0, "正文非空");
      }
    }

    // ---- 环节 8：取 HTML 报告，主题生效 ------------------------------
    const html = await call(base, `/v1/geo-reports/${reportA}/html`);
    assert.equal(html.status, 200, "HTML 可取");
    assert.ok(html.text.includes("--accent:#0f766e"), "主题主色生效");
    assert.ok(html.text.includes("端到端测试报告"), "页脚署名生效");
    assert.ok(html.text.startsWith("<!doctype html>"), "自包含单文件");

    // ---- 环节 9：鉴权边界 --------------------------------------------
    const anon = await fetch(`${base}/v1/task-groups/${groupId}/answers/search?q=x`);
    assert.ok([401, 503].includes(anon.status), `无凭据应拒绝，实际 ${anon.status}`);

    const badGroup = await call(base, "/v1/task-groups/grp_0000000000000000000000000000dead/answers/search?q=x");
    assert.equal(badGroup.status, 404, "不存在的组应 404");
  } finally {
    // 清理必须无条件执行：失败运行留下的同名任务会让下次重跑撞 409，
    // 于是「一个失败测试」变成「之后所有运行都失败」，比不写还糟。
    if (created.reports.length) {
      await pool.query(
        "DELETE FROM service_geo_reports WHERE public_id = ANY($1::text[])",
        [created.reports],
      ).catch(() => undefined);
    }
    if (created.taskIds.length) {
      await pool.query(
        `DELETE FROM service_tasks
          WHERE public_id = ANY($1::text[])
            AND NOT EXISTS (SELECT 1 FROM service_task_group_members m
                            JOIN service_task_groups g ON g.id = m.group_id
                            WHERE m.task_id = service_tasks.id
                              AND g.public_id <> ALL($2::text[]))`,
        [created.taskIds, created.groups],
      ).catch(() => undefined);
    }
    for (const groupId of created.groups) {
      await pool.query("DELETE FROM service_task_groups WHERE public_id = $1", [groupId])
        .catch(() => undefined);
    }
    if (created.projectId) {
      await pool.query(
        "DELETE FROM projects WHERE public_id = $1 OR name = $2",
        [created.projectId, `竞品链路 ${suffix}`],
      ).catch(() => undefined);
    }
    await stop(proc.child);
    await pool.end();
  }
});
