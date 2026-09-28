import assert from "node:assert/strict";
import test from "node:test";

import { buildBrandSourceIntelligence } from "../src/db/brand-source-intelligence.js";
import { CITATION_EVIDENCE_STATES, CITATION_UNRELIABLE_STATES } from "../src/db/citation-validity.js";

function fakePool(runRows) {
  return {
    async query(sql, params) {
      assert.deepEqual(params, [9]);
      if (/FROM sampling_batches WHERE id = \$1/.test(sql)) {
        return {
          rows: [
            {
              batch_status: "completed",
              batch_finished_at: "2026-09-15T04:00:00Z",
              generation: 1,
              status: "completed",
              queued_at: "2026-09-15T04:00:01Z",
              started_at: "2026-09-15T04:00:02Z",
              finished_at: "2026-09-15T04:00:03Z",
              error: null,
              stale: false,
            },
          ],
        };
      }
      assert.match(sql, /c\.source_type = 'visible'/);
      assert.match(sql, /c\.visible_to_user IS TRUE/);
      // 引用有效性的 citation_state 白名单来自 db/citation-validity.js：
      // 各平台词表不同（千问 'ok'、豆包 'found'），断言必须跟随共享定义，
      // 不能就地写死一份字面量，否则修一处漏一处。
      assert.match(sql, /r\.citation_state IN \([^\)]*\)/);
      for (const state of CITATION_EVIDENCE_STATES) {
        assert.ok(sql.includes(`'${state}'`), `引用口径包含 ${state}`);
      }
      for (const state of CITATION_UNRELIABLE_STATES) {
        // 不可信状态不能出现在白名单里，否则会混入「抓到条数对不上」的运行
        assert.ok(
          !new RegExp(`r\\.citation_state IN \\([^)]*'${state}'`).test(sql),
          `引用口径排除 ${state}`,
        );
      }
      return { rows: runRows };
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
      status: "success",
      citation_state: "found",
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
      status: "success",
      citation_state: "found",
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
  assert.equal(result.coverage.answerValidRuns, 2);
  assert.equal(result.coverage.citationValidRuns, 2);
  assert.equal(result.coverage.citationEvidenceRate, 1);
  assert.equal(result.job.status, "completed");
});

test("页面当前抓取失败时，不沿用旧 brand_mentioned 作为品牌证据", async () => {
  const rows = [
    {
      id: "3",
      local_run_id: "r3",
      status: "success",
      citation_state: "found",
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
