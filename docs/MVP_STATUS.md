# MVP status

## Phase model

| Phase | Scope | Status |
|---|---|---|
| **Phase 0** — Doubao capture validation | Browser capture of answer + DOM-visible citations, per-run evidence artifacts | Implemented |
| **Phase 1** — Persistent collection | PostgreSQL schema, SQL migrations, single-transaction run persistence, article dedup | Implemented |
| **Phase 2** — Batch / queue / operator workflow | Keyword pools, seeded sampling, per-account profiles, BullMQ worker, account safety, dashboard | Implemented |
| **Phase 3** — Analytics / client reporting | Batch mention-rate reports, domain aggregation, self-contained HTML report | Implemented |
| Beyond | Network/SSE capture, other providers, scoring models | Not started, deliberately |

"Implemented" means the code exists and its testable logic is covered by the offline suite. It
does not mean every browser-facing behaviour has been re-verified against the live Doubao UI.
Those are listed under [Awaiting real-account validation](#awaiting-real-account-validation).

## Phase 0 — Doubao capture validation

- Doubao Web entry at `https://www.doubao.com/chat/`.
- Camoufox-first Playwright browser launcher.
- Manual first login; `storageState` stored per account under `.onegl/auth/accounts/`.
- Session states: healthy, login required/expired, verification required, access restricted,
  unknown/page-changed.
- **Clean conversation enforced before every prompt.** A session that cannot be proven empty is
  never used: the prompt is not submitted and the run fails with
  `DOUBAO_CONVERSATION_RESET_FAILED`, keeping its artifacts.
- Prompt input verification and fail-closed submission confirmation (no blind auto-resubmit).
- Answer capture that excludes the user's own bubble (Doubao uses the same `.md-box-root` class
  for both), with streaming/stability completion checks.
- DOM-visible source extraction from the Doubao `block_type:10025` reference block.
- Parsing and enforcement of the UI-declared `参考 M 篇资料` count.
- Reference overlay fallback for sources hidden behind a UI expander.
- Conservative URL canonicalization that removes tracking parameters but preserves generic
  `source`/`ref` parameters.
- Per-attempt evidence: `screenshot.png`, `page.html`, `answer.md`, `citations.json`,
  `dom-observation.json`, plus `run.json`.

## Phase 1 — Persistent collection

- PostgreSQL schema: `projects`, `prompts`, `runs`, `articles`, `citations`,
  `schema_migrations`.
- Plain numbered SQL migrations applied by `src/db/migrate.js` with a checksum ledger; no ORM.
- One transaction per run: Project/Prompt upsert, Run upsert, Article upsert, Citation upsert.
  A run can never end up with only half of its citations.
- Articles deduplicate on `canonical_url`; one article cited many times stays one row.
- `expected_citation_count` and `captured_citation_count` are both persisted, so the
  UI-declared vs captured signal survives in the database.
- `citations.source_type` (`visible` | `retrieved`, default `visible`), enforced by a check
  constraint. Current DOM capture always writes `visible`.
- `DATABASE_URL` is optional: without it the collector still runs artifact-only.

## Phase 2 — Batch / queue / operator workflow

- Keyword pools imported from JSON, with categories and a pool version.
- Seeded sampling (`random` or `stratified`); seed, method, pool version and the selected
  prompts are recorded, so a batch is reproducible.
- Per-account anonymous identifiers and per-account browser profiles; credentials never reach
  the database or the repository.
- BullMQ queues, one per account, concurrency 1 per account, so a single account is serial by
  construction and one blocked account cannot stall the others.
- Deterministic run identity (`run_token`, `job_id`, `attempt`) with a unique index, so a retried
  job rewrites the same Run instead of producing a duplicate.
- Per-attempt artifact directories: retries never overwrite an earlier attempt's evidence.
- Account safety: daily limit, consecutive-failure cooldown, pause/resume, and a distinction
  between **temporary** states (cooldown, rate limit, daily limit) which **delay** the task until
  recovery, and **permanent/manual** states (disabled, login required, session expired,
  verification required, access restricted, manual pause) which skip the task and stop hitting
  the account.
- The daily limit is computed in the account timezone (`ONEGL_ACCOUNT_TIMEZONE`, default
  `Asia/Shanghai`), not UTC and not the server's local timezone.
- Batch terminal status: `completed` only when real data was produced and nothing failed or was
  skipped; `partial` when successes are mixed with failures or skips, and also when **everything
  was skipped**; `failed` when nothing succeeded; `aborted` stays `aborted`.
- Read-only dashboard: runs, run detail, sources, projects, accounts, batch progress.

## Phase 3 — Analytics / client reporting

- Batch report: run-level and prompt-level mention rates kept separate, citation totals, unique
  articles/domains, per-category and per-account breakdowns, top domains and top articles.
- Self-contained HTML client report (`tools/build-report-html.js`) with no CDN or webfont
  dependency, so it opens offline.
- The generic renderer depends only on the batch snapshot. Client-specific wording, highlight
  terms, own-domain monitoring and conclusions live in an external profile under `local/`
  (gitignored), never in the renderer.

## Stabilization pass (data-reliability fixes)

| Fix | Behaviour now |
|---|---|
| Conversation reset | Fail closed before submit; new error code `DOUBAO_CONVERSATION_RESET_FAILED`; failure artifacts preserved |
| Batch terminal status | All-skipped is `partial`, never `completed`; `completed + failed + skipped` is consistent with `requested` |
| Retry attempt | Real `job.attemptsMade + 1` recorded on the Run and in PostgreSQL; one Run per `run_token` |
| Artifact evidence | `attempts/<n>/` per attempt; retries cannot overwrite an earlier failure's evidence |
| Cooldown | Temporary states delay the job until recovery (bounded number of waits); permanent states skip and stop |
| Citation source type | `source_type` column with `visible` / `retrieved`, default `visible` |
| Account daily limit | Account-timezone day key; also fixed `runs_today_date` comparison against pg's `date` type |
| Report | De-client-ified; expected/captured gap described as unconfirmed rather than attributed to a specific cause |

## Deliberately not implemented

- Network/SSE source capture as a production data source.
- Retrieved Source / Cited Source inference beyond UI evidence, and any automatic promotion of
  `retrieved` to a visible citation.
- Multi-provider support (Kimi, DeepSeek, Yuanbao, Qwen) and any provider-abstraction refactor.
- GEO, sentiment, recommendation, competitor, or brand scoring.
- Training-data claims.
- Prompt generation, payment, multi-tenant SaaS permissions.

## Awaiting real-account validation

The following were changed by the stabilization pass and are covered by offline tests only. They
must be re-verified with an authorised live account before being treated as proven:

- `NEEDS_REAL_ACCOUNT_VALIDATION` — conversation-reset detection against the live Doubao UI, and
  that a genuine fresh conversation still passes the new fail-closed gate.
- `NEEDS_REAL_ACCOUNT_VALIDATION` — session state judgement (healthy / login / verification /
  access restricted) after the change.
- `NEEDS_REAL_ACCOUNT_VALIDATION` — Doubao DOM selector validity, prompt submit behaviour, and
  answer completion detection.
- `NEEDS_REAL_ACCOUNT_VALIDATION` — citation expander behaviour and the real cause of
  expected/captured gaps.
- `NEEDS_REAL_ACCOUNT_VALIDATION` — real platform behaviour for rate limits, verification and
  session expiry, and therefore the cooldown delay policy's usefulness in practice.
- `NEEDS_REAL_ACCOUNT_VALIDATION` — queue retry behaviour end to end (attempt 2 writing into
  `attempts/2/` while `attempts/1/` survives).

## Known risks

- A run's mention-rate value depends on the conversation genuinely being fresh; the fail-closed
  gate reduces (but cannot fully prove) that risk.
- Citation-source statistics are a conservative floor whenever the UI declares more sources than
  were parsed.
- The 30-case Phase 0 suite has not been re-run as a whole against the current code.

## Validation gate before further feature work

Re-run the fixed prompt suite against an authorised account and confirm, per run:

1. answer present in UI vs answer captured;
2. visible reference count in UI vs `expectedCitationCount`;
3. source title/URL/order vs the expanded reference UI;
4. new-conversation isolation between consecutive prompts (and that no run was silently allowed
   through without a confirmed reset);
5. session-expiry and verification behaviour, including that a real cooldown delays rather than
   drops the task.

Feature work should not resume until these hold.
