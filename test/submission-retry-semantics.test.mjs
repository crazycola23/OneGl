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
  assert.match(qianwen, /reason: "verification-mismatch", expected: composerText\(prompt\), actual, promptSubmitted: false/,
    "focus 路径的 throw 也要带 promptSubmitted:false");
});

test("豆包原有的两条路径标记仍然正确", () => {
  // 豆包区分两种情况：校验没过（未提交）vs 发送已触发但未确认（可能已提交）
  assert.match(doubao, /promptSubmitted: false/);
  // 「send action fired but the page did not confirm submission」那条不能带 false
  const sendConfirm = doubao.slice(doubao.indexOf("sentByButton"), doubao.indexOf("sentByButton") + 400);
  assert.ok(!sendConfirm.includes("promptSubmitted: false"),
    "可能已提交的场景不能标记为未提交，否则会造成重复提问");
});

test("千问的 ANSWER_NOT_FOUND 现状：可重试但无标记", () => {
  // 那 3 次 ANSWER_NOT_FOUND 不在 RESUBMIT_UNSAFE_CODES 里，
  // 所以默认可重试 —— 但没有 promptSubmitted 标记，
  // 意味着重试时无法区分「平台静默丢弃」与「已提交但没等到回答」。
  // 这是已知的待改进项，不在本轮修复范围。
  assert.ok(RETRYABLE_CODES.has("ANSWER_NOT_FOUND") || !RESUBMIT_UNSAFE_CODES.has("ANSWER_NOT_FOUND"),
    "ANSWER_NOT_FOUND 不应被当成高危码");
});
