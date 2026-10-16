import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import {
  ProxyEgressError,
  extractEgressIp,
  probeDirectEgress,
  probeEgressThroughProxy,
} from "../src/proxy-egress.js";

/**
 * 本机自建的 CONNECT 代理 + 回显服务。
 *
 * 为什么要自己搭：出口探针的**唯一职责**就是证明「流量真的走了这台代理」，
 * 而这件事只有在一个受控代理上才验得干净 —— 拿真供应商验，失败时分不清
 * 是探针错了还是线路错了。
 */
async function startEchoServer({ ip = "203.0.113.7" } = {}) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`${ip}\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, ip };
}

async function startConnectProxy({ requiredAuth = null, allow = true } = {}) {
  const seen = [];
  const server = http.createServer((request, response) => {
    response.writeHead(405);
    response.end("CONNECT only");
  });
  server.on("connect", (request, clientSocket, head) => {
    seen.push({ url: request.url, authorization: request.headers["proxy-authorization"] ?? null });
    if (!allow) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    if (requiredAuth && request.headers["proxy-authorization"] !== requiredAuth) {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    const [host, port] = request.url.split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, seen };
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("extractEgressIp reads the first IPv4 out of an echo body", () => {
  assert.equal(extractEgressIp("203.0.113.7\n"), "203.0.113.7");
  assert.equal(extractEgressIp('{"ip":"198.51.100.4"}'), "198.51.100.4");
  assert.equal(extractEgressIp("no address here"), null);
});

test("the probe reports the address the tunnel actually carried", async () => {
  const echo = await startEchoServer({ ip: "203.0.113.7" });
  const proxy = await startConnectProxy();
  try {
    const result = await probeEgressThroughProxy(
      { id: "local", server: `http://127.0.0.1:${proxy.port}` },
      { urls: [`http://127.0.0.1:${echo.port}/`] },
    );
    assert.equal(result.error, null);
    assert.equal(result.ip, "203.0.113.7");
    assert.match(result.status_line, /^HTTP\/1\.1 200/);
    // 关键判据：隧道真的被用上了，而不是本机直连。
    assert.equal(proxy.seen.length, 1);
    assert.equal(proxy.seen[0].url, `127.0.0.1:${echo.port}`);
  } finally {
    await close(proxy.server);
    await close(echo.server);
  }
});

test("proxy credentials travel as a header and never inside the URL", async () => {
  const echo = await startEchoServer();
  const expected = `Basic ${Buffer.from("proxy:secret", "utf8").toString("base64")}`;
  const proxy = await startConnectProxy({ requiredAuth: expected });
  try {
    const result = await probeEgressThroughProxy(
      { id: "local", server: `http://127.0.0.1:${proxy.port}`, username: "proxy", password: "secret" },
      { urls: [`http://127.0.0.1:${echo.port}/`] },
    );
    assert.equal(result.ip, echo.ip);
    assert.equal(proxy.seen[0].authorization, expected);
  } finally {
    await close(proxy.server);
    await close(echo.server);
  }
});

test("a 407 is reported as an auth failure and is not retried against another echo url", async () => {
  const proxy = await startConnectProxy({ requiredAuth: "Basic nope" });
  try {
    const result = await probeEgressThroughProxy(
      { id: "local", server: `http://127.0.0.1:${proxy.port}`, username: "wrong", password: "creds" },
      {
        urls: [
          "http://first.example.invalid/",
          "http://second.example.invalid/",
        ],
        timeoutMs: 3_000,
      },
    );
    assert.equal(result.ip, null);
    assert.match(result.error, /HTTP 407/);
    // 认证失败与「这个回显站点不通」不是一回事：换站点还是同一个 407，不该白试第二轮。
    assert.equal(proxy.seen.length, 1);
  } finally {
    await close(proxy.server);
  }
});

// 407 的**分类**是运维处置的依据：配置错误不该被当成线路故障去重试。
test("an auth failure comes back classified as proxy_auth / non-retryable", async () => {
  const proxy = await startConnectProxy({ requiredAuth: "Basic expected" });
  try {
    const result = await probeEgressThroughProxy(
      { id: "local", server: `http://127.0.0.1:${proxy.port}` },
      { urls: ["http://target.example.invalid/"], timeoutMs: 3_000 },
    );
    assert.equal(result.ip, null);
    assert.equal(result.stage, "proxy_auth");
    assert.equal(result.status_code, 407);
    assert.equal(result.retryable, false);
  } finally {
    await close(proxy.server);
  }
});

test("the error class carries the fields the CLI prints", () => {
  const error = new ProxyEgressError("boom", {
    stage: "proxy_connect",
    proxyServer: "http://127.0.0.1:9",
    statusCode: 503,
    retryable: true,
  });
  assert.equal(error.stage, "proxy_connect");
  assert.equal(error.proxyServer, "http://127.0.0.1:9");
  assert.equal(error.statusCode, 503);
  assert.equal(error.retryable, true);
});

test("a dead proxy yields an error instead of a direct-connection result", async () => {
  const result = await probeEgressThroughProxy(
    { id: "dead", server: `http://127.0.0.1:${await closedPort()}` },
    { urls: ["http://target.example.invalid/"], timeoutMs: 1_500 },
  );
  assert.equal(result.ip, null);
  assert.ok(result.error, "expected an error describing the dead proxy");
});

test("probeEgressThroughProxy refuses to run without an exit", async () => {
  await assert.rejects(probeEgressThroughProxy({ id: "none" }), /requires an exit with a server/);
});

test("probeDirectEgress reports an error rather than throwing when nothing answers", async () => {
  const result = await probeDirectEgress({
    urls: [`http://127.0.0.1:${await closedPort()}/`],
    timeoutMs: 1_500,
  });
  assert.equal(result.ip, null);
  assert.ok(result.error);
});

/** 拿一个「刚刚关闭」的端口，比硬编码一个端口更不容易撞上别的进程。 */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
