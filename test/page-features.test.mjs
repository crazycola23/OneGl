import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicHttpUrl, extractPageFeatures } from "../src/analysis/page-features.js";

const HTML = `<!doctype html>
<html><head>
<title>2026 新能源 SUV 选购报告</title>
<meta name="description" content="对比价格、续航和配置">
<meta name="author" content="研穵组">
<meta property="article:published_time" content="2026-08-01T08:00:00+08:00">
<meta property="article:modified_time" content="2026-09-10T12:00:00+08:00">
<meta name="robots" content="index,follow">
<link rel="canonical" href="https://example.com/report">
<script type="application/ld+json">{"@type":"Article","dateModified":"2026-09-10","author":{"@type":"Organization","name":"Lab"}}</script>
<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script>
</head><body>
<h1>新能源 SUV 怎么选？</h1>
<h2>核心结论</h2><p>测试 32 款车型，价格 15-30 万元，平均续航 610km。</p>
<h2>常见问题 FAQ</h2><p>20 万预算优先看补能和安全配置。</p>
<h3>续航是否越高越好？</h3>
<table><tr><td>A</td><td>620km</td></tr></table>
<ul><li>价格</li><li>续航</li></ul>
<a href="https://source.example.org/data">数据来源</a>
</body></html>`;

test("extractPageFeatures returns conservative observable HTML features", () => {
  const f = extractPageFeatures(HTML, { url: "https://example.com/report" });
  assert.equal(f.titleText, "2026 新能源 SUV 选购报告");
  assert.equal(f.h1Count, 1);
  assert.equal(f.h2Count, 2);
  assert.equal(f.h3Count, 1);
  assert.equal(f.tableCount, 1);
  assert.equal(f.listCount, 1);
  assert.equal(f.faqHeadingCount, 1);
  assert.ok(f.questionHeadingCount >= 1);
  assert.equal(f.hasArticleSchema, true);
  assert.equal(f.hasFaqSchema, true);
  assert.equal(f.authorPresent, true);
  assert.equal(f.modifiedAtRaw, "2026-09-10T12:00:00+08:00");
  assert.equal(f.robotsNoindex, false);
  assert.equal(f.externalLinkCount, 1);
  assert.ok(f.numericTokenCount >= 4);
  assert.ok(f.numericTokensPer1000Chars > 0);
  assert.match(f.contentHash, /^[a-f0-9]{64}$/);
});

test("invalid JSON-LD is reported, not treated as a fatal extraction error", () => {
  const f = extractPageFeatures('<html><script type="application/ld+json">{broken}</script><h2>FAQ</h2></html>');
  assert.equal(f.jsonLdCount, 0);
  assert.deepEqual(f.diagnostics, [{ code: "JSONLD_PARSE_ERROR", count: 1 }]);
  assert.equal(f.faqHeadingCount, 1);
});

test("page evidence URL guard rejects local/private destinations", async () => {
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1/admin"), (error) => error.code === "PAGE_URL_PRIVATE");
  await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd"), (error) => error.code === "PAGE_URL_UNSUPPORTED");
});
