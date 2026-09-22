import assert from "node:assert/strict";
import test from "node:test";

import { checkExecutionAccounts } from "../src/api/task-routes.js";
import { ApiHttpError } from "../src/api/http.js";

/**
 * The gate that decided "is this account executable" without ever asking which platform it
 * belongs to. A Doubao row and a Qianwen row can share an account_key, so the pre-fix query
 * answered for whichever row came back first.
 */
function fakeDb({ bindings, accounts }) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (sql.includes("FROM service_account_bindings")) {
        const [, provider, ids] = params;
        const rows = bindings
          .filter((row) => row.provider === provider && ids.includes(row.external_id))
          .map(({ external_id, account_key }) => ({ external_id, account_key }));
        return { rows };
      }
      if (sql.includes("FROM accounts")) {
        const [keys, provider] = params;
        return { rows: accounts.filter((row) => row.provider === provider && keys.includes(row.account_key)) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

const BINDINGS = [
  { provider: "doubao", external_id: "acct-main", account_key: "lane_01" },
  { provider: "qianwen", external_id: "acct-qw", account_key: "lane_01" },
];
const ACCOUNTS = [
  { provider: "doubao", account_key: "lane_01", enabled: true, status: "verification_required", cooldown_until: null },
  { provider: "qianwen", account_key: "lane_01", enabled: true, status: "healthy", cooldown_until: null },
];

test("a Qianwen task is judged on the Qianwen row, not the Doubao one sharing the key", async () => {
  const db = fakeDb({ bindings: BINDINGS, accounts: ACCOUNTS });
  const resolved = await checkExecutionAccounts(db, 7, ["acct-qw"], "qianwen");
  assert.deepEqual(resolved.map((row) => row.accountKey), ["lane_01"]);
  const accountQuery = db.seen.find((entry) => entry.sql.includes("FROM accounts"));
  assert.match(accountQuery.sql, /WHERE provider = \$2/, "the availability query must filter by platform");
  assert.deepEqual(accountQuery.params, [["lane_01"], "qianwen"]);
});

test("a manual block on the other platform does not stop a healthy Qianwen account", async () => {
  // Doubao's lane_01 needs manual verification above; lose the platform here and the gate
  // answers 409 for a Qianwen task that is perfectly runnable.
  const db = fakeDb({ bindings: BINDINGS, accounts: ACCOUNTS });
  await assert.doesNotReject(() => checkExecutionAccounts(db, 7, ["acct-qw"], "qianwen"));
});

test("an external id bound only on another platform resolves to nothing", async () => {
  const db = fakeDb({ bindings: BINDINGS, accounts: ACCOUNTS });
  await assert.rejects(
    () => checkExecutionAccounts(db, 7, ["acct-main"], "qianwen"),
    (error) => error instanceof ApiHttpError && error.code === "unknown_accounts",
  );
});

test("a blocked account on the task's own platform still reports which one needs attention", async () => {
  const db = fakeDb({ bindings: BINDINGS, accounts: ACCOUNTS });
  await assert.rejects(
    () => checkExecutionAccounts(db, 7, ["acct-main"], "doubao"),
    (error) => {
      assert.equal(error.code, "account_action_required");
      assert.deepEqual(error.details.accounts, [
        { account_id: "acct-main", status: "verification_required", cooldown_until: null },
      ]);
      return true;
    },
  );
});

test("cooldown is not a creation-time block; only manual states are", async () => {
  // Pinned because it is a boundary, not an accident: the queue re-checks cooldown per job and
  // delays instead of refusing, so refusing a task here would be the wrong layer.
  const cooling = [
    { provider: "qianwen", external_id: "acct-qw", account_key: "lane_01" },
  ];
  const db = fakeDb({
    bindings: cooling,
    accounts: [{ provider: "qianwen", account_key: "lane_01", enabled: true, status: "cooldown", cooldown_until: "2099-01-01" }],
  });
  await assert.doesNotReject(() => checkExecutionAccounts(db, 7, ["acct-qw"], "qianwen"));
});

test("an account-less request is rejected with the platform named", async () => {
  const db = fakeDb({ bindings: BINDINGS, accounts: ACCOUNTS });
  await assert.rejects(
    () => checkExecutionAccounts(db, 7, [], "qianwen"),
    (error) => error.code === "account_required" && /qianwen/.test(error.message),
  );
});
