import "dotenv/config";

import { compileBrandRules } from "../src/brand/detect.js";
import { buildPageContentIntelligence } from "../src/analysis/content-intelligence.js";
import {
  assertPublicHttpUrl,
  decodeHtmlBytes,
  extractPageFeatures,
} from "../src/analysis/page-features.js";
import {
  assessContentQuality,
  robotsDecision,
} from "../src/analysis/page-fetch-guard.js";
import { createPool } from "../src/db/pool.js";

const USER_AGENT = "OneGlSourceIntelligence/0.4 (+https://github.com/crazycola23/OneGl)";
const pool = createPool();
const robotsCache = new Map();
const lastDomainFetch = new Map();

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseArgs(argv) {
  const args = {
    batchId: null,
    concurrency: positiveInt(process.env.ONEGL_SOURCE_INTELLIGENCE_CONCURRENCY, 3),
    timeoutMs: positiveInt(process.env.ONEGL_PAGE_TIMEOUT_MS, 10000),
    maxBytes: positiveInt(process.env.ONEGL_PAGE_MAX_BYTES, 2 * 1024 * 1024),
    limit: null,
    refresh: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--batch") args.batchId = Number(argv[++i]);
    else if (value === "--concurrency") args.concurrency = positiveInt(argv[++i], null);
    else if (value === "--timeout-ms") args.timeoutMs = positiveInt(argv[++i], null);
    else if (value === "--max-bytes") args.maxBytes = positiveInt(argv[++i], null);
    else if (value === "--limit") args.limit = positiveInt(argv[++i], null);
    else if (value === "--refresh") args.refresh = true;
    else if (!value.startsWith("--") && args.batchId == null) args.batchId = Number(value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isInteger(args.batchId) || args.batchId <= 0) {
    throw new Error("Usage: npm run source:intelligence -- --batch <positive batch id> [--refresh] [--limit N]");
  }
  return args;
}

async function loadBrandConfig(batchId) {
  const { rows } = await pool.query(
    `SELECT p.target_brand, p.brand_aliases, p.brand_product_aliases, p.brand_exclude_patterns
       FROM sampling_batches b
       JOIN projects p ON p.id = b.project_id
      WHERE b.id = $1`,
    [batchId],
  );
  const row = rows[0] ?? {};
  return compileBrandRules({
    name: row.target_brand ?? "",
    aliases: Array.isArray(row.brand_aliases) ? row.brand_aliases : [],
    productAliases: Array.isArray(row.brand_product_aliases) ? row.brand_product_aliases : [],
    excludePatterns: Array.isArray(row.brand_exclude_patterns) ? row.brand_exclude_patterns : [],
  });
}

async function loadCitedArticles(batchId, { refresh, limit }) {
  const params = [batchId];
  let limitSql = "";
  if (limit) {
    params.push(limit);
    limitSql = ` LIMIT $${params.length}`;
  }
  return (
    await pool.query(
      `SELECT a.id AS article_id,
              a.original_url,
              a.canonical_url,
              a.title,
              a.normalized_domain,
              count(*) AS citation_count,
              count(DISTINCT r.id) AS run_count,
              count(DISTINCT r.prompt_id) AS prompt_count
         FROM citations c
         JOIN articles a ON a.id = c.article_id
         JOIN runs r ON r.id = c.run_id
         LEFT JOIN article_page_observations apo
           ON apo.batch_id = r.sampling_batch_id AND apo.article_id = a.id
        WHERE r.sampling_batch_id = $1
          AND c.visible_to_user IS NOT FALSE
          ${refresh ? "" : "AND COALESCE(apo.content_profile, '{}'::jsonb) = '{}'::jsonb"}
        GROUP BY a.id
        ORDER BY citation_count DESC, a.id${limitSql}`,
      params,
    )
  ).rows;
}

async function waitForDomain(url) {
  const domain = new URL(url).hostname.toLowerCase();
  const spacing = positiveInt(process.env.ONEGL_SOURCE_DOMAIN_SPACING_MS, 1500);
  const previous = lastDomainFetch.get(domain) ?? 0;
  const delay = Math.max(0, previous + spacing - Date.now());
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  lastDomainFetch.set(domain, Date.now());
}

async function fetchRobots(url, timeoutMs) {
  const base = await assertPublicHttpUrl(url);
  const key = base.hostname.toLowerCase();
  if (robotsCache.has(key)) return robotsCache.get(key);

  let current = await assertPublicHttpUrl(new URL("/robots.txt", base).href);
  let result = { status: "unavailable", text: null };
  try {
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      const response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)),
        headers: { "user-agent": USER_AGENT, accept: "text/plain,*/*;q=0.1" },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirectCount >= 3) {
          result = { status: "unavailable", text: null };
          break;
        }
        current = await assertPublicHttpUrl(new URL(location, current).href);
        continue;
      }

      if (response.status >= 400 && response.status < 500) {
        result = { status: "missing", text: null };
      } else if (response.ok) {
        const text = await response.text();
        result = text && text.length <= 512 * 1024
          ? { status: "found", text }
          : { status: "missing", text: null };
      }
      break;
    }
  } catch {
    result = { status: "unavailable", text: null };
  }
  robotsCache.set(key, result);
  return result;
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

async function fetchHtml(inputUrl, { timeoutMs, maxBytes, maxRedirects = 5 }) {
  let current = await assertPublicHttpUrl(inputUrl);
  const robots = await fetchRobots(current.href, timeoutMs);
  if (robots.status === "unavailable") {
    return { state: "blocked", finalUrl: current.href, errorCode: "ROBOTS_UNAVAILABLE" };
  }
  if (robots.status === "found") {
    const decision = robotsDecision(robots.text, { path: current.pathname || "/", userAgent: USER_AGENT });
    if (decision.rule === "disallow") {
      return { state: "blocked", finalUrl: current.href, errorCode: "ROBOTS_DISALLOW" };
    }
  }

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await waitForDomain(current.href);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirectCount >= maxRedirects) {
        return { state: "redirect_limit", finalUrl: current.href, httpStatus: response.status, errorCode: "PAGE_REDIRECT_LIMIT" };
      }
      current = await assertPublicHttpUrl(new URL(location, current).href);
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) return { state: "too_large", finalUrl: current.href, httpStatus: response.status, contentType, responseBytes: contentLength, errorCode: "PAGE_TOO_LARGE" };
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) return { state: "non_html", finalUrl: current.href, httpStatus: response.status, contentType, responseBytes: contentLength || null };
    if (!response.ok) return { state: response.status === 401 || response.status === 403 || response.status === 429 ? "blocked" : "http_error", finalUrl: current.href, httpStatus: response.status, contentType, errorCode: `HTTP_${response.status}` };

    const body = await readLimitedBody(response, maxBytes);
    if (body.tooLarge) return { state: "too_large", finalUrl: current.href, httpStatus: response.status, contentType, responseBytes: body.bytes, errorCode: "PAGE_TOO_LARGE" };
    const decoded = decodeHtmlBytes(body.data, contentType);
    const quality = assessContentQuality({ text: decoded.text, html: decoded.text, contentType });
    if (!quality.usable) {
      return { state: "unusable", finalUrl: current.href, httpStatus: response.status, contentType, contentCharset: decoded.charset, responseBytes: body.bytes, errorCode: quality.code === "THIN_CONTENT" ? "PAGE_THIN_CONTENT" : "PAGE_JAVASCRIPT_SHELL" };
    }
    return {
      state: "success",
      html: decoded.text,
      finalUrl: current.href,
      httpStatus: response.status,
      contentType,
      contentCharset: decoded.charset,
      responseBytes: body.bytes,
    };
  }
  return { state: "redirect_limit", finalUrl: current.href, errorCode: "PAGE_REDIRECT_LIMIT" };
}

async function persist(batchId, article, fetched, brandRules) {
  if (fetched.state !== "success") {
    await pool.query(
      `INSERT INTO article_page_observations (batch_id, article_id, requested_url, final_url, fetch_state, http_status, content_type, content_charset, response_bytes, error_code, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (batch_id, article_id) DO UPDATE SET
         final_url=EXCLUDED.final_url, fetch_state=EXCLUDED.fetch_state, http_status=EXCLUDED.http_status,
         content_type=EXCLUDED.content_type, content_charset=EXCLUDED.content_charset,
         response_bytes=EXCLUDED.response_bytes, error_code=EXCLUDED.error_code, captured_at=now()`,
      [batchId, article.article_id, article.original_url || article.canonical_url, fetched.finalUrl ?? null, fetched.state, fetched.httpStatus ?? null, fetched.contentType ?? null, fetched.contentCharset ?? null, fetched.responseBytes ?? null, fetched.errorCode ?? null],
    );
    return;
  }

  const features = extractPageFeatures(fetched.html, { url: fetched.finalUrl, contentType: fetched.contentType });
  const intel = buildPageContentIntelligence(fetched.html, {
    titleText: features.titleText,
    metaDescription: features.metaDescription,
    tableCount: features.tableCount,
    listCount: features.listCount,
    faqHeadingCount: features.faqHeadingCount,
    schemaTypes: features.schemaTypes,
    brandRules,
  });

  await pool.query(
    `INSERT INTO article_page_observations (
       batch_id, article_id, requested_url, final_url, fetch_state, http_status, content_type, content_charset,
       response_bytes, captured_at, content_hash, title_text, meta_description, canonical_href, text_length,
       numeric_token_count, numeric_tokens_per_1000_chars, h1_count, h2_count, h3_count, table_count, list_count,
       faq_heading_count, question_heading_count, external_link_count, jsonld_count, schema_types, has_article_schema,
       has_faq_schema, author_present, published_at_raw, modified_at_raw, robots_noindex, robots_nofollow, diagnostics,
       content_excerpt, paragraph_count, heading_outline, content_profile, brand_mentioned, brand_mention_count,
       brand_first_mention_position, brand_matched_terms, brand_contexts, brand_locations, brand_detection_version,
       brand_terms_used
     ) VALUES (
       $1,$2,$3,$4,'success',$5,$6,$7,$8,now(),$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26,$27,$28,$29,$30,$31,$32,$33::jsonb,$34,$35,$36::jsonb,$37::jsonb,$38,$39,$40,$41::jsonb,$42::jsonb,$43::jsonb,$44,$45::jsonb
     )
     ON CONFLICT (batch_id, article_id) DO UPDATE SET
       requested_url=EXCLUDED.requested_url, final_url=EXCLUDED.final_url, fetch_state='success', http_status=EXCLUDED.http_status,
       content_type=EXCLUDED.content_type, content_charset=EXCLUDED.content_charset, response_bytes=EXCLUDED.response_bytes,
       captured_at=now(), error_code=NULL, error_message=NULL, content_hash=EXCLUDED.content_hash,
       title_text=EXCLUDED.title_text, meta_description=EXCLUDED.meta_description, canonical_href=EXCLUDED.canonical_href,
       text_length=EXCLUDED.text_length, numeric_token_count=EXCLUDED.numeric_token_count,
       numeric_tokens_per_1000_chars=EXCLUDED.numeric_tokens_per_1000_chars, h1_count=EXCLUDED.h1_count,
       h2_count=EXCLUDED.h2_count, h3_count=EXCLUDED.h3_count, table_count=EXCLUDED.table_count,
       list_count=EXCLUDED.list_count, faq_heading_count=EXCLUDED.faq_heading_count,
       question_heading_count=EXCLUDED.question_heading_count, external_link_count=EXCLUDED.external_link_count,
       jsonld_count=EXCLUDED.jsonld_count, schema_types=EXCLUDED.schema_types, has_article_schema=EXCLUDED.has_article_schema,
       has_faq_schema=EXCLUDED.has_faq_schema, author_present=EXCLUDED.author_present,
       published_at_raw=EXCLUDED.published_at_raw, modified_at_raw=EXCLUDED.modified_at_raw,
       robots_noindex=EXCLUDED.robots_noindex, robots_nofollow=EXCLUDED.robots_nofollow, diagnostics=EXCLUDED.diagnostics,
       content_excerpt=EXCLUDED.content_excerpt, paragraph_count=EXCLUDED.paragraph_count,
       heading_outline=EXCLUDED.heading_outline, content_profile=EXCLUDED.content_profile,
       brand_mentioned=EXCLUDED.brand_mentioned, brand_mention_count=EXCLUDED.brand_mention_count,
       brand_first_mention_position=EXCLUDED.brand_first_mention_position,
       brand_matched_terms=EXCLUDED.brand_matched_terms, brand_contexts=EXCLUDED.brand_contexts,
       brand_locations=EXCLUDED.brand_locations, brand_detection_version=EXCLUDED.brand_detection_version,
       brand_terms_used=EXCLUDED.brand_terms_used`,
    [
      batchId,
      article.article_id,
      article.original_url || article.canonical_url,
      fetched.finalUrl,
      fetched.httpStatus,
      fetched.contentType,
      fetched.contentCharset,
      fetched.responseBytes,
      features.contentHash,
      features.titleText,
      features.metaDescription,
      features.canonicalHref,
      features.textLength,
      features.numericTokenCount,
      features.numericTokensPer1000Chars,
      features.h1Count,
      features.h2Count,
      features.h3Count,
      features.tableCount,
      features.listCount,
      features.faqHeadingCount,
      features.questionHeadingCount,
      features.externalLinkCount,
      features.jsonLdCount,
      JSON.stringify(features.schemaTypes ?? []),
      features.hasArticleSchema,
      features.hasFaqSchema,
      features.authorPresent,
      features.publishedAtRaw,
      features.modifiedAtRaw,
      features.robotsNoindex,
      features.robotsNofollow,
      JSON.stringify(features.diagnostics ?? []),
      intel.contentExcerpt,
      intel.paragraphCount,
      JSON.stringify(intel.outline ?? []),
      JSON.stringify(intel.contentProfile ?? {}),
      intel.brandMentioned,
      intel.brandMentionCount,
      intel.brandFirstMentionPosition,
      JSON.stringify(intel.brandMatchedTerms ?? []),
      JSON.stringify(intel.brandContexts ?? []),
      JSON.stringify(intel.brandLocations ?? []),
      intel.brandDetectionVersion,
      JSON.stringify(intel.brandTermsUsed ?? []),
    ],
  );
}

async function worker(queue, options, brandRules, stats) {
  while (queue.length) {
    const article = queue.shift();
    const url = article.original_url || article.canonical_url;
    let fetched;
    try {
      fetched = await fetchHtml(url, options);
    } catch (error) {
      fetched = {
        state: "error",
        finalUrl: url,
        errorCode: error?.code ?? "SOURCE_INTELLIGENCE_FETCH_ERROR",
      };
    }
    await persist(options.batchId, article, fetched, brandRules);
    stats.total += 1;
    stats[fetched.state] = (stats[fetched.state] ?? 0) + 1;
    const brand = fetched.state === "success" ? " analyzed" : "";
    console.log(`${fetched.state === "success" ? "✓" : "·"} [${stats.total}] ${article.normalized_domain} ${fetched.state}${brand} ${url}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [brandRules, articles] = await Promise.all([
    loadBrandConfig(options.batchId),
    loadCitedArticles(options.batchId, options),
  ]);
  console.log(`Source intelligence batch=${options.batchId}: ${articles.length} cited pages`);
  console.log(`Target brand: ${brandRules.name || "未配置"}; terms=${brandRules.terms.length}`);
  if (!articles.length) return;

  const stats = { total: 0 };
  const queue = [...articles];
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, queue.length) }, () => worker(queue, options, brandRules, stats)),
  );
  console.log("\nSource intelligence states:");
  console.table(Object.entries(stats).filter(([key]) => key !== "total").map(([state, count]) => ({ state, count })));
  console.log("Only derived excerpts, outlines, structural features and brand contexts are stored; raw third-party HTML/full article text is not persisted.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
