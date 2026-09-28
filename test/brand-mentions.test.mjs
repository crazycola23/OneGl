import assert from "node:assert/strict";
import test from "node:test";

import { BrandInputError, computeBrandMentions, normalizeBrands } from "../src/analysis/brand-mentions.js";

const answers = [
  { runId: "r1", provider: "qianwen", text: "推荐思邈棠中式养生体质调理（银泰城店） 核心优势：先辨证后调理。绍兴市中医院 特色：公立三甲。" },
  { runId: "r2", provider: "qianwen", text: "思邈棠值得一试，另外沈园堂也口碑不错。" },
  { runId: "r3", provider: "doubao", text: "1. 思邈棠中式养生体质调理\n📍位置：越城区\n✅适合：肩颈僵硬" },
  { runId: "r4", provider: "doubao", text: "董大盲人医疗按摩所 位置：老城区。适合：慢性酸痛。" },
];

test("normalizeBrands 接受最小输入并默认 role", () => {
  const brands = normalizeBrands([{ name: "思邈棠" }]);
  assert.equal(brands.length, 1);
  assert.equal(brands[0].name, "思邈棠");
  assert.equal(brands[0].role, "unspecified");
  assert.deepEqual(brands[0].aliases, []);
});

test("normalizeBrands 保留 role 与别名", () => {
  const brands = normalizeBrands([
    { name: "思邈棠", role: "competitor", aliases: ["思邈堂"], product_aliases: ["思邈棠中式养生"] },
  ]);
  assert.equal(brands[0].role, "competitor");
  assert.deepEqual(brands[0].aliases, ["思邈堂"]);
});

test("normalizeBrands 拒绝非法输入", () => {
  assert.throws(() => normalizeBrands("不是数组"), BrandInputError);
  assert.throws(() => normalizeBrands([{}]), /name is required/);
  assert.throws(() => normalizeBrands([{ name: "" }]), /name is required/);
  assert.throws(() => normalizeBrands([{ name: "A" }, { name: "A" }]), /duplicate/);
  assert.throws(() => normalizeBrands([{ name: "x".repeat(201) }]), /too long/);
  assert.throws(() => normalizeBrands([{ name: "a", aliases: "notarray" }]), /must be an array/);
});

test("computeBrandMentions 按提及回答数排序", () => {
  const brands = normalizeBrands([{ name: "思邈棠" }, { name: "沈园堂" }, { name: "不存在" }]);
  const result = computeBrandMentions(answers, brands);
  assert.equal(result.answer_count, 4);
  const names = result.brands.map((b) => b.name);
  assert.equal(names[0], "思邈棠", "思邈棠应在 3 条回答中被提及");
  assert.equal(names.at(-1), "不存在");
  assert.equal(result.brands.at(-1).mention_rate, 0);
});

test("提及率分母是该平台全部有正文的回答数", () => {
  const brands = normalizeBrands([{ name: "思邈棠" }]);
  const result = computeBrandMentions(answers, brands);
  const smt = result.brands[0];
  // 思邈棠出现在 r1/r2/r3 共 3 条，qianwen 2 条 + doubao 1 条
  assert.equal(smt.mentioned_answers, 3);
  assert.equal(smt.valid_answers, 4);
  assert.equal(smt.mention_rate, 0.75);
  assert.equal(smt.by_platform.qianwen.valid_answers, 2);
  assert.equal(smt.by_platform.doubao.valid_answers, 2);
});

test("别名与产品名参与匹配并记录 match_terms", () => {
  const brands = normalizeBrands([{ name: "思邈棠", aliases: ["思邈堂"], product_aliases: ["思邈棠中式养生"] }]);
  const result = computeBrandMentions(answers, brands);
  assert.ok(result.brands[0].match_terms.includes("思邈棠"));
  assert.ok(result.brands[0].match_terms.includes("思邈堂"));
  assert.ok(result.brands[0].match_terms.includes("思邈棠中式养生"));
});

test("同一回答内多次出现只计一次提及率，但次数累加", () => {
  const brands = normalizeBrands([{ name: "思邈棠" }]);
  const once = computeBrandMentions(
    [{ runId: "x", provider: "qianwen", text: "思邈棠 思邈棠 思邈棠" }],
    brands,
  );
  assert.equal(once.brands[0].mentioned_answers, 1, "提及率分子按回答数计");
  assert.equal(once.brands[0].mention_count, 3, "mention_count 按出现次数累加");
});

test("未提及的品牌不产出示例，首现位置为 null", () => {
  const brands = normalizeBrands([{ name: "查无此店" }]);
  const result = computeBrandMentions(answers, brands);
  const b = result.brands[0];
  assert.equal(b.mentioned_answers, 0);
  assert.equal(b.average_first_position, null);
  assert.deepEqual(b.examples, []);
});

test("空回答列表不崩溃且口径明确", () => {
  const brands = normalizeBrands([{ name: "思邈棠" }]);
  const result = computeBrandMentions([], brands);
  assert.equal(result.answer_count, 0);
  assert.equal(result.brands[0].mention_rate, null, "分母为 0 时提及率必须是 null 而不是 0");
  assert.equal(result.interpretation.conclusion, null, "不含结论");
});

test("空白回答不计入分母", () => {
  const brands = normalizeBrands([{ name: "思邈棠" }]);
  const result = computeBrandMentions(
    [
      { runId: "a", provider: "qianwen", text: "思邈棠不错" },
      { runId: "b", provider: "qianwen", text: "   " },
      { runId: "c", provider: "qianwen", text: "" },
    ],
    brands,
  );
  assert.equal(result.answer_count, 1, "空白回答不计入");
  assert.equal(result.brands[0].mention_rate, 1);
});

test("示例带 run_id 与原文片段，便于回溯", () => {
  const brands = normalizeBrands([{ name: "思邈棠" }]);
  const result = computeBrandMentions(answers, brands);
  const ex = result.brands[0].examples[0];
  assert.ok(ex.run_id);
  assert.ok(ex.context.includes("思邈棠"));
  assert.ok(Array.isArray(ex.matched_terms));
});
