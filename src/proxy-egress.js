import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { DoubaoMvpError, ErrorCode } from "./errors.js";

/**
 * 出口自证：**不起浏览器**，直接用 HTTP CONNECT 穿过代理去问一个回显服务。
 *
 * 为什么要单独一层：`tools/probe-proxy-egress.mjs` 走完整浏览器，一次要 35–60 秒冷启动。
 * 采购前要验 20 个 IP、每次会话后要验一次出口，这个代价用不起。CONNECT 隧道 + 一条
 * 明文 GET 只要几百毫秒，且验的是**同一条代理入口和同一套凭据** —— 这正是要证伪的对象。
 *
 * 这一层刻意不做的事：
 *   · 不解析 HTTPS 页面（回显服务用明文 HTTP 就够，少一层证书问题）
 *   · 不猜测出口（供应商返回的 host 不是已证实的出口 IP，必须以这里观测到的为准）
 *   · 不吞掉错误（连接失败、407、407 之外的 4xx/5xx 分开报，见 ProxyEgressError.classify）
 */

/** 回显服务按「先便宜后完整」排列：明文 HTTP 的那条优先。 */
export const DEFAULT_EGRESS_URLS = [
  "http://members.3322.org/dyndns/getip",
  "https://myip.ipip.net",
];

const DEFAULT_TIMEOUT_MS = 15_000;
const IPV4_PATTERN = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;

export class ProxyEgressError extends Error {
  /**
   * @param {string} message
   * @param {{stage: string, proxyServer?: string|null, statusCode?: number|null, retryable?: boolean}} details
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "ProxyEgressError";
    this.stage = details.stage ?? "unknown";
    this.proxyServer = details.proxyServer ?? null;
    this.statusCode = details.statusCode ?? null;
    this.retryable = details.retryable === true;
  }
}

export function extractEgressIp(text) {
  const match = IPV4_PATTERN.exec(String(text ?? ""));
  return match ? match[1] : null;
}

/** 凭据只走独立字段；Promise 化后的错误里绝不能带 Authorization 头。 */
function proxyAuthorizationHeader(exit) {
  if (!exit?.username) return null;
  const raw = `${exit.username}:${exit.password ?? ""}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

function connectThroughProxy({ server, exit, target, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(server);
    const authorization = proxyAuthorizationHeader(exit);
    const request = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80)),
      method: "CONNECT",
      path: `${target.hostname}:${target.port}`,
      timeout: timeoutMs,
      headers: {
        host: `${target.hostname}:${target.port}`,
        ...(authorization ? { "proxy-authorization": authorization } : {}),
      },
    });

    request.on("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(
          new ProxyEgressError(
            `proxy refused CONNECT with HTTP ${response.statusCode}`,
            {
              stage: response.statusCode === 407 ? "proxy_auth" : "proxy_connect",
              proxyServer: server,
              statusCode: response.statusCode,
              // 407 是配置错误，重试同一个凭据没有意义。
              retryable: response.statusCode !== 407,
            },
          ),
        );
        return;
      }
      socket.setTimeout(timeoutMs);
      resolve(socket);
    });
    request.on("timeout", () => {
      request.destroy();
      reject(
        new ProxyEgressError("proxy CONNECT timed out", {
          stage: "proxy_timeout",
          proxyServer: server,
          retryable: true,
        }),
      );
    });
    request.on("error", (error) => {
      reject(
        new ProxyEgressError(`proxy CONNECT failed: ${error?.message ?? error}`, {
          stage: "proxy_connect",
          proxyServer: server,
          retryable: true,
        }),
      );
    });
    request.end();
  });
}

/** 隧道建好之后，在隧道里发一条 HTTP/1.1 GET 并读完整响应。 */
function httpGetOverSocket(socket, target, { timeoutMs, hostHeader }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };

    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => finish(resolve, Buffer.concat(chunks).toString("utf8")));
    socket.on("error", (error) =>
      finish(
        reject,
        new ProxyEgressError(`tunnel read failed: ${error?.message ?? error}`, {
          stage: "tunnel_read",
          retryable: true,
        }),
      ),
    );
    socket.on("timeout", () =>
      finish(
        reject,
        new ProxyEgressError("tunnel read timed out", {
          stage: "tunnel_read",
          retryable: true,
        }),
      ),
    );
    socket.setTimeout(timeoutMs);

    socket.write(
      [
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${hostHeader}`,
        "User-Agent: OneGl-proxy-egress-probe/1",
        "Accept: */*",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
  });
}

function httpsGetOverSocket(socket, target, { timeoutMs, hostHeader }) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect(
      { socket, servername: target.hostname, rejectUnauthorized: true },
      () => {
        secure.setTimeout(timeoutMs);
        httpGetOverSocket(secure, target, { timeoutMs, hostHeader }).then(resolve, reject);
      },
    );
    secure.on("error", (error) =>
      reject(
        new ProxyEgressError(`tunnel TLS handshake failed: ${error?.message ?? error}`, {
          stage: "tunnel_tls",
          retryable: false,
        }),
      ),
    );
  });
}

/**
 * 穿过一个池子出口去取真实出口 IPv4。
 *
 * @param {object} exit proxy-pool.js 规范化后的出口记录（含 server/username/password）
 * @param {{url?: string, timeoutMs?: number, urls?: string[]}} [options]
 * @returns {Promise<{ip: string|null, url: string|null, status_line: string|null, error: string|null,
 *                    stage: string|null, retryable: boolean, status_code: number|null}>}
 *
 * 失败时**不抛错**（除了配置本身不成立）：调用方要的是「这批出口里哪几个能用」的表格，
 * 一个坏 IP 不该中断整轮体检。失败原因按 stage 分类，处置完全不同：
 * `proxy_auth` 改配置、`proxy_connect`/`proxy_timeout` 换线路、`tunnel_tls` 换回显站点。
 */
export async function probeEgressThroughProxy(exit, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const urls = options.urls ?? (options.url ? [options.url] : DEFAULT_EGRESS_URLS);
  // 直连对照不需要出口；没有出口时**不**静默直连，直接报错。
  if (!exit?.server) {
    throw new ProxyEgressError("probeEgressThroughProxy requires an exit with a server", {
      stage: "config",
      retryable: false,
    });
  }

  const failure = (error, url, stage = null, statusCode = null, retryable = false) => ({
    ip: null,
    url: url ?? null,
    status_line: null,
    error,
    stage,
    retryable,
    status_code: statusCode,
  });

  let lastError = null;
  for (const raw of urls) {
    let target;
    try {
      target = new URL(raw);
    } catch {
      lastError = `invalid egress url ${raw}`;
      continue;
    }
    try {
      const socket = await connectThroughProxy({
        server: exit.server,
        exit,
        target: { hostname: target.hostname, port: Number(target.port || (target.protocol === "https:" ? 443 : 80)) },
        timeoutMs,
      });
      const body =
        target.protocol === "https:"
          ? await httpsGetOverSocket(socket, target, {
              timeoutMs,
              hostHeader: target.host,
            })
          : await httpGetOverSocket(socket, target, {
              timeoutMs,
              hostHeader: target.host,
            });
      const statusLine = String(body).split("\r\n", 1)[0] || null;
      const ip = extractEgressIp(body);
      if (ip) {
        return {
          ip,
          url: raw,
          status_line: statusLine,
          error: null,
          stage: null,
          retryable: false,
          status_code: null,
        };
      }
      lastError = `${raw} returned no IPv4 (${statusLine ?? "no status line"})`;
    } catch (error) {
      lastError = error?.message ?? String(error);
      const classified = error instanceof ProxyEgressError;
      // 代理认证/连接层的失败与「这个回显站点不通」不是一回事：
      // 前者换一个回显站点还是失败，不该白试第二轮。
      if (classified && error.retryable !== true) {
        return failure(lastError, raw, error.stage, error.statusCode, false);
      }
      if (classified && error.statusCode != null) {
        return failure(lastError, raw, error.stage, error.statusCode, true);
      }
    }
  }
  return failure(lastError, null, "unknown");
}

/** 直连对照：不经过任何代理，用来证明「观测到的出口确实变了」。 */
export async function probeDirectEgress({ urls = DEFAULT_EGRESS_URLS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const ip = extractEgressIp(await response.text());
      if (ip) return { ip, url, error: null };
      lastError = `${url} returned no IPv4`;
    } catch (error) {
      lastError = error?.message ?? String(error);
    }
  }
  return { ip: null, url: null, error: lastError };
}

/** 把探针结果折叠成一句可直接写进日志/落库的描述。 */
export function describeEgress(result) {
  if (!result) return null;
  return {
    ip: result.ip ?? null,
    url: result.url ?? null,
    error: result.error ?? null,
    stage: result.stage ?? null,
  };
}

export function egressProbeError(message, details = {}) {
  return new DoubaoMvpError(ErrorCode.UNKNOWN_ERROR, message, {
    stage: "proxy_egress",
    ...details,
  });
}
