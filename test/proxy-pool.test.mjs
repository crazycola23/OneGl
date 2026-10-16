import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  describeProxy,
  normalizeProxyServer,
  parseProxyPool,
  playwrightProxy,
  resolveSessionProxy,
  selectExit,
} from "../src/proxy-pool.js";

const ENV = {
  ONEGL_PROXY_A_USERNAME: "proxy",
  ONEGL_PROXY_A_PASSWORD: "secret",
};

function poolDocument(overrides = {}) {
  return {
    schema_version: 1,
    pool_id: "shared_web",
    enabled: true,
    required: true,
    platforms: ["doubao", "qianwen"],
    source: {
      kind: "static",
      items: [
        { id: "exit_a", server: "http://proxy-a.example.invalid:3128", auth: { username_env: "ONEGL_PROXY_A_USERNAME", password_env: "ONEGL_PROXY_A_PASSWORD" }, stability: { mode: "fixed" } },
        { id: "exit_b", server: "http://proxy-b.example.invalid:3128", stability: { mode: "fixed" } },
      ],
    },
    ...overrides,
  };
}

test("a static pool resolves credentials from env and never embeds them in the server", () => {
  const pool = parseProxyPool(poolDocument(), { env: ENV });
  assert.equal(pool.exits.length, 2);
  assert.deepEqual(pool.exits[0], {
    id: "exit_a",
    server: "http://proxy-a.example.invalid:3128",
    stability: "fixed",
    username: "proxy",
    password: "secret",
    expires_at: null,
    source_id: "exit_a",
  });
  assert.equal(pool.exits[1].username, null);
});

test("credentials in the server URL are rejected instead of being forwarded", () => {
  assert.throws(() => normalizeProxyServer("http://user:pass@host:3128"), /must not embed credentials/);
  assert.throws(() => normalizeProxyServer("http://host:3128/path"), /path, query or fragment/);
  assert.throws(() => normalizeProxyServer("http://host"), /explicit port/);
  assert.throws(() => normalizeProxyServer("socks5://host:1080"), /http:\/\/ or https:\/\//);
});

test("half-configured auth fails loudly rather than becoming an anonymous request", () => {
  const document = poolDocument();
  document.source.items[0].auth = { username_env: "ONEGL_PROXY_A_USERNAME" };
  assert.throws(() => parseProxyPool(document, { env: ENV }), /username_env and password_env together/);

  const missing = poolDocument();
  missing.source.items[0].auth = { username_env: "ONEGL_PROXY_MISSING_USER", password_env: "ONEGL_PROXY_MISSING_PASS" };
  assert.throws(() => parseProxyPool(missing, { env: ENV }), /credentials are missing/);
});

test("assignment is stable per platform and account, and spreads across exits", () => {
  const pool = parseProxyPool(poolDocument(), { env: ENV });
  const first = selectExit(pool, { platform: "doubao", accountKey: "acc_1" });
  const again = selectExit(pool, { platform: "doubao", accountKey: "acc_1" });
  assert.equal(first.id, again.id);
  assert.equal(first.server, "http://proxy-a.example.invalid:3128");

  const chosen = new Set(
    ["acc_1", "acc_2", "acc_3", "acc_4", "acc_5", "acc_6"].map(
      (accountKey) => selectExit(pool, { platform: "doubao", accountKey }).id,
    ),
  );
  assert.ok(chosen.size > 1, "expected the hash to spread accounts across both exits");
});

test("同一个账号的不同槽位必须落在不同出口（池子够大时）", () => {
  // 6 个出口给 4 个槽位，哈希应当给出 4 个互不相同的出口。
  // 这条锁住的是 2026-10-16 的发现：原来哈希键里没有 slot，
  // 同账号的多开全落在同一个 IP 上 —— 那正是 9-30 收紧槽位的实测配置。
  const document = poolDocument();
  document.source.items = Array.from({ length: 6 }, (_, index) => ({
    id: `exit_${index}`,
    server: `http://proxy-${index}.example.invalid:3128`,
    stability: { mode: "fixed" },
  }));
  const pool = parseProxyPool(document, { env: ENV });

  const bySlot = [0, 1, 2, 3].map(
    (slot) => selectExit(pool, { platform: "doubao", accountKey: "acc_1", slot }).id,
  );
  assert.equal(new Set(bySlot).size, bySlot.length, `槽位应拿到不同出口，实得 ${bySlot.join(",")}`);

  // 同一个槽位重复取必须稳定（否则每次冷启动换出口，会话粘性就没了）
  assert.equal(
    selectExit(pool, { platform: "doubao", accountKey: "acc_1", slot: 2 }).id,
    bySlot[2],
  );
  // 不带 slot 时等价于 slot=0 —— 保证老调用方的行为不变
  assert.equal(
    selectExit(pool, { platform: "doubao", accountKey: "acc_1" }).id,
    bySlot[0],
  );
});

test("a required but disabled pool blocks the session instead of falling back to direct", () => {
  const file = writePoolFile(poolDocument({ enabled: false, required: true }));
  assert.throws(
    () => resolveSessionProxy({ proxyPoolFile: file, provider: "doubao", accountKey: "acc_1" }, { env: ENV }),
    /is required for platform doubao but disabled/,
  );
});

test("an optional disabled pool leaves the session direct", () => {
  const file = writePoolFile(poolDocument({ enabled: false, required: false }));
  assert.equal(
    resolveSessionProxy({ proxyPoolFile: file, provider: "doubao", accountKey: "acc_1" }, { env: ENV }),
    null,
  );
});

test("platforms outside the pool keep their previous direct behaviour", () => {
  const file = writePoolFile(poolDocument({ required: true }));
  assert.equal(
    resolveSessionProxy({ proxyPoolFile: file, provider: "wenxin", accountKey: "acc_1" }, { env: ENV }),
    null,
  );
  assert.equal(resolveSessionProxy({ proxyPoolFile: null, provider: "doubao" }, { env: ENV }), null);
});

test("a missing or malformed pool file fails closed when an entry point is configured", () => {
  assert.throws(
    () => resolveSessionProxy({ proxyPoolFile: path.join(tmpdir(), "onegl-does-not-exist.json"), provider: "doubao" }, { env: ENV }),
    /could not be read/,
  );
  const file = writePoolFile("{ not json");
  assert.throws(
    () => resolveSessionProxy({ proxyPoolFile: file, provider: "doubao" }, { env: ENV }),
    /is not valid JSON/,
  );
});

test("an unknown source kind is refused instead of silently falling back to direct", () => {
  const document = poolDocument();
  document.source = { kind: "carrier_pigeon", request: { url: "https://provider.example.invalid/api" } };
  assert.throws(() => parseProxyPool(document, { env: ENV }), /expected static or http_api/);
});

test("an http_api pool parses, but the synchronous resolver refuses to fake it", () => {
  const document = poolDocument();
  document.source = {
    kind: "http_api",
    request: { method: "GET", url: "https://provider.example.invalid/api/getip" },
    response: { format: "json", fields: { host: "ip", port: "port" } },
  };
  const pool = parseProxyPool(document, { env: ENV });
  assert.equal(pool.sourceKind, "http_api");
  assert.equal(pool.exits, undefined);
  assert.equal(pool.api.request.method, "GET");

  const file = writePoolFile(document);
  assert.throws(
    () => resolveSessionProxy({ proxyPoolFile: file, provider: "doubao", accountKey: "acc_1" }, { env: ENV }),
    /call acquireSessionProxy\(\) instead/,
  );
});

test("per_session is refused on a static source (fixed exits never rotate)", () => {
  const document = poolDocument({ acquisition: { mode: "per_session" } });
  assert.throws(() => parseProxyPool(document, { env: ENV }), /never change/);
});

test("an exit with no remaining lifetime is skipped, not handed out", () => {
  const document = poolDocument();
  document.min_session_lifetime_ms = 120_000;
  const pool = parseProxyPool(document, { env: ENV });
  // 两个静态出口没有 expires_at，所以永远可用；这里锁的是「过滤只对声明了寿命的出口生效」。
  assert.ok(selectExit(pool, { platform: "doubao", accountKey: "acc_1", minRemainingMs: 120_000 }));

  // 声明了 10 秒寿命的出口，在要求 120 秒会话预算时必须被跳过。
  const expiring = parseProxyPool(
    {
      ...document,
      source: {
        kind: "static",
        items: [
          { id: "short", server: "http://short.example.invalid:3128", stability: { mode: "until_expiry" } },
          { id: "long", server: "http://long.example.invalid:3128", stability: { mode: "until_expiry" } },
        ],
      },
    },
    { env: ENV },
  );
  expiring.exits[0].expires_at = Date.now() + 10_000;
  expiring.exits[1].expires_at = Date.now() + 600_000;
  for (let slot = 0; slot < 8; slot += 1) {
    assert.equal(
      selectExit(expiring, { platform: "doubao", accountKey: `acc_${slot}`, slot, minRemainingMs: 120_000 }).id,
      "long",
    );
  }
});

test("credentials stay out of the descriptor and reach Playwright only as fields", () => {
  const exit = { ...parseProxyPool(poolDocument(), { env: ENV }).exits[0], poolId: "shared_web", required: true };
  assert.deepEqual(playwrightProxy(exit), {
    server: "http://proxy-a.example.invalid:3128",
    username: "proxy",
    password: "secret",
  });
  const described = describeProxy(exit);
  assert.deepEqual(described, {
    pool_id: "shared_web",
    exit_id: "exit_a",
    server: "http://proxy-a.example.invalid:3128",
    authenticated: true,
    stability: "fixed",
    required: true,
    mode: null,
    expires_at: null,
  });
  assert.ok(!JSON.stringify(described).includes("secret"));
  assert.equal(playwrightProxy(null), undefined);
});

function writePoolFile(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), "onegl-proxy-pool-"));
  const file = path.join(dir, "proxy-pool.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return file;
}
