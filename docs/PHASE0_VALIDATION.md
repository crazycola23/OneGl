# Phase 0 — Real Doubao Validation Protocol

This repository is **only a Doubao browser/citation spike**. It is not the final OneGl architecture.
Do not add PostgreSQL, ClickHouse, Redis, BullMQ, GEO scoring, multi-provider support, or a larger
product dashboard until the capture chain below has been validated against a real logged-in Doubao
account:

```text
Prompt -> clean/new conversation -> complete visible Answer -> Visible Citation -> Article
```

## Ground-truth rule

The real Doubao UI is the ground truth for this phase.

- `screenshot.png`, `page.html`, `run.json`, `answer.md`, and `citations.json` must exist for every run.
- `dom-observation.json` is extra diagnostic evidence and records the DOM assumptions used by the spike.
- Network/SSE source data may be inspected later, but it must **never** be promoted to Visible Citation
  merely because it appeared in a response payload.
- Never rewrite `expectedCitationCount` to match what the extractor happened to capture.
- If the UI declares `参考 M 篇资料` and the extractor captures a different number, the sample is a failure.

## 30-prompt suite

Run `validation/phase0-prompts.json`. The cases intentionally overlap because a single Doubao answer
can exercise more than one behavior.

| Cases | Primary target |
|---|---|
| P01–P06 | Explicit web search with multiple visible citations |
| P07–P10 | Low citation count, ideally 1–2 visible citations |
| P11–P14 | No-search / no-visible-citation behavior |
| P15–P18 | Many visible citations and source-list completeness |
| P19–P22 | Inline citation / Answer↔Citation relation |
| P23–P24 | Reference UI that may need expansion |
| P25–P26 | Long answers / long generation time |
| P27–P30 | Sequential conversation isolation with leak sentinels |

The requested behavior is a test stimulus, not ground truth. If Doubao chooses a different citation
count than the prompt suggests, record what the UI actually shows. Do not force the observation to
match the target scenario.

## Execution procedure

1. Install the runtime and complete `npm run auth` in a headful browser.
2. Confirm the account is visibly logged in.
3. Run the suite sequentially. Do not parallelize it.

```bash
npm run batch -- --file validation/phase0-prompts.json --delay-ms 8000
```

A modest delay reduces accidental rate limiting. Do not reduce the delay just to make the test finish
faster; rate-limit behavior is itself evidence when it occurs naturally.

4. After the batch, create the human-review worksheet:

```bash
npm run validate:scaffold -- --project phase0-doubao-validation
```

This creates `.onegl/phase0-review.json`.

5. For every run, compare the real browser UI with these artifacts side by side:

```text
screenshot.png
page.html
run.json
answer.md
citations.json
dom-observation.json
```

6. Fill the `ui` object in `.onegl/phase0-review.json`.
7. Calculate the metrics:

```bash
npm run validate:evaluate -- --file .onegl/phase0-review.json
```

The evaluator writes `.onegl/phase0-report.json` and `.onegl/phase0-report.md`.

## Human review fields

For each run:

- `answerMatches`: `true` only when `answer.md` matches the complete visible Doubao answer. Missing
  tail paragraphs, duplicated text, thinking text mixed into the answer, or stale text from another
  turn means `false`.
- `visibleCitationCount`: count only sources that are visible from the Doubao answer UI. If a collapsed
  “参考资料” control must be expanded to see them all, expand it first.
- `citations`: enter the visible source rows in exact UI order. Record the visible title and the actual
  clickable link target. Do not use a URL found only in Network/SSE as ground truth.
- `relationMatches`: set `true` or `false` only if the UI makes the Answer↔Citation relation observable
  (for example an inline marker/link tied to a sentence). Leave it `null` when the UI does not expose a
  relation. Do not infer relation from semantic similarity.
- `conversationIsolated`: `true` only when the active conversation is clean and does not retain previous
  prompt/answer context.
- `failureClass`: optional manual classification when the automated diagnostic is insufficient.

Missing manual fields are excluded from metric denominators and are never counted as passes.

## Metrics

The validation report calculates:

1. **Answer Capture Accuracy** — reviewed runs whose complete captured answer matches the UI.
2. **Visible Citation Count Accuracy** — reviewed runs whose captured visible citation count exactly
   matches the UI count.
3. **Citation Title Accuracy** — exact title matches at reviewed citation positions after whitespace
   normalization only.
4. **Citation URL Accuracy** — exact visible link-target matches at reviewed citation positions.
5. **Citation Order Accuracy** — runs whose complete visible source sequence matches the UI sequence.
6. **Citation Position Accuracy** — per-source positional accuracy; reported as a diagnostic companion
   to the run-level order metric.
7. **Answer ↔ Citation Relation Accuracy** — manually observable relations judged correct.
8. **Conversation Isolation Success Rate** — reviewed runs that are visibly isolated.

## Exit gate

Do not graduate from Phase 0 merely because the runner “usually works.” The working target is:

- Answer Capture Accuracy: **>= 95%** on answer-bearing samples.
- Visible Citation Count Accuracy: **100%** on reviewed source-bearing and zero-source samples.
- Citation Title Accuracy: **100%** on reviewed visible sources.
- Citation URL Accuracy: **100%** on reviewed visible sources.
- Citation Order Accuracy: **100%** on reviewed source-bearing runs.
- Answer↔Citation Relation Accuracy: **100% of relations that are actually observable in the UI**.
- Conversation Isolation Success Rate: **100%** for the sequential isolation cases.

Any citation mismatch remains a bug to investigate, not a threshold to relax.

## DOM evidence recorded per run

`dom-observation.json` records the assumptions currently under test rather than silently treating them
as facts:

- match counts for `.md-box-root`, `[class*="md-box-root"]`, message test IDs, and `.flow-markdown-body`;
- the latest visible answer node metadata and a bounded `outerHTML` sample;
- visible `[data-plugin-identifier*="block_type:10025"]` blocks;
- whether each source block matches `搜索 N 个关键词，参考 M 篇资料`;
- visible external links inside each source block;
- candidate controls that might expand the reference list;
- visible reference/dialog/popover overlays and their links;
- inline external links and nearby answer text;
- visible user-message candidates and prompt echo count;
- `_ROUTER_DATA...is_login` when available, captcha/login/access-limit signals, generation state, and
  visible textbox count.

When a sample fails, inspect this file together with `page.html` before changing selectors.

## Failure taxonomy

Use these categories when reviewing failures:

- `ANSWER_ROOT_NOT_FOUND`
- `ANSWER_INCOMPLETE_OR_EARLY_STABLE`
- `ANSWER_STALE_OR_WRONG_TURN`
- `SOURCE_BLOCK_NOT_FOUND`
- `REFERENCE_COUNT_SIGNAL_MISSING`
- `REFERENCE_COUNT_MISMATCH`
- `REFERENCE_EXPAND_TRIGGER_NOT_FOUND`
- `REFERENCE_OVERLAY_AMBIGUOUS`
- `CITATION_TITLE_MISMATCH`
- `CITATION_URL_MISMATCH`
- `CITATION_ORDER_MISMATCH`
- `INLINE_RELATION_MISSING_OR_WRONG`
- `CONVERSATION_ISOLATION_FAILED`
- `SESSION_FALSE_HEALTHY`
- `DOUBAO_LOGIN_REQUIRED`
- `DOUBAO_SESSION_EXPIRED`
- `DOUBAO_VERIFICATION_REQUIRED`
- `DOUBAO_ACCESS_RESTRICTED`
- `RATE_LIMITED`
- `NETWORK_ERROR`
- `PAGE_CHANGED`
- `UNKNOWN`

## Session and abnormal-state drills

Do these separately from the 30 normal prompt cases.

### Saved session expiration

1. Complete a normal authenticated run.
2. Log out of Doubao manually in the same browser/account.
3. Close the browser so the invalid state is persisted only if that is what the test intends to prove.
4. Run one harmless prompt and verify the runner does not continue as a healthy authenticated session.
5. Save the failed run artifacts and classify whether it is `SESSION_EXPIRED`, `LOGIN_REQUIRED`, or a
   false-healthy bug.

The current spike intentionally records `_ROUTER_DATA.is_login`, login UI, and textbox evidence because
`textbox visible` may be an unsafe health fallback if Doubao allows anonymous chat. Tighten this only
after the real account evidence is known.

### Verification / captcha / access restriction

Do not intentionally hammer the service or attempt to bypass anti-bot controls. If a real captcha,
verification challenge, access restriction, or rate limit appears during the suite:

1. stop the batch;
2. preserve the run artifacts;
3. record the exact visible UI text and DOM structure;
4. verify the error code is correct;
5. do not auto-retry the blocked session as if it were a normal extraction failure.

## Network/SSE rule

External research suggests Doubao Web can expose structured search result data in streaming responses,
but this Phase 0 protocol does not use it as visible-source truth. If a later diagnostic patch records
SSE data, it must be stored under a separate provenance such as `NETWORK_OBSERVATION` and compared
against DOM/UI evidence only after the DOM accuracy work is complete.

## After Phase 0

When the real-account report is complete, produce a failure analysis before adding product features.
Then re-evaluate how to merge the validated Doubao provider/extraction logic back into upstream
OneGlanse (`aryamantodkar/oneglanse`). Do **not** keep expanding this small CLI into an independent
replacement architecture.
