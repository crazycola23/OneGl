import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenApiDocument } from "../src/api/build-openapi.js";

function requestSchema(document, path, method) {
  return document.paths[path][method].requestBody.content["application/json"].schema;
}

test("SaaS PATCH operations use explicit request schemas", () => {
  const document = buildOpenApiDocument();

  assert.deepEqual(requestSchema(document, "/v1/tasks/{taskId}", "patch"), {
    $ref: "#/components/schemas/TaskPatch",
  });
  assert.deepEqual(requestSchema(document, "/v1/schedules/{scheduleId}", "patch"), {
    $ref: "#/components/schemas/TaskSchedulePatch",
  });

  assert.equal(document.components.schemas.TaskPatch.additionalProperties, false);
  assert.equal(document.components.schemas.TaskPatch.minProperties, 1);
  assert.equal(document.components.schemas.TaskSchedulePatch.additionalProperties, false);
  assert.equal(document.components.schemas.TaskSchedulePatch.minProperties, 1);
});

test("TaskPatch preserves create-time field constraints without making fields required", () => {
  const document = buildOpenApiDocument();
  const patch = document.components.schemas.TaskPatch;

  assert.equal(patch.required, undefined);
  assert.equal(patch.properties.name.maxLength, 200);
  assert.equal(patch.properties.questions.maxItems, 5000);
  assert.equal(patch.properties.platforms.items.enum[0], "doubao");
  assert.equal(patch.properties.sampling.$ref, "#/components/schemas/TaskSamplingInput");
});

test("TaskSchedulePatch documents nested schedule fields and runtime compatibility aliases", () => {
  const document = buildOpenApiDocument();
  const patch = document.components.schemas.TaskSchedulePatch;

  assert.equal(patch.properties.schedule.properties.cadence.enum.includes("weekly"), true);
  assert.equal(patch.properties.sampling.properties.repeats.maximum, 100);
  assert.equal(patch.properties.account_ids.minItems, 1);
  assert.equal(patch.properties.cadence.deprecated, true);
  assert.equal(patch.properties.time_zone.deprecated, true);
});

test("monitoring plan create/update requests mirror runtime validation", () => {
  const document = buildOpenApiDocument();
  const create = document.components.schemas.MonitorPlanCreate;
  const patch = document.components.schemas.MonitorPlanPatch;

  assert.deepEqual(requestSchema(document, "/v1/projects/{projectId}/monitor-plans", "post"), {
    $ref: "#/components/schemas/MonitorPlanCreate",
  });
  assert.deepEqual(requestSchema(document, "/v1/monitor-plans/{monitorPlanId}", "patch"), {
    $ref: "#/components/schemas/MonitorPlanPatch",
  });

  assert.deepEqual(create.required, ["name", "accounts"]);
  assert.equal(create.additionalProperties, false);
  assert.equal(create.properties.size.maximum, 10000);
  assert.equal(create.properties.repeats.maximum, 100);
  assert.deepEqual(create.properties.method.enum, ["stratified", "random"]);
  assert.equal(create.properties.accounts.minItems, 1);
  assert.equal(create.properties.accounts.maxItems, 100);

  assert.equal(patch.required, undefined);
  assert.equal(patch.minProperties, 1);
  assert.equal(patch.additionalProperties, false);
});
