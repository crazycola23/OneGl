const jsonBody = (schema) => ({
  required: true,
  content: { "application/json": { schema } },
});

const planProperties = () => ({
  name: { type: "string", minLength: 1 },
  cadence: { type: "string", enum: ["daily", "weekly"], default: "daily" },
  time_zone: {
    type: "string",
    default: "Asia/Shanghai",
    description: "IANA time-zone name validated by Intl.DateTimeFormat at runtime.",
  },
  local_time: {
    type: "string",
    pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
    default: "09:00",
  },
  weekday: {
    type: ["integer", "null"],
    minimum: 1,
    maximum: 7,
    description: "ISO weekday. Used for weekly schedules; ignored/null for daily schedules.",
  },
  size: { type: ["integer", "null"], minimum: 1, maximum: 10000 },
  method: { type: "string", enum: ["stratified", "random"], default: "stratified" },
  repeats: { type: "integer", minimum: 1, maximum: 100, default: 1 },
  accounts: {
    type: "array",
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    items: { type: "string", minLength: 1 },
  },
  enabled: { type: "boolean", default: true },
});

export function applyMonitoringContractOpenApi(document) {
  const schemas = document.components?.schemas;
  if (!schemas) throw new Error("OpenAPI components.schemas must exist before monitoring contract hardening");

  Object.assign(schemas, {
    MonitorPlanCreate: {
      type: "object",
      additionalProperties: false,
      required: ["name", "accounts"],
      properties: planProperties(),
    },
    MonitorPlanPatch: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: planProperties(),
    },
  });

  const create = document.paths?.["/v1/projects/{projectId}/monitor-plans"]?.post;
  if (create) create.requestBody = jsonBody({ $ref: "#/components/schemas/MonitorPlanCreate" });

  const patch = document.paths?.["/v1/monitor-plans/{monitorPlanId}"]?.patch;
  if (patch) patch.requestBody = jsonBody({ $ref: "#/components/schemas/MonitorPlanPatch" });

  return document;
}
