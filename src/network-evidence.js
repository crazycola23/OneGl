import { canonicalizeUrl, domainFromUrl, isExternalSourceUrl } from "./url.js";

const SEARCH_BLOCK_TYPE = "10025";
const JSONISH_LIMIT = 1_000_000;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 8_000;
const ELIGIBLE_CONTENT_TYPE = /(json|event-stream|text\/plain|octet-stream)/i;
const SEARCH_SIGNAL = /(10025|search_query_result|search_result_block|search_queries)/i;
const INTERNAL_RESPONSE_HOST = /(doubao\.com|zijieapi|bytedance|byteimg|feiliao)/i;

function compactText(value, max = 1_000) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function stringArray(value) {
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object") {
        const nested = item.query ?? item.text ?? item.keyword ?? item.q;
        return typeof nested === "string" ? [nested] : [];
      }
      return [];
    })
    .map((item) => compactText(item, 500))
    .filter(Boolean);
}

function parseJsonish(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > JSONISH_LIMIT) return null;
  if (!((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")))) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sseDataChunks(text) {
  const chunks = [];
  let current = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line === "") {
      if (current.length) chunks.push(current.join("\n"));
      current = [];
      continue;
    }
    if (line.startsWith("data:")) current.push(line.slice(5).trimStart());
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks.filter((chunk) => chunk && chunk !== "[DONE]");
}

function responseCandidates(text) {
  const candidates = [String(text || "")];
  candidates.push(...sseDataChunks(text));
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed);
  }
  return [...new Set(candidates)];
}

function looksLikeSearchBlock(object) {
  if (!object || typeof object !== "object") return false;
  if (String(object.block_type ?? object.blockType ?? "") === SEARCH_BLOCK_TYPE) return true;
  return Object.keys(object).some((key) => /search_query_result|search_result_block/i.test(key));
}

function valueByKeys(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value != null && value !== "") return value;
  }
  return null;
}

function sourceFromObject(object, position = null) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  const rawUrl = valueByKeys(object, [
    "url",
    "href",
    "link",
    "source_url",
    "sourceUrl",
    "web_url",
    "webUrl",
    "article_url",
    "articleUrl",
  ]);
  if (typeof rawUrl !== "string" || !isExternalSourceUrl(rawUrl)) return null;
  const canonicalUrl = canonicalizeUrl(rawUrl);
  if (!canonicalUrl) return null;

  const requestedPosition = valueByKeys(object, ["position", "rank", "index", "order"]);
  const numericPosition = Number(requestedPosition);

  return {
    title: compactText(valueByKeys(object, ["title", "name", "page_title", "pageTitle"]), 500),
    url: rawUrl,
    canonicalUrl,
    domain: domainFromUrl(canonicalUrl),
    sourceName: compactText(
      valueByKeys(object, ["source", "source_name", "sourceName", "site", "site_name", "siteName"]),
      300,
    ),
    summary: compactText(
      valueByKeys(object, ["summary", "snippet", "description", "abstract", "digest"]),
      1_500,
    ),
    sourcePosition:
      Number.isInteger(numericPosition) && numericPosition > 0 ? numericPosition : position,
    citationMarker: null,
    answerText: null,
    relationStatus: "unresolved",
    sourceType: "retrieved",
    capturedFrom: "NETWORK",
    visibleToUser: false,
  };
}

export function extractSearchEvidence(text) {
  const queries = [];
  const querySet = new Set();
  const sourceMap = new Map();
  let matchedBlockCount = 0;

  const addQuery = (value) => {
    for (const query of stringArray(value)) {
      const key = query.toLocaleLowerCase();
      if (querySet.has(key)) continue;
      querySet.add(key);
      queries.push(query);
    }
  };

  const addSource = (source) => {
    if (!source) return;
    const previous = sourceMap.get(source.canonicalUrl);
    if (!previous) {
      sourceMap.set(source.canonicalUrl, source);
      return;
    }
    sourceMap.set(source.canonicalUrl, {
      ...previous,
      title: previous.title ?? source.title,
      sourceName: previous.sourceName ?? source.sourceName,
      summary: previous.summary ?? source.summary,
      sourcePosition: previous.sourcePosition ?? source.sourcePosition,
    });
  };

  const seenObjects = new WeakSet();
  const walk = (value, searchContext = false, depth = 0) => {
    if (depth > 14 || value == null) return;

    if (typeof value === "string") {
      const parsed = parseJsonish(value);
      if (parsed != null) walk(parsed, searchContext, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (searchContext) addSource(sourceFromObject(item, index + 1));
        walk(item, searchContext, depth + 1);
      });
      return;
    }

    const blockHere = looksLikeSearchBlock(value);
    const nextSearchContext = searchContext || blockHere;
    if (blockHere) matchedBlockCount += 1;

    if (nextSearchContext) {
      for (const key of ["queries", "search_queries", "searchQueries", "query_list", "queryList"]) {
        if (key in value) addQuery(value[key]);
      }
      if ("query" in value && typeof value.query === "string") addQuery(value.query);
      addSource(sourceFromObject(value));
    }

    for (const [key, child] of Object.entries(value)) {
      const childSearchContext =
        nextSearchContext || /search_query_result|search_result_block|search_results?/i.test(key);
      walk(child, childSearchContext, depth + 1);
    }
  };

  for (const candidate of responseCandidates(text)) {
    const parsed = parseJsonish(candidate);
    if (parsed != null) walk(parsed, false, 0);
  }

  return {
    queries,
    retrievedSources: [...sourceMap.values()].map((source, index) => ({
      ...source,
      sourcePosition: source.sourcePosition ?? index + 1,
    })),
    matchedBlockCount,
  };
}

function endpointIdentity(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

function eligibleResponse(response) {
  let url;
  try {
    url = new URL(response.url());
  } catch {
    return false;
  }
  if (!INTERNAL_RESPONSE_HOST.test(url.hostname)) return false;
  const status = response.status();
  if (status < 200 || status === 204 || status === 304) return false;
  const headers = response.headers();
  const contentType = headers["content-type"] || "";
  return !contentType || ELIGIBLE_CONTENT_TYPE.test(contentType);
}

function mergeSource(target, source) {
  const previous = target.get(source.canonicalUrl);
  if (!previous) {
    target.set(source.canonicalUrl, source);
    return;
  }
  target.set(source.canonicalUrl, {
    ...previous,
    title: previous.title ?? source.title,
    sourceName: previous.sourceName ?? source.sourceName,
    summary: previous.summary ?? source.summary,
    sourcePosition: previous.sourcePosition ?? source.sourcePosition,
  });
}

function timeoutAfter(ms) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("network-body-timeout")), ms);
    timer.unref?.();
  });
}

export function createNetworkEvidenceCollector(page, options = {}) {
  const enabled = options.enabled !== false;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const pending = new Set();
  const responseEvidence = [];
  const querySet = new Set();
  const queries = [];
  const sources = new Map();
  const diagnostics = [];
  let stopped = false;

  const snapshot = () => ({
    version: 1,
    state:
      !enabled ? "disabled" : queries.length || sources.size ? "found" : diagnostics.length ? "partial" : "none",
    queries: [...queries],
    retrievedSources: [...sources.values()].map((source, index) => ({
      ...source,
      sourcePosition: source.sourcePosition ?? index + 1,
    })),
    responses: [...responseEvidence],
    diagnostics: [...new Set(diagnostics)],
  });

  if (!enabled) {
    return { stop: async () => snapshot(), snapshot };
  }

  const captureResponse = async (response) => {
    if (!eligibleResponse(response)) return;

    const headers = response.headers();
    const contentLength = Number(headers["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      diagnostics.push(`body-too-large:${endpointIdentity(response.url()) || "unknown"}`);
      return;
    }

    let body;
    try {
      body = await Promise.race([response.body(), timeoutAfter(bodyTimeoutMs)]);
    } catch (error) {
      if (String(error?.message || error).includes("network-body-timeout")) {
        diagnostics.push(`body-timeout:${endpointIdentity(response.url()) || "unknown"}`);
      }
      return;
    }
    if (!body?.length || body.length > maxBodyBytes) {
      if (body?.length > maxBodyBytes) {
        diagnostics.push(`body-too-large:${endpointIdentity(response.url()) || "unknown"}`);
      }
      return;
    }

    const text = body.toString("utf8");
    if (!SEARCH_SIGNAL.test(text)) return;
    const evidence = extractSearchEvidence(text);
    if (!evidence.queries.length && !evidence.retrievedSources.length) return;

    for (const query of evidence.queries) {
      const key = query.toLocaleLowerCase();
      if (!querySet.has(key)) {
        querySet.add(key);
        queries.push(query);
      }
    }
    for (const source of evidence.retrievedSources) mergeSource(sources, source);

    responseEvidence.push({
      endpoint: endpointIdentity(response.url()),
      status: response.status(),
      contentType: headers["content-type"] || null,
      bodyBytes: body.length,
      queryCount: evidence.queries.length,
      retrievedSourceCount: evidence.retrievedSources.length,
      matchedBlockCount: evidence.matchedBlockCount,
    });
  };

  const onResponse = (response) => {
    const task = captureResponse(response)
      .catch((error) => diagnostics.push(`capture-error:${error?.message || String(error)}`))
      .finally(() => pending.delete(task));
    pending.add(task);
  };

  page.on("response", onResponse);

  return {
    snapshot,
    async stop() {
      if (!stopped) {
        stopped = true;
        page.off("response", onResponse);
      }
      await Promise.allSettled([...pending]);
      return snapshot();
    },
  };
}
