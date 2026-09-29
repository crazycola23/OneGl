import { footerText, normalizeTheme, themeCss } from "./report-theme.js";

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll("\"", "&quot;")
  .replaceAll("'", "&#39;");

function safeUrl(value) {
  try {
    const parsed = new URL(String(value));
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

const numberText = (value) => value == null ? "N/A" : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 1 });
const percentage = (value) => value == null ? "N/A" : (Number(value) * 100).toFixed(1) + "%";
const deltaText = (value) => value == null ? "N/A" : (value > 0 ? "+" : "") + Number(value).toFixed(1) + " 个百分点";

function sourceLink(url, label) {
  const href = safeUrl(url);
  if (!href) return escapeHtml(label || url || "—");
  return "<a href=\"" + escapeHtml(href) + "\" target=\"_blank\" rel=\"noopener noreferrer\">" +
    escapeHtml(label || url) + "</a>";
}

function table(headers, rows, emptyText = "当前范围没有可展示的数据") {
  const head = "<thead><tr>" + headers.map((item) => "<th>" + escapeHtml(item) + "</th>").join("") + "</tr></thead>";
  const body = rows.length
    ? rows.map((row) => "<tr>" + row.map((cell) => "<td>" + cell + "</td>").join("") + "</tr>").join("")
    : "<tr><td colspan=\"" + headers.length + "\" class=\"muted\">" + escapeHtml(emptyText) + "</td></tr>";
  return "<div class=\"table-wrap\"><table>" + head + "<tbody>" + body + "</tbody></table></div>";
}

function note(sample, selection, implication) {
  return "<p class=\"methodology\"><strong>数据量：</strong>" + escapeHtml(sample) +
    "。<strong>选取规则：</strong>" + escapeHtml(selection) +
    "。<strong>可执行含义：</strong>" + escapeHtml(implication) + "</p>";
}

function platformClass(platform, payload) {
  const index = payload.scope.platforms.indexOf(platform);
  return "p" + Math.max(0, index);
}

function platformTag(platform, payload) {
  return "<span class=\"tag platform " + platformClass(platform, payload) + "\">" + escapeHtml(platform) + "</span>";
}

function allRows(payload) {
  const rows = [];
  for (const period of payload.periods) {
    for (const platform of period.platforms) rows.push({ period, platform });
  }
  return rows;
}

function overviewSection(payload, rows) {
  const reportTimeZone = payload.scope.periods[0]?.time_zone || "Asia/Shanghai";
  const totalRuns = rows.reduce((sum, row) => sum + row.platform.runs.valid_runs, 0);
  const totalAssignments = rows.reduce((sum, row) => sum + row.platform.runs.assignments, 0);
  const totalSources = rows.reduce((sum, row) => sum + row.platform.citations.content_citations, 0);
  const cards = [
    ["阶段", numberText(payload.periods.length)],
    ["平台", numberText(payload.scope.platforms.length)],
    ["分配样本", numberText(totalAssignments)],
    ["有效回答", numberText(totalRuns)],
    ["可见内容引用", numberText(totalSources)],
    ["目标内容配置", payload.target.tracked_articles_configured ? numberText(payload.target.tracked_articles_count) + " 篇" : "未配置"],
  ].map(([label, value]) => "<div class=\"card\"><div class=\"muted\">" + escapeHtml(label) +
    "</div><strong class=\"num\">" + escapeHtml(value) + "</strong></div>").join("");
  const summaryRows = rows.map(({ period, platform }) => [
    escapeHtml(period.label),
    platformTag(platform.platform, payload),
    "<span class=\"num\">" + numberText(platform.runs.assignments) + "</span>",
    "<span class=\"num\">" + numberText(platform.runs.valid_runs) + "</span>",
    "<span class=\"num\">" + percentage(platform.runs.success_rate) + "</span>",
    "<span class=\"num\">" + numberText(platform.runs.partial_runs) + "</span>",
    "<span class=\"num\">" + numberText(platform.runs.failed_runs) + "</span>",
    "<span class=\"num\">" + numberText(platform.runs.average_answer_characters) + "</span>",
    "<span class=\"num\">" + (platform.runs.brand_mention_rate == null
      ? "N/A" : percentage(platform.runs.brand_mention_rate) + " (" + numberText(platform.runs.brand_mentioned_runs) + ")") + "</span>",
    "<span class=\"num\">" + numberText(platform.citations.citation_valid_runs) + "</span>",
    "<span class=\"num\">" + numberText(platform.citations.visible_citations) + "</span>",
  ]);
  return "<section id=\"sec-01\"><h2>1. 执行概览</h2>" +
    "<p>目标：" + escapeHtml(payload.target.name) + (payload.target.brand ? " · 品牌：" + escapeHtml(payload.target.brand) : " · 品牌未配置") +
    "。报告生成于 " + escapeHtml(new Date(payload.generated_at).toLocaleString("zh-CN", { timeZone: reportTimeZone })) +
    "（" + escapeHtml(reportTimeZone) + "）。</p>" +
    "<div class=\"grid cards\">" + cards + "</div>" +
    // 表头必须点明这是「采集期项目品牌」的口径。
    // 同一份报告第 3 节讲的是本次请求传入的竞品，两个都叫「品牌提及率」
    // 会让读者以为其中一处在算错。采集期那个值本身没错，只是另一批品牌。
    table(["阶段", "平台", "分配数", "有效回答", "有效率", "部分回答", "失败", "平均答长",
      "项目品牌提及率", "可计引用回答", "可见引用"], summaryRows) +
    note("按阶段 × 平台列出；不合并不同阶段的重复采集。",
      "分配数来自 sampling_batch_prompts；有效回答须为 success/partial 且确认新会话。" +
      "「项目品牌提及率」是采集期按项目 target_brand 算的，与第 3 节本次传入的竞品不是同一批品牌；" +
      "本次竞品的提及率见第 3 节。",
      "样本量差异较大的平台先比较比例和来源结构，不直接比较原始总数。") +
    "</section>";
}

function findingsSection(payload, rows) {
  const blocks = [];
  for (const { period, platform } of rows) {
    const source = platform.citations.top_domains[0];
    if (platform.runs.valid_runs < 1) continue;
    const fact = platform.runs.valid_runs + " 条有效回答";
    const sourceFact = source
      ? "；引用覆盖最多的来源域为 " + source.domain + "，覆盖 " + source.covered_runs + " 条可计引用回答"
      : "；当前没有符合口径的可见内容来源";
    const implication = source
      ? "可先核对该来源页与客户内容的覆盖差距；这表示来源共现，不代表该来源导致品牌提及。"
      : "先累积可计引用样本，再判断来源结构。";
    // 品牌事实必须用本报告 brands 参数统计出来的口径。
    //
    // 早期版本读 runs.brand_mention_rate —— 那是**采集期**按项目 target_brand
    // 算的，与报告请求里传的竞品毫无关系。实测项目 target_brand 是类目词
    // 「绍兴肩颈腰腿调理（改名）」，于是第 2 节对客户说「品牌提及率 1.0%」，
    // 而第 3 节说思邈棠 71.8% —— 两个「品牌提及率」并列出现，
    // 读者只会认为其中某个错了。数字本身都没错，错的只是没标口径。
    const brandFact = competitorFact(platform, payload);
    blocks.push("<div class=\"key\"><div class=\"key-title\">" + escapeHtml(period.label) + " · " +
      platformTag(platform.platform, payload) + "</div><p><strong>事实：</strong>" + escapeHtml(fact + brandFact + sourceFact) +
      "。</p><p><strong>建议：</strong>" + escapeHtml(implication) + "</p></div>");
  }
  if (!blocks.length) {
    blocks.push("<div class=\"empty\">所选范围尚无已结束批次的有效回答，当前不能形成平台结论。采集完成后可用相同日期范围重新生成快照。</div>");
  }
  return "<section id=\"sec-02\"><h2>2. 最重要的发现</h2>" + blocks.join("") +
    "<p class=\"muted\">发现只总结本报告实际观测；不将同一回答里的品牌提及和来源引用解释为因果关系。" +
    "品牌数据来自本次报告请求传入的竞品列表，与采集期项目配置的品牌无关。</p></section>";
}

/**
 * 平台品牌事实：按本报告的竞品统计，给出最高提及者。
 *
 * 不用 runs.brand_mention_rate —— 那是采集期按项目 target_brand 算的，
 * 与本报告的竞品列表不是同一批品牌。详见 findingsSection 的注释。
 */
function competitorFact(platform, payload) {
  const stats = platform.brand_mentions;
  if (!stats?.available || !stats.brands?.length) {
    // 没做品牌分析时如实说没做，而不是退回到另一个口径的数字
    return payload.scope?.brands?.length
      ? "；本次未产出品牌提及统计（没有可分析的回答正文）"
      : "；本次未指定竞品，未做品牌提及统计";
  }
  const top = [...stats.brands].sort((a, b) => (b.mention_rate ?? 0) - (a.mention_rate ?? 0))[0];
  if (!top || top.mention_rate == null) return "；本平台没有可用于计算提及率的有效回答";
  const others = stats.brands.length - 1;
  return `；本次传入的 ${stats.brands.length} 个品牌中提及率最高的是 ${top.name} ${percentage(top.mention_rate)}` +
    (others > 0 ? `，其余 ${others} 个见第 3 节` : "");
}

/**
 * 竞品跨平台对照表。
 *
 * 分平台各自的排名只能告诉你「在千问里谁排第一」，但竞品分析真正要回答的是
 * 「哪个平台更偏爱哪个竞品」——那需要把同一个竞品在两边的提及率并排放，
 * 按差值排序。差值为正 = 千问侧更受偏好，为负 = 豆包侧更受偏好。
 *
 * 缺失一律显示 N/A 而不是 0：某个平台没提到某竞品是「0%」，
 * 但那个平台压根没有有效样本时是「N/A」，两者含义完全不同。
 */
function crossPlatformBrandTable(payload, rows) {
  if (rows.length < 2) return "";

  const byPlatform = new Map();
  for (const { period, platform } of rows) {
    const stats = platform.brand_mentions ?? { brands: [] };
    if (!byPlatform.has(platform.platform)) byPlatform.set(platform.platform, new Map());
    const map = byPlatform.get(platform.platform);
    for (const b of stats.brands) map.set(b.name, b);
  }

  const platformIds = [...byPlatform.keys()];
  const names = new Set();
  for (const map of byPlatform.values()) for (const name of map.keys()) names.add(name);

  const cells = [...names].map((name) => {
    const per = platformIds.map((id) => byPlatform.get(id).get(name) ?? null);
    const rates = per.map((b) => (b ? b.mention_rate : null)).filter((r) => r != null);
    // 只有两边都有有效样本时才给差值；否则差值无意义
    const gap = rates.length === platformIds.length
      ? (rates[0] - rates[1]) * 100
      : null;
    return { name, per, gap };
  });

  // 排序：先按差值绝对值（差异最悬殊的排前面），再按两边的平均提及率
  cells.sort((a, b) => {
    const ga = a.gap == null ? -1 : Math.abs(a.gap);
    const gb = b.gap == null ? -1 : Math.abs(b.gap);
    if (ga !== gb) return gb - ga;
    const avg = (c) => {
      const rs = c.per.map((x) => (x ? x.mention_rate : null)).filter((r) => r != null);
      return rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : -1;
    };
    return avg(b) - avg(a);
  });

  const header = ["竞品", ...platformIds.map((id) => id + " 提及率"), "差值(百分点)"];
  const body = cells.map((cell) => [
    escapeHtml(cell.name) + roleTag(cell.per.find(Boolean)?.role),
    ...cell.per.map((b) => {
      if (!b) return "<span class=\"muted\">N/A</span>";
      return "<span class=\"num\">" + percentage(b.mention_rate) +
        " <span class=\"muted\">(" + numberText(b.mentioned_answers) + "/" + numberText(b.valid_answers) + ")</span></span>";
    }),
    cell.gap == null
      ? "<span class=\"muted\">N/A</span>"
      : "<span class=\"num " + (cell.gap > 0 ? "risky" : "safe") + "\">" +
        (cell.gap > 0 ? "+" : "") + cell.gap.toFixed(1) + "</span>",
  ]);

  return table(header, body);
}

/**
 * 品牌提及对比。
 *
 * 分工写在这一节里，因为它决定了读者怎么用这份数据：
 *   - 品牌由调用方在报告请求里传入（brands 参数），OneGl 不预设、不猜测
 *   - 提及率是可复现的统计口径，同一份品牌列表跑两次数字完全一样
 *   - 「被提及」不等于「被推荐」，推荐强度与应对策略由调用方的模型分析
 *
 * OneGl 不做实体抽取：早期试过用机构后缀词表猜名字，换行业即失效，
 * 而用户不会为了跑 GEO 去维护那张表。现在由调用方按平台分层抽样回答、
 * 交给自己的模型读一遍拿到高频品牌，再用 brands 传回。
 *
 * 多平台时先给跨平台对照表：竞品分析要先看「哪个平台偏爱哪个竞品」，
 * 那是这一节最直接可用的结论；分平台明细作为支撑放在后面。
 */
function institutionSection(payload, rows) {
  const hasBrands = rows.some(({ platform }) => (platform.brand_mentions?.brands ?? []).length);
  if (!hasBrands) {
    return "<section id=\"sec-03\"><h2>3. 品牌提及对比</h2>" +
      "<div class=\"empty\">未传 brands 参数，不做品牌提及统计。<br>" +
      "品牌列表可先按平台分层抽样 AI 回答、交给模型读出高频品牌，再用 brands 参数生成报告。" +
      "</div></section>";
  }

  const cross = crossPlatformBrandTable(payload, rows);
  const blocks = rows.map(({ period, platform }) => {
    const stats = platform.brand_mentions ?? { brands: [] };
    const mentionRows = stats.brands.map((item, index) => [
      "<span class=\"num\">" + numberText(index + 1) + "</span>",
      escapeHtml(item.name) + roleTag(item.role),
      "<span class=\"num\">" + numberText(item.mentioned_answers) + " / " + numberText(item.valid_answers) + "</span>",
      "<span class=\"num\">" + percentage(item.mention_rate) + "</span>",
      "<span class=\"num\">" + numberText(item.mention_count) + "</span>",
      "<span class=\"num\">" + numberText(item.average_first_position) + "</span>",
      Object.keys(item.by_platform ?? {}).map((p) =>
        platformTag(p, payload) + " " + numberText(item.by_platform[p].mentioned_answers) + "/" +
        numberText(item.by_platform[p].valid_answers)
      ).join(" "),
    ]);
    const examples = stats.brands
      .filter((item) => item.examples?.length)
      .slice(0, 6)
      .map((item) => {
        const sample = item.examples[0];
        return "<li><b>" + escapeHtml(item.name) + "</b> · 命中 " +
          escapeHtml((sample.matched_terms ?? []).join("、")) + " · " + escapeHtml(sample.run_id) +
          "<div class=\"quote\">" + escapeHtml(sample.context) + "</div></li>";
      })
      .join("");

    return "<div class=\"subpanel\"><h3>" + escapeHtml(period.label) + " · " +
      platformTag(platform.platform, payload) + "</h3>" +
      table(["#", "品牌", "提及回答", "提及率", "提及次数", "首现位置均值", "分平台"], mentionRows) +
      note(
        "基于 " + numberText(stats.answer_count) + " 条有正文的回答。",
        "提及率 = 提及该品牌的回答数 ÷ 有正文的回答数。匹配用调用方传入的 match_terms（品牌名+别名+产品名），子串匹配。" +
        "首现位置均值越小说明 AI 越早提到它。",
        "这是提及统计，不是推荐排序。哪个更值得投入、被提及是主动推荐还是顺带列举，" +
        "请结合下方原文用模型分析。") +
      (examples ? "<h4>原文出处</h4><ul class=\"quotes\">" + examples + "</ul>" : "") +
      "</div>";
  });

  return "<section id=\"sec-03\"><h2>3. 品牌提及对比</h2>" +
    (cross
      ? "<h4>跨平台对照</h4>" + cross +
        note(
          "同一竞品在两个平台上的提及率与差值，按差值绝对值降序。",
          "差值为正表示千问侧提及率更高，为负表示豆包侧更高。某平台无有效样本时显示 N/A，" +
          "不参与差值计算 —— 0% 与「没样本」不是一回事。",
          "这张表回答「哪个平台偏爱哪个竞品」。具体推荐强度、以及该往哪边投放，需要读原文后用模型判断。")
      : "") +
    "<h4>分平台明细</h4>" +
    blocks.join("") +
    "<div class=\"callout\"><b>这一节提供数据，不提供结论。</b>" +
    "提及率是确定性统计，可复现、可核对；但「被提及」不等于「被推荐」——" +
    "判断推荐强度排序、渠道差异、以及该不该投放，需要阅读原文后用你自己的模型分析。" +
    "品牌列表由报告请求的 brands 参数传入，OneGl 不预设品牌、不猜机构名。</div></section>";
}

function roleTag(role) {
  if (role === "own") return " <span class=\"tag-muted\">我方</span>";
  if (role === "competitor") return " <span class=\"tag-muted\">竞品</span>";
  return "";
}

function sourcesSection(payload, rows) {
  const blocks = rows.map(({ period, platform }) => {
    const domainRows = platform.citations.top_domains.map((item) => [
      escapeHtml(item.domain),
      "<span class=\"num\">" + numberText(item.citations) + "</span>",
      "<span class=\"num\">" + numberText(item.unique_articles) + "</span>",
      "<span class=\"num\">" + numberText(item.covered_runs) + "</span>",
      "<span class=\"num\">" + percentage(item.covered_run_rate) + "</span>",
    ]);
    const articleRows = platform.citations.top_articles.map((item) => [
      sourceLink(item.canonical_url, item.title || item.canonical_url),
      escapeHtml(item.domain || "—"),
      "<span class=\"num\">" + numberText(item.citations) + "</span>",
      "<span class=\"num\">" + numberText(item.covered_runs) + "</span>",
    ]);
    const valid = platform.citations.citation_valid_runs;
    return "<div class=\"subpanel\"><h3>" + escapeHtml(period.label) + " · " +
      platformTag(platform.platform, payload) + "</h3><h4>来源域名</h4>" +
      table(["域名", "引用数", "唯一文章", "覆盖回答", "覆盖率"], domainRows) +
      note(numberText(valid) + " 条可计引用回答；" + numberText(platform.citations.content_citations) + " 条内容引用",
        "按覆盖回答数降序，展示前 12 个域名；覆盖率分母为可计引用回答。",
        "可优先核对被更多回答引用的来源内容与客户页面主题是否一致。") +
      "<h4>来源文章</h4>" + table(["文章", "域名", "引用数", "覆盖回答"], articleRows) +
      note(numberText(platform.citations.content_citations) + " 条内容引用；" + numberText(platform.citations.unique_articles) + " 个唯一文章",
        "按覆盖回答数、引用数降序，展示前 12 个 URL；不是随机抽样。",
        "链接便于逐条核对引用证据；重复覆盖只说明共同出现频次。") +
      "</div>";
  });
  return "<section id=\"sec-04\"><h2>4. 来源链接与引用强度</h2>" +
    (blocks.join("") || "<div class=\"empty\">当前范围没有可计引用。来源引用仅计成功且引用解析有效的回答中的可见来源。</div>") +
    "<p class=\"muted\">来源图标域 cdn.sm.cn 与 gw.alicdn.com 单独计数，不纳入内容来源排行。当前平台合计图标引用：" +
    numberText(rows.reduce((sum, row) => sum + row.platform.citations.icon_citations, 0)) + "。</p></section>";
}

function regionsSection() {
  return "<section id=\"sec-05\"><h2>5. 地域需求分布</h2>" +
    "<div class=\"empty\">当前报告配置未包含地域词表。系统不会从回答文本自动猜测地名的业务含义。</div></section>";
}

function trackedSection(payload, rows) {
  const metricsRows = rows.map(({ period, platform }) => {
    const tracked = platform.citations.tracked_content;
    return [
      escapeHtml(period.label),
      platformTag(platform.platform, payload),
      tracked.configured ? numberText(tracked.configured_articles) : "N/A",
      tracked.configured && tracked.cited_articles != null ? numberText(tracked.cited_articles) : "N/A",
      tracked.configured ? percentage(tracked.article_coverage_rate) : "N/A",
      tracked.configured && tracked.covered_runs != null ? numberText(tracked.covered_runs) : "N/A",
      tracked.configured ? percentage(tracked.coverage_rate) : "N/A",
      tracked.configured ? deltaText(tracked.coverage_delta_percentage_points) : "N/A",
    ];
  });
  const details = rows.map(({ period, platform }) => {
    const tracked = platform.citations.tracked_content;
    if (!tracked.configured) return "";
    const articleRows = tracked.articles.map((item) => [
      sourceLink(item.canonical_url, item.title || item.canonical_url),
      escapeHtml(item.domain || "—"),
      "<span class=\"num\">" + numberText(item.citations) + "</span>",
      "<span class=\"num\">" + numberText(item.covered_runs) + "</span>",
    ]);
    return "<h3>" + escapeHtml(period.label) + " · " + platformTag(platform.platform, payload) + "</h3>" +
      table(["目标文章", "域名", "引用数", "覆盖回答"], articleRows) +
      (tracked.truncated ? "<p class=\"muted\">列表只展开覆盖靠前的 200 条，汇总指标使用完整配置集合。</p>" : "");
  }).join("");
  return "<section id=\"sec-06\"><h2>6. 内容要素覆盖</h2>" +
    (payload.target.tracked_articles_configured
      ? table(["阶段", "平台", "已配置文章", "被引用文章", "文章覆盖率", "覆盖回答", "覆盖回答率", "较上一阶段变化"], metricsRows)
      : "<div class=\"empty\">尚未配置目标文章（tracked_articles），收录效果显示 N/A，不把未配置当成 0%。</div>") +
    (payload.target.tracked_articles_configured
      ? note("有效引用回答 " + numberText(rows.reduce((sum, row) => sum + row.platform.citations.citation_valid_runs, 0)) + " 条；目标文章配置 " + numberText(payload.target.tracked_articles_count) + " 篇",
        "按 tracked_article_id 精确匹配；该字段为空时按项目内 canonical URL 精确匹配。覆盖回答率分母为可计引用回答。",
        "按阶段观察目标文章覆盖率变化；样本与配置变化需一并考虑，趋势本身不证明页面修改导致变化。")
      : "") + details + "</section>";
}

function questionSection(payload) {
  const blocks = [];
  for (const period of payload.periods) {
    for (const platform of period.platforms) {
      const byCategory = new Map();
      for (const item of platform.questions) {
        byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + item.assignments);
      }
      const categoryRows = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => [
        escapeHtml(category),
        "<span class=\"num\">" + numberText(count) + "</span>",
      ]);
      const questionRows = platform.questions.map((item) => "<li><span class=\"muted\">" +
        escapeHtml(item.category) + " · " + numberText(item.assignments) + " 次</span><br>" +
        escapeHtml(item.question) + "</li>").join("");
      blocks.push("<div class=\"subpanel\"><h3>" + escapeHtml(period.label) + " · " +
        platformTag(platform.platform, payload) + "</h3>" +
        table(["问题分类", "分配次数"], categoryRows) +
        note(numberText(platform.runs.assignments) + " 次分配；列出 " + numberText(platform.questions.length) + " 个问题",
          "分类来自采集时保存的问题分类；重复分配按次数计数。",
          "用于理解本期检测覆盖范围，不代表市场总体需求占比。") +
        "<details><summary>" + escapeHtml(platform.platform) + " · 完整问题清单（" +
        numberText(platform.questions.length) + "）</summary><ol>" + questionRows + "</ol></details></div>");
    }
  }
  return "<section id=\"sec-07\"><h2>7. 检测的问题范围</h2>" +
    (blocks.join("") || "<div class=\"empty\">所选范围没有问题分配记录。</div>") + "</section>";
}

function evaluationSection() {
  return "<section id=\"sec-08\"><h2>8. AI 评判维度与价格带</h2>" +
    "<div class=\"empty\">当前版本尚无经项目确认的主题词与价格抽取配置，因此不输出推断性维度或金额统计。</div></section>";
}

function sourceOpportunitySection(payload, rows) {
  const domainCount = rows.reduce((sum, row) => sum + row.platform.citations.unique_domains, 0);
  const iconCount = rows.reduce((sum, row) => sum + row.platform.citations.icon_citations, 0);
  // 标题里点明「来源结构」而不是「层级」：下面这两个数字是域名去重计数，
  // 与媒体/垂直站/UGC 的层级判定无关。放在「来源层级与机会点」标题下
  // 会让人误以为这是层级分析的结果。
  return "<section id=\"sec-09\"><h2>9. 来源层级与机会点</h2>" +
    "<div class=\"empty\">媒体、垂直站、UGC 与官网层级需要可维护的域名映射，" +
    "当前不对域名自动贴来源层级标签，因此本节不输出层级构成或机会点判断。</div>" +
    // 数字单独归组并标注口径，避免被当成层级的代理指标
    "<h3>可计的来源规模（按域名去重，非层级构成）</h3>" +
    "<div class=\"grid grid2\"><div class=\"card\"><div class=\"muted\">平台阶段记录的唯一内容域名数合计</div><strong class=\"num\">" +
    numberText(domainCount) + "</strong></div><div class=\"card\"><div class=\"muted\">排除在内容排行外的图标引用</div><strong class=\"num\">" +
    numberText(iconCount) + "</strong></div></div>" +
    note("域名数按平台和阶段分别统计后展示，不做层级归类。",
      "以可计可见引用中的 normalized_domain 去重；图标域不计入内容来源。",
      "这两个数字反映来源规模，不能推断渠道结构或各层级的权重；建立经确认的域名层级配置后才可按期观察渠道结构变化。") +
    "</section>";
}

function actionSection(payload, rows) {
  const blocks = [];
  const brandStats = rows.map((row) => row.platform.brand_mentions).find((s) => s?.available);

  // 关于项目品牌（采集期口径）的建议只在**确实没产出竞品数据**时才提。
  //
  // 早期版本只看 payload.target.brand_configured，于是「项目没配 target_brand、
  // 但本次传了竞品」时会同时出现：第 3 节展示思邈棠 71.8%，第 10 节却说
  // 「当前品牌提及指标为 N/A；补充目标品牌后再解读提及表现」—— 客户刚看到
  // 竞品数据就被告知没有品牌数据，只能认为其中一处在算错。
  if (!payload.target.brand_configured && !brandStats) {
    blocks.push("<li><strong>完善项目品牌配置：</strong>项目未配置目标品牌，采集期口径的品牌提及指标为 N/A。" +
      "该指标与本次传入的竞品列表是两回事，配置后重采集才能得到。</li>");
  }
  if (!payload.target.tracked_articles_configured) {
    blocks.push("<li><strong>配置目标内容：</strong>当前无法衡量自有文章的收录覆盖；添加要跟踪的 canonical URL 后，可按平台和阶段比较。</li>");
  } else if (rows.some((row) => row.platform.citations.citation_valid_runs > 0)) {
    blocks.push("<li><strong>复核目标文章：</strong>根据上表的覆盖回答和引用链接检查目标页面是否仍可访问、主题是否匹配；引用共现不表示页面修改会导致品牌提及。</li>");
  } else {
    blocks.push("<li><strong>先取得可计样本：</strong>当前没有可计引用回答；等待采集批次结束后重生成，再判断目标文章覆盖。</li>");
  }
  if (rows.some((row) => row.platform.citations.top_domains.length > 0)) {
    blocks.push("<li><strong>逐条核对来源：</strong>从覆盖回答较多的域名与 URL 开始，验证公开页面是否能支持对应内容主题。</li>");
  }
  // 有竞品数据时，给出针对竞品口径的下一步 —— 之前无论有没有数据都只谈项目品牌
  if (brandStats) {
    const names = brandStats.brands.slice(0, 3).map((b) => b.name).join("、");
    const more = brandStats.brands.length > 3 ? ` 等 ${brandStats.brands.length} 个` : "";
    blocks.push("<li><strong>针对竞品口径复核：</strong>第 3 节的竞品提及率按本次传入的 " +
      brandStats.brands.length + " 个品牌计算（" + escapeHtml(names + more) + "）；" +
      "需要换一批竞品时重新提交 brands 参数生成新快照，历史快照不会自动改。</li>");
  }
  if (payload.periods.length > 1) {
    blocks.push("<li><strong>持续记录阶段：</strong>沿用相同 Task、平台、时区和跟踪文章配置生成下一阶段；样本口径变化时单独注明。</li>");
  }
  return "<section id=\"sec-10\"><h2>10. 结论与行动建议</h2><div class=\"key\"><p>报告当前只对已采集数据作描述性统计。阶段变化可作为复核线索，不单独证明某次内容动作带来了变化。</p></div><ol class=\"actions\">" +
    blocks.join("") + "</ol></section>";
}

function dataNotesSection(payload, rows) {
  const methodRows = [
    ["有效回答", payload.methodology.valid_runs],
    ["引用有效回答", payload.methodology.citation_valid_runs],
    ["可见引用", payload.methodology.visible_citations],
    ["内容来源", payload.methodology.content_sources],
    ["目标文章匹配", payload.methodology.tracked_articles],
    ["批次筛选", payload.methodology.report_batch_scope],
    ["品牌提及", payload.methodology.brand_mentions],
    ["回答正文", payload.methodology.answer_text],
    ["归因边界", payload.methodology.attribution],
  ].map(([label, value]) => [escapeHtml(label), escapeHtml(value)]);
  const batchRows = [];
  for (const period of payload.periods) {
    for (const batch of period.source_batches) {
      batchRows.push([
        escapeHtml(period.label),
        platformTag(batch.platform, payload),
        escapeHtml(batch.execution_id),
        escapeHtml(batch.status),
        escapeHtml(batch.started_at || "—"),
      ]);
    }
    for (const batch of period.excluded_batches) {
      batchRows.push([
        escapeHtml(period.label),
        platformTag(batch.platform, payload),
        escapeHtml(batch.execution_id),
        escapeHtml(batch.status + "（未纳入）"),
        escapeHtml(batch.started_at || "—"),
      ]);
    }
  }
  const warnings = payload.warnings.length
    ? "<ul class=\"warnings\">" + payload.warnings.map((item) => "<li>" + escapeHtml(item) + "</li>").join("") + "</ul>"
    : "<p class=\"muted\">无额外数据质量提示。</p>";
  return "<section id=\"sec-11\"><h2>11. 数据说明</h2>" +
    table(["口径", "说明"], methodRows) +
    note("可计批次 " + numberText(rows.reduce((sum, row) => sum + row.period.source_batches.length, 0)) +
      " 个；未结束批次 " + numberText(payload.periods.reduce((sum, period) => sum + period.excluded_batches.length, 0)) + " 个",
      "批次以 Task 关联、平台一致且 started_at 落入日期边界为准。日期范围两端均包含。",
      "报告使用生成时的一致数据库快照；重新生成会创建新的报告和修订，不改写旧结果。") +
    table(["阶段", "平台", "执行 ID", "批次状态", "开始时间"], batchRows) +
    warnings + "</section>";
}

const CSS = [
  ":root{--ink:#1a2130;--muted:#66707f;--faint:#98a1ad;--line:#e6e8ec;--surface:#fff;--bg:#f7f8fa;--ok:#0e9f6e;--warn:#d97706;--bad:#dc2626;--accent:#2563eb;--platform-0:#2563eb;--platform-1:#7c3aed;--platform-2:#0e9f6e;--platform-3:#d97706;--platform-4:#0891b2;--platform-5:#db2777;--platform-6:#4f46e5;--platform-7:#65a30d}",
  "*{box-sizing:border-box}",
  "html{scroll-behavior:smooth}",
  "body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}",
  "main{max-width:1060px;margin:0 auto;padding:32px 24px 64px}",
  "header.hero{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:28px;margin-bottom:18px}",
  "h1{font-size:25px;line-height:1.35;margin:0 0 10px}h2{font-size:18px;margin:0 0 14px;scroll-margin-top:18px}h3{font-size:15px;margin:18px 0 10px}h4{font-size:14px;margin:14px 0 8px}",
  "p{margin:8px 0}a{color:var(--accent);overflow-wrap:anywhere}",
  "section,.subpanel,.card,.guide{background:var(--surface);border:1px solid var(--line);border-radius:14px}",
  "section{padding:22px;margin:16px 0}.subpanel{padding:16px;margin:14px 0}.card{padding:14px 16px;min-width:0}",
  ".grid{display:grid;gap:12px}.cards{grid-template-columns:repeat(3,minmax(0,1fr));margin:14px 0}.grid2{grid-template-columns:repeat(2,minmax(0,1fr))}",
  ".card strong{display:block;font-size:23px;margin-top:3px}.num{font-variant-numeric:tabular-nums;text-align:right}",
  ".muted{color:var(--muted)}.small{font-size:12px;color:var(--muted)}",
  ".tag{display:inline-flex;align-items:center;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:650;white-space:nowrap;background:#eef2f7;color:var(--ink)}",
  ".platform.p0{color:var(--platform-0);background:color-mix(in srgb,var(--platform-0) 10%,white)}.platform.p1{color:var(--platform-1);background:color-mix(in srgb,var(--platform-1) 10%,white)}.platform.p2{color:var(--platform-2);background:color-mix(in srgb,var(--platform-2) 10%,white)}.platform.p3{color:var(--platform-3);background:color-mix(in srgb,var(--platform-3) 10%,white)}.platform.p4{color:var(--platform-4);background:color-mix(in srgb,var(--platform-4) 10%,white)}.platform.p5{color:var(--platform-5);background:color-mix(in srgb,var(--platform-5) 10%,white)}.platform.p6{color:var(--platform-6);background:color-mix(in srgb,var(--platform-6) 10%,white)}.platform.p7{color:var(--platform-7);background:color-mix(in srgb,var(--platform-7) 10%,white)}",
  ".table-wrap{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;width:100%;min-width:620px}th,td{border-bottom:1px solid var(--line);padding:9px 10px;text-align:left;vertical-align:top}th{color:var(--muted);font-size:12px;font-weight:650;background:#fafbfc}td .num{display:block}",
  ".methodology{font-size:12px;color:var(--muted);background:#f8fafc;border-left:3px solid var(--accent);padding:9px 12px;margin:8px 0 18px}",
  ".key{border-left:4px solid var(--accent);background:#f5f8ff;padding:14px 16px;border-radius:8px;margin:12px 0}.key-title{font-weight:700}.key p:last-child{margin-bottom:0}",
  ".empty{border:1px dashed #cbd2dc;background:#fbfcfd;padding:14px 16px;border-radius:10px;color:var(--muted)}",
  ".guide{padding:18px 20px;margin:18px 0}.guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.guide a{font-weight:600}",
  ".toclist{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:14px}.toclist a{text-decoration:none;font-size:12px}",
  "details{border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin:12px 0}summary{cursor:pointer;font-weight:650;color:var(--accent)}details ol{padding-left:24px}details li{margin:8px 0}",
  ".warnings{background:#fff8eb;border:1px solid #f3d5a4;border-radius:9px;padding:12px 12px 12px 32px;color:#7a4d0b}",
  // 排名节：callout 提示需要模型分析，quotes 是给 agent 判断用的原文出处片段
  ".callout{border:1px solid #c7d7f0;background:#f4f8fe;border-left:4px solid var(--accent);border-radius:8px;padding:12px 14px;margin:14px 0;font-size:13px;line-height:1.75}",
  ".quotes{list-style:none;padding:0!important;margin:10px 0 0}.quotes li{border-top:1px solid var(--line);padding:9px 0;margin:0!important;font-size:12.5px}",
  ".quote{margin-top:5px;padding:8px 11px;background:#f8fafc;border-left:2px solid #cbd2dc;border-radius:0 6px 6px 0;color:var(--muted);line-height:1.8;word-break:break-word}",
  ".tag-muted{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:500;color:var(--muted);background:#eef1f5;white-space:nowrap}",
  ".actions li{margin:10px 0}.subpanel .tag{vertical-align:middle}",
  "footer{color:var(--muted);font-size:12px;text-align:center;padding:20px}",
  // 客户 logo：只在传了 theme.logo_url 时出现，否则这个标签不存在
  ".brand-logo{display:block;max-width:100%;height:auto;margin:0 auto 12px;object-fit:contain}",
  // 目录里标出「本期未启用」的章节：不标的话读者会以为漏看了内容
  ".toc-pending{color:var(--muted)}.toc-tag{color:var(--faint);font-weight:400;margin-left:4px}",
  "@media(max-width:760px){main{padding:16px 12px 40px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.grid2,.guide-grid{grid-template-columns:1fr}section{padding:16px}.hero{padding:20px!important}}",
  "@media print{@page{margin:14mm}body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}main{max-width:none;padding:0}section,.subpanel,.card,.guide{box-shadow:none;break-inside:avoid;border-color:#d7dce3}a{color:inherit;text-decoration:none}details{break-inside:avoid}details>summary{list-style:none}details:not([open])>*:not(summary){display:block}.toclist a:after{content:''}header.hero{border-color:#d7dce3}.table-wrap{overflow:visible}table{min-width:0;font-size:11px}th,td{padding:6px}}",
].join("\n");

function platformStyle(payload) {
  const declarations = payload.scope.platforms.map((platform, index) => {
    const color = payload.profile.platform_colors?.[platform];
    const safeColor = /^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb";
    return { variable: "--platform-" + index + ":" + safeColor, rule: ".platform.p" + index +
      "{color:var(--platform-" + index + ");background:color-mix(in srgb,var(--platform-" + index + ") 10%,white)}" };
  });
  return ":root{" + declarations.map((item) => item.variable).join(";") + "}" +
    declarations.map((item) => item.rule).join("");
}

/**
 * logo 标记。
 *
 * 渲染层重新跑一遍 normalizeTheme，而不是信任入参：artifact_html 是生成时
 * 渲染后存进快照的，渲染时的 payload 来自数据库，且完整性校验只保证哈希一致、
 * 不保证字段取值合法。escapeHtml 挡得住引号突破，挡不住 `javascript:` 这种
 * 协议注入 —— 协议必须在这里再判一次。
 */
function logoMarkup(theme) {
  const safe = normalizeTheme(theme);
  if (!safe?.logo_url) return "";
  const height = Math.min(safe.logo_height ?? 40, 64);
  const width = safe.logo_width ? ` width="${Math.min(safe.logo_width, 320)}"` : "";
  return `<img class="brand-logo" src="${escapeHtml(safe.logo_url)}" alt="" height="${height}"${width}>`;
}

export function buildGeoCustomerReportHtml(payload) {
  const rows = allRows(payload);
  const sectionHtml = [
    overviewSection(payload, rows),
    findingsSection(payload, rows),
    institutionSection(payload, rows),
    sourcesSection(payload, rows),
    regionsSection(),
    trackedSection(payload, rows),
    questionSection(payload),
    evaluationSection(),
    sourceOpportunitySection(payload, rows),
    actionSection(payload, rows),
    dataNotesSection(payload, rows),
  ].join("");
  const guides = [
    ["只有 1 分钟", "从最重要的发现和行动建议开始。", "#sec-02"],
    // 指向第 3 节（品牌提及对比）而不是第 9 节：来源层级一节当前是空占位，
    // 引导过去只会让人扑空。
    ["要决定渠道", "看竞品在各平台的提及差异，再看来源强度。", "#sec-03"],
    ["要核对证据", "打开来源文章链接逐条核对。", "#sec-04"],
    ["要调整内容", "先看目标文章覆盖，再看问题范围。", "#sec-06"],
  ];
  // 目录里给三个未启用的章节加「本期未启用」标记。
  // 它们在正文里是说明为什么不输出的空状态，但目录只有标题，
  // 读者会以为漏看了内容或渲染失败。标出来更省事。
  const PENDING_SECTIONS = new Set(["地域需求分布", "AI 评判维度与价格带", "来源层级与机会点"]);
  const toc = [
    "执行概览", "最重要的发现", "品牌提及对比", "来源链接与引用强度",
    "地域需求分布", "内容要素覆盖", "检测的问题范围", "AI 评判维度与价格带",
    "来源层级与机会点", "结论与行动建议", "数据说明",
  ].map((title, index) => {
    const number = String(index + 1).padStart(2, "0");
    const suffix = PENDING_SECTIONS.has(title) ? "（本期未启用）" : "";
    return "<a href=\"#sec-" + number + "\" class=\"" + (PENDING_SECTIONS.has(title) ? "toc-pending" : "") + "\">" +
      number + " " + escapeHtml(title) + "<span class=\"toc-tag\">" + suffix + "</span></a>";
  }).join("");
  const periodSummary = payload.scope.periods.map((period) =>
    escapeHtml(period.label + " (" + period.from + " 至 " + period.to + ", " + period.time_zone + ")")).join("；");
  // 主题覆盖放在最后，靠 CSS 层叠生效；platformStyle 必须先于它，
  // 否则主题的 accent 会被平台色变量抢回去。
  const theme = payload.theme ?? null;
  const css = CSS + "\n" + platformStyle(payload) + "\n" + themeCss(theme);
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<meta name=\"referrer\" content=\"no-referrer\"><title>" + escapeHtml(payload.title) + "</title>" +
    "<style>" + css + "</style></head><body><main>" +
    "<header class=\"hero\">" + logoMarkup(theme) +
    "<h1>" + escapeHtml(payload.title) + "</h1>" +
    "<p class=\"muted\">目标：" + escapeHtml(payload.target.name) + " · 平台：" +
    payload.scope.platforms.map(escapeHtml).join("、") + "</p>" +
    "<p class=\"muted\">阶段：" + periodSummary + "</p><p class=\"small\">报告 ID " +
    escapeHtml(payload.report_id) + " · 固定快照版本 " + escapeHtml(payload.schema_version) + "</p></header>" +
    "<nav id=\"toc\" class=\"guide\"><h2>目录与阅读指引</h2><div class=\"guide-grid\">" +
    guides.map(([label, hint, href]) => "<div><strong>" + escapeHtml(label) + "：</strong>" +
      escapeHtml(hint) + " <a href=\"" + href + "\">前往</a></div>").join("") +
    "</div><div class=\"toclist\">" + toc + "</div></nav>" +
    sectionHtml +
    "<footer>" + escapeHtml(footerText(theme, "OneGl · GEO 客户报告")) + " · 快照 " +
    escapeHtml(payload.report_id) + " · 生成时间 " + escapeHtml(payload.generated_at) +
    "</footer></main></body></html>";
}
