/**
 * 匿名面也必须受节流闸门约束。
 *
 * 锁的是 2026-10-06 实测到的一个真问题：`classifyAccountState` 里
 * `isCredentialFreeSurface(provider)` 直接 return AVAILABLE，
 * 于是**每日上限、每小时上限、提交间隔三者对豆包匿名面全部失效**。
 *
 * 实测证据：
 *   runs_today = 79 ≥ 上限 40  →  仍返回 available
 *   env 的 hourly limit = 6，但实测滑动窗计数最高 17
 *   worker 日志里「已达每小时上限」与 job-delayed 都是 0 次
 *
 * 也就是今天能跑到 79 次，正是因为这道豁免。
 *
 * 原注释的理由是「匿名面没有账号可烧」。但账号额度本来就是我们内部的计数器 ——
 * 平台不看它。平台看的是**同一出口 IP + 同一行为模式**，而那正是会被限速的东西。
 * 所以「烧不掉账号」不等于「不需要节流」。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// ★ doubao 的 requiresStoredAuth 是**运行时开关**（doubao-web.js 用 getter 读
//   ONEGL_DOUBAO_ANONYMOUS），而 requireStatic 在本文件被 import 时就求值了。
//   所以必须在 import 目标之前设好，否则 doubao 会被当成有凭证账号。
process.env.ONEGL_DOUBAO_ANONYMOUS = "1";

const { classifyAccountState, AVAILABILITY } = await import("../src/accounts/safety.js");

const config = {
  accountHourlyLimit: 6,
  accountDailyLimit: 40,
  maxConsecutiveFailures: 3,
  cooldownMinutes: 60,
  minInterRunMs: 45_000,
  maxDelayMs: 120_000,
};

/** 用「今天」的日期键，避免跨日让计数被归零。 */
function todayState(overrides = {}) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return {
    provider: "doubao",
    enabled: true,
    status: "healthy",
    paused_at: null,
    pause_reason: null,
    cooldown_until: null,
    runs_today: 0,
    runs_today_date: `${y}-${m}-${d}`,
    runs_last_hour: 0,
    hour_window_oldest: null,
    last_run_at: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

test("★ 匿名面达到每日上限时必须被拦（实测 79/40 却放行了 79 次）", () => {
  const verdict = classifyAccountState(todayState({ runs_today: 79 }), { config });
  assert.equal(
    verdict.kind,
    AVAILABILITY.TEMPORARY,
    "runs_today 79 ≥ 40 却返回 available —— 这正是今天跑到 79 次的原因",
  );
  assert.match(verdict.reason, /每日上限/, "理由要说清是哪条闸门");
  assert.ok(verdict.retryAt, "必须给出恢复时间，否则 worker 会立刻再试");
});

test("匿名面达到每小时上限时必须被拦", () => {
  const verdict = classifyAccountState(todayState({ runs_last_hour: 17 }), { config });
  assert.equal(verdict.kind, AVAILABILITY.TEMPORARY);
  assert.match(verdict.reason, /每小时上限/, "实测滑动窗 17 次、上限 6，日志里一次都没拦过");
});

test("匿名面提交间隔也必须执法", () => {
  const verdict = classifyAccountState(
    todayState({ last_run_at: new Date(Date.now() - 5_000).toISOString() }),
    { config },
  );
  assert.equal(verdict.kind, AVAILABILITY.TEMPORARY);
  assert.match(verdict.reason, /间隔|过近/);
});

test("匿名面在额度内仍然放行（不能把通道彻底堵死）", () => {
  const verdict = classifyAccountState(
    todayState({ runs_today: 5, runs_last_hour: 2, last_run_at: new Date(Date.now() - 120_000).toISOString() }),
    { config },
  );
  assert.equal(verdict.kind, AVAILABILITY.AVAILABLE, "额度内必须放行");
});

test("跨日的计数要归零（日期键不匹配时不计数）", () => {
  const verdict = classifyAccountState(
    todayState({ runs_today: 79, runs_today_date: "2020-01-01" }),
    { config },
  );
  assert.equal(
    verdict.kind,
    AVAILABILITY.AVAILABLE,
    "跨日的旧计数不该继续拦今天的任务",
  );
});

test("登录态账号的行为不变（不能被这次改动影响）", () => {
  // ⚠️ 不能用 qianwen / zhipu / wenxin 当「登录态」的样本 ——
  //    它们的 requiresStoredAuth 都是 false，全都是匿名面。
  //    yuanbao 是仓里唯一 requiresStoredAuth: true 的。
  const state = todayState({
    provider: "yuanbao",
    runs_today: 79,
    runs_last_hour: 17,
    last_run_at: new Date(Date.now() - 5_000).toISOString(),
  });
  const verdict = classifyAccountState(state, { config });
  assert.equal(verdict.kind, AVAILABILITY.TEMPORARY, "有凭证账号仍按原来的顺序判定");
  assert.match(verdict.reason, /每日上限/, "拦它的应当是原有的每日上限");
});

test("豆包的登录态模式（ONEGL_DOUBAO_ANONYMOUS=0）不受这次改动影响", () => {
  // doubao-web.js 的 requiresStoredAuth 是运行时 getter（读 ONEGL_DOUBAO_ANONYMOUS），
  // 所以「开/关匿名面」走两条不同分支。这里验证关掉之后豆包仍按有凭证路径判定。
  //
  // 不重新 import：模块已被缓存，而 requiresStoredAuth 每次调用时重新求值，
  // 所以改环境变量就够 —— 前提是 getter 真的在调用时读（doubao-web.js:69 就是）。
  const saved = process.env.ONEGL_DOUBAO_ANONYMOUS;
  process.env.ONEGL_DOUBAO_ANONYMOUS = "0";
  try {
    const verdict = classifyAccountState(
      todayState({ runs_today: 79, runs_last_hour: 17 }),
      { config },
    );
    assert.equal(
      verdict.kind,
      AVAILABILITY.TEMPORARY,
      "关闭匿名面时豆包按有凭证路径判定 —— 闸门本来就该执法",
    );
    assert.match(verdict.reason, /每日上限/);
  } finally {
    if (saved === undefined) delete process.env.ONEGL_DOUBAO_ANONYMOUS;
    else process.env.ONEGL_DOUBAO_ANONYMOUS = saved;
  }
});

test("禁用与暂停仍优先于额度（顺序不能被改坏）", () => {
  assert.equal(
    classifyAccountState(todayState({ enabled: false, runs_today: 79 }), { config }).kind,
    AVAILABILITY.PERMANENT,
    "禁用账号不该只被记成「超额度」",
  );
  assert.equal(
    classifyAccountState(todayState({ paused_at: new Date(), runs_today: 79 }), { config }).kind,
    AVAILABILITY.PERMANENT,
    "手动暂停优先于额度",
  );
});

test("千问匿名面仍然免于节流（不要凭空收紧没证据的通道）", () => {
  // 2026-09-14 的实测支撑这条豁免：匿名面在四道闸门全触发时仍然正常。
  // 2026-10-06 的实测支撑豆包必须收紧。两者并存才是对的。
  const verdict = classifyAccountState(
    todayState({ provider: "qianwen", runs_today: 999, runs_last_hour: 99 }),
    { config },
  );
  assert.equal(
    verdict.kind,
    AVAILABILITY.AVAILABLE,
    "千问匿名面至今没有限速迹象，不该被这次改动收紧",
  );
});

test("匿名面的豁免理由写进注释（防止被当成多余的节流删掉）", () => {
  const source = readFileSync(new URL("../src/accounts/safety.js", import.meta.url), "utf8");
  const idx = source.indexOf("isCredentialFreeSurface(state.provider)");
  assert.ok(idx > 0, "应能找到匿名面豁免点");
  const around = source.slice(Math.max(0, idx - 1600), idx);
  assert.match(around, /79/, "应记录实测数字：79 次超过 40 上限却放行");
  assert.match(
    around,
    /出口 IP|行为模式/,
    "应记录「平台看的是 IP+行为，不是我们的账号计数器」这个理由",
  );
});

test("受限速的匿名面集合只收有证据的平台", () => {
  const source = readFileSync(new URL("../src/accounts/safety.js", import.meta.url), "utf8");
  const m = source.match(
    /ANONYMOUS_SURFACES_THAT_RATE_LIMIT\s*=\s*new Set\(\[(.*?)\]\)/s,
  );
  assert.ok(m, "应能找到该集合");
  const entries = m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  assert.deepEqual(
    entries,
    ["doubao"],
    "目前只有豆包有实测限速证据；新增平台前必须先有证据，不能因为「也是匿名面」就加",
  );
});