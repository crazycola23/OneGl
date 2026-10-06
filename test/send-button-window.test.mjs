/**
 * 发送按钮的等待窗口 —— 锁住 2026-10-06 实测出的一处真实缺陷。
 *
 * 实测（.ops/probe-tryclicksend.mjs，复刻 tryClickSend 的循环逐轮打印）：
 *
 *   第 1–13 轮   可见=true  enabled=false   → 跳过
 *   第 14 轮     可见=true  enabled=true    → 点 ✅
 *   耗时约 4.2 秒 / 14 轮（每轮 300ms）
 *   结果 URL → /chat/38445625431828226（建了会话）
 *
 * ★ 当时的注释说「按钮还没渲染」—— **不准确**：
 *   按钮一直在 DOM 里（count=1、visible=true），只是 `enabled` 慢。
 *   「渲染」与「启用」是两件事，判据也要分开。
 *
 * 而原窗口是 8 秒：单跑够（4.2 秒），**并发下不够** ——
 * 端到端预演（那个窗口有两个浏览器）里它返回了 false，退化成 Enter，
 * 而 Enter 的引用率是 7.1%、按钮是 78.6%。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");
// ★ 统一成 LF 再断言 —— 这个仓库里同一文件可能是 CRLF 也可能 LF，
//   断言里写死 \n 会在 Windows 上全部失配（今天已经栽过一次同类）。
const lf = source.replace(/\r\n/g, "\n");
const start = lf.indexOf("async function tryClickSend");
const body = lf.slice(start, lf.indexOf("\n}", start));

test("等待窗口是 20 秒（实测按钮要 4.2 秒才 enabled）", () => {
  const m = body.match(/const deadline = Date\.now\(\) \+ ([\d_]+);/);
  assert.ok(m, "应定义 deadline");
  assert.equal(
    Number(m[1].replace(/_/g, "")),
    20_000,
    "实测 4.2 秒，20 秒给 5 倍余量 —— 并发下 CPU 被分摊时 8 秒不够",
  );
});

test("★ 注释要说清是「启用」不是「渲染」", () => {
  // 「按钮还没渲染」这个说法会把后来的人引向错误的排查方向
  // （去数 count，而不是看 isEnabled）
  //
  // ⚠️ 注释在 `const selectors` **之后**，不是之前 ——
  //   取错范围会让这条断言永远失败（今天已栽过一次）。
  const afterSelectors = body.slice(body.indexOf("const selectors"));
  const deadlineIdx = afterSelectors.indexOf("const deadline");
  const jsdoc = afterSelectors.slice(0, deadlineIdx);

  assert.match(jsdoc, /enabled/, "注释应点明关键在 isEnabled");
  assert.match(
    jsdoc,
    /4\.2|4200/,
    "应记录实测的 4.2 秒 —— 否则下一个人会以为这是随手调大的等待",
  );
  assert.match(
    jsdoc,
    /7\.1|78\.6/,
    "应记录退 Enter 的代价（引用率 7.1% vs 78.6%）—— 这是决定宁可多等的理由",
  );
  assert.doesNotMatch(
    jsdoc,
    /按钮常常还没渲染/,
    "★ 那句「按钮还没渲染」是错的：按钮一直在 DOM 里，只是 enabled 慢",
  );
});

test("找不到时仍保留 Enter 兜底（改版时至少能把问题发出去）", () => {
  assert.match(body, /return false;/, "窗口耗尽应返回 false 而不是抛错");
  // Enter 兜底在 submitPrompt 里，不在 tryClickSend 里
  const submit = lf.slice(lf.indexOf("async function submitPrompt"));
  assert.match(
    submit.slice(0, submit.indexOf("async function finishSubmit")),
    /press\("Enter"/,
    "Enter 兜底必须保留 —— 下一次改版时它至少能发出问题",
  );
});

test("判据是 isVisible && isEnabled 两条都要（只看其一都不够）", () => {
  assert.match(body, /isVisible\(\)/, "应检查可见性");
  assert.match(body, /isEnabled\(\)/, "应检查可用性 —— 实测失败正是卡在它");
  assert.match(
    body,
    /\(await button\.isVisible\(\)\.catch\(\(\) => false\)\)\s*&&\s*\(await button\.isEnabled\(\)\.catch\(\(\) => false\)\)/,
    "两条应同时成立才点",
  );
});
