import assert from "node:assert/strict";
import test from "node:test";

import { openApiDocument } from "../src/api/openapi.js";
import { applySaasOpenApi } from "../src/api/saas-openapi.js";

function contract() {
  const document = structuredClone(openApiDocument);
  applySaasOpenApi(document);
  return document;
}

test("SaaS OpenAPI exposes stable v0.7 production contract", () => {
  const document = contract();
  assert.equal(document.info.version, "0.7.0");

  for (const name of [
    "TaskSamplingInput",
    "TaskSampling",
    "TaskCreate",
    "TaskResource",
    "ExecutionCreate",
    "ExecutionProgress",
    "ExecutionResource",
    "ResultListItem",
    "ResultResource",
    "CitationResource",
    "ReportResource",
    "ReportListItem",
    "TaskScheduleCreate",
    "ScheduleResource",
    "ScheduleExecutionItem",
    "SaasError",
    "PageMeta",
    "SaasWebhookEvent",
  ]) {
    assert.ok(document.components.schemas[name], `missing schema ${name}`);
  }

  for (const path of [
    "/v1/tasks",
    "/v1/tasks/{taskId}/executions",
    "/v1/executions/{executionId}",
    "/v1/executions/{executionId}/pause",
    "/v1/executions/{executionId}/resume",
    "/v1/executions/{executionId}/cancel",
    "/v1/executions/{executionId}/results",
    "/v1/results/{resultId}",
    "/v1/reports/{reportId}",
    "/v1/tasks/{taskId}/reports",
    "/v1/tasks/{taskId}/schedules",
    "/v1/schedules/{scheduleId}",
    "/v1/schedules/{scheduleId}/executions",
  ]) {
    assert.ok(document.paths[path], `missing path ${path}`);
  }
});

test("execution, result and report statuses are explicit", () => {
  const document = contract();
  assert.deepEqual(document.components.schemas.ExecutionResource.properties.status.enum, [
    "pending", "queued", "running", "paused", "completed", "partial", "failed", "cancelled",
  ]);
  assert.deepEqual(document.components.schemas.ResultResource.properties.status.enum, [
    "pending", "running", "success", "partial", "failed",
  ]);
  assert.deepEqual(document.components.schemas.ReportResource.properties.status.enum, ["generating", "ready"]);
});

test("core SaaS single-resource responses remain data envelopes", () => {
  const document = contract();
  const responseSchemas = [
    document.paths["/v1/tasks"].post.responses[201],
    document.paths["/v1/tasks/{taskId}/executions"].post.responses[202],
    document.paths["/v1/executions/{executionId}"].get.responses[200],
    document.paths["/v1/results/{resultId}"].get.responses[200],
    document.paths["/v1/reports/{reportId}"].get.responses[200],
  ];
  for (const response of responseSchemas) {
    const schema = response.content["application/json"].schema;
    assert.deepEqual(schema.required, ["data"]);
    assert.ok(schema.properties.data);
    assert.ok(response.headers["X-OneGl-API-Version"]);
  }
});

test("history lists use opaque cursor pagination without shrinking v0.6 limits", () => {
  const document = contract();
  for (const [path, method] of [
    ["/v1/tasks", "get"],
    ["/v1/tasks/{taskId}/executions", "get"],
    ["/v1/executions/{executionId}/results", "get"],
    ["/v1/tasks/{taskId}/reports", "get"],
    ["/v1/tasks/{taskId}/schedules", "get"],
    ["/v1/schedules/{scheduleId}/executions", "get"],
  ]) {
    const operation = document.paths[path][method];
    const limit = operation.parameters.find((parameter) => parameter.name === "limit");
    assert.ok(operation.parameters.some((parameter) => parameter.name === "cursor"));
    assert.equal(limit.schema.default, 100);
    assert.equal(limit.schema.maximum, 500);
    const schema = operation.responses[200].content["application/json"].schema;
    assert.deepEqual(schema.required, ["data", "meta"]);
    assert.equal(schema.properties.meta.$ref, "#/components/schemas/PageMeta");
  }
});

test("create-style SaaS POST routes document Idempotency-Key", () => {
  const document = contract();
  for (const path of [
    "/v1/tasks",
    "/v1/tasks/{taskId}/clone",
    "/v1/tasks/{taskId}/executions",
    "/v1/tasks/{taskId}/schedules",
  ]) {
    const operation = document.paths[path].post;
    assert.ok(operation.parameters.some((parameter) => parameter.name === "Idempotency-Key"));
  }
});

test("SaaS webhook contract uses public event types", () => {
  const document = contract();
  const eventType = document.components.schemas.SaasWebhookEvent.properties.type.enum;
  for (const value of [
    "execution.completed",
    "execution.partial",
    "execution.failed",
    "execution.cancelled",
    "account.action_required",
    "account.ready",
  ]) assert.ok(eventType.includes(value));
  assert.match(document.components.schemas.SaasWebhookEvent.properties.id.pattern, /evt_/);
});

test("execution sampling overrides are partial and internal queue controls are not public", () => {
  const document = contract();
  const sampling = document.components.schemas.TaskSamplingInput;
  assert.equal(sampling.required, undefined);
  assert.ok(sampling.properties.method);
  assert.ok(sampling.properties.repeats);

  const executionCreate = document.components.schemas.ExecutionCreate;
  assert.equal(executionCreate.properties.start, undefined);
  assert.equal(executionCreate.properties.sampling.$ref, "#/components/schemas/TaskSamplingInput");
});

test("public IDs are typed by prefix and task create does not expose browser primitives", () => {
  const document = contract();
  assert.match(document.paths["/v1/tasks/{taskId}"].parameters[0].schema.pattern, /tsk_/);
  assert.match(document.paths["/v1/executions/{executionId}"].parameters[0].schema.pattern, /exe_/);
  assert.match(document.paths["/v1/results/{resultId}"].parameters[0].schema.pattern, /res_/);
  assert.match(document.paths["/v1/reports/{reportId}"].parameters[0].schema.pattern, /rpt_/);
  assert.match(document.paths["/v1/schedules/{scheduleId}"].parameters[0].schema.pattern, /sch_/);

  const serialized = JSON.stringify(document.components.schemas.TaskCreate);
  for (const forbidden of ["cookie", "storageState", "selector", "captcha", "browser_control"]) {
    assert.equal(serialized.includes(forbidden), false, `TaskCreate must not expose ${forbidden}`);
  }
});
