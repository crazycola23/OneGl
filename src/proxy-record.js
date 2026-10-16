import { DoubaoMvpError, ErrorCode } from "./errors.js";

/**
 * 代理记录的**共享底座**：把一个出口从任意输入源规范化成同一种形状。
 *
 * 从 `proxy-pool.js` 拆出来，是因为 `static` 与 `http_api` 两个输入源都要做同一件事
 * （校验 server、成对解出凭据、判定寿命），而两者互相 import 会绕成环。这里只放
 * 「任何输入源都不能违反」的规则，管的是**格式**，不是调度。
 */

export function poolError(message, details = null) {
  return new DoubaoMvpError(ErrorCode.UNKNOWN_ERROR, message, {
    stage: "proxy_pool",
    ...(details ?? {}),
  });
}

export function requireNonEmptyString(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw poolError(`${field} must be a non-empty string`);
  return text;
}

/**
 * Playwright 拿到 proxy.server 后原样使用，所以这里必须挡住「URL 里塞凭据」
 * 和第二跳：认证只能走独立的 username/password 字段。
 */
export function normalizeProxyServer(value) {
  const raw = requireNonEmptyString(value, "proxy server");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw poolError(`proxy server ${JSON.stringify(raw)} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw poolError(
      `proxy server ${JSON.stringify(raw)} must use http:// or https:// (v1 does not accept SOCKS)`,
    );
  }
  if (url.username || url.password) {
    throw poolError(
      `proxy server ${JSON.stringify(raw)} must not embed credentials; use username_env/password_env`,
    );
  }
  if (!url.port) {
    throw poolError(`proxy server ${JSON.stringify(raw)} must include an explicit port`);
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw poolError(`proxy server ${JSON.stringify(raw)} must not carry a path, query or fragment`);
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * 认证要么成对给，要么一个都不给。半套认证（只有用户名）会在代理侧变成
 * 一个看不懂的 407，而不是一条能定位的配置错误。
 */
export function resolveCredentialPair(auth, env = process.env) {
  if (auth == null) return { username: null, password: null };
  if (typeof auth !== "object" || Array.isArray(auth)) {
    throw poolError("proxy auth must be an object with username_env/password_env");
  }
  const usernameEnv = auth.username_env == null ? null : String(auth.username_env).trim();
  const passwordEnv = auth.password_env == null ? null : String(auth.password_env).trim();
  if (Boolean(usernameEnv) !== Boolean(passwordEnv)) {
    throw poolError("proxy auth must set username_env and password_env together");
  }
  if (!usernameEnv) return { username: null, password: null };
  const username = env[usernameEnv];
  const password = env[passwordEnv];
  if (username == null || String(username) === "" || password == null || String(password) === "") {
    throw poolError(
      `proxy credentials are missing: expected both ${usernameEnv} and ${passwordEnv} to be set`,
      { env: [usernameEnv, passwordEnv] },
    );
  }
  return { username: String(username), password: String(password) };
}

/** `host` + `port` 拼成 server，并走同一套校验（不许内嵌凭据、必须带端口）。 */
export function buildProxyServer({ host, port, scheme = "http" }, { label = "proxy exit" } = {}) {
  const hostText = requireNonEmptyString(host, `${label} host`);
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65_535) {
    throw poolError(`${label} port ${JSON.stringify(port)} is not a valid TCP port`);
  }
  const schemeText = String(scheme ?? "http").trim().toLowerCase().replace(/:$/, "");
  // IPv6 必须加方括号才是合法 URL；供应商返回裸 IPv6 是常见形态。
  const hostForUrl = hostText.includes(":") && !hostText.startsWith("[") ? `[${hostText}]` : hostText;
  return normalizeProxyServer(`${schemeText}://${hostForUrl}:${portNumber}`);
}

/**
 * 供应商的失效时间格式**不做猜测**：单位不明的值一律返回 null，由调用方按
 * 「寿命未知」处理（= 不给它排长任务），而不是当成永不过期。
 */
export function parseExpiry(value, format) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  switch (format) {
    case "iso8601": {
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case "unix_seconds": {
      const seconds = Number(text);
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      return Math.round(seconds * 1000);
    }
    case "unix_millis": {
      const millis = Number(text);
      if (!Number.isFinite(millis) || millis <= 0) return null;
      return Math.round(millis);
    }
    default:
      throw poolError(
        `expiry_format ${JSON.stringify(format)} is unsupported; expected iso8601, unix_seconds or unix_millis`,
      );
  }
}

/**
 * 一条规范化出口。
 *
 * `expires_at` 为 null 的语义是「供应商没给可信失效时间」，不是「永久有效」——
 * `stability.mode=until_expiry` 却拿不到时间时，由池子在解析阶段就拒绝。
 */
export function buildExit({
  id,
  server,
  stability = "fixed",
  username = null,
  password = null,
  expiresAt = null,
  sourceId = null,
}) {
  return {
    id: requireNonEmptyString(id, "proxy exit id"),
    server: normalizeProxyServer(server),
    stability,
    username,
    password,
    expires_at: expiresAt == null ? null : Number(expiresAt),
    source_id: sourceId,
  };
}
