import assert from "node:assert/strict";
import test from "node:test";

import {
  accountIdentity,
  accountQueueName,
  parseAccountIdentity,
} from "../src/queue/connection.js";
import { accountQueueNamesFor } from "../src/queue/batches.js";

const KEY = "account_01";

test("queue names carry the platform so two providers never share a serial lane", () => {
  assert.equal(accountQueueName(KEY), "onegl-run-doubao-account_01");
  assert.equal(accountQueueName(KEY, "yuanbao"), "onegl-run-yuanbao-account_01");
  assert.notEqual(accountQueueName(KEY, "doubao"), accountQueueName(KEY, "qianwen"));
});

test("the queue name is derived from the assignment's own platform", () => {
  const names = accountQueueNamesFor([
    { accountKey: KEY, provider: "doubao" },
    { accountKey: KEY, provider: "doubao" },
    { accountKey: KEY, provider: "deepseek" },
    { accountKey: "account_02", provider: "doubao" },
  ]);
  assert.deepEqual(names, [
    "onegl-run-doubao-account_01",
    "onegl-run-deepseek-account_01",
    "onegl-run-doubao-account_02",
  ]);
});

test("identity round-trips, which is what lets a stale sweep stop the right worker", () => {
  for (const provider of ["doubao", "yuanbao", "deepseek-web"]) {
    assert.deepEqual(parseAccountIdentity(accountIdentity(KEY, provider)), {
      accountKey: KEY,
      provider,
    });
  }
});

test("a key that is not an identity is rejected instead of defaulting to Doubao", () => {
  // Silently reading a bare key as "doubao" would stop the wrong platform's worker.
  for (const bad of ["account_01", ":account_01", "doubao:", null, undefined]) {
    assert.throws(() => parseAccountIdentity(bad), /账号身份串不合法/);
  }
});
