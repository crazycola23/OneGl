// 钉住报告的两个结构约定：
//   1) 多平台时按平台分块，不把不同平台的数据混在一张表里
//   2) 目录常驻在侧边（sticky），不是正文顶部一块会滚走的标签
//
// 这两条都是被明确要求过的，而且很容易在后续改渲染时被无意弄回去：
// 表格"混在一起"也能正常渲染，目录"放顶上"也能用，只是读起来费劲 ——
// 没有任何功能测试会失败，所以必须单独钉。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGeoCustomerReportHtml } from "../src/report/html-geo-customer.js";

/** 造一份双平台双阶段的 payload，够触发分块逻辑。字段形状对齐 report-brand-caliber 的 fixture。 */
function twoPlatformPayload() {
  const platform = (name, validRuns) => ({
    platform: name,
    color: "#2563eb",
    runs: {
      runs: 100, assignments: 100, valid_runs: validRuns, partial_runs: 0,
      failed_runs: 100 - validRuns, reset_unconfirmed_runs: 0,
      success_rate: validRuns / 100, answers_with_text: validRuns,
      average_answer_characters: 800,
      brand_mentioned_runs: 5,
      brand_mention_rate: 0.05,
      citation_valid_runs: validRuns,
    },
    citations: {
      citation_valid_runs: validRuns, visible_citations: 900, content_citations: 900,
      icon_citations: 50, unique_domains: 25, unique_articles: 200,
      top_domains: [{ domain: "example.com", citations: 300, unique_articles: 90, covered_runs: 80, covered_run_rate: 0.8 }],
      top_articles: [{ canonical_url: "https://example.com/a", title: "示例", domain: "example.com", citations: 20, covered_runs: 10 }],
      tracked_content: {
        configured: false, configured_articles: 0, articles: [],
        cited_articles: null, citations: null, covered_runs: null,
        coverage_rate: null, article_coverage_rate: null, truncated: false,
      },
    },
    questions: [{ question: "哪家好", category: "test", assignments: 100 }],
    answers: [{ run_id: "run_1", question: "哪家好", answer_chars: 800 }],
    brand_mentions: {
      available: true,
      answer_count: validRuns,
      excluded_answers: 0,
      truncated: false,
      brand_count: 2,
      basis: "mentioned_answers_over_valid_answers",
      brands: [
        { name: "思邈棠", role: "competitor", mention_rate: 8 / validRuns, mentioned_answers: 8, mention_count: 9, valid_answers: validRuns, first_position_avg: 1.2, examples: [] },
        { name: "禅悦汇", role: "competitor", mention_rate: 2 / validRuns, mentioned_answers: 2, mention_count: 2, valid_answers: validRuns, first_position_avg: 3.1, examples: [] },
      ],
    },
  });

  const period = (key, label, a, b) => ({
    key, label, from: "2026-09-25", to: "2026-09-26", time_zone: "Asia/Shanghai",
    source_batches: [], excluded_batches: [],
    // allRows 靠 period.platforms 展开，所以平台挂在 period 下
    platforms: [platform("doubao", a), platform("qianwen", b)],
  });

  const periods = [period("p1", "阶段一", 25, 97), period("p2", "阶段二", 30, 90)];

  return {
    schema_version: "geo-customer-report.v1",
    report_id: "rpt_test",
    scope_kind: "group",
    task_id: null,
    group_id: "grp_test",
    title: "测试报告",
    generated_at: "2026-01-01T00:00:00.000Z",
    target: { name: "测试目标", brand: "思邈棠", tracked_articles_configured: false, tracked_articles_count: 0 },
    theme: null,
    scope: { platforms: ["doubao", "qianwen"], periods, brands: [{ name: "思邈棠" }, { name: "禅悦汇" }] },
    profile: { version: "v1", platform_colors: { doubao: "#dc2626", qianwen: "#2563eb" } },
    periods,
    methodology: {},
    warnings: [],
  };
}

test("概览按平台分块：同一张表里不同时出现两个平台的阶段行", () => {
  const html = buildGeoCustomerReportHtml(twoPlatformPayload());
  const section = html.slice(html.indexOf('id="sec-01"'), html.indexOf('id="sec-02"'));

  // 分块后每个平台一块，块内各两行阶段
  assert.match(section, /doubao/, "概览应出现 doubao");
  assert.match(section, /qianwen/, "概览应出现 qianwen");

  // 关键：表头里不该再有「平台」这一列 —— 平台已经是块的标题了
  assert.ok(
    !/<th[^>]*>平台<\/th>/.test(section),
    "按平台分块后表头不应再保留「平台」列，否则同一信息出现两次",
  );
});

test("品牌提及对比按平台分块，两个平台各自一块", () => {
  const html = buildGeoCustomerReportHtml(twoPlatformPayload());
  const section = html.slice(html.indexOf('id="sec-03"'), html.indexOf('id="sec-04"'));

  // 跨平台对照表保留（那是"哪个平台偏爱哪个竞品"的答案，是这份报告最有用的结论）
  assert.match(section, /跨平台对照/, "跨平台对照表应保留");

  // 分平台明细：两个平台各一个 subpanel
  const panels = section.match(/<div class="subpanel">/g) ?? [];
  assert.equal(panels.length, 2, `应为每个平台各一个分块，实际 ${panels.length} 个`);

  // 明细表里不该再有「分平台」列
  assert.ok(
    !/<th[^>]*>分平台<\/th>/.test(section),
    "按平台分块后明细表不应再有「分平台」列",
  );
});

test("来源章节按平台分块", () => {
  const html = buildGeoCustomerReportHtml(twoPlatformPayload());
  const section = html.slice(html.indexOf('id="sec-04"'), html.indexOf('id="sec-05"'));
  const panels = section.match(/<div class="subpanel">/g) ?? [];
  assert.equal(panels.length, 2, `来源章节应为每个平台各一个分块，实际 ${panels.length} 个`);
});

test("目录常驻在侧边：sticky 定位 + 两栏布局", () => {
  const html = buildGeoCustomerReportHtml(twoPlatformPayload());
  const style = html.slice(0, html.indexOf("</style>"));

  assert.match(html, /<aside id="toc" class="sidenav">/, "目录应是侧边栏");
  assert.match(style, /\.sidenav\{[^}]*position:sticky/, "侧边栏必须 sticky，否则会随正文滚走");
  assert.match(style, /body\{display:grid;grid-template-columns:\d+px/, "正文应为两栏布局，目录占一栏");
});

test("窄屏时侧边栏退回横排，打印时整条隐藏", () => {
  const html = buildGeoCustomerReportHtml(twoPlatformPayload());
  const style = html.slice(0, html.indexOf("</style>"));

  assert.match(
    style,
    /@media\(max-width:\d+px\)\{body\{display:block\}/,
    "窄屏必须退回单栏，否则正文被切掉一截",
  );
  assert.match(
    style,
    /@media print\{[\s\S]*?\.sidenav\{display:none\}/,
    "打印时侧边栏应隐藏 —— 每页印一份目录没有意义",
  );
});

test("报告里不引入可执行脚本（快照可能被改，HTML 必须自洽）", () => {
  const html = buildGeoCustomerReportHtml(twoPlatformPayload());
  assert.ok(!/<script[\s>]/i.test(html), "报告 HTML 不应带 script");
  // 目录高亮因此用 :target + :has() 实现，不靠 JS 跟随滚动
  assert.match(html, /:has\(#sec-01:target\)/, "当前章节高亮应当是纯 CSS 方案");
});
