function intelEsc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function intelPct(value, digits = 1) {
  if (value == null || value === "") return "N/A";
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "N/A";
}

function intelNum(value, digits = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "N/A";
}

function intelUrl(url) {
  const value = String(url ?? "");
  if (!/^https?:\/\//i.test(value)) return intelEsc(value || "-");
  const label = value.length > 72 ? `${value.slice(0, 69)}…` : value;
  return `<a href="${intelEsc(value)}" target="_blank" rel="noreferrer">${intelEsc(label)}</a>`;
}

function pageProfiled(page) {
  return Boolean(
    page?.fetchState === "success" &&
      page?.contentProfile &&
      typeof page.contentProfile === "object" &&
      Object.keys(page.contentProfile).length > 0,
  );
}

function topSourcesHtml(rows) {
  if (!Array.isArray(rows) || !rows.length) return "无可见引用";
  return `<ol class="intel-source-list">${rows.slice(0, 5).map((row) => {
    const label = row.title || row.domain || row.url || "未知来源";
    return `<li><b>${intelEsc(label)}</b> <span class="intel-sub">×${Number(row.citations || 0)}</span><div>${intelUrl(row.url)}</div></li>`;
  }).join("")}</ol>`;
}

function profileLabel(profile) {
  const type = profile?.type ?? "未分析";
  const structure = Array.isArray(profile?.structure) && profile.structure.length
    ? profile.structure.join(" + ")
    : "无结构标签";
  return `${type} · ${structure}`;
}

function brandContextText(page) {
  const rows = Array.isArray(page?.brandContexts) ? page.brandContexts : [];
  if (!rows.length) return "未保存品牌上下文";
  return rows.slice(0, 2).map((row) => row.snippet).join(" / ");
}

function outlineText(page) {
  const rows = Array.isArray(page?.outline) ? page.outline : [];
  if (!rows.length) return "暂无标题层级";
  return rows.slice(0, 16).map((row) => `${"　".repeat(Math.max(0, Number(row.level || 1) - 1))}H${row.level} ${row.text}`).join("\n");
}

function promptListHtml(prompts) {
  if (!Array.isArray(prompts) || !prompts.length) return "";
  return `<details><summary>${prompts.length} 个涉及问题</summary><ul class="intel-prompt-list">${prompts.slice(0, 12).map((prompt) => `<li>${intelEsc(prompt)}</li>`).join("")}</ul></details>`;
}

function intelligenceJobHtml(intelligence) {
  const job = intelligence?.job;
  if (!job) return "";
  const coverage = intelligence?.coverage ?? {};
  const labels = {
    idle: job.stale ? "等待自动调度" : "尚未开始",
    queued: "已进入后台队列",
    running: "正在分析引用页",
    completed: "引用页分析完成",
    partial: "引用页分析部分完成",
    failed: "引用页分析失败",
  };
  const status = String(job.status ?? "idle");
  const tone = status === "completed" && !job.stale
    ? "good"
    : status === "failed"
      ? "bad"
      : "warn";
  const coverageText = Number(coverage.citedSources || 0) > 0
    ? `${Number(coverage.analyzedSources || 0)} / ${Number(coverage.citedSources || 0)} 个唯一引用页已形成内容画像`
    : "当前没有用户可见引用页需要分析";
  const error = job.error ? `<div class="intel-sub">${intelEsc(job.error)}</div>` : "";
  const note = ["queued", "running"].includes(status) || job.stale
    ? "后台会自动补齐；无需手工运行 source:intelligence。"
    : status === "partial"
      ? "部分第三方页面可能被 robots、登录墙、动态渲染或网络限制阻挡；已成功页面仍可用于结构与品牌证据分析。"
      : status === "failed"
        ? "AI 搜索与引用结果仍然有效；失败只影响引用页内容情报，不会改写批次结果。"
        : "";
  return `<div class="intel-job ${tone}"><b>引用页内容分析：${intelEsc(labels[status] || status)}</b><div>${intelEsc(coverageText)}</div>${error}${note ? `<div class="intel-sub">${intelEsc(note)}</div>` : ""}</div>`;
}

function queryRowsHtml(intelligence) {
  return (intelligence?.queries ?? []).map((row) => {
    const mentioned = Number(row.aiBrandMentionedRuns || 0);
    const valid = Number(row.validRuns || 0);
    const brandLabel = valid ? `${mentioned}/${valid} · ${intelPct(row.aiBrandMentionRate)}` : "N/A";
    const answer = row.exampleAnswer
      ? `<details><summary>${row.exampleAnswerContainsBrand ? "含品牌的 AI 回答片段" : "AI 回答片段"}</summary><div class="intel-excerpt">${intelEsc(row.exampleAnswer)}</div></details>`
      : "";
    return `<tr>
      <td><b>${intelEsc(row.prompt)}</b><div class="intel-sub">${intelEsc(row.category)}</div>${answer}</td>
      <td>${intelEsc(brandLabel)}</td>
      <td>${intelEsc(row.uniqueSourceCount)}</td>
      <td>${intelEsc(row.brandEvidenceSourceCount)}</td>
      <td>${topSourcesHtml(row.topSources)}</td>
    </tr>`;
  }).join("");
}

function domainRowsHtml(intelligence) {
  return (intelligence?.domains ?? []).slice(0, 20).map((row, index) => `<tr>
    <td>${index + 1}</td>
    <td><b>${intelEsc(row.domain)}</b></td>
    <td>${intelEsc(row.citations)}</td>
    <td>${intelEsc(row.sources)}</td>
    <td>${intelEsc(row.promptCount)}</td>
    <td>${intelEsc(row.brandEvidenceSources)}</td>
  </tr>`).join("");
}

function sourceRowsHtml(intelligence) {
  return (intelligence?.sources ?? []).slice(0, 30).map((row) => {
    const page = row.page ?? {};
    const profiled = pageProfiled(page);
    const brand = profiled
      ? page.brandMentioned === true
        ? `是 · ${Number(page.brandMentionCount || 0)} 次`
        : "否"
      : "N/A";
    const analyzed = profiled
      ? profileLabel(page.contentProfile)
      : page.fetchState === "success"
        ? "已抓取 · 等待内容画像"
        : `页面证据：${page.fetchState || "未采集"}`;
    const excerpt = page.contentExcerpt ? `<details><summary>文章内容摘要</summary><div class="intel-excerpt">${intelEsc(page.contentExcerpt)}</div></details>` : "";
    const outline = profiled ? `<details><summary>文章标题结构</summary><pre class="intel-outline">${intelEsc(outlineText(page))}</pre></details>` : "";
    return `<tr>
      <td><b>${intelEsc(row.title || "(无标题)")}</b><div class="intel-sub">${intelUrl(row.canonicalUrl || row.finalUrl || row.originalUrl)}</div>${excerpt}${outline}</td>
      <td>${intelEsc(row.domain || "-")}</td>
      <td>${intelEsc(row.citationCount)}</td>
      <td>${intelEsc(row.promptCount)}${promptListHtml(row.prompts)}</td>
      <td>${intelEsc(brand)}</td>
      <td>${intelEsc(analyzed)}</td>
    </tr>`;
  }).join("");
}

function brandEvidenceRowsHtml(intelligence) {
  return (intelligence?.brandEvidenceSources ?? []).map((row) => {
    const page = row.page ?? {};
    const locations = Array.isArray(page.brandLocations) && page.brandLocations.length
      ? page.brandLocations.join(", ")
      : "正文";
    return `<tr>
      <td><b>${intelEsc(row.title || "(无标题)")}</b><div class="intel-sub">${intelUrl(row.canonicalUrl || row.finalUrl || row.originalUrl)}</div></td>
      <td>${intelEsc(row.citationCount)}</td>
      <td>${intelEsc(row.promptCount)}${promptListHtml(row.prompts)}</td>
      <td>${intelEsc(Number(page.brandMentionCount || 0))}</td>
      <td>${intelEsc(locations)}</td>
      <td><div class="intel-excerpt">${intelEsc(brandContextText(page))}</div></td>
    </tr>`;
  }).join("");
}

function structureCardsHtml(intelligence) {
  const s = intelligence?.structure ?? {};
  const profileTypes = (s.profileTypes ?? []).slice(0, 5).map((row) => `${row.label} ${row.count}`).join(" · ") || "暂无";
  const structures = (s.commonStructures ?? []).slice(0, 4).map((row) => `${row.label} ${row.count}`).join(" · ") || "暂无";
  return `<div class="intel-grid">
    <div class="intel-stat"><div class="intel-label">引用页分析覆盖</div><strong>${intelPct(s.coverageRate)}</strong><div class="intel-sub">${intelEsc(s.analyzedSources || 0)} / ${intelEsc(s.citedSources || 0)} 个唯一引用页</div></div>
    <div class="intel-stat"><div class="intel-label">有 H2</div><strong>${intelPct(s.withH2Rate)}</strong><div class="intel-sub">平均 H2 ${intelNum(s.averageH2Count, 1)}</div></div>
    <div class="intel-stat"><div class="intel-label">有列表</div><strong>${intelPct(s.withListRate)}</strong><div class="intel-sub">结构元素</div></div>
    <div class="intel-stat"><div class="intel-label">有表格</div><strong>${intelPct(s.withTableRate)}</strong><div class="intel-sub">结构元素</div></div>
    <div class="intel-stat"><div class="intel-label">有 FAQ</div><strong>${intelPct(s.withFaqRate)}</strong><div class="intel-sub">标题或结构信号</div></div>
    <div class="intel-stat"><div class="intel-label">平均正文长度</div><strong>${intelNum(s.averageTextLength)}</strong><div class="intel-sub">字符，仅已形成内容画像的页面</div></div>
  </div>
  <div class="intel-note"><b>常见内容类型：</b>${intelEsc(profileTypes)}</div>
  <div class="intel-note"><b>常见结构组合：</b>${intelEsc(structures)}</div>`;
}

function intelStyles() {
  return `<style>
    .brand-source-intel{margin:18px 0}.brand-source-intel h2{margin:0 0 8px}.brand-source-intel h3{margin:22px 0 8px}
    .intel-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:12px 0}
    .intel-stat{border:1px solid rgba(120,90,70,.18);border-radius:10px;padding:12px;background:rgba(255,255,255,.45)}
    .intel-stat strong{display:block;font-size:22px;margin:3px 0}.intel-label{font-size:12px;opacity:.72}.intel-sub{font-size:12px;opacity:.7;margin-top:4px}
    .intel-note{padding:9px 12px;margin:8px 0;border-left:3px solid #b86d4a;background:rgba(184,109,74,.06);font-size:13px;line-height:1.55}
    .intel-job{padding:11px 13px;margin:10px 0 14px;border:1px solid rgba(120,90,70,.18);border-radius:10px;font-size:13px;line-height:1.55}.intel-job.good{border-left:4px solid #6e7b55}.intel-job.warn{border-left:4px solid #b78b37}.intel-job.bad{border-left:4px solid #a24d3f}
    .intel-table-wrap{overflow:auto;border:1px solid rgba(120,90,70,.15);border-radius:10px}.intel-table{width:100%;border-collapse:collapse;min-width:760px}
    .intel-table th,.intel-table td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid rgba(120,90,70,.12);font-size:13px;line-height:1.45}.intel-table th{font-size:12px;opacity:.75;background:rgba(184,109,74,.05)}
    .intel-excerpt{max-width:720px;font-size:12px;line-height:1.6;opacity:.86;margin-top:6px}.intel-outline{white-space:pre-wrap;max-width:720px;font-size:12px;line-height:1.6;background:rgba(120,90,70,.05);padding:8px;border-radius:6px}.intel-empty{padding:14px;border:1px dashed rgba(120,90,70,.25);border-radius:10px;opacity:.75}
    .intel-source-list,.intel-prompt-list{margin:5px 0;padding-left:18px}.intel-source-list li,.intel-prompt-list li{margin:4px 0}.intel-source-list a{font-size:12px}
  </style>`;
}

/** Main user-facing intelligence: query -> AI brand -> cited pages -> page content/structure -> brand evidence. */
export function brandSourceIntelligenceHtml(detail, { dashboard = false } = {}) {
  const intelligence = detail?.intelligence;
  if (!intelligence) return "";
  const queryRows = queryRowsHtml(intelligence);
  const domainRows = domainRowsHtml(intelligence);
  const sourceRows = sourceRowsHtml(intelligence);
  const brandRows = brandEvidenceRowsHtml(intelligence);
  const coverage = intelligence.coverage ?? {};
  const job = intelligence.job ?? {};
  const brandEmpty = ["queued", "running"].includes(job.status) || job.stale
    ? "引用页内容分析正在后台补齐；当前品牌证据列表仍可能变化。"
    : Number(coverage.analyzedSources || 0) === 0 && Number(coverage.citedSources || 0) > 0
      ? "当前没有成功形成内容画像的引用页，因此还不能判断引用页是否包含目标品牌。"
      : "当前已分析引用页中尚未发现目标品牌。";
  const body = `${intelStyles()}
    <div class="brand-source-intel">
      <h2>AI 搜索品牌与引用情报</h2>
      <div class="intel-note"><b>先回答四个问题：</b>当前搜索问题里 AI 有没有目标品牌？这个问题具体引用了哪些 URL？这些引用页大多是什么内容/结构？哪些引用页本身提到了目标品牌？</div>
      ${intelligenceJobHtml(intelligence)}

      <h3>1. 搜索问题 → AI 是否出现目标品牌 → 具体引用 URL</h3>
      ${queryRows ? `<div class="intel-table-wrap"><table class="intel-table"><thead><tr><th>搜索问题 / AI 回答</th><th>AI 品牌提及</th><th>唯一引用页</th><th>含品牌引用页</th><th>该问题的主要引用 URL</th></tr></thead><tbody>${queryRows}</tbody></table></div>` : `<div class="intel-empty">暂无有效搜索问题数据。</div>`}

      <h3>2. AI 的引用主要来自哪些域名与链接</h3>
      <div class="intel-note">共 ${intelEsc(coverage.citedSources || 0)} 个唯一引用页；已完成页面内容分析 ${intelEsc(coverage.analyzedSources || 0)} 个（${intelPct(coverage.analysisRate)}）。域名表回答“资料主要来自哪里”，链接表回答“具体是哪篇文章、哪些问题引用了它”。</div>
      ${domainRows ? `<div class="intel-table-wrap" style="margin-bottom:12px"><table class="intel-table"><thead><tr><th>#</th><th>域名</th><th>引用次数</th><th>唯一文章</th><th>涉及问题</th><th>含品牌文章</th></tr></thead><tbody>${domainRows}</tbody></table></div>` : ""}
      ${sourceRows ? `<div class="intel-table-wrap"><table class="intel-table"><thead><tr><th>文章 / URL / 内容</th><th>域名</th><th>引用次数</th><th>涉及问题</th><th>页面提品牌</th><th>内容结构</th></tr></thead><tbody>${sourceRows}</tbody></table></div>` : `<div class="intel-empty">暂无可见引用链接。</div>`}

      <h3>3. 被引用文章大部分是什么结构</h3>
      ${structureCardsHtml(intelligence)}

      <h3>4. 哪些被引用文章本身提到了目标品牌</h3>
      <div class="intel-note">在已分析引用页中发现 ${intelEsc(coverage.brandEvidenceSources || 0)} 个品牌证据页（${intelPct(coverage.brandEvidenceRate)}）。这表示“该引用页本身包含品牌信息”，不等于证明该 URL 是 AI 提及品牌的唯一原因。</div>
      ${brandRows ? `<div class="intel-table-wrap"><table class="intel-table"><thead><tr><th>品牌证据文章 / URL</th><th>引用次数</th><th>涉及问题</th><th>品牌出现次数</th><th>出现位置</th><th>品牌上下文</th></tr></thead><tbody>${brandRows}</tbody></table></div>` : `<div class="intel-empty">${intelEsc(brandEmpty)}</div>`}

      <div class="intel-note"><b>归因边界：</b>${intelEsc(intelligence.attributionNote || "同一回答中的引用来源与品牌提及是共同观测，不自动等同于因果归因。")}</div>
    </div>`;

  if (dashboard) {
    return `<section class="card" id="brand-source-intelligence"><div class="card-head"><strong>AI 搜索品牌与引用情报</strong><span>Query → Brand → Citation → Content</span></div><div class="card-body">${body.replace(/<h2>AI 搜索品牌与引用情报<\/h2>/, "")}</div></section>`;
  }
  return `<section class="section brand-source-intelligence">${body}</section>`;
}

export function brandSourceIntelligenceBrowserBundle() {
  return [
    intelEsc,
    intelPct,
    intelNum,
    intelUrl,
    pageProfiled,
    topSourcesHtml,
    profileLabel,
    brandContextText,
    outlineText,
    promptListHtml,
    intelligenceJobHtml,
    queryRowsHtml,
    domainRowsHtml,
    sourceRowsHtml,
    brandEvidenceRowsHtml,
    structureCardsHtml,
    intelStyles,
    brandSourceIntelligenceHtml,
  ].map((fn) => fn.toString()).join("\n");
}
