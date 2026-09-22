import { ApiHttpError, parsePositiveInt, stringArray } from "./http.js";
import { defaultProviderId, supportedProviderIds } from "../providers/index.js";

export function parseProjectCreate(body) {
  const name = String(body.name ?? "").trim();
  if (!name) throw new ApiHttpError(400, "invalid_request", "name is required");
  const description = body.description == null ? null : String(body.description).trim() || null;
  const targetBrand = body.target_brand == null ? null : String(body.target_brand).trim() || null;
  const keywords = stringArray(body.keywords, "keywords", { required: false, maxItems: 5000 });
  const category = body.category == null ? null : String(body.category).trim() || null;
  return { name, description, targetBrand, keywords, category };
}

export function parseKeywordsCreate(body) {
  const keywords = stringArray(body.keywords, "keywords", { required: true, maxItems: 5000 });
  const category = body.category == null ? null : String(body.category).trim() || null;
  return { keywords, category };
}

export function parseBatchCreate(body) {
  const projectId = parsePositiveInt(body.project_id, "project_id");
  const size = body.size == null ? null : parsePositiveInt(body.size, "size", { max: 10000 });
  const repeats = parsePositiveInt(body.repeats ?? 1, "repeats", { max: 100 });
  const accounts = stringArray(body.accounts, "accounts", { required: true, maxItems: 100 });
  const method = body.method == null ? "stratified" : String(body.method).trim().toLowerCase();
  if (!new Set(["stratified", "random"]).has(method)) {
    throw new ApiHttpError(400, "invalid_request", "method must be stratified or random");
  }
  const seed = body.seed == null ? null : String(body.seed).trim() || null;
  const name = body.name == null ? null : String(body.name).trim() || null;
  // Optional: which platform to collect on. Absent means the default provider, so every
  // existing integration keeps its behaviour without sending anything new.
  const platform = body.platform == null ? defaultProviderId() : String(body.platform).trim().toLowerCase();
  if (!supportedProviderIds().includes(platform)) {
    throw new ApiHttpError(422, "unsupported_platform", `platform must be one of: ${supportedProviderIds().join(", ")}`, {
      supported: supportedProviderIds(),
    });
  }
  const start = body.start === true;
  return { projectId, size, repeats, accounts, method, seed, name, platform, start };
}

export function parseLimit(value, fallback = 100, max = 500) {
  if (value == null || value === "") return fallback;
  return parsePositiveInt(value, "limit", { max });
}
