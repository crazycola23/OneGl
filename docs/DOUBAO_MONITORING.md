# Doubao-first monitoring loop

OneGl currently optimizes for **Doubao Web as the product measurement surface**. The provider abstraction remains in the codebase for auditability and future compatibility, but recurring monitoring in this phase is intentionally Doubao-only.

The product loop is:

```text
Project keyword / prompt pool
        ↓
Recurring monitor plan
        ↓
Ordinary sampling batch
        ↓
Existing account safety + BullMQ worker
        ↓
Doubao answer / visible citations / optional search evidence
        ↓
PostgreSQL evidence
        ↓
Project intelligence + cited-page signals
        ↓
Next scheduled observation
```

## Safety boundary

A monitoring plan does not create a second execution path. It only materializes ordinary `sampling_batches` and calls the existing queue layer. Account safety remains authoritative:

- configured per-account hourly and daily ceilings still apply;
- minimum inter-run pacing and randomized delay still apply;
- ordinary cooldowns and rate-limit cooldowns still apply;
- uncertain submissions are not blindly retried;
- login expiry, human verification and access restriction remain fail-closed/manual states;
- the monitoring worker does not solve CAPTCHA, dismiss access controls, spoof browser identity or expose raw browser controls.

If **any configured account** for a scheduled occurrence is in a permanent/manual-attention state, that occurrence is skipped and a `monitor.action_required` webhook event is queued. OneGl does not silently route around the challenged account by switching to the other configured accounts.

Temporary states such as normal cooldown, rolling hourly ceiling or daily ceiling are different: the original batch/worker layer remains responsible for delaying those jobs until they are eligible or for settling them under its existing bounded-wait rules.

## Running the scheduler

Run migrations first, then start the monitor worker as a separate service process:

```bash
npm run db:migrate
npm run monitor:worker
```

The scheduler checks for due plans every 30 seconds by default. For deployment/testing only, the scheduler polling interval can be changed with:

```bash
ONEGL_MONITOR_TICK_MS=30000
```

This value controls how often OneGl looks for due schedules. It does **not** change Doubao prompt pacing or account rate limits.

The normal deployment therefore has independent processes for:

```text
api:serve        product/service API
worker           Doubao execution queues
monitor:worker   daily/weekly schedule materialization
webhook:worker   webhook delivery
```

## Service API

### Create a daily plan

```http
POST /v1/projects/{projectId}/monitor-plans
Authorization: Bearer <tenant api key>
Content-Type: application/json
```

```json
{
  "name": "每日品牌监测",
  "cadence": "daily",
  "time_zone": "Asia/Shanghai",
  "local_time": "09:00",
  "size": 20,
  "method": "stratified",
  "repeats": 1,
  "accounts": ["doubao-main"],
  "enabled": true
}
```

`size: null` (or omitted) means the plan uses all currently enabled prompts when an occurrence is materialized. If the pool later shrinks, OneGl clamps the scheduled sample to the current enabled pool instead of failing because an old configured sample size is now larger than the pool.

### Create a weekly plan

For weekly cadence, `weekday` uses ISO weekday numbers (`1 = Monday`, `7 = Sunday`):

```json
{
  "name": "每周三基准监测",
  "cadence": "weekly",
  "weekday": 3,
  "time_zone": "Asia/Shanghai",
  "local_time": "10:00",
  "accounts": ["doubao-main"]
}
```

### List/update plans

```http
GET    /v1/projects/{projectId}/monitor-plans
GET    /v1/monitor-plans/{monitorPlanId}
PATCH  /v1/monitor-plans/{monitorPlanId}
DELETE /v1/monitor-plans/{monitorPlanId}
GET    /v1/monitor-plans/{monitorPlanId}/executions
```

Setting `enabled: false` pauses future materialization without deleting historical batches. Re-enabling a plan recomputes its next wall-clock occurrence from the configured time zone.

Each scheduled occurrence is persisted in `service_monitor_executions` before a batch is created. `(plan_id, scheduled_for)` is unique, and `sampling_batches.monitor_execution_id` is unique, so retries or scheduler restarts do not intentionally create duplicate batches for the same occurrence.

OneGl deliberately does **not** backfill every missed period after scheduler downtime. If a daily plan was offline for several days, recovery materializes at most one overdue occurrence and then advances `next_run_at` to the next future wall-clock slot. Running several “historical” batches today would still measure today's Doubao behavior, so treating them as missing historical observations would corrupt the trend and could create a needless burst of work.

## Webhook events

The scheduler queues service webhook events that can be consumed by the main product:

- `monitor.batch_created` — a scheduled occurrence produced (or recovered) an ordinary batch;
- `monitor.action_required` — a configured account requires manual attention, so the occurrence was skipped;
- `monitor.failed` — the occurrence could not be materialized/enqueued for an operational reason.

Batch terminal events (`batch.completed`, `batch.partial`, `batch.failed`, `batch.aborted`) continue to come from the existing batch webhook trigger. This gives the main product two separate concepts: **schedule execution** and **measurement completion**.

## Project-level cited-page signals

The rolling project intelligence endpoint now also returns `sourceContent`:

```http
GET /v1/projects/{projectId}/intelligence?days=30
```

It summarizes only pages that were visibly cited by valid Doubao Web runs in the requested window and, where page evidence was successfully collected, reports observable fields such as:

- cited/analyzed page counts and evidence coverage;
- page content-type distribution;
- H2/table/list/FAQ/author/published-date observation rates;
- average text length and H2 count;
- capture-time target-brand evidence rate on analyzed cited pages;
- guarded opportunity candidates for reviewing cited-page patterns or brand-evidence gaps.

The same `sourceContent` surface is available for an exact batch through:

```http
GET /v1/batches/{batchId}/intelligence
```

These are **observational** metrics. OneGl does not claim that tables, FAQ headings, article length, brand mentions or any other page feature caused Doubao to cite a page. The response includes `evidenceQuality`, `brandEvidenceRuleMode` and an attribution note so downstream UI should preserve that distinction.

The page-level `brandEvidenceRate` uses the project brand rules that were in force when page evidence was captured (`capture-time-page-evidence`). By contrast, the answer-level project intelligence deliberately re-derives brand/competitor mentions with the current project rules. The two semantics are intentionally labelled instead of silently mixing them.
