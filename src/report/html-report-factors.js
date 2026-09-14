import { buildHtmlReport, htmlReportBrowserBundle } from "./html-report.js";

function factorEsc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function factorPct(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "—";
}

function factorSignedPct(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const number = n * 100;
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}%`;
}

function factorRows(report) {
  const source = Array.isArray(report?.strongestSignals) ? report.strongestSignals : [];
  const supported = source.filter(
    (row) => row.bucket !== "missing" && Number.isFinite(Number(row.qValue)) && Number(row.qValue) <= 0.1 && Number(row.candidates) >= 30,
  );
  const positives = supported.filter((row) => Number(row.uplift) > 0).slice(0, 6);
  const negatives = supported.filter((row) => Number(row.uplift) < 0).slice(0, 4);
  return [...positives, ...negatives];
}

function factorEvidenceSection(detail, evaluation) {
  const factor = detail?.report?.citationFactors ?? detail?.citationFactors ?? null;
  const evidence = evaluation?.metrics?.factorEvidence ?? null;
  if (!factor || factor.available === false || !factor?.cohort?.candidates) return "";

  const rows = factorRows(factor);
  const table = rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>页面/检索因素</th><th>分组</th><th>样本</th><th>引用率</th><th>相对基线</th><th>FDR q</th><th>证据</th></tr></thead><tbody>${rows.map((row) => `<tr>
      <td>${factorEsc(row.factorLabel ?? row.factor)}</td>
      <td><code>${factorEsc(row.bucket)}</code></td>
      <td class="num">${factorEsc(row.candidates)}</td>
      <td>${factorPct(row.rate)}</td>
      <td>${factorSignedPct(row.uplift)}</td>
      <td>${Number.isFinite(Number(row.qValue)) ? Number(row.qValue).toFixed(3) : "—"}</td>
      <td>${factorEsc(row.evidenceLevel ?? "探索性")}</td>
    </tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">当前没有同时达到样本门槛与 q≤0.10 的页面/检索因素。保留原始因子统计，但不把弱信号提升为优化建议。</div>`;

  const pageRate = factor?.pageEvidence?.successRate;
  const coverage = Number.isFinite(Number(pageRate)) ? factorPct(pageRate) : "—";
  const evidenceLabel = evidence?.evidenceLabel ?? "探索性";
  const evidenceScore = Number.isFinite(Number(evidence?.evidenceScore)) ? Number(evidence.evidenceScore).toFixed(0) : "—";

  return `<section class="section">
    <h2>候选 → 最终引用：页面因素证据</h2>
    <p class="lead">回答“豆包已经检索到以后，哪些可观测页面/检索特征与最终进入可见引用层相关”。这是 OneGl 的描述性研究层，不代表豆包内部权重。</p>
    <div class="grid">
      <div class="kpi"><label>候选资料</label><strong>${factorEsc(factor.cohort.candidates)}</strong><small>${factorEsc(factor.cohort.runs)} 个干净运行</small></div>
      <div class="kpi"><label>精确引用命中</label><strong>${factorEsc(factor.cohort.cited)}</strong><small>基线转化率 ${factorPct(factor.cohort.baselineRate)}</small></div>
      <div class="kpi"><label>页面证据覆盖</label><strong>${coverage}</strong><small>${factorEsc(factor.pageEvidence?.successfulArticles ?? 0)} / ${factorEsc(factor.pageEvidence?.totalArticles ?? 0)} 篇唯一候选文章</small></div>
      <div class="kpi"><label>因子证据质量</label><strong>${factorEsc(evidenceScore)}</strong><small>${factorEsc(evidenceLabel)} · 独立于业务准备度评分</small></div>
    </div>
    <div class="callout" style="margin-top:14px">统计口径：bucket 与其余候选做探索性比例差异检验，并对本报告非 missing bucket 使用 Benjamini-Hochberg FDR 校正。q≤0.10 只表示“值得复验”，不构成因果证明。页面快照由 OneGl 在批次后独立抓取，可能与豆包当时看到的页面版本不同。</div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><strong>优先复验的关联信号</strong></div><div class="panel-body">${table}</div></div>
  </section>`;
}

export function buildHtmlReportWithFactors(detail, evaluation, options = {}) {
  const base = buildHtmlReport(detail, evaluation, options);
  const section = factorEvidenceSection(detail, evaluation);
  if (!section) return base;
  const marker = '<section class="section">\n  <h2>专业评估与建议方向</h2>';
  return base.includes(marker) ? base.replace(marker, `${section}\n\n${marker}`) : base.replace("</body>", `${section}</body>`);
}

export function htmlReportWithFactorsBrowserBundle() {
  return `${htmlReportBrowserBundle()}\n${[
    factorEsc,
    factorPct,
    factorSignedPct,
    factorRows,
    factorEvidenceSection,
    buildHtmlReportWithFactors,
  ].map((fn) => fn.toString()).join("\n")}`;
}
