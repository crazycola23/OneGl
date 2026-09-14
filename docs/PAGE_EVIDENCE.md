# Retrieved-page evidence

OneGl can optionally capture **observable page features** for URLs that already appeared as retrieved candidates in a clean Doubao batch.

This layer exists to test practical GEO hypotheses such as whether cited candidates are more often structured, dated, authored, data-dense or table/list-heavy. It does **not** claim that Doubao fetched the page in the same way, at the same time, or with the same rendering environment.

## Crawler behaviour

Page evidence is collected by a polite crawler, not a fetcher that hits every URL in the batch:

- **robots.txt is honoured.** A domain's rules are fetched once per run and cached; a disallowed
  path is skipped and recorded as `blocked` with `ROBOTS_DISALLOW`. If robots.txt itself cannot be
  fetched (network error or 5xx), the domain is skipped rather than assumed to consent.
- **Per-domain circuit breaker.** Three consecutive failures (blocked, HTTP error, timeout,
  redirect limit) open a 15-minute window for that domain, during which remaining candidates are
  skipped without a request. A success, including a 304, resets the counter.
- **Conditional requests.** When a previous observation stored an `etag` or `last-modified`, the
  next capture sends `if-none-match` / `if-modified-since`. A `304` is stored as
  `not_modified`: the row is timestamped, the existing features are kept, and the page is not
  re-read. This is what makes repeated captures cheap for the origin.
- **Deterministic per-domain spacing.** `ONEGL_PAGE_DOMAIN_SPACING_MS` (default 1500) applies a
  stable per-domain offset so a queue of same-site URLs does not arrive as a burst. It is
  deterministic on purpose: random jitter would make a re-run unreproducible.
- **Content quality gate.** A `200` response with no usable body (JavaScript shell, interstitial,
  or under 200 characters of text) is stored as `unusable`, not `success`. Otherwise "the page did
  not load" silently becomes "the page has no FAQ schema" in the factor table.

CLI switches: `--no-robots` and `--unconditional` exist for environments where the operator has
already established permission and wants to re-read everything.
## Scope

Page evidence is intentionally downstream of retrieval capture:

```text
Doubao run
  -> observed retrieved candidate URL
  -> OneGl page:capture (separate step)
  -> batch-scoped page observation
  -> descriptive Retrieved -> Cited factor analysis
```

OneGl does not crawl arbitrary search results or discover new URLs in this step. It only visits the unique candidate articles already observed in the selected batch.

## Capture command

Apply migrations first:

```bash
npm run db:migrate
```

Then capture page evidence for a completed batch:

```bash
npm run page:capture -- --batch 1
```

Optional controls:

```bash
npm run page:capture -- --batch 1 --concurrency 2 --timeout-ms 12000 --max-bytes 2097152
npm run page:capture -- --batch 1 --limit 50
npm run page:capture -- --batch 1 --refresh
```

Environment defaults:

```text
ONEGL_PAGE_CONCURRENCY=4
ONEGL_PAGE_TIMEOUT_MS=10000
ONEGL_PAGE_MAX_BYTES=2097152
```

## Safety / correctness boundaries

The fetcher:

- accepts only public HTTP(S) URLs;
- rejects localhost and private/reserved IP destinations before each request and redirect;
- follows redirects manually and re-validates the next destination;
- enforces timeout, redirect and response-size limits;
- accepts only HTML/XHTML for feature extraction;
- stores no raw third-party HTML in PostgreSQL;
- stores a SHA-256 content hash plus derived fields for audit/change detection.

The URL guard reduces SSRF risk, but it is not a substitute for network-level egress controls in a production deployment.

## Stored observation states

Each `(batch_id, article_id)` has at most one current batch-scoped observation:

- `success` — HTML fetched and features extracted;
- `blocked` — access denied or destination rejected;
- `non_html` — response is not HTML/XHTML;
- `too_large` — response exceeds configured size limit;
- `http_error` — other non-success HTTP response;
- `redirect_limit` — redirect chain exceeded the configured limit;
- `error` — DNS/network/parser-side fetch failure.

A failed page capture is **not** converted into a negative content feature. In factor analysis, content features become `missing` unless `fetch_state = success`.

## Observable features

For successful observations OneGl currently derives:

- response/content metadata and final URL;
- title, meta description and canonical href;
- visible-text character length;
- numeric-token count and numeric tokens per 1,000 visible characters;
- H1/H2/H3 counts;
- table and list counts;
- FAQ/question-heading lexical signals;
- external HTTP(S) link count;
- JSON-LD count and observed `@type` values;
- Article-like / FAQPage schema signals;
- author metadata/JSON-LD signal;
- published/modified date strings when observable;
- robots `noindex` / `nofollow` signals;
- JSON-LD parse diagnostics.

These are surface observations, not quality scores. For example, `FAQPage=true` means OneGl observed that schema type; it does not mean the schema improves citation probability.

## Factor analysis

After page capture:

```bash
npm run report:factors -- --batch 1 --min-n 10 --signal-min-n 20
```

The factor report joins the page observation for the same batch and can compare citation rates across buckets such as:

- page text length;
- H2 count;
- table/list presence;
- FAQ heading signal;
- Article / FAQPage schema presence;
- author / modified-date signal;
- noindex signal;
- numeric density;
- external-link count.

All results remain **descriptive associations**. Page structure, domain authority, candidate position, prompt category and content freshness can be correlated. A factor should only become a product recommendation after it repeats across independent batches and survives multivariable/out-of-sample checks.

## Important timing caveat

`page:capture` usually runs after the Doubao batch. Therefore the stored page snapshot may not be byte-identical to what existed at the exact answer time. The report exposes page-evidence coverage and keeps this timing limitation explicit instead of presenting the features as Doubao-internal observations.
