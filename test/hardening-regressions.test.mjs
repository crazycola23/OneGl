import assert from "node:assert/strict";
import test from "node:test";

import { recordAccountFailure } from "../src/accounts/safety.js";
import { compileBrandRules, detectBrandMention } from "../src/brand/detect.js";
import { MATCH_METHODS, exactCitationMatch } from "../src/db/retrieval.js";
import { resolvePublicTarget } from "../src/security/outbound-url.js";
import { siteRuleAlias } from "../src/url.js";

test("ASCII brand aliases use token boundaries while CJK aliases keep substring semantics", () => {
  const ai = compileBrandRules({ name: "AI" });
  assert.equal(detectBrandMention("OpenAI 发布了新模型", ai).mentioned, false);
  assert.equal(detectBrandMention("AI 模型发布", ai).mentioned, true);

  const su7 = compileBrandRules({ name: "SU7" });
  assert.equal(detectBrandMention("小米 SU7 Ultra", su7).mentioned, true);
  assert.equal(detectBrandMention("ASU7X", su7).mentioned, false);

  const chinese = compileBrandRules({ name: "小米" });
  assert.equal(detectBrandMention("小米汽车发布新品", chinese).mentioned, true);
});

test("brand exclude regex rejects nested unbounded quantifiers", () => {
  assert.throws(
    () => compileBrandRules({ name: "X", excludePatterns: ["(a+)+$"] }),
    /nested unbounded quantifiers/,
  );
});

test("site-rule matching normalizes the retrieved side as well as the visible side", () => {
  const visible = new Map([["https://www.example.com/a", { id: 7 }]]);
  const siteRule = new Map([[siteRuleAlias("https://www.example.com/a"), { id: 7 }]]);

  assert.deepEqual(
    exactCitationMatch("https://m.example.com/a", visible, { siteRule }),
    { visibleCitationId: 7, matchMethod: MATCH_METHODS.SITE_RULE },
  );
});

test("mixed public/private DNS answers are rejected instead of selecting the public one", async () => {
  await assert.rejects(
    () => resolvePublicTarget(new URL("https://example.com"), {
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    }),
    /non-public address/,
  );
});

test("database failures do not mutate provider account health", async () => {
  let queries = 0;
  const pool = { async query() { queries += 1; throw new Error("must not be called"); } };
  const result = await recordAccountFailure(pool, {
    accountKey: "acct",
    errorCode: "DATABASE_ERROR",
    config: { maxConsecutiveFailures: 1, cooldownMinutes: 60 },
  });
  assert.equal(result.infrastructure, true);
  assert.equal(result.blocked, false);
  assert.equal(queries, 0);
});
