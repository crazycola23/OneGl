# OneGl architecture

## Goal

OneGl measures how a target brand appears in Doubao answers and which observable sources are
retrieved and cited, using reproducible prompts in independent fresh conversations:

```text
Keyword pool -> seeded sample -> per-account queue -> fresh conversation
  -> Doubao Web
     -> Answer -> brand detection
     -> DOM-visible citations -----------------------> citations
     -> optional Network/SSE search provenance
          -> generated search queries --------------> run_search_queries
          -> retrieved candidate sources -----------> retrieved_sources
                 -> canonical URL exact overlap -----^ visible citation relation
  -> PostgreSQL -> visibility report / retrieval report / factor report
```

The browser UI remains the source of truth for `visible_to_user`. Network evidence can show search
queries and retrieved candidates, but a network-observed source is not automatically a citation
and does not prove that the final answer used it.

The governing rule is **数据可信度 > 功能数量**: unsupported relations are left unknown rather than
filled in by inference.

## Runtime topology

Three processes share one collector core (`src/collect/runner.js`):

| Process | Entry point | Role |
|---|---|---|
| Collector CLI | `src/cli.js` | auth / run / batch, project setup, sampling, reports |
| Worker | `src/worker.js` | drains BullMQ queues, one serial queue per account |
| Web | `src/server.js` | read-only dashboard plus batch start/stop |

- **Browser automation:** Playwright Core.
- **Default browser:** Camoufox.
- **Authentication:** manual first login; `storageState` stays local under `.onegl/auth/`.
- **Queue:** BullMQ over Redis; one queue per account with concurrency 1.
- **Database:** PostgreSQL through numbered migrations in `migrations/*.sql`.

## Prompt isolation and fail-closed

Every prompt must run in a conversation that is provably empty. If emptiness cannot be confirmed
within `DOUBAO_CONVERSATION_SETTLE_MS`, the prompt is not submitted and the run fails with
`DOUBAO_CONVERSATION_RESET_FAILED`.

This is an execution gate rather than a reporting filter: a contaminated answer cannot be made
valid later by excluding it from a report.

## Answer capture

Doubao renders user and assistant content with overlapping renderer classes, so answer extraction
filters user bubbles by ancestor alignment and uses streaming/stability signals to detect
completion. A partial answer is kept as evidence on timeout but does not become a successful run.

## Citation truth model

DOM-confirmed visible sources are citation truth:

```text
source_type = visible
captured_from = DOM
visible_to_user = true
```

When Doubao renders `搜索 N 个关键词，参考 M 篇资料`, `M` is treated as an explicit expected visible
citation count. If the final unique visible URLs do not reconcile with `M`, the run becomes
`partial` with `CITATION_PARSE_FAILED`.

A retrieved source is never auto-promoted into this visible set.

## Network / SSE provenance

`src/network-evidence.js` is an opt-in passive observer enabled with:

```bash
ONEGL_NETWORK_EVIDENCE=true
```

It listens to Playwright response events and looks for search-result-shaped JSON/SSE payloads such
as `block_type:10025` / `search_query_result`. When exposed, it extracts:

- generated search queries;
- external candidate URLs;
- title / source name / summary when present;
- candidate position when present;
- sanitized endpoint metadata.

Every network candidate is represented conservatively:

```json
{
  "sourceType": "retrieved",
  "capturedFrom": "NETWORK",
  "visibleToUser": false,
  "relationStatus": "unresolved"
}
```

Raw response bodies are parsed in memory but not persisted. Stored endpoint identity strips query
strings, and cookies / authorization headers are not copied into evidence artifacts.

Per-attempt provenance is written to `network-evidence.json`; normalized search queries and
retrieved candidates are also persisted when PostgreSQL is enabled.

## Retrieval persistence

Migration `0006_retrieval_evidence.sql` keeps search/retrieval evidence separate from citation
truth:

- `run_search_queries` — ordered, deduplicated queries observed for one run;
- `retrieved_sources` — deduplicated candidate articles observed in network evidence;
- run-level network evidence state / diagnostics / counts.

Persistence happens inside the same `persistRun` transaction as answer and visible-citation
storage. Therefore a database run cannot commit visible citations while silently losing its
retrieval evidence, or vice versa.

`retrieved_sources` is constrained to:

```text
captured_from = NETWORK
visible_to_user = false
```

## Candidate -> visible citation relation

The only automatic candidate/citation relation currently stored is:

```text
same run
AND retrieved canonical_url == visible citation canonical_url
```

Stored match method, evaluated in confidence order (first hit wins):

```text
canonical_url_exact     same normalised URL (authoritative)
canonical_url_redirect  candidate's redirect target
canonical_url_html      page-declared <link rel="canonical">
site_rule_alias         www. / m. / amp. / trailing-slash folding
content_hash_alias      identical body hash
```

No domain-only, title-similarity, embedding or LLM judgement is used for this relation, and the
alias tiers never replace the exact tier: `exactCitationMatches` keeps its original meaning, and the
wider figure is reported separately as `aliasCitationMatches` / `matchedCitationConversionRate`.
That still favours false negatives over unsupported positives, but it no longer counts an obviously
identical article as "not cited" merely because the network copy and the rendered citation were
observed under different URL shapes.

## Citation factor analysis

`src/analysis/citation-factors.js` derives reproducible, observable factor buckets from already
captured evidence. `tools/citation-factor-report.js` analyzes only clean runs:

```text
status = success
conversation_reset_confirmed = true
network_evidence_state = found
```

`partial` runs are excluded because incomplete visible-citation capture would create false
negative candidate outcomes.

Current factors include:

- candidate position bucket;
- title <-> prompt lexical overlap;
- title <-> observed search-query lexical overlap;
- summary <-> prompt lexical overlap;
- title / summary / source-name presence;
- run search-query count;
- article retrieval recurrence inside the batch.

For each bucket OneGl reports sample size, exact citation rate, uplift relative to the cohort
baseline and a Wilson 95% interval.

These outputs are **descriptive associations**, not causal effects and not Doubao internal
weights. See [CITATION_FACTOR_ANALYSIS.md](CITATION_FACTOR_ANALYSIS.md).

## Storage: dual track

Structured research/business data goes to PostgreSQL while per-attempt audit evidence stays on
disk:

```text
.onegl/runs/<run_id>/
  run.json
  attempts/
    1/
      screenshot.png
      page.html
      answer.md
      citations.json
      dom-observation.json
      network-evidence.json   # when enabled
    2/
      ...
```

Retries reuse the deterministic run identity but write to a new attempt directory so earlier
failure evidence is not overwritten.

## Error semantics

Session-blocking errors stop work on an account rather than repeatedly hitting the provider:

- `DOUBAO_LOGIN_REQUIRED`
- `DOUBAO_SESSION_EXPIRED`
- `DOUBAO_VERIFICATION_REQUIRED`
- `DOUBAO_ACCESS_RESTRICTED`

Other run errors include timeout, submission, conversation-reset, answer-not-found, citation-parse,
page-change, rate-limit and network failures.

Temporary account states delay work until recovery; permanent/manual states skip work and stop
hitting the account. Daily limits use the configured account timezone.

## Batch state machine

`completed_jobs + failed_jobs + skipped_jobs` never exceeds requested assignments.

| Situation | Terminal status |
|---|---|
| real data produced, nothing failed or skipped | `completed` |
| successes mixed with failures/skips | `partial` |
| everything skipped | `partial` |
| nothing succeeded | `failed` |
| manually stopped | `aborted` |

## Reporting layers

The reporting surfaces intentionally answer different questions:

```text
npm run report -- --batch <id>
  -> brand visibility + DOM-visible citation metrics

npm run report:retrieval -- --batch <id>
  -> retrieved candidates + exact retrieved->cited conversion

npm run report:factors -- --batch <id>
  -> descriptive factor/citation-rate associations
```

Client-facing HTML output remains based on the standard batch visibility snapshot. Experimental
network/factor research should not silently enter client headline metrics.

## Validation gate

Before treating network-derived analytics as production-grade evidence, an authorised live run
must confirm:

1. current Doubao response endpoint/payload shapes still expose the intended search layer;
2. extracted queries and candidate URLs correspond to the product's actual search/retrieval UI
   behaviour;
3. passive response observation does not change answer completion or visible citation counts;
4. no auth/session material is written into evidence;
5. exact candidate/citation overlap is stable enough across repeated batches for downstream
   analysis.

A multivariable estimated-citation-probability model is deliberately gated on those checks and on
having enough repeated data for out-of-sample evaluation.
