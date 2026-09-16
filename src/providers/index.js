import { assertProviderAdapter } from "./contract.js";
import { doubaoWebProvider } from "./doubao-web.js";

const adapters = [doubaoWebProvider].map(assertProviderAdapter);
const byId = new Map();

for (const adapter of adapters) {
  byId.set(adapter.id, adapter);
  byId.set(adapter.provider, adapter);
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
