import { canonicalizeUrl } from "../url.js";
import {
  DEFAULT_BREAKER,
  assessContentQuality,
  captureValidators,
  conditionalHeaders,
  isBreakerOpen,
  registerDomainOutcome,
  robotsDecision,
  userAgentToken,
} from "./page-fetch-guard.js";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";

const DEFAULT_USER_AGENT = "OneGlPageEvidence/0.3 (+https://github.com/crazycola23/OneGl)";
const META_DATE_PUBLISHED = new Set([
  "article:published_time", "datepublished", "date", "publishdate", "pubdate", "dc.date", "dcterms.date",
]);
const META_DATE_MODIFIED = new Set([
  "article:modified_time", "datemodified", "last-modified", "last_modified", "modified", "og:updated_time",
]);

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(value) {
  return decodeEntities(String(value ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseAttributes(tag) {
  const attrs = {};
  for (const match of String(tag).matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function firstMatch(html, re) {
  const match = re.exec(html);
  return match ? stripTags(match[1]) : null;
}

function allTagText(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  for (const match of html.matchAll(re)) out.push(stripTags(match[1]));
  return out.filter(Boolean);
}

function collectMeta(html) {
  const meta = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const key = String(attrs.name ?? attrs.property ?? attrs.itemprop ?? "").toLowerCase().trim();
    const content = String(attrs.content ?? "").trim();
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  return meta;
}

function collectJsonLd(html) {
  const parsed = [];
  let parseErrors = 0;
  const re = /<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      parsed.push(JSON.parse(raw));
    } catch {
      parseErrors += 1;
    }
  }
  return { parsed, parseErrors };
}

function walkJson(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  visitor(value);
  for (const child of Object.values(value)) walkJson(child, visitor);
}

function jsonLdSignals(objects) {
  const types = new Set();
  let authorPresent = false;
  let publishedAtRaw = null;
  let modifiedAtRaw = null;
  for (const root of objects) {
    walkJson(root, (node) => {
      const rawType = node["@type"];
      for (const type of Array.isArray(rawType) ? rawType : [rawType]) {
        if (typeof type === "string" && type.trim()) types.add(type.trim());
      }
      if (node.author != null) authorPresent = true;
      if (!publishedAtRaw && typeof node.datePublished === "string") publishedAtRaw = node.datePublished;
      if (!modifiedAtRaw && typeof node.dateModified === "string") modifiedAtRaw = node.dateModified;
    });
  }
  const lower = new Set([...types].map((type) => type.toLowerCase()));
  return {
    types: [...types].sort(),
    authorPresent,
    publishedAtRaw,
    modifiedAtRaw,
    hasArticleSchema: ["article", "newsarticle", "blogposting", "report", "review"].some((t) => lower.has(t)),
    hasFaqSchema: lower.has("faqpage"),
  };
}

function firstMeta(meta, names) {
  for (const name of names) {
    const value = meta.get(name);
    if (value) return value;
  }
  return null;
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function normalizeCharset(value) {
  const label = String(value ?? "").trim().toLowerCase().replace(/^['"]|['"]$/g, "");
  if (!label) return null;
  if (["utf8", "unicode-1-1-utf-8"].includes(label)) return "utf-8";
  if (["gb2312", "gb_2312-80", "gbk", "x-gbk", "cp936", "ms936"].includes(label)) return "gb18030";
  if (["big5-hkscs", "cn-big5"].includes(label)) return "big5";
  return label;
}

export function detectHtmlCharset(bytes, contentType = "") {
  const header = String(contentType).match(/charset\s*=\s*["']?([^;\s"']+)/i);
  if (header?.[1]) return normalizeCharset(header[1]) ?? "utf-8";

  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const prefix = input.slice(0, Math.min(input.length, 8192));
  // HTML charset declarations are ASCII-compatible even when the document body is GBK/Big5.
  const sniff = new TextDecoder("windows-1252", { fatal: false }).decode(prefix);
  const direct = sniff.match(/<meta\b[^>]*charset\s*=\s*["']?([^\s"'/>;]+)/i);
  if (direct?.[1]) return normalizeCharset(direct[1]) ?? "utf-8";
  const httpEquiv = sniff.match(/<meta\b[^>]*(?:http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([^\s;"']+)|content\s*=\s*["'][^"']*charset\s*=\s*([^\s;"']+)[^"']*["'][^>]*http-equiv\s*=\s*["']?content-type)/i);
  const declared = httpEquiv?.[1] ?? httpEquiv?.[2];
  return normalizeCharset(declared) ?? "utf-8";
}

export function decodeHtmlBytes(bytes, contentType = "") {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const charset = detectHtmlCharset(input, contentType);
  try {
    return { text: new TextDecoder(charset, { fatal: false }).decode(input), charset, fallback: false };
  } catch {
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(input), charset: "utf-8", fallback: true };
  }
}

function isPrivateIp(address) {
  if (!net.isIP(address)) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("ff")) return true;
  if (lower.startsWith("2001:db8:")) return true;
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    return net.isIPv4(mapped) ? isPrivateIp(mapped) : true;
  }
  return false;
}

export async function assertPublicHttpUrl(value) {
  const url = validHttpUrl(value);
  if (!url) throw Object.assign(new Error("only public http(s) URLs are supported"), { code: "PAGE_URL_UNSUPPORTED" });
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw Object.assign(new Error("localhost is not allowed"), { code: "PAGE_URL_PRIVATE" });
  }
  const records = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw Object.assign(new Error("private/reserved destination is not allowed"), { code: "PAGE_URL_PRIVATE" });
  }
  return url;
}

export function extractPageFeatures(html, { url = null, contentType = "text/html" } = {}) {
  const source = String(html ?? "");
  const meta = collectMeta(source);
  const { parsed: jsonLd, parseErrors } = collectJsonLd(source);
  const ld = jsonLdSignals(jsonLd);
  const headings = [...allTagText(source, "h1"), ...allTagText(source, "h2"), ...allTagText(source, "h3")];
  const h1 = allTagText(source, "h1");
  const h2 = allTagText(source, "h2");
  const h3 = allTagText(source, "h3");
  const faqHeadingCount = headings.filter((text) => /(?:faq|frequently\s+asked|常见问题|常见问答|问题解答|问答|q\s*&\s*a)/i.test(text)).length;
  const questionHeadingCount = headings.filter((text) => /[?？]\s*$/.test(text)).length;

  const robots = `${meta.get("robots") ?? ""},${meta.get("googlebot") ?? ""}`.toLowerCase();
  const publishedAtRaw = firstMeta(meta, META_DATE_PUBLISHED) ?? ld.publishedAtRaw;
  const modifiedAtRaw = firstMeta(meta, META_DATE_MODIFIED) ?? ld.modifiedAtRaw;
  const authorPresent = Boolean(firstMeta(meta, ["author", "article:author", "byl"])) || ld.authorPresent;

  const titleText = firstMatch(source, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription = firstMeta(meta, ["description", "og:description", "twitter:description"]);
  const canonicalMatch = source.match(/<link\b[^>]*rel\s*=\s*(?:"canonical"|'canonical'|canonical)[^>]*>/i);
  const canonicalRaw = canonicalMatch ? parseAttributes(canonicalMatch[0]).href ?? null : null;
  // Resolved against the fetched (final) URL and normalised with the same helper the
  // citation matcher uses. A raw attribute is useless as a matching key: it is often
  // relative, and it never had the tracking parameters removed.
  let canonicalHref = canonicalRaw;
  if (canonicalRaw) {
    try {
      const resolved = new URL(canonicalRaw, validHttpUrl(url) ?? undefined);
      canonicalHref = canonicalizeUrl(resolved.href) ?? canonicalRaw;
    } catch {
      canonicalHref = canonicalRaw;
    }
  }

  const bodyWithoutCode = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  const visibleText = stripTags(bodyWithoutCode);
  const compactText = visibleText.replace(/\s+/g, "");
  const numericTokens = visibleText.match(/(?:\d[\d,.]*)(?:%|％|万|亿|元|年|月|日|倍|个|家|条|次|kg|km|gb|mb)?/gi) ?? [];
  const numericTokensPer1000Chars = compactText.length ? (numericTokens.length * 1000) / compactText.length : 0;

  let externalLinkCount = 0;
  const base = validHttpUrl(url);
  for (const match of source.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi)) {
    const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
    try {
      const resolved = new URL(href, base ?? undefined);
      if ((resolved.protocol === "http:" || resolved.protocol === "https:") && base && resolved.hostname !== base.hostname) externalLinkCount += 1;
    } catch {
      // malformed link is ignored
    }
  }

  return {
    contentHash: createHash("sha256").update(source).digest("hex"),
    contentType,
    titleText,
    metaDescription,
    canonicalHref,
    textLength: compactText.length,
    numericTokenCount: numericTokens.length,
    numericTokensPer1000Chars,
    h1Count: h1.length,
    h2Count: h2.length,
    h3Count: h3.length,
    tableCount: (source.match(/<table\b/gi) ?? []).length,
    listCount: (source.match(/<(?:ul|ol)\b/gi) ?? []).length,
    faqHeadingCount,
    questionHeadingCount,
    externalLinkCount,
    jsonLdCount: jsonLd.length,
    schemaTypes: ld.types,
    hasArticleSchema: ld.hasArticleSchema,
    hasFaqSchema: ld.hasFaqSchema,
    authorPresent,
    publishedAtRaw,
    modifiedAtRaw,
    robotsNoindex: /(?:^|[,\s])noindex(?:[,\s]|$)/.test(robots),
    robotsNofollow: /(?:^|[,\s])nofollow(?:[,\s]|$)/.test(robots),
    diagnostics: parseErrors ? [{ code: "JSONLD_PARSE_ERROR", count: parseErrors }] : [],
  };
}

async function readLimitedBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return { data: new Uint8Array(), bytes: 0, tooLarge: false };
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { data: new Uint8Array(), bytes: total, tooLarge: true };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { data: merged, bytes: total, tooLarge: false };
}

/**
 * robots.txt lookup, kept deliberately small.
 *
 * Status meanings:
 *   found       - usable rules were returned
 *   missing     - the origin answered 4xx: treat the site as having no rules
 *   unavailable - network failure, 5xx or an unreadable body: the caller decides, and the
 *                 crawler's choice is to skip the domain rather than assume consent
 */
async function fetchRobots(baseUrl, { timeoutMs = 10000, userAgent = DEFAULT_USER_AGENT } = {}) {
  const robotsUrl = new URL("/robots.txt", baseUrl);
  try {
    const response = await fetch(robotsUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)),
      headers: { "user-agent": userAgent, accept: "text/plain,*/*;q=0.1" },
    });
    if (response.status >= 400 && response.status < 500) return { status: "missing" };
    if (!response.ok) return { status: "unavailable", httpStatus: response.status };
    const text = await response.text();
    if (!text || text.length > 512 * 1024) return { status: "missing" };
    return { status: "found", text };
  } catch {
    return { status: "unavailable" };
  }
}
export async function fetchPageEvidence(inputUrl, {
  timeoutMs = 10000,
  maxBytes = 2 * 1024 * 1024,
  maxRedirects = 5,
  userAgent = DEFAULT_USER_AGENT,
  robots = null,
  breakers = null,
  breakerConfig = DEFAULT_BREAKER,
  validateRobots = true,
  previous = null,
  unconditional = false,
} = {}) {
  const startedAt = new Date().toISOString();
  let current = null;
  let breaker = null;

  const finish = (result) => {
    const state = String(result?.state ?? "error");
    if (breakers && breaker?.domain) {
      breakers.set(breaker.domain, registerDomainOutcome(breaker.state, state, Date.now(), breakerConfig));
    }
    return result;
  };

  try {
    current = await assertPublicHttpUrl(inputUrl);
    const domain = current.hostname.toLowerCase();
    breaker = breakers?.has?.(domain)
      ? { domain, state: breakers.get(domain) }
      : { domain, state: null };

    // A domain that already answered with blocks or timeouts is left alone. This is the
    // cheapest way to avoid turning a soft block into a hard one across a batch.
    if (isBreakerOpen(breaker.state, Date.now(), breakerConfig)) {
      return finish({
        state: "blocked",
        startedAt,
        finalUrl: current.href,
        errorCode: "DOMAIN_BREAKER_OPEN",
        diagnostics: [`域 ${domain} 在熔断窗口内，未发起请求`],
      });
    }

    if (validateRobots) {
      const token = userAgentToken(userAgent);
      const cached = robots?.get?.(domain);
      let decision;
      if (cached?.text) {
        decision = robotsDecision(cached.text, { path: current.pathname || "/", userAgent });
      } else if (cached?.status === "denied") {
        return finish({
          state: "blocked",
          startedAt,
          finalUrl: current.href,
          errorCode: "ROBOTS_DISALLOW",
          diagnostics: [`robots.txt 不可用，已按保守策略跳过域 ${domain}`],
        });
      } else if (cached?.status === "unverified") {
        decision = { rule: "allow", matched: null };
      } else {
        const robotsResult = await fetchRobots(current, { timeoutMs, userAgent, maxBytes });
        if (robotsResult.status === "found") {
          robots?.set?.(domain, { status: "found", text: robotsResult.text, fetchedAt: Date.now() });
          decision = robotsDecision(robotsResult.text, { path: current.pathname || "/", userAgent });
        } else if (robotsResult.status === "missing") {
          robots?.set?.(domain, { status: "unverified", fetchedAt: Date.now() });
          decision = { rule: "allow", matched: null };
        } else {
          robots?.set?.(domain, { status: "denied", fetchedAt: Date.now() });
          return finish({
            state: "blocked",
            startedAt,
            finalUrl: current.href,
            errorCode: "ROBOTS_UNAVAILABLE",
            diagnostics: [`robots.txt 抓取失败（${robotsResult.status}），已按保守策略跳过`],
          });
        }
      }
      if (decision.rule === "disallow") {
        return finish({
          state: "blocked",
          startedAt,
          finalUrl: current.href,
          errorCode: "ROBOTS_DISALLOW",
          diagnostics: [`robots.txt 禁止抓取 ${decision.matched ?? current.pathname}`],
        });
      }
    }

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const headers = {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        ...(unconditional ? {} : conditionalHeaders(previous)),
      };
      const response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) return finish({ state: "http_error", startedAt, finalUrl: current.href, httpStatus: response.status, errorCode: "REDIRECT_WITHOUT_LOCATION" });
        if (redirectCount >= maxRedirects) return finish({ state: "redirect_limit", startedAt, finalUrl: current.href, httpStatus: response.status, errorCode: "PAGE_REDIRECT_LIMIT" });
        current = await assertPublicHttpUrl(new URL(location, current).href);
        continue;
      }

      // The server says nothing changed. That is a useful observation in itself: it means
      // the version OneGl already holds is still current, so features stay valid without
      // re-reading the page.
      if (response.status === 304) {
        return finish({
          state: "not_modified",
          startedAt,
          finalUrl: current.href,
          httpStatus: 304,
          validators: captureValidators(response),
        });
      }

      const contentType = response.headers.get("content-type") ?? "";
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      const validators = captureValidators(response);
      if (contentLength > maxBytes) return finish({ state: "too_large", startedAt, finalUrl: current.href, httpStatus: response.status, contentType, responseBytes: contentLength, errorCode: "PAGE_TOO_LARGE", validators });
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) return finish({ state: "non_html", startedAt, finalUrl: current.href, httpStatus: response.status, contentType, responseBytes: contentLength || null, validators });
      if (!response.ok) {
        return finish({
          state: response.status === 401 || response.status === 403 || response.status === 429 ? "blocked" : "http_error",
          startedAt,
          finalUrl: current.href,
          httpStatus: response.status,
          contentType,
          errorCode: `HTTP_${response.status}`,
          validators,
        });
      }

      const body = await readLimitedBody(response, maxBytes);
      if (body.tooLarge) return finish({ state: "too_large", startedAt, finalUrl: current.href, httpStatus: response.status, contentType, responseBytes: body.bytes, errorCode: "PAGE_TOO_LARGE", validators });
      const decoded = decodeHtmlBytes(body.data, contentType);
      const quality = assessContentQuality({ text: decoded.text, html: decoded.text, contentType });
      if (!quality.usable) {
        return finish({
          state: "unusable",
          startedAt,
          finalUrl: current.href,
          httpStatus: response.status,
          contentType,
          contentCharset: decoded.charset,
          responseBytes: body.bytes,
          errorCode: quality.code === "THIN_CONTENT" ? "PAGE_THIN_CONTENT" : "PAGE_JAVASCRIPT_SHELL",
          diagnostics: quality.diagnostics.map((item) => item.code),
          validators,
        });
      }

      const features = extractPageFeatures(decoded.text, { url: current.href, contentType });
      if (decoded.fallback) features.diagnostics = [...features.diagnostics, { code: "CHARSET_FALLBACK", declared: detectHtmlCharset(body.data, contentType) }];
      if (quality.diagnostics.length) features.diagnostics = [...features.diagnostics, ...quality.diagnostics];
      return finish({
        state: "success",
        startedAt,
        finalUrl: current.href,
        httpStatus: response.status,
        contentType,
        contentCharset: decoded.charset,
        responseBytes: body.bytes,
        validators,
        features,
      });
    }
    return finish({ state: "redirect_limit", startedAt, finalUrl: current.href, errorCode: "PAGE_REDIRECT_LIMIT" });
  } catch (error) {
    const state = error?.code === "PAGE_URL_PRIVATE" ? "blocked" : (error?.name === "TimeoutError" ? "timeout" : "error");
    return finish({
      state,
      startedAt,
      finalUrl: current?.href ?? null,
      errorCode: error?.code ?? "PAGE_FETCH_ERROR",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
