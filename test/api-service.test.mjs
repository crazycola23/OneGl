import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { parseBatchCreate, parseKeywordsCreate, parseLimit, parseProjectCreate } from "../src/api/contracts.js";
import { ApiHttpError, readJsonBody } from "../src/api/http.js";
import { openApiDocument } from "../src/api/openapi.js";
import {
  DEFAULT_SCOPES,
  hashApiKey,
  internalAccountKey,
  internalProjectName,
  requireScope,
  webhookSecretFor,
} from "../src/api/service-store.js";

test("tenant client keys are stored as hashes and scopes are enforced", () => {
  const plaintext = "onegl_client_secret_example";
  assert.notEqual(hashApiKey(plaintext), plaintext);
  assert.equal(hashApiKey(plaintext), hashApiKey(plaintext));

  assert.doesNotThrow(() => requireScope({ kind: "client", scopes: ["projects:read"] }, "projects:read"));
  assert.throws(
    () => requireScope({ kind: "client", scopes: ["projects:read"] }, "projects:write"),
    (error) => error instanceof ApiHttpError && error.status === 403,
  );
  assert.doesNotThrow(() => requireScope({ kind: "master", scopes: ["*"] }, "anything"));
  assert.ok(DEFAULT_SCOPES.includes("webhooks:write"));
});

test("tenant project names are internally namespaced without breaking legacy default tenant names", () => {
  assert.equal(internalProjectName({ slug: "default" }, "小米汽车"), "小米汽车");
  assert.equal(internalProjectName({ slug: "agency-a" }, "小米汽车"), "agency-a::小米汽车");
  assert.equal(internalAccountKey({ slug: "default" }, "account_01"), "account_01");
  assert.equal(internalAccountKey({ slug: "agency-a" }, "account_01"), "agency-a::account_01");
});

test("webhook signing secrets are deterministic per tenant and endpoint", () => {
  const previous = process.env.ONEGL_WEBHOOK_SIGNING_KEY;
  process.env.ONEGL_WEBHOOK_SIGNING_KEY = "test-master-signing-key";
  try {
    const a = webhookSecretFor(3, 9);
    const b = webhookSecretFor(3, 9);
    const c = webhookSecretFor(3, 10);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^whsec_[0-9a-f]{64}$/);
  } finally {
    if (previous == null) delete process.env.ONEGL_WEBHOOK_SIGNING_KEY;
    else process.env.ONEGL_WEBHOOK_SIGNING_KEY = previous;
  }
});

test("project contract normalizes optional bootstrap keywords", () => {
  const parsed = parseProjectCreate({
    name: " demo ",
    description: "  note ",
    target_brand: " Brand ",
    keywords: [" a ", "a", "", " b "],
    category: "  category ",
  });
  assert.deepEqual(parsed, {
    name: "demo",
    description: "note",
    targetBrand: "Brand",
    keywords: ["a", "b"],
    category: "category",
  });
});

test("batch contract validates method, limits and account list", () => {
  assert.deepEqual(
    parseBatchCreate({ project_id: 2, accounts: [" a ", "a", "b"], method: "random", repeats: 2, start: true }),
    {
      projectId: 2,
      name: null,
      size: null,
      method: "random",
      seed: null,
      accounts: ["a", "b"],
      repeats: 2,
      start: true,
    },
  );
  assert.throws(() => parseBatchCreate({ project_id: 1, accounts: [], method: "random" }), ApiHttpError);
  assert.throws(() => parseBatchCreate({ project_id: 1, accounts: ["a"], method: "nope" }), ApiHttpError);
  assert.equal(parseLimit("", 7, 20), 7);
  assert.equal(parseLimit("99", 7, 20), 20);
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

test("OpenAPI documents tenant clients, remote auth, webhooks and GEO intelligence without raw browser controls", () => {
  assert.equal(openApiDocument.openapi, "3.1.0");
  assert.equal(openApiDocument.info.version, "0.3.0");
  assert.ok(openApiDocument.paths["/v1/admin/tenants"]);
  assert.ok(openApiDocument.paths["/v1/admin/tenants/{tenantId}/clients"]);
  assert.ok(openApiDocument.paths["/v1/providers"]);
  assert.ok(openApiDocument.paths["/v1/projects"]);
  assert.ok(openApiDocument.paths["/v1/projects/{projectId}/competitors"]);
  assert.ok(openApiDocument.paths["/v1/accounts/{accountId}/auth-sessions"]);
  assert.ok(openApiDocument.paths["/v1/auth-sessions/{authSessionId}/screenshot"]);
  assert.ok(openApiDocument.paths["/v1/batches/{batchId}/start"]);
  assert.ok(openApiDocument.paths["/v1/batches/{batchId}/report"]);
  assert.ok(openApiDocument.paths["/v1/batches/{batchId}/intelligence"]);
  assert.ok(openApiDocument.paths["/v1/webhooks"]);
  assert.ok(openApiDocument.paths["/v1/webhooks/test"]);
  assert.ok(openApiDocument.paths["/v1/runs/{runId}"]);
  assert.equal(openApiDocument.paths["/click-new-chat"], undefined);
  assert.equal(openApiDocument.paths["/type-prompt"], undefined);
  assert.equal(openApiDocument.paths["/solve-captcha"], undefined);
});
