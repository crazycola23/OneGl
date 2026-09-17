import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runOnePrompt } from "../src/collect/runner.js";
import { loadConfig } from "../src/config.js";
import { executeDoubaoPrompt } from "../src/doubao.js";
import { ErrorCode } from "../src/errors.js";
import { hardenDoubaoCitationFallback } from "../src/providers/doubao-web.js";
import { RunStore } from "../src/store.js";

function createResetMockPage(answerBubbles) {
  const calls = { fills: [] };
  const textbox = {
    async fill(value) { calls.fills.push(value); },
    async click() {},
    async isVisible() { return true; },
    async isEditable() { return true; },
    async evaluate() { return ""; },
  };
  const emptyLocator = {
    async count() { return 0; },
    nth: () => textbox,
  };

  return {
    calls,
    url: () => "https://www.doubao.com/chat/",
    async waitForTimeout() {},
    async goto() {},
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

test("a leftover user-only bubble does not count as an empty conversation", async () => {
  const page = createResetMockPage([
    { text: "上一轮用户问题", isUser: true, streaming: false },
  ]);
  const config = loadConfig({ headless: true, conversationSettleMs: 60 });

  await assert.rejects(
    () => executeDoubaoPrompt(page, "绝不能发送这个 prompt", config),
    (error) => error?.code === ErrorCode.CONVERSATION_RESET_FAILED,
  );

  assert.deepEqual(page.calls.fills, [""]);
  assert.equal(page.calls.fills.includes("绝不能发送这个 prompt"), false);
});

test("inline links without the verified reference block remain diagnostic evidence only", () => {
  const hardened = hardenDoubaoCitationFallback({
    answer: "答案正文",
    citations: [{ url: "https://example.com/a" }],
    citationState: "found",
    expectedCitationCount: 1,
    citationDiagnostics: ["inline-link-fallback"],
    citationSelectorUsed: "inline-links",
  });

  assert.equal(hardened.citationState, "parse_failed");
  assert.equal(hardened.expectedCitationCount, null);
  assert.equal(hardened.citations.length, 1);
  assert.ok(hardened.citationDiagnostics.includes("reference-block-not-found"));
  assert.ok(hardened.citationDiagnostics.includes("inline-links-observed"));
});

test("verified reference-block citation results are not downgraded", () => {
  const raw = {
    citations: [{ url: "https://example.com/a" }],
    citationState: "found",
    expectedCitationCount: 1,
    citationDiagnostics: [],
    citationSelectorUsed: '[data-plugin-identifier*="block_type:10025"]',
  };
  assert.equal(hardenDoubaoCitationFallback(raw), raw);
});

test("a completed local observation retries persistence without entering provider collection", async () => {
  const previous = {
    id: "run_batch_9_1",
    status: "success",
    dbStatus: "failed",
    provider: "doubao",
    project: "svc:t1:test:nonce",
    prompt: "新能源 SUV 推荐",
    accountKey: "acct_primary",
    samplingBatchId: 9,
    runToken: "batch:9:1",
    jobId: "job-9-1",
    attempt: 1,
    startedAt: "2026-09-17T00:00:00.000Z",
    completedAt: "2026-09-17T00:00:10.000Z",
    answer: "已经采集完成的答案",
    citationState: "none_visible",
    expectedCitationCount: 0,
    citations: [],
    citationDiagnostics: [],
    conversationResetConfirmed: true,
  };

  let readCount = 0;
  let createCount = 0;
  const store = {
    async readRun(runId) {
      readCount += 1;
      assert.equal(runId, previous.id);
      return { ...previous };
    },
    async updateRun(runId, patch) {
      assert.equal(runId, previous.id);
      return { ...previous, ...patch };
    },
    async createRun() {
      createCount += 1;
      throw new Error("provider collection path must not be entered");
    },
  };
  const pool = {
    async connect() {
      throw new Error("postgres temporarily unavailable");
    },
  };

  const outcome = await runOnePrompt({
    page: null,
    store,
    config: { provider: "doubao" },
    prompt: previous.prompt,
    project: previous.project,
    pool,
    runId: previous.id,
    validation: { caseId: previous.runToken },
    context: {
      accountKey: previous.accountKey,
      samplingBatchId: previous.samplingBatchId,
      runToken: previous.runToken,
      jobId: previous.jobId,
      attempt: 2,
    },
  });

  assert.equal(outcome.persistenceReplay, true);
  assert.equal(outcome.ok, true);
  assert.ok(outcome.persistError);
  assert.equal(readCount, 1);
  assert.equal(createCount, 0);
});

test("an unsettled deterministic run refuses a later automatic attempt", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "onegl-run-state-"));
  const store = new RunStore({ dataDir });
  const runId = "run_batch_10_1";

  try {
    const first = await store.createRun({
      runId,
      prompt: "测试问题",
      project: "project",
      accountKey: "acct",
      samplingBatchId: 10,
      runToken: "batch:10:1",
      attempt: 1,
    });
    assert.equal(first.status, undefined);

    await assert.rejects(
      () => store.createRun({
        runId,
        prompt: "测试问题",
        project: "project",
        accountKey: "acct",
        samplingBatchId: 10,
        runToken: "batch:10:1",
        attempt: 2,
      }),
      (error) => error?.code === "RUN_STATE_UNCERTAIN" && error?.details?.previousAttempt === 1,
    );

    const untouched = await store.readRun(runId);
    assert.equal(untouched.attempt, 1);

    await store.updateRun(runId, {
      status: "failed",
      completedAt: "2026-09-17T00:00:10.000Z",
      errorCode: "DOUBAO_CONVERSATION_RESET_FAILED",
    });
    const retry = await store.createRun({
      runId,
      prompt: "测试问题",
      project: "project",
      accountKey: "acct",
      samplingBatchId: 10,
      runToken: "batch:10:1",
      attempt: 2,
    });
    assert.equal(retry.attempt, 2);
    assert.ok(retry.attemptHistory.some((entry) => entry.attempt === 1 && entry.status === "failed"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
