import {
  buildHtmlReportWithFactors,
  htmlReportWithFactorsBrowserBundle,
} from "./html-report-factors.js";
import {
  buildPromptOpportunities,
  promptOpportunityBrowserBundle,
} from "./prompt-opportunities.js";

function opportunityEsc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function opportunityPct(value, digits = 1) {
  if (value == null || value === "") return "N/A";
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "N/A";
}

function opportunityTone(key) {
  if (key === "DATA_GAP" || key === "NO_MENTION") return "bad";
  if (key === "WEAK_MENTION" || key === "UNSTABLE_MENTION") return "warn";
  return "good";
}

function promptOpportunitySection(detail) {
  const opportunity = buildPromptOpportunities(detail, { maxRows: 30 });
  if (!opportunity.rows.length) return "";

  const rows = opportunity.rows.map((row) => {
    const citationDensity = row.citationDensity == null ? "N/A" : Number(row.citationDensity).toFixed(2);
    return `<tr>
      <td><span class="opportunity-priority ${opportunityEsc(opportunityTone(row.key))}">${opportunityEsc(row.priority)}</span></td>
      <td><b>${opportunityEsc(row.prompt)}</b><div class="opportunity-sub">${opportunityEsc(row.category)}</div></td>
      <td class="num">${opportunityEsc(row.validRuns)} / ${opportunityEsc(row.totalRuns)}</td>
      <td>${opportunityPct(row.mentionRate)}</td>
      <td>${opportunityEsc(citationDensity)}</td>
      <td><b>${opportunityEsc(row.label)}</b><div class="opportunity-sub">${opportunityEsc(row.action)}</div></td>
    </tr>`;
  }).join("");

  const warning = opportunity.truncated
    ? `<div class="callout" style="margin-bottom:14px"><b>机会表不是完整问题池。</b>批次分配 ${opportunityEsc(opportunity.assignmentCount)} 个 Run，但当前 batch detail 只返回 ${opportunityEsc(opportunity.observedRuns)} 个 Run。下表只能用于局部诊断。</div>`
    : `<div class="callout" style="margin-bottom:14px">按真实 Run 聚合，不构造未经验证的 Query → Source 归因。排序优先看“数据是否有效、品牌是否被提及及其稳定性”；可见引用密度只是上下文，不是质量分。</div>`;

  return `<section class="section prompt-opportunities">
    <h2>Prompt 优化机会矩阵</h2>
    <p class="lead">直接回答“下一轮先优化哪些问题”。P0 是数据缺口；P1 是从未/低频提及；P2 是提及不稳定；WATCH 作为稳定对照。这里不把引用总量高误判成品牌表现好。</p>
    ${warning}
    <div class="panel"><div class="panel-body">
      <div class="table-wrap"><table>
        <thead><tr><th>优先级</th><th>Prompt / 分类</th><th>有效 / 总 Run</th><th>品牌提及率</th><th>平均可见引用</th><th>状态 / 下一步</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div></div>
  </section>`;
}

function injectPromptOpportunitySection(html, detail) {
  const section = promptOpportunitySection(detail);
  if (!section) return html;
  const marker = '<section class="section">\n  <h2>品牌可见度拆解</h2>';
  if (html.includes(marker)) return html.replace(marker, `${section}\n\n${marker}`);
  const fallback = '<section class="section">\n  <h2>专业评估与建议方向</h2>';
  return html.includes(fallback)
    ? html.replace(fallback, `${section}\n\n${fallback}`)
    : html.replace("</body>", `${section}</body>`);
}

export function buildOptimizationHtmlReport(detail, evaluation, options = {}) {
  return injectPromptOpportunitySection(
    buildHtmlReportWithFactors(detail, evaluation, options),
    detail,
  );
}

export function optimizationHtmlReportBrowserBundle() {
  return `${htmlReportWithFactorsBrowserBundle()}\n${promptOpportunityBrowserBundle()}\n${[
    opportunityEsc,
    opportunityPct,
    opportunityTone,
    promptOpportunitySection,
    injectPromptOpportunitySection,
    buildOptimizationHtmlReport,
  ].map((fn) => fn.toString()).join("\n")}`;
}
