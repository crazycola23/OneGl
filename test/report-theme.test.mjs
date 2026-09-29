import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTheme, themeCss, footerText, DEFAULT_COLORS } from "../src/report/report-theme.js";

/**
 * 主题定制的输入校验。
 *
 * 主题值会进入 HTML 的 <style> 标签，是这份报告里唯一「原始文本进 style」的路径，
 * 所以校验必须是白名单而不是黑名单。早期版本只判断值是不是 hex，
 * 但没限制「哪些键可以改」——那样调用方能覆盖任意 CSS 变量。
 */

test("接受合法颜色并保持原样", () => {
  const t = normalizeTheme({ colors: { accent: "#c2410c", ink: "#abc" } });
  assert.equal(t.colors.accent, "#c2410c");
  assert.equal(t.colors.ink, "#abc", "三位 hex 也是合法颜色");
});

test("丢弃非法颜色而不是让报告生成失败", () => {
  const t = normalizeTheme({
    colors: {
      accent: "red;}body{display:none",
      ink: "expression(alert(1))",
      bg: "#12345",
      surface: "not-a-color",
    },
  });
  // 客户报告因为一个颜色写错就生成不出来是很糟的体验
  assert.equal(t, null, "全部非法时整体回落默认主题");
  assert.ok(!themeCss(t), "不产生任何 CSS 覆盖");
});

test("部分非法时只保留合法的那些", () => {
  const t = normalizeTheme({ colors: { accent: "#111111", bg: "bogus" } });
  assert.deepEqual(t.colors, { accent: "#111111" });
});

test("颜色键是白名单：未列出的键被丢弃", () => {
  const t = normalizeTheme({ colors: { accent: "#111111", "--evil": "#000000", position: "fixed" } });
  assert.deepEqual(Object.keys(t.colors), ["accent"], "只有白名单内的键被保留");
  assert.ok(!themeCss(t).includes("--evil"), "CSS 输出里不能出现未授权变量");
});

test("允许覆盖的键就是默认色板那些，且与 OpenAPI 契约一致", async () => {
  // 注意嵌套层级：颜色在 colors 之下，与契约 GeoCustomerReportCreate.theme.colors 一致
  const t = normalizeTheme({
    colors: Object.fromEntries(Object.keys(DEFAULT_COLORS).map((k) => [k, "#010203"])),
  });
  assert.ok(t?.colors, "全部默认键都应被接受");
  assert.deepEqual(
    Object.keys(t.colors).sort(),
    Object.keys(DEFAULT_COLORS).sort(),
    "默认色板里的每个键都应可覆盖",
  );

  // 契约里 ReportTheme.colors 的属性集合必须与实现的白名单一致，
  // 否则调用方按文档传了某个键会被静默丢弃。
  // 读已生成的 openapi.json 而不是 buildOpenApiDocument()：后者返回的是
  // 惰性骨架，schemas 要等 apply 之后才填充。
  const { readFileSync } = await import("node:fs");
  const doc = JSON.parse(
    readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
  );
  const contractKeys = Object.keys(
    doc.components.schemas.ReportTheme?.properties?.colors?.properties ?? {},
  ).sort();
  assert.deepEqual(
    contractKeys,
    Object.keys(DEFAULT_COLORS).sort(),
    "OpenAPI 声明的可覆盖颜色键与实现一致",
  );
});

test("logo 只接受 http(s)", () => {
  assert.equal(normalizeTheme({ logo_url: "https://cdn.example.com/l.png" }).logo_url,
    "https://cdn.example.com/l.png");
  assert.equal(normalizeTheme({ logo_url: "http://cdn.example.com/l.png" }).logo_url,
    "http://cdn.example.com/l.png");
  // javascript: / data: 会变成可执行的 URL，必须拒绝
  assert.equal(normalizeTheme({ logo_url: "javascript:alert(1)" }), null);
  assert.equal(normalizeTheme({ logo_url: "data:text/html,<script>x</script>" }), null);
  assert.equal(normalizeTheme({ logo_url: "  " }), null);
});

test("logo 尺寸非法时回落默认，超大值不被采纳", () => {
  // 99999 是明显的笔误，回落默认比夹到上限更合理：
  // 调用方以为自己要的是 64px，实际渲染出来会莫名变大。
  const t = normalizeTheme({ logo_url: "https://a.example/l.png", logo_height: 99999, logo_width: 99999 });
  assert.equal(t.logo_height, 40, "非法高度回落默认 40");
  assert.equal(t.logo_width, null, "非法宽度不设置");

  const valid = normalizeTheme({ logo_url: "https://a.example/l.png", logo_height: 48, logo_width: 200 });
  assert.equal(valid.logo_height, 48);
  assert.equal(valid.logo_width, 200);
});

test("页脚文本限长并保留原文", () => {
  assert.equal(normalizeTheme({ footer_text: "某某数字营销" }).footer_text, "某某数字营销");
  assert.equal(normalizeTheme({ footer_text: "x".repeat(500) }), null, "超长被丢弃 → 回落默认主题");
  assert.equal(normalizeTheme({ footer_text: "   " }), null, "纯空白视为未提供");
});

test("非对象输入安全降级", () => {
  for (const bad of [null, undefined, "string", 42, [1, 2]]) {
    assert.equal(normalizeTheme(bad), null, `${JSON.stringify(bad)} 应返回 null`);
  }
});

test("themeCss 只输出变量覆盖，不含布局规则", () => {
  const css = themeCss(normalizeTheme({ colors: { accent: "#c2410c" } }));
  assert.equal(css, ":root{--accent:#c2410c}");
  assert.ok(!css.includes("body"), "不应能注入布局规则");
  assert.equal(themeCss(null), "", "无主题时不输出任何 CSS");
});

test("footerText 有主题用主题的，没有用默认", () => {
  const t = normalizeTheme({ footer_text: "客户品牌" });
  assert.equal(footerText(t, "OneGl"), "客户品牌");
  assert.equal(footerText(null, "OneGl"), "OneGl");
  assert.equal(footerText({}, "OneGl"), "OneGl", "空主题也应回落默认");
});
