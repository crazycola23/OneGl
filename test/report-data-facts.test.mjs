import assert from "node:assert/strict";
import test from "node:test";

import { buildGeoCustomerReportHtml } from "../src/report/html-geo-customer.js";
import { sectionText } from "./helpers/section-text.mjs";

/**
 * 行动建议里要有基于数据的事实，不只是流程性建议。
 *
 * ## 真实缺陷
 *
 * 第 10 节原本全是「逐条核对来源」「持续记录阶段」这类流程性建议，
 * 而报告本身最有决策价值的观察一条都没出现。实测一份 4 竞品 2 平台的报告：
 *
 *   - 千问侧某竞品 71.8%、豆包侧只有 38.1%（差 33.7 个百分点）
 *   - 目标文章覆盖千问 91.5%、豆包 36.0%（差 55.5 个百分点）
 *   - 某竞品两个平台都没被提到
 *   - 豆包采集完成率仅 50%
 *
 * 客户读完第 3 节的表格得自己总结，而多数人不会认真看表。
 *
 * ## 边界
 *
 * 只陈述报告内的数字与差值，不做推断、不给行动判断 ——
 * 那与 OneGL 其它章节的立场一致：给确定性数据，判断归调用方模型。
 */

const period = {
  key: "p", label: "阶段", from: "2026-01-01", to: "2026-01-02",
  time_zone: "Asia/Shanghai", source_batches: [], excluded_batches: [],
};

function platform({ id, valid, assignments, brands, coverage }) {
  return {
    platform: id,
    color: "#2563eb",
    runs: {
      runs: assignments, assignments, valid_runs: valid,
      partial_runs: 0, failed_runs: assignments - valid, reset_unconfirmed_runs: 0,
      success_rate: assignments ? valid / assignments : null,
      answers_with_text: valid, average_answer_characters: 800,
      brand_mentioned_runs: 1, brand_mention_rate: 0.01, citation_valid_runs: valid,
    },
    citations: {
      citation_valid_runs: valid, visible_citations: valid * 10, content_citations: valid * 10,
      icon_citations: 0, unique_domains: 20, unique_articles: 50,
      top_domains: [{ domain: "example.com", citations: 30, unique_articles: 10, covered_runs: 20, covered_run_rate: 0.5 }],
      top_articles: [],
      tracked_content: {
        configured: coverage != null, configured_articles: 28,
        articles: [], cited_articles: 10, citations: 50, covered_runs: valid,
        coverage_rate: coverage, article_coverage_rate: 0.4, truncated: false,
      },
    },
    questions: [], answers: [{ run_id: "run_1", question: "q", answer_chars: 800 }],
    brand_mentions: {
      available: true, answer_count: valid, excluded_answers: 0, truncated: false,
      brand_count: brands.length, basis: "mentioned_answers_over_valid_answers",
      brands: brands.map(([name, rate]) => ({
        name, role: "competitor", mention_rate: rate,
        mentioned_answers: Math.round(rate * valid), mention_count: Math.round(rate * valid),
        valid_answers: valid, first_position_avg: 100, examples: [],
      })),
    },
  };
}

function payload(platforms) {
  return {
    schema_version: "geo-customer-report.v1",
    report_id: "rpt_test", scope_kind: "group", task_id: null, group_id: "grp_test",
    title: "测试报告", generated_at: "2026-01-01T00:00:00.000Z",
    target: {
      name: "测试目标", brand: "自有品牌", brand_configured: true,
      tracked_articles_configured: true, tracked_articles_count: 28,
    },
    theme: null,
    scope: { platforms: platforms.map((p) => p.platform), periods: [period], brands: [] },
    profile: { version: "v1", platform_colors: { qianwen: "#2563eb", doubao: "#7c3aed" } },
    periods: [{ ...period, platforms }],
    methodology: { valid_runs: "口径", assignments: "分配" },
    warnings: [],
  };
}

const section10 = (html) => sectionText(html, "结论与行动建议");

const RICH = () => payload([
  platform({
    id: "qianwen", valid: 85, assignments: 100, coverage: 0.915,
    brands: [["思邈棠", 0.718], ["沈园堂", 0.235], ["禅悦汇", 0.188], ["越都", 0]],
  }),
  platform({
    id: "doubao", valid: 25, assignments: 50, coverage: 0.36,
    brands: [["思邈棠", 0.381], ["沈园堂", 0.143], ["禅悦汇", 0], ["越都", 0]],
  }),
]);

test("报告竞品在各平台的差值", () => {
  const s10 = section10(buildGeoCustomerReportHtml(RICH()));
  assert.match(s10, /思邈棠/, "应提到最高提及率的品牌");
  assert.match(s10, /33\.7 个百分点/, "应给出跨平台差值");
});

test("报告目标文章覆盖的跨平台差距", () => {
  const s10 = section10(buildGeoCustomerReportHtml(RICH()));
  assert.match(s10, /目标文章覆盖/);
  assert.match(s10, /91\.5%/);
  assert.match(s10, /36\.0%|36%/);
  assert.match(s10, /55\.5 个百分点/);
});

test("报告两平台都没提到的竞品", () => {
  const s10 = section10(buildGeoCustomerReportHtml(RICH()));
  assert.match(s10, /完全未提及/, "应指出存在感缺失的竞品");
  assert.match(s10, /越都/);
});

test("报告采集完成率不足的平台", () => {
  const s10 = section10(buildGeoCustomerReportHtml(RICH()));
  assert.match(s10, /采集完成率不足 80%/);
  assert.match(s10, /doubao/);
});

test("平台名正确渲染，不出现 [object Object]", () => {
  const s10 = section10(buildGeoCustomerReportHtml(RICH()));
  assert.ok(!s10.includes("[object Object]"),
    "平台名取自 platform.platform 而非 platform 对象");
  assert.match(s10, /qianwen/);
  assert.match(s10, /doubao/);
});

test("单平台时不硬造跨平台对比", () => {
  const one = payload([
    platform({ id: "qianwen", valid: 85, assignments: 100, coverage: 0.9, brands: [["思邈棠", 0.7]] }),
  ]);
  const s10 = section10(buildGeoCustomerReportHtml(one));
  // 单平台仍可说最高提及率，但不该出现「相差 X 个百分点」
  assert.doesNotMatch(s10, /相差.*个百分点/, "单平台不该有跨平台差值");
});

test("数据不足时不编造数字", () => {
  const empty = payload([
    platform({ id: "qianwen", valid: 0, assignments: 0, coverage: null, brands: [] }),
  ]);
  const html = buildGeoCustomerReportHtml(empty);
  assert.ok(!html.includes("NaN"), "不应出现 NaN");
  assert.ok(!html.includes("Infinity"), "不应出现 Infinity");
  assert.ok(!html.includes("undefined"), "不应出现 undefined");
});

test("只陈述事实，不给行动判断", () => {
  const html = buildGeoCustomerReportHtml(RICH());
  // 只取 facts 块本身：按 <div class="facts"> 定位到它的 </ul>。
  // 早先按「复核目标文章」切分，把标题「结论与行动建议」里的「建议」二字
  // 也算进去了 —— 那是节标题，不该被当成事实摘要里的判断词。
  const start = html.indexOf('<div class="facts">');
  assert.ok(start >= 0, "应存在 facts 块");
  const block = html.slice(start, html.indexOf("</ul>", start))
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  for (const word of ["建议", "应该", "必须", "主攻", "优先"]) {
    assert.ok(!block.includes(word),
      `事实摘要里不应出现判断词「${word}」—— 那是调用方模型的活`);
  }
  // 至少要有实质内容，不能是空壳
  assert.ok(block.length > 80, `事实块应有实质内容，实际长度 ${block.length}`);
});
