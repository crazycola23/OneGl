const nullableDateTime = { type: ["string", "null"], format: "date-time" };
const nullableString = { type: ["string", "null"] };
const count = { type: "integer", minimum: 0 };
const nullableCount = { type: ["integer", "null"], minimum: 0 };

const batchStatuses = ["pending", "queued", "running", "paused", "completed", "partial", "failed", "aborted"];
const runStatuses = ["success", "partial", "failed"];
const accountStatuses = [
  "ready",
  "healthy",
  "login_required",
  "session_expired",
  "verification_required",
  "access_restricted",
  "paused",
  "cooldown",
  "rate_limited",
  "disabled",
];

function object(properties, { required = [], additionalProperties = false } = {}) {
  return {
    type: "object",
    ...(required.length ? { required } : {}),
    properties,
    additionalProperties,
  };
}

export function applyResourceContractOpenApi(document) {
  const schemas = document.components?.schemas;
  if (!schemas) throw new Error("OpenAPI components.schemas must exist before resource contract hardening");

  Object.assign(schemas, {
    KeywordImportResource: object({
      added: count,
      revived: count,
      duplicates: count,
      skipped: count,
      keywords: {
        type: "array",
        items: object({
          id: { type: "integer", minimum: 1 },
          keyword: { type: "string" },
          isNew: { type: "boolean" },
        }, { required: ["id", "keyword", "isNew"] }),
      },
    }, { required: ["added", "revived", "duplicates", "skipped", "keywords"] }),

    BatchDetailResource: object({
      batchId: { type: "integer", minimum: 1 },
      seed: { type: ["string", "integer"] },
      poolSize: count,
      sampleSize: count,
      assignments: count,
      byCategory: {
        type: "array",
        items: object({
          category: nullableString,
          count,
        }, { required: ["category", "count"] }),
      },
      project_id: { type: "integer", minimum: 1 },
      project_name: { type: "string" },
      accounts: { type: "array", items: { type: "string" } },
      status: { type: "string", enum: ["pending", "queued"] },
      start: {
        type: ["object", "null"],
        properties: {
          started: { type: "boolean" },
          reason: { type: "string" },
          alreadyActive: { type: "boolean" },
          enqueued: count,
          accounts: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    }, {
      required: ["batchId", "seed", "poolSize", "sampleSize", "assignments", "byCategory", "project_id", "project_name", "accounts", "status"],
    }),

    BatchProgressResource: object({
      batch: object({
        id: { type: "integer", minimum: 1 },
        name: nullableString,
        status: { type: "string", enum: batchStatuses },
        requested_jobs: nullableCount,
        completed_jobs: nullableCount,
        failed_jobs: nullableCount,
        skipped_jobs: nullableCount,
        started_at: nullableDateTime,
        finished_at: nullableDateTime,
        queued_at: nullableDateTime,
        aborted_at: nullableDateTime,
        last_heartbeat_at: nullableDateTime,
        project_name: { type: "string" },
        target_brand: nullableString,
      }, { required: ["id", "status", "project_name"] }),
      counts: object({
        requested: count,
        completed: count,
        failed: count,
        skipped: count,
        waiting: count,
        active: count,
        parallelism: { type: "integer", minimum: 1 },
        done: count,
        percent: { type: "integer", minimum: 0, maximum: 100 },
      }, { required: ["requested", "completed", "failed", "skipped", "waiting", "active", "parallelism", "done", "percent"] }),
      active: { type: "boolean" },
    }, { required: ["batch", "counts", "active"] }),

    MonitorPlanResource: object({
      id: { type: "integer", minimum: 1 },
      tenant_id: { type: "integer", minimum: 1 },
      project_id: { type: "integer", minimum: 1 },
      name: { type: "string" },
      cadence: { type: "string", enum: ["daily", "weekly"] },
      time_zone: { type: "string" },
      local_hour: { type: "integer", minimum: 0, maximum: 23 },
      local_minute: { type: "integer", minimum: 0, maximum: 59 },
      local_time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
      weekday: { type: ["integer", "null"], minimum: 1, maximum: 7 },
      sample_size: { type: ["integer", "null"], minimum: 1, maximum: 10000 },
      sampling_method: { type: "string", enum: ["stratified", "random"] },
      repeats: { type: "integer", minimum: 1, maximum: 100 },
      accounts: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
      enabled: { type: "boolean" },
      next_run_at: { type: "string", format: "date-time" },
      last_scheduled_for: nullableDateTime,
      last_executed_at: nullableDateTime,
      last_batch_id: { type: ["integer", "null"], minimum: 1 },
      consecutive_failures: count,
      last_error: nullableString,
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    }, {
      required: ["id", "tenant_id", "project_id", "name", "cadence", "time_zone", "local_time", "sampling_method", "repeats", "accounts", "enabled", "next_run_at"],
      additionalProperties: true,
    }),

    MonitorExecutionResource: object({
      id: { type: "integer", minimum: 1 },
      plan_id: { type: "integer", minimum: 1 },
      project_id: { type: "integer", minimum: 1 },
      scheduled_for: { type: "string", format: "date-time" },
      status: { type: "string", enum: ["pending", "processing", "completed", "failed"] },
      attempts: count,
      batch_id: { type: ["integer", "null"], minimum: 1 },
      details: { type: ["object", "null"], additionalProperties: true },
      last_error: nullableString,
      started_at: nullableDateTime,
      finished_at: nullableDateTime,
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    }, { required: ["id", "plan_id", "project_id", "scheduled_for", "status", "attempts"] }),

    IntelligenceResource: object({
      scope: object({
        type: { type: "string", enum: ["batch", "project"] },
        batchId: { type: "integer", minimum: 1 },
        batchName: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 365 },
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
      }, { required: ["type"], additionalProperties: true }),
      project: object({
        id: { type: "integer", minimum: 1 },
        name: { type: "string" },
        targetBrand: nullableString,
      }, { required: ["id", "name", "targetBrand"] }),
      ruleMode: { type: "string" },
      visibility: object({
        validRuns: count,
        brandMentions: count,
        rate: { type: ["number", "null"], minimum: 0, maximum: 1 },
        series: { type: "array", items: { type: "object", additionalProperties: true } },
      }, { required: ["validRuns", "brandMentions", "rate", "series"] }),
      providers: { type: "array", items: { type: "object", additionalProperties: true } },
      shareOfVoice: { type: "object", additionalProperties: true },
      competitors: { type: "array", items: { type: "object", additionalProperties: true } },
      fanout: { type: "object", additionalProperties: true },
      citations: { type: "object", additionalProperties: true },
      promptGaps: { type: "array", items: { type: "object", additionalProperties: true } },
      opportunities: { type: "array", items: { type: "object", additionalProperties: true } },
      sourceContent: { type: "object", additionalProperties: true },
    }, {
      required: ["scope", "project", "ruleMode", "visibility", "providers", "shareOfVoice", "competitors", "fanout", "citations", "promptGaps", "opportunities"],
      additionalProperties: true,
    }),

    ReportPayloadResource: object({
      project_name: { type: "string" },
      report: { type: "object", additionalProperties: true },
      runs: { type: "array", items: { $ref: "#/components/schemas/RunResource" } },
      sources: { type: "object", additionalProperties: true },
      intelligence: { $ref: "#/components/schemas/IntelligenceResource" },
    }, { required: ["project_name", "report", "runs", "sources", "intelligence"], additionalProperties: true }),
  });

  // Refine status-bearing core resources so generated SDKs expose finite states.
  if (schemas.AccountResource?.properties?.status) schemas.AccountResource.properties.status.enum = accountStatuses;
  if (schemas.BatchSummaryResource?.properties?.status) schemas.BatchSummaryResource.properties.status.enum = batchStatuses;
  if (schemas.RunResource?.properties?.status) schemas.RunResource.properties.status.enum = runStatuses;
  if (schemas.WebhookEventResource?.properties?.status) {
    schemas.WebhookEventResource.properties.status.enum = ["pending", "delivering", "delivered", "failed"];
  }

  return document;
}
