# OneGl architecture

## Goal

OneGl measures how a target brand appears in Doubao's answers, and which sources Doubao cites,
by asking a reproducible sample of questions in independent fresh conversations:

```text
Keyword pool -> seeded sample -> per-account queue -> fresh conversation
  -> Doubao Web -> Answer -> brand detection -> visible citations
  -> article dedup -> PostgreSQL -> batch report
```

The browser UI is the source of truth for `visible_to_user`. We deliberately do not claim access
to model training data, hidden model reads, or sources merely because a network request happened.

The governing rule is **数据可信度 > 功能数量**: when a run cannot be trusted it is recorded as a
failure, and when a number cannot be confirmed it is reported as unconfirmed.

## Runtime topology

Three processes, all sharing one collector core (`src/collect/runner.js`):

| Process | Entry point | Role |
|---|---|---|
| Collector CLI | `src/cli.js` | `auth` / `run` / `batch`, project setup, sampling, reports |
| Worker | `src/worker.js` | Drains BullMQ queues, one per account |
| Web | `src/server.js` | Read-only dashboard plus batch start/stop |

- **Browser automation:** Playwright Core.
- **Default browser:** Camoufox, resolved through the same Python `camoufox.utils.launch_options`
  approach used by upstream OneGlanse. Its snake_case options are mapped to Playwright's
  camelCase keys explicitly; passing them through unchanged makes Playwright silently ignore the
  Camoufox executable.
- **Authentication:** first login is manual; Playwright `storageState` is persisted locally per
  account under `.onegl/auth/accounts/` and reused by later runs. Credentials never reach the
  database or the repository.
- **Queue:** BullMQ over Redis. One queue per account with concurrency 1, so a single account is
  serial by construction. `ONEGL_ACCOUNT_PARALLELISM` caps how many accounts run at once.
- **Database:** PostgreSQL, reached through migrations in `migrations/*.sql`.

## Prompt isolation and fail-closed

Every prompt must run in a conversation that is provably empty, because the quantity being
measured is `P(brand mentioned | prompt)` and not `P(brand mentioned | prompt + history)`.

- The runner clicks Doubao's 新对话 control (or reopens `/chat/`), then waits until no assistant
  message bubble remains.
- If emptiness cannot be confirmed within `DOUBAO_CONVERSATION_SETTLE_MS`, the prompt is **not
  submitted**. The run fails with `DOUBAO_CONVERSATION_RESET_FAILED` and keeps its screenshot,
  HTML snapshot, DOM observation and current URL.
- This is an execution-stage gate, not a reporting filter: excluding such runs later would still
  mean the prompt had been sent.

## Answer capture

Doubao renders the user's own message bubble with the same `.md-box-root` class it uses for
assistant answers, so a bare selector match mistakes the submitted prompt for the answer.
Candidates are filtered by walking up to six ancestors for the `justify-end` row that right-aligns
a user bubble. Completion is gated on the answer node's `data-streaming` attribute, because the
stop-generation button is not rendered on current Doubao builds.

## Citation truth model

Only DOM-confirmed visible sources are stored as citations:

- `source_type = visible` (persisted, check-constrained to `visible` | `retrieved`)
- `captured_from = DOM`
- `visible_to_user = true`

When Doubao renders a block identified by `block_type:10025`, the collector reads the UI signal
`搜索 N 个关键词，参考 M 篇资料`. `M` becomes an explicit expected citation count.

If fewer visible links are present, the collector tries to open the reference UI and reads the
visible reference overlay. If the final unique URL count still differs from `M`, the run is
**partial** with `CITATION_PARSE_FAILED`; it is not silently treated as a successful run.

When the UI-declared count exceeds the parsed count, **the cause is not determined**. It may be
collapsed UI, a DOM change, or a gap in parsing. Reports must therefore present citation-source
statistics as a conservative floor, not as an exact figure, and must not attribute the gap to a
specific cause.

`source_type = retrieved` is reserved for future non-DOM capture. A retrieved source must never be
auto-promoted into a visible citation. Whether an answer-to-citation link was actually confirmed
is expressed separately by `relation_status` (`matched` | `unresolved`); the tool never invents
that relation to make the data look complete.

## Storage: dual track

Structured business data goes to PostgreSQL; per-run debug artifacts stay on disk.

```text
.onegl/runs/<run_id>/
  run.json                  # current attempt, final status/answer/error, latest artifact path
  attempts/
    1/                      # attempt 1 evidence
      screenshot.png
      page.html
      answer.md
      citations.json
      dom-observation.json
    2/                      # attempt 2 evidence, attempt 1 untouched
      ...
```

A queued retry re-enters with the same deterministic `run_id` (`run_b<batch>_i<index>`) and the
same `run_token`. The Run record and `run.json` are reused; only the attempt directory is new. A
unique index on `runs.run_token` plus the local directory reuse together guarantee that one
assignment never produces two Runs and never loses the previous attempt's failure evidence.

## Error semantics

Session-blocking errors stop work on that account instead of hammering Doubao:

- `DOUBAO_LOGIN_REQUIRED`
- `DOUBAO_SESSION_EXPIRED`
- `DOUBAO_VERIFICATION_REQUIRED`
- `DOUBAO_ACCESS_RESTRICTED`

Other run errors include `DOUBAO_TIMEOUT`, `DOUBAO_SUBMISSION_FAILED`,
`DOUBAO_CONVERSATION_RESET_FAILED`, `ANSWER_NOT_FOUND`, `CITATION_PARSE_FAILED`, `PAGE_CHANGED`,
`RATE_LIMITED`, `NETWORK_ERROR`, and `UNKNOWN_ERROR`.

Account availability is classified into two kinds, and the worker acts differently on each:

| Kind | Examples | Action |
|---|---|---|
| temporary | cooldown, rate-limit cooldown, daily limit reached | delay the job until the recovery time; does not consume retry attempts, bounded by a maximum number of waits |
| permanent / manual | disabled, login required, session expired, verification required, access restricted, manual pause | skip the assignment (counted in `skipped_jobs`) and stop hitting that account |

The daily limit is evaluated against the account timezone's calendar day
(`ONEGL_ACCOUNT_TIMEZONE`, default `Asia/Shanghai`), never UTC and never the server's local zone.

## Batch state machine

Counts are kept consistent with `requested_jobs`: `completed_jobs + failed_jobs + skipped_jobs`
never exceeds it, and at terminal time equals "how many assignments have a conclusion".

| Situation | Terminal status |
|---|---|
| real data produced, nothing failed or skipped | `completed` |
| successes mixed with failures and/or skips | `partial` |
| everything skipped, nothing produced | `partial` (never `completed`) |
| nothing succeeded | `failed` |
| manually stopped | `aborted` |

## Reporting

`tools/export-batch.js` dumps a batch snapshot; `tools/build-report-html.js` renders it into a
single self-contained HTML file (no CDN, no webfont, works offline). The renderer is generic and
depends only on the snapshot plus an optional profile. Client-specific wording, highlight terms,
own-domain monitoring and conclusions live in a profile under `local/`, which is gitignored.

## Next integration step

Remaining work is validation, not new surface area. The immediate step is an authorised
real-account run of the fixed prompt suite to re-verify the items listed as
`NEEDS_REAL_ACCOUNT_VALIDATION` in [MVP_STATUS.md](MVP_STATUS.md). A Doubao SSE/network collector
can only be added later as provenance-aware `retrieved` evidence — never as an automatic
replacement for DOM-visible citations, and never as a second provider abstraction.
