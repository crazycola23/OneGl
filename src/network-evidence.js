import { canonicalizeUrl, domainFromUrl, isExternalSourceUrl } from "./url.js";

const SEARCH_BLOCK_TYPE = "10025";
const JSONISH_LIMIT = 1_000_000;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 8_000;
const ELIGIBLE_CONTENT_TYPE = /(json|event-stream|text\/plain|octet-stream)/i;
const SEARCH_SIGNAL = /(10025|search_query_result|search_result_block|search_queries)/i;
const INTERNAL_RESPONSE_HOST = /(doubao\.com|zijieapi|bytedance|byteimg|feiliao)/i;

/**
 * Endpoints whose payload is *this turn's* retrieval.
 *
 * `im/conversation/batch_get` deliberately replays the whole conversation, so mining it
 * yields hundreds of candidates belonging to earlier, unrelated questions - the collector
 * previously treated that as a successful capture. Only the completion stream carries the
 * search blocks for the turn currently being run.
 */
const DEFAULT_EVIDENCE_ENDPOINTS = [/\/chat\/completion/i];

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

/**
 * Incremental reader for a possibly-still-open response body.
 *
 * The previous implementation awaited `response.body()` for the *whole* response and gave
 * up after a timeout. On a streaming endpoint (`/chat/completion` answers over SSE) the
 * body is not complete until generation ends, and is sometimes never closed at all - so
 * every capture timed out and the retrieval layer stayed permanently empty.
 *
 * Reading chunk by chunk fixes that: bytes already received are parsed immediately, and the
 * only cost of an endless stream is that we stop accumulating once the cap is reached.
 */
async function readStreamIncrementally(body, { maxBytes, stopSignal, onChunk }) {
  if (!body) return { bytes: 0, truncated: false, ended: false, error: null };

  // A non-streaming response (or a test double) hands back a Buffer; deliver it whole.
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (buffer.length > maxBytes) return { bytes: buffer.length, truncated: true, ended: false, error: null };
    onChunk(buffer);
    return { bytes: buffer.length, truncated: false, ended: true, error: null };
  }

  let total = 0;
  let truncated = false;
  let ended = false;
  let error = null;
  try {
    for await (const chunk of body) {
      if (stopSignal?.stopped) break;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        truncated = true;
        break;
      }
      onChunk(buffer);
    }
    ended = !truncated && !stopSignal?.stopped;
  } catch (streamError) {
    // "Premature close" is the normal shape of an aborted/abandoned stream, not a parser bug.
    error = streamError?.message ?? String(streamError);
  }
  return { bytes: total, truncated, ended, error };
}

export function createNetworkEvidenceCollector(page, options = {}) {
  const enabled = options.enabled !== false;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  // Retained for callers/tests: this is how long stop() waits for in-flight stream reads
  // to wind down before snapshotting. It is no longer a whole-body deadline.
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  // Turn scoping. A conversation is not an isolated event: the page loads the whole
  // history, and `/im/conversation/batch_get` replays every previous turn's search blocks
  // in one go. Without this gate a single run "discovers" hundreds of candidates from
  // earlier, unrelated questions, and the retrieval layer becomes unusable.
  const getTurnId = typeof options.getTurnId === "function" ? options.getTurnId : null;
  const evidenceEndpoints = Array.isArray(options.evidenceEndpoints) && options.evidenceEndpoints.length
    ? options.evidenceEndpoints
    : DEFAULT_EVIDENCE_ENDPOINTS;
  const pending = new Set();
  const responseEvidence = [];
  const querySet = new Set();
  const queries = [];
  const sources = new Map();
  const diagnostics = [];
  const rejectedQueries = [];
  const stopSignal = { stopped: false };

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
    rejectedQueryCount: rejectedQueries.length,
  });

  if (!enabled) {
    return { stop: async () => snapshot(), snapshot };
  }

  /** Returns true when this text contained search evidence at all (new or repeat). */
  const absorb = (text) => {
    if (!text || !SEARCH_SIGNAL.test(text)) return false;
    if (getTurnId && !getTurnId()) {
      diagnostics.push("evidence-before-turn-scope");
      return false;
    }
    const evidence = extractSearchEvidence(text);
    for (const query of evidence.queries) {
      if (!isPlausibleQuery(query)) {
        rejectedQueries.push(String(query).slice(0, 60));
        continue;
      }
      const key = query.toLocaleLowerCase();
      if (!querySet.has(key)) {
        querySet.add(key);
        queries.push(query);
      }
    }
    for (const source of evidence.retrievedSources) mergeSource(sources, source);
    return Boolean(evidence.queries.length || evidence.retrievedSources.length);
  };

  const isEvidenceEndpoint = (rawUrl) => evidenceEndpoints.some((pattern) => pattern.test(rawUrl));

  const captureResponse = async (response) => {
    if (!eligibleResponse(response)) return;
    // Everything else on the page (settings, banners, conversation history, monitoring) is
    // noise. Not reading it keeps the artifact small and, more importantly, keeps other
    // turns' retrieval out of this turn's data.
    if (!isEvidenceEndpoint(response.url())) return;

    const headers = response.headers();
    const contentLength = Number(headers["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      diagnostics.push(`body-too-large:${endpointIdentity(response.url()) || "unknown"}`);
      return;
    }

    let body;
    try {
      body = await response.body();
    } catch (error) {
      diagnostics.push(`body-unavailable:${endpointIdentity(response.url()) || "unknown"}`);
      return;
    }

    // The stream is scanned as it arrives, and the same buffer is scanned once more at the
    // end: a search block can straddle a chunk boundary, and the final parse is what catches
    // it once more bytes have landed.
    let buffered = "";
    let sawEvidence = false;
    const record = () => {
      if (!buffered) return;
      if (absorb(buffered)) sawEvidence = true;
      // The buffer is dropped once a search block has been seen, so a long stream is not
      // re-parsed from the beginning on every chunk.
      if (sawEvidence) buffered = "";
    };

    const read = await readStreamIncrementally(body, {
      maxBytes: maxBodyBytes,
      stopSignal,
      onChunk: (chunk) => {
        buffered += chunk.toString("utf8");
        // Bound the working buffer: a stream can be far larger than one response.
        if (buffered.length > 4 * maxBodyBytes) buffered = buffered.slice(-2 * maxBodyBytes);
        // Parse whenever a plausible block terminator has arrived, plus periodically so a
        // chunk that never ends with one is still scanned.
        if (blockCount(buffered) || buffered.length > 16_384) record();
      },
    });
    record();

    const endpoint = endpointIdentity(response.url()) || "unknown";
    if (read.truncated) diagnostics.push(`body-truncated:${endpoint}`);
    if (read.error && !/aborted|premature close|target closed/i.test(read.error)) {
      diagnostics.push(`stream-error:${endpoint}`);
    }
    if (read.bytes === 0) diagnostics.push(`body-empty:${endpoint}`);

    // One row per captured response, capped so a long-lived page cannot grow the artifact
    // without bound. `matched` records whether this response actually carried search
    // evidence, which is what makes an empty retrieval layer explainable.
    if (responseEvidence.length < 200) {
      responseEvidence.push({
        endpoint,
        status: response.status(),
        contentType: headers["content-type"] || null,
        bodyBytes: read.bytes,
        streamEnded: read.ended,
        queryCount: sawEvidence ? queries.length : 0,
        retrievedSourceCount: sawEvidence ? sources.size : 0,
        matched: sawEvidence,
      });
    }
  };

  const onResponse = (response) => {
    // Endpoints that are not internal, stream-shaped, or relevant never reach the reader.
    const task = captureResponse(response)
      .catch((error) => diagnostics.push(`capture-error:${error?.message || String(error)}`))
      .finally(() => pending.delete(task));
    pending.add(task);
  };

  page.on("response", onResponse);

  return {
    snapshot,
    async stop() {
      if (!stopped()) {
        stopSignal.stopped = true;
        page.off("response", onResponse);
      }
      if (pending.size) {
        const grace = Math.min(Math.max(Number(bodyTimeoutMs) || 0, 500), 5_000);
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise((resolve) => setTimeout(resolve, grace).unref?.()),
        ]);
      }
      return snapshot();
    },
  };

  function stopped() {
    return stopSignal.stopped;
  }
}

/**
 * A query string that Doubao would actually send to a search engine.
 *
 * The real payload also carries internal identifiers, log sentences and truncated UI
 * strings ("辑消息", a 32-hex id, "心跳正常 第三方活动更新..."). Those are not search
 * queries, and letting them through both pollutes the query list and inflates the
 * apparent retrieval breadth. Requiring at least two characters of real text in a CJK or
 * Latin script is deliberately loose: it only removes strings that could not be a query.
 */
function isPlausibleQuery(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  // A bare long hex id has no spaces and no separators.
  if (/^[0-9a-f]{16,}$/i.test(text)) return false;
  // Log lines arrive as several space-separated clauses and always end in sentence
  // punctuation; no search query looks like that.
  if (/[。！？]$/.test(text)) return false;
  if (text.split(/\s+/).filter(Boolean).length >= 4) return false;
  const letters = text.match(/[A-Za-z\u4e00-\u9fff]/g) ?? [];
  if (letters.length < 4) return false;
  // Chinese queries are content words: a two-character fragment is a UI label or a
  // truncated string, not something anyone searches for.
  const han = text.match(/[\u4e00-\u9fff]/g) ?? [];
  if (han.length === text.length && han.length < 4) return false;
  return true;
}

/** Cheap pre-check so we only run the JSON parser when a block boundary is present. */
function blockCount(text) {
  let index = text.indexOf("block_type");
  let count = 0;
  while (index >= 0 && count < 3) {
    count += 1;
    index = text.indexOf("block_type", index + 1);
  }
  return count;
}