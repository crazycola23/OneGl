#!/usr/bin/env node
/**
 * 代理出口探针 —— 验证两件事：
 *   1) 浏览器真的从代理出口上网，而不是「配了代理但走直连」；
 *   2) 必需代理不可用时，启动/导航必须失败，不能静默回退直连。
 *
 *   node tools/probe-proxy-egress.mjs                     走配置的代理池，打印真实出口
 *   node tools/probe-proxy-egress.mjs --expect 1.2.3.4    出口与预期不符时非零退出
 *   node tools/probe-proxy-egress.mjs --mode fail-closed  死代理必须失败（不许回退直连）
 *   node tools/probe-proxy-egress.mjs --mode no-proxy     同一浏览器显式直连，作为对照
 *
 * 证据以 ONEGL_PROXY_PROBE <json> 单行输出，方便直接贴进记录。
 */
import "dotenv/config";
import process from "node:process";
import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import { acquireSessionProxy, describeProxy } from "../src/proxy-pool.js";

/**
 * 出口查询站按「先便宜后完整」排列：首个 HTTPS 页面在冷启动时可能耗时 40-60 秒，
 * 先把明文 HTTP 的那条跑通，再去取更详细的那条。
 */
const EGRESS_URLS = [
  "http://members.3322.org/dyndns/getip",
  "https://myip.ipip.net",
];
const NAVIGATION_TIMEOUT_MS = 60_000;
const PLATFORM_URLS = [
  ["doubao", "https://www.doubao.com"],
  ["qianwen", "https://tongyi.aliyun.com"],
  ["wenxin", "https://yiyan.baidu.com"],
  ["zhipu", "https://chatglm.cn"],
];
const IPV4_PATTERN = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
/** 故意指向一个没有监听的本地端口：连不上是确定的，回退直连才是要抓的 bug。 */
const DEAD_PROXY = {
  id: "probe_dead_exit",
  server: "http://127.0.0.1:9",
  username: null,
  password: null,
  stability: "fixed",
  poolId: "probe",
  required: true,
};

function parseArgs(argv) {
  const options = { mode: "egress", provider: "doubao", account: "proxy_probe", expect: null, headless: false, platforms: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--provider") options.provider = argv[++index];
    else if (arg === "--account") options.account = argv[++index];
    else if (arg === "--expect") options.expect = argv[++index];
    else if (arg === "--headless") options.headless = true;
    // 平台可达性检查会真的去访问那四个站点。冷却期间只想验出口时用它跳过。
    else if (arg === "--skip-platforms") options.platforms = false;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!new Set(["egress", "fail-closed", "no-proxy"]).has(options.mode)) {
    throw new Error(`--mode must be egress, fail-closed or no-proxy (got ${options.mode})`);
  }
  return options;
}

function emit(payload) {
  console.log(`ONEGL_PROXY_PROBE ${JSON.stringify(payload)}`);
}

function extractIp(text) {
  const match = IPV4_PATTERN.exec(text ?? "");
  return match ? match[1] : null;
}

/** 直连出口：不经过浏览器，只作为「代理是否真的被用上」的对照组。 */
async function directEgressIp() {
  let lastError = null;
  for (const url of EGRESS_URLS) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const ip = extractIp(await response.text());
      if (ip) return { ip, error: null, url };
      lastError = `${url} returned no IPv4`;
    } catch (error) {
      lastError = error?.message ?? String(error);
    }
  }
  return { ip: null, error: lastError, url: null };
}

const options = parseArgs(process.argv.slice(2));
const config = loadConfig({
  provider: options.provider,
  accountKey: options.account,
  ...(options.headless ? { camoufoxMode: "headless" } : {}),
});

if (options.mode === "fail-closed") {
  let session = null;
  let failure = null;
  try {
    session = await launchBrowserSession(config, { proxy: DEAD_PROXY, ignoreStoredAuth: true });
    await session.page.goto(EGRESS_URLS[0], { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (error) {
    failure = error?.message ?? String(error);
  }

  // 关键判据：死代理下绝不能拿到出口页面的内容。拿到了就是回退直连。
  let leaked = null;
  if (session) {
    leaked = await session.page
      .evaluate(() => document.body?.innerText ?? "")
      .then((text) => extractIp(text))
      .catch(() => null);
    await session.close().catch(() => undefined);
  }

  const passed = failure !== null && leaked === null;
  emit({
    mode: "fail-closed",
    proxy: describeProxy(DEAD_PROXY),
    blocked: failure !== null,
    error_message: failure,
    leaked_direct_ip: leaked,
    passed,
  });
  process.exit(passed ? 0 : 3);
}

// no-proxy 是**同一个浏览器**的直连对照组：只有两次观测的出口不同，
// 才能把「走了代理」从配置声明变成观测事实。
const bypassProxy = options.mode === "no-proxy";
const resolved = bypassProxy
  ? null
  : // 用 acquire（异步）而不是同步解析：http_api 类型的池子要先调提取接口。
    await acquireSessionProxy(config, { platform: config.provider, accountKey: config.accountKey });
if (!resolved && !bypassProxy) {
  emit({ mode: "egress", error: "no proxy configured for this platform", proxy_pool_file: config.proxyPoolFile ?? null });
  process.exit(1);
}
emit({ mode: options.mode, step: "resolved", proxy: describeProxy(resolved) });

const direct = await directEgressIp();
let session = null;
let failure = null;
let observedIp = null;
let platformStatuses = null;
try {
  session = await launchBrowserSession(config, {
    ignoreStoredAuth: true,
    ...(bypassProxy ? { proxy: null } : {}),
  });
  for (const url of EGRESS_URLS) {
    try {
      await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      const body = await session.page.evaluate(() => document.body?.innerText ?? "");
      observedIp = extractIp(body);
      if (observedIp) break;
    } catch (error) {
      failure = error?.message ?? String(error);
    }
  }
  if (options.platforms) {
    platformStatuses = {};
    for (const [platform, url] of PLATFORM_URLS) {
      platformStatuses[platform] = await session.page
        .goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
        .then((result) => result?.status() ?? null)
        .catch((error) => `error: ${error?.message ?? error}`);
    }
  }
} catch (error) {
  failure = error?.message ?? String(error);
} finally {
  await session?.close().catch(() => undefined);
}

const proxied = observedIp !== null && (direct.ip === null || observedIp !== direct.ip);
const matchesExpectation = options.expect === null || observedIp === options.expect;
// 对照组期望「与直连一致」，代理组期望「与直连不同」—— 方向相反，判据不能共用。
const passed = bypassProxy
  ? failure === null && observedIp !== null && observedIp === direct.ip
  : failure === null && observedIp !== null && proxied && matchesExpectation;
emit({
  mode: options.mode,
  proxy: describeProxy(resolved),
  direct_ip: direct.ip,
  direct_error: direct.error,
  observed_ip: observedIp,
  used_proxy: proxied,
  expected_ip: options.expect,
  platform_statuses: platformStatuses,
  failure,
  passed,
});
process.exit(passed ? 0 : 2);
