# OneGl — Phase 0 Doubao Browser Spike

OneGl is a China-first GEO / AI Citation Intelligence experiment built from the architectural
ideas of the open-source [OneGlanse](https://github.com/aryamantodkar/oneglanse) project.
Phase 0 supports **Doubao Web only** and exists solely to prove a trustworthy capture chain:

```text
Prompt -> Doubao Web UI -> Answer -> Visible Citation -> Article
```

This repository currently contains the browser/data-verification core rather than the full
OneGlanse monorepo. The target repository was empty when this MVP slice started, so the first
commit intentionally keeps the surface small and testable instead of copying a large stack that
has not yet been validated against Doubao.

## What this Phase 0 spike does

- launches Doubao with **Camoufox + Playwright Core** by default;
- waits for a **manual first login**, then stores Playwright `storageState` locally;
- attempts a **new/clean conversation for every prompt**;
- sends a prompt only after verifying the text in the editor;
- captures the final answer, prioritizing Doubao's `.md-box-root` renderer;
- extracts **DOM-visible citations** and their title/URL/domain/order;
- parses Doubao's visible `搜索 N 个关键词，参考 M 篇资料` signal and fails closed when the
  captured count does not match `M`;
- records `run.json`, answer, citations, screenshot, HTML, URL, status, and error details;
- supports sequential batches and a small read-only Runs / Sources verification dashboard.

It does **not** claim model training data or hidden sources. Network search results are not
silently promoted to citations.

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
- `failed` — login, verification, submission, answer, rate-limit, network, or page failure.

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

## Source semantics

Phase 0 stores a source as visible only when it is confirmed in the rendered UI:

```json
{
  "sourceType": "visible",
  "capturedFrom": "DOM",
  "visibleToUser": true
}
```

If Doubao says `参考 5 篇资料` but the extractor only obtains 3 unique visible URLs, the run is
`partial` with `CITATION_PARSE_FAILED`. It is not reported as a clean success.

See [docs/PHASE0_VALIDATION.md](docs/PHASE0_VALIDATION.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/MVP_STATUS.md](docs/MVP_STATUS.md).

## Phase 0 real-account validation

The next task is **not** to add product infrastructure. Run the fixed 30-case suite against a real logged-in Doubao account:

```bash
npm run batch -- --file validation/phase0-prompts.json --delay-ms 8000
npm run validate:scaffold -- --project phase0-doubao-validation
# Fill .onegl/phase0-review.json while comparing the real Doubao UI and saved artifacts.
npm run validate:evaluate -- --file .onegl/phase0-review.json
```

Every run keeps the five primary audit artifacts (`screenshot.png`, `page.html`, `run.json`, `answer.md`, `citations.json`) and also writes `dom-observation.json` to record the DOM assumptions under test. Citation-count mismatches remain failures; the validation tooling never changes the UI-declared expected count to make a run pass.

The full protocol, metric definitions, failure taxonomy, session-expiry drill, and merge-back gate are in [docs/PHASE0_VALIDATION.md](docs/PHASE0_VALIDATION.md).

## Browser fallback

Camoufox is the default. For troubleshooting only, you can point Playwright Core at a locally
installed browser:

```bash
ONEGL_BROWSER=chromium ONEGL_BROWSER_EXECUTABLE=/path/to/chrome npm run run -- --prompt "..."
```

A browser fallback is not evidence that production Doubao automation should abandon Camoufox;
we should make that decision only after real account/browser compatibility testing.

## License and upstream

The project keeps the upstream OneGlanse MIT license and attribution. The intent is to merge this
validated Doubao core back into the full OneGlanse provider/queue architecture once the browser
spike passes real-account tests.
