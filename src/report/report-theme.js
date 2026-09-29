/**
 * 报告主题定制。
 *
 * ## 为什么需要
 *
 * 报告是要交给客户看的，但生成的 HTML 永远是「OneGl 味」的：固定的蓝色主色、
 * 固定页脚 `OneGl · GEO 客户报告`。GEO 平台想出一份带自己品牌色的客户报告，
 * 以前只有两条路：要么将就，要么自己在 GEO 侧用 snapshot JSON 重写一套模板。
 * 后者意味着 OneGl 精心做的排版、响应式、打印样式全部作废。
 *
 * 所以把「能变的部分」显式开出来：主色、页脚署名、logo、标题后缀。
 * 排版结构不变 —— 它是 OneGl 的专业性所在，不该被主题参数搅乱。
 *
 * ## 安全边界
 *
 * 所有值都进入 HTML，必须防注入：
 *   - 颜色：只接受 #rgb / #rrggbb，其余丢弃并回落默认。CSS 变量注入是
 *     报告里唯一的「原始文本进 style 标签」路径，严格白名单。
 *   - 文本：走 escapeHtml。
 *   - logo：必须是 http(s) URL（safeUrl 同样拒绝 javascript:），
 *     且协议/格式校验失败时静默不渲染，不留破图。
 */

/** 默认色板。主题只覆盖这里列出的键，其余保持默认。 */
export const DEFAULT_COLORS = Object.freeze({
  accent: "#2563eb",
  ink: "#1a2130",
  bg: "#f7f8fa",
  surface: "#ffffff",
  line: "#e6e8ec",
  ok: "#0e9f6e",
  warn: "#d97706",
  bad: "#dc2626",
});

/** 允许覆盖的颜色键 —— 白名单，不是黑名单：新增变量时必须显式放行。 */
const ALLOWED_COLOR_KEYS = Object.freeze(Object.keys(DEFAULT_COLORS));

/** logo 最大尺寸（像素）。不设上限的话，一个 4000px 的图会撑爆版面。 */
const MAX_LOGO_HEIGHT = 64;
const MAX_LOGO_WIDTH = 320;

const HEX3 = /^#[0-9a-f]{3}$/i;
const HEX6 = /^#[0-9a-f]{6}$/i;

function isHexColor(value) {
  const text = String(value ?? "").trim();
  return HEX3.test(text) || HEX6.test(text);
}

function isPositiveInt(value, max) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= max;
}

/**
 * 归一化主题输入。
 *
 * 非法值一律丢弃而不是报错：报告生成不该因为一个颜色写错就失败。
 * 全部非法时返回 null，表示「用默认主题」。
 */
export function normalizeTheme(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out = {};

  if (input.colors && typeof input.colors === "object" && !Array.isArray(input.colors)) {
    const colors = {};
    for (const key of ALLOWED_COLOR_KEYS) {
      const value = input.colors[key];
      if (isHexColor(value)) colors[key] = String(value).trim();
    }
    if (Object.keys(colors).length) out.colors = colors;
  }

  // footer 署名：纯文本，交给 escapeHtml
  if (typeof input.footer_text === "string" && input.footer_text.trim()) {
    const text = input.footer_text.trim();
    if (text.length <= 200) out.footer_text = text;
  }

  // logo：只接受 http(s)，且尺寸需在合理范围内
  if (typeof input.logo_url === "string" && input.logo_url.trim()) {
    const url = input.logo_url.trim();
    if (/^https?:\/\//i.test(url) && url.length <= 2048) {
      out.logo_url = url;
      const h = Number(input.logo_height);
      const w = Number(input.logo_width);
      out.logo_height = isPositiveInt(h, MAX_LOGO_HEIGHT) ? h : 40;
      out.logo_width = isPositiveInt(w, MAX_LOGO_WIDTH) ? w : null;
    }
  }

  return Object.keys(out).length ? out : null;
}

/**
 * 生成主题 CSS。
 *
 * 只输出变量覆盖，不输出任何布局规则 —— 布局是 OneGl 的专业性所在。
 * 放在 CSS 常量之后注入，靠 CSS 层叠的「后者胜」生效。
 *
 * ## 这里为什么再校验一次
 *
 * 正常路径下 theme 已经过 normalizeTheme，但渲染层是最后一道防线：
 *   - artifact_html 是生成时渲染并存进快照的，渲染时的 payload 来自数据库
 *   - assertSnapshotIntegrity 只校验哈希，不校验字段取值是否合法
 *   - 哈希一致但内容危险是可能的（有人直接改库后重算哈希）
 *
 * 所以这里不信任入参，重新跑一遍 normalizeTheme。
 * 多一次字符串检查的成本，远低于把原始文本拼进 <style> 的后果。
 */
export function themeCss(theme) {
  const safe = normalizeTheme(theme);
  if (!safe) return "";
  const declarations = [];
  for (const [key, value] of Object.entries(safe.colors ?? {})) {
    // 二次确认：normalizeTheme 已保证是白名单键 + hex 色，这里是防御性断言
    if (!ALLOWED_COLOR_KEYS.includes(key)) continue;
    if (!isHexColor(value)) continue;
    declarations.push(`--${key}:${String(value).trim()}`);
  }
  return declarations.length ? `:root{${declarations.join(";")}}` : "";
}

/**
 * 默认页脚署名。传了 footer_text 就用客户的，否则用 OneGl 的。
 *
 * 同样重新归一化：渲染层的入参来自数据库快照，不能因为「正常路径下
 * 已经校验过」就省掉。调用方随后会做 escapeHtml，这里只保证取值合法。
 */
export function footerText(theme, defaultText) {
  const safe = normalizeTheme(theme);
  return safe?.footer_text ?? defaultText;
}
