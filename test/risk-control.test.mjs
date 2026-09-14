import assert from "node:assert/strict";
import test from "node:test";

import {
  AVAILABILITY,
  classifyAccountState,
} from "../src/accounts/safety.js";
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
