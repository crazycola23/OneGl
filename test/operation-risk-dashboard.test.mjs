import assert from "node:assert/strict";
import test from "node:test";

import {
  assessAccountRisk,
  auditOperationRisk,
  highestRisk,
  summarizeOperationRisk,
} from "../src/operation-risk.js";
import { riskDashboardPanel, sidebarRisk } from "../src/ui/risk-dashboard.js";

const safety = {
  minDelayMs: 15_000,
  maxDelayMs: 30_000,
  minInterRunMs: 15_000,
  accountHourlyLimit: 20,
  accountDailyLimit: 60,
  maxConsecutiveFailures: 3,
  cooldownMinutes: 60,
  rateLimitCooldownMinutes: 120,
  accountParallelism: 1,
};

const app = {
  browser: "chromium",
  headless: false,
  networkEvidenceEnabled: false,
};

test("风险等级按最高严重度汇总", () => {
  assert.equal(highestRisk(["low", "medium", "high", "medium"]), "high");
  assert.equal(highestRisk([]), "low");
});

test("保守 Chromium 配置不产生中高风险配置项", () => {
  const report = auditOperationRisk({ app, safety });
  assert.equal(report.risk, "low");
  assert.equal(report.findings.filter((item) => item.level !== "low").length, 0);
});

test("显式频率限制属于高风险账号信号", () => {
  const report = assessAccountRisk(
    {
      account_key: "a1",
      enabled: true,
      status: "rate_limited",
      runs_today: 10,
      runs_last_hour: 4,
      cooldown_until: "2026-09-14T08:00:00.000Z",
    },
    { safety, now: new Date("2026-09-14T07:00:00.000Z") },
  );
  assert.equal(report.level, "high");
  assert.match(report.reasons.join(" "), /频率限制/);
  assert.equal(report.availability, "temporary");
});

test("接近滚动小时上限会升为中风险", () => {
  const report = assessAccountRisk(
    {
      account_key: "a1",
      enabled: true,
      status: "healthy",
      runs_today: 12,
      runs_last_hour: 15,
      last_run_at: "2026-09-14T06:30:00.000Z",
    },
    { safety, now: new Date("2026-09-14T07:00:00.000Z") },
  );
  assert.equal(report.level, "medium");
  assert.match(report.reasons.join(" "), /最近 1 小时/);
});

test("总体风险取配置与账号实时风险的最高值", () => {
  const report = summarizeOperationRisk(
    [
      { account_key: "a1", enabled: true, status: "healthy", runs_today: 1, runs_last_hour: 1 },
      { account_key: "a2", enabled: true, status: "verification_required", runs_today: 1, runs_last_hour: 1 },
    ],
    { app, safety, now: new Date("2026-09-14T07:00:00.000Z") },
  );
  assert.equal(report.risk, "high");
  assert.equal(report.highRiskAccounts, 1);
});

test("首页风险面板包含活跃批次停止控制，但不出现验证码绕过逻辑", () => {
  const previous = {
    browser: process.env.ONEGL_BROWSER,
    headless: process.env.ONEGL_HEADLESS,
    hourly: process.env.ONEGL_ACCOUNT_HOURLY_LIMIT,
    daily: process.env.ONEGL_ACCOUNT_DAILY_LIMIT,
  };
  process.env.ONEGL_BROWSER = "chromium";
  process.env.ONEGL_HEADLESS = "false";
  process.env.ONEGL_ACCOUNT_HOURLY_LIMIT = "20";
  process.env.ONEGL_ACCOUNT_DAILY_LIMIT = "60";
  try {
    const system = {
      accounts: {
        healthy: [
          {
            account_key: "account_01",
            provider: "doubao",
            enabled: true,
            status: "healthy",
            runs_today: 3,
            consecutive_failures: 0,
          },
        ],
        auto_waiting: [],
        manual_attention: [],
        disabled: [],
        usable: 1,
        total: 1,
      },
      activeBatches: [{ id: 12, status: "running" }, { id: 13, status: "queued" }],
    };
    const html = riskDashboardPanel(system, { active: "home" });
    assert.match(html, /一键暂停当前全部采集/);
    assert.match(html, /\/batches\/.*\/stop/);
    assert.match(html, /account_01/);
    assert.doesNotMatch(html, /captcha.*solve|验证码识别|绕过验证/i);
    assert.equal(sidebarRisk(system).level, "low");
  } finally {
    if (previous.browser == null) delete process.env.ONEGL_BROWSER;
    else process.env.ONEGL_BROWSER = previous.browser;
    if (previous.headless == null) delete process.env.ONEGL_HEADLESS;
    else process.env.ONEGL_HEADLESS = previous.headless;
    if (previous.hourly == null) delete process.env.ONEGL_ACCOUNT_HOURLY_LIMIT;
    else process.env.ONEGL_ACCOUNT_HOURLY_LIMIT = previous.hourly;
    if (previous.daily == null) delete process.env.ONEGL_ACCOUNT_DAILY_LIMIT;
    else process.env.ONEGL_ACCOUNT_DAILY_LIMIT = previous.daily;
  }
});
