# OneGl observability and API controls

This layer is for operating OneGl after a SaaS starts sending real traffic. It does not change Doubao collection behavior and it does not log prompt/answer bodies.

## Request IDs

Every request that enters the production API entrypoint receives:

```text
X-OneGl-Request-Id: req_<32 hex characters>
```

Persist this ID in the SaaS request log when diagnosing a failed call. It is the join key into `service_api_audit_logs`.

## Distributed API rate limit

`/v1` requests are limited per API credential through Redis, so multiple API nodes share the same counter.

```env
ONEGL_API_RATE_LIMIT_PER_MINUTE=120
```

Responses include:

```text
X-RateLimit-Limit
X-RateLimit-Remaining
X-RateLimit-Reset
```

A rejected call returns HTTP 429 with `error=api_rate_limited` and `Retry-After`.

Production mode requires a positive rate limit. Redis failure is fail-closed for the production API and `/readyz` also reports Redis as unavailable.

## Durable API audit log

Migration `0020_observability_controls.sql` adds `service_api_audit_logs`.

Stored fields are deliberately limited to operational metadata:

- request ID
- tenant/client IDs when the credential maps to a known SaaS API client
- auth kind (`client`, `master`, `anonymous`)
- method and path
- normalized route key with high-cardinality resource IDs replaced by placeholders
- HTTP status and duration
- API error code
- whether an Idempotency-Key response was replayed
- whether the request was rate-limited

The audit table does **not** store Authorization headers, API keys, cookies, storageState, request bodies, prompts, answers or response bodies.

Retention defaults to 30 days and is lazily pruned by API processes:

```env
ONEGL_AUDIT_RETENTION_DAYS=30
```

Query recent metadata:

```bash
npm run audit:list -- --hours 24 --limit 100
npm run audit:list -- --hours 24 --errors
npm run audit:list -- --tenant-id 1 --hours 168
```

## Operations summary

For a quick JSON snapshot without Prometheus:

```bash
npm run ops:summary -- --hours 24
npm run ops:summary -- --tenant-id 1 --hours 168
```

The summary includes API request/error/rate-limit counts, average and p95 API duration, top routes, top error codes, execution status/duration, account states, webhook event/delivery outcomes and per-result run status.

## Prometheus-compatible metrics

`/metrics` is disabled unless a separate metrics secret is configured:

```env
ONEGL_METRICS_TOKEN=<long-random-secret>
```

Scrape it with:

```text
Authorization: Bearer <ONEGL_METRICS_TOKEN>
```

Do not reuse `ONEGL_API_KEY` or a tenant API key for metrics.

The endpoint exposes:

- `onegl_api_requests_total{method,route,status}`
- `onegl_api_request_duration_ms_sum/count{method,route}`
- `onegl_api_rate_limited_total`
- `onegl_database_ready`
- `onegl_accounts{status}`
- `onegl_executions{status}`
- `onegl_webhook_events{status}`
- `onegl_webhook_deliveries{status}`
- `onegl_runs{status}`
- `onegl_worker_state{state}`
- `onegl_worker_heartbeat_age_seconds`
- `onegl_worker_account_count`
- `onegl_worker_account_parallelism`

API request counters are process-local, which is normal for Prometheus: scrape every API replica and aggregate in Prometheus. Database and Redis-backed gauges represent shared runtime state.

## Suggested alerts

Useful first alerts are:

- `/readyz` not ready for more than a few minutes;
- `onegl_worker_state{state="offline"} == 1`;
- webhook failed events/deliveries increasing;
- account `verification_required`, `session_expired` or `access_restricted` counts above zero;
- sustained API 5xx growth;
- sustained API 429 growth;
- execution `failed`/`partial` growth;
- API p95 duration increasing in `npm run ops:summary`.

The account alerts are operational signals, not instructions to bypass provider verification. Verification/access restriction continues to require manual handling.
