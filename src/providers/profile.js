import { PROVIDER_ACCESS } from "./contract.js";

/**
 * Declarative description of one web chat provider.
 *
 * The point of the shape is not configuration convenience, it is the gate: a profile that
 * has not been measured against the live site cannot be registered as an adapter. Every
 * array below is filled in by `tools/provider-phase0.js`, never by guessing - a guessed
 * session cookie is how an unauthenticated visit gets recorded as a successful login, and a
 * guessed citation selector is how "we failed to read it" becomes "the platform cited nothing".
 */

const REQUIRED_TEXT_FIELDS = ["id", "provider", "model"];

function patternList(value, field, profileId, report) {
  if (!Array.isArray(value)) {
    report(field, `${profileId}.${field} must be an array of RegExp or strings`);
    return;
  }
  value.forEach((entry, index) => {
    if (!(entry instanceof RegExp) && typeof entry !== "string") {
      report(`${field}[${index}]`, `${profileId}.${field}[${index}] must be a RegExp or a string`);
    }
  });
}

function stringList(value, field, profileId, report) {
  // An empty array must fail: it is exactly the shape of "nobody measured this yet", and
  // treating it as valid is what would let an unprobed profile reach a live site.
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    report(field, `${profileId}.${field} must be a non-empty array of strings`);
  }
}

export const CITATION_TIERS = Object.freeze({
  // The platform states how many sources it consulted, so captured citations can be
  // reconciled against that number and a shortfall marked partial.
  SELF_REPORTED_COUNT: "self-reported-count",
  // Only DOM-visible citations exist. Nothing may claim the capture was complete.
  DOM_ONLY: "dom-only",
});

/**
 * Fields whose absence can only cost explanation, never correctness.
 *
 * The distinction matters because it decides what blocks registration. A missing quota
 * pattern means a spent free allowance surfaces as an unexplained timeout - annoying, and
 * the alert path already covers it via consecutive failures. A missing session-cookie list or
 * answer container means *wrong data*: an anonymous visit recorded as a login, or our own
 * question recorded as the platform's answer. Only the second class may stop a release.
 */
const DIAGNOSTIC_ONLY_FIELDS = new Set(["quota.exhaustedPatterns", "login.qrExpiredPatterns"]);

export function collectProfileErrors(profile) {
  return collectProfileFindings(profile).errors;
}

export function collectProfileWarnings(profile) {
  return collectProfileFindings(profile).warnings;
}

export function collectProfileFindings(profile) {
  const errors = [];
  const warnings = [];
  const push = (field, message) => {
    (DIAGNOSTIC_ONLY_FIELDS.has(field) ? warnings : errors).push(message);
  };
  const id = typeof profile?.id === "string" && profile.id ? profile.id : "<missing id>";

  for (const field of REQUIRED_TEXT_FIELDS) {
    if (typeof profile?.[field] !== "string" || !profile[field].trim()) {
      errors.push(`${id}.${field} is required`);
    }
  }
  if (profile?.access && !Object.values(PROVIDER_ACCESS).includes(profile.access)) {
    errors.push(`${id}.access must be one of ${Object.values(PROVIDER_ACCESS).join(", ")}`);
  }
  if (typeof profile?.entryUrl !== "string" || !/^https:\/\//.test(profile.entryUrl)) {
    errors.push(`${id}.entryUrl must be an https:// URL`);
  }
  // Every profile has to say outright whether it needs an account session. That single bit
  // decides whether login state, conversation-isolation and the cap semantics below apply,
  // and it is the only place the anonymous surface is allowed to be declared.
  if (typeof profile?.requiresStoredAuth !== "boolean") {
    errors.push(`${id}.requiresStoredAuth must be true (account) or false (anonymous surface)`);
  }
  if (!Object.values(CITATION_TIERS).includes(profile?.citation?.tier)) {
    errors.push(`${id}.citation.tier must be one of ${Object.values(CITATION_TIERS).join(", ")}`);
  }

  patternList(profile?.login?.captchaPatterns, "login.captchaPatterns", id, push);
  patternList(profile?.login?.restrictedPatterns, "login.restrictedPatterns", id, push);
  patternList(profile?.login?.qrExpiredPatterns, "login.qrExpiredPatterns", id, push);
  if (profile?.requiresStoredAuth !== false) {
    // An account surface cannot tell "logged in" from "anonymous" without a measured cookie
    // list. An anonymous surface has no session to measure, but it does still need to
    // distinguish a quota cap from a risk-control block, so the signal patterns stay required.
    stringList(profile?.login?.sessionCookies, "login.sessionCookies", id, push);
  }
  stringList(profile?.chat?.composerSelectors, "chat.composerSelectors", id, push);
  stringList(profile?.chat?.sendSelectors, "chat.sendSelectors", id, push);
  stringList(profile?.chat?.answerSelectors, "chat.answerSelectors", id, push);
  patternList(profile?.chat?.inProgressPatterns, "chat.inProgressPatterns", id, push);
  stringList(profile?.chat?.userBubbleSelectors, "chat.userBubbleSelectors", id, push);
  if (profile?.requiresStoredAuth === false) {
    stringList(profile?.quota?.exhaustedPatterns, "quota.exhaustedPatterns", id, push);
    if (!Number.isInteger(profile?.quota?.promptsPerWindow) || profile.quota.promptsPerWindow < 1) {
      errors.push(`${id}.quota.promptsPerWindow must be a positive integer`);
    }
  }

  if (profile?.citation?.tier === CITATION_TIERS.SELF_REPORTED_COUNT) {
    const pattern = profile.citation.countPattern;
    if (!(pattern instanceof RegExp) && typeof pattern !== "string") {
      errors.push(`${id}.citation.countPattern is required for the self-reported-count tier`);
    }
  }

  return { errors, warnings };
}

/**
 * An unvalidated profile is necessarily incomplete - that is the state it ships in - so the
 * gaps have to be reportable without throwing. Import-time crashes here would take the API
 * and every worker down over a platform nobody asked to use yet.
 */
export function assertProviderProfile(profile) {
  const errors = collectProfileErrors(profile);
  if (errors.length) {
    const error = new Error(`Provider profile ${profile?.id ?? "<missing id>"} is incomplete:\n- ${errors.join("\n- ")}`);
    error.profileErrors = errors;
    throw error;
  }
  return profile;
}

/**
 * A profile is only usable once Phase 0 has measured it. Registration checks this so the
 * failure mode is "platform unavailable", never "silently collected the wrong thing".
 */
export function isProfileValidated(profile) {
  return profile?.validated === true;
}

/**
 * Cookie names observed only on an anonymous visit are CSRF/telemetry tokens and must never
 * decide login state - Doubao's `passport_csrf_token` proved that exact lesson. The diff is
 * what makes a session cookie list trustworthy: it keeps names that appeared or became
 * non-empty after a real login.
 */
export function deriveSessionCookieCandidates(anonymousCookies = {}, loggedInCookies = {}) {
  const read = (value) => {
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return {};
      const out = {};
      for (const part of text.split(";")) {
        const index = part.indexOf("=");
        if (index < 0) continue;
        const name = part.slice(0, index).trim().toLowerCase();
        if (name) out[name] = part.slice(index + 1).trim();
      }
      return out;
    }
    return Object.fromEntries(
      Object.entries(value ?? {}).map(([name, v]) => [String(name).toLowerCase(), String(v ?? "")]),
    );
  };

  const before = read(anonymousCookies);
  const after = read(loggedInCookies);
  const candidates = [];
  for (const [name, value] of Object.entries(after)) {
    if (!value) continue;
    const previous = before[name];
    if (previous === undefined || previous === "" || previous !== value) {
      candidates.push({ name, anonymousValue: previous ?? null, loggedInValue: value });
    }
  }
  return {
    candidates: candidates.sort((a, b) => a.name.localeCompare(b.name)),
    unchanged: Object.keys(after).filter((name) => before[name] === after[name]).sort(),
  };
}
