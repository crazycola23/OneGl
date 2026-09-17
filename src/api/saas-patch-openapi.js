const body = (schema) => ({
  required: true,
  content: { "application/json": { schema } },
});

const stringArray = ({ minItems = 0, maxItems = 100 } = {}) => ({
  type: "array",
  minItems,
  maxItems,
  uniqueItems: true,
  items: { type: "string", minLength: 1 },
});

export function applySaasPatchOpenApi(document) {
  const schemas = document.components?.schemas;
  if (!schemas) throw new Error("OpenAPI components.schemas must exist before SaaS patch hardening");

  Object.assign(schemas, {
    TaskPatch: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      description: "Partial Task update. Execution-shaping fields are rejected at runtime after the task has execution history; clone the task instead.",
      properties: {
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
          items: { type: "string", enum: ["doubao"] },
        },
        account_ids: stringArray(),
        sampling: { $ref: "#/components/schemas/TaskSamplingInput" },
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
  });

  const taskPatch = document.paths?.["/v1/tasks/{taskId}"]?.patch;
  if (taskPatch) taskPatch.requestBody = body({ $ref: "#/components/schemas/TaskPatch" });

  const schedulePatch = document.paths?.["/v1/schedules/{scheduleId}"]?.patch;
  if (schedulePatch) schedulePatch.requestBody = body({ $ref: "#/components/schemas/TaskSchedulePatch" });
}
