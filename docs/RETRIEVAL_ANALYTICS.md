# Retrieval -> Citation analytics

OneGl keeps three concepts separate:

1. **Search query** — a query string observed in Doubao network search evidence.
2. **Retrieved source** — an external candidate URL observed in network evidence.
3. **Visible citation** — a source confirmed in the rendered Doubao UI.

A retrieved source is **not** a citation.

## Database model

Migration `0006_retrieval_evidence.sql` adds:

- `run_search_queries` — ordered, deduplicated search queries for one run;
- `retrieved_sources` — network candidates linked to deduplicated `articles` rows;
- run-level network state/count columns on `runs`.

`retrieved_sources.visible_to_user` is constrained to `false` and `captured_from` to `NETWORK`.
This prevents a network candidate from silently changing the existing visible-citation metric.

## Candidate -> citation matching

A candidate is only ever matched against a DOM-confirmed citation **in the same run**, and every
match records which rule produced it in `retrieved_sources.match_method`.

Matches are evaluated in strict confidence order, and the first hit wins:

| Order | `match_method` | Meaning |
|---|---|---|
| 1 | `canonical_url_exact` | Both URLs normalise to the same string. Authoritative. |
| 2 | `canonical_url_redirect` | The candidate's redirect target matches. |
| 3 | `canonical_url_html` | The page's own `<link rel="canonical">` matches. |
| 4 | `site_rule_alias` | Same URL after folding presentation hosts (`www.` / `m.` / `amp.` / trailing slash). |
| 5 | `content_hash_alias` | Identical body hash. |

No title similarity, domain-only match or embedding/LLM judgement is used, and the alias tiers
never overwrite the exact tier. What they fix is a *systematic undercount*: the same article is
routinely observed as one URL shape in the network evidence and another in the rendered citation
list, and treating those as "not cited" biases the conversion rate downward.

What is deliberately **not** expanded: the exact metric itself. `exactCitationMatches` and
`exactCitationConversionRate` still mean exactly what they always meant. The wider figure is
reported alongside it as `aliasCitationMatches` / `matchedCitationConversionRate`, so a report can
show both "exact overlap" and "overlap allowing labelled aliases" without either number being
silently redefined.

Query-parameter handling is also strict by construction: only known tracking parameters are
removed, unknown ones are preserved, and remaining parameters are sorted so `?a=1&b=2` and
`?b=2&a=1` compare equal. A parameter that might select a different document is never dropped.

## Metrics

For a batch:

```text
candidate conversion rate = exact matched retrieved sources / retrieved sources
```

This answers: **of the candidate URLs observed in network evidence, what fraction were also
confirmed as visible citations in the same run?**

It does not prove the candidate was considered by the model, scored by a reranker, or read in
full. It only measures the overlap between two observable evidence layers.

Domain conversion rate is computed the same way after grouping candidates by normalized domain.
It is useful for comparing source-selection tendencies while keeping retrieval frequency visible.
For example, 20 final citations from 200 candidates and 10 final citations from 20 candidates are
very different behaviours even though the first domain has more citations.

## Command

After applying migrations and collecting runs with network evidence enabled:

```bash
npm run db:migrate
ONEGL_NETWORK_EVIDENCE=true npm run batch:run -- --batch 1
npm run report:retrieval -- --batch 1
```

The report prints:

- runs with network evidence;
- generated search-query count;
- retrieved candidate count;
- exact candidate -> visible-citation matches;
- overall conversion rate;
- per-domain candidate count, citation count and conversion rate;
- per-run query/candidate/match counts.

## URL normalisation and the alias tiers

`canonicalizeUrl()` only removes things that can never select a different resource: the fragment,
known tracking parameters (`utm_*`, `gclid`, `fbclid`, `spm`, `share_*`, `from_source`, …) and query
ordering. Everything else — including unrecognised query parameters — is preserved.

`siteRuleAlias()` is a separate, looser key used only by tier 4. It folds `www.` / `m.` / `mobile.` /
`amp.` / `touch.` / `so.` / `mip.` sub-domains and an empty trailing slash. It is intentionally not
part of `canonicalizeUrl()`, because two URLs that differ only by `www.` are not *proven* to be the
same article; a match made that way is labelled `site_rule_alias` instead of `canonical_url_exact`.

Internal-host detection (which decides whether a link is an external source at all) is matched on
DNS label boundaries, so `notdoubao.com` is no longer mistaken for a Doubao host and `byteimg.com`
sub-domains are still excluded.

## What is deliberately not calculated yet

### Query -> source attribution

The current collector can observe generated queries and retrieved sources, but it does not yet
have enough validated provenance to claim that a particular source came from a particular query.
Therefore OneGl does **not** create a query-source edge by position or timing alone.

### Hidden ranking score

No score is labelled as Doubao's internal rank/relevance/citation probability unless such a score
is directly observed and its semantics are validated. A model trained later from OneGl data must
be labelled as an **estimated citation probability**, not an internal Doubao score.

### Tiers not yet populated

`canonical_url_redirect` and `canonical_url_html` are defined, constrained in the schema and
accepted by the matcher, but nothing writes them yet: the redirect target and the parsed
`<link rel="canonical">` live in `article_page_observations` (page evidence), which is captured
separately from a run. Wiring those observations into the per-run match is the next step, and it
must land as its own migration so the exact metric keeps its current meaning for existing data.

`content_hash_alias` is likewise reserved: it requires content hashes on both sides of the match,
which only page evidence can supply today.

## Recommended research workflow

Use repeated fixed prompts and preserve the sampling seed. Accumulate enough runs before drawing
source-selection conclusions. Analyze at least these layers separately:

```text
prompt
  -> observed search queries
  -> retrieved candidates
  -> exact candidate/citation overlap
  -> visible citations
  -> answer / brand mention
```

This separation is the basis for later citation-probability modelling.
