import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireSessionProxy,
  describePool,
  loadProxyPool,
  parseProxyPool,
  poolRuntimeSummary,
  releaseSessionProxy,
  resetPoolState,
} from "../src/proxy-pool.js";
import { extractProxyExits, parseHttpApiSource, redactUrl } from "../src/proxy-source-http-api.js";

const ENV = {
  ONEGL_PROXY_PROVIDER_TOKEN: "provider-secret-token",
  ONEGL_PROXY_USERNAME: "pxuser",
  ONEGL_PROXY_PASSWORD: "pxpass",
};

/** 本机假供应商。真实供应商不可用时也能把解析层验干净。 */
async function startProvider(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const record = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(record);
      handler(record, response, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function json(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

function text(response, body, status = 200) {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(body);
}

function apiSource(port, overrides = {}) {
  return {
    kind: "http_api",
    request: { method: "GET", url: `http://127.0.0.1:${port}/api/getip`, query: { num: 2 } },
    response: {
      format: "json",
      success: { path: "code", equals: 0 },
      items_path: "data.list",
      fields: { id: "id", host: "ip", port: "port", expires_at: "expire_time" },
      default_scheme: "http",
      expiry_format: "iso8601",
    },
    stability: { mode: "until_expiry" },
    inventory: { extract_count: 2, min_refresh_interval_seconds: 0, max_pool_size: 50 },
    ...overrides,
  };
}

function poolDocument(port, overrides = {}) {
  return {
    schema_version: 1,
    pool_id: "test_pool",
    enabled: true,
    required: true,
    platforms: ["doubao", "qianwen"],
    source: apiSource(port),
    ...overrides,
  };
}

function writePoolFile(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), "onegl-http-api-pool-"));
  const file = path.join(dir, "proxy-pool.json");
  writeFileSync(file, JSON.stringify(contents), "utf8");
  return file;
}

function inMinutes(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

test("a JSON extract maps vendor fields into normalised exits", async () => {
  const provider = await startProvider((_request, response) => {
    json(response, {
      code: 0,
      data: {
        list: [
          { id: "e1", ip: "198.51.100.10", port: 3128, expire_time: inMinutes(10) },
          { id: "e2", ip: "198.51.100.11", port: 3129, expire_time: inMinutes(10) },
        ],
      },
    });
  });
  try {
    const document = poolDocument(provider.port);
    document.source.default_auth = {
      username_env: "ONEGL_PROXY_USERNAME",
      password_env: "ONEGL_PROXY_PASSWORD",
    };
    const pool = parseProxyPool(document, { env: ENV });
    const { exits } = await extractProxyExits(pool.api, { env: ENV });
    assert.equal(exits.length, 2);
    assert.equal(exits[0].server, "http://198.51.100.10:3128");
    assert.equal(exits[0].username, "pxuser");
    assert.equal(exits[0].password, "pxpass");
    assert.equal(exits[0].stability, "until_expiry");
    assert.ok(exits[0].expires_at > Date.now());
    // 请求真的带上了配置的查询参数。
    assert.match(provider.requests[0].url, /num=2/);
  } finally {
    await provider.close();
  }
});

test("HTTP 200 with a failing business code is not treated as success", async () => {
  const provider = await startProvider((_request, response) => {
    json(response, { code: 1001, message: "余额不足" });
  });
  try {
    const pool = parseProxyPool(poolDocument(provider.port), { env: ENV });
    await assert.rejects(extractProxyExits(pool.api, { env: ENV }), /provider reported failure/);
  } finally {
    await provider.close();
  }
});

test("text_lines parses host:port and bracketed IPv6, and refuses an ambiguous 4-part line", async () => {
  const provider = await startProvider((_request, response) => {
    text(response, "1.2.3.4:8080\n[2001:db8::1]:9090\n\n# comment\n");
  });
  try {
    const pool = parseProxyPool(
      poolDocument(provider.port, {
        source: {
          kind: "http_api",
          request: { method: "GET", url: `http://127.0.0.1:${provider.port}/api/getip` },
          response: { format: "text_lines", default_scheme: "http" },
          stability: { mode: "fixed" },
          inventory: { min_refresh_interval_seconds: 0 },
        },
      }),
      { env: ENV },
    );
    const { exits } = await extractProxyExits(pool.api, { env: ENV });
    assert.deepEqual(
      exits.map((exit) => exit.server),
      ["http://1.2.3.4:8080", "http://[2001:db8::1]:9090"],
    );
  } finally {
    await provider.close();
  }
});

test("a plaintext ip:port:user:password line is refused rather than guessed", async () => {
  const provider = await startProvider((_request, response) => {
    text(response, "1.2.3.4:8080:alice:secret\n");
  });
  try {
    const pool = parseProxyPool(
      poolDocument(provider.port, {
        source: {
          kind: "http_api",
          request: { method: "GET", url: `http://127.0.0.1:${provider.port}/api/getip` },
          response: { format: "text_lines" },
          stability: { mode: "fixed" },
        },
      }),
      { env: ENV },
    );
    await assert.rejects(extractProxyExits(pool.api, { env: ENV }), /refusing to guess/);
  } finally {
    await provider.close();
  }
});

test("already-expired exits are dropped instead of being handed out", async () => {
  const provider = await startProvider((_request, response) => {
    json(response, {
      code: 0,
      data: {
        list: [
          { id: "dead", ip: "198.51.100.20", port: 3128, expire_time: inMinutes(-5) },
          { id: "live", ip: "198.51.100.21", port: 3128, expire_time: inMinutes(10) },
        ],
      },
    });
  });
  try {
    const pool = parseProxyPool(poolDocument(provider.port), { env: ENV });
    const { exits, rejected } = await extractProxyExits(pool.api, { env: ENV });
    assert.deepEqual(exits.map((exit) => exit.id), ["live"]);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0], /already expired/);
  } finally {
    await provider.close();
  }
});

test("until_expiry without an expiry_format is refused at parse time", () => {
  assert.throws(
    () =>
      parseProxyPool(
        poolDocument(9, {
          source: {
            kind: "http_api",
            request: { method: "GET", url: "https://provider.example.invalid/api" },
            response: { format: "json", fields: { host: "ip", port: "port" } },
            stability: { mode: "until_expiry" },
          },
        }),
        { env: ENV },
      ),
    /expiry_format is required when stability.mode is until_expiry/,
  );
});

test("a query-string secret never appears in the error text", async () => {
  const provider = await startProvider((_request, response) => {
    text(response, "upstream exploded", 500);
  });
  try {
    const pool = parseProxyPool(
      poolDocument(provider.port, {
        source: {
          kind: "http_api",
          request: {
            method: "GET",
            url: `http://127.0.0.1:${provider.port}/api/getip`,
            auth: { type: "query_env", env: "ONEGL_PROXY_PROVIDER_TOKEN", name: "token" },
          },
          response: { format: "json", fields: { host: "ip", port: "port" } },
          stability: { mode: "fixed" },
        },
      }),
      { env: ENV },
    );
    const error = await extractProxyExits(pool.api, { env: ENV }).catch((caught) => caught);
    assert.match(error.message, /HTTP 500/);
    assert.ok(
      !error.message.includes(ENV.ONEGL_PROXY_PROVIDER_TOKEN),
      `error message leaked the token: ${error.message}`,
    );
    assert.match(error.message, /token=\*\*\*/);
    // 但请求本身必须真的带上了它 —— 脱敏不能把认证也一起脱掉。
    assert.match(provider.requests[0].url, /token=provider-secret-token/);
  } finally {
    await provider.close();
  }
});

test("redactUrl masks secrets and leaves ordinary parameters alone", () => {
  assert.equal(
    redactUrl("https://p.example.invalid/api?num=2&token=abc&api_key=xyz"),
    "https://p.example.invalid/api?num=2&token=***&api_key=***",
  );
});

test("per_session hands out a different, unconsumed exit each time", async () => {
  const provider = await startProvider((_request, response, count) => {
    json(response, {
      code: 0,
      data: {
        list: [
          { id: `e${count}a`, ip: `10.0.${count}.1`, port: 3128, expire_time: inMinutes(10) },
          { id: `e${count}b`, ip: `10.0.${count}.2`, port: 3128, expire_time: inMinutes(10) },
        ],
      },
    });
  });
  const file = writePoolFile(
    poolDocument(provider.port, { acquisition: { mode: "per_session" } }),
  );
  try {
    resetPoolState(file);
    const config = { proxyPoolFile: file, provider: "doubao", accountKey: "acc_1" };
    const first = await acquireSessionProxy(config, { env: ENV });
    const second = await acquireSessionProxy(config, { env: ENV });
    const third = await acquireSessionProxy(config, { env: ENV });
    assert.equal(first.mode, "per_session");
    assert.notEqual(first.id, second.id);
    assert.notEqual(second.id, third.id);
    // 前两个来自同一次提取，第三个才需要再提取一次。
    assert.equal(provider.requests.length, 2);
    const summary = poolRuntimeSummary(file, "test_pool");
    assert.equal(summary.consumed_exits, 3);
  } finally {
    await provider.close();
  }
});

test("pooled keeps one exit per (platform, account, slot) until it expires", async () => {
  let extractions = 0;
  const provider = await startProvider((_request, response) => {
    extractions += 1;
    json(response, {
      code: 0,
      data: {
        list: [
          { id: `e${extractions}a`, ip: `10.1.${extractions}.1`, port: 3128, expire_time: inMinutes(10) },
          { id: `e${extractions}b`, ip: `10.1.${extractions}.2`, port: 3128, expire_time: inMinutes(10) },
        ],
      },
    });
  });
  const file = writePoolFile(poolDocument(provider.port));
  try {
    resetPoolState(file);
    const config = { proxyPoolFile: file, provider: "doubao", accountKey: "acc_1" };
    const first = await acquireSessionProxy(config, { env: ENV, slot: 0 });
    const again = await acquireSessionProxy(config, { env: ENV, slot: 0 });
    assert.equal(first.id, again.id, "同一个键必须绑定同一个出口 —— 这是会话粘性");
    assert.equal(provider.requests.length, 1);

    // 另一个槽位必须能拿到另一个出口，否则「多开窗口」还是在同一个 IP 上提交。
    const otherSlot = await acquireSessionProxy(config, { env: ENV, slot: 1 });
    assert.notEqual(first.id, otherSlot.id);
  } finally {
    await provider.close();
  }
});

test("concurrent session creations trigger exactly one extraction", async () => {
  const provider = await startProvider((_request, response) => {
    json(response, {
      code: 0,
      data: {
        list: Array.from({ length: 6 }, (_, index) => ({
          id: `e${index}`,
          ip: `10.2.0.${index + 1}`,
          port: 3128,
          expire_time: inMinutes(10),
        })),
      },
    });
  });
  const file = writePoolFile(
    poolDocument(provider.port, { acquisition: { mode: "per_session" } }),
  );
  try {
    resetPoolState(file);
    const config = { proxyPoolFile: file, provider: "doubao", accountKey: "acc_1" };
    const exits = await Promise.all(
      [0, 1, 2, 3].map((slot) => acquireSessionProxy(config, { env: ENV, slot })),
    );
    assert.equal(new Set(exits.map((exit) => exit.id)).size, 4);
    // 单飞：4 个并发请求只能打供应商一次。少了这条，槽位一放开就是把提取接口打成
    // 洪泛，供应商侧封 key 只是时间问题。
    assert.equal(provider.requests.length, 1);
  } finally {
    await provider.close();
  }
});

test("an exhausted pool throws instead of falling back to a direct connection", async () => {
  const provider = await startProvider((_request, response) => {
    json(response, { code: 0, data: { list: [] } });
  });
  const file = writePoolFile(
    poolDocument(provider.port, { acquisition: { mode: "per_session" } }),
  );
  try {
    resetPoolState(file);
    await assert.rejects(
      acquireSessionProxy({ proxyPoolFile: file, provider: "doubao", accountKey: "acc_1" }, { env: ENV }),
      /returned no usable exit/,
    );
  } finally {
    await provider.close();
  }
});

test("releaseSessionProxy with ok:false evicts the exit so the next session gets another", async () => {
  const provider = await startProvider((_request, response, count) => {
    json(response, {
      code: 0,
      data: {
        list: [
          { id: `gen${count}-a`, ip: `10.3.${count}.1`, port: 3128, expire_time: inMinutes(10) },
          { id: `gen${count}-b`, ip: `10.3.${count}.2`, port: 3128, expire_time: inMinutes(10) },
        ],
      },
    });
  });
  const file = writePoolFile(poolDocument(provider.port));
  try {
    resetPoolState(file);
    const config = { proxyPoolFile: file, provider: "doubao", accountKey: "acc_1" };
    const bad = await acquireSessionProxy(config, { env: ENV, slot: 0 });
    releaseSessionProxy(file, bad, { ok: false, reason: "test: line dead" });
    const replacement = await acquireSessionProxy(config, { env: ENV, slot: 0 });
    assert.notEqual(replacement.id, bad.id);
    assert.equal(poolRuntimeSummary(file, "test_pool").last_error, null);
  } finally {
    await provider.close();
  }
});

test("describePool never prints provider credentials or proxy passwords", () => {
  const document = poolDocument(9, {
    source: {
      kind: "http_api",
      request: {
        method: "GET",
        url: "https://provider.example.invalid/api/getip",
        auth: { type: "bearer_env", env: "ONEGL_PROXY_PROVIDER_TOKEN" },
      },
      response: { format: "json", fields: { host: "ip", port: "port" } },
      default_auth: { username_env: "ONEGL_PROXY_USERNAME", password_env: "ONEGL_PROXY_PASSWORD" },
      stability: { mode: "fixed" },
    },
  });
  const rendered = JSON.stringify(describePool(parseProxyPool(document, { env: ENV }), "/tmp/pool.json"));
  assert.ok(!rendered.includes(ENV.ONEGL_PROXY_PROVIDER_TOKEN), rendered);
  assert.ok(!rendered.includes(ENV.ONEGL_PROXY_PASSWORD), rendered);
  assert.match(rendered, /bearer_env/);
});

test("loadProxyPool reports a missing file instead of returning an empty pool", () => {
  assert.throws(() => loadProxyPool(path.join(tmpdir(), "onegl-no-such-pool.json"), { env: ENV }), /could not be read/);
});

test("parseHttpApiSource rejects a GET with a body and a credential-bearing URL", () => {
  assert.throws(
    () => parseHttpApiSource({ request: { method: "GET", url: "https://p.invalid/a", body: { a: 1 } } }, { env: ENV }),
    /not allowed with method GET/,
  );
  assert.throws(
    () => parseHttpApiSource({ request: { url: "https://user:pass@p.invalid/a" } }, { env: ENV }),
    /must not embed credentials/,
  );
});

test("parseHttpApiSource refuses a missing provider credential at config time", () => {
  assert.throws(
    () =>
      parseHttpApiSource(
        {
          request: {
            url: "https://p.invalid/a",
            auth: { type: "bearer_env", env: "ONEGL_NOT_SET_ANYWHERE" },
          },
          response: { format: "json", fields: { host: "ip", port: "port" } },
        },
        { env: ENV },
      ),
    /expected ONEGL_NOT_SET_ANYWHERE to be set/,
  );
});
