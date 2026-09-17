import assert from "node:assert/strict";
import test from "node:test";
import {
  createNetworkEvidenceCollector,
  extractSearchEvidence,
} from "../src/network-evidence.js";

test("extracts queries and retrieved sources from a block_type 10025 SSE event", () => {
  const payload = {
    event_data: JSON.stringify({
      block_type: 10025,
      block_content: JSON.stringify({
        queries: ["豆包 GEO", { query: "豆包 引用 来源" }],
        results: [
          {
            title: "Example A",
            url: "https://example.com/a?utm_source=test",
            summary: "A summary",
            source: "Example",
          },
          {
            title: "Internal",
            url: "https://www.doubao.com/internal",
          },
        ],
      }),
    }),
  };

  const text = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  const evidence = extractSearchEvidence(text);

  assert.deepEqual(evidence.queries, ["豆包 GEO", "豆包 引用 来源"]);
  assert.equal(evidence.retrievedSources.length, 1);
  assert.equal(evidence.retrievedSources[0].canonicalUrl, "https://example.com/a");
  assert.equal(evidence.retrievedSources[0].sourceType, "retrieved");
  assert.equal(evidence.retrievedSources[0].visibleToUser, false);
  assert.equal(evidence.retrievedSources[0].capturedFrom, "NETWORK");
});

test("deduplicates the same retrieved URL across nested blocks", () => {
  const text = JSON.stringify({
    search_query_result_block: {
      queries: ["q1", "q1"],
      results: [
        { url: "https://example.com/a?utm_medium=x", title: "First" },
        { url: "https://example.com/a?utm_campaign=y", summary: "Later summary" },
      ],
    },
  });

  const evidence = extractSearchEvidence(text);
  assert.deepEqual(evidence.queries, ["q1"]);
  assert.equal(evidence.retrievedSources.length, 1);
  assert.equal(evidence.retrievedSources[0].title, "First");
  assert.equal(evidence.retrievedSources[0].summary, "Later summary");
});

test("collector keeps only structured evidence and strips endpoint query strings", async () => {
  const listeners = new Map();
  const page = {
    on(event, fn) {
      listeners.set(event, fn);
    },
    off(event, fn) {
      if (listeners.get(event) === fn) listeners.delete(event);
    },
  };

  const collector = createNetworkEvidenceCollector(page, { bodyTimeoutMs: 100, evidenceEndpoints: [/.*/] });
  const response = {
    url: () => "https://www.doubao.com/api/chat/stream?conversation_id=secret",
    status: () => 200,
    headers: () => ({ "content-type": "text/event-stream" }),
    body: async () =>
      Buffer.from(
        `data: ${JSON.stringify({
          block_type: 10025,
          queries: ["绍兴正骨推荐"],
          results: [{ title: "A", url: "https://example.com/a" }],
        })}\n\n`,
      ),
  };

  listeners.get("response")(response);
  const evidence = await collector.stop();

  assert.equal(evidence.state, "found");
  assert.deepEqual(evidence.queries, ["绍兴正骨推荐"]);
  assert.equal(evidence.retrievedSources.length, 1);
  assert.equal(evidence.responses[0].endpoint, "https://www.doubao.com/api/chat/stream");
  assert.equal(listeners.has("response"), false);
});

test("collector parses search evidence nested inside stringified event_data", async () => {
  const listeners = new Map();
  const page = {
    on(event, fn) {
      listeners.set(event, fn);
    },
    off(event, fn) {
      if (listeners.get(event) === fn) listeners.delete(event);
    },
  };

  const collector = createNetworkEvidenceCollector(page, { bodyTimeoutMs: 100, evidenceEndpoints: [/.*/] });
  const nested = {
    event_data: JSON.stringify({
      block_type: 10025,
      block_content: JSON.stringify({
        queries: ["nested q"],
        results: [{ url: "https://example.org/source", title: "Nested" }],
      }),
    }),
  };
  listeners.get("response")({
    url: () => "https://www.doubao.com/api/chat/stream",
    status: () => 200,
    headers: () => ({ "content-type": "text/event-stream" }),
    body: async () => Buffer.from(`data: ${JSON.stringify(nested)}\n\n`),
  });

  const evidence = await collector.stop();
  assert.deepEqual(evidence.queries, ["nested q"]);
  assert.equal(evidence.retrievedSources[0].canonicalUrl, "https://example.org/source");
});

test("collector drops identifiers and log sentences that are not real queries", async () => {
  const listeners = new Map();
  const page = {
    on(event, fn) {
      listeners.set(event, fn);
    },
    off(event, fn) {
      if (listeners.get(event) === fn) listeners.delete(event);
    },
  };
  const collector = createNetworkEvidenceCollector(page, { bodyTimeoutMs: 100, evidenceEndpoints: [/.*/] });
  const response = {
    url: () => "https://www.doubao.com/im/conversation/batch_get",
    status: () => 200,
    headers: () => ({ "content-type": "application/json" }),
    body: async () =>
      Buffer.from(
        JSON.stringify({
          block_type: 10025,
          queries: [
            "绍兴中医馆推荐",
            "96baaa315e688ddea88a3aeb7684a071",
            "辑消息",
            "心跳正常 第三方活动更新 历史任务后台生成中 模型等待阶段",
          ],
          results: [{ title: "A", url: "https://example.com/a" }],
        }),
      ),
  };

  listeners.get("response")(response);
  const evidence = await collector.stop();

  assert.deepEqual(evidence.queries, ["绍兴中医馆推荐"]);
  assert.ok(evidence.rejectedQueryCount >= 2);
});

test("collector ignores responses that are not this turn's retrieval endpoint", async () => {
  const listeners = new Map();
  const page = {
    on(event, fn) {
      listeners.set(event, fn);
    },
    off(event, fn) {
      if (listeners.get(event) === fn) listeners.delete(event);
    },
  };
  // Default endpoint policy: only the completion stream counts.
  const collector = createNetworkEvidenceCollector(page, { bodyTimeoutMs: 100 });
  const historyResponse = {
    url: () => "https://www.doubao.com/im/conversation/batch_get",
    status: () => 200,
    headers: () => ({ "content-type": "application/json" }),
    body: async () =>
      Buffer.from(
        JSON.stringify({
          block_type: 10025,
          queries: ["历史轮次的问题"],
          results: [{ title: "旧候选", url: "https://example.com/old" }],
        }),
      ),
  };

  listeners.get("response")(historyResponse);
  const evidence = await collector.stop();

  assert.equal(evidence.state, "none");
  assert.deepEqual(evidence.queries, []);
  assert.equal(evidence.retrievedSources.length, 0);
  assert.equal(evidence.responses.length, 0);
});

test("collector marks an unsettled Playwright body as partial instead of a measured zero", async () => {
  const listeners = new Map();
  const page = {
    on(event, fn) {
      listeners.set(event, fn);
    },
    off(event, fn) {
      if (listeners.get(event) === fn) listeners.delete(event);
    },
  };
  const collector = createNetworkEvidenceCollector(page, {
    bodyTimeoutMs: 20,
    evidenceEndpoints: [/.*/],
  });
  listeners.get("response")({
    url: () => "https://www.doubao.com/chat/completion",
    status: () => 200,
    headers: () => ({ "content-type": "text/event-stream" }),
    body: () => new Promise(() => {}),
  });

  const evidence = await collector.stop();
  assert.equal(evidence.state, "partial");
  assert.deepEqual(evidence.queries, []);
  assert.equal(evidence.responses.length, 0);
  assert.ok(evidence.diagnostics.some((value) => value.startsWith("body-timeout:")));
});
