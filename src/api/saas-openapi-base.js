import { defaultProviderId as DEFAULT_PROVIDER, supportedProviderIds as PROVIDERS } from "../providers/index.js";
const commonHeaders = {
  "X-OneGl-API-Version": {
    description: "OpenAPI contract version served by this OneGl instance.",
    schema: { type: "string", example: "0.7.0" },
  },
  "Idempotency-Replayed": {
    description: "Present with value true when a successful response was replayed from Idempotency-Key storage.",
    schema: { type: "string", enum: ["true"] },
  },
};

const envelope = (schema) => ({
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: schema },
});

const paginatedEnvelope = (schema) => ({
  type: "object",
  additionalProperties: false,
  required: ["data", "meta"],
  properties: {
    data: schema,
    meta: { $ref: "#/components/schemas/PageMeta" },
  },
});

const json = (description, schema = { type: "object" }) => ({
  description,
  headers: commonHeaders,
  content: { "application/json": { schema: envelope(schema) } },
});

const pageJson = (description, itemSchema) => ({
  description,
  headers: commonHeaders,
  content: {
    "application/json": {
      schema: paginatedEnvelope({ type: "array", items: itemSchema }),
    },
  },
});

const body = (schema, example = undefined) => ({
  required: true,
  content: {
    "application/json": {
      schema,
      ...(example === undefined ? {} : { example }),
    },
  },
});

const stringId = (name, prefix) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", pattern: `^${prefix}_[a-f0-9]{32}$`, example: `${prefix}_0123456789abcdef0123456789abcdef` },
});

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description: "Recommended for create/execute requests. Reusing the same key with the same request replays the first response; reusing it with a different body returns idempotency_conflict.",
  schema: { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:-]+$" },
};

const paginationParameters = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
  { name: "cursor", in: "query", description: "Opaque next_cursor returned by the previous page.", schema: { type: "string" } },
];

const nullableDateTime = { type: ["string", "null"], format: "date-time" };
const LOGIN_STATES = ["account", "anonymous"];
const nullableLoginState = {
  type: ["string", "null"],
  enum: [...LOGIN_STATES, null],
  description: "Whether the run behind this result was observed from a signed-in account or the anonymous surface. Null while no run has been recorded for the assignment.",
};
const nullableAnswerTruncated = {
  type: ["boolean", "null"],
  description: "The captured answer looks cut off mid-sentence, so the platform was probably still writing when the run ended. Null while no run has been recorded. Do not average these rows into a mention or citation rate.",
};
// Orthogonal to answer_truncated: that one asks "does the text look complete", this one asks
// "what justified calling it complete". A platform that rewrites its answer block can hand back
// a whole sentence that is still an intermediate state, which the punctuation check cannot see.
const nullableAnswerCompletion = {
  type: ["string", "null"],
  enum: ["follow-up-chips", "length-stability-fallback", "timeout", "unknown", null],
  description: "How the end of the answer was decided. 'follow-up-chips' is the platform's own finished signal; 'length-stability-fallback' and 'timeout' are guesses and the answer may be cut at a sentence boundary, so separate or exclude those rows when computing rates. Null while no run has been recorded.",
};
const nullablePlatform = {
  type: ["string", "null"],
  enum: [...PROVIDERS(), null],
  description: "Platform the collection ran on, read from its own batch rather than the Task's platform list. Null only once the batch row itself is gone.",
};
const loginStates = {
  type: "array",
  maxItems: LOGIN_STATES.length,
  uniqueItems: true,
  items: { type: "string", enum: LOGIN_STATES },
  description: "Observation surfaces behind these numbers. Empty before any run is recorded; two entries mean account and anonymous samples are blended in one rate.",
};
const taskId = { type: "string", pattern: "^tsk_[a-f0-9]{32}$" };
const executionId = { type: "string", pattern: "^exe_[a-f0-9]{32}$" };
const resultId = { type: "string", pattern: "^res_[a-f0-9]{32}$" };
const reportId = { type: "string", pattern: "^rpt_[a-f0-9]{32}$" };
const groupId = { type: "string", pattern: "^grp_[a-f0-9]{32}$" };
const scheduleId = { type: "string", pattern: "^sch_[a-f0-9]{32}$" };

export function applySaasOpenApi(document) {
  document.info.version = "0.7.0";
  document.info.description = `${document.info.description}\n\nSaaS production contract: stable task/execution/result/report/schedule IDs sit above the internal project/batch/run model. v1 is additive: documented fields and meanings remain compatible within /v1; a breaking contract requires a new major API path. Mutating SaaS POST routes support Idempotency-Key, history lists use opaque cursor pagination, and stable SaaS webhook events use public IDs only.`;

  Object.assign(document.components.schemas, {
    SaasError: {
      type: "object",
      additionalProperties: false,
      required: ["error", "message"],
      properties: {
        error: {
          type: "string",
          description: "Stable machine-readable error code.",
          examples: ["invalid_request", "account_action_required", "idempotency_conflict", "task_not_found"],
        },
        message: { type: "string", description: "Human-readable diagnostic message." },
        details: { description: "Optional structured details. Do not parse message text when details are available." },
      },
    },
    PageMeta: {
      type: "object",
      additionalProperties: false,
      required: ["has_more", "next_cursor"],
      properties: {
        has_more: { type: "boolean" },
        next_cursor: { type: ["string", "null"], description: "Opaque cursor for the next page. Null means this is the last page." },
      },
    },
    TaskSamplingInput: {
      type: "object",
      additionalProperties: false,
      description: "Optional sampling overrides. Each field may be supplied independently.",
      properties: {
        method: { type: "string", enum: ["stratified", "random"], default: "stratified" },
        repeats: { type: "integer", minimum: 1, maximum: 100, default: 1 },
      },
    },
    TaskSampling: {
      type: "object",
      additionalProperties: false,
      required: ["method", "repeats"],
      properties: {
        method: { type: "string", enum: ["stratified", "random"] },
        repeats: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    TaskCreate: {
      type: "object",
      additionalProperties: false,
      required: ["name", "questions"],
      properties: {
        external_id: {
          type: ["string", "null"],
          maxLength: 255,
          description: "Optional caller-owned ID used by the SaaS to correlate this task with its own record.",
        },
        name: { type: "string", minLength: 1, maxLength: 200 },
        target_brand: { type: ["string", "null"], maxLength: 500 },
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 5000,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        platforms: {
          type: "array",
          minItems: 1,
          // The contract used to advertise up to 20 platforms while the server rejected
          // anything but exactly one, so a spec-compliant client could build a request that
          // could never succeed. One platform per task; multi-platform means one task each.
          maxItems: 1,
          uniqueItems: true,
          items: { type: "string", enum: PROVIDERS() },
          default: [DEFAULT_PROVIDER()],
        },
        account_ids: {
          type: "array",
          maxItems: 100,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          default: [],
        },
        sampling: { $ref: "#/components/schemas/TaskSamplingInput" },
      },
    },
    TaskResource: {
      type: "object",
      required: ["task_id", "name", "questions", "platforms", "account_ids", "sampling", "revision", "state", "execution_count", "created_at", "updated_at"],
      properties: {
        task_id: taskId,
        external_id: { type: ["string", "null"] },
        name: { type: "string" },
        target_brand: { type: ["string", "null"] },
        questions: { type: "array", items: { type: "string" } },
        platforms: { type: "array", items: { type: "string" } },
        account_ids: { type: "array", items: { type: "string" } },
        sampling: { $ref: "#/components/schemas/TaskSampling" },
        revision: { type: "integer", minimum: 1 },
        state: { type: "string", enum: ["active", "archived"] },
        execution_count: { type: "integer", minimum: 0 },
        latest_execution_id: { anyOf: [executionId, { type: "null" }] },
        created_at: { type: "string", format: "date-time" },
        updated_at: { type: "string", format: "date-time" },
      },
    },
    GeoReportPeriodInput: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      properties: {
        key: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
        label: { type: "string", maxLength: 100 },
        from: { type: "string", format: "date", description: "Inclusive local calendar date." },
        to: { type: "string", format: "date", description: "Inclusive local calendar date; the range may span at most 366 days." },
        time_zone: { type: "string", default: "Asia/Shanghai", description: "IANA time zone used to interpret the date boundaries." },
      },
    },
    /**
     * 报告请求里传入的品牌列表。
     *
     * 刻意不提供「从回答里猜品牌」的开关：猜测需要行业词表，而词表无法由用户维护。
     * 正确路径是调用方用 GET /v1/answers 抽样、交给自己的模型读出高频品牌，再传回这里。
     */
    ReportBrandInput: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        role: {
          type: "string",
          enum: ["own", "competitor", "unspecified"],
          default: "unspecified",
          description: "Label only; it is passed through to the report for grouping and does not change any metric.",
        },
        aliases: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 200 },
          description: "Alternate spellings. The name itself is always matched, so listing it again is harmless.",
        },
        product_aliases: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 200 },
          description: "Product or full-store-name variants, e.g. a brand written as 「思邈棠中式养生」 in answers but 「思邈棠」 elsewhere.",
        },
        exclude_patterns: {
          type: "array",
          maxItems: 20,
          items: { type: "string", maxLength: 200 },
          description: "Regular expressions masking contexts where an alias means something else.",
        },
      },
    },
    GeoReportBrandSummary: {
      type: "object",
      required: ["name", "role", "valid_answers", "mentioned_answers", "mention_count", "by_platform"],
      properties: {
        name: { type: "string" },
        role: { type: "string", enum: ["own", "competitor", "unspecified"] },
        match_terms: { type: "array", items: { type: "string" }, description: "Terms actually matched, for verification." },
        valid_answers: { type: "integer", minimum: 0, description: "Answers with text on this platform; the mention-rate denominator." },
        mentioned_answers: { type: "integer", minimum: 0 },
        mention_rate: { type: ["number", "null"], minimum: 0, maximum: 1 },
        mention_count: { type: "integer", minimum: 0, description: "Total mentions; one answer mentioning a brand twice counts twice." },
        platform_count: { type: "integer", minimum: 0 },
        platforms: { type: "array", items: { type: "string", enum: PROVIDERS() } },
        average_first_position: {
          type: ["number", "null"],
          minimum: 0,
          description: "Mean character offset of the first mention. Lower means the platform raised it earlier — a weak signal for emphasis, not a substitute for reading the text.",
        },
        by_platform: { type: "object", additionalProperties: { type: "object", additionalProperties: true } },
        examples: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      additionalProperties: true,
    },
    BrandMentionsResource: {
      type: "object",
      required: ["available", "answer_count", "excluded_answers", "truncated", "brand_count", "basis", "brands", "interpretation"],
      properties: {
        available: {
          type: "boolean",
          description: "False when no brand analysis was performed (no brands supplied, or no usable answers). Distinguishes 'not measured' from 'measured and not mentioned', whose brand list is empty but available is true.",
        },
        answer_count: { type: "integer", minimum: 0, description: "Answers that count toward mention-rate denominators." },
        excluded_answers: {
          type: "integer",
          minimum: 0,
          description: "Answers dropped before counting: blank, shorter than the minimum usable length (platform UI text such as '找到 1 篇资料'), or flagged as truncated by the platform. Reported so the denominator is auditable.",
        },
        truncated: {
          type: "boolean",
          description: "True when the answer count exceeded the per-report statistics limit; mention rates were computed on the earliest answers only.",
        },
        notes: {
          type: "array",
          items: { type: "string" },
          description: "Caveats affecting how the numbers above should be read.",
        },
        brand_count: { type: "integer", minimum: 0 },
        basis: { type: "string", const: "mentioned_answers_over_valid_answers" },
        brands: { type: "array", items: { $ref: "#/components/schemas/GeoReportBrandSummary" } },
        interpretation: { type: "object", additionalProperties: true },
      },
      additionalProperties: true,
    },
    ReportTheme: {
      type: "object",
      additionalProperties: false,
      description:
        "Optional customer branding for the HTML report: accent colour, logo, footer attribution. Invalid " +
        "values are dropped rather than failing report generation. The theme is stored in the snapshot, so the " +
        "rendered HTML and its content_hash stay consistent.",
      properties: {
        colors: {
          type: "object",
          additionalProperties: false,
          description: "Hex colours only. Anything else is ignored and the default is kept.",
          properties: {
            accent: { type: "string", pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", description: "Links, borders, highlights." },
            ink: { type: "string", pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", description: "Body text." },
            bg: { type: "string", pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", description: "Page background." },
            surface: { type: "string", pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$" },
            line: { type: "string", pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", description: "Borders and separators." },
            ok: { type: "string", pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$" },
            warn: { type: "string", pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$" },
            bad: { type: "string", pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$" },
          },
        },
        logo_url: {
          type: "string",
          maxLength: 2048,
          pattern: "^https?://",
          description: "Customer logo, http(s) only. Rendered above the report title; ignored when the URL is not http(s).",
        },
        logo_height: { type: "integer", minimum: 1, maximum: 64, default: 40 },
        logo_width: { type: ["integer", "null"], minimum: 1, maximum: 320 },
        footer_text: {
          type: "string",
          maxLength: 200,
          description: "Footer attribution, e.g. the agency or platform name. Defaults to 'OneGl · GEO 客户报告'.",
        },
      },
    },
    GeoCustomerReportCreate: {
      type: "object",
      additionalProperties: false,
      required: ["periods"],
      properties: {
        platforms: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
          items: { type: "string", enum: PROVIDERS() },
          description: "Defaults to the platforms configured on this Task.",
        },
        periods: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { $ref: "#/components/schemas/GeoReportPeriodInput" },
          description: "Ordered stages. Supplying multiple stages stores comparable snapshots in one report.",
        },
        format: { type: "string", const: "html", default: "html" },
        theme: {
          $ref: "#/components/schemas/ReportTheme",
          description: "Optional customer branding applied to the generated HTML.",
        },
        brands: {
          type: "array",
          maxItems: 50,
          items: { $ref: "#/components/schemas/ReportBrandInput" },
          description:
            "Brands to measure mention rate for. Supply your own list: read a stratified answer sample with " +
            "GET /v1/answers, have your model extract the high-frequency brands, then pass them here. " +
            "OneGl never guesses entity names and keeps no brand library. Omitting this field skips brand " +
            "analysis entirely rather than guessing.",
        },
      },
      description:
        "Target brand is NOT accepted here. Brand metrics read runs.brand_mentioned, which is fixed at collection " +
        "time; passing a brand to this endpoint would label the report with a name the numbers were never measured " +
        "against. To change the measured brand, configure it on the project/task and collect again.",
    },
    GeoReportPeriodSummary: {
      type: "object",
      additionalProperties: false,
      required: ["key", "label", "from", "to", "time_zone"],
      properties: {
        key: { type: "string" },
        label: { type: "string" },
        from: { type: "string", format: "date" },
        to: { type: "string", format: "date" },
        time_zone: { type: "string" },
      },
    },
    GeoCustomerReportResource: {
      type: "object",
      // task_id 与 group_id 恰好一个非空：单采集任务报告 vs 跨平台任务组报告。
      required: ["report_id", "scope_kind", "status", "format", "title", "generated_at", "platforms", "periods", "profile_version", "content_hash", "report_url", "html_url"],
      properties: {
        report_id: reportId,
        scope_kind: {
          type: "string",
          enum: ["task", "group"],
          description: "'task' for a single collection task; 'group' for a cross-platform report covering every platform in the task group.",
        },
        task_id: {
          type: ["string", "null"],
          description: "Set when scope_kind is 'task'; null otherwise.",
        },
        group_id: {
          anyOf: [groupId, { type: "null" }],
          description: "Set when scope_kind is 'group'; null otherwise.",
        },
        status: { type: "string", const: "ready" },
        format: { type: "string", const: "html" },
        title: { type: "string" },
        generated_at: { type: "string", format: "date-time" },
        platforms: { type: "array", items: { type: "string", enum: PROVIDERS() } },
        periods: { type: "array", items: { $ref: "#/components/schemas/GeoReportPeriodSummary" } },
        brands: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Brands this report measured, echoed from the request. Empty when none were supplied.",
        },
        brand_mentions: {
          type: "array",
          items: {
            type: "object",
            required: ["period_key", "platform", "answer_count", "brands"],
            properties: {
              period_key: { type: "string" },
              platform: { type: "string", enum: PROVIDERS() },
              answer_count: { type: "integer", minimum: 0 },
              brands: { type: "array", items: { $ref: "#/components/schemas/GeoReportBrandSummary" } },
            },
            additionalProperties: true,
          },
          description: "Per-platform mention statistics. Deterministic and reproducible; contains no conclusions.",
        },
        profile_version: { type: "string" },
        content_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        report_url: { type: "string" },
        html_url: { type: "string" },
      },
      additionalProperties: true,
    },
    /* 快照里各平台节点的真实结构。
     * 这些字段是调用方真正要消费的载荷，之前是裸 `additionalProperties: true`，
     * 等于没有任何类型保证 —— 生成出来的客户端拿不到补全，也无法在编译期发现
     * 字段被改名。字段名与 src/reporting/geo-customer-reports.js 的
     * platformMetrics() 返回值逐一对齐。 */
    GeoReportRunMetrics: {
      type: "object",
      description: "Run-level counts for one platform in one period.",
      required: ["valid_runs", "runs", "assignments", "success_rate"],
      properties: {
        assignments: { type: "integer", minimum: 0, description: "Platform assignments inside this period; unrun ones stay in the denominator." },
        runs: { type: "integer", minimum: 0 },
        valid_runs: { type: "integer", minimum: 0, description: "status in (success, partial) and conversation_reset_confirmed." },
        citation_valid_runs: { type: "integer", minimum: 0 },
        partial_runs: { type: "integer", minimum: 0 },
        failed_runs: { type: "integer", minimum: 0 },
        reset_unconfirmed_runs: { type: "integer", minimum: 0 },
        answers_with_text: { type: "integer", minimum: 0 },
        average_answer_characters: { type: ["number", "null"] },
        success_rate: { type: ["number", "null"], minimum: 0, maximum: 1 },
        brand_mentioned_runs: { type: ["integer", "null"], description: "Null when no target brand is configured; do not read 0 as 'not mentioned'." },
        brand_mention_rate: { type: ["number", "null"], minimum: 0, maximum: 1 },
      },
      additionalProperties: true,
    },
    GeoReportTrackedContent: {
      type: "object",
      description: "Coverage of the caller's tracked (target) articles. All rates are null until articles are configured.",
      required: ["configured", "configured_articles"],
      properties: {
        configured: { type: "boolean" },
        configured_articles: { type: "integer", minimum: 0 },
        cited_articles: { type: ["integer", "null"] },
        citations: { type: ["integer", "null"] },
        covered_runs: { type: ["integer", "null"] },
        coverage_rate: { type: ["number", "null"], minimum: 0, maximum: 1, description: "Answers that cited any tracked article / citation-valid answers." },
        article_coverage_rate: { type: ["number", "null"], minimum: 0, maximum: 1, description: "Tracked articles that were cited at least once / configured articles." },
        previous_period_key: { type: ["string", "null"] },
        coverage_delta_percentage_points: { type: ["number", "null"] },
        articles: { type: "array", items: { type: "object", additionalProperties: true } },
        truncated: { type: "boolean" },
      },
      additionalProperties: true,
    },
    GeoReportCitationMetrics: {
      type: "object",
      required: ["citation_valid_runs", "visible_citations", "content_citations", "unique_articles", "unique_domains", "tracked_content"],
      properties: {
        citation_valid_runs: { type: "integer", minimum: 0 },
        visible_citations: { type: "integer", minimum: 0, description: "source_type='visible' and visible_to_user=true." },
        content_citations: { type: "integer", minimum: 0, description: "Excludes icon/CDN references." },
        icon_citations: { type: "integer", minimum: 0 },
        unique_articles: { type: "integer", minimum: 0 },
        unique_domains: { type: "integer", minimum: 0 },
        tracked_content: { $ref: "#/components/schemas/GeoReportTrackedContent" },
        top_domains: {
          type: "array",
          items: {
            type: "object",
            required: ["domain", "citations", "covered_runs"],
            properties: {
              domain: { type: ["string", "null"] },
              citations: { type: "integer", minimum: 0 },
              articles: { type: "integer", minimum: 0 },
              covered_runs: { type: "integer", minimum: 0 },
              covered_run_rate: { type: ["number", "null"] },
            },
            additionalProperties: true,
          },
        },
        top_articles: {
          type: "array",
          items: {
            type: "object",
            required: ["canonical_url"],
            properties: {
              canonical_url: { type: "string", format: "uri" },
              title: { type: ["string", "null"] },
              domain: { type: ["string", "null"] },
              citations: { type: "integer", minimum: 0 },
              covered_runs: { type: "integer", minimum: 0 },
            },
            additionalProperties: true,
          },
        },
      },
      additionalProperties: true,
    },
    GeoReportPlatformNode: {
      type: "object",
      required: ["platform", "runs", "citations"],
      properties: {
        platform: { type: "string", enum: PROVIDERS() },
        color: { type: "string" },
        runs: { $ref: "#/components/schemas/GeoReportRunMetrics" },
        citations: { $ref: "#/components/schemas/GeoReportCitationMetrics" },
        questions: { type: "array", items: { type: "object", additionalProperties: true } },
        brand_mentions: { $ref: "#/components/schemas/BrandMentionsResource" },
      },
      additionalProperties: true,
    },
    GeoReportPeriodNode: {
      type: "object",
      required: ["key", "label", "from", "to", "time_zone", "platforms"],
      properties: {
        key: { type: "string" },
        label: { type: "string" },
        from: { type: "string", format: "date" },
        to: { type: "string", format: "date" },
        time_zone: { type: "string" },
        platforms: { type: "array", items: { $ref: "#/components/schemas/GeoReportPlatformNode" } },
        source_batches: { type: "array", items: { type: "object", additionalProperties: true } },
        excluded_batches: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Batches that started inside this period but never finished; excluded from metrics.",
        },
      },
      additionalProperties: true,
    },
    GeoCustomerReportSnapshot: {
      type: "object",
      description: "Immutable report snapshot and fixed-format customer HTML source data.",
      required: ["report_id", "scope_kind", "schema_version", "theme", "target", "profile", "scope", "periods", "methodology", "warnings"],
      properties: {
        report_id: reportId,
        scope_kind: { type: "string", enum: ["task", "group"] },
        task_id: { type: ["string", "null"] },
        group_id: { type: ["string", "null"] },
        schema_version: { type: "string" },
        theme: {
          type: ["object", "null"],
          additionalProperties: true,
          description: "Customer branding stored in this snapshot; null when the default theme was used.",
        },
        target: { type: "object", additionalProperties: true },
        profile: { type: "object", additionalProperties: true },
        scope: { type: "object", additionalProperties: true },
        periods: { type: "array", items: { $ref: "#/components/schemas/GeoReportPeriodNode" } },
        brand_mentions: {
          type: "array",
          items: { $ref: "#/components/schemas/BrandMentionsResource" },
          description: "One entry per platform, in the same order as scope.platforms. Empty when no brands were supplied.",
        },
        methodology: { type: "object", additionalProperties: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
      },
      additionalProperties: true,
    },
    GeoCustomerReportDetails: {
      allOf: [
        { $ref: "#/components/schemas/GeoCustomerReportResource" },
        {
          type: "object",
          required: ["snapshot"],
          properties: { snapshot: { $ref: "#/components/schemas/GeoCustomerReportSnapshot" } },
        },
      ],
    },

    /* ------------------------------------------------------------ 任务组 */
    // 一个用户视角的任务横跨多个采集任务（每个平台一个）。组是这层聚合概念：
    // 报告按平台横排、横向对比按组取历史，都建立在它之上。

    TaskGroupCreate: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        external_id: {
          type: "string",
          pattern: "^[A-Za-z0-9._:-]{1,200}$",
          description: "Caller-owned key. Unique per tenant; use it to link snapshots of the same customer task over time.",
        },
        tags: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
        task_ids: {
          type: "array",
          maxItems: 50,
          uniqueItems: true,
          items: taskId,
          description: "Collection Tasks to group. A task may belong to at most one group.",
        },
      },
    },
    TaskGroupPatch: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        external_id: { type: ["string", "null"], pattern: "^[A-Za-z0-9._:-]{1,200}$" },
        tags: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
      },
    },
    TaskGroupMemberTask: {
      type: "object",
      required: ["task_id", "name", "platforms", "state", "batch_count"],
      properties: {
        task_id: taskId,
        name: { type: "string" },
        platforms: { type: "array", items: { type: "string", enum: PROVIDERS() } },
        state: { type: "string" },
        batch_count: { type: "integer", minimum: 0 },
      },
    },
    TaskGroupMemberInput: {
      type: "object",
      additionalProperties: false,
      required: ["task_ids"],
      properties: {
        task_ids: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: taskId },
      },
    },
    TaskGroupResource: {
      type: "object",
      required: ["group_id", "name", "platforms", "task_count", "tasks", "batch_count", "run_count"],
      properties: {
        group_id: groupId,
        name: { type: "string" },
        external_id: { type: ["string", "null"] },
        tags: { type: "array", items: { type: "string" } },
        // 组的平台 = 成员 task 的 platforms 并集。组本身不声明平台，
        // 避免出现「组声称支持某平台但底下没有对应 task」这种无法验证的声明。
        platforms: { type: "array", items: { type: "string", enum: PROVIDERS() } },
        brand: {
          type: ["string", "null"],
          description: "Target brand when all member projects agree; null when they differ, in which case pass brand explicitly when creating a report.",
        },
        task_count: { type: "integer", minimum: 0 },
        tasks: { type: "array", items: { $ref: "#/components/schemas/TaskGroupMemberTask" } },
        batch_count: { type: "integer", minimum: 0, description: "Terminal collection batches across member tasks." },
        run_count: { type: "integer", minimum: 0 },
        created_at: { type: "string", format: "date-time" },
        updated_at: { type: "string", format: "date-time" },
      },
      additionalProperties: true,
    },

    /* ---------------------------------------------------- 回答读取与抽样 */
    // 品牌从回答里读出来，但「哪个是机构名」是语义问题，不该由 OneGl 猜。
    // 这条链路把回答交给调用方的模型：分层抽样 → 模型读出高频品牌 → brands 传回
    // → OneGl 对全量做可复现的提及率统计。

    AnswerSampleAnswer: {
      type: "object",
      required: ["run_id", "batch_id", "platform", "question", "answer", "answer_chars"],
      properties: {
        run_id: { type: "string" },
        batch_id: { type: "integer" },
        platform: { type: "string", enum: PROVIDERS() },
        question: { type: ["string", "null"] },
        answer: { type: "string", description: "AI answer text, safe-sliced to avoid splitting surrogate pairs." },
        answer_chars: { type: "integer", minimum: 0, description: "Full length before slicing." },
        truncated_by_length: { type: "boolean", description: "The response text was cut at MAX answer length for transport." },
        answer_truncated: {
          type: "boolean",
          description: "The platform appears to have stopped mid-answer. Untrusted answers are already excluded from this endpoint, so this is informational.",
        },
        answer_completion: {
          type: ["string", "null"],
          enum: ["follow-up-chips", "length-stability-fallback", "timeout", "unknown", null],
          description: "How the end of the answer was decided. Null on old rows; treat as untrusted only for the two explicitly untrusted values.",
        },
        citation_count: { type: "integer", minimum: 0 },
      },
      additionalProperties: true,
    },
    AnswerSampleResource: {
      type: "object",
      required: ["sampled", "scanned", "scan_cap", "total_available", "returned", "by_platform", "meta", "answers", "interpretation"],
      properties: {
        sampled: { type: "boolean" },
        sample_ratio: { type: ["number", "null"], minimum: 0, maximum: 1 },
        seed: { type: ["string", "null"], description: "Same seed always selects the same answers, so a model-derived brand list can be reproduced." },
        scanned: { type: "integer", minimum: 0, description: "Candidates examined after applying filters; capped by scan_cap." },
        scan_cap: { type: "integer", minimum: 0, description: "Hard ceiling on candidates examined in one call." },
        scan_truncated: { type: "boolean", description: "True when scan_cap was hit, meaning more answers exist beyond the current window." },
        total_available: { type: "integer", minimum: 0, description: "Same as scanned: candidates in the current window, NOT the full table count." },
        returned: { type: "integer", minimum: 0 },
        by_platform: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["available", "sampled", "returned"],
            properties: {
              available: { type: "integer", minimum: 0 },
              sampled: { type: "integer", minimum: 0 },
              returned: { type: "integer", minimum: 0 },
            },
          },
        },
        meta: {
          type: "object",
          required: ["has_more", "next_cursor"],
          properties: {
            has_more: { type: "boolean" },
            next_cursor: {
              type: ["string", "null"],
              description: "Pass back as after_id to continue. Null when the scan window reached the end. This is the window end, not the last returned id, so answers skipped by sample_ratio inside the window stay reachable.",
            },
            cursor_basis: { type: "string", const: "scan_window_end" },
          },
          additionalProperties: true,
        },
        answers: { type: "array", items: { $ref: "#/components/schemas/AnswerSampleAnswer" } },
        interpretation: { type: "object", additionalProperties: true },
      },
      additionalProperties: true,
    },

    /* ---------------------------------------------------- 报告横向对比 */
    GeoReportCompareDomain: {
      type: "object",
      required: ["domain", "citations", "covered_runs"],
      properties: {
        domain: { type: ["string", "null"] },
        citations: { type: ["integer", "null"], minimum: 0 },
        covered_runs: { type: ["integer", "null"], minimum: 0 },
      },
    },
    GeoReportCompareBrandDelta: {
      type: "object",
      description: "One competitor's mention movement between the two reports. Null on either side means the brand was not measured in that report — not that it scored zero.",
      required: ["name", "comparable", "present_in_current", "present_in_base", "current", "base"],
      properties: {
        name: { type: "string" },
        role: { type: "string", enum: ["own", "competitor", "unspecified"] },
        comparable: { type: "boolean" },
        present_in_current: { type: "boolean" },
        present_in_base: { type: "boolean" },
        current: { type: ["object", "null"], additionalProperties: true },
        base: { type: ["object", "null"], additionalProperties: true },
        mention_rate_delta_percentage_points: { type: ["number", "null"] },
        mention_count_delta: { type: ["integer", "null"] },
      },
      additionalProperties: true,
    },
    GeoReportCompareBrandMentions: {
      type: "object",
      description: "Competitor mention comparison. Deterministic deltas only; interpretation is left to the caller's model.",
      required: ["available", "brands"],
      properties: {
        available: { type: "boolean" },
        reason: { type: ["string", "null"] },
        current_answer_count: { type: ["integer", "null"], description: "Valid answers on the target side; the mention-rate denominator." },
        base_answer_count: { type: ["integer", "null"] },
        denominator_changed: {
          type: ["boolean", "null"],
          description: "True when the two periods used different denominators, so a rate change may reflect sampling rather than brand performance.",
        },
        brands: { type: "array", items: { $ref: "#/components/schemas/GeoReportCompareBrandDelta" } },
      },
      additionalProperties: true,
    },
    GeoReportComparePlatform: {
      type: "object",
      description:
        "Per-platform comparison. Aligned by platform, not by period key: period keys are caller-supplied " +
        "strings and will not match between two reports, so using them as an alignment key silently yields " +
        "zero comparable rows. When a report holds several periods, the one closest in time is used.",
      required: ["platform", "present_in_both", "present_in_target", "removed_since_base", "runs", "citations", "tracked_content", "brand_mentions"],
      properties: {
        platform: { type: "string", enum: PROVIDERS() },
        period_key: { type: ["string", "null"] },
        period_label: { type: ["string", "null"] },
        period_from: { type: ["string", "null"], format: "date" },
        period_to: { type: ["string", "null"], format: "date" },
        base_period_key: { type: ["string", "null"], description: "Period key taken from the base report; usually differs from period_key." },
        base_period_label: { type: ["string", "null"] },
        base_period_from: { type: ["string", "null"], format: "date" },
        base_period_to: { type: ["string", "null"], format: "date" },
        present_in_both: { type: "boolean", description: "False means the platform is missing from one side; metrics are null, not 0." },
        present_in_target: { type: "boolean" },
        removed_since_base: { type: "boolean" },
        runs: { type: ["object", "null"], additionalProperties: true },
        citations: { type: ["object", "null"], additionalProperties: true },
        tracked_content: { type: ["object", "null"], additionalProperties: true },
        brand_mentions: { $ref: "#/components/schemas/GeoReportCompareBrandMentions" },
        top_domains: {
          type: "object",
          properties: {
            current: { type: "array", items: { $ref: "#/components/schemas/GeoReportCompareDomain" } },
            previous: { type: "array", items: { $ref: "#/components/schemas/GeoReportCompareDomain" } },
            entered: {
              type: "array",
              items: { $ref: "#/components/schemas/GeoReportCompareDomain" },
              description: "Domains present in target but absent from base.",
            },
            exited: {
              type: "array",
              items: { $ref: "#/components/schemas/GeoReportCompareDomain" },
              description: "Domains present in base but absent from target.",
            },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
    GeoReportCompareSide: {
      type: "object",
      required: ["report_id", "scope_kind", "generated_at", "platforms", "periods"],
      properties: {
        report_id: reportId,
        scope_kind: { type: "string", enum: ["task", "group"] },
        task_id: { type: ["string", "null"] },
        group_id: { type: ["string", "null"] },
        generated_at: { type: "string", format: "date-time" },
        platforms: { type: "array", items: { type: "string", enum: PROVIDERS() } },
        periods: { type: "array", items: { $ref: "#/components/schemas/GeoReportPeriodSummary" } },
      },
      additionalProperties: true,
    },
    GeoReportCompareResource: {
      type: "object",
      required: ["base", "target", "platforms", "notes", "interpretation"],
      description:
        "Structured deltas between two immutable report snapshots. This endpoint deliberately returns " +
        "numbers only: missing metrics are null (never 0) so a caller can tell a real drop from a missing " +
        "period. Natural-language conclusions are not produced here.",
      properties: {
        base: { $ref: "#/components/schemas/GeoReportCompareSide" },
        target: { $ref: "#/components/schemas/GeoReportCompareSide" },
        platforms: { type: "array", items: { $ref: "#/components/schemas/GeoReportComparePlatform" } },
        notes: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Caveats that make some deltas unsafe to read, e.g. tracked-article configuration changed between reports.",
        },
        interpretation: {
          type: "object",
          required: ["provided_by", "conclusion", "guidance"],
          properties: {
            provided_by: { type: "string", const: "onegl" },
            conclusion: { type: "null", description: "Always null. Interpretation belongs to the caller's own model." },
            guidance: { type: "string" },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
    ExecutionCreate: {
      type: "object",
      additionalProperties: false,
      description: "All fields are optional. Omitted fields inherit the saved Task configuration. Creating an Execution starts it immediately.",
      properties: {
        account_ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1 } },
        platforms: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "string", enum: PROVIDERS() } },
        sampling: { $ref: "#/components/schemas/TaskSamplingInput" },
        seed: { type: ["string", "null"], description: "Optional deterministic sampling seed." },
      },
    },
    ExecutionProgress: {
      type: "object",
      additionalProperties: false,
      required: ["total", "completed", "failed", "skipped", "remaining", "percent"],
      properties: {
        total: { type: "integer", minimum: 0 },
        completed: { type: "integer", minimum: 0 },
        failed: { type: "integer", minimum: 0 },
        skipped: { type: "integer", minimum: 0 },
        remaining: { type: "integer", minimum: 0 },
        percent: { type: "number", minimum: 0, maximum: 100 },
      },
    },
    ExecutionResource: {
      type: "object",
      required: ["execution_id", "task_id", "task_name", "report_id", "platform", "trigger", "status", "progress", "login_states", "created_at"],
      properties: {
        execution_id: executionId,
        task_id: taskId,
        task_name: { type: "string" },
        report_id: { anyOf: [reportId, { type: "null" }] },
        platform: nullablePlatform,
        trigger: { type: "string", enum: ["manual", "rerun", "schedule"] },
        status: { type: "string", enum: ["pending", "queued", "running", "paused", "completed", "partial", "failed", "cancelled"] },
        progress: { $ref: "#/components/schemas/ExecutionProgress" },
        login_states: loginStates,
        created_at: { type: "string", format: "date-time" },
        started_at: nullableDateTime,
        finished_at: nullableDateTime,
        report_url: { type: "string", examples: ["/v1/reports/rpt_0123456789abcdef0123456789abcdef"] },
        results_url: { type: "string", examples: ["/v1/executions/exe_0123456789abcdef0123456789abcdef/results"] },
      },
    },
    ResultListItem: {
      type: "object",
      required: ["result_id", "question", "platform", "status", "login_state", "result_url"],
      properties: {
        result_id: resultId,
        question: { type: "string" },
        platform: { type: "string", enum: PROVIDERS() },
        status: { type: "string", enum: ["pending", "running", "success", "partial", "failed"] },
        login_state: nullableLoginState,

        answer_truncated: nullableAnswerTruncated,
        answer_completion: nullableAnswerCompletion,
        brand_mentioned: { type: ["boolean", "null"] },
        mention_count: { type: ["integer", "null"], minimum: 0 },
        finished_at: nullableDateTime,
        result_url: { type: "string" },
      },
    },
    CitationResource: {
      type: "object",
      properties: {
        source_position: { type: "integer", minimum: 1 },
        citation_marker: { type: ["string", "null"] },
        relation_status: { type: "string", enum: ["matched", "unresolved"] },
        captured_from: { type: "string" },
        visible_to_user: { type: "boolean" },
        source_type: { type: ["string", "null"] },
        answer_text: { type: ["string", "null"] },
        tracked_article_id: { type: ["integer", "null"] },
        canonical_url: { type: ["string", "null"], format: "uri" },
        original_url: { type: ["string", "null"], format: "uri" },
        title: { type: ["string", "null"] },
        domain: { type: ["string", "null"] },
        normalized_domain: { type: ["string", "null"] },
      },
    },
    ResultResource: {
      type: "object",
      required: ["result_id", "task_id", "execution_id", "platform", "question", "status", "login_state", "citations"],
      properties: {
        result_id: resultId,
        task_id: taskId,
        execution_id: executionId,
        platform: { type: "string", enum: PROVIDERS() },
        question: { type: "string" },
        status: { type: "string", enum: ["pending", "running", "success", "partial", "failed"] },
        login_state: nullableLoginState,

        answer_truncated: nullableAnswerTruncated,
        answer_completion: nullableAnswerCompletion,
        answer: {
          type: "object",
          required: ["text", "brand_mentioned", "mention_count"],
          properties: {
            text: { type: ["string", "null"] },
            brand_mentioned: { type: ["boolean", "null"] },
            mention_count: { type: ["integer", "null"], minimum: 0 },
          },
        },
        citations: { type: "array", items: { $ref: "#/components/schemas/CitationResource" } },
        started_at: nullableDateTime,
        finished_at: nullableDateTime,
      },
    },
    ReportResource: {
      type: "object",
      required: ["report_id", "task_id", "execution_id", "platform", "status", "execution_status", "report_url", "created_at", "login_states"],
      properties: {
        report_id: reportId,
        task_id: taskId,
        execution_id: executionId,
        platform: nullablePlatform,
        status: { type: "string", enum: ["generating", "ready"] },
        execution_status: { type: "string", enum: ["pending", "queued", "running", "paused", "completed", "partial", "failed", "cancelled"] },
        report_url: { type: "string" },
        summary: { type: ["object", "null"], additionalProperties: true },
        sources: { type: ["object", "null"], additionalProperties: true },
        intelligence: { type: ["object", "null"], additionalProperties: true },
        created_at: { type: "string", format: "date-time" },
        login_states: loginStates,
      },
    },
    ReportListItem: {
      type: "object",
      required: ["report_id", "execution_id", "platform", "status", "execution_status", "report_url", "created_at"],
      properties: {
        report_id: reportId,
        execution_id: executionId,
        platform: nullablePlatform,
        status: { type: "string", enum: ["generating", "ready"] },
        execution_status: { type: "string", enum: ["pending", "queued", "running", "paused", "completed", "partial", "failed", "cancelled"] },
        report_url: { type: "string" },
        created_at: { type: "string", format: "date-time" },
        finished_at: nullableDateTime,
      },
    },
    TaskScheduleCreate: {
      type: "object",
      additionalProperties: false,
      required: ["schedule"],
      properties: {
        name: { type: ["string", "null"], maxLength: 200 },
        schedule: {
          type: "object",
          additionalProperties: false,
          required: ["cadence"],
          properties: {
            cadence: { type: "string", enum: ["daily", "weekly"] },
            time_zone: { type: "string", default: "Asia/Shanghai" },
            local_time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$", default: "09:00" },
            weekday: { type: ["integer", "null"], minimum: 1, maximum: 7, description: "ISO weekday; Monday=1. Required for weekly schedules." },
          },
        },
        sampling: {
          type: "object",
          additionalProperties: false,
          properties: {
            size: { type: ["integer", "null"], minimum: 1 },
            method: { type: "string", enum: ["stratified", "random"] },
            repeats: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        account_ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string" } },
        enabled: { type: "boolean", default: true },
      },
    },
    ScheduleResource: {
      type: "object",
      required: ["schedule_id", "task_id", "name", "enabled", "schedule", "sampling", "account_ids", "next_run_at", "created_at"],
      properties: {
        schedule_id: scheduleId,
        task_id: taskId,
        name: { type: "string" },
        enabled: { type: "boolean" },
        schedule: {
          type: "object",
          required: ["cadence", "time_zone", "local_time"],
          properties: {
            cadence: { type: "string", enum: ["daily", "weekly"] },
            time_zone: { type: "string" },
            local_time: { type: "string" },
            weekday: { type: ["integer", "null"], minimum: 1, maximum: 7 },
          },
        },
        sampling: {
          type: "object",
          properties: {
            size: { type: ["integer", "null"] },
            method: { type: "string", enum: ["stratified", "random"] },
            repeats: { type: "integer", minimum: 1 },
          },
        },
        account_ids: { type: "array", items: { type: "string" } },
        next_run_at: { type: "string", format: "date-time" },
        last_run_at: nullableDateTime,
        created_at: { type: "string", format: "date-time" },
      },
    },
    ScheduleExecutionItem: {
      type: "object",
      required: ["scheduled_for", "status", "execution_id", "batch_created"],
      properties: {
        scheduled_for: { type: "string", format: "date-time" },
        status: { type: "string" },
        execution_id: { anyOf: [executionId, { type: "null" }] },
        batch_created: { type: "boolean" },
        details: { type: ["object", "null"], additionalProperties: true },
        error: { type: ["string", "null"] },
      },
    },
    SaasWebhookEvent: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "occurred_at", "data"],
      properties: {
        id: { type: "string", pattern: "^evt_[a-f0-9]{32}$" },
        type: {
          type: "string",
          enum: [
            "execution.completed",
            "execution.partial",
            "execution.failed",
            "execution.cancelled",
            "report.revision.ready",
            "account.action_required",
            "account.ready",
            "webhook.test",
          ],
        },
        occurred_at: { type: "string", format: "date-time" },
        created_at: { type: "string", format: "date-time", description: "Compatibility alias for occurred_at." },
        data: {
          type: "object",
          additionalProperties: true,
          description: "Event payload, whose shape follows `type`. execution.* events always name the platform and the observation surfaces, so a subscriber can route without fetching the execution first.",
        },
      },
    },
  });

  document.components.responses.SaasBadRequest = { description: "Invalid SaaS API request", content: { "application/json": { schema: { $ref: "#/components/schemas/SaasError" } } } };
  document.components.responses.SaasNotFound = { description: "Requested SaaS resource was not found", content: { "application/json": { schema: { $ref: "#/components/schemas/SaasError" } } } };
  document.components.responses.SaasConflict = { description: "Request conflicts with resource/account/idempotency state", content: { "application/json": { schema: { $ref: "#/components/schemas/SaasError" } } } };

  Object.assign(document.paths, {
    "/v1/tasks": {
      get: {
        summary: "List reusable SaaS tasks",
        parameters: paginationParameters,
        responses: { 200: pageJson("Tasks", { $ref: "#/components/schemas/TaskResource" }) },
      },
      post: {
        summary: "Create a reusable task from questions and selected platforms",
        description: "Executable platforms are exactly those with a registered collection adapter; an unsupported platform is rejected with unsupported_platform. Persist the returned task_id in the calling SaaS. Send Idempotency-Key from the SaaS job/request ID to make network retries safe.",
        parameters: [idempotencyHeader],
        requestBody: body({ $ref: "#/components/schemas/TaskCreate" }, {
          external_id: "saas_project_1024",
          name: "小米汽车 GEO 监测",
          target_brand: "小米汽车",
          questions: ["20万左右新能源SUV推荐", "国产新能源车哪个品牌值得买"],
          platforms: ["doubao"],
          account_ids: ["doubao-main"],
          sampling: { method: "stratified", repeats: 1 },
        }),
        responses: {
          201: json("Created task", { $ref: "#/components/schemas/TaskResource" }),
          400: { $ref: "#/components/responses/SaasBadRequest" },
          409: { $ref: "#/components/responses/SaasConflict" },
        },
      },
    },
    "/v1/tasks/{taskId}": {
      parameters: [stringId("taskId", "tsk")],
      get: { summary: "Get a task", responses: { 200: json("Task", { $ref: "#/components/schemas/TaskResource" }), 404: { $ref: "#/components/responses/SaasNotFound" } } },
      patch: { summary: "Update a task before execution history exists", requestBody: body({ type: "object" }), responses: { 200: json("Task", { $ref: "#/components/schemas/TaskResource" }), 409: { $ref: "#/components/responses/SaasConflict" } } },
      delete: { summary: "Archive a task", responses: { 200: json("Archived task") } },
    },
    "/v1/tasks/{taskId}/clone": {
      parameters: [stringId("taskId", "tsk")],
      post: {
        summary: "Clone a task so measurement-shaping fields can change without rewriting history",
        parameters: [idempotencyHeader],
        requestBody: body({ type: "object" }),
        responses: { 201: json("Cloned task", { $ref: "#/components/schemas/TaskResource" }), 409: { $ref: "#/components/responses/SaasConflict" } },
      },
    },
    "/v1/tasks/{taskId}/executions": {
      parameters: [stringId("taskId", "tsk")],
      get: {
        summary: "List execution history",
        parameters: paginationParameters,
        responses: { 200: pageJson("Executions", { $ref: "#/components/schemas/ExecutionResource" }) },
      },
      post: {
        summary: "Execute or re-execute a task",
        description: "Every call creates and starts a new execution_id, result IDs and report_id. Re-execution never overwrites previous measurements. Idempotency-Key prevents gateway/client retries from creating a second execution.",
        parameters: [idempotencyHeader],
        requestBody: { required: false, content: { "application/json": { schema: { $ref: "#/components/schemas/ExecutionCreate" }, example: {} } } },
        responses: {
          202: json("Execution accepted", { $ref: "#/components/schemas/ExecutionResource" }),
          409: { $ref: "#/components/responses/SaasConflict" },
          422: { $ref: "#/components/responses/SaasBadRequest" },
        },
      },
    },
    "/v1/executions/{executionId}": {
      parameters: [stringId("executionId", "exe")],
      get: { summary: "Poll execution status and progress", responses: { 200: json("Execution progress", { $ref: "#/components/schemas/ExecutionResource" }), 404: { $ref: "#/components/responses/SaasNotFound" } } },
    },
    "/v1/executions/{executionId}/pause": {
      parameters: [stringId("executionId", "exe")],
      post: { summary: "Pause remaining queued work; an already-active prompt may safely finish", responses: { 200: json("Paused execution", { $ref: "#/components/schemas/ExecutionResource" }), 409: { $ref: "#/components/responses/SaasConflict" } } },
    },
    "/v1/executions/{executionId}/resume": {
      parameters: [stringId("executionId", "exe")],
      post: { summary: "Resume only unfinished work", responses: { 200: json("Resumed execution", { $ref: "#/components/schemas/ExecutionResource" }), 409: { $ref: "#/components/responses/SaasConflict" } } },
    },
    "/v1/executions/{executionId}/cancel": {
      parameters: [stringId("executionId", "exe")],
      post: { summary: "Cancel remaining work while retaining finished results", responses: { 200: json("Cancelled execution", { $ref: "#/components/schemas/ExecutionResource" }), 409: { $ref: "#/components/responses/SaasConflict" } } },
    },
    "/v1/executions/{executionId}/results": {
      parameters: [stringId("executionId", "exe")],
      get: {
        summary: "List stable result IDs for every question/platform execution unit",
        parameters: paginationParameters,
        responses: { 200: pageJson("Results", { $ref: "#/components/schemas/ResultListItem" }), 404: { $ref: "#/components/responses/SaasNotFound" } },
      },
    },
    "/v1/results/{resultId}": {
      parameters: [stringId("resultId", "res")],
      get: { summary: "Get one question result, answer and citations", responses: { 200: json("Result", { $ref: "#/components/schemas/ResultResource" }), 404: { $ref: "#/components/responses/SaasNotFound" } } },
    },
    "/v1/executions/{executionId}/report": {
      parameters: [stringId("executionId", "exe")],
      get: { summary: "Get the report resource for an execution", responses: { 200: json("Report", { $ref: "#/components/schemas/ReportResource" }), 404: { $ref: "#/components/responses/SaasNotFound" } } },
    },
    "/v1/reports/{reportId}": {
      parameters: [stringId("reportId", "rpt")],
      get: { summary: "Query a report by stable report_id", description: "Returns status=generating while execution is active. The same report_id becomes status=ready at a terminal execution state.", responses: { 200: json("Report", { $ref: "#/components/schemas/ReportResource" }), 404: { $ref: "#/components/responses/SaasNotFound" } } },
    },
    "/v1/tasks/{taskId}/reports": {
      parameters: [stringId("taskId", "tsk")],
      get: {
        summary: "List historical reports for a task",
        parameters: paginationParameters,
        responses: { 200: pageJson("Reports", { $ref: "#/components/schemas/ReportListItem" }) },
      },
    },
    "/v1/tasks/{taskId}/geo-reports": {
      parameters: [stringId("taskId", "tsk")],
      get: {
        summary: "List generated GEO customer reports for a task",
        parameters: paginationParameters,
        responses: { 200: pageJson("GEO customer reports", { $ref: "#/components/schemas/GeoCustomerReportResource" }) },
      },
      post: {
        summary: "Generate a fixed-format GEO customer report",
        description: "Builds a persisted report snapshot synchronously from this tenant-scoped Task. Only terminal batches whose started_at falls within each inclusive local date period are included. Repeating an Idempotency-Key replays the first created report.",
        parameters: [idempotencyHeader],
        requestBody: body({ $ref: "#/components/schemas/GeoCustomerReportCreate" }, {
          platforms: ["doubao", "qianwen"],
          periods: [
            { key: "baseline", label: "基线阶段", from: "2026-09-01", to: "2026-09-07", time_zone: "Asia/Shanghai" },
            { key: "follow-up", label: "优化后", from: "2026-09-22", to: "2026-09-28", time_zone: "Asia/Shanghai" },
          ],
          format: "html",
        }),
        responses: {
          201: json("Generated report resource and download URLs", { $ref: "#/components/schemas/GeoCustomerReportResource" }),
          409: { $ref: "#/components/responses/SaasConflict" },
          422: { $ref: "#/components/responses/SaasBadRequest" },
        },
      },
    },
    "/v1/task-groups/{groupId}/answers": {
      parameters: [stringId("groupId", "grp")],
      get: {
        summary: "Read AI answers for a task group, optionally stratified-sampled",
        description:
          "Returns AI answer text so a caller can run its own model over a sample to discover which brands " +
          "the answers mention, then pass that list back via the reports' brands parameter. OneGl does not " +
          "extract entity names: deciding what counts as a business name is a semantic judgement, and a suffix " +
          "word list would break on every new industry. Sampling is stratified per platform because platform " +
          "volumes differ widely; a pooled sample would leave the smaller platform with too few answers to " +
          "discover its own brands.",
        parameters: [
          {
            name: "sample_ratio",
            in: "query",
            schema: { type: "number", exclusiveMinimum: 0, maximum: 1, default: 1 },
            description: "Fraction of answers to keep per platform. 0.1 is a practical default: measured on a 122-answer sample, brands above 15% mention rate were still discovered 93–100% of the time.",
          },
          {
            name: "platform",
            in: "query",
            schema: { type: "array", items: { type: "string", enum: PROVIDERS() } },
            style: "form",
            explode: true,
            description: "Restrict to specific platforms. Repeat the parameter for more than one.",
          },
          { name: "from", in: "query", schema: { type: "string", format: "date" }, description: "Batch local start date, inclusive." },
          { name: "to", in: "query", schema: { type: "string", format: "date" }, description: "Batch local start date, inclusive." },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
          {
            name: "after_id",
            in: "query",
            schema: { type: "integer", minimum: 1 },
            description:
              "Continuation cursor from meta.next_cursor of the previous page. The cursor is the end of the " +
              "SCAN window, not of the returned page: answers filtered out by sample_ratio inside a window " +
              "remain reachable on later pages, so no answer is skipped. It equals runs.id ordering.",
          },
          {
            name: "seed",
            in: "query",
            schema: { type: "string", maxLength: 64 },
            description: "Sampling seed. The same seed always yields the same answers.",
          },
        ],
        responses: {
          200: json("Answer page with coverage counts per platform and a continuation cursor", { $ref: "#/components/schemas/AnswerSampleResource" }),
          400: { $ref: "#/components/responses/SaasBadRequest" },
          404: { $ref: "#/components/responses/SaasNotFound" },
          422: { $ref: "#/components/responses/SaasBadRequest" },
        },
      },
    },
    "/v1/tasks/{taskId}/answers": {
      parameters: [stringId("taskId", "tsk")],
      get: {
        summary: "Read AI answers for a single collection task",
        description: "Same contract as the task-group variant, scoped to one collection task.",
        parameters: [
          { name: "sample_ratio", in: "query", schema: { type: "number", exclusiveMinimum: 0, maximum: 1, default: 1 } },
          {
            name: "platform",
            in: "query",
            schema: { type: "array", items: { type: "string", enum: PROVIDERS() } },
            style: "form",
            explode: true,
          },
          { name: "from", in: "query", schema: { type: "string", format: "date" } },
          { name: "to", in: "query", schema: { type: "string", format: "date" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
          {
            name: "after_id",
            in: "query",
            schema: { type: "integer", minimum: 1 },
            description: "Continuation cursor from meta.next_cursor of the previous page.",
          },
          { name: "seed", in: "query", schema: { type: "string", maxLength: 64 } },
        ],
        responses: {
          200: json("Answer sample with coverage counts per platform", { $ref: "#/components/schemas/AnswerSampleResource" }),
          400: { $ref: "#/components/responses/SaasBadRequest" },
          404: { $ref: "#/components/responses/SaasNotFound" },
          422: { $ref: "#/components/responses/SaasBadRequest" },
        },
      },
    },
    "/v1/geo-reports/compare": {
      get: {
        summary: "Compare two GEO report snapshots",
        description:
          "Aligns two immutable snapshots by period and platform and returns per-metric deltas, competitor mention " +
          "movement, and source-structure changes. Returns numbers only: a missing metric is null rather than 0, " +
          "so callers can distinguish a real drop from a period or platform that was not collected. " +
          "Natural-language conclusions are intentionally not produced — generate them with your own model from " +
          "these deltas.\n\n" +
          "Each side is located in one of three ways, checked in this order: *_report_id, then *_group_id, then " +
          "*_task_id. The group/task forms resolve to that scope's most recent report, which is what you want " +
          "when comparing two tasks rather than two specific snapshots.",
        parameters: [
          {
            name: "base_report_id",
            in: "query",
            schema: reportId,
            description: "Earlier snapshot. Mutually exclusive with base_group_id / base_task_id.",
          },
          {
            name: "target_report_id",
            in: "query",
            schema: reportId,
            description: "Later snapshot to measure against the base. Mutually exclusive with target_group_id / target_task_id.",
          },
          {
            name: "base_group_id",
            in: "query",
            schema: groupId,
            description: "Compare the most recent report of this task group against the target. Use this to compare two tasks directly.",
          },
          {
            name: "target_group_id",
            in: "query",
            schema: groupId,
            description: "Most recent report of this task group acts as the target.",
          },
          {
            name: "base_task_id",
            in: "query",
            schema: { type: "string", pattern: "^tsk_[a-f0-9]{32}$" },
            description: "Same as base_group_id but for a single collection task.",
          },
          {
            name: "target_task_id",
            in: "query",
            schema: { type: "string", pattern: "^tsk_[a-f0-9]{32}$" },
            description: "Same as target_group_id but for a single collection task.",
          },
        ],
        responses: {
          200: json("Structured per-platform deltas and interpretation boundary", {
            $ref: "#/components/schemas/GeoReportCompareResource",
          }),
          400: { $ref: "#/components/responses/SaasBadRequest" },
          404: { $ref: "#/components/responses/SaasNotFound" },
          422: { $ref: "#/components/responses/SaasBadRequest" },
        },
      },
    },
    "/v1/task-groups": {
      get: {
        summary: "List task groups",
        description: "Task groups are the cross-platform task abstraction: one customer task, one collection task per platform.",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: { 200: json("Task groups visible to this tenant", { type: "array", items: { $ref: "#/components/schemas/TaskGroupResource" } }) },
      },
      post: {
        summary: "Create a task group",
        requestBody: body({ $ref: "#/components/schemas/TaskGroupCreate" }),
        responses: {
          201: json("Created task group", { $ref: "#/components/schemas/TaskGroupResource" }),
          409: { $ref: "#/components/responses/SaasConflict" },
          422: { $ref: "#/components/responses/SaasBadRequest" },
        },
      },
    },
    "/v1/task-groups/{groupId}": {
      parameters: [stringId("groupId", "grp")],
      get: {
        summary: "Get a task group",
        responses: {
          200: json("Task group with member tasks and platform union", { $ref: "#/components/schemas/TaskGroupResource" }),
          404: { $ref: "#/components/responses/SaasNotFound" },
        },
      },
      patch: {
        summary: "Update task group metadata",
        requestBody: body({ $ref: "#/components/schemas/TaskGroupPatch" }),
        responses: {
          200: json("Updated task group", { $ref: "#/components/schemas/TaskGroupResource" }),
          404: { $ref: "#/components/responses/SaasNotFound" },
          409: { $ref: "#/components/responses/SaasConflict" },
        },
      },
      delete: {
        summary: "Delete a task group",
        description: "Removes the group and its membership rows. Member collection tasks and their reports are not deleted.",
        responses: {
          200: json("Deletion confirmation", { $ref: "#/components/schemas/DeletedResource" }),
          404: { $ref: "#/components/responses/SaasNotFound" },
        },
      },
    },
    "/v1/task-groups/{groupId}/members": {
      parameters: [stringId("groupId", "grp")],
      get: {
        summary: "List member collection tasks of a task group",
        responses: {
          200: json("Member collection tasks", { type: "array", items: { $ref: "#/components/schemas/TaskGroupMemberTask" } }),
          404: { $ref: "#/components/responses/SaasNotFound" },
        },
      },
      post: {
        summary: "Attach collection tasks to a task group",
        description: "Idempotent for tasks already in this group. A task may belong to at most one group.",
        requestBody: body({ $ref: "#/components/schemas/TaskGroupMemberInput" }),
        responses: {
          200: json("Task group after attaching", { $ref: "#/components/schemas/TaskGroupResource" }),
          400: { $ref: "#/components/responses/SaasBadRequest" },
          404: { $ref: "#/components/responses/SaasNotFound" },
        },
      },
      delete: {
        summary: "Detach a collection task from a task group",
        parameters: [
          { name: "task_id", in: "query", required: true, schema: { type: "integer", minimum: 1 }, description: "Internal task id from the members listing." },
        ],
        responses: {
          200: json("Detach confirmation", { type: "object", properties: { removed: { type: "boolean" } } }),
          400: { $ref: "#/components/responses/SaasBadRequest" },
          404: { $ref: "#/components/responses/SaasNotFound" },
        },
      },
    },
    "/v1/task-groups/{groupId}/geo-reports": {
      parameters: [stringId("groupId", "grp")],
      get: {
        summary: "List report history for a task group",
        description: "Every snapshot generated for this group, newest first. Use this to pick the reports to compare.",
        parameters: paginationParameters,
        responses: {
          // 必须用 pageJson：实现返回的是带 meta 的分页数组（{data:[…], meta:{…}}），
          // 之前误用 json() + ReportListItem —— 声明成单个对象、且带上了执行报告才有的
          // execution_id / execution_status。严格按契约生成客户端的调用方会直接解析失败。
          200: pageJson("Report history with opaque cursor pagination", { $ref: "#/components/schemas/GeoCustomerReportResource" }),
          404: { $ref: "#/components/responses/SaasNotFound" },
        },
      },
      post: {
        summary: "Generate a cross-platform GEO customer report for a task group",
        description:
          "Covers every platform configured across the group's member tasks, laid out side by side. Defaults " +
          "platforms to the union of member platforms, so a 千问 + 豆包 group produces one report with both platforms " +
          "compared in the same table. Only terminal batches whose started_at falls within each inclusive local date " +
          "period are included. Repeating an Idempotency-Key replays the first created report.",
        parameters: [idempotencyHeader],
        requestBody: body({ $ref: "#/components/schemas/GeoCustomerReportCreate" }, {
          platforms: ["qianwen", "doubao"],
          periods: [
            { key: "baseline", label: "基线阶段", from: "2026-09-01", to: "2026-09-07", time_zone: "Asia/Shanghai" },
            { key: "follow-up", label: "优化后", from: "2026-09-22", to: "2026-09-28", time_zone: "Asia/Shanghai" },
          ],
          brands: [
            { name: "某竞品", role: "competitor", aliases: ["别名"], product_aliases: ["某竞品旗舰店"] },
          ],
          format: "html",
        }),
        responses: {
          201: json("Generated report resource and download URLs", { $ref: "#/components/schemas/GeoCustomerReportResource" }),
          409: { $ref: "#/components/responses/SaasConflict" },
          422: { $ref: "#/components/responses/SaasBadRequest" },
        },
      },
    },
    "/v1/geo-reports/{reportId}": {
      parameters: [stringId("reportId", "rpt")],
      get: {
        summary: "Get an immutable GEO customer report snapshot",
        responses: { 200: json("Report metadata and frozen aggregate snapshot", { $ref: "#/components/schemas/GeoCustomerReportDetails" }) },
      },
    },
    "/v1/geo-reports/{reportId}/html": {
      parameters: [stringId("reportId", "rpt")],
      get: {
        summary: "Download the self-contained customer HTML report",
        responses: {
          200: {
            description: "Single-file UTF-8 HTML with inline CSS and no external assets.",
            headers: {
              ETag: { schema: { type: "string" }, description: "SHA-256 of the stored immutable HTML artifact." },
              "Content-Disposition": { schema: { type: "string" } },
            },
            content: { "text/html": { schema: { type: "string" } } },
          },
          404: { $ref: "#/components/responses/SaasNotFound" },
        },
      },
    },
    "/v1/tasks/{taskId}/schedules": {
      parameters: [stringId("taskId", "tsk")],
      get: {
        summary: "List recurring schedules for a task",
        parameters: paginationParameters,
        responses: { 200: pageJson("Schedules", { $ref: "#/components/schemas/ScheduleResource" }) },
      },
      post: {
        summary: "Create daily/weekly task schedule",
        description: "Schedules run only on doubao for now: a monitor plan has no platform dimension and its accounts resolve as doubao, so a task collecting any other platform is rejected with unsupported_schedule_platform rather than collecting under the wrong one.",
        parameters: [idempotencyHeader],
        requestBody: body({ $ref: "#/components/schemas/TaskScheduleCreate" }, { name: "每日豆包监测", schedule: { cadence: "daily", time_zone: "Asia/Shanghai", local_time: "09:00" }, account_ids: ["doubao-main"], enabled: true }),
        responses: {
          201: json("Schedule", { $ref: "#/components/schemas/ScheduleResource" }),
          409: { $ref: "#/components/responses/SaasConflict" },
          422: { $ref: "#/components/responses/SaasBadRequest" },
        },
      },
    },
    "/v1/schedules/{scheduleId}": {
      parameters: [stringId("scheduleId", "sch")],
      get: { summary: "Get schedule", responses: { 200: json("Schedule", { $ref: "#/components/schemas/ScheduleResource" }) } },
      patch: { summary: "Update/pause/resume schedule", requestBody: body({ type: "object" }), responses: { 200: json("Schedule", { $ref: "#/components/schemas/ScheduleResource" }) } },
      delete: { summary: "Delete future schedule while retaining historical executions", responses: { 200: json("Deleted schedule") } },
    },
    "/v1/schedules/{scheduleId}/executions": {
      parameters: [stringId("scheduleId", "sch")],
      get: {
        summary: "List scheduled occurrences and linked execution IDs",
        parameters: paginationParameters,
        responses: { 200: pageJson("Schedule executions", { $ref: "#/components/schemas/ScheduleExecutionItem" }) },
      },
    },
  });

  if (document.paths["/v1/webhooks"]?.post) {
    document.paths["/v1/webhooks"].post.description = "For SaaS integrations, subscribe to execution.completed, execution.partial, execution.failed, execution.cancelled, account.action_required and account.ready. Delivery uses X-OneGl-Event-Id (evt_...), X-OneGl-Timestamp and X-OneGl-Signature. Legacy batch.* events remain available for lower-level integrations.";
  }
}
