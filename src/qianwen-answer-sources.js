/**
 * 从千问的答案文本里解析出处块。
 *
 * 为什么走文本而不是 DOM：2026-09-24 实测确认，千问改版后页面上**已经没有**采集器依赖的
 * 汇总卡（`data-card_name="bar_workflow"` 元素计数为 0），来源链接也不以 `<a>` 形式存在，
 * 页面上只剩一个「10篇来源」的折叠提示。也就是说 DOM 这条路当前拿不到引用 ——
 * 而**平台自述的出处块完整地写进了答案文本**：
 *
 *   已完成分析，共参考 15 篇资料
 *   搜索 2 个关键词，参考 15 篇资料
 *   "绍兴越城区口碑好的推拿店推荐" "绍兴越城区推拿店手法和价格对比"
 *   禅悦汇足道（越城店）60号服务好-大众点评 坐标绍兴！是懂年轻人的中式调理馆-大众点评
 *   爱美的花花在护肤的美篇 … 查看全部
 *   越城区口碑好的推拿店，按手法与价格可以这样比：      ← 正文从这里开始
 *
 * 两边各有一个稳定标记（开头「已完成分析」，结尾「查看全部」），所以切出来是可靠的；
 * 而正文里那些**带完整 URL 的行**（`标题 | https://…`）也一并收集 —— 那是真的可点击来源，
 * 只是不经过 DOM。
 *
 * 效率上这是零成本的：答案本来就已经采到了，解析纯本地字符串运算，不额外访问页面。
 */

/** 出处块的结束标记。出现它说明来源列表到此为止，后面就是正文。 */
const SOURCE_BLOCK_END_MARKERS = ["查看全部", "收起", "展开全部"];

/** 出处块的开头标记。命中它才说明这段文本是出处块，避免把正文误判成来源。 */
const SOURCE_BLOCK_START_PATTERN = /已完成分析|共参考\s*\d+\s*篇|搜索\s*\d+\s*个关键词/;

/** 引用行里带完整 URL 的形态：`标题 | https://…` 或 `标题 https://…`。 */
const URL_LINE_PATTERN = /(https?:\/\/[^\s|）)】\]]+)/g;

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 解析答案文本里的出处块。
 *
 * @returns {{found: boolean, sourceCount: number|null, keywords: string[], titles: string[], urls: string[], raw: string|null}}
 */
export function parseAnswerSources(answer) {
  const text = normalize(answer);
  const empty = { found: false, sourceCount: null, keywords: [], titles: [], urls: [], raw: null };
  if (!text) return empty;

  // 中文数字也要认：页面上出现过「十篇来源」这类写法。
  const countMatch = text.match(/共参考\s*([0-9零一二三四五六七八九十百]+)\s*篇资料/);
  const sourceCount = countMatch ? toNumber(countMatch[1]) : null;

  if (!SOURCE_BLOCK_START_PATTERN.test(text.slice(0, 200))) {
    // 没有出处块的开头标记：正文里仍可能有带 URL 的引用行，顺手收集但不当作出处块。
    const urls = [...new Set(text.match(URL_LINE_PATTERN) ?? [])];
    return { ...empty, urls };
  }

  const start = text.search(SOURCE_BLOCK_START_PATTERN);
  let body = text.slice(start);

  // 切到结束标记（没有标记时退化为「首段」——出处块总是在第一段里）。
  let end = body.length;
  for (const marker of SOURCE_BLOCK_END_MARKERS) {
    const at = body.indexOf(marker);
    if (at >= 0 && at < end) end = at + marker.length;
  }
  if (end === body.length) {
    const firstBreak = body.indexOf("\n");
    end = firstBreak > 0 ? firstBreak : Math.min(body.length, 600);
  }
  const raw = body.slice(0, end);

  // 关键词：出处块里被双引号包起来的那些
  const keywords = [...new Set([...raw.matchAll(/"([^"]{2,60})"/g)].map((m) => normalize(m[1])))];

  // 来源标题：去掉关键词、计数文案、结束标记之后剩下的片段。
  // 按「媒体后缀」切分 —— 千问的来源标题几乎都带平台名（-大众点评 / 的美篇 / _绍兴网 等）。
  const titles = extractTitles(raw, keywords);

  const urls = [...new Set(raw.match(URL_LINE_PATTERN) ?? [])];

  return { found: true, sourceCount, keywords, titles, urls, raw };
}

function extractTitles(raw, keywords) {
  let rest = raw;
  for (const keyword of keywords) rest = rest.replaceAll(`"${keyword}"`, " ");
  rest = rest
    .replace(/已完成分析/g, " ")
    .replace(/共参考\s*[0-9零一二三四五六七八九十百]+\s*篇资料/g, " ")
    .replace(/搜索\s*[0-9零一二三四五六七八九十百]+\s*个关键词[，,、]?/g, " ")
    .replace(/参考\s*[0-9零一二三四五六七八九十百]+\s*篇资料/g, " ")
    .replace(/查看全部|收起|展开全部/g, " ")
    .replace(URL_LINE_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!rest) return [];

  // 来源标题之间没有分隔符，只能按「媒体名后缀」切开。这些后缀是实测观察到的形态：
  //   「…-大众点评」「…的美篇」「…_绍兴网」「…--人民网」…
  const MEDIA_SUFFIX = /(?:-|–|—|_|--)?(?:大众点评|美篇|绍兴网|人民网|中国网|今日头条|头条|39健康网|寻医问药网|丁香园|知乎|小红书|百家号|搜狐|网易|腾讯|新浪|美团|夸克|百度|微博|bilibili|哔哩哔哩|携程|蚂蜂窝)/g;

  const marks = [...rest.matchAll(MEDIA_SUFFIX)].map((m) => m.index + m[0].length);
  if (marks.length === 0) {
    return rest.length > 0 && rest.length < 200 ? [rest] : [];
  }

  const titles = [];
  let cursor = 0;
  for (const mark of marks) {
    const piece = normalize(rest.slice(cursor, mark));
    if (piece.length >= 4) titles.push(piece);
    cursor = mark;
  }
  const tail = normalize(rest.slice(cursor));
  if (tail.length >= 6) titles.push(tail);

  // 去掉纯平台名（没有标题内容的片段）与重复项
  return [...new Set(titles.filter((t) => t.length >= 4 && !/^(?:-|–|—|_)?(?:大众点评|美篇|绍兴网)$/.test(t)))];
}

function toNumber(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === "十") return 10;
  if (text.startsWith("十")) return 10 + (digits[text[1]] ?? 0);
  if (text.endsWith("十")) return (digits[text[0]] ?? 0) * 10;
  if (/^[零一二三四五六七八九]十[零一二三四五六七八九]$/.test(text)) {
    return (digits[text[0]] ?? 0) * 10 + (digits[text[2]] ?? 0);
  }
  return null;
}
