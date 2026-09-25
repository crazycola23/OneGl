/**
 * 从千问页面解析引用来源。
 *
 * 关键发现（2026-09-24 深挖）：引用**不是文本，是 favicon 图标**。
 *
 *   已完成分析… 那个出处块不是每条都有；
 *   「N篇来源」只是个计数标签，点不开；
 *   真正承载来源的是 `reference-wrap` 里的一排 `search-icon-item > img`，
 *   每个 img 的 `src` 是「图片代理 URL」，其中 `key=` 参数是 **base64 编码的原始来源 URL**。
 *
 * 例如：
 *   src = "http://s2.zimgs.cn/ims?at=smstruct&kt=url&key=aHR0cHM6Ly9jZG4uc20uY24v...png&sign=..."
 *   key 解 base64 → "https://cdn.sm.cn/temp/20251204...png"
 *   → 域名 cdn.sm.cn
 *
 * 所以抓法不是「点开列表」，而是「读那排 favicon 并解码 key」。
 */

/** 图片代理 URL 里的 base64 载荷参数名。 */
const PROXY_KEY_PARAM = "key";

function safeBase64Decode(value) {
  try {
    // 代理里用的是标准 base64，但可能缺 padding、也可能把 +/ 换成 -_
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * 从一批 img src 里还原来源 URL。
 * 导出是为了单测：解码逻辑一旦错了，抓到的域名就是错的，而错域名比没有域名更糟。
 */
export function decodeProxyImageSources(srcList) {
  const out = [];
  for (const src of srcList ?? []) {
    if (!src) continue;
    let raw = null;
    try {
      raw = new URL(src, "http://x/").searchParams.get(PROXY_KEY_PARAM);
    } catch {
      raw = null;
    }
    const decoded = raw ? safeBase64Decode(raw) : null;
    if (!decoded) continue;
    const host = hostOf(decoded);
    if (!host) continue;
    out.push({ url: decoded, host });
  }
  // 同一域名只留一条（一排图标里常见多个同站来源）
  const seen = new Set();
  return out.filter((item) => {
    if (seen.has(item.host)) return false;
    seen.add(item.host);
    return true;
  });
}

/** 把域名收敛成可读的来源名，供报告展示。 */
export function sourceLabel(host) {
  const text = String(host ?? "").toLowerCase();
  const known = [
    [/dianping/, "大众点评"],
    [/meipian/, "美篇"],
    [/toutiao/, "今日头条"],
    [/people\.cn|people\.com\.cn/, "人民网"],
    [/china\.com\.cn/, "中国网"],
    [/shaoxing\.com\.cn/, "绍兴网"],
    [/39\.net/, "39健康网"],
    [/xywy/, "寻医问药网"],
    [/zhihu/, "知乎"],
    [/xiaohongshu|xhscdn/, "小红书"],
    [/baidu|bdstatic/, "百度"],
    [/sm\.cn|quark/, "夸克/UC"],
    [/alicdn|alibaba/, "阿里"],
    [/meituan/, "美团"],
    [/ctrip/, "携程"],
    [/douyin|bytedance/, "抖音"],
    [/weibo/, "微博"],
  ];
  for (const [pattern, label] of known) {
    if (pattern.test(text)) return label;
  }
  return text;
}
