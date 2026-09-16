const jsonResponse = (description, schema = { type: "object" }) => ({
  description,
  content: { "application/json": { schema } },
});

const idParameter = (name, description) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "integer", minimum: 1 },
});

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "OneGl Service API",
    version: "0.4.0",
    description:
      "China-first server-to-server GEO measurement and intelligence API focused on Doubao Web. It supports tenant-scoped API clients, conservative account-connect sessions, recurring daily/weekly Doubao monitoring, signed webhooks, competitor benchmarking, query fan-out, longitudinal visibility/share-of-voice trends, citation stability, and observable cited-page content signals. Recurring monitoring only creates ordinary batches: the existing account pacing, quotas, cooldowns, verification fail-closed behavior and retry rules remain the execution source of truth. Browser cookies/storageState and arbitrary browser-control primitives are never exposed.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
    },
    schemas: {
      Error: {
        type: "object",
        properties: { error: { type: "string" }, message: { type: "string" }, details: {} },
        required: ["error", "message"],
      },
      ProjectCreate: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1 },
          external_id: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          target_brand: { type: ["string", "null"] },
          keywords: { type: "array", maxItems: 5000, items: { type: "string" } },
          category: { type: ["string", "null"] },
        },
      },
      KeywordCreate: {
        type: "object",
        required: ["keywords"],
        properties: {
          keywords: { type: "array", minItems: 1, maxItems: 5000, items: { type: "string" } },
          category: { type: ["string", "null"] },
        },
      },
      CompetitorUpsert: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          aliases: { type: "array", items: { type: "string" }, default: [] },
          domains: { type: "array", items: { type: "string" }, default: [] },
          exclude_patterns: { type: "array", items: { type: "string" }, default: [] },
          enabled: { type: "boolean", default: true },
        },
      },
      MonitorPlanCreate: {
        type: "object",
        required: ["name", "cadence", "accounts"],
        properties: {
          name: { type: "string", minLength: 1 },
          cadence: { type: "string", enum: ["daily", "weekly"] },
          time_zone: { type: "string", default: "Asia/Shanghai", examples: ["Asia/Shanghai"] },
          local_time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$", default: "09:00" },
          weekday: { type: ["integer", "null"], minimum: 1, maximum: 7, description: "ISO weekday, Monday=1. Required for weekly cadence." },
          size: { type: ["integer", "null"], minimum: 1, maximum: 10000, description: "Null means all currently enabled prompts." },
          method: { type: "string", enum: ["stratified", "random"], default: "stratified" },
          repeats: { type: "integer", minimum: 1, maximum: 100, default: 1 },
          accounts: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
          enabled: { type: "boolean", default: true },
        },
      },
      AccountCreate: {
        type: "object",
        required: ["account_id"],
        properties: {
          account_id: { type: "string", minLength: 1 },
          provider: { type: "string", enum: ["doubao"], default: "doubao" },
          label: { type: ["string", "null"] },
        },
      },
      BatchCreate: {
        type: "object",
        required: ["project_id", "accounts"],
        properties: {
          project_id: { type: "integer", minimum: 1 },
          name: { type: ["string", "null"] },
          size: { type: ["integer", "null"], minimum: 1, maximum: 10000 },
          method: { type: "string", enum: ["stratified", "random"], default: "stratified" },
          seed: { type: ["string", "null"] },
          accounts: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
          repeats: { type: "integer", minimum: 1, maximum: 100, default: 1 },
          start: { type: "boolean", default: false },
        },
      },
      TenantCreate: {
        type: "object",
        required: ["slug"],
        properties: { slug: { type: "string" }, name: { type: "string" } },
      },
      ClientCreate: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          scopes: { type: "array", items: { type: "string" } },
          expires_at: { type: ["string", "null"], format: "date-time" },
        },
      },
      WebhookCreate: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri" },
          event_types: { type: "array", items: { type: "string" }, default: ["*"] },
          description: { type: ["string", "null"] },
        },
      },
    },
    responses: {
      BadRequest: jsonResponse("Invalid request", { $ref: "#/components/schemas/Error" }),
      Unauthorized: jsonResponse("Missing or invalid API credentials", { $ref: "#/components/schemas/Error" }),
      Forbidden: jsonResponse("Credential lacks the required scope", { $ref: "#/components/schemas/Error" }),
      NotFound: jsonResponse("Resource not found", { $ref: "#/components/schemas/Error" }),
      Conflict: jsonResponse("Resource cannot perform the requested operation in its current state", { $ref: "#/components/schemas/Error" }),
    },
  },
  security: [{ bearerAuth: [] }, { apiKey: [] }],
  paths: {
    "/healthz": { get: { security: [], summary: "Service health", responses: { 200: jsonResponse("Service health") } } },
    "/openapi.json": { get: { security: [], summary: "OpenAPI document", responses: { 200: jsonResponse("OpenAPI 3.1 document") } } },

    "/v1/admin/tenants": {
      get: { summary: "List tenants (master key)", responses: { 200: jsonResponse("Tenants"), 403: { $ref: "#/components/responses/Forbidden" } } },
      post: {
        summary: "Create/update tenant (master key)",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TenantCreate" } } } },
        responses: { 201: jsonResponse("Tenant"), 403: { $ref: "#/components/responses/Forbidden" } },
      },
    },
    "/v1/admin/tenants/{tenantId}/clients": {
      parameters: [idParameter("tenantId", "Tenant ID")],
      get: { summary: "List tenant API clients (master key)", responses: { 200: jsonResponse("API clients") } },
      post: {
        summary: "Create tenant API client; secret returned once (master key)",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ClientCreate" } } } },
        responses: { 201: jsonResponse("API client with one-time api_key") },
      },
    },
    "/v1/admin/clients/{clientId}": {
      parameters: [idParameter("clientId", "API client ID")],
      delete: { summary: "Revoke API client (master key)", responses: { 200: jsonResponse("Revoked") } },
    },

    "/v1/providers": {
      get: {
        summary: "List configured provider adapter types",
        description: "Doubao Web is the current product measurement surface. Provider identity remains explicit so measurements are auditable.",
        responses: { 200: jsonResponse("Provider adapters") },
      },
    },

    "/v1/projects": {
      get: { summary: "List tenant projects", responses: { 200: jsonResponse("Projects") } },
      post: {
        summary: "Create tenant project",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ProjectCreate" } } } },
        responses: { 201: jsonResponse("Project") },
      },
    },
    "/v1/projects/{projectId}": {
      parameters: [idParameter("projectId", "Project ID")],
      get: { summary: "Get tenant project", responses: { 200: jsonResponse("Project"), 404: { $ref: "#/components/responses/NotFound" } } },
    },
    "/v1/projects/{projectId}/keywords": {
      parameters: [idParameter("projectId", "Project ID")],
      get: { summary: "List project keywords", responses: { 200: jsonResponse("Keywords") } },
      post: {
        summary: "Add/revive project keywords",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/KeywordCreate" } } } },
        responses: { 201: jsonResponse("Keyword import result") },
      },
    },
    "/v1/projects/{projectId}/competitors": {
      parameters: [idParameter("projectId", "Project ID")],
      get: { summary: "List competitors used for share-of-voice analysis", responses: { 200: jsonResponse("Competitors") } },
      post: {
        summary: "Create or replace competitor matching rules",
        description: "Brand and competitor mentions are re-derived from stored historical answers using current project rules, so rule changes immediately apply to the intelligence view without rewriting captured evidence.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CompetitorUpsert" } } } },
        responses: { 201: jsonResponse("Competitor") },
      },
    },
    "/v1/projects/{projectId}/competitors/{competitorId}": {
      parameters: [idParameter("projectId", "Project ID"), idParameter("competitorId", "Competitor ID")],
      delete: { summary: "Delete competitor matching rules", responses: { 200: jsonResponse("Deleted") } },
    },
    "/v1/projects/{projectId}/monitor-plans": {
      parameters: [idParameter("projectId", "Project ID")],
      get: {
        summary: "List recurring Doubao monitoring plans",
        responses: { 200: jsonResponse("Monitoring plans") },
      },
      post: {
        summary: "Create a daily or weekly Doubao monitoring plan",
        description: "A due occurrence creates an ordinary sampling batch. The monitor worker does not override account quotas, cooldowns, verification/access blocks or safe retry rules.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/MonitorPlanCreate" } } } },
        responses: { 201: jsonResponse("Monitoring plan"), 409: { $ref: "#/components/responses/Conflict" } },
      },
    },
    "/v1/monitor-plans/{monitorPlanId}": {
      parameters: [idParameter("monitorPlanId", "Monitoring plan ID")],
      get: { summary: "Get a recurring Doubao monitoring plan", responses: { 200: jsonResponse("Monitoring plan") } },
      patch: {
        summary: "Update/pause/resume a recurring Doubao monitoring plan",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        responses: { 200: jsonResponse("Updated monitoring plan") },
      },
      delete: { summary: "Delete monitoring plan; historical batches remain", responses: { 200: jsonResponse("Deleted") } },
    },
    "/v1/monitor-plans/{monitorPlanId}/executions": {
      parameters: [
        idParameter("monitorPlanId", "Monitoring plan ID"),
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
      ],
      get: { summary: "List scheduled monitoring occurrences and linked batches", responses: { 200: jsonResponse("Monitoring executions") } },
    },
    "/v1/projects/{projectId}/intelligence": {
      parameters: [
        idParameter("projectId", "Project ID"),
        { name: "days", in: "query", description: "Rolling lookback in days", schema: { type: "integer", minimum: 1, maximum: 365, default: 30 } },
      ],
      get: {
        summary: "Get longitudinal Doubao GEO intelligence for a project",
        description: "Aggregates valid Doubao runs across batches in the rolling window. Includes daily visibility/share-of-voice trends, query fan-out, citation stability, and sourceContent: observable structures and brand evidence from actually cited pages when page evidence has been collected. Source-content traits are reported as correlations, not as Doubao ranking/citation causes.",
        responses: { 200: jsonResponse("Project GEO intelligence"), 404: { $ref: "#/components/responses/NotFound" } },
      },
    },

    "/v1/accounts": {
      get: {
        summary: "List tenant execution accounts",
        description: "Returns derived operational state only; cookies/storageState are never returned.",
        responses: { 200: jsonResponse("Accounts") },
      },
      post: {
        summary: "Register a tenant account alias",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AccountCreate" } } } },
        responses: { 201: jsonResponse("Account binding") },
      },
    },
    "/v1/accounts/{accountId}/auth-sessions": {
      parameters: [{ name: "accountId", in: "path", required: true, schema: { type: "string" } }],
      post: {
        summary: "Start constrained remote login session",
        description: "Starts an isolated browser session and exposes screenshots/status only. No arbitrary browser-control endpoint is provided.",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { ttl_minutes: { type: "integer", minimum: 1 } } } } } },
        responses: { 202: jsonResponse("Auth session") },
      },
    },
    "/v1/auth-sessions/{authSessionId}": {
      parameters: [{ name: "authSessionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: { summary: "Get remote auth session state", responses: { 200: jsonResponse("Auth session") } },
    },
    "/v1/auth-sessions/{authSessionId}/screenshot": {
      parameters: [{ name: "authSessionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: { summary: "Get current login screenshot", responses: { 200: { description: "PNG screenshot", content: { "image/png": { schema: { type: "string", contentEncoding: "binary" } } } } } },
    },
    "/v1/auth-sessions/{authSessionId}/cancel": {
      parameters: [{ name: "authSessionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      post: { summary: "Cancel remote auth session", responses: { 200: jsonResponse("Cancelled") } },
    },

    "/v1/batches": {
      get: {
        summary: "List tenant batches",
        parameters: [
          { name: "project_id", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        ],
        responses: { 200: jsonResponse("Batches") },
      },
      post: {
        summary: "Create sampling batch",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/BatchCreate" } } } },
        responses: { 201: jsonResponse("Batch"), 409: { $ref: "#/components/responses/Conflict" } },
      },
    },
    "/v1/batches/{batchId}": {
      parameters: [idParameter("batchId", "Batch ID")],
      get: { summary: "Get batch progress", responses: { 200: jsonResponse("Batch progress"), 404: { $ref: "#/components/responses/NotFound" } } },
    },
    "/v1/batches/{batchId}/start": {
      parameters: [idParameter("batchId", "Batch ID")],
      post: { summary: "Enqueue batch", responses: { 202: jsonResponse("Batch enqueued"), 409: { $ref: "#/components/responses/Conflict" } } },
    },
    "/v1/batches/{batchId}/stop": {
      parameters: [idParameter("batchId", "Batch ID")],
      post: { summary: "Stop queued/running batch", responses: { 200: jsonResponse("Batch stopped") } },
    },
    "/v1/batches/{batchId}/runs": {
      parameters: [idParameter("batchId", "Batch ID")],
      get: { summary: "List batch runs", responses: { 200: jsonResponse("Runs") } },
    },
    "/v1/batches/{batchId}/report": {
      parameters: [idParameter("batchId", "Batch ID")],
      get: { summary: "Get batch analytics report", responses: { 200: jsonResponse("Report") } },
    },
    "/v1/batches/{batchId}/intelligence": {
      parameters: [idParameter("batchId", "Batch ID")],
      get: {
        summary: "Get auditable Doubao GEO intelligence for a batch",
        description: "Returns visibility, competitor share of voice, query fan-out, citation source stability, prompt gaps, deterministic opportunity candidates, and observable cited-page sourceContent. Source-content traits are explicitly non-causal.",
        responses: { 200: jsonResponse("Batch GEO intelligence"), 404: { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/v1/runs/{runId}": {
      parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", pattern: "^run_[A-Za-z0-9_-]+$" } }],
      get: { summary: "Get run with citations", responses: { 200: jsonResponse("Run and citations") } },
    },

    "/v1/webhooks": {
      get: { summary: "List webhook endpoints", responses: { 200: jsonResponse("Webhooks") } },
      post: {
        summary: "Create signed webhook endpoint",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookCreate" } } } },
        responses: { 201: jsonResponse("Webhook endpoint and derived signing secret") },
      },
    },
    "/v1/webhooks/{webhookId}": {
      parameters: [idParameter("webhookId", "Webhook endpoint ID")],
      delete: { summary: "Delete webhook endpoint", responses: { 200: jsonResponse("Deleted") } },
    },
    "/v1/webhooks/test": { post: { summary: "Queue test webhook event", responses: { 202: jsonResponse("Webhook event") } } },
    "/v1/webhook-events": { get: { summary: "List recent webhook delivery events", responses: { 200: jsonResponse("Events") } } },
  },
};
