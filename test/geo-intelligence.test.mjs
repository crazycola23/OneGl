import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGeoOpportunities,
  citationDifficulty,
  computeCitationVolatility,
  computeQueryFanout,
  computeShareOfVoice,
  tokenizeFanout,
} from "../src/analysis/geo-intelligence.js";

test("tokenizeFanout handles Chinese and Latin terms", () => {
  const tokens = tokenizeFanout("2026年 小米 SU7 和 Model Y 怎么选？");
  assert.ok(tokens.some((token) => token.includes("小米")));
  assert.ok(tokens.some((token) => token.toLowerCase() === "su7"));
  assert.ok(tokens.some((token) => token.toLowerCase() === "model" || token.toLowerCase() === "model y"));
});

test("query fan-out excludes verbatim searches and measures rewrite coverage", () => {
  const fanout = computeQueryFanout([
    { promptId: "p1", prompt: "20万新能源SUV推荐", query: "20万新能源SUV推荐", brand_mentioned: false },
    { promptId: "p1", prompt: "20万新能源SUV推荐", query: "2026 20万 新能源 SUV 推荐", brand_mentioned: false },
    { promptId: "p1", prompt: "20万新能源SUV推荐", query: "2026 20万 新能源 SUV 推荐", brand_mentioned: true },
    { promptId: "p2", prompt: "国产SUV怎么选", query: "国产新能源 SUV 续航排名", brand_mentioned: true },
    { promptId: "p2", prompt: "国产SUV怎么选", query: "unavailable", brand_mentioned: true },
  ], { promptRunCounts: new Map([["p1", 2], ["p2", 1]]) });

  assert.equal(fanout.totalQueries, 3);
  assert.equal(fanout.uniqueQueries, 2);
  assert.equal(fanout.topQueries[0].count, 2);
  assert.equal(fanout.topQueries[0].brandMentionRate, 0.5);
  assert.ok(fanout.wordChanges.added.length > 0);
  assert.equal(fanout.byPrompt.find((row) => row.promptId === "p1").avgPerRun, 1);
});

test("citation volatility separates set churn from weighted source churn", () => {
  const result = computeCitationVolatility([
    { date: "2026-09-01", domain: "a.com", count: 8 },
    { date: "2026-09-01", domain: "b.com", count: 2 },
    { date: "2026-09-02", domain: "a.com", count: 8 },
    { date: "2026-09-02", domain: "c.com", count: 2 },
  ]);

  assert.equal(result.transitions, 1);
  assert.equal(result.setVolatility, 0.667);
  assert.equal(result.weightedVolatility, 0.2);
  assert.equal(result.stabilityScore, 80);
  assert.equal(citationDifficulty(result.stabilityScore), "locked-in");
});

test("share of voice uses comparable entity mention units", () => {
  const result = computeShareOfVoice(
    { name: "小米汽车", mentions: 3 },
    [{ name: "特斯拉", mentions: 5 }, { name: "比亚迪", mentions: 2 }],
  );
  assert.equal(result.totalMentions, 10);
  assert.equal(result.brandShare, 0.3);
  assert.equal(result.entries[0].name, "特斯拉");
});

test("deterministic opportunities stay grounded in measured signals", () => {
  const result = buildGeoOpportunities({
    visibilityRate: 0.2,
    stability: { stabilityScore: 35, weightedVolatility: 0.65 },
    promptGaps: [{ promptId: "1", prompt: "新能源SUV推荐", competitor: "特斯拉", gap: 0.5 }],
    fanout: { topQueries: [{ query: "新能源SUV续航排名", count: 6, brandMentionRate: 0.2 }] },
    topDomains: [{ domain: "example.com", citations: 12, share: 0.3 }],
  });

  assert.ok(result.some((row) => row.category === "competitive-gap"));
  assert.ok(result.some((row) => row.category === "query-coverage"));
  assert.ok(result.some((row) => row.category === "source-landscape"));
  assert.ok(result.some((row) => row.category === "source-surface"));
});
