# OneGl SaaS Task API

This is the recommended integration surface for a product/SaaS backend. The SaaS owns end-user login, billing and UI. OneGl owns AI-platform login state, execution, evidence capture, progress and reports.

The first executable platform is `doubao`. The contract already carries a `platforms` array so later Chinese providers can be added without changing the Task/Execution/Result/Report model. Unsupported providers are rejected rather than silently ignored.

## Stable IDs the SaaS should persist

| Resource | Public ID | Meaning |
| --- | --- | --- |
| Platform account | caller-defined `account_id` | AI-platform connection/login alias |
| Task | `tsk_...` | reusable questions + platform configuration |
| Execution | `exe_...` | one immutable run/re-run of a task |
| Result | `res_...` | one question/platform execution unit |
| Report | `rpt_...` | queryable report for one execution |
| Schedule | `sch_...` | daily/weekly recurring task schedule |

Internal PostgreSQL IDs, BullMQ job IDs, browser cookies and storageState are not part of this contract.

## 1. Connect a platform account

Register the connection alias:

```http
POST /v1/accounts
```

```json
{
  "account_id": "doubao-main",
  "provider": "doubao",
  "label": "主豆包账号"
}
```

A newly registered account is **not executable**. Its login state is `login_required` until the normal OneGl auth flow successfully saves platform login state.

Start a restricted login session:

```http
POST /v1/accounts/doubao-main/auth-sessions
```

Poll that auth session and proxy its screenshot from the SaaS backend. OneGl never returns browser cookies/storageState to the SaaS frontend.

Account/list status remains available from:

```http
GET /v1/accounts
```

If login expires, verification is required, or access is restricted, execution fails closed and returns an account-action-required error instead of bypassing the provider restriction.

## 2. Create a reusable task

```http
POST /v1/tasks
```

```json
{
  "external_id": "saas-project-1024",
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

The response contains a stable `task_id`. Store it in the SaaS.

A Task is configuration/history identity, not an individual measurement. Once a task has execution history, fields that change measurement meaning (questions/platforms/accounts/sampling) are locked. To make a new version, clone it:

```http
POST /v1/tasks/{task_id}/clone
```

This prevents historical reports from silently changing meaning.

## 3. Execute or re-execute

```http
POST /v1/tasks/{task_id}/executions
```

An empty JSON object uses the saved task configuration. Every call creates a new immutable `execution_id`, a new `report_id`, and stable result IDs. Re-running never overwrites a previous measurement.

Typical accepted response:

```json
{
  "data": {
    "execution_id": "exe_...",
    "task_id": "tsk_...",
    "report_id": "rpt_...",
    "status": "queued",
    "progress": {
      "total": 2,
      "completed": 0,
      "failed": 0,
      "skipped": 0,
      "remaining": 2,
      "percent": 0
    },
    "report_url": "/v1/reports/rpt_...",
    "results_url": "/v1/executions/exe_.../results"
  }
}
```

If an account needs login/manual action, OneGl rejects execution creation with `account_action_required`. Temporary cooldown/hour/day ceilings are still handled by the existing conservative worker policy.

## 4. Poll progress

The SaaS can poll:

```http
GET /v1/executions/{execution_id}
```

Useful execution states are based on OneGl measurement state, not raw BullMQ states. Current Doubao execution can return states such as:

- `pending`
- `queued`
- `running`
- `paused`
- `completed`
- `partial`
- `failed`
- `cancelled`

`progress` contains total/completed/failed/skipped/remaining/percent so the SaaS does not need to understand OneGl's internal queues.

## 5. Pause, resume, cancel

```http
POST /v1/executions/{execution_id}/pause
POST /v1/executions/{execution_id}/resume
POST /v1/executions/{execution_id}/cancel
```

Pause removes remaining queued work for that execution. A prompt already actively executing is allowed to finish safely. Resume queues only unfinished assignments; successful historical results are not asked again. Cancel retains already-finished results and stops remaining queued work.

## 6. Query individual question results

List result IDs:

```http
GET /v1/executions/{execution_id}/results
```

Then query one result:

```http
GET /v1/results/{result_id}
```

A finished result returns the question, platform, answer/brand signal and captured citations. A result that has not run yet returns `pending` rather than inventing an answer.

## 7. Query reports

By stable report ID:

```http
GET /v1/reports/{report_id}
```

By execution:

```http
GET /v1/executions/{execution_id}/report
```

Historical reports for one task:

```http
GET /v1/tasks/{task_id}/reports
```

While execution is active, the report resource exists with `status: generating`. When the underlying measurement reaches a terminal state, the same `report_id` becomes `ready` and exposes OneGl's auditable report/source/intelligence data.

This means the SaaS can create its own report-list page using only saved `task_id`/`report_id` values.

## 8. Recurring schedules

Create:

```http
POST /v1/tasks/{task_id}/schedules
```

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

Weekly schedules additionally use ISO weekday `1..7`.

Manage/query:

```http
GET    /v1/tasks/{task_id}/schedules
GET    /v1/schedules/{schedule_id}
PATCH  /v1/schedules/{schedule_id}
DELETE /v1/schedules/{schedule_id}
GET    /v1/schedules/{schedule_id}/executions
```

Scheduled occurrences reuse the ordinary OneGl batch + worker safety path and create stable `execution_id`/`report_id` resources when a batch is materialized. Scheduler downtime is not backfilled into fake historical measurements.

## Recommended SaaS workflow

```text
User signs into SaaS
        ↓
SaaS checks AI-platform accounts
        ↓
User completes Doubao login if required
        ↓
SaaS POST /v1/tasks
        ↓ store task_id
SaaS POST /v1/tasks/{task_id}/executions
        ↓ store execution_id + report_id
SaaS polls GET /v1/executions/{execution_id}
        ↓
completed / partial / failed / cancelled
        ↓
GET /v1/reports/{report_id}
GET /v1/executions/{execution_id}/results
        ↓
SaaS renders report/history or links into its own report UI
```

All calls must be server-to-server. Do not put OneGl API keys in browser/mobile client code.
