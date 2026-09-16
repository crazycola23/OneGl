# OneGl SaaS Production Contract v0.7

This document adds the production rules that sit on top of `docs/SAAS_TASK_API.md`.

The stable product boundary remains:

```text
SaaS user/workspace
    ↓
account_id
    ↓
task_id (tsk_...)
    ↓
execution_id (exe_...)
    ├─ result_id (res_...)
    └─ report_id (rpt_...)
    ↓
schedule_id (sch_...)
```

The SaaS must not depend on OneGl internal PostgreSQL IDs, batch IDs, BullMQ IDs, run tokens, cookies or storageState.

## 1. API version compatibility

The public path remains `/v1`.

Within `/v1`, OneGl treats changes as additive: documented field meanings and stable IDs should not be removed or reinterpreted. A breaking public contract requires a new major API path rather than silently changing `/v1`.

Every HTTP response includes:

```http
X-OneGl-API-Version: 0.7.0
```

The OpenAPI document at `/openapi.json` is the machine-readable source of truth.

## 2. Safe retries with Idempotency-Key

The following create-style routes support `Idempotency-Key`:

```http
POST /v1/tasks
POST /v1/tasks/{task_id}/clone
POST /v1/tasks/{task_id}/executions
POST /v1/tasks/{task_id}/schedules
```

Recommended request:

```http
Idempotency-Key: saas-job-92812
```

The key is scoped to the tenant and exact operation/path.

If the SaaS retries the same request with the same key and same JSON body, OneGl returns the first stored response instead of creating a second resource. Replayed responses include:

```http
Idempotency-Replayed: true
```

If the same key is reused with a different request body, OneGl returns:

```json
{
  "error": "idempotency_conflict",
  "message": "Idempotency-Key was already used with a different request body"
}
```

If the original request with that key is still being processed, OneGl returns `idempotency_in_progress`.

The first HTTP outcome for an idempotent operation is retained, including validation/account-state errors. If a user fixes a precondition such as `account_action_required` and intentionally tries the action again, the SaaS should create a **new** Idempotency-Key. Reuse the old key only when retrying an ambiguous network/gateway outcome of the same intended action.

The SaaS should generate a new idempotency key for each intended create/run action. A natural key is the SaaS-side job/request UUID.

### Example: safe Execution creation

```http
POST /v1/tasks/tsk_xxx/executions
Authorization: Bearer ...
Idempotency-Key: execution-request-8e6c...
Content-Type: application/json

{}
```

A gateway timeout followed by an identical retry will return the same `execution_id` and `report_id`.

## 3. Cursor pagination

Large SaaS history lists use cursor pagination. Existing v0.6 list-size compatibility is preserved: default `limit` is `100` and maximum is `500`.

```http
GET /v1/tasks?limit=50
GET /v1/tasks/{task_id}/executions?limit=50
GET /v1/executions/{execution_id}/results?limit=50
GET /v1/tasks/{task_id}/reports?limit=50
GET /v1/tasks/{task_id}/schedules?limit=50
```

Response:

```json
{
  "data": [],
  "meta": {
    "has_more": true,
    "next_cursor": "eyJ2IjoxLCJrIjo..."
  }
}
```

Fetch the next page by passing the cursor back unchanged:

```http
GET /v1/tasks?limit=50&cursor=eyJ2IjoxLCJrIjo...
```

Rules:

- `cursor` is opaque; the SaaS must not parse or construct it.
- `next_cursor = null` means the final page.
- use the same collection endpoint and filters with the returned cursor.
- do not implement page numbers on top of this cursor.

## 4. SaaS webhook events

The recommended SaaS event types are:

```text
execution.completed
execution.partial
execution.failed
execution.cancelled
account.action_required
account.ready
```

`batch.*` events remain available for lower-level/legacy integrations, but the SaaS should prefer the stable events above.

Create a webhook endpoint with only the events the SaaS needs:

```json
{
  "url": "https://saas.example.com/webhooks/onegl",
  "event_types": [
    "execution.completed",
    "execution.partial",
    "execution.failed",
    "execution.cancelled",
    "account.action_required",
    "account.ready"
  ]
}
```

Webhook body:

```json
{
  "id": "evt_0123456789abcdef0123456789abcdef",
  "type": "execution.completed",
  "occurred_at": "2026-09-16T10:00:00.000Z",
  "created_at": "2026-09-16T10:00:00.000Z",
  "data": {
    "task_id": "tsk_...",
    "execution_id": "exe_...",
    "report_id": "rpt_...",
    "status": "completed",
    "progress": {
      "total": 20,
      "completed": 20,
      "failed": 0,
      "skipped": 0
    },
    "finished_at": "2026-09-16T10:00:00.000Z"
  }
}
```

Important headers:

```http
X-OneGl-Event-Id: evt_...
X-OneGl-Event: execution.completed
X-OneGl-Webhook-Version: 1
X-OneGl-Timestamp: 1789552800
X-OneGl-Signature: v1=...
```

The SaaS must use `X-OneGl-Event-Id` / body `id` for deduplication because webhook delivery is at-least-once and may be retried.

The signature remains HMAC-SHA256 over:

```text
{timestamp}.{raw_request_body}
```

using the endpoint signing secret returned when the webhook is created.

## 5. Account action events

When a provider login/session requires the user to act, SaaS receives:

```json
{
  "id": "evt_...",
  "type": "account.action_required",
  "data": {
    "provider": "doubao",
    "account_id": "doubao-main",
    "status": "session_expired",
    "reason": "session_expired",
    "cooldown_until": null,
    "last_error_code": "session_expired"
  }
}
```

The SaaS should route the user back to the platform-login flow. It should not attempt to bypass verification/access restrictions.

After a real login state has been restored, OneGl emits:

```json
{
  "id": "evt_...",
  "type": "account.ready",
  "data": {
    "provider": "doubao",
    "account_id": "doubao-main",
    "status": "ready"
  }
}
```

## 6. Recommended SaaS behavior

Use both polling and webhooks:

```text
Create execution with Idempotency-Key
        ↓
Persist execution_id + report_id
        ↓
Poll GET /v1/executions/{execution_id} while user is watching
        ↓
Webhook provides terminal/background notification
        ↓
Deduplicate webhook by evt_ id
        ↓
GET /v1/reports/{report_id}
```

Polling is the source for live progress. Webhooks reduce background polling and notify the SaaS about terminal execution/account state changes.

## 7. Retry guidance

Recommended behavior by failure type:

| Situation | SaaS behavior |
| --- | --- |
| network timeout after POST | retry with the **same** `Idempotency-Key` and same body |
| `idempotency_in_progress` | wait briefly and retry same request/key |
| `idempotency_conflict` | treat as caller bug; generate a new key only for a genuinely new action |
| `account_action_required` | send user to login/verification handling; after recovery, retry the intended action with a **new** key |
| `429` | obey Retry-After when rate limiting is added/exposed |
| `5xx` | retry conservatively; do not change the idempotency key for an ambiguous create request |

## 8. Events and polling are not execution bypasses

All execution still uses OneGl's existing conservative provider controls: login state, one-account execution safety, quotas, cooldowns, verification fail-closed behavior and safe retry rules. Idempotency, scheduling and webhooks do not override those controls.
