const json = (description, schema = { type: "object" }) => ({
  description,
  content: { "application/json": { schema } },
});

const body = (schema) => ({ required: true, content: { "application/json": { schema } } });
const stringId = (name, example) => ({ name, in: "path", required: true, schema: { type: "string", example } });

export function applySaasOpenApi(document) {
  document.info.version = "0.5.0";
  document.info.description = `${document.info.description}\n\nSaaS task facade: stable task/execution/result/report/schedule IDs sit above the internal project/batch/run model. A task is reusable configuration; every run creates a new execution and report. Execution progress is pollable and supports pause, resume and cancel.`;

  Object.assign(document.components.schemas, {
    TaskCreate: {
      type: "object",
      required: ["name", "questions"],
      properties: {
        external_id: { type: ["string", "null"], description: "Optional ID from the calling SaaS." },
        name: { type: "string", minLength: 1, maxLength: 200 },
        target_brand: { type: ["string", "null"] },
        questions: { type: "array", minItems: 1, maxItems: 5000, items: { type: "string" } },
        platforms: { type: "array", minItems: 1, items: { type: "string", enum: ["doubao"] }, default: ["doubao"] },
        account_ids: { type: "array", maxItems: 100, items: { type: "string" }, default: [] },
        sampling: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["stratified", "random"], default: "stratified" },
            repeats: { type: "integer", minimum: 1, maximum: 100, default: 1 },
          },
        },
      },
    },
    ExecutionCreate: {
      type: "object",
      properties: {
        account_ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
        platforms: { type: "array", minItems: 1, items: { type: "string", enum: ["doubao"] } },
        sampling: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["stratified", "random"] },
            repeats: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        seed: { type: ["string", "null"] },
        start: { type: "boolean", default: true },
      },
    },
    TaskScheduleCreate: {
      type: "object",
      required: ["schedule"],
      properties: {
        name: { type: ["string", "null"] },
        schedule: {
          type: "object",
          required: ["cadence"],
          properties: {
            cadence: { type: "string", enum: ["daily", "weekly"] },
            time_zone: { type: "string", default: "Asia/Shanghai" },
            local_time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$", default: "09:00" },
            weekday: { type: ["integer", "null"], minimum: 1, maximum: 7 },
          },
        },
        sampling: {
          type: "object",
          properties: {
            size: { type: ["integer", "null"], minimum: 1 },
            method: { type: "string", enum: ["stratified", "random"] },
            repeats: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        account_ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
        enabled: { type: "boolean", default: true },
      },
    },
  });

  Object.assign(document.paths, {
    "/v1/tasks": {
      get: { summary: "List reusable SaaS tasks", responses: { 200: json("Tasks") } },
      post: {
        summary: "Create a reusable task from questions and selected platforms",
        description: "Currently only doubao is executable. The returned task_id is stable and should be stored by the calling SaaS.",
        requestBody: body({ $ref: "#/components/schemas/TaskCreate" }),
        responses: { 201: json("Task") },
      },
    },
    "/v1/tasks/{taskId}": {
      parameters: [stringId("taskId", "tsk_...")],
      get: { summary: "Get a task", responses: { 200: json("Task") } },
      patch: { summary: "Update a task before execution history exists", requestBody: body({ type: "object" }), responses: { 200: json("Task"), 409: json("Task is locked; clone it instead") } },
      delete: { summary: "Archive a task", responses: { 200: json("Archived") } },
    },
    "/v1/tasks/{taskId}/clone": {
      parameters: [stringId("taskId", "tsk_...")],
      post: { summary: "Clone a task so questions/platforms can change without rewriting history", requestBody: body({ type: "object" }), responses: { 201: json("Cloned task") } },
    },
    "/v1/tasks/{taskId}/executions": {
      parameters: [stringId("taskId", "tsk_...")],
      get: { summary: "List execution history", responses: { 200: json("Executions") } },
      post: {
        summary: "Execute or re-execute a task",
        description: "Every call creates a new execution_id, result IDs and report_id. Re-execution never overwrites historical measurements.",
        requestBody: { required: false, content: { "application/json": { schema: { $ref: "#/components/schemas/ExecutionCreate" } } } },
        responses: { 202: json("Execution accepted") },
      },
    },
    "/v1/executions/{executionId}": {
      parameters: [stringId("executionId", "exe_...")],
      get: { summary: "Poll execution status and progress", responses: { 200: json("Execution progress") } },
    },
    "/v1/executions/{executionId}/pause": {
      parameters: [stringId("executionId", "exe_...")],
      post: { summary: "Pause remaining queued work; an already-active prompt may safely finish", responses: { 200: json("Paused execution"), 409: json("Invalid execution state") } },
    },
    "/v1/executions/{executionId}/resume": {
      parameters: [stringId("executionId", "exe_...")],
      post: { summary: "Resume only unfinished work", responses: { 200: json("Resumed execution"), 409: json("Invalid execution state") } },
    },
    "/v1/executions/{executionId}/cancel": {
      parameters: [stringId("executionId", "exe_...")],
      post: { summary: "Cancel remaining work while retaining finished results", responses: { 200: json("Cancelled execution"), 409: json("Invalid execution state") } },
    },
    "/v1/executions/{executionId}/results": {
      parameters: [stringId("executionId", "exe_...")],
      get: { summary: "List stable result IDs for every question/platform execution unit", responses: { 200: json("Results") } },
    },
    "/v1/results/{resultId}": {
      parameters: [stringId("resultId", "res_...")],
      get: { summary: "Get one question result, answer and citations", responses: { 200: json("Result") } },
    },
    "/v1/executions/{executionId}/report": {
      parameters: [stringId("executionId", "exe_...")],
      get: { summary: "Get the report resource for an execution", responses: { 200: json("Report") } },
    },
    "/v1/reports/{reportId}": {
      parameters: [stringId("reportId", "rpt_...")],
      get: { summary: "Query a report by stable report_id", description: "Returns generating while the execution is active, and the current auditable report data when ready.", responses: { 200: json("Report") } },
    },
    "/v1/tasks/{taskId}/reports": {
      parameters: [stringId("taskId", "tsk_...")],
      get: { summary: "List historical reports for a task", responses: { 200: json("Reports") } },
    },
    "/v1/tasks/{taskId}/schedules": {
      parameters: [stringId("taskId", "tsk_...")],
      get: { summary: "List recurring schedules for a task", responses: { 200: json("Schedules") } },
      post: { summary: "Create daily/weekly task schedule", requestBody: body({ $ref: "#/components/schemas/TaskScheduleCreate" }), responses: { 201: json("Schedule") } },
    },
    "/v1/schedules/{scheduleId}": {
      parameters: [stringId("scheduleId", "sch_...")],
      get: { summary: "Get schedule", responses: { 200: json("Schedule") } },
      patch: { summary: "Update/pause/resume schedule", requestBody: body({ type: "object" }), responses: { 200: json("Schedule") } },
      delete: { summary: "Delete future schedule while retaining historical executions", responses: { 200: json("Deleted") } },
    },
    "/v1/schedules/{scheduleId}/executions": {
      parameters: [stringId("scheduleId", "sch_...")],
      get: { summary: "List scheduled occurrences and linked execution IDs", responses: { 200: json("Schedule executions") } },
    },
  });
}
