/**
 * 重试次数可配 —— 锁住 2026-10-06 实测出的代价换算。
 *
 * 实测（docs 第十八节）：
 *   44 个问题 → sum(attempt) = 70 次请求（放大 59%）
 *   第 1 次尝试成功率 47.4%，第 2 次 45.5% —— 重试几乎不改变成功率
 *   而平台侧的引用能力在累积请求数到 33 次附近归零
 *
 * 两点合起来的意思：**重试本身把总量推过了那个阈值**。
 * 所以在配额稀缺且引用已衰减的窗口里，要把 attempts 设成 1。
 *
 * 判据是这个函数的行为，而不是「有没有这个环境变量」——
 * 变量名改了也不该让默认值悄悄变掉。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { jobAttempts } from "../src/queue/batches.js";

test("默认仍是 3（首次 + 2 次重试），保持原有行为", () => {
  assert.equal(jobAttempts({}), 3, "未设时必须保持原行为");
  assert.equal(jobAttempts({ ONEGL_JOB_ATTEMPTS: "" }), 3, "空串等同未设");
  assert.equal(jobAttempts({ ONEGL_JOB_ATTEMPTS: "   " }), 3, "空白等同未设");
});

test("设为 1 即关闭重试（每次问题只花一次请求）", () => {
  assert.equal(jobAttempts({ ONEGL_JOB_ATTEMPTS: "1" }), 1);
});

test("非法输入夹到安全值而不是让整批入队失败", () => {
  assert.equal(jobAttempts({ ONEGL_JOB_ATTEMPTS: "0" }), 3, "0 会被 BullMQ 拒绝，夹回默认");
  assert.equal(jobAttempts({ ONEGL_JOB_ATTEMPTS: "-5" }), 3);
  assert.equal(jobAttempts({ ONEGL_JOB_ATTEMPTS: "abc" }), 3);
  assert.equal(jobAttempts({ ONEGL_JOB_ATTEMPTS: "2.5" }), 3, "非整数夹回默认");
  assert.equal(jobAttempts({ ONEGL_JOB_ATTEMPTS: "999" }), 5, "上限 5 —— 手滑的 1000 次会真的重试 1000 次");
});

test("enqueueBatch 真的用它，而不是仍然硬编码 3", () => {
  const source = readFileSync(new URL("../src/queue/batches.js", import.meta.url), "utf8");
  assert.match(
    source,
    /attempts:\s*jobAttempts\(\)/,
    "入队时必须调 jobAttempts()，否则改了函数也不生效",
  );
  assert.doesNotMatch(
    source,
    /attempts:\s*3\s*,/,
    "不应再有硬编码的 attempts: 3",
  );
});

test("代价与收益写进注释（避免被当成随手加的开关）", () => {
  const source = readFileSync(new URL("../src/queue/batches.js", import.meta.url), "utf8");
  const idx = source.indexOf("attempts: jobAttempts()");
  assert.ok(idx > 0, "应能找到调用点");
  // 往上找它所在的那段注释
  const comment = source.slice(Math.max(0, idx - 1400), idx);
  assert.match(comment, /47\.4|45\.5/, "应记录两次尝试的成功率对比");
  assert.match(comment, /70|59/, "应记录请求放大倍数");
  assert.match(comment, /33/, "应记录引用归零的累积请求阈值");
});