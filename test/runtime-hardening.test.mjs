import assert from "node:assert/strict";
import test from "node:test";

import { acquireAccountExecutionLease } from "../src/accounts/distributed-lock.js";
import { createPool } from "../src/db/pool.js";
import {
  isPublicIpAddress,
  parseOutboundUrl,
  resolvePublicTarget,
  validatePublicOutboundUrl,
} from "../src/security/outbound-url.js";

const dbEnabled = Boolean(process.env.DATABASE_URL);

test("outbound URL guard rejects local, private and reserved IP ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.10.0.4",
    "100.64.1.2",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "203.0.113.8",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) assert.equal(isPublicIpAddress(address), false, address);

  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("1.1.1.1"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
});

test("outbound URL guard rejects credentials and requires HTTPS by default", () => {
  assert.throws(() => parseOutboundUrl("http://example.com/hook"), /HTTPS/);
  assert.throws(() => parseOutboundUrl("https://user:pass@example.com/hook"), /credentials/);
  assert.equal(parseOutboundUrl("https://example.com/hook#fragment").hash, "");
});

test("DNS validation fails closed when any answer is non-public", async () => {
  const mixedLookup = async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await assert.rejects(
    () => validatePublicOutboundUrl("https://webhook.example.test/path", { lookup: mixedLookup }),
    /non-public address/,
  );

  const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];
  const normalized = await validatePublicOutboundUrl("https://webhook.example.test/path", { lookup: publicLookup });
  assert.equal(normalized, "https://webhook.example.test/path");
  assert.deepEqual(
    await resolvePublicTarget(new URL(normalized), { lookup: publicLookup }),
    [{ address: "8.8.8.8", family: 4 }],
  );
});

test("PostgreSQL advisory lease prevents same-account and global cross-process concurrency", { skip: !dbEnabled }, async () => {
  const pool = createPool();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let first = null;
  let second = null;
  try {
    first = await acquireAccountExecutionLease(pool, { accountKey: `account-a-${suffix}`, parallelism: 1 });
    assert.ok(first);

    const sameAccount = await acquireAccountExecutionLease(pool, { accountKey: `account-a-${suffix}`, parallelism: 1 });
    assert.equal(sameAccount, null);

    const otherAccountNoGlobalSlot = await acquireAccountExecutionLease(pool, { accountKey: `account-b-${suffix}`, parallelism: 1 });
    assert.equal(otherAccountNoGlobalSlot, null);

    await first.release();
    first = null;

    second = await acquireAccountExecutionLease(pool, { accountKey: `account-b-${suffix}`, parallelism: 1 });
    assert.ok(second);
  } finally {
    await first?.release().catch(() => undefined);
    await second?.release().catch(() => undefined);
    await pool.end();
  }
});
