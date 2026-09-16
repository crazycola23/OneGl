const envelope = (schema) => ({
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: schema },
});

const json = (description, schema = { type: "object" }) => ({
  description,
  content: { "application/json": { schema: envelope(schema) } },
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

const nullableDateTime = { type: ["string", "null"], format: "date-time" };
const taskId = { type: "string", pattern: "^tsk_[a-f0-9]{32}$" };
const executionId = { type: "string", pattern: "^exe_[a-f0-9]{32}$" };
const resultId = { type: "string", pattern: "^res_[a-f0-9]{32}$" };
const reportId = { type: "string", pattern: "^rpt_[a-f0-9]{32}$" };
const scheduleId = { type: "string", pattern: "^sch_[a-f0-9]{32}$" };

export function applySaasOpenApi(document) {
  document.info.version = "0.6.0";
  document.info.description = `${document.info.description}\n\nSaaS task facade: stable task/execution/result/report/schedule IDs sit above the internal project/batch/run model. The schemas below are the stable server-to-server contract. Callers should depend only on documented fields and ignore any extra diagnostic fields returned by older/newer OneGl builds.`;

  Object.assign(document.components.schemas, {
    SaasError: {
      type: "object",
      additionalProperties: false,
      required: ["error", "message"],
      properties: {
        error: {
          type: "string",
          description: "Stable machine-readable error code.",
          examples: ["invalid_request", "account_action_required", "task_not_found"],
        },
        message: { type: "string", description: "Human-readable diagnostic message." },
        details: { description: "Optional structured details. Do not parse message text when details are available." },
      },
    },
    TaskSampling: {
      type: "object",
      additionalProperties: false,
      required: ["method", "repeats"],
      properties: {
        method: { type: "string", enum: ["stratified", "random"], default: "stratified" },
        repeats: { type: "integer", minimum: 1, maximum: 100, default: 1 },
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
          maxItems: 20,
          uniqueItems: true,
          items: { type: "string", enum: ["doubao"] },
          default: ["doubao"],
        },
        account_ids: {
          type: "array",
          maxItems: 100,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          default: [],
        },
        sampling: { $ref: "#/components/schemas/TaskSampling" },
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
    ExecutionCreate: {
      type: "object",
      additionalProperties: false,
      description: "All fields are optional. Omitted fields inherit the saved Task configuration.",
      properties: {
        account_ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1 } },
        platforms: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "string", enum: ["doubao"] } },
        sampling: { $ref: "#/components/schemas/TaskSampling" },
        seed: { type: ["string", "null"], description: "Optional deterministic sampling seed." },
        start: { type: "boolean", default: true, description: "Normally true. false creates the execution resource without enqueueing it immediately." },
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
      required: ["execution_id", "task_id", "task_name", "report_id", "trigger", "status", "progress", "created_at"],
      properties: {
        execution_id: executionId,
        task_id: taskId,
        task_name: { type: "string" },
        report_id: { anyOf: [reportId, { type: "null" }] },
        trigger: { type: "string", enum: ["manual", "rerun", "schedule"] },
        status: { type: "string", enum: ["pending", "queued", "running", "paused", "completed", "partial", "failed", "cancelled"] },
        progress: { $ref: "#/components/schemas/ExecutionProgress" },
        created_at: { type: "string", format: "date-time" },
        started_at: nullableDateTime,
        finished_at: nullableDateTime,
        report_url: { type: "string", examples: ["/v1/reports/rpt_0123456789abcdef0123456789abcdef"] },
        results_url: { type: "string", examples: ["/v1/executions/exe_0123456789abcdef0123456789abcdef/results"] },
      },
    },
    ResultListItem: {
      type: "object",
      required: ["result_id", "question", "platform", "status", "result_url"],
      properties: {
        result_id: resultId,
        question: { type: "string" },
        platform: { type: "string", enum: ["doubao"] },
        status: { type: "string", enum: ["pending", "running", "success", "partial", "failed"] },
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
      required: ["result_id", "task_id", "execution_id", "platform", "question", "status", "citations"],
      properties: {
        result_id: resultId,
        task_id: taskId,
        execution_id: executionId,
        platform: { type: "string", enum: ["doubao"] },
        question: { type: "string" },
        status: { type: "string", enum: ["pending", "running", "success", "partial", "failed"] },
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
      required: ["report_id", "task_id", "execution_id", "status", "execution_status", "report_url", "created_at"],
      properties: {
        report_id: reportId,
        task_id: taskId,
        execution_id: executionId,
        status: { type: "string", enum: ["generating", "ready"] },
        execution_status: { type: "string", enum: ["pending", "queued", "running", "paused", "completed", "partial", "failed", "cancelled"] },
        report_url: { type: "string" },
        summary: { type: ["object", "null"], additionalProperties: true },
        sources: { type: ["object", "null"], additionalProperties: true },
        intelligence: { type: ["object", "null"], additionalProperties: true },
        created_at: { type: "string", format: "date-time" },
      },
    },
    ReportListItem: {
      type: "object",
      required: ["report_id", "execution_id", "status", "execution_status", "report_url", "created_at"],
      properties: {
        report_id: reportId,
        execution_id: executionId,
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
  });

  document.components.responses.SaasBadRequest = { description: "Invalid SaaS API request", content: { "application/json": { schema: { $ref: "#/components/schemas/SaasError" } } } };
  document.components.responses.SaasNotFound = { description: "Requested SaaS resource was not found", content: { "application/json": { schema: { $ref: "#/components/schemas/SaasError" } } } };
  document.components.responses.SaasConflict = { description: "Request conflicts with resource/account state", content: { "application/json": { schema: { $ref: "#/components/schemas/SaasError" } } } };

  Object.assign(document.paths, {
    "/v1/tasks": {
      get: {
        summary: "List reusable SaaS tasks",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } }],
        responses: { 200: json("Tasks", { type: "array", items: { $ref: "#/components/schemas/TaskResource" } }) },
      },
      post: {
        summary: "Create a reusable task from questions and selected platforms",
        description: "Currently only doubao is executable. Persist the returned task_id in the calling SaaS.",
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
      post: { summary: "Clone a task so measurement-shaping fields can change without rewriting history", requestBody: body({ type: "object" }), responses: { 201: json("Cloned task", { $ref: "#/components/schemas/TaskResource" }) } },
    },
    "/v1/tasks/{taskId}/executions": {
      parameters: [stringId("taskId", "tsk")],
      get: {
        summary: "List execution history",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } }],
        responses: { 200: json("Executions", { type: "array", items: { $ref: "#/components/schemas/ExecutionResource" } }) },
      },
      post: {
        summary: "Execute or re-execute a task",
        description: "Every call creates a new execution_id, result IDs and report_id. Re-execution never overwrites previous measurements.",
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
      get: { summary: "List stable result IDs for every question/platform execution unit", responses: { 200: json("Results", { type: "array", items: { $ref: "#/components/schemas/ResultListItem" } }), 404: { $ref: "#/components/responses/SaasNotFound" } } },
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
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } }],
        responses: { 200: json("Reports", { type: "array", items: { $ref: "#/components/schemas/ReportListItem" } }) },
      },
    },
    "/v1/tasks/{taskId}/schedules": {
      parameters: [stringId("taskId", "tsk")],
      get: { summary: "List recurring schedules for a task", responses: { 200: json("Schedules", { type: "array", items: { $ref: "#/components/schemas/ScheduleResource" } }) } },
      post: { summary: "Create daily/weekly task schedule", requestBody: body({ $ref: "#/components/schemas/TaskScheduleCreate" }, { name: "每日豆包监测", schedule: { cadence: "daily", time_zone: "Asia/Shanghai", local_time: "09:00" }, account_ids: ["doubao-main"], enabled: true }), responses: { 201: json("Schedule", { $ref: "#/components/schemas/ScheduleResource" }) } },
    },
    "/v1/schedules/{scheduleId}": {
      parameters: [stringId("scheduleId", "sch")],
      get: { summary: "Get schedule", responses: { 200: json("Schedule", { $ref: "#/components/schemas/ScheduleResource" }) } },
      patch: { summary: "Update/pause/resume schedule", requestBody: body({ type: "object" }), responses: { 200: json("Schedule", { $ref: "#/components/schemas/ScheduleResource" }) } },
      delete: { summary: "Delete future schedule while retaining historical executions", responses: { 200: json("Deleted schedule") } },
    },
    "/v1/schedules/{scheduleId}/executions": {
      parameters: [stringId("scheduleId", "sch")],
      get: { summary: "List scheduled occurrences and linked execution IDs", responses: { 200: json("Schedule executions") } },
    },
  });
}
