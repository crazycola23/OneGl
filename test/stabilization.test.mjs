import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AVAILABILITY,
  accountDayKey,
  classifyAccountState,
  dateKeyOf,
  nextAccountDayStart,
} from "../src/accounts/safety.js";
import { loadConfig } from "../src/config.js";
import { executeDoubaoPrompt } from "../src/doubao.js";
import { ErrorCode } from "../src/errors.js";
import { resolveBatchOutcome } from "../src/queue/batch-status.js";
import { planUnavailableJob } from "../src/queue/job-plan.js";
import { RunStore } from "../src/store.js";

/**
 * 稳定化补丁的离线回归测试。
 *
 * 全部不触碰真实豆包账号、不发起任何网络请求、不需要数据库：
 *   - 批次终态判定、账号可用性分类、任务调度决策都是纯函数
 *   - 会话 fail-closed 用 mock Playwright Page 驱动，验证「不确认新会话就不提交」
 *   - Run/attempt 与产物目录用临时目录验证
 */

const at = (iso) => new Date(iso);

// ---------------------------------------------------------------------------
// 二、sampling batch 状态机
// ---------------------------------------------------------------------------

test("批次终态：全部 skipped 绝不能算 completed", () => {
  const outcome = resolveBatchOutcome({ requested: 100, completed: 0, failed: 0, skipped: 100 });
  assert.equal(outcome.settled, true);
  assert.equal(outcome.status, "partial");
  assert.notEqual(outcome.status, "completed");
  // 三个计数与 requested 语义一致
  assert.equal(0 + 0 + outcome.skipped, 100);
});

test("批次终态：成功 + 跳过 = partial", () => {
  const outcome = resolveBatchOutcome({ requested: 10, completed: 7, failed: 0, skipped: 3 });
  assert.equal(outcome.status, "partial");
  assert.equal(7 + 0 + outcome.skipped, 10);
});

test("批次终态：成功 + 失败 = partial", () => {
  const outcome = resolveBatchOutcome({ requested: 10, completed: 6, failed: 4, skipped: 0 });
  assert.equal(outcome.status, "partial");
  assert.equal(6 + 4 + outcome.skipped, 10);
});

test("批次终态：全部失败 = failed", () => {
  const outcome = resolveBatchOutcome({ requested: 10, completed: 0, failed: 10, skipped: 0 });
  assert.equal(outcome.status, "failed");
});

test("批次终态：全部成功且无跳过 = completed", () => {
  const outcome = resolveBatchOutcome({ requested: 10, completed: 10, failed: 0, skipped: 0 });
  assert.equal(outcome.status, "completed");
});

test("批次终态：未跑完时不判定终态", () => {
  const outcome = resolveBatchOutcome({ requested: 10, completed: 3, failed: 1, skipped: 0 });
  assert.equal(outcome.settled, false);
  assert.equal(outcome.status, null);
  // 运行中也不能让三个计数超过 requested
  assert.ok(3 + 1 + outcome.skipped <= 10);
});

test("批次计数：同一个分配既失败又被跳过时不会把总数算超", () => {
  // 终态以「没有产出 Run 的分配数」为准，而不是把累加计数直接相加
  const outcome = resolveBatchOutcome({ requested: 10, completed: 8, failed: 1, skipped: 9 });
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.skipped, 1);
  assert.equal(8 + 1 + outcome.skipped, 10);
});

// ---------------------------------------------------------------------------
// 四、临时 cooldown 与永久阻塞
// ---------------------------------------------------------------------------

test("账号可用性：冷却中是临时状态，必须给出恢复时刻", () => {
  const now = at("2026-09-11T02:00:00Z");
  const cooldownUntil = at("2026-09-11T02:30:00Z");
  const verdict = classifyAccountState(
    { enabled: true, status: "cooldown", cooldown_until: cooldownUntil, paused_at: at("2026-09-11T01:59:00Z") },
    { now },
  );
  assert.equal(verdict.kind, AVAILABILITY.TEMPORARY);
  assert.equal(verdict.retryAt.getTime(), cooldownUntil.getTime());
});

test("账号可用性：频率限制冷却同样是临时状态", () => {
  const verdict = classifyAccountState(
    { enabled: true, status: "rate_limited", cooldown_until: at("2026-09-11T03:00:00Z"), paused_at: at("2026-09-11T02:00:00Z") },
    { now: at("2026-09-11T02:00:00Z") },
  );
  assert.equal(verdict.kind, AVAILABILITY.TEMPORARY);
});

test("账号可用性：当日额度用完属于临时状态，次日重置", () => {
  const now = at("2026-09-11T02:00:00Z");
  const verdict = classifyAccountState(
    { enabled: true, status: "healthy", runs_today: 60, runs_today_date: "2026-09-11" },
    { config: { accountDailyLimit: 60 }, now },
  );
  assert.equal(verdict.kind, AVAILABILITY.TEMPORARY);
  assert.ok(verdict.retryAt.getTime() > now.getTime());
  assert.equal(accountDayKey(verdict.retryAt), "2026-09-12");
});

test("账号可用性：登录失效等人工阻塞是永久状态", () => {
  for (const state of [
    { enabled: true, status: "login_required", paused_at: at("2026-09-11T02:00:00Z"), cooldown_until: null, pause_reason: "登录态已失效" },
    { enabled: true, status: "session_expired", paused_at: at("2026-09-11T02:00:00Z"), cooldown_until: null, pause_reason: "登录态已失效" },
    { enabled: true, status: "verification_required", paused_at: at("2026-09-11T02:00:00Z"), cooldown_until: null, pause_reason: "需要人工处理验证码" },
    { enabled: true, status: "access_restricted", paused_at: at("2026-09-11T02:00:00Z"), cooldown_until: null, pause_reason: "访问受限" },
    { enabled: false, status: "disabled" },
  ]) {
    const verdict = classifyAccountState(state, { now: at("2026-09-11T02:00:00Z") });
    assert.equal(verdict.kind, AVAILABILITY.PERMANENT, JSON.stringify(state));
    assert.equal(verdict.retryAt, null);
  }
});

test("账号可用性：正常账号可用", () => {
  const verdict = classifyAccountState(
    { enabled: true, status: "healthy", runs_today: 3, runs_today_date: "2026-09-11" },
    { config: { accountDailyLimit: 60 }, now: at("2026-09-11T02:00:00Z") },
  );
  assert.equal(verdict.kind, AVAILABILITY.AVAILABLE);
});

test("任务调度：冷却中的任务被延迟而不是永久跳过", () => {
  const retryAt = at("2026-09-11T02:30:00Z");
  const plan = planUnavailableJob({
    availability: { kind: AVAILABILITY.TEMPORARY, retryAt, reason: "冷却中" },
    cooldownWaits: 0,
    now: at("2026-09-11T02:00:00Z").getTime(),
  });
  assert.equal(plan.action, "delay");
  assert.equal(plan.retryAt, retryAt.getTime());
  assert.equal(plan.cooldownWaits, 1);
});

test("任务调度：冷却等待次数用完后按跳过处理，不会无限期挂着", () => {
  const plan = planUnavailableJob({
    availability: { kind: AVAILABILITY.TEMPORARY, retryAt: at("2026-09-11T02:30:00Z"), reason: "冷却中" },
    cooldownWaits: 3,
    maxCooldownWaits: 3,
  });
  assert.equal(plan.action, "skip");
  assert.equal(plan.exhausted, true);
});

test("任务调度：永久阻塞的账号直接跳过并停止", () => {
  const plan = planUnavailableJob({
    availability: { kind: AVAILABILITY.PERMANENT, retryAt: null, reason: "登录态已失效" },
    cooldownWaits: 0,
  });
  assert.equal(plan.action, "skip");
  assert.equal(plan.reason, "登录态已失效");
});

// ---------------------------------------------------------------------------
// 八、账号每日限额时区
// ---------------------------------------------------------------------------

test("自然日按账号时区计算，而不是 UTC", () => {
  // UTC 还是 9 月 10 日，北京时间已经是 9 月 11 日
  const instant = at("2026-09-10T17:30:00Z");
  assert.equal(accountDayKey(instant, "Asia/Shanghai"), "2026-09-11");
  assert.equal(accountDayKey(instant, "UTC"), "2026-09-10");
});

test("dateKeyOf 同时兼容 pg 的 Date 与字符串", () => {
  assert.equal(dateKeyOf("2026-09-11"), "2026-09-11");
  assert.equal(dateKeyOf("2026-09-11T00:00:00.000Z"), "2026-09-11");
  assert.equal(dateKeyOf(new Date(2026, 8, 11)), "2026-09-11");
  assert.equal(dateKeyOf(null), null);
});

test("下一个自然日零点落在账号时区的次日", () => {
  const now = at("2026-09-11T02:00:00Z"); // 北京时间 2026-09-11 10:00
  const next = nextAccountDayStart(now, "Asia/Shanghai");
  assert.ok(next.getTime() > now.getTime());
  assert.equal(accountDayKey(next, "Asia/Shanghai"), "2026-09-12");
});

// ---------------------------------------------------------------------------
// 一、独立会话 fail-closed
// ---------------------------------------------------------------------------

/**
 * 最小 mock Playwright Page：只实现采集链路真正会调用的部分。
 * evaluate 按回调源码分流——inspectSession 关心登录态，answerCandidates 关心气泡。
 */
function createMockPage({ answerBubbles }) {
  const calls = { fills: [] };

  const textbox = {
    async fill(value) {
      calls.fills.push(value);
    },
    async click() {},
    async isVisible() {
      return true;
    },
    async isEditable() {
      return true;
    },
    async evaluate() {
      return "";
    },
  };

  const emptyLocator = {
    async count() {
      return 0;
    },
    nth: () => textbox,
  };

  return {
    calls,
    url: () => "https://www.doubao.com/chat/",
    async waitForTimeout() {},
    async goto() {},
    async content() {
      return "<html></html>";
    },
    async screenshot() {
      return Buffer.from("");
    },
    keyboard: { async press() {} },
    locator(selector) {
      if (selector === 'div[role="textbox"]') {
        return { async count() { return 1; }, nth: () => textbox };
      }
      return emptyLocator;
    },
    getByRole: () => emptyLocator,
    getByText: () => emptyLocator,
    async evaluate(callback) {
      const source = String(callback);
      if (source.includes("_ROUTER_DATA")) return { state: "healthy" };
      if (source.includes("justify-end") && source.includes("data-streaming")) {
        return answerBubbles;
      }
      return [];
    },
  };
}

test("无法确认独立新会话时，绝不向豆包提交 Prompt", async () => {
  // 会话里还有一条 AI 回答，说明「新对话」没有生效
  const page = createMockPage({
    answerBubbles: [{ text: "上一轮对话留下的回答", isUser: false, streaming: false }],
  });
  const config = loadConfig({ headless: true, conversationSettleMs: 60 });

  await assert.rejects(
    () => executeDoubaoPrompt(page, "这个 Prompt 不应该被发送", config),
    (error) => {
      assert.equal(error.code, ErrorCode.CONVERSATION_RESET_FAILED);
      return true;
    },
  );

  // 只允许有一次清空输入框的 fill("")，Prompt 正文绝不能进入输入框
  assert.deepEqual(page.calls.fills, [""]);
  assert.ok(
    !page.calls.fills.some((value) => value.includes("这个 Prompt 不应该被发送")),
    "Prompt 被提交了，fail-closed 失效",
  );
});

// ---------------------------------------------------------------------------
// 三、Run retry attempt
// ---------------------------------------------------------------------------

test("重试时保留历史 attempt 的失败证据，且最终记录真实 attempt", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "onegl-store-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new RunStore({ dataDir });

  const first = await store.createRun({
    prompt: "同一个问题",
    runId: "run_b12_i4",
    runToken: "b12_i4",
    attempt: 1,
  });
  assert.equal(first.attempt, 1);
  await store.writeAttemptArtifact("run_b12_i4", 1, "screenshot.png", "attempt-1-evidence");
  await store.updateRun("run_b12_i4", { status: "failed", errorCode: "RATE_LIMITED" });

  const second = await store.createRun({
    prompt: "同一个问题",
    runId: "run_b12_i4",
    runToken: "b12_i4",
    attempt: 2,
  });
  assert.equal(second.attempt, 2);
  assert.deepEqual(second.attempts, [1, 2]);
  // 整个 Run 的起始时间不应被重试重置
  assert.equal(second.startedAt, first.startedAt);
  await store.writeAttemptArtifact("run_b12_i4", 2, "screenshot.png", "attempt-2-evidence");

  const saved = await store.updateRun("run_b12_i4", { status: "success", answer: "最终回答" });

  // 最终 attempt 落盘
  assert.equal(saved.attempt, 2);
  assert.equal(saved.status, "success");
  assert.equal(saved.answer, "最终回答");
  // artifactPath 指向最新一次尝试（与 debugPath 同约定：相对 process.cwd()）
  assert.ok(saved.artifactPath.endsWith(path.join("attempts", "2")));
  assert.equal(await stat(path.resolve(saved.artifactPath)).then(() => true), true);

  // 第一次尝试的现场没有被覆盖
  const attemptOne = await readFile(
    path.join(store.attemptDir("run_b12_i4", 1), "screenshot.png"),
    "utf8",
  );
  const attemptTwo = await readFile(
    path.join(store.attemptDir("run_b12_i4", 2), "screenshot.png"),
    "utf8",
  );
  assert.equal(attemptOne, "attempt-1-evidence");
  assert.equal(attemptTwo, "attempt-2-evidence");
});

test("同一个 run_token 重试不产生第二条 Run", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "onegl-store-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new RunStore({ dataDir });

  for (const attempt of [1, 2, 3]) {
    await store.createRun({
      prompt: "同一个问题",
      runId: "run_b7_i2",
      runToken: "b7_i2",
      attempt,
    });
  }

  // 本地只应有一个 Run 目录，重试只是在同一个 Run 上追加 attempt
  const entries = (await readdir(store.runsDir)).filter((name) => name.startsWith("run_"));
  assert.deepEqual(entries, ["run_b7_i2"]);
  const run = await store.readRun("run_b7_i2");
  assert.deepEqual(run.attempts, [1, 2, 3]);
  assert.equal(run.attempt, 3);
});

test("数据库层用唯一索引兜住 run_token 重复", async () => {
  // 本测试不连数据库：直接断言迁移声明了 run_token 的唯一约束。
  // 本地目录不重复（上一个测试）＋ 数据库唯一索引，两者合起来才保证同一次重试
  // 不会留下第二条 Run。
  const sql = await readFile(
    path.resolve("migrations/0004_background_runner.sql"),
    "utf8",
  );
  assert.match(sql, /CREATE UNIQUE INDEX runs_run_token_key ON runs \(run_token\)/);
});

test("attempt 必须是正整数", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "onegl-store-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new RunStore({ dataDir });
  await assert.rejects(() => store.createRun({ prompt: "p", attempt: 0 }));
  await assert.rejects(() => store.createRun({ prompt: "p", attempt: 1.5 }));
});
