import { readFile, writeFile } from "node:fs/promises";

import { evaluateBatchDetail } from "../src/report/evaluation.js";
import { buildOptimizationHtmlReport } from "../src/report/html-report-optimization.js";

/**
 * 把 tools/export-batch.js 导出的批次快照渲染成自包含 HTML 报告。
 *
 * 用法：
 *   node tools/build-report-html.js <快照.json> <输出.html> [--profile <profile.json>]
 *
 * profile 目前支持：
 *   { "title": "...", "subtitle": "..." }
 *
 * HTML 不依赖 CDN / 外部字体，可直接双击、归档或发送给客户。
 */
const [, , inputFile, outputFile, ...rest] = process.argv;
if (!inputFile || !outputFile) {
  console.error(
    "用法：node tools/build-report-html.js <快照.json> <输出.html> [--profile <profile.json>]",
  );
  process.exit(1);
}

const profileFlagIndex = rest.findIndex((token) => token === "--profile");
const profileFile = profileFlagIndex >= 0 ? rest[profileFlagIndex + 1] : null;
const profile = profileFile ? JSON.parse(await readFile(profileFile, "utf8")) : {};
const snapshot = JSON.parse(await readFile(inputFile, "utf8"));

// 兼容旧 export-batch 快照结构，并统一成 Dashboard / API 使用的 batchDetail 形状。
// intelligence 缺失时 src/report/brand-source-intelligence.js 会直接返回空串，
// 「AI 搜索品牌与引用情报」整节就会静默消失，所以旧快照必须显式回退而不是假装存在。
const detail = {
  report: snapshot.report ?? {},
  runs: Array.isArray(snapshot.runs) ? snapshot.runs : [],
  sources: snapshot.sources ?? {
    domains: Array.isArray(snapshot.domains) ? snapshot.domains : snapshot.report?.topDomains ?? [],
    articles: snapshot.report?.topArticles ?? [],
    totals: snapshot.report?.citations ?? { citations: 0, articles: 0, domains: 0 },
  },
  intelligence: snapshot.intelligence ?? null,
};

if (!detail.intelligence) {
  console.warn(
    "[build-report-html] 快照缺少 intelligence（引用页品牌与结构情报）；"
      + "请用当前版本的 tools/export-batch.js 重新导出，否则该节不会出现在 HTML 中。",
  );
}

const evaluation = evaluateBatchDetail(detail);
const html = buildOptimizationHtmlReport(detail, evaluation, {
  generatedAt: new Date().toISOString(),
  title: profile.title ?? null,
  subtitle: profile.subtitle ?? null,
});

await writeFile(outputFile, html, "utf8");
console.log(`已生成 ${outputFile}`);
console.log(
  `综合准备度=${evaluation.metrics.readinessIndex}/100 ` +
    `数据质量=${evaluation.metrics.dataQualityScore}/100 ` +
    `品牌可见度=${evaluation.metrics.visibilityIndex}/100 ` +
    `因子证据=${evaluation.metrics.factorEvidence.evidenceScore}/100`,
);
