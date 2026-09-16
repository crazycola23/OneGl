import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  apiCredentialFromHeaders,
  isApiRequestAuthorized,
  secureStringEqual,
} from "../src/api/auth.js";
import { parseBatchCreate, parseProjectCreate } from "../src/api/contracts.js";
import { ApiHttpError, readJsonBody } from "../src/api/http.js";
import { openApiDocument } from "../src/api/openapi.js";
import {
  hashServiceKey,
  internalProjectName,
  requireScope,
  webhookSecretFor,
} from "../src/api/service-store.js";

test("API credentials accept bearer and X-API-Key without exposing comparison timing", () => {
  assert.equal(apiCredentialFromHeaders({ authorization: "Bearer secret-123" }), "secret-123");
  assert.equal(apiCredentialFromHeaders({ "x-api-key": "key-456" }), "key-456");
  assert.equal(secureStringEqual("same-value", "same-value"), true);
  assert.equal(secureStringEqual("same-value", "other-value"), false);
  assert.equal(secureStringEqual("short", "longer-value"), false);
  assert.equal(isApiRequestAuthorized({ headers: { authorization: "Bearer service-key" } }, "service-key"), true);
  assert.equal(isApiRequestAuthorized({ headers: { "x-api-key": "wrong" } }, "service-key"), false);
});

test("tenant client keys are stored as hashes and scopes are enforced", () => {
  assert.equal(hashServiceKey("alpha"), hashServiceKey("alpha"));
  assert.notEqual(hashServiceKey("alpha"), hashServiceKey("beta"));
  assert.doesNotThrow(() => requireScope({ master: false, scopes: ["projects:read"] }, "projects:read"));
  assert.throws(
    () => requireScope({ master: false, scopes: ["projects:read"] }, "batches:write"),
    (error) => error instanceof ApiHttpError && error.status === 403,
  );
  assert.doesNotThrow(() => requireScope({ master: true, scopes: [] }, "anything:write"));
});

test("tenant project names are internally namespaced without breaking legacy default tenant names", () => {
  assert.equal(internalProjectName({ slug: "acme" }, "小米汽车"), "acme::小米汽车");
  assert.equal(internalProjectName({ slug: "default" }, "Demo"), "Demo");
});

test("webhook signing secrets are deterministic per tenant and endpoint", () => {
  const previous = process.env.ONEGL_WEBHOOK_SIGNING_KEY;
  process.env.ONEGL_WEBHOOK_SIGNING_KEY = "test-root-signing-key";
  try {
    const one = webhookSecretFor(1, 10);
    assert.equal(one, webhookSecretFor(1, 10));
    assert.notEqual(one, webhookSecretFor(1, 11));
    assert.notEqual(one, webhookSecretFor(2, 10));
  } finally {
    if (previous == null) delete process.env.ONEGL_WEBHOOK_SIGNING_KEY;
    else process.env.ONEGL_WEBHOOK_SIGNING_KEY = previous;
  }
});

test("project contract normalizes optional bootstrap keywords", () => {
  assert.deepEqual(
    parseProjectCreate({
      name: " 小米汽车 ",
      target_brand: " 小米 ",
      keywords: ["20万新能源SUV", "20万新能源SUV", "国产新能源推荐"],
      category: " recommendation ",
    }),
    {
      name: "小米汽车",
      description: null,
      targetBrand: "小米",
      keywords: ["20万新能源SUV", "国产新能源推荐"],
      category: "recommendation",
    },
  );
});

test("batch contract validates method, limits and account list", () => {
  assert.deepEqual(
    parseBatchCreate({
      project_id: 12,
      accounts: ["account_01", "account_01", "account_02"],
      repeats: 3,
      size: 20,
      method: "RANDOM",
      start: true,
    }),
    {
      projectId: 12,
      size: 20,
      repeats: 3,
      accounts: ["account_01", "account_02"],
      method: "random",
      seed: null,
      name: null,
      start: true,
    },
  );

  assert.throws(
    () => parseBatchCreate({ project_id: 1, accounts: ["account_01"], method: "unknown" }),
    (error) => error instanceof ApiHttpError && error.status === 400,
  );
});

test("JSON reader rejects invalid and oversized request bodies", async () => {
  const valid = Readable.from([Buffer.from('{"name":"demo"}')]);
  assert.deepEqual(await readJsonBody(valid), { name: "demo" });

  const invalid = Readable.from([Buffer.from("not-json")]);
  await assert.rejects(
    () => readJsonBody(invalid),
    (error) => error instanceof ApiHttpError && error.code === "invalid_json",
  );

  const oversized = Readable.from([Buffer.from("123456")]);
  await assert.rejects(
    () => readJsonBody(oversized, { maxBytes: 5 }),
    (error) => error instanceof ApiHttpError && error.status === 413,
  );
});

test("OpenAPI documents tenant clients, remote auth, webhooks and business API without raw browser controls", () => {
  assert.equal(openApiDocument.openapi, "3.1.0");
  assert.equal(openApiDocument.info.version, "0.2.0");
  assert.ok(openApiDocument.paths["/v1/admin/tenants"]);
  assert.ok(openApiDocument.paths["/v1/admin/tenants/{tenantId}/clients"]);
  assert.ok(openApiDocument.paths["/v1/projects"]);
  assert.ok(openApiDocument.paths["/v1/accounts/{accountId}/auth-sessions"]);
  assert.ok(openApiDocument.paths["/v1/auth-sessions/{authSessionId}/screenshot"]);
  assert.ok(openApiDocument.paths["/v1/batches/{batchId}/start"]);
  assert.ok(openApiDocument.paths["/v1/batches/{batchId}/report"]);
  assert.ok(openApiDocument.paths["/v1/webhooks"]);
  assert.ok(openApiDocument.paths["/v1/webhooks/test"]);
  assert.ok(openApiDocument.paths["/v1/runs/{runId}"]);
  assert.equal(openApiDocument.paths["/click-new-chat"], undefined);
  assert.equal(openApiDocument.paths["/type-prompt"], undefined);
  assert.equal(openApiDocument.paths["/solve-captcha"], undefined);
});
