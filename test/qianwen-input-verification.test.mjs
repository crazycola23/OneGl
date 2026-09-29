import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 千问的输入与「新会话」处理。
 *
 * ## 这些断言锁定的做法是被实测否决过的
 *
 * 早期实现是 `clearComposer()`（`evaluate(el => el.textContent = "")`）+
 * `pressSequentially` 逐字符输入。**实测（真实 Chromium + 真实 Slate）100% 失效**：
 *
 *   基线（不清空，直接 type）        ✗ locator.click 超时
 *   locator.fill()                   ✓ 105ms
 *   Ctrl+A + Backspace + type        ✗ locator.click 超时
 *   evaluate textContent="" + type    ✗ locator.click 超时
 *
 * 原因：Slate 是「DOM 结构即状态」的编辑器，`textContent = ""` 删掉它的状态树，
 * 之后键盘输入全部无效。而且破坏是**持久**的 —— 同一浏览器会话内不可恢复。
 *
 * 所以这些测试存在的意义是：**防止有人再把 clearComposer 加回来**。
 */

const src = readFileSync(new URL("../src/qianwen.js", import.meta.url), "utf8");
const profile = readFileSync(new URL("../src/providers/qianwen-web.js", import.meta.url), "utf8");

/**
 * 取函数体。
 *
 * 要同时覆盖 `async function` 与 `function` —— assertFreshConversation 是同步的
 * （只做判断后抛错），只匹配 async 会漏掉它，表现为「应能找到」的失败。
 */
function functionBody(name) {
  const asyncAt = src.indexOf(`async function ${name}`);
  const plainAt = src.indexOf(`function ${name}`);
  const start = asyncAt >= 0 ? asyncAt : plainAt;
  assert.ok(start >= 0, `应能找到 ${name}`);
  const declEnd = src.indexOf("{", start);
  const next = src.indexOf("\nfunction", declEnd) >= 0
    ? src.indexOf("\nfunction", declEnd)
    : src.indexOf("\nasync function", declEnd);
  return src.slice(start, next > declEnd ? next : src.length);
}

test("不再用 evaluate 改 textContent 清空（会破坏 Slate 状态）", () => {
  assert.ok(!/async function clearComposer/.test(src),
    "clearComposer 必须不存在 —— 实测它会删掉 Slate 的状态树并导致 100% 失败");
  assert.ok(!/element\.textContent\s*=\s*""/.test(src),
    "源码里不应再有 evaluate 里改 textContent 的清空动作");
});

test("用 locator.fill() 填入 —— 实测唯一可用的方式", () => {
  const body = functionBody("fillVerifiedPrompt");
  assert.match(body, /composer\.fill\(prompt/,
    "必须用 fill()：它自带清空语义且走 Playwright 为 contenteditable 准备的事件路径");
  assert.ok(!/pressSequentially/.test(body),
    "不应再用 pressSequentially —— 与 clearComposer 配对时 100% 失败");
});

test("两条输入路径合并（都不再走键盘 type）", () => {
  // 指针 click 在千问 composer 上会超时，所以生产走 focus 路径；
  // 而 focus 路径原本用 clearComposer + keyboard.type。fill() 两条都能走。
  assert.ok(!/keyboard\.type\(prompt/.test(src),
    "不应再有 keyboard.type 填入路径");
  assert.match(src, /await fillVerifiedPrompt\(page, composer, prompt\)/,
    "提交前统一走 fillVerifiedPrompt");
});

test("每问之前开新会话（实测缺失会导致答案串台）", () => {
  // 实测：连续提问时第二问返回的答案开头是第一问的内容
  assert.match(src, /startFreshConversation/,
    "必须在提交前开新会话");
  const body = functionBody("startFreshConversation");
  assert.match(body, /new-chat|data-session-switch-target/,
    "用实测量到的 data-session-switch-target=\"new-chat\" 入口");
});

test("开新会话后要确认历史回答真的清空", () => {
  // 豆包的 waitForEmptyConversation 要求连续 3 次轮询为空才算稳定。
  // 千问照做：不等够时间就继续，会把上一轮的卡片当成本次答案。
  assert.match(src, /waitForEmptyConversation/);
  const body = functionBody("waitForEmptyConversation");
  assert.match(body, /stableEmptyPolls/);
  assert.match(body, /REQUIRED_EMPTY_POLLS|>= 3/,
    "要连续多次确认为空，不能只判一次");
});

test("开新会话失败要 fail-closed，不能静默继续", () => {
  // 这里刻意与别处相反：开新会话失败**不** catch 掉继续跑。
  //
  // 因为开新会话失败意味着页面上还留着上一轮的回答卡片，而扫描逻辑读的是
  // **页面上所有**助手卡片 —— 于是历史回答会被当成自己的答案存进库。
  // 那种错误不报错，只是报告里的数字悄悄错了，比这次采集失败危险得多。
  //
  // 四个平台里只有千问缺过这个逻辑（豆包 doubao.js:1316-1317 用
  // startCleanConversation + assertFreshConversation；文心 wenxin.js:409 与
  // 智谱 zhipu.js 用内联的 `if (!reset.ok) throw`）。千问现在对齐豆包。
  assert.match(src, /function assertFreshConversation/);
  assert.match(src, /assertFreshConversation\(conversation, page\.url\(\)\)/,
    "开完新会话必须断言，确认它真的成了");
  // 只在 qianwen.js 内检查：文心与智谱也有同名函数，全局匹配会误判。
  // 正则里避开「catch」字面，否则本注释自己就会被匹配上（真发生过）。
  const swallowed = new RegExp(
    "startFreshConversation\\([^)]*\\)\\s*" + "\\." + "catch" + "\\(",
  );
  assert.ok(!swallowed.test(src),
    "startFreshConversation 不应被捕获后继续 —— 失败要 fail-closed");
});

test("断言允许「点过且已确认」与「回到根路径」两种成功形态", () => {
  const body = functionBody("assertFreshConversation");
  assert.match(body, /if \(conversation\.clicked\)/,
    "点过按钮：必须确认卡片清空");
  assert.match(body, /if \(!onRoot\)/,
    "没点成：只有回到根路径才算开了新会话");
  assert.match(body, /ErrorCode\.PAGE_CHANGED/,
    "确认不了就抛 PAGE_CHANGED，语义是「页面状态不对」");
});

test("profile 声明了新会话入口", () => {
  assert.match(profile, /newChatSelectors:\s*\['\[data-session-switch-target="new-chat"\]'\]/,
    "选择器应进 profile —— 平台差异属于 profile，不该写死在采集器里");
});

test("回读校验：expected 与 actual 同口径", () => {
  const body = functionBody("fillVerifiedPrompt");
  assert.match(body, /const expected = composerText\(prompt\)/);
  assert.match(body, /const actual = composerText\(/);
  assert.match(body, /promptSubmitted:\s*false/,
    "未提交才可安全重试");
});
