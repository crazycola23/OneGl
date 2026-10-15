/** Evidence fields consumed by the shared run/report pipeline. */
export function conversationEvidence(reset) {
  return {
    conversationReset: reset?.ok === true && reset.attempts > 0,
    conversationResetConfirmed: reset?.ok === true ? true : reset?.ok === false ? false : null,
  };
}

/** Keep the capture tier separate from whether the captured references reconcile. */
export function citationEvidenceState(citations, expectedCount) {
  const actual = Array.isArray(citations) ? citations.length : 0;
  if (!Number.isInteger(expectedCount) || expectedCount < 0) return "dom-only";
  if (actual !== expectedCount) return "count_mismatch";
  return actual === 0 ? "none_visible" : "found";
}
