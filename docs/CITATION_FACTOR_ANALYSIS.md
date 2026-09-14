# Citation factor analysis

This layer asks a narrower question than retrieval reporting:

> Among retrieved candidates observed in clean runs, which **observable retrieval and page features** are associated with a higher or lower probability of also appearing as a DOM-visible citation?

It does **not** claim to recover Doubao's internal ranking formula, hidden reranker score, model weights, or causal effects.

## Analysis cohort

A candidate enters the factor report only when its run satisfies all of these:

- `status = success`;
- `conversation_reset_confirmed = true`;
- `network_evidence_state = found`.

`partial` runs are intentionally excluded. The binary outcome remains:

```text
cited = retrieved_sources.visible_citation_id IS NOT NULL
```

The relation uses the match tiers defined in `RETRIEVAL_ANALYTICS.md`, and every row records which
tier produced it in `match_method`. The exact tier (`canonical_url_exact`) remains the strict
baseline; `site_rule_alias` covers the same article observed under a presentation-host variant. No
title-similarity, embedding or LLM judgement contributes to the binary outcome.

## Retrieval-side factors

The original factors remain unchanged:

- candidate position bucket;
- title <-> original prompt lexical overlap;
- title <-> observed generated-query lexical overlap;
- summary <-> prompt lexical overlap;
- title / summary / source-name presence;
- run search-query count;
- article retrieval recurrence inside the batch.

These use evidence observed during the Doubao run.

## Optional public-page evidence

A second, deliberately separate evidence layer can be captured after the batch:

```bash
npm run page:capture -- --batch 1
```

The capture command only visits unique article URLs that were already observed as retrieved candidates in clean runs for that batch. It stores a batch-scoped snapshot of **derived fields**, not raw third-party HTML.

Page capture currently records signals such as:

- rendered-source HTML text length (static HTTP response only; no JavaScript rendering claim);
- H1/H2/H3 counts;
- table and list presence;
- FAQ/question heading signals;
- JSON-LD types, including Article-like and FAQPage signals;
- author metadata signal;
- published/modified date metadata signals;
- robots `noindex` / `nofollow` signals;
- numeric-token density;
- external-link count;
- canonical/meta-description/title observations;
- SHA-256 content hash for snapshot change detection.

See `PAGE_EVIDENCE.md` for collection semantics and safety controls.

### Important provenance rule

Page evidence is **OneGl's own later public HTTP observation**. It does not prove that Doubao fetched the same bytes, saw the same version, executed the same JavaScript, or used any of these fields as ranking inputs.

Therefore the factor report labels these fields as descriptive page associations only.

If a page was blocked, timed out, returned non-HTML, exceeded the byte cap, or otherwise failed capture, its page factors are grouped as `missing`; failure is never silently converted to `no` or `0`.

## Page factor buckets

Current page-factor buckets include:

- page text length: `missing`, `<1k`, `1k-5k`, `5k-15k`, `15k+`;
- H2 count: `missing`, `0`, `1-2`, `3-5`, `6+`;
- table/list/FAQ-heading/Article-schema/FAQ-schema/author/modified-date/noindex signals: `missing`, `yes`, `no`;
- numeric density: `missing`, `0`, `low`, `medium`, `high`;
- external links: `missing`, `0`, `1-4`, `5-14`, `15+`.

These bucket boundaries are analysis conveniences, not platform thresholds.

## Lexical similarity

The implementation remains deterministic and dependency-free:

- Unicode NFKC normalization and lower-casing;
- Latin/digit tokens preserved;
- contiguous Han text represented by character bigrams;
- Sørensen-Dice coefficient over unique lexical units.

Similarity buckets are `missing`, `0`, `low`, `medium`, `high`.

This is lexical similarity, not semantic similarity.

## Statistics

For every retained factor bucket OneGl reports:

- candidate count;
- exact citation-match count;
- observed citation rate;
- uplift relative to the whole analyzed cohort;
- Wilson 95% confidence interval for the binomial rate.

```text
uplift = bucket_rate / baseline_rate - 1
```

Large uplift is not causal evidence. In particular, page structure, domain, candidate position, freshness, content length and query overlap can be correlated.

## Commands

```bash
npm run db:migrate
npm run page:capture -- --batch 1
npm run report:factors -- --batch 1
```

Optional controls:

```bash
npm run page:capture -- --batch 1 --concurrency 4 --limit 100
npm run page:capture -- --batch 1 --refresh
npm run report:factors -- --batch 1 --min-n 10 --signal-min-n 20
npm run report:factors -- --batch 1 --json > factor-report.json
```

## Interpretation rules

Do not promote a factor into a GEO recommendation from one batch merely because its uplift is large. At minimum check:

1. sample size and Wilson interval;
2. whether the effect repeats in another seeded/repeated batch;
3. whether one domain or one prompt category dominates the bucket;
4. whether the factor is correlated with another factor;
5. whether page-capture success differs between buckets;
6. whether the page snapshot was taken close enough to the Doubao run to be a useful comparison.

A later multivariable model should be labelled **estimated citation probability**, evaluated out of sample, and kept separate from any claim about Doubao's internal score.
