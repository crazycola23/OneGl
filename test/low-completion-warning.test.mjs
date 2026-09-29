import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import { buildGeoCustomerReportHtml } from "../src/report/html-geo-customer.js";

/**
 * 低采集完成率必须被显式提示，且列名不能误导。
 *
 * ## 真实缺陷
 *
 * 警告只检查「平台间样本量差异」，没有任何针对「单个平台采集失败率高」的提示。
 * 实测豆包 50% 失败率时报告里一声不吭 —— 客户只看到第 1 节那列
 * 「有效率 50.0%」，容易理解成「一半回答内容无效」，
 * 而实际含义是「一半采集失败了」。指标本身没错，但表达会误导。
 *
 * 修法两处：
 *   1. 采集完成率 < 80% 时加警告，说清是采集问题不是内容问题
 *   2. 列名从「有效率」改成「采集完成率」，并在数据说明里点明它衡量什么
 */

const period = {
  key: "p", label: "阶段", from: "2026-01-01", to: "2026-01-02",
  time_zone: "Asia/Shanghai", source_batches: [], excluded_batches: [],
};

function payload(runs, warnings = []) {
  return {
    schema_version: "geo-customer-report.v1",
    report_id: "rpt_test", scope_kind: "group", task_id: null, group_id: "grp_test",
    title: "测试报告", generated_at: "2026-01-01T00:00:00.000Z",
    target: {
      name: "测试目标", brand: "某品牌", brand_configured: true,
      tracked_articles_configured: true, tracked_articles_count: 0,
    },
    theme: null,
    scope: { platforms: ["qianwen"], periods: [period], brands: [] },
    profile: { version: "v1", platform_colors: { qianwen: "#2563eb" } },
    periods: [{
      ...period,
      platforms: [{
        platform: "qianwen", color: "#2563eb",
        runs: {
          runs: runs.assignments, assignments: runs.assignments,
          valid_runs: runs.valid_runs, partial_runs: 0, failed_runs: runs.failed_runs,
          reset_unconfirmed_runs: 0, success_rate: runs.valid_runs / runs.assignments,
          answers_with_text: runs.valid_runs, average_answer_characters: 800,
          brand_mentioned_runs: 1, brand_mention_rate: 0.01, citation_valid_runs: runs.valid_runs,
        },
        citations: {
          citation_valid_runs: runs.valid_runs, visible_citations: 100, content_citations: 100,
          icon_citations: 0, unique_domains: 5, unique_articles: 20,
          top_domains: [{ domain: "example.com", citations: 50, unique_articles: 10, covered_runs: 20, covered_run_rate: 0.5 }],
          top_articles: [],
          tracked_content: {
            configured: true, configured_articles: 3, articles: [],
            cited_articles: 1, citations: 5, covered_runs: 20,
            coverage_rate: 0.5, article_coverage_rate: 0.33, truncated: false,
          },
        },
        questions: [], answers: [],
        brand_mentions: {
          available: false, answer_count: 0, excluded_answers: 0, brand_count: 0,
          basis: "mentioned_answers_over_valid_answers", brands: [],
        },
      }],
    }],
    methodology: { valid_runs: "口径", assignments: "分配口径" },
    warnings,
  };
}

test("低完成率时警告里点明是采集问题", () => {
  // warnings 由 geo-customer-reports 的 reportWarnings 生成，
  // 这里直接验证 HTML 渲染能把它显示出来
  const html = buildGeoCustomerReportHtml(payload(
    { assignments: 50, valid_runs: 25, failed_runs: 25 },
    ["阶段“阶段”·qianwen：50 条分配中仅 25 条产出有效回答（采集完成率 50%，不足一半，其中 25 条采集失败）。"],
  ));
  assert.match(html, /采集完成率 50%/);
  assert.match(html, /采集失败/);
});

test("列名是「采集完成率」而不是「有效率」", () => {
  const html = buildGeoCustomerReportHtml(payload({ assignments: 100, valid_runs: 97, failed_runs: 3 }));
  assert.match(html, /采集完成率/, "列名应表明这是采集完成率");
  assert.doesNotMatch(html, />有效率</, "不应再叫「有效率」，容易被理解成内容质量");
});

test("数据说明点明它衡量采集而非内容", () => {
  const html = buildGeoCustomerReportHtml(payload({ assignments: 100, valid_runs: 97, failed_runs: 3 }));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /衡量的是采集是否跑完，不是回答内容质量/);
  assert.match(text, /未执行的分配仍计入分母/);
});

test("警告文案里不再混用「有效率」", () => {
  // 措辞不一致比措辞不准确更糟：表头说「采集完成率」，
  // 警告里写「有效率」，读者会以为是两个指标。
  //
  // 早期版本用正则去抓 warnings.push 的代码块，抓到了别处的 push ——
  // 断言通过与否都不代表对。直接检查 reportWarnings 的整个函数体。
  const src = readFileSync(
    new URL("../src/reporting/geo-customer-reports.js", import.meta.url), "utf8");
  const start = src.indexOf("function reportWarnings(");
  assert.ok(start >= 0, "应能找到 reportWarnings");
  let body = src.slice(start, src.indexOf("\nfunction ", start + 10));
  // 剥掉行注释：注释里提到「有效率」是在解释它为什么误导，是正当的。
  // 断言只该看会真正出现在用户眼前的代码字符串。
  body = body.replace(/\/\/[^\n]*/g, "");

  assert.match(body, /采集完成率/, "警告里应使用「采集完成率」");
  assert.ok(!body.includes("有效率"),
    "用户可见的警告文案里不应再出现「有效率」，与表头不一致");
});
