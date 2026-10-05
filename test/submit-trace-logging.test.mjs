/**
 * 提交链必须留埋点 —— 锁住 2026-10-06 一次真实的可观测性缺口。
 *
 * 那天修了六处缺陷，四次诊断的判据都来自 **artifact 截图**：
 * 弹窗关掉没有、fill 成功没有、按钮点到了没有、等确认等到了没有。
 *
 * 而 worker 里有 10 个结构化事件（`log({ event: ... })`），
 * **与提交相关的 0 个**。截图只能反映**失败那一刻**的状态，
 * 答不出「过程中发生了什么」——
 * 于是同一个问题只能反复回放 + 翻截图，而不是读一行日志。
 *
 * 具体的浪费：
 *   · `from_logout` 的相关性查了半小时，因为没有埋点能说明「提交时页面是什么状态」
 *   · 水合 30 秒不够，只看到一行 `未在 30000ms 内完成水合`，看不出差多少
 *   · 「提交后零输出」成功时有 first-token 日志、失败时一条都没有
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");

test("提交链逐步打点（弹窗/fill/按钮/确认各有结果）", () => {
  const start = source.indexOf("async function submitPrompt");
  const body = source.slice(start, source.indexOf("\n}", start));

  // 弹窗两次清理的结果都要记
  assert.match(body, /promoBeforeFill/, "应记录填入前的弹窗清理结果");
  assert.match(body, /promoAfterFill/, "应记录填入后的弹窗清理结果");
  assert.match(body, /promoAfterFailedClick/, "应记录点不到按钮后那次清理的结果");
  // 提交方式
  assert.match(body, /sentByButton/, "应记录是否点到了发送按钮");
  assert.match(body, /retriedAfterPromo/, "应记录是否因清弹窗而重试");
  assert.match(body, /submittedByEnter/, "应记录是否退化成回车提交");
  assert.match(body, /confirmationWaitMs/, "应记录等确认花了多久");
});

test("成功与失败都要打点（否则无法对比两条路径）", () => {
  const start = source.indexOf("async function finishSubmit");
  const body = source.slice(start, source.indexOf("\n}", start));

  // 确认之前打 —— 失败时也会打出来
  assert.match(
    body,
    /console\.log\(\s*`\[doubao\] submit/,
    "提交链的结论必须在抛错之前打点，否则失败时看不到",
  );
  // 失败时把 trace 一起塞进 error details，让 runs 表里能直接查到
  assert.match(body, /\{ sentByButton, \.\.\.\(trace \?\? \{\}\) \}/, "错误详情应带上 trace");
});

test("水合等待打出实际耗时与关键信号", () => {
  const start = source.indexOf("async function waitForHydration");
  const body = source.slice(start, source.indexOf("\n}", start));

  // 成功时：耗时 + 文本量 + 组件就绪 + 是否被遮挡
  assert.match(
    body,
    /\[doubao\] hydration ok \$\{Date\.now\(\) - startedAt\}ms/,
    "成功时要打耗时 —— 「上限够不够」只能靠这些数字判断",
  );
  assert.match(body, /hydration ok[\s\S]*?textLength=/, "应打出文本量");
  assert.match(body, /hydration ok[\s\S]*?composerReady=/, "应打出 composer 是否就绪");
  assert.match(body, /hydration ok[\s\S]*?covered=/, "应打出是否被遮挡");
  // 超时时也要打数值，否则看不出是差 1 秒还是差 40 秒
  assert.match(body, /hydration timeout[\s\S]*?textLength=/, "超时时也要打数值");
  assert.match(body, /hydration timeout[\s\S]*?composerReady=/, "超时时也要打组件状态");
});

test("零输出路径要有日志（成功路径有 first-token，失败路径此前一条都没有）", () => {
  assert.match(
    source,
    /\[doubao\] no-first-token waited=/,
    "「提交后零输出」必须有日志 —— 今天查 from_logout 关联就是卡在这里",
  );
  const idx = source.indexOf("[doubao] no-first-token");
  const around = source.slice(Math.max(0, idx - 400), idx);
  assert.match(
    around,
    /埋点|一条都没有|只能靠/,
    "应记录为什么加这条日志，否则会被当成调试残留删掉",
  );
});

test("埋点不改变错误语义（不新增 throw、不改判据）", () => {
  const start = source.indexOf("async function finishSubmit");
  const body = source.slice(start, source.indexOf("\n}", start));
  const logs = (body.match(/console\.(log|warn)/g) || []).length;
  const throws = (body.match(/throw new/g) || []).length;
  assert.equal(throws, 1, "finishSubmit 只应有一处 throw（确认失败）");
  assert.ok(logs >= 1, "至少有确认那一条日志");
});