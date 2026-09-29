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

function functionBody(name) {
  const start = src.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `应能找到 ${name}`);
  const declEnd = src.indexOf("{", start);
  const next = src.indexOf("\nasync function", declEnd);
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

test("新会话失败不静默 —— 失败原因要能被追到", () => {
  assert.match(src, /startFreshConversation[\s\S]{0,200}catch/,
    "要有 catch：失败不该直接判死后续流程");
  assert.match(src, /error:\s*String\(error/,
    "catch 里要记下原因，否则出问题无从追");
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
