import {
  buildExit,
  buildProxyServer,
  parseExpiry,
  poolError,
  requireNonEmptyString,
  resolveCredentialPair,
} from "./proxy-record.js";

/**
 * `http_api` 输入源：从供应商的提取接口拿一批出口。
 *
 * 为什么这个必须有：能买到的池子（91HTTP、快代理、讯代理、芝麻……）几乎都是
 * 「给你一个提取 URL，调一次返回一批 ip:port」。没有这一层，池子文件就只能手抄 IP，
 * 而手抄的 IP 在短效池上几分钟就废了 —— 等于整个代理能力只停在演示。
 *
 * 设计约束（契约见 docs/2026-10-15_proxy-pool-interface-v1.md 第 2 节）：
 *   · 供应商字段名不进核心逻辑：全部走声明式 `fields` 点路径映射，不跑表达式、不用 eval
 *   · HTTP 成功 ≠ 业务成功：`success.path/equals` 是从响应体里判的
 *   · 寿命单位不猜：`expiry_format` 必须显式声明，拿不到可信时间就不按永久处理
 *   · 密钥只从 env 读，绝不出现在错误信息或日志里（URL 查询参数一律脱敏）
 */

const SUPPORTED_FORMATS = new Set(["json", "text_lines"]);
const SUPPORTED_AUTH_TYPES = new Set(["none", "bearer_env", "header_env", "query_env"]);
const SUPPORTED_EXPIRY_FORMATS = new Set(["iso8601", "unix_seconds", "unix_millis"]);
const SUPPORTED_FIELD_KEYS = new Set([
  "id",
  "host",
  "port",
  "scheme",
  "expires_at",
  "username",
  "password",
]);
const SECRET_QUERY_PATTERN = /token|key|secret|pass|auth|sign|api[-_]?id/i;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_EXTRACT_COUNT = 1;
const DEFAULT_MIN_REFRESH_SECONDS = 30;
const DEFAULT_MAX_POOL_SIZE = 50;

/** 脱敏后的 URL，可以安全写进错误信息和日志。 */
export function redactUrl(raw) {
  try {
    const url = new URL(String(raw));
    for (const [key] of [...url.searchParams]) {
      if (SECRET_QUERY_PATTERN.test(key)) url.searchParams.set(key, "***");
    }
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function parseAuth(auth, field = "request.auth") {
  if (auth == null) return { type: "none" };
  if (typeof auth !== "object" || Array.isArray(auth)) {
    throw poolError(`${field} must be an object`);
  }
  const type = String(auth.type ?? "none").trim().toLowerCase();
  if (!SUPPORTED_AUTH_TYPES.has(type)) {
    throw poolError(
      `${field}.type ${JSON.stringify(auth.type)} is unsupported; expected ${[...SUPPORTED_AUTH_TYPES].join(", ")}`,
    );
  }
  if (type === "none") return { type };
  const envName = requireNonEmptyString(auth.env, `${field}.env`);
  const name = type === "bearer_env" ? "Authorization" : requireNonEmptyString(auth.name, `${field}.name`);
  return { type, env: envName, name };
}

function parseRequest(request) {
  if (request == null || typeof request !== "object" || Array.isArray(request)) {
    throw poolError("http_api source must provide a request object");
  }
  const rawUrl = requireNonEmptyString(request.url, "request.url");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw poolError(`request.url ${JSON.stringify(rawUrl)} is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw poolError(`request.url must use https:// (or http:// for a local test server)`);
  }
  if (url.username || url.password) {
    throw poolError("request.url must not embed credentials; use request.auth");
  }
  const method = String(request.method ?? "GET").trim().toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw poolError(`request.method ${JSON.stringify(request.method)} is unsupported; expected GET or POST`);
  }
  const body = request.body ?? null;
  if (method === "GET" && body != null) {
    throw poolError("request.body is not allowed with method GET");
  }
  const query = request.query ?? null;
  if (query != null && (typeof query !== "object" || Array.isArray(query))) {
    throw poolError("request.query must be an object");
  }
  const headers = request.headers ?? null;
  if (headers != null && (typeof headers !== "object" || Array.isArray(headers))) {
    throw poolError("request.headers must be an object");
  }
  const timeoutMs = request.timeout_ms == null ? DEFAULT_TIMEOUT_MS : Number(request.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw poolError(`request.timeout_ms ${JSON.stringify(request.timeout_ms)} must be a positive number`);
  }
  return {
    method,
    url: url.toString(),
    query,
    body,
    headers,
    auth: parseAuth(request.auth),
    timeout_ms: timeoutMs,
  };
}

function parseResponse(response, { defaultScheme, stability }) {
  if (response == null || typeof response !== "object" || Array.isArray(response)) {
    throw poolError("http_api source must provide a response object");
  }
  const format = String(response.format ?? "json").trim().toLowerCase();
  if (!SUPPORTED_FORMATS.has(format)) {
    throw poolError(
      `response.format ${JSON.stringify(response.format)} is unsupported; expected json or text_lines`,
    );
  }
  const expiryFormat = response.expiry_format == null ? null : String(response.expiry_format).trim().toLowerCase();
  if (expiryFormat != null && !SUPPORTED_EXPIRY_FORMATS.has(expiryFormat)) {
    throw poolError(
      `response.expiry_format ${JSON.stringify(response.expiry_format)} is unsupported; expected ${[...SUPPORTED_EXPIRY_FORMATS].join(", ")}`,
    );
  }
  // until_expiry 是「这批 IP 会过期」的声明；拿不到可信失效时间就等于声明无法兑现。
  if (stability.mode === "until_expiry" && format === "json" && expiryFormat == null) {
    throw poolError(
      "response.expiry_format is required when stability.mode is until_expiry (refusing to treat an unknown lifetime as permanent)",
    );
  }
  const success = response.success ?? null;
  if (success != null) {
    if (typeof success !== "object" || Array.isArray(success)) {
      throw poolError("response.success must be an object with path/equals");
    }
    requireNonEmptyString(success.path, "response.success.path");
    if (success.equals === undefined) {
      throw poolError("response.success.equals is required when response.success is set");
    }
  }
  const fields = response.fields ?? null;
  if (format === "json") {
    if (fields != null) {
      if (typeof fields !== "object" || Array.isArray(fields)) {
        throw poolError("response.fields must be an object");
      }
      for (const key of Object.keys(fields)) {
        if (!SUPPORTED_FIELD_KEYS.has(key)) {
          throw poolError(
            `response.fields.${key} is not a mappable field; expected one of ${[...SUPPORTED_FIELD_KEYS].join(", ")}`,
          );
        }
      }
    }
    if (!fields?.host) {
      throw poolError("response.fields.host is required for format json");
    }
    if (!fields?.port) {
      throw poolError("response.fields.port is required for format json");
    }
  }
  return {
    format,
    success,
    items_path: response.items_path == null ? "" : String(response.items_path),
    fields,
    default_scheme: defaultScheme,
    expiry_format: expiryFormat,
  };
}

function parseInventory(inventory) {
  if (inventory == null) {
    return {
      extract_count: DEFAULT_EXTRACT_COUNT,
      min_refresh_interval_seconds: DEFAULT_MIN_REFRESH_SECONDS,
      max_pool_size: DEFAULT_MAX_POOL_SIZE,
    };
  }
  if (typeof inventory !== "object" || Array.isArray(inventory)) {
    throw poolError("source.inventory must be an object");
  }
  const extractCount =
    inventory.extract_count == null ? DEFAULT_EXTRACT_COUNT : Number(inventory.extract_count);
  if (!Number.isInteger(extractCount) || extractCount < 1 || extractCount > 200) {
    throw poolError("source.inventory.extract_count must be an integer between 1 and 200");
  }
  const minRefresh =
    inventory.min_refresh_interval_seconds == null
      ? DEFAULT_MIN_REFRESH_SECONDS
      : Number(inventory.min_refresh_interval_seconds);
  if (!Number.isFinite(minRefresh) || minRefresh < 0) {
    throw poolError("source.inventory.min_refresh_interval_seconds must be a non-negative number");
  }
  const maxPoolSize =
    inventory.max_pool_size == null ? DEFAULT_MAX_POOL_SIZE : Number(inventory.max_pool_size);
  if (!Number.isInteger(maxPoolSize) || maxPoolSize < 1 || maxPoolSize > 1000) {
    throw poolError("source.inventory.max_pool_size must be an integer between 1 and 1000");
  }
  return {
    extract_count: extractCount,
    min_refresh_interval_seconds: minRefresh,
    max_pool_size: maxPoolSize,
  };
}

function parseAcquisition(acquisition, sourceKind) {
  const mode = String(acquisition?.mode ?? "pooled").trim().toLowerCase();
  if (mode !== "pooled" && mode !== "per_session") {
    throw poolError(
      `acquisition.mode ${JSON.stringify(acquisition?.mode)} is unsupported; expected pooled or per_session`,
    );
  }
  if (sourceKind === "static" && mode === "per_session") {
    // static 的条目是固定的，每次会话「取新的」只会拿到同一个出口 —— 让配置在这里
    // 失败，好过让运维以为自己在轮换 IP。
    throw poolError("acquisition.mode per_session requires source.kind=http_api (static exits never change)");
  }
  return { mode };
}

/**
 * 校验并规范化 `http_api` 输入源。**不发网络请求** —— 配置错误要在开跑前就暴露，
 * 而不是等第一条任务去撞。
 */
export function parseHttpApiSource(source, { env = process.env } = {}) {
  const stabilityMode = String(source.stability?.mode ?? "fixed").trim();
  if (stabilityMode !== "fixed" && stabilityMode !== "until_expiry") {
    throw poolError(
      `source.stability.mode ${JSON.stringify(source.stability?.mode)} is unsupported; expected fixed or until_expiry`,
    );
  }
  const defaultScheme = String(source.response?.default_scheme ?? "http").trim().toLowerCase();
  if (defaultScheme !== "http" && defaultScheme !== "https") {
    throw poolError("response.default_scheme must be http or https");
  }
  const stability = { mode: stabilityMode };
  const request = parseRequest(source.request);
  const response = parseResponse(source.response, { defaultScheme, stability });
  // 提取接口的凭据也要在解析期查一次：等第一条任务撞上去才发现密钥没配，那时
  // 任务已经在队列里了（值本身仍在请求时读取，所以轮换密钥不必重启进程）。
  if (request.auth.type !== "none") requireEnvValue(request.auth.env, env);
  // default_auth 在**解析期**就解出 env，缺失即报错：等到第一次提取才发现密钥没配，
  // 那时任务已经在队列里了。
  const defaultAuth = resolveCredentialPair(source.default_auth ?? null, env);
  return {
    kind: "http_api",
    request,
    response,
    default_auth: { username: defaultAuth.username, password: defaultAuth.password },
    stability,
    inventory: parseInventory(source.inventory),
    allow_plaintext_auth: source.allow_plaintext_auth === true,
  };
}

/** 点路径取值。刻意只支持属性访问：不跑表达式，也就没有注入面。 */
export function getByPath(value, path) {
  if (path == null || path === "") return value;
  let current = value;
  for (const segment of String(path).split(".")) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function requireEnvValue(name, env) {
  const raw = env[name];
  if (raw == null || String(raw) === "") {
    throw poolError(`provider credential is missing: expected ${name} to be set`, { env: name });
  }
  return raw;
}

function resolveAuthHeader(auth, env) {
  if (!auth || auth.type === "none") return {};
  const raw = requireEnvValue(auth.env, env);
  const value = auth.type === "bearer_env" ? `Bearer ${raw}` : String(raw);
  return { [auth.name]: value };
}

function applyQueryAuth(url, auth, env) {
  if (!auth || auth.type !== "query_env") return url;
  const raw = requireEnvValue(auth.env, env);
  url.searchParams.set(auth.name, String(raw));
  return url;
}

function parseTextLines(text, { defaultScheme }) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const exits = [];
  for (const line of lines) {
    const ipv6 = /^\[([0-9a-fA-F:]+)\]:(\d+)$/.exec(line);
    if (ipv6) {
      exits.push({ host: ipv6[1], port: Number(ipv6[2]), scheme: defaultScheme, raw: line });
      continue;
    }
    const parts = line.split(":");
    if (parts.length === 2) {
      exits.push({ host: parts[0].trim(), port: Number(parts[1]), scheme: defaultScheme, raw: line });
      continue;
    }
    // 四段形态（ip:port:user:password）在不同供应商那里顺序并不一致。猜错一次就等于
    // 把别人的凭据配到自己这一侧，宁可拒绝并让对方改用 JSON 接口。
    throw poolError(
      `text_lines entry ${JSON.stringify(line)} is not a plain host:port; refusing to guess an ip:port:user:password layout`,
    );
  }
  return exits;
}

function parseJsonItems(payload, response) {
  if (response.success != null) {
    const actual = getByPath(payload, response.success.path);
    const expected = response.success.equals;
    // 业务码可能是数字也可能是字符串，两边都归一成字符串比。
    if (String(actual) !== String(expected)) {
      throw poolError(
        `provider reported failure: response.success.path ${response.success.path} = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`,
        { stage: "proxy_extract_business_error" },
      );
    }
  }
  const items = getByPath(payload, response.items_path);
  if (!Array.isArray(items)) {
    throw poolError(
      `provider response at ${JSON.stringify(response.items_path || "<root>")} is not an array`,
      { stage: "proxy_extract_shape" },
    );
  }
  return items.map((item) => ({
    host: getByPath(item, response.fields.host),
    port: getByPath(item, response.fields.port),
    scheme: response.fields.scheme ? getByPath(item, response.fields.scheme) : response.default_scheme,
    expires_at: response.fields.expires_at ? getByPath(item, response.fields.expires_at) : null,
    username: response.fields.username ? getByPath(item, response.fields.username) : null,
    password: response.fields.password ? getByPath(item, response.fields.password) : null,
    id: response.fields.id ? getByPath(item, response.fields.id) : null,
  }));
}

/**
 * 真正去调供应商接口，把响应规范化成出口记录。
 *
 * 返回的 `exits` 与 `static` 输入源形状一致（`{id, server, stability, username, password, expires_at}`），
 * 这样调度层不需要知道出口是从哪儿来的。
 */
export async function extractProxyExits(spec, { fetchImpl = globalThis.fetch, env = process.env, now = Date.now() } = {}) {
  const url = new URL(spec.request.url);
  for (const [key, value] of Object.entries(spec.request.query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  applyQueryAuth(url, spec.request.auth, env);

  const headers = { accept: "*/*", ...(spec.request.headers ?? {}) };
  for (const [key, value] of Object.entries(headers)) headers[key] = String(value);
  Object.assign(headers, resolveAuthHeader(spec.request.auth, env));

  let body;
  if (spec.request.method === "POST" && spec.request.body != null) {
    if (typeof spec.request.body === "string") {
      body = spec.request.body;
    } else {
      body = JSON.stringify(spec.request.body);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }
    }
    headers["content-length"] = String(Buffer.byteLength(body));
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: spec.request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(spec.request.timeout_ms),
    });
  } catch (error) {
    // 错误里只能出现脱敏 URL：query_env 认证把密钥放在查询串里。
    throw poolError(
      `proxy extract request to ${redactUrl(url.toString())} failed: ${error?.message ?? error}`,
      { stage: "proxy_extract_request" },
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw poolError(
      `proxy extract request to ${redactUrl(url.toString())} returned HTTP ${response.status}`,
      {
        stage: "proxy_extract_http",
        status: response.status,
        // 429 / 5xx 值得冷却后重试；401/403 是配置问题。
        retryable: response.status === 429 || response.status >= 500,
        body_excerpt: text.slice(0, 300),
      },
    );
  }

  let rawItems;
  if (spec.response.format === "json") {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw poolError(`proxy extract response is not valid JSON: ${error?.message ?? error}`, {
        stage: "proxy_extract_shape",
        body_excerpt: text.slice(0, 300),
      });
    }
    rawItems = parseJsonItems(payload, spec.response);
  } else {
    rawItems = parseTextLines(text, { defaultScheme: spec.response.default_scheme });
  }

  const exits = [];
  const seen = new Set();
  const rejected = [];
  for (const [index, item] of rawItems.entries()) {
    const label = item.id == null ? `extracted_${index + 1}` : String(item.id);
    let server;
    try {
      server = buildProxyServer(
        { host: item.host, port: item.port, scheme: item.scheme ?? spec.response.default_scheme },
        { label },
      );
    } catch (error) {
      rejected.push(`${label}: ${error?.message ?? error}`);
      continue;
    }
    const username = item.username == null || String(item.username) === "" ? null : String(item.username);
    const password = item.password == null ? null : String(item.password);
    // 半套认证是配置错误，不是「当作匿名用」——后者会在平台侧表现为一次匿名访问，
    // 让整批实验的样本口径变脏。
    if ((username == null) !== (password == null)) {
      throw poolError(
        `extracted exit ${label} has half an authentication pair (username=${username === null ? "null" : "set"}, password=${password === null ? "null" : "set"}); use default_auth or fix the field mapping`,
      );
    }
    const expiresAt =
      item.expires_at == null || item.expires_at === ""
        ? null
        : parseExpiry(item.expires_at, spec.response.expiry_format);
    if (spec.stability.mode === "until_expiry" && (expiresAt == null || expiresAt <= now)) {
      rejected.push(`${label}: already expired or unusable expiry ${JSON.stringify(item.expires_at)}`);
      continue;
    }
    const finalUser = username ?? spec.default_auth.username;
    const finalPass = password ?? spec.default_auth.password;
    const dedupeKey = `${server}|${finalUser ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    exits.push(
      buildExit({
        id: label,
        server,
        stability: spec.stability.mode,
        username: finalUser,
        password: finalPass,
        expiresAt,
        sourceId: label,
      }),
    );
  }

  if (exits.length === 0) {
    throw poolError(
      `proxy extractor returned no usable exit${rejected.length ? ` (${rejected.length} rejected: ${rejected.slice(0, 3).join("; ")})` : ""}`,
      { stage: "proxy_extract_empty", rejected: rejected.slice(0, 10) },
    );
  }
  return { exits, rejected, url: redactUrl(url.toString()) };
}
