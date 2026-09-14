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

  const collector = createNetworkEvidenceCollector(page, { bodyTimeoutMs: 100 });
  const response = {
    url: () => "https://www.doubao.com/api/chat/stream?conversation_id=secret",
    status: () => 200,
    headers: () => ({ "content-type": "text/event-stream" }),
    body: async () =>
      Buffer.from(
        `data: ${JSON.stringify({
          block_type: 10025,
          queries: ["q"],
          results: [{ title: "A", url: "https://example.com/a" }],
        })}\n\n`,
      ),
  };

  listeners.get("response")(response);
  const evidence = await collector.stop();

  assert.equal(evidence.state, "found");
  assert.deepEqual(evidence.queries, ["q"]);
  assert.equal(evidence.retrievedSources.length, 1);
  assert.equal(evidence.responses[0].endpoint, "https://www.doubao.com/api/chat/stream");
  assert.equal(listeners.has("response"), false);
});
