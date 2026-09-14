/**
 * Crawl politeness and change-detection helpers.
 *
 * Two concerns live here, deliberately kept out of the fetch call so both can be tested
 * without a network:
 *
 *   - robots.txt compliance: a URL the site asked crawlers not to read is not read, the
 *     same way a 403 is not retried.
 *   - per-domain circuit breaker: a domain that answers with blocks or timeouts is left
 *     alone for a while instead of being hit by every remaining candidate. That is both
 *     etiquette and the cheapest way to stop a soft block becoming a hard one.
 */

const DEFAULT_USER_AGENT = "OneGlPageEvidence";

export function userAgentToken(userAgent) {
  const raw = String(userAgent ?? "").trim();
  if (!raw) return DEFAULT_USER_AGENT.toLowerCase();
  return (raw.split(/[\s/]/)[0] || DEFAULT_USER_AGENT).toLowerCase();
}

function parseGroupLines(lines) {
  const groups = [];
  let current = null;
  let readingAgents = false;

  for (const rawLine of lines) {
    const line = String(rawLine ?? "").replace(/#.*$/, "").trim();
    if (!line) {
      current = null;
      readingAgents = false;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!current || !readingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        readingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    readingAgents = false;
    if (field === "allow" || field === "disallow") {
      current.rules.push({ type: field, path: value });
    }
  }
  return groups;
}

function selectGroup(groups, token) {
  // Longest matching user-agent token wins, which is what the robots.txt spec asks for.
  let best = null;
  let bestLength = -1;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === "*") continue;
      if (token.startsWith(agent) || agent.startsWith(token)) {
        if (agent.length > bestLength) {
          best = group;
          bestLength = agent.length;
        }
      }
    }
  }
  if (best) return best;
  return groups.find((group) => group.agents.includes("*")) ?? null;
}

function patternToRegExp(pattern) {
  const source = String(pattern);
  // A trailing "$" is the only anchor robots.txt defines; everything else is a literal
  // prefix match. Wildcards become ".*" and the whole pattern is anchored at the start.
  const anchored = source.endsWith("$");
  const body = anchored ? source.slice(0, -1) : source;
  const escaped = body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

export function parseRobots(text) {
  return { groups: parseGroupLines(String(text ?? "").split(/\r?\n/)) };
}

/**
 * Returns "allow" | "disallow" for a path under the rules that apply to this token.
 *
 * Ties are resolved conservatively: if an Allow and a Disallow match with the same
 * specificity, the Disallow wins. Being wrong that way costs one sample; being wrong the
 * other way means reading a page the site asked crawlers not to read.
 */
export function robotsDecision(robotsText, { path = "/", userAgent = DEFAULT_USER_AGENT } = {}) {
  const parsed = parseRobots(robotsText);
  const group = selectGroup(parsed.groups, userAgentToken(userAgent));
  if (!group) return { rule: "allow", matched: null };

  let best = null;
  for (const entry of group.rules) {
    // An empty Disallow means "everything allowed"; an empty Allow means nothing.
    if (!entry.path) continue;
    if (!patternToRegExp(entry.path).test(path)) continue;
    const specificity = entry.path.replace(/\*.*$/, "").length;
    if (
      !best ||
      specificity > best.specificity ||
      (specificity === best.specificity && entry.type === "disallow")
    ) {
      best = { ...entry, specificity };
    }
  }
  return best ? { rule: best.type, matched: best.path } : { rule: "allow", matched: null };
}

// ---------------------------------------------------------------------------
// Per-domain circuit breaker
// ---------------------------------------------------------------------------

export const DEFAULT_BREAKER = Object.freeze({
  failureThreshold: 3,
  openMs: 15 * 60 * 1000,
});

export function isBreakerOpen(breaker, now = Date.now(), config = DEFAULT_BREAKER) {
  const threshold = Number(config?.failureThreshold ?? DEFAULT_BREAKER.failureThreshold);
  if (!breaker || Number(breaker.consecutiveFailures ?? 0) < threshold) return false;
  if (!breaker.openUntil) return false;
  return new Date(breaker.openUntil).getTime() > Number(now);
}

export function registerDomainOutcome(breaker, outcome, now = Date.now(), config = DEFAULT_BREAKER) {
  const state = breaker ?? { consecutiveFailures: 0, openUntil: null, lastOutcome: null };
  // "not_modified" is a success: the origin answered, it just had nothing new.
  const failure = ["blocked", "http_error", "error", "timeout", "redirect_limit"].includes(outcome);
  if (!failure) {
    return { ...state, consecutiveFailures: 0, openUntil: null, lastOutcome: outcome };
  }
  const consecutiveFailures = Number(state.consecutiveFailures ?? 0) + 1;
  const openUntil =
    consecutiveFailures >= config.failureThreshold
      ? new Date(Number(now) + config.openMs).toISOString()
      : state.openUntil;
  return { ...state, consecutiveFailures, openUntil, lastOutcome: outcome };
}

// ---------------------------------------------------------------------------
// Conditional requests
// ---------------------------------------------------------------------------

export function conditionalHeaders(previous) {
  const headers = {};
  if (!previous) return headers;
  if (previous.etag) headers["if-none-match"] = previous.etag;
  if (previous.lastModified) headers["if-modified-since"] = previous.lastModified;
  return headers;
}

export function captureValidators(response) {
  const headers = response?.headers;
  if (!headers?.get) return { etag: null, lastModified: null };
  return {
    etag: headers.get("etag") ?? null,
    lastModified: headers.get("last-modified") ?? null,
  };
}

// ---------------------------------------------------------------------------
// Content quality gate
// ---------------------------------------------------------------------------

const JS_SHELL_MARKERS = [
  /<div[^>]+id\s*=\s*["'](?:root|app|__next)["'][^>]*>\s*<\/div>/i,
  /enable\s+javascript|请(?:开启|启用)\s*JavaScript|需要\s*JavaScript/i,
];

/**
 * A 200 response is not automatically usable evidence. A JavaScript shell or an
 * interstitial returns 200 with almost no text, and feeding that into the factor table
 * silently turns "the page did not load" into "the page has no FAQ schema".
 */
export function assessContentQuality({ text = "", html = "", contentType = "" } = {}) {
  const body = String(text ?? "").replace(/\s+/g, " ").trim();
  const source = String(html ?? "");
  const diagnostics = [];

  if (!/text\/html|application\/xhtml\+xml/i.test(String(contentType ?? ""))) {
    return { usable: false, code: "content_type_not_html", diagnostics };
  }
  if (body.length < 200) {
    diagnostics.push({ code: "THIN_CONTENT", textLength: body.length });
  }
  if (JS_SHELL_MARKERS.some((re) => re.test(source))) {
    diagnostics.push({ code: "JAVASCRIPT_SHELL" });
  }
  const usable =
    body.length >= 200 && !diagnostics.some((item) => item.code === "JAVASCRIPT_SHELL");
  return {
    usable,
    code: usable ? "ok" : diagnostics[0]?.code ?? "unusable",
    diagnostics,
  };
}