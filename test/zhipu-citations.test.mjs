import assert from "node:assert/strict";
import test from "node:test";
import { parseReferenceItems } from "../src/zhipu-citations.js";
import { citationEvidenceState } from "../src/providers/web-evidence.js";

// URLs taken from the answer (after reasoning removal) in batch 153 / run 947, 2026-09-30.
const SOURCE_URLS = [
  "https://cloud.kepuchina.cn/newSearch/imgText?id=7467957761225986048",
  "https://www.sina.cn/news/detail/5344981665450556.html",
  "https://www.toutiao.com/w/1874827319855116/",
  "https://tech.ifeng.com/c/8wdOMEi903P",
  "https://www.sina.cn/gc/article/nisencu8892369.html",
];

test("five actual articles on four hosts reconcile with the displayed source count", () => {
  const citations = parseReferenceItems(SOURCE_URLS.flatMap((url) => [{ url }, { url }]));
  assert.deepEqual(citations.map((item) => item.url), SOURCE_URLS);
  assert.equal(new Set(citations.map((item) => item.domain)).size, 4);
  assert.equal(citationEvidenceState(citations, 5), "found");
  assert.equal(citations.filter((item) => item.domain === "www.sina.cn").length, 2);
  assert.ok(citations.every((item) => item.capturedFrom === "角标来源链接"));
});

test("missing article remains incomplete", () => {
  assert.equal(citationEvidenceState(parseReferenceItems(SOURCE_URLS.slice(0, 4).map((url) => ({ url }))), 5), "count_mismatch");
});

test("malformed or non-http attributes do not become source evidence", () => {
  const citations = parseReferenceItems([
    null, {}, { url: "sina.cn" }, { url: "/relative" }, { url: "javascript:alert(1)" },
    { url: "file:///tmp/source" }, { url: "https://user:password@example.com/" },
    { url: `  ${SOURCE_URLS[0]}  ` },
  ]);
  assert.deepEqual(citations.map((item) => item.url), [SOURCE_URLS[0]]);
  assert.deepEqual(parseReferenceItems(null), []);
});

test("hostname normalization deduplicates repeated markers without merging paths", () => {
  const citations = parseReferenceItems([
    { url: "https://WWW.sina.cn/a" }, { url: "https://www.sina.cn/a" }, { url: "https://www.sina.cn/b" },
  ]);
  assert.equal(citations.length, 2);
  assert.equal(citations[0].url, "https://WWW.sina.cn/a");
  assert.equal(citations[0].domain, "www.sina.cn");
});
