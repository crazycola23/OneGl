#!/usr/bin/env node
/**
 * 把 Clash(mihomo) 里的节点转成 OneGl 能直接用的代理池。
 *
 * 为什么需要转：Clash 的 71 个节点里只有极少是 http/socks5 类型，其余是
 * vless / hysteria2 / ss —— 那些协议 OneGl 的浏览器根本不认识。但它们都能被
 * mihomo 终结在本地端口上，于是「一条隧道」就变成一个 `http://127.0.0.1:<port>`，
 * 落进我们已经实现的 `static` 输入源。
 *
 *   node tools/clash-pool.mjs [--limit 12] [--match 日本] [--base-port 7801]
 *
 * 产出两个文件（都在 local/，不进版本库）：
 *   1. local/clash-listeners.yaml —— 贴进 Clash Verge 的全局扩展配置(Merge)
 *   2. local/proxy-pool.json      —— OneGl 的静态池（ONEGL_PROXY_POOL_FILE 指向它）
 *
 * 它**只生成文本，不改你的 Clash 配置**：动活的网络配置需要你自己确认后粘贴并重启内核。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    config: path.join(
      process.env.APPDATA ?? "",
      "io.github.clash-verge-rev.clash-verge-rev",
      "clash-verge.yaml",
    ),
    outDir: "local",
    limit: 12,
    match: null,
    basePort: 7801,
    poolId: "clash_exits",
    platforms: ["doubao", "qianwen", "wenxin", "zhipu"],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") options.config = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--match") options.match = argv[++index];
    else if (arg === "--base-port") options.basePort = Number(argv[++index]);
    else if (arg === "--pool-id") options.poolId = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

/**
 * 只取 `name` 与 `type` 两个字段 —— 完整解析这份 YAML 没有必要，
 * 而且配置文件里有节点密码，少读一个字段就少一处泄漏面。
 */
export function parseClashProxies(text) {
  const start = text.search(/^proxies:\s*$/m);
  if (start < 0) return [];
  const rest = text.slice(start);
  // 跳过 "proxies:" 这一行本身再找下一个顶层键 ——
  // 否则 "roxies:" 会被当成一个顶层键，整段被切成 1 个字符。
  const bodyStart = rest.indexOf("\n") + 1;
  // 下一个顶层键（列表项 "- name:" 也顶格，不能拿它当边界）
  const boundary = rest.slice(bodyStart).search(/^[A-Za-z][A-Za-z0-9_-]*:/m);
  const block =
    boundary < 0 ? rest.slice(bodyStart) : rest.slice(bodyStart, bodyStart + boundary);

  const chunks = block.split(/^-\s*(?=\S)/m).slice(1);
  const proxies = [];
  for (const chunk of chunks) {
    const head = /^\{?\s*name:\s*(.+?)\s*$/m.exec(chunk);
    if (!head) continue;
    const name = head[1].trim().replace(/^"(.*)"$/, "$1");
    const type = /(?:^|[,\s])type:\s*"?([A-Za-z0-9_-]+)"?/m.exec(chunk)?.[1] ?? null;
    proxies.push({ name, type });
  }
  return proxies;
}

const yamlString = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const options = parseArgs(process.argv.slice(2));
const raw = readFileSync(options.config, "utf8");
const all = parseClashProxies(raw);
const excluded = new Set(["direct", "reject", "compatible", "pass", "dns"]);
const usable = all.filter((proxy) => proxy.type && !excluded.has(proxy.type.toLowerCase()));
const selected = usable
  .filter((proxy) => (options.match ? proxy.name.includes(options.match) : true))
  .slice(0, options.limit);

if (selected.length === 0) {
  console.error(`没有匹配的节点（总数 ${all.length}，可用 ${usable.length}，--match ${options.match ?? "无"}）`);
  process.exit(1);
}

const listeners = [
  "# 由 tools/clash-pool.mjs 生成 —— 贴进 Clash Verge 的全局扩展配置(Merge)，然后重启内核。",
  "# 每个 listener 把一条节点隧道终结在本机端口上；OneGl 通过 http://127.0.0.1:<port> 走它。",
  "# 只监听 127.0.0.1：这些端口没有认证，暴露到局域网等于把你的订阅送人。",
  "listeners:",
  ...selected.flatMap((proxy, index) => [
    `  - name: ${yamlString(`onegl-${String(index + 1).padStart(2, "0")}`)}`,
    "    type: mixed",
    `    port: ${options.basePort + index}`,
    "    listen: 127.0.0.1",
    `    proxy: ${yamlString(proxy.name)}`,
  ]),
  "",
].join("\n");

const pool = {
  schema_version: 1,
  pool_id: options.poolId,
  enabled: true,
  // required=true：池不可用时**阻断**采集，而不是悄悄回退直连。
  // 这个池存在的意义就是「不要用本机 IP」，回退直连等于把它取消了。
  required: true,
  platforms: options.platforms,
  source: {
    kind: "static",
    items: selected.map((proxy, index) => ({
      id: `clash-${String(index + 1).padStart(2, "0")}`,
      server: `http://127.0.0.1:${options.basePort + index}`,
      stability: { mode: "fixed" },
      label: proxy.name,
    })),
  },
};

mkdirSync(options.outDir, { recursive: true });
const listenersPath = path.join(options.outDir, "clash-listeners.yaml");
// 故意不叫 proxy-pool.json：那个文件现在是成都固定出口，两个池并存、按需切换。
const poolPath = path.join(options.outDir, "clash-pool.json");
writeFileSync(listenersPath, listeners, "utf8");
writeFileSync(poolPath, `${JSON.stringify(pool, null, 2)}\n`, "utf8");

console.log(`Clash 节点总数 ${all.length}，可用 ${usable.length}，本次选中 ${selected.length}`);
console.log(`  ${listenersPath}`);
console.log(`  ${poolPath}`);
for (const [index, proxy] of selected.entries()) {
  console.log(
    `  ${options.basePort + index} -> [${proxy.type}] ${proxy.name}`,
  );
}
