import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBatchDetail } from "../src/report/evaluation.js";
import { buildHtmlReport } from "../src/report/html-report.js";
import { reportExportBootstrap } from "../src/ui/report-export.js";
import { WARM_THEME } from "../src/ui/warm-theme.js";

function fixture(overrides = {}) {
  const detail = {
    report: {
      batch: {
        id: 7,
        name: "品牌监测批次",
        project_name: "Example Brand",
        target_brand: "Example",
        sampling_method: "stratified",
        sample_size: 50,
        repeats: 2,
        started_at: "2026-09-14T01:00:00Z",
        finished_at: "2026-09-14T02:00:00Z",
      },
      runs: {
        assignmentsRun: 100,
        valid: 92,
        partial: 4,
        failed: 8,
        mentioned: 46,
        mentionRate: 0.5,
      },
      prompts: { total: 50, mentioned: 20, mentionCoverage: 0.4 },
      citations: { total: 140, articles: 72, domains: 18 },
      tracked: { total: 10, cited: 2, citationRate: 0.2, articles: [] },
      byCategory: [
        { category: "推荐", validRuns: 40, mentioned: 28, mentionRate: 0.7 },
        { category: "科普", validRuns: 30, mentioned: 9, mentionRate: 0.3 },
      ],
      byAccount: [
        { account: "a1", validRuns: 46, mentioned: 27, mentionRate: 0.59, citations: 80 },
        { account: "a2", validRuns: 46, mentioned: 19, mentionRate: 0.41, citations: 60 },
      ],
      failures: [{ error_code: "DOUBAO_TIMEOUT", runs: 8 }],
    },
    runs: [
      { expected_citation_count: 3, captured_citation_count: 3 },
      { expected_citation_count: 4, captured_citation_count: 3 },
    ],
    sources: {
      totals: { citations: 140, articles: 72, domains: 18 },
      domains: [
        { domain: "source-a.example", citations: 75, articles: 20, runs: 40 },
        { domain: "source-b.example", citations: 30, articles: 18, runs: 24 },
        { domain: "source-c.example", citations: 15, articles: 10, runs: 14 },
      ],
      articles: [
        { title: "Article A", canonical_url: "https://source-a.example/a", normalized_domain: "source-a.example", citations: 12, prompts: 9 },
      ],
    },
  };
  return { ...detail, ...overrides };
}

test("专业评估同时考虑数据质量、品牌可见度和来源集中度", () => {
  const evaluation = evaluateBatchDetail(fixture());
  assert.ok(evaluation.metrics.dataQualityScore >= 70);
  assert.equal(evaluation.metrics.visibilityIndex, 42);
  assert.equal(evaluation.metrics.source.concentrationLabel, "高度集中");
  assert.ok(evaluation.recommendations.some((item) => /目标文章/.test(item.title)));
  assert.ok(evaluation.recommendations.some((item) => /来源依赖/.test(item.title)));
});

test("小样本会明确降低结论置信表达，而不是伪装成稳定规律", () => {
  const detail = fixture();
  detail.report.runs.assignmentsRun = 8;
  detail.report.runs.valid = 7;
  detail.report.prompts.total = 4;
  const evaluation = evaluateBatchDetail(detail);
  assert.equal(evaluation.metrics.sampleConfidence, "低");
  assert.ok(evaluation.caveats.some((item) => /样本量较小/.test(item)));
});

test("HTML 报告是自包含暖色专业报告并转义外部数据", () => {
  const detail = fixture();
  detail.report.batch.project_name = '<script>alert("x")</script>';
  const evaluation = evaluateBatchDetail(detail);
  const html = buildHtmlReport(detail, evaluation, { generatedAt: "2026-09-14T07:00:00Z" });
  assert.match(html, /#F8F1E7/);
  assert.match(html, /专业评估与建议方向/);
  assert.match(html, /综合准备度/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.doesNotMatch(html, /cdn|fonts\.googleapis/i);
});

test("批次页面脚本提供一键 HTML 导出与预览，不在其它页面注入", () => {
  const script = reportExportBootstrap("batches");
  assert.match(script, /生成 HTML 报告/);
  assert.match(script, /预览报告/);
  assert.match(script, /onegl-batch-/);
  assert.equal(reportExportBootstrap("runs"), "");
});

test("暖色主题明确覆盖原深色控制台的主色与色彩模式", () => {
  assert.match(WARM_THEME, /color-scheme:\s*light/);
  assert.match(WARM_THEME, /--bg:\s*#F7F0E7/);
  assert.match(WARM_THEME, /--accent:\s*#B55B34/);
});
