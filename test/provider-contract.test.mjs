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
    // 智谱清言与文心一言在 Phase 0 跑通并注册（docs/ZHIPU_PHASE0.md、docs/WENXIN_PHASE0.md）。
    // 匿名面，与千问同形。
    { id: "zhipu-web", provider: "zhipu", model: "zhipu", access: "scraped" },
    { id: "wenxin-web", provider: "wenxin", model: "wenxin", access: "scraped" },
  ]);
  // 别名仍然按 provider 命中，但匿名面必须自己声明不需要登录态。
  assert.equal(getProviderAdapter("qianwen").id, "qianwen-web");
  assert.equal(getProviderAdapter("qianwen").requiresStoredAuth, false);
  assert.equal(getProviderAdapter("doubao").requiresStoredAuth, true);
  assert.equal(getProviderAdapter("doubao").frontEndGuard, true);
  assert.equal(getProviderAdapter("qianwen").frontEndGuard, undefined);
  assert.equal(getProviderAdapter("zhipu").id, "zhipu-web");
  assert.equal(getProviderAdapter("zhipu").requiresStoredAuth, false);
  assert.equal(getProviderAdapter("wenxin").id, "wenxin-web");
  assert.equal(getProviderAdapter("wenxin").requiresStoredAuth, false);
});
