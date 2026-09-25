import assert from "node:assert/strict";
import test from "node:test";

import {
  AVAILABILITY,
  classifyAccountState,
} from "../src/accounts/safety.js";
import { providerBurstPacing } from "../src/providers/index.js";
import { collectProfileErrors } from "../src/providers/profile.js";
import { qianwenWebProfile } from "../src/providers/qianwen-web.js";
import {
  createConservativeDoubaoPage,
  prepareFrontEndForRun,
} from "../src/front-end-guard.js";
import { auditOperationRisk } from "../tools/risk-audit.js";

const at = (iso) => new Date(iso);

test("minimum inter-run gap delays an account instead of running immediately", () => {
  const now = at("2026-09-14T10:00:00Z");
  const verdict = classifyAccountState(
    {
      enabled: true,
      status: "healthy",
      runs_today: 1,
      runs_today_date: "2026-09-14",
      last_run_at: at("2026-09-14T09:59:50Z"),
      runs_last_hour: 1,
    },
    {
      now,
      config: {
        accountDailyLimit: 60,
        minInterRunMs: 15_000,
        accountHourlyLimit: 20,
      },
    },
  );
  assert.equal(verdict.kind, AVAILABILITY.TEMPORARY);
  assert.equal(verdict.retryAt.toISOString(), "2026-09-14T10:00:05.000Z");
});

test("hourly ceiling delays until the rolling window opens", () => {
  const now = at("2026-09-14T10:00:00Z");
  const verdict = classifyAccountState(
    {
      enabled: true,
      status: "healthy",
      runs_today: 20,
      runs_today_date: "2026-09-14",
      last_run_at: at("2026-09-14T09:50:00Z"),
      runs_last_hour: 20,
      hour_window_oldest: at("2026-09-14T09:15:00Z"),
    },
    {
      now,
      config: {
        accountDailyLimit: 60,
        minInterRunMs: 0,
        accountHourlyLimit: 20,
      },
    },
  );
  assert.equal(verdict.kind, AVAILABILITY.TEMPORARY);
  assert.equal(verdict.retryAt.toISOString(), "2026-09-14T10:15:01.000Z");
});

test("conservative page proxy blocks legacy new-work-task fallback", async () => {
  const calls = [];
  const normalLocator = { async count() { return 1; } };
  const page = {
    getByRole(role, options) {
      calls.push(["role", role, options]);
      return normalLocator;
    },
    getByText(text, options) {
      calls.push(["text", text, options]);
      return normalLocator;
    },
  };
  const guarded = createConservativeDoubaoPage(page);
  assert.equal(await guarded.getByRole("button", { name: "新工作任务" }).count(), 0);
  assert.equal(await guarded.getByText("新工作任务", { exact: true }).count(), 0);
  assert.equal(await guarded.getByRole("button", { name: "新对话" }).count(), 1);
  assert.equal(calls.length, 1);
});

test("frontend preflight returns to ordinary chat root when new-conversation control is absent", async () => {
  let url = "https://www.doubao.com/chat/abc123";
  let navigated = false;
  const page = {
    url: () => url,
    async goto(next) {
      url = next;
      navigated = true;
    },
    async waitForTimeout() {},
    async evaluate(callback) {
      const source = String(callback);
      if (source.includes("_ROUTER_DATA")) return { state: "healthy" };
      return {
        busy: false,
        stopVisible: false,
        streamingVisible: false,
        progressVisible: false,
        newConversationVisible: navigated,
        composerCount: 1,
      };
    },
  };

  const result = await prepareFrontEndForRun(
    page,
    { doubaoUrl: "https://www.doubao.com/chat/" },
    { idleWaitMs: 10, pollMs: 1 },
  );
  assert.equal(result.navigatedToChatRoot, true);
  assert.equal(result.finalUrl, "https://www.doubao.com/chat/");
  assert.equal(result.workTaskFallbackBlocked, true);
});

test("risk audit marks aggressive cadence and parallelism as high risk", () => {
  const report = auditOperationRisk({
    app: { browser: "chromium", headless: false, networkEvidenceEnabled: false },
    safety: {
      minDelayMs: 2_000,
      maxDelayMs: 5_000,
      minInterRunMs: 0,
      accountHourlyLimit: 60,
      accountDailyLimit: 200,
      rateLimitCooldownMinutes: 10,
      accountParallelism: 3,
    },
  });
  assert.equal(report.risk, "high");
  assert.ok(report.findings.some((item) => item.area === "parallelism" && item.level === "high"));
  assert.ok(report.findings.some((item) => item.area === "cadence" && item.level === "high"));
});

test("a credential-free surface is exempt from the caps, the spacing and the cooldown", () => {
  const now = at("2026-09-14T10:00:00Z");
  const limits = {
    accountDailyLimit: 40,
    accountHourlyLimit: 10,
    minInterRunMs: 30_000,
    cooldownMinutes: 60,
    maxConsecutiveFailures: 3,
  };
  // Every gate that exists to keep a real account from being blocked, all tripped at once.
  const wornOut = {
    provider: "qianwen",
    enabled: true,
    status: "cooldown",
    runs_today: 999,
    runs_today_date: "2026-09-14",
    last_run_at: at("2026-09-14T09:59:59Z"),
    runs_last_hour: 99,
    cooldown_until: at("2026-09-14T11:00:00Z"),
    paused_at: at("2026-09-14T09:00:00Z"),
    pause_reason: "连续失败 3 次，冷却 60 分钟",
  };
  assert.equal(classifyAccountState(wornOut, { now, config: limits }).kind, AVAILABILITY.AVAILABLE);

  // The operator's own switch still stops the lane: that is the only claim left on a surface
  // with no credential behind it.
  assert.equal(
    classifyAccountState({ ...wornOut, enabled: false }, { now, config: limits }).kind,
    AVAILABILITY.PERMANENT,
  );

  // The exemption is the surface's, not a global loosening: the same state on an account-driven
  // provider is still refused.
  assert.notEqual(
    classifyAccountState({ ...wornOut, provider: "doubao" }, { now, config: limits }).kind,
    AVAILABILITY.AVAILABLE,
  );
});

test("a measured burst allowance stops a credential-free lane before the platform does", () => {
  const now = at("2026-09-24T00:20:00Z");
  // Four prompts at ~3.5 min apart: the fifth is where 千问 answered with a login wall, and the
  // prompt that trips it is already submitted, so the burst has to stop rather than recover.
  const spent = {
    enabled: true,
    status: "healthy",
    provider: "qianwen",
    runs_today: 4,
    runs_today_date: "2026-09-24",
    last_run_at: at("2026-09-24T00:10:30Z"),
    runs_last_hour: 4,
  };
  const pacing = { prompts: 4, pauseMs: 25 * 60_000 };

  const paused = classifyAccountState(spent, {
    now,
    pacing,
    burst: { runsInWindow: 4, newestRunAt: at("2026-09-24T00:10:30Z") },
  });
  assert.equal(paused.kind, AVAILABILITY.TEMPORARY);
  // Quiet runs from the *last* prompt, not the first, so the platform sees a real gap.
  assert.equal(paused.retryAt.toISOString(), "2026-09-24T00:35:30.000Z");
  // Flagged as a planned wait: a full run needs one of these per cycle, so it must not spend
  // the same budget as an account that is genuinely stuck.
  assert.equal(paused.paced, true);

  // Room left in the window: the lane keeps working, which is the whole point of pacing it.
  assert.equal(
    classifyAccountState(spent, {
      now,
      pacing,
      burst: { runsInWindow: 3, newestRunAt: at("2026-09-24T00:10:30Z") },
    }).kind,
    AVAILABILITY.AVAILABLE,
  );

  // Once the pause has elapsed the allowance is spent again by runs that have aged out.
  assert.equal(
    classifyAccountState(spent, {
      now: at("2026-09-24T00:40:00Z"),
      pacing,
      burst: { runsInWindow: 4, newestRunAt: at("2026-09-24T00:10:30Z") },
    }).kind,
    AVAILABILITY.AVAILABLE,
  );

  // No pacing measured means the exemption stands untouched - a provider that never measured a
  // burst limit must not be slowed down by a mechanism it never opted into.
  assert.equal(
    classifyAccountState(spent, { now, pacing: null, burst: null }).kind,
    AVAILABILITY.AVAILABLE,
  );
});

test("only a provider that declared a measured burst allowance gets paced", () => {
  const previous = process.env.ONEGL_QIANWEN_BURST_PAUSE_MS;
  try {
    // 默认 = 2026-09-23/24 实测的 25 分钟；运维把它设成 0 就是取消这条限制。
    delete process.env.ONEGL_QIANWEN_BURST_PAUSE_MS;
    assert.deepEqual(providerBurstPacing("qianwen"), { prompts: 4, pauseMs: 25 * 60_000 });

    process.env.ONEGL_QIANWEN_BURST_PAUSE_MS = "0";
    assert.equal(
      providerBurstPacing("qianwen"),
      null,
      "0 must read as «no measured burst limit», not as a zero-length window",
    );

    process.env.ONEGL_QIANWEN_BURST_PAUSE_MS = "60000";
    assert.deepEqual(providerBurstPacing("qianwen"), { prompts: 4, pauseMs: 60_000 });

    // 负数不是在这里抛：这条路径在 worker 热路径上，throw 会被吞成「没有 pacing」。
    // 真正的把关在 profile 校验 —— 非法值让 collectProfileErrors 直接抛出带变量名的错误，
    // 注册阶段就停住，而不是悄悄丢掉 pacing 继续跑。
    process.env.ONEGL_QIANWEN_BURST_PAUSE_MS = "-1";
    assert.equal(providerBurstPacing("qianwen"), null);
    assert.throws(
      () => collectProfileErrors(qianwenWebProfile),
      /ONEGL_QIANWEN_BURST_PAUSE_MS/,
      "a negative pause must fail the profile loudly, not silently drop the pacing",
    );
  } finally {
    if (previous == null) delete process.env.ONEGL_QIANWEN_BURST_PAUSE_MS;
    else process.env.ONEGL_QIANWEN_BURST_PAUSE_MS = previous;
  }

  // 豆包 2026-09-25 也声明了实测额度，所以它和千问一样被 pacing —— 但数字不同：
  // 连续测量显示修掉推广弹窗后前 5 条成功、第 6 条起失败（千问是 4）。
  // 这里断言的是「两边都拿得到 pacing，且各用各的数字」，而不是「豆包没有」。
  assert.deepEqual(providerBurstPacing("doubao"), { prompts: 5, pauseMs: 25 * 60_000 });
  // An unknown provider must not throw here: this runs on the worker's hot path.
  assert.equal(providerBurstPacing("nope"), null);
});
