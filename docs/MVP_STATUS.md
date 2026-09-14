# MVP status

## Phase model

| Phase | Scope | Status |
|---|---|---|
| **Phase 0** — Doubao capture validation | Answer + DOM-visible citations + per-run evidence | Implemented |
| **Phase 1** — Persistent collection | PostgreSQL schema, migrations, transactional persistence, article dedup | Implemented |
| **Phase 2** — Batch / queue / operator workflow | Keyword pools, seeded sampling, per-account profiles, BullMQ worker, account safety, dashboard | Implemented |
| **Phase 3** — Visibility analytics | Mention rates, domain/article aggregation, HTML report | Implemented |
| **Experimental A** — Network/SSE provenance | Search-query + retrieved-candidate capture | Implemented; opt-in, needs current real-account validation |
| **Experimental B** — Retrieval -> citation analytics | Candidate persistence, exact matching, conversion reporting | Implemented |
| **Experimental C** — Citation factor analysis | Descriptive factor rates/uplift/confidence intervals | Implemented |
| Beyond | Multivariable estimated citation probability, other providers | Not started deliberately |

"Implemented" means the code exists and offline-testable logic is covered where possible. Browser
and provider-facing behaviour still requires authorised real-account re-validation.

## Phase 0 — Doubao capture validation

- Camoufox-first Playwright browser launcher.
- Manual first login; local per-account `storageState`.
- Session classification: healthy / login / verification / access restricted / unknown.
- Confirmed fresh conversation before every prompt; fail closed before submit if isolation cannot
  be proven.
- Prompt input verification and fail-closed submission confirmation.
- Assistant-answer capture excluding the user's own renderer bubble.
- DOM-visible source extraction from the current reference block/UI.
- Enforcement of visible `参考 M 篇资料` count; unresolved count gaps become `partial`.
- Per-attempt evidence directories; retries never overwrite earlier attempts.

## Experimental A — Network / SSE provenance

- Opt-in via `ONEGL_NETWORK_EVIDENCE=true`.
- Passive Playwright response observer; no request mutation or access-control bypass.
- Parses JSON/SSE search-result-shaped payloads including nested/stringified structures.
- Extracts generated search queries, external candidate URLs and optional title/source/summary.
- Raw response bodies are parsed in memory but not persisted.
- Stored endpoint metadata strips query strings; cookies/auth headers are not copied.
- Retrieved sources remain `NETWORK`, `visible_to_user=false`, separate from citation truth.
- Per-attempt `network-evidence.json` is retained for audit.

## Experimental B — Retrieval -> citation analytics

Migration `0006_retrieval_evidence.sql` adds:

- `run_search_queries`;
- `retrieved_sources`;
- run-level network evidence state/diagnostic/count fields.

Search queries and retrieved candidates are persisted inside the same PostgreSQL transaction as
the run and visible citations.

The only automatic candidate -> visible citation relation is exact canonical URL equality within
the same run:

```text
match_method = canonical_url_exact
```

No domain-only, title-similarity, redirect, embedding or LLM match is silently substituted.

Report:

```bash
npm run report:retrieval -- --batch <id>
```

Outputs candidate counts, exact matches, conversion rate, per-domain conversion and per-run
query/candidate/match counts.

## Experimental C — Citation factor analysis

Report:

```bash
npm run report:factors -- --batch <id>
```

The analysis cohort is intentionally strict:

```text
status = success
conversation_reset_confirmed = true
network_evidence_state = found
```

`partial` runs are excluded so incomplete visible citation capture cannot create false negatives.

Current observable factors:

- candidate position;
- title <-> prompt lexical overlap;
- title <-> observed generated-query lexical overlap;
- summary <-> prompt lexical overlap;
- title / summary / source-name presence;
- search-query count;
- repeated candidate frequency inside the analyzed batch.

Each factor bucket reports sample size, exact citation rate, uplift versus cohort baseline and a
Wilson 95% interval. Results are descriptive associations, not causal effects or proprietary
Doubao weights.

See [CITATION_FACTOR_ANALYSIS.md](CITATION_FACTOR_ANALYSIS.md).

## Persistent collection

- Numbered SQL migrations with checksum ledger; no ORM.
- One transaction per run.
- `articles` deduplicate on `canonical_url`.
- Visible citation truth remains in `citations`.
- Retrieval evidence remains in `run_search_queries` / `retrieved_sources`.
- `DATABASE_URL` is optional; artifact-only collection still works without PostgreSQL.

## Batch / queue / account safety

- Seeded random or stratified sampling with stored seed and pool version.
- Per-account browser profiles and anonymous account keys.
- BullMQ queue per account, concurrency 1 per account.
- Deterministic run identity and retry attempts.
- Temporary cooldown states delay jobs; permanent/manual states skip and stop the account.
- Daily limits use configured account timezone.
- Terminal batch status distinguishes completed / partial / failed / aborted consistently.

## Reporting layers

The three main reports have deliberately different truth scopes:

```text
npm run report
  DOM-visible citation + brand visibility metrics

npm run report:retrieval
  observed retrieval candidate -> exact visible citation overlap

npm run report:factors
  descriptive associations inside the clean retrieval/citation cohort
```

Experimental retrieval/factor metrics do not silently enter client-facing headline citation
numbers.

## Deliberately not implemented

- claims about training data or hidden model reads;
- fuzzy candidate/citation matching presented as exact evidence;
- query -> source attribution when the network payload does not explicitly provide it;
- Doubao internal ranking-score claims;
- multivariable citation-probability modelling before sufficient repeated real data exists;
- multi-provider abstraction/refactor;
- payment or multi-tenant SaaS permissions.

## Awaiting real-account validation

The following must be re-verified with an authorised live account before network-derived analysis
is treated as production-grade:

- `NEEDS_REAL_ACCOUNT_VALIDATION` — fresh-conversation detection on current Doubao Web;
- `NEEDS_REAL_ACCOUNT_VALIDATION` — session/login/verification/access-restriction classification;
- `NEEDS_REAL_ACCOUNT_VALIDATION` — current DOM selectors, prompt submission and answer completion;
- `NEEDS_REAL_ACCOUNT_VALIDATION` — citation expander/count reconciliation;
- `NEEDS_REAL_ACCOUNT_VALIDATION` — real rate-limit/session-expiry behaviour;
- `NEEDS_REAL_ACCOUNT_VALIDATION` — queue retry attempts and artifact preservation end to end;
- `NEEDS_REAL_ACCOUNT_VALIDATION` — current Network/SSE endpoint and payload shape;
- `NEEDS_REAL_ACCOUNT_VALIDATION` — observed search queries / retrieved URLs map to the intended
  current product retrieval layer;
- `NEEDS_REAL_ACCOUNT_VALIDATION` — passive network capture does not alter answer completion,
  visible citation counts or account safety behaviour.

## Known risks

- Network field names are reverse-observed implementation details and may change.
- Exact URL matching can undercount true candidate/citation overlap when redirects or alternate
  canonical forms are involved; this is preferable to unsupported positive matches.
- Citation-factor analysis is univariate/descriptive, so confounding and Simpson's paradox are
  possible.
- Small buckets can produce unstable uplift; use sample thresholds and Wilson intervals.
- The full fixed live validation suite must be rerun after provider-facing changes.

## Gate before estimated-probability modelling

Do not add a multivariable model until repeated authorised batches show:

1. stable enough network evidence capture;
2. acceptable exact match coverage;
3. enough positive and negative candidate outcomes;
4. reproducible feature distributions across repeated prompts/batches;
5. enough data for train/test or time-split out-of-sample evaluation.

Any future model must be labelled **estimated citation probability**, never Doubao's internal
score.
