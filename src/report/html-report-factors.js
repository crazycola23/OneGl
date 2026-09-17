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
  if (value == null || value === "") return "—";
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
        ${gate.allowOptimizationAdvice ? "" : "<p><b>本批次不输出页面因素优化建议。</b>下表仅作诊断，不得把弱关联直接当成改版依据。</p>"}
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
        ? "证据门槛未通过：本批次不输出可执行页面因素清单，仅保留诊断数据。"
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

function optimizationSummaryData(detail, evaluation) {
  const report = detail?.report ?? {};
  const metrics = evaluation?.metrics ?? {};
  const recommendations = Array.isArray(evaluation?.recommendations) ? evaluation.recommendations : [];
  const tracked = report.tracked ?? {};
  const trackedTotal = Number(tracked.total ?? 0);
  const trackedConfigured = Number.isFinite(trackedTotal) && trackedTotal > 0;
  const weakest = metrics?.category?.weakest ?? null;
  const categoryGap = Number(metrics?.category?.gap);
  const promptCoverage = metrics.promptCoverage == null ? null : Number(metrics.promptCoverage);
  const trackedRate = metrics.trackedRate == null ? null : Number(metrics.trackedRate);
  const citationEvidenceRate = metrics.citationEvidenceRate == null ? null : Number(metrics.citationEvidenceRate);
  const topShare = metrics?.source?.topDomainShare == null ? null : Number(metrics.source.topDomainShare);
  const gate = metrics?.factorEvidence?.gate ?? report?.citationFactors?.evidenceGate ?? null;
  const factorAvailable = Boolean(report?.citationFactors?.cohort?.candidates || metrics?.factorEvidence?.available);

  let bottleneck = "进入扩样验证阶段";
  let bottleneckEvidence = "当前没有单一指标足以定义明确短板，优先保持固定 Prompt 池做跨批次复测。";
  let bottleneckTone = "good";
  let actionKeywords = [];

  if (citationEvidenceRate != null && Number.isFinite(citationEvidenceRate) && citationEvidenceRate < 0.8) {
    bottleneck = "引用证据覆盖";
    bottleneckEvidence = `只有 ${factorPct(citationEvidenceRate)} 的 answer-valid Run 具备完整引用证据；先修采集覆盖，再解释引用密度和来源变化。`;
    bottleneckTone = "bad";
    actionKeywords = ["引用证据", "数据可信度"];
  } else if (Number(metrics.dataQualityScore) < 80) {
    bottleneck = "数据可信度";
    bottleneckEvidence = `数据质量 ${factorEsc(metrics.dataQualityScore)}/100；先修失败 Run、引用解析或页面证据，再解释业务结果。`;
    bottleneckTone = "bad";
    actionKeywords = ["数据可信度", "数据质量"];
  } else if (gate?.allowOptimizationAdvice === false) {
    bottleneck = "证据可用性";
    bottleneckEvidence = gate.label
      ? `页面因素证据门槛为「${factorEsc(gate.label)}」；先补齐候选匹配/页面证据，再用因子关联指导改版。`
      : "页面因素证据门槛未通过；先补齐候选匹配或页面证据，再用因子关联指导改版。";
    bottleneckTone = "warn";
    actionKeywords = ["页面证据", "数据可信度"];
  } else if (weakest && Number.isFinite(categoryGap) && categoryGap >= 0.3 && Number(weakest.mentionRate) < 0.4) {
    bottleneck = `意图覆盖：${weakest.category}`;
    bottleneckEvidence = `该分类提及率仅 ${factorPct(weakest.mentionRate)}，与最佳分类相差 ${factorPct(categoryGap)}。`;
    bottleneckTone = "bad";
    actionKeywords = ["最弱问题意图", "问题池"];
  } else if (promptCoverage != null && Number.isFinite(promptCoverage) && promptCoverage < 0.4) {
    bottleneck = "问题覆盖率";
    bottleneckEvidence = `品牌仅覆盖 ${factorPct(promptCoverage)} 的去重 Prompt；应先找出低覆盖问题簇，而不是继续看总引用数。`;
    bottleneckTone = "bad";
    actionKeywords = ["问题池", "自然可见度"];
  } else if (trackedConfigured && trackedRate != null && Number.isFinite(trackedRate) && trackedRate < 0.25) {
    bottleneck = "自有内容进入引用层";
    bottleneckEvidence = `已配置目标文章，但最终引用率仅 ${factorPct(trackedRate)}。`;
    bottleneckTone = "warn";
    actionKeywords = ["目标文章", "自有"];
  } else if (topShare != null && Number.isFinite(topShare) && topShare >= 0.5) {
    bottleneck = "来源结构过度集中";
    bottleneckEvidence = `Top1 来源占全部可见引用 ${factorPct(topShare)}，需要判断是否长期依赖单一来源生态。`;
    bottleneckTone = "warn";
    actionKeywords = ["来源依赖", "来源结构"];
  }

  let actionability = "待扩样";
  let actionabilityHint = `当前样本信心：${metrics.sampleConfidence ?? "未知"}`;
  let actionabilityTone = "warn";
  if (citationEvidenceRate != null && Number.isFinite(citationEvidenceRate) && citationEvidenceRate < 0.8) {
    actionability = "先修引用证据";
    actionabilityHint = `引用证据覆盖仅 ${factorPct(citationEvidenceRate)}，暂不把引用表现当成业务结果。`;
    actionabilityTone = "bad";
  } else if (Number(metrics.dataQualityScore) < 80) {
    actionability = "先修数据";
    actionabilityHint = "数据基础未过线，不建议据此改内容。";
    actionabilityTone = "bad";
  } else if (gate?.allowOptimizationAdvice === false) {
    actionability = "仅诊断";
    actionabilityHint = gate.label ? `证据门槛：${gate.label}` : "页面因素证据尚不足以支持改版。";
    actionabilityTone = "warn";
  } else if (gate?.allowOptimizationAdvice === true) {
    actionability = "可做受控实验";
    actionabilityHint = gate.label ? `证据门槛：${gate.label}` : "优先做单变量/小型析因实验。";
    actionabilityTone = "good";
  } else if (factorAvailable) {
    actionability = "方向性诊断";
    actionabilityHint = `因子证据：${metrics?.factorEvidence?.evidenceLabel ?? "探索性"}`;
  } else if (["低", "偏低"].includes(metrics.sampleConfidence)) {
    actionability = "方向性诊断";
    actionabilityHint = "样本仍小，先用来发现问题，不做稳定规律声明。";
  }

  const p0Action = recommendations.find((item) => item.level === "P0") ?? null;
  const alignedAction = actionKeywords.length
    ? recommendations.find(
        (item) => item.level === "P1" && actionKeywords.some((keyword) => String(item.title ?? "").includes(keyword)),
      ) ?? null
    : null;
  const primaryAction =
    p0Action ??
    alignedAction ??
    recommendations.find((item) => item.level === "P1") ??
    recommendations[0] ??
    null;

  return {
    bottleneck,
    bottleneckEvidence,
    bottleneckTone,
    weakest,
    trackedConfigured,
    trackedRate,
    trackedCited: Number(tracked.cited ?? 0),
    trackedTotal,
    actionability,
    actionabilityHint,
    actionabilityTone,
    primaryAction,
  };
}

function optimizationSummarySection(detail, evaluation) {
  const report = detail?.report ?? {};
  const metrics = evaluation?.metrics ?? {};
  const prompts = report.prompts ?? {};
  const summary = optimizationSummaryData(detail, evaluation);
  const weakestValue = summary.weakest ? factorEsc(summary.weakest.category) : "暂无分类";
  const weakestHint = summary.weakest
    ? `提及率 ${factorPct(summary.weakest.mentionRate)} · ${factorEsc(summary.weakest.mentioned ?? 0)}/${factorEsc(summary.weakest.validRuns ?? 0)} Run`
    : "需要先给 Prompt 配置问题分类";
  const trackedValue = summary.trackedConfigured ? factorPct(summary.trackedRate) : "N/A";
  const trackedHint = summary.trackedConfigured
    ? `${factorEsc(summary.trackedCited)} / ${factorEsc(summary.trackedTotal)} 篇目标文章`
    : "未配置目标文章，不计为 0%";
  const citationCoverageSummary = metrics.citationEvidenceRate == null
    ? "引用证据覆盖未知（旧快照未提供该口径）"
    : `引用证据覆盖 ${factorPct(metrics.citationEvidenceRate)}（${factorEsc(metrics.citationValidRuns ?? "—")} / ${factorEsc(metrics.valid ?? 0)} Run）`;
  const action = summary.primaryAction;

  return `<section class="section optimization-summary">
    <h2>调优摘要</h2>
    <p class="lead">先回答“当前卡在哪里、哪类问题最弱、现有证据能不能指导改版、下一轮验证什么”，而不是先看一个综合分。</p>
    <div class="optimization-focus ${factorEsc(summary.bottleneckTone)}">
      <span>当前首要瓶颈</span>
      <strong>${factorEsc(summary.bottleneck)}</strong>
      <p>${factorEsc(summary.bottleneckEvidence)}</p>
    </div>
    <div class="grid" style="margin-top:14px">
      <div class="kpi"><label>问题覆盖</label><strong>${factorPct(metrics.promptCoverage)}</strong><small>${factorEsc(prompts.mentioned ?? 0)} / ${factorEsc(prompts.total ?? 0)} 个去重 Prompt 被提及</small></div>
      <div class="kpi"><label>最弱问题意图</label><strong class="text-value">${weakestValue}</strong><small>${weakestHint}</small></div>
      <div class="kpi"><label>自有内容引用</label><strong>${trackedValue}</strong><small>${trackedHint}</small></div>
      <div class="kpi ${factorEsc(summary.actionabilityTone)}"><label>证据可行动性</label><strong class="text-value">${factorEsc(summary.actionability)}</strong><small>${factorEsc(summary.actionabilityHint)}</small></div>
    </div>
    <div class="two" style="margin-top:14px">
      <div class="panel"><div class="panel-head"><strong>这批数据怎么读</strong></div><div class="panel-body">
        <p><b>数据基础：</b>${factorEsc(metrics.valid ?? 0)} / ${factorEsc(metrics.assignments ?? 0)} Run 有效；数据质量 ${factorEsc(metrics.dataQualityScore ?? 0)}/100；${factorEsc(citationCoverageSummary)}；样本信心 ${factorEsc(metrics.sampleConfidence ?? "未知")}。</p>
        <p><b>可见结果：</b>RUN 提及率 ${factorPct(metrics.runMentionRate)}；问题覆盖 ${factorPct(metrics.promptCoverage)}。</p>
        <p><b>解释边界：</b>优先把这些指标当成定位损失环节的观测数据，不把单批次相关性直接解释成豆包排序规则。</p>
      </div></div>
      <div class="panel"><div class="panel-head"><strong>下一轮优先动作</strong></div><div class="panel-body">
        ${action
          ? `<p><b>${factorEsc(action.level)} · ${factorEsc(action.title)}</b></p><p>${factorEsc(action.direction)}</p><p><b>验证：</b>${factorEsc(action.metric)}</p>`
          : "<p>保持固定 Prompt 池与种子继续扩样，建立跨批次基线。</p>"}
      </div></div>
    </div>
  </section>`;
}

function optimizationMetricsSection(detail, evaluation) {
  const report = detail?.report ?? {};
  const metrics = evaluation?.metrics ?? {};
  const citations = report.citations ?? {};
  const prompts = report.prompts ?? {};
  const tracked = report.tracked ?? {};
  const summary = optimizationSummaryData(detail, evaluation);
  const weakest = summary.weakest;
  const categoryGap = metrics?.category?.gap;
  const factor = metrics?.factorEvidence ?? {};
  const gate = factor?.gate ?? report?.citationFactors?.evidenceGate ?? null;
  const trackedValue = summary.trackedConfigured ? factorPct(summary.trackedRate) : "N/A";
  const trackedHint = summary.trackedConfigured
    ? `${factorEsc(summary.trackedCited)} / ${factorEsc(summary.trackedTotal)} 篇目标文章`
    : "未配置目标文章";
  const citationCoverageHint = metrics.citationEvidenceRate == null
    ? "旧快照未提供该口径"
    : `${factorEsc(metrics.citationValidRuns ?? "—")} / ${factorEsc(metrics.valid ?? 0)} 个 answer-valid Run`;
  const densityHint = metrics.citationEvidenceRate == null
    ? "旧快照：每个有效 Run 的可见引用数；不是质量分"
    : "每个引用有效 Run 的可见引用数；不是质量分";
  const sourceLabel = metrics?.source?.concentrationLabel ?? "暂无引用数据";
  const topShare = metrics?.source?.topDomainShare;
  const factorAction = gate?.allowOptimizationAdvice === true
    ? "可做受控实验"
    : gate?.allowOptimizationAdvice === false
      ? "仅诊断"
      : factor.available
        ? "方向性诊断"
        : "N/A";

  return `<section class="section optimization-metrics">
    <h2>调优观测指标</h2>
    <p class="lead">把“结果、诊断、证据”分层阅读。Outcome 告诉你发生了什么；Diagnostic 定位损失；Evidence 决定这些现象是否足以指导改版。</p>

    <div class="metric-group">
      <div class="metric-group-head"><b>Outcome · 实际结果</b><span>描述当前表现，不单独解释原因</span></div>
      <div class="grid">
        <div class="kpi"><label>PROMPT 提及覆盖</label><strong>${factorPct(metrics.promptCoverage)}</strong><small>${factorEsc(prompts.mentioned ?? 0)} / ${factorEsc(prompts.total ?? 0)} 个去重问题</small></div>
        <div class="kpi"><label>RUN 提及率</label><strong>${factorPct(metrics.runMentionRate)}</strong><small>${factorEsc(report?.runs?.mentioned ?? 0)} / ${factorEsc(report?.runs?.valid ?? metrics.valid ?? 0)} 有效 Run</small></div>
        <div class="kpi"><label>自有内容引用</label><strong>${trackedValue}</strong><small>${trackedHint}</small></div>
        <div class="kpi"><label>可见引用</label><strong>${factorEsc(citations.total ?? 0)}</strong><small>${factorEsc(citations.articles ?? 0)} 篇文章 · ${factorEsc(citations.domains ?? 0)} 个域名</small></div>
      </div>
    </div>

    <div class="metric-group">
      <div class="metric-group-head"><b>Diagnostic · 损失定位</b><span>用于决定下一轮优先查哪一层</span></div>
      <div class="grid">
        <div class="kpi"><label>最弱问题意图</label><strong class="text-value">${weakest ? factorEsc(weakest.category) : "暂无分类"}</strong><small>${weakest ? `提及率 ${factorPct(weakest.mentionRate)}` : "需要配置问题分类"}</small></div>
        <div class="kpi"><label>意图差距</label><strong>${categoryGap == null ? "—" : factorPct(categoryGap)}</strong><small>最佳分类与最弱分类的提及率差</small></div>
        <div class="kpi"><label>来源集中度</label><strong class="text-value">${factorEsc(sourceLabel)}</strong><small>Top1 ${topShare == null ? "—" : factorPct(topShare)}</small></div>
        <div class="kpi"><label>平均引用密度</label><strong>${Number.isFinite(Number(metrics.citationDensity)) ? Number(metrics.citationDensity).toFixed(2) : "—"}</strong><small>${densityHint}</small></div>
      </div>
    </div>

    <div class="metric-group">
      <div class="metric-group-head"><b>Evidence · 可行动性</b><span>缺失数据不按 0 分处理</span></div>
      <div class="grid">
        <div class="kpi"><label>有效样本率</label><strong>${factorPct(metrics.validRate)}</strong><small>${factorEsc(metrics.valid ?? 0)} / ${factorEsc(metrics.assignments ?? 0)} Run</small></div>
        <div class="kpi"><label>引用证据覆盖</label><strong>${factorPct(metrics.citationEvidenceRate)}</strong><small>${citationCoverageHint}</small></div>
        <div class="kpi"><label>引用解析完整度</label><strong>${factorPct(metrics?.citationCompleteness?.rate)}</strong><small>${factorEsc(metrics?.citationCompleteness?.comparableRuns ?? 0)} 个可比较 Run</small></div>
        <div class="kpi"><label>页面证据覆盖</label><strong>${factorPct(factor.pageEvidenceRate)}</strong><small>${factor.available ? `${factorEsc(factor.pageEvidenceSuccessful ?? 0)} / ${factorEsc(factor.pageEvidenceArticles ?? 0)} 篇候选文章` : "暂无页面因子证据"}</small></div>
        <div class="kpi ${factorEsc(summary.actionabilityTone)}"><label>当前可行动性</label><strong class="text-value">${factorEsc(factorAction)}</strong><small>${factorEsc(summary.actionabilityHint)}</small></div>
      </div>
    </div>
  </section>`;
}

function replaceSectionByHeading(html, heading, replacement) {
  const marker = `<section class="section">\n  <h2>${heading}</h2>`;
  const start = html.indexOf(marker);
  if (start < 0) return html;
  const end = html.indexOf("\n</section>", start);
  if (end < 0) return html;
  return `${html.slice(0, start)}${replacement}${html.slice(end + "\n</section>".length)}`;
}

function enhanceOptimizationSummary(base, detail, evaluation) {
  let html = base;
  const summarySection = optimizationSummarySection(detail, evaluation);
  html = replaceSectionByHeading(html, "管理层摘要", summarySection);

  // Composite scores remain useful for longitudinal comparison, but they are deliberately
  // demoted below the action-first summary so readers do not mistake a single number for an
  // optimization instruction.
  html = html
    .replace("<h2>专业评分卡</h2>", "<h2>内部趋势评分（辅助）</h2>")
    .replace(
      "这些是 OneGl 的内部评估指标，用于批次间对比和行动排序，不是豆包官方分数。",
      "仅用于同一项目跨批次趋势比较；真正的改版优先级以上方调优摘要、问题意图与证据门槛为准。",
    )
    .replace("<h2>核心数据统计</h2>", "<h2>调优观测指标</h2>");

  html = replaceSectionByHeading(html, "调优观测指标", optimizationMetricsSection(detail, evaluation));

  const report = detail?.report ?? {};
  const tracked = report.tracked ?? {};
  const metrics = evaluation?.metrics ?? {};
  const trackedTotal = Number(tracked.total ?? 0);
  const trackedConfigured = Number.isFinite(trackedTotal) && trackedTotal > 0;
  const trackedCard = `<div class="kpi"><label>目标文章引用率</label><strong>${trackedConfigured ? factorPct(metrics.trackedRate) : "N/A"}</strong><small>${trackedConfigured ? `${factorEsc(tracked.cited ?? 0)} / ${factorEsc(tracked.total ?? 0)} 篇目标文章` : "未配置目标文章"}</small></div>`;
  html = html.replace(
    /<div class="kpi"><label>目标文章引用率<\/label><strong>[\s\S]*?<\/strong><small>[\s\S]*?<\/small><\/div>/,
    trackedCard,
  );

  const summaryCss = `
.optimization-focus{padding:20px 22px;border-radius:16px;border:1px solid var(--line);border-left:5px solid var(--green);background:var(--paper);box-shadow:var(--shadow)}
.optimization-focus.warn{border-left-color:var(--amber)}.optimization-focus.bad{border-left-color:var(--red)}
.optimization-focus span{display:block;color:var(--soft);font-size:12px}.optimization-focus strong{display:block;margin-top:3px;font-size:24px}.optimization-focus p{margin:7px 0 0;color:var(--soft)}
.kpi .text-value{font-size:20px;line-height:1.35}.kpi.good strong{color:var(--green)}.kpi.warn strong{color:var(--amber)}.kpi.bad strong{color:var(--red)}
.metric-group{margin-top:14px;padding:16px;border:1px solid var(--line);border-radius:16px;background:var(--paper)}
.metric-group-head{display:flex;justify-content:space-between;gap:16px;align-items:baseline;margin-bottom:12px}.metric-group-head b{font-size:14px}.metric-group-head span{color:var(--soft);font-size:12px;text-align:right}
@media(max-width:820px){.metric-group-head{display:block}.metric-group-head span{display:block;margin-top:3px;text-align:left}}
`;
  if (!html.includes(".optimization-focus{")) html = html.replace("</style>", `${summaryCss}</style>`);
  return html;
}

export function buildHtmlReportWithFactors(detail, evaluation, options = {}) {
  const base = enhanceOptimizationSummary(buildHtmlReport(detail, evaluation, options), detail, evaluation);
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
    optimizationSummaryData,
    optimizationSummarySection,
    optimizationMetricsSection,
    replaceSectionByHeading,
    enhanceOptimizationSummary,
    buildHtmlReportWithFactors,
  ].map((fn) => fn.toString()).join("\n")}`;
}
