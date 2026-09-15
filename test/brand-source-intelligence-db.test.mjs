import assert from "node:assert/strict";
import test from "node:test";

import { buildBrandSourceIntelligence } from "../src/db/brand-source-intelligence.js";

function fakePool(rows) {
  return {
    async query(sql, params) {
      assert.match(sql, /c\.visible_to_user IS NOT FALSE/);
      assert.deepEqual(params, [9]);
      return { rows };
    },
  };
}

test("同一 Prompt 多次 Run 时，示例回答优先选择真正含品牌的回答", async () => {
  const page = {
    fetchState: "success",
    brandMentioned: false,
    contentProfile: { type: "informational", structure: ["H1", "H2"] },
  };
  const rows = [
    {
      id: "1",
      local_run_id: "r1",
      prompt: "本地调理机构怎么选",
      category: "推荐",
      brand_mentioned: false,
      mention_count: 0,
      answer_excerpt: "第一次回答没有出现目标品牌。",
      citations: [{ canonicalUrl: "https://a.example/1", title: "A", domain: "a.example", sourcePosition: 1, page }],
    },
    {
      id: "2",
      local_run_id: "r2",
      prompt: "本地调理机构怎么选",
      category: "推荐",
      brand_mentioned: true,
      mention_count: 1,
      answer_excerpt: "第二次回答明确推荐了测试品牌。",
      citations: [{ canonicalUrl: "https://a.example/1", title: "A", domain: "a.example", sourcePosition: 1, page }],
    },
  ];

  const result = await buildBrandSourceIntelligence(fakePool(rows), 9);
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].aiBrandMentionedRuns, 1);
  assert.equal(result.queries[0].aiBrandMentionRate, 0.5);
  assert.equal(result.queries[0].exampleAnswerContainsBrand, true);
  assert.equal(result.queries[0].exampleAnswer, "第二次回答明确推荐了测试品牌。");
  assert.equal(result.queries[0].topSources[0].url, "https://a.example/1");
});

test("页面当前抓取失败时，不沿用旧 brand_mentioned 作为品牌证据", async () => {
  const rows = [
    {
      id: "3",
      local_run_id: "r3",
      prompt: "测试品牌怎么样",
      category: "品牌直问",
      brand_mentioned: true,
      mention_count: 1,
      answer_excerpt: "回答出现测试品牌。",
      citations: [
        {
          canonicalUrl: "https://stale.example/a",
          title: "旧页面",
          domain: "stale.example",
          sourcePosition: 1,
          page: {
            fetchState: "blocked",
            brandMentioned: true,
            brandMentionCount: 4,
          },
        },
      ],
    },
  ];

  const result = await buildBrandSourceIntelligence(fakePool(rows), 9);
  assert.equal(result.brandEvidenceSources.length, 0);
  assert.equal(result.queries[0].brandEvidenceSourceCount, 0);
  assert.equal(result.domains[0].brandEvidenceSources, 0);
  assert.equal(result.coverage.analyzedSources, 0);
  assert.equal(result.coverage.brandEvidenceRate, null);
});
