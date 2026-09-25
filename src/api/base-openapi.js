// 两个口径不能混用：
//   PROVIDERS()   = 平台码（doubao / qianwen），调用方在 provider / platform 字段里传的值。
//   ADAPTER_IDS() = 适配器 id（doubao-web / qianwen-web），GET /v1/providers 里报的 id。
// 之前只用前者描述「有哪些通道」，而 provider 是全局状态、adapter 才是可选择项，两者混用会让
// 文档里的枚举和调用方实际要传的值对不上 —— 那种分叉在联调时表现为「照文档传了却被拒」。
import {
  defaultProviderId as DEFAULT_PROVIDER,
  listProviderAdapters,
  supportedProviderIds as PROVIDERS,
} from "../providers/index.js";

const ADAPTER_IDS = () => listProviderAdapters().map((entry) => entry.id);
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
          provider: {
            type: "string",
            enum: PROVIDERS(),
            default: DEFAULT_PROVIDER(),
            description:
              "Adapter id, not just the platform. An anonymous lane is a separate adapter sharing the platform (`doubao-anonymous` collects from `doubao`), so this field decides the observation surface the account will produce.",
          },
          label: { type: ["string", "null"] },
          account_slots: {
            type: "integer",
            minimum: 1,
            maximum: 4,
            description:
              "How many browsers this account may run at the same time. Defaults to the server's ONEGL_ACCOUNT_SLOTS. Each slot holds its own browser process, page and fingerprint, so the platform sees N independent visitors rather than one session issuing parallel prompts.",
          },
          acknowledge_concurrency_risk: {
            type: "boolean",
            default: false,
            description:
              "Required to be true when the adapter needs a stored login (requires_stored_auth=true) and account_slots>1. Raising the slot count gives up the account-level serialization that keeps one login state from being hammered concurrently, so the caller has to say it knows. Anonymous lanes need no such acknowledgement: they have no login state to protect. Missing this answers 422 concurrency_risk_not_acknowledged.",
          },
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
          platform: {
            type: "string",
            enum: PROVIDERS(),
            default: DEFAULT_PROVIDER(),
            description: "Platform to collect on. The batch is single-platform, and the listed accounts must be bound to this same platform.",
          },
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
      // 契约测试要求成功响应给具体 schema，不接受裸 object —— 这条约束的价值就在这里：
      // 泛型 schema 会让调用方无法从文档判断字段是否存在，只能靠试。
      ProviderAdapterResource: {
        type: "object",
        required: ["id", "provider", "model", "access", "requires_stored_auth"],
        properties: {
          id: { type: "string", description: "Adapter id, e.g. doubao-web." },
          provider: { type: "string", enum: PROVIDERS(), description: "Platform the adapter collects from." },
          model: { type: "string" },
          access: { type: "string", enum: ["scraped", "official_api"] },
          requires_stored_auth: {
            type: "boolean",
            description: "false 表示匿名通道：不需要绑定登录态，也不吃账号级每日/每小时额度。",
          },
        },
        additionalProperties: true,
      },
      CapabilityResource: {
        type: "object",
        required: ["providers", "worker", "notes"],
        properties: {
          providers: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "provider", "requires_stored_auth", "max_slots", "enabled"],
              properties: {
                id: { type: "string" },
                provider: { type: "string", enum: PROVIDERS() },
                requires_stored_auth: { type: "boolean" },
                max_slots: {
                  type: "integer",
                  minimum: 1,
                  maximum: 4,
                  description: "同一账号可同时运行的浏览器数。",
                },
                enabled: {
                  type: "boolean",
                  description: "运行期事实：false 表示这条通道在当前实例上尚未开启，调用方应置灰而不是试错。",
                },
              },
              additionalProperties: true,
            },
          },
          worker: {
            type: "object",
            required: ["account_slots_default", "account_parallelism"],
            properties: {
              account_slots_default: { type: "integer", minimum: 1, maximum: 4 },
              account_parallelism: { type: "integer", minimum: 1 },
            },
            additionalProperties: true,
          },
          notes: { type: "array", items: { type: "string" } },
        },
        additionalProperties: true,
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
        description:
          "Lists the collection adapters this instance has registered, which is exactly the set of platforms a Task can execute on. Provider identity stays explicit so every measurement remains attributable to the surface that produced it. Note that `id` and `provider` differ for an anonymous surface: `doubao-anonymous` is a separate adapter that shares the `doubao` platform, so a client may run both a signed-in lane and an anonymous lane against the same platform without them being confused for one observation surface. `requires_stored_auth=false` marks the anonymous lanes.",
        responses: {
          200: jsonResponse("Provider adapters", {
            type: "object",
            required: ["data"],
            properties: { data: { type: "array", items: { $ref: "#/components/schemas/ProviderAdapterResource" } } },
            additionalProperties: true,
          }),
        },
      },
    },
    "/v1/capabilities": {
      get: {
        summary: "Read what this instance currently supports",
        description:
          "Probe for integration: `providers` says which lanes exist and whether each is switched on *right now*, `worker` reports the concurrency defaults. `enabled` is a runtime fact rather than a capability declaration — an anonymous lane whose feature flag is off answers `enabled=false` here, so a caller can grey the option out instead of discovering the refusal by creating an account and failing. Concurrency is reported as `max_slots`, the number of browsers one account may run at the same time. A lane with `requires_stored_auth=true` using more than one slot gives up the account-level serialization that keeps a login state from being hammered concurrently, which is why account creation demands an explicit acknowledgement in that case.",
        responses: {
          200: jsonResponse("Instance capabilities", {
            type: "object",
            required: ["data"],
            properties: { data: { $ref: "#/components/schemas/CapabilityResource" } },
            additionalProperties: true,
          }),
        },
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
    "/v1/accounts/{accountId}": {
      parameters: [
        {
          name: "accountId",
          in: "path",
          required: true,
          description: "Tenant account alias, i.e. the account_id returned by GET /v1/accounts (the upstream external_id), not an internal key",
          schema: { type: "string", minLength: 1 },
        },
      ],
      delete: {
        summary: "Reclaim a tenant account: soft disable, drop login state, retire its worker",
        description:
          "Soft delete only: the accounts row is flipped to enabled=false / status=disabled and both the accounts row and the service_account_bindings row are kept, because historical runs are attributed by internal account key and deleting rows would make history untraceable. The account's Playwright storageState files (plaintext and encrypted) are removed from disk, and the resident collection worker for that account is retired by the next 60s account sweep without a process restart. Per-account Redis queues and already-scheduled monitor plans are not deleted: a later plan run for this account fails closed on account status. Idempotent: a repeated call returns 200 with reclaimed=false and storage_state_removed=false. reclaimed_at is sourced from accounts.updated_at because the accounts table has no dedicated reclaim column; it is null when this call changed nothing.",
        responses: { 200: jsonResponse("Account reclaim result") },
      },
    },
    "/v1/accounts/{accountId}/reactivate": {
      parameters: [
        {
          name: "accountId",
          in: "path",
          required: true,
          description: "Tenant account alias, i.e. the account_id returned by GET /v1/accounts (the upstream external_id), not an internal key",
          schema: { type: "string", minLength: 1 },
        },
      ],
      post: {
        summary: "Reactivate a reclaimed tenant account",
        description:
          "Inverse of DELETE /v1/accounts/{accountId}: flips the accounts row to enabled=true / status=login_required / storage_state_present=false and never touches service_account_bindings or the account's other columns. Reactivation is not login restoration: the reclaimed Playwright storageState files are gone for good, so the account answers login_required and has to be scanned in again through POST /v1/accounts/{accountId}/auth-sessions before it can run. It is deliberately not set to healthy, because healthy would mark the account executable without any valid login state. There is no worker operation here: the resident worker comes back on its own, since the collection process re-reads accounts.enabled=true on its 60s account sweep. Idempotent: an account that is already enabled and not disabled is returned unchanged with reactivated=false, and its status is never downgraded to login_required.",
        responses: { 200: jsonResponse("Account reactivation result") },
      },
    },
    "/v1/accounts/{accountId}/inflight": {
      parameters: [{ name: "accountId", in: "path", required: true, schema: { type: "string", minLength: 1 } }],
      get: {
        summary: "Read whether a tenant account can be reclaimed safely",
        description:
          "Read-only pre-reclaim gate: no database write, no queue mutation, no worker shutdown. queue counts are the BullMQ job counts of this account's own queue (one queue per account key, default prefix onegl-run-<account_key>); referencing counts the enabled SaaS schedules and the enabled monitoring plans that still list this account in their account_ids, because an enabled plan keeps materializing batches into that account queue after the account is soft-deleted. reclaim_safe is computed server-side and is true only when every one of those counts is 0. Any count that cannot be observed answers 503 queue_unavailable instead of 0: a silently zero queue would be read as permission to reclaim, and reclaiming is irreversible. Note that this covers work already inside Redis plus enabled references only; it does not cover batches that were created but not started yet.",
        responses: { 200: jsonResponse("Account in-flight state") },
      },
    },
    "/v1/accounts/{accountId}/auth-sessions": {
      parameters: [
        { name: "accountId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "provider",
          in: "query",
          required: false,
          schema: { type: "string", enum: PROVIDERS() },
          description: "Disambiguates an account id that is bound on more than one platform. Omit when the id is unique to one platform; send it when the call answers ambiguous_account_provider.",
        },
      ],
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
