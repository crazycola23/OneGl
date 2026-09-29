import assert from "node:assert/strict";
import test from "node:test";

import { buildGeoCustomerReportHtml } from "../src/report/html-geo-customer.js";

/**
 * 报告里两个「品牌提及率」不能混为一谈。
 *
 * ## 真实事故
 *
 * 第 2 节「最重要的发现」原来读 `runs.brand_mention_rate` —— 那是**采集期**
 * 按项目 `target_brand` 算的。实测该项目 target_brand 是类目词
 * 「绍兴肩颈腰腿调理（改名）」，于是报告对客户说：
 *
 *   第 2 节：品牌提及率 1.0%
 *   第 3 节：思邈棠 71.8%
 *
 * 两个「品牌提及率」并列出现，读者只会认为其中某个在算错。
 * **数字本身都没错，错的只是没标口径。**
 *
 * 现在第 2 节改用本报告 brands 参数的统计结果，第 1 节表头改称
 * 「项目品牌提及率」并注明与第 3 节不是同一批品牌。
 */

const long = (core) => core + "。".repeat(120);

function payload({ brands, brandMentions, targetBrand = "绍兴肩颈腰腿调理（改名）" }) {
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
    target: {
      name: "测试目标",
      brand: targetBrand,
      tracked_articles_configured: false,
      tracked_articles_count: 0,
    },
    theme: null,
    scope: { platforms: ["qianwen"], periods: [period], brands },
    profile: { version: "v1", platform_colors: { qianwen: "#2563eb" } },
    periods: [{
      ...period,
      platforms: [{
        platform: "qianwen",
        color: "#2563eb",
        runs: {
          runs: 100, assignments: 100, valid_runs: 100, partial_runs: 0, failed_runs: 0,
          reset_unconfirmed_runs: 0, success_rate: 1, answers_with_text: 100,
          average_answer_characters: 800,
          // 采集期口径：1.0%，与下面的竞品 71.8% 完全是两回事
          brand_mentioned_runs: 1,
          brand_mention_rate: 0.01,
          citation_valid_runs: 95,
        },
        citations: {
          citation_valid_runs: 95, visible_citations: 900, content_citations: 900,
          icon_citations: 50, unique_domains: 25, unique_articles: 200,
          top_domains: [{ domain: "example.com", citations: 300, covered_runs: 80 }],
          top_articles: [],
          tracked_content: {
            configured: false, configured_articles: 0, articles: [],
            cited_articles: null, citations: null, covered_runs: null,
            coverage_rate: null, article_coverage_rate: null, truncated: false,
          },
        },
        questions: [{ question: "哪家好", category: "test", assignments: 100 }],
        answers: [{ run_id: "run_1", question: "哪家好", answer_chars: 800 }],
        brand_mentions: brandMentions,
      }],
    }],
    methodology: {},
    warnings: [],
  };
}

const COMPETITOR_STATS = {
  available: true,
  answer_count: 100,
  excluded_answers: 0,
  truncated: false,
  brand_count: 2,
  basis: "mentioned_answers_over_valid_answers",
  brands: [
    {
      name: "思邈棠", role: "competitor", mention_rate: 0.718,
      mentioned_answers: 72, mention_count: 80, valid_answers: 100,
      first_position_avg: 120, examples: [],
    },
    {
      name: "沈园堂", role: "competitor", mention_rate: 0.235,
      mentioned_answers: 24, mention_count: 26, valid_answers: 100,
      first_position_avg: 300, examples: [],
    },
  ],
};

test("第 2 节用本次竞品的提及率，不用采集期的项目品牌", () => {
  const html = buildGeoCustomerReportHtml(payload({
    brands: [{ name: "思邈棠", role: "competitor" }, { name: "沈园堂", role: "competitor" }],
    brandMentions: COMPETITOR_STATS,
  }));
  const s2 = html.slice(html.indexOf('id="sec-02"'), html.indexOf("</section>", html.indexOf('id="sec-02"')));
  const text = s2.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  assert.match(text, /思邈棠/, "第 2 节应提到竞品名");
  assert.match(text, /71\.8%/, "第 2 节应给出竞品的提及率");
  assert.doesNotMatch(text, /1\.0%/, "不应出现采集期项目品牌的 1.0%");
  assert.match(text, /本次传入的 2 个品牌/, "应说明这是本次传入的竞品口径");
});

test("第 1 节表头点明是项目品牌口径，并说明与第 3 节不同", () => {
  const html = buildGeoCustomerReportHtml(payload({
    brands: [{ name: "思邈棠", role: "competitor" }],
    brandMentions: COMPETITOR_STATS,
  }));
  assert.match(html, /项目品牌提及率/, "表头应点明口径");
  assert.match(html, /与第 3 节本次传入的竞品不是同一批品牌/,
    "数据说明应澄清两个口径的关系");
  void long;
});

test("没做品牌分析时如实说没做，不退回另一个口径的数字", () => {
  const html = buildGeoCustomerReportHtml(payload({
    brands: [{ name: "思邈棠", role: "competitor" }],
    brandMentions: {
      available: false, answer_count: 0, excluded_answers: 0, brand_count: 0,
      basis: "mentioned_answers_over_valid_answers", brands: [],
    },
  }));
  const s2 = html.slice(html.indexOf('id="sec-02"'), html.indexOf("</section>", html.indexOf('id="sec-02"')));
  const text = s2.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /未产出品牌提及统计/, "应说明没有产出统计");
  assert.doesNotMatch(text, /1\.0%/, "绝不能用采集期的数字顶替");
});

test("没传 brands 时说明未指定竞品", () => {
  const html = buildGeoCustomerReportHtml(payload({
    brands: [],
    brandMentions: {
      available: false, answer_count: 0, excluded_answers: 0, brand_count: 0,
      basis: "mentioned_answers_over_valid_answers", brands: [],
    },
  }));
  const s2 = html.slice(html.indexOf('id="sec-02"'), html.indexOf("</section>", html.indexOf('id="sec-02"')));
  const text = s2.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /未指定竞品/, "应说明未指定竞品");
  assert.doesNotMatch(text, /1\.0%/, "绝不能用采集期的数字顶替");
});

test("两个口径的数字都不该被隐去，但必须各自标明", () => {
  const html = buildGeoCustomerReportHtml(payload({
    brands: [{ name: "思邈棠", role: "competitor" }, { name: "沈园堂", role: "competitor" }],
    brandMentions: COMPETITOR_STATS,
  }));
  // 采集期的 1.0% 仍出现在第 1 节的表里（那是有效数据，不该删），
  // 但表头与说明必须点明它与竞品无关
  assert.match(html, /1\.0%/, "项目品牌数据本身是有效的，不应删除");
  assert.match(html, /项目品牌提及率/, "但表头要标明口径");
});
