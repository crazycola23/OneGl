# OneGl — Doubao AI Citation Intelligence

OneGl is a China-first GEO / AI Citation Intelligence tool built from the architectural ideas of
the open-source [OneGlanse](https://github.com/aryamantodkar/oneglanse) project. It currently
supports **Doubao Web** and measures both brand visibility and observable source-selection
behaviour.

```text
Prompt
  -> Doubao Web
  -> Answer / brand mention
  -> DOM-visible citations
  -> optional Network/SSE search provenance
       -> generated search queries
       -> retrieved candidate sources
       -> exact candidate -> visible citation overlap
       -> descriptive citation-factor analysis
```

The guiding principle is **数据可信度 > 功能数量**. A network-observed source is never silently
promoted into a visible citation, and an estimated association is never labelled as Doubao's
internal score.

## Phase roadmap

| Phase | Scope | Status |
|---|---|---|
| **Phase 0** — Doubao capture validation | Browser capture of answer + DOM-visible citations, per-run evidence artifacts | Implemented; capture chain exercised against a real logged-in account |
| **Phase 1** — Persistent collection | PostgreSQL schema, migrations, transactional persistence, article dedup | Implemented |
| **Phase 2** — Batch / queue / operator workflow | Keyword pools, seeded sampling, per-account profiles, BullMQ worker, account safety, dashboard | Implemented |
| **Phase 3** — Visibility analytics | Mention rates, domain/article aggregation, self-contained HTML report | Implemented |
| **Experimental** — Network/SSE provenance | Search queries + retrieved candidates, kept separate from visible citations | Implemented; opt-in, needs current real-account validation |
| **Experimental** — Retrieval -> citation analytics | Exact candidate/citation overlap, conversion reports, descriptive factor analysis | Implemented; quality depends on validated network evidence |
| Beyond | Multivariable estimated-citation models, other providers | Not started deliberately |

"Implemented" means the code exists and testable logic is covered offline where possible. It does
**not** mean every browser-facing behaviour has been re-verified against the current Doubao build.

## What OneGl does

- launches Doubao with **Camoufox + Playwright Core** by default;
- waits for manual first login and stores Playwright `storageState` locally per account;
- runs every prompt in a confirmed fresh conversation and fails closed if isolation cannot be
  proven;
- verifies prompt text before sending;
- captures the final answer while excluding the user's own message bubble;
- extracts DOM-visible citations with title / URL / domain / order;
- parses the visible `搜索 N 个关键词，参考 M 篇资料` signal and marks a run `partial` when the
  final visible-source count cannot be reconciled;
- optionally captures passive Network/SSE provenance: generated search queries and retrieved
  candidate sources;
- persists answers, visible citations, search queries and retrieved candidates in the same
  PostgreSQL transaction when database persistence is enabled;
- marks a retrieved candidate as finally cited only when its canonical URL exactly matches a
  DOM-visible citation in the same run;
- reports retrieval -> citation conversion by run/domain;
- performs descriptive citation-factor analysis with sample counts, uplift and Wilson 95% rate
  intervals;
- supports reproducible seeded sampling, per-account queues, cooldowns, daily limits and batch
  reports.

OneGl does **not** claim access to model training data, hidden model reads, proprietary reranker
weights or Doubao's internal citation formula.

## Requirements

- Node.js 20+
- pnpm/npm
- Python 3.10+
- Camoufox runtime

Install JavaScript dependencies:

```bash
npm install
```

Install Camoufox using the same package/channel approach documented by upstream OneGlanse:

```bash
python3 -m pip install 'cloverlabs-camoufox[geoip]'
python3 -m camoufox set official/stable
python3 -m camoufox fetch
```

If your Python command is not `python3`, copy `.env.example` to `.env` and set
`ONEGL_CAMOUFOX_PYTHON`.

## 1. Manual login

```bash
npm run auth
```

A headful Doubao window opens. Complete login manually. OneGl stores the resulting browser state
under `.onegl/auth/`. Do not commit these files or share session material.

## 2. Run one prompt

```bash
npm run run -- --project "新能源汽车监控" --prompt "2026年中国市场值得关注的新能源汽车品牌有哪些？请结合公开资料说明。"
```

Possible statuses:

- `success` — answer captured and visible-citation evidence is internally consistent;
- `partial` — answer captured but citation extraction conflicts with visible UI evidence;
- `failed` — login, verification, submission, answer, network, rate-limit, page or conversation
  isolation failed.

A run that cannot confirm a fresh conversation fails **before** sending the prompt with
`DOUBAO_CONVERSATION_RESET_FAILED`.

## 3. Experimental Network / SSE evidence

Enable only on an account/environment you are authorised to test:

```bash
ONEGL_NETWORK_EVIDENCE=true npm run run -- --project "新能源汽车监控" --prompt "20万新能源SUV推荐"
```

When enabled, each attempt can add:

```text
network-evidence.json
```

The network observer is passive. Raw response bodies are parsed in memory but are not persisted;
saved response endpoints have query strings stripped. Candidate sources are represented as:

```json
{
  "sourceType": "retrieved",
  "capturedFrom": "NETWORK",
  "visibleToUser": false
}
```

A retrieved source remains different from a visible citation.

See [docs/NETWORK_EVIDENCE.md](docs/NETWORK_EVIDENCE.md).

## 4. Database + reproducible batches

Configure PostgreSQL with `DATABASE_URL`, then:

```bash
npm run db:migrate
```

Configure a project and keyword pool:

```bash
npm run project:init -- --file examples/project.xiaomi.json
npm run pool:list -- --project "小米汽车"
```

Create and run a reproducible sample:

```bash
npm run sample -- --project "小米汽车" --size 100 --method stratified \
  --accounts account_01 [--seed 20260910-ab12] [--repeats 1]

ONEGL_NETWORK_EVIDENCE=true npm run batch:run -- --batch 1 [--delay-ms 6000]
```

For background execution with Redis:

```bash
npm run worker
npm run batch:start -- --batch 1
```

## 5. Reports

### Visibility report

```bash
npm run report -- --batch 1
```

### Retrieval -> citation report

```bash
npm run report:retrieval -- --batch 1
```

This reports retrieved candidate counts, exact candidate -> visible-citation matches, overall
conversion rate, per-domain conversion and per-run query/candidate/match counts.

See [docs/RETRIEVAL_ANALYTICS.md](docs/RETRIEVAL_ANALYTICS.md).

### Citation factor analysis

```bash
npm run report:factors -- --batch 1
```

Optional:

```bash
npm run report:factors -- --batch 1 --min-n 10 --signal-min-n 20
npm run report:factors -- --batch 1 --json > factor-report.json
```

The v1 factor report uses only observable evidence and currently evaluates:

- candidate position bucket;
- title <-> original prompt lexical overlap;
- title <-> observed generated-query lexical overlap;
- summary <-> prompt lexical overlap;
- title / summary / source-name presence;
- search-query count bucket;
- repeated retrieval frequency of the same article within the analyzed batch.

For every retained factor bucket it reports sample size, exact citation rate, uplift relative to
the batch baseline, and a Wilson 95% interval. These are **descriptive associations**, not causal
GEO rules or internal Doubao weights.

See [docs/CITATION_FACTOR_ANALYSIS.md](docs/CITATION_FACTOR_ANALYSIS.md).

### Client-facing HTML report

```bash
npm run report:export -- 1 "$TEMP/batch1.json"
npm run report:html -- "$TEMP/batch1.json" "reports/batch1.html" \
  [--profile local/report-profile.<client>.json]
```

The generic renderer is client-neutral. Client-specific wording and monitored own domains belong
in a gitignored profile under `local/`.

## Source truth semantics

A visible citation requires DOM evidence:

```json
{
  "sourceType": "visible",
  "capturedFrom": "DOM",
  "visibleToUser": true
}
```

Retrieved candidates are stored separately in `retrieved_sources`; observed search queries are
stored in `run_search_queries`. They are not inserted as visible citation rows.

A retrieved candidate receives a relation to a final citation only when:

```text
same run
AND candidate canonical_url == DOM-visible citation canonical_url
```

The stored method is:

```text
canonical_url_exact
```

No title similarity, domain-only matching, embedding similarity or LLM judgement is used to make
that exact relation look more complete.

If Doubao says `参考 5 篇资料` but OneGl can only obtain 3 unique visible URLs, the run is `partial`
with `CITATION_PARSE_FAILED`. Factor analysis excludes such runs so incomplete citation capture
does not turn valid retrieved candidates into false negatives.

## Audit artifacts

Each run keeps `run.json` and attempt-specific evidence:

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
      network-evidence.json   # when network evidence is enabled
```

Retries use a new attempt directory and do not overwrite previous evidence.

## Validation status

Offline:

```bash
npm test
```

The suite covers core state/queue logic, conversation-reset fail-closed logic, citation extraction
fixtures, Network/SSE parsing, retrieval normalization/exact matching and citation-factor analysis
primitives.

Still requiring authorised real-account validation:

- current Doubao DOM selectors and answer completion behaviour;
- citation expander/count reconciliation;
- real session expiry / verification / rate-limit behaviour;
- current Network/SSE endpoint and payload shape;
- whether observed search queries and candidate URLs still correspond to the intended retrieval
  layer on current Doubao Web;
- whether enabling passive network evidence changes any visible answer/citation behaviour.

Until that validation is repeated, network-derived analytics should be treated as experimental.

See [docs/PHASE0_VALIDATION.md](docs/PHASE0_VALIDATION.md),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/MVP_STATUS.md](docs/MVP_STATUS.md),
[docs/NETWORK_EVIDENCE.md](docs/NETWORK_EVIDENCE.md),
[docs/RETRIEVAL_ANALYTICS.md](docs/RETRIEVAL_ANALYTICS.md), and
[docs/CITATION_FACTOR_ANALYSIS.md](docs/CITATION_FACTOR_ANALYSIS.md).

## Browser fallback

Camoufox is the default. For troubleshooting only:

```bash
ONEGL_BROWSER=chromium ONEGL_BROWSER_EXECUTABLE=/path/to/chrome npm run run -- --prompt "..."
```

Do not treat a fallback browser working as evidence that production collection should abandon
Camoufox; verify behaviour with the intended account/browser setup.

## License and upstream

The project keeps the upstream OneGlanse MIT license and attribution. Additional providers remain
out of scope until the Doubao evidence chain is consistently validated.
