import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBatchDetail } from "../src/report/evaluation.js";
import { buildHtmlReportWithFactors } from "../src/report/html-report-factors.js";
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
      citationFactors: {
        batchId: 7,
        cohort: { runs: 80, candidates: 320, cited: 64, baselineRate: 0.2 },
        pageEvidence: { totalArticles: 120, successfulArticles: 102, successRate: 0.85, states: { success: 102 } },
        evidenceGate: { status: "pass", label: "可进入复验", allowOptimizationAdvice: true, blockers: [], warnings: [] },
        strongestSignals: [
          {
            factor: "page_table_present",
            factorLabel: "页面包含表格",
            bucket: "yes",
            candidates: 72,
            cited: 24,
            rate: 1 / 3,
            uplift: 0.6667,
            qValue: 0.04,
            evidenceLevel: "较强",
          },
          {
            factor: "page_modified_date_signal",
            factorLabel: "更新时间信号",
            bucket: "yes",
            candidates: 88,
            cited: 25,
            rate: 25 / 88,
            uplift: 0.4205,
            qValue: 0.08,
            evidenceLevel: "中等",
          },
        ],
      },
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

test("因子证据质量独立于业务准备度，并只把 FDR 支持信号提升为实验建议", () => {
  const detail = fixture();
  const withEvidence = evaluateBatchDetail(detail);
  const withoutEvidenceDetail = fixture();
  delete withoutEvidenceDetail.report.citationFactors;
  const withoutEvidence = evaluateBatchDetail(withoutEvidenceDetail);

  assert.equal(withEvidence.metrics.readinessIndex, withoutEvidence.metrics.readinessIndex);
  assert.ok(withEvidence.metrics.factorEvidence.evidenceScore > 0);
  assert.equal(withEvidence.metrics.factorEvidence.positiveSignals.length, 2);
  assert.equal(withEvidence.metrics.factorEvidence.gate.allowOptimizationAdvice, true);
  assert.ok(withEvidence.recommendations.some((item) => /受控验证实验/.test(item.title)));
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

test("未配置目标文章时保持 N/A，不把 0/0 解释成 0% 或压低准备度", () => {
  const detail = fixture();
  detail.report.tracked = { total: 0, cited: 0, citationRate: null, articles: [] };
  const evaluation = evaluateBatchDetail(detail);
  assert.equal(evaluation.metrics.trackedConfigured, false);
  assert.equal(evaluation.metrics.trackedRate, null);
  assert.ok(!evaluation.recommendations.some((item) => /目标文章/.test(item.title)));

  const html = buildHtmlReportWithFactors(detail, evaluation, { generatedAt: "2026-09-14T07:00:00Z" });
  assert.match(html, /自有内容引用<\/label><strong>N\/A<\/strong><small>未配置目标文章/);
  assert.match(html, /未配置目标文章，不计为 0%/);
  assert.doesNotMatch(html, /(?:目标文章引用率|自有内容引用)<\/label><strong>0\.0%/);
});

test("调优摘要优先展示瓶颈、最弱意图、证据可行动性和下一轮动作", () => {
  const detail = fixture();
  const evaluation = evaluateBatchDetail(detail);
  const html = buildHtmlReportWithFactors(detail, evaluation, { generatedAt: "2026-09-14T07:00:00Z" });
  assert.match(html, /调优摘要/);
  assert.match(html, /当前首要瓶颈/);
  assert.match(html, /意图覆盖：科普/);
  assert.match(html, /最弱问题意图/);
  assert.match(html, /证据可行动性/);
  assert.match(html, /可做受控实验/);
  assert.match(html, /下一轮优先动作/);
  assert.match(html, /P1 · 优先补齐最弱问题意图/);
  assert.match(html, /内部趋势评分（辅助）/);
});

test("调优观测指标强制拆成 Outcome、Diagnostic、Evidence 三层", () => {
  const detail = fixture();
  const evaluation = evaluateBatchDetail(detail);
  const html = buildHtmlReportWithFactors(detail, evaluation, { generatedAt: "2026-09-14T07:00:00Z" });
  assert.match(html, /Outcome · 实际结果/);
  assert.match(html, /Diagnostic · 损失定位/);
  assert.match(html, /Evidence · 可行动性/);
  assert.match(html, /平均引用密度/);
  assert.match(html, /不是质量分/);
  assert.match(html, /缺失数据不按 0 分处理/);
});

test("Evidence Gate 未过时，证据修复优先于业务内容改版", () => {
  const detail = fixture();
  detail.report.citationFactors.evidenceGate = {
    status: "blocked",
    label: "页面证据不足",
    allowOptimizationAdvice: false,
    blockers: [{ code: "PAGE_COVERAGE", message: "页面证据覆盖不足" }],
    warnings: [],
  };
  detail.report.citationFactors.pageEvidence = {
    totalArticles: 120,
    successfulArticles: 60,
    successRate: 0.5,
    states: { success: 60 },
  };
  detail.report.citationFactors.strongestSignals = [];
  const evaluation = evaluateBatchDetail(detail);
  const html = buildHtmlReportWithFactors(detail, evaluation, { generatedAt: "2026-09-14T07:00:00Z" });
  assert.match(html, /当前首要瓶颈/);
  assert.match(html, /证据可用性/);
  assert.match(html, /仅诊断/);
  assert.match(html, /P0 · 先提高候选页面证据覆盖/);
  assert.doesNotMatch(html, /P1 · 优先补齐最弱问题意图<\/b>/);
});

test("HTML 报告是自包含暖色专业报告、包含因子证据并转义外部数据", () => {
  const detail = fixture();
  detail.report.batch.project_name = '<script>alert("x")</script>';
  const evaluation = evaluateBatchDetail(detail);
  const html = buildHtmlReportWithFactors(detail, evaluation, { generatedAt: "2026-09-14T07:00:00Z" });
  assert.match(html, /#F8F1E7/);
  assert.match(html, /专业评估与建议方向/);
  assert.match(html, /综合准备度/);
  assert.match(html, /候选 → 最终引用：页面因素证据/);
  assert.match(html, /FDR q/);
  assert.match(html, /页面包含表格/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.doesNotMatch(html, /cdn|fonts\.googleapis/i);
});

test("批次页面以品牌/引用情报为主视图，GEO 调优诊断降为二级", () => {
  const script = reportExportBootstrap("batches");
  assert.match(script, /生成 HTML 报告/);
  assert.match(script, /预览报告/);
  assert.match(script, /buildOptimizationHtmlReport/);
  assert.match(script, /AI 搜索品牌与引用情报/);
  assert.match(script, /搜索问题 → AI 是否出现目标品牌/);
  assert.match(script, /AI 的引用主要来自哪些域名与链接/);
  assert.match(script, /被引用文章大部分是什么结构/);
  assert.match(script, /哪些被引用文章本身提到了目标品牌/);
  assert.match(script, /二级 GEO 调优诊断/);
  assert.match(script, /Outcome · 实际结果/);
  assert.match(script, /Diagnostic · 损失定位/);
  assert.match(script, /Evidence · 能不能据此改内容/);
  assert.match(script, /内部趋势评分（辅助）/);
  assert.match(script, /onegl-batch-/);
  assert.equal(reportExportBootstrap("runs"), "");
});

test("暖色主题明确覆盖原深色控制台的主色与色彩模式", () => {
  assert.match(WARM_THEME, /color-scheme:\s*light/);
  assert.match(WARM_THEME, /--bg:\s*#F7F0E7/);
  assert.match(WARM_THEME, /--accent:\s*#B55B34/);
});
