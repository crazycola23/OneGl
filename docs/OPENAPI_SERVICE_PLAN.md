# OneGl Service API

OneGl can run as an execution backend for another product. The product owns end-user login, product UI, billing and permissions; OneGl owns GEO execution, account safety, browser sessions, queueing, evidence and reporting.

```text
Product / SaaS UI
      |
      | product user session
      v
Product backend
      |
      | HTTPS + tenant API key
      v
OneGl Service API
      |
      +--> PostgreSQL
      +--> BullMQ / Redis --> OneGl Worker --> Doubao Web
      +--> Remote auth session (temporary login browser)
      +--> Durable webhook events --> Webhook Worker --> Product backend
```

The existing OneGl dashboard stays an internal/admin console. It is not the customer-facing surface.

## Processes

```bash
npm run api:serve          # business API
npm run worker             # GEO execution
npm run webhook:worker     # signed webhook delivery
npm run serve              # internal/admin dashboard (optional)
```

## Minimum configuration

```bash
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
ONEGL_API_KEY=<long-random-master-secret>
ONEGL_WEBHOOK_SIGNING_KEY=<different-long-random-secret>
ONEGL_API_HOST=127.0.0.1
ONEGL_API_PORT=3200
```

For cross-host deployment, keep OneGl behind TLS or a private network. Do not expose a plaintext API port directly to the public Internet.

## Authentication model

There are two credential levels.

### Master key

`ONEGL_API_KEY` is an operator/bootstrap key. It can create tenants and tenant API clients and can select a tenant with `X-OneGl-Tenant` for administrative first-party calls.

Do not put it in browser JavaScript or mobile clients.

### Tenant client keys

Create tenant-scoped keys with:

```http
POST /v1/admin/tenants/{tenantId}/clients
Authorization: Bearer <master-key>
Content-Type: application/json

{
  "name": "main-product-backend",
  "scopes": [
    "projects:read",
    "projects:write",
    "accounts:read",
    "accounts:write",
    "batches:read",
    "batches:write",
    "reports:read",
    "webhooks:read",
    "webhooks:write"
  ]
}
```

The returned `api_key` is shown once. Only its SHA-256 hash and a display prefix are stored in PostgreSQL. Tenant client keys cannot select another tenant.

## Tenant isolation

The collector's historical core tables remain compatible with the CLI/dashboard. The service layer adds binding tables:

```text
service_tenants
  +-- service_project_bindings --> projects
  +-- service_account_bindings --> accounts
  +-- service_api_clients
  +-- service_webhook_endpoints
  +-- service_auth_sessions
```

Projects are internally namespaced while the API returns the tenant-facing display name. Account aliases are also mapped to opaque internal account keys, so one tenant cannot address another tenant's project, batch, run or account through the API.

Existing pre-service projects/accounts are migrated into the `default` tenant.

## Typical product flow

### 1. Create tenant and product client

```http
POST /v1/admin/tenants
Authorization: Bearer <master>

{
  "slug": "customer-a",
  "name": "Customer A"
}
```

Then create a scoped client using `/v1/admin/tenants/{tenantId}/clients`.

### 2. Create project and keywords

```http
POST /v1/projects
Authorization: Bearer <tenant-client-key>
Content-Type: application/json

{
  "name": "小米汽车",
  "external_id": "project_9081",
  "target_brand": "小米",
  "keywords": [
    "20万新能源SUV推荐",
    "国产新能源车哪个品牌值得买"
  ]
}
```

### 3. Register an execution account alias

```http
POST /v1/accounts
Authorization: Bearer <tenant-client-key>
Content-Type: application/json

{
  "account_id": "doubao-primary",
  "provider": "doubao",
  "label": "客户主账号"
}
```

The external `account_id` is the only identifier your product needs to store.

### 4. Connect/login the provider account

```http
POST /v1/accounts/doubao-primary/auth-sessions
Authorization: Bearer <tenant-client-key>
Content-Type: application/json

{
  "ttl_minutes": 10
}
```

OneGl starts a temporary isolated browser session. The API returns an auth-session UUID and a screenshot endpoint. Your product backend can proxy that PNG into its own account-connect UI:

```http
GET /v1/auth-sessions/{id}/screenshot
GET /v1/auth-sessions/{id}
```

The login session only opens the provider's normal login surface and returns screenshots/status. It does not expose arbitrary click/type endpoints, cookies or Playwright `storageState`.

When OneGl detects a healthy logged-in session, it writes the account's storage state into OneGl's local account directory and closes the temporary browser. Verification/access-restriction states fail closed; OneGl does not solve or bypass them.

### 5. Create and start a batch

```http
POST /v1/batches
Authorization: Bearer <tenant-client-key>
Content-Type: application/json

{
  "project_id": 123,
  "size": 20,
  "method": "stratified",
  "accounts": ["doubao-primary"],
  "repeats": 3,
  "start": true
}
```

The service resolves the tenant-facing account alias to its internal OneGl account key and then reuses the normal sampling, BullMQ and Worker execution path. Existing hourly/daily limits, cooldowns, verification handling and retry/idempotency rules remain the source of truth.

### 6. Progress and report

```http
GET /v1/batches/{batchId}
GET /v1/batches/{batchId}/runs
GET /v1/batches/{batchId}/report
GET /v1/runs/{runId}
```

All ownership checks are tenant-scoped.

## Product-side UI mapping

A customer-facing platform can map its pages almost one-for-one to the service resources without embedding the OneGl Admin Console:

```text
Product page                 OneGl API
-------------------------------------------------------------
Projects                     GET/POST /v1/projects
Keyword manager              /v1/projects/{id}/keywords
AI account connections       GET/POST /v1/accounts
Connect Doubao               POST /v1/accounts/{id}/auth-sessions
Login QR / connection state  /v1/auth-sessions/{id}[/screenshot]
Monitoring jobs              GET/POST /v1/batches
Job detail/progress          GET /v1/batches/{id}
Run detail                   GET /v1/runs/{runId}
Results/report               GET /v1/batches/{id}/report
Notifications                signed webhooks
```

The product backend should proxy the auth-session screenshot rather than giving the browser a OneGl API key.

## Webhooks

Create an endpoint:

```http
POST /v1/webhooks
Authorization: Bearer <tenant-client-key>
Content-Type: application/json

{
  "url": "https://product.example.com/webhooks/onegl",
  "event_types": [
    "batch.completed",
    "batch.partial",
    "batch.failed",
    "batch.aborted",
    "account.verification_required",
    "account.rate_limited"
  ]
}
```

The response includes a derived `signing_secret`. Store it in the product backend; it is not persisted as endpoint plaintext in the database.

Run `npm run webhook:worker` to deliver durable queued events. Terminal batch transitions and important account-risk transitions are inserted into `service_webhook_events` by PostgreSQL triggers, so a temporary API or worker restart does not lose the event.

Webhook headers:

```text
X-OneGl-Event
X-OneGl-Event-Id
X-OneGl-Timestamp
X-OneGl-Signature: v1=<hex HMAC-SHA256>
```

Verification input is:

```text
<timestamp>.<raw request body>
```

using the endpoint `signing_secret` as the HMAC-SHA256 key. Consumers should reject stale timestamps (for example older than five minutes) and deduplicate by `X-OneGl-Event-Id` before applying side effects.

Delivery retries use bounded backoff and retain delivery attempts/status in PostgreSQL.

## Security boundaries

The API intentionally does not expose:

```text
click-new-chat
type-prompt
click-send
solve-captcha
set-cookie
get-storage-state
arbitrary browser navigation
```

Customer-facing product code should call OneGl only from its backend. Browser/mobile clients should never receive OneGl tenant API keys, the master key, provider cookies or storage state.

## OpenAPI

`GET /openapi.json` returns OpenAPI 3.1 and documents tenant administration, client keys, projects, account-connect sessions, batches, runs, reports and webhooks.

This can be used to generate a TypeScript/Python/Go SDK for the product backend.
