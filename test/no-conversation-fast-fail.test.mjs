/**
 * 未建会话就快速失败 —— 锁住 2026-10-06 实测出的最大一处时间浪费。
 *
 * 实测（.ops/confirm-session-rootpage.sh，六批 52 条）：
 *
 *   停在根页 /chat/?from_logout=1   19 条   有答案 0 条   最长答案 0 字
 *   进了会话页 /chat/{id}           33 条   有答案 24 条   最长答案 1701 字
 *
 * 「停在根页」是**从来没有过任何一个字符**，不是「暂时没读到」——
 * 所以继续等满 180 秒的 first-token 窗口不会有任何变化。
 * 19 × 180s ≈ 57 分钟，而每日配额只有 40 次。
 *
 * 这个测试锁三件事：判据本身、不会误杀、以及它为什么在原路径之后。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { conversationIdOf } from "../src/doubao.js";

const source = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");
// 只取 waitForAnswer 的函数体。
//   · 固定字符数切片会跨到下一个函数（把它的 throw 也数进来）
//   · indexOf("\n}") 会命中内层第一个 }，把函数体截断
// 所以按「顶格的 }」收尾 —— 函数体的所有 } 都有缩进。
const waitStart = source.indexOf("async function waitForAnswer");
const rest = source.slice(waitStart);
const endMatch = rest.match(/\n\}/);
const waitBody = endMatch ? rest.slice(0, endMatch.index) : rest;

test("快速失败阈值是 20 秒（不是 180 秒）", () => {
  const m = source.match(/const CONVERSATION_LANDING_WAIT_MS\s*=\s*([\d_]+);/);
  assert.ok(m, "应定义 CONVERSATION_LANDING_WAIT_MS");
  assert.equal(
    Number(m[1].replace(/_/g, "")),
    20_000,
    "实测提交到进会话要 2–8 秒，20 秒给足余量仍把失败从 180s 压到 20s",
  );
});

test("判据用「当前是否在会话页」，不是时间", () => {
  assert.match(
    waitBody,
    /conversationIdOf\(page\.url\(\)\) !== null/,
    "应直接问「现在在不在会话页」，而不是比较前后 URL 是否变化",
  );
  assert.ok(
    /!landedInConversation/.test(waitBody),
    "不在会话页才走提前退出",
  );
});

test("★ 已经读到字符时不提前退出（不能误杀正在生成的）", () => {
  assert.match(
    waitBody,
    /!landedInConversation && !best/,
    "条件里必须带 !best —— 一旦有字符就交给原有完整等待",
  );
});

test("baselineUrl 必须来自提交之前", () => {
  // 提交后页面可能已经跳进 /chat/{id}，那样就答不出「建没建」了
  const idx = source.indexOf("const urlBeforeSend = page.url();");
  assert.ok(idx > 0, "submitPrompt 应在提交前记录 urlBeforeSend");
  const fillIdx = source.indexOf("await fillVerifiedPrompt(page, prompt);");
  const clickIdx = source.indexOf("await tryClickSend(page)");
  assert.ok(
    idx < fillIdx && idx < clickIdx,
    "urlBeforeSend 必须在 fill 与 click 之前取，否则它记的是提交后的 URL",
  );
  assert.match(
    source,
    /return \{ baselineAnswers, sentByButton, urlBeforeSend \};/,
    "finishSubmit 应当把 urlBeforeSend 带出去",
  );
  assert.match(
    source,
    /waitForAnswer\(\s*page,\s*submission\.baselineAnswers,\s*config,\s*submission\.urlBeforeSend/,
    "调用处必须把它传进 waitForAnswer",
  );
});

test("错误码不新增语义：三条失败路径都是 ANSWER_NOT_FOUND", () => {
  // 实际上有三条（我一开始以为只有两条，断言写成 2 失败了 —— 是断言错，不是代码错）：
  //   1. 未建会话就提前退出（2026-10-06 新增）
  //   2. 进了会话但 180s 零输出
  //   3. 进了会话、有片段答案但没到稳定态（片段答案超时）
  // 三者都是「没拿到可用的完整答案」，应当是同一个错误码，
  // 这样下游的统计、重试策略、报告口径都不用为新增路径再开一套。
  const throws = waitBody.match(/ErrorCode\.ANSWER_NOT_FOUND/g) || [];
  assert.equal(throws.length, 3, "三条失败路径都应是 ANSWER_NOT_FOUND");

  // 但**可重试性**不该因此变化：新增的那条要能被 retry 判据认出
  assert.match(
    waitBody,
    /conversationLanded: false/,
    "应把这个事实记进 error_details，否则下次还要重查",
  );
  assert.match(
    waitBody,
    /no-conversation waited=/,
    "应打日志 —— 成功路径有 first-token，三条失败路径都要有各自的日志",
  );
});

test("实测数字留在注释里（避免被当成随手加的提前退出）", () => {
  const jsdocStart = source.lastIndexOf("/**", source.indexOf("const CONVERSATION_LANDING_WAIT_MS"));
  const jsdoc = source.slice(jsdocStart, source.indexOf("const CONVERSATION_LANDING_WAIT_MS"));
  assert.match(jsdoc, /19\s*条/, "应记录停在根页的条数");
  assert.match(jsdoc, /0\s*字|0 字/, "应记录那些条目的最长答案是 0 字");
  assert.match(jsdoc, /180|57/, "应记录原本要白等多久");
});
