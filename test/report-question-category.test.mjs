import assert from "node:assert/strict";
import test from "node:test";

import { buildGeoCustomerReportHtml } from "../src/report/html-geo-customer.js";
import { sectionText } from "./helpers/section-text.mjs";

/**
 * 第 7 节：未配置问题分类时明说，而不是显示一张零信息量的表。
 *
 * ## 真实缺陷
 *
 * `prompts.category` 未配置 → 采集时写入的 `sampling_batch_prompts.category`
 * 全部是 `uncategorized`（实测 174 条分配无一例外）→ 报告第 7 节每份都出现
 * 一张 `uncategorized=50` 的「问题分类」表。
 *
 * 客户读到那张表会以为「我们只检测了一类问题」，而真相是**根本没配置分类**。
 * 一行信息的表占了整张表的位置，却比一行说明更没用。
 */

const period = {
  key: "p", label: "阶段", from: "2026-01-01", to: "2026-01-02",
  time_zone: "Asia/Shanghai", source_batches: [], excluded_batches: [],
};

function payload(questions) {
  return {
    schema_version: "geo-customer-report.v1",
    report_id: "rpt_test", scope_kind: "group", task_id: null, group_id: "grp_test",
    title: "测试报告", generated_at: "2026-01-01T00:00:00.000Z",
    target: {
      name: "测试目标", brand: "自有品牌", brand_configured: true,
      tracked_articles_configured: true, tracked_articles_count: 28,
    },
    theme: null,
    scope: { platforms: ["qianwen"], periods: [period], brands: [] },
    profile: { version: "v1", platform_colors: { qianwen: "#2563eb" } },
    periods: [{
      ...period,
      platforms: [{
        platform: "qianwen", color: "#2563eb",
        runs: {
          runs: 50, assignments: 50, valid_runs: 45, partial_runs: 0, failed_runs: 5,
          reset_unconfirmed_runs: 0, success_rate: 0.9, answers_with_text: 45,
          average_answer_characters: 800, brand_mentioned_runs: 1,
          brand_mention_rate: 0.02, citation_valid_runs: 44,
        },
        citations: {
          citation_valid_runs: 44, visible_citations: 440, content_citations: 440,
          icon_citations: 0, unique_domains: 20, unique_articles: 50,
          top_domains: [{ domain: "example.com", citations: 30, unique_articles: 10, covered_runs: 20, covered_run_rate: 0.5 }],
          top_articles: [],
          tracked_content: {
            configured: true, configured_articles: 28, articles: [], cited_articles: 10,
            citations: 50, covered_runs: 40, coverage_rate: 0.9,
            article_coverage_rate: 0.4, truncated: false,
          },
        },
        questions, answers: [], brand_mentions: null,
      }],
    }],
    methodology: { valid_runs: "口径" },
    warnings: [],
  };
}

/** 按标题取「检测的问题范围」一节，不依赖章节编号（删章后编号会移位）。 */
const section7 = (html) => sectionText(html, "检测的问题范围");

const Q = (question, category, assignments = 1) => ({ question, category, assignments });

test("全部 uncategorized 时显示说明而非空表", () => {
  const html = buildGeoCustomerReportHtml(payload([
    Q("哪家好", "uncategorized", 30), Q("多少钱", "uncategorized", 20),
  ]));
  const s7 = section7(html);
  assert.match(s7, /未配置分类/, "应明说未配置分类");
  assert.match(s7, /prompts\.category/, "应指出配置入口");
  // 不应出现那张只有一行的表
  assert.doesNotMatch(s7, /问题分类\s+分配次数/,
    "全部未分类时不应显示分类表");
});

test("有真实分类时照常显示分类表", () => {
  const html = buildGeoCustomerReportHtml(payload([
    Q("哪家好", "品牌识别", 30), Q("多少钱", "价格", 20),
  ]));
  const s7 = section7(html);
  assert.match(s7, /品牌识别/, "应显示真实分类");
  assert.match(s7, /价格/);
  assert.ok(!s7.includes("未配置分类"), "有分类时不该显示未配置说明");
});

test("只有一个真实分类时仍显示表", () => {
  // 「只有一类」是真实的数据形态，与「没配置」要区分开
  const html = buildGeoCustomerReportHtml(payload([Q("哪家好", "品牌识别", 50)]));
  const s7 = section7(html);
  assert.match(s7, /品牌识别/);
  assert.ok(!s7.includes("未配置分类"),
    "只有一个真实分类 ≠ 未配置分类，不能混为一谈");
});

test("判据基于原始分类名，不依赖转义后的巧合", () => {
  // "uncategorized" 是纯 ASCII，escapeHtml 后恰好不变 ——
  // 若判据写在转义后的字符串上，能工作纯属巧合。
  // 这里用一个需要转义的分类名验证判据不会误判。
  const html = buildGeoCustomerReportHtml(payload([
    Q("哪家好", "价格&服务", 50),
  ]));
  const s7 = section7(html);
  assert.ok(!s7.includes("未配置分类"),
    "含 & 的分类名不应被误判成 uncategorized");
  assert.match(s7, /价格&服务|价格&amp;服务/);
});
