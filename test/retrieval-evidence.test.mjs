import assert from "node:assert/strict";
import test from "node:test";
import {
  exactCitationMatch,
  prepareRetrievedSources,
  prepareSearchQueries,
} from "../src/db/retrieval.js";

test("prepareSearchQueries deduplicates case-insensitively and preserves order", () => {
  assert.deepEqual(prepareSearchQueries([" 豆包 GEO ", "豆包 geo", "引用 来源"]), [
    { queryPosition: 1, queryText: "豆包 GEO" },
    { queryPosition: 2, queryText: "引用 来源" },
  ]);
});

test("prepareRetrievedSources keeps network-only candidates and deduplicates canonical URLs", () => {
  const { rows, skipped } = prepareRetrievedSources([
    {
      url: "https://example.com/a?utm_source=x",
      title: "A",
      sourceType: "retrieved",
      visibleToUser: false,
      sourcePosition: 2,
    },
    {
      url: "https://example.com/a?utm_campaign=y",
      title: "A duplicate",
      sourceType: "retrieved",
      visibleToUser: false,
    },
    {
      url: "https://example.com/visible",
      sourceType: "visible",
      visibleToUser: true,
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].canonicalUrl, "https://example.com/a");
  assert.equal(rows[0].sourcePosition, 2);
  assert.equal(rows[0].capturedFrom, "NETWORK");
  assert.equal(rows[0].visibleToUser, false);
  assert.deepEqual(skipped, [{ index: 2, reason: "not-retrieved" }]);
});

test("exactCitationMatch only accepts canonical URL exact equality", () => {
  const visible = new Map([["https://example.com/a", { id: 42 }]]);
  assert.deepEqual(exactCitationMatch("https://example.com/a", visible), {
    visibleCitationId: 42,
    matchMethod: "canonical_url_exact",
  });
  assert.deepEqual(exactCitationMatch("https://example.com/b", visible), {
    visibleCitationId: null,
    matchMethod: null,
  });
});
