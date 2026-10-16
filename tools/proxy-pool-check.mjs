#!/usr/bin/env node
/**
 * 代理池体检 —— 拿到一份新的池子配置（或换了一家供应商）时，先用它把链路跑通，
 * 再去跑真正的采集。它是「池子到货后第一条要跑的命令」。
 *
 *   node tools/proxy-pool-check.mjs                         用 ONEGL_PROXY_POOL_FILE
 *   node tools/proxy-pool-check.mjs --file local/pool.json  指定池子文件
 *   node tools/proxy-pool-check.mjs --slots 4               每个平台取 4 个出口（默认 2）
 *   node tools/proxy-pool-check.mjs --full                  同时验四个平台的出口矩阵
 *   node tools/proxy-pool-check.mjs --as                    附上 AS 归属（采购判据第 1 条）
 *   node tools/proxy-pool-check.mjs --json                  机器可读输出
 *   node tools/proxy-pool-check.mjs --echo http://host:port/ 换一个回显服务（自检/离线环境用）
 *
 * 它验的四件事，每件都能单独判失败：
 *   1. 配置能被解析（含密钥从 env 取到位）—— 解析不过就没必要谈后面
 *   2. 每次 acquire 真的拿到一个出口，且**不同槽位拿到不同出口**
 *      （同一个账号多开却共用一个 IP，等于回到 9-30 那个失败配置）
 *   3. 这条出口真能把流量送出去（CONNECT 隧道 + 回显服务）
 *   4. **没有回退直连**：观测到的出口 IP 与本机直连 IP 不同
 *
 * 刻意不用浏览器：一次冷启动 11–60 秒，验 20 个 IP 要十几分钟。这一层验的是线路，
 * 浏览器级的证明由 tools/probe-proxy-egress.mjs 负责，两者互补。
 */
import "dotenv/config";
import process from "node:process";
import { acquireSessionProxy, describePool, loadProxyPool, poolRuntimeSummary } from "../src/proxy-pool.js";
import { probeDirectEgress, probeEgressThroughProxy } from "../src/proxy-egress.js";

const DEFAULT_PLATFORMS = ["doubao", "qianwen", "wenxin", "zhipu"];

function parseArgs(argv) {
  const options = {
    file: process.env.ONEGL_PROXY_POOL_FILE ?? null,
    slots: 2,
    platform: "doubao",
    full: false,
    as: false,
    json: false,
    timeoutMs: 15_000,
    echo: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") options.file = argv[++index];
    else if (arg === "--slots") options.slots = Number(argv[++index]);
    else if (arg === "--platform") options.platform = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--full") options.full = true;
    else if (arg === "--as") options.as = true;
    else if (arg === "--json") options.json = true;
    // 换回显服务：离线环境自检、或默认那两个站点被墙时用。
    else if (arg === "--echo") options.echo = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.file) throw new Error("no pool file: pass --file or set ONEGL_PROXY_POOL_FILE");
  if (!Number.isInteger(options.slots) || options.slots < 1 || options.slots > 32) {
    throw new Error("--slots must be an integer between 1 and 32");
  }
  return options;
}

/** 归属查询：采购判据要区分家宽段和机房段，这个字段是唯一便宜的入口。 */
async function lookupAs(ip) {
  if (!ip) return null;
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,isp,org,as`, {
      signal: AbortSignal.timeout(8_000),
    });
    const payload = await response.json();
    if (payload?.status !== "success") return { error: payload?.message ?? "lookup failed" };
    return { country: payload.country, region: payload.regionName, isp: payload.isp, as: payload.as };
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

function pad(text, width) {
  const value = String(text ?? "");
  // 中文字符占两列，宽度对齐要按显示宽度算，不能按 char 数。
  let display = 0;
  for (const char of value) display += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char) ? 2 : 1;
  return value + " ".repeat(Math.max(0, width - display));
}

const options = parseArgs(process.argv.slice(2));
const config = { proxyPoolFile: options.file, provider: options.platform, accountKey: "pool_check" };

const pool = loadProxyPool(options.file);
if (!pool.enabled) {
  console.error(
    `池子 ${pool.poolId} 的 enabled=false —— 体检没意义，先把它打开。` +
      (pool.required ? "（required=true 时它还会直接阻断任务）" : ""),
  );
  process.exit(1);
}

const platforms = options.full ? pool.platforms.length ? pool.platforms : DEFAULT_PLATFORMS : [options.platform];
const requested = [];
for (const platform of platforms) {
  for (let slot = 0; slot < options.slots; slot += 1) requested.push({ platform, slot });
}

const echoUrls = options.echo ? [options.echo] : undefined;
const direct = await probeDirectEgress(options.echo ? { urls: echoUrls, timeoutMs: options.timeoutMs } : {});
const rows = [];
const started = Date.now();
for (const { platform, slot } of requested) {
  const row = { platform, slot, exit_id: null, server: null, ip: null, ms: null, error: null, stage: null, as: null };
  let exit = null;
  try {
    exit = await acquireSessionProxy(
      { ...config, provider: platform, accountKey: `pool_check_${slot}` },
      { platform, accountKey: `pool_check_${slot}`, slot },
    );
  } catch (error) {
    row.error = error?.message ?? String(error);
    row.stage = "acquire";
    rows.push(row);
    continue;
  }
  if (!exit) {
    row.error = "acquire returned null (platform not covered by this pool)";
    row.stage = "acquire";
    rows.push(row);
    continue;
  }
  row.exit_id = exit.id;
  row.server = exit.server;
  row.mode = exit.mode;
  row.expires_at = exit.expires_at == null ? null : new Date(exit.expires_at).toISOString();

  const probeStarted = Date.now();
  const result = await probeEgressThroughProxy(exit, {
    timeoutMs: options.timeoutMs,
    ...(echoUrls ? { urls: echoUrls } : {}),
  });
  row.ms = Date.now() - probeStarted;
  row.ip = result.ip;
  row.error = result.error;
  row.stage = result.stage;
  if (options.as && result.ip) row.as = await lookupAs(result.ip);
  rows.push(row);
}

const runtime = poolRuntimeSummary(options.file, pool.poolId);
const observed = rows.map((row) => row.ip).filter(Boolean);
const uniqueObserved = [...new Set(observed)];
const leaked = direct.ip != null && observed.includes(direct.ip);
const unusable = rows.filter((row) => row.ip == null);
const ok = unusable.length === 0 && !leaked;

const report = {
  tool: "proxy-pool-check",
  pool: describePool(pool, options.file),
  direct_egress: direct,
  sampled: rows.length,
  usable: rows.length - unusable.length,
  distinct_egress_ips: uniqueObserved.length,
  leaked_direct_ip: leaked,
  runtime,
  rows,
  duration_ms: Date.now() - started,
  passed: ok,
};

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `ONEGL_PROXY_POOL_CHECK ${JSON.stringify({
      pool_id: report.pool.pool_id,
      source_kind: report.pool.source_kind,
      acquisition_mode: report.pool.acquisition_mode,
      platforms: report.pool.platforms,
      sampled: report.sampled,
      usable: report.usable,
      distinct_egress_ips: report.distinct_egress_ips,
      leaked_direct_ip: leaked,
      passed: ok,
    })}`,
  );
  console.log("");
  console.log(`本机直连出口: ${direct.ip ?? `（取不到：${direct.error}）`}`);
  console.log("");
  console.log(
    `${pad("平台", 10)}${pad("槽位", 6)}${pad("出口 ID", 22)}${pad("实测出口 IP", 18)}${pad("耗时", 8)}${pad("结果", 10)}AS`,
  );
  for (const row of rows) {
    const verdict = row.ip ? "OK" : `FAIL(${row.stage ?? "?"})`;
    const asText = row.as?.as ?? row.as?.error ?? "";
    console.log(
      `${pad(row.platform, 10)}${pad(row.slot, 6)}${pad(row.exit_id ?? "-", 22)}${pad(row.ip ?? "-", 18)}${pad(
        row.ms == null ? "-" : `${row.ms}ms`,
        8,
      )}${pad(verdict, 10)}${asText}`,
    );
    if (row.error) console.log(`    └ ${row.error}`);
  }
  if (runtime) {
    console.log("");
    console.log(
      `池子运行期: 提取 ${runtime.extractions} 次 / 缓存 ${runtime.cached_exits} 个（其中可用 ${runtime.live_exits}）/ 已消费 ${runtime.consumed_exits}` +
        (runtime.last_error ? ` / 上次错误: ${runtime.last_error}` : ""),
    );
  }
  if (leaked) {
    console.log("");
    console.log("⛔ 观测到本机直连 IP —— 代理没有生效，或某条出口回退到了直连。这条必须先修。");
  }
  if (unusable.length > 0) {
    console.log("");
    console.log(`⚠ ${unusable.length}/${rows.length} 个出口不可用。`);
  }
  if (rows.length > 1 && uniqueObserved.length < rows.length) {
    console.log("");
    console.log(
      `⚠ ${rows.length} 次取样只观测到 ${uniqueObserved.length} 个不同的出口 IP：池子没有给出足够的分散度，` +
        "多开槽位仍会撞在同一个 IP 上。",
    );
  }
}

// 用 exitCode 而不是 process.exit()：探针留下的 CONNECT 套接字还在收尾，
// Windows 上强退会让 Node 在退出路径上崩掉（实测退出码 0xC0000409），
// 于是「体检通过」被读成一个崩溃。让它自然排空。
process.exitCode = ok ? 0 : 2;
