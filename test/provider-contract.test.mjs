import assert from "node:assert/strict";
import test from "node:test";

import { assertProviderAdapter, normalizeProviderResult } from "../src/providers/contract.js";
import { getProviderAdapter, listProviderAdapters } from "../src/providers/index.js";

test("normalizes provider-specific results into a stable contract", () => {
  const raw = {
    answer: "小米SU7被提及",
    citations: [{ url: "https://example.com/a" }],
    webQueries: ["  小米 SU7 评测  ", "", "续航"],
    extra: 1,
  };
  const result = normalizeProviderResult(raw, {
    provider: "doubao",
    model: "doubao",
    access: "scraped",
    modelVersion: "web-2026",
  });

  assert.equal(result.textContent, raw.answer);
  assert.equal(result.provider, "doubao");
  assert.equal(result.model, "doubao");
  assert.equal(result.access, "scraped");
  assert.equal(result.modelVersion, "web-2026");
  assert.deepEqual(result.webQueries, ["小米 SU7 评测", "续航"]);
  assert.equal(result.rawOutput, raw);
  assert.equal(result.extra, 1);
});

test("rejects invalid provider access modes", () => {
  assert.throws(() => normalizeProviderResult({}, { access: "stealth" }), /Unsupported provider access/);
  assert.throws(
    () => assertProviderAdapter({ id: "x", provider: "x", model: "x", access: "stealth", run() {} }),
    /invalid access/,
  );
});

test("registers the measured providers as scraped adapters", () => {
  const adapter = getProviderAdapter("doubao");
  assert.equal(adapter.id, "doubao-web");
  assert.equal(adapter.access, "scraped");
  assert.equal(typeof adapter.run, "function");
  assert.deepEqual(listProviderAdapters(), [
    { id: "doubao-web", provider: "doubao", model: "doubao", access: "scraped" },
    { id: "qianwen-web", provider: "qianwen", model: "qianwen", access: "scraped" },
  ]);
  // 别名仍然按 provider 命中，但匿名面必须自己声明不需要登录态。
  assert.equal(getProviderAdapter("qianwen").id, "qianwen-web");
  assert.equal(getProviderAdapter("qianwen").requiresStoredAuth, false);
  assert.equal(getProviderAdapter("doubao").requiresStoredAuth, true);
  assert.equal(getProviderAdapter("doubao").frontEndGuard, true);
  assert.equal(getProviderAdapter("qianwen").frontEndGuard, undefined);
});
