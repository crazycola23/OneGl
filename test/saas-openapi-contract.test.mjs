import assert from "node:assert/strict";
import test from "node:test";

import { openApiDocument } from "../src/api/openapi.js";
import { applySaasOpenApi } from "../src/api/saas-openapi.js";

function contract() {
  const document = structuredClone(openApiDocument);
  applySaasOpenApi(document);
  return document;
}

test("SaaS OpenAPI exposes stable v0.6 task contract", () => {
  const document = contract();
  assert.equal(document.info.version, "0.6.0");

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
    "SaasError",
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

test("core SaaS responses are documented as data envelopes", () => {
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
  }
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
