# OneGl Service API

This service lets another trusted platform use OneGl as an execution backend without exposing browser-control primitives or Doubao session material.

## Topology

```text
Product / SaaS UI
      |
      | user auth
      v
Product backend
      |
      | HTTPS + OneGl service API key
      v
OneGl Service API
      |
      +--> PostgreSQL
      +--> BullMQ / Redis --> OneGl Worker --> Doubao Web
```

The existing OneGl dashboard remains an internal/admin console. The service API is a separate process and exposes only business-level resources: projects, keyword pools, accounts, batches, runs and reports.

## Start

Configure at minimum:

```bash
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
ONEGL_API_KEY=<long-random-secret>
ONEGL_API_HOST=127.0.0.1
ONEGL_API_PORT=3200
```

Then run:

```bash
npm run api:serve
```

The API exposes:

- `GET /healthz`
- `GET /openapi.json`
- authenticated `/v1/*` endpoints

For cross-host deployment, keep OneGl behind a TLS reverse proxy or private network. Do not expose a plaintext service port directly to the public Internet.

## Authentication

Either header form is accepted:

```http
Authorization: Bearer <ONEGL_API_KEY>
```

or:

```http
X-API-Key: <ONEGL_API_KEY>
```

The key is intended for server-to-server calls from your product backend. Do not put it in browser JavaScript or mobile clients.

## Typical product flow

### 1. Create a project

```http
POST /v1/projects
Content-Type: application/json
Authorization: Bearer ...

{
  "name": "小米汽车",
  "target_brand": "小米",
  "keywords": [
    "20万新能源SUV推荐",
    "国产新能源车哪个品牌值得买"
  ]
}
```

Keywords are optional here; they can also be added later with `POST /v1/projects/{projectId}/keywords`.

### 2. Inspect available execution accounts

```http
GET /v1/accounts
Authorization: Bearer ...
```

The response includes account health and an `executable` flag. It never includes cookies, Playwright `storageState`, session tokens or browser profile contents.

### 3. Create a batch

```http
POST /v1/batches
Content-Type: application/json
Authorization: Bearer ...

{
  "project_id": 1,
  "size": 2,
  "method": "stratified",
  "accounts": ["account_01"],
  "repeats": 3,
  "start": true
}
```

`start: true` creates and immediately enqueues the batch. If omitted, call `POST /v1/batches/{batchId}/start` later.

### 4. Poll progress

```http
GET /v1/batches/123
Authorization: Bearer ...
```

For a first integration, polling this endpoint is sufficient. A webhook layer can be added later without changing the execution model.

### 5. Read runs and report

```http
GET /v1/batches/123/runs
GET /v1/batches/123/report
GET /v1/runs/run_b123_i1
```

The batch report is backed by the same database/reporting logic used by the existing OneGl dashboard and CLI.

## API boundaries

The service intentionally does **not** expose endpoints such as:

```text
click-new-chat
type-prompt
click-send
solve-captcha
set-cookie
get-storage-state
```

External callers operate OneGl through domain resources, not through raw browser actions. Verification, login expiry and access restrictions continue to use OneGl's fail-closed account safety model and require manual handling where appropriate.

## Next service milestones

The current API is designed for a trusted first-party product backend. Before opening it to unrelated third parties, add:

1. tenant ownership / `tenant_id` isolation;
2. per-client API keys and scopes;
3. signed webhook delivery with replay protection;
4. service-level request rate limits and audit records;
5. remote account-connect sessions only if customer-owned Doubao accounts must be linked from the product UI.

The execution worker and account safety controls should remain the single source of truth; future API features should orchestrate those primitives rather than duplicate them.
