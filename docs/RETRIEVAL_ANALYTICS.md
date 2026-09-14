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

OneGl currently records a candidate as finally cited only when all of these are true:

- candidate and visible citation belong to the same run;
- both URLs canonicalize to exactly the same `canonical_url`;
- the visible source is a DOM-confirmed citation.

The stored method is:

```text
canonical_url_exact
```

No title similarity, domain-only match, redirect guess, fuzzy URL match, embedding similarity or
LLM judgement is used. Those methods may be useful later, but they must be reported separately
from exact evidence.

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

## What is deliberately not calculated yet

### Query -> source attribution

The current collector can observe generated queries and retrieved sources, but it does not yet
have enough validated provenance to claim that a particular source came from a particular query.
Therefore OneGl does **not** create a query-source edge by position or timing alone.

### Hidden ranking score

No score is labelled as Doubao's internal rank/relevance/citation probability unless such a score
is directly observed and its semantics are validated. A model trained later from OneGl data must
be labelled as an **estimated citation probability**, not an internal Doubao score.

### Fuzzy citation matching

If a retrieved URL redirects to a different visible citation URL, exact matching may undercount
true overlap. That is preferable to silently overcounting. Redirect-aware or content-hash matching
can be added later as a separate match method with its own validation.

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
