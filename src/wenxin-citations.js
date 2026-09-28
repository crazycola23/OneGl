/**
 * 文心一言答案与引用的纯解析层。
 *
 * 抽出来是为了能单测：这一层的错误**不会报错**，只会静默产出错数据 ——
 * 采到思考过程当答案、丢掉零宽字符、把 23 条引用解析成 0 条。
 * 跑在 `page.evaluate` 里的代码没法在 Node 里测，而跑在 Node 里的可以。
 *
 * 分工：
 *   - 页面侧（src/wenxin.js 的 readAnswer）只负责**取原始材料**：
 *     答案块原文、每个参考条目的 data 属性与文本、页面自陈的来源数文案。
 *   - 这里负责**解释**这些材料：清洗答案、解析引用、对账数量。
 *
 * 全部取值来自 2026-09-28 在本地 Camoufox 出货引擎上的 14 轮探针，
 * 记录见 `docs/WENXIN_PHASE0.md`。
 */

/**
 * U+200C / U+200D / U+2060 / U+FEFF 等零宽与方向控制字符。
 *
 * 实测文心把每个强调片段都用 U+200C 包起来：答案读回来是
 * `中国的首都是\u200c北京\u200c。` —— 一条 164 字符的答案里有 2 个。
 * 它们在编辑器里和 diff 里都**看不见**，但会破坏后续任何品牌名子串匹配
 * （"小米" ≠ "小‌‌米"），也会让长度统计偏大。所以必须在入库前剥掉。
 */
const INVISIBLE_CHARS = /[‌‍⁠⁡⁢⁣⁤﻿]/g;

/**
 * 平台免责声明。它们独立成行，可以整行去掉。
 *
 * ⚠️ 只整行匹配，**绝不做全局替换**：问「文心一言的免责声明是什么」这类问题，
 * 答案里本来就会出现这句话。全局替换会把答案本身删掉 ——
 * 那是 zhipu 实测踩过的坑（`/ChatGLM/g` 删掉了答案里的产品名），
 * 而它在报告里完全看不出来。
 */
const DISCLAIMER_LINE = /^(?:内容由AI生成[，,]?\s*仅供参考|以上内容为\s*AI\s*生成)/;

/**
 * 参考条目里序号前缀的形态：实测是 `1.` / `2、` / `3)` 三种都出现过。
 * 只在取不到 data 属性里的标题时用它兜底。
 */
const REFERENCE_INDEX = /^\s*\d+[.、)]\s*/;

/**
 * 清洗答案正文。
 *
 * 处理三件事，各有实测理由：
 *  1. 剥掉零宽字符（见 INVISIBLE_CHARS 注释）。
 *  2. 逐行规范空白并丢掉空行 —— 平台把段落渲染成多个 `<p>`，
 *     innerText 里会带大量空行，落库后是一堆空行噪声。
 *  3. 去掉整行的免责声明。
 *
 * 注意这里**不做**的事：不按长度筛选、不取"最长段落"、不做任何内容改写。
 * 那些都会在答案短于页面其它文本时把答案换掉（kianwen/智谱/文心三个平台都因此栽过）。
 */
export function cleanAnswerText(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(INVISIBLE_CHARS, "")
    .split("\n")
    .map((line) => line.replace(/[ \t　]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !DISCLAIMER_LINE.test(line))
    .join("\n")
    .trim();
}

/**
 * 解析一条参考条目。
 *
 * 实测：文心的参考条目**不含任何 `<a>`、没有 href 属性**（22-45 条全是这样，
 * `querySelectorAll("a[href^='http']")` 恒为 0）。真实地址在
 * `data-long-press-ext-info` 的 JSON 里：
 *
 *   data-long-press-ext-info='{"link":"https://paper.people.com.cn/rmrbhwb/images/2023-12/20/12/rmrbhwb2023122012.pdf",
 *                              "linkTitle":"\"数\"说 2023 中国旅游-人民网",
 *                              "logInfo":{"longpress_content":"thinkinglink"}}'
 *
 * 这是文心与智谱的关键区别：智谱是**裸域名角标**（url 只能是域名根占位），
 * 文心是**完整可回查 URL**。
 *
 * 为什么必须拿到真实 url：`db/persist.js` 的 prepareCitations 会把缺 url 的引用
 * 整条 skip（reason=missing-url）。只找 `<a>` 的后果是「平台自陈 23 篇资料、
 * 库里一条都没有」，而报告仍会显示"引用了 23 个来源" —— 这是最坏的形态：
 * 一个没人能回查的数字。
 *
 * @param {{extInfo?: string|null, text?: string}} item 页面侧取到的原始材料
 * @returns {{url: string, title: string|null, domain: string|null, sourceType: string,
 *            capturedFrom: string, citationMarker: null}|null}
 *          没有可解析的链接时返回 null（**不是**造一条占位引用）
 */
export function parseReferenceItem(item) {
  const raw = typeof item?.extInfo === "string" ? item.extInfo : "";
  if (!raw) return null;

  let info = null;
  try {
    info = JSON.parse(raw);
  } catch {
    // 平台偶尔会改这个属性的结构。解析不了就如实丢掉这一条，
    // 下游按"少了几条"处理；伪造一条 url 为空的引用只会被 persist 再丢一次。
    return null;
  }

  const link = typeof info?.link === "string" ? info.link.trim() : "";
  if (!link || !/^https?:\/\//i.test(link)) return null;

  const declaredTitle = typeof info?.linkTitle === "string" ? info.linkTitle.trim() : "";
  const fallback = cleanAnswerText(typeof item?.text === "string" ? item.text : "")
    .replace(REFERENCE_INDEX, "")
    .trim();
  const title = declaredTitle || fallback.slice(0, 200) || null;

  let domain = null;
  try {
    domain = new URL(link).hostname;
  } catch {
    domain = null;
  }

  return {
    url: link,
    title,
    domain,
    sourceType: "visible",
    // 这些链接在页面上是**长按才出现**的菜单项，不是可点的 <a>。标注来源形态，
    // 让下游知道它们是"页面自己渲染出来的来源入口"而不是我们点出来的。
    capturedFrom: "参考资料列表",
    citationMarker: null,
  };
}

/**
 * 解析整份参考列表，去掉解析不出来的条目。
 *
 * 去重按 url：实测同一篇文章可能既出现在参考列表里、又作为答案里的内联链接出现，
 * 重复计入会让引用数虚高。
 */
export function parseReferenceItems(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const citation = parseReferenceItem(item);
    if (!citation) continue;
    if (seen.has(citation.url)) continue;
    seen.add(citation.url);
    out.push(citation);
  }
  return out;
}

/**
 * 平台自陈的来源数。
 *
 * 实测两种文案，数字一致：
 *   「搜索3个关键词 共参考22篇资料」
 *   「搜索全网22篇资料」
 *
 * 这个数字是**对账基准**，不是采到的条数：两者不等说明有来源没解析出来，
 * 下游据此标 partial，而不是悄悄按抓到的数量出数。
 *
 * ⚠️ 千问与文心的文案不同（千问是「已完成分析，共参考 15 篇资料」），
 * 这里的正则只认实测到的两种 —— 别把它当成通用中文匹配。
 *
 * @returns {number|null} 没观测到自陈数时返回 null，不返回 0
 */
export function parseSelfReportedSourceCount(bodyText) {
  if (typeof bodyText !== "string") return null;
  const m = bodyText.match(/(?:共参考|搜索全网)\s*(\d+)\s*篇资料/);
  return m ? Number(m[1]) : null;
}

/**
 * 引用与自陈数的对账结论。
 *
 * 区分三种情况，因为它们对报告的含义完全不同：
 *   - 一条都没抓到，但平台说它参考了 N 篇 → 抓取侧失真，标 `wenxin-no-visible-sources`
 *   - 抓到的条数与 N 不等 → 标 `wenxin-source-count-mismatch`（可能少解析了）
 *   - 相等 → 没有诊断标记
 *
 * 平台**没**自陈数时不做对账：那是「没观测到」而不是「相等」。
 */
export function citationDiagnostics({ captured, selfReported }) {
  if (captured === 0) return ["wenxin-no-visible-sources"];
  if (selfReported != null && captured !== selfReported) {
    return ["wenxin-source-count-mismatch"];
  }
  return [];
}
