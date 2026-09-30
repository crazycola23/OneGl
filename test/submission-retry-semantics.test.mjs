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
  // 千问的输入分支已合并（focus 与指针两条路径现在都走 fillVerifiedPrompt），
  // 所以这里只验证 fillVerifiedPrompt 本身带正确标记。
  assert.match(qianwen, /reason: "verification-mismatch"/);
  assert.match(qianwen, /expected: composerTextForLog\(/);
  assert.match(qianwen, /actual: composerTextForLog\(/);
  const fill = qianwen.slice(
    qianwen.indexOf("async function fillVerifiedPrompt"),
    qianwen.indexOf("\nasync function", qianwen.indexOf("async function fillVerifiedPrompt") + 10),
  );
  assert.match(fill, /promptSubmitted: false/,
    "校验失败说明提问未送达，必须标记为可安全重试");
});

test("豆包原有的两条路径标记仍然正确", () => {
  // 豆包区分两种情况：校验没过（未提交）vs 发送已触发但未确认（可能已提交）
  assert.match(doubao, /promptSubmitted: false/);
  // 「send action fired but the page did not confirm submission」那条不能带 false
  const sendConfirm = doubao.slice(doubao.indexOf("sentByButton"), doubao.indexOf("sentByButton") + 400);
  assert.ok(!sendConfirm.includes("promptSubmitted: false"),
    "可能已提交的场景不能标记为未提交，否则会造成重复提问");
});

test("ANSWER_NOT_FOUND 2026-09-30 起放开重试：一问一换窗口下重发不会串上下文", () => {
  // 原先它被双重锁死（不在 RETRYABLE_CODES + 在 RESUBMIT_UNSAFE_CODES 里），
  // 理由是「提问很可能已送达，重发就是重复提问」。这个理由成立的前提是
  // 「重发会污染同一段对话」—— 而采集侧本来就是一条一问一换窗口
  //（round_prompt_limit=1，每 2 条还重启浏览器换指纹），重发落在全新会话上。
  //
  // 2026-09-30 实测支持放开：失败率 4 槽位 50% → 2 槽位 10%，剩下的
  // ANSWER_NOT_FOUND 是平台侧随机丢弃，放弃重试等于白丢这批样本。
  assert.ok(RETRYABLE_CODES.has("ANSWER_NOT_FOUND"),
    "应进可重试集合");
  assert.ok(!RESUBMIT_UNSAFE_CODES.has("ANSWER_NOT_FOUND"),
    "应从重发不安全集合移出");

  assert.equal(isRetryable("ANSWER_NOT_FOUND"), true);
  assert.equal(canRetryOutcome("ANSWER_NOT_FOUND", { promptSubmitted: true }), true,
    "新窗口不串上下文，允许重发");
  assert.equal(canRetryOutcome("ANSWER_NOT_FOUND", { promptSubmitted: false }), true);
});

test("DOUBAO_SUBMISSION_FAILED 仍在高危集合：是否真收到不确定，重复风险更高", () => {
  // 与 ANSWER_NOT_FOUND 分开处理：这一类是「发送动作触发了但页面没确认提交」，
  // 平台侧是否真的收到不确定；且实测里 sentByButton=false 占比高，
  // 重发撞上同一问题的概率明显更高。
  assert.ok(RESUBMIT_UNSAFE_CODES.has("DOUBAO_SUBMISSION_FAILED"));
  assert.equal(canRetryOutcome("DOUBAO_SUBMISSION_FAILED", { promptSubmitted: true }), false,
    "已标记送达 → 拦下");
  assert.equal(canRetryOutcome("DOUBAO_SUBMISSION_FAILED", { promptSubmitted: false }), true,
    "明确未送达 → 放行");
});

test("第二道检查（promptSubmitted）仍然对真正的高危码有效", () => {
  // ANSWER_NOT_FOUND 放开后，重复提问的防线只剩 promptSubmitted 标记这一道。
  // 它必须仍然拦得住那些「是否送达真的不确定」的码。
  assert.equal(canRetryOutcome("DOUBAO_SUBMISSION_FAILED", { promptSubmitted: true }), false);
  assert.equal(canRetryOutcome("DOUBAO_TIMEOUT", { promptSubmitted: true }), false);
  assert.equal(canRetryOutcome("NETWORK_ERROR", { promptSubmitted: true }), false);
  assert.equal(canRetryOutcome("PAGE_CHANGED", { promptSubmitted: true }), false);
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
