# GEO Intelligence

OneGl separates **collection evidence** from **derived intelligence**. The collection layer keeps raw answer, citation, retrieval, DOM and network evidence; the intelligence layer re-derives metrics from those stored observations so every headline number remains auditable.

## Provider identity

Every Run now has independent execution identity dimensions:

- `provider`: the execution integration, for example `doubao`
- `model`: the answer-engine/model family being measured
- `provider_access`: `scraped` or `api`
- `model_version`: optional model/surface version when the provider exposes one

The distinction between `scraped` and `api` is intentional: a consumer product and a direct model API are different measurement surfaces and must not be silently mixed. Provider analytics also keep different `model_version` values separate.

Provider adapters normalize results to:

```json
{
  "provider": "doubao",
  "model": "doubao",
  "access": "scraped",
  "modelVersion": null,
  "textContent": "...",
  "rawOutput": {},
  "webQueries": [],
  "citations": []
}
```

The existing Doubao browser collector remains the implementation behind `doubao-web`; account safety, CAPTCHA fail-closed behavior and front-end guards are unchanged. The shared runner no longer requires a browser page for every provider, so later direct-API adapters can reuse the same persistence and analytics path without cloning the collector workflow.

## Current-rule analytics

Collection-time fields remain immutable audit evidence, but GEO intelligence deliberately re-runs **both brand and competitor matching** against stored raw answers using the project's current rules. The response exposes:

```text
ruleMode = current-project-rules
```

That gives the product two useful semantics:

- historical reports can continue to show what OneGl concluded when a Run was captured;
- current intelligence can immediately reflect a newly added alias, exclusion rule or competitor without rewriting historical Run evidence.

## Competitors and Share of Voice

Competitors are configured per project with a name plus optional aliases, domains and exclusion patterns. They can be added through project JSON or the Service API. `aliases` participate in answer-text mention matching; `domains` are source-ownership metadata and are deliberately **not** treated as answer-text aliases, so a cited URL alone cannot create a competitor mention.

Share of Voice uses comparable entity-mention units:

```text
brand share = brand mention units / (brand mention units + competitor mention units)
```

A single answer may mention more than one competitor, so the denominator is entity mentions rather than number of runs. The intelligence response includes both the current aggregate and a daily `shareOfVoice.series` for charting.

## Query Fan-out

If network evidence or a provider exposes the real web searches an engine issued, OneGl stores them in `run_search_queries` and derives:

- total and unique fan-out queries
- high-frequency query rewrites
- number of tracked prompts reached by each rewrite
- brand mention rate for answers associated with each rewrite
- tokens added, dropped and preserved from prompt -> search query
- per-prompt fan-out volume

A search identical to the original prompt and the sentinel `unavailable` are excluded from rewrite analytics, but raw evidence remains stored.

Tokenization uses `Intl.Segmenter` with Chinese word segmentation when available instead of assuming whitespace-delimited English text.

## Citation source stability

OneGl reports two different source-churn measures between consecutive observed days:

1. **Set volatility**: Jaccard distance between the sets of cited domains.
2. **Weighted volatility**: churn in normalized citation-volume shares, implemented as `1 - sum(min(previousShare, currentShare))` over shared domains.

The product-facing stability score is:

```text
stability = round((1 - weightedVolatility) * 100)
```

When fewer than two observed citation days exist, stability is `null` rather than an invented score.

The current human-readable bands are deliberately heuristic:

- `< 40`: `wide-open`
- `40..69`: `contested`
- `>= 70`: `locked-in`

These thresholds should be calibrated later against OneGl's own longitudinal datasets; they are not presented as an industry standard.

### Batch vs rolling-project stability

A single Batch often finishes in one day, so a batch-level stability metric may correctly return `null`. For longitudinal product views use the project window endpoint instead:

```http
GET /v1/projects/{projectId}/intelligence?days=30
```

It aggregates all valid project Runs inside the explicit `[from, to]` time window and includes daily `visibility.series` and `shareOfVoice.series`. The lookback accepts `1..365` days and defaults to 30.

## Deterministic Opportunities

Both intelligence endpoints produce evidence-grounded opportunity candidates from measured signals such as:

- competitor mention-rate gaps
- frequent fan-out queries with weak brand coverage
- unstable citation landscapes with low visibility
- high-share citation domains

This layer does **not** infer page-internal recommendations that the evidence did not observe. A future LLM narrative layer should consume this deterministic digest instead of receiving raw runs and improvising unsupported advice.

## Service API

### Providers

```http
GET /v1/providers
```

### Competitors

```http
GET    /v1/projects/{projectId}/competitors
POST   /v1/projects/{projectId}/competitors
DELETE /v1/projects/{projectId}/competitors/{competitorId}
```

Example:

```json
{
  "name": "特斯拉",
  "aliases": ["Tesla", "Model 3", "Model Y"],
  "domains": ["tesla.com"],
  "exclude_patterns": [],
  "enabled": true
}
```

### Project intelligence (preferred for trends)

```http
GET /v1/projects/{projectId}/intelligence?days=30
```

### Batch intelligence (exact execution slice)

```http
GET /v1/batches/{batchId}/intelligence
```

The response includes:

```text
scope
project
ruleMode
visibility + visibility.series
providers
shareOfVoice + shareOfVoice.series
competitors
fanout
citations.stability
citations.topDomains
promptGaps
opportunities
```

Tenant ownership is checked before competitor, project-intelligence or batch-intelligence data is returned.
