import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { parseBatchCreate, parseKeywordsCreate, parseLimit, parseProjectCreate } from "../src/api/contracts.js";
import { ApiHttpError, readJsonBody } from "../src/api/http.js";
import { openApiDocument } from "../src/api/openapi.js";
import { applySaasOpenApi } from "../src/api/saas-openapi.js";
import {
  DEFAULT_SCOPES,
  hashServiceKey,
  internalProjectName,
  requireScope,
  webhookSecretFor,
} from "../src/api/service-store.js";

applySaasOpenApi(openApiDocument);

test("tenant client keys are stored as hashes and scopes are enforced", () => {
  const plaintext = "onegl_client_secret_example";
  assert.notEqual(hashServiceKey(plaintext), plaintext);
  assert.equal(hashServiceKey(plaintext), hashServiceKey(plaintext));

  assert.doesNotThrow(() => requireScope({ kind: "client", scopes: ["projects:read"] }, "projects:read"));
  assert.throws(
    () => requireScope({ kind: "client", scopes: ["projects:read"] }, "projects:write"),
    (error) => error instanceof ApiHttpError && error.status === 403,
  );
  assert.doesNotThrow(() => requireScope({ kind: "master", master: true, scopes: ["*"] }, "anything"));
  assert.ok(DEFAULT_SCOPES.includes("webhooks:write"));
});

test("service project names are opaque and cannot be chosen by another tenant", () => {
  const first = internalProjectName({ id: 1, slug: "default" }, "小米汽车");
  const second = internalProjectName({ id: 1, slug: "default" }, "小米汽车");
  const otherTenant = internalProjectName({ id: 2, slug: "agency-a" }, "小米汽车");

  assert.match(first, /^svc:t1:[a-f0-9]{16}:[a-f0-9]{12}$/);
  assert.match(otherTenant, /^svc:t2:[a-f0-9]{16}:[a-f0-9]{12}$/);
  assert.notEqual(first, second);
  assert.notEqual(first, otherTenant);
  assert.equal(first.includes("小米汽车"), false);
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
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
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
      // 不传 platform 的既有集成必须继续落在默认平台上。
      platform: "doubao",
      start: true,
    },
  );
  assert.throws(() => parseBatchCreate({ project_id: 1, accounts: [], method: "random" }), ApiHttpError);
  assert.throws(() => parseBatchCreate({ project_id: 1, accounts: ["a"], method: "nope" }), ApiHttpError);
  assert.equal(parseBatchCreate({ project_id: 1, accounts: ["a"], platform: "Qianwen " }).platform, "qianwen");
  assert.throws(
    () => parseBatchCreate({ project_id: 1, accounts: ["a"], platform: "yuanbao" }),
    (error) => error instanceof ApiHttpError && error.code === "unsupported_platform",
    "an unregistered platform must be rejected at the edge, not enqueued and left stranded",
  );
  assert.equal(parseLimit("", 7, 20), 7);
  assert.equal(parseLimit("20", 7, 20), 20);
  assert.throws(() => parseLimit("99", 7, 20), ApiHttpError);
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

test("OpenAPI documents SaaS tasks plus Doubao monitoring without raw browser controls", () => {
  assert.equal(openApiDocument.openapi, "3.1.0");
  assert.equal(openApiDocument.info.version, "0.7.0");
  assert.ok(openApiDocument.paths["/v1/admin/tenants"]);
  assert.ok(openApiDocument.paths["/v1/providers"]);
  assert.ok(openApiDocument.paths["/v1/projects/{projectId}/monitor-plans"]);
  assert.ok(openApiDocument.paths["/v1/tasks"]);
  assert.ok(openApiDocument.paths["/v1/tasks/{taskId}"]);
  assert.ok(openApiDocument.paths["/v1/tasks/{taskId}/executions"]);
  assert.ok(openApiDocument.paths["/v1/executions/{executionId}"]);
  assert.ok(openApiDocument.paths["/v1/executions/{executionId}/pause"]);
  assert.ok(openApiDocument.paths["/v1/executions/{executionId}/resume"]);
  assert.ok(openApiDocument.paths["/v1/executions/{executionId}/cancel"]);
  assert.ok(openApiDocument.paths["/v1/results/{resultId}"]);
  assert.ok(openApiDocument.paths["/v1/reports/{reportId}"]);
  assert.ok(openApiDocument.paths["/v1/tasks/{taskId}/schedules"]);
  assert.ok(openApiDocument.paths["/v1/schedules/{scheduleId}/executions"]);
  assert.ok(openApiDocument.paths["/v1/projects/{projectId}/intelligence"]);
  assert.ok(openApiDocument.components.schemas.TaskResource);
  assert.ok(openApiDocument.components.schemas.ExecutionResource);
  assert.ok(openApiDocument.components.schemas.ResultResource);
  assert.ok(openApiDocument.components.schemas.ReportResource);
  assert.ok(openApiDocument.components.schemas.PageMeta);
  assert.ok(openApiDocument.components.schemas.SaasWebhookEvent);
  assert.deepEqual(openApiDocument.components.schemas.ReportResource.properties.status.enum, ["generating", "ready"]);
  assert.match(openApiDocument.paths["/v1/projects/{projectId}/intelligence"].get.description, /sourceContent/);
  assert.equal(openApiDocument.paths["/click-new-chat"], undefined);
  assert.equal(openApiDocument.paths["/type-prompt"], undefined);
  assert.equal(openApiDocument.paths["/solve-captcha"], undefined);
});
