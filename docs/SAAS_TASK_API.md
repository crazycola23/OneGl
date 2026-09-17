# OneGl SaaS Task API Contract v0.7

This is the stable server-to-server contract for integrating a SaaS product with OneGl.

The SaaS owns end-user login, billing, permissions and product UI. OneGl owns AI-platform login state, browser execution, evidence capture, progress, results and GEO reports.

The first executable platform is `doubao`. The contract already uses `platforms` and platform-scoped results so more Chinese AI platforms can be added later without changing the Task → Execution → Result → Report model.

## 0. Contract rules

All calls are server-to-server. Never put a OneGl API key in browser/mobile code.

Recommended authentication:

```http
Authorization: Bearer <tenant-api-key>
Content-Type: application/json
```

Successful JSON responses use one envelope:

```json
{
  "data": {}
}
```

Errors use one shape:

```json
{
  "error": "account_action_required",
  "message": "one or more platform accounts require manual attention",
  "details": {
    "accounts": [
      {
        "account_id": "doubao-main",
        "status": "login_required",
        "cooldown_until": null
      }
    ]
  }
}
```

Callers should branch on `error`, not parse the English `message` string.

All timestamps are ISO-8601 timestamps returned by PostgreSQL/Node and should be treated as absolute instants.

### Stable IDs the SaaS should persist

| Object | ID | Meaning |
| --- | --- | --- |
| Platform account | caller-owned `account_id` | AI-platform login alias |
| Task | `tsk_...` | reusable question/platform configuration |
| Execution | `exe_...` | one immutable measurement run |
| Result | `res_...` | one question/platform result |
| Report | `rpt_...` | report resource for one execution |
| Schedule | `sch_...` | recurring task schedule |

Do **not** persist internal PostgreSQL IDs, sampling batch IDs, BullMQ job IDs, run tokens, browser cookies or storageState as part of the SaaS contract.

---

## 1. Platform account and login

### 1.1 Register an account alias

```http
POST /v1/accounts
```

Request:

```json
{
  "account_id": "doubao-main",
  "provider": "doubao",
  "label": "主豆包账号"
}
```

Response:

```json
{
  "data": {
    "account_id": "doubao-main",
    "provider": "doubao",
    "label": "主豆包账号"
  }
}
```

Registering an account does not mean it is logged in. A new account starts as `login_required`.

### 1.2 Start login

```http
POST /v1/accounts/doubao-main/auth-sessions
```

Typical request:

```json
{
  "ttl_minutes": 10
}
```

The SaaS backend then polls the auth-session resource and proxies the screenshot endpoint to its frontend. OneGl never returns raw cookies/storageState.

Useful routes:

```http
GET  /v1/auth-sessions/{auth_session_id}
GET  /v1/auth-sessions/{auth_session_id}/screenshot
POST /v1/auth-sessions/{auth_session_id}/cancel
GET  /v1/accounts
```

Account states that require the user/operator to act include:

```text
login_required
session_expired
verification_required
access_restricted
paused
disabled
```

Temporary safety states such as cooldown/rate limiting are handled by OneGl's execution safety layer rather than bypassed.

---

## 2. Create a Task

A Task is reusable configuration and history identity. It is not a single run.

```http
POST /v1/tasks
```

Recommended request:

```json
{
  "external_id": "saas_project_1024",
  "name": "小米汽车 GEO 监测",
  "target_brand": "小米汽车",
  "questions": [
    "20万左右新能源SUV推荐",
    "国产新能源车哪个品牌值得买"
  ],
  "platforms": ["doubao"],
  "account_ids": ["doubao-main"],
  "sampling": {
    "method": "stratified",
    "repeats": 1
  }
}
```

Field meaning:

| Field | Required | Meaning |
| --- | --- | --- |
| `external_id` | no | caller-owned reference from your SaaS |
| `name` | yes | user-facing task name |
| `target_brand` | no | brand to detect/analyze |
| `questions` | yes | questions sent to the selected AI platform |
| `platforms` | no | defaults to `["doubao"]` |
| `account_ids` | no at creation | saved account aliases; at least one is required to execute |
| `sampling.method` | no | `stratified` or `random`, default `stratified` |
| `sampling.repeats` | no | times each selected question is measured, default `1` |

Response:

```json
{
  "data": {
    "task_id": "tsk_0123456789abcdef0123456789abcdef",
    "external_id": "saas_project_1024",
    "name": "小米汽车 GEO 监测",
    "target_brand": "小米汽车",
    "questions": [
      "20万左右新能源SUV推荐",
      "国产新能源车哪个品牌值得买"
    ],
    "platforms": ["doubao"],
    "account_ids": ["doubao-main"],
    "sampling": {
      "method": "stratified",
      "repeats": 1
    },
    "revision": 1,
    "state": "active",
    "execution_count": 0,
    "latest_execution_id": null,
    "created_at": "2026-09-16T09:30:00.000Z",
    "updated_at": "2026-09-16T09:30:00.000Z"
  }
}
```

Your SaaS should persist `task_id` immediately.

### Task editing rule

Before a Task has execution history, it may be edited.

Once it has execution history, fields that change measurement meaning — questions, platforms, accounts and sampling configuration — are locked. Clone instead:

```http
POST /v1/tasks/{task_id}/clone
```

This keeps historical reports reproducible.

---

## 3. Execute or re-execute a Task

```http
POST /v1/tasks/{task_id}/executions
```

For the normal case, send an empty object or no body. Saved Task settings are used and the new Execution is started immediately:

```json
{}
```

Optional per-execution overrides:

```json
{
  "account_ids": ["doubao-main"],
  "platforms": ["doubao"],
  "sampling": {
    "repeats": 2
  },
  "seed": null
}
```

Each sampling field is independently optional. For example, overriding only `repeats` keeps the Task's saved sampling method.

Accepted response:

```json
{
  "data": {
    "execution_id": "exe_0123456789abcdef0123456789abcdef",
    "task_id": "tsk_0123456789abcdef0123456789abcdef",
    "task_name": "小米汽车 GEO 监测",
    "report_id": "rpt_0123456789abcdef0123456789abcdef",
    "trigger": "manual",
    "status": "queued",
    "progress": {
      "total": 2,
      "completed": 0,
      "failed": 0,
      "skipped": 0,
      "remaining": 2,
      "percent": 0
    },
    "created_at": "2026-09-16T09:31:00.000Z",
    "started_at": null,
    "finished_at": null,
    "report_url": "/v1/reports/rpt_0123456789abcdef0123456789abcdef",
    "results_url": "/v1/executions/exe_0123456789abcdef0123456789abcdef/results"
  }
}
```

The SaaS should persist `execution_id` and `report_id` immediately.

Every POST creates a new execution. Re-execution never overwrites old results:

```text
tsk_A
├─ exe_1 → rpt_1
├─ exe_2 → rpt_2
└─ exe_3 → rpt_3
```

If the account is not logged in or requires manual action, execution creation fails closed with `account_action_required`.

---

## 4. Poll execution progress

```http
GET /v1/executions/{execution_id}
```

Response:

```json
{
  "data": {
    "execution_id": "exe_0123456789abcdef0123456789abcdef",
    "task_id": "tsk_0123456789abcdef0123456789abcdef",
    "task_name": "小米汽车 GEO 监测",
    "report_id": "rpt_0123456789abcdef0123456789abcdef",
    "trigger": "manual",
    "status": "running",
    "progress": {
      "total": 20,
      "completed": 7,
      "failed": 1,
      "skipped": 0,
      "remaining": 12,
      "percent": 40
    },
    "created_at": "2026-09-16T09:31:00.000Z",
    "started_at": "2026-09-16T09:31:04.000Z",
    "finished_at": null
  }
}
```

Execution status values:

```text
pending
queued
running
paused
completed
partial
failed
cancelled
```

Suggested SaaS behavior:

| Status | UI behavior |
| --- | --- |
| `pending` | waiting to start |
| `queued` | queued |
| `running` | show live progress |
| `paused` | show resume button |
| `completed` | open report |
| `partial` | open report + show partial warning |
| `failed` | show failure state; keep any finished results |
| `cancelled` | show cancelled; keep finished results |

The SaaS can poll every few seconds while the status is non-terminal. Webhooks can later replace/reduce polling for completion notifications.

---

## 5. Pause, resume and cancel

```http
POST /v1/executions/{execution_id}/pause
POST /v1/executions/{execution_id}/resume
POST /v1/executions/{execution_id}/cancel
```

Rules:

- Pause removes remaining queued work. A prompt already active is allowed to finish safely.
- Resume only queues unfinished assignments; successful results are not asked again.
- Cancel keeps already-finished results and stops remaining queued work.
- Invalid transitions return `invalid_execution_state` rather than silently succeeding.

---

## 6. List Result IDs

```http
GET /v1/executions/{execution_id}/results
```

Response:

```json
{
  "data": [
    {
      "result_id": "res_0123456789abcdef0123456789abcdef",
      "question": "20万左右新能源SUV推荐",
      "platform": "doubao",
      "status": "success",
      "brand_mentioned": true,
      "mention_count": 2,
      "finished_at": "2026-09-16T09:32:10.000Z",
      "result_url": "/v1/results/res_0123456789abcdef0123456789abcdef"
    }
  ]
}
```

Result status values currently follow the capture-result vocabulary:

```text
pending
running
success
partial
failed
```

`execution.status=completed` describes the whole execution. `result.status=success` describes one captured question result.

---

## 7. Query one Result

```http
GET /v1/results/{result_id}
```

Pending result:

```json
{
  "data": {
    "result_id": "res_0123456789abcdef0123456789abcdef",
    "task_id": "tsk_0123456789abcdef0123456789abcdef",
    "execution_id": "exe_0123456789abcdef0123456789abcdef",
    "platform": "doubao",
    "question": "20万左右新能源SUV推荐",
    "status": "pending",
    "citations": []
  }
}
```

Finished result:

```json
{
  "data": {
    "result_id": "res_0123456789abcdef0123456789abcdef",
    "task_id": "tsk_0123456789abcdef0123456789abcdef",
    "execution_id": "exe_0123456789abcdef0123456789abcdef",
    "platform": "doubao",
    "question": "20万左右新能源SUV推荐",
    "status": "success",
    "answer": {
      "text": "……豆包回答正文……",
      "brand_mentioned": true,
      "mention_count": 2
    },
    "citations": [
      {
        "source_position": 1,
        "citation_marker": null,
        "relation_status": "matched",
        "captured_from": "DOM",
        "visible_to_user": true,
        "source_type": "visible",
        "answer_text": null,
        "tracked_article_id": null,
        "canonical_url": "https://example.com/article",
        "original_url": "https://example.com/article?from=doubao",
        "title": "文章标题",
        "domain": "example.com",
        "normalized_domain": "example.com"
      }
    ],
    "started_at": "2026-09-16T09:31:05.000Z",
    "finished_at": "2026-09-16T09:32:10.000Z"
  }
}
```

If a result has not executed yet, OneGl returns `pending` and an empty citation array rather than inventing answer data.

---

## 8. Query reports

### By report ID

```http
GET /v1/reports/{report_id}
```

### By execution ID

```http
GET /v1/executions/{execution_id}/report
```

### Historical reports for a Task

```http
GET /v1/tasks/{task_id}/reports
```

While execution is active:

```json
{
  "data": {
    "report_id": "rpt_0123456789abcdef0123456789abcdef",
    "task_id": "tsk_0123456789abcdef0123456789abcdef",
    "execution_id": "exe_0123456789abcdef0123456789abcdef",
    "status": "generating",
    "execution_status": "running",
    "report_url": "/v1/reports/rpt_0123456789abcdef0123456789abcdef",
    "summary": null,
    "sources": null,
    "intelligence": null,
    "created_at": "2026-09-16T09:31:00.000Z"
  }
}
```

At a terminal execution state, the same `report_id` becomes ready:

```json
{
  "data": {
    "report_id": "rpt_0123456789abcdef0123456789abcdef",
    "task_id": "tsk_0123456789abcdef0123456789abcdef",
    "execution_id": "exe_0123456789abcdef0123456789abcdef",
    "status": "ready",
    "execution_status": "completed",
    "report_url": "/v1/reports/rpt_0123456789abcdef0123456789abcdef",
    "summary": {},
    "sources": {},
    "intelligence": {},
    "created_at": "2026-09-16T09:31:00.000Z"
  }
}
```

Report status is deliberately simple:

```text
generating
ready
```

A `ready` report can still have `execution_status=partial`, `failed`, or `cancelled`; it means the execution has reached a terminal state and the report reflects all evidence that exists.

---

## 9. Recurring schedules

```http
POST /v1/tasks/{task_id}/schedules
```

Daily example:

```json
{
  "name": "每日豆包监测",
  "schedule": {
    "cadence": "daily",
    "time_zone": "Asia/Shanghai",
    "local_time": "09:00"
  },
  "account_ids": ["doubao-main"],
  "enabled": true
}
```

Weekly example:

```json
{
  "name": "每周一监测",
  "schedule": {
    "cadence": "weekly",
    "time_zone": "Asia/Shanghai",
    "local_time": "09:00",
    "weekday": 1
  },
  "account_ids": ["doubao-main"],
  "enabled": true
}
```

`weekday` uses ISO weekday numbering: Monday=`1`, Sunday=`7`.

Manage schedules:

```http
GET    /v1/tasks/{task_id}/schedules
GET    /v1/schedules/{schedule_id}
PATCH  /v1/schedules/{schedule_id}
DELETE /v1/schedules/{schedule_id}
GET    /v1/schedules/{schedule_id}/executions
```

Scheduled runs reuse the ordinary OneGl batch/worker safety path and produce stable `execution_id`, `result_id` and `report_id` resources.

---

## 10. Error codes the SaaS should handle

| HTTP | `error` | SaaS action |
| --- | --- | --- |
| 400 | `invalid_request` | request/form bug; show validation message |
| 401 | `unauthorized` | server API key missing/invalid |
| 401 | `api_key_expired` | rotate/reissue backend API key |
| 403 | `insufficient_scope` | backend credential configuration error |
| 403 | `tenant_disabled` | tenant is disabled |
| 404 | `task_not_found` | remove stale task reference |
| 404 | `execution_not_found` | remove stale execution reference |
| 404 | `result_not_found` | remove stale result reference |
| 404 | `report_not_found` | remove stale report reference |
| 404 | `schedule_not_found` | remove stale schedule reference |
| 409 | `account_action_required` | send user to platform login/account handling |
| 409 | `task_locked` | clone Task before changing measurement-shaping fields |
| 409 | `invalid_execution_state` | refresh execution and update available controls |
| 409 | `question_pool_empty` | Task has no active questions |
| 409 | `task_conflict` | caller `external_id` conflicts with an existing Task |
| 422 | `account_required` | select/login at least one platform account |
| 422 | `unknown_accounts` | account alias is not registered for tenant |
| 422 | `unsupported_platform` | selected platform is not implemented yet |
| 503 | `database_unavailable` | backend/service incident; retry later |

For `account_action_required`, prefer structured `details.accounts[]` over parsing message text.

---

## 11. Recommended SaaS data model

Your SaaS can keep a thin mapping table such as:

```text
saas_user / workspace
    ↓
onegl_account_id
onegl_task_id
onegl_execution_id
onegl_report_id
onegl_result_id
onegl_schedule_id
```

A practical history model is:

```text
Task: 小米汽车 GEO 监测
│
├─ Execution 2026-09-16
│    ├─ Result A
│    ├─ Result B
│    └─ Report A
│
├─ Execution 2026-09-17
│    ├─ Result A
│    ├─ Result B
│    └─ Report B
│
└─ Schedule: 每日 09:00
```

The SaaS should not need to know how OneGl stores projects, sampling batches, BullMQ queues or browser sessions internally.

---

## 12. Recommended end-to-end workflow

```text
User signs into SaaS
        ↓
SaaS GET /v1/accounts
        ↓
No valid Doubao login?
        ↓ yes
Create/poll auth session
        ↓
POST /v1/tasks
        ↓ persist task_id
POST /v1/tasks/{task_id}/executions
        ↓ persist execution_id + report_id
GET /v1/executions/{execution_id} every few seconds
        ↓
terminal state
        ↓
GET /v1/executions/{execution_id}/results
GET /v1/reports/{report_id}
        ↓
SaaS renders history/report
```

This is the intended public integration surface. Legacy `/projects`, `/batches` and `/runs` remain useful for OneGl administration and lower-level integrations, but a product SaaS should prefer the Task API above.
