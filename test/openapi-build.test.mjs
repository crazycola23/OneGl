import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenApiDocument } from "../src/api/build-openapi.js";
import { openApiDocument } from "../src/api/openapi.js";

test("OpenAPI build is deterministic and side-effect free", () => {
  const first = buildOpenApiDocument();
  const second = buildOpenApiDocument();
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.equal(first.openapi, "3.1.0");
  assert.equal(first.info.version, "0.7.0");
  assert.equal(first.info.license?.identifier, "MIT");
});

test("runtime OpenAPI export is semantically identical to a fresh deterministic build", () => {
  assert.deepEqual(openApiDocument, buildOpenApiDocument());
});

test("OpenAPI build includes readiness and formal SaaS webhook contracts", () => {
  const document = buildOpenApiDocument();
  assert.ok(document.paths["/readyz"]?.get);
  assert.ok(document.paths["/readyz"].get.responses["200"]);
  assert.ok(document.paths["/readyz"].get.responses["503"]);

  for (const eventType of [
    "execution.completed",
    "execution.partial",
    "execution.failed",
    "execution.cancelled",
    "account.action_required",
    "account.ready",
  ]) {
    const receiver = document.webhooks?.[eventType]?.post;
    assert.ok(receiver, `${eventType} webhook must be documented`);
    assert.equal(
      receiver.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/SaasWebhookEvent",
    );
  }
});
