import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { executeDoubaoPrompt } from "../src/doubao.js";
import { ErrorCode } from "../src/errors.js";
import { hardenDoubaoCitationFallback } from "../src/providers/doubao-web.js";

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
