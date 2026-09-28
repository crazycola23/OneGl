/**
 * 文本切片工具。
 *
 * ## 为什么不能直接用 String.prototype.slice
 *
 * JS 的字符串按 UTF-16 码元存储，slice 从码元边界切。而 AI 回答里大量使用
 * emoji（🔗 📍 ✅ 🏥 🥇），它们由**代理对**表示（U+D83D U+DC17 这样的两个码元）。
 * 从中间切断会产生**孤立代理项** —— 一个没有配对伙伴的 U+D83D。
 *
 * 后果不是显示乱码，而是那条字符串不再是合法 JSON：
 * `JSON.stringify` 不会报错（它照样输出），但 PostgreSQL 解析 jsonb 时会报
 * `invalid input syntax for type json`。报错发生在入库那一刻，而真正的错误
 * 在几百行之前的某次切片，排查成本极高。
 *
 * 所以任何从 AI 回答里截取、且要存进 jsonb 或拼进 HTML 的文本，都必须走 safeSlice。
 */

/**
 * 按码元区间切片，并修掉切出来的非法字符。
 *
 * @param {unknown} value
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
export function safeSlice(value, start, end) {
  let out = String(value ?? "").slice(start, end);
  // 孤立的高代理项：后面没跟低代理项
  out = out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
  // 孤立的低代理项：前面没跟高代理项
  out = out.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  // 控制字符（保留制表符、换行、回车：它们在 HTML 渲染里有意义）
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  return out;
}

/** 以中心点为中心取一段上下文，两侧各 radius 个码元。 */
export function safeContext(text, position, length, radius) {
  return safeSlice(text, Math.max(0, position - radius), Math.min(String(text ?? "").length, position + length + radius));
}

/** 判断字符串里是否残留孤立代理项（测试与自检用）。 */
export function hasLoneSurrogate(value) {
  const text = String(value ?? "");
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text) || /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}
