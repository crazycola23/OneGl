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

## Evidence gate and domain-stratified analysis

Two additions exist because the factor table is persuasive by construction: it has uplift,
confidence intervals and q-values, and that makes a purely observational number look like a
finding.

### Evidence gate

`buildEvidenceGate()` runs *before* any recommendation is produced. It records blockers
(insufficient match coverage, too few candidates, page-evidence coverage below 70%) and warnings
(few domains, too few paired domains). When a blocker is present:

- `strongestSignals` is returned empty;
- the signals that would have been shown are moved to `suppressedSignals`, which the CLI and the
  HTML report label as diagnostic-only;
- the HTML report renders the blocker messages inline instead of a recommendation list.

The gate is not a statistical correction. It is a statement that a number resting on an
unobserved majority of the retrieval layer cannot support an action, regardless of how small its
p-value looks.

### Domain stratification

Candidate rows are clustered by domain, and the pooled analysis treats them as independent. The
stratified layer computes, per factor bucket:

| Field | Meaning |
|---|---|
| `domains` | how many domains contributed to this bucket |
| `pairedDomains` | domains that contained BOTH this bucket and its complement, i.e. the only ones that can compare the factor to itself |
| `withinDomainDifference` | mean per-domain rate difference (each domain counts once, whatever its row count) |
| `withinDomainPValue` | Wilcoxon signed-rank over the paired differences |
| `directionConsistent` | ≥80% of paired domains agree in direction |
| `evidenceLevel` | capped at exploratory when the pooled test had to be used |

Three rules follow from this, and each is covered by a test:

1. **Complete pairs cannot hide a reversal.** When every domain contributes both arms, the pooled
   difference is algebraically proportional to the within-domain difference, so the two can never
   disagree in sign. The composition risk is therefore about *unbalanced* designs, not balanced
   ones.
2. **A bucket no domain can pair is capped at exploratory.** `significanceBasis` becomes
   `pooled_naive` and the evidence ladder refuses to go higher, because the pooled difference is
   then a statement about which sites use the feature.
3. **Domains that disagree in direction cap the claim.** Even with a small p-value, a bucket whose
   per-domain differences point both ways is reported as directionally inconsistent.

`design.nEff` reports how many independent observations the domain structure actually buys, based
on a variance decomposition of the citation outcome. It is routinely much smaller than the row
count, and that gap is the honest sample size.

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
