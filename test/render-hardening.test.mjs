import assert from "node:assert/strict";
import test from "node:test";

import { footerText, normalizeTheme, themeCss } from "../src/report/report-theme.js";
import { buildGeoCustomerReportHtml } from "../src/report/html-geo-customer.js";

/**
 * 渲染层不信任入参。
 *
 * 正常路径下 theme 已经过 normalizeTheme，但渲染时的 payload 来自数据库
 * 快照，而 assertSnapshotIntegrity 只保证哈希一致 —— 哈希一致而内容危险
 * 是可能的（直接改库后重算哈希）。
 *
 * 所以 themeCss / logoMarkup / footerText 三个出口都重新跑一遍归一化。
 * 这些函数是「原始文本进 HTML」的唯一路径，多一次字符串检查的成本，
 * 远低于把 `red;}body{display:none` 拼进 <style> 的后果。
 */

/**
 * 最小可渲染 payload。
 *
 * 结构照抄真实报告的 payload（用无数据的一次生成导出后看的字段表），
 * 而不是手写猜字段 —— 第一版手写漏了 source_batches / excluded_batches，
 * 渲染时直接 TypeError。字段齐全比字段精简重要：这里是渲染层的冒烟测试。
 */
function payload(theme) {
  const period = {
    key: "p", label: "阶段", from: "2026-01-01", to: "2026-01-02",
    time_zone: "Asia/Shanghai",
    source_batches: [], excluded_batches: [],
  };
  return {
    schema_version: "geo-customer-report.v1",
    report_id: "rpt_test",
    scope_kind: "group",
    task_id: null,
    group_id: "grp_test",
    title: "测试报告",
    generated_at: "2026-01-01T00:00:00.000Z",
    target: { name: "测试目标" },
    theme,
    scope: { platforms: ["qianwen"], periods: [period], brands: [] },
    profile: { version: "v1", platform_colors: { qianwen: "#2563eb" } },
    periods: [{
      ...period,
      platforms: [{
        platform: "qianwen",
        color: "#2563eb",
        runs: {
          runs: 0, assignments: 0, valid_runs: 0, partial_runs: 0, failed_runs: 0,
          reset_unconfirmed_runs: 0, success_rate: null, answers_with_text: 0,
          average_answer_characters: null, brand_mentioned_runs: 0,
          brand_mention_rate: null, citation_valid_runs: 0,
        },
        citations: {
          citation_valid_runs: 0, visible_citations: 0, content_citations: 0,
          icon_citations: 0, unique_domains: 0, unique_articles: 0,
          top_domains: [], top_articles: [],
          tracked_content: {
            configured: false, configured_articles: 0, articles: [],
            cited_articles: null, citations: null, covered_runs: null,
            coverage_rate: null, article_coverage_rate: null, truncated: false,
          },
        },
        questions: [], answers: [], brand_mentions: null,
      }],
    }],
    methodology: {},
    warnings: [],
  };
}

test("themeCss 拒绝非法颜色，即使入参绕过了 normalizeTheme", () => {
  // 模拟「快照里的 theme 未经校验」的情形
  const hostile = { colors: { accent: "red;}body{display:none;color:blue" } };
  const css = themeCss(hostile);
  assert.ok(!css.includes("display:none"), "CSS 注入必须被挡住");
  assert.ok(!css.includes("red;"), "非法颜色不应出现在输出里");
});

test("themeCss 只输出白名单内的变量", () => {
  const css = themeCss({ colors: { accent: "#111111", "--evil": "#000", position: "fixed" } });
  assert.equal(css, ":root{--accent:#111111}");
});

test("logoMarkup 拒绝非 http(s) 协议", () => {
  const html = buildGeoCustomerReportHtml(payload({ logo_url: "javascript:alert(1)" }));
  assert.ok(!html.includes("javascript:"), "javascript: 协议必须被拒");
  assert.ok(!/<img[^>]*brand-logo/i.test(html), "非法 logo 不应渲染出 img 标签");
});

test("logoMarkup 拒绝 data: 协议", () => {
  const html = buildGeoCustomerReportHtml(payload({ logo_url: "data:text/html,<script>alert(1)</script>" }));
  assert.ok(!/src="data:/i.test(html), "data: 协议必须被拒");
});

test("logo 尺寸异常时回落默认，不采纳", () => {
  const html = buildGeoCustomerReportHtml(payload({ logo_url: "https://a.example/l.png", logo_height: 99999 }));
  const m = html.match(/<img class="brand-logo"[^>]*height="(\d+)"/);
  assert.ok(m, "合法 logo 仍应渲染");
  assert.ok(Number(m[1]) <= 64, `height 应被夹到 64 以内，实际 ${m[1]}`);
});

test("页脚署名回显，非法值回退默认", () => {
  assert.equal(footerText({ footer_text: "客户署名" }, "默认"), "客户署名");
  // 超长不应被采纳
  assert.equal(footerText({ footer_text: "x".repeat(500) }, "默认"), "默认");
  assert.equal(footerText(null, "默认"), "默认");
  assert.equal(footerText({}, "默认"), "默认");
});

test("页脚里的 HTML 在最终文档里被转义", () => {
  const html = buildGeoCustomerReportHtml(payload({ footer_text: "<b>粗体</b>" }));
  const m = html.match(/<footer>(.*?) · 快照/s);
  assert.ok(m, "应能定位到页脚");
  assert.ok(!m[1].includes("<b>"), "页脚里不应出现未转义的标签");
  assert.ok(m[1].includes("&lt;b&gt;"), "应转义成实体");
});

test("整体渲染：恶意 theme 不会在文档里留下可执行内容", () => {
  const html = buildGeoCustomerReportHtml(payload({
    colors: { accent: "}body{display:none" },
    logo_url: "javascript:alert(1)",
    footer_text: "<script>alert(1)</script>",
  }));
  // 检测口径要正确：把 &lt;script&gt; 还原后再找 <script> 是自欺欺人 ——
  // 正确转义恰好就产生这个形态。这个坑我踩过一次。
  //
  // 浏览器真正会执行的是：**未转义的**标签与事件处理器属性。
  // 文本节点里的 "<script>" 字面量是安全的（显示为文字，不执行）。
  const styleBlock = html.slice(0, html.indexOf("</style>"));
  // display:none 的检测必须区分「谁写的」。
  // 渲染器自己的响应式规则里就有 display:none（窄屏时收起侧边栏的辅助区），
  // 那是正常写法；恶意 theme 注入的 display:none 会让**正文**整段消失。
  // 判据：正文容器（body / main / section / table / .hero）被隐藏才算注入。
  // 早期版本只判 "有没有 display:none"，结果加个正常的响应式规则就被判失败。
  const hideMainContent = /(?:^|[};{])\s*(?:body|main|section|table|\.hero)\s*\{[^}]*display\s*:\s*none/i
    .test(styleBlock);
  const problems = [
    ["未转义的 script 标签", /<script[\s>]/i.test(html)],
    ["未转义的 iframe/object", /<(iframe|object|embed)[\s>]/i.test(html)],
    ["事件处理器属性", /\son(?:error|load|click|mouseover)\s*=/i.test(html)],
    ["javascript: 协议", /javascript:/i.test(html)],
    ["style 里隐藏正文", hideMainContent],
  ].filter(([, hit]) => hit);

  assert.deepEqual(problems, [], `发现可执行内容: ${problems.map(([n]) => n).join(", ")}`);
});

test("恶意 theme 的 accent 注入确实会被挡住（防止上面的检测被改成永远通过）", () => {
  const evil = buildGeoCustomerReportHtml(payload({
    colors: { accent: "}body{display:none" },
  }));
  const styleBlock = evil.slice(0, evil.indexOf("</style>"));
  // 注入的原始形态应当在 CSS 里被截断或转义 —— 无论最终是「没有 display:none」
  // 还是「theme 整段被丢弃」，都不能让 body 真的被隐藏。
  assert.ok(
    !/(?:^|[};{])\s*body\s*\{[^}]*display\s*:\s*none/i.test(styleBlock),
    "accent 里的 }body{display:none 不得生效",
  );
});

test("页脚里的 script 字面量以文本形式呈现而非被执行", () => {
  const html = buildGeoCustomerReportHtml(payload({ footer_text: "<script>alert(1)</script>" }));
  assert.ok(html.includes("&lt;script&gt;"), "应转义为实体");
  // 关键：转义后的文本里不应出现「真实的标签开始」—— 那才是可执行的
  const footerStart = html.indexOf("<footer>");
  const footerEnd = html.indexOf("</footer>");
  const footer = html.slice(footerStart, footerEnd);
  assert.ok(!/<script/i.test(footer), "页脚内不应有未转义的 script 标签");
  assert.ok(footer.includes("&lt;script&gt;"), "但应保留这段文字本身");
});

test("合法主题仍正常生效（防御不能误伤）", () => {
  const html = buildGeoCustomerReportHtml(payload({
    colors: { accent: "#0f766e" },
    logo_url: "https://cdn.example.com/logo.png",
    footer_text: "某某数字营销",
  }));
  assert.ok(html.includes("--accent:#0f766e"), "合法主色应生效");
  assert.ok(html.includes("cdn.example.com/logo.png"), "合法 logo 应渲染");
  assert.ok(html.includes("某某数字营销"), "合法署名应生效");
});
