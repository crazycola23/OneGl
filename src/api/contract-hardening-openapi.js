import { defaultProviderId as DEFAULT_PROVIDER, supportedProviderIds as PROVIDERS } from "../providers/index.js";
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

const envelope = (schema) => ({
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: schema },
});

const arrayOf = (ref) => ({ type: "array", items: { $ref: ref } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

const jsonResponse = (description, schema) => ({
  description,
  content: { "application/json": { schema } },
});

const jsonEnvelopeResponse = (description, schema) => jsonResponse(description, envelope(schema));

const nullableDateTime = { type: ["string", "null"], format: "date-time" };

const coreSchemas = {
  HealthResource: {
    type: "object",
    additionalProperties: false,
    required: ["service", "status", "database", "queue", "auth", "webhooks", "remote_auth"],
    properties: {
      service: { type: "string", const: "onegl-api" },
      status: { type: "string", enum: ["ok", "degraded"] },
      database: {
        type: "object",
        required: ["ready"],
        properties: { ready: { type: "boolean" }, message: { type: "string" } },
        additionalProperties: true,
      },
      queue: { type: "object", required: ["configured"], properties: { configured: { type: "boolean" } }, additionalProperties: true },
      auth: { type: "object", additionalProperties: true },
      webhooks: { type: "object", additionalProperties: true },
      remote_auth: { type: "object", additionalProperties: true },
    },
  },
  ReadinessResource: {
    type: "object",
    additionalProperties: false,
    required: ["service", "status", "ready", "production", "checks", "advisory"],
    properties: {
      service: { type: "string" },
      status: { type: "string", enum: ["ready", "not_ready"] },
      ready: { type: "boolean" },
      production: { type: "boolean" },
      checks: { type: "object", additionalProperties: { type: "object", additionalProperties: true } },
      advisory: { type: "object", additionalProperties: { type: "object", additionalProperties: true } },
    },
  },
  OpenApiDocumentResource: {
    type: "object",
    required: ["openapi", "info", "paths"],
    properties: {
      openapi: { type: "string", const: "3.1.0" },
      info: { type: "object", additionalProperties: true },
      paths: { type: "object", additionalProperties: true },
    },
    additionalProperties: true,
  },
  TenantResource: {
    type: "object",
    required: ["id", "slug", "name", "enabled", "created_at", "updated_at"],
    properties: {
      id: { type: "integer", minimum: 1 },
      slug: { type: "string" },
      name: { type: "string" },
      enabled: { type: "boolean" },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
      projects: { type: ["integer", "string", "null"] },
      accounts: { type: ["integer", "string", "null"] },
      api_clients: { type: ["integer", "string", "null"] },
    },
    additionalProperties: false,
  },
  ApiClientResource: {
    type: "object",
    required: ["id", "tenant_id", "name", "key_prefix", "scopes", "enabled"],
    properties: {
      id: { type: "integer", minimum: 1 },
      tenant_id: { type: "integer", minimum: 1 },
      name: { type: "string" },
      key_prefix: { type: "string" },
      scopes: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" },
      api_key: { type: "string", description: "Returned once when a client is created." },
      last_used_at: nullableDateTime,
      expires_at: nullableDateTime,
      created_at: { type: ["string", "null"], format: "date-time" },
      revoked_at: nullableDateTime,
    },
    additionalProperties: false,
  },
  ProviderResource: {
    type: "object",
    properties: {
      provider: { type: "string", enum: PROVIDERS() },
      name: { type: "string" },
      enabled: { type: "boolean" },
    },
    additionalProperties: true,
  },
  ProjectResource: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string" },
      external_id: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      target_brand: { type: ["string", "null"] },
      brand_aliases: { type: "array", items: { type: "string" } },
      brand_product_aliases: { type: "array", items: { type: "string" } },
      brand_exclude_patterns: { type: "array", items: { type: "string" } },
      pool_size: { type: ["integer", "string", "null"] },
      pool_enabled: { type: ["integer", "string", "null"] },
      batch_count: { type: ["integer", "string", "null"] },
      created_at: { type: ["string", "null"], format: "date-time" },
      updated_at: { type: ["string", "null"], format: "date-time" },
      keywords: { type: "array", items: { $ref: "#/components/schemas/KeywordResource" } },
    },
    additionalProperties: true,
  },
  KeywordResource: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      project_id: { type: "integer", minimum: 1 },
      keyword: { type: "string" },
      category: { type: ["string", "null"] },
      enabled: { type: "boolean" },
      created_at: { type: ["string", "null"], format: "date-time" },
      updated_at: { type: ["string", "null"], format: "date-time" },
    },
    additionalProperties: true,
  },
  KeywordImportResource: { type: "object", additionalProperties: true },
  CompetitorResource: {
    type: "object",
    required: ["id", "project_id", "name"],
    properties: {
      id: { type: "integer", minimum: 1 },
      project_id: { type: "integer", minimum: 1 },
      name: { type: "string" },
      aliases: { type: "array", items: { type: "string" } },
      domains: { type: "array", items: { type: "string" } },
      exclude_patterns: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" },
    },
    additionalProperties: true,
  },
  AccountResource: {
    type: "object",
    properties: {
      binding_id: { type: "integer", minimum: 1 },
      account_id: { type: "string" },
      provider: { type: "string", enum: PROVIDERS() },
      label: { type: ["string", "null"] },
      enabled: { type: "boolean" },
      status: { type: "string" },
      cooldown_until: nullableDateTime,
      last_run_at: nullableDateTime,
      storage_state_present: { type: "boolean" },
      created_at: { type: ["string", "null"], format: "date-time" },
      updated_at: { type: ["string", "null"], format: "date-time" },
    },
    additionalProperties: true,
  },
  AccountReclaimResource: {
    type: "object",
    additionalProperties: false,
    required: [
      "account_id",
      "provider",
      "reclaimed",
      "reclaimed_at",
      "storage_state_removed",
      "storage_state_files_removed",
      "enabled",
      "status",
      "reclaim_marked_by",
    ],
    properties: {
      account_id: { type: "string" },
      provider: { type: "string", enum: PROVIDERS() },
      reclaimed: { description: "Whether this call actually flipped the account row", type: "boolean" },
      reclaimed_at: { description: "accounts.updated_at of this reclaim; null when this call changed nothing", ...nullableDateTime },
      storage_state_removed: { description: "Whether any on-disk storageState file was deleted", type: "boolean" },
      storage_state_files_removed: { type: "integer", minimum: 0, maximum: 2 },
      enabled: { type: "boolean", const: false },
      status: { type: "string", const: "disabled" },
      reclaim_marked_by: { description: "The accounts column carrying the reclaim timestamp", type: "string", const: "updated_at" },
    },
  },
  AccountReactivateResource: {
    type: "object",
    additionalProperties: false,
    required: ["account_id", "provider", "enabled", "status", "storage_state_present", "reactivated"],
    properties: {
      account_id: { type: "string" },
      provider: { type: "string", enum: PROVIDERS() },
      enabled: { description: "Always true after a successful reactivation; echoed from the row when nothing changed", type: "boolean" },
      status: {
        description: "login_required right after a real reactivation, because the reclaimed login state cannot be restored; a no-op call echoes the existing status instead of downgrading it",
        type: "string",
      },
      storage_state_present: { description: "Always false right after a real reactivation: the storageState files were deleted by the reclaim and are not recreated", type: "boolean" },
      reactivated: { description: "Whether this call actually flipped the account row out of its reclaimed state", type: "boolean" },
    },
  },
  AccountInflightResource: {
    type: "object",
    additionalProperties: false,
    required: ["account_id", "queue", "referencing", "reclaim_safe"],
    properties: {
      account_id: { description: "Tenant account alias, i.e. the account_id returned by GET /v1/accounts", type: "string" },
      queue: {
        description: "BullMQ job counts of this account's own per-account queue",
        type: "object",
        additionalProperties: false,
        required: ["waiting", "active", "delayed"],
        properties: {
          waiting: { type: "integer", minimum: 0 },
          active: { type: "integer", minimum: 0 },
          delayed: { description: "Includes jobs waiting out a retry backoff", type: "integer", minimum: 0 },
        },
      },
      referencing: {
        description: "Enabled SaaS schedules and enabled monitoring plans whose account_ids still list this account",
        type: "object",
        additionalProperties: false,
        required: ["enabled_schedules", "enabled_monitor_plans"],
        properties: {
          enabled_schedules: { type: "integer", minimum: 0 },
          enabled_monitor_plans: { description: "All enabled plans referencing the account, including the plan behind each schedule", type: "integer", minimum: 0 },
        },
      },
      reclaim_safe: {
        description: "True only when every queue and referencing count above is 0; an unobservable count answers 503 instead of being reported as 0",
        type: "boolean",
      },
    },
  },
  AuthSessionResource: {
    type: "object",
    required: ["id", "status"],
    properties: {
      id: { type: "string", format: "uuid" },
      account_id: { type: ["string", "null"] },
      status: { type: "string" },
      state_details: { type: "object", additionalProperties: true },
      created_at: { type: ["string", "null"], format: "date-time" },
      updated_at: { type: ["string", "null"], format: "date-time" },
      expires_at: nullableDateTime,
      completed_at: nullableDateTime,
    },
    additionalProperties: true,
  },
  BatchSummaryResource: {
    type: "object",
    required: ["id", "status"],
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: ["string", "null"] },
      provider: { type: "string", enum: PROVIDERS() },
      status: { type: "string" },
      project_id: { type: "integer", minimum: 1 },
      project_name: { type: "string" },
      sample_size: { type: ["integer", "null"], minimum: 0 },
      requested_jobs: { type: ["integer", "null"], minimum: 0 },
      completed_jobs: { type: ["integer", "null"], minimum: 0 },
      failed_jobs: { type: ["integer", "null"], minimum: 0 },
      skipped_jobs: { type: ["integer", "null"], minimum: 0 },
      created_at: { type: ["string", "null"], format: "date-time" },
      started_at: nullableDateTime,
      finished_at: nullableDateTime,
    },
    additionalProperties: true,
  },
  BatchDetailResource: { type: "object", additionalProperties: true },
  BatchProgressResource: { type: "object", additionalProperties: true },
  RunResource: {
    type: "object",
    properties: {
      local_run_id: { type: "string", pattern: "^run_[A-Za-z0-9_-]+$" },
      status: { type: "string" },
      provider: { type: "string", enum: PROVIDERS() },
      login_state: {
        type: "string",
        enum: ["account", "anonymous"],
        description: "Observation surface this run was collected from. Runs that predate the column report 'account'.",
      },
      answer_truncated: {
        type: "boolean",
        description: "The captured answer looks cut off mid-sentence: the platform was probably still writing when the run ended.",
      },
      project_id: { type: ["integer", "null"] },
      project_name: { type: ["string", "null"] },
      account_id: { type: ["string", "null"] },
      started_at: nullableDateTime,
      finished_at: nullableDateTime,
    },
    additionalProperties: true,
  },
  RunDetailResource: {
    type: "object",
    required: ["run", "citations"],
    properties: {
      run: { $ref: "#/components/schemas/RunResource" },
      citations: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    additionalProperties: false,
  },
  WebhookResource: {
    type: "object",
    required: ["id", "url", "event_types", "enabled"],
    properties: {
      id: { type: "integer", minimum: 1 },
      url: { type: "string", format: "uri" },
      event_types: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" },
      description: { type: ["string", "null"] },
      signing_secret: { type: "string", description: "Returned only when creating the endpoint." },
      created_at: { type: ["string", "null"], format: "date-time" },
      updated_at: { type: ["string", "null"], format: "date-time" },
    },
    additionalProperties: false,
  },
  WebhookEventResource: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      event_type: { type: "string" },
      status: { type: "string" },
      attempts: { type: "integer", minimum: 0 },
      next_attempt_at: nullableDateTime,
      created_at: { type: ["string", "null"], format: "date-time" },
      delivered_at: nullableDateTime,
      last_error: { type: ["string", "null"] },
    },
    additionalProperties: true,
  },
  MonitorPlanResource: { type: "object", additionalProperties: true },
  MonitorExecutionResource: { type: "object", additionalProperties: true },
  IntelligenceResource: { type: "object", additionalProperties: true },
  ReportPayloadResource: { type: "object", additionalProperties: true },
  DeletedResource: {
    type: "object",
    additionalProperties: false,
    required: ["deleted"],
    properties: { deleted: { type: "boolean", const: true } },
  },
  RevokedResource: {
    type: "object",
    additionalProperties: false,
    required: ["revoked"],
    properties: { revoked: { type: "boolean", const: true } },
  },
};

const successSchemas = new Map([
  ["GET /v1/admin/tenants", arrayOf("#/components/schemas/TenantResource")],
  ["POST /v1/admin/tenants", ref("TenantResource")],
  ["GET /v1/admin/tenants/{tenantId}/clients", arrayOf("#/components/schemas/ApiClientResource")],
  ["POST /v1/admin/tenants/{tenantId}/clients", ref("ApiClientResource")],
  ["DELETE /v1/admin/clients/{clientId}", ref("RevokedResource")],
  ["GET /v1/providers", arrayOf("#/components/schemas/ProviderResource")],
  ["GET /v1/projects", arrayOf("#/components/schemas/ProjectResource")],
  ["POST /v1/projects", ref("ProjectResource")],
  ["GET /v1/projects/{projectId}", ref("ProjectResource")],
  ["GET /v1/projects/{projectId}/keywords", arrayOf("#/components/schemas/KeywordResource")],
  ["POST /v1/projects/{projectId}/keywords", ref("KeywordImportResource")],
  ["GET /v1/projects/{projectId}/competitors", arrayOf("#/components/schemas/CompetitorResource")],
  ["POST /v1/projects/{projectId}/competitors", ref("CompetitorResource")],
  ["DELETE /v1/projects/{projectId}/competitors/{competitorId}", ref("DeletedResource")],
  ["GET /v1/projects/{projectId}/monitor-plans", arrayOf("#/components/schemas/MonitorPlanResource")],
  ["POST /v1/projects/{projectId}/monitor-plans", ref("MonitorPlanResource")],
  ["GET /v1/monitor-plans/{monitorPlanId}", ref("MonitorPlanResource")],
  ["PATCH /v1/monitor-plans/{monitorPlanId}", ref("MonitorPlanResource")],
  ["DELETE /v1/monitor-plans/{monitorPlanId}", ref("DeletedResource")],
  ["GET /v1/monitor-plans/{monitorPlanId}/executions", arrayOf("#/components/schemas/MonitorExecutionResource")],
  ["GET /v1/projects/{projectId}/intelligence", ref("IntelligenceResource")],
  ["GET /v1/accounts", arrayOf("#/components/schemas/AccountResource")],
  ["POST /v1/accounts", ref("AccountResource")],
  ["DELETE /v1/accounts/{accountId}", ref("AccountReclaimResource")],
  ["POST /v1/accounts/{accountId}/reactivate", ref("AccountReactivateResource")],
  ["GET /v1/accounts/{accountId}/inflight", ref("AccountInflightResource")],
  ["POST /v1/accounts/{accountId}/auth-sessions", ref("AuthSessionResource")],
  ["GET /v1/auth-sessions/{authSessionId}", ref("AuthSessionResource")],
  ["POST /v1/auth-sessions/{authSessionId}/cancel", ref("AuthSessionResource")],
  ["GET /v1/batches", arrayOf("#/components/schemas/BatchSummaryResource")],
  ["POST /v1/batches", ref("BatchDetailResource")],
  ["GET /v1/batches/{batchId}", ref("BatchProgressResource")],
  ["POST /v1/batches/{batchId}/start", ref("BatchProgressResource")],
  ["POST /v1/batches/{batchId}/stop", ref("BatchProgressResource")],
  ["GET /v1/batches/{batchId}/runs", arrayOf("#/components/schemas/RunResource")],
  ["GET /v1/batches/{batchId}/report", ref("ReportPayloadResource")],
  ["GET /v1/batches/{batchId}/intelligence", ref("IntelligenceResource")],
  ["GET /v1/runs/{runId}", ref("RunDetailResource")],
  ["GET /v1/webhooks", arrayOf("#/components/schemas/WebhookResource")],
  ["POST /v1/webhooks", ref("WebhookResource")],
  ["DELETE /v1/webhooks/{webhookId}", ref("DeletedResource")],
  ["POST /v1/webhooks/test", ref("WebhookEventResource")],
  ["GET /v1/webhook-events", arrayOf("#/components/schemas/WebhookEventResource")],
]);

const tagDescriptions = {
  Health: "Service liveness, readiness, and machine-readable API metadata.",
  Admin: "Master-key tenant and API-client administration.",
  Providers: "Measurement provider capabilities.",
  Projects: "Tenant projects and their configuration.",
  Keywords: "Project question and keyword pools.",
  Competitors: "Competitor matching rules used by GEO analytics.",
  Accounts: "Tenant execution accounts and constrained authentication sessions.",
  Batches: "Lower-level sampling batches.",
  Runs: "Individual provider runs and evidence.",
  Tasks: "Stable SaaS task resources.",
  Executions: "Stable SaaS execution resources.",
  Results: "Execution results and citations.",
  Reports: "Execution reports and historical report access.",
  Schedules: "Recurring SaaS task schedules.",
  Webhooks: "Webhook endpoints, events, and receiver contracts.",
  Monitoring: "Recurring lower-level monitoring plans.",
  Observability: "Operational API controls and response metadata.",
};

function tagFor(pathname) {
  if (["/healthz", "/readyz", "/openapi.json"].includes(pathname)) return "Health";
  if (pathname.startsWith("/v1/admin/")) return "Admin";
  if (pathname.startsWith("/v1/providers")) return "Providers";
  if (pathname.includes("/keywords")) return "Keywords";
  if (pathname.includes("/competitors")) return "Competitors";
  if (pathname.includes("/auth-sessions") || pathname.startsWith("/v1/accounts")) return "Accounts";
  if (pathname.startsWith("/v1/batches")) return "Batches";
  if (pathname.startsWith("/v1/runs")) return "Runs";
  if (pathname.startsWith("/v1/tasks")) return "Tasks";
  if (pathname.startsWith("/v1/executions")) return "Executions";
  if (pathname.startsWith("/v1/results")) return "Results";
  if (pathname.startsWith("/v1/reports")) return "Reports";
  if (pathname.includes("/schedules")) return "Schedules";
  if (pathname.includes("webhook")) return "Webhooks";
  if (pathname.includes("monitor-plans")) return "Monitoring";
  if (pathname.startsWith("/v1/projects")) return "Projects";
  return "Observability";
}

function pascal(value) {
  return String(value)
    .replace(/[{}]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function operationIdFor(method, pathname) {
  if (pathname === "/healthz") return "getHealth";
  if (pathname === "/readyz") return "getReadiness";
  if (pathname === "/openapi.json") return "getOpenApiDocument";
  const stem = pathname
    .replace(/^\/v1\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.startsWith("{") ? `By${pascal(segment)}` : pascal(segment))
    .join("");
  const prefix = { get: "get", post: "create", put: "replace", patch: "update", delete: "delete" }[method] ?? method;
  return `${prefix}${stem}`;
}

function isJsonResponse(response) {
  return Boolean(response?.content?.["application/json"]);
}

function firstSuccessResponse(operation) {
  return Object.entries(operation.responses ?? {}).find(([status]) => /^2\d\d$/.test(String(status)));
}

function attachCoreSuccessSchemas(document) {
  document.paths["/healthz"].get.responses["200"] = jsonResponse("Service health", ref("HealthResource"));
  document.paths["/readyz"] = {
    get: {
      security: [],
      summary: "Service readiness",
      description: "Checks database, migrations, queue, and production safety dependencies without exposing credentials or connection strings.",
      responses: {
        200: jsonResponse("Service is ready", ref("ReadinessResource")),
        503: jsonResponse("Service dependencies are not ready", ref("ReadinessResource")),
      },
    },
  };
  document.paths["/openapi.json"].get.responses["200"] = jsonResponse("OpenAPI 3.1 document", ref("OpenApiDocumentResource"));

  for (const [key, schema] of successSchemas) {
    const separator = key.indexOf(" ");
    const method = key.slice(0, separator).toLowerCase();
    const pathname = key.slice(separator + 1);
    const operation = document.paths?.[pathname]?.[method];
    if (!operation) continue;
    const success = firstSuccessResponse(operation);
    if (!success) continue;
    const [status, response] = success;
    if (!isJsonResponse(response)) continue;
    operation.responses[status] = jsonEnvelopeResponse(response.description ?? "Success", schema);
  }
}

function attachCommonErrors(document) {
  document.components.responses.ServiceUnavailable = jsonResponse("Service dependency unavailable", ref("Error"));

  for (const [pathname, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathname.startsWith("/v1")) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      operation.responses ??= {};
      operation.responses["401"] ??= { $ref: "#/components/responses/Unauthorized" };
      operation.responses["403"] ??= { $ref: "#/components/responses/Forbidden" };
      operation.responses["503"] ??= { $ref: "#/components/responses/ServiceUnavailable" };
      if (operation.requestBody && ["post", "put", "patch"].includes(method)) {
        operation.responses["400"] ??= { $ref: "#/components/responses/BadRequest" };
      }
      const hasPathId = /\{[^}]+\}/.test(pathname);
      if (hasPathId) operation.responses["404"] ??= { $ref: "#/components/responses/NotFound" };
    }
  }
}

function attachOperationMetadata(document) {
  const ids = new Set();
  const usedTags = new Set();
  for (const [pathname, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      const operationId = operation.operationId ?? operationIdFor(method, pathname);
      if (ids.has(operationId)) throw new Error(`duplicate OpenAPI operationId: ${operationId}`);
      ids.add(operationId);
      operation.operationId = operationId;
      operation.tags ??= [tagFor(pathname)];
      for (const tag of operation.tags) usedTags.add(tag);
      operation.description ??= operation.summary;
    }
  }
  document.tags = [...usedTags].sort().map((name) => ({ name, description: tagDescriptions[name] ?? `${name} API operations.` }));
}

function webhookReceiver(eventType) {
  return {
    post: {
      operationId: `receive${pascal(eventType)}Webhook`,
      tags: ["Webhooks"],
      summary: `Receive ${eventType} webhook`,
      description: `Receiver-side contract for the ${eventType} public SaaS webhook event. Verify the HMAC-SHA256 signature before processing the JSON body.`,
      parameters: [
        { name: "X-OneGl-Webhook-Id", in: "header", required: true, schema: { type: "string", pattern: "^evt_[a-f0-9]{32}$" } },
        { name: "X-OneGl-Webhook-Timestamp", in: "header", required: true, schema: { type: "string" } },
        { name: "X-OneGl-Webhook-Signature", in: "header", required: true, schema: { type: "string" } },
        { name: "X-OneGl-Webhook-Version", in: "header", required: true, schema: { type: "string", const: "1" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SaasWebhookEvent" },
            examples: { event: { value: { id: "evt_0123456789abcdef0123456789abcdef", type: eventType, occurred_at: "2026-09-17T00:00:00.000Z", data: {} } } },
          },
        },
      },
      responses: {
        200: { description: "Event accepted" },
        204: { description: "Event accepted with no response body" },
      },
    },
  };
}

function attachWebhooks(document) {
  const eventTypes = [
    "execution.completed",
    "execution.partial",
    "execution.failed",
    "execution.cancelled",
    "report.revision.ready",
    "account.action_required",
    "account.ready",
  ];
  document.webhooks = Object.fromEntries(eventTypes.map((eventType) => [eventType, webhookReceiver(eventType)]));
}

export function applyContractHardeningOpenApi(document) {
  document.info.license = { name: "MIT", identifier: "MIT" };
  document.info.description = `${document.info.description}\n\nContract source of truth: the generated openapi.json. All public operations carry stable operationId/tag metadata; additive changes remain within /v1 while breaking public contract changes require compatibility review.`;
  document.externalDocs = {
    description: "OneGl OpenAPI service design and SaaS production contract documentation",
    url: "https://github.com/crazycola23/OneGl/tree/main/docs",
  };
  Object.assign(document.components.schemas, coreSchemas);
  attachCoreSuccessSchemas(document);
  attachCommonErrors(document);
  attachOperationMetadata(document);
  attachWebhooks(document);
  return document;
}
