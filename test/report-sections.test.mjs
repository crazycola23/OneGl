// 钉住章节结构：8 章、无空占位、编号连续、目录与正文一致。
//
// 背景：报告原有 11 章，其中 3 章永远输出「本期未启用」的空占位
// （地域需求分布 / AI 评判维度与价格带 / 来源层级与机会点）。
// 空占位占了目录、占了页码、占了阅读时间，读者只会以为是渲染失败 —— 已删除。
//
// 同时钉住新增的渲染期断言：章节数或 id 与目录声明不一致时必须抛错，
// 而不是静默渲染出一份目录与正文错位的报告。
import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { buildGeoCustomerReportHtml } from "../src/report/html-geo-customer.js";

/** 复用 test/report-brand-caliber 的 fixture 形状。 */
function payload() {
  const period = {
    key: "p", label: "阶段", from: "2026-01-01", to: "2026-01-02",
    time_zone: "Asia/Shanghai", source_batches: [], excluded_batches: [],
  };
  return {
    schema_version: "geo-customer-report.v1",
    report_id: "rpt_test",
    scope_kind: "group",
    task_id: null,
    group_id: "grp_test",
    title: "测试报告",
    generated_at: "2026-01-01T00:00:00.000Z",
    target: { name: "测试目标", brand: "测试", tracked_articles_configured: false, tracked_articles_count: 0 },
    theme: null,
    scope: { platforms: ["qianwen"], periods: [period], brands: [] },
    profile: { version: "v1", platform_colors: { qianwen: "#2563eb" } },
    periods: [{
      ...period,
      platforms: [{
        platform: "qianwen", color: "#2563eb",
        runs: {
          runs: 10, assignments: 10, valid_runs: 10, partial_runs: 0, failed_runs: 0,
          reset_unconfirmed_runs: 0, success_rate: 1, answers_with_text: 10,
          average_answer_characters: 800, brand_mentioned_runs: 1, brand_mention_rate: 0.1,
          citation_valid_runs: 9,
        },
        citations: {
          citation_valid_runs: 9, visible_citations: 90, content_citations: 90,
          icon_citations: 5, unique_domains: 4, unique_articles: 20,
          top_domains: [{ domain: "example.com", citations: 30, unique_articles: 9, covered_runs: 6, covered_run_rate: 0.6 }],
          top_articles: [],
          tracked_content: {
            configured: false, configured_articles: 0, articles: [],
            cited_articles: null, citations: null, covered_runs: null,
            coverage_rate: null, article_coverage_rate: null, truncated: false,
          },
        },
        questions: [{ question: "哪家好", category: "test", assignments: 10 }],
        answers: [{ run_id: "run_1", question: "哪家好", answer_chars: 800 }],
        brand_mentions: { available: false, brands: [] },
      }],
    }],
    methodology: {},
    warnings: [],
  };
}

const REMOVED = ["地域需求分布", "AI 评判维度与价格带", "来源层级与机会点"];

test("报告是 8 章，且三章已删除", () => {
  const html = buildGeoCustomerReportHtml(payload());
  const ids = [...html.matchAll(/<section id="(sec-\d+)"/g)].map((m) => m[1]);

  assert.equal(ids.length, 8, `应为 8 节，实际 ${ids.length}：${ids.join(",")}`);
  assert.deepEqual(
    ids,
    ["sec-01", "sec-02", "sec-03", "sec-04", "sec-05", "sec-06", "sec-07", "sec-08"],
    "章节 id 必须连续且从 01 起",
  );
});

test("已删除的三章在正文和目录里都不再出现", () => {
  const html = buildGeoCustomerReportHtml(payload());
  const toc = html.slice(html.indexOf('<aside'), html.indexOf("</aside>"));

  for (const title of REMOVED) {
    assert.ok(!html.includes(title), `正文不应再出现「${title}」`);
    assert.ok(!toc.includes(title), `目录不应再出现「${title}」`);
  }
});

test("目录里不再有「本期未启用」标记", () => {
  const html = buildGeoCustomerReportHtml(payload());
  const toc = html.slice(html.indexOf('<aside'), html.indexOf("</aside>"));
  assert.ok(!toc.includes("本期未启用"), "空占位章已删除，不该再有未启用标记");
  assert.ok(!html.includes("toc-pending"), "未启用标记的 CSS 类也不该再被使用");
});

test("目录项与正文章节数一致", () => {
  const html = buildGeoCustomerReportHtml(payload());
  const toc = html.slice(html.indexOf('<aside'), html.indexOf("</aside>"));
  const links = [...toc.matchAll(/href="#(sec-\d+)"/g)].map((m) => m[1]);
  const sections = [...html.matchAll(/<section id="(sec-\d+)"/g)].map((m) => m[1]);

  const unique = [...new Set(links)].filter((id) => id.startsWith("sec-"));
  assert.deepEqual(unique, sections, "目录链接必须覆盖全部正文章节，且不多不少");
});

test(":target 高亮规则覆盖每一节（章节数变化时自动跟随）", () => {
  const html = buildGeoCustomerReportHtml(payload());
  const rules = [...html.matchAll(/body:has\((#sec-\d+):target\)/g)].map((m) => m[1]);
  assert.equal(rules.length, 8, `应为 8 条高亮规则，实际 ${rules.length} 条`);
});

/**
 * 把渲染器源码改坏后，在临时模块里跑一遍，确认它确实抛错。
 *
 * 两个必须做对的地方：
 *  - 临时文件写在 src/report/ 下。放 test/ 的话它内部的
 *    `import ... from "./report-theme.js"` 解析不到，整个 import 抛错，
 *    assert.throws 根本没机会跑。
 *  - import 和断言都要在 try 里、finally 只负责删文件。之前 import 放在 try 外，
 *    import 失败时文件留在 src/report/ 里，被 node --test 当测试文件跑 ——
 *    一次注入测试污染了后续三轮全量测试的失败列表。
 *  - 文件名用随机串而不是 process.pid：并发跑测试时同 pid 会撞车。
 */
async function withBrokenRenderer(mutate, expected) {
  const file = new URL("../src/report/html-geo-customer.js", import.meta.url);
  const original = readFileSync(file, "utf8");
  const broken = mutate(original);
  assert.notEqual(broken, original, "改写源码失败，注入用例本身有问题");

  // 落在 src/report/ 而不是 test/：渲染器内部 import 的是 "./report-theme.js"，
  // 相对 import 按文件所在目录解析，放 test/ 下会找不到。
  const tmp = new URL(`../src/report/tmp-sections-${randomUUID()}.mjs`, import.meta.url);
  writeFileSync(tmp, broken);
  try {
    const mod = await import(tmp.href);
    assert.throws(() => mod.buildGeoCustomerReportHtml(payload()), expected);
  } finally {
    unlinkSync(tmp);
  }
}

test("章节结构不一致时渲染直接抛错，而不是产出错位报告", async () => {
  // 防止「目录与正文各写一份」回退的关键。
  // 早期版本目录是一份手写数组、正文是另一组硬编码 id，漏改任何一处
  // 都不报错，症状是「点目录跳错位置」—— 报告照常渲染、照常 200。
  await withBrokenRenderer(
    (src) => src.replace(
      /const SECTION_TITLES = \[/,
      'const SECTION_TITLES = [\n  "多出来的第九节",',
    ),
    /章节数量与目录不一致/,
  );
});

test("章节 id 与目录声明错位时同样抛错", async () => {
  await withBrokenRenderer(
    (src) => src.replace('id=\\"sec-05\\"', 'id=\\"sec-09\\"'),
    /的 id 不对/,
  );
});
