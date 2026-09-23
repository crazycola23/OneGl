import { assertProviderAdapter } from "./contract.js";
import { doubaoWebProvider } from "./doubao-web.js";
import { collectProfileErrors, isProfileValidated } from "./profile.js";
import { qianwenWebProfile, qianwenWebProvider } from "./qianwen-web.js";
import { yuanbaoWebProfile } from "./yuanbao-web.js";

/**
 * Profiles that exist but have not passed Phase 0. They are discoverable by the probe tool,
 * but never selectable for collection: registering an unmeasured profile would mean driving a
 * live site with guessed selectors and guessed session cookies, which is how a platform that
 * was never logged into gets recorded as a successful capture.
 */
export const pendingProviderProfiles = [yuanbaoWebProfile, qianwenWebProfile];

/**
 * The collection table: hand-written drivers plus any profile-driven adapter whose profile has
 * been through Phase 0. Unvalidated ones are excluded here and therefore also absent from the
 * public provider enum, which derives from this list - so "the API accepts it" and "the
 * collector can run it" cannot come apart.
 *
 * Exported so the gate itself is testable without mutating module state at runtime.
 */
export function selectRegistrableAdapters(candidates) {
  return candidates
    .filter((adapter) => !adapter.profile || isProfileValidated(adapter.profile))
    .map(assertProviderAdapter);
}

const adapters = selectRegistrableAdapters([doubaoWebProvider, qianwenWebProvider]);
const byId = new Map();

/** What still has to be measured before a pending profile can be registered. */
export function providerProfileGaps(profileId) {
  const profile = pendingProviderProfiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error(`Unknown provider profile: ${JSON.stringify(profileId)}`);
  return collectProfileErrors(profile);
}

for (const adapter of adapters) {
  byId.set(adapter.id, adapter);
  // Convenience aliases are only valid while a provider has one unambiguous
  // default adapter. Explicit adapter ids remain authoritative once multiple
  // access paths (for example web + API) exist for the same provider.
  if (!byId.has(adapter.provider)) byId.set(adapter.provider, adapter);
}

export function getProviderAdapter(id = "doubao") {
  const key = String(id ?? "doubao").trim().toLowerCase();
  const adapter = byId.get(key);
  if (!adapter) throw new Error(`Unsupported provider adapter: ${JSON.stringify(id)}`);
  return adapter;
}

export function listProviderAdapters() {
  return adapters.map(({ id, provider, model, access }) => ({ id, provider, model, access }));
}

/**
 * The provider ids the public contract may name.
 *
 * Derived from the adapter table on purpose: a hand-maintained enum drifts the moment a
 * platform is added or pulled, and the direction that drifts is the bad one - an API that
 * advertises a provider collection cannot actually run will accept accounts, create batches
 * and then fail every execution. Pending profiles are absent from this list by construction.
 */
export function supportedProviderIds() {
  return [...new Set(adapters.map((adapter) => adapter.provider))].sort();
}

export function defaultProviderId() {
  return supportedProviderIds()[0] ?? "doubao";
}

/**
 * True when a provider collects from a surface that needs no credential.
 *
 * Such a lane has no login to protect, so the per-account daily/hourly caps, the inter-run
 * spacing and the consecutive-failure cooldown would only throttle work that cannot burn an
 * account. The operator's `enabled` flag stays the way to stop it.
 */
export function isCredentialFreeSurface(provider) {
  try {
    return getProviderAdapter(provider)?.requiresStoredAuth === false;
  } catch {
    return false;
  }
}
