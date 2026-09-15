import assert from "node:assert/strict";
import test from "node:test";

import { brandSourceIntelligenceHtml } from "../src/report/brand-source-intelligence.js";

function detail() {
  return {
    intelligence: {
      job: {
        batch_status: "completed",
        generation: 2,
        status: "completed",
        queued_at: "2026-09-15T04:00:00Z",
        started_at: "2026-09-15T04:00:02Z",
        finished_at: "2026-09-15T04:00:08Z",
        error: null,
        stale: false,
      },
      queries: [
        {
          prompt: "长沙腰痛调理去哪好",
          category: "本地推荐",
          validRuns: 2,
          aiBrandMentionedRuns: 1,
          aiBrandMentionRate: 0.5,
          uniqueSourceCount: 2,
          brandEvidenceSourceCount: 1,
          topSources: [{ domain: "example.com", citations: 2, url: "https://example.com/article-a" }],
          exampleAnswer: "可以结合资质、适用范围和距离选择，本次回答提到了测试品牌。",
          exampleAnswerContainsBrand: true,
        },
      ],
      domains: [
        { domain: "example.com", citations: 2, sources: 1, promptCount: 1, brandEvidenceSources: 1 },
        { domain: "hospital.example", citations: 1, sources: 1, promptCount: 1, brandEvidenceSources: 0 },
      ],
      sources: [
        {
          canonicalUrl: "https://example.com/article-a",
          title: "长沙腰痛调理机构参考",
          domain: "example.com",
          citationCount: 2,
          promptCount: 1,
          prompts: ["长沙腰痛调理去哪好"],
          page: {
            fetchState: "success",
            contentExcerpt: "文章介绍了本地调理机构，其中包含测试品牌的公开信息。",
            contentProfile: { type: "recommendation_list", structure: ["H1", "H2", "LIST"] },
            outline: [{ level: 1, text: "长沙腰痛调理机构参考" }, { level: 2, text: "本地机构怎么选" }],
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
          prompts: ["长沙腰痛调理去哪好"],
          page: {
            fetchState: "success",
            contentExcerpt: "介绍腰痛常见原因和就医建议。",
            contentProfile: { type: "informational", structure: ["H1", "H2"] },
            outline: [{ level: 1, text: "腰痛科普指南" }],
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
          prompts: ["长沙腰痛调理去哪好"],
          page: {
            fetchState: "success",
            contentProfile: { type: "recommendation_list", structure: ["H1", "H2", "LIST"] },
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

test("主情报视图回答 Query、品牌、域名/链接、文章内容结构和品牌证据", () => {
  const html = brandSourceIntelligenceHtml(detail());
  assert.match(html, /搜索问题 → AI 是否出现目标品牌/);
  assert.match(html, /AI 的引用主要来自哪些域名与链接/);
  assert.match(html, /被引用文章大部分是什么结构/);
  assert.match(html, /哪些被引用文章本身提到了目标品牌/);
  assert.match(html, /引用页内容分析完成/);
  assert.match(html, /2 \/ 2 个唯一引用页已形成内容画像/);
  assert.match(html, /长沙腰痛调理去哪好/);
  assert.match(html, /含品牌的 AI 回答片段/);
  assert.match(html, /本次回答提到了测试品牌/);
  assert.match(html, /example\.com/);
  assert.match(html, /https:\/\/example\.com\/article-a/);
  assert.match(html, /文章内容摘要/);
  assert.match(html, /文章标题结构/);
  assert.match(html, /recommendation_list/);
  assert.match(html, /测试品牌的公开信息/);
  assert.match(html, /不等于证明该 URL 是 AI 提及品牌的唯一原因/);
});

test("分析运行中明确告诉用户后台自动补齐而不是要求手工跑命令", () => {
  const input = detail();
  input.intelligence.job.status = "running";
  input.intelligence.job.stale = true;
  input.intelligence.coverage.analyzedSources = 0;
  input.intelligence.coverage.analysisRate = 0;
  input.intelligence.brandEvidenceSources = [];
  const html = brandSourceIntelligenceHtml(input);
  assert.match(html, /正在分析引用页/);
  assert.match(html, /后台会自动补齐/);
  assert.match(html, /当前品牌证据列表仍可能变化/);
  assert.doesNotMatch(html, /可先运行 source:intelligence/);
});

test("仅抓取成功但没有 content profile 时不把页面误判成无品牌", () => {
  const input = detail();
  input.intelligence.sources[0].page = {
    fetchState: "success",
    contentProfile: {},
    brandMentioned: false,
  };
  const html = brandSourceIntelligenceHtml(input);
  assert.match(html, /已抓取 · 等待内容画像/);
  assert.match(html, /<td>N\/A<\/td>/);
});

test("外部标题和 URL 文本会转义，不注入 HTML", () => {
  const input = detail();
  input.intelligence.sources[0].title = '<img src=x onerror="alert(1)">';
  const html = brandSourceIntelligenceHtml(input);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});
