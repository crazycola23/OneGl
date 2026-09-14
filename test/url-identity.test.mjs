import assert from "node:assert/strict";
import test from "node:test";

import { canRetryOutcome } from "../src/accounts/safety.js";
import { MATCH_METHODS, exactCitationMatch } from "../src/db/retrieval.js";
import { canonicalizeUrl, isExternalSourceUrl, siteRuleAlias } from "../src/url.js";

/**
 * Offline regression tests for URL identity and retry classification.
 *
 * These are the two places where a small mistake has a large, quiet cost: a bad
 * canonicalisation merges two distinct sources, and a bad retry decision sends the
 * same prompt twice. Both are cheap to pin down here and expensive to notice later.
 */

// ---------------------------------------------------------------------------
// URL identity
// ---------------------------------------------------------------------------

test("canonicalizeUrl removes known tracking parameters but keeps unknown ones", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/a?utm_source=x&gclid=y&keep=1#section"),
    "https://example.com/a?keep=1",
  );
  assert.equal(
    canonicalizeUrl("https://example.com/a?spm=a1z.2&b=2"),
    "https://example.com/a?b=2",
  );
  // An unrecognised parameter may select a different document, so it is preserved.
  assert.equal(
    canonicalizeUrl("https://example.com/a?id=7&utm_medium=email"),
    "https://example.com/a?id=7",
  );
});

test("canonicalizeUrl makes query order and default ports irrelevant", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/a?b=2&a=1"),
    canonicalizeUrl("https://example.com/a?a=1&b=2"),
  );
  assert.equal(
    canonicalizeUrl("https://example.com:443/a"),
    canonicalizeUrl("https://example.com/a"),
  );
  // Duplicate keys keep their multiplicity: they are not collapsed into one value.
  assert.equal(
    canonicalizeUrl("https://example.com/a?tag=b&tag=a"),
    "https://example.com/a?tag=a&tag=b",
  );
});

test("canonicalizeUrl refuses non-http input instead of inventing a URL", () => {
  assert.equal(canonicalizeUrl("javascript:alert(1)"), null);
  assert.equal(canonicalizeUrl("not a url"), null);
  assert.equal(canonicalizeUrl(null), null);
});

test("isExternalSourceUrl matches internal hosts on label boundaries only", () => {
  assert.equal(isExternalSourceUrl("https://www.doubao.com/chat/"), false);
  assert.equal(isExternalSourceUrl("https://p3.byteimg.com/img.png"), false);
  assert.equal(isExternalSourceUrl("https://example.com/a"), true);
  // Not a Doubao host, and previously excluded by a substring match.
  assert.equal(isExternalSourceUrl("https://notdoubao.com/a"), true);
  assert.equal(isExternalSourceUrl("https://mybyteimg.example/a"), true);
});

test("siteRuleAlias folds host presentation but canonicalizeUrl does not", () => {
  assert.equal(canonicalizeUrl("https://www.example.com/a/b"), "https://www.example.com/a/b");
  assert.equal(
    siteRuleAlias("https://www.example.com/a/b"),
    siteRuleAlias("https://example.com/a/b"),
  );
  assert.equal(
    siteRuleAlias("https://m.example.com/a/b"),
    siteRuleAlias("https://example.com/a/b"),
  );
  assert.equal(
    siteRuleAlias("https://amp.example.com/a/b"),
    siteRuleAlias("https://example.com/a/b"),
  );
  // A genuine sub-site is not a presentation alias and must not be folded.
  assert.notEqual(
    siteRuleAlias("https://blog.example.com/a/b"),
    siteRuleAlias("https://example.com/a/b"),
  );
});

// ---------------------------------------------------------------------------
// retrieval -> citation matching tiers
// ---------------------------------------------------------------------------

test("exact match wins and is labelled as the exact method", () => {
  const visible = new Map([["https://example.com/a", { id: 7 }]]);
  assert.deepEqual(exactCitationMatch("https://example.com/a", visible), {
    visibleCitationId: 7,
    matchMethod: MATCH_METHODS.EXACT,
  });
});

test("alias tiers only match through their own labelled method", () => {
  const visible = new Map([["https://www.example.com/a", { id: 7 }]]);
  const siteRule = new Map([["https://example.com/a", { id: 7 }]]);

  assert.deepEqual(exactCitationMatch("https://example.com/a", visible, { siteRule }), {
    visibleCitationId: 7,
    matchMethod: MATCH_METHODS.SITE_RULE,
  });

  const redirect = new Map([["https://example.com/final", { id: 9 }]]);
  assert.deepEqual(exactCitationMatch("https://example.com/final", visible, { redirect }), {
    visibleCitationId: 9,
    matchMethod: MATCH_METHODS.REDIRECT,
  });
});

test("no match at any tier returns a null match instead of guessing", () => {
  const visible = new Map([["https://example.com/a", { id: 7 }]]);
  const siteRule = new Map([["https://example.com/b", { id: 8 }]]);
  assert.deepEqual(exactCitationMatch("https://other.example/x", visible, { siteRule }), {
    visibleCitationId: null,
    matchMethod: null,
  });
  assert.deepEqual(exactCitationMatch(null, visible), {
    visibleCitationId: null,
    matchMethod: null,
  });
});

test("visible citations can be supplied as either a Map or an array of rows", () => {
  const visible = [{ canonical_url: "https://example.com/a", id: 3 }];
  assert.deepEqual(exactCitationMatch("https://example.com/a", visible), {
    visibleCitationId: 3,
    matchMethod: MATCH_METHODS.EXACT,
  });
});

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

test("a timeout is only retryable when the prompt provably never went out", () => {
  assert.equal(canRetryOutcome("DOUBAO_TIMEOUT", { promptSubmitted: false }), true);
  assert.equal(canRetryOutcome("DOUBAO_TIMEOUT", { promptSubmitted: true }), false);
  // Missing evidence is treated as "may have been submitted".
  assert.equal(canRetryOutcome("DOUBAO_TIMEOUT", null), false);
  assert.equal(canRetryOutcome("DOUBAO_TIMEOUT", {}), false);
  assert.equal(canRetryOutcome("NETWORK_ERROR", { promptSubmitted: false }), true);
  assert.equal(canRetryOutcome("NETWORK_ERROR", { promptSubmitted: true }), false);
});

test("a reset failure is retryable because nothing was submitted", () => {
  assert.equal(
    canRetryOutcome("DOUBAO_CONVERSATION_RESET_FAILED", { promptSubmitted: false }),
    true,
  );
});

test("unknown errors and account blocks are never auto-retried", () => {
  assert.equal(canRetryOutcome("UNKNOWN_ERROR", { promptSubmitted: false }), false);
  assert.equal(canRetryOutcome("DOUBAO_VERIFICATION_REQUIRED", { promptSubmitted: false }), false);
  assert.equal(canRetryOutcome("RATE_LIMITED", { promptSubmitted: false }), false);
  assert.equal(canRetryOutcome("PAGE_CHANGED", { promptSubmitted: false }), false);
});