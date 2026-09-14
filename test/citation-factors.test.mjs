import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCitationFactors,
  bucketPosition,
  candidateFeatures,
  diceSimilarity,
  lexicalUnits,
  rankFactorSignals,
  wilsonInterval,
} from "../src/analysis/citation-factors.js";

test("Chinese lexical overlap is higher for related titles than unrelated titles", () => {
  const prompt = "20万左右最值得买的新能源SUV有哪些";
  const related = diceSimilarity("20万新能源SUV推荐与选购指南", prompt);
  const unrelated = diceSimilarity("秋季家常菜做法大全", prompt);
  assert.ok(related > 0.2);
  assert.equal(unrelated, 0);
  assert.ok(lexicalUnits(prompt).size > 3);
});

test("candidate features keep retrieval and page evidence in explicit buckets", () => {
  const features = candidateFeatures({
    sourcePosition: 7,
    title: "豆包 GEO 引用来源研究",
    summary: "本文分析豆包如何展示引用来源。",
    sourceName: "Example",
    prompt: "豆包会引用哪些资料来源？",
    queries: ["豆包 引用 来源", "豆包 GEO"],
    searchQueryCount: 2,
    articleRetrievals: 5,
    pageEvidenceState: "success",
    pageTextLength: 6200,
    pageH2Count: 4,
    pageTableCount: 1,
    pageListCount: 2,
    pageFaqHeadingCount: 1,
    pageHasArticleSchema: true,
    pageHasFaqSchema: false,
    pageAuthorPresent: true,
    pageModifiedAtRaw: "2026-09-10",
    pageRobotsNoindex: false,
    pageNumericDensity: 8.2,
    pageExternalLinkCount: 6,
  });

  assert.equal(features.candidate_position, "6-10");
  assert.notEqual(features.title_prompt_overlap, "missing");
  assert.notEqual(features.title_query_overlap, "missing");
  assert.equal(features.summary_present, "yes");
  assert.equal(features.search_query_count, "2");
  assert.equal(features.article_retrieval_frequency, "4-9");
  assert.equal(features.page_text_length, "5k-15k");
  assert.equal(features.page_h2_count, "3-5");
  assert.equal(features.page_table_present, "yes");
  assert.equal(features.page_faq_heading_signal, "yes");
  assert.equal(features.page_article_schema, "yes");
  assert.equal(features.page_faq_schema, "no");
  assert.equal(features.page_modified_date_signal, "yes");
  assert.equal(features.page_noindex_signal, "no");
  assert.equal(features.page_numeric_density, "medium");
  assert.equal(features.page_external_links, "5-14");
  assert.equal(bucketPosition(12), "11+");
});

test("missing page evidence stays missing instead of becoming a negative feature", () => {
  const features = candidateFeatures({ sourcePosition: 1, pageEvidenceState: "blocked" });
  assert.equal(features.page_table_present, "missing");
  assert.equal(features.page_h2_count, "missing");
  assert.equal(features.page_numeric_density, "missing");
});

test("factor analysis reports baseline, uplift and Wilson intervals", () => {
  const rows = [
    { cited: true, sourcePosition: 1, title: "新能源汽车推荐", summary: "新能源SUV推荐", prompt: "新能源汽车推荐", queries: ["新能源汽车推荐"], searchQueryCount: 1, articleRetrievals: 2 },
    { cited: true, sourcePosition: 1, title: "新能源汽车品牌", summary: "新能源品牌", prompt: "新能源汽车推荐", queries: ["新能源汽车推荐"], searchQueryCount: 1, articleRetrievals: 1 },
    { cited: false, sourcePosition: 8, title: "完全无关标题", summary: null, prompt: "新能源汽车推荐", queries: ["新能源汽车推荐"], searchQueryCount: 1, articleRetrievals: 1 },
    { cited: false, sourcePosition: 12, title: "另一个无关页面", summary: null, prompt: "新能源汽车推荐", queries: ["新能源汽车推荐"], searchQueryCount: 1, articleRetrievals: 1 },
  ];
  const analysis = analyzeCitationFactors(rows, { minN: 1 });
  assert.equal(analysis.summary.candidates, 4);
  assert.equal(analysis.summary.cited, 2);
  assert.equal(analysis.summary.baselineRate, 0.5);
  const positionOne = analysis.factors.find((row) => row.factor === "candidate_position" && row.bucket === "1");
  assert.equal(positionOne.candidates, 2);
  assert.equal(positionOne.cited, 2);
  assert.equal(positionOne.rate, 1);
  assert.equal(positionOne.uplift, 1);
  assert.ok(positionOne.ciLow >= 0 && positionOne.ciHigh <= 1);
  const signals = rankFactorSignals(analysis, { minN: 2 });
  assert.ok(signals.some((row) => row.factor === "candidate_position"));
  assert.ok(!signals.some((row) => row.bucket === "missing"));
  const [low, high] = wilsonInterval(5, 10);
  assert.ok(low < 0.5 && high > 0.5);
});
