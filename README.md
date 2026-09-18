# OneGl — Doubao GEO / AI Citation Intelligence

OneGl is a China-first, evidence-first GEO / AI Citation Intelligence system for measuring how brands, answers, and sources appear in Doubao Web.

It can be used in two ways:

- as a local/operator CLI for authenticated Doubao collection and analysis;
- as a backend service for a SaaS product through a versioned /v1 API, PostgreSQL, BullMQ/Redis workers, signed webhooks, and an OpenAPI 3.1 contract.

The current executable provider is **Doubao Web**. Other providers are intentionally not presented as supported until their evidence chains are implemented and validated.

> **Trust boundary:** OneGl treats DOM-visible citations as visible citations. Passive Network/SSE observations are stored separately as retrieval provenance and are never silently promoted into user-visible citations.

## Why OneGl

OneGl is designed around one principle:

**数据可信度 > 功能数量**

The system is built to answer practical GEO questions without pretending to know hidden model internals:

- Was a brand mentioned?
- Which sources were visibly cited?
- Which search queries and retrieved candidates were observable?
- Which retrieved candidates became visible citations by exact canonical-URL match?
- How did visibility and citation behaviour change across repeated executions?
- Can a product backend run those measurements safely through a stable API?

OneGl does **not** claim access to Doubao training data, private model reads, hidden reranker weights, or an internal citation formula.

## Current scope

| Area | Status |
| --- | --- |
| Doubao answer + DOM-visible citation capture | Implemented |
| PostgreSQL persistence and migrations | Implemented |
| Reproducible sampling, batches, BullMQ workers, account safety | Implemented |
| Visibility and citation analytics | Implemented |
| SaaS Task → Execution → Result → Report API | Implemented |
| Recurring schedules and account-connect sessions | Implemented |
| Signed durable webhooks | Implemented |
| OpenAPI 3.1 contract + generated TypeScript declarations | Implemented |
| Readiness, audit, metrics hooks and SLO tooling | Implemented |
| Passive Network/SSE provenance | Experimental; opt-in |
| Retrieval → citation factor analysis | Experimental; depends on validated network evidence |
| Additional AI providers | Not yet supported |

“Implemented” means the code path exists and is covered offline/in CI where practical. Browser-facing behaviour still depends on the current Doubao Web UI and should be revalidated with an authorised real account when selectors, login flows, or network payloads change.

## Architecture

~~~text
Customer / operator
        |
        +----------------------------+
        |                            |
        v                            v
 Local CLI / Admin             Product backend
        |                            |
        |                            | HTTPS + tenant API key
        |                            v
        |                     OneGl Service API
        |                       /v1 + OpenAPI
        |                            |
        +-------------+--------------+----------------+
                      |                               |
                      v                               v
                 PostgreSQL                     BullMQ / Redis
                                                      |
                                                      v
                                                OneGl Worker
                                                      |
                                                      v
                                                Doubao Web
                                                      |
                      +-------------------------------+
                      |
                      v
             evidence + results + reports
                      |
                      +--> signed webhook worker
                      +--> monitor worker
                      +--> alert / SLO tooling
~~~

The public SaaS model is intentionally separate from internal queue and browser details:

~~~text
Task
  ├─ Execution
  │    ├─ Result
  │    └─ Report
  └─ Schedule
~~~

A SaaS integration should persist OneGl public IDs such as task_id, execution_id, result_id, report_id, and schedule_id instead of depending on internal PostgreSQL IDs, BullMQ job IDs, browser cookies, or storageState.

## Requirements

For local collection:

- Node.js 20+
- npm or pnpm
- Python 3.10+
- Camoufox runtime, or a supported local browser for troubleshooting

For persistent/service operation:

- PostgreSQL
- Redis for BullMQ-backed background execution
- long random service secrets
- a TLS/private-network boundary for cross-host API deployment

Install JavaScript dependencies:

~~~bash
npm install
~~~

Copy the environment template:

~~~bash
cp .env.example .env
~~~

Install Camoufox:

~~~bash
python3 -m pip install 'cloverlabs-camoufox[geoip]'
python3 -m camoufox set official/stable
python3 -m camoufox fetch
~~~

If your Python command is not python3, configure ONEGL_CAMOUFOX_PYTHON in .env.

## Quick start: local/operator workflow

### 1. Authenticate a Doubao account

~~~bash
npm run auth
~~~

A headful Doubao window opens. Complete login manually. OneGl stores the resulting browser state under .onegl/auth/.

Do not commit or share authentication state.

### 2. Run one prompt

~~~bash
npm run run --   --project "新能源汽车监控"   --prompt "2026年中国市场值得关注的新能源汽车品牌有哪些？请结合公开资料说明。"
~~~

Typical run statuses:

- **success** — answer captured and visible-citation evidence is internally consistent;
- **partial** — answer captured but evidence is incomplete or citation reconciliation failed;
- **failed** — login, verification, submission, answer capture, rate limit, page state, or conversation isolation failed.

OneGl fails closed if it cannot confirm a fresh conversation before sending a prompt.

### 3. Optional: persist and run reproducible batches

Configure DATABASE_URL, then:

~~~bash
npm run db:migrate
npm run project:init -- --file examples/project.xiaomi.json
npm run pool:list -- --project "小米汽车"
~~~

Create a reproducible sample:

~~~bash
npm run sample --   --project "小米汽车"   --size 100   --method stratified   --accounts account_01
~~~

Run it directly:

~~~bash
npm run batch:run -- --batch 1
~~~

Or use Redis/BullMQ background execution:

~~~bash
npm run worker
npm run batch:start -- --batch 1
~~~

## Quick start: service / SaaS backend

OneGl can run behind another product. The product owns end-user login, product UI, billing, and permissions; OneGl owns provider-account state, browser execution, evidence, progress, results, reports, and delivery events.

Minimum service configuration includes:

~~~text
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
ONEGL_API_KEY=<long-random-master-secret>
ONEGL_WEBHOOK_SIGNING_KEY=<different-long-random-secret>
ONEGL_API_HOST=127.0.0.1
ONEGL_API_PORT=3200
~~~

Production mode additionally requires the safety settings documented in .env.example, including encrypted browser storage state.

Apply migrations:

~~~bash
npm run db:migrate
~~~

Run the processes in separate service/process slots:

~~~bash
npm run api:serve
npm run worker
npm run webhook:worker
~~~

Optional operational workers:

~~~bash
npm run monitor:worker
npm run alert:worker
~~~

The internal/admin console is separate:

~~~bash
npm run serve
~~~

By default the service API listens on port 3200 and the internal/admin console on port 3100. For cross-host deployment, place the API behind TLS or a private network rather than exposing a plaintext service port directly to the public Internet.

## SaaS API model

The preferred product integration surface is the Task API.

Typical flow:

~~~text
GET /v1/accounts
      |
      v
connect/login provider account if needed
      |
      v
POST /v1/tasks
      |
      v
POST /v1/tasks/{task_id}/executions
      |
      v
GET /v1/executions/{execution_id}
      |
      +--> GET /v1/executions/{execution_id}/results
      |
      +--> GET /v1/reports/{report_id}
~~~

Recurring monitoring uses schedules under the same Task model.

Create-style SaaS routes support Idempotency-Key where documented so product backends can safely retry ambiguous network outcomes without accidentally creating duplicate resources.

The service also supports cursor pagination for large history collections and signed webhook events such as:

~~~text
execution.completed
execution.partial
execution.failed
execution.cancelled
account.action_required
account.ready
~~~

See:

- [SaaS Task API](docs/SAAS_TASK_API.md)
- [SaaS Production Contract](docs/SAAS_PRODUCTION_CONTRACT.md)
- [Service API architecture](docs/OPENAPI_SERVICE_PLAN.md)

## OpenAPI contract

OneGl exposes a hardened OpenAPI 3.1 contract.

Machine-readable artifacts:

- [openapi.json](openapi.json) — committed static contract;
- [generated/openapi.d.ts](generated/openapi.d.ts) — generated TypeScript declarations;
- GET /openapi.json — runtime contract served by the API.

The deterministic contract builder is src/api/build-openapi.js. Runtime output, the committed JSON document, generated TypeScript types, tests, and CI all derive from that builder.

Useful commands:

~~~bash
npm run openapi:build
npm run openapi:lint
npm run openapi:types
npm run openapi:typecheck
npm run openapi:check
~~~

The OpenAPI quality gate checks deterministic generation, Redocly validation, generated TypeScript declarations, request/response coverage, PATCH contracts, runtime/static parity, and generated-file drift.

Pull requests also run an oasdiff breaking-change gate against the target branch once a baseline contract exists.

See [OpenAPI Contract Hardening](docs/OPENAPI_CONTRACT_HARDENING.md).

## Readiness and operations

The service exposes a readiness contract at:

~~~http
GET /readyz
~~~

It returns a success response when required dependencies are ready and a 503 response when the service should not receive production traffic.

Operational tooling includes:

~~~bash
npm run runtime:check
npm run audit:list
npm run ops:summary
npm run slo:check
~~~

An optional Prometheus-compatible metrics endpoint can be enabled with ONEGL_METRICS_TOKEN.

The alert worker reports aggregate operational state only; prompts, answers, cookies, and API credentials are not included in alert payloads.

## Webhook security

Webhook delivery is HMAC-SHA256 signed.

Important headers include:

~~~text
X-OneGl-Event
X-OneGl-Event-Id
X-OneGl-Webhook-Version: 1
X-OneGl-Timestamp
X-OneGl-Signature: v1=<hex HMAC-SHA256>
~~~

The signed input is:

~~~text
<timestamp>.<raw request body>
~~~

Consumers should:

- verify the signature against the raw request body;
- reject stale timestamps;
- deduplicate side effects by X-OneGl-Event-Id;
- assume delivery is at-least-once and may be retried.

Webhook endpoint secrets are backend credentials and must never be exposed to browser/mobile clients.

## Evidence semantics

Visible citations require DOM evidence.

Example:

~~~json
{
  "sourceType": "visible",
  "capturedFrom": "DOM",
  "visibleToUser": true
}
~~~

Retrieved candidates are a different evidence class:

~~~json
{
  "sourceType": "retrieved",
  "capturedFrom": "NETWORK",
  "visibleToUser": false
}
~~~

A retrieved candidate becomes related to a final citation only when its canonical URL exactly matches a DOM-visible citation from the same run.

~~~text
same run
AND candidate canonical_url == DOM-visible citation canonical_url
~~~

The stored relation method is:

~~~text
canonical_url_exact
~~~

OneGl does not use title similarity, domain-only matching, embeddings, or LLM judgement to make that exact relation appear more complete.

If Doubao visibly reports more referenced materials than OneGl can reconcile into unique visible URLs, the run is marked partial rather than silently treating incomplete capture as complete evidence.

## Experimental Network / SSE provenance

Network evidence is opt-in:

~~~bash
ONEGL_NETWORK_EVIDENCE=true npm run run --   --project "新能源汽车监控"   --prompt "20万新能源SUV推荐"
~~~

When enabled, OneGl may observe generated search queries and retrieved candidate sources from passive Network/SSE traffic.

Raw response bodies are parsed in memory and are not persisted as visible citations.

Network-derived analytics should remain experimental until the current Doubao Web endpoint and payload behaviour has been revalidated with an authorised account.

See:

- [Network Evidence](docs/NETWORK_EVIDENCE.md)
- [Retrieval Analytics](docs/RETRIEVAL_ANALYTICS.md)
- [Citation Factor Analysis](docs/CITATION_FACTOR_ANALYSIS.md)

## Reports

Visibility report:

~~~bash
npm run report -- --batch 1
~~~

Retrieval → citation report:

~~~bash
npm run report:retrieval -- --batch 1
~~~

Citation-factor analysis:

~~~bash
npm run report:factors -- --batch 1
~~~

Client-facing HTML report:

~~~bash
npm run report:export -- 1 "$TEMP/batch1.json"

npm run report:html --   "$TEMP/batch1.json"   "reports/batch1.html"
~~~

The citation-factor report describes observed associations with sample counts, uplift, and Wilson 95% rate intervals. It should not be interpreted as a causal model of Doubao's internal ranking or citation logic.

## Audit artifacts

Local runs keep evidence under .onegl/runs:

~~~text
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
~~~

Retries use separate attempt directories and do not overwrite prior evidence.

## Safety model

OneGl intentionally does not expose general-purpose browser-control endpoints such as arbitrary navigation, arbitrary typing/clicking, cookie extraction, storageState download, or verification bypass.

Execution continues to use conservative provider controls including:

- per-account serialization;
- minimum delays;
- hourly/daily limits;
- cooldowns;
- session/verification fail-closed behaviour;
- bounded retries;
- production storage-state encryption requirements.

These defaults are OneGl safety guardrails, not claims about official Doubao platform limits.

## Validation

Run the full test suite:

~~~bash
npm test
~~~

Run the OpenAPI contract gate:

~~~bash
npm run openapi:check
~~~

The repository CI also exercises database migrations and service-platform, GEO, monitoring, SaaS, dashboard, readiness, observability, SLO, browser, and runtime integration paths.

Still requiring periodic authorised real-account revalidation:

- current Doubao DOM selectors and answer-completion behaviour;
- citation expander/count reconciliation;
- real session-expiry, verification, and rate-limit behaviour;
- current Network/SSE endpoint and payload shape;
- whether observed network queries/candidates still represent the intended retrieval layer;
- whether passive network observation changes any visible answer/citation behaviour.

## Documentation

Start here depending on what you are working on:

- [Architecture](docs/ARCHITECTURE.md)
- [MVP / implementation status](docs/MVP_STATUS.md)
- [Phase 0 browser validation](docs/PHASE0_VALIDATION.md)
- [Service API architecture](docs/OPENAPI_SERVICE_PLAN.md)
- [SaaS Task API](docs/SAAS_TASK_API.md)
- [SaaS Production Contract](docs/SAAS_PRODUCTION_CONTRACT.md)
- [OpenAPI Contract Hardening](docs/OPENAPI_CONTRACT_HARDENING.md)
- [Network Evidence](docs/NETWORK_EVIDENCE.md)
- [Retrieval Analytics](docs/RETRIEVAL_ANALYTICS.md)
- [Citation Factor Analysis](docs/CITATION_FACTOR_ANALYSIS.md)

## Browser fallback

Camoufox remains the default collector path.

For troubleshooting only, a local Chromium-family browser can be configured:

~~~bash
ONEGL_BROWSER=chromium ONEGL_BROWSER_EXECUTABLE=/path/to/chrome npm run run -- --prompt "..."
~~~

A fallback browser working is not by itself evidence that production collection should abandon the intended browser/account setup.

## License and upstream

OneGl keeps the upstream [OneGlanse](https://github.com/aryamantodkar/oneglanse) MIT license and attribution.

The project currently focuses on making the Doubao evidence chain, service contract, and operational boundaries reliable before expanding to additional providers.
