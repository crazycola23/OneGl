const ACCESS_TYPES = new Set(["scraped", "api"]);

function stringOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * Canonical result shape shared by every answer-engine adapter.
 *
 * Provider-specific fields are preserved so existing collectors can migrate
 * incrementally while analytics depends only on the stable fields below.
 */
export function normalizeProviderResult(input = {}, meta = {}) {
  const access = String(meta.access ?? input.access ?? "scraped").trim().toLowerCase();
  if (!ACCESS_TYPES.has(access)) {
    throw new Error(`Unsupported provider access type: ${JSON.stringify(access)}`);
  }

  const textContent = typeof input.textContent === "string"
    ? input.textContent
    : typeof input.answer === "string"
      ? input.answer
      : "";

  const citations = Array.isArray(input.citations) ? input.citations : [];
  const webQueries = Array.isArray(input.webQueries)
    ? input.webQueries.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];

  return {
    ...input,
    provider: stringOrNull(meta.provider ?? input.provider),
    model: stringOrNull(meta.model ?? input.model ?? meta.provider ?? input.provider),
    access,
    modelVersion: stringOrNull(input.modelVersion ?? meta.modelVersion),
    textContent,
    rawOutput: input.rawOutput ?? input,
    webQueries,
    citations,
  };
}

export function assertProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new Error("Provider adapter must be an object");
  if (!String(adapter.id ?? "").trim()) throw new Error("Provider adapter requires id");
  if (!String(adapter.provider ?? "").trim()) throw new Error("Provider adapter requires provider");
  if (!String(adapter.model ?? "").trim()) throw new Error("Provider adapter requires model");
  if (!ACCESS_TYPES.has(adapter.access)) throw new Error(`Provider adapter ${adapter.id} has invalid access`);
  if (typeof adapter.run !== "function") throw new Error(`Provider adapter ${adapter.id} requires run()`);
  return adapter;
}

export const PROVIDER_ACCESS = Object.freeze({
  SCRAPED: "scraped",
  API: "api",
});
