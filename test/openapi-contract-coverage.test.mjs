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

test("response objects never mix $ref with sibling fields", () => {
  const document = buildOpenApiDocument();
  for (const { pathname, method, operation } of operations(document)) {
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (!response?.$ref) continue;
      assert.deepEqual(Object.keys(response), ["$ref"], `${method.toUpperCase()} ${pathname} ${status} has $ref siblings`);
    }
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
