# Citation factor analysis

This layer asks a narrower question than retrieval reporting:

> Among retrieved candidates observed in clean runs, which **observable candidate/run features** are associated with a higher or lower probability of also appearing as a DOM-visible citation?

It does **not** claim to recover Doubao's internal ranking formula, hidden reranker score, model weights, or causal effects.

## Analysis cohort

A candidate enters the factor report only when its run satisfies all of these:

- `status = success`;
- `conversation_reset_confirmed = true`;
- `network_evidence_state = found`.

`partial` runs are intentionally excluded. A partial run means the visible citation set could not be reconciled with the UI-declared count, so treating unmatched retrieved candidates as negatives would introduce false negatives.

The binary outcome is:

```text
cited = retrieved_sources.visible_citation_id IS NOT NULL
```

The relation is still the strict `canonical_url_exact` match defined in `RETRIEVAL_ANALYTICS.md`.

## Observable factors in v1

The first version uses only values already present in OneGl evidence. It does not fetch or infer external page attributes.

### Candidate position

Buckets:

```text
1, 2, 3, 4-5, 6-10, 11+
```

This is the observed source position in network evidence. It is an association feature; do not label it an internal Doubao rank unless that semantic is validated separately.

### Title <-> prompt lexical overlap

A lightweight reproducible lexical similarity between the retrieved page title and the original prompt.

### Title <-> generated-query lexical overlap

The maximum lexical similarity between the title and any observed search query from the same run.

This does not create a query -> source edge. It only asks whether the title resembles at least one observed query.

### Summary <-> prompt lexical overlap

Same lexical metric, using the network-observed summary/snippet when present.

### Evidence completeness flags

- title present;
- summary present;
- source name present.

These can reveal capture-shape effects and should not automatically be interpreted as content-quality factors.

### Search-query count

Buckets the number of observed generated queries in the run:

```text
0, 1, 2, 3-4, 5+
```

This is a run-level feature shared by all candidates in the run.

### Article retrieval frequency

How often the same deduplicated article appears as a candidate within the analyzed batch:

```text
1, 2-3, 4-9, 10+
```

This is descriptive batch recurrence, not a feature known to exist inside Doubao.

## Lexical similarity

The implementation is intentionally dependency-free and deterministic:

- text is Unicode NFKC-normalized and lower-cased;
- Latin/digit tokens are preserved;
- contiguous Han text is represented by character bigrams;
- similarity uses the Sørensen-Dice coefficient over unique lexical units.

Similarity buckets are:

```text
missing
0
low      (0, 0.2)
medium   [0.2, 0.5)
high     [0.5, 1]
```

This is not semantic similarity. A later embedding/LLM feature must be named separately so lexical and semantic evidence cannot be confused.

## Statistics

For every factor bucket, OneGl reports:

- candidate count;
- exact citation-match count;
- observed citation rate;
- uplift relative to the whole analyzed cohort;
- Wilson 95% confidence interval for the binomial rate.

```text
uplift = bucket_rate / baseline_rate - 1
```

Example:

```text
baseline citation rate = 20%
position=1 citation rate = 35%
uplift = +75%
```

This means the observed rate in that bucket is 75% above the cohort baseline. It does **not** mean moving an article to position 1 would causally increase citation probability by 75%.

## Command

```bash
npm run report:factors -- --batch 1
```

Optional controls:

```bash
npm run report:factors -- --batch 1 --min-n 10 --signal-min-n 20
npm run report:factors -- --batch 1 --json > factor-report.json
```

- `--min-n` hides factor buckets with fewer candidates from the main factor tables.
- `--signal-min-n` controls eligibility for the "strongest observed associations" ranking.
- `--json` emits the report as machine-readable JSON for notebooks or later modelling.

## Interpretation rules

Do not promote a factor into a GEO recommendation from one batch merely because its uplift is large.

At minimum check:

1. sample size and Wilson interval;
2. whether the effect repeats in another seeded/repeated batch;
3. whether one domain or one prompt category dominates the bucket;
4. whether the factor is correlated with another factor (for example position and title overlap);
5. whether capture completeness differs between buckets.

These checks matter because this v1 report is univariate descriptive analysis. Simpson's paradox and confounding are possible.

## Next modelling gate

A multivariable estimated-citation-probability model should only be added after real-account data shows that:

- network retrieval evidence is stable enough across a meaningful sample;
- exact candidate/citation matching has acceptable coverage;
- enough positive and negative candidates exist for train/test separation;
- repeated prompt batches show reasonably stable feature distributions.

When such a model is added, it must be labelled **estimated citation probability** and evaluated out of sample. It must never be presented as Doubao's internal score.
