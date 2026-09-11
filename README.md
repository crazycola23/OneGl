# OneGl — Doubao AI Citation Intelligence

OneGl is a China-first GEO / AI Citation Intelligence tool built from the architectural ideas of
the open-source [OneGlanse](https://github.com/aryamantodkar/oneglanse) project. It supports
**Doubao Web only** and measures how a target brand appears in AI answers, and what those answers
cite:

```text
Prompt -> Doubao Web UI -> Answer -> Visible Citation -> Article
```

The guiding principle is **数据可信度 > 功能数量**: a run that cannot be trusted is recorded as a
failure rather than silently counted as data.

## Phase roadmap

| Phase | Scope | Status |
|---|---|---|
| **Phase 0** — Doubao capture validation | Browser capture of answer + DOM-visible citations, per-run evidence artifacts | Implemented; capture chain exercised against a real logged-in account |
| **Phase 1** — Persistent collection | PostgreSQL schema, SQL migrations, single-transaction run persistence, article dedup on canonical URL | Implemented |
| **Phase 2** — Batch / queue / operator workflow | Keyword pools, seeded stratified sampling, per-account browser profiles, BullMQ worker, account safety state, dashboard | Implemented |
| **Phase 3** — Analytics / client reporting | Batch mention-rate reports, domain aggregation, self-contained HTML client report | Implemented |
| Beyond | Network/SSE source capture, additional providers, scoring models | Not started, deliberately |

"Implemented" means the code exists and is covered by the offline test suite where the logic is
testable without a live account. It does **not** mean every browser-facing behaviour has been
re-verified online; see [Validation status](#validation-status).

## What OneGl does

- launches Doubao with **Camoufox + Playwright Core** by default;
- waits for a **manual first login**, then stores Playwright `storageState` per account under
  `.onegl/auth/accounts/`;
- runs every prompt in a **confirmed fresh conversation**: if the conversation cannot be proven
  empty, the prompt is **not sent** (`DOUBAO_CONVERSATION_RESET_FAILED`);
- sends a prompt only after verifying the text in the editor;
- captures the final answer by excluding the user's own bubble, which shares Doubao's
  `.md-box-root` renderer class;
- extracts **DOM-visible citations** and their title/URL/domain/order;
- parses Doubao's visible `搜索 N 个关键词，参考 M 篇资料` signal and fails closed when the
  captured count does not match `M`;
- persists everything into PostgreSQL in one transaction per run, deduplicating articles on
  canonical URL (100 citations of one article stay 1 article + 100 citations);
- samples from a keyword pool with a recorded seed and pool version, so a batch is reproducible;
- runs batches through a BullMQ worker with one queue per account (concurrency 1 per account) and
  an account safety layer that delays on temporary cooldown instead of dropping tasks;
- produces a self-contained HTML report per batch.

It does **not** claim model training data or hidden sources. Network search results are not
silently promoted to citations: `source_type = retrieved` exists in the schema for future
non-DOM capture, and must never be auto-promoted into a visible citation.

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

A headful Doubao window opens. Complete login manually. The runner detects a healthy chat page
and saves browser storage state to `.onegl/auth/doubao.storage.json`.

Do not commit this file and do not send cookies/session tokens to anyone.

## 2. Run one prompt

```bash
npm run run -- --project "新能源汽车监控" --prompt "2026年中国市场值得关注的新能源汽车品牌有哪些？请结合公开资料说明。"
```

A run is written under `.onegl/runs/run_.../`.

Possible statuses:

- `success` — answer captured; citation state is verified or there are no visible citations;
- `partial` — answer captured but citation extraction conflicts with visible UI evidence;
- `failed` — login, verification, submission, answer, rate-limit, network, page, or
  conversation-reset failure.

A run that cannot confirm a fresh conversation is recorded as `failed` with
`DOUBAO_CONVERSATION_RESET_FAILED` **before** the prompt is submitted. Its artifacts
(`screenshot.png`, `page.html`, `dom-observation.json`, `currentUrl`) are still written.

## 3. Batch prompts

```bash
npm run batch -- --file prompts.example.json --delay-ms 5000
```

Runs are sequential. Every prompt attempts a fresh conversation. Session-blocking failures stop
the batch instead of continuing with bad state.

## 4. Inspect locally

CLI summary:

```bash
npm run runs
```

Read-only verification dashboard:

```bash
npm run serve
```

Then open `http://127.0.0.1:3100`.

The Run Detail page is intentionally the first UI: it lets a human compare saved answer/source
data against the captured screenshot before we build scoring or trend analytics.

## 5. Visibility monitoring workflow

Requires `DATABASE_URL` (PostgreSQL). The database only listens on the database host's loopback
interface, so a collector running elsewhere reaches it through an SSH tunnel:

```bash
npm run db:tunnel     # forwards PostgreSQL and Redis; keep it running
npm run db:migrate    # create/update the schema from migrations/*.sql
```

Configure a project (target brand, alias rules, keyword pool, accounts, tracked articles):

```bash
npm run project:init -- --file examples/project.xiaomi.json
npm run pool:list    -- --project "小米汽车"
```

Draw a reproducible sample and run it:

```bash
npm run sample    -- --project "小米汽车" --size 100 --method stratified \
                     --accounts account_01 [--seed 20260910-ab12] [--repeats 1]
npm run batch:run -- --batch 1 [--delay-ms 6000]     # foreground, no Redis needed
npm run worker                                       # background worker (needs REDIS_URL)
npm run batch:start -- --batch 1                     # enqueue for the worker
npm run report    -- --batch 1
```

Client-facing report (self-contained HTML, no CDN or webfont dependency):

```bash
npm run report:export -- 1 "$TEMP/batch1.json"
npm run report:html   -- "$TEMP/batch1.json" "reports/batch1.html" \
                        [--profile local/report-profile.<client>.json]
```

The generic renderer in `tools/build-report-html.js` only depends on the batch snapshot. Client
specific wording, highlight terms, own domains, and conclusions belong in a profile file kept
under `local/` (gitignored), not in the renderer.

## Source semantics

A source is stored as visible only when it is confirmed in the rendered UI:

```json
{
  "sourceType": "visible",
  "capturedFrom": "DOM",
  "visibleToUser": true
}
```

`source_type` is enforced by the database (`visible` | `retrieved`, default `visible`). Current
DOM capture always writes `visible`. `retrieved` is reserved for future non-DOM capture and is
never promoted into a visible citation automatically.

`relation_status` (`matched` | `unresolved`) separately records whether an answer-to-citation
link was actually confirmed; the tool never fabricates that relation to make a database look
complete.

If Doubao says `参考 5 篇资料` but the extractor only obtains 3 unique visible URLs, the run is
`partial` with `CITATION_PARSE_FAILED`. It is not reported as a clean success. When the
UI-declared count is higher than the parsed count the cause is **not** confirmed — it may be
collapsed UI, a DOM change, or a gap in parsing — so citation-source statistics are reported as a
conservative floor rather than an exact figure.

See [docs/PHASE0_VALIDATION.md](docs/PHASE0_VALIDATION.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/MVP_STATUS.md](docs/MVP_STATUS.md).

## Validation status

What the repository can prove on its own, with no account and no network:

```bash
npm test        # offline logic tests + citation extractor replayed on real captured DOM
```

The suite covers the batch terminal-status rules, account availability classification, the
cooldown delay policy, account timezone day keys, the conversation-reset fail-closed gate
(driven by a mock page), retry attempt persistence, and the citation extractor replayed against
sanitized real DOM fixtures.

What requires an authorised real-account validation run (see
[docs/PHASE0_VALIDATION.md](docs/PHASE0_VALIDATION.md) for the protocol):

- Doubao DOM selector validity against the current live UI;
- prompt submission behaviour and answer-completion detection;
- citation expander behaviour and the true cause of expected/captured gaps;
- real platform behaviour for rate limits, verification, and session expiry;
- the fail-closed conversation-reset path end to end.

Those items are **not** claimed as verified. Items changed by the stabilization pass and still
awaiting a live run are marked `NEEDS_REAL_ACCOUNT_VALIDATION` in
[docs/MVP_STATUS.md](docs/MVP_STATUS.md).

Audit artifacts: every run keeps `run.json` plus per-attempt evidence under
`attempts/<n>/` (`screenshot.png`, `page.html`, `answer.md`, `citations.json`,
`dom-observation.json`). Retrying a run never overwrites an earlier attempt's evidence, and a
retry reuses the same Run record rather than creating a duplicate.
Citation-count mismatches remain failures; the validation tooling never changes the UI-declared
expected count to make a run pass.

The earlier Phase 0 protocol, metric definitions, failure taxonomy, session-expiry drill, and
merge-back gate are in [docs/PHASE0_VALIDATION.md](docs/PHASE0_VALIDATION.md).

## Browser fallback

Camoufox is the default. For troubleshooting only, you can point Playwright Core at a locally
installed browser:

```bash
ONEGL_BROWSER=chromium ONEGL_BROWSER_EXECUTABLE=/path/to/chrome npm run run -- --prompt "..."
```

A browser fallback is not evidence that production Doubao automation should abandon Camoufox;
we should make that decision only after real account/browser compatibility testing.

## License and upstream

The project keeps the upstream OneGlanse MIT license and attribution. A second provider is
explicitly out of scope until the Doubao data chain and its real-account validation are
consistently trustworthy.
