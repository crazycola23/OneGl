/**
 * 全屏推广浮层的判据 —— 锁住两次修正。
 *
 * 第一次（2026-10-06 早）：原实现遍历 `[role="dialog"]`，而实测弹窗主体
 * 没有这个角色（role=dialog 全页仅 1 处、aria-modal 为 0），主体是
 * `dialogContent-*`、遮罩是 `dialogOverlay-*`，两层都不是。首选的
 * `dialog-close` 在页面上出现 0 次 —— 于是这个函数从写下来那天起就没生效过。
 *
 * 第二次（同日）：改成按推广文案判之后仍然漏。**同一个全屏弹窗的按钮文案
 * 在不同实验分组下不一样** —— run_b5_i5 的截图是「下载豆包工作」，
 * run_b5_i3 是「领30天订阅」。按「下载豆包电脑版」匹配会漏掉其中一组，
 * 而漏掉的那一组正好盖住 composer。
 *
 * 所以最终判据是**结构 + 几何**，不依赖任何具体文案：
 *   1. 存在带 dialogOverlay-/dialogContent-/dialogMask-/fullscreenPopup-
 *      这些 class 前缀的节点（hash 后缀随构建变，只匹配前缀）
 *   2. 它的矩形面积 ≥ 视口面积的 70%（全屏特征，实测 h-full w-full）
 *   3. 并且 composer 中心的 elementFromPoint 不是 composer 本身
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");

test("判据用结构+几何，不能靠文案（按钮文案随实验分组变）", () => {
  assert.match(
    source,
    /async function inspectFullscreenCover/,
    "应有独立的浮层探测函数",
  );
  const start = source.indexOf("async function inspectFullscreenCover");
  const body = source.slice(start, source.indexOf("\n}", start));

  // 几何判据：面积阈值 + 命中测试
  assert.match(body, /viewportArea \* 0\.7/, "应有面积阈值（≥70% 视口）来判「全屏」");
  assert.match(body, /elementFromPoint/, "应有命中测试 —— 「它盖住了 composer」的硬证据");
  assert.match(body, /covered/, "应输出 covered");

  // class 前缀匹配（hash 后缀会变，不能整名匹配）
  assert.match(source, /dialogOverlay-/, "应按 class 前缀匹配浮层");
  assert.match(source, /fullscreenPopup-/, "应包含 fullscreenPopup- 前缀");
});

test("文案只能作附加判据，不能是唯一依据", () => {
  const start = source.indexOf("async function inspectFullscreenCover");
  const body = source.slice(start, source.indexOf("\n}", start));

  // 存在文案匹配（作为 textMatched 辅助信号）…
  assert.match(body, /textMatched/, "应把文案匹配作为单独字段输出");
  // …但存在性判据不依赖它
  assert.doesNotMatch(
    body,
    /if\s*\(\s*!?\s*textMatched\s*\)\s*return/,
    "存在性不能由 textMatched 单独决定",
  );
});

test("dismissPromoDialog 的判据与探测函数一致，不再用文案正则", () => {
  const start = source.indexOf("async function dismissPromoDialog");
  const body = source.slice(start, source.indexOf("\n}", start));
  // 去掉注释行再断言 —— 函数体里那句「详见 PROMO_DIALOG_TEXT」是注释，不是依赖
  const code = body
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  assert.match(code, /inspectFullscreenCover/, "关闭前后都应用结构+几何判据");
  assert.doesNotMatch(
    code,
    /PROMO_DIALOG_TEXT/,
    "关闭流程不应再依赖文案正则 —— 它会随 A/B 实验变",
  );
  // 三路兜底仍在
  assert.match(body, /dialog-close/, "① 关闭控件");
  assert.match(body, /data-slot="dialog-overlay"/, "② 点遮罩");
  assert.match(body, /keyboard\.press\("Escape"\)/, "③ Escape 兜底");
});

test("关闭控件找不到时按位置兜底（右上角那个 × 没有可访问名）", () => {
  const start = source.indexOf("async function dismissPromoDialog");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.match(
    body,
    /r\.top < 120/,
    "应按几何位置兜底找关闭控件 —— 实测那个 × 没有 aria-label",
  );
});

test("两次修正的原因都写进注释（防止被当成过度实现改回去）", () => {
  const start = source.indexOf("async function dismissPromoDialog");
  const jsdoc = source.slice(source.lastIndexOf("/**", start), start);
  assert.match(jsdoc, /role="dialog"/, "应记录第一次失效的原因（没有 role=dialog）");
  assert.match(
    jsdoc,
    /下载豆包<strong>工作<\/strong>|下载豆包工作/,
    "应记录第二次失效的原因（按钮文案随实验分组变）",
  );
  assert.match(jsdoc, /h-full w-full/, "应记录全屏这个几何事实");
  assert.match(jsdoc, /34\s*秒/, "应记录 34 秒那个耗时，它是本次修复的判据之一");
});

test("结构类名用前缀匹配，不整名匹配（hash 后缀随构建变）", () => {
  // 只看**代码行**：注释里保留带 hash 的类名是刻意的实测记录（17.3 节要靠它复现），
  // 真正不能出现的是把它们当选择器用。
  const codeLines = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  // 整名匹配 dialogOverlay-v_86B7 会在下次构建时失效
  assert.doesNotMatch(
    codeLines,
    /dialogOverlay-v_|dialogContent-BoNHR6|dialogMask-eE93D4|fullscreenPopup-VgLjBm/,
    "不应在代码里把带 hash 的类名当选择器",
  );
  assert.match(
    codeLines,
    /cls\.includes\(p\)/,
    "应使用 includes 前缀匹配",
  );
  // 前缀常量里存的必须是「带连字符但不带 hash」的形式
  assert.match(source, /"dialogOverlay-"/, "前缀常量应止于连字符");
  assert.match(source, /"fullscreenPopup-"/, "fullscreenPopup- 前缀应止于连字符");
});