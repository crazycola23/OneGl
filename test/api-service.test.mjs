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

test("API credentials accept bearer and X-API-Key without exposing comparison timing", () => {
  assert.equal(apiCredentialFromHeaders({ authorization: "Bearer secret-123" }), "secret-123");
  assert.equal(apiCredentialFromHeaders({ "x-api-key": "key-456" }), "key-456");
  assert.equal(secureStringEqual("same-value", "same-value"), true);
  assert.equal(secureStringEqual("same-value", "other-value"), false);
  assert.equal(secureStringEqual("short", "longer-value"), false);

  assert.equal(
    isApiRequestAuthorized({ headers: { authorization: "Bearer service-key" } }, "service-key"),
    true,
  );
  assert.equal(
    isApiRequestAuthorized({ headers: { "x-api-key": "wrong" } }, "service-key"),
    false,
  );
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

test("OpenAPI describes the business API and does not expose browser-control endpoints", () => {
  assert.equal(openApiDocument.openapi, "3.1.0");
  assert.ok(openApiDocument.paths["/v1/projects"]);
  assert.ok(openApiDocument.paths["/v1/batches"]);
  assert.ok(openApiDocument.paths["/v1/batches/{batchId}/start"]);
  assert.ok(openApiDocument.paths["/v1/batches/{batchId}/report"]);
  assert.ok(openApiDocument.paths["/v1/runs/{runId}"]);
  assert.equal(openApiDocument.paths["/click-new-chat"], undefined);
  assert.equal(openApiDocument.paths["/type-prompt"], undefined);
});
