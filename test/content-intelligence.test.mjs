import assert from "node:assert/strict";
import test from "node:test";

import { compileBrandRules } from "../src/brand/detect.js";
import { buildPageContentIntelligence } from "../src/analysis/content-intelligence.js";

const html = `<!doctype html>
<html><head><title>长沙腰痛调理机构推荐</title><meta name="description" content="本地机构选择参考"></head>
<body><article>
<h1>长沙腰痛调理怎么选</h1>
<p>腰痛反复时应先区分急性损伤与慢性问题，再决定是否需要进一步就医。</p>
<h2>本地机构推荐</h2>
<p>如果关注中医调理，可以了解测试品牌。测试品牌公开介绍包含推拿与日常调理服务。</p>
<ul><li>先看机构资质</li><li>再看适用范围</li></ul>
<h2>常见问题</h2>
<p>测试品牌适不适合所有人？应结合个人情况判断。</p>
<table><tr><th>维度</th><th>说明</th></tr><tr><td>服务</td><td>公开信息</td></tr></table>
</article></body></html>`;

test("引用页内容情报提取标题层级、内容类型与品牌证据", () => {
  const brandRules = compileBrandRules({ name: "测试品牌", aliases: ["测试堂"] });
  const result = buildPageContentIntelligence(html, {
    titleText: "长沙腰痛调理机构推荐",
    metaDescription: "本地机构选择参考",
    tableCount: 1,
    listCount: 1,
    faqHeadingCount: 1,
    schemaTypes: ["Article"],
    brandRules,
  });

  assert.equal(result.contentProfile.type, "recommendation_list");
  assert.deepEqual(result.contentProfile.structure, ["H1", "H2", "TABLE", "LIST", "FAQ"]);
  assert.equal(result.brandMentioned, true);
  assert.equal(result.brandMentionCount, 3);
  assert.ok(result.brandLocations.includes("h2") === false);
  assert.ok(result.brandLocations.includes("body"));
  assert.ok(result.outline.some((row) => row.level === 2 && row.text === "本地机构推荐"));
  assert.match(result.contentExcerpt, /测试品牌公开介绍/);
  assert.ok(result.brandContexts.length >= 1);
});

test("品牌排除规则沿用回答侧规则，避免同名误报", () => {
  const rules = compileBrandRules({
    name: "苹果",
    excludePatterns: ["苹果手机"],
  });
  const result = buildPageContentIntelligence(
    "<article><h1>手机推荐</h1><p>苹果手机近期发布了新型号。</p></article>",
    { titleText: "手机推荐", brandRules: rules },
  );
  assert.equal(result.brandMentioned, false);
  assert.equal(result.brandMentionCount, 0);
});
