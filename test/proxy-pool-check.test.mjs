import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

/**
 * 体检工具的端到端自检。
 *
 * 这是「池子到货后第一条要跑的命令」，所以它本身必须在一个完全受控的环境里被证明可用 ——
 * 三条判据各自单独验：全绿、直连泄漏、出口不可用。用真供应商验这三条的区别是：
 * 失败时分不清是工具错了还是线路错了。
 */

const run = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function startEcho(ip) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`${ip}\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, ip, close: () => close(server) };
}

/**
 * 模拟一个代理入口。`rewriteTo` 用来表达「两个入口落到不同出口」——
 * 真实的供应商池就是这个样子，而这是「槽位是否拿到不同 IP」的唯一可验证形态。
 */
async function startProxy({ rewriteTo, breakTunnel = false }) {
  const server = http.createServer((_request, response) => {
    response.writeHead(405);
    response.end();
  });
  server.on("connect", (request, clientSocket, head) => {
    if (breakTunnel) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const [host, port] = request.url.split(":");
    const targetHost = rewriteTo?.host ?? host;
    const targetPort = rewriteTo?.port ?? Number(port);
    const upstream = net.connect(targetPort, targetHost, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, close: () => close(server) };
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function startExtractApi(exits) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        code: 0,
        data: {
          list: exits.map((exit, index) => ({
            id: `exit_${index + 1}`,
            ip: "127.0.0.1",
            port: exit.port,
            expire_time: new Date(Date.now() + 600_000).toISOString(),
          })),
        },
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, close: () => close(server) }),
    );
  });
}

function writePool(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), "onegl-pool-check-"));
  const file = path.join(dir, "proxy-pool.json");
  writeFileSync(file, JSON.stringify(contents, null, 2), "utf8");
  return file;
}

function poolDocument(apiPort, { slots = 2 } = {}) {
  return {
    schema_version: 1,
    pool_id: "check_pool",
    enabled: true,
    required: true,
    platforms: ["doubao"],
    acquisition: { mode: "per_session" },
    source: {
      kind: "http_api",
      request: {
        method: "GET",
        url: `http://127.0.0.1:${apiPort}/api/getip`,
        query: { num: slots },
      },
      response: {
        format: "json",
        success: { path: "code", equals: 0 },
        items_path: "data.list",
        fields: { id: "id", host: "ip", port: "port", expires_at: "expire_time" },
        expiry_format: "iso8601",
      },
      stability: { mode: "until_expiry" },
      inventory: { min_refresh_interval_seconds: 0, max_pool_size: 32 },
    },
  };
}

async function check(file, echo, extraArgs = []) {
  try {
    const { stdout } = await run(
      process.execPath,
      ["tools/proxy-pool-check.mjs", "--file", file, "--json", "--echo", echo, ...extraArgs],
      { cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024 },
    );
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    // 非零退出是判失败的方式，不是测试失败 —— stderr 之外 stdout 仍有完整报告。
    const stdout = String(error.stdout ?? "");
    return { code: error.code ?? 1, report: stdout.trim() ? JSON.parse(stdout) : null };
  }
}

test("a healthy pool reports every sampled exit as usable and distinct", async () => {
  const hostEcho = await startEcho("198.51.100.1");
  const exitA = await startEcho("203.0.113.7");
  const exitB = await startEcho("203.0.113.8");
  const proxyA = await startProxy({ rewriteTo: { host: "127.0.0.1", port: exitA.port } });
  const proxyB = await startProxy({ rewriteTo: { host: "127.0.0.1", port: exitB.port } });
  const api = await startExtractApi([proxyA, proxyB]);
  const file = writePool(poolDocument(api.port, { slots: 6 }));
  try {
    const { code, report } = await check(file, `http://127.0.0.1:${hostEcho.port}/`, [
      "--slots",
      "2",
    ]);
    assert.equal(report.direct_egress.ip, "198.51.100.1");
    assert.equal(report.sampled, 2);
    assert.equal(report.usable, 2);
    assert.equal(report.leaked_direct_ip, false);
    assert.equal(report.passed, true);
    assert.equal(code, 0, JSON.stringify(report.rows, null, 2));
    // 两个槽位必须落在两个不同的出口 IP 上 —— 这正是这套池子存在的理由。
    assert.deepEqual(
      report.rows.map((row) => row.ip).sort(),
      ["203.0.113.7", "203.0.113.8"],
    );
  } finally {
    await Promise.all([api.close(), proxyA.close(), proxyB.close(), exitA.close(), exitB.close(), hostEcho.close()]);
  }
});

test("an exit that lands back on the host IP is reported as a leak and fails the check", async () => {
  const hostEcho = await startEcho("198.51.100.1");
  // 这条「代理」把流量送到与直连完全相同的地方 —— 就是回退直连的样子。
  const sneaky = await startProxy({ rewriteTo: { host: "127.0.0.1", port: hostEcho.port } });
  const api = await startExtractApi([sneaky]);
  const file = writePool(poolDocument(api.port, { slots: 1 }));
  try {
    const { code, report } = await check(file, `http://127.0.0.1:${hostEcho.port}/`, ["--slots", "1"]);
    assert.equal(report.leaked_direct_ip, true);
    assert.equal(report.passed, false);
    assert.notEqual(code, 0);
  } finally {
    await Promise.all([api.close(), sneaky.close(), hostEcho.close()]);
  }
});

test("a dead tunnel is reported per row instead of crashing the whole check", async () => {
  const hostEcho = await startEcho("198.51.100.1");
  const dead = await startProxy({ breakTunnel: true });
  const api = await startExtractApi([dead]);
  const file = writePool(poolDocument(api.port, { slots: 1 }));
  try {
    const { code, report } = await check(file, `http://127.0.0.1:${hostEcho.port}/`, ["--slots", "1"]);
    assert.equal(report.usable, 0);
    assert.equal(report.passed, false);
    assert.notEqual(code, 0);
    assert.match(report.rows[0].error, /502|failed|timed out/i);
  } finally {
    await Promise.all([api.close(), dead.close(), hostEcho.close()]);
  }
});

test("a disabled pool is rejected instead of being reported as healthy", async () => {
  const api = await startExtractApi([]);
  const document = poolDocument(api.port);
  document.enabled = false;
  const file = writePool(document);
  try {
    const { code, report } = await check(file, "http://127.0.0.1:1/");
    assert.equal(report, null);
    assert.notEqual(code, 0);
  } finally {
    await api.close();
  }
});
