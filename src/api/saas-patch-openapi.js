import { defaultProviderId as DEFAULT_PROVIDER, supportedProviderIds as PROVIDERS } from "../providers/index.js";
const body = (schema) => ({
  required: true,
  content: { "application/json": { schema } },
});

const envelope = (schema) => ({
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: schema },
});

const stringArray = ({ minItems = 0, maxItems = 100 } = {}) => ({
  type: "array",
  minItems,
  maxItems,
  uniqueItems: true,
  items: { type: "string", minLength: 1 },
});

const taskMutableProperties = () => ({
  external_id: { type: ["string", "null"], maxLength: 255 },
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
    items: { type: "string", enum: PROVIDERS() },
  },
  account_ids: stringArray(),
  sampling: { $ref: "#/components/schemas/TaskSamplingInput" },
});

function setJsonResponseSchema(document, pathname, method, status, schema) {
  const response = document.paths?.[pathname]?.[method]?.responses?.[String(status)];
  const media = response?.content?.["application/json"];
  if (media) media.schema = schema;
}

export function applySaasPatchOpenApi(document) {
  const schemas = document.components?.schemas;
  if (!schemas) throw new Error("OpenAPI components.schemas must exist before SaaS patch hardening");

  Object.assign(schemas, {
    TaskPatch: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      description: "Partial Task update. Execution-shaping fields are rejected at runtime after the task has execution history; clone the task instead.",
      properties: taskMutableProperties(),
    },
    TaskCloneRequest: {
      type: "object",
      additionalProperties: false,
      description: "Optional overrides applied when cloning an existing Task. An empty object clones the current public Task configuration unchanged except for its generated identity/name defaults.",
      properties: taskMutableProperties(),
    },
    TaskArchiveResource: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "archived"],
      properties: {
        task_id: { type: "string", pattern: "^tsk_[a-f0-9]{32}$" },
        archived: { type: "boolean", const: true },
      },
    },
    TaskSchedulePatch: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      description: "Partial schedule update. Prefer the nested schedule object; flat cadence/time_zone/local_time/weekday fields remain documented as compatibility aliases because the runtime accepts them.",
      properties: {
        name: { type: ["string", "null"], maxLength: 200 },
        schedule: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            cadence: { type: "string", enum: ["daily", "weekly"] },
            time_zone: { type: "string" },
            local_time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
            weekday: { type: ["integer", "null"], minimum: 1, maximum: 7 },
          },
        },
        sampling: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            size: { type: ["integer", "null"], minimum: 1 },
            method: { type: "string", enum: ["stratified", "random"] },
            repeats: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        account_ids: stringArray({ minItems: 1 }),
        enabled: { type: "boolean" },
        cadence: { type: "string", enum: ["daily", "weekly"], deprecated: true, description: "Compatibility alias for schedule.cadence." },
        time_zone: { type: "string", deprecated: true, description: "Compatibility alias for schedule.time_zone." },
        local_time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$", deprecated: true, description: "Compatibility alias for schedule.local_time." },
        weekday: { type: ["integer", "null"], minimum: 1, maximum: 7, deprecated: true, description: "Compatibility alias for schedule.weekday." },
      },
    },
    ScheduleDeleteResource: {
      type: "object",
      additionalProperties: false,
      required: ["schedule_id", "deleted"],
      properties: {
        schedule_id: { type: "string", pattern: "^sch_[a-f0-9]{32}$" },
        deleted: { type: "boolean", const: true },
      },
    },
  });

  const taskPatch = document.paths?.["/v1/tasks/{taskId}"]?.patch;
  if (taskPatch) taskPatch.requestBody = body({ $ref: "#/components/schemas/TaskPatch" });

  const cloneTask = document.paths?.["/v1/tasks/{taskId}/clone"]?.post;
  if (cloneTask) cloneTask.requestBody = body({ $ref: "#/components/schemas/TaskCloneRequest" });

  const schedulePatch = document.paths?.["/v1/schedules/{scheduleId}"]?.patch;
  if (schedulePatch) schedulePatch.requestBody = body({ $ref: "#/components/schemas/TaskSchedulePatch" });

  setJsonResponseSchema(
    document,
    "/v1/tasks/{taskId}",
    "delete",
    200,
    envelope({ $ref: "#/components/schemas/TaskArchiveResource" }),
  );
  setJsonResponseSchema(
    document,
    "/v1/schedules/{scheduleId}",
    "delete",
    200,
    envelope({ $ref: "#/components/schemas/ScheduleDeleteResource" }),
  );
}
