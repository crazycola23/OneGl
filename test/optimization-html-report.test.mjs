import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBatchDetail } from "../src/report/evaluation.js";
import { buildOptimizationHtmlReport } from "../src/report/html-report-optimization.js";

function detail() {
  return {
    report: {
      batch: {
        id: 9,
        name: "机会矩阵测试",
        project_name: "Test Brand",
        target_brand: "Test Brand",
        sample_size: 3,
        repeats: 1,
      },
      runs: { assignmentsRun: 3, valid: 3, partial: 0, failed: 0, mentioned: 1, mentionRate: 1 / 3 },
      prompts: { total: 2, mentioned: 1, mentionCoverage: 0.5 },
      citations: { total: 7, articles: 5, domains: 4 },
      tracked: { total: 0, cited: 0, citationRate: null, articles: [] },
      citationFactors: { available: false, message: "暂无因子数据" },
      byCategory: [
        { category: "科普", validRuns: 2, mentioned: 0, mentionRate: 0 },
        { category: "品牌", validRuns: 1, mentioned: 1, mentionRate: 1 },
      ],
      byAccount: [],
      failures: [],
    },
    runs: [
      {
        prompt: "腰痛推拿怎么选",
        category: "科普",
        status: "success",
        conversation_reset_confirmed: true,
        brand_mentioned: false,
        captured_citation_count: 3,
        expected_citation_count: 3,
      },
      {
        prompt: "腰痛推拿怎么选",
        category: "科普",
        status: "success",
        conversation_reset_confirmed: true,
        brand_mentioned: false,
        captured_citation_count: 2,
        expected_citation_count: 2,
      },
      {
        prompt: "Test Brand 怎么样",
        category: "品牌",
        status: "success",
        conversation_reset_confirmed: true,
        brand_mentioned: true,
        captured_citation_count: 2,
        expected_citation_count: 2,
      },
    ],
    sources: {
      totals: { citations: 7, articles: 5, domains: 4 },
      domains: [{ domain: "example.com", citations: 2, articles: 1 }],
      articles: [],
    },
  };
}

test("优化 HTML 报告包含 Prompt 机会矩阵并优先暴露 0 提及问题", () => {
  const input = detail();
  const evaluation = evaluateBatchDetail(input);
  const html = buildOptimizationHtmlReport(input, evaluation, { generatedAt: "2026-09-15T03:00:00Z" });

  assert.match(html, /Prompt 优化机会矩阵/);
  assert.match(html, /腰痛推拿怎么选/);
  assert.match(html, /未被提及/);
  assert.match(html, /P1/);
  assert.match(html, /Test Brand 怎么样/);
  assert.match(html, /当前稳定提及/);
  assert.match(html, /不构造未经验证的 Query → Source 归因/);
});

test("Prompt 机会矩阵转义外部 Prompt 文本", () => {
  const input = detail();
  input.runs[0].prompt = '<img src=x onerror="alert(1)">';
  input.runs[1].prompt = '<img src=x onerror="alert(1)">';
  const evaluation = evaluateBatchDetail(input);
  const html = buildOptimizationHtmlReport(input, evaluation);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});
