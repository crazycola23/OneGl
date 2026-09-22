import { assertProviderAdapter } from "./contract.js";
import { doubaoWebProvider } from "./doubao-web.js";
import { assertProviderProfile, collectProfileErrors, isProfileValidated } from "./profile.js";
import { qianwenWebProfile } from "./qianwen-web.js";
import { yuanbaoWebProfile } from "./yuanbao-web.js";

/**
 * Profiles that exist but have not passed Phase 0. They are discoverable by the probe tool,
 * but never selectable for collection: registering an unmeasured profile would mean driving a
 * live site with guessed selectors and guessed session cookies, which is how a platform that
 * was never logged into gets recorded as a successful capture.
 */
export const pendingProviderProfiles = [yuanbaoWebProfile, qianwenWebProfile];

const adapters = [doubaoWebProvider].map(assertProviderAdapter);
const byId = new Map();

/** What still has to be measured before a pending profile can be registered. */
export function providerProfileGaps(profileId) {
  const profile = pendingProviderProfiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error(`Unknown provider profile: ${JSON.stringify(profileId)}`);
  return collectProfileErrors(profile);
}

/** The only path onto the adapter table: a complete profile that Phase 0 has validated. */
export function registerProviderProfile(profile, run) {
  assertProviderProfile(profile);
  if (!isProfileValidated(profile)) {
    throw new Error(
      `Provider profile ${profile.id} has not passed Phase 0 validation; refusing to register it`,
    );
  }
  const adapter = assertProviderAdapter({ ...profile, run });
  adapters.push(adapter);
  byId.set(adapter.id, adapter);
  if (!byId.has(adapter.provider)) byId.set(adapter.provider, adapter);
  return adapter;
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
