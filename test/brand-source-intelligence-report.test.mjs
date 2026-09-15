import assert from "node:assert/strict";
import test from "node:test";

import { brandSourceIntelligenceHtml } from "../src/report/brand-source-intelligence.js";

function detail() {
  return {
    intelligence: {
      queries: [
        {
          prompt: "长沙腰痛调理去哪好",
          category: "本地推荐",
          validRuns: 2,
          aiBrandMentionedRuns: 1,
          aiBrandMentionRate: 0.5,
          uniqueSourceCount: 2,
          brandEvidenceSourceCount: 1,
          topSources: [{ domain: "example.com", citations: 2 }],
        },
      ],
      sources: [
        {
          canonicalUrl: "https://example.com/article-a",
          title: "长沙腰痛调理机构参考",
          domain: "example.com",
          citationCount: 2,
          promptCount: 1,
          page: {
            fetchState: "success",
            contentExcerpt: "文章介绍了本地调理机构，其中包含测试品牌的公开信息。",
            contentProfile: { type: "recommendation_list", structure: ["H1", "H2", "LIST"] },
            brandMentioned: true,
            brandMentionCount: 2,
            brandLocations: ["body"],
            brandContexts: [{ snippet: "其中包含测试品牌的公开信息" }],
          },
        },
        {
          canonicalUrl: "https://hospital.example/guide",
          title: "腰痛科普指南",
          domain: "hospital.example",
          citationCount: 1,
          promptCount: 1,
          page: {
            fetchState: "success",
            contentExcerpt: "介绍腰痛常见原因和就医建议。",
            contentProfile: { type: "informational", structure: ["H1", "H2"] },
            brandMentioned: false,
            brandMentionCount: 0,
          },
        },
      ],
      brandEvidenceSources: [
        {
          canonicalUrl: "https://example.com/article-a",
          title: "长沙腰痛调理机构参考",
          domain: "example.com",
          citationCount: 2,
          promptCount: 1,
          page: {
            brandMentioned: true,
            brandMentionCount: 2,
            brandLocations: ["body"],
            brandContexts: [{ snippet: "其中包含测试品牌的公开信息" }],
          },
        },
      ],
      structure: {
        citedSources: 2,
        analyzedSources: 2,
        coverageRate: 1,
        profileTypes: [{ label: "recommendation_list", count: 1 }, { label: "informational", count: 1 }],
        commonStructures: [{ label: "H1 + H2", count: 1 }],
        withH2Rate: 1,
        withListRate: 0.5,
        withTableRate: 0,
        withFaqRate: 0,
        averageTextLength: 1800,
        averageH2Count: 3,
      },
      coverage: {
        citedSources: 2,
        analyzedSources: 2,
        analysisRate: 1,
        brandEvidenceSources: 1,
        brandEvidenceRate: 0.5,
      },
      attributionNote: "同一回答共同观测，不声明单 URL 因果。",
    },
  };
}

test("主情报视图回答 Query、品牌、引用链接、文章结构和品牌证据", () => {
  const html = brandSourceIntelligenceHtml(detail());
  assert.match(html, /搜索问题 → AI 是否出现目标品牌/);
  assert.match(html, /AI 引用最多的是哪些链接/);
  assert.match(html, /被引用文章大部分是什么结构/);
  assert.match(html, /哪些被引用文章本身提到了目标品牌/);
  assert.match(html, /长沙腰痛调理去哪好/);
  assert.match(html, /https:\/\/example\.com\/article-a/);
  assert.match(html, /recommendation_list/);
  assert.match(html, /测试品牌的公开信息/);
  assert.match(html, /不等于证明该 URL 是 AI 提及品牌的唯一原因/);
});

test("外部标题和 URL 文本会转义，不注入 HTML", () => {
  const input = detail();
  input.intelligence.sources[0].title = '<img src=x onerror="alert(1)">';
  const html = brandSourceIntelligenceHtml(input);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});
