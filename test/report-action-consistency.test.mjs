import assert from "node:assert/strict";
import test from "node:test";

import { buildGeoCustomerReportHtml } from "../src/report/html-geo-customer.js";
import { sectionText } from "./helpers/section-text.mjs";

/**
 * 行动建议不能与报告已展示的内容自相矛盾。
 *
 * ## 真实缺陷
 *
 * 第 10 节原来只看 `target.brand_configured`（项目是否配了 target_brand），
 * 于是「项目没配品牌、但本次传了竞品」时同时出现：
 *
 *   第 3 节：思邈棠 71.8%（有竞品数据）
 *   第 10 节：完善品牌配置，当前品牌提及指标为 N/A
 *
 * 客户刚看到竞品数据就被告知没有品牌数据，只能认为其中一处在算错。
 *
 * 修法：那条建议只在**确实没产出竞品数据**时才提，并且说清
 * 「项目品牌口径」与「本次竞品口径」是两回事。
 */

function payload({ brandConfigured, competitorData, trackedConfigured = true }) {
  const period = {
    key: "p", label: "阶段", from: "2026-01-01", to: "2026-01-02",
    time_zone: "Asia/Shanghai", source_batches: [], excluded_batches: [],
  };
  const brandMentions = competitorData
    ? {
        available: true, answer_count: 100, excluded_answers: 0, brand_count: 2,
        basis: "mentioned_answers_over_valid_answers",
        brands: [
          { name: "思邈棠", role: "competitor", mention_rate: 0.718, mentioned_answers: 72, mention_count: 80, valid_answers: 100, first_position_avg: 120, examples: [] },
          { name: "沈园堂", role: "competitor", mention_rate: 0.235, mentioned_answers: 24, mention_count: 26, valid_answers: 100, first_position_avg: 300, examples: [] },
        ],
      }
    : {
        available: false, answer_count: 0, excluded_answers: 0, brand_count: 0,
        basis: "mentioned_answers_over_valid_answers", brands: [],
      };

  return {
    schema_version: "geo-customer-report.v1",
    report_id: "rpt_test", scope_kind: "group", task_id: null, group_id: "grp_test",
    title: "测试报告", generated_at: "2026-01-01T00:00:00.000Z",
    target: {
      name: "测试目标",
      brand: brandConfigured ? "某自有品牌" : null,
      brand_configured: brandConfigured,
      tracked_articles_configured: trackedConfigured,
      tracked_articles_count: 0,
    },
    theme: null,
    scope: { platforms: ["qianwen"], periods: [period], brands: [{ name: "思邈棠", role: "competitor" }] },
    profile: { version: "v1", platform_colors: { qianwen: "#2563eb" } },
    periods: [{
      ...period,
      platforms: [{
        platform: "qianwen", color: "#2563eb",
        runs: {
          runs: 100, assignments: 100, valid_runs: 100, partial_runs: 0, failed_runs: 0,
          reset_unconfirmed_runs: 0, success_rate: 1, answers_with_text: 100,
          average_answer_characters: 800,
          brand_mentioned_runs: brandConfigured ? 5 : null,
          brand_mention_rate: brandConfigured ? 0.05 : null,
          citation_valid_runs: 95,
        },
        citations: {
          citation_valid_runs: 95, visible_citations: 900, content_citations: 900,
          icon_citations: 50, unique_domains: 25, unique_articles: 200,
          top_domains: [{ domain: "example.com", citations: 300, covered_runs: 80 }],
          top_articles: [],
          tracked_content: {
            configured: trackedConfigured, configured_articles: trackedConfigured ? 5 : 0,
            articles: [], cited_articles: null, citations: null, covered_runs: null,
            coverage_rate: null, article_coverage_rate: null, truncated: false,
          },
        },
        questions: [{ question: "哪家好", category: "test", assignments: 100 }],
        answers: [{ run_id: "run_1", question: "哪家好", answer_chars: 800 }],
        brand_mentions: brandMentions,
      }],
    }],
    methodology: {}, warnings: [],
  };
}

const section10 = (html) => sectionText(html, "结论与行动建议");

test("有竞品数据时不要求「完善品牌配置」", () => {
  // 项目未配 target_brand，但本次传了竞品 —— 之前这两条会同时出现
  const html = buildGeoCustomerReportHtml(payload({
    brandConfigured: false,
    competitorData: true,
  }));
  const s10 = section10(html);
  assert.doesNotMatch(s10, /完善品牌配置/,
    "展示了竞品数据就不该说没有品牌数据");
  assert.match(s10, /针对竞品口径复核/,
    "应该给出针对竞品的下一步建议");
  assert.match(s10, /思邈棠/, "建议里应列出实际统计的品牌");
});

test("确实没有品牌数据时才提示配置", () => {
  const html = buildGeoCustomerReportHtml(payload({
    brandConfigured: false,
    competitorData: false,
  }));
  const s10 = section10(html);
  assert.match(s10, /完善项目品牌配置/);
  assert.match(s10, /与本次传入的竞品列表是两回事/,
    "必须点明这是两个不同口径");
});

test("项目已配品牌且有竞品数据时，不提配置建议", () => {
  const html = buildGeoCustomerReportHtml(payload({
    brandConfigured: true,
    competitorData: true,
  }));
  const s10 = section10(html);
  assert.doesNotMatch(s10, /完善项目品牌配置/);
  assert.match(s10, /针对竞品口径复核/);
});

test("竞品口径建议说明换竞品要重新生成快照", () => {
  const html = buildGeoCustomerReportHtml(payload({
    brandConfigured: true,
    competitorData: true,
  }));
  const s10 = section10(html);
  assert.match(s10, /重新提交 brands 参数生成新快照/,
    "要说明历史快照不会自动改，避免用户以为改参数就影响旧报告");
  assert.match(s10, /历史快照不会自动改/);
});
