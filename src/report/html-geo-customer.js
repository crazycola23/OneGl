import { footerText, normalizeTheme, themeCss } from "./report-theme.js";

/**
 * 正文章节顺序，全报告唯一来源。
 *
 * 目录项、章节 id、:target 高亮规则三处都从这里派生，所以加减章节只改这一行。
 * 之前这三处各写一份：正文里硬编码 `sec-01..sec-11`，目录是另一份手写数组，
 * 高亮 CSS 又是第三条手写 11 条规则。漏改任何一处都不报错，症状是
 * 「点目录跳错位置」或「点某节不高亮」——只能靠人眼发现。
 *
 * 序号与章节 id 一一对应且连续。跳过连续性的检查放在渲染时（见 render 里的断言）。
 */
const SECTION_TITLES = [
  "执行概览",
  "最重要的发现",
  "品牌提及对比",
  "来源链接与引用强度",
  "内容要素覆盖",
  "检测的问题范围",
  "结论与行动建议",
  "数据说明",
];

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
  // 概览按平台分块，而不是一张「阶段 × 平台」交叉表。
  // 交叉表在两个平台、两个阶段时就已经要跨行读数；平台一多就没法看了。
  const platformTables = groupBlocksByPlatform(rows).map((group) =>
    "<h4>" + platformTag(group.platform, payload) + "</h4>" +
    table(["阶段", "分配数", "有效回答", "采集完成率", "部分回答", "失败", "平均答长",
      "项目品牌提及率", "可计引用回答", "可见引用"],
      group.items.map(({ period, platform }) => [
        escapeHtml(period.label),
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
      ]))).join("");

  return "<section id=\"sec-01\"><h2>1. 执行概览</h2>" +
    "<p>目标：" + escapeHtml(payload.target.name) + (payload.target.brand ? " · 品牌：" + escapeHtml(payload.target.brand) : " · 品牌未配置") +
    "。报告生成于 " + escapeHtml(new Date(payload.generated_at).toLocaleString("zh-CN", { timeZone: reportTimeZone })) +
    "（" + escapeHtml(reportTimeZone) + "）。</p>" +
    "<div class=\"grid cards\">" + cards + "</div>" +
    // 表头必须点明这是「采集期项目品牌」的口径。
    // 同一份报告第 3 节讲的是本次请求传入的竞品，两个都叫「品牌提及率」
    // 会让读者以为其中一处在算错。采集期那个值本身没错，只是另一批品牌。
    platformTables +
    note("按平台分块，块内按阶段列出；不合并不同阶段的重复采集。",
      "分配数来自 sampling_batch_prompts；有效回答须为 success/partial 且确认新会话。" +
      "「采集完成率」= 有效回答 / 分配数，衡量的是采集是否跑完，不是回答内容质量；" +
      "未执行的分配仍计入分母，完成率偏低时该平台样本更小、指标更不稳定。" +
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
  return "<section id=\"sec-03\"><h2>3. 品牌提及对比</h2>" +
    (cross
      ? "<h4>跨平台对照</h4>" + cross +
        note(
          "同一竞品在两个平台上的提及率与差值，按差值绝对值降序。",
          "差值为正表示千问侧提及率更高，为负表示豆包侧更高。某平台无有效样本时显示 N/A，" +
          "不参与差值计算 —— 0% 与「没样本」不是一回事。",
          "这张表回答「哪个平台偏爱哪个竞品」。具体推荐强度、以及该往哪边投放，需要读原文后用模型判断。")
      : "") +
    // 分平台明细按平台分块，块与块之间不再共用一张表。
    // 混在一张表里时，读的人得自己在脑子里做减法才知道每个平台的情况。
    "<h4>分平台明细</h4>" +
    groupBlocksByPlatform(rows).map((group) =>
      "<div class=\"subpanel\"><h3>" + platformTag(group.platform, payload) +
      " <span class=\"muted small\">共 " + numberText(group.items.length) + " 个阶段</span></h3>" +
      group.items.map(({ period, platform }) => {
        const stats = platform.brand_mentions ?? { brands: [] };
        const mentionRows = stats.brands.map((item, index) => [
          "<span class=\"num\">" + numberText(index + 1) + "</span>",
          escapeHtml(item.name) + roleTag(item.role),
          "<span class=\"num\">" + numberText(item.mentioned_answers) + " / " + numberText(item.valid_answers) + "</span>",
          "<span class=\"num\">" + percentage(item.mention_rate) + "</span>",
          "<span class=\"num\">" + numberText(item.mention_count) + "</span>",
          "<span class=\"num\">" + numberText(item.average_first_position) + "</span>",
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

        return "<h4>" + escapeHtml(period.label) + "</h4>" +
          table(["#", "品牌", "提及回答", "提及率", "提及次数", "首现位置均值"], mentionRows) +
          note(
            "基于 " + numberText(stats.answer_count) + " 条有正文的回答。",
            "提及率 = 提及该品牌的回答数 ÷ 有正文的回答数。匹配用调用方传入的 match_terms（品牌名+别名+产品名），子串匹配。" +
            "首现位置均值越小说明 AI 越早提到它。",
            "这是提及统计，不是推荐排序。哪个更值得投入、被提及是主动推荐还是顺带列举，" +
            "请结合下方原文用模型分析。") +
          (examples ? "<h5>原文出处</h5><ul class=\"quotes\">" + examples + "</ul>" : "");
      }).join("") +
      "</div>").join("") +
    "<div class=\"callout\"><b>这一节提供数据，不提供结论。</b>" +
    "提及率是确定性统计，可复现、可核对；但「被提及」不等于「被推荐」——" +
    "判断推荐强度排序、渠道差异、以及该不该投放，需要阅读原文后用你自己的模型分析。" +
    "品牌列表由报告请求的 brands 参数传入，OneGl 不预设品牌、不猜机构名。</div></section>";
}

/**
 * 把 rows 按平台聚起来。
 *
 * 一份报告横跨多个平台时，同一个品牌在每个平台各有一行，中间还夹着阶段列 ——
 * 读的人要自己在脑子里做减法才知道「千问这边到底谁排第一」。按平台分块之后，
 * 每个平台自成一块，块内只有该平台的数据。
 *
 * 块内按平台出现顺序分组（Map 保序），组内保持原来的阶段顺序，
 * 这样同平台跨阶段时读起来仍然是从早到晚。
 */
function groupBlocksByPlatform(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.platform.platform)) {
      groups.set(row.platform.platform, { platform: row.platform.platform, items: [] });
    }
    groups.get(row.platform.platform).items.push(row);
  }
  return [...groups.values()];
}

function roleTag(role) {
  if (role === "own") return " <span class=\"tag-muted\">我方</span>";
  if (role === "competitor") return " <span class=\"tag-muted\">竞品</span>";
  return "";
}

function sourcesSection(payload, rows) {
  // 与概览、品牌提及一致：按平台分块。域名排行混在一起时，
  // 「豆包引用最多的域名」和「千问引用最多的域名」会并排出现，读的人得自己分清哪行属于谁。
  const blocks = groupBlocksByPlatform(rows).map((group) => {
    const inner = group.items.map(({ period, platform }) => {
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
      return "<h4>" + escapeHtml(period.label) + "</h4><h5>来源域名</h5>" +
        table(["域名", "引用数", "唯一文章", "覆盖回答", "覆盖率"], domainRows) +
        note(numberText(platform.citations.citation_valid_runs) + " 条可计引用回答；" + numberText(platform.citations.content_citations) + " 条内容引用",
          "按覆盖回答数降序，展示前 12 个域名；覆盖率分母为可计引用回答。",
          "可优先核对被更多回答引用的来源内容与客户页面主题是否一致。") +
        "<h5>来源文章</h5>" + table(["文章", "域名", "引用数", "覆盖回答"], articleRows) +
        note(numberText(platform.citations.content_citations) + " 条内容引用；" + numberText(platform.citations.unique_articles) + " 个唯一文章",
          "按覆盖回答数、引用数降序，展示前 12 个 URL；不是随机抽样。",
          "链接便于逐条核对引用证据；重复覆盖只说明共同出现频次。");
    }).join("");
    const iconTotal = group.items.reduce((sum, row) => sum + row.platform.citations.icon_citations, 0);
    return "<div class=\"subpanel\"><h3>" + platformTag(group.platform, payload) + "</h3>" + inner +
      (iconTotal ? "<p class=\"muted small\">本平台图标引用 " + numberText(iconTotal) + " 条，不纳入内容来源排行。</p>" : "") +
      "</div>";
  });
  return "<section id=\"sec-04\"><h2>4. 来源链接与引用强度</h2>" +
    (blocks.join("") || "<div class=\"empty\">当前范围没有可计引用。来源引用仅计成功且引用解析有效的回答中的可见来源。</div>") +
     "<p class=\"muted\">来源图标域（canonical_url 主机名为 cdn.sm.cn 与 gw.alicdn.com，" +
     "落库归一化为 sm.cn 与 alicdn.com）单独计数，不纳入内容来源排行。各平台合计见上方分块。</p></section>";
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
  return "<section id=\"sec-05\"><h2>5. 内容要素覆盖</h2>" +
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
      // 全部问题都在 uncategorized 时，「问题分类」表只有一行、零信息量，
      // 却占掉整张表的位置。改为一句话说明未配置分类，把版面让给完整问题清单。
      //
      // 实测：当前库 174 条分配全部是 uncategorized（prompts.category 未配置），
      // 于是每份报告都出现一张「uncategorized=50」的表，客户会以为
      // 「我们只检测了一类问题」—— 而真相是根本没有配置分类。
      // 判据用 byCategory 的原始键，不用 escapeHtml 之后的字符串 ——
      // "uncategorized" 是纯 ASCII，转义后恰好不变，能工作纯属巧合。
      const onlyUncategorized = byCategory.size === 1 && byCategory.has("uncategorized");
      const categoryBlock = onlyUncategorized
        ? "<p class=\"muted\">本阶段问题未配置分类，全部计入「uncategorized」；" +
          "配置 prompts.category 后可按「品牌识别 / 价格 / 服务」等维度分组看覆盖范围。</p>"
        : table(["问题分类", "分配次数"], categoryRows);
      blocks.push("<div class=\"subpanel\"><h3>" + escapeHtml(period.label) + " · " +
        platformTag(platform.platform, payload) + "</h3>" +
        categoryBlock +
        note(numberText(platform.runs.assignments) + " 次分配；列出 " + numberText(platform.questions.length) + " 个问题",
          "分类来自采集时保存的问题分类；重复分配按次数计数。",
          "用于理解本期检测覆盖范围，不代表市场总体需求占比。") +
        "<details><summary>" + escapeHtml(platform.platform) + " · 完整问题清单（" +
        numberText(platform.questions.length) + "）</summary><ol>" + questionRows + "</ol></details></div>");
    }
  }
  return "<section id=\"sec-06\"><h2>6. 检测的问题范围</h2>" +
    (blocks.join("") || "<div class=\"empty\">所选范围没有问题分配记录。</div>") + "</section>";
}

/**
 * 从报告数据里挑出「值得先看的几点」。
 *
 * ## 为什么需要
 *
 * 第 7 节之前全是流程性建议（"逐条核对来源"、"持续记录阶段"），
 * 而报告本身最有决策价值的观察 —— 哪个平台被谁压制、我的内容在哪弱 ——
 * 一条都没出现在行动建议里。实测一份 4 竞品 2 平台的报告里，
 * 5 条关键事实全部缺席：千问首选某品牌 72% 而豆包只有 38%、
 * 目标文章覆盖千问 91% 豆包 36%、某竞品两平台都没被提到。
 *
 * 客户读完第 3 节的表格得自己总结，而多数人不会认真看表。
 *
 * ## 边界
 *
 * 只陈述**报告内已有的数字与差值**，不做任何推断：
 *   - 不说「你被压制了」「应该主攻千问」这类判断
 *   - 不把共现说成因果
 *   - 分母不足的平台不给结论（N/A 而不是拿 0 充数）
 *
 * 判断归调用方的模型 —— 这与 OneGL 其它章节的立场一致。
 */
function dataFacts(rows) {
  const facts = [];
  const withBrands = rows.filter((row) => row.platform.brand_mentions?.available);
  const withCoverage = rows.filter((row) =>
    row.platform.citations.tracked_content.configured
    && row.platform.citations.tracked_content.coverage_rate != null);

  // 1. 各平台的首选竞品与差距 —— 同一批竞品在不同平台的排序差异
  const leaders = new Map();
  for (const row of withBrands) {
    const top = [...row.platform.brand_mentions.brands]
      .filter((b) => b.mention_rate > 0)
      .sort((a, b) => b.mention_rate - a.mention_rate)[0];
    if (top) leaders.set(row.platform.platform, { ...top, valid: row.platform.brand_mentions.answer_count });
  }
  if (leaders.size >= 2) {
    const parts = [...leaders.entries()].map(([platform, b]) =>
      `${platform} ${percentage(b.mention_rate)}（${b.valid} 条有效回答）`);
    facts.push(`本期提及率最高的品牌：${parts.join("，")}。`);

    // 同一品牌在平台间的差距
    const byName = new Map();
    for (const [platform, b] of leaders) {
      if (!byName.has(b.name)) byName.set(b.name, []);
      byName.get(b.name).push([platform, b.mention_rate]);
    }
    for (const [name, entries] of byName) {
      if (entries.length < 2) continue;
      const rates = entries.map(([, r]) => r);
      const spread = Math.max(...rates) - Math.min(...rates);
      const resolution = 100 / Math.max(1, Math.min(...leaders.values().map((b) => b.valid)));
      if (spread * 100 >= Math.max(1, resolution)) {
        const sorted = entries.slice().sort((a, b) => b[1] - a[1]);
        facts.push(`「${name}」在 ${sorted[0][0]} 为 ${percentage(sorted[0][1])}、在 ${sorted[sorted.length - 1][0]} 为 ${percentage(sorted[sorted.length - 1][1])}，相差 ${(spread * 100).toFixed(1)} 个百分点。`);
      }
    }
    // 首选品牌不同的情况 —— 那是最值得先看的
    const names = [...leaders.values()].map((b) => b.name);
    if (new Set(names).size > 1) {
      facts.push(`各平台的首选品牌不同（${names.join(" / ")}），说明平台偏好存在差异。`);
    }
  }

  // 2. 目标文章覆盖的跨平台差距
  if (withCoverage.length >= 2) {
    const parts = withCoverage.map((row) =>
      `${row.platform.platform} ${percentage(row.platform.citations.tracked_content.coverage_rate)}`);
    const rates = withCoverage.map((row) => row.platform.citations.tracked_content.coverage_rate);
    const spread = Math.max(...rates) - Math.min(...rates);
    facts.push(`目标文章覆盖：${parts.join("，")}` + (spread > 0.01
      ? `，差距 ${(spread * 100).toFixed(1)} 个百分点。`
      : "。"));
  }

  // 3. 有回答但完全没被提到的竞品 —— 存在感缺失，与「势头稳定」不同
  for (const row of withBrands) {
    const stats = row.platform.brand_mentions;
    if (!stats.available || stats.answer_count === 0) continue;
    const absent = stats.brands.filter((b) => b.mention_rate === 0).map((b) => b.name);
    if (absent.length && absent.length < stats.brands.length) {
      facts.push(`${row.platform.platform} 侧完全未提及：${absent.join("、")}（${stats.answer_count} 条有效回答内）。`);
    }
  }

  // 4. 采集完成率的显著差异
  const lowCompletion = rows.filter((row) =>
    row.platform.runs.assignments > 0
    && row.platform.runs.valid_runs / row.platform.runs.assignments < 0.8);
  if (lowCompletion.length) {
    facts.push(`采集完成率不足 80% 的平台：${lowCompletion
      .map((row) => `${row.platform.platform} ${(row.platform.runs.valid_runs / row.platform.runs.assignments * 100).toFixed(0)}%`)
      .join("，")} —— 相关指标样本更小。`);
  }

  return facts;
}

function actionSection(payload, rows) {
  const blocks = [];
  const brandStats = rows.map((row) => row.platform.brand_mentions).find((s) => s?.available);


  // 数据事实摘要：把报告里最值钱的观察直接摆到行动建议前面。
  //
  // 之前这一节全是流程性建议（"逐条核对来源"、"持续记录阶段"），
  // 而报告本身最有决策价值的观察 —— 哪个平台被谁压制、我的内容在哪弱 ——
  // 一条都没出现在这里。客户读完第 3 节的表格得自己总结，
  // 而多数人不会认真看表。
  //
  // 只陈述事实与差值，不给「该怎么做」的判断 —— 判断归调用方的模型。
  const facts = dataFacts(rows);
  if (facts.length) {
    blocks.push("<div class=\"facts\"><h4>本期值得先看的几点（均为报告内数据，不含推断）</h4><ul>" +
      facts.map((f) => "<li>" + escapeHtml(f) + "</li>").join("") + "</ul></div>");
  }
  // 关于项目品牌（采集期口径）的建议只在**确实没产出竞品数据**时才提。
  //
  // 早期版本只看 payload.target.brand_configured，于是「项目没配 target_brand、
  // 但本次传了竞品」时会同时出现：第 3 节展示思邈棠 71.8%，第 7 节却说
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
  return "<section id=\"sec-07\"><h2>7. 结论与行动建议</h2><div class=\"key\"><p>报告当前只对已采集数据作描述性统计。阶段变化可作为复核线索，不单独证明某次内容动作带来了变化。</p></div><ol class=\"actions\">" +
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
  return "<section id=\"sec-08\"><h2>8. 数据说明</h2>" +
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
  // 侧边目录常驻：左侧固定栏 + 右侧正文。栏宽 232px，正文限宽保证行长可读。
  "body{display:grid;grid-template-columns:232px minmax(0,1fr);align-items:start}",
  "main{max-width:900px;margin:0 auto;padding:32px 24px 64px;width:100%}",
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
  // 侧边栏本体：sticky 顶到视口顶部，高度不超过视口，内部可滚动。
  // top 留 0 而不是留 header 高度 —— 栏里不放 hero，滚到顶就贴边更省空间。
  ".sidenav{position:sticky;top:0;align-self:start;height:100vh;overflow-y:auto;border-right:1px solid var(--line);background:var(--surface);padding:22px 0}",
  ".sidenav-inner{padding:0 16px}",
  ".sidenav-title{font-size:13px;margin:0 0 12px;color:var(--muted);letter-spacing:.06em}",
  // 目录改成竖排：横排的 flex 标签在侧边窄栏里会折成一团，竖排才像目录。
  ".sidenav .toclist{display:flex;flex-direction:column;gap:2px;margin:0}",
  ".sidenav .toclist a{display:block;text-decoration:none;font-size:12.5px;padding:5px 9px;border-radius:6px;color:var(--ink);border-left:2px solid transparent}",
  ".sidenav .toclist a:hover{background:#f2f5fa}",
  // 当前章节高亮：不用 JS。
  //
  // 报告的 artifact_html 是落库快照，完整性校验只保证哈希一致、不保证内容没被改过，
  // 所以这份 HTML 里不能有可执行脚本 —— test/render-hardening.test.mjs 就是钉这一条。
  // 纯 CSS 做不到「滚动到哪一节」，于是改用 :target：点目录项时对应 section 变成
  // 目标，:has() 顺带把对应目录项高亮。拿不到滚动跟随，但零脚本、零注入面。
  ".sidenav .toclist a:active{background:#eef3fb}",
  // :target 高亮规则按章节数生成。写死 11 条时每次加减章节都要同步改这里，
  // 漏一条的表现是「点那一节不高亮」——很不起眼，但每次都在。
  // @supports selector(:has(*)) 包一层：不支持 :has() 的浏览器整块忽略。
  "@supports selector(:has(*){" + SECTION_TITLES.map((_, index) => {
    const n = String(index + 1).padStart(2, "0");
    return "body:has(#sec-" + n + ":target) .toclist a[href='#sec-" + n + "']";
  }).join(",") + "{background:color-mix(in srgb,var(--accent) 9%,white);border-left-color:var(--accent);font-weight:650}}",
  ".sidenav-guides{display:block;margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}",
  ".sidenav-guides div{margin:8px 0}.sidenav-guides strong{color:var(--ink)}",
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
  // 行动建议里的「本期值得先看的几点」：与下面的流程性建议视觉上区分开，
  // 避免客户把它们当成同等性质的建议
  ".facts{border-left:4px solid var(--ok);background:#f4fbf7;padding:12px 14px;border-radius:8px;margin:0 0 14px}" +
  ".facts h4{margin:0 0 8px;font-size:14px;color:var(--ink)}" +
  ".facts ul{margin:0;padding-left:20px}.facts li{margin:4px 0}",
  // 目录里标出「本期未启用」的章节：不标的话读者会以为漏看了内容
  // toc-pending / toc-tag 随「本期未启用」标记一起删除：空占位章移除后
  // 这两个类不再被任何地方使用，留着是误导。
  // 窄屏：侧边栏退回到正文顶部的横排目录。侧栏常驻在小屏上没有意义 ——
  // 它会把本来就窄的正文再切掉 232px。
  "@media(max-width:900px){body{display:block}.sidenav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:16px 0}.sidenav .toclist{flex-direction:row;flex-wrap:wrap;gap:6px 12px}.sidenav .toclist a{padding:4px 8px;border-left:0;border-bottom:2px solid transparent}.sidenav-guides{display:none}main{padding:16px 12px 40px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.grid2,.guide-grid{grid-template-columns:1fr}section{padding:16px}.hero{padding:20px!important}}",
  // 打印：侧边栏整条隐藏 —— 打印时每页都印一份目录毫无意义，还会挤掉正文。
  "@media print{@page{margin:14mm}body{display:block;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}.sidenav{display:none}main{max-width:none;padding:0}section,.subpanel,.card{box-shadow:none;break-inside:avoid;border-color:#d7dce3}a{color:inherit;text-decoration:none}details{break-inside:avoid}details>summary{list-style:none}details:not([open])>*:not(summary){display:block}header.hero{border-color:#d7dce3}.table-wrap{overflow:visible}table{min-width:0;font-size:11px}th,td{padding:6px}}",
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
  const sectionParts = [
    overviewSection(payload, rows),
    findingsSection(payload, rows),
    institutionSection(payload, rows),
    sourcesSection(payload, rows),
    trackedSection(payload, rows),
    questionSection(payload),
    actionSection(payload, rows),
    dataNotesSection(payload, rows),
  ];
  // 章节顺序与 id 必须和 SECTION_TITLES 对得上，对不上直接抛错。
  // 少了这层，目录里点「第 5 节」跳到的会是一节不相干的标题，而报告照常渲染、
  // 照常 http 200 —— 没有任何测试会失败。这正是原来那份手写 11 条目录规则的由来。
  if (sectionParts.length !== SECTION_TITLES.length) {
    throw new Error(
      `章节数量与目录不一致：渲染了 ${sectionParts.length} 节，目录声明 ${SECTION_TITLES.length} 节`,
    );
  }
  sectionParts.forEach((html, index) => {
    const number = String(index + 1).padStart(2, "0");
    if (!html.includes(`<section id="sec-${number}">`)) {
      throw new Error(`第 ${number} 节（${SECTION_TITLES[index]}）的 id 不对，应为 sec-${number}`);
    }
  });
  const sectionHtml = sectionParts.join("");
  const guides = [
    ["只有 1 分钟", "从最重要的发现和行动建议开始。", "#sec-02"],
    ["要决定渠道", "看竞品在各平台的提及差异，再看来源强度。", "#sec-03"],
    ["要核对证据", "打开来源文章链接逐条核对。", "#sec-04"],
    ["要调整内容", "先看目标文章覆盖，再看问题范围。", "#sec-05"],
  ];
  // 目录、正文章节标题、:target 高亮规则三处都从这一份列表派生。
  // 之前目录是一份手写数组、正文是另一组硬编码 id，加减章节要同步改三处 ——
  // 漏改的表现是「点目录跳到错的地方」或「那一节不高亮」，都不会报错。
  const toc = SECTION_TITLES.map((title, index) => {
    const number = String(index + 1).padStart(2, "0");
    return "<a href=\"#sec-" + number + "\">" + number + " " + escapeHtml(title) + "</a>";
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
    "<style>" + css + "</style></head><body>" +
    // 侧边目录常驻：滚动时靠 sticky 固定，读者随时知道自己在第几节、
    // 下面还有没有内容。原先目录是正文顶部一块 flex 标签，滚下去就没了。
    "<aside id=\"toc\" class=\"sidenav\"><div class=\"sidenav-inner\">" +
    "<h2 class=\"sidenav-title\">目录</h2>" +
    "<div class=\"toclist\">" + toc + "</div>" +
    "<div class=\"guide-grid sidenav-guides\">" +
    guides.map(([label, hint, href]) => "<div><strong>" + escapeHtml(label) + "：</strong>" +
      escapeHtml(hint) + " <a href=\"" + href + "\">前往</a></div>").join("") +
    "</div></div></aside>" +
    "<main>" +
    "<header class=\"hero\">" + logoMarkup(theme) +
    "<h1>" + escapeHtml(payload.title) + "</h1>" +
    "<p class=\"muted\">目标：" + escapeHtml(payload.target.name) + " · 平台：" +
    payload.scope.platforms.map(escapeHtml).join("、") + "</p>" +
    "<p class=\"muted\">阶段：" + periodSummary + "</p><p class=\"small\">报告 ID " +
    escapeHtml(payload.report_id) + " · 固定快照版本 " + escapeHtml(payload.schema_version) + "</p></header>" +
    sectionHtml +
    "<footer>" + escapeHtml(footerText(theme, "OneGl · GEO 客户报告")) + " · 快照 " +
    escapeHtml(payload.report_id) + " · 生成时间 " + escapeHtml(payload.generated_at) +
    "</footer></main></body></html>";
}
