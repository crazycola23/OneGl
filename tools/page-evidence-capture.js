import "dotenv/config";
import { fetchPageEvidence } from "../src/analysis/page-features.js";
import { createPool } from "../src/db/pool.js";

const pool = createPool();

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseArgs(argv) {
  const args = {
    batchId: null,
    concurrency: positiveInt(process.env.ONEGL_PAGE_CONCURRENCY, 4),
    timeoutMs: positiveInt(process.env.ONEGL_PAGE_TIMEOUT_MS, 10000),
    maxBytes: positiveInt(process.env.ONEGL_PAGE_MAX_BYTES, 2 * 1024 * 1024),
    refresh: false,
    limit: null,
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
    throw new Error("Usage: npm run page:capture -- --batch <positive batch id> [--concurrency 4] [--limit N] [--refresh]");
  }
  if (!args.concurrency || !args.timeoutMs || !args.maxBytes) throw new Error("page evidence limits must be positive integers");
  return args;
}

async function loadArticles(batchId, { refresh, limit }) {
  const params = [batchId];
  let limitSql = "";
  if (limit) {
    params.push(limit);
    limitSql = ` LIMIT $${params.length}`;
  }
  return (
    await pool.query(
      `SELECT DISTINCT a.id AS article_id,
                       a.original_url,
                       a.canonical_url,
                       a.title,
                       a.normalized_domain
         FROM retrieved_sources rs
         JOIN articles a ON a.id = rs.article_id
         JOIN runs r ON r.id = rs.run_id
        WHERE r.sampling_batch_id = $1
          AND r.status = 'success'
          AND r.conversation_reset_confirmed IS TRUE
          AND r.network_evidence_state = 'found'
          ${refresh ? "" : "AND NOT EXISTS (SELECT 1 FROM article_page_observations apo WHERE apo.batch_id = r.sampling_batch_id AND apo.article_id = a.id)"}
        ORDER BY a.id${limitSql}`,
      params,
    )
  ).rows;
}

async function persistObservation(batchId, article, result) {
  const f = result.features ?? {};
  await pool.query(
    `INSERT INTO article_page_observations (
       batch_id, article_id, requested_url, final_url, fetch_state, http_status, content_type,
       content_charset, response_bytes, captured_at, error_code, error_message, content_hash, title_text,
       meta_description, canonical_href, text_length, numeric_token_count,
       numeric_tokens_per_1000_chars, h1_count, h2_count, h3_count, table_count, list_count,
       faq_heading_count, question_heading_count, external_link_count, jsonld_count, schema_types,
       has_article_schema, has_faq_schema, author_present, published_at_raw, modified_at_raw,
       robots_noindex, robots_nofollow, diagnostics
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29,$30,$31,$32,$33,$34,$35,$36::jsonb
     )
     ON CONFLICT (batch_id, article_id) DO UPDATE SET
       requested_url = EXCLUDED.requested_url,
       final_url = EXCLUDED.final_url,
       fetch_state = EXCLUDED.fetch_state,
       http_status = EXCLUDED.http_status,
       content_type = EXCLUDED.content_type,
       content_charset = EXCLUDED.content_charset,
       response_bytes = EXCLUDED.response_bytes,
       captured_at = now(),
       error_code = EXCLUDED.error_code,
       error_message = EXCLUDED.error_message,
       content_hash = EXCLUDED.content_hash,
       title_text = EXCLUDED.title_text,
       meta_description = EXCLUDED.meta_description,
       canonical_href = EXCLUDED.canonical_href,
       text_length = EXCLUDED.text_length,
       numeric_token_count = EXCLUDED.numeric_token_count,
       numeric_tokens_per_1000_chars = EXCLUDED.numeric_tokens_per_1000_chars,
       h1_count = EXCLUDED.h1_count,
       h2_count = EXCLUDED.h2_count,
       h3_count = EXCLUDED.h3_count,
       table_count = EXCLUDED.table_count,
       list_count = EXCLUDED.list_count,
       faq_heading_count = EXCLUDED.faq_heading_count,
       question_heading_count = EXCLUDED.question_heading_count,
       external_link_count = EXCLUDED.external_link_count,
       jsonld_count = EXCLUDED.jsonld_count,
       schema_types = EXCLUDED.schema_types,
       has_article_schema = EXCLUDED.has_article_schema,
       has_faq_schema = EXCLUDED.has_faq_schema,
       author_present = EXCLUDED.author_present,
       published_at_raw = EXCLUDED.published_at_raw,
       modified_at_raw = EXCLUDED.modified_at_raw,
       robots_noindex = EXCLUDED.robots_noindex,
       robots_nofollow = EXCLUDED.robots_nofollow,
       diagnostics = EXCLUDED.diagnostics`,
    [
      batchId,
      article.article_id,
      article.original_url || article.canonical_url,
      result.finalUrl ?? null,
      result.state,
      result.httpStatus ?? null,
      result.contentType ?? f.contentType ?? null,
      result.contentCharset ?? null,
      result.responseBytes ?? null,
      result.errorCode ?? null,
      result.errorMessage ?? null,
      f.contentHash ?? null,
      f.titleText ?? null,
      f.metaDescription ?? null,
      f.canonicalHref ?? null,
      f.textLength ?? null,
      f.numericTokenCount ?? null,
      f.numericTokensPer1000Chars ?? null,
      f.h1Count ?? null,
      f.h2Count ?? null,
      f.h3Count ?? null,
      f.tableCount ?? null,
      f.listCount ?? null,
      f.faqHeadingCount ?? null,
      f.questionHeadingCount ?? null,
      f.externalLinkCount ?? null,
      f.jsonLdCount ?? null,
      JSON.stringify(f.schemaTypes ?? []),
      f.hasArticleSchema ?? null,
      f.hasFaqSchema ?? null,
      f.authorPresent ?? null,
      f.publishedAtRaw ?? null,
      f.modifiedAtRaw ?? null,
      f.robotsNoindex ?? null,
      f.robotsNofollow ?? null,
      JSON.stringify(f.diagnostics ?? []),
    ],
  );
}

async function worker(queue, options, stats) {
  while (queue.length) {
    const article = queue.shift();
    const url = article.original_url || article.canonical_url;
    const result = await fetchPageEvidence(url, { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
    await persistObservation(options.batchId, article, result);
    stats.total += 1;
    stats[result.state] = (stats[result.state] ?? 0) + 1;
    const marker = result.state === "success" ? "✓" : "·";
    const charset = result.contentCharset ? ` charset=${result.contentCharset}` : "";
    console.log(`${marker} [${stats.total}] ${article.normalized_domain} ${result.state}${charset} ${url}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const articles = await loadArticles(options.batchId, options);
  console.log(`Page evidence batch=${options.batchId}: ${articles.length} unique retrieved articles to capture`);
  console.log(`Limits: concurrency=${options.concurrency}, timeout=${options.timeoutMs}ms, maxBytes=${options.maxBytes}`);
  if (!articles.length) return;

  const stats = { total: 0 };
  const queue = [...articles];
  await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, () => worker(queue, options, stats)));
  console.log("\nPage evidence states:");
  console.table(Object.entries(stats).filter(([key]) => key !== "total").map(([state, count]) => ({ state, count })));
  console.log("No raw page HTML is persisted; only derived fields, detected charset and a SHA-256 content hash are stored.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
