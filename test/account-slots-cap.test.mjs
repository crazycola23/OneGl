import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 单账号并发槽位的硬上限。
 *
 * ## 真实缺陷
 *
 * 实测（2026-09-30，豆包匿名面 10 条采集）在 `ONEGL_ACCOUNT_SLOTS=4` 时
 * 5 条失败：4 条 ANSWER_NOT_FOUND（提交后 180s 内零输出，判定被平台静默
 * 丢弃）、1 条 DOUBAO_SUBMISSION_FAILED。失败集中在 13:41–13:45，之后
 * 同一账号又恢复成功 —— 是平台对「同账号多窗口高频提交」的惩罚，不是本地
 * 资源竞争（成功记录的耗时没有变长）。
 *
 * ## 为什么「按配置取值」本身就是缺陷
 *
 * 并发度决定了这个账号同时开几个浏览器，也就决定了平台在多短的时间窗口内
 * 看到几次来自「同一台机器、同一个出口 IP」的提交。把它交给一个可以随手改的
 * 环境变量，意味着**配错就直接放大风险**，而且从配置里完全看不出来。
 *
 * 所以上限写死在代码里（MAX_ACCOUNT_SLOTS = 2），配置写多少都被钳到它。
 * 想再降只改这一行常量，不存在「配错了就放大」的情况。
 */

const worker = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");

function constantValue(name) {
  const m = worker.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `worker.js 里找不到常量 ${name}`);
  return Number(m[1]);
}

test("槽位上限固定为 2，与配置值无关", () => {
  assert.equal(constantValue("MAX_ACCOUNT_SLOTS"), 2);
});

test("slotsFor 一律把配置钳到硬上限，不存在「配多少就跑多少」", () => {
  const body = worker.match(/function slotsFor\([^)]*\) \{[\s\S]*?\n\}/);
  assert.ok(body, "找不到 slotsFor");
  assert.match(
    body[0],
    /Math\.min\(configured, MAX_ACCOUNT_SLOTS\)/,
    "slotsFor 必须用 Math.min 钳到上限",
  );
});

test("降级机制已整体移除，不再存在「事后把账号降下来」这条路径", () => {
  // 移除理由：判据只认 TIMEOUT，而这次失败走的是 ANSWER_NOT_FOUND —— 两者
  // 语义相同（平台整段没给出任何字符）却判不出来，机制实际从未触发；而一旦
  // 触发就把吞吐悄悄减半，表现为「配置写 2、take-slot 却全是 1」，很难查。
  for (const gone of [
    "CONCURRENCY_DEGRADE_ENABLED",
    "CONCURRENCY_DEGRADE_THRESHOLD",
    "CONCURRENCY_DEGRADE_WINDOW_MS",
    "concurrencyDegraded",
    "degradedAccounts",
    "noteConcurrencyTimeout",
  ]) {
    assert.ok(
      !worker.includes(gone),
      `${gone} 已被移除，源码里不该再出现（残留会变成死代码或未定义引用）`,
    );
  }
});

test("启动日志打印生效上限，而不是会被钳掉的配置值", () => {
  // 配置写 4、实际跑 2 时，打印配置值会让人从第一步就按错误的并发度排查。
  assert.match(
    worker,
    /槽位上限\s*:\s*\$\{MAX_ACCOUNT_SLOTS\}/,
    "启动日志必须打印 MAX_ACCOUNT_SLOTS",
  );
  assert.ok(
    !/匿名账号槽位\s*:\s*\$\{safety\.accountSlots\}/.test(worker),
    "不该再单独打印 safety.accountSlots —— 那是钳之前的值",
  );
});

test("提交节流仍按账号串行：多槽位不会把间隔压缩成 1/N", () => {
  // 这是「四槽位下平台仍应看到每 60s 一次提交」的前提。节流的键必须是
  // accountIdentity（账号级），而不是槽位级或任务级。
  assert.match(
    worker,
    /const identity = accountIdentity\(accountKey, provider\);[\s\S]{0,200}submitGates/,
    "submitGate 必须以 accountIdentity 为键",
  );
});
