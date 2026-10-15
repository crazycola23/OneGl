import assert from "node:assert/strict";
import test from "node:test";
import { citationEvidenceState, conversationEvidence } from "../src/providers/web-evidence.js";
import { normalizeProviderResult } from "../src/providers/contract.js";
import { CITATION_EVIDENCE_STATES } from "../src/db/citation-validity.js";

test("a verified empty conversation is valid without requiring a click", () => {
  assert.deepEqual(conversationEvidence({ ok: true, attempts: 0 }), {
    conversationReset: false, conversationResetConfirmed: true,
  });
});
test("a verified reset preserves both evidence fields through normalization", () => {
  for (const provider of ["zhipu", "wenxin"]) {
    const result = normalizeProviderResult({ answer: "answer", ...conversationEvidence({ ok: true, attempts: 1 }) }, { provider });
    assert.equal(result.conversationReset, true);
    assert.equal(result.conversationResetConfirmed, true);
  }
});
test("failed or unknown resets cannot become confirmed", () => {
  assert.equal(conversationEvidence({ ok: false }).conversationResetConfirmed, false);
  assert.equal(conversationEvidence(null).conversationResetConfirmed, null);
  assert.equal(conversationEvidence({}).conversationResetConfirmed, null);
});
test("self-reported count with matching references enters citation statistics", () => {
  const state = citationEvidenceState([{ url: "https://example.com" }], 1);
  assert.equal(state, "found");
  assert.ok(CITATION_EVIDENCE_STATES.includes(state));
});
test("self-reported count with missing or extra references stays incomplete", () => {
  assert.equal(citationEvidenceState([], 1), "count_mismatch");
  assert.equal(citationEvidenceState([{}, {}], 1), "count_mismatch");
});
test("confirmed absence and DOM-only capture retain their distinct meanings", () => {
  assert.equal(citationEvidenceState([], 0), "none_visible");
  assert.equal(citationEvidenceState([{}], null), "dom-only");
  assert.equal(citationEvidenceState([], undefined), "dom-only");
});
test("invalid self-reported counts do not pretend to be reconciled", () => {
  for (const count of [-1, 1.5, "1", Number.NaN]) {
    assert.equal(citationEvidenceState([{}], count), "dom-only");
  }
});
