import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { canRetryOutcome, isRetryable, RESUBMIT_UNSAFE_CODES, RETRYABLE_CODES } from "../src/accounts/safety.js";

/**
 * 千问新增的输入校验失败，能不能被正确重试。
 *
 * ## 为什么单独查这个
 *
 * 上一轮给千问加的 `fillVerifiedPrompt` 抛 `ErrorCode.SUBMISSION_FAILED`，
 * 它的值是 `DOUBAO_SUBMISSION_FAILED` —— 而那个码在 `RESUBMIT_UNSAFE_CODES` 里，
 * **只有 details.promptSubmitted === false 才放行重试**。
 *
 * 判据错了的后果是两种：
 *   - 漏了 promptSubmitted:false → 输入框偶发状态问题被判死，永远没有第二次机会
 *     （这正是批次 69 里 22 条的遭遇）
 *   - 多写了 promptSubmitted:false → 可能已提交却放行重试，造成重复提问
 *
 * 所以「抛的码」与「details 的标记」必须配对正确。
 */

const qianwen = readFileSync(new URL("../src/qianwen.js", import.meta.url), "utf8");
const doubao = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");

test("SUBMISSION_FAILED 是可重试的码", () => {
  assert.ok(isRetryable("DOUBAO_SUBMISSION_FAILED"),
    "输入校验失败应该可重试 —— 提问没送达，重试安全");
});

test("带 promptSubmitted:false 时放行重试", () => {
  assert.ok(RESUBMIT_UNSAFE_CODES.has("DOUBAO_SUBMISSION_FAILED"),
    "该码本身属于「可能已提交」的高危类");
  const allowed = canRetryOutcome("DOUBAO_SUBMISSION_FAILED", { promptSubmitted: false });
  assert.equal(allowed, true,
    "明确声明未提交时应放行 —— 否则输入框偶发问题会被判死");
});

test("不带标记或标记为 true 时不放行", () => {
  assert.equal(canRetryOutcome("DOUBAO_SUBMISSION_FAILED", null), false,
    "没有证据就不能重试");
  assert.equal(canRetryOutcome("DOUBAO_SUBMISSION_FAILED", {}), false);
  assert.equal(canRetryOutcome("DOUBAO_SUBMISSION_FAILED", { promptSubmitted: true }), false,
    "可能已提交时重试会造成重复提问");
});

test("千问的 fillVerifiedPrompt 带正确的标记", () => {
  const start = qianwen.indexOf("async function fillVerifiedPrompt");
  assert.ok(start >= 0, "应定义 fillVerifiedPrompt");
  const declEnd = qianwen.indexOf("{", start);
  const next = qianwen.indexOf("\nasync function", declEnd);
  const body = qianwen.slice(start, next);
  assert.match(body, /promptSubmitted:\s*false/,
    "千问校验失败必须声明未提交，否则永远不会被重试");
});

test("千问 focus 路径的校验也带正确标记", () => {
  // focus 路径是内联的 throw，不在 fillVerifiedPrompt 里
  // focus 路径的 throw 也要带 promptSubmitted:false。
  // 断言写「字段都在」而不是逐字匹配：诊断形式改过一次
  // （改用 composerTextForLog 输出可读形式），逐字匹配会在改动时误报。
  assert.match(qianwen, /reason: "verification-mismatch"/);
  assert.match(qianwen, /expected: composerTextForLog\(/);
  assert.match(qianwen, /actual: composerTextForLog\(/);
  // 「clickable.mode === "focus"」在文件里出现两次（点击分支、输入分支），
  // 所以从「keyboard.type」往后取才是输入分支。
  const typeAt = qianwen.indexOf("await page.keyboard.type(prompt");
  const focusBlock = qianwen.slice(typeAt - 200, typeAt + 1200);
  assert.match(focusBlock, /promptSubmitted: false/,
    "focus 输入分支的 throw 也要带 promptSubmitted:false");
});

test("豆包原有的两条路径标记仍然正确", () => {
  // 豆包区分两种情况：校验没过（未提交）vs 发送已触发但未确认（可能已提交）
  assert.match(doubao, /promptSubmitted: false/);
  // 「send action fired but the page did not confirm submission」那条不能带 false
  const sendConfirm = doubao.slice(doubao.indexOf("sentByButton"), doubao.indexOf("sentByButton") + 400);
  assert.ok(!sendConfirm.includes("promptSubmitted: false"),
    "可能已提交的场景不能标记为未提交，否则会造成重复提问");
});

test("ANSWER_NOT_FOUND 显式列入高危集合，不靠「忘了加」才安全", () => {
  // 三处抛出点（豆包 804/846、千问 657）都标了 promptSubmitted: true，
  // 承认提问很可能已送达。
  //
  // 之前它不在 RESUBMIT_UNSAFE_CODES 里，靠「不在 RETRYABLE_CODES → false」
  // 那条路恰好不重试。结论对但理由错 —— 任何人「让超时也能重试」时把它加进
  // RETRYABLE_CODES，就会立刻变成重复提问。
  assert.ok(RESUBMIT_UNSAFE_CODES.has("ANSWER_NOT_FOUND"),
    "应显式列入高危集合，让语义与实现一致");

  // 现状行为不变：不重试。
  assert.equal(isRetryable("ANSWER_NOT_FOUND"), false,
    "它不在 RETRYABLE_CODES 里，所以第一道检查就返回 false");
  assert.equal(canRetryOutcome("ANSWER_NOT_FOUND", { promptSubmitted: true }), false);
  assert.equal(canRetryOutcome("ANSWER_NOT_FOUND", { promptSubmitted: false }), false,
    "同样不重试 —— 第一道 RETRYABLE_CODES 检查就拦下了，promptSubmitted 是第二道");
});

test("若将来把 ANSWER_NOT_FOUND 加进可重试集合，标记仍能拦住重复提问", () => {
  // 这是本次改动的真正价值：让第二道检查（promptSubmitted）成为可靠防线，
  // 而不是让第一道检查的「遗漏」来兜底。
  //
  // 用一个等价场景验证第二道检查本身是有效的。
  assert.equal(canRetryOutcome("DOUBAO_SUBMISSION_FAILED", { promptSubmitted: true }), false,
    "高危码 + 已送达 → 拦下（第二道检查有效）");
  assert.equal(canRetryOutcome("DOUBAO_SUBMISSION_FAILED", { promptSubmitted: false }), true,
    "高危码 + 未送达 → 放行");
  assert.equal(canRetryOutcome("ANSWER_NOT_FOUND", { promptSubmitted: true }), false,
    "ANSWER_NOT_FOUND 现在也在高危集合里，标记语义被尊重");
});

test("三个抛出点都显式标注了 promptSubmitted", () => {
  const doubao = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");
  const qianwen = readFileSync(new URL("../src/qianwen.js", import.meta.url), "utf8");
  let checked = 0;
  for (const [name, source] of [["豆包", doubao], ["千问", qianwen]]) {
    const lines = source.split("\n");
    for (const [i, line] of lines.entries()) {
      if (!line.includes("ErrorCode.ANSWER_NOT_FOUND")) continue;
      checked += 1;
      const ctx = lines.slice(Math.max(0, i - 6), i + 8).join("\n");
      assert.match(ctx, /promptSubmitted:\s*true/,
        `${name}:${i + 1} 的 ANSWER_NOT_FOUND 应标注 promptSubmitted:true`);
    }
  }
  assert.ok(checked >= 3, `应检查到至少 3 个抛出点，实际 ${checked}`);
});
