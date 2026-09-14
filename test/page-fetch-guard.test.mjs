import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BREAKER,
  assessContentQuality,
  captureValidators,
  conditionalHeaders,
  isBreakerOpen,
  registerDomainOutcome,
  robotsDecision,
  userAgentToken,
} from "../src/analysis/page-fetch-guard.js";

/**
 * Offline tests for the crawler's politeness and change-detection rules.
 *
 * These are pure functions on purpose: getting robots.txt or the circuit breaker wrong is
 * expensive to discover in production (either we read pages we were told not to, or we
 * hammer a site that is already refusing us), and cheap to pin down here.
 */

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

const ROBOTS = `
# global rules
User-agent: *
Disallow: /private/
Disallow: /search
Allow: /private/public-report

User-agent: OneGlPageEvidence
Disallow: /no-crawl
Allow: /
`;

test("a specific user-agent group overrides the wildcard group", () => {
  assert.equal(userAgentToken("OneGlPageEvidence/0.3 (+https://example.com)"), "oneglpageevidence");
  // The wildcard group forbids /private/, but our own group only forbids /no-crawl.
  assert.equal(robotsDecision(ROBOTS, { path: "/private/report" }).rule, "allow");
  assert.equal(robotsDecision(ROBOTS, { path: "/no-crawl/page" }).rule, "disallow");
});

test("an unnamed crawler falls back to the wildcard group and honours longest match", () => {
  assert.equal(robotsDecision(ROBOTS, { path: "/private/report", userAgent: "SomeOtherBot" }).rule, "disallow");
  // The longer Allow wins over the shorter Disallow.
  assert.equal(robotsDecision(ROBOTS, { path: "/private/public-report", userAgent: "SomeOtherBot" }).rule, "allow");
});

test("ties are resolved conservatively in favour of Disallow", () => {
  const text = "User-agent: *\nAllow: /a\nDisallow: /a\n";
  assert.equal(robotsDecision(text, { path: "/a" }).rule, "disallow");
});

test("an empty Disallow allows everything and an empty ruleset allows everything", () => {
  assert.equal(robotsDecision("User-agent: *\nDisallow:\n", { path: "/anything" }).rule, "allow");
  assert.equal(robotsDecision("", { path: "/anything" }).rule, "allow");
});

test("wildcards in a rule are honoured", () => {
  const text = "User-agent: *\nDisallow: /*.pdf$\n";
  assert.equal(robotsDecision(text, { path: "/docs/report.pdf" }).rule, "disallow");
  assert.equal(robotsDecision(text, { path: "/docs/report.pdf.html" }).rule, "allow");
});

// ---------------------------------------------------------------------------
// circuit breaker
// ---------------------------------------------------------------------------

test("the breaker opens only after the configured number of consecutive failures", () => {
  let state = registerDomainOutcome(null, "blocked", 1000);
  assert.equal(isBreakerOpen(state, 1000), false);
  state = registerDomainOutcome(state, "blocked", 1000);
  assert.equal(isBreakerOpen(state, 1000), false);
  state = registerDomainOutcome(state, "blocked", 1000);
  assert.equal(isBreakerOpen(state, 1000), true);
  // Still open just before the window ends, closed after it.
  assert.equal(isBreakerOpen(state, 1000 + DEFAULT_BREAKER.openMs - 1), true);
  assert.equal(isBreakerOpen(state, 1000 + DEFAULT_BREAKER.openMs + 1), false);
});

test("any success resets the failure counter", () => {
  let state = registerDomainOutcome(null, "http_error", 1000);
  state = registerDomainOutcome(state, "http_error", 1000);
  state = registerDomainOutcome(state, "success", 1000);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.openUntil, null);
  assert.equal(isBreakerOpen(state, 1000), false);
});

test("a 304 is a success, not a failure", () => {
  let state = registerDomainOutcome(null, "blocked", 1000);
  state = registerDomainOutcome(state, "not_modified", 1000);
  assert.equal(state.consecutiveFailures, 0);
});

// ---------------------------------------------------------------------------
// conditional requests
// ---------------------------------------------------------------------------

test("validators are sent only when they were observed", () => {
  assert.deepEqual(conditionalHeaders(null), {});
  assert.deepEqual(conditionalHeaders({ etag: '"abc"', lastModified: null }), { "if-none-match": '"abc"' });
  assert.deepEqual(
    conditionalHeaders({ etag: null, lastModified: "Wed, 10 Sep 2026 07:00:00 GMT" }),
    { "if-modified-since": "Wed, 10 Sep 2026 07:00:00 GMT" },
  );
});

test("validators are captured from a response when present", () => {
  const response = {
    headers: {
      get(name) {
        if (name === "etag") return '"xyz"';
        if (name === "last-modified") return "Wed, 10 Sep 2026 07:00:00 GMT";
        return null;
      },
    },
  };
  assert.deepEqual(captureValidators(response), {
    etag: '"xyz"',
    lastModified: "Wed, 10 Sep 2026 07:00:00 GMT",
  });
  assert.deepEqual(captureValidators({}), { etag: null, lastModified: null });
});

// ---------------------------------------------------------------------------
// content quality
// ---------------------------------------------------------------------------

test("a 200 response with no real content is not treated as a usable page", () => {
  const shell = assessContentQuality({
    text: "   ",
    html: "<html><body><div id=\"root\"></div></body></html>",
    contentType: "text/html; charset=utf-8",
  });
  assert.equal(shell.usable, false);
  assert.ok(shell.diagnostics.some((item) => item.code === "JAVASCRIPT_SHELL"));
});

test("a thin but real page is flagged without being called a shell", () => {
  const result = assessContentQuality({
    text: "短",
    html: "<html><body><p>短</p></body></html>",
    contentType: "text/html",
  });
  assert.equal(result.usable, false);
  assert.equal(result.code, "THIN_CONTENT");
  assert.equal(result.diagnostics.some((item) => item.code === "JAVASCRIPT_SHELL"), false);
});

test("a normal article passes the quality gate", () => {
  const text = "新能源 SUV 选购报告。".repeat(40);
  const result = assessContentQuality({ text, html: `<html><body>${text}</body></html>`, contentType: "text/html" });
  assert.equal(result.usable, true);
  assert.equal(result.code, "ok");
});

test("a non-HTML content type is rejected before anything else", () => {
  const result = assessContentQuality({ text: "x".repeat(500), html: "", contentType: "application/pdf" });
  assert.equal(result.usable, false);
  assert.equal(result.code, "content_type_not_html");
});