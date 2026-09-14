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

  // The gate decides whether this section may argue for action at all. When it says no,
  // the numbers are still shown - hiding them would just push the reader to compute them
  // by hand - but they are labelled as diagnostic-only.
  const gate = evaluation?.metrics?.factorEvidence?.gate ?? detail?.report?.citationFactors?.evidenceGate ?? null;
  const gateBlock = gate
    ? `<div class="callout" style="margin-top:14px;border-left-color:${gate.allowOptimizationAdvice ? "var(--green)" : "var(--red)"}">
        <b>证据门槛：${factorEsc(gate.label)}（${factorEsc(gate.status)}）</b>
        ${gate.blockers?.length ? `<ul>${gate.blockers.map((item) => `<li>${factorEsc(item.message)}</li>`).join("")}</ul>` : ""}
        ${gate.warnings?.length ? `<ul>${gate.warnings.map((item) => `<li>${factorEsc(item.message)}</li>`).join("")}</ul>` : ""}
        ${gate.allowOptimizationAdvice ? "" : "<p><b>本批次不输出优化建议。</b>下表仅作诊断，不得作为改版依据。</p>"}
      </div>`
    : "";

  const matchCoverage = evaluation?.metrics?.factorEvidence?.matchCoverage ?? detail?.report?.citationFactors?.matchCoverage ?? null;
  const matchCoverageBlock = matchCoverage
    ? `<div class="callout" style="margin-top:14px">
        匹配覆盖：精确 ${factorEsc(matchCoverage.exact)} + 别名 ${factorEsc(matchCoverage.alias)}，未匹配 ${factorEsc(matchCoverage.unmatched)}（${factorPct(matchCoverage.unmatchedShare)}）。
        「未匹配」同时包含「确实没被引用」和「网络证据没抓全」，在区分清楚之前不要把转化率差额全部读成引用行为差异。
      </div>`
    : "";

  const rows = gate?.allowOptimizationAdvice === false ? [] : factorRows(factor);
  const table = rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>页面/检索因素</th><th>分组</th><th>样本</th><th>域名</th><th>可配对域名</th><th>引用率</th><th>相对基线</th><th>域内差值</th><th>FDR q</th><th>方向一致</th><th>证据</th></tr></thead><tbody>${rows.map((row) => `<tr>
      <td>${factorEsc(row.factorLabel ?? row.factor)}</td>
      <td><code>${factorEsc(row.bucket)}</code></td>
      <td class="num">${factorEsc(row.candidates)}</td>
      <td class="num">${factorEsc(row.domains ?? "—")}</td>
      <td class="num">${factorEsc(row.pairedDomains ?? 0)}</td>
      <td>${factorPct(row.rate)}</td>
      <td>${factorSignedPct(row.uplift)}</td>
      <td>${factorSignedPct(row.withinDomainDifference)}</td>
      <td>${Number.isFinite(Number(row.qValue)) ? Number(row.qValue).toFixed(3) : "—"}</td>
      <td>${row.directionConsistent ? "是" : "否"}</td>
      <td>${factorEsc(row.evidenceLevel ?? "探索性")}</td>
    </tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">${gate?.allowOptimizationAdvice === false
        ? "证据门槛未通过：本批次不输出可执行因素清单，仅保留诊断数据。"
        : "当前没有同时达到样本门槛与 q≤0.10 的页面/检索因素。保留原始因子统计，但不把弱信号提升为优化建议。"}</div>`;

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
    <div class="callout" style="margin-top:14px">统计口径：主检验是<b>域内配对</b>（对每个同时包含该分组与其对照的域名比较引用率，Wilcoxon signed-rank），再做 Benjamini-Hochberg FDR 校正；合并口径的 p 值仅作参考。候选行按域名聚集，因此有效样本量小于候选条数。q≤0.10 只表示“值得复验”，不构成因果证明。页面快照由 OneGl 在批次后独立抓取，可能与豆包当时看到的页面版本不同。</div>
    ${matchCoverageBlock}
    ${gateBlock}
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
