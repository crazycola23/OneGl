import { readFile, writeFile } from "node:fs/promises";

/**
 * 把 tools/export-batch.js 导出的批次快照渲染成一份自包含的 HTML 报告。
 *
 * 这里是**通用**渲染器：只依赖快照数据与一个可选的 profile。
 * 客户专属的东西（品牌叙述、行业措辞、要监控的自有域名、要强调的词、
 * 行业结论）一律不放这里，而是通过 --profile 传入外部文件，并把该文件
 * 放进 .gitignore，避免客户信息进入公开仓库。
 *
 * 用法：
 *   node tools/build-report-html.js <快照.json> <输出.html> [--profile <profile.json>]
 *
 * 输出不依赖任何 CDN 与外部字体：客户直接双击打开就能看，也可以离线存档。
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

const snapshot = JSON.parse(await readFile(inputFile, "utf8"));
const { report, runs, citations, domains } = snapshot;

/** 客户/项目专属的呈现选项。全部可省略，省略时报告依然完整可读。 */
const profile = {
  title: null,
  subtitle: null,
  // 哪个分类代表「问题里直接点名品牌」。没配置就不做直问/拓词的对照。
  directCategory: null,
  // 需要单独标注的自有域名（数据驱动，不在代码里写死任何域名）。
  ownDomains: [],
  // 需要高亮的关键词（通用渲染器不预设任何行业词）。
  highlightTerms: [],
  // 额外的结论条目，属于客户语境，由 profile 提供。
  notes: [],
  ...(profileFile ? JSON.parse(await readFile(profileFile, "utf8")) : {}),
};

// The snapshot is embedded into a <script> block, so any literal "</script>" (or "<!--")
// inside a captured answer would terminate the block early. Escaping "<" as \u003c is
// still valid JSON and keeps the payload from breaking out of the tag.
const embeddedData = JSON.stringify(snapshot).replace(/</g, "\\u003c");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${report.batch.project_name} · 豆包可见度监测报告</title>
<style>
  :root {
    /* 暖色调：赭石 / 陶土 / 琥珀金 + 米白底 */
    --bg:            #FBF6F0;
    --surface:       #FFFFFF;
    --surface-alt:   #F7EEE4;
    --surface-warm:  #FDF3E9;
    --border:        #EADFD2;
    --border-strong: #DCCBB8;

    --ink:           #2E2620;
    --ink-soft:      #6B5B4E;
    --ink-mute:      #9C8977;

    --primary:       #A8471F;
    --primary-soft:  #C9754A;
    --primary-pale:  #F2DCCE;
    --accent:        #B8862B;
    --accent-pale:   #F5E7C9;

    --good:          #5F7F3F;
    --good-pale:     #E4ECDA;
    --bad:           #B23A2E;
    --bad-pale:      #F6DED9;

    --radius:        14px;
    --radius-sm:     9px;
    --shadow:        0 1px 2px rgba(70, 45, 25, .05), 0 8px 24px -12px rgba(70, 45, 25, .18);
    --font: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC",
            "Noto Sans CJK SC", system-ui, -apple-system, "Segoe UI", sans-serif;
  }

  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font);
    font-size: 15px;
    line-height: 1.65;
    font-variant-numeric: tabular-nums;
  }

  .page { max-width: 1140px; margin: 0 auto; padding: 40px 28px 72px; }

  /* ---------------------------------------------------------------- header */
  .masthead {
    background: linear-gradient(135deg, #A8471F 0%, #C0653A 52%, #C2892E 100%);
    border-radius: 20px;
    padding: 38px 40px 34px;
    color: #FFF6EE;
    box-shadow: 0 18px 40px -20px rgba(120, 60, 25, .55);
    position: relative;
    overflow: hidden;
  }
  .masthead::after {
    content: "";
    position: absolute; right: -70px; top: -90px;
    width: 300px; height: 300px; border-radius: 50%;
    background: rgba(255, 255, 255, .10);
  }
  .masthead .eyebrow {
    font-size: 12.5px; letter-spacing: .22em; text-transform: uppercase;
    opacity: .88; margin: 0 0 12px;
  }
  .masthead h1 { margin: 0; font-size: 33px; line-height: 1.25; font-weight: 700; letter-spacing: .01em; }
  .masthead .subtitle { margin: 12px 0 0; font-size: 15px; opacity: .93; max-width: 62ch; }
  .meta-grid {
    margin-top: 26px; display: grid; gap: 10px 30px;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    position: relative; z-index: 1;
  }
  .meta-item .k { font-size: 11.5px; letter-spacing: .12em; opacity: .8; text-transform: uppercase; }
  .meta-item .v { font-size: 14.5px; font-weight: 600; margin-top: 1px; word-break: break-all; }

  /* ------------------------------------------------------------ typography */
  h2.section {
    font-size: 20px; margin: 46px 0 6px; font-weight: 700; letter-spacing: .01em;
    display: flex; align-items: center; gap: 11px;
  }
  h2.section::before {
    content: ""; width: 4px; height: 19px; border-radius: 3px;
    background: linear-gradient(180deg, var(--primary), var(--accent));
    flex: none;
  }
  .section-note { color: var(--ink-soft); font-size: 13.5px; margin: 0 0 18px 15px; }

  /* ------------------------------------------------------------ stat cards */
  .kpi-row {
    display: grid; gap: 14px; margin-top: 20px;
    grid-template-columns: repeat(auto-fit, minmax(178px, 1fr));
  }
  .kpi {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px 18px 16px; box-shadow: var(--shadow);
  }
  .kpi .label { font-size: 12.5px; color: var(--ink-soft); margin-bottom: 8px; }
  .kpi .value { font-size: 30px; font-weight: 700; line-height: 1.05; color: var(--primary); letter-spacing: -.01em; }
  .kpi .value .unit { font-size: 15px; font-weight: 600; margin-left: 2px; color: var(--ink-soft); }
  .kpi .foot { font-size: 12.5px; color: var(--ink-mute); margin-top: 7px; }
  .kpi.is-accent .value { color: var(--accent); }
  .kpi.is-good   .value { color: var(--good); }
  .kpi.is-bad    .value { color: var(--bad); }

  /* --------------------------------------------------------------- verdict */
  .verdict {
    margin-top: 22px; background: var(--surface); border: 1px solid var(--border);
    border-left: 5px solid var(--primary); border-radius: var(--radius);
    padding: 24px 26px; box-shadow: var(--shadow);
  }
  .verdict h3 { margin: 0 0 12px; font-size: 17px; }
  .verdict ol { margin: 0; padding-left: 22px; }
  .verdict li { margin-bottom: 11px; }
  .verdict li:last-child { margin-bottom: 0; }
  .verdict strong { color: var(--primary); }
  .hl-good { color: var(--good); font-weight: 600; }
  .hl-bad  { color: var(--bad);  font-weight: 600; }

  /* ---------------------------------------------------------------- charts */
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 22px 24px; box-shadow: var(--shadow);
  }
  .chart-grid { display: grid; gap: 16px; margin-top: 20px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 880px) { .chart-grid { grid-template-columns: 1fr; } }

  .card h3 { margin: 0 0 3px; font-size: 15.5px; font-weight: 700; }
  .card .hint { margin: 0 0 18px; font-size: 12.5px; color: var(--ink-mute); }

  .bar-row { display: grid; grid-template-columns: 108px 1fr 62px; align-items: center; gap: 11px; margin-bottom: 11px; }
  .bar-row .name { font-size: 13.5px; color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { height: 22px; background: var(--surface-alt); border-radius: 6px; overflow: hidden; }
  .bar-fill {
    height: 100%; border-radius: 6px; min-width: 2px;
    transition: width .5s cubic-bezier(.22,1,.36,1);
  }
  .bar-row .val { text-align: right; font-size: 13.5px; font-weight: 700; color: var(--ink); }

  /* 两栏对照 */
  .compare { display: grid; gap: 14px; grid-template-columns: 1fr 1fr; margin-top: 4px; }
  @media (max-width: 620px) { .compare { grid-template-columns: 1fr; } }
  .compare .side { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 16px 17px; background: var(--surface-alt); }
  .compare .side .cap { font-size: 13px; color: var(--ink-soft); }
  .compare .side .big { font-size: 34px; font-weight: 700; line-height: 1.1; margin: 6px 0 2px; }
  .compare .side .sub { font-size: 12.5px; color: var(--ink-mute); }
  .compare .side.good { background: var(--good-pale); border-color: #CDDCBB; }
  .compare .side.good .big { color: var(--good); }
  .compare .side.bad  { background: var(--bad-pale); border-color: #EBC7BF; }
  .compare .side.bad .big { color: var(--bad); }

  /* ---------------------------------------------------------------- tables */
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  thead th {
    text-align: left; font-weight: 600; color: var(--ink-soft); font-size: 12.5px;
    padding: 9px 10px; border-bottom: 1px solid var(--border-strong); white-space: nowrap;
    background: var(--surface-alt);
  }
  thead th:first-child { border-top-left-radius: 8px; }
  thead th:last-child  { border-top-right-radius: 8px; }
  tbody td { padding: 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:hover { background: var(--surface-warm); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tag {
    display: inline-block; padding: 1px 9px; border-radius: 99px;
    font-size: 12px; font-weight: 600; white-space: nowrap; line-height: 1.7;
  }
  .tag.yes  { background: var(--good-pale); color: #43602B; }
  .tag.no   { background: var(--surface-alt); color: var(--ink-soft); }
  .tag.warm { background: var(--accent-pale); color: #8A6314; }
  .tag.bad  { background: var(--bad-pale); color: #8C2A20; }
  .mono { font-variant-numeric: tabular-nums; }

  /* --------------------------------------------------------------- quotes */
  .quote {
    background: var(--surface-warm); border: 1px solid var(--border);
    border-left: 4px solid var(--accent); border-radius: var(--radius-sm);
    padding: 16px 18px; margin-top: 14px;
  }
  .quote .q-head { font-size: 13px; color: var(--ink-soft); margin-bottom: 8px; }
  .quote .q-text { font-size: 14px; color: var(--ink); white-space: pre-wrap; }
  mark {
    background: #F6E0A8; color: #6B4A05; padding: 0 3px; border-radius: 3px; font-weight: 600;
  }

  .callout {
    margin-top: 18px; padding: 16px 18px; border-radius: var(--radius-sm);
    background: var(--accent-pale); border: 1px solid #E8D3A4; font-size: 13.5px;
  }
  .callout .t { font-weight: 700; margin-bottom: 5px; color: #7A5710; }

  ul.plain { margin: 8px 0 0; padding-left: 20px; }
  ul.plain li { margin-bottom: 6px; }

  footer.report-foot {
    margin-top: 46px; padding-top: 18px; border-top: 1px solid var(--border);
    font-size: 12.5px; color: var(--ink-mute);
    display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  }

  @media print {
    body { background: #fff; }
    .page { max-width: none; padding: 0; }
    .masthead { box-shadow: none; }
    .card, .kpi, .verdict { box-shadow: none; break-inside: avoid; }
    h2.section { break-after: avoid; }
  }
</style>
</head>
<body>
<div class="page">

  <header class="masthead">
    <p class="eyebrow">AI Visibility Report · Doubao</p>
    <h1 id="coverTitle"></h1>
    <p class="subtitle" id="coverSubtitle"></p>
    <div class="meta-grid" id="coverMeta"></div>
  </header>

  <h2 class="section">核心结论</h2>
  <p class="section-note">以下结论全部来自本轮真实提问与豆包可见引用，未做推断性补全。</p>
  <div class="verdict" id="verdict"></div>

  <h2 class="section">关键指标</h2>
  <p class="section-note">RUN 级与 PROMPT 级提及率分开计算：前者统计回答次数，后者统计不同问题，避免某一问题被重复提问后拉偏整体结果。</p>
  <div class="kpi-row" id="kpiRow"></div>

  <div id="compareSection">
    <h2 class="section" id="compareTitle">提及率的结构性落差</h2>
    <p class="section-note" id="compareNote"></p>
    <div class="card">
      <h3 id="compareHead"></h3>
      <p class="hint" id="compareHint"></p>
      <div class="compare" id="compareBox"></div>
      <div id="compareFallback"></div>
    </div>
  </div>

  <div class="chart-grid">
    <div class="card">
      <h3>各问题类型的提及率</h3>
      <p class="hint">按问题池分类拆分，右侧数字为「提到品牌的有效回答 / 该分类有效回答」。</p>
      <div id="categoryChart"></div>
    </div>
    <div class="card">
      <h3>豆包实际引用的来源</h3>
      <p class="hint">本轮全部可见引用按域名聚合，括号内为该域名被引用的文章数。</p>
      <div id="domainChart"></div>
    </div>
  </div>

  <h2 class="section">引用抓取完整度</h2>
  <p class="section-note">豆包界面标注的来源条数（expected）与实际成功解析的条数（captured）。差额原因见下方口径说明。</p>
  <div class="card"><div id="captureChart"></div></div>

  <h2 class="section">逐题明细</h2>
  <p class="section-note">共 ${runs.length} 条提问，按抽样顺序排列。</p>
  <div class="card" style="padding:8px 6px 6px">
    <table id="runsTable"><thead><tr>
      <th>#</th><th>问题</th><th>类型</th><th>状态</th><th>品牌提及</th>
      <th class="num">提及次数</th><th class="num">引用</th>
    </tr></thead><tbody id="runsBody"></tbody></table>
  </div>

  <div id="quotesSection">
    <h2 class="section">点名提问的回答摘录</h2>
    <p class="section-note">问题里直接出现品牌名时，豆包给出的原始表述。这里只做忠实摘录，便于人工核对表述方向。</p>
    <div id="quotes"></div>
  </div>

  <h2 class="section">方法与口径</h2>
  <div class="card">
    <ul class="plain" id="methodList"></ul>
  </div>

  <footer class="report-foot">
    <span>报告生成时间：<span id="generatedAt"></span></span>
    <span>抽样批次 #${report.batch.id} · 种子 ${report.batch.sampling_seed}</span>
  </footer>
</div>

<script>
const DATA = ${embeddedData};
/* 客户/项目专属的呈现选项；通用渲染器只在有配置时才启用对应区块。 */
const PROFILE = ${JSON.stringify(profile).replace(/</g, "\\u003c")};

/* ------------------------------------------------------------------ 常量 */
const PALETTE = ["#A8471F", "#C0653A", "#C2892E", "#D9A85C", "#8C7A5B",
                 "#B98A6E", "#9C8977", "#CBB49A"];
const COLORS = { primary: "#A8471F", primarySoft: "#C9754A", accent: "#B8862B",
                 good: "#5F7F3F", bad: "#B23A2E", track: "#F1E7DC", muted: "#C4AE99" };

const runs = DATA.runs;
const report = DATA.report;
const pct = (n, d) => (d ? (n / d * 100).toFixed(1) + "%" : "—");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";

/* --------------------------------------------------------------- 数据派生 */
const VALID = new Set(["success", "partial"]);
const validRuns = runs.filter((r) => VALID.has(r.status) && r.conversation_reset_confirmed === true);
const directCategory = PROFILE.directCategory || null;
const direct = directCategory ? validRuns.filter((r) => r.category === directCategory) : [];
const indirect = directCategory ? validRuns.filter((r) => r.category !== directCategory) : [];
const mentionedIn = (list) => list.filter((r) => r.brand_mentioned === true).length;

const ownDomains = (PROFILE.ownDomains || []).map((d) => String(d).toLowerCase());
const ownDomainRows = DATA.domains.filter((d) => ownDomains.includes(String(d.domain).toLowerCase()));
const ownCitations = (PROFILE.ownDomains || []).length
  ? DATA.citations.filter((c) => ownDomains.includes(String(c.domain).toLowerCase()))
  : [];
const ownRuns = new Set(ownCitations.map((c) => c.run_id)).size;

const withExpectation = validRuns.filter((r) => r.expected_citation_count != null);
const completeRuns = withExpectation.filter(
  (r) => r.captured_citation_count >= r.expected_citation_count);
const gapTotal = withExpectation.reduce((sum, r) =>
  Math.max(0, r.expected_citation_count - r.captured_citation_count), 0);

/* ------------------------------------------------------------------ 封面 */
document.getElementById("coverTitle").textContent =
  PROFILE.title || (report.batch.project_name + " · 豆包可见度监测报告");
document.getElementById("coverSubtitle").textContent =
  PROFILE.subtitle ||
  "通过关键词池随机抽样，在独立新会话中向豆包提问，统计目标品牌在 AI 回答中的提及率，"
  + "以及相关内容进入豆包可见引用来源的情况。";
document.getElementById("coverMeta").innerHTML = [
  ["监测品牌", report.batch.target_brand ?? report.batch.project_name],
  ["观测平台", "豆包 Web（" + report.batch.provider + "）"],
  ["本批次提问", report.batch.sample_size + " 条（问题池 " + report.batch.pool_size + " 条）"],
  ["抽样方式", report.batch.sampling_method === "stratified" ? "分层随机抽样" : "纯随机抽样"],
  ["执行时间", fmtTime(report.batch.started_at)],
  ["账号", (report.batch.account_keys || []).join("、") || "—"],
].map(([k, v]) => \`<div class="meta-item"><div class="k">\${esc(k)}</div><div class="v">\${esc(v)}</div></div>\`).join("");

/* ------------------------------------------------------------------ 结论 */
(function renderVerdict() {
  const items = [];

  if (directCategory && direct.length) {
    items.push(
      \`被点名问到时，豆包 <span class="hl-good">\${mentionedIn(direct)}/\${direct.length} 次给出了这个品牌</span>\` +
      \`（提及率 \${pct(mentionedIn(direct), direct.length)}）。\`
    );
    items.push(
      \`在场景化提问下，豆包 <span class="hl-bad">\${mentionedIn(indirect)}/\${indirect.length} 次主动提到该品牌</span>\` +
      \`（提及率 \${pct(mentionedIn(indirect), indirect.length)}）。两者相差 \` +
      \`<strong>\${(pct(mentionedIn(direct), direct.length) === "—" ? "—" : (mentionedIn(direct) / direct.length * 100 - (indirect.length ? mentionedIn(indirect) / indirect.length * 100 : 0)).toFixed(1) + " 个百分点")}</strong>。\`
    );
  } else {
    items.push(
      \`本轮有效回答 \${validRuns.length} 条，其中 <strong>\${report.runs.mentioned} 条</strong>提到目标品牌\` +
      \`（RUN 级提及率 \${pct(report.runs.mentioned, report.runs.valid)}，PROMPT 级 \${pct(report.prompts.mentioned, report.prompts.total)}）。\`
    );
    items.push(
      "本报告的 profile 未定义「点名提问」分类，因此没有做点名与场景提问的对照拆分。"
    );
  }

  if (withExpectation.length) {
    items.push(
      \`引用抓取：\${withExpectation.length} 条带引用标注的回答中 \${completeRuns.length} 条完全抓齐\` +
      \`（合计差额 \${gapTotal} 条）。引用来源统计因此按保守口径呈现，详见「方法与口径」。\`
    );
  }

  (PROFILE.notes || []).forEach((note) => items.push(note));

  document.getElementById("verdict").innerHTML =
    \`<h3>一句话总结</h3><ol>\${items.map((i) => \`<li>\${i}</li>\`).join("")}</ol>\`;
})();

/* ------------------------------------------------------------------- KPI */
const kpis = [
  { label: "有效回答数", value: validRuns.length, unit: "/ " + report.batch.sample_size, foot: "已确认独立新会话", cls: "" },
  { label: "RUN 级提及率", value: pct(report.runs.mentioned, report.runs.valid), unit: "", foot: report.runs.mentioned + " / " + report.runs.valid + " 次回答提及", cls: "is-accent" },
  { label: "PROMPT 级覆盖", value: pct(report.prompts.mentioned, report.prompts.total), unit: "", foot: report.prompts.mentioned + " / " + report.prompts.total + " 个去重问题", cls: "" },
  { label: "可见引用总数", value: report.citations.total, unit: "条", foot: "来自 " + report.citations.domains + " 个域名", cls: "" },
  { label: "唯一被引文章", value: report.citations.articles, unit: "篇", foot: "去重后", cls: "" },
];
if (directCategory && direct.length) {
  kpis.splice(2, 0,
    { label: "点名提问提及率", value: pct(mentionedIn(direct), direct.length), unit: "", foot: mentionedIn(direct) + " / " + direct.length + " 条", cls: "is-good" },
    { label: "场景提问提及率", value: pct(mentionedIn(indirect), indirect.length), unit: "", foot: mentionedIn(indirect) + " / " + indirect.length + " 条", cls: "is-bad" });
}
document.getElementById("kpiRow").innerHTML = kpis.map((k) => \`
  <div class="kpi \${k.cls}">
    <div class="label">\${esc(k.label)}</div>
    <div class="value">\${esc(k.value)}\${k.unit ? \`<span class="unit">\${esc(k.unit)}</span>\` : ""}</div>
    <div class="foot">\${esc(k.foot)}</div>
  </div>\`).join("");

/* -------------------------------------------------------- 点名 vs 场景 */
(function renderCompare() {
  if (!directCategory || !direct.length) {
    document.getElementById("compareTitle").textContent = "点名提问与场景提问的对照";
    document.getElementById("compareNote").textContent =
      "该对照需要 profile 指定「点名提问」对应的分类后才能计算。";
    document.getElementById("compareHead").textContent = "未配置对照分类";
    document.getElementById("compareHint").textContent = "";
    document.getElementById("compareBox").innerHTML = "";
    document.getElementById("compareFallback").innerHTML =
      \`<div class="callout"><div class="t">如何启用</div>
        在报告 profile 里设置 <code>directCategory</code> 为问题池中代表「问题里直接出现品牌名」的分类名称。
        通用渲染器不预设任何分类名。</div>\`;
    return;
  }

  document.getElementById("compareNote").textContent =
    \`点名提问＝问题里直接出现品牌名（分类「\${directCategory}」）；场景提问＝其余用户按需求提问的情况，衡量品牌是否被主动推荐。\`;
  document.getElementById("compareHead").textContent =
    \`\${directCategory} vs 场景提问\`;
  document.getElementById("compareHint").textContent =
    "两侧都是已确认独立新会话的有效回答。";

  document.getElementById("compareBox").innerHTML = \`
    <div class="side good">
      <div class="cap">点名提问（\${esc(directCategory)}）</div>
      <div class="big">\${pct(mentionedIn(direct), direct.length)}</div>
      <div class="sub">\${mentionedIn(direct)} / \${direct.length} 条回答提及品牌</div>
    </div>
    <div class="side bad">
      <div class="cap">场景提问（其余分类）</div>
      <div class="big">\${pct(mentionedIn(indirect), indirect.length)}</div>
      <div class="sub">\${mentionedIn(indirect)} / \${indirect.length} 条回答提及品牌</div>
    </div>\`;
})();

/* ----------------------------------------------------- 分类提及率柱状图 */
(function renderCategory() {
  const rows = [...report.byCategory].sort((a, b) => b.mentionRate - a.mentionRate);
  document.getElementById("categoryChart").innerHTML = rows.map((r) => {
    const p = r.mentionRate * 100;
    const color = p >= 50 ? COLORS.good : p > 0 ? COLORS.accent : COLORS.muted;
    return \`<div class="bar-row">
      <div class="name" title="\${esc(r.category)}">\${esc(r.category)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:\${Math.max(p, 1.5)}%;background:\${color}"></div></div>
      <div class="val">\${r.mentioned}/\${r.validRuns}</div>
    </div>\`;
  }).join("");
})();

/* --------------------------------------------------------- 域名引用柱状 */
(function renderDomains() {
  const top = DATA.domains.slice(0, 10);
  const max = Math.max(...top.map((d) => Number(d.citations)), 1);
  document.getElementById("domainChart").innerHTML = top.map((d, i) => \`
    <div class="bar-row">
      <div class="name" title="\${esc(d.domain)}">\${esc(d.domain)}</div>
      <div class="bar-track"><div class="bar-fill"
        style="width:\${(Number(d.citations) / max) * 100}%;background:\${PALETTE[i % PALETTE.length]}"></div></div>
      <div class="val">\${d.citations}<span style="color:var(--ink-mute);font-weight:500"> (\${d.articles})</span></div>
    </div>\`).join("");
})();

/* ----------------------------------------------------------- 抓取完整度 */
(function renderCapture() {
  const rows = withExpectation
    .slice()
    .sort((a, b) => a.selection_index - b.selection_index);
  const max = Math.max(...rows.map((r) => r.expected_citation_count), 1);
  const head = \`<div style="display:flex;gap:20px;font-size:12.5px;color:var(--ink-mute);margin-bottom:14px">
      <span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:\${COLORS.primarySoft};margin-right:6px"></i>成功解析</span>
      <span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:\${COLORS.track};margin-right:6px"></i>界面标注（差额部分）</span>
    </div>\`;
  const bars = rows.map((r) => {
    const exp = r.expected_citation_count, cap = r.captured_citation_count;
    const capW = (cap / max) * 100, expW = (exp / max) * 100;
    const full = cap >= exp;
    return \`<div class="bar-row" style="grid-template-columns:1fr 100px">
      <div>
        <div class="name" style="max-width:none;color:var(--ink-soft);font-size:12.5px;margin-bottom:3px">
          #\${r.selection_index} \${esc(r.prompt)}
        </div>
        <div class="bar-track" style="position:relative">
          <div style="position:absolute;inset:0;width:\${expW}%;background:\${COLORS.track};border-radius:6px"></div>
          <div style="position:relative;height:100%;width:\${capW}%;background:\${full ? COLORS.good : COLORS.primarySoft};border-radius:6px"></div>
        </div>
      </div>
      <div class="val">\${cap} / \${exp}</div>
    </div>\`;
  }).join("");

  document.getElementById("captureChart").innerHTML = head + bars +
    \`<div class="callout">
      <div class="t">口径说明（差额原因未确认）</div>
      本批次 \${withExpectation.length} 条有引用标注的回答中，\${completeRuns.length} 条与界面标注数量一致，
      合计差额 \${gapTotal} 条。页面标注的引用数量高于成功解析数量，
      <strong>可能来自折叠展示、DOM 结构变化或解析未覆盖</strong>；
      本轮未对差额成因做验证，因此引用来源统计按保守口径展示——
      实际可见来源可能多于本报告，本报告不据此推断任何来源未被引用。
    </div>\`;
})();

/* ------------------------------------------------------------- 明细表 */
document.getElementById("runsBody").innerHTML = runs.map((r) => {
  const valid = VALID.has(r.status) && r.conversation_reset_confirmed === true;
  const mention = r.brand_mentioned === true
    ? '<span class="tag yes">提及</span>'
    : r.brand_mentioned === false ? '<span class="tag no">未提及</span>'
    : '<span class="tag no">未判定</span>';
  const status = !valid
    ? \`<span class="tag bad">\${esc(r.error_code ?? "失败")}</span>\`
    : r.status === "partial" ? '<span class="tag warm">部分成功</span>'
    : '<span class="tag yes">成功</span>';
  return \`<tr>
    <td class="num mono">\${r.selection_index}</td>
    <td>\${esc(r.prompt)}</td>
    <td>\${esc(r.category)}</td>
    <td>\${status}</td>
    <td>\${mention}</td>
    <td class="num mono">\${r.mention_count ?? "—"}</td>
    <td class="num mono">\${r.captured_citation_count ?? 0}\${r.expected_citation_count != null ? \`<span style="color:var(--ink-mute)">/\${r.expected_citation_count}</span>\` : ""}</td>
  </tr>\`;
}).join("");

/* ----------------------------------------------------------- 原话摘录 */
(function renderQuotes() {
  if (!directCategory) {
    document.getElementById("quotesSection").style.display = "none";
    return;
  }
  const terms = PROFILE.highlightTerms || [];
  const quoteRuns = runs.filter((r) => r.category === directCategory && r.answer_excerpt);
  document.getElementById("quotes").innerHTML = quoteRuns.map((r) => {
    let text = esc(r.answer_excerpt);
    for (const term of terms) {
      if (!term) continue;
      text = text.replaceAll(esc(term), \`<mark>\${esc(term)}</mark>\`);
    }
    return \`<div class="quote">
      <div class="q-head">
        <strong>#\${r.selection_index} 提问：</strong>\${esc(r.prompt)}
        <span style="color:var(--ink-mute)"> · \${fmtTime(r.finished_at)} · 引用 \${r.captured_citation_count} 条</span>
      </div>
      <div class="q-text">\${text}\${r.answer_excerpt.length >= 900 ? "……" : ""}</div>
    </div>\`;
  }).join("");
})();

/* --------------------------------------------------------------- 方法 */
(function renderMethod() {
  const ownDomainText = ownDomainRows.length
    ? \`<strong>指定自有域名</strong>：\${ownDomainRows.map((d) => esc(d.domain) + "（被引用 " + d.citations + " 次，涉及 " +
        DATA.citations.filter((c) => c.domain === d.domain).length + " 条引用）").join("、")}。\`
    : "";

  const items = [
    \`<strong>数据来源</strong>：通过 Camoufox 驱动的真实浏览器访问豆包 Web，使用已登录账号，\${validRuns.length} 条提问均在<strong>独立新建会话</strong>中完成（会话重置已逐条确认），不使用历史上下文，保证测的是 P(提及品牌 | 该问题) 而非 P(提及品牌 | 问题＋历史对话)。无法确认新会话时该条提问不会被执行，直接记为失败。\`,
    \`<strong>抽样可复现</strong>：问题池 \${report.batch.pool_size} 条，分层随机抽取 \${report.batch.sample_size} 条，随机种子 <code>\${esc(report.batch.sampling_seed)}</code>，池版本 \${esc(report.batch.pool_version)}。同一命令可复现同一批问题。\`,
    \`<strong>提及判定</strong>：规则匹配（品牌全称与别名），保留原始回答供人工复核；重叠匹配保留最长项。规则版本 rules-v1。\`,
    \`<strong>两类提及率</strong>：RUN 级＝提及的回答数 ÷ 有效回答数；PROMPT 级＝提到品牌的去重问题数 ÷ 总问题数。两者不合并成单一分数。\`,
    \`<strong>引用口径</strong>：统计的是「豆包最终回答里对用户可见的引用来源」，即 AI Citation Inclusion，不等同于搜索引擎收录或训练数据收录。\`,
    \`<strong>有效样本</strong>：\${report.runs.failed} 条未完成（\${(report.failures || []).map((f) => f.error_code).join("、") || "—"}），不计入统计；\${report.runs.partial} 条「部分成功」指回答完整但引用数未能与界面标注对齐，其回答仍然完整有效，因此计入提及率。\`,
    ownDomainText,
  ].filter(Boolean);

  document.getElementById("methodList").innerHTML = items.map((item) => \`<li>\${item}</li>\`).join("");
})();

document.getElementById("generatedAt").textContent =
  new Date().toLocaleString("zh-CN", { hour12: false });
</script>
</body>
</html>
`;

await writeFile(outputFile, html, "utf8");
console.log(`已生成 ${outputFile}（${(html.length / 1024).toFixed(0)} KB）`);
