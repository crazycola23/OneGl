import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenApiDocument } from "../src/api/build-openapi.js";

const METHODS = ["get", "post", "put", "patch", "delete"];

function operations(document) {
  const result = [];
  for (const [pathname, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      if (pathItem?.[method]) result.push({ pathname, method, operation: pathItem[method] });
    }
  }
  return result;
}

function resolveLocalRef(document, value) {
  if (!value?.$ref?.startsWith("#/")) return value;
  return value.$ref.slice(2).split("/").reduce((target, key) => target?.[key], document);
}

function isBareObjectSchema(schema) {
  if (!schema || schema.$ref || schema.oneOf || schema.anyOf || schema.allOf) return false;
  const objectType = schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"));
  if (!objectType) return false;
  return !schema.properties && (!schema.additionalProperties || schema.additionalProperties === true);
}

test("every operation has a unique operationId and at least one tag", () => {
  const document = buildOpenApiDocument();
  const ids = new Set();
  const all = operations(document);
  assert.ok(all.length > 0);

  for (const { pathname, method, operation } of all) {
    assert.ok(operation.operationId, `${method.toUpperCase()} ${pathname} is missing operationId`);
    assert.ok(Array.isArray(operation.tags) && operation.tags.length > 0, `${operation.operationId} is missing tags`);
    assert.equal(ids.has(operation.operationId), false, `duplicate operationId ${operation.operationId}`);
    ids.add(operation.operationId);
  }
});

test("protected v1 operations declare common authentication and availability errors", () => {
  const document = buildOpenApiDocument();
  for (const { pathname, method, operation } of operations(document)) {
    if (!pathname.startsWith("/v1")) continue;
    for (const status of ["401", "403", "429", "503"]) {
      assert.ok(operation.responses?.[status], `${method.toUpperCase()} ${pathname} is missing ${status}`);
    }
    if (operation.requestBody && ["post", "put", "patch"].includes(method)) {
      assert.ok(operation.responses?.["400"], `${method.toUpperCase()} ${pathname} is missing 400`);
    }
  }
});

test("known runtime conflict and semantic validation errors are documented", () => {
  const document = buildOpenApiDocument();
  const expected = [
    ["/v1/accounts", "post", "422"],
    ["/v1/webhooks", "post", "422"],
    ["/v1/batches", "post", "422"],
    ["/v1/auth-sessions/{authSessionId}/screenshot", "get", "409"],
    ["/v1/batches/{batchId}/stop", "post", "409"],
    ["/v1/projects/{projectId}/monitor-plans", "post", "409"],
    ["/v1/monitor-plans/{monitorPlanId}", "patch", "409"],
  ];

  for (const [pathname, method, status] of expected) {
    assert.ok(
      document.paths?.[pathname]?.[method]?.responses?.[status],
      `${method.toUpperCase()} ${pathname} is missing runtime ${status}`,
    );
  }
});

test("response objects never mix $ref with sibling fields", () => {
  const document = buildOpenApiDocument();
  for (const { pathname, method, operation } of operations(document)) {
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (!response?.$ref) continue;
      assert.deepEqual(Object.keys(response), ["$ref"], `${method.toUpperCase()} ${pathname} ${status} has $ref siblings`);
    }
  }
});

test("all JSON success responses use concrete schemas instead of bare objects", () => {
  const document = buildOpenApiDocument();
  for (const { pathname, method, operation } of operations(document)) {
    for (const [status, unresolvedResponse] of Object.entries(operation.responses ?? {})) {
      if (!/^2\d\d$/.test(status)) continue;
      const response = resolveLocalRef(document, unresolvedResponse);
      const schema = response?.content?.["application/json"]?.schema;
      if (!schema) continue;
      assert.equal(
        isBareObjectSchema(resolveLocalRef(document, schema)),
        false,
        `${method.toUpperCase()} ${pathname} ${status} has a generic object response schema`,
      );
    }
  }
});

test("all JSON request bodies use concrete schemas instead of bare objects", () => {
  const document = buildOpenApiDocument();
  for (const { pathname, method, operation } of operations(document)) {
    const requestBody = resolveLocalRef(document, operation.requestBody);
    const schema = requestBody?.content?.["application/json"]?.schema;
    if (!schema) continue;
    assert.equal(
      isBareObjectSchema(resolveLocalRef(document, schema)),
      false,
      `${method.toUpperCase()} ${pathname} has a generic object request schema`,
    );
  }
});

test("status-bearing public core resources expose finite enums", () => {
  const document = buildOpenApiDocument();
  for (const schemaName of [
    "AccountResource",
    "AuthSessionResource",
    "BatchSummaryResource",
    "RunResource",
    "WebhookEventResource",
    "MonitorExecutionResource",
    "ScheduleExecutionItem",
  ]) {
    const status = document.components.schemas[schemaName]?.properties?.status;
    assert.ok(status, `${schemaName} is missing status`);
    assert.ok(Array.isArray(status.enum) && status.enum.length > 0, `${schemaName}.status must be an enum`);
  }
});

test("core lower-level API success responses use typed data envelopes", () => {
  const document = buildOpenApiDocument();
  const projects = document.paths["/v1/projects"].get.responses["200"].content["application/json"].schema;
  assert.equal(projects.properties.data.type, "array");
  assert.equal(projects.properties.data.items.$ref, "#/components/schemas/ProjectResource");

  const batch = document.paths["/v1/batches/{batchId}"].get.responses["200"].content["application/json"].schema;
  assert.equal(batch.properties.data.$ref, "#/components/schemas/BatchProgressResource");

  const run = document.paths["/v1/runs/{runId}"].get.responses["200"].content["application/json"].schema;
  assert.equal(run.properties.data.$ref, "#/components/schemas/RunDetailResource");

  const webhook = document.paths["/v1/webhooks"].post.responses["201"].content["application/json"].schema;
  assert.equal(webhook.properties.data.$ref, "#/components/schemas/WebhookResource");
});
