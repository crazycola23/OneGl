import assert from "node:assert/strict";
import test from "node:test";

import { computeBrandMentions, normalizeBrands } from "../src/analysis/brand-mentions.js";

/**
 * available 字段的语义测试。
 *
 * 它存在的理由：一次安全审查发现，对比端点无法区分
 * 「没做品牌统计」（请求没传 brands）和「统计了但都没提到」。
 * 前者应该报 available=false，后者是 available=true + 空品牌列表。
 * 混为一谈会让调用方把「没测」读成「下降到 0」。
 */

const long = (core) => core + "。".repeat(90);
const ANSWERS = [
  { runId: "r1", provider: "qianwen", text: long("思邈棠值得推荐。") },
  { runId: "r2", provider: "qianwen", text: long("沈园堂也不错。") },
];

test("传了品牌且有可用回答 → available=true", () => {
  const brands = normalizeBrands([{ name: "思邈棠" }]);
  const r = computeBrandMentions(ANSWERS, brands);
  assert.equal(r.available, true);
  assert.equal(r.answer_count, 2);
});
test("没传 brands → available=false（没做这项分析）", () => {
  // 没传品牌列表就无从「统计」，brands 为空是分析未执行的结果，
  // 而非「分析执行了但一个都没提到」。这两种必须能区分。
  const r = computeBrandMentions(ANSWERS, []);
  assert.equal(r.available, false, "未传品牌时不应声称做了品牌分析");
  assert.deepEqual(r.brands, []);
  assert.ok(r.answer_count > 0, "回答本身仍然是可用的，只是没做品牌分析");
});

test("传了品牌但都没被提到 → available=true 且 mention_rate=0", () => {
  // 这才是「分析执行了、结论是零」：与 available=false 语义相反
  const brands = normalizeBrands([{ name: "查无此店" }]);
  const r = computeBrandMentions(ANSWERS, brands);
  assert.equal(r.available, true);
  assert.equal(r.brands.length, 1);
  assert.equal(r.brands[0].mentioned_answers, 0);
  assert.equal(r.brands[0].mention_rate, 0, "确实没提到就是 0，不是 null");
});

test("传了品牌但没有可用回答 → available=false", () => {
  const brands = normalizeBrands([{ name: "思邈棠" }]);
  const r = computeBrandMentions([{ runId: "x", provider: "qianwen", text: "" }], brands);
  assert.equal(r.available, false, "没有可用回答时不应声称做了统计");
});

test("排除了不可信回答后分母下降，available 仍为 true", () => {
  const brands = normalizeBrands([{ name: "思邈棠" }]);
  const r = computeBrandMentions(
    [...ANSWERS, { runId: "junk", provider: "qianwen", text: "找到 1 篇资料" }],
    brands,
  );
  assert.equal(r.available, true);
  assert.equal(r.answer_count, 2, "废答案不进分母");
  assert.equal(r.excluded_answers, 1, "被排除的条数如实上报");
});

test("truncated 默认为 false，触上限时由报告层置位", () => {
  const brands = normalizeBrands([{ name: "思邈棠" }]);
  const r = computeBrandMentions(ANSWERS, brands);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.notes, []);
});
