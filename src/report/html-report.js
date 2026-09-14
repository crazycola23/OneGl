function reportEsc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function reportNum(value, digits = 0) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function reportPct(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

function reportDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return reportEsc(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function reportTone(score) {
  if (Number(score) >= 80) return "good";
  if (Number(score) >= 60) return "warn";
  return "bad";
}

function reportBar(value, tone = "warm") {
  const width = Math.max(0, Math.min(100, Math.round(Number(value ?? 0) * 100)));
  return `<div class="mini-bar"><i class="${reportEsc(tone)}" style="width:${width}%"></i></div>`;
}

function reportRows(rows, columns, empty = "暂无数据") {
  if (!Array.isArray(rows) || rows.length === 0) {
    return `<div class="empty">${reportEsc(empty)}</div>`;
  }
  const head = columns.map((column) => `<th>${reportEsc(column.label)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${columns.map((column) => `<td${column.num ? ' class="num"' : ""}>${column.render(row)}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function reportScoreCard(label, score, hint) {
  const tone = reportTone(score);
  return `<div class="score ${tone}">
    <div class="score-label">${reportEsc(label)}</div>
    <div class="score-value">${reportNum(score)}<span>/100</span></div>
    <div class="score-grade">${reportEsc(hint)}</div>
    ${reportBar(Number(score) / 100, tone)}
  </div>`;
}

function reportRecommendation(item) {
  const tone = item.level === "P0" ? "bad" : item.level === "P1" ? "warn" : "good";
  return `<article class="recommendation ${tone}">
    <div class="recommendation-head"><span class="priority">${reportEsc(item.level)}</span><strong>${reportEsc(item.title)}</strong></div>
    <p><b>证据：</b>${reportEsc(item.evidence)}</p>
    <p><b>建议方向：</b>${reportEsc(item.direction)}</p>
    <p class="metric"><b>下一轮验证指标：</b>${reportEsc(item.metric)}</p>
  </article>`;
}

function buildHtmlReport(detail, evaluation, options = {}) {
  const report = detail?.report ?? {};
  const batch = report.batch ?? {};
  const runs = report.runs ?? {};
  const prompts = report.prompts ?? {};
  const citations = report.citations ?? {};
  const tracked = report.tracked ?? {};
  const sources = detail?.sources ?? { domains: [], articles: [], totals: citations };
  const metrics = evaluation?.metrics ?? {};
  const recommendations = evaluation?.recommendations ?? [];
  const caveats = evaluation?.caveats ?? [];
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const title = options.title ?? `${batch.project_name ?? "OneGl"} · 豆包可见度评估报告`;
  const subtitle =
    options.subtitle ??
    "基于真实批次运行、品牌提及与可见引用的观测性评估；用于发现方向、制定下一轮实验，不代表豆包官方评分。";

  const categories = Array.isArray(report.byCategory) ? report.byCategory : [];
  const accounts = Array.isArray(report.byAccount) ? report.byAccount : [];
  const domains = Array.isArray(sources.domains) ? sources.domains : [];
  const articles = Array.isArray(sources.articles) ? sources.articles : [];
  const failures = Array.isArray(report.failures) ? report.failures : [];
  const totalCitations = Number(citations.total ?? sources?.totals?.citations ?? 0);
  const topDomain = domains[0] ?? null;

  const categoryTable = reportRows(
    categories,
    [
      { label: "问题分类", render: (row) => reportEsc(row.category) },
      { label: "有效 Run", num: true, render: (row) => reportNum(row.validRuns) },
      { label: "提及", num: true, render: (row) => reportNum(row.mentioned) },
      {
        label: "提及率",
        render: (row) => `${reportPct(row.mentionRate)}${reportBar(row.mentionRate, Number(row.mentionRate) >= 0.5 ? "good" : "warm")}`,
      },
    ],
    "本批次没有问题分类数据。",
  );

  const domainTable = reportRows(
    domains.slice(0, 15),
    [
      { label: "域名", render: (row) => `<code>${reportEsc(row.domain ?? "—")}</code>` },
      { label: "引用", num: true, render: (row) => reportNum(row.citations) },
      { label: "文章", num: true, render: (row) => reportNum(row.articles) },
      {
        label: "引用占比",
        render: (row) => {
          const share = totalCitations ? Number(row.citations ?? 0) / totalCitations : 0;
          return `${reportPct(share)}${reportBar(share, "warm")}`;
        },
      },
    ],
    "本批次没有可见引用来源。",
  );

  const articleTable = reportRows(
    articles.slice(0, 12),
    [
      {
        label: "文章",
        render: (row) =>
          row.canonical_url
            ? `<a href="${reportEsc(row.canonical_url)}" target="_blank" rel="noreferrer">${reportEsc(row.title || row.canonical_url)}</a>`
            : reportEsc(row.title ?? "—"),
      },
      { label: "域名", render: (row) => reportEsc(row.normalized_domain ?? row.domain ?? "—") },
      { label: "引用", num: true, render: (row) => reportNum(row.citations) },
      { label: "涉及问题", num: true, render: (row) => reportNum(row.prompts ?? row.runs) },
    ],
    "本批次没有文章引用数据。",
  );

  const accountTable = reportRows(
    accounts,
    [
      { label: "账号", render: (row) => `<code>${reportEsc(row.account)}</code>` },
      { label: "有效 Run", num: true, render: (row) => reportNum(row.validRuns) },
      { label: "提及率", render: (row) => reportPct(row.mentionRate) },
      { label: "引用", num: true, render: (row) => reportNum(row.citations) },
    ],
    "当前仅有单账号或没有账号拆分数据。",
  );

  const failureTable = reportRows(
    failures,
    [
      { label: "错误码", render: (row) => `<code>${reportEsc(row.error_code)}</code>` },
      { label: "Run 数", num: true, render: (row) => reportNum(row.runs) },
    ],
    "没有失败 Run。",
  );

  const trackedTable = reportRows(
    Array.isArray(tracked.articles) ? tracked.articles.slice(0, 12) : [],
    [
      { label: "目标文章", render: (row) => reportEsc(row.title || row.canonical_url) },
      { label: "域名", render: (row) => reportEsc(row.domain ?? "—") },
      { label: "引用", num: true, render: (row) => reportNum(row.citations) },
      { label: "涉及问题", num: true, render: (row) => reportNum(row.prompts) },
    ],
    "项目未配置目标文章，或本批次没有命中目标文章。",
  );

  const reliabilityText =
    metrics.sampleConfidence === "高" || metrics.sampleConfidence === "中高"
      ? "当前样本量可用于较稳定的方向判断，但仍建议跨时间重复。"
      : "当前样本量更适合发现方向，不适合直接宣称稳定规律或因果关系。";

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${reportEsc(title)}</title>
<style>
:root{
  --bg:#F8F1E7;--paper:#FFFDFC;--paper2:#FDF6ED;--line:#E7D7C5;--line2:#D9C2AA;
  --ink:#352820;--soft:#746153;--mute:#9D8977;--terracotta:#B45A32;--terracotta2:#D47B4E;
  --amber:#C28A32;--green:#607B49;--red:#B54C3D;--blue:#5A7D80;--shadow:0 14px 35px rgba(92,60,34,.10);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif;
}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.65}
a{color:#8F4B2D;text-decoration:none}a:hover{text-decoration:underline}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
.page{max-width:1180px;margin:auto;padding:34px 24px 70px}.hero{position:relative;overflow:hidden;padding:38px;border-radius:24px;color:#FFF9F3;background:linear-gradient(135deg,#9D4327 0%,#B95B35 52%,#C98A35 100%);box-shadow:0 22px 55px rgba(125,61,31,.22)}
.hero:after{content:"";position:absolute;width:340px;height:340px;border-radius:50%;right:-130px;top:-170px;background:rgba(255,255,255,.11)}.eyebrow{font-size:11px;letter-spacing:.2em;opacity:.83}.hero h1{font-size:32px;line-height:1.25;margin:10px 0 10px}.hero p{max-width:780px;margin:0;opacity:.94}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px 26px;margin-top:28px;position:relative;z-index:1}.meta b{display:block;font-size:11px;letter-spacing:.08em;opacity:.76}.meta span{display:block;margin-top:3px;font-weight:600}
.section{margin-top:34px}.section h2{font-size:20px;margin:0 0 6px}.section .lead{color:var(--soft);margin:0 0 16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:13px}.kpi,.score,.panel,.recommendation{background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
.kpi{padding:18px}.kpi label,.score-label{display:block;color:var(--soft);font-size:12px}.kpi strong{display:block;margin-top:5px;font-size:27px;color:var(--terracotta)}.kpi small{display:block;margin-top:5px;color:var(--mute)}
.score{padding:19px}.score-value{font-size:31px;font-weight:760;margin:5px 0 3px}.score-value span{font-size:13px;color:var(--mute);font-weight:600}.score-grade{color:var(--soft);font-size:12px}.score.good .score-value{color:var(--green)}.score.warn .score-value{color:var(--amber)}.score.bad .score-value{color:var(--red)}
.mini-bar{height:6px;background:#F0E4D7;border-radius:10px;overflow:hidden;margin-top:9px}.mini-bar i{display:block;height:100%;border-radius:10px;background:var(--terracotta2)}.mini-bar i.good{background:var(--green)}.mini-bar i.warn{background:var(--amber)}.mini-bar i.bad{background:var(--red)}.mini-bar i.warm{background:var(--terracotta2)}
.panel{padding:0;overflow:hidden}.panel-head{padding:14px 18px;border-bottom:1px solid var(--line);background:var(--paper2)}.panel-head strong{font-size:14px}.panel-body{padding:18px}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:820px){.two{grid-template-columns:1fr}.hero{padding:28px}.page{padding:18px 14px 50px}}
.executive{padding:20px 22px;border-left:5px solid var(--terracotta);background:var(--paper);border-radius:14px;border-top:1px solid var(--line);border-right:1px solid var(--line);border-bottom:1px solid var(--line);box-shadow:var(--shadow)}.executive strong{color:var(--terracotta)}
.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;font-size:11.5px;letter-spacing:.04em;color:var(--soft);background:#F8EEE3;padding:9px 10px;border-bottom:1px solid var(--line2);white-space:nowrap}td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}td.num{text-align:right}tbody tr:hover{background:#FFF7EF}.empty{padding:18px;color:var(--mute);background:var(--paper2);border-radius:10px}
.recommendations{display:grid;gap:12px}.recommendation{padding:18px 19px;border-left:5px solid var(--green)}.recommendation.warn{border-left-color:var(--amber)}.recommendation.bad{border-left-color:var(--red)}.recommendation-head{display:flex;align-items:center;gap:9px}.priority{display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:24px;border-radius:99px;background:#F4E5D6;color:var(--terracotta);font-size:11px;font-weight:800}.recommendation p{margin:9px 0 0;color:var(--soft)}.recommendation .metric{color:var(--ink)}
.callout{padding:15px 17px;border-radius:13px;background:#F6E7D3;border:1px solid #E8CFB0;color:#694D35}.method{font-size:12.5px;color:var(--soft)}.method li{margin:5px 0}.footer{margin-top:38px;padding-top:15px;border-top:1px solid var(--line);color:var(--mute);font-size:12px}
@media print{body{background:white}.page{max-width:none;padding:0}.hero,.kpi,.score,.panel,.recommendation,.executive{box-shadow:none}.section{break-inside:avoid}.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body><div class="page">
<header class="hero">
  <div class="eyebrow">ONEGL · CITATION INTELLIGENCE REPORT</div>
  <h1>${reportEsc(title)}</h1>
  <p>${reportEsc(subtitle)}</p>
  <div class="meta">
    <div><b>项目</b><span>${reportEsc(batch.project_name ?? "—")}</span></div>
    <div><b>批次</b><span>#${reportNum(batch.id)} · ${reportEsc(batch.name ?? "—")}</span></div>
    <div><b>目标品牌</b><span>${reportEsc(batch.target_brand ?? "未配置")}</span></div>
    <div><b>生成时间</b><span>${reportDate(generatedAt)}</span></div>
    <div><b>实验时间</b><span>${reportDate(batch.started_at)} → ${reportDate(batch.finished_at)}</span></div>
    <div><b>抽样</b><span>${reportEsc(batch.sampling_method ?? "—")} · ${reportNum(batch.sample_size)} × ${reportNum(batch.repeats ?? 1)}</span></div>
  </div>
</header>

<section class="section">
  <h2>管理层摘要</h2>
  <p class="lead">先回答“这批数据能不能信、品牌有没有被看到、引用结构是否健康、下一步最值得做什么”。</p>
  <div class="executive">
    本批次共有 <strong>${reportNum(metrics.valid)}</strong> 个有效 Run，数据质量评分 <strong>${reportNum(metrics.dataQualityScore)}/100</strong>；
    PROMPT 级品牌提及覆盖为 <strong>${reportPct(metrics.promptCoverage)}</strong>，RUN 级提及率为 <strong>${reportPct(metrics.runMentionRate)}</strong>；
    共观察到 <strong>${reportNum(citations.total)}</strong> 条可见引用，来源结构为 <strong>${reportEsc(metrics.source?.concentrationLabel ?? "暂无数据")}</strong>。
    OneGl 内部综合准备度指数为 <strong>${reportNum(metrics.readinessIndex)}/100（${reportEsc(metrics.readinessGrade)}）</strong>。
    ${reportEsc(reliabilityText)}
  </div>
</section>

<section class="section">
  <h2>专业评分卡</h2>
  <p class="lead">这些是 OneGl 的内部评估指标，用于批次间对比和行动排序，不是豆包官方分数。</p>
  <div class="grid">
    ${reportScoreCard("数据质量", metrics.dataQualityScore, `等级 ${metrics.dataQualityGrade} · 样本信心 ${metrics.sampleConfidence}`)}
    ${reportScoreCard("品牌可见度", metrics.visibilityIndex, `等级 ${metrics.visibilityGrade} · PROMPT 覆盖 ${reportPct(metrics.promptCoverage)}`)}
    ${reportScoreCard("来源多样性", metrics.source?.diversityScore ?? 0, `${metrics.source?.concentrationLabel ?? "暂无数据"} · 有效来源数 ${reportNum(metrics.source?.effectiveDomains ?? 0, 1)}`)}
    ${reportScoreCard("综合准备度", metrics.readinessIndex, `等级 ${metrics.readinessGrade} · 用于内部批次对比`)}
  </div>
</section>

<section class="section">
  <h2>核心数据统计</h2>
  <div class="grid">
    <div class="kpi"><label>有效样本率</label><strong>${reportPct(metrics.validRate)}</strong><small>${reportNum(metrics.valid)} / ${reportNum(metrics.assignments)} Run</small></div>
    <div class="kpi"><label>PROMPT 提及覆盖</label><strong>${reportPct(metrics.promptCoverage)}</strong><small>${reportNum(prompts.mentioned)} / ${reportNum(prompts.total)} 个去重问题</small></div>
    <div class="kpi"><label>RUN 提及率</label><strong>${reportPct(metrics.runMentionRate)}</strong><small>${reportNum(runs.mentioned)} / ${reportNum(runs.valid)} 有效 Run</small></div>
    <div class="kpi"><label>可见引用</label><strong>${reportNum(citations.total)}</strong><small>${reportNum(citations.articles)} 篇文章 · ${reportNum(citations.domains)} 个域名</small></div>
    <div class="kpi"><label>平均引用密度</label><strong>${reportNum(metrics.citationDensity, 2)}</strong><small>每个有效 Run 的可见引用数</small></div>
    <div class="kpi"><label>目标文章引用率</label><strong>${reportPct(metrics.trackedRate)}</strong><small>${reportNum(tracked.cited)} / ${reportNum(tracked.total)} 篇目标文章</small></div>
    <div class="kpi"><label>Top1 来源占比</label><strong>${reportPct(metrics.source?.topDomainShare)}</strong><small>${reportEsc(topDomain?.domain ?? "暂无来源")}</small></div>
    <div class="kpi"><label>引用解析完整度</label><strong>${reportPct(metrics.citationCompleteness?.rate)}</strong><small>${reportNum(metrics.citationCompleteness?.comparableRuns)} 个可比较 Run</small></div>
  </div>
</section>

<section class="section">
  <h2>品牌可见度拆解</h2>
  <p class="lead">平均值之外，更重要的是不同问题意图与不同账号是否出现结构性差异。</p>
  <div class="two">
    <div class="panel"><div class="panel-head"><strong>按问题分类</strong></div><div class="panel-body">${categoryTable}</div></div>
    <div class="panel"><div class="panel-head"><strong>按账号</strong></div><div class="panel-body">${accountTable}</div></div>
  </div>
</section>

<section class="section">
  <h2>引用来源结构</h2>
  <p class="lead">不仅看引用总量，也看来源是否过度集中、是否形成可持续的多来源可见度。</p>
  <div class="callout">来源集中度：<b>${reportEsc(metrics.source?.concentrationLabel ?? "暂无数据")}</b>；HHI 约 <b>${reportNum(metrics.source?.hhi ?? 0, 3)}</b>；有效来源数约 <b>${reportNum(metrics.source?.effectiveDomains ?? 0, 1)}</b>。HHI 越高表示引用越集中。</div>
  <div class="two" style="margin-top:14px">
    <div class="panel"><div class="panel-head"><strong>域名分布</strong></div><div class="panel-body">${domainTable}</div></div>
    <div class="panel"><div class="panel-head"><strong>被引用最多的文章</strong></div><div class="panel-body">${articleTable}</div></div>
  </div>
</section>

<section class="section">
  <h2>目标文章表现</h2>
  <p class="lead">目标文章采用 canonical URL 精确匹配，适合评估自有内容是否真正进入最终用户可见引用层。</p>
  <div class="panel"><div class="panel-body">${trackedTable}</div></div>
</section>

<section class="section">
  <h2>专业评估与建议方向</h2>
  <p class="lead">建议按优先级执行，并在下一批固定 Prompt/种子的对照实验里验证。</p>
  <div class="recommendations">${recommendations.map(reportRecommendation).join("")}</div>
</section>

<section class="section">
  <h2>数据质量与异常</h2>
  <div class="two">
    <div class="panel"><div class="panel-head"><strong>质量口径</strong></div><div class="panel-body">
      <p>有效 Run：${reportNum(metrics.valid)} / ${reportNum(metrics.assignments)}（${reportPct(metrics.validRate)}）</p>
      <p>失败 Run：${reportNum(metrics.failed)}（${reportPct(metrics.failureRate)}）</p>
      <p>部分成功：${reportNum(metrics.partial)}（${reportPct(metrics.partialRate)}）</p>
      <p>样本信心：<b>${reportEsc(metrics.sampleConfidence)}</b></p>
    </div></div>
    <div class="panel"><div class="panel-head"><strong>失败原因</strong></div><div class="panel-body">${failureTable}</div></div>
  </div>
</section>

<section class="section">
  <h2>方法与限制</h2>
  <div class="panel"><div class="panel-body"><ul class="method">${caveats.map((item) => `<li>${reportEsc(item)}</li>`).join("")}</ul></div></div>
</section>

<footer class="footer">OneGl · Doubao Citation Intelligence · Batch #${reportNum(batch.id)} · Generated ${reportDate(generatedAt)}</footer>
</div></body></html>`;

  return html;
}

export { buildHtmlReport };

export function htmlReportBrowserBundle() {
  return [
    reportEsc,
    reportNum,
    reportPct,
    reportDate,
    reportTone,
    reportBar,
    reportRows,
    reportScoreCard,
    reportRecommendation,
    buildHtmlReport,
  ]
    .map((fn) => fn.toString())
    .join("\n");
}
